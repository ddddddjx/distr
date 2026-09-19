// 应用主控：相机/视频文件双数据源、推理循环、语音反馈、UI 状态与渲染
import { PoseDetector } from "./poseDetector.js";
import { SwingAnalyzer, PHASE, PHASE_LABEL } from "./swingAnalyzer.js";
import { RULES, SEVERITY } from "./rules.js";
import { VoiceCoach } from "./voice.js";
import { saveSwing, computeStats, getSwings, clearSwings } from "./store.js";
import { buildSwingCard, buildWeeklyCard, tierOf, percentileOf, roastOf } from "./shareCard.js";
import { flag } from "./flags.js";
import { renderImuBlockHtml } from "./imuReport.js";
import { decideRecovery, STALL_MS } from "./cameraWatchdog.js";
import { sampleGrid, estimateAnalysisSeconds } from "./frameGrid.js";

const APP_VERSION = "0.9.0";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

const state = {
  running: false,
  source: "camera",      // "camera" 实时相机 | "file" 上传的视频
  facing: "environment", // 默认后置镜头（由他人帮拍）
  view: "front",
  sound: false,          // 上传视频是否放原声（记忆在 localStorage，见 SOUND_KEY）
  handedness: "right",
  stream: null,
  fileUrl: null,
  rafId: 0,
  frames: 0,
  fpsT0: performance.now(),
};

// 视频原声开关的持久化键。相机模式恒定静音：getUserMedia 没要音轨，
// 真开了也只会造成啸叫；这个开关只服务"上传视频"。
const SOUND_KEY = "videoSound.v1";
try { state.sound = localStorage.getItem(SOUND_KEY) === "1"; } catch (e) { /* 隐私模式 */ }

const detector = new PoseDetector();
const coach = new VoiceCoach();

// 分析器工厂：EXPORT_ENABLED 开启时让分析器为契约导出留存关键点与
// P1/P10 时间戳（详见 schema/）；默认关闭，构造结果与旧行为完全一致
function newAnalyzer() {
  return new SwingAnalyzer(state.view, state.handedness, {
    captureKeypoints: flag("EXPORT_ENABLED"),
  });
}

// 推理图被污染（时间戳倒退等）后无法自愈，只能重开页面。宁可明说，
// 也不要让用户对着一个"有画面、没结果"的 App 反复挥杆
detector.onBroken = () => {
  showHint("推理引擎出错，已停止分析。请刷新页面重试", 12000);
  if (state.running) stopAnalysis();
};

let analyzer = newAnalyzer();
// 每次挥杆中各问题首次出现瞬间的截图（报告中展示）
const snapshots = new Map();
let baselineAnnounced = false;
// 关键位置帧（准备/顶点/击球/收杆）与慢放回放
const keyframes = new Map();
let prevPhase = PHASE.IDLE;
let recorder = null;          // 实时模式：MediaRecorder
let recChunks = [];
let replayUrl = null;         // 实时模式：回放 blob URL
let replayFallbackTimer = 0;  // 回放没出帧时切到原生控件的兜底计时器
// 回放慢放倍速。导出慢放视频用的是同一个常量——两处若各写各的，
// 用户存下来的文件就会和报告里看到的速度对不上
const REPLAY_RATE = 0.4;
const replaySegment = { start: 0, end: 0 }; // 视频模式：挥杆起止时间点
let impactVideoT = null; // 当前挥杆的击球时刻（视频时间轴秒）
// 视频模式：整段视频中检测到的每次完整挥杆（试挥+正式击球）。
// 看完全片后只报告最后一次——实拍素材里正式击球几乎总是最后一挥。
const videoSwings = [];
// 预览卡死看门狗的观测量（判定逻辑在 cameraWatchdog.js，纯函数可单测）
let lastFrameAt = 0;    // 最近一次真正拿到新视频帧的时刻
let resumeTries = 0;    // 本轮卡死已尝试过几次轻量续播
let reopenTries = 0;    // 本轮卡死已重开过几次摄像头
let recovering = false; // 恢复流程进行中（异步，避免逐帧重复触发）

/* ---------------- 初始化 ---------------- */

const isWeChat = /MicroMessenger/i.test(navigator.userAgent);

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms)),
  ]);
}

async function boot() {
  try {
    $("loadingText").textContent =
      "正在加载 AI 模型…首次使用需下载约 25MB，之后打开秒启动";
    await detector.init();
    // 首帧推理比稳态慢一个数量级，摊在加载遮罩里跑掉
    $("loadingText").textContent = "正在预热推理引擎…";
    await detector.warmUp();
  } catch (err) {
    // 模型加载失败是致命错误，保留遮罩提示
    $("loadingText").textContent = "AI 模型加载失败，请检查网络后刷新页面。" + (err?.message || "");
    $("loading").querySelector(".spinner")?.remove();
    return;
  }
  // 不自动开启摄像头：让用户先选择实时拍摄还是上传视频
  $("loading").classList.add("hidden");
  $("chooser").classList.remove("hidden");
  updateSessionBadge();
  updateChromeInsets();
}

async function startLiveMode() {
  $("loadingText").textContent = "正在打开摄像头…";
  $("loading").classList.remove("hidden");
  try {
    await openCamera();
    $("loading").classList.add("hidden");
    if (state.source === "camera") {
      // 首次进入实时模式：三步引导（直接决定新用户激活率）
      if (!localStorage.getItem("onboarded")) {
        localStorage.setItem("onboarded", "1");
        $("onboardModal").classList.remove("hidden");
      } else {
        showHint(hintForView(), 4000);
      }
    }
  } catch (err) {
    // 相机失败不阻塞应用：上传视频分析仍然可用
    $("loading").classList.add("hidden");
    showHint(cameraErrorMessage(err), 12000);
  }
}

function cameraErrorMessage(err) {
  if (isWeChat)
    return "微信内置浏览器不支持实时摄像头：请点右上角「···」选择「在浏览器中打开」；或直接用下方「上传视频」分析（微信内可用）。";
  if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError"))
    return "无法访问摄像头：请在浏览器设置中允许相机权限后刷新页面，或使用「上传视频」分析。";
  if (location.protocol !== "https:" && location.hostname !== "localhost")
    return "摄像头需要 HTTPS 环境。请通过 https:// 或 localhost 访问本页面。";
  return "摄像头打开失败（" + (err?.message || err) + "）。可改用「上传视频」分析。";
}

// 摄像头打开的会话序号：进入视频模式后，迟到返回的 getUserMedia 结果会被作废，
// 避免上传视频路径中摄像头被悄悄重新激活（表现为"自动录像"）
let camSeq = 0;

async function openCamera() {
  stopMediaSources();
  state.source = "camera";
  const seq = ++camSeq;
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("当前浏览器环境不支持摄像头 API");

  // 约束逐级放宽：部分 WebView/老设备对分辨率或 facingMode 约束会直接挂起
  const constraintTries = [
    { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    { facingMode: state.facing },
    true,
  ];
  let lastErr = null;
  let stream = null;
  for (const c of constraintTries) {
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: false, video: c }),
        8000,
        "打开摄像头超时"
      );
      break;
    } catch (e) {
      lastErr = e;
      // 用户明确拒绝授权时不再重试
      if (e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError") throw e;
    }
  }
  // 等待期间用户已切到上传视频模式：作废本次打开，立即释放摄像头
  if (seq !== camSeq || state.source !== "camera") {
    stream?.getTracks().forEach((t) => t.stop());
    return;
  }
  if (!stream) throw lastErr || new Error("无法获取摄像头");
  state.stream = stream;

  video.srcObject = state.stream;
  applyVideoSound(); // 相机模式恒定静音 + 隐藏原声按钮
  video.classList.toggle("mirrored", state.facing === "user");
  if (video.readyState < 1) {
    await withTimeout(
      new Promise((res) => video.addEventListener("loadedmetadata", res, { once: true })),
      7000,
      "摄像头画面加载超时"
    ).catch(() => {}); // 个别 WebView 不触发该事件但画面正常，继续往下走
  }
  try {
    await video.play();
  } catch {
    // 自动播放被拦截：等用户任意点击后再播
    showHint("点击屏幕任意位置开启画面", 8000);
    document.addEventListener("click", () => video.play().catch(() => {}), { once: true });
  }
  detector.lastVideoTime = -1;
  lastFrameAt = performance.now();
  resizeOverlay();
}

