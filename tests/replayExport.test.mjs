// 慢放导出的纯函数单测（能力判定 / 容器选择 / 文件名 / 耗时预估）。
// 真正的重编码走浏览器 E2E：tests/replay-export.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportCapability, pickMime, exportFileName, estimateSeconds,
} from "../js/replayExport.js";

const env = (o = {}) => ({
  hasSource: true, hasRawBlob: true,
  hasCaptureStream: true, hasRecorder: true, ...o,
});

test("能力判定：齐活就本地重编码成慢放", () => {
  assert.equal(exportCapability(env()), "slowmo");
});

test("能力判定：缺 captureStream / MediaRecorder → 降级存原速片段", () => {
  assert.equal(exportCapability(env({ hasCaptureStream: false })), "raw");
  assert.equal(exportCapability(env({ hasRecorder: false })), "raw");
});

test("能力判定：没有原速片段又转不了码（视频模式）→ 不给存，别骗用户", () => {
  assert.equal(
    exportCapability(env({ hasCaptureStream: false, hasRawBlob: false })),
    "none"
  );
});

test("能力判定：压根没有回放源 → none", () => {
  assert.equal(exportCapability(env({ hasSource: false })), "none");
});

test("容器优先 mp4：iOS 存进相册只认它，webm 只能存到「文件」", () => {
  assert.equal(pickMime((t) => true), "video/mp4");
  assert.equal(pickMime((t) => !t.includes("mp4")), "video/webm;codecs=vp9");
  assert.equal(pickMime(() => false), "", "都不支持时交给浏览器默认");
});

test("文件名带日期与分数，扩展名跟随容器", () => {
  const d = new Date(2026, 8, 19, 18, 19, 5);
  assert.equal(exportFileName(92, "video/mp4", d), "jaykay-golf-20260919-181905-92分.mp4");
  assert.equal(exportFileName(undefined, "video/webm;codecs=vp9", d), "jaykay-golf-20260919-181905.webm");
});

test("耗时预估 = 区间时长 ÷ 倍速；区间非法时为 0", () => {
  assert.equal(estimateSeconds(1, 3, 0.4), 5);
  assert.equal(estimateSeconds(3, 1, 0.4), 0);
  assert.equal(estimateSeconds(0, 0, 0.4), 0);
});
