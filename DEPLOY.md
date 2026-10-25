# 部署与依赖清单（dsh-feiyu v0.4.0）

> 这份文档回答一个问题：**要复现这只大肥鱼，需要装什么、什么版本、放在哪、怎么验证**。
> 版本号取自 2026-10-25 实际跑通的那台机器（Windows 11 / x64 / RTX 显卡）。

---

## 一、最小可用集（只聊天，不做语音/生图/视频）

| 组件 | 版本 | 用途 | 位置 / 获取 |
|---|---|---|---|
| **DSH 桌面端** | `0.2.1-rc.2`（`@deepseek-ai/dsh-desktop-runtime`） | 宿主：会话、系统提示、设置面板、模型 | 官方安装包 |
| **Node.js** | `v24.21.0` | 工具链运行时（DSH 自带一份同版本） | DSH 运行时自带：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/` |
| **DeepSeek API** | `deepseek-chat`（`https://api.deepseek.com/v1`） | QQ / 抖音私信 / 微信 的实时对话 | 充值后填 `llm.api_key` |
| **B站凭据** | Cookie（`SESSDATA` + `bili_jct` + `buvid3`） | B站刷视频/评论 | 浏览器 F12 → Application → Cookies |
| **本插件** | `0.4.0` | 就是本仓库 | `dsh plugin --profile desktop add "link:<repo>"` |

装完即可用：B站刷视频、QQ 聊天（无表情包/无语音）、记忆、面板。

---

## 二、QQ 通道（NapCat）

| 组件 | 版本 | 说明 |
|---|---|---|
| **QQNT 客户端** | `9.9.20-36330`（内置 `qqnt.json` 目标 `9.9.22-40990`） | NapCat 注入宿主 |
| **NapCatQQ** | **`NapCat.Onebot 4.18.41`**（OneBot **v11**） | 通过 `NapCatWinBootHook.dll` + `NapCatWinBootMain.exe` 注入 |
| 启动方式 | `D:\napcat\launcher-user.bat`（需管理员） | 本插件注册计划任务 `DSH-Feiyu-NapCat`（`RunLevel Highest`），随 DSH 起停 |
| HTTP 上报 | `http://127.0.0.1:8080/onebot`，`messagePostFormat=array` | qq-server 的入口 |
| 验证 | `curl http://127.0.0.1:3000/get_version_info` | 应返回 `"app_version":"4.18.41"` |

> NapCat 挂了的表现：`/health` 里 `napcat.ok=false`、`qq-server.log` 每 30s 报「网关不通」。
> 修复：`schtasks /Run /TN "DSH-Feiyu-NapCat"`（不用 UAC 交互）。

---

## 三、抖音通道

| 组件 | 版本 | 说明 |
|---|---|---|
| **Python** | `3.12.0`（独立 venv） | `D:\social-auto-upload\.venv\Scripts\python.exe` |
| **patchright** | `1.58.2` | 反检测版 Playwright，抖音用 `patchright.async_api` |
| **requests** | `2.32.3` | 下载/上传 |
| **loguru** | `0.7.3` | 日志 |
| **opencv-python** / **numpy** | venv 自带（numpy 1.x） | 视频帧处理 |
| **qrcode** / **segno** | venv 自带 | 扫码登录 |
| **social-auto-upload** | 本机包（`social_auto_upload`） | 抖音页面上传/互动骨架 |
| **Chrome** | `156.0.8078.47` | patchright 用它的内核；CDP 模式用 `--remote-debugging-port=9222` |

脚本：`douyin_interact.py`（子命令 `feed / comments / comment / reply / comment-reply / self-info / my-videos / dm-send / dm-read / dm-list / login / cdp-start`）

> 登录态：`~/.feiyu-ai/douyin-cookies.json`；当前登录号 **顾思苡**（`sec_uid` 由 `feiyu douyin self` 读出并缓存到 `~/.feiyu-ai/douyin-self.json`）。

---

## 四、微信通道

| 组件 | 版本 | 说明 |
|---|---|---|
| **Python** | `3.12.0`（独立 venv） | `D:\wechat-bot\.venv\Scripts\python.exe` |
| **微信 PC 客户端** | 4.x（UI 自动化） | — |
| **uiautomation** | `2.0.29` | 读窗口控件、点按输入 |
| **comtypes** | `1.4.17` + **pywin32** `312` | COM / 窗口句柄 |
| **psutil** | `7.2.2` | 进程探活 |
| **Pillow** | `13.0.0` | 图片消息 |

