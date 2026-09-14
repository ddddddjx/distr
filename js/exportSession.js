// exportSession：把分析产出（summary，可多杆）映射为 SwingSession v1.0.0。
// 只填 vision 块，imu 恒为 null（由传感器线在其模块内填充）。
// 导出前强制 schema 校验：契约违规视为编程错误，直接抛出。
// 本模块不触碰报告与分享卡的任何路径，仅在 EXPORT_ENABLED 开启时被动态加载。
import { validateSwingSession, SCHEMA_VERSION } from "../schema/validate.js";

// 历史规则键 → 契约 code 的映射。与 schema/finding-codes.json 的一致性
// 由 tests/export.test.mjs 强制（改漏任何一边测试即红）。
export const LEGACY_TO_CODE = {
  SPINE_TOO_UPRIGHT: "spine_too_upright",
  SPINE_TOO_BENT: "spine_too_bent",
  C_POSTURE: "c_posture",
  LOSS_OF_POSTURE: "loss_of_posture",
  EARLY_EXTENSION: "early_extension",
  OVER_THE_TOP: "over_the_top",
  HEAD_DROP: "head_drop",
  HEAD_SWAY: "head_sway",
  HIP_SWAY: "hip_sway",
  HIP_SLIDE: "hip_slide",
  REVERSE_SPINE: "reverse_spine_angle",
  HANGING_BACK: "hanging_back",
  FLAT_SHOULDER_PLANE: "flat_shoulder_plane",
  CHICKEN_WING: "chicken_wing",
};

const VISION_SOURCE = "swingcoach-web@mediapipe-pose-landmarker-lite";

function uuid() {
  try {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* 老 WebView 无 randomUUID */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 设备级持久用户标识：本地无账号体系时的匿名 ID，仅存本机。取不到时返回 null（schema 允许）。 */
export function getDeviceUserId() {
  try {
    let id = localStorage.getItem("deviceUserId");
    if (!id) {
      id = "dev-" + uuid();
      localStorage.setItem("deviceUserId", id);
    }
    return id;
  } catch (e) {
    return null;
  }
}

/**
 * 把单个 summary（swingAnalyzer._finishSwing 产物）映射为契约中的一个 swing。
 * summary.exportData 由 captureKeypoints 选项开启时附带；缺失时（旧数据/开关
 * 中途打开）关键点为 []、多数 phase 为 null——仍是合法契约实例。
 */
function mapSwing(summary, index) {
  const ed = summary.exportData || null;
  const t = (ed && ed.t) || {};
  // 时间零点优先取准备锁定时刻（P1 语义），退化到起杆时刻
  const t0 = pick(t.addressLock, t.backswing, 0);
  const rel = (v) => (typeof v === "number" && v > 0 ? round1(v - t0) : null);

  const phases = {
    P1: typeof t.addressLock === "number" && t.addressLock > 0 ? 0 : null,
    P2: rel(t.backswing),
    P3: null,
    P4: rel(t.top),
    P5: null,
    P6: null,
    P7: rel(t.impact),
    P8: null,
    P9: null,
    P10: rel(t.finish),
  };

  const keypoints_2d = ((ed && ed.keypoints) || []).map((f) => ({
    t_ms: round1(f.t - t0),
    points: f.points,
  }));

  const metrics = { view: summary.view };
  if (summary.tempo) {
    metrics.tempo_ratio = round2(summary.tempo.ratio);
    metrics.backswing_ms = Math.round(summary.tempo.back);
    metrics.downswing_ms = Math.round(summary.tempo.down);
  }

  const findings = (summary.faults || []).map((f) => {
    const code = LEGACY_TO_CODE[f.key];
    if (!code) throw new Error("exportSession: 未映射的规则键 " + f.key);
    return {
      code,
      severity: f.rule && f.rule.severity === "bad" ? "bad" : "warn",
      ratio: typeof f.ratio === "number" ? round2(f.ratio) : null,
      phase: f.phase || null,
      t_ms: null, // v1 未按问题记录最严重时刻，如实置 null
    };
  });

  return {
    swing_id: "sw-" + String(index + 1).padStart(3, "0") + "-" + uuid().slice(0, 8),
    t0_ms: round1(t0),
    t_impact_ms: phases.P7,
    phases,
    vision: {
      source: VISION_SOURCE,
      fps: ed && typeof ed.kpFps === "number" ? ed.kpFps : null,
      keypoint_format: "mediapipe-pose-33",
      keypoints_2d,
      keypoints_3d: null,
      metrics,
      score: typeof summary.score === "number" ? summary.score : null,
      findings,
    },
    imu: null, // 本仓库（视觉线）永远不产出 imu
    annotations: [],
  };
}

/**
 * 构建并校验一份 SwingSession。
 * @param {object[]} summaries 一次分析中的各杆 summary（按时间顺序）
 * @param {object} [opts] { sessionId, userId, capturedAt }
 * @returns {object} 通过校验的 SwingSession
 * @throws {Error} 映射结果违反契约时抛出（携带全部校验错误）
 */
export function exportSession(summaries, opts = {}) {
  if (!Array.isArray(summaries)) throw new Error("exportSession: summaries 必须是数组");
  const session = {
    schema_version: SCHEMA_VERSION,
    session_id: opts.sessionId || uuid(),
    user_id: "userId" in opts ? opts.userId : getDeviceUserId(),
    captured_at: opts.capturedAt || new Date().toISOString(),
    swings: summaries.map(mapSwing),
  };
  const r = validateSwingSession(session);
  if (!r.valid) {
    throw new Error("exportSession: 产出违反 SwingSession 契约：\n" + r.errors.join("\n"));
  }
  return session;
}

function pick() {
  for (const v of arguments) if (typeof v === "number" && v > 0) return v;
  return 0;
}
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
