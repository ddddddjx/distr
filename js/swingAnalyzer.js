// 挥杆分析核心：
// 1. 状态机切分挥杆阶段：准备 → 上杆 → 顶点 → 下杆 → 击球 → 送杆 → 收杆
// 2. 在对应阶段运行 rules.js 中的检测规则，输出实时提示
// 3. 一次挥杆结束后生成总结报告
import { LM } from "./poseDetector.js";
import { RULES, SEVERITY } from "./rules.js";

export const PHASE = {
  IDLE: "idle",          // 等待入镜
  ADDRESS: "address",    // 准备姿势（采集基准）
  BACKSWING: "backswing",
  TOP: "top",
  DOWNSWING: "downswing",
  IMPACT: "impact",
  FOLLOW: "follow",
  FINISH: "finish",
};

export const PHASE_LABEL = {
  [PHASE.IDLE]: "请站好位置",
  [PHASE.ADDRESS]: "准备姿势",
  [PHASE.BACKSWING]: "上杆中",
  [PHASE.TOP]: "上杆顶点",
  [PHASE.DOWNSWING]: "下杆中",
  [PHASE.IMPACT]: "击球",
  [PHASE.FOLLOW]: "送杆",
  [PHASE.FINISH]: "收杆完成",
};

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 三点夹角（b 为顶点），单位：度 */
function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (m === 0) return 180;
  return (Math.acos(Math.min(1, Math.max(-1, dot / m))) * 180) / Math.PI;
}

/** 肩中点-髋中点连线与竖直方向的夹角（脊柱前倾角的二维近似），单位：度 */
function spineAngleFromVertical(lms) {
  const sh = mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]);
  const hp = mid(lms[LM.L_HIP], lms[LM.R_HIP]);
  return (Math.atan2(Math.abs(sh.x - hp.x), Math.abs(sh.y - hp.y)) * 180) / Math.PI;
}

/** 脊柱侧倾的带符号角度（正面视角用），正值 = 肩中点在髋中点的 +x 侧 */
function spineLeanSigned(lms) {
  const sh = mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]);
  const hp = mid(lms[LM.L_HIP], lms[LM.R_HIP]);
  return (Math.atan2(sh.x - hp.x, Math.abs(sh.y - hp.y) || 1e-6) * 180) / Math.PI;
}

export class SwingAnalyzer {
  /**
   * @param {"front"|"side"} view 拍摄角度
   * @param {"right"|"left"} handedness 球员持杆习惯
   */
  constructor(view = "front", handedness = "right") {
    this.view = view;
    this.handedness = handedness;
    this.reset();
  }

  reset() {
    this.phase = PHASE.IDLE;
    this.baseline = null;       // 准备姿势基准（关键点均值）
    this.addressFrames = [];    // 静止采样缓冲
    this.lastWristY = null;
    this.wristVelY = 0;
    this.topReachedAt = 0;
    this.finishStillSince = 0;
    this.targetDir = 0;         // +1 / -1：目标方向（由上杆方向反推，免疫镜像）
    this.faultsThisSwing = new Map(); // ruleKey -> { worst, phase }
    this.liveFaults = [];
    this.summary = null;
  }

  get leadSide() {
    // 右手球员前导侧为左臂/左髋
    return this.handedness === "right"
      ? { wrist: LM.L_WRIST, elbow: LM.L_ELBOW, shoulder: LM.L_SHOULDER }
      : { wrist: LM.R_WRIST, elbow: LM.R_ELBOW, shoulder: LM.R_SHOULDER };
  }