脚本：`D:\wechat-bot\wechat_bot.py`（本仓库 `wechat/` 下有副本，运行的是 `D:\wechat-bot\` 那份）

---

## 五、语音克隆（说话 / 语音条）

| 组件 | 版本 | 说明 |
|---|---|---|
| **GPT-SoVITS** | commit `b4570b8`（2026-10-19，API v2 语义流式切分） | `D:\GPT-SoVITS` |
| 关键依赖 | `numpy<2.0`、`librosa==0.10.2`、`pytorch-lightning>=2.4`、`gradio<5`、`ffmpeg-python` | 见 `requirements-tts.txt` |
| API 服务 | `api_v2.py` → `http://127.0.0.1:9880/tts` | 插件启动时自动拉起 + 每 60s 探活 |
| 零样本参考音 | `D:\GPT-SoVITS\models\yinlang\yinlang.wav`（+ `prompt_text`/`prompt_lang`） | 当前配置用的就是它 |
| 训练权重（可选） | `models\sunshine_girl\{sunshine_girl.ckpt, .pth}` | 训练过的音色，换成 `sovits_path`/`gpt_path` |
| 调用链 | `qq-server` 摇中语音 → `lib/tts.mjs` POST `/tts` → 得 wav → NapCat `record` 段发出 | 失败自动降级纯文字 |

发送段：`{ "type": "record", "data": { "file": "<wav>" } }`

---

## 六、唱歌（原创 / 翻唱）

**诚实说明**：GPT-SoVITS 是**说话**引擎，不是歌声合成（本机没装 SVC 引擎）。所以：

| 模式 | 实现 | 命令 |
|---|---|---|
| **原创** | 用 GPT-SoVITS 按"说唱/旋律"的节奏念白式合成 + WAV 拼接调音（`lib/sing.mjs` 自带 RIFF/PCM16 读写） | `feiyu sing "主题"` |
| **翻唱** | 真歌 → **yt-dlp** 取音轨 → **ffmpeg** 转 44.1k 双声道 → **RVC** 换她的音色 → ffmpeg 混回伴奏 | `feiyu sing cover "歌名"` |

| 组件 | 版本 | 位置 |
|---|---|---|
| **RVC（Retrieval-based-Voice-Conversion-WebUI）** | 本机部署（含 realtime VST 变体目录） | `D:\rvc\RVC` |
| Python | `3.12.0`（venv：`D:\rvc\venv`） | — |
| **torch / torchaudio** | `2.7.1+cu128` | CUDA 12.8 |
| **faiss-cpu** | `1.15.1` | 检索索引 |
| **librosa** | `0.10.2.post1` | 特征 |
| **numpy** | `1.26.4` | — |
| **soundfile** | `0.14.0` | 读写 |
| **praat-parselmouth** | `0.4.7` | F0 |
| **yt-dlp** | `2026.10.21` | 取源歌 |
| **ffmpeg** | `7.1-essentials_build-ghyan`（GPT-SoVITS 自带） | `D:\GPT-SoVITS\runtime\ffmpeg.exe` |
| **ffprobe** | RVC 自带 | `D:\rvc\bin\ffprobe.exe` |
| 她的音色模型 | `D:\rvc\RVC\assets\weights\feiyu-rose.pth`（+ `_e50/_e100/_e125/_e150` 各轮次） | v2 40k |
| 底模 | `assets\pretrained_v2\{f0G40k,f0D40k,f0G48k,f0D48k}.pth` | RVC 预训练 |

产物落在她的工作目录，可直接发 QQ（`sendQQ` 用 NapCat `record` 段）。

---

## 七、生图 / 表情包

| 用途 | 模型 / 服务 | 版本或标识 | 归属 |
|---|---|---|---|
| **形象锁定编辑**（表情包、视频分镜） | `Qwen/Qwen-Image-Edit-2509` | 硅基流动 API | `imageGen.model` |
| **兜底文生图**（不进图库） | `flux`（Pollinations） | `image.pollinations.ai` | 免费、无需 key |
| **视觉理解**（看图说话、判断形象是否一致） | `Qwen/Qwen3-VL-8B-Instruct` | 硅基流动 API | `vision.model` |
| 参考图上传（Pollinations 需要公网 URL） | `tmpfiles.org` API | — | 60 分钟过期自动重传 |
| 本地文字贴纸 | Pillow 画的 PNG | `tools/lib/sticker_render.py` | 不联网 |

**根本形象链**：`~/.feiyu-ai/sticker-ref.jpg` + `sticker-refs/ref-{哭,举手,得意,微笑}.jpg`（按文案情绪自动挑）→ 硅基 `images/generations`（`image: <dataURI>`）→ 存 `~/.feiyu-ai/stickers/<标签>/sf-*.jpg`

