// 粗扫定位「有动作且完整击到球」的区间（纯函数叶子模块）。
//
// 守的是逐帧分析的成本：确定性逐帧把整段视频按固定网格走一遍，而每帧推理
// 实测 380–450ms（seek 只占 18ms）——20 秒的素材要跑 240 帧、一分半。
// 但用户拍的素材里真正有用的只有击球前后那几秒，前面架机位、后面捡球都在陪跑。
//
// 两级定位，都不做 AI 推理：
//  1) 击球声（strikeAudio 的瞬态峰）——最准也最便宜，**一帧视频都不用碰**，
//     因为它直接回答了"击到球了吗"；
//  2) 没有音轨/没有峰时退到廉价帧差粗扫（小画布逐格取样，只判"有没有动作"）。
// 两级都落空就回退整段，绝不因为定位失败让用户拿不到报告。
//
// 三条不可回退的性质：
//  - 窗口时刻是**全局网格的子集**（planFrames 从 sampleGrid 里筛），所以裁剪
//    不会改变窗口内任何一帧的采样时刻——同一段视频的分数依旧可复现；
//  - 窗口必须**从准备姿势前**开起：基准锁定要静止 600ms + ≥5 采样，窗口开太晚
//    基准锁不上，整杆识别不到（比慢更糟）；
//  - 覆盖率超过 maxCoverage 就直接走整段：裁一点点不值得承担漏采风险。

import { sampleGrid, FILE_SAMPLE_FPS } from "./frameGrid.js";

export const SCAN_PARAMS = {
  preS: 3.0,        // 击球时刻之前保留（覆盖准备静止 + 上杆约 1s）
  postS: 2.0,       // 击球时刻之后保留（送杆到收杆）
  coarseFps: 6,     // 帧差粗扫的取样率（只判有无动作，不需要密）
  diffRatio: 0.35,  // 动作阈值：相对本段最强帧差的比例
  diffFloor: 0.006, // 绝对下限，防静止画面的传感器噪点被当成动作
  motionPreS: 2.0,  // 动作起点之前额外保留
  motionPostS: 1.5, // 动作终点之后额外保留
  maxCoverage: 0.7, // 窗口覆盖超过整段这个比例就不裁了
};

/** 合并重叠/相邻窗口并裁进 [0, duration]。输入可乱序。 */
export function mergeWindows(wins, duration) {
  if (!(duration > 0)) return [];
  const list = (wins || [])
    .map((w) => ({ start: Math.max(0, w.start), end: Math.min(duration, w.end) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of list) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/** 击球声峰 → 候选窗口。peaks 为秒（strikeAudio.detectTransients 的输出）。 */
export function windowsFromStrikes(peaks, duration, p = SCAN_PARAMS) {
  if (!Array.isArray(peaks) || !peaks.length) return [];
  return mergeWindows(
    peaks.map((t) => ({ start: t - p.preS, end: t + p.postS })),
    duration
  );
}

/**
 * 帧差粗扫结果 → 候选窗口。
 * @param {{t:number,d:number}[]} samples 取样时刻与归一化帧差（0..1）
 */
export function windowsFromMotion(samples, duration, p = SCAN_PARAMS) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const peak = samples.reduce((m, s) => Math.max(m, s.d), 0);
  if (!(peak > p.diffFloor)) return []; // 整段几乎静止：粗扫没有意见
  const th = Math.max(p.diffFloor, peak * p.diffRatio);
  return mergeWindows(
    samples.filter((s) => s.d >= th).map((s) => ({
      start: s.t - p.motionPreS,
      end: s.t + p.motionPostS,
    })),
    duration
  );
}

/**
 * 窗口 → 实际要推理的帧。时刻取自全局网格的子集：
 * 裁剪只减少帧，不移动帧，窗口内的分析结果与整段扫描逐帧一致。
 * 覆盖率过高或窗口为空时回退整段（返回单个整段窗口）。
 * @returns {{start:number,end:number,times:number[]}[]}
 */
export function planFrames(windows, duration, fps = FILE_SAMPLE_FPS, p = SCAN_PARAMS) {
  const grid = sampleGrid(duration, fps);
  if (!grid.length) return [];
  const full = [{ start: 0, end: duration, times: grid }];
  const merged = mergeWindows(windows, duration);
  if (!merged.length) return full;
  const covered = merged.reduce((s, w) => s + (w.end - w.start), 0);
  if (covered / duration > p.maxCoverage) return full;
  const out = merged
    .map((w) => ({ ...w, times: grid.filter((t) => t >= w.start && t <= w.end) }))
    .filter((w) => w.times.length);
  return out.length ? out : full;
}

/** 计划内的总帧数（进度条与耗时预估用） */
export function totalFrames(plan) {
  return (plan || []).reduce((s, w) => s + w.times.length, 0);
}

/** 计划是否等价于"整段都扫"（用于给用户如实的文案） */
export function isFullScan(plan, duration) {
  return plan.length === 1 && plan[0].start <= 0 && plan[0].end >= duration;
}
