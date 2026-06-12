// 应用主控：相机/视频文件双数据源、推理循环、语音反馈、UI 状态与渲染
import { PoseDetector } from "./poseDetector.js";
import { SwingAnalyzer, PHASE, PHASE_LABEL } from "./swingAnalyzer.js";
import { RULES, SEVERITY } from "./rules.js";
import { VoiceCoach } from "./voice.js";
import { saveSwing, computeStats } from "./store.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

const state = {
  running: false,
  source: "camera",      // "camera" 实时相机 | "file" 上传的视频
  facing: "environment", // 默认后置镜头（由他人帮拍）
  view: "front",
  handedness: "right",
  stream: null,
  fileUrl: null,
  rafId: 0,
  frames: 0,
  fpsT0: performance.now(),
};

const detector = new PoseDetector();
const coach = new VoiceCoach();
let analyzer = new SwingAnalyzer(state.view, state.handedness);
// 每次挥杆中各问题首次出现瞬间的截图（报告中展示）
const snapshots = new Map();
let baselineAnnounced = false;
// 关键位置帧（准备/顶点/击球/收杆）与慢放回放
const keyframes = new Map();
let prevPhase = PHASE.IDLE;
let recorder = null;          // 实时模式：MediaRecorder
let recChunks = [];
let replayUrl = null;         // 实时模式：回放 blob URL
const replaySegment = { start: 0, end: 0 }; // 视频模式：挥杆起止时间点
// 视频模式：整段视频中检测到的每次完整挥杆（试挥+正式击球）。
// 看完全片后只报告最后一次——实拍素材里正式击球几乎总是最后一挥。
const videoSwings = [];

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
    $("loadingText").textContent = "正在加载 AI 姿态模型…";
    await detector.init();
  } catch (err) {
    // 模型加载失败是致命错误，保留遮罩提示
    $("loadingText").textContent = "AI 模型加载失败，请检查网络后刷新页面。" + (err?.message || "");
    $("loading").querySelector(".spinner")?.remove();
    return;
  }
  // 不自动开启摄像头：让用户先选择实时拍摄还是上传视频
  $("loading").classList.add("hidden");
  $("chooser").classList.remove("hidden");
}

