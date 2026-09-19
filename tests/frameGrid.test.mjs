// 上传视频确定性采样网格单测。
// 守的是线上事故：同一段视频两次分析分数不一样（旧实现"边播边抽帧"，
// 抽到哪些帧取决于当时手机有多忙，实测两遍重合度只有 6%）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleGrid, estimateAnalysisSeconds, FILE_SAMPLE_FPS } from "../js/frameGrid.js";

test("同样的入参永远同样的网格（这正是分数可复现的根据）", () => {
  const a = sampleGrid(3.7);
  const b = sampleGrid(3.7);
  assert.deepEqual(a, b);
  assert.ok(a.length > 1);
});

test("网格只由时长与采样率决定，与机器快慢无关", () => {
  assert.equal(sampleGrid(10, 15).length, 151);   // 0 到 10s，每 1/15s 一帧
  assert.equal(sampleGrid(10, 30).length, 301);
  assert.equal(sampleGrid(10, 12).length, 121);
});

test("时刻递增且不越过片尾", () => {
  const g = sampleGrid(2.03);
  for (let i = 1; i < g.length; i++) assert.ok(g[i] > g[i - 1], "必须严格递增");
  assert.ok(g[g.length - 1] <= 2.03 + 1e-9);
  assert.equal(g[0], 0);
});

test("非法时长返回空网格（调用方据此提示读不到时长）", () => {
  assert.deepEqual(sampleGrid(0), []);
  assert.deepEqual(sampleGrid(-1), []);
  assert.deepEqual(sampleGrid(NaN), []);
  assert.deepEqual(sampleGrid(5, 0), []);
});

test("采样率守住下限：快速下杆那 0.25s 至少采到 3 帧", () => {
  // 采样率是准确度与耗时的折中。降到采不满 3 帧就会漏掉击球瞬间，
  // 分数口径也跟着变——这条是下限，不是当前值的快照。
  assert.ok(0.25 * FILE_SAMPLE_FPS >= 3, `当前 ${FILE_SAMPLE_FPS}fps 采不到 3 帧`);
  // 配套的识别验证见 tests/analyzer.test.mjs「12fps 采样下仍能识别完整挥杆」
});

test("耗时预估随时长线性增长", () => {
  const s5 = estimateAnalysisSeconds(5), s10 = estimateAnalysisSeconds(10);
  assert.ok(s10 > s5 && s10 < s5 * 2.5);
  assert.ok(estimateAnalysisSeconds(0) >= 1, "0 时长也要给个下限，别显示「约 0 秒」");
});
