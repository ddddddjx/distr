// 传感器模块装载器：路径为占位（模块由传感器线在独立仓库/包中开发，
// 当前不存在）。加载失败一律安静回退 NullProvider——视觉线的任何
// 行为都不得依赖传感器模块的存在。
const SENSOR_MODULE_PATH = "./sensorProvider.js"; // 占位：传感器线交付后替换/对齐

export async function loadExternalProvider() {
  try {
    const mod = await import(/* @vite-ignore */ SENSOR_MODULE_PATH);
    if (mod && typeof mod.createProvider === "function") {
      return { provider: mod.createProvider(), source: "sensor" };
    }
    throw new Error("sensorProvider 缺少 createProvider 工厂");
  } catch (e) {
    const { NullProvider } = await import("./nullProvider.js");
    return { provider: new NullProvider(), source: "null", reason: String(e && e.message || e) };
  }
}