async function startLiveMode() {
  $("loadingText").textContent = "正在打开摄像头…";
  $("loading").classList.remove("hidden");
  try {
    await openCamera();
    $("loading").classList.add("hidden");
    if (state.source === "camera") showHint(hintForView(), 4000);
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
window.addEventListener("resize", resizeOverlay);

/* ---------------- 视频文件模式 ---------------- */

async function enterFileMode(file) {
  stopAnalysis();
  camSeq++; // 作废任何还在等待中的摄像头打开请求
  stopMediaSources();
  state.source = "file";
  state.fileUrl = URL.createObjectURL(file);
  video.src = state.fileUrl;
  video.classList.remove("mirrored");
  video.loop = false;
  $("stage").classList.add("file-mode");
  $("flipBtn").textContent = "返回相机";
  await new Promise((res) => (video.onloadedmetadata = res));
  resizeOverlay();
  showHint("请确认上方机位选择与视频拍摄角度一致，点「开始分析」", 5000);
  $("phasePill").textContent = "视频已就绪";
}

async function exitFileMode() {
  stopAnalysis();
  $("stage").classList.remove("file-mode");
  $("flipBtn").textContent = "切换镜头";
  try {
    await openCamera();
    showHint(hintForView(), 3000);
  } catch (err) {
    showHint(cameraErrorMessage(err), 5000);
  }
}

video.addEventListener("ended", () => {
  if (state.source !== "file" || !state.running) return;
  // 片尾若正处于挥杆中（正式击球被剪到结尾），强制收束成一次挥杆
  replaySegment.end = video.duration || video.currentTime;
  const tail = analyzer.finalize();
  if (tail) videoSwings.push(packSwing(tail));

  // 只报告最后一次挥杆：试挥/热身动作在前，正式击球几乎总是最后一挥
  const chosen = videoSwings[videoSwings.length - 1];
  if (chosen) {
    restoreSwing(chosen);
    showSummary(chosen.summary, videoSwings.length);
  } else if (analyzer.phase !== PHASE.FINISH) {
    showHint("视频中未识别到完整挥杆，请确认全身入镜且机位选择正确", 5000);
  }
  stopAnalysis();
  $("phasePill").textContent = "播放结束";
});

/** 打包/恢复一次挥杆的全部展示数据（报告、问题截图、关键帧、回放区间） */
function packSwing(summary) {
  return {
    summary,
    snapshots: new Map(snapshots),
    keyframes: new Map(keyframes),
    segment: { ...replaySegment },
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
}

/* ---------------- 推理主循环 ---------------- */

function loop() {
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now();
  const lms = detector.detect(video, now);
  // undefined = 视频没有新帧（文件帧率低于渲染帧率），跳过本次分析
  if (lms !== undefined) {
    const mirrored = state.source === "camera" && state.facing === "user";
    detector.draw(ctx, lms, mirrored);
    const { phase, liveFaults, summary } = analyzer.update(lms, now);
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
      if (phase === PHASE.BACKSWING && state.source === "file")
        replaySegment.start = Math.max(0, video.currentTime - 1);
      if (phase === PHASE.TOP) captureKeyframe("top", lms, mirrored);
      if (phase === PHASE.IMPACT) captureKeyframe("impact", lms, mirrored);
      if (phase === PHASE.FINISH) captureKeyframe("finish", lms, mirrored);
      prevPhase = phase;
    }
    // 实时问题：语音播报 + 截取问题瞬间画面
    for (const key of liveFaults) {
      const rule = RULES[key];
      if (rule?.voice) coach.say(rule.voice, key, 7000);
      if (lms && !snapshots.has(key)) {
        const shot = detector.snapshot(video, lms, mirrored);
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
        showSummary(summary);
      }
    }
  }

  // FPS 统计
  state.frames++;
  if (now - state.fpsT0 > 1000) {
    $("fpsLabel").textContent = state.frames + " FPS";
    state.frames = 0;
    state.fpsT0 = now;
  }
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
  analyzer = new SwingAnalyzer(state.view, state.handedness);
  resetPerSwing();
  videoSwings.length = 0;
  discardRecorder();
  cleanupReplay();
  coach.unlock(); // 借用户点击手势解锁 iOS 语音
  state.running = true;
  const btn = $("startBtn");
  btn.textContent = "停止分析";
  btn.classList.add("stop");
  if (state.source === "file") {
    video.currentTime = 0;
    detector.lastVideoTime = -1;
    await video.play();
    showHint("正在分析视频…", 2500);
  } else {
    showHint("摆好准备姿势并静止 1 秒，开始你的挥杆", 4000);
  }
  loop();
}

function stopAnalysis() {
  if (!state.running) return;
  state.running = false;
  coach.stop();
  discardRecorder();
  cancelAnimationFrame(state.rafId);
  if (state.source === "file") video.pause();
  const btn = $("startBtn");
  btn.textContent = state.source === "file" ? "重新分析" : "开始分析";
  btn.classList.remove("stop");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  $("liveFaults").innerHTML = "";
  $("phasePill").textContent = "未开始";
  $("phasePill").classList.remove("active");
}

/* ---------------- UI 渲染 ---------------- */

function renderPhase(phase) {
  const pill = $("phasePill");
  pill.textContent = PHASE_LABEL[phase] || "—";
  pill.classList.toggle("active", phase !== PHASE.IDLE);
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

function showSummary(summary, swingCount = 1) {
  saveSwing(summary, state.source); // 存入练习历史（仅元数据，不含视频）
  const note = $("summaryNote");
  if (swingCount > 1) {
    note.textContent = `视频中检测到 ${swingCount} 次挥杆动作 · 已分析最后一次（通常为正式击球）`;
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  const { score, faults, tempo } = summary;
  const scoreEl = $("summaryScore");
  scoreEl.textContent = score + " 分";
  scoreEl.className =
    "score " + (score >= 85 ? "s-good" : score >= 65 ? "s-mid" : "s-bad");

  renderTempo(tempo);
  showReplay();
  renderKeyframes();

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
    recChunks = [];
    recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.start();
  } catch {
    recorder = null;
  }
}

/** 实时模式：收杆后停止录制并把回放装进报告 */
function stopRecorderToReplay() {
  if (!recorder || recorder.state === "inactive") { recorder = null; return; }
  const mimeType = recorder.mimeType;
  recorder.onstop = () => {
    if (replayUrl) URL.revokeObjectURL(replayUrl);
    const blob = new Blob(recChunks, { type: mimeType || recChunks[0]?.type || "video/webm" });
    recChunks = [];
    if (!blob.size) return;
    replayUrl = URL.createObjectURL(blob);
    const rv = $("replayVideo");
    rv.onloadeddata = () => { rv.playbackRate = 0.4; };
    rv.ontimeupdate = null;
    rv.src = replayUrl;
    rv.classList.remove("hidden");
    rv.play().catch(() => {});
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

function showReplay() {
  const rv = $("replayVideo");
  if (state.source === "camera") {
    stopRecorderToReplay(); // 异步装载，onstop 后自动显示
    return;
  }
  // 视频模式：对原视频做挥杆区间慢放循环
  if (!state.fileUrl || !replaySegment.end) return;
  const { start, end } = replaySegment;
  rv.src = state.fileUrl;
  rv.onloadeddata = () => {
    rv.currentTime = start;
    rv.playbackRate = 0.4;
    rv.play().catch(() => {});
  };
  rv.ontimeupdate = () => {
    if (rv.currentTime > end) rv.currentTime = start;
  };
  rv.classList.remove("hidden");
}

function cleanupReplay() {
  const rv = $("replayVideo");
  rv.pause();
  rv.ontimeupdate = null;
  rv.onloadeddata = null;
  rv.removeAttribute("src");
  rv.classList.add("hidden");
  if (replayUrl) { URL.revokeObjectURL(replayUrl); replayUrl = null; }
  replaySegment.start = 0;
  replaySegment.end = 0;
  $("keyframesWrap").classList.add("hidden");
  $("summaryTempo").classList.add("hidden");
}

let hintTimer = 0;
function showHint(text, ms = 3000) {
  const el = $("hint");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function hintForView() {
  return state.view === "front"
    ? "正面拍摄：镜头正对球员胸口，距离约 3-4 米，全身入镜"
    : "侧面拍摄：镜头沿目标线方向、与手齐高，距离约 3-4 米";
}

/* ---------------- 交互 ---------------- */

$("startBtn").addEventListener("click", () => {
  if (state.running) stopAnalysis();
  else startAnalysis();
});

$("closeSummary").addEventListener("click", () => {
  $("summaryModal").classList.add("hidden");
  analyzer.nextSwing();
  resetPerSwing();
  videoSwings.length = 0;
  cleanupReplay();
  if (state.running && state.source === "camera")
    showHint("摆好准备姿势，开始下一次挥杆", 3000);
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
  if (file) enterFileMode(file);
  e.target.value = ""; // 允许重复选择同一个文件
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
  analyzer = new SwingAnalyzer(state.view, state.handedness);
  showHint(state.source === "file" ? "机位已切换，点「开始分析」重新分析视频" : hintForView(), 4000);
});

bindSeg("handSeg", "hand", (h) => {
  state.handedness = h;
  if (state.running) stopAnalysis();
  analyzer = new SwingAnalyzer(state.view, state.handedness);
});

boot();
