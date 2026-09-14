// 历史规则键 → SwingSession 契约 code 的映射（叶子模块，零依赖）。
// 单独成文件的原因：exportSession（EXPORT_ENABLED 动态加载）与
// imuReport（报告静态加载）都需要它——放在 exportSession 里会把整个
// 导出链拖进启动模块图，破坏"开关关闭时导出模块不加载"的设计。
// 与 schema/finding-codes.json 的一致性由 tests/export.test.mjs 强制。
export const LEGACY_TO_CODE = {
  SPINE_TOO_UPRIGHT: "spine_too_upright",
  SPINE_TOO_BENT: "spine_too_bent",
  C_POSTURE: "c_posture",
  LOSS_OF_POSTURE: "loss_of_posture",
  EARLY_EXTENSION: "early_extension",
  OVER_THE_TOP: "over_the_top",
  HEAD_DROP: "head_drop",
  HEAD_SWAY: "head_sway",
  HIP_SWAY: "hip_sway",
  HIP_SLIDE: "hip_slide",
  REVERSE_SPINE: "reverse_spine_angle",
  HANGING_BACK: "hanging_back",
  FLAT_SHOULDER_PLANE: "flat_shoulder_plane",
  CHICKEN_WING: "chicken_wing",
};
