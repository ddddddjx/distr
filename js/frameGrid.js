// 上传视频的确定性采样网格（纯函数叶子模块）。
//
// 守的是一个线上事故：同一段视频两次分析出来的分数不一样。
// 旧实现是"边播边抽帧"——视频实时播放，rAF 拿到哪一帧全看当时手机有多忙
// （MediaPipe 推理是同步阻塞的，一帧几十到几百毫秒）。而评分是逐帧取最大偏差，
// 抽到的帧不同 → 峰值不同 → 分数不同。实测同一段视频跑两遍，抽到的帧集合
// 重合度只有 6%：分数不一致是必然，不是偶发。
//
// 改成固定网格后，采样时刻只由「视频时长 + 采样率」决定，与机器快慢无关：
// 同一段视频永远走同一组帧，分数可复现。

/** 采样率。15fps 是准确度与耗时的折中：快速下杆那 0.25s 仍能采到 3–4 帧，
 *  而 10 秒视频只需 150 次 seek+推理。调它会改变分数，属于口径变更。 */
export const FILE_SAMPLE_FPS = 15;

/**
 * 生成采样时刻（秒）。纯函数：同样的入参永远同样的输出。
 * @param {number} duration 视频时长（秒）
 * @param {number} [fps] 采样率
 * @returns {number[]} 递增的时刻数组，末尾必定落在片尾
 */
export function sampleGrid(duration, fps = FILE_SAMPLE_FPS) {
  if (!(duration > 0) || !(fps > 0)) return [];
  const step = 1 / fps;
  const n = Math.floor(duration / step);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.min(duration, i * step));
  return out;
}

/** 逐帧分析的粗略耗时预估（秒），用于给用户一个像样的等待提示。
 *  每帧 = 一次 seek + 一次推理，手机上合计约 100ms 量级。 */
export function estimateAnalysisSeconds(duration, perFrameMs = 100, fps = FILE_SAMPLE_FPS) {
  return Math.max(1, Math.round((sampleGrid(duration, fps).length * perFrameMs) / 1000));
}