规则（写进代码了）：

- `sf-*` = 硅基 + 参考图 → **只发这种**
- `px-*` = Pollinations 兜底 → **永不入库、永不发送**
- `pickSticker()` 过滤 `px-`；`autoTag()` 认不出情绪只在「开心/无语/比心」里选

成本参考：`≈¥0.25/张`（1024px，带中文气泡）。

---

## 八、做视频（produce 投稿包）

| 环节 | 实现 | 依赖 |
|---|---|---|
| 1. 策划 | DeepSeek `deepseek-chat` 出脚本/分镜 | `llm` |
| 2. 配图 | 硅基 `Qwen-Image-Edit-2509`（锁她的形象）× N 张 | `imageGen` |
| 3. 旁白 | GPT-SoVITS `/tts` 念旁白（她的音色） | `voice` |
| 4. 成片 | **ffmpeg** 图片序列 + 音频 → mp4 | `D:\GPT-SoVITS\runtime\ffmpeg.exe` |
| 5. 落地 | `~/.feiyu-ai/douyin-posts/<日期-标题>/`（`img-*.jpg` + `narration.wav` + `video.mp4` + 文案） | — |
| 6. 发布 | **她不能自己发** —— 成片等你在面板点发布 | 设计如此 |

```bash
node tools/feiyu.mjs produce ["主题"]     # 每天有额度（douyin.produce.dailyMax）
```

---

## 九、上网（她自己的手脚）

| 组件 | 版本/端点 | 说明 |
|---|---|---|
| 搜索引擎 | Bing（`cn.bing.com`）+ DuckDuckGo（`html.duckduckgo.com`） | 双源兜底，抓不到就换 |
| 网页抓取 | `fetch` + 本地代理 | Clash `http://127.0.0.1:7897` |
| 常驻进程 | `feiyu.mjs web roam`（`web.roam.enabled`） | 完全自由开着时死了自动拉起（60s） |
| 记忆 | 搜索/读页/写小说/自我升级 全部 `remember(platform=web)` | 面板可见、可作为她的"行为记忆" |

---

## 十、端口一览

| 端口 | 谁 | 必需 |
|---|---|---|
| `8080` | `qq-server`（OneBot 上报入口） | QQ 通道 |
| `8095` | `douyin-dm-server`（抖音私信陪聊） | 抖音私信 |
| `3000` | NapCat HTTP | QQ 通道 |
| `9880` | GPT-SoVITS `api_v2.py` | 语音 / 唱歌 / 视频旁白 |
| `9222` | Chrome CDP（可选，抖音真发评论用） | 可选 |
| `7897` | Clash / 系统代理 | 生图兜底、上网 |
| `65466` | DSH Web GUI（每次重启会变） | — |

---

## 十一、安装顺序（照这个走不会卡）

```powershell
# 0) 前置：DSH 桌面端 + Node 24（DSH 自带）+ Python 3.12 ×3 个 venv

# 1) 插件
dsh plugin --profile desktop add "link:D:\dsh-feiyu"
#    重启 DSH → 设置里出现「🐟 大肥鱼」

# 2) 最小配置 ~/.dsh/feiyu.config.json
#    identity / owner.qq / llm.api_key  → 面板里填也行

# 3) B站凭据
#    浏览器 F12 拷贝 SESSDATA/bili_jct/buvid3 → POST /dsh-feiyu/api/cookie
node tools/feiyu.mjs nav            # 验证登录态
node tools/feiyu.mjs selftest       # 全量体检

# 4) QQ
#    装 QQNT 9.9.20+ → NapCat 注入（管理员）→ 面板点「启动 QQ 服务」
#    curl http://127.0.0.1:3000/get_version_info   # 看 4.18.41

# 5) 抖音
D:\social-auto-upload\.venv\Scripts\python.exe douyin_interact.py login
node tools/feiyu.mjs douyin self     # 记下自己的 sec_uid
node tools/feiyu.mjs douyin my-videos

# 6) 语音（可选）
#    GPT-SoVITS 装好 → python api_v2.py（9880）→ 面板「音色」试听
node tools/feiyu.mjs voice list

# 7) 唱歌（可选）
#    RVC 装好 → assets/weights 放她的 .pth → 确认 ffmpeg/ffprobe 路径
node tools/feiyu.mjs sing cover "天黑黑" --dry

# 8) 生图 / 表情包（可选）
#    硅基 key → imageGen.api_key；参考图 → ~/.feiyu-ai/sticker-ref.jpg
node tools/feiyu.mjs sticker gen "本鱼饿了" --tag 开心

# 9) 最后开自主行为
#    面板：完全自由 ON、每日回顾 ON、主动搭话 ON、干跑 OFF
```