  /** 每帧调用。返回 { phase, liveFaults, summary }，summary 仅在收杆后出现一次 */
  update(lms, tMs) {
    this.liveFaults = [];
    this.summary = null;
    if (!lms) {
      if (this.phase !== PHASE.IDLE && this.phase !== PHASE.ADDRESS) {
        // 人离开画面，放弃本次跟踪
        this.reset();
      }
      return this._out();
    }

    // 双手中点（握杆位置近似），y 越小越高
    const hands = mid(lms[LM.L_WRIST], lms[LM.R_WRIST]);
    const torso = dist(
      mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]),
      mid(lms[LM.L_HIP], lms[LM.R_HIP])
    );
    if (torso < 1e-4) return this._out();

    if (this.lastWristY !== null) this.wristVelY = hands.y - this.lastWristY;
    this.lastWristY = hands.y;

    switch (this.phase) {
      case PHASE.IDLE:
        this._detectAddress(lms, hands, torso, tMs);
        break;
      case PHASE.ADDRESS:
        this._collectBaseline(lms, hands, torso, tMs);
        break;
      case PHASE.BACKSWING:
        this._checkBackswing(lms, torso, hands);
        // 手回升（y 增大）且已明显高于基准 → 到达顶点
        if (
          hands.y < this.baseline.handsY - 0.35 * torso &&
          this.wristVelY > 0.002
        ) {
          this.phase = PHASE.TOP;
          this.topReachedAt = tMs;
          this._checkTop(lms, torso);
        } else if (hands.y > this.baseline.handsY - 0.05 * torso) {
          // 上杆中途收回（取消试挥）→ 回到准备状态，保留基准
          this.phase = PHASE.ADDRESS;
          this.faultsThisSwing.clear();
        }
        break;
      case PHASE.TOP:
        this._checkTop(lms, torso);
        if (tMs - this.topReachedAt > 80 || this.wristVelY > 0.004) {
          this.phase = PHASE.DOWNSWING;
        }
        break;
      case PHASE.DOWNSWING:
        this._checkDownswing(lms, torso, hands);
        // 手回到基准高度附近 → 击球区
        if (hands.y > this.baseline.handsY - 0.15 * torso) {
          this.phase = PHASE.IMPACT;
          this._checkImpact(lms, torso);
        }
        break;
      case PHASE.IMPACT:
        this._checkImpact(lms, torso);
        if (hands.y < this.baseline.handsY - 0.25 * torso) {
          this.phase = PHASE.FOLLOW;
        }
        break;
      case PHASE.FOLLOW: {
        // 手高过肩且基本静止 → 收杆
        const shoulderY = mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]).y;
        const still = Math.abs(this.wristVelY) < 0.003;
        if (hands.y < shoulderY && still) {
          if (!this.finishStillSince) this.finishStillSince = tMs;
          if (tMs - this.finishStillSince > 400) this._finishSwing();
        } else {
          this.finishStillSince = 0;
        }
        // 超时兜底（收杆动作不标准时也要出报告）
        if (tMs - this.topReachedAt > 4000) this._finishSwing();
        break;
      }
      case PHASE.FINISH:
        break;
    }
    return this._out();
  }

  _out() {
    return { phase: this.phase, liveFaults: this.liveFaults, summary: this.summary };
  }

  /* ---------- 阶段：等待 / 准备 ---------- */

  _detectAddress(lms, hands, torso, tMs) {
    // 手在髋部以下且整体静止 → 认为进入准备姿势
    const hipY = mid(lms[LM.L_HIP], lms[LM.R_HIP]).y;
    if (hands.y > hipY && Math.abs(this.wristVelY) < 0.004) {
      this.phase = PHASE.ADDRESS;
      this.addressFrames = [];
      this.addressStart = tMs;
    }
  }

  _collectBaseline(lms, hands, torso, tMs) {
    if (this.baseline) {
      // 基准已锁定：手明显抬高即进入上杆，小幅晃动则继续保持准备状态
      if (hands.y < this.baseline.handsY - 0.08 * torso) this._beginBackswing(hands);
      return;
    }
    if (Math.abs(this.wristVelY) > 0.006) {
      // 基准尚未锁定时移动 → 重新等待静止
      this.phase = PHASE.IDLE;
      return;
    }
    this.addressFrames.push({
      handsY: hands.y,
      handsX: hands.x,
      hipX: mid(lms[LM.L_HIP], lms[LM.R_HIP]).x,
      hipY: mid(lms[LM.L_HIP], lms[LM.R_HIP]).y,
      headX: lms[LM.NOSE].x,
      headY: lms[LM.NOSE].y,
      spine: spineAngleFromVertical(lms),
      lean: spineLeanSigned(lms),
      shoulderW: dist(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]),
      torso,
    });
    // 静止约 600ms（≥12 帧）后锁定基准并做准备姿势检查
    if (this.addressFrames.length >= 12 && !this.baseline) {
      const avg = (k) =>
        this.addressFrames.reduce((s, f) => s + f[k], 0) / this.addressFrames.length;
      this.baseline = {
        handsY: avg("handsY"), handsX: avg("handsX"),
        hipX: avg("hipX"), hipY: avg("hipY"),
        headX: avg("headX"), headY: avg("headY"),
        spine: avg("spine"), lean: avg("lean"),
        shoulderW: avg("shoulderW"), torso: avg("torso"),
        // 侧面视角：球的方向 = 准备姿势时手相对髋的方向（用于 OTT 判定）
        ballDir: Math.sign(avg("handsX") - avg("hipX")) || 1,
      };
      this._checkAddress(lms);
    }
  }

  _beginBackswing(hands) {
    this.phase = PHASE.BACKSWING;
    // 上杆时手远离目标 → 反推目标方向（与镜像、左右手均无关）
    this.targetDir = hands.x > this.baseline.handsX ? -1 : 1;
    // 侧面视角记录上杆手部路径，下杆时对比判定 Over-the-Top
    this.bsPath = [];
    this.ottCount = 0;
  }

  /* ---------- 各阶段规则检查 ---------- */

  _record(key, value = 1) {
    const prev = this.faultsThisSwing.get(key);
    if (!prev || value > prev.worst) {
      this.faultsThisSwing.set(key, { worst: value, phase: this.phase });
    }
    this.liveFaults.push(key);
  }

  _checkAddress(lms) {
    if (this.view !== "side") return;
    if (this.baseline.spine < 20) this._record("SPINE_TOO_UPRIGHT");
    else if (this.baseline.spine > 50) this._record("SPINE_TOO_BENT");
    // TPI C-Posture：颈部（耳-肩连线）相对脊柱明显前探 → 圆肩驼背
    if (lms) {
      const ear = mid(lms[LM.L_EAR], lms[LM.R_EAR]);
      const sh = mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]);
      const neckAng =
        (Math.atan2(Math.abs(ear.x - sh.x), Math.abs(ear.y - sh.y)) * 180) / Math.PI;
      if (neckAng - this.baseline.spine > 25)
        this._record("C_POSTURE", neckAng - this.baseline.spine);
    }
  }

  _checkBackswing(lms, torso, hands) {
    const b = this.baseline;
    if (this.view === "side") {
      this._checkPosture(lms, torso);
      if (hands) this.bsPath.push({ x: hands.x, y: hands.y });
    } else {
      const headDx = Math.abs(lms[LM.NOSE].x - b.headX);
      if (headDx > 0.45 * b.shoulderW) this._record("HEAD_SWAY", headDx);
      // 髋部向"远离目标"方向平移过多 = 摇摆
      const hipX = mid(lms[LM.L_HIP], lms[LM.R_HIP]).x;
      const sway = (hipX - b.hipX) * -this.targetDir;
      if (sway > 0.35 * b.shoulderW) this._record("HIP_SWAY", sway);
    }
  }

  _checkTop(lms, torso) {
    if (this.view !== "front") return;
    // 顶点时上身应略微远离目标；倒向目标 = 逆向脊柱倾斜
    const lean = spineLeanSigned(lms) - this.baseline.lean;
    if (lean * this.targetDir > 6) this._record("REVERSE_SPINE", lean * this.targetDir);
    // TPI Flat Shoulder Plane：顶点双肩连线应明显倾斜（前导肩低于后肩）
    const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
    const tilt =
      (Math.atan2(Math.abs(ls.y - rs.y), Math.abs(ls.x - rs.x) || 1e-6) * 180) / Math.PI;
    if (tilt < 12) this._record("FLAT_SHOULDER_PLANE", 12 - tilt);
  }

  _checkDownswing(lms, torso, hands) {
    const b = this.baseline;
    if (this.view === "side") {
      this._checkPosture(lms, torso);
      // 早伸：髋部沿水平方向顶出（侧面视角下任一水平方向位移过大）
      const hipDx = Math.abs(mid(lms[LM.L_HIP], lms[LM.R_HIP]).x - b.hipX);
      if (hipDx > 0.22 * b.torso) this._record("EARLY_EXTENSION", hipDx);
      // TPI Over-the-Top：同一高度上，下杆手部路径比上杆明显更靠球一侧
      if (hands && this.bsPath.length > 4) {
        let nearest = null, best = Infinity;
        for (const p of this.bsPath) {
          const dy = Math.abs(p.y - hands.y);
          if (dy < best) { best = dy; nearest = p; }
        }
        if (nearest && best < 0.08) {
          const out = (hands.x - nearest.x) * b.ballDir;
          if (out > 0.12 * b.torso) {
            // 连续多帧偏外才判定，避免单帧抖动误报
            if (++this.ottCount >= 3) this._record("OVER_THE_TOP", out);
          }
        }
      }
    } else {
      // 滑动：髋部向目标方向平移过多
      const hipX = mid(lms[LM.L_HIP], lms[LM.R_HIP]).x;
      const slide = (hipX - b.hipX) * this.targetDir;
      if (slide > 0.6 * b.shoulderW) this._record("HIP_SLIDE", slide);
    }
  }

  _checkImpact(lms) {
    if (this.view !== "front") return;
    const s = this.leadSide;
    const elbow = angleAt(lms[s.shoulder], lms[s.elbow], lms[s.wrist]);
    if (elbow < 145) this._record("CHICKEN_WING", 180 - elbow);
    // TPI Hanging Back：击球时骨盆几乎没有向目标方向移动（重心滞留后脚）
    const b = this.baseline;
    const shift =
      (mid(lms[LM.L_HIP], lms[LM.R_HIP]).x - b.hipX) * this.targetDir;
    if (shift < 0.05 * b.shoulderW) this._record("HANGING_BACK", 0.05 * b.shoulderW - shift);
  }

  /** 侧面通用：起身 / 头部起伏（上杆和下杆都检查） */
  _checkPosture(lms, torso) {
    const b = this.baseline;
    const dSpine = Math.abs(spineAngleFromVertical(lms) - b.spine);
    if (dSpine > 12) this._record("LOSS_OF_POSTURE", dSpine);
    const headDy = Math.abs(lms[LM.NOSE].y - b.headY);
    if (headDy > 0.18 * b.torso) this._record("HEAD_DROP", headDy);
  }

  /* ---------- 收杆 → 生成报告 ---------- */

  _finishSwing() {
    this.phase = PHASE.FINISH;
    const faults = [...this.faultsThisSwing.entries()]
      .map(([key, v]) => ({ key, rule: RULES[key], ...v }))
      .filter((f) => f.rule)
      .sort((a, b) =>
        (b.rule.severity === SEVERITY.BAD) - (a.rule.severity === SEVERITY.BAD)
      );
    // 简单评分：满分 100，严重问题 -20，轻微问题 -10
    const score = Math.max(
      40,
      100 - faults.reduce((s, f) => s + (f.rule.severity === SEVERITY.BAD ? 20 : 10), 0)
    );
    this.summary = { score, faults, view: this.view };
  }

  /** 视频播放结束等场景下强制结束本次挥杆：已进入挥杆阶段则直接生成报告 */
  finalize() {
    const swinging = ![PHASE.IDLE, PHASE.ADDRESS, PHASE.FINISH].includes(this.phase);
    if (this.baseline && swinging) {
      this._finishSwing();
      return this.summary;
    }
    return null;
  }

  /** 收杆报告确认后调用，准备分析下一次挥杆 */
  nextSwing() {
    const { view, handedness } = this;
    this.reset();
    this.view = view;
    this.handedness = handedness;
  }
}
