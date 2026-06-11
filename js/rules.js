// 挥杆问题规则库：每条规则包含触发阈值、实时提示语和详细改进建议。
// 所有位移类阈值均以"躯干长度"(肩中点到髋中点) 为单位做了归一化，
// 因此对不同身高、不同拍摄距离都基本适用。可按教学需求微调。

export const SEVERITY = { WARN: "warn", BAD: "bad" };

export const RULES = {
  /* ================= 侧面拍摄 (Down-the-line) ================= */
  SPINE_TOO_UPRIGHT: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "站姿过于直立",
    live: "⚠️ 站姿太直，加大前倾",
    advice:
      "准备姿势时脊柱前倾角不足（小于约 20°）。从髋部向前屈身，让手臂自然下垂握杆，" +
      "臀部向后坐，保持背部平直。前倾不足会导致挥杆平面过平、击球不扎实。",
  },
  SPINE_TOO_BENT: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "前倾角过大",
    live: "⚠️ 前倾过多，挺直一些",
    advice:
      "准备姿势脊柱前倾超过约 50°，重心容易压到脚尖。略微抬起上身，" +
      "感觉重量落在脚掌中部，膝盖微屈即可。",
  },
  LOSS_OF_POSTURE: {
    view: "side",
    severity: SEVERITY.BAD,
    title: "失去脊柱角度（起身）",
    live: "🔴 起身了！保持脊柱角度",
    advice:
      "挥杆过程中脊柱前倾角明显变化（变化超过 12°），俗称\"起身\"。" +
      "这是导致剃头球、薄击的主要原因。练习方法：把臀部贴着椅背或墙做空挥，" +
      "整个挥杆过程中臀部不离开，体会下杆时保持前倾的感觉。",
  },
  EARLY_EXTENSION: {
    view: "side",
    severity: SEVERITY.BAD,
    title: "早伸（髋部前顶）",
    live: "🔴 髋部前顶（早伸）",
    advice:
      "下杆时髋部向球的方向顶出，挥杆空间被挤压，容易右曲球或杆身陡插。" +
      "练习：背对墙站位，臀部轻触墙面，下杆时保持右臀→左臀依次擦墙，" +
      "感受髋部是\"旋转\"而不是\"前顶\"。",
  },
  HEAD_DROP: {
    view: "side",
    severity: SEVERITY.WARN,
    title: "头部上下起伏过大",
    live: "🟡 头部起伏过大",
    advice:
      "挥杆中头部垂直位移过大，说明重心上下波动，击球低点不稳定。" +
      "保持膝盖弯曲幅度稳定，转肩时感觉头部在一个\"玻璃罩\"内转动。",
  },

  /* ================= 正面拍摄 (Face-on) ================= */
  HEAD_SWAY: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "头部左右晃动过大",
    live: "🟡 头部晃动，保持稳定",
    advice:
      "上杆时头部明显随身体平移，会带动击球低点偏移。允许头部少量随转动移动，" +
      "但应以\"转\"为主。练习：请同伴用杆头轻抵你的头侧做上杆，体会原地转肩。",
  },
  HIP_SWAY: {
    view: "front",
    severity: SEVERITY.BAD,
    title: "髋部摇摆（Sway）",
    live: "🔴 髋部向后摇摆",
    advice:
      "上杆时髋部向远离目标方向平移过多，而不是旋转，导致重心丢在右脚外侧、" +
      "下杆顺序混乱。练习：右脚外侧踩一个球或瓶子，上杆时顶住不让髋部外移，" +
      "感觉右髋是\"向后旋转\"。",
  },
  HIP_SLIDE: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "下杆髋部滑动过多（Slide）",
    live: "🟡 髋部滑动过多",
    advice:
      "下杆时髋部向目标方向平移过多而旋转不足，容易杆面打开、推球。" +
      "下杆应是\"轻微移动 + 大量旋转\"：感觉左髋向后口袋方向转，而不是整体平移。",
  },
  REVERSE_SPINE: {
    view: "front",
    severity: SEVERITY.BAD,
    title: "逆向脊柱倾斜",
    live: "🔴 上杆顶点上身倒向目标",
    advice:
      "上杆顶点时上半身向目标方向倾斜（应略微远离目标），这是腰部受伤和" +
      "\"先上后下\"乱序下杆的常见原因。检查上杆：转肩时让左肩转到下巴下方，" +
      "胸口朝向球的后方，而不是用侧弯代替转体。",
  },
  CHICKEN_WING: {
    view: "front",
    severity: SEVERITY.WARN,
    title: "击球区左臂弯曲（鸡翅膀）",
    live: "🟡 左臂弯曲（鸡翅膀）",
    advice:
      "击球前后前导手臂明显弯曲回收，损失力量且杆面不稳。多做左手单手击球练习，" +
      "感受击球后双臂向目标方向充分伸展，由身体旋转带动手臂。",
  },
};

// 总结报告中按严重程度排序用
export function severityWeight(s) {
  return s === SEVERITY.BAD ? 2 : 1;
}