function stopMediaSources() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  if (state.fileUrl) {
    URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = null;
  }
  video.removeAttribute("src");
}

function resizeOverlay() {
  overlay.width = video.videoWidth || overlay.clientWidth;
  overlay.height = video.videoHeight || overlay.clientHeight;
}

/** 量出顶栏/控制面板的实际高度写入 CSS 变量：
 *  视频模式的画面据此内缩，避免下半部分动作被工具栏遮挡 */
function updateChromeInsets() {
  const s = document.documentElement.style;
  s.setProperty("--chrome-top", $("topbar").offsetHeight + "px");
  s.setProperty("--chrome-bottom", $("controls").offsetHeight + "px");
}
window.addEventListener("resize", () => {
  resizeOverlay();
  updateChromeInsets();
});

// 顶栏/控制面板的高度会随状态变化（分析中收起配置行、安全区变化、字号缩放），
// 而视频模式的 stage 完全按 --chrome-* 内缩。只在状态切换点手动量高度依赖布局
// 时机——iOS 上量到旧值时 stage 会停在旧位置，与控制面板之间露出黑带
// （实测 174px 的旧值配 78px 的新高度 = 95px 黑带）。改用 ResizeObserver 持续
// 跟踪，测量不再依赖调用时机；--chrome-* 不影响这两个元素自身，不会触发回环。
if ("ResizeObserver" in window) {
  const chromeRO = new ResizeObserver(updateChromeInsets);
  chromeRO.observe($("topbar"));
  chromeRO.observe($("controls"));
}

/** 把原声开关落到 video 元素与顶栏按钮上。相机模式恒定静音且不显示按钮。 */
function applyVideoSound() {
  const isFile = state.source === "file";
  video.muted = !(isFile && state.sound);
  const btn = $("soundBtn");
  btn.classList.toggle("hidden", !isFile);
  btn.classList.toggle("off", !state.sound);
  btn.textContent = state.sound ? "原声" : "静音";
}

$("soundBtn").addEventListener("click", () => {
  state.sound = !state.sound;
  try { localStorage.setItem(SOUND_KEY, state.sound ? "1" : "0"); } catch (e) { /* 隐私模式 */ }
  applyVideoSound();
  // 解除静音必须借用户手势（这次点击就是），否则 iOS 会直接把视频暂停
  if (state.sound && state.source === "file" && state.running) video.play().catch(() => {});
  showHint(state.sound ? "已开启视频原声" : "已静音视频原声", 2000);
});

/* ---------------- 视频文件模式 ---------------- */

async function enterFileMode(file) {
  stopAnalysis();
  camSeq++; // 作废任何还在等待中的摄像头打开请求
  stopMediaSources();
  state.source = "file";
  state.fileObj = file; // 保留原始文件引用：击球声定位需解码音轨
  state.fileUrl = URL.createObjectURL(file);
  video.src = state.fileUrl;
  video.classList.remove("mirrored");
  video.loop = false;
  // <video autoplay> 会让文件一装载就自动播放。逐帧分析要求暂停态：
  // 一旦在播，取到哪一帧又回到"看当时手机多忙"，分数就不可复现了
  video.autoplay = false;
  video.pause();
  $("stage").classList.add("file-mode");
  updateChromeInsets();
  $("flipBtn").textContent = "返回相机";
  applyVideoSound();
  await new Promise((res) => (video.onloadedmetadata = res));
  resizeOverlay();
  showHint(
    video.duration > 120
      ? "视频较长，建议剪辑到挥杆前后 10-20 秒再分析，更快更准。点「开始分析」继续"
      : "请确认上方机位选择与视频拍摄角度一致，点「开始分析」",
    5000
  );
  $("phasePill").textContent = "视频已就绪";
}

async function exitFileMode() {
  stopAnalysis();
  $("stage").classList.remove("file-mode");
  updateChromeInsets();
  updateSessionBadge();
  $("flipBtn").textContent = "切换镜头";
  try {
    await openCamera();
    showHint(hintForView(), 3000);
  } catch (err) {
    applyVideoSound(); // 开相机失败也要收起原声按钮
    showHint(cameraErrorMessage(err), 5000);
  }
}

/**
 * 结束视频分析并出报告：自然播完与中途点「停止分析」共用同一逻辑。
 * 若此刻正处于挥杆中（击球被剪到结尾/中途停止），先强制收束；
 * 然后报告最后一次挥杆——试挥/热身在前，正式击球几乎总是最后一挥。
 */
async function concludeFileAnalysis() {
  // 相机模式要靠 VIDEO 模式的跟踪，分析一结束就切回去
  detector.setStateless(false);
  replaySegment.end = video.currentTime || video.duration || 0;
  const tail = analyzer.finalize();
  if (tail) videoSwings.push(packSwing(tail));

  stopAnalysis();
  if (!videoSwings.length) {
    showHint("未识别到完整挥杆：请确认全身入镜、机位选择正确，且视频包含完整的挥杆动作", 5000);
    return;
  }
  // 击球声定位：区分试挥与正式挥杆（全本地解码；无音轨/失败一律降级）
  let audioUsed = false;
  try {
    if (videoSwings.length > 1 && state.fileObj) {
      const { extractImpactTimes, hasStrikeNear, hasStrikeInRange } = await import("./strikeAudio.js");
      const peaks = await extractImpactTimes(state.fileObj);
      if (peaks && peaks.length) {
        for (const sw of videoSwings) {
          // 优先按击球时刻点匹配；低帧率漏采 IMPACT 时退化为时间跨度匹配
          sw.strike =
            typeof sw.impactVideoT === "number"
              ? hasStrikeNear(sw.impactVideoT, peaks)
              : hasStrikeInRange(sw.segment.start + 0.5, sw.segment.end, peaks);
          // 判定写入 summary，随 exportSession 落进契约 annotations[]
          sw.summary.strikeDetection = {
            has_strike: sw.strike === true,
            method: "audio_transient",
          };
        }
        // 仅当确实定位到击球声时才以"定位模式"呈现，避免误导
        audioUsed = videoSwings.some((sw) => sw.strike === true);
      }
    }
  } catch (e) {
    /* 声学定位是增强能力，任何失败都不影响报告 */
  }
  // 每次完整挥杆都独立计入练习历史，报告中可逐杆切换查看
  videoSwings.forEach((sw) => saveSwing(sw.summary, "file"));
  // 默认展示：有击球声的最后一杆（正式挥）；无音频信号回退最后一杆
  const { pickDefaultSwing } = await import("./strikeAudio.js");
  const chosen = pickDefaultSwing(videoSwings.map((sw) => sw.strike));
  presentSwing(chosen, { celebrate: true, audioUsed });
}

