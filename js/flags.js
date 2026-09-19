// 特性开关基座：解耦准备期的所有新能力默认关闭，线上行为与现状完全一致。
// 覆写方式（仅供开发与测试，普通用户无感知）：
//   1. URL 参数：?ff=EXPORT_ENABLED,SENSOR_ENABLED
//   2. localStorage：ff.EXPORT_ENABLED = "1"（持久，便于真机连续调试）
// 优先级：URL > localStorage > 默认值。

const DEFAULTS = {
  EXPORT_ENABLED: false,      // exportSession()：分析结果导出为 SwingSession
  SENSOR_ENABLED: false,      // 传感器线：启动时动态加载 ExternalDataProvider
  IMU_REPORT_ENABLED: false,  // 报告中的"手腕数据"扩展区块
  REPLAY_DOWNLOAD: false,     // 报告里"保存慢放视频"：本地重编码后存到相册/文件
};

function urlOverrides() {
  try {
    const raw = new URLSearchParams(location.search).get("ff") || "";
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

const urlSet = urlOverrides();

/** 查询开关状态。未知开关一律返回 false。 */
export function flag(name) {
  if (!(name in DEFAULTS)) return false;
  if (urlSet.has(name)) return true;
  try {
    const v = localStorage.getItem("ff." + name);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch (e) {
    /* 隐私模式等场景读取失败 → 走默认值 */
  }
  return DEFAULTS[name];
}

/** 供测试与调试页使用：列出全部开关及当前值 */
export function allFlags() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = flag(k);
  return out;
}
