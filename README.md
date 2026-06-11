# ⛳ SwingCoach — 高尔夫挥杆实时 AI 分析 Mini App

一个纯前端的移动端 Web App：用手机摄像头**实时**拍摄高尔夫挥杆（支持正面 / 侧面两种机位），
基于浏览器端人体姿态估计（MediaPipe Pose），自动切分挥杆阶段、实时指出动作问题，
并在每次挥杆结束后给出带改进建议的分析报告。

**无需安装、无需服务器、视频不离开手机**——所有 AI 推理都在浏览器本地完成。

## 功能

- 📹 **实时姿态追踪**：手机浏览器内 20-30 FPS 骨骼叠加显示（MediaPipe Pose Landmarker）
- 🎓 **TPI / PGA 知识体系**：检测规则与反馈内容基于 TPI（Titleist Performance Institute）
  十二大挥杆特征（Big 12）与 PGA 教学体系（准备姿势标准、动力链顺序、球路法则）；
  每个问题的报告包含「球路影响 → TPI 身体筛查关联 → 矫正练习」
- 🔄 **双机位分析**
  - **正面（Face-on）**：Sway 摇摆、Slide 滑动、Reverse Spine Angle 逆向脊柱倾斜、
    Hanging Back 重心滞留、Flat Shoulder Plane 转肩过平、Chicken Wing 鸡翅膀、头部晃动
  - **侧面（Down-the-line）**：Loss of Posture 起身、Early Extension 早伸、
    Over-the-Top 由外向内下杆、C-Posture 圆肩驼背、站姿前倾角、头部起伏
- 🏌️ **挥杆阶段自动切分**：准备 → 上杆 → 顶点 → 下杆 → 击球 → 送杆 → 收杆，无需手动标记
- 📁 **上传视频分析**：除实时相机外，可直接上传已拍好的挥杆视频（相册/文件），
  逐帧跑同一套分析管线，播放结束自动出报告，支持一键重新分析
- ⚡ **实时提示**：挥杆过程中问题即时弹出（红色=严重，黄色=轻微）
- 📋 **挥杆报告**：每次收杆后自动弹出评分 + 问题清单 + 针对性练习建议
- 🤝 左/右手球员、前后摄像头切换；阈值按躯干长度归一化，对身高和拍摄距离不敏感

## 快速开始

摄像头 API 要求 **HTTPS 或 localhost**，任选一种方式：

```bash
# 方式一：本地起静态服务（电脑调试用 localhost 即可）
npx serve .            # 或 python3 -m http.server 8000

# 方式二：手机真机调试（推荐）——用隧道拿到一个 https 地址
npx serve . &
npx cloudflared tunnel --url http://localhost:3000
# 手机浏览器打开输出的 https 链接即可

# 方式三：直接部署到 GitHub Pages / Vercel / Netlify（静态站点，零配置）
```

使用流程：选择机位（正面/侧面）→ 按提示架好手机 → 点「开始分析」→
摆好准备姿势静止 1 秒 → 正常挥杆 → 收杆后自动弹出报告。

## 项目结构

```
index.html            页面骨架（相机画面、控制面板、报告弹窗）
css/style.css         移动端优先的 UI 样式
js/app.js             主控：相机管理、推理循环、UI 渲染
js/poseDetector.js    MediaPipe Pose Landmarker 封装（加载/推理/绘制骨骼）
js/swingAnalyzer.js   核心：挥杆阶段状态机 + 各阶段问题检测 + 报告生成
js/rules.js           问题规则库（阈值、实时提示语、改进建议文案）
```

## 分析原理

1. **基准采集**：球员摆好准备姿势并静止约 600ms 后，记录脊柱前倾角、头/髋/手位置、
   肩宽与躯干长度作为基准。
2. **阶段切分**：以双手中点的高度与垂直速度驱动状态机（上杆=手上升，顶点=速度反向，
   击球=手回到基准高度附近，收杆=手高于肩且静止）。
3. **方向自适应**：目标方向由上杆时手的移动方向反推，因此**与镜像、左右手、机位朝向无关**。
4. **问题检测**：每个阶段运行对应规则，位移阈值以躯干长度/肩宽归一化（具体阈值见
   `js/rules.js` 与 `js/swingAnalyzer.js`，可按教学标准微调）。

## TPI 十二大挥杆特征覆盖情况

| TPI Big 12 | 检测机位 | 状态 |
|---|---|---|
| Loss of Posture 失去姿势 | 侧面 | ✅ |
| Early Extension 早伸 | 侧面 | ✅ |
| Over-the-Top 由外向内 | 侧面 | ✅ |
| C-Posture 圆肩驼背 | 侧面 | ✅ |
| Sway 摇摆 | 正面 | ✅ |
| Slide 滑动 | 正面 | ✅ |
| Reverse Spine Angle 逆向脊柱倾斜 | 正面 | ✅ |
| Hanging Back 重心滞留 | 正面 | ✅ |
| Flat Shoulder Plane 转肩过平 | 正面 | ✅ |
| Chicken Wing 鸡翅膀 | 正面 | ✅ |
| Casting / Early Release 提前释放 | — | ❌ 需杆身追踪 |
| S-Posture 骨盆前倾过大 | — | ❌ 需骨盆倾角，2D 关键点不可见 |

> ⚠️ 检测基于 2D 关键点的启发式规则，定位是**练习辅助**，不能替代教练的专业判断。
> 本应用与 PGA、TPI 无官方关联，规则为基于其公开教学体系的工程实现。
> 侧面机位请尽量沿目标线摆放，否则脊柱角度估计会有偏差。

## 后续路线图

- [ ] 挥杆视频回放 + 关键帧（顶点/击球）截图对比
- [ ] 历史记录与趋势统计（localStorage / 后端）
- [ ] 3D 姿态（MediaPipe world landmarks）提升侧倾/转体角度精度
- [ ] 杆头轨迹追踪与挥杆平面分析
- [ ] 打包为 PWA（离线可用）/ 微信小程序壳
