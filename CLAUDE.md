# SwingCoach 交接文档（CLAUDE.md）

高尔夫挥杆 AI 分析 H5/PWA。手机浏览器打开即用：实时拍摄或上传视频，本地姿态推理 + TPI/PGA 规则检出，产出逐杆评分报告、可视化标注截图、语音指导与分享卡。

- 线上地址：https://ddddddjx.github.io/distr/ （GitHub Pages，只从 main 部署）
- 产品负责人是用户；Claude 担任技术合伙人。改动前先对齐，**每完成一件事停下来给 diff 和验收方式，确认后再做下一件**。

## 不可违背的约束

1. **视频与音频永远不离开手机**——姿态推理、音频解码全部在浏览器本地完成，无任何上传。
2. **纯前端**：Vanilla JS ES Modules，零构建、零运行时依赖、无服务端。部署 = 静态文件。
3. 模型等资产全部自托管在 `vendor/`（~24MB），因为 Google CDN 在中国不可达。
4. 与 PGA/TPI 无官方关联，界面保留免责声明；不得克隆真人声音（声音肖像权）。
5. 中文注释、英文标识符；新功能一律放在默认关闭的 feature flag 后（`js/flags.js`，URL `?ff=X,Y` 或 localStorage `ff.X` 开启）。验收通过后可把默认值翻成 true（如 `REPLAY_DOWNLOAD`），localStorage `ff.X=0` 仍可关掉。
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
| `js/frameGrid.js` | 上传视频的确定性采样网格（纯函数叶子模块）：同一段视频永远同一组帧 |
| `js/cameraWatchdog.js` | 预览卡死判定（纯函数叶子模块）：none / resume / reopen / stop |
| `js/replayExport.js` | 慢放回放导出（叶子模块，点按钮时才动态装载）：canvas 逐帧重编码 + 系统分享/下载 |
| `sw.js` | PWA：vendor 缓存优先（独立缓存，发布升版**不清**，否则每人重下 24MB）、外壳 install 预缓存、页面网络优先 |
| `xhs-tool/` | 小红书小工具版（非 AI 回看训练器，容器无 WASM/无网络），独立维护 |

**实时模式必须给摄像头预览保活**：iOS 播完报告里的慢放回放后，会把预览 `<video>` 暂停、
严重时直接中断采集轨道（track muted/ended）。元素不报错、rAF 照转，但 `video.currentTime`
不再前进 → `detect()` 每帧返回 undefined → 一帧都不再推理。用户看到的就是
"第一杆能出报告，点完「继续练习」后第二杆怎么挥都识别不到"。三道防线：
关报告时主动 `resumePreview()`；主循环连续 1.5s 没新帧则走 `cameraWatchdog` 分级恢复
（续播 → 重开摄像头 → 三次仍无帧就停下来告诉用户）；FPS 面板只统计真正完成推理的帧，
预览冻住时直接显示 0，不再用 60 FPS 的假象掩盖问题（回归见 `tests/preview-stall.mjs`）。

