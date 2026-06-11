// MediaPipe Pose Landmarker 封装：负责加载模型、逐帧推理、绘制骨骼
import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
// lite 模型在中端手机上约 20-30 FPS，足够实时反馈；追求精度可换 full
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

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

  /** 对当前视频帧做姿态推理，返回归一化关键点数组（无人则返回 null） */
  detect(video, nowMs) {
    if (!this.landmarker || video.currentTime === this.lastVideoTime) return null;
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
      color: "rgba(52, 199, 89, 0.85)",
      lineWidth: 3,
    });
    utils.drawLandmarks(landmarks, {
      color: "#ffffff",
      fillColor: "#34c759",
      lineWidth: 1,
      radius: 3.5,
    });
    ctx.restore();
  }
}
