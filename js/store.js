// 练习历史存储与统计：localStorage 持久化（只存每次挥杆的元数据，
// 几百字节/次，不存视频），并计算趋势与"主攻问题"建议。
import { RULES, SEVERITY } from "./rules.js";

const KEY = "swingHistory.v1";
const MAX_RECORDS = 3000;

// TPI 因果链优先级：根因问题排前（教练逻辑：先改因，果往往自愈）。
// 例如早伸是鸡翅膀的因、摇摆是重心滞留的因。
const FOCUS_PRIORITY = [
  "HIP_SWAY", "EARLY_EXTENSION", "LOSS_OF_POSTURE", "REVERSE_SPINE",
  "OVER_THE_TOP", "C_POSTURE", "SPINE_TOO_BENT", "SPINE_TOO_UPRIGHT",
  "HIP_SLIDE", "FLAT_SHOULDER_PLANE", "HEAD_SWAY", "HEAD_DROP",
  "HANGING_BACK", "CHICKEN_WING",
];

export function getSwings() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

/** 报告生成时调用：存档一次挥杆 */
export function saveSwing(summary, source) {
  const rec = {
    t: Date.now(),
    view: summary.view,
    source,
    score: summary.score,
    faults: summary.faults.map((f) => f.key),
    tempo: summary.tempo ? +summary.tempo.ratio.toFixed(2) : null,
  };
  const arr = getSwings();
  arr.push(rec);
  if (arr.length > MAX_RECORDS) arr.splice(0, arr.length - MAX_RECORDS);
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    /* 存储满时静默放弃 */
  }
  return rec;
}

export function clearSwings() {
  localStorage.removeItem(KEY);
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

/** 汇总统计：本周/上周对比、14 天评分趋势、问题触发率、主攻建议 */
export function computeStats() {
  const swings = getSwings();
  if (swings.length === 0) return null;
  const now = Date.now();
  const WEEK = 7 * 864e5;

  const today = swings.filter((s) => dayKey(s.t) === dayKey(now));
  const thisWeek = swings.filter((s) => now - s.t < WEEK);
  const lastWeek = swings.filter((s) => now - s.t >= WEEK && now - s.t < 2 * WEEK);

  // 各问题触发率（出现该问题的挥杆占比）
  const rate = (key, arr) =>
    arr.length ? arr.filter((s) => s.faults.includes(key)).length / arr.length : 0;
  const keys = [...new Set([...thisWeek, ...lastWeek].flatMap((s) => s.faults))];
  const faultStats = keys
    .map((key) => ({
      key,
      rule: RULES[key],
      now: rate(key, thisWeek),
      prev: lastWeek.length ? rate(key, lastWeek) : null,
    }))
    .filter((f) => f.rule)
    .sort((a, b) => b.now - a.now);

  // 主攻问题：本周触发率 ≥30% 的问题里，按因果链优先级取最靠前的根因
  const candidates = faultStats.filter((f) => f.now >= 0.3);
  const focus =
    candidates.sort(
      (a, b) => FOCUS_PRIORITY.indexOf(a.key) - FOCUS_PRIORITY.indexOf(b.key)
    )[0] || faultStats[0] || null;

  // 最近 14 天逐日平均分
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const t = now - i * 864e5;
    const k = dayKey(t);
    const ds = swings.filter((s) => dayKey(s.t) === k);
    days.push({
      label: new Date(t).getDate() + "",
      count: ds.length,
      score: ds.length ? Math.round(avg(ds.map((s) => s.score))) : null,
    });
  }

  const tempos = thisWeek.map((s) => s.tempo).filter(Boolean);
  return {
    total: swings.length,
    today: { count: today.length, score: Math.round(avg(today.map((s) => s.score))) },
    week: {
      count: thisWeek.length,
      score: Math.round(avg(thisWeek.map((s) => s.score))),
      prevScore: lastWeek.length ? Math.round(avg(lastWeek.map((s) => s.score))) : null,
      tempo: tempos.length ? +avg(tempos).toFixed(1) : null,
    },
    faultStats,
    focus,
    days,
  };
}

export { SEVERITY };
