// SwingSession schema v1.0.0 单元测试（node:test，零额外依赖）
// 覆盖：合法样例（全量 / vision-only / imu-only / 双 null）、非法样例逐类拒绝、
// validate.js 内嵌 code 镜像与 finding-codes.json 的一致性。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateSwingSession, FINDING_CODES, SCHEMA_VERSION } from "../schema/validate.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 构造一份全量合法样例（vision + imu 都非空） */
function fullSample() {
  return {
    schema_version: "1.0.0",
    session_id: "3f2b8c1e-aaaa-bbbb-cccc-000000000001",
    user_id: "device-uuid-1234",
    captured_at: "2026-09-14T10:00:00+08:00",
    swings: [
      {
        swing_id: "sw-0001",
        t0_ms: 12000,
        t_impact_ms: 1450,
        phases: { P1: 0, P2: 320, P3: null, P4: 1100, P5: null, P6: null, P7: 1450, P8: null, P9: null, P10: null },
        vision: {
          source: "swingcoach-web@mediapipe-pose-landmarker-lite",
          fps: 15,
          keypoint_format: "mediapipe-pose-33",
          keypoints_2d: [
            { t_ms: 0, points: Array.from({ length: 33 }, () => [0.5, 0.5, 0.9]) },
            { t_ms: 66, points: Array.from({ length: 33 }, () => [0.51, 0.49, 0.88]) },
          ],
          keypoints_3d: null,
          metrics: { view: "side", tempo_ratio: 2.8, backswing_ms: 780 },
          score: 76,
          findings: [
            { code: "early_extension", severity: "bad", ratio: 1.4, phase: "downswing", t_ms: 1320 },
            { code: "head_drop", severity: "warn", ratio: 1.1, phase: "backswing", t_ms: 700 },
          ],
        },
        imu: {
          source: "swingcoach-sleeve@fw1.0",
          devices: [
            { device_id: "imu-hand", placement: "hand_back", sample_rate_hz: 200, model: "SC-S1", firmware: "1.0.2" },
            { device_id: "imu-forearm", placement: "forearm", sample_rate_hz: 200, model: "SC-S1", firmware: "1.0.2" },
          ],
          samples: [
            { t_ms: 0, device_id: "imu-hand", acc: [0.1, 9.8, 0.2], gyro: [1, 2, 3], mag: null },
            { t_ms: 5, device_id: "imu-forearm", acc: [0.1, 9.8, 0.2], gyro: [1, 2, 3] },
          ],
          metrics: { wrist_release_ms: 1380 },
          findings: [{ code: "casting", severity: "bad", ratio: 1.6, phase: "downswing", t_ms: 1300 }],
        },
        annotations: [{ kind: "user_note", t_ms: null, payload: { text: "7 号铁" } }],
      },
    ],
  };
}

test("全量样例（vision+imu）通过", () => {
  const r = validateSwingSession(fullSample());
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test("vision-only（imu=null）合法 —— 本仓库的标准产出形态", () => {
  const s = fullSample();
  s.swings[0].imu = null;
  assert.equal(validateSwingSession(s).valid, true);
});

test("imu-only（vision=null）合法 —— 传感器线的标准产出形态", () => {
  const s = fullSample();
  s.swings[0].vision = null;
  assert.equal(validateSwingSession(s).valid, true);
});

test("vision 与 imu 同时为 null 合法（仅时间戳的挥杆记录）", () => {
  const s = fullSample();
  s.swings[0].vision = null;
  s.swings[0].imu = null;
  assert.equal(validateSwingSession(s).valid, true);
});

test("keypoints_2d 为空数组合法（导出方未开启关键点留存）", () => {
  const s = fullSample();
  s.swings[0].vision.keypoints_2d = [];
  assert.equal(validateSwingSession(s).valid, true);
});

test("user_id 可为 null（匿名导出）", () => {
  const s = fullSample();
  s.user_id = null;
  assert.equal(validateSwingSession(s).valid, true);
});

// ---- 非法样例：逐类拒绝，并给出可定位的路径 ----

function expectInvalid(mutate, pathFragment) {
  const s = fullSample();
  mutate(s);
  const r = validateSwingSession(s);
  assert.equal(r.valid, false, "应当校验失败");
  assert.ok(
    r.errors.some((e) => e.includes(pathFragment)),
    "错误应指向 " + pathFragment + "，实际：" + JSON.stringify(r.errors)
  );
}

test("缺 schema_version 拒绝", () => expectInvalid((s) => delete s.schema_version, "schema_version"));
test("主版本不兼容拒绝", () => expectInvalid((s) => { s.schema_version = "2.0.0"; }, "schema_version"));
test("captured_at 非法拒绝", () => expectInvalid((s) => { s.captured_at = "昨天"; }, "captured_at"));
test("phases 缺 P7 拒绝", () => expectInvalid((s) => delete s.swings[0].phases.P7, "phases.P7"));
test("phases 出现未知键拒绝", () => expectInvalid((s) => { s.swings[0].phases.P11 = 1; }, "phases.P11"));
test("未注册 finding code 拒绝", () =>
  expectInvalid((s) => { s.swings[0].vision.findings[0].code = "made_up_code"; }, "findings[0].code"));
test("severity 非法拒绝", () =>
  expectInvalid((s) => { s.swings[0].vision.findings[0].severity = "fatal"; }, "severity"));
test("关键点非三元组拒绝", () =>
  expectInvalid((s) => { s.swings[0].vision.keypoints_2d[0].points[0] = [0.5, 0.5]; }, "points[0]"));
test("keypoints_3d 非 null 拒绝（v1 预留）", () =>
  expectInvalid((s) => { s.swings[0].vision.keypoints_3d = []; }, "keypoints_3d"));
test("imu placement 非法拒绝", () =>
  expectInvalid((s) => { s.swings[0].imu.devices[0].placement = "wrist"; }, "placement"));
test("imu 样本 acc 缺维度拒绝", () =>
  expectInvalid((s) => { s.swings[0].imu.samples[0].acc = [1, 2]; }, "acc"));
test("缺 vision 键（而非 null）拒绝", () =>
  expectInvalid((s) => delete s.swings[0].vision, ".vision"));

// ---- 单一事实源保障：内嵌镜像必须与 finding-codes.json 一致 ----

test("validate.js 的 FINDING_CODES 与 finding-codes.json 完全一致", () => {
  const json = JSON.parse(readFileSync(path.join(REPO, "schema/finding-codes.json"), "utf8"));
  const fromJson = Object.keys(json.codes).sort();
  assert.deepEqual([...FINDING_CODES].sort(), fromJson);
  assert.equal(json.registry_version, SCHEMA_VERSION);
});

test("现有 rules.js 的 14 个问题键全部有对应 code（legacy_key 映射完整）", async () => {
  const { RULES } = await import("../js/rules.js");
  const json = JSON.parse(readFileSync(path.join(REPO, "schema/finding-codes.json"), "utf8"));
  const legacy = new Set(
    Object.values(json.codes).map((c) => c.legacy_key).filter(Boolean)
  );
  for (const key of Object.keys(RULES)) {
    assert.ok(legacy.has(key), "rules.js 键未迁移到 finding-codes.json：" + key);
  }
});
