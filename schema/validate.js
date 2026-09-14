// SwingSession v1.0.0 运行时校验器（零依赖，Node 与浏览器通用）。
// 与 swing-session.schema.json 等价；schema.json 是权威文档，本文件是可执行实现。
//
// FINDING_CODES 与 finding-codes.json 的一致性由 tests/schema.test.mjs 强制：
// 两者不同步时测试失败（浏览器端无法免属性断言地 import JSON，故此处内嵌镜像）。

export const SCHEMA_VERSION = "1.0.0";

export const FINDING_CODES = [
  "spine_too_upright", "spine_too_bent", "c_posture", "loss_of_posture",
  "early_extension", "over_the_top", "head_drop", "head_sway",
  "hip_sway", "hip_slide", "reverse_spine_angle", "hanging_back",
  "flat_shoulder_plane", "chicken_wing", "casting", "s_posture",
];

const PHASE_KEYS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];
const SWING_PHASES = ["address", "backswing", "top", "downswing", "impact", "follow", "finish"];
const SEVERITIES = ["warn", "bad"];
const PLACEMENTS = ["hand_back", "forearm"];
const CODE_SET = new Set(FINDING_CODES);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const numOrNull = (v) => v === null || isNum(v);

/**
 * 校验一个 SwingSession 实例。
 * @returns {{ valid: boolean, errors: string[] }} errors 为空即 valid。
 *          错误信息带 JSON 路径，便于跨线联调时定位。
 */
export function validateSwingSession(s) {
  const errors = [];
  const err = (path, msg) => errors.push(path + ": " + msg);

  if (!isObj(s)) return { valid: false, errors: ["$: 必须是对象"] };

  // ---- 顶层 ----
  if (!isStr(s.schema_version) || !/^\d+\.\d+\.\d+$/.test(s.schema_version)) {
    err("$.schema_version", "必须是语义化版本字符串（如 1.0.0）");
  } else if (s.schema_version.split(".")[0] !== SCHEMA_VERSION.split(".")[0]) {
    err("$.schema_version", "主版本不兼容：校验器为 " + SCHEMA_VERSION);
  }
  if (!isStr(s.session_id) || s.session_id.length < 8) err("$.session_id", "必须是 ≥8 字符的字符串");
  if (!(s.user_id === null || isStr(s.user_id))) err("$.user_id", "必须是字符串或 null");
  if (!isStr(s.captured_at) || Number.isNaN(Date.parse(s.captured_at))) {
    err("$.captured_at", "必须是可解析的 ISO 8601 时间字符串");
  }
  if (!Array.isArray(s.swings)) {
    err("$.swings", "必须是数组");
    return { valid: errors.length === 0, errors };
  }

  s.swings.forEach((sw, i) => validateSwing(sw, "$.swings[" + i + "]", err));
  return { valid: errors.length === 0, errors };
}

function validateSwing(sw, p, err) {
  if (!isObj(sw)) { err(p, "必须是对象"); return; }
  if (!isStr(sw.swing_id) || sw.swing_id.length < 4) err(p + ".swing_id", "必须是 ≥4 字符的字符串");
  if (!isNum(sw.t0_ms)) err(p + ".t0_ms", "必须是数字（会话内单调毫秒）");
  if (!numOrNull(sw.t_impact_ms)) err(p + ".t_impact_ms", "必须是数字或 null");

  // phases：P1..P10 必须齐全，值为 number|null，不允许多余键
  if (!isObj(sw.phases)) {
    err(p + ".phases", "必须是对象");
  } else {
    for (const k of PHASE_KEYS) {
      if (!(k in sw.phases)) err(p + ".phases." + k, "缺失（不可省略，未检出请置 null）");
      else if (!numOrNull(sw.phases[k])) err(p + ".phases." + k, "必须是数字或 null");
    }
    for (const k of Object.keys(sw.phases)) {
      if (!PHASE_KEYS.includes(k)) err(p + ".phases." + k, "未知键（仅允许 P1..P10）");
    }
  }

  if (!("vision" in sw)) err(p + ".vision", "缺失（无视觉数据请置 null）");
  else if (sw.vision !== null) validateVision(sw.vision, p + ".vision", err);

  if (!("imu" in sw)) err(p + ".imu", "缺失（无传感器数据请置 null）");
  else if (sw.imu !== null) validateImu(sw.imu, p + ".imu", err);

  if (!Array.isArray(sw.annotations)) {
    err(p + ".annotations", "必须是数组（可为空）");
  } else {
    sw.annotations.forEach((a, i) => {
      const ap = p + ".annotations[" + i + "]";
      if (!isObj(a)) { err(ap, "必须是对象"); return; }
      if (!isStr(a.kind) || !a.kind) err(ap + ".kind", "必须是非空字符串");
      if (!numOrNull(a.t_ms)) err(ap + ".t_ms", "必须是数字或 null");
      if (!isObj(a.payload)) err(ap + ".payload", "必须是对象");
    });
  }
}

