# Video Reader

[English](#english) · 中文

A DeepSeek Harness plugin that lets the agent **watch, listen to, and look at** things: video/audio files on disk, and the live desktop. Everything runs locally — no upload, no cloud API.

- `video_read` — metadata, frames, subtitles, multilingual speaker-labelled transcript
- `video_frames` — full-width stills at exact instants
- `screen_capture` — look at the screen; every captured frame is returned, in pages
- `screen_frames_read` — continue reading a capture until nothing is unread
- `screen_watch` — sample continuously, wake the agent only when the picture changes
- `screen_record` — long captures as video (1 h at 30 fps ≈ 350 MB)
- `video_reader_setup` — check or install the external toolchain (auto-installed on first use)

## English

**Install**

```powershell
git clone https://github.com/ck99998888/dsh-video-reader $env:USERPROFILE\dsh-video-reader
pwsh -File $env:USERPROFILE\dsh-video-reader\scripts\setup.ps1   # optional; -Mirror if GitHub is slow
```

Then install the folder as a bundle in DSH (Plugin Manager → install from folder, or
`plugin_manager install_bundle` with that path) and restart DSH once: the Client half
of a bundle is composed at page boot.

**Dependencies are installed automatically.** The first `video_read`/`video_frames`/`screen_capture`
call downloads whatever is missing (ffmpeg first) into `%LOCALAPPDATA%\dsh-video-reader\bin`
and `…\models`, then retries the call. Every download is pinned by version and verified
by sha256 against the manifest in `lib/deps.js`; a mismatching file is deleted, never
installed. `scripts/setup.ps1` is now only a way to pre-seed everything up front.
Control the behaviour with the plugin Config (`autoSetup`, `autoSetupModels`,
`dependencyMirror`) or from Settings → Video Reader → Dependencies.

| Piece | Size | Why not committed |
|---|---|---|
| ffmpeg + ffprobe (essentials 9.0.2) | ~200 MB | per-file GitHub limit is 100 MB |
| whisper.cpp CLI + DLLs (b5454) | ~10 MB | fetched with the rest |
| sherpa-onnx diarization runtime (v2.0.0) | ~17 MB | fetched with the rest |
| `ggml-medium-q5_0.bin` speech model | 514 MB | far above the limit |
| pyannote segmentation + 3D-Speaker embedding | ~33 MB | fetched with the rest |

**Design notes worth knowing**

- Long captures are recordings, not frame piles: one hour at 30 fps is 108,000 frames,
  which only makes sense as a video the reader samples afterwards.
- `screen_capture` never samples down. It keeps every frame, writes a `manifest.json`,
  attaches a batch, and tells you exactly how many frames are still unread.
- Window capture crops the composed desktop by the window's bounds: GDI cannot read the
  D3D surface of a hardware-composited window, so `gdigrab -i title=` returns black frames.
- `screen_watch` compares a 64×40 grayscale sample (2,560 bytes) and only spends a
  full-size frame and a wake-up when the change exceeds the threshold.

**License** MIT.

---

让智能体真正“看”和“听”视频：一次调用即可拿到容器与流信息、可直观看清的关键帧拼版、逐帧大图路径、内嵌或同名字幕，以及**带说话人标签的多语种转写**（S1/S2/… 谁在第几秒说了什么）。

全部在本机处理：视频不上传、不联网、不依赖云服务。插件 = Harness Host 插件 + ffmpeg / whisper.cpp / sherpa-onnx 与模型（由插件自动下载，不入库）。

### 依赖：首次使用自动补齐（1.8 起）

`tools/`、`models/` 不入库，插件会自己补齐：

- 首次需要时（`video_read` / `video_frames` / `screen_capture`）自动把缺的组件下到 `%LOCALAPPDATA%\dsh-video-reader\{bin,models}`，装好再继续本次调用；
- 每个文件都按 `lib/deps.js` 里钉死的版本与 sha256 校验，校验失败的文件直接丢弃、不会安装；
- GitHub 域名不可达时默认走 `gh-proxy.com` 镜像（`dependencyMirror`）；
- 设置页「依赖组件」可看状态、手动安装、关掉自动安装；
- 也可以用工具 `video_reader_setup` 显式检查/安装，或提前跑 `scripts/setup.ps1`。

## 工具

### `video_reader_setup`

| 参数 | 说明 |
|---|---|
| `action` | `status`（只读报告）或 `install`（下载缺失组件） |
| `components` | `ffmpeg` `whisper` `whisper-model` `sherpa` `diarization-models`，或简写 `models` / `binaries` / `all`（默认） |
| `mirror` | GitHub 下载是否优先走 gh-proxy 镜像；默认取设置页 |

返回每一项的就绪状态、安装位置、版本，以及安装耗时/体积。视频类工具在缺依赖时会先自动安装再继续，所以这个工具主要用于提前体检或重试失败的下载。

### `video_read`

| 参数 | 说明 |
|---|---|
| `path` | 视频/音频路径，绝对或相对会话工作目录 |
| `frames` | 抽帧数量，默认 12，0–40，`0` 只要元数据/转写 |
| `mode` | `even`（默认）或 `scenes`（按镜头切换） |
| `start` / `end` | 只看某段，支持 `90`、`1:30`、`00:01:30` |
| `transcript` | 是否转写，默认 true |
| `language` | 强制语种，如 `zh` `en` `de` `ja` `ko` `fr` `ru`；默认 `auto` 自动识别 |
| `speakers` | 已知说话人数（0 = 自动推断）；给出时聚类更稳 |
| `diarize` | 是否标说话人，默认 true |
| `subtitles` | 是否提取内嵌/同名字幕，默认 true |
| `width` | 单帧宽度，默认 960，0 = 原尺寸 |

输出现场：

```
## Speech transcript (auto-detected, 6 turns, 2 speakers: S1/S2)
talk time: S1 0:10 · S2 0:07
[S1] 0:00–0:05  大家好，今天我们讨论视频阅读器的测试结果。
[S2] 0:06–0:09  我觉得识别准确率比之前好多了。
...
full timestamped SRT: …\transcript.srt
```

拼版图片会作为图片内容直接进模型上下文（每格左上角烧入时间码），同时给出每帧全尺寸图路径。

### `video_frames`

按时间点抓全宽大图，一次最多 8 张，用于复查细节。

### `screen_capture`

看一眼**当前桌面**（实时屏幕），不是磁盘上的文件。

| 参数 | 说明 |
|---|---|
| `seconds` | 抓取窗口秒数，0 = 单张截图，最大 30 |
| `fps` | 采样帧率 1–30（默认取自设置页）。实测 2560×1600 下 gdigrab 能稳定跑到 ~28 fps、上限 ~56 fps；单次抓取总帧数封顶 240 |
| `region` | `full` / `window:<标题片段>` / `x,y,w,h`；不传则用设置页的默认值 |
| `frames` | 拼版最多保留几帧（默认 12） |
| `width` | 每帧宽度 |
| `mouse` | 是否把鼠标指针画进去 |

返回同样是一张可直接看的拼版 + 每帧路径。**抓取是采样**：模型看到的是这 N 秒内实际存在的若干帧，不是持续视频流——所谓“实时看视频”，就是“按 2–5 fps 采样一段时间”。

## 屏幕捕获设置页

Web UI 里 **设置 → 视频阅读器** 提供图形化配置：允许/禁止抓屏、整屏 / 指定窗口 / 自定义区域、帧率、默认时长、每帧宽度、是否包含鼠标指针，并带「抓一帧预览」按钮直接确认范围。

设置在保存后立即生效（工具每次调用都会重新读取），也可以直接改 `%LOCALAPPDATA%\dsh-video-reader\screen-settings.json`。

抓取方式的实现要点：

- **整屏**：`gdigrab -i desktop`，对 GPU 合成的浏览器、播放器同样有效
- **窗口**：先枚举窗口拿到坐标，再按该矩形裁剪桌面。不能直接用 `gdigrab -i title=`，因为 GDI 读不到 D3D 合成窗口，会得到黑帧
- **区域**：`-offset_x/-offset_y/-video_size`
- 窗口标题是**子串匹配**，填稳定片段（如 `Microsoft Edge`），因为播放页的完整标题会随页面变化

### 实测帧率（2560×1600 桌面，JPEG 落盘）

| 目标 fps | 实际产出 | 说明 |
|---|---|---|
| 10 | 9.1 fps | |
| 20 | 18.8 fps | |
| 30 | 28.5 fps | 插件上限，够覆盖 24–30fps 的视频 |
| 40 | 37.9 fps | |
| 60 | 56.6 fps | 受 JPEG 编码/写盘限制，不是采集 API 的瓶颈 |

单张全屏截图（含进程启动）约 **173 ms**。ddagrab（Desktop Duplication）同分辨率下 60 目标也只有 55.5 fps，与 gdigrab 基本持平，因此插件统一用 gdigrab，避免给窗口/区域模式再分一套实现。

看视频场景建议 15–24 fps；看游戏或快速动画再上 30。总帧数封顶 240（`seconds × fps ≤ 240`），超了会自动降 fps 并在结果里注明。


## 语种与识别

单个多语种模型（whisper `medium-q5_0`，99 种语言），不需要按语种换模型。

本机实测：

| 语种 | 素材 | 结果 |
|---|---|---|
| 中文 | Windows 原生 TTS 双人对话 | 逐句全对，两名说话人分对 |
| 英文 | 原生 TTS + espeak | 全对 |
| 德文 | espeak | “Das **Wetter** ist heute schön. Wir gehen im Park spazieren.” 全对 |
| 法文 | espeak | “Le temps est bon aujourd'hui, nous allons nous promener dans le parc.” 仅一处冠词差异 |
| 俄/日/韩 | — | 模型原生支持（99 语种），本机没有可用素材，未实测 |

## 说话人分离

`sherpa-onnx` 离线分离：pyannote 分段模型（5.7MB）+ 3D-Speaker 声纹嵌入（27MB）+ 聚类，不联网、CPU 即可。57 秒 4 人素材实测分离正确（S1–S4），速度约为实时 20 倍。

- 每句转写按时间重叠度归到说话人，连续同人语句合并成一 "turn"
- 输出附带各说话人发言总时长
- 已知人数时传 `speakers` 会显著更稳（尤其 3 人以上）

## 配置

```yaml
- insert:
    - id: video-reader
      name: '@local/dsh-video-reader'
      config:
        frames: 12
        columns: 4
        frameWidth: 960
        tileWidth: 320
        maxTextChars: 12000
        maxTranscriptSeconds: 900
        languages: auto
        cacheDir: .dsh-video-cache
        diarize: true
        speakers: 0              # 0 = 自动
        diarizationThreshold: 0.5
        # 依赖自动安装（1.8 起）
        autoSetup: true          # 首次使用时自动下载缺失的 ffmpeg / 运行时
        autoSetupModels: true    # 连语音与分离模型（~547 MB）也自动下载
        dependencyMirror: true   # GitHub 域名不通时走 gh-proxy.com 镜像
        # 路径覆盖（留空则用随包二进制）
        ffmpegPath: ''
        ffprobePath: ''
        whisperPath: ''
        whisperModel: ''
        diarizationPath: ''
        segmentationModel: ''
        embeddingModel: ''
```

## 体积

| 组成 | 大小 |
|---|---|
| ffmpeg + ffprobe（essentials 构建） | 201 MB |
| whisper.cpp + sherpa-onnx 运行时 | 27 MB |
| 识别模型 medium-q5_0 | 514 MB |
| 分离模型（分段 + 声纹） | 33 MB |
| 代码/资源 | < 0.1 MB |
| **合计** | **约 778 MB** |

想更准可以换 `ggml-large-v3-q5_0.bin`（1031 MB，俄/日/韩明显更好）放进 `models/` 即可，代码会自动优先选它。想更小可以换 `ggml-small.bin`（465 MB），代价是德/俄/日/韩准确率下降。

> `ggml-large-v3-turbo-q5_0.bin` 经实测在本机两个 whisper.cpp 构建上都无法加载（`unknown tensor ''`），文件 sha256 与官方一致，属模型与构建的格式兼容问题，故默认不采用。

### `screen_record`

长时采集走录制而不是堆截图：**1 小时 × 30fps = 108,000 帧**，只有视频形态才合理。

| 参数 | 说明 |
|---|---|
| `action` | `start` / `stop` / `status` |
| `id` | `stop` 时指定要停的录制 id |
| `seconds` | 最长时长，默认 3600（1 小时），上限 7200 |
| `fps` | 1–30，默认 30 |
| `region` | 同 `screen_capture`，默认用设置页的选择 |
| `maxMB` | 文件大小上限，默认 2000MB，到顶自动停 |
| `width` | 编码前缩放宽度，默认 1280 |

录制在后台跑（不阻塞对话），返回 id 和 `.mkv` 路径；`stop` 后直接用 `video_read` 采样任意片段。

**实测码率（2560×1600 桌面，30fps）**：

| 编码参数 | 码率 | 1 小时 |
|---|---|---|
| 原生尺寸 · crf26 · ultrafast | 7.7 GB/h | 太大 |
| 原生尺寸 · crf30 · veryfast | 1.05 GB/h | 偏大 |
| **1280 宽 · crf30 · veryfast（默认）** | **354 MB/h** | 1 小时约 0.35 GB |

## 选择要抓的软件界面

设置页的「指定窗口」是一个**自动列出当前所有可见窗口**的下拉框（进程名 + 标题 + 分辨率），带「刷新窗口列表」按钮，不用手打标题。

选中的窗口会同时保存 `windowTitle` 与 `windowProcess`；抓取时按 **精确标题 → 标题子串 → 进程名** 的顺序解析，所以浏览器换页面、标题变了也能命中同一个进程。窗口不在了会直接报错并列出当前可选的窗口，而不是给一张黑图。

抓窗口的实现是「先取窗口坐标，再裁剪合成后的桌面」——因为 GDI 读不到 GPU 合成窗口的 D3D 表面，`gdigrab -i title=` 对浏览器/播放器只会得到黑帧。

## 缓存

帧、拼版、字幕、wav、SRT 写在 `<会话工作目录>/.dsh-video-cache/<文件名>-<内容哈希>/`，保留最近 20 个媒体目录，可整删。

## 边界

- 位图字幕（PGS/VobSub）无法转文字，会标注跳过
- 转写同步执行：turbo/medium 在 CPU 上约实时 1–3 倍；超过 `maxTranscriptSeconds` 需自己传 `start`/`end` 分段
- 说话人分离是聚类结果，人数未知且音色接近时可能多分/少分；给 `speakers` 可缓解
- whisper 系模型对纯合成音（如 espeak）不代表真实口语表现
- 抓屏会包含屏幕上一切可见内容（聊天、验证码、密码框），默认整屏；需要隔离就用窗口/区域模式
- DRM、受保护视频、部分全屏独占的游戏在 GDI 下可能黑屏；独显直连/多显示器时坐标要按实际桌面
- 抓屏是采样而非录制：`seconds × fps` 决定能看清多少变化，动作太快（如 60fps 游戏）需要调高 fps 或缩短窗口

## 两条读取路径（1.6 起）

### 1. 全帧读取：不抽样

`screen_capture` 保留每一帧、写入 `manifest.json`，并把帧按批（默认 20 张/次）作为图片返回：

- 返回里带 `totalFrames` / `readFrames` / `remainingFrames`
- `remainingFrames > 0` 时结果明确写出下一步：`screen_frames_read {manifest, offset, count}`
- 拼版只在 `sheet: true` 时生成，且仅作总览，不再替代逐帧阅读

算一下就知道为何要分批：30 秒 × 30fps = 900 帧，每帧约 800 token，全读约 72 万 token，单轮装不下。插件保证“一帧不少地落盘、可按批读完”，同时保留 240 帧采集预算（`fps` 会被压到 240/seconds）。

### 2. 实时通道：`screen_watch`

| 参数 | 说明 |
|---|---|
| `action` | `start` / `stop` / `status` |
| `intervalMs` | 采样间隔，默认 2000ms |
| `threshold` | 判定“变了”的归一化差异，默认 0.02 |
| `maxMinutes` | 自动停止，默认 30 分钟 |

每次抓一张 64×40 灰度小图（2560 字节）算平均绝对差；超过阈值才抓全尺寸帧存盘，并主动唤醒模型（`agent.inject` + `agent.followup`）。唤醒失败时事件留在队列，用 `action:"status"` 抽取，不丢观察。

实测：3 秒内壁纸变化一次，检测 1 次、唤醒 1 次、误报 0。