/** 呈现视频中的第 i 次挥杆（评分/回放/关键帧/标注均为该杆数据） */
/** 重放一次 CSS 动画：改类名不够，必须先摘掉、强制重排、再挂上 */
function replayAnim(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function presentSwing(i, opts = {}) {
  const sw = videoSwings[i];
  if (!sw) return;
  restoreSwing(sw);
  showSummary(sw.summary, {
    count: videoSwings.length,
    index: i,
    celebrate: !!opts.celebrate, // 切换查看时不重复撒彩带/震动
    audioUsed: !!opts.audioUsed,
  });
  // 只有"切换杆号"才给正文淡入：首次开报告时 sheet 本身在入场，
  // 再套一层内部动画只会让报告显得慢
  if (!opts.celebrate) {
    replayAnim($("summaryBody"), "content-swap");
    replayAnim($("keyframesWrap"), "content-swap");
  }
}

video.addEventListener("ended", () => {
  if (state.source !== "file" || !state.running) return;
  concludeFileAnalysis();
  $("phasePill").textContent = "播放结束";
});

/** 打包/恢复一次挥杆的全部展示数据（报告、问题截图、关键帧、回放区间） */
function packSwing(summary) {
  return {
    summary,
    snapshots: new Map(snapshots),
    keyframes: new Map(keyframes),
    segment: { ...replaySegment },
    impactVideoT, // 击球时刻（视频时间轴秒），供击球声对齐；未达击球相位为 null
    strike: null, // 声学判定：true 有击球声 / false 无 / null 未知
  };
}

function restoreSwing(sw) {
  snapshots.clear();
  for (const [k, v] of sw.snapshots) snapshots.set(k, v);
  keyframes.clear();
  for (const [k, v] of sw.keyframes) keyframes.set(k, v);
  replaySegment.start = sw.segment.start;
  replaySegment.end = sw.segment.end;
}

function resetPerSwing() {
  snapshots.clear();
  keyframes.clear();
  prevPhase = PHASE.IDLE;
  baselineAnnounced = false;
  replaySegment.start = 0;
  replaySegment.end = 0;
  impactVideoT = null;
}

/* ---------------- 推理主循环 ---------------- */

/** 每帧的全部处理。两条路径共用：
 *  - 相机模式：rAF 实时循环，时间基准是墙钟（现场只能如此）；
 *  - 上传视频：确定性逐帧推进，时间基准是【视频时间轴】。
 *  tMs 必须单调递增。 */
function processFrame(lms, tMs, bg = null) {
  const mirrored = state.source === "camera" && state.facing === "user";
  detector.draw(ctx, lms, mirrored, bg);
  const { phase, liveFaults, summary } = analyzer.update(lms, tMs);
  renderPhase(phase);
  renderLiveFaults(liveFaults, phase, lms);

  // 准备姿势锁定：语音提示、截"准备"关键帧、实时模式开始录制回放
  if (!baselineAnnounced && analyzer.baseline) {
    baselineAnnounced = true;
    captureKeyframe("address", lms, mirrored);
    if (state.source === "camera") {
      coach.say("姿势就位，开始挥杆吧", "ready", 2000);
      startRecorder();
    }
  }
  // 阶段切换：截关键帧、记录视频模式的挥杆起点
  if (phase !== prevPhase) {
    if (
      (phase === PHASE.ADDRESS || phase === PHASE.IDLE) &&
      prevPhase !== PHASE.IDLE && prevPhase !== PHASE.ADDRESS
    ) {
      // 动作被判定为无效（准备小动作/弯腰摆球/走动）：清掉误捕的截图与关键帧
      snapshots.clear();
      if (phase === PHASE.IDLE) {
        // 基准已作废：全部关键帧重来，重新等待就位
        keyframes.clear();
        baselineAnnounced = false;
        // 这一段录制跟着作废。留着不丢会让 startRecorder early-return，
        // 之后每一杆的回放都还是这段从未收束的旧录像
        discardRecorder();
      } else {
        for (const k of ["top", "impact", "finish"]) keyframes.delete(k);
      }
    }
    if (phase === PHASE.BACKSWING && state.source === "file")
      replaySegment.start = Math.max(0, video.currentTime - 1);
    if (phase === PHASE.TOP) captureKeyframe("top", lms, mirrored);
    if (phase === PHASE.IMPACT) {
      captureKeyframe("impact", lms, mirrored);
      // 记录击球时刻在视频时间轴上的位置（击球声对齐用）
      if (state.source === "file") impactVideoT = video.currentTime;
    }
    if (phase === PHASE.FINISH) captureKeyframe("finish", lms, mirrored);
    prevPhase = phase;
  }
  // 实时问题：语音播报 + 截取问题瞬间画面
  for (const key of liveFaults) {
    const rule = RULES[key];
    if (rule?.voice) coach.say(rule.voice, key, 7000);
    // 截图取偏差最严重的瞬间（首次触发常是擦线的临界帧，最不准）
    if (lms && (!snapshots.has(key) || analyzer.updatedFaults.has(key))) {
      // 带可视化标注的问题截图：红=当前动作，绿虚线=正确参考
      const shot = detector.snapshot(
        video, lms, mirrored, 480, analyzer.annotations.get(key)
      );
      if (shot) snapshots.set(key, shot);
    }
  }
  if (summary) {
    if (state.source === "file") {
      // 上传视频：静默存档这次挥杆（可能只是试挥），看完整段视频后
      // 由 ended 事件统一报告最后一次挥杆
      replaySegment.end = video.currentTime + 0.3;
      videoSwings.push(packSwing(summary));
      resetPerSwing();
      analyzer.nextSwing();
    } else {
      coach.say(
        summary.faults.length
          ? "挥杆完成，来看一下分析报告"
          : "漂亮，这一杆没有明显问题",
        "summary",
        2000
      );
      saveSwing(summary, "camera");
      showSummary(summary);
    }
  }

}

function loop() {
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now();
  // 报告弹窗期间不推理：这一杆已经出了报告，分析结果只会被「继续练习」重置；
  // 顺带避开 iOS 上"回放视频与摄像头预览抢资源"的窗口，也省电
  if (!$("summaryModal").classList.contains("hidden")) return;
  const lms = detector.detect(video, now);
  // undefined = 没有新帧（相机预览被冻住），跳过本次分析
  if (lms === undefined) {
    watchPreview(now);
  } else {
    lastFrameAt = now;
    resumeTries = 0;
    reopenTries = 0;
    processFrame(lms, now);
  }

  // FPS 统计：只计真正完成推理的帧。rAF 空转不能显示成 60 FPS——
  // 预览冻住时面板若还是一片"正常"，只会把问题藏起来
  if (lms !== undefined) state.frames++;
  if (now - state.fpsT0 > 1000) {
    $("fpsLabel").textContent = state.frames + " FPS";
    state.frames = 0;
    state.fpsT0 = now;
  }
}

/* ---------------- 上传视频：确定性逐帧分析 ---------------- */

/** seek 到指定时刻并等落定。卡住也要放行，不能把整段分析挂死 */
function seekTo(t) {
  return new Promise((res) => {
    if (Math.abs(video.currentTime - t) < 0.001) return res();
    let timer = 0;
    const done = () => {
      video.removeEventListener("seeked", done);
      clearTimeout(timer);
      res();
    };
    timer = setTimeout(done, 2000);
    video.addEventListener("seeked", done);
    try { video.currentTime = t; } catch (e) { done(); }
  });
}

/** 让出一帧，好让画面刷新、「停止分析」点得动 */
const nextPaint = () => new Promise((r) => requestAnimationFrame(r));

/**
 * 逐帧走完整段视频。时间基准用【网格时刻】而不是 video.currentTime：
 * seek 会落到最近的可解码帧，用实际落点会把机器差异重新引回来。
 */
async function runFileAnalysis() {
  const dur = Number.isFinite(video.duration) ? video.duration : 0;
  const grid = sampleGrid(dur);
  if (!grid.length) { showHint("读不到视频时长，无法分析", 4000); stopAnalysis(); return; }
  video.pause();   // 关键：不播放。一播放就又变成"抽到哪帧看运气"
  video.autoplay = false;
  for (let i = 0; i < grid.length; i++) {
    if (!state.running) return;         // 用户中途点了「停止分析」
    const t = grid[i];
    await seekTo(t);
    if (!state.running) return;
    // 时间基准用【网格时刻】而不是 video.currentTime：seek 会落到最近的
    // 可解码帧，用实际落点会把机器差异重新引回来
    const lms = detector.detectAt(video, t * 1000);
    // detectAt 里已经把这一帧缩进工作画布，直接复用它当底图：
    // iOS 上"暂停 + seek"的 video 不往屏幕合成，不自己画就是一片黑
    processFrame(lms, t * 1000, detector.work);
    const pct = Math.round(((i + 1) / grid.length) * 100);
    $("fpsLabel").textContent = pct + "%";
    // 相位药丸在文件模式下显示进度：IDLE 的文案是"请站好位置"，
    // 对着一段已经拍好的视频说这个毫无意义
    $("phasePill").textContent = `分析中 ${pct}%`;
    await nextPaint();
  }
  if (state.running) concludeFileAnalysis();
}

/* ---------------- 摄像头预览保活 ---------------- */

/** 主循环连续拿不到新帧时调用：交给纯函数判定该不该救、怎么救 */
function watchPreview(now) {
  const track = state.stream?.getVideoTracks?.()[0] || null;
  const action = decideRecovery({
    now,
    lastFrameAt,
    source: state.source,
    running: state.running,
    recovering,
    resumeTries,
    reopenTries,
    trackState: track ? track.readyState : "none",
    trackMuted: !!track?.muted,
  });
  if (action !== "none") recoverPreview(action);
}

/**
 * 把冻住的摄像头预览救回来。
 * resume：轨道还活着，只是 <video> 被系统暂停（iOS 播完报告回放后的常态）→ 续播；
 * reopen：轨道已被系统中断/回收，或续播一次仍无新帧 → 重新申请摄像头。
 * 画面断过之后旧基准不再可信，reopen 时连同这一杆的中间状态一起作废。
 */
async function recoverPreview(action) {
  recovering = true;
  try {
    if (action === "stop") {
      stopAnalysis();
      showHint("摄像头画面已中断且无法恢复：请检查相机权限、关闭占用相机的其他应用后重新开始分析", 10000);
      return;
    }
    if (action === "resume") {
      resumeTries++;
      await resumePreview();
    } else {
      resumeTries = 0;
      reopenTries++;
      await openCamera();
      analyzer.nextSwing();
      resetPerSwing();
      discardRecorder();
      showHint("摄像头画面已恢复，请重新摆好准备姿势再挥杆", 4000);
    }
  } catch (err) {
    showHint(cameraErrorMessage(err), 8000);
  } finally {
    // 无论成败都重新计时：再卡 STALL_MS 才会升级到下一级恢复手段
    lastFrameAt = performance.now();
    recovering = false;
  }
}

/** 轻量续播：接回 srcObject 并让 detect() 重新接受下一帧 */
function resumePreview() {
  if (state.source !== "camera" || !state.stream) return Promise.resolve();
  if (video.srcObject !== state.stream) video.srcObject = state.stream;
  detector.lastVideoTime = -1;
  lastFrameAt = performance.now();
  return video.play().catch(() => {});
}

/* ---------------- 分析启停 ---------------- */

async function startAnalysis() {
  // 相机模式下若此前打开失败，先重试一次
  if (state.source === "camera" && !state.stream) {
    try {
      await openCamera();
    } catch (err) {
      showHint(cameraErrorMessage(err), 12000);
      return;
    }
  }
  analyzer = newAnalyzer();
  resetPerSwing();
  videoSwings.length = 0;
  discardRecorder();
  cleanupReplay();
  coach.unlock(); // 借用户点击手势解锁 iOS 语音
  state.running = true;
  lastFrameAt = performance.now();
  resumeTries = 0;
  reopenTries = 0;
  const btn = $("startBtn");
  btn.textContent = "停止分析";
  btn.classList.add("stop");
  // 分析进行中收起配置行，扩大观看区域
  $("controls").classList.add("running");
  updateChromeInsets();
  if (state.source === "file") {
    video.currentTime = 0;
    detector.lastVideoTime = -1;
    // 逐帧前先推理一次，把首帧的着色器编译/算子初始化开销摊掉
    await detector.prime(video);
    // 预热用的是 performance.now()，视频时间轴从 0 起——必须先接好时间戳游标
    detector.beginTimeline();
    // 关键：切到无状态推理。VIDEO 模式的跟踪状态会跨"两次分析"残留，
    // 第二次从头分析时开头几帧就偏、基准锁错——只统一帧序列是不够的
    await detector.setStateless(true);
    const secs = estimateAnalysisSeconds(Number.isFinite(video.duration) ? video.duration : 0);
    showHint(
      `正在逐帧分析（约 ${secs} 秒）：同一段视频每次结果都一样，请别离开本页`,
      6000
    );
    // 逐帧是异步的，自己跑完自己收尾，不进 rAF 循环
    runFileAnalysis().catch((err) => {
      // 别让异常变成一条无人接手的 Promise 拒绝：那样按钮会一直显示
      // "停止分析"，用户却等不到任何结果
      showHint("分析中断：" + (err?.message || err), 6000);
      stopAnalysis();
    });
    return;
  }
  // 上一轮若因系统中断停在冻结画面上，这里先把预览接回来再开跑
  resumePreview();
  showHint("摆好准备姿势并静止 1 秒，开始你的挥杆", 4000);
  loop();
}

function stopAnalysis() {
  if (!state.running) return;
  state.running = false;
  detector.setStateless(false); // 逐帧分析可能中途停下，模式要还原
  coach.stop();
  discardRecorder();
  cancelAnimationFrame(state.rafId);
  if (state.source === "file") video.pause();
  const btn = $("startBtn");
  btn.textContent = state.source === "file" ? "重新分析" : "开始分析";
  btn.classList.remove("stop");
  $("controls").classList.remove("running");
  updateChromeInsets();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  $("liveFaults").innerHTML = "";
  $("phasePill").textContent = "未开始";
  $("phasePill").classList.remove("active");
}

/* ---------------- UI 渲染 ---------------- */

function renderPhase(phase) {
  const pill = $("phasePill");
  // 文件逐帧分析时这里显示进度，别被相位文案覆盖掉
  if (!(state.source === "file" && state.running)) {
    pill.textContent = PHASE_LABEL[phase] || "—";
  }
  pill.classList.toggle("active", phase !== PHASE.IDLE);
  // 实时模式等待入镜时显示站位引导框
  $("guideFrame").classList.toggle(
    "hidden",
    !(state.running && state.source === "camera" && phase === PHASE.IDLE)
  );
}

// 同一条提示做 1.2s 防抖，避免逐帧闪烁
const faultShownAt = new Map();
function renderLiveFaults(keys, phase, lms) {
  const box = $("liveFaults");
  const now = performance.now();
  for (const key of keys) faultShownAt.set(key, now);

  const chips = [];
  for (const [key, t] of faultShownAt) {
    if (now - t > 1200) { faultShownAt.delete(key); continue; }
    const rule = RULES[key];
    if (rule) chips.push(`<div class="fault-chip ${rule.severity}">${rule.live}</div>`);
  }
  if (chips.length === 0 && lms &&
      (phase === PHASE.BACKSWING || phase === PHASE.DOWNSWING)) {
    chips.push(`<div class="fault-chip good">动作不错，继续保持</div>`);
  }
  box.innerHTML = chips.join("");
}

/** 打开叠在另一层之上的模态：父层后退压暗，自己用更轻的遮罩。
 *  不这么做就是两层 0.48 的黑叠在一起，只是"更黑了"，读不出层级。 */
function openStackedModal(id, parentId) {
  const parent = $(parentId);
  if (parent && !parent.classList.contains("hidden")) parent.classList.add("pushed");
  $(id).classList.add("stacked");
  $(id).classList.remove("hidden");
}

function closeStackedModal(id, parentId) {
  $(id).classList.add("hidden");
  $(id).classList.remove("stacked");
  $(parentId)?.classList.remove("pushed");
}

let lastSummary = null; // 分享卡数据源

// 注意：存历史（saveSwing）由调用方负责——报告可反复切换查看，不能重复入库
function showSummary(summary, opts = {}) {
  const { count = 1, index = 0, celebrate: doCelebrate = true } = opts;
  lastSummary = summary;
  $("summaryTier").textContent =
    `${tierOf(summary.score)} · 预估击败 ${percentileOf(summary.score)}% 的球友`;
  $("summaryRoast").textContent = `「 ${roastOf(summary)} 」`;
  if (doCelebrate) navigator.vibrate?.(30); // 报告弹出的轻触觉反馈（支持的设备）
  renderSwingTabs(count, index);
  const note = $("summaryNote");
  if (count > 1) {
    note.textContent = opts.audioUsed
      ? `检测到 ${count} 次挥杆 · 已按击球声定位正式挥杆（⛳），点上方切换`
      : `视频中检测到 ${count} 次完整挥杆 · 每杆独立评分，点上方切换`;
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  const { score, faults, tempo } = summary;
  const scoreEl = $("summaryScore");
  scoreEl.className =
    "score " + (score >= 85 ? "s-good" : score >= 65 ? "s-mid" : "s-bad");
  animateScore(scoreEl, score);       // 分数滚动揭晓
  if (doCelebrate && score >= 85) celebrate(); // 高分彩带：值得录屏的瞬间
  updateSessionBadge();

  renderTempo(tempo);
  showReplay();
  renderKeyframes();
  // 步骤4 扩展点（IMU_REPORT_ENABLED）：summary.imu 为契约 imu 块，由
  // 传感器线集成后注入；视觉线不产出，故当前恒为空——渲染器返回空串，
  // UI 与现状一致。flag 关闭时同样注入空串，行为零差异。
  $("imuBlock").innerHTML = flag("IMU_REPORT_ENABLED")
    ? renderImuBlockHtml(summary.imu ?? null)
    : "";

  updateSaveReplayBtn();

  const body = $("summaryBody");
  if (faults.length === 0) {
    body.innerHTML = `<p class="summary-good">🎉 本次挥杆没有检测到明显问题，动作很棒！</p>`;
  } else {
    body.innerHTML = faults.map(faultCardHtml).join("");
  }
  $("summaryModal").classList.remove("hidden");
}

// 报告卡片：问题瞬间截图 + 大白话解释优先，专业内容收进"进阶"折叠区
function faultCardHtml(f) {
  const r = f.rule;
  const cls = r.severity === SEVERITY.BAD ? "bad" : "warn";
  const shot = snapshots.get(f.key);
  const drills = (r.drills || []).map((d) => `<li>${d}</li>`).join("");
  return `
    <div class="summary-item">
      <div class="si-head">
        <span class="si-dot ${cls}"></span>
        <span class="si-title">${r.title}</span>
        ${r.tpi ? `<span class="si-tpi">${r.tpi}</span>` : ""}
      </div>
      ${shot ? `<img class="si-shot" src="${shot}" alt="问题发生瞬间" />` : ""}
      ${r.plain ? `<div class="si-plain">${r.plain}</div>` : ""}
      ${r.why ? `<div class="si-block"><span class="si-label">对球路的影响</span>${r.why}</div>` : ""}
      ${drills ? `<div class="si-block"><span class="si-label">怎么练</span><ul class="si-drills">${drills}</ul></div>` : ""}
      ${r.causes ? `<details class="si-more"><summary>进阶 · 身体原因（TPI 筛查）</summary><p>${r.causes}</p></details>` : ""}
    </div>`;
}

/* ---------- 回放 / 关键帧 / 节奏 ---------- */

function captureKeyframe(key, lms, mirrored) {
  if (!lms || keyframes.has(key)) return;
  const shot = detector.snapshot(video, lms, mirrored, 360);
  if (shot) keyframes.set(key, shot);
}

function renderKeyframes() {
  const order = [
    ["address", "准备"],
    ["top", "顶点"],
    ["impact", "击球"],
    ["finish", "收杆"],
  ];
  const cells = order
    .filter(([k]) => keyframes.has(k))
    .map(
      ([k, label]) =>
        `<figure class="kf"><img src="${keyframes.get(k)}" alt="${label}" /><figcaption>${label}</figcaption></figure>`
    );
  const wrap = $("keyframesWrap");
  wrap.innerHTML = cells.join("");
  wrap.classList.toggle("hidden", cells.length === 0);
}

function renderTempo(tempo) {
  const el = $("summaryTempo");
  if (!tempo) { el.classList.add("hidden"); return; }
  const r = tempo.ratio;
  el.innerHTML =
    `节奏 <b>${r.toFixed(1)} : 1</b> · 上杆 ${(tempo.back / 1000).toFixed(2)}s / ` +
    `下杆 ${(tempo.down / 1000).toFixed(2)}s（职业参考 3:1）`;
  el.classList.toggle("good", r >= 2.4 && r <= 3.6);
  el.classList.remove("hidden");
}

/** 实时模式：基准锁定后开始录制本次挥杆（仅相机模式，双重保险） */
function startRecorder() {
  if (state.source !== "camera") return;
  if (!state.stream || !window.MediaRecorder || recorder) return;
  const mime =
    ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    ) || "";
  try {
    // 分片数组每段录制一份：onstop 是异步的，收尾期间下一杆可能已经开录，
    // 共用同一个数组会让两段互相吞掉分片
    const chunks = [];
    recChunks = chunks;
    recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start();
  } catch {
    recorder = null;
  }
}

/** 实时模式：收杆后停止录制并把回放装进报告 */
function stopRecorderToReplay() {
  if (!recorder || recorder.state === "inactive") { recorder = null; return; }
  const mimeType = recorder.mimeType;
  const chunks = recChunks; // 交接本段分片，后续录制用新数组
  recChunks = [];
  recorder.onstop = () => {
    if (replayUrl) URL.revokeObjectURL(replayUrl);
    const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || "video/webm" });
    if (!blob.size) return;
    replayUrl = URL.createObjectURL(blob);
    const rv = $("replayVideo");
    rv.poster = replayPoster();
    rv.controls = false;
    rv.onloadeddata = () => { rv.playbackRate = REPLAY_RATE; };
    rv.ontimeupdate = null;
    rv.src = replayUrl;
    rv.classList.remove("hidden");
    rv.play().catch(() => { rv.controls = true; });
    armReplayFallback(rv);
  };
  try { recorder.stop(); } catch { /* 忽略 */ }
  recorder = null;
}

