// 报告"手腕数据"区块渲染器（步骤 4 扩展点，IMU_REPORT_ENABLED）。
// 纯函数、无 DOM 依赖，Node 可测：输入 SwingSession 契约的 imu 块，
// 输出 HTML 字符串；imu 为 null/undefined 时返回空串——不渲染任何内容，
// UI 与现状完全一致。本仓库（视觉线）不产出 imu，数据由传感器线经
// 契约注入后才会出现。
import { RULES } from "./rules.js";
import { LEGACY_TO_CODE } from "./legacyCodeMap.js";

// finding code → 中文标签：14 个视觉共享码复用 rules.js 标题（单一事实源），
// 传感器线专属码在此补充；未知码回退显示原始 code（前向兼容新增码）。
const CODE_LABELS = (() => {
  const m = {};
  for (const [legacy, code] of Object.entries(LEGACY_TO_CODE)) {
    if (RULES[legacy]) m[code] = RULES[legacy].title;
  }
  m.casting = "提前释放";
  m.s_posture = "塌腰翘臀";
  return m;
})();

const PLACEMENT_LABELS = { hand_back: "手背", forearm: "前臂" };

// 已知派生指标的展示标签与格式；未知键按原样展示（契约 metrics 是开放 KV）
const METRIC_LABELS = {
  wrist_release_ms: { label: "手腕释放时刻", format: (v) => v + " ms" },
  peak_gyro_dps: { label: "峰值角速度", format: (v) => v + " °/s" },
  peak_acc_ms2: { label: "峰值加速度", format: (v) => v + " m/s²" },
};

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/**
 * 渲染"手腕数据"区块。
 * @param {object|null|undefined} imu SwingSession 契约的 imu 块
 * @returns {string} HTML；无数据时为 ""（调用方无需特判）
 */
export function renderImuBlockHtml(imu) {
  if (!imu || typeof imu !== "object") return "";

  const devices = (imu.devices || [])
    .map((d) => {
      const place = PLACEMENT_LABELS[d.placement] || d.placement;
      return esc(place) + " " + esc(d.sample_rate_hz) + "Hz";
    })
    .join(" · ");

  const metricRows = Object.entries(imu.metrics || {})
    .map(([k, v]) => {
      const spec = METRIC_LABELS[k];
      const label = spec ? spec.label : k;
      const val = spec ? spec.format(v) : v;
      return (
        '<div class="imu-kv"><span class="imu-k">' + esc(label) +
        '</span><span class="imu-v">' + esc(val) + "</span></div>"
      );
    })
    .join("");

  const findingChips = (imu.findings || [])
    .map((f) => {
      const label = CODE_LABELS[f.code] || f.code;
      return (
        '<span class="imu-finding ' + (f.severity === "bad" ? "bad" : "warn") + '">' +
        esc(label) + "</span>"
      );
    })
    .join("");

  return (
    '<div class="imu-block">' +
    '<div class="imu-head"><span class="imu-title">手腕数据</span>' +
    '<span class="imu-src">' + esc(imu.source || "") + "</span></div>" +
    (devices ? '<div class="imu-devices">' + devices + "</div>" : "") +
    (metricRows ? '<div class="imu-metrics">' + metricRows + "</div>" : "") +
    (findingChips ? '<div class="imu-findings">' + findingChips + "</div>" : "") +
    "</div>"
  );
}
