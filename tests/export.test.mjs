// exportSession 映射单元测试：summary → SwingSession 契约实例。
// 覆盖：完整 exportData 的时间换算与关键点映射、缺 exportData 的降级、
// 多杆会话、未知规则键报错、LEGACY_TO_CODE 与注册表/规则库的一致性。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exportSession, LEGACY_TO_CODE } from "../js/exportSession.js";
import { validateSwingSession } from "../schema/validate.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 伪造一份 swingAnalyzer._finishSwing 产物（开启 captureKeypoints 形态） */
function fakeSummary() {
  return {
    score: 72,
    view: "side",
    tempo: { back: 780, down: 290, ratio: 780 / 290 },
    faults: [
      { key: "EARLY_EXTENSION", rule: { severity: "bad" }, ratio: 1.42, phase: "downswing" },
      { key: "HEAD_DROP", rule: { severity: "warn" }, ratio: 1.13, phase: "backswing" },
    ],
    exportData: {
      t: { addressLock: 10000, backswing: 10600, top: 11380, impact: 11670, finish: 12400 },
      keypoints: [
        { t: 10000, points: Array.from({ length: 33 }, () => [0.5, 0.5, 0.9]) },
        { t: 10066, points: Array.from({ length: 33 }, () => [0.51, 0.5, 0.9]) },
      ],
      kpFps: 15,
    },
  };
}

test("完整映射：通过契约校验，imu 恒为 null", () => {
  const s = exportSession([fakeSummary()], { userId: "u-test" });
  const r = validateSwingSession(s);
  assert.deepEqual(r.errors, []);
  assert.equal(s.swings.length, 1);
  assert.equal(s.swings[0].imu, null);
  assert.equal(s.swings[0].vision.keypoints_3d, null);
  assert.equal(s.user_id, "u-test");
});

test("时间换算：t0 取 P1（基准锁定），各 phase 为相对偏移", () => {
  const sw = exportSession([fakeSummary()]).swings[0];
  assert.equal(sw.t0_ms, 10000);
  assert.equal(sw.phases.P1, 0);
  assert.equal(sw.phases.P2, 600);
  assert.equal(sw.phases.P4, 1380);
  assert.equal(sw.phases.P7, 1670);
  assert.equal(sw.phases.P10, 2400);
  assert.equal(sw.phases.P3, null);
  assert.equal(sw.t_impact_ms, 1670);
});

test("关键点映射：t_ms 转为相对 t0，点数据原样透传", () => {
  const v = exportSession([fakeSummary()]).swings[0].vision;
  assert.equal(v.keypoints_2d.length, 2);
  assert.equal(v.keypoints_2d[0].t_ms, 0);
  assert.equal(v.keypoints_2d[1].t_ms, 66);
  assert.equal(v.keypoints_2d[0].points.length, 33);
  assert.equal(v.fps, 15);
});

test("findings 映射：legacy key → code，severity/ratio/phase 保留", () => {
  const f = exportSession([fakeSummary()]).swings[0].vision.findings;
  assert.deepEqual(f[0], {
    code: "early_extension", severity: "bad", ratio: 1.42, phase: "downswing", t_ms: null,
  });
  assert.equal(f[1].code, "head_drop");
  assert.equal(f[1].severity, "warn");
});

test("缺 exportData（开关中途打开/旧数据）：降级仍合法，关键点为空", () => {
  const sum = fakeSummary();
  delete sum.exportData;
  const s = exportSession([sum]);
  const sw = s.swings[0];
  assert.equal(validateSwingSession(s).valid, true);
  assert.deepEqual(sw.vision.keypoints_2d, []);
  assert.equal(sw.phases.P1, null);
  assert.equal(sw.t0_ms, 0);
  assert.equal(sw.vision.fps, null);
});

test("多杆会话：swing_id 互不相同，顺序保留", () => {
  const s = exportSession([fakeSummary(), fakeSummary(), fakeSummary()]);
  assert.equal(s.swings.length, 3);
  assert.equal(new Set(s.swings.map((x) => x.swing_id)).size, 3);
});

test("无 tempo / 无 faults 的挥杆合法", () => {
  const sum = fakeSummary();
  sum.tempo = null;
  sum.faults = [];
  const s = exportSession([sum]);
  assert.equal(validateSwingSession(s).valid, true);
  assert.equal(s.swings[0].vision.findings.length, 0);
});

