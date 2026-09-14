// "手腕数据"区块渲染器单元测试（步骤 4 扩展点）
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderImuBlockHtml } from "../js/imuReport.js";

const sampleImu = () => ({
  source: "swingcoach-sleeve@fw1.0",
  devices: [
    { device_id: "a", placement: "hand_back", sample_rate_hz: 200 },
    { device_id: "b", placement: "forearm", sample_rate_hz: 200 },
  ],
  samples: [],
  metrics: { wrist_release_ms: 1380, custom_metric: 7 },
  findings: [
    { code: "casting", severity: "bad", ratio: 1.6, phase: "downswing", t_ms: 1300 },
    { code: "chicken_wing", severity: "warn", ratio: 1.2, phase: "impact", t_ms: null },
    { code: "future_new_code", severity: "warn", ratio: null, phase: null, t_ms: null },
  ],
});

test("imu 为 null/undefined/非对象：返回空串，UI 与现状一致", () => {
  assert.equal(renderImuBlockHtml(null), "");
  assert.equal(renderImuBlockHtml(undefined), "");
  assert.equal(renderImuBlockHtml("x"), "");
});

test("完整 imu：包含标题、设备中文标签与采样率、指标、问题标签", () => {
  const html = renderImuBlockHtml(sampleImu());
  assert.ok(html.includes("手腕数据"));
  assert.ok(html.includes("手背 200Hz"));
  assert.ok(html.includes("前臂 200Hz"));
  assert.ok(html.includes("手腕释放时刻"));
  assert.ok(html.includes("1380 ms"));
  assert.ok(html.includes("custom_metric"), "未知指标键按原样展示");
  assert.ok(html.includes("提前释放"), "imu 专属码有中文标签");
  assert.ok(html.includes("鸡翅膀") || html.includes("前臂没伸直"), "视觉共享码复用 rules.js 标题");
  assert.ok(html.includes("future_new_code"), "未知 finding code 回退显示原始码");
  assert.ok(html.includes('class="imu-finding bad"'), "严重度样式区分");
});

test("空 metrics / 空 findings：对应小节不渲染但块仍存在", () => {
  const imu = sampleImu();
  imu.metrics = {};
  imu.findings = [];
  const html = renderImuBlockHtml(imu);
  assert.ok(html.includes("手腕数据"));
  assert.ok(!html.includes("imu-metrics"));
  assert.ok(!html.includes("imu-findings"));
});

test("动态字符串做 HTML 转义（契约数据不可信输入）", () => {
  const imu = sampleImu();
  imu.source = '<img src=x onerror=alert(1)>';
  imu.metrics = { note: '<script>bad</script>' };
  const html = renderImuBlockHtml(imu);
  assert.ok(!html.includes("<img"), "source 已转义");
  assert.ok(!html.includes("<script>"), "metrics 值已转义");
  assert.ok(html.includes("&lt;script&gt;"));
});
