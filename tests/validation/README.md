# 规则精度验证（tests/validation）

目的：在拿不到教练逐段点评的情况下，用两类便宜的素材把 14 条规则的精度变成可度量的数字。

- **职业选手集（阴性对照）**：理论上零检出。哪条规则在职业选手身上频繁触发，那条规则的阈值或几何定义就有问题。顺带得到职业节奏分布。
- **阳性样本集**：自己或球友刻意做出某个问题（早伸、摇摆、起身……）拍下来，检验规则响不响。测出的是召回率下限。

素材本身不进 git（`tests/assets/` 已 gitignore），标签靠目录约定和 `manifest.json`。

## 目录约定

```
tests/assets/validation/
  pro/side/*.webm                    职业选手 · 侧面（Down-the-line）
  pro/front/*.webm                   职业选手 · 正面（Face-on）
  faults/<规则码>/<机位>/*.webm      阳性样本，例如 faults/early_extension/side/jax-01.webm
```

规则码用契约里的 snake_case（见 `schema/finding-codes.json`）。每条规则只在一个机位检测，放错机位目录脚本会警告：

| 侧面 side | 正面 front |
|---|---|
| spine_too_upright、spine_too_bent、c_posture、loss_of_posture、early_extension、over_the_top、head_drop | head_sway、hip_sway、hip_slide、reverse_spine_angle、hanging_back、flat_shoulder_plane、chicken_wing |

运行 `node tests/validation/run-validation.mjs init` 会把这些目录一次建好。

## 职业对照集：直接从 GolfDB 导入

GolfDB（McNally 等，CVPR-W 2019）有 1400 杆职业挥杆的标注：YouTube ID、球员、机位、慢动作与否、8 个关键事件帧号、球手裁剪框。
其中侧面 585 杆、正面 461 杆、202 位球员。它不带视频，`golfdb-import.py` 负责下载原片、按裁剪框与事件帧裁出单杆、转 WebM，并把顶点/击球时刻写进 manifest：

```bash
pip install scipy yt-dlp            # 另需 ffmpeg/ffprobe 在 PATH
python3 tests/validation/golfdb-import.py select --view side --slow 0 --limit 30   # 筛子集（可多次追加）
python3 tests/validation/golfdb-import.py select --view front --limit 20
python3 tests/validation/golfdb-import.py download                                  # yt-dlp，国内需翻墙
python3 tests/validation/golfdb-import.py cut                                       # 裁剪 + 转码 → pro/<view>/golfdb-*.webm
python3 tests/validation/golfdb-import.py manifest                                  # 写 events/source 到 manifest.json
```

每步幂等，已完成的自动跳过；`--dry-run` 只打印命令。默认每段视频只取 1 杆、每位球员最多 2 杆，以最大化多样性并减少下载量。
标注帧号是在 30fps 原片上标的，下载格式已限定 ≤30fps；若相位误差表里出现整体接近 2 倍的偏差，先怀疑拿到了 60fps 流。

## 素材要求

- 标准机位：侧面镜头在球手身后沿目标线，正面镜头正对胸口。斜后方、高机位的转播画面不要。
- 全身入镜，从头到脚尖都在画面里，挥杆全程不出框。
- 固定机位优先。轻微推拉摇移可以接受（踝锚点归一化能扛），大幅跟拍不要。
- 一段一杆最好。多杆视频可以，但要在 manifest 里写期望杆数。
- 准备姿势要有至少 1 秒静止，否则基准锁不上。剪辑时开头多留一点。
- 正常速度与慢动作都可以，建议两种都有，慢动作在文件名里标 `-slomo`。

## 转码

测试环境的 Chromium 没有 H.264 解码器，所有素材要转成 WebM。裁切时开头留 1.5 秒静止：

```bash
# 单段：缩到 720p 宽，VP8，保留音轨（击球声定位要用）
ffmpeg -ss 00:00:12 -t 6 -i in.mp4 -vf scale=720:-2 -c:v libvpx -b:v 1.5M -c:a libvorbis out.webm

# 无音轨素材
ffmpeg -i in.mp4 -vf scale=720:-2 -c:v libvpx -b:v 1.5M -an out.webm
```

拼接多段必须用 `filter_complex` 全重编码，concat demuxer 会打断 vorbis 时间戳。

## 标注（manifest.json）

目录已经给出机位和主标签，manifest 只补目录表达不了的信息。所有字段可选，但 `source` 请务必填，方便追溯与版权核对：

```json
{
  "defaults": { "playbackRate": 0.5 },
  "clips": {
    "pro/side/rory-dtl-01.webm": {
      "source": "https://…",
      "swings": 1,
      "events": { "top": 2.35, "impact": 2.62 }
    },
    "pro/side/furyk-dtl-01.webm": {
      "source": "https://…",
      "allow": ["over_the_top"],
      "note": "上杆路线个人特征明显，放行"
    },
    "faults/early_extension/side/jax-01.webm": {
      "codes": ["early_extension", "loss_of_posture"],
      "note": "刻意早伸时顺带起身了"
    }
  }
}
```

- `events` 的时间是**视频秒数**，在播放器里逐帧找顶点和击球那一帧记下来即可。只标几段也能用。
- `allow` 是职业选手个人特征放行，不要为个别球员放宽全局阈值。
- `codes` 覆盖目录推导的标签，一段素材带多个问题时用。

## 运行

```bash
npm run test:validation                                   # 全部
node tests/validation/run-validation.mjs --only pro/side  # 路径过滤
RATE=0.25 LIMIT=3 DEBUG=1 npm run test:validation         # 更密采样、只跑前 3 段、打印轮询
```

无头推理约 3fps，默认按 0.5 倍速播放补偿；慢动作素材可以用 1 倍。每段素材会重新加载页面（本地模型加载很快），几十段大约十几分钟。

## 产出

- `tests/output/validation/report.md`：六张表，识别率、误报率、检出率、附带检出、相位误差、职业节奏分布，外加逐段明细。
- `tests/output/validation/results.json`：机读版，含每杆的 findings 与 ratio（关键点序列已剔除以控制体积）。
- `tests/output/validation/<素材名>/`：该段的 `session.json`（完整 SwingSession 契约实例）与每条检出的标注截图。

## 怎么读

1. 先看识别率。识别不到挥杆的素材，先排查机位、入镜、开头静止，再怀疑分析器。
2. 误报率高的规则，打开触发素材的截图，分清是关键点抖动（感知层）还是阈值过严（规则层）。
3. 检出率低的规则，先看相位误差表。相位切错，下游一定错。
4. 决策原则：宁可漏报，不能错报。误报率明显高又调不下来的规则，先关掉或降为"疑似"。

## 版权

转播片段与教学视频只能做内部测试集，不进仓库、不进产品。产品里若要做"与职业动作对比"，需要自拍或授权素材。
