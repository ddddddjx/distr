// 击球声定位：从上传视频的音轨中检测击球瞬态，用于区分试挥与正式挥杆。
// 全部在本地解码分析（Web Audio API），音频与视频一样不离开设备。
//
// 原理：正式击球产生尖锐的宽频瞬态（能量在几毫秒内跃升数倍），而试挥
// 只有低频风声。对高通预处理后的能量包络做"相对本底跃升"检测，
// 峰值时刻与某杆的击球时刻（视频时间轴）对齐即判定该杆有击球声。
//
// detectTransients / hasStrikeNear 为纯函数（Node 可测）；
// extractImpactTimes 是浏览器端解码入口。

/** 检测参数（集中声明，便于调优与测试引用） */
export const STRIKE_PARAMS = {
  hopMs: 10,          // 能量包络的窗口步长
  riseRatio: 4.0,     // 峰值能量 / 前置本底 的最小倍数
  floorRms: 0.015,    // 绝对能量下限（防静音底噪误报）
  baselineMs: 300,    // 本底统计窗口（峰值之前）
  mergeMs: 120,       // 相邻峰合并间隔
  matchWindowS: 0.25, // 与击球时刻的对齐窗口（±秒）
};

/**
 * 在单声道采样上检测击球类瞬态。
 * @param {Float32Array} samples 单声道 PCM（-1..1）
 * @param {number} sampleRate
 * @returns {number[]} 瞬态时刻（秒，升序）
 */
export function detectTransients(samples, sampleRate) {
  const P = STRIKE_PARAMS;
  if (!samples || samples.length === 0 || !sampleRate) return [];

  // 一阶差分做廉价高通：强调宽频瞬态、压制风声/语音等低频能量
  const hop = Math.max(1, Math.round((P.hopMs / 1000) * sampleRate));
  const nWin = Math.floor(samples.length / hop);
  if (nWin < 4) return [];
  const rms = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let acc = 0;
    const start = w * hop;
    for (let i = start === 0 ? 1 : start; i < start + hop; i++) {
      const d = samples[i] - samples[i - 1];
      acc += d * d;
    }
    rms[w] = Math.sqrt(acc / hop);
  }

  const baseWin = Math.max(2, Math.round(P.baselineMs / P.hopMs));
  const peaks = [];
  for (let w = 1; w < nWin; w++) {
    if (rms[w] < P.floorRms) continue;
    // 前置本底：峰值之前 baselineMs 的中位数（对偶发杂音鲁棒）
    const from = Math.max(0, w - baseWin);
    const base = median(rms.subarray(from, w));
    if (rms[w] >= (base + 1e-6) * P.riseRatio && rms[w] > rms[w - 1]) {
      const t = (w * hop) / sampleRate;
      const last = peaks[peaks.length - 1];
      if (last && t - last.t < P.mergeMs / 1000) {
        if (rms[w] > last.v) { last.t = t; last.v = rms[w]; } // 同一击保留最强点
      } else {
        peaks.push({ t, v: rms[w] });
      }
    }
  }
  return peaks.map((p) => p.t);
}

/**
 * 某个击球时刻附近是否存在瞬态峰。
 * @param {number|null} impactT 该杆击球时刻（视频时间轴秒）；null 视为未知
 * @param {number[]} peaks detectTransients 的输出
 * @param {number} [windowS] 对齐窗口（±秒）
 * @returns {boolean|null} true/false；impactT 为 null 时返回 null（未知）
 */
export function hasStrikeNear(impactT, peaks, windowS = STRIKE_PARAMS.matchWindowS) {
  if (typeof impactT !== "number") return null;
  return peaks.some((t) => Math.abs(t - impactT) <= windowS);
}

/**
 * 浏览器端入口：从视频文件解码音轨并返回瞬态时刻。
 * 无音轨/解码失败/超时返回 null（调用方按"无音频信号"降级）。
 * @param {Blob} fileBlob 用户上传的视频文件
 * @param {number} [timeoutMs] 解码+分析的总超时
 * @returns {Promise<number[]|null>}
 */
export async function extractImpactTimes(fileBlob, timeoutMs = 4000) {
  const work = (async () => {
    const buf = await fileBlob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      const audio = await ctx.decodeAudioData(buf);
      // 混单声道
      const n = audio.length;
      const mono = new Float32Array(n);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const ch = audio.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
      }
      return detectTransients(mono, audio.sampleRate);
    } finally {
      ctx.close().catch(() => {});
    }
  })();
  const timeout = new Promise((res) => setTimeout(() => res(null), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    return null; // 无音轨等解码失败 → 降级
  }
}

function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

/**
 * 默认展示杆选择：有击球声的最后一杆优先（正式挥通常在后），
 * 全部无声/未知时回退最后一杆。
 * @param {(boolean|null)[]} strikes 各杆的声学判定
 * @returns {number} 默认展示的下标
 */
export function pickDefaultSwing(strikes) {
  if (!Array.isArray(strikes) || strikes.length === 0) return 0;
  for (let i = strikes.length - 1; i >= 0; i--) {
    if (strikes[i] === true) return i;
  }
  return strikes.length - 1;
}

/**
 * 区间匹配兜底：击球时刻未知（低帧率漏采 IMPACT 相位）时，
 * 用该杆的时间跨度判断——挥杆之间不重叠，声落在跨度内即属于该杆。
 * @param {number} startS 该杆起始（视频秒）
 * @param {number} endS 该杆结束（视频秒）
 * @param {number[]} peaks
 * @returns {boolean}
 */
export function hasStrikeInRange(startS, endS, peaks) {
  if (typeof startS !== "number" || typeof endS !== "number" || endS <= startS) return false;
  return peaks.some((t) => t >= startS && t <= endS);
}
