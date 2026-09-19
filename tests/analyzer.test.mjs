// 挥杆状态机单元测试（合成关键点驱动，无需浏览器与真实视频）
//
// 覆盖的核心回归：一杆已经打完（过了顶点）之后，球手走出取景框或弯腰
// 摆下一颗球，不能把这一杆连同分析结果一起丢掉——这正是"让视频播完
// 反而识别不到挥杆、中途手动停止却能识别"的成因。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SwingAnalyzer, PHASE } from "../js/swingAnalyzer.js";
import { LM } from "../js/poseDetector.js";

/** 合成一帧 33 点关键点：画面坐标 y 向下，踝为锚点，躯干长 0.22 */
function makeLms({ handsY, hipY = 0.62, shoulderY = 0.4, ankleY = 0.95 }) {
  const p = (x, y) => ({ x, y, visibility: 1 });
  const l = Array.from({ length: 33 }, () => p(0.5, 0.5));
  l[LM.NOSE] = p(0.5, 0.3);
  l[LM.L_EAR] = p(0.47, 0.3); l[LM.R_EAR] = p(0.53, 0.3);
  l[LM.L_SHOULDER] = p(0.44, shoulderY); l[LM.R_SHOULDER] = p(0.56, shoulderY);
  l[LM.L_ELBOW] = p(0.43, (shoulderY + handsY) / 2);
  l[LM.R_ELBOW] = p(0.57, (shoulderY + handsY) / 2);
  l[LM.L_WRIST] = p(0.49, handsY); l[LM.R_WRIST] = p(0.51, handsY);
  l[LM.L_HIP] = p(0.46, hipY); l[LM.R_HIP] = p(0.54, hipY);
  l[LM.L_KNEE] = p(0.46, (hipY + ankleY) / 2); l[LM.R_KNEE] = p(0.54, (hipY + ankleY) / 2);
  l[LM.L_ANKLE] = p(0.46, ankleY); l[LM.R_ANKLE] = p(0.54, ankleY);
  return l;
}

/** 按 30fps 推进一串动作段；gone:true 表示该段完全检不到人 */
function drive(a, segs, t0 = 0) {
  let t = t0, summary = null;
  for (const s of segs) {
    const n = Math.max(1, Math.round(s.ms / 33));
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 1 : i / (n - 1);
      const lerp = (r) => r[0] + (r[1] - r[0]) * k;
      t += 33;
      const out = s.gone
        ? a.update(null, t)
        : a.update(makeLms({ handsY: lerp(s.handsY), hipY: s.hipY ? lerp(s.hipY) : 0.62 }), t);
      if (out.summary) summary = out.summary;
    }
  }
  return { t, summary };
}

/** 一次完整挥杆：准备静止锁基准 → 上杆 → 顶点 → 下杆 → 击球 → 送杆 */
const SWING = [
  { ms: 1000, handsY: [0.70, 0.70] },
  { ms: 600,  handsY: [0.70, 0.42] },
  { ms: 130,  handsY: [0.42, 0.46] },
  { ms: 300,  handsY: [0.46, 0.72] },
  { ms: 200,  handsY: [0.72, 0.72] },
  { ms: 300,  handsY: [0.72, 0.48] },
];

const fresh = () => new SwingAnalyzer("front", "right");
/** 循环中出报告、或片尾 finalize 收束，都算"识别到了这一杆" */
const swingOf = (a, ...runs) => runs.find(Boolean) || a.finalize();

test("完整挥杆后立即停止分析：出报告（基线行为）", () => {
  const a = fresh();
  const { summary } = drive(a, SWING);
  assert.equal(a.phase, PHASE.FOLLOW);
  const s = swingOf(a, summary);
  assert.ok(s, "打完就停应当能拿到报告");
  assert.ok(s.score > 0);
});

test("打完后球手走出取景框：这一杆不能丢", () => {
  const a = fresh();
  const r1 = drive(a, SWING);
  const r2 = drive(a, [{ ms: 2000, handsY: [0.48, 0.48], gone: true }], r1.t);
  assert.ok(swingOf(a, r1.summary, r2.summary), "人离开画面前已过顶点，应先收束出报告");
});

test("打完后弯腰摆下一颗球：这一杆不能丢", () => {
  const a = fresh();
  const r1 = drive(a, SWING);
  const r2 = drive(a, [
    { ms: 500,  handsY: [0.48, 0.60], hipY: [0.62, 0.50] },
    { ms: 1500, handsY: [0.60, 0.70], hipY: [0.50, 0.50] },
  ], r1.t);
  assert.ok(swingOf(a, r1.summary, r2.summary), "髋部大幅位移前已过顶点，应先收束出报告");
});