function discardRecorder() {
  if (recorder) {
    recorder.onstop = null;
    try { recorder.stop(); } catch { /* 忽略 */ }
    recorder = null;
  }
  recChunks = [];
}

/** 回放兜底封面：iOS 上报告里的第二个 video 元素经常拿不到解码资源、
 *  或非用户手势的自动播放被拒——元素既不报错也不出帧，就是一片纯黑。
 *  先铺一张本次挥杆的真实关键帧当 poster，至少不会是黑屏。 */
function replayPoster() {
  return (
    keyframes.get("impact") || keyframes.get("top") ||
    keyframes.get("address") || keyframes.get("finish") || ""
  );
}

/** 出不了帧就露出原生播放按钮：用户一点就是合法手势，能把回放放出来。 */
function armReplayFallback(rv) {
  clearTimeout(replayFallbackTimer);
  replayFallbackTimer = setTimeout(() => {
    if (rv.paused || rv.readyState < 2) rv.controls = true;
  }, 1500);
}

function showReplay() {
  const rv = $("replayVideo");
  if (state.source === "camera") {
    stopRecorderToReplay(); // 异步装载，onstop 后自动显示
    return;
  }
  // 视频模式：对原视频做挥杆区间慢放循环
  if (!state.fileUrl || !replaySegment.end) return;
  const { start, end } = replaySegment;
  rv.poster = replayPoster();
  rv.controls = false;
  rv.src = state.fileUrl;
  // 用 loadedmetadata 定位：它比 loadeddata 先到，seek 有更多时间完成
  rv.onloadedmetadata = () => {
    rv.currentTime = start;
    rv.playbackRate = REPLAY_RATE;
  };
  rv.onloadeddata = () => {
    rv.playbackRate = REPLAY_RATE;
    rv.play().catch(() => { rv.controls = true; });
  };
  rv.ontimeupdate = () => {
    if (rv.currentTime > end) rv.currentTime = start;
  };
  rv.classList.remove("hidden");
  armReplayFallback(rv);
}

