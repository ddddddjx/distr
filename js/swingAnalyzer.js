// 挥杆分析核心：
// 1. 状态机切分挥杆阶段：准备 → 上杆 → 顶点 → 下杆 → 击球 → 送杆 → 收杆
// 2. 在对应阶段运行 rules.js 中的检测规则，输出实时提示
// 3. 一次挥杆结束后生成总结报告（连续评分制）
//
// 坐标系说明（镜头运动补偿）：
// 所有位置都转换为"以双脚踝中点为原点、以躯干长度为单位"的归一化坐标。
// 挥杆过程中双脚是钉在地上的，因此镜头的平移、跟拍、变焦都不会改变
// 归一化坐标——电视转播类素材的位移误报由此消除。
// 角度类指标（脊柱角、肩线倾角、肘角）本身与平移/缩放无关。
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
    this.baseline = null;       // 准备姿势基准（归一化坐标均值）
    this.addressFrames = [];    // 静止采样缓冲
    this.useAnkleAnchor = null; // 脚踝是否可见（决定是否启用镜头运动补偿）
    this.lastHandsY = null;
    this.handsVelY = 0;         // 归一化单位/帧
    this.topReachedAt = 0;
    this.finishStillSince = 0;
    this.targetDir = 0;         // +1 / -1：目标方向（由上杆方向反推，免疫镜像）
    this.maxRise = 0;           // 本次动作中手的最大上抬幅度（躯干单位），用于过滤小动作
    this.maxHipDev = 0;         // 本次动作中髋部相对基准的最大垂直偏移：
                                // 挥杆时双脚钉地髋部高度几乎不变，弯腰摆球/起身/走动则大幅变化
    this.tBackswing = 0;        // 节奏计时：上杆开始 / 击球时刻
    this.tImpact = 0;
    this.bsPath = [];           // 上杆手部路径（OTT 判定用）
    this.ottCount = 0;
    this.faultsThisSwing = new Map(); // ruleKey -> { ratio, phase }
    this.liveFaults = [];
    this.summary = null;
  }

  get leadSide() {
    // 右手球员前导侧为左臂/左髋
    return this.handedness === "right"
      ? { wrist: LM.L_WRIST, elbow: LM.L_ELBOW, shoulder: LM.L_SHOULDER }
      : { wrist: LM.R_WRIST, elbow: LM.R_ELBOW, shoulder: LM.R_SHOULDER };
  }

  /**
   * 把一帧关键点转换为归一化坐标系（原点=脚踝中点，单位=躯干长度）。
   * 脚踝不可见时退化为画面绝对坐标（仅缩放归一化）。
   */
  _normalize(lms) {
    const sh = mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]);
    const hp = mid(lms[LM.L_HIP], lms[LM.R_HIP]);
    const torso = dist(sh, hp);
    if (torso < 1e-4) return null;
    if (this.useAnkleAnchor === null) {
      // 在首帧锁定参考系模式，整次挥杆保持一致
      const vis =
        ((lms[LM.L_ANKLE].visibility ?? 1) + (lms[LM.R_ANKLE].visibility ?? 1)) / 2;
      this.useAnkleAnchor = vis > 0.5;
    }
    const anchor = this.useAnkleAnchor
      ? mid(lms[LM.L_ANKLE], lms[LM.R_ANKLE])
      : { x: 0, y: 0 };
    const n = (p) => ({ x: (p.x - anchor.x) / torso, y: (p.y - anchor.y) / torso });
    return {
      hands: n(mid(lms[LM.L_WRIST], lms[LM.R_WRIST])),
      hip: n(hp),
      shoulder: n(sh),
      head: n(lms[LM.NOSE]),
      shoulderW: dist(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]) / torso,
      spine: spineAngleFromVertical(lms),
      lean: spineLeanSigned(lms),
      torso, // 当前帧躯干投影长度（画面单位），供稳定性判定换算回原始尺度
    };
  }

  /**
   * 髋部相对基准的位移，以【基准】躯干长度为单位。
   * 注意不能直接用归一化坐标相减：挥杆转体时躯干 2D 投影会缩短 20-30%，
   * 会让按当前帧归一化的数值虚假膨胀，把真实挥杆误判成起身/走动。
   */
  _hipDevFrom(f) {
    const b = this.baseline;
    return {
      dx: Math.abs(f.hip.x * f.torso - b.hip.x * b.torso) / b.torso,
      dy: Math.abs(f.hip.y * f.torso - b.hip.y * b.torso) / b.torso,
    };
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

    const f = this._normalize(lms);
    if (!f) return this._out();

    if (this.lastHandsY !== null) this.handsVelY = f.hands.y - this.lastHandsY;
    this.lastHandsY = f.hands.y;
    // 记录本次动作的最大上抬幅度（收束时用于过滤准备中的小动作）
    if (this.baseline && this.phase !== PHASE.IDLE && this.phase !== PHASE.ADDRESS) {
      this.maxRise = Math.max(this.maxRise, this.baseline.hands.y - f.hands.y);
      // 髋部稳定性闸门：髋部大幅升降 = 弯腰/起身/走动，不是挥杆
      const hipDev = this._hipDevFrom(f).dy;
      this.maxHipDev = Math.max(this.maxHipDev, hipDev);
      if (hipDev > 0.5) {
        this._reacquire();
        return this._out();
      }
    }

    switch (this.phase) {
      case PHASE.IDLE:
        this._detectAddress(f, tMs);
        break;
      case PHASE.ADDRESS:
        this._collectBaseline(lms, f, tMs);
        break;
      case PHASE.BACKSWING:
        this._checkBackswing(lms, f);
        // 手回升（y 增大）且已明显高于基准 → 到达顶点
        if (f.hands.y < this.baseline.hands.y - 0.35 && this.handsVelY > 0.008) {
          this.phase = PHASE.TOP;
          this.topReachedAt = tMs;
          this._checkTop(lms, f);
        } else if (f.hands.y > this.baseline.hands.y - 0.05) {
          // 上杆中途收回（准备小动作/取消试挥）→ 静默回到准备状态
          this._abortSwing();
        }
        break;
      case PHASE.TOP:
        this._checkTop(lms, f);
        if (tMs - this.topReachedAt > 80 || this.handsVelY > 0.016) {
          this.phase = PHASE.DOWNSWING;
        }
        break;
      case PHASE.DOWNSWING:
        this._checkDownswing(lms, f);
        // 手回到基准高度附近 → 击球区
        if (f.hands.y > this.baseline.hands.y - 0.15) {
          this.phase = PHASE.IMPACT;
          this.tImpact = tMs;
          this._checkImpact(lms, f);
        }
        break;
      case PHASE.IMPACT:
        this._checkImpact(lms, f);
        if (f.hands.y < this.baseline.hands.y - 0.25) {
          this.phase = PHASE.FOLLOW;
        }
        break;
      case PHASE.FOLLOW: {
        // 手高过肩且基本静止 → 收杆
        const still = Math.abs(this.handsVelY) < 0.012;
        if (f.hands.y < f.shoulder.y && still) {
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

  _detectAddress(f, tMs) {
    // 手在髋部以下且整体静止 → 认为进入准备姿势
    if (f.hands.y > f.hip.y && Math.abs(this.handsVelY) < 0.016) {
      this.phase = PHASE.ADDRESS;
      this.addressFrames = [];
      this.addressStart = tMs;
    }
  }

  _collectBaseline(lms, f, tMs) {
    if (this.baseline) {
      // 球员离开准备位（走动/弯腰摆球/大幅调整站位）→ 旧基准作废，重新采集
      const dev = this._hipDevFrom(f);
      if (dev.dy > 0.35 || dev.dx > 0.6) {
        this._reacquire();
        return;
      }
      // 基准已锁定：手明显抬高且带有明确向上速度才算上杆——
      // 压杆、举杆检查、waggle 等准备小动作（幅度通常 <0.15）不触发
      if (
        f.hands.y < this.baseline.hands.y - 0.15 &&
        this.handsVelY < -0.008
      ) {
        this._beginBackswing(f, tMs);
      }
      return;
    }
    if (Math.abs(this.handsVelY) > 0.024) {
      // 基准尚未锁定时移动 → 重新等待静止
      this.phase = PHASE.IDLE;
      return;
    }
    this.addressFrames.push(f);
    // 静止约 600ms（≥12 帧）后锁定基准并做准备姿势检查
    if (this.addressFrames.length >= 12 && !this.baseline) {
      const fs = this.addressFrames;
      const avgP = (k) => ({
        x: fs.reduce((s, x) => s + x[k].x, 0) / fs.length,
        y: fs.reduce((s, x) => s + x[k].y, 0) / fs.length,
      });
      const avg = (k) => fs.reduce((s, x) => s + x[k], 0) / fs.length;
      this.baseline = {
        hands: avgP("hands"), hip: avgP("hip"),
        shoulder: avgP("shoulder"), head: avgP("head"),
        shoulderW: avg("shoulderW"),
        spine: avg("spine"), lean: avg("lean"),
        torso: avg("torso"),
        // 侧面视角：球的方向 = 准备姿势时手相对髋的方向（用于 OTT 判定）
        ballDir: Math.sign(avgP("hands").x - avgP("hip").x) || 1,
      };
      // 站姿合理性校验：髋-踝距离（腿长）明显小于躯干 = 蹲姿/坐姿
      // （弯腰摆球时的短暂静止），不是击球准备姿势。
      // 阈值取 0.85：兼容手机俯拍等透视压缩腿长的常见机位
      if (this.useAnkleAnchor && Math.abs(this.baseline.hip.y) < 0.85) {
        this.baseline = null;
        this.addressFrames = [];
        this.phase = PHASE.IDLE;
        return;
      }
      this._checkAddress(lms);
    }
  }

  _beginBackswing(f, tMs) {
    this.phase = PHASE.BACKSWING;
    this.tBackswing = tMs;
    // 上杆时手远离目标 → 反推目标方向（与镜像、左右手均无关）
    this.targetDir = f.hands.x > this.baseline.hands.x ? -1 : 1;
    // 侧面视角记录上杆手部路径，下杆时对比判定 Over-the-Top
    this.bsPath = [];
    this.ottCount = 0;
  }

  /* ---------- 各阶段规则检查 ---------- */

  /**
   * 记录一次问题触发。
   * @param {string} key 规则键
   * @param {number} ratio 偏差程度：1.0 = 刚到阈值，2.0 = 超出一倍，用于连续评分
   */
  _record(key, ratio = 1.2) {
    const prev = this.faultsThisSwing.get(key);
    if (!prev || ratio > prev.ratio) {
      this.faultsThisSwing.set(key, { ratio, phase: this.phase });
    }
    this.liveFaults.push(key);
  }

  _checkAddress(lms) {
    if (this.view !== "side") return;
    const spine = this.baseline.spine;
    if (spine < 20) this._record("SPINE_TOO_UPRIGHT", 1 + (20 - spine) / 15);
    else if (spine > 50) this._record("SPINE_TOO_BENT", 1 + (spine - 50) / 15);
    // TPI C-Posture：颈部（耳-肩连线）相对脊柱明显前探 → 圆肩驼背
    const ear = mid(lms[LM.L_EAR], lms[LM.R_EAR]);
    const sh = mid(lms[LM.L_SHOULDER], lms[LM.R_SHOULDER]);
    const neckAng =
      (Math.atan2(Math.abs(ear.x - sh.x), Math.abs(ear.y - sh.y)) * 180) / Math.PI;
    if (neckAng - spine > 25) this._record("C_POSTURE", (neckAng - spine) / 25);
  }

  _checkBackswing(lms, f) {
    const b = this.baseline;
    if (this.view === "side") {
      this._checkPosture(lms, f);
      this.bsPath.push({ x: f.hands.x, y: f.hands.y });
    } else {
      const headDx = Math.abs(f.head.x - b.head.x);
      const headLimit = 0.55 * b.shoulderW;
      if (headDx > headLimit) this._record("HEAD_SWAY", headDx / headLimit);
      // 髋部向"远离目标"方向平移过多 = 摇摆
      const sway = (f.hip.x - b.hip.x) * -this.targetDir;
      const swayLimit = 0.42 * b.shoulderW;
      if (sway > swayLimit) this._record("HIP_SWAY", sway / swayLimit);
    }
  }

  _checkTop(lms, f) {
    if (this.view !== "front") return;
    // 顶点时上身应略微远离目标；倒向目标 = 逆向脊柱倾斜
    const lean = (f.lean - this.baseline.lean) * this.targetDir;
    if (lean > 8) this._record("REVERSE_SPINE", lean / 8);
    // TPI Flat Shoulder Plane：顶点双肩连线应明显倾斜（前导肩低于后肩）
    const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
    const tilt =
      (Math.atan2(Math.abs(ls.y - rs.y), Math.abs(ls.x - rs.x) || 1e-6) * 180) / Math.PI;
    if (tilt < 10) this._record("FLAT_SHOULDER_PLANE", 1 + (10 - tilt) / 10);
  }

  _checkDownswing(lms, f) {
    const b = this.baseline;
    if (this.view === "side") {
      this._checkPosture(lms, f);
      // 早伸：髋部沿水平方向顶出
      const hipDx = Math.abs(f.hip.x - b.hip.x);
      if (hipDx > 0.26) this._record("EARLY_EXTENSION", hipDx / 0.26);
      // TPI Over-the-Top：同一高度上，下杆手部路径比上杆明显更靠球一侧
      if (this.bsPath.length > 4) {
        let nearest = null, best = Infinity;
        for (const p of this.bsPath) {
          const dy = Math.abs(p.y - f.hands.y);
          if (dy < best) { best = dy; nearest = p; }
        }
        if (nearest && best < 0.3) {
          const out = (f.hands.x - nearest.x) * b.ballDir;
          if (out > 0.15) {
            // 连续多帧偏外才判定，避免单帧抖动误报
            if (++this.ottCount >= 4) this._record("OVER_THE_TOP", out / 0.15);
          }
        }
      }
    } else {
      // 滑动：髋部向目标方向平移过多
      const slide = (f.hip.x - b.hip.x) * this.targetDir;
      const slideLimit = 0.75 * b.shoulderW;
      if (slide > slideLimit) this._record("HIP_SLIDE", slide / slideLimit);
    }
  }

  _checkImpact(lms, f) {
    if (this.view !== "front") return;
    const s = this.leadSide;
    const elbow = angleAt(lms[s.shoulder], lms[s.elbow], lms[s.wrist]);
    if (elbow < 140) this._record("CHICKEN_WING", 1 + (140 - elbow) / 25);
    // TPI Hanging Back：击球时骨盆几乎没有向目标方向移动（重心滞留后脚）
    const b = this.baseline;
    const shift = (f.hip.x - b.hip.x) * this.targetDir;
    const minShift = 0.02 * b.shoulderW;
    if (shift < minShift)
      this._record("HANGING_BACK", 1 + (minShift - shift) / (0.15 * b.shoulderW));
  }

  /** 侧面通用：起身 / 头部起伏（上杆和下杆都检查） */
  _checkPosture(lms, f) {
    const b = this.baseline;
    const dSpine = Math.abs(f.spine - b.spine);
    if (dSpine > 13) this._record("LOSS_OF_POSTURE", dSpine / 13);
    const headDy = Math.abs(f.head.y - b.head.y);
    if (headDy > 0.22) this._record("HEAD_DROP", headDy / 0.22);
  }

  /* ---------- 收杆 → 生成报告 ---------- */

  /** 判定为无效动作（幅度不足的准备小动作）：静默回到准备状态，不出报告 */
  _abortSwing() {
    this.phase = PHASE.ADDRESS;
    this.faultsThisSwing.clear();
    this.bsPath = [];
    this.ottCount = 0;
    this.finishStillSince = 0;
    this.maxRise = 0;
    this.maxHipDev = 0;
    this.tBackswing = 0;
    this.tImpact = 0;
  }

  /** 球员离开准备位（走动/弯腰摆球）：连基准一起作废，重新等待就位 */
  _reacquire() {
    this._abortSwing();
    this.baseline = null;
    this.addressFrames = [];
    this.phase = PHASE.IDLE;
  }

  _finishSwing() {
    // 最终校验（双闸门）：
    // 1. 真实挥杆（哪怕半挥）手的最大上抬幅度 ≥0.45 躯干单位，
    //    举杆检查、waggle 等小动作达不到；
    // 2. 挥杆全程髋部高度基本不变（≤0.35 躯干），弯腰摆球/起身必超
    if (this.maxRise < 0.45 || this.maxHipDev > 0.35) {
      this._abortSwing();
      return;
    }
    this.phase = PHASE.FINISH;
    const faults = [...this.faultsThisSwing.entries()]
      .map(([key, v]) => ({ key, rule: RULES[key], ...v }))
      .filter((f) => f.rule)
      .sort(
        (a, b) =>
          (b.rule.severity === SEVERITY.BAD) - (a.rule.severity === SEVERITY.BAD) ||
          b.ratio - a.ratio
      );
    // 连续评分：扣分随偏差程度线性增长。
    // ratio=1.0（刚擦线）→ 严重 -8 / 轻微 -4；ratio≥1.6（超出 60%）→ 严重 -20 / 轻微 -10
    const deduction = (f) => {
      const bad = f.rule.severity === SEVERITY.BAD;
      const min = bad ? 8 : 4;
      const max = bad ? 20 : 10;
      const t = Math.min(1, Math.max(0, (f.ratio - 1) / 0.6));
      return Math.round(min + (max - min) * t);
    };
    const score = Math.max(40, 100 - faults.reduce((s, f) => s + deduction(f), 0));
    // 节奏（Tempo）：上杆时长 : 下杆时长，职业球员稳定在 3:1 附近
    let tempo = null;
    if (this.tBackswing && this.topReachedAt && this.tImpact) {
      const back = this.topReachedAt - this.tBackswing;
      const down = this.tImpact - this.topReachedAt;
      if (back > 100 && down > 50) tempo = { back, down, ratio: back / down };
    }
    this.summary = { score, faults, view: this.view, tempo };
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