function validateVision(v, p, err) {
  if (!isObj(v)) { err(p, "必须是对象或 null"); return; }
  if (!isStr(v.source) || !v.source) err(p + ".source", "必须是非空字符串");
  if (!numOrNull(v.fps)) err(p + ".fps", "必须是数字或 null");
  if (v.keypoints_3d !== null) err(p + ".keypoints_3d", "v1 预留字段，必须为 null");
  if (!isObj(v.metrics)) err(p + ".metrics", "必须是对象（可为空 {}）");
  if (!(v.score === null || (isNum(v.score) && v.score >= 0 && v.score <= 100))) {
    err(p + ".score", "必须是 0..100 的数字或 null");
  }

  if (!Array.isArray(v.keypoints_2d)) {
    err(p + ".keypoints_2d", "必须是数组（未留存关键点请置 []）");
  } else {
    v.keypoints_2d.forEach((f, i) => {
      const fp = p + ".keypoints_2d[" + i + "]";
      if (!isObj(f)) { err(fp, "必须是对象"); return; }
      if (!isNum(f.t_ms)) err(fp + ".t_ms", "必须是数字");
      if (!Array.isArray(f.points)) {
        err(fp + ".points", "必须是数组");
      } else {
        f.points.forEach((pt, j) => {
          if (!Array.isArray(pt) || pt.length !== 3 || !pt.every(isNum)) {
            err(fp + ".points[" + j + "]", "必须是 [x, y, visibility] 三元数字组");
          }
        });
      }
    });
  }
  validateFindings(v.findings, p + ".findings", err);
}

function validateImu(m, p, err) {
  if (!isObj(m)) { err(p, "必须是对象或 null"); return; }
  if (!isStr(m.source) || !m.source) err(p + ".source", "必须是非空字符串");
  if (!isObj(m.metrics)) err(p + ".metrics", "必须是对象（可为空 {}）");

  if (!Array.isArray(m.devices) || m.devices.length < 1) {
    err(p + ".devices", "必须是至少含一个设备的数组");
  } else {
    m.devices.forEach((d, i) => {
      const dp = p + ".devices[" + i + "]";
      if (!isObj(d)) { err(dp, "必须是对象"); return; }
      if (!isStr(d.device_id) || !d.device_id) err(dp + ".device_id", "必须是非空字符串");
      if (!PLACEMENTS.includes(d.placement)) err(dp + ".placement", "必须是 " + PLACEMENTS.join("|"));
      if (!isNum(d.sample_rate_hz)) err(dp + ".sample_rate_hz", "必须是数字");
    });
  }

  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
  if (!Array.isArray(m.samples)) {
    err(p + ".samples", "必须是数组");
  } else {
    m.samples.forEach((sp, i) => {
      const spp = p + ".samples[" + i + "]";
      if (!isObj(sp)) { err(spp, "必须是对象"); return; }
      if (!isNum(sp.t_ms)) err(spp + ".t_ms", "必须是数字");
      if (!isStr(sp.device_id)) err(spp + ".device_id", "必须是字符串");
      if (!vec3(sp.acc)) err(spp + ".acc", "必须是 [x,y,z] 三元数字组");
      if (!vec3(sp.gyro)) err(spp + ".gyro", "必须是 [x,y,z] 三元数字组");
      if ("mag" in sp && sp.mag !== null && !vec3(sp.mag)) {
        err(spp + ".mag", "必须是 [x,y,z] 三元数字组或 null");
      }
    });
  }
  validateFindings(m.findings, p + ".findings", err);
}

function validateFindings(list, p, err) {
  if (!Array.isArray(list)) { err(p, "必须是数组（可为空）"); return; }
  list.forEach((f, i) => {
    const fp = p + "[" + i + "]";
    if (!isObj(f)) { err(fp, "必须是对象"); return; }
    if (!CODE_SET.has(f.code)) err(fp + ".code", "未注册的 code：" + String(f.code) + "（见 schema/finding-codes.json）");
    if (!SEVERITIES.includes(f.severity)) err(fp + ".severity", "必须是 warn|bad");
    if (!numOrNull(f.ratio)) err(fp + ".ratio", "必须是数字或 null");
    if (!(f.phase === null || SWING_PHASES.includes(f.phase))) {
      err(fp + ".phase", "必须是挥杆阶段名或 null");
    }
    if (!numOrNull(f.t_ms)) err(fp + ".t_ms", "必须是数字或 null");
  });
}
