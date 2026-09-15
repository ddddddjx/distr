# SwingCoach 交接文档（CLAUDE.md）

高尔夫挥杆 AI 分析 H5/PWA。手机浏览器打开即用：实时拍摄或上传视频，本地姿态推理 + TPI/PGA 规则检出，产出逐杆评分报告、可视化标注截图、语音指导与分享卡。

- 线上地址：https://ddddddjx.github.io/distr/ （GitHub Pages，只从 main 部署）
- 产品负责人是用户；Claude 担任技术合伙人。改动前先对齐，**每完成一件事停下来给 diff 和验收方式，确认后再做下一件**。

## 不可违背的约束

1. **视频与音频永远不离开手机**——姿态推理、音频解码全部在浏览器本地完成，无任何上传。
2. **纯前端**：Vanilla JS ES Modules，零构建、零运行时依赖、无服务端。部署 = 静态文件。
3. 模型等资产全部自托管在 `vendor/`（~24MB），因为 Google CDN 在中国不可达。
4. 与 PGA/TPI 无官方关联，界面保留免责声明；不得克隆真人声音（声音肖像权）。
5. 中文注释、英文标识符；新功能一律放在默认关闭的 feature flag 后（`js/flags.js`，URL `?ff=X,Y` 或 localStorage `ff.X` 开启）。
6. user_id 只能是设备级匿名 UUID 或 null。

## 两条产品线与解耦契约

- **A 视觉主线（本仓库）**：免费本地分析 → 规划中的付费云端 3D + Claude 纠正 + 进步追踪。
- **B 传感器线（独立模块，未在本仓库实现）**：袖套双 IMU（hand_back + forearm，200Hz BLE）。
- 两线**只**通过版本化 SwingSession JSON 契约交互（`schema/swing-session.schema.json` v1.0.0，权威定义），不共享代码状态。finding 码注册表在 `schema/finding-codes.json`，零依赖校验器在 `schema/validate.js`（内嵌码表镜像，与 json 的一致性由测试强制）。
- 接入点已就绪且全部 flag 关闭：`exportSession()`（EXPORT_ENABLED）、`ExternalDataProvider` 接口 + NullProvider（SENSOR_ENABLED）、报告手腕数据区块（IMU_REPORT_ENABLED）。

## 模块地图

| 路径 | 职责 |
|---|---|
| `index.html` + `css/` | 单页应用壳，Apple HIG 设计系统 |
| `js/app.js` | 主控（~1200 行）：模式选择、相机/视频装载、逐杆报告、分享卡、击球声定位调度 |
| `js/swingAnalyzer.js` | 核心状态机（~740 行）：踝锚点+躯干归一化、相位 IDLE→…→FINISH、多重有效性闸门、时间基准化（兼容 3-60fps） |
| `js/poseDetector.js` | MediaPipe Pose Landmarker lite 封装（33 关键点） |
| `js/rules.js` | TPI 14 项检出规则 |
| `js/strikeAudio.js` | 击球声定位：差分高通 + 能量包络 + 4× 本底跃升；只标注（⛳/试挥?）不隐藏，默认选中有声最后一杆 |
| `js/exportSession.js` + `js/legacyCodeMap.js` | summary → SwingSession 契约映射（legacyCodeMap 是叶子模块，防止导出链被拖进启动模块图） |
| `js/providers/` | ExternalDataProvider 接口 + NullProvider + 动态装载 |
| `js/imuReport.js` | 手腕数据区块纯渲染函数（imu 非空才渲染） |
| `js/voice.js` / `js/shareCard.js` / `js/store.js` | 语音指导 / 分享卡生成 / 本地统计 |
| `sw.js` | PWA：vendor 缓存优先（独立缓存，发布升版**不清**，否则每人重下 24MB）、外壳 install 预缓存、页面网络优先 |
| `xhs-tool/` | 小红书小工具版（非 AI 回看训练器，容器无 WASM/无网络），独立维护 |

## 分析器关键设计（改动前必读）

踩坑沉淀，勿轻易回退：