function cleanupReplay() {
  const rv = $("replayVideo");
  rv.pause();
  rv.ontimeupdate = null;
  rv.onloadeddata = null;
  rv.onloadedmetadata = null;
  clearTimeout(replayFallbackTimer);
  rv.controls = false;
  rv.removeAttribute("poster");
  rv.removeAttribute("src");
  rv.classList.add("hidden");
  if (replayUrl) { URL.revokeObjectURL(replayUrl); replayUrl = null; }
  replaySegment.start = 0;
  replaySegment.end = 0;
  $("keyframesWrap").classList.add("hidden");
  $("summaryTempo").classList.add("hidden");
  updateSaveReplayBtn();
}

let hintTimer = 0;
function showHint(text, ms = 3000) {
  const el = $("hint");
  el.textContent = text;
  // 用 .visible 而不是 .hidden：display:none 没法过渡，消失时会硬切
  el.classList.add("visible");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

function hintForView() {
  return state.view === "front"
    ? "正面拍摄：镜头正对球员胸口，距离约 3-4 米，全身入镜"
    : "侧面拍摄：镜头沿目标线方向、与手齐高，距离约 3-4 米";
}

/* ---------------- 交互 ---------------- */

$("startBtn").addEventListener("click", () => {
  if (!state.running) {
    startAnalysis();
    return;
  }
  if (state.source === "camera") {
    // 用户主动停止：不静默丢弃——已进入挥杆阶段则强制收束出报告
    const summary = analyzer.finalize();
    if (summary) {
      saveSwing(summary, "camera");
      showSummary(summary); // 内部会先取走录制的回放，再停止
      stopAnalysis();
    } else {
      const stalled = performance.now() - lastFrameAt > STALL_MS;
      stopAnalysis();
      showHint(
        stalled
          ? "摄像头画面没有更新，这段时间没能分析任何动作：请重新点「开始分析」，若仍无画面请刷新页面"
          : "本次未检测到完整挥杆。提示：摆好准备姿势静止 1 秒再挥杆，收杆后保持姿势片刻，报告会自动弹出",
        6000
      );
    }
  } else {
    // 视频模式中途停止：与播完一样，汇总已检测的挥杆并弹出系统报告
    concludeFileAnalysis();
  }
});

$("closeSummary").addEventListener("click", () => {
  $("summaryModal").classList.add("hidden");
  analyzer.nextSwing();
  resetPerSwing();
  videoSwings.length = 0;
  cleanupReplay();
  if (state.running && state.source === "camera") {
    // 报告里的慢放回放在 iOS 上会把摄像头预览挤停（元素被暂停、甚至采集
    // 轨道被中断）。不主动接回来，detect() 就再也拿不到新帧——"第一杆有
    // 报告、之后怎么挥都识别不到"正是这么来的。看门狗是第二道防线。
    resumePreview();
    resumeTries = 0;
    reopenTries = 0;
    showHint("摆好准备姿势，开始下一次挥杆", 3000);
  }
});

/* ---------- 高光时刻：分数动画 / 彩带 / 今日战绩 ---------- */

function animateScore(el, target) {
  const t0 = performance.now(), dur = 700;
  (function tick() {
    const p = Math.min(1, (performance.now() - t0) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))) + " 分";
    if (p < 1) requestAnimationFrame(tick);
  })();
}

