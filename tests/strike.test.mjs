// 击球声瞬态检测单元测试（纯函数，合成信号驱动）
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTransients, hasStrikeNear, STRIKE_PARAMS } from "../js/strikeAudio.js";

const SR = 8000;
const sec = (s) => Math.round(s * SR);

/** 确定性伪白噪声（可复现） */
function noise(n, amp) {
  const out = new Float32Array(n);
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

/** 在 t 秒处叠加宽频击球瞬态（交替方波片段） */
function addClick(sig, t, amp = 0.9, ms = 6) {
  const start = sec(t);
  const n = Math.round((ms / 1000) * SR);
  for (let i = 0; i < n && start + i < sig.length; i++) {
    sig[start + i] += i % 2 === 0 ? amp : -amp;
  }
}

test("纯静音：无峰", () => {
  assert.deepEqual(detectTransients(new Float32Array(sec(3)), SR), []);
});

test("本底噪声 + 单次击球：定位到击球时刻（±50ms）", () => {
  const sig = noise(sec(5), 0.02);
  addClick(sig, 2.0);
  const peaks = detectTransients(sig, SR);
  assert.equal(peaks.length, 1, "应恰好一个峰，实际 " + JSON.stringify(peaks));
  assert.ok(Math.abs(peaks[0] - 2.0) < 0.05, "峰位 " + peaks[0]);
});

test("低频风声（大振幅慢变化）：不误报", () => {
  const sig = new Float32Array(sec(4));
  for (let i = 0; i < sig.length; i++) sig[i] = 0.5 * Math.sin((2 * Math.PI * 3 * i) / SR);
  assert.deepEqual(detectTransients(sig, SR), []);
});

test("双击相隔 60ms：合并为一个峰；相隔 1s：两个峰", () => {
  const near = noise(sec(4), 0.02);
  addClick(near, 2.0);
  addClick(near, 2.06);
  assert.equal(detectTransients(near, SR).length, 1);

  const far = noise(sec(5), 0.02);
  addClick(far, 1.5);
  addClick(far, 3.2);
  const peaks = detectTransients(far, SR);
  assert.equal(peaks.length, 2);
  assert.ok(Math.abs(peaks[0] - 1.5) < 0.05 && Math.abs(peaks[1] - 3.2) < 0.05);
});

test("hasStrikeNear：窗口内命中/窗口外不命中/未知时刻返回 null", () => {
  const peaks = [2.0, 8.5];
  assert.equal(hasStrikeNear(2.1, peaks), true);
  assert.equal(hasStrikeNear(2.0 + STRIKE_PARAMS.matchWindowS + 0.01, peaks), false);
  assert.equal(hasStrikeNear(5.0, peaks), false);
  assert.equal(hasStrikeNear(null, peaks), null);
});

test("pickDefaultSwing：有声最后一杆优先，全无声/未知回退最后一杆", async () => {
  const { pickDefaultSwing } = await import("../js/strikeAudio.js");
  assert.equal(pickDefaultSwing([null, null]), 1, "无音频信号 → 最后一杆");
  assert.equal(pickDefaultSwing([true, false]), 0, "正式挥在前也能选中");
  assert.equal(pickDefaultSwing([false, true]), 1);
  assert.equal(pickDefaultSwing([false, true, true]), 2, "多次正式挥取最后");
  assert.equal(pickDefaultSwing([false, false]), 1);
  assert.equal(pickDefaultSwing([]), 0);
});

test("hasStrikeInRange：跨度内命中、跨度外与非法区间不命中", async () => {
  const { hasStrikeInRange } = await import("../js/strikeAudio.js");
  const peaks = [17.49];
  assert.equal(hasStrikeInRange(15.0, 20.0, peaks), true);
  assert.equal(hasStrikeInRange(4.0, 10.0, peaks), false);
  assert.equal(hasStrikeInRange(20.0, 15.0, peaks), false, "非法区间返回 false");
});