- **首帧推理必须预热**：`detectForVideo` 首次调用要编译 GPU 着色器、初始化 WASM 算子，实测 4405ms vs 稳态 345ms 中位（无头环境）。
  `boot()` 里在加载遮罩后跑 `detector.warmUp()`，视频分析开播前再 `detector.prime(video)` 兜一层。
  漏了会怎样：那几秒视频照播但无人推理 → 骨骼停在旧帧（用户报"绿框定位不准"）+ 开头漏采导致基准锁不上 → 整段识别不到挥杆，重试一次反而好了。
- **时间基准化**：一切速度用"躯干单位/秒"，基准锁定 = 静止 600ms + ≥5 采样；不要假设 30fps（无头测试环境只有 ~3fps）。
- **归一化陷阱**：转体让躯干 2D 投影缩短 20-30%，髋部偏移必须按**基准躯干**换算（`_hipDevFrom`），否则真挥杆被误杀。
- 有效性闸门：maxRise≥0.45、maxHipDev≤0.35、腿长≥0.85、侧面锁基准要求 spine≥10°（防赛前直立闲站）、上杆悬停>0.9s 重采基准。
  maxHipDev **只累计到击球为止**：送杆本就伴随重心转移与起身，算进去会误杀真实挥杆；弯腰摆球走不到送杆，防误判不受影响。
- 防悬挂：DOWNSWING/IMPACT 超 5s 用 `_finishSwing` 收束（不是 abort——低采样环境击球窗口可能整段漏采）。
- **过顶点即已成杆**：此后人走出画面（`!lms`）或髋部大位移（弯腰摆下一颗球）都先走 `_salvagePastTop()` 收束出报告，收不住才 reset/reacquire。
  否则会出现"播完整段反而识别不到、中途手动停止却能识别"——两条收尾路径会把已经打完的那一杆静默丢掉（回归测试见 `tests/analyzer.test.mjs`）。
- 平滑：hands+hip 80ms EMA；腕/髋可见度门控 0.35/0.2；峰值回落 0.08 判顶点。
- 上传路径**绝不**开摄像头（历史 bug ×2）；摄像头只在用户显式选择实时模式后开启。

## Git 工作流

- 默认分支 `main`；开发分支 `claude/golf-swing-camera-analysis-vp5hc5`。
- 流程：分支开发 → push → 开 PR → CI（`.github/workflows/ci.yml` 跑 `npm run test:unit`）绿 → **用户 review + merge** → main 自动部署（`deploy-pages.yml`）。
- 每次合并后重置分支：`git checkout -B <branch> origin/main && git push -u origin <branch> --force-with-lease`（仅含已合并历史时合法）。
- 生产只从 main 上线是有意的纪律；单测/E2E/CI 都在合并前完成。

## 测试

- `npm run test:unit`：53 个单测（schema/export/provider/imuReport/strike/analyzer），CI 门禁。analyzer 用合成关键点驱动状态机，无需浏览器与真实视频。
- `node tests/run-video-test.mjs <video.webm> [front|side] [playbackRate]`：Playwright E2E，真实视频回归。加 `FF=EXPORT_ENABLED` 可校验导出契约。
- E2E 环境须知：预装 Chromium 在 `/opt/pw-browsers/`（勿 `playwright install`）；**无 H.264 解码**，iPhone 素材要转 WebM（音轨 `-c:a libvorbis`；拼接必须 `filter_complex` 全重编码，concat demuxer 会断 vorbis 时间戳）；无头推理仅 ~3fps，用 playbackRate 0.25-0.5 补偿；本地静态服务 MIME 必须含 `.mjs`。
- `node tests/sw-offline.mjs`：Service Worker 离线启动回归。守的是线上事故——网络优先分支回退缓存未命中时
  `respondWith(undefined)` 会让导航直接失败，装到主屏幕的 PWA 启动后黑屏转白屏打不开。兜底必须返回真实 Response。
- 测试素材在 `tests/assets/`（gitignored，容器重置后需重新转码生成）。

## 已知边界 / 待办

- 嘈杂练习场邻位击球声可能误标 ⛳（仅标注，可一键切换纠正）；静音视频自动降级为旧行为。
- 极低帧率下多挥杆相位可能收束不完整（靠 `hasStrikeInRange` 区间兜底）。
- 用户暂缓：自购域名/国内托管迁移。小工具提审由用户自行操作。
