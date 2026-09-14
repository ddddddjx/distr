// ExternalDataProvider / NullProvider / 装载器 单元测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalDataProvider } from "../js/providers/externalDataProvider.js";
import { NullProvider } from "../js/providers/nullProvider.js";
import { loadExternalProvider } from "../js/providers/loadProvider.js";

test("接口基类：未实现的方法必须抛错（防止半吊子实现静默通过）", async () => {
  const base = new ExternalDataProvider();
  await assert.rejects(() => base.connect(), /未实现/);
  await assert.rejects(() => base.disconnect(), /未实现/);
  assert.throws(() => base.startSwing("sw-1", 0), /未实现/);
  assert.throws(() => base.stopSwing("sw-1"), /未实现/);
  await assert.rejects(() => base.getSamples("sw-1"), /未实现/);
});

test("NullProvider：连接返回 false、生命周期 no-op、getSamples 恒为 null", async () => {
  const p = new NullProvider();
  assert.ok(p instanceof ExternalDataProvider, "必须是接口子类");
  assert.equal(await p.connect(), false);
  p.startSwing("sw-1", 1000);
  p.stopSwing("sw-1");
  assert.equal(await p.getSamples("sw-1"), null, "imu 块为 null 是合法契约值");
  await p.disconnect();
});

test("装载器：传感器模块缺失（占位路径）时安静回退 NullProvider", async () => {
  const { provider, source, reason } = await loadExternalProvider();
  assert.equal(source, "null");
  assert.ok(provider instanceof NullProvider);
  assert.ok(reason && reason.length > 0, "应携带回退原因便于排查");
  assert.equal(await provider.getSamples("any"), null);
});

test("NullProvider.getSamples 的 null 与契约兼容（挂进 swing.imu 可过校验）", async () => {
  const { validateSwingSession } = await import("../schema/validate.js");
  const { exportSession } = await import("../js/exportSession.js");
  const s = exportSession([{ score: 60, view: "front", tempo: null, faults: [] }]);
  s.swings[0].imu = await new NullProvider().getSamples("sw-x"); // = null
  assert.equal(validateSwingSession(s).valid, true);
});
