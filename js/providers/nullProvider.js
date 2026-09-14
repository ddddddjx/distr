// NullProvider：ExternalDataProvider 的默认空实现。
// 语义 = "没有传感器"：连接永远失败（false）、生命周期全部 no-op、
// getSamples 恒返回 null（契约允许 imu 为 null，下游零特判）。
// SENSOR_ENABLED 关闭、或传感器模块缺失/加载失败时使用。
import { ExternalDataProvider } from "./externalDataProvider.js";

export class NullProvider extends ExternalDataProvider {
  async connect() { return false; }
  async disconnect() { /* no-op */ }
  startSwing(_swingId, _t0) { /* no-op */ }
  stopSwing(_swingId) { /* no-op */ }
  async getSamples(_swingId) { return null; }
}