/** 系统开启「减弱动态效果」时不放彩带：纯装饰，且是全屏大范围运动 */
const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function celebrate() {
  if (prefersReducedMotion()) return;
  const c = $("confetti");
  c.width = innerWidth;
  c.height = innerHeight;
  c.classList.remove("hidden");
  const ctx2 = c.getContext("2d");
  const colors = ["#30d158", "#ffd60a", "#ffffff", "#64d2ff"];
  const parts = Array.from({ length: 90 }, () => ({
    x: Math.random() * c.width,
    y: -20 - Math.random() * c.height * 0.3,
    r: 5 + Math.random() * 6,
    vy: 2.5 + Math.random() * 3.5,
    vx: (Math.random() - 0.5) * 2,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    col: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function tick() {
    ctx2.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx2.save();
      ctx2.translate(p.x, p.y);
      ctx2.rotate(p.rot);
      ctx2.fillStyle = p.col;
      ctx2.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx2.restore();
    }
    if (performance.now() - t0 < 1800) requestAnimationFrame(tick);
    else {
      ctx2.clearRect(0, 0, c.width, c.height);
      c.classList.add("hidden");
    }
  })();
}

function updateSessionBadge() {
  const el = $("sessionBadge");
  // 今日战绩是实时练习的角标；看视频的场景下展示会造成困惑
  if (state.source === "file") { el.classList.add("hidden"); return; }
  const todayKey = new Date().toDateString();
  const today = getSwings().filter(
    (s) => new Date(s.t).toDateString() === todayKey
  );
  if (!today.length) { el.classList.add("hidden"); return; }
  const best = Math.max(...today.map((s) => s.score));
  el.textContent = `今日第 ${today.length} 杆 · 最佳 ${best} 分`;
  el.classList.remove("hidden");
}

$("closeOnboard").addEventListener("click", () => {
  $("onboardModal").classList.add("hidden");
  showHint(hintForView(), 4000);
});

/* 报告内逐杆切换器（视频中检测到多次挥杆时显示） */
function renderSwingTabs(count, index) {
  const el = $("swingTabs");
  if (count < 2) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.innerHTML = Array.from({ length: count }, (_, i) => {
    const sw = videoSwings[i];
    const mark = sw?.strike === true ? " ⛳" : sw?.strike === false ? '<span class="st-practice">试挥?</span>' : "";
    return `<button class="swing-tab${i === index ? " active" : ""}" data-i="${i}">第 ${i + 1} 杆${mark}<span class="st-score">${sw?.summary.score ?? ""}</span></button>`;
  }).join("");
  el.classList.remove("hidden");
}

$("swingTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  presentSwing(Number(b.dataset.i));
});

/* ---------- 分享卡 ---------- */

function openShare(dataUrl) {
  $("shareImg").src = dataUrl;
  // 分享卡可能开在报告之上（逐杆分享），也可能从统计面板开（周报）
  const parent = !$("summaryModal").classList.contains("hidden") ? "summaryModal" : "statsModal";
  openStackedModal("shareModal", parent);
}

$("shareSummaryBtn").addEventListener("click", async () => {
  if (!lastSummary) return;
  $("shareSummaryBtn").textContent = "生成中…";
  try {
    openShare(await buildSwingCard(lastSummary, keyframes));
  } finally {
    $("shareSummaryBtn").textContent = "生成成绩分享卡";
  }
});

$("shareWeeklyBtn").addEventListener("click", async () => {
  const st = computeStats();
  if (!st) { showHint("还没有练习数据，先完成一次挥杆分析", 2500); return; }
  $("shareWeeklyBtn").textContent = "生成中…";
  try {
    openShare(await buildWeeklyCard(st));
  } finally {
    $("shareWeeklyBtn").textContent = "生成周报分享卡";
  }
});

$("closeShare").addEventListener("click", () => {
  closeStackedModal("shareModal", "summaryModal");
  $("statsModal").classList.remove("pushed"); // 周报分享卡的父层是统计面板
});

$("shareSend").addEventListener("click", async () => {
  try {
    const blob = await (await fetch($("shareImg").src)).blob();
    const file = new File([blob], "jaykay-golf.jpg", { type: "image/jpeg" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "JAYKAY Golf 挥杆成绩" });
    } else {
      showHint("当前浏览器不支持系统分享，请长按图片保存", 3000);
    }
  } catch {
    /* 用户取消分享 */
  }
});

/* ---------- 保存慢放视频（REPLAY_DOWNLOAD） ---------- */