**导出慢放视频必须真的重编码**：录下来的片段是原速的，报告里的"慢动作"只是 `playbackRate = REPLAY_RATE`(0.4)
的播放效果。直接把 blob 存给用户，他打开一看"怎么不慢了"。`renderSlowMotion()` 让回放以 0.4x 播放、
逐帧画进 canvas，用 `captureStream() + MediaRecorder` 按墙钟录下来——文件本身就是慢速的（回归见
`tests/replay-export.mjs`，断言产出时长 ≈ 源 ÷ 倍速）。耗时 = 片段时长 ÷ 倍速，要给等待提示。
实时模式导出整段录像，上传视频模式导出本杆的 `replaySegment` 区间，两条路径都覆盖。
`await import()` 之后 iOS 的用户手势可能已失效导致 `play()` 被拒——必须就地 finish() 并抛错，
否则录制器挂到 60s 超时、`done` 无人接手变成未捕获拒绝，用户对着白转圈等一分钟。
**保存必须拆成两步**：`navigator.share()` 在 iOS 上只接受【用户手势直接触发】的调用，
而转码要跑好几秒，手势早已过期 → `share()` 抛 `NotAllowedError`，面板根本不弹。
旧实现还把 `NotAllowedError` 当"用户取消"吞掉，用户既没看到面板也没看到报错，
以为存进相册了其实什么都没发生。所以：第一步转码（按钮上跑实时百分比 + 剩余秒数，
`onProgress` 限流 100ms），第二步把按钮变成"存到相册 · 点此完成"，用户那一下点击
就是新鲜手势，面板必定弹出。`AbortError`（用户自己取消）留在第二步等他再点；
其他失败退回 `forceDownload`，两条路都不通就如实报错，**绝不显示"已保存"**。
网页没有任何 API 能直接写相册——只能靠这张面板，文案要说清"选「存储视频」"。
导出帧右上角画品牌水印（`drawWatermark`：`assets/logo-mark.png` 圆标 + JAYKAY Golf +
半透明胶囊底衬，纯白背景上也读得清）。logo 必须**同源**加载（`loadLogo()`，已进 sw 预缓存）——
跨源图会污染 canvas，被污染的 canvas 根本录不出流；取不到图则退回绿点，绝不因为一张图让导出失败。
圆标不能画太小，里面还有小鸟和字，糊成一团就失去意义（当前 `1.15 × 字号`）。容器优先 mp4：iOS 存进相册只认它，webm 只能存到「文件」。拿不到 `captureStream`/`MediaRecorder`
时降级为保存**原速**片段，并如实说明，不许假装是慢放。屏上倍速与导出倍速共用 `REPLAY_RATE` 常量，
各写各的就会让存下来的文件和报告里看到的速度对不上。

**上传视频的原声开关**（顶栏「原声/静音」药丸，只在文件模式出现）：`<video>` 带 `muted` 属性是
相机自动播放的前提，所以原声由 JS 的 `applyVideoSound()` 统一控制，相机模式恒定静音——
getUserMedia 压根没要音轨，真开了只会啸叫。顶栏已有一个 🔊（语音指导），再放个喇叭图标必然
混淆，故用文字药丸。开关放顶栏而非配置行：分析进行中 `#controls.running` 会把配置行折叠，
放那儿播放途中就点不到了。解除静音必须借用户手势，否则 iOS 直接把视频暂停。
`startAnalysis` 里 `video.play()` **必须 try**：带声音的播放更容易被自动播放策略拦下
（`detector.prime()` 的 await 可能已经把手势耗掉），原来那行没有 try，一旦被拒就直接抛出、
末尾的 `loop()` 再也跑不到——按钮显示"停止分析"却一帧都不分析。被拒时静音重试并如实提示。
报告里的慢放回放与导出的视频都无声（0.4x 的音频是糊的，canvas 录制也不含音轨）。
回归见 `tests/video-sound.mjs`。

报告里的慢放回放（`#replayVideo`）**必须带 poster 兜底**：iOS 上这个第二个 video 元素常常拿不到解码资源、
或非用户手势的自动播放被拒，既不报错也不出帧，结果就是一片纯黑。铺一张本次挥杆的真实关键帧当 poster，
并在 1.5s 后仍未出帧时打开原生 `controls`，让用户一点即可播放。

## 移动端原生手感基线（勿回退）