test("未映射的规则键：直接抛错（编程错误不静默）", () => {
  const sum = fakeSummary();
  sum.faults[0].key = "NOT_A_RULE";
  assert.throws(() => exportSession([sum]), /未映射的规则键/);
});

test("Node 环境无 localStorage：user_id 回退 null 且仍合法", () => {
  const s = exportSession([fakeSummary()]); // 未传 userId → getDeviceUserId → null
  assert.equal(s.user_id, null);
  assert.equal(validateSwingSession(s).valid, true);
});

// ---- 一致性保障 ----

test("LEGACY_TO_CODE 与 finding-codes.json 双向一致", () => {
  const json = JSON.parse(readFileSync(path.join(REPO, "schema/finding-codes.json"), "utf8"));
  for (const [legacy, code] of Object.entries(LEGACY_TO_CODE)) {
    assert.ok(json.codes[code], "code 未注册：" + code);
    assert.equal(json.codes[code].legacy_key, legacy, "legacy_key 回链不一致：" + code);
  }
  const jsonLegacy = Object.values(json.codes).map((c) => c.legacy_key).filter(Boolean);
  assert.equal(jsonLegacy.length, Object.keys(LEGACY_TO_CODE).length, "注册表中存在未进映射的 legacy_key");
});

test("rules.js 的全部键都可导出（新增规则必须同步映射）", async () => {
  const { RULES } = await import("../js/rules.js");
  for (const key of Object.keys(RULES)) {
    assert.ok(LEGACY_TO_CODE[key], "rules.js 键缺少导出映射：" + key);
  }
});

// ---- 分析器捕获路径（captureKeypoints 开启时的留存行为） ----

test("analyzer 捕获：ADDRESS 后开始收帧、等待期只保留 3s 滚动窗口；关闭时零留存", async () => {
  const { SwingAnalyzer } = await import("../js/swingAnalyzer.js");
  // 侧面站姿合成姿态：有前倾角(~18°)、腿长合法、手低于髋、可见度良好
  const pose = () => {
    const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    const set = (i, x, y) => { p[i] = { x, y, visibility: 0.9 }; };
    set(0, 0.40, 0.24); set(7, 0.41, 0.26); set(8, 0.41, 0.26);      // 头/耳
    set(11, 0.42, 0.30); set(12, 0.42, 0.30);                        // 肩
    set(13, 0.45, 0.45); set(14, 0.45, 0.45);                        // 肘
    set(15, 0.48, 0.62); set(16, 0.48, 0.62);                        // 腕（低于髋）
    set(23, 0.50, 0.55); set(24, 0.50, 0.55);                        // 髋
    set(25, 0.50, 0.72); set(26, 0.50, 0.72);                        // 膝
    set(27, 0.50, 0.90); set(28, 0.50, 0.90);                        // 踝
    return p;
  };

  const on = new SwingAnalyzer("side", "right", { captureKeypoints: true });
  for (let t = 0; t <= 5000; t += 66) on.update(pose(), t);
  assert.ok(on.baseline, "静止 600ms 后应锁定基准");
  assert.ok(on.kpBuffer.length > 0, "captureKeypoints 开启时应留存关键点");
  const span = on.kpBuffer[on.kpBuffer.length - 1].t - on.kpBuffer[0].t;
  assert.ok(span <= 3100, "等待期滚动窗口应≈3s，实际 " + span + "ms");
  assert.equal(on.kpBuffer[0].points.length, 33);
  assert.ok(on.tAddressLock > 0, "应记录 P1（基准锁定时刻）");

  const off = new SwingAnalyzer("side", "right");
  for (let t = 0; t <= 2000; t += 66) off.update(pose(), t);
  assert.ok(off.baseline, "默认构造行为不变：仍能锁定基准");
  assert.equal(off.kpBuffer.length, 0, "默认关闭：零留存");
});

test("strikeDetection 判定落入契约 annotations[] 且通过校验", () => {
  const sum = fakeSummary();
  sum.strikeDetection = { has_strike: true, method: "audio_transient" };
  const s = exportSession([sum]);
  assert.equal(validateSwingSession(s).valid, true);
  const ann = s.swings[0].annotations;
  assert.equal(ann.length, 1);
  assert.equal(ann[0].kind, "strike_detection");
  assert.equal(ann[0].payload.has_strike, true);
});