// 转码好但还没交给用户的慢放文件。必须存成两步：
// iOS 的 navigator.share() 只接受【用户手势直接触发】的调用，而转码要跑好几秒，
// 手势早过期了——share() 会抛 NotAllowedError，分享面板根本不弹，用户既没看到
// 面板也没看到报错（旧实现还把它当"用户取消"吞掉了）。所以转码完先把文件握在
// 手里，把按钮变成"点此保存"，用户那一下点击就是新鲜手势，面板必定弹出。
let pendingReplay = null; // { blob, name, slowmo }

/** 本次报告能不能导出回放：相机模式看录到的 blob，视频模式看挥杆区间 */
function replaySource() {
  if (state.source === "camera")
    return replayUrl ? { start: 0, end: 0, hasRawBlob: true } : null;
  if (state.fileUrl && replaySegment.end > replaySegment.start)
    return { start: replaySegment.start, end: replaySegment.end, hasRawBlob: false };
  return null;
}

/** 回到第一步（换杆、关报告、保存完成后都要复位，别把上一杆的文件留着） */
function updateSaveReplayBtn() {
  const btn = $("saveReplayBtn");
  if (!btn) return;
  pendingReplay = null;
  btn.classList.toggle("hidden", !(flag("REPLAY_DOWNLOAD") && replaySource()));
  btn.classList.remove("ready");
  btn.disabled = false;
  btn.textContent = "保存慢放视频";
}

/** 第一步：本地转码，按钮上跑实时进度（两种模式共用同一条路径） */
async function buildSlowMotion(src) {
  const btn = $("saveReplayBtn");
  const rv = $("replayVideo");
  const ex = await import("./replayExport.js");
  const cap = ex.exportCapability({
    hasSource: true,
    hasRawBlob: src.hasRawBlob,
    hasCaptureStream: typeof HTMLCanvasElement.prototype.captureStream === "function",
    hasRecorder: typeof window.MediaRecorder === "function",
  });
  if (cap === "none") throw new Error("当前浏览器无法保存回放视频");
  if (cap === "raw") {
    // 拿不到重编码能力：如实降级为原速片段，不假装是慢放
    const blob = await (await fetch(replayUrl)).blob();
    return { blob, name: ex.exportFileName(lastSummary?.score, blob.type), slowmo: false };
  }
  // 时长只探测一次：相机模式的 blob duration 常年 Infinity，要 seek 出来。
  // 顺手把 end 补全，renderSlowMotion 里就不必再探一遍
  const end = src.end > src.start ? src.end : src.start + (await ex.resolveDuration(rv));
  const secs = Math.max(1, Math.ceil(ex.estimateSeconds(src.start, end, REPLAY_RATE)));
  btn.textContent = `正在生成慢放视频 0%`;
  showHint(`正在本地生成慢放视频（约 ${secs} 秒），视频不会上传，请别离开本页`, secs * 1000 + 2000);
  const loop = rv.ontimeupdate;   // 区间循环会打断录制，先摘掉
  rv.ontimeupdate = null;
  rv.loop = false;
  let blob;
  try {
    blob = await ex.renderSlowMotion(rv, {
      rate: REPLAY_RATE, start: src.start, end,
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        const left = Math.max(0, Math.ceil(secs * (1 - p)));
        btn.textContent = `正在生成慢放视频 ${pct}%${left ? ` · 还剩 ${left} 秒` : ""}`;
      },
    });
  } finally {
    rv.ontimeupdate = loop;
    rv.loop = true;
    rv.currentTime = src.start;
    rv.playbackRate = REPLAY_RATE;
    rv.play().catch(() => { rv.controls = true; });
  }
  return { blob, name: ex.exportFileName(lastSummary?.score, blob.type), slowmo: true };
}

/** 第二步：把握在手里的文件交出去。必须在用户点击的同一个事件里调用 */
async function handOffReplay() {
  const { blob, name, slowmo } = pendingReplay;
  const btn = $("saveReplayBtn");
  const ex = await import("./replayExport.js");
  try {
    const how = await ex.saveVideoBlob(blob, name);
    btn.textContent = "已保存 ✓";
    showHint(
      how === "shared"
        ? (slowmo
            ? "在弹出的面板里选「存储视频」即可存进相册"
            : "已保存【原速】片段（本机不支持本地转码，可在剪辑 App 里调慢）")
        : `已下载到「文件」App：${name}`,
      6000
    );
    setTimeout(updateSaveReplayBtn, 2500);
  } catch (err) {
    if (err?.name === "AbortError") {   // 用户自己在面板上点了取消：留在第二步等他再点
      btn.textContent = "存到相册 · 点此完成";
      return;
    }
    // 分享被系统拒绝（手势失效等）→ 退回下载，别让用户白转一圈
    try {
      await ex.saveVideoBlob(blob, name, { forceDownload: true });
      btn.textContent = "已保存 ✓";
      showHint(`系统分享不可用，已下载到「文件」App：${name}`, 6000);
      setTimeout(updateSaveReplayBtn, 2500);
    } catch (e2) {
      // 两条路都走不通就如实说，不能显示"已保存"骗人
      btn.textContent = "存到相册 · 点此重试";
      showHint("保存失败：" + (e2?.message || err?.message || err), 6000);
    }
  }
}

$("saveReplayBtn").addEventListener("click", async () => {
  const btn = $("saveReplayBtn");
  if (pendingReplay) return void handOffReplay();  // 第二步：这一下就是新鲜手势
  const src = replaySource();
  if (!src) return;
  btn.disabled = true;
  try {
    pendingReplay = await buildSlowMotion(src);
    btn.disabled = false;
    btn.classList.add("ready");
    btn.textContent = pendingReplay.slowmo ? "存到相册 · 点此完成" : "保存原速片段 · 点此完成";
    showHint(
      pendingReplay.slowmo
        ? "慢放视频已生成 · 点上面的按钮，在弹出的面板里选「存储视频」"
        : "本机不支持本地转码，已备好【原速】片段 · 点上面的按钮保存",
      8000
    );
  } catch (err) {
    pendingReplay = null;
    btn.disabled = false;
    btn.textContent = "保存慢放视频";
    showHint("生成失败：" + (err?.message || err), 5000);
  }
});

/* ---------- 练习统计面板 ---------- */

$("statsBtn").addEventListener("click", () => {
  renderStats();
  $("statsModal").classList.remove("hidden");
});

$("closeStats").addEventListener("click", () => {
  $("statsModal").classList.add("hidden");
});