依据 [emilkowalski/skills](https://github.com/emilkowalski/skills) 的 mobile-native 与
review-animations 标准。这些是"一个网页"与"一个 App"的分界线，回退了手机上立刻现原形：

- **`viewport-fit=cover` 是 `env(safe-area-inset-*)` 生效的前提**。缺了它，样式里所有安全区
  padding 恒为 `0px`——写了等于没写（本项目曾经就是这样：4 处 env() 全部失效）。
- **绝不禁用缩放**：`user-scalable=no` / `maximum-scale=1` 是无障碍缺陷。本页没有输入框，
  不存在 iOS 聚焦输入自动放大的问题，本来也没有禁用的理由。
- 可点元素必须有 `touch-action: manipulation`（否则 iOS 等 ~300ms 判双击，点起来慢半拍）
  与 `user-select: none`（否则长按选中文字/弹复制菜单）。`user-select: none` **只给控件**，
  绝不给 body——报告正文与错误信息用户要能复制。
- 每个可点元素都要有 `:active` 按压反馈（`scale(0.96~0.97)`，100–160ms）。原生按钮是手指
  按下的瞬间就响应；只在 click 上给反馈，即使 0ms 也会被读成"卡"。
- 动效曲线：进场/离场与按压用 `--ease-out`（强 ease-out），**绝不 `ease-in`**；
  只动 `transform`/`opacity`/颜色，**不写 `transition: all`**（会连 layout/paint 属性一起动）。
- `prefers-reduced-motion: reduce` 要降级：去掉位移/缩放与无限循环呼吸，保留透明度与颜色
  （减弱动态 ≠ 没有反馈）；彩带这类纯装饰直接不放（`celebrate()` 里也判断）。
- **排版是体系不是散值**：字距（`--tr-*`）随字号变化——字越大越紧，≤12px 反而要微放，
  全大写小标签必须放开，否则糊成一团；行距（`--lh-*`）与字号反向。一个 `letter-spacing`
  通吃必然有一头是错的（本项目曾经 `-0.4px`/`-1px`/`0.5px` 混用，11px 小字还用了负字距）。
- **堆叠 sheet 要让父层后退并压暗**（`openStackedModal()` / `.pushed` / `.stacked`），
  而不是再糊一层 0.48 的黑——两层叠起来≈0.73，只是"更黑了"，读不出层级。
  `.pushed` 必须 `animation: none`：CSS 动画在层叠里压过普通声明，父层入场还没跑完时
  后退效果会被整个吃掉。
- 遮罩要和卡片同步入场（`scrim-in`）。原来卡片滑入、遮罩硬切，两者不同步很扎眼。
- **动效要经得起"频次"这一关**：一天出现上百次的东西（相位药丸、保存进度百分比）
  **永远不加动画**——动画会让高频动作显得慢、显得延迟。偶尔出现的（报告、提示条、
  关键帧）才有资格，稀有的（首次引导、高分庆祝）才配得上"取悦"预算。
  用户正在读取的数据（统计图表）不为了好看而动。
- 回归见 `tests/mobile-polish.mjs`。注意**安全区的实际数值只有真机能验**，测试只验前提条件。
  写这类测试有两个坑：① `getComputedStyle(el).animationName` 是**声明值**，动画跑完照样
  返回动画名，拿它当"动画结束"的判据会永远等不到——要用 `document.getAnimations()`；
  ② 断言要取**数值**（`brightness < 0.99`），只判 `!== "none"` 的话 `brightness(1)` 也能蒙混过关。

## 上传视频必须确定性逐帧（勿回退）

**同一段视频两次分析分数不一样，是架构问题，不是玄学。** 旧实现"边播边抽帧"：
视频实时播放，rAF 拿到哪一帧全看当时手机有多忙（MediaPipe 推理同步阻塞，一帧几十到
几百毫秒，30fps 的视频实际只分析到 8–15 帧/秒）；而评分是**逐帧取最大偏差**
（`_record` 里 `ratio > prev.ratio` 才更新），抽到的帧不同 → 峰值不同 → 分数不同。
实测同一段视频跑两遍，抽到的帧集合**重合度只有 6%**。

现在（`runFileAnalysis()` + `js/frameGrid.js`）：
- **不播放**，`currentTime` 按 `sampleGrid()` 的固定网格（15fps）逐格 seek，等 `seeked` 再推理。
  `<video autoplay>` 属性会让文件一装载就自动播放，`enterFileMode` 与循环里都要 `pause()`——
  一旦在播就又回到"抽到哪帧看运气"。
- 分析器的时间基准是**网格时刻**，不是 `performance.now()`，也不是 `video.currentTime`
  （seek 会落到最近可解码帧，用实际落点会把机器差异重新引回来）。
- **MediaPipe 的时间戳要单调**：它要求时间戳在 landmarker 整个生命周期内递增，而预热用的是
  `performance.now()`（页面开越久数值越大）、视频时间轴却从 0 起——直接喂会抛
  "Packet timestamp mismatch"。`PoseDetector._ts()` 维护游标，`beginTimeline()` 把视频时间
  平移到游标之后（不是 clamp：clamp 会把所有帧压成 1ms 间隔，跟踪行为与真实节奏对不上）。
- **逐帧期间画面必须自己画**：iOS 上"暂停 + seek"的 `<video>` 元素经常不往屏幕合成，
  用户看到的是一片全黑（实测过）。`detectAt()` 已经把该帧缩进 `detector.work` 工作画布，
  `processFrame(lms, t, detector.work)` 把它铺进 overlay 再画骨骼。
- **预缩放到 640 宽再推理**：手机素材常是 1080p/4K，直接喂 video 元素每帧要上传一张大纹理；
  实测省 17%（源越大省得越多），而模型内部本来就缩到 256×256，几乎不损精度。
- 性能分布（实测，无头环境）：**seek 只占 18ms，推理 380–450ms** ——
  要提速只有"每帧更便宜"和"帧数更少"两条路，优化 seek 没有意义。
- 采样率 `FILE_SAMPLE_FPS` 是准确度与耗时的折中，**下限是"快速下杆那 0.25s 至少 3 帧"**。
  改它属于口径变更（分数会变），改前先跑 analyzer 的「12fps 采样下仍能识别完整挥杆」。
- 代价：分析不再是实时，10 秒视频要等几十秒，必须给进度。进度写进**相位药丸**——
  IDLE 的文案是"请站好位置"，对着一段已经拍好的视频说这个毫无意义。
- 相机模式不受影响：现场只能实时，时间基准仍是墙钟。
- **只统一帧序列还不够，模型本身也带状态**：MediaPipe 的 VIDEO 模式用上一帧的结果做
  跟踪 ROI，而 landmarker 是全局长寿命实例——第二次从头分析时跟踪器里还留着第一次
  最后一帧的状态，开头几帧就偏、基准锁错、分数天差地别（用户实测同一段视频 50 分 / 90 分，
  第一轮只修了帧序列，没解决）。实测同一串 12 帧喂两遍，关键点最大坐标差：
  **VIDEO 0.19，IMAGE 0.000**。所以上传视频必须 `detector.setStateless(true)` 走 IMAGE
  无状态模式，分析结束（含中途停止）切回 VIDEO——相机要靠跟踪。
  代价：没有跟踪 ROI 加速，每帧全图检测，实测慢约 1.6 倍。
- **时间戳倒退会永久毒死推理图**：实测只要喂进一个倒退的时间戳，之后即使给合法时间戳
  也一直 `Graph has errors`，除非重建 landmarker。`_ts()` 保证我们自己不倒退；
  `_run()` 是最后兜底——图坏了就降级成"这帧没人"并通过 `onBroken` 明确告诉用户刷新，
  绝不每帧抛异常、让用户对着一个"有画面、没结果"的 App 反复挥杆。
- 回归见 `tests/detector-determinism.mjs`（**直接比对关键点数值**，并用 VIDEO 模式做控制组
  证明这条测试测得到东西）、`tests/deterministic-analysis.mjs`（帧序列）与 `tests/frameGrid.test.mjs`。
  教训：上一版只断言"两次走过的帧时刻一致"，没验模型输出，这个 bug 就是这么溜过去的。

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
- **但这两条路径都不许一帧定生死**：手机下杆那 0.25s 运动模糊最重，lite 模型经常连丢几帧。
  单帧漏检当成"离场"会两头出错——顶点前 reset 掉整杆（识别不到），顶点后立刻收束（挥杆打到一半弹报告，用户实测过）。
  故 `!lms` 要连续 `MISSING_MS`(600ms)、髋部离位要连续 `HIP_OUT_MS`(250ms) 才算数。
  同理 `maxHipDev` 是只增不减的最大值，累计时取与上一帧的较小值（两帧腐蚀），
  否则一帧裙装/模糊的髋部跳变就能把它顶过 0.35，让打完的一杆在 `_finishSwing` 里被静默判废。
- 平滑：hands+hip 80ms EMA；腕/髋可见度门控 0.35/0.2；峰值回落 0.08 判顶点。
- 上传路径**绝不**开摄像头（历史 bug ×2）；摄像头只在用户显式选择实时模式后开启。

## Git 工作流

- 默认分支 `main`；开发分支 `claude/golf-swing-camera-analysis-vp5hc5`。
- 流程：分支开发 → push → 开 PR → CI（`.github/workflows/ci.yml` 跑 `npm run test:unit`）绿 → **用户 review + merge** → main 自动部署（`deploy-pages.yml`）。
- 每次合并后重置分支：`git checkout -B <branch> origin/main && git push -u origin <branch> --force-with-lease`（仅含已合并历史时合法）。
- 生产只从 main 上线是有意的纪律；单测/E2E/CI 都在合并前完成。

## 测试

- `npm run test:unit`：77 个单测（schema/export/provider/imuReport/strike/analyzer/cameraWatchdog/replayExport/frameGrid），CI 门禁。analyzer 用合成关键点驱动状态机，无需浏览器与真实视频。
- `node tests/run-video-test.mjs <video.webm> [front|side] [playbackRate]`：Playwright E2E，真实视频回归。加 `FF=EXPORT_ENABLED` 可校验导出契约。
- E2E 环境须知：预装 Chromium 在 `/opt/pw-browsers/`（勿 `playwright install`）；**无 H.264 解码**，iPhone 素材要转 WebM（音轨 `-c:a libvorbis`；拼接必须 `filter_complex` 全重编码，concat demuxer 会断 vorbis 时间戳）；无头推理仅 ~3fps，用 playbackRate 0.25-0.5 补偿；本地静态服务 MIME 必须含 `.mjs`。
- `node tests/replay-export.mjs`：慢放导出回归（canvas 合成素材 → `renderSlowMotion`）。断言：
  产出时长 ≈ 源 ÷ 倍速、区间导出（上传视频模式）同样成立、右上角水印把画面压暗、
  进度回调单调递增且收尾 100%、`play()` 被拒时秒级报错不挂到超时。需要浏览器，不进 CI 门禁。
- `node tests/detector-determinism.mjs`：姿态推理可复现性回归（合成人形喂两遍，断言无状态
  模式关键点完全一致；VIDEO 模式作控制组必须不同）。需要浏览器。
- `node tests/deterministic-analysis.mjs`：上传视频分析确定性回归（同一段合成视频跑两遍，
  断言分析期间视频不播放、两次走过的帧时刻完全一致、步长是固定的 1/15s）。需要浏览器。
- `node tests/mobile-polish.mjs`：移动端原生手感基线回归（viewport-fit / 未禁缩放 /
  touch-action / user-select / text-size-adjust / overscroll / 无 transition:all /
  :active 覆盖面 / 393px 无横向溢出 / 减弱动态降级）。需要浏览器。
- `node tests/video-sound.mjs`：上传视频原声开关回归（相机模式恒静音且不显示按钮、
  点击真的解除 `<video>` 静音并写入 localStorage、393px 顶栏放得下不挤掉 FPS）。需要浏览器。
- `node tests/preview-stall.mjs`：实时模式预览卡死恢复回归（假摄像头启动分析 → 暂停预览元素 /
  停掉采集轨道 → 断言看门狗把画面救回来、推理继续）。需要浏览器，不进 CI 门禁。
- `node tests/sw-offline.mjs`：Service Worker 离线启动回归。守的是线上事故——网络优先分支回退缓存未命中时
  `respondWith(undefined)` 会让导航直接失败，装到主屏幕的 PWA 启动后黑屏转白屏打不开。兜底必须返回真实 Response。
- 测试素材在 `tests/assets/`（gitignored，容器重置后需重新转码生成）。

## 已知边界 / 待办

- 嘈杂练习场邻位击球声可能误标 ⛳（仅标注，可一键切换纠正）；静音视频自动降级为旧行为。
- ~~极低帧率下多挥杆相位可能收束不完整~~：上传视频改成确定性逐帧后不再有漏采问题；
  实时拍摄仍受设备算力影响。
- 上传视频的「原声」开关在逐帧分析期间无声——逐帧不播放，没有可播的音频。
- 用户暂缓：自购域名/国内托管迁移。小工具提审由用户自行操作。
