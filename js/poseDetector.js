// MediaPipe Pose Landmarker 封装：负责加载模型、逐帧推理、绘制骨骼
// 推理库、WASM 与模型均随站点自托管（vendor/ 目录），与页面同源加载，
// 不依赖任何第三方 CDN——只要页面能打开，模型就能加载（含国内网络环境）。
import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "../vendor/mediapipe/vision_bundle.mjs";

const WASM_URL = "vendor/mediapipe/wasm";
// lite 模型在中端手机上约 20-30 FPS，足够实时反馈；追求精度可换 full
const MODEL_URL = "vendor/models/pose_landmarker_lite.task";

export const LM = {
  NOSE: 0,
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

export class PoseDetector {
  constructor() {
    this.landmarker = null;
    this.lastVideoTime = -1;
  }

  async init() {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  /**
   * 对当前视频帧做姿态推理。
   * 返回 undefined = 没有新帧（视频帧率低于渲染帧率时跳过该次渲染）；
   * 返回 null = 有新帧但画面中没有人；否则返回归一化关键点数组。
   */
  detect(video, nowMs) {
    if (!this.landmarker || video.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = video.currentTime;
    const result = this.landmarker.detectForVideo(video, nowMs);
    return result.landmarks && result.landmarks.length > 0
      ? result.landmarks[0]
      : null;
  }

  /** 在叠加层上绘制骨骼连线和关键点 */
  draw(ctx, landmarks, mirrored) {
    const { canvas } = ctx;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) { ctx.restore(); return; }
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    const utils = new DrawingUtils(ctx);
    utils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
      color: "rgba(48, 209, 88, 0.9)",
      lineWidth: 3,
    });
    utils.drawLandmarks(landmarks, {
      color: "#ffffff",
      fillColor: "#30d158",
      lineWidth: 1,
      radius: 3.5,
    });
    ctx.restore();
  }

  /**
   * 截取当前视频帧 + 骨骼的合成小图（用于报告中标记问题发生的瞬间）。
   * annotation = { label, shapes }：问题的可视化标注
   * （红=当前错误位置，绿虚线=正确参考），shapes 坐标为图像空间 0..1。
   */
  snapshot(video, landmarks, mirrored, maxW = 480, annotation = null) {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, maxW / w);
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext("2d");
    ctx.save();
    if (mirrored) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, c.width, c.height);
    if (landmarks) {
      const utils = new DrawingUtils(ctx);
      utils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
        color: "rgba(255, 255, 255, 0.45)",
        lineWidth: 2,
      });
    }
    if (annotation?.shapes) this._drawShapes(ctx, c, annotation.shapes);
    ctx.restore();
    if (annotation?.label) this._drawLabel(ctx, c, annotation.label);
    try {
      return c.toDataURL("image/jpeg", 0.8);
    } catch {
      return null;
    }
  }

  _drawShapes(ctx, c, shapes) {
    const X = (p) => p.x * c.width;
    const Y = (p) => p.y * c.height;
    const lw = Math.max(2.5, c.width * 0.008);
    const colors = { red: "#ff453a", green: "#30d158" };
    for (const s of shapes) {
      ctx.strokeStyle = colors[s.color] || s.color;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = lw;
      ctx.setLineDash(s.dash ? [lw * 2.2, lw * 1.8] : []);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (s.type === "line") {
        ctx.beginPath();
        ctx.moveTo(X(s.a), Y(s.a));
        ctx.lineTo(X(s.b), Y(s.b));
        ctx.stroke();
      } else if (s.type === "path" && s.pts?.length > 1) {
        ctx.beginPath();
        ctx.moveTo(X(s.pts[0]), Y(s.pts[0]));
        for (const p of s.pts.slice(1)) ctx.lineTo(X(p), Y(p));
        ctx.stroke();
      } else if (s.type === "circle") {
        ctx.beginPath();
        ctx.ellipse(X(s.c), Y(s.c), s.r * c.width, s.r * c.width, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.type === "arrow") {
        const ax = X(s.a), ay = Y(s.a), bx = X(s.b), by = Y(s.b);
        const ang = Math.atan2(by - ay, bx - ax);
        const head = lw * 3.2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
        ctx.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
  }

  /** 标注说明条：顶部大白话解释 + 底部图例 */
  _drawLabel(ctx, c, label) {
    const fs = Math.max(12, Math.round(c.width * 0.036));
    const pad = fs * 0.6;
    ctx.font = `600 ${fs}px -apple-system, 'PingFang SC', sans-serif`;
    ctx.textBaseline = "top";
    // 自动换行
    const maxW = c.width - pad * 2;
    const lines = [];
    let line = "";
    for (const ch of label) {
      if (ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch; }
      else line += ch;
    }
    if (line) lines.push(line);
    const boxH = pad * 2 + lines.length * fs * 1.35;
    ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
    ctx.fillRect(0, 0, c.width, boxH);
    ctx.fillStyle = "#fff";
    lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * fs * 1.35));
    // 底部图例
    const legFs = Math.max(10, Math.round(fs * 0.78));
    ctx.font = `500 ${legFs}px -apple-system, 'PingFang SC', sans-serif`;
    const leg = "红 = 你的动作 · 绿虚线 = 正确参考";
    const lw2 = ctx.measureText(leg).width + legFs * 1.2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
    ctx.fillRect(0, c.height - legFs * 2.1, lw2, legFs * 2.1);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(leg, legFs * 0.6, c.height - legFs * 1.65);
  }
}
