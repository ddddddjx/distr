// 应用主控：相机管理、推理循环、UI 状态与反馈渲染
import { PoseDetector } from "./poseDetector.js";
import { SwingAnalyzer, PHASE, PHASE_LABEL } from "./swingAnalyzer.js";
import { RULES, SEVERITY } from "./rules.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

const state = {
  running: false,
  facing: "environment", // 默认后置镜头（由他人帮拍）
  view: "front",
  handedness: "right",
  stream: null,
  rafId: 0,
  frames: 0,
  fpsT0: performance.now(),
};

const detector = new PoseDetector();
let analyzer = new SwingAnalyzer(state.view, state.handedness);

/* ---------------- 初始化 ---------------- */

async function boot() {
  try {
    $("loadingText").textContent = "正在加载 AI 姿态模型…";
    await detector.init();
    $("loadingText").textContent = "正在打开摄像头…";
    await openCamera();
    $("loading").classList.add("hidden");
    showHint(hintForView(), 4000);
  } catch (err) {
    $("loadingText").textContent = cameraErrorMessage(err);
    $("loading").querySelector(".spinner")?.remove();
  }
}

function cameraErrorMessage(err) {
  if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError"))
    return "无法访问摄像头：请在浏览器设置中允许相机权限后刷新页面。";
  if (location.protocol !== "https:" && location.hostname !== "localhost")
    return "摄像头需要 HTTPS 环境。请通过 https:// 或 localhost 访问本页面。";
  return "初始化失败：" + (err?.message || err);
}

async function openCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: state.facing,
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.srcObject = state.stream;
  video.classList.toggle("mirrored", state.facing === "user");
  await new Promise((res) => (video.onloadedmetadata = res));
  await video.play();
  resizeOverlay();
}

function resizeOverlay() {
  overlay.width = video.videoWidth || overlay.clientWidth;
  overlay.height = video.videoHeight || overlay.clientHeight;
}
window.addEventListener("resize", resizeOverlay);

/* ---------------- 推理主循环 ---------------- */

function loop() {
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now();
  const lms = detector.detect(video, now);
  detector.draw(ctx, lms, state.facing === "user");

  const { phase, liveFaults, summary } = analyzer.update(lms, now);
  renderPhase(phase);
  renderLiveFaults(liveFaults, phase, lms);
  if (summary) showSummary(summary);

  // FPS 统计
  state.frames++;
  if (now - state.fpsT0 > 1000) {
    $("fpsLabel").textContent = state.frames + " FPS";
    state.frames = 0;
    state.fpsT0 = now;
  }
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
    body.innerHTML = faults
      .map(
        (f) => `
        <div class="summary-item">
          <div class="si-title ${f.rule.severity === SEVERITY.BAD ? "bad" : "warn"}">${f.rule.title}</div>
          <div class="si-advice">${f.rule.advice}</div>
        </div>`
      )
      .join("");
  }
  $("summaryModal").classList.remove("hidden");
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
  state.running = !state.running;
  const btn = $("startBtn");
  if (state.running) {
    analyzer = new SwingAnalyzer(state.view, state.handedness);
    btn.textContent = "停止分析";
    btn.classList.add("stop");
    showHint("摆好准备姿势并静止 1 秒，开始你的挥杆", 4000);
    loop();
  } else {
    btn.textContent = "开始分析";
    btn.classList.remove("stop");
    cancelAnimationFrame(state.rafId);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    $("liveFaults").innerHTML = "";
    renderPhase(PHASE.IDLE);
    $("phasePill").textContent = "未开始";
  }
});

$("closeSummary").addEventListener("click", () => {
  $("summaryModal").classList.add("hidden");
  analyzer.nextSwing();
  showHint("摆好准备姿势，开始下一次挥杆", 3000);
});

$("flipBtn").addEventListener("click", async () => {
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
  analyzer = new SwingAnalyzer(state.view, state.handedness);
  showHint(hintForView(), 4000);
});

bindSeg("handSeg", "hand", (h) => {
  state.handedness = h;
  analyzer = new SwingAnalyzer(state.view, state.handedness);
});

boot();
