// 挥杆问题规则库 —— 基于 TPI (Titleist Performance Institute) 十二大挥杆特征
// (The Big 12 Swing Characteristics) 与 PGA 教学体系（准备姿势标准、
// 动力链顺序 Kinematic Sequence、球路法则 Ball Flight Laws）。
//
// 每条规则的结构：
//   tpi    — TPI 官方特征名（属于 Big 12 时标注）
//   live   — 挥杆过程中的实时短提示
//   why    — 对球路/身体的影响（PGA 球路法则视角）
//   causes — TPI 身体功能筛查中与该特征相关的常见受限项
//   drills — TPI / PGA 教学常用矫正练习
//
// 所有位移类阈值均以"躯干长度/肩宽"归一化，对身高和拍摄距离不敏感，可按需微调。
//
// 注：本应用与 PGA、TPI 无官方关联，规则为基于其公开教学体系的工程实现；
// 基于 2D 关键点的检测无法覆盖 Casting/Scooping（需要杆身追踪）与
// S-Posture（需要骨盆前倾角），这两项请结合教练目视判断。

export const SEVERITY = { WARN: "warn", BAD: "bad" };

export const RULES = {
  /* ================= 侧面拍摄 (Down-the-line) ================= */

  SPINE_TOO_UPRIGHT: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "站姿过于直立",
    tpi: "PGA Setup",
    live: "⚠️ 站姿太直，加大髋部前倾",
    why: "脊柱前倾角不足（<20°）会让挥杆平面过平、转肩空间不足，常见薄击与击球不扎实。",
    causes: "多为习惯问题；若刻意前倾仍做不到，TPI 体前屈测试（Toe Touch）受限提示髋铰链能力不足。",
    drills: [
      "髋铰链练习：球杆贴脊柱（后脑、上背、骶骨三点接触），从髋部向前折叠而不是弯腰",
      "PGA 标准准备姿势检查：手臂自然下垂握杆、臀部后坐、重心在脚掌中部",
    ],
  },

  SPINE_TOO_BENT: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "前倾角过大",
    tpi: "PGA Setup",
    live: "⚠️ 前倾过多，挺直一些",
    why: "前倾超过约 50°，重心压向脚尖，转动受阻，容易在挥杆中被迫起身代偿。",
    causes: "常与站位距球过近或杆身过短有关；先检查站位再调身体。",
    drills: [
      "对镜调整：从髋部前倾至手臂自然垂下即可，膝盖微屈，背部平直",
      "重心感知：准备姿势时脚趾应能在鞋内自由活动（重心未压向前脚掌）",
    ],
  },

  C_POSTURE: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "C 型姿势（圆肩驼背）",
    tpi: "TPI Big 12 · C-Posture",
    live: "⚠️ 圆肩驼背（C 型姿势）",
    why: "上背呈 C 形圆弧会直接限制胸椎旋转，使完整转肩变得不可能，常引发手臂代偿和挥杆幅度不足。",
    causes:
      "TPI 归因于\"上交叉综合征\"：胸肌/颈后肌群紧张 + 下斜方肌/深层颈屈肌无力。坐姿躯干旋转测试（Seated Trunk Rotation）常 <45°。",
    drills: [
      "泡沫轴胸椎伸展（Thoracic Extension on Roller）",
      "Reach, Roll & Lift：四点跪姿前伸-外旋-抬臂，激活下斜方肌",
      "准备姿势时做\"挺胸收下巴\"自查：肩胛微收、耳-肩-髋大致成线",
    ],
  },

  LOSS_OF_POSTURE: {
    view: "side",
    severity: SEVERITY.BAD,
    title: "失去脊柱角度（起身）",
    tpi: "TPI Big 12 · Loss of Posture",
    live: "🔴 起身了！保持脊柱角度",
    why: "挥杆中脊柱前倾角明显改变（>12°），击球低点失控，是薄击、剃头球和方向不稳的首要原因。",
    causes:
      "TPI 筛查常见关联：髋铰链能力不足（体前屈测试受限）、骨盆-躯干分离转动差（骨盆旋转测试）、核心与臀肌耐力不足（臀桥测试）。",
    drills: [
      "墙壁/椅背 Drill：臀部贴墙做空挥，全程不离开，体会\"边转边保持前倾\"",
      "球杆贴脊柱转肩：保持三点接触做上杆-下杆转动",
      "单腿平衡转肩（TPI 单腿平衡测试同款）：提升旋转中的稳定性",
    ],
  },

  EARLY_EXTENSION: {
    view: "side",
    severity: SEVERITY.BAD,
    title: "早伸（髋部前顶）",
    tpi: "TPI Big 12 · Early Extension",
    live: "🔴 髋部前顶（早伸）",
    why:
      "下杆时髋部向球的方向顶出，挤压挥杆空间，迫使杆身变陡或手部抬高代偿——TPI 统计中业余球员发生率最高的特征之一，典型后果是右曲球与杆跟/杆颈击球。",
    causes:
      "TPI 深蹲过头测试（Overhead Deep Squat）不达标是最强预测指标；常见受限：踝关节背屈不足、髋内旋受限、臀肌激活差。",
    drills: [
      "墙壁臀部 Drill：背对墙，下杆时右臀→左臀依次擦墙，髋是\"旋转\"不是\"前顶\"",
      "高脚杯深蹲（Goblet Squat）：改善深蹲模式与踝背屈",
      "90/90 髋内旋拉伸：解决髋内旋受限",
    ],
  },

  OVER_THE_TOP: {
    view: "side",
    severity: SEVERITY.BAD,
    title: "由外向内下杆（Over the Top）",
    tpi: "TPI Big 12 · Over-the-Top",
    live: "🔴 下杆轨迹由外向内",
    why:
      "下杆时手的路径明显高于/外于上杆路径。按 PGA 球路法则：外-内轨迹 + 开放杆面 = 右曲球（Slice），+ 关闭杆面 = 拉左——业余球员最常见的轨迹问题。",
    causes:
      "TPI 归因于动力链顺序错误：下杆由上半身（肩/手）启动而非骨盆。骨盆-躯干分离测试、坐姿躯干旋转测试受限时尤其高发。",
    drills: [
      "Pump Drill：下杆先做两次\"泵送\"到右髋前侧再击球，建立从内侧下杆的轨迹",
      "Step Drill：上杆到顶后左脚向目标方向先迈一小步再下杆，强迫下肢先启动（PGA 动力链顺序：骨盆→躯干→手臂→球杆）",
      "9 点-3 点半挥练习：杆头始终从球的内侧接近",
    ],
  },

  HEAD_DROP: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "头部上下起伏过大",
    tpi: "PGA 低点控制",
    live: "🟡 头部起伏过大",
    why: "垂直起伏过大说明重心上下波动，击球低点不稳定，厚击/薄击交替出现。",
    causes: "通常是起身或下蹲发力的伴随症状；TPI 并不要求\"头完全不动\"，关键是幅度可控、低点一致。",
    drills: [
      "保持膝屈幅度稳定做半挥，体会头部在\"玻璃罩\"内转动",
      "影子练习：让头部影子始终落在地面同一标记附近",
    ],
  },

  /* ================= 正面拍摄 (Face-on) ================= */

  HEAD_SWAY: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "头部左右移动过大",
    tpi: "PGA 旋转中心",
    live: "🟡 头部随身体平移过多",
    why: "上杆时头部明显平移说明身体在\"移\"而不是\"转\"，旋转中心丢失后击球低点随之漂移。",
    causes: "TPI 观点：允许头部少量随转动移动（教条式\"头别动\"反而限制转肩），但大幅平移通常是 Sway 的上半身表现。",
    drills: [
      "请同伴用杆头轻抵头侧做上杆，体会原地转肩",
      "对镜上杆：鼻尖横移不超过一个头宽",
    ],
  },

  HIP_SWAY: {
    view: "front",
    severity: SEVERITY.BAD,
    title: "髋部摇摆（Sway）",
    tpi: "TPI Big 12 · Sway",
    live: "🔴 髋部向后摇摆",
    why:
      "上杆时骨盆向远离目标方向平移而非旋转，重心被丢在后侧脚外侧，下杆动力链顺序被破坏，常连锁出 Hanging Back 或 Slide。",
    causes:
      "TPI 首要筛查项：后侧髋内旋受限（90/90 测试、骨盆旋转测试）；单腿平衡测试差也常见。",
    drills: [
      "后脚外侧抵墙/踩稳一个球做上杆，顶住不让髋外移，体会\"右髋向后旋转\"",
      "Hip Loading Drill：上杆时感受重量压入后侧髋关节内侧而不是脚外侧",
      "90/90 髋内旋活动度训练",
    ],
  },

  HIP_SLIDE: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "下杆髋部滑动过多（Slide）",
    tpi: "TPI Big 12 · Slide",
    live: "🟡 髋部滑动过多",
    why:
      "下杆时骨盆向目标方向平移过多而旋转不足，身体\"追不上\"手臂，杆面容易打开，典型球路是推右或为救球而翻腕的左曲。",
    causes:
      "TPI 筛查：前导髋内旋受限、前导腿臀肌力量不足（单腿臀桥测试）——蹬转无力时身体只能用平移代替旋转。",
    drills: [
      "Post-Up Drill：下杆蹬转后前导腿伸直\"立柱\"，感受左髋向后口袋方向转",
      "单腿臀桥强化前导侧臀肌",
      "正确比例：下杆是\"轻微压向目标 + 大量旋转\"",
    ],
  },

  REVERSE_SPINE: {
    view: "front",
    severity: SEVERITY.BAD,
    title: "逆向脊柱倾斜",
    tpi: "TPI Big 12 · Reverse Spine Angle",
    live: "🔴 上杆顶点上身倒向目标",
    why:
      "上杆顶点上半身向目标方向倾斜（应略微远离目标）。TPI 将其列为与下背痛相关性最高的挥杆特征，同时它几乎必然导致下杆\"上半身先动\"的乱序。",
    causes:
      "TPI 筛查：骨盆-躯干分离转动受限（转不动就用侧弯代偿）、核心前侧力量不足、髋内旋受限；S-Posture（骨盆前倾过大）会显著加重此问题。",
    drills: [
      "带右侧屈的转肩练习：上杆时感觉右侧腰侧微缩、胸口转向球的后方",
      "死虫（Dead Bug）/ 平板支撑：建立核心前侧支撑",
      "检查上杆：左肩转到下巴下方，而不是左肩\"抬\"向下巴",
    ],
  },

  HANGING_BACK: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "重心滞留后脚（Hanging Back）",
    tpi: "TPI Big 12 · Hanging Back",
    live: "🟡 重心没有转移到前脚",
    why:
      "击球瞬间重心仍留在后侧脚，低点落在球后，典型后果是厚击和高弱球；为救球常伴随挑球（Scooping）。",
    causes:
      "TPI 筛查：前导髋内旋受限（重心\"转不进\"前侧髋）、单腿平衡测试差、Sway 之后的连锁代偿。",
    drills: [
      "Step-Through Drill：击球后后脚顺势向目标方向上步走出，强迫重心通过",
      "前脚单脚击球练习：90% 重量放前脚打半挥",
      "节奏口令\"转-坐进左髋-伸\"，下杆从下肢开始",
    ],
  },

  FLAT_SHOULDER_PLANE: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "肩部转动平面过平",
    tpi: "TPI Big 12 · Flat Shoulder Plane",
    live: "🟡 转肩过平，左肩应转向下巴下方",
    why:
      "上杆顶点双肩连线过于水平（正常应随脊柱前倾呈明显倾斜，前导肩低于后肩），挥杆平面失真，下杆轨迹与杆面难以稳定，常与起身互为因果。",
    causes:
      "TPI 筛查：胸椎旋转/侧屈受限（坐姿躯干旋转测试）、上杆中丢失前倾角。",
    drills: [
      "双手抱杆横贴胸口，保持前倾做转肩：顶点时杆应指向球的方向（斜向下）",
      "Open Book 胸椎旋转活动度练习",
      "对镜检查顶点：前导肩在下巴正下方，而非平转到下巴旁边",
    ],
  },

  CHICKEN_WING: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "击球区前导臂弯曲（鸡翅膀）",
    tpi: "TPI Big 12 · Chicken Wing",
    live: "🟡 前导臂弯曲（鸡翅膀）",
    why:
      "击球前后前导肘弯曲外撇，损失杆头速度且杆面不稳，常见薄击与右曲。PGA 教学要点：击球后双臂应被身体旋转带动充分伸展。",
    causes:
      "TPI 观点：多数鸡翅膀是早伸/空间被挤压后的被动代偿，也与前导肩活动度、握杆过紧有关——先解决早伸往往鸡翅膀随之消失。",
    drills: [
      "腋下夹毛巾打半挥：送杆时毛巾不掉，体会身体带动手臂",
      "分手握杆（Split-Grip）挥杆：感受前导臂在击球区的伸展与转动",
      "前导手单手击球练习",
    ],
  },
};

export function severityWeight(s) {
  return s === SEVERITY.BAD ? 2 : 1;
}
