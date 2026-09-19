// 击球区间粗扫定位单测。
// 守两件事：① 裁剪省下的帧是真省（覆盖率、帧数）；
// ② 裁剪**不改变分数口径**——窗口内的采样时刻必须与整段扫描逐帧一致，
//    且窗口要从准备姿势之前开起（基准锁定要静止 600ms + ≥5 采样，
//    窗口开太晚会整杆识别不到，那比慢更糟）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCAN_PARAMS, mergeWindows, windowsFromStrikes, windowsFromMotion,
  planFrames, totalFrames, isFullScan,
} from "../js/scanWindows.js";
import { sampleGrid, FILE_SAMPLE_FPS } from "../js/frameGrid.js";

test("重叠/相邻窗口合并，并裁进 [0, duration]", () => {
  const w = mergeWindows([{ start: 5, end: 8 }, { start: -2, end: 3 }, { start: 7, end: 20 }], 12);
  assert.deepEqual(w, [{ start: 0, end: 3 }, { start: 5, end: 12 }]);
});

test("击球声峰 → 覆盖挥杆全程的窗口（前留准备、后留收杆）", () => {
  const w = windowsFromStrikes([10], 30);
  assert.equal(w.length, 1);
  assert.equal(w[0].start, 10 - SCAN_PARAMS.preS);
  assert.equal(w[0].end, 10 + SCAN_PARAMS.postS);
  // 前置余量必须覆盖"静止 600ms 锁基准 + 约 1s 上杆"，否则基准锁不上
  assert.ok(SCAN_PARAMS.preS >= 0.6 + 1.0 + 0.5, "击球前留的余量不够锁基准");
  assert.ok(SCAN_PARAMS.postS >= 1.0, "击球后留的余量不够走完送杆到收杆");
});

test("连续两杆各成一段；靠得近的两声合成一段", () => {
  assert.equal(windowsFromStrikes([5, 20], 30).length, 2);
  assert.equal(windowsFromStrikes([5, 6.5], 30).length, 1);
});

test("没有击球声就不给窗口（调用方据此退到帧差粗扫）", () => {
  assert.deepEqual(windowsFromStrikes([], 30), []);
  assert.deepEqual(windowsFromStrikes(null, 30), []);
});

test("帧差粗扫：只圈出动的那几秒，静止段不入选", () => {
  const samples = [];
  for (let t = 0; t < 30; t += 1 / SCAN_PARAMS.coarseFps) {
    samples.push({ t, d: t > 14 && t < 16 ? 0.2 : 0.001 }); // 只有 14–16s 在动
  }
  const w = windowsFromMotion(samples, 30);
  assert.equal(w.length, 1);
  // 起点至少退到动作开始前 motionPreS（粗网格本身有一格的量化误差）
  assert.ok(w[0].start <= 14 - SCAN_PARAMS.motionPreS + 1 / SCAN_PARAMS.coarseFps + 1e-6);
  assert.ok(w[0].end >= 16 - 1e-6);
  assert.ok(w[0].end - w[0].start < 10, "窗口不该退化成整段");
});

test("整段几乎静止（只有传感器噪点）时粗扫不表态，不硬圈一段", () => {
  const samples = [];
  for (let t = 0; t < 10; t += 1 / SCAN_PARAMS.coarseFps) samples.push({ t, d: 0.002 });
  assert.deepEqual(windowsFromMotion(samples, 10), []);
});

test("窗口内的采样时刻是全局网格的子集：裁剪只减少帧，绝不移动帧", () => {
  const dur = 30;
  const full = sampleGrid(dur);
  const plan = planFrames(windowsFromStrikes([20], dur), dur);
  const times = plan.flatMap((w) => w.times);
  assert.ok(times.length > 0);
  for (const t of times) {
    assert.ok(full.some((g) => Math.abs(g - t) < 1e-9), `${t} 不在全局网格上`);
  }
  // 同一段窗口里，我们走的帧与整段扫描在该区间走的帧完全一致
  const inRange = full.filter((t) => t >= plan[0].start && t <= plan[0].end);
  assert.deepEqual(times, inRange);
});

test("定位成功要真省帧：30 秒素材只剩击球前后那几秒", () => {
  const dur = 30;
  const plan = planFrames(windowsFromStrikes([20], dur), dur);
  const saved = 1 - totalFrames(plan) / sampleGrid(dur).length;
  assert.ok(saved > 0.7, `只省了 ${(saved * 100).toFixed(0)}%，不值得这套机制`);
  assert.equal(totalFrames(plan), Math.round((SCAN_PARAMS.preS + SCAN_PARAMS.postS) * FILE_SAMPLE_FPS) + 1);
});

test("定位不到就回退整段：宁可慢，也不能让用户拿不到报告", () => {
  const dur = 12;
  const plan = planFrames([], dur);
  assert.ok(isFullScan(plan, dur));
  assert.deepEqual(plan[0].times, sampleGrid(dur));
});

test("窗口铺满大半段时直接走整段：裁一点点不值得承担漏采风险", () => {
  const dur = 6; // 短素材：一次击球的窗口就已经覆盖全段
  const plan = planFrames(windowsFromStrikes([4], dur), dur);
  assert.ok(isFullScan(plan, dur));
});

test("嘈杂练习场：邻位击球声铺满全段时退回整段，而不是切成一堆窗口", () => {
  const dur = 30;
  const peaks = [];
  for (let t = 1; t < dur; t += 2) peaks.push(t); // 每 2 秒一声
  const plan = planFrames(windowsFromStrikes(peaks, dur), dur);
  assert.ok(isFullScan(plan, dur));
});

test("时长读不到时不给任何计划（调用方据此提示）", () => {
  assert.deepEqual(planFrames(windowsFromStrikes([3], 0), 0), []);
});

test("同样的入参永远同样的计划（定位本身也必须确定性）", () => {
  const a = planFrames(windowsFromStrikes([7.3, 21.9], 40), 40);
  const b = planFrames(windowsFromStrikes([7.3, 21.9], 40), 40);
  assert.deepEqual(a, b);
});
