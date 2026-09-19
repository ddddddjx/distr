// 摄像头预览卡死看门狗（纯函数叶子模块，无 DOM / 无副作用，便于单测）。
//
// 守的是这个线上事故：实时模式打完第一杆、报告里的慢放回放播过一遍之后，
// iOS 会把摄像头预览的 <video> 元素暂停、或直接中断采集轨道（track 被 mute）。
// 元素不报错、页面也照常 requestAnimationFrame 空转，但 video.currentTime
// 不再前进 —— PoseDetector.detect() 于是永远返回 undefined，一帧都不再推理。
// 表现就是："第一杆能出报告，点完「继续练习」之后第二杆怎么挥都识别不到"。
//
// 恢复策略分两级：
//   resume —— 轨道还活着，只是元素被系统暂停：接回 srcObject 并续播即可；
//   reopen —— 轨道已 ended/muted（系统回收了摄像头），或续播过一次仍无新帧：
//             只能重新 getUserMedia，并把旧基准作废重来。

/** 连续多久拿不到新帧就认定预览卡死（ms）。真实相机 <100ms 就该有新帧 */
export const STALL_MS = 1500;
/** 重开摄像头仍拿不到帧的次数上限：再试也是空转，不如停下来告诉用户 */
export const MAX_REOPEN_TRIES = 3;

/**
 * @param {object} s 当前观测量
 * @param {number} s.now 当前时刻（ms）
 * @param {number} s.lastFrameAt 最近一次拿到新视频帧的时刻（ms）
 * @param {"camera"|"file"} s.source 数据源
 * @param {boolean} s.running 是否正在分析
 * @param {boolean} s.recovering 是否已有一次恢复在进行中
 * @param {number} s.resumeTries 本轮卡死已尝试过几次轻量续播
 * @param {number} s.reopenTries 本轮卡死已重开过几次摄像头
 * @param {"live"|"ended"|"none"} s.trackState 摄像头轨道状态
 * @param {boolean} s.trackMuted 轨道是否被系统静默（iOS 中断采集时为 true）
 * @returns {"none"|"resume"|"reopen"|"stop"}
 */
export function decideRecovery(s) {
  // 视频文件模式的"没有新帧"是正常现象（文件帧率低于渲染帧率），不介入
  if (!s.running || s.source !== "camera" || s.recovering) return "none";
  if (!(s.now - s.lastFrameAt >= STALL_MS)) return "none";
  // 重开过几次还是一帧没有：摄像头是真的拿不回来了（权限被撤、被别的
  // 应用占用），继续空转只会让用户对着死画面一直挥
  if (s.reopenTries >= MAX_REOPEN_TRIES) return "stop";
  if (s.trackState !== "live" || s.trackMuted) return "reopen";
  // 续播已经试过一次还是没帧 → 不再空转，直接重开摄像头
  return s.resumeTries >= 1 ? "reopen" : "resume";
}
