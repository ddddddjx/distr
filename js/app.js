// 应用主控：相机/视频文件双数据源、推理循环、UI 状态与反馈渲染
import { PoseDetector } from "./poseDetector.js";
import { SwingAnalyzer, PHASE, PHASE_LABEL } from "./swingAnalyzer.js";
import { RULES, SEVERITY } from "./rules.js";

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
let analyzer = new SwingAnalyzer(state.view, state.handedness);

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
  $("loadingText").textContent = "正在打开摄像头…";
  try {
    await openCamera();
    $("loading").classList.add("hidden");
    showHint(hintForView(), 4000);
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

async function openCamera() {
  stopMediaSources();
  state.source = "camera";
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("当前浏览器环境不支持摄像头 API");

  // 约束逐级放宽：部分 WebView/老设备对分辨率或 facingMode 约束会直接挂起
  const constraintTries = [
    { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    { facingMode: state.facing },
    true,
  ];
  let lastErr = null;
  for (const c of constraintTries) {
    try {
      state.stream = await withTimeout(
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
  if (!state.stream) throw lastErr || new Error("无法获取摄像头");

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
  stopMediaSources();
  state.source = "file";
  state.fileUrl = URL.createObjectURL(file);
  video.src = state.fileUrl;
  video.classList.remove("mirrored");
  video.loop = false;
  $("stage").classList.add("file-mode");
  $("flipBtn").textContent = "🎥 返回相机";
  await new Promise((res) => (video.onloadedmetadata = res));
  resizeOverlay();
  showHint("请确认上方机位选择与视频拍摄角度一致，点「开始分析」", 5000);
  $("phasePill").textContent = "视频已就绪";
}

async function exitFileMode() {
  stopAnalysis();
  $("stage").classList.remove("file-mode");
  $("flipBtn").textContent = "🔄 切换镜头";
  try {
    await openCamera();
    showHint(hintForView(), 3000);
  } catch (err) {
    showHint(cameraErrorMessage(err), 5000);
  }
}

video.addEventListener("ended", () => {
  if (state.source !== "file" || !state.running) return;
  // 视频放完但还没自然收杆：强制出报告
  const summary = analyzer.finalize();
  if (summary) showSummary(summary);
  stopAnalysis();
  $("phasePill").textContent = "播放结束";
  if (!summary && analyzer.phase !== PHASE.FINISH)
    showHint("视频中未识别到完整挥杆，请确认全身入镜且机位选择正确", 5000);
});

/* ---------------- 推理主循环 ---------------- */

function loop() {
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now();
  const lms = detector.detect(video, now);
  // undefined = 视频没有新帧（文件帧率低于渲染帧率），跳过本次分析
  if (lms !== undefined) {
    detector.draw(ctx, lms, state.source === "camera" && state.facing === "user");
    const { phase, liveFaults, summary } = analyzer.update(lms, now);
    renderPhase(phase);
    renderLiveFaults(liveFaults, phase, lms);
    if (summary) showSummary(summary);
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
    chips.push(`<div class="fault-chip good">✅ 动作不错，继续保持</div>`);
  }
  box.innerHTML = chips.join("");
}

function showSummary(summary) {
  const { score, faults } = summary;
  const scoreEl = $("summaryScore");
  scoreEl.textContent = score + " 分";
  scoreEl.className =
    "score " + (score >= 85 ? "s-good" : score >= 65 ? "s-mid" : "s-bad");

  const body = $("summaryBody");
  if (faults.length === 0) {
    body.innerHTML = `<p class="summary-good">🎉 本次挥杆没有检测到明显问题，动作很棒！</p>`;
  } else {
    body.innerHTML = faults.map(faultCardHtml).join("");
  }
  $("summaryModal").classList.remove("hidden");
}

// 报告卡片：TPI 特征名 + 球路影响 + 身体筛查原因 + 矫正练习
function faultCardHtml(f) {
  const r = f.rule;
  const cls = r.severity === SEVERITY.BAD ? "bad" : "warn";
  const drills = (r.drills || [])
    .map((d) => `<li>${d}</li>`)
    .join("");
  return `
    <div class="summary-item">
      <div class="si-title ${cls}">${r.title}</div>
      ${r.tpi ? `<div class="si-tpi">${r.tpi}</div>` : ""}
      ${r.why ? `<div class="si-block"><span class="si-label">影响</span>${r.why}</div>` : ""}
      ${r.causes ? `<div class="si-block"><span class="si-label">身体筛查</span>${r.causes}</div>` : ""}
      ${drills ? `<div class="si-block"><span class="si-label">矫正练习</span><ul class="si-drills">${drills}</ul></div>` : ""}
    </div>`;
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
    ? "📷 正面拍摄：镜头正对球员胸口，距离约 3-4 米，全身入镜"
    : "📷 侧面拍摄：镜头沿目标线方向、与手齐高，距离约 3-4 米";
}

/* ---------------- 交互 ---------------- */

$("startBtn").addEventListener("click", () => {
  if (state.running) stopAnalysis();
  else startAnalysis();
});

$("closeSummary").addEventListener("click", () => {
  $("summaryModal").classList.add("hidden");
  analyzer.nextSwing();
  if (state.running && state.source === "camera")
    showHint("摆好准备姿势，开始下一次挥杆", 3000);
});

$("uploadBtn").addEventListener("click", () => $("videoInput").click());

$("videoInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) enterFileMode(file);
  e.target.value = ""; // 允许重复选择同一个文件
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
