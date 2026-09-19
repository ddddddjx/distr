// 摄像头预览卡死看门狗单测。
//
// 守的线上事故：实时模式打完第一杆、报告里的慢放回放播过之后，iOS 把摄像头
// 预览的 <video> 暂停（甚至中断采集轨道），video.currentTime 不再前进，
// detect() 从此永远返回 undefined——页面一切正常，就是再也识别不到挥杆。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecovery, STALL_MS, MAX_REOPEN_TRIES } from "../js/cameraWatchdog.js";

/** 默认现场：相机模式、正在分析、轨道正常、刚刚卡住 */
const base = (o = {}) => ({
  now: 10_000,
  lastFrameAt: 10_000 - STALL_MS,
  source: "camera",
  running: true,
  recovering: false,
  resumeTries: 0,
  reopenTries: 0,
  trackState: "live",
  trackMuted: false,
  ...o,
});

test("帧还在正常来：不介入", () => {
  assert.equal(decideRecovery(base({ lastFrameAt: 10_000 - 100 })), "none");
});

test("轨道活着但画面停了：先轻量续播", () => {
  assert.equal(decideRecovery(base()), "resume");
});

test("续播过一次仍然没有新帧：升级为重开摄像头", () => {
  assert.equal(decideRecovery(base({ resumeTries: 1 })), "reopen");
});

test("轨道被系统中断（iOS 抢走相机）：直接重开", () => {
  assert.equal(decideRecovery(base({ trackMuted: true })), "reopen");
  assert.equal(decideRecovery(base({ trackState: "ended" })), "reopen");
  assert.equal(decideRecovery(base({ trackState: "none" })), "reopen");
});

test("重开多次仍拿不到帧：停下来告诉用户，不再空转", () => {
  assert.equal(decideRecovery(base({ reopenTries: MAX_REOPEN_TRIES })), "stop");
  // 停机判定优先于任何恢复手段
  assert.equal(
    decideRecovery(base({ reopenTries: MAX_REOPEN_TRIES, trackMuted: true })),
    "stop"
  );
});

test("视频文件模式的「没有新帧」是正常现象：绝不重开摄像头", () => {
  assert.equal(decideRecovery(base({ source: "file", lastFrameAt: 0 })), "none");
});

test("未在分析 / 已有恢复在跑：不重复触发", () => {
  assert.equal(decideRecovery(base({ running: false })), "none");
  assert.equal(decideRecovery(base({ recovering: true })), "none");
});
