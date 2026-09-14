// ExternalDataProvider：视觉线与外部传感器模块（袖套双 IMU）之间的运行时接口。
// 传感器实现放在独立模块（js/providers/sensorProvider.js，由传感器线维护，
// 本仓库不包含），仅在 SENSOR_ENABLED 开启时动态加载；两线不共享状态，
// 数据交互只通过 SwingSession 契约的 imu 块（见 schema/swing-session.schema.json）。
//
// 生命周期约定：
//   connect() → startSwing(swingId, t0) … stopSwing(swingId) → getSamples(swingId) → disconnect()
//   t0 为该次挥杆的时间零点（会话内单调毫秒，与契约 t0_ms 同源），
//   实现方负责把设备时钟对齐到该基准。

/* eslint-disable no-unused-vars */
export class ExternalDataProvider {
  /** 建立设备连接。@returns {Promise<boolean>} 是否连接成功 */
  async connect() { throw new Error("ExternalDataProvider.connect 未实现"); }

  /** 断开连接并释放资源。@returns {Promise<void>} */
  async disconnect() { throw new Error("ExternalDataProvider.disconnect 未实现"); }

  /**
   * 一次挥杆开始：实现方应从此刻起缓存样本并以 t0 为时间零点。
   * @param {string} swingId 契约中的 swing_id
   * @param {number} t0 时间零点（会话内单调毫秒）
   */
  startSwing(swingId, t0) { throw new Error("ExternalDataProvider.startSwing 未实现"); }

  /** 一次挥杆结束：停止为该 swingId 缓存样本。@param {string} swingId */
  stopSwing(swingId) { throw new Error("ExternalDataProvider.stopSwing 未实现"); }

  /**
   * 取回该次挥杆的传感器数据。
   * @param {string} swingId
   * @returns {Promise<object|null>} 符合契约 imu 块定义的对象；无数据返回 null
   *   （null 是合法契约值，消费方无需特判设备缺席）
   */
  async getSamples(swingId) { throw new Error("ExternalDataProvider.getSamples 未实现"); }
}