test("只有弯腰摆球、没有挥杆：仍然不出报告（防误判未退化）", () => {
  const a = fresh();
  const r = drive(a, [
    { ms: 1000, handsY: [0.70, 0.70] },
    { ms: 600,  handsY: [0.70, 0.78], hipY: [0.62, 0.50] }, // 弯腰，手下沉
    { ms: 600,  handsY: [0.78, 0.70], hipY: [0.50, 0.62] }, // 起身回位
  ]);
  assert.equal(swingOf(a, r.summary), null, "弯腰摆球不是挥杆");
});

test("幅度不足的 waggle 小动作：仍然不出报告（防误判未退化）", () => {
  const a = fresh();
  const r = drive(a, [
    { ms: 1000, handsY: [0.70, 0.70] },
    { ms: 300,  handsY: [0.70, 0.66] }, // 抬手 <0.45 躯干
    { ms: 300,  handsY: [0.66, 0.70] },
    { ms: 300,  handsY: [0.70, 0.66] },
    { ms: 300,  handsY: [0.66, 0.70] },
  ]);
  assert.equal(swingOf(a, r.summary), null, "waggle 幅度不足，应被闸门拦下");
});

test("连续两杆：第一杆出报告、nextSwing 之后第二杆照样出报告", () => {
  const a = fresh();
  const r1 = drive(a, SWING);
  assert.ok(swingOf(a, r1.summary), "第一杆应当出报告");
  // 用户盯着报告看了几秒（相机仍在跑），然后点「继续练习」
  const r15 = drive(a, [{ ms: 3000, handsY: [0.48, 0.70] }], r1.t);
  a.nextSwing();
  const r2 = drive(a, SWING, r15.t);
  assert.ok(swingOf(a, r2.summary), "第二杆不能被上一杆的残留状态吞掉");
});

// —— 单帧漏检容忍 ——
// 手机上下杆那 0.25 秒运动模糊最重，lite 模型经常连丢几帧。把单帧漏检当成
// "人离开画面"会两头出错：顶点前作废基准 → 整杆识别不到；顶点后立刻收束
// → 挥杆打到一半就弹出报告（用户实测："动作还没打完就给我打分了"）。

test("上杆中单帧漏检：基准不能作废，这一杆不能丢", () => {
  const a = fresh();
  const r1 = drive(a, SWING.slice(0, 2)); // 准备 → 上杆
  assert.equal(a.phase, PHASE.BACKSWING);
  const r2 = drive(a, [{ ms: 33, handsY: [0.42, 0.42], gone: true }], r1.t);
  assert.ok(a.baseline, "一帧漏检就作废基准 = 整段都识别不到挥杆");
  const r3 = drive(a, SWING.slice(2), r2.t);
  assert.ok(swingOf(a, r3.summary), "漏检帧之后这一杆应当照常走完并出报告");
});

test("顶点之后单帧漏检：不能当场收束（挥杆还没打完）", () => {
  const a = fresh();
  const r1 = drive(a, SWING.slice(0, 3)); // 准备 → 上杆 → 顶点
  const r2 = drive(a, [{ ms: 33, handsY: [0.46, 0.46], gone: true }], r1.t);
  assert.equal(r2.summary, null, "一帧看不到人就出报告 = 挥杆中途弹报告");
  assert.notEqual(a.phase, PHASE.FINISH);
  const r3 = drive(a, SWING.slice(3), r2.t);
  assert.ok(swingOf(a, r3.summary), "漏检帧之后这一杆应当照常走完并出报告");
});

test("单帧髋部跳变（裙装遮挡/运动模糊）：不能当场收束", () => {
  const a = fresh();
  const r1 = drive(a, SWING.slice(0, 3));
  const r2 = drive(a, [{ ms: 33, handsY: [0.46, 0.46], hipY: [0.15, 0.15] }], r1.t);
  assert.equal(r2.summary, null, "单帧髋部估计跳变不该当场出报告");
  assert.notEqual(a.phase, PHASE.FINISH);
  const r3 = drive(a, SWING.slice(3), r2.t);
  assert.ok(swingOf(a, r3.summary), "跳变帧之后这一杆应当照常走完并出报告");
});