function renderStats() {
  const body = $("statsBody");
  const st = computeStats();
  if (!st) {
    body.innerHTML = `<p class="stats-empty">还没有练习数据。完成第一次挥杆分析后，这里会出现你的进步曲线。</p>`;
    return;
  }

  // 本周概览
  const diff =
    st.week.prevScore !== null ? st.week.score - st.week.prevScore : null;
  const diffHtml =
    diff === null
      ? ""
      : `<span class="stat-diff ${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : ""}${diff} vs 上周</span>`;
  let html = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${st.week.count}</div><div class="stat-label">本周挥杆</div></div>
      <div class="stat-card"><div class="stat-num">${st.week.score || "—"}</div><div class="stat-label">平均分 ${diffHtml}</div></div>
      <div class="stat-card"><div class="stat-num">${st.week.tempo ? st.week.tempo + ":1" : "—"}</div><div class="stat-label">平均节奏</div></div>
    </div>`;

  // 主攻问题（按 TPI 因果链取根因）
  if (st.focus) {
    const f = st.focus;
    const trend =
      f.prev === null
        ? ""
        : ` · ${f.now <= f.prev ? "↓" : "↑"} 上周 ${Math.round(f.prev * 100)}%`;
    html += `
      <div class="focus-card">
        <div class="focus-tag">本周主攻一个问题</div>
        <div class="focus-title">${f.rule.title}</div>
        <div class="focus-rate">触发率 ${Math.round(f.now * 100)}%${trend}</div>
        <div class="focus-drill">${f.rule.drills?.[0] || ""}</div>
        <div class="focus-note">教练逻辑：一次只改一个根因问题，相关的连锁问题往往随之消失。</div>
      </div>`;
  }

  // 14 天评分趋势（柱状图）
  const hasTrend = st.days.some((d) => d.score !== null);
  if (hasTrend) {
    const bars = st.days
      .map((d) => {
        const h = d.score === null ? 0 : ((d.score - 40) / 60) * 100;
        return `<div class="bar-col">
          <div class="bar" style="height:${Math.max(h, d.score ? 6 : 0)}%" title="${d.score ?? ""}"></div>
          <div class="bar-label">${d.label}</div>
        </div>`;
      })
      .join("");
    html += `
      <div class="stats-section-label">最近 14 天平均分</div>
      <div class="trend-chart">${bars}</div>`;
  }

  // 问题触发率（本周）
  if (st.faultStats.length) {
    html += `<div class="stats-section-label">问题触发率（本周）</div>`;
    html += st.faultStats
      .slice(0, 8)
      .map((f) => {
        const pct = Math.round(f.now * 100);
        const arrow =
          f.prev === null ? "" : f.now < f.prev ? "<span class='fr-down'>↓</span>" : f.now > f.prev ? "<span class='fr-up'>↑</span>" : "";
        return `
        <div class="fault-rate">
          <span class="fr-name">${f.rule.title}</span>
          <div class="fr-bar"><div class="fr-fill" style="width:${pct}%"></div></div>
          <span class="fr-pct">${pct}% ${arrow}</span>
        </div>`;
      })
      .join("");
  }

  html += `<p class="stats-foot">共记录 ${st.total} 次挥杆 · 数据仅保存在本机</p>`;
  body.innerHTML = html;
}

/* ---------- 语音设置面板 ---------- */

$("voiceBtn").addEventListener("click", () => {
  coach.unlock(); // 借这次点击手势解锁语音，确保试听可发声
  renderVoiceList();
  syncVoiceUI();
  $("voiceModal").classList.remove("hidden");
});

$("closeVoice").addEventListener("click", () => {
  $("voiceModal").classList.add("hidden");
});

$("voiceToggleRow").addEventListener("click", () => {
  coach.setEnabled(!coach.enabled);
  syncVoiceUI();
});

$("voiceList").addEventListener("click", (e) => {
  const row = e.target.closest(".voice-row[data-name]");
  if (!row) return;
  coach.setVoiceByName(row.dataset.name);
  renderVoiceList();
});

function syncVoiceUI() {
  $("voiceSwitch").classList.toggle("on", coach.enabled);
  $("voiceBtn").classList.toggle("off", !coach.enabled);
  $("voiceBtn").textContent = coach.enabled ? "🔊" : "🔇";
}

function renderVoiceList() {
  const voices = coach.listVoices();
  const cur = coach.voice?.name;
  $("voiceList").innerHTML = voices.length
    ? voices
        .map(
          (v) => `
          <div class="voice-row" data-name="${v.name}">
            <span class="v-name">${v.name}</span>
            <span class="v-lang">${v.lang}</span>
            ${v.name === cur ? `<span class="v-check">✓</span>` : ""}
          </div>`
        )
        .join("")
    : `<div class="voice-empty">当前浏览器没有可用的中文语音。iPhone 可在 设置 → 辅助功能 → 朗读内容 → 声音 中下载；安卓需安装系统 TTS 引擎。</div>`;
}

$("aboutLink").addEventListener("click", () => {
  $("aboutVer").textContent = `JAYKAY Golf v${APP_VERSION}`;
  openStackedModal("aboutModal", "chooser"); // 关于开在选择页之上
});

$("closeAbout").addEventListener("click", () => {
  closeStackedModal("aboutModal", "chooser");
});

$("feedbackBtn").addEventListener("click", () => {
  location.href =
    "mailto:ding1430829048@gmail.com?subject=" +
    encodeURIComponent(`JAYKAY Golf 反馈 (v${APP_VERSION})`);
});

// 清除本地数据：双击确认，避免误触
let clearArmed = false;
$("clearDataBtn").addEventListener("click", () => {
  if (!clearArmed) {
    clearArmed = true;
    $("clearDataBtn").textContent = "再点一次确认清除";
    setTimeout(() => {
      clearArmed = false;
      $("clearDataBtn").textContent = "清除本地数据";
    }, 3000);
    return;
  }
  clearSwings();
  clearArmed = false;
  $("clearDataBtn").textContent = "清除本地数据";
  updateSessionBadge();
  showHint("本地练习数据已清除", 2500);
});

$("chooseLive").addEventListener("click", () => {
  $("chooser").classList.add("hidden");
  startLiveMode();
});

$("chooseUpload").addEventListener("click", () => {
  $("chooser").classList.add("hidden");
  $("videoInput").click();
});

$("uploadBtn").addEventListener("click", () => $("videoInput").click());

$("videoInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // 允许重复选择同一个文件
  if (!file) return;
  if (file.type && !file.type.startsWith("video/")) {
    showHint("请选择视频文件（相册里拍摄的挥杆视频）", 3000);
    if (!state.stream && !state.fileUrl) $("chooser").classList.remove("hidden");
    return;
  }
  enterFileMode(file);
});

// 在选择页点了上传又取消选择 → 回到选择页（此时没有任何画面来源）
$("videoInput").addEventListener("cancel", () => {
  if (!state.stream && !state.fileUrl) $("chooser").classList.remove("hidden");
});

$("flipBtn").addEventListener("click", async () => {
  if (state.source === "file") {
    await exitFileMode();
    return;
  }
  state.facing = state.facing === "environment" ? "user" : "environment";
  try {
    await openCamera();
  } catch {
    // 部分设备只有单摄像头，切换失败时回退
    state.facing = state.facing === "environment" ? "user" : "environment";
    await openCamera();
  }
});

function bindSeg(segId, dataKey, onChange) {
  $(segId).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $(segId).querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onChange(btn.dataset[dataKey]);
  });
}

bindSeg("viewSeg", "view", (v) => {
  state.view = v;
  if (state.running) stopAnalysis();
  analyzer = newAnalyzer();
  showHint(state.source === "file" ? "机位已切换，点「开始分析」重新分析视频" : hintForView(), 4000);
});

bindSeg("handSeg", "hand", (h) => {
  state.handedness = h;
  if (state.running) stopAnalysis();
  analyzer = newAnalyzer();
});

// 传感器线装载（SENSOR_ENABLED）：动态 import 传感器模块（路径占位，
// 由传感器线在独立模块交付），缺失/失败时安静回退 NullProvider。
// 视觉线的任何行为不依赖其存在；两线仅通过 SwingSession 契约的 imu 块交互。
let externalProvider = null;
if (flag("SENSOR_ENABLED")) {
  import("./providers/loadProvider.js")
    .then(function (m) { return m.loadExternalProvider(); })
    .then(async function (r) {
      externalProvider = r.provider;
      window.__sensorProvider = r.provider; // 调试句柄
      const connected = await r.provider.connect().catch(function () { return false; });
      console.info(
        "[sensor] provider=" + r.source + " connected=" + connected +
        (r.reason ? "（回退原因：" + r.reason + "）" : "")
      );
    })
    .catch(function () { /* 装载器失败也不影响视觉主线 */ });
}

// exportSession 入口（EXPORT_ENABLED）：当前仅提供程序化调用（控制台/
// 后续 UI 复用），把本次分析的各杆 summary 映射为 SwingSession 契约实例。
// 动态 import：开关关闭时导出模块完全不加载。
if (flag("EXPORT_ENABLED")) {
  window.__exportSession = async function (opts) {
    const { exportSession } = await import("./exportSession.js");
    const summaries = videoSwings.length
      ? videoSwings.map(function (s) { return s.summary; })
      : lastSummary ? [lastSummary] : [];
    if (!summaries.length) throw new Error("当前没有可导出的挥杆分析结果");
    return exportSession(summaries, opts);
  };
}

// PWA：离线缓存 + 可添加到主屏幕（顺带缓解 github.io 二次访问的不稳定）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