验证清单（一条条打勾即可）：

```powershell
node tools/feiyu.mjs selftest                 # 全绿
curl http://127.0.0.1:8080/health             # napcat.ok=true
curl http://127.0.0.1:8095/health             # failStreak=0
node tools/feiyu.mjs mem stats                # episodes/facts/lore 都有数
node tools/feiyu.mjs mem recallall --chat qq:<你的号>   # 跨通道记忆块能装配出来
npm test                                      # 8 套测试全过
```

---

## 十二、模型/服务一览（改配置时对照）

| 配置键 | 当前值 | 作用 | 换掉会怎样 |
|---|---|---|---|
| `llm.model` | `deepseek-v4.1-flash-1017` | 所有实时对话 | 关掉 `params.enable_thinking` 会慢 3~14 倍 |
| `llm.base_url` | `https://maas.qianwenaiapi.com/compatible-mode/v1` | OpenAI 兼容端点 | 可换任何兼容服务（含本地 vLLM）；主挂自动落 `llm.fallback` |
| `vision.model` | `qwen3-vl-plus` | 看图（表情包形象校验、图片消息理解） | 换更强的 VL 更准；主挂自动落 `vision.fallback` |
| `imageGen.model` | `Qwen/Qwen-Image-Edit-2509`（另有三段兜底：`imageGen.qwen.model` → Pollinations） | 锁形象生图 | 换成纯文生图会丢形象一致性 |
| `imageGen.refImage` | `~/.feiyu-ai/sticker-ref.jpg` | 根本形象 | 换图 = 换她的长相 |
| `voice.sovits_url` | `http://127.0.0.1:9880/tts` | 说话 | — |
| `voice.ref_audio_path` | `D:/GPT-SoVITS/models/yinlang/yinlang.wav` | 零样本参考音 | 换音色 |
| `voice.prompt_text` | 参考音的原话 | GPT-SoVITS 需要 | 必须与参考音一致 |
| `rvc.ffmpeg` | `D:/GPT-SoVITS/runtime/ffmpeg.exe` | 翻唱/视频合成 | 换成系统 ffmpeg 也行 |
| `rvc.python` | `D:/rvc/venv/Scripts/python.exe` | RVC 推理 | — |
| `web.proxy` | `http://127.0.0.1:7897` | 生图兜底/上网 | 国内直连会被墙（实测 HTTP 000） |

---

## 十三、常见失败与真因

| 现象 | 真因 | 处置 |
|---|---|---|
| 表情包出来不是鲸鱼娘 | 硅基失败走了 Pollinations 兜底 | 看 `~/.feiyu-ai/imggen.log`；`sf-` 才是根本形象 |
| 语音没声音 | GPT-SoVITS 9880 没起 | 插件会自动拉；或手动 `python api_v2.py` |
| 翻唱跑一半失败 | yt-dlp 取不到源 / ffmpeg 路径不对 | `feiyu sing cover "歌名" --url <直链>` 绕开搜索 |
| 生图 502 / 超时 | 硅基额度或网络 | 会回落 Pollinations（只作临时图，不入库） |
| 抖音评论"发成功"却没内容 | 新号在**别人**视频下回复被审核吞 | 先在自己作品下互动；或等号养起来 |
| 抖音私信不回 | `failStreak` 上升 / 抓不到新消息 | `curl 8095/health`，看 `douyin-dm.log` 里「主人：」 |
| 完全自由不动 | ① 摇号没中 ② 模型额度 429 | `feiyu-freedom.json` / 会话最后几帧 |
| QQ 服务在跑却不回 | NapCat 掉了（`napcat.ok=false`） | `schtasks /Run /TN "DSH-Feiyu-NapCat"` |

---

## 十四、磁盘占用参考（本机实测）

| 目录 | 大小 | 说明 |
|---|---|---|
| `D:\GPT-SoVITS` | 数 GB | 含 runtime + 底模 |
| `D:\rvc` | 数 GB | torch cu128 + 底模 + 她的 .pth |
| `D:\social-auto-upload` | 数百 MB | patchright + venv |
| `~/.feiyu-ai` | 数十 MB | 记忆 / 表情 / 日记 / 凭据 |
| `~/.dsh/sessions` | 随聊天增长 | 她的会话（完全自由痕迹） |
