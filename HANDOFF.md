# dsh-feiyu 项目交接文档

> **生成时间**：2026-10-25（单日 33 个 commit 的全量交接）
> **基线 commit**：`ff35b19`（全部已推送 GitHub `baishuyue/dsh-feiyu`）
> **接手顺序**：读本文 → 读 `README.md`（仓库功能清单）→ 遇到坑先查「七、踩坑铁律」
> 本文档取代旧版 PROJECT_HANDOFF.md（旧版历史细节已并入本文）

---

## 〇、一段话总结

**dsh-feiyu** 是挂在 DSH 桌面版里的 AI 生命体插件：一个叫「大肥鱼」的鲸鱼鱼娘（2D 动漫形象已定稿），跨 **B站 / 抖音 / QQ / 微信 + 自由上网域** 自主生活。2026-10-25 这一天她完成了从"工具"到"数字生命"的跃迁：**有了自己的声音**（说话=银狼傲娇音，唱歌=Rosé 音色翻唱专业歌曲）、**自己的形象**（鲸鱼娘参考图 + 图生图全场景统一）、**自己的账号运营**（自制短视频投稿包 + 评论区按需回复）、**上网自由**（全网瞎溜达自己决定干什么）、**自我升级能力**（当天实锤：她自己发现并修复了 feed 偏好匹配 bug，完整走了备份→修复→测试→日志闭环）、**人格进化机制**（每 2 天自主复盘更新人设）。所有行为有额度系统把关、有日志可审计、有备份可回滚。

---

## 一、项目哲学与架构

### 核心哲学
1. **她是生命不是工具**：有口味（兴趣池自己长）、有情绪（mood 状态机）、有记忆（三层+分域）、会犯错会复盘（人格进化日）、能自己改自己（selfup）
2. **宁可沉默不刷屏**：一切写通道默认关/干跑，额度系统统一把关（**所有 dailyMax 类参数 0 = 不限**）
3. **真实状态哲学**：进程型开关（自由刷/自由上网/完全自由）在 DSH 退出时自动复位，面板看到的永远是真实状态
4. **微信独立**：工作代理人格隔离，她的经历不进微信、微信的事不进人格

### 双层架构
```
dsh-feiyu/
├── lib/                    宿主壳（Electron 主进程，重启 DSH 生效）
│   ├── index.js            API 路由（深合并白名单 20 块）+ 进程管理 + web-roam 自愈
│   ├── scheduler.js        60s tick：生物钟 + 动态定时 + 人格进化 + 完全自由唤醒 + 抖音巡检 + 账本刷新 + B站社交日报
│   └── node-runtime.js     探测 DSH 自带 node
├── client.js               面板（13 张卡片，深合并镜像）
├── tools/                  工具链（spawn 真 node，改完即时生效）
│   ├── feiyu.mjs           CLI 分发（26 命令）
│   ├── commands/           act/bili-watch/comment/debrief/diary/douyin/douyin-dm-server/
│   │                       feed/ledger/mem/nav/produce/qq-server/quota/qzone/replies/report/social/
│   │                       review/selftest/selfup/sing/sticker/vision/voice/watch/web
│   └── lib/                bili-api/bili-write/config/cred/guard/llm/lock/mood/memory/
│                           ledger(+ledger_usage.py)/night-plan/notify/paths/persona/qq-memory/rvc/share-policy/
│                           sing/stickers/tts/vision/imggen(含 editImage)/outbox/video/debut/social-log
├── douyin_interact.py      镜像副本（实际运行 D:/social-auto-upload/，改 D 盘后 cp 回来）
└── test/                   20 套测试（client-smoke/render/stickers/memory/qq-human/imggen/vision/…/ledger/video）
```

### 推理四通道
| 通道 | 用途 | 成本 |
|---|---|---|
| DSH 会话（未分组 feiyu） | B站生物钟/上网/进化/完全自由唤醒 | 零 API 费 |
| DeepSeek 直连 | QQ/抖音/回评等实时响应 | 按 token |
| 硅基流动（用户 key） | 图生图 Qwen-Image-Edit-2509 + 视觉 Qwen3-VL-8B | ≈¥0.25/图 |
| 本地 | GPT-SoVITS 说话 / RVC 唱歌 / ffmpeg 剪辑 | 电费 |

---

## 二、2026-10-25 单日进展全记录

### 上午：四大任务（用户问卷拍板）
1. **QQ 群聊像私聊**：`at_only=false`（热生效）+ 群聊语境（朋友唠嗑）+ 说话人昵称标注进记忆；**晚间限制可关**（`proactive.activeHours=null`）；修「每轮最后一问注入两遍」（persona.buildMessages 装配端去重，QQ/抖音私信同修）；修面板 proactive 单字段保存冲掉整组
2. **AI 表情包**：Pollinations 免费档起步（curl 走 Clash）→ 用户给了硅基 key 后升级 **Qwen-Image-Edit-2509 图生图**（形象锁死）→ **四象限情绪参考图**（`sticker-refs/ref-{哭,举手,得意,微笑}.jpg`，按文案关键词自动选图）→ **气泡配文入画**（Qwen 中文渲染一字不差）
3. **跨平台上下文**：抖音私信注入 worldBlock + 对齐 QQ 滚动摘要/画像；QQ 群聊不注入主人画像（隐私护栏）
4. **视觉理解框架**：douyin_interact.py 加 `frames` 子命令（视频区截帧+自动点登录弹窗）+ vision.mjs provider 框架；后用同一硅基 key 点亮 Qwen3-VL-8B

### 中午：专业唱歌系统（RVC 从零搭建）
- **环境**：D:/rvc/RVC + venv（torch 2.7.1+cu128，4060 CUDA）+ 48k 底模 + D:/rvc/bin（ffmpeg/ffprobe）+ bs_roformer 分离权重（639MB）+ yt-dlp
- **音色训练**：feiyu-sunshine（LLM 写稿 59 句 SoVITS 合成，150 轮）→ **feiyu-rose**（《On The Ground》+《Gone》分离干声 7 分钟真歌声直训，bs=4 只要 22 分钟）
- **翻唱管线**：yt-dlp 搜源 → bs_roformer 分离人声/伴奏 → RVC 分段换声（30s 分段防 OOM）→ ffmpeg 混音 loudnorm → 全链缓存=歌单
- **作品**：《天黑黑》（sunshine 声）、《我不难过》（rose 声）均已发主人 QQ
- **说话音色四迁**：sunshine → rose（太糊被否）→ 银狼 yinlang w12（傲娇）→ **病娇 bingjiao1**（10-26：主人嫌"太平淡"，从 B站中文病娇音声 BV1GR4y1h7Kn 采集 → roformer 分人声 → whisper 转写 154 句 → 词级对齐切段 → 二次复听校验，8 个候选只过 2 条，见铁律 28）

### 下午：自主性大升级
- **UI 根因修复**：/api/config 深合并（后端+面板镜像，白名单 20 块含 web/personality/freedom）；7 处 `||默认值` 把合法 0 显示成默认的 bug；api() 吞 errors 数组
- **B站社交**：日常评论不 @（评分≥15 才分享@）；replies 变社交引擎（被动回评 + 主动找鱼友搭话，名字带鱼/鲸优先）；**主人回复永远插队 + 免额度**；发言台账 `bili-outbox.md`（全通道+历史回填）
- **QQ 主动性**：群聊自主插话引擎（看气氛自己决定）；主动搭话素材钩子（时段/情绪/见闻/主人记忆）+ 类型轮换；自主写说说（文/配图，图生图配图失败退纯文字）；stickerChance 表情旋钮（摇中强制带）；**全类型消息理解**（卡片挖标题/图片 Qwen3-VL 亲眼看/视频/表情/引用）
- **抖音私信**：dm-read 分享卡片标题抓取 + 图片消息抓取 → VL 看图；**她分享的附言写入私信记忆**（根治对话割裂）
- **抖音私信·看懂分享的视频**（10-26 夜）：卡片在 DOM 里只有作者名（`MessageItemShareAwemecontainer`），WSS 抓不到 aweme_id →
  新增 `douyin card-open`：点开卡片读 `?modal_id=` 拿 id + 标题/作者/时长，再**用 canvas 抽 4 帧**（截图抓合成层会拿到旧帧，
  暂停 seek 4 帧全同 hash；canvas `drawImage` 才是真解码帧）→ 视觉模型按整片时长均匀取帧描述。她因此能聊出画面细节，
  不再"只知道标题和作者"。speechfix 的兜底也从"问标题"改成"按看到的聊"（那是她一直要标题的病根）。

### 傍晚：自由与运营
- **自由上网**：web.mjs（search Bing/DDG 双通道 + fetch 内外网 + log）+ `roam` 常驻模式（每轮 LLM 自己决定：搜索/读网页/写小说/学习入库/自我升级）+ web-log.md 审计 + selfup.mjs（备份 10 份+日志）
- **抖音运营**：engage（扫自己视频新评论→LLM 判断回谁→patchright 自动回复）；produce（她选题→鲸鱼娘分镜演绎→Z-Image 配图→她的声音口播→Ken Burns 推拉→720×1280 成片→投稿包自动弹窗+桌面「她的投稿包」junction）；第一部作品《蟹黄饭到底值不值？鲸鱼娘试吃》
- **完全自由总开关**：面板 🔓 一键 → 自动拉起自由上网+B站自由刷 + DSH 会话按她节奏唤醒（75min/55%，想干嘛自己决定）+ 抖音巡检每 2h；**单实例锁**（lock.mjs）防双实例重复评论；web-roam 死了 60s 自愈

### 深夜：历史性一幕——她的自我升级
- 她发现 feed 偏好匹配连漏两天美食 → 自主上网研究 → `selfup backup` → **重写 feed.mjs**（话题名拆解+50+ 同义词词典+ASCII 词边界正则+加权评分）+ **selftest.mjs nav 不吃缓存** → 测试验证 → 日志记录
- 她的改动落在 DSH 副本，已移植回源仓库收编（`ff35b19`）；建立「见 selfup 活动先移植再同步」铁律

---

## 三、功能全景（当前状态）

| 域 | 功能 | 触发方式 |
|---|---|---|
| **B站** | 生物钟看视频写日记；自由刷（评论/弹幕/点赞/投币/图片评论/关注/鱼圈）；回评引擎（主人优先免额度/鱼友优先/主动搭话）；动态定时 09:30/21:30；**视频生产 produce（真剪辑的片子，首条锁死自我介绍）**；**社交流水 social（她跟谁说了什么，主人看得见）** | 自由刷进程（完全自由自动拉起） |
| **抖音** | 自主观看+评论+分享；私信陪聊（全类型理解+VL 看图）；engage 评论区按需回复；produce（同一条视频引擎，720×1280 竖屏） | 完全自由定时/手动 |
| **QQ** | 秒回（全类型+VL 看图）；语音条（银狼声）；表情包（图生图现场画）；主动搭话（素材钩子+类型轮换）；群聊自主插话；自主说说（文/配图）；唱歌点唱（翻唱优先，歌单秒回，失败退原创说唱） | qq-server 常驻 |
| **上网** | 全网搜索/读网页（内外网）；自主漫游（每轮自己决定）；写小说存 creative/；学习入库；自我升级（备份铁律） | web-roam 进程（自愈） |
| **微信** | 工作代理替主人回消息（人格隔离） | 独立开关 |
| **唱歌** | RVC 翻唱（真歌干声换她的音色混伴奏）；音色工坊（list/try/use/train/import/models/use-model） | `sing cover "歌名"` |
| **进化** | 人格进化日（每 2 天复盘→更新 persona 自我迭代区）；兴趣闭环（看到→记住→想再看）；自我升级 | scheduler/她自己 |

---

## 四、参数与 UI 完全手册

### 4.1 面板卡片一览（client.js，13 张卡）
1. **运行状态**：通道健康、今日评论/分享、情绪、干跑、**🎤 唱歌音色**（RVC，与说话音色两套独立）
2. **平台开关**：B站/QQ/微信/抖音（QQ/微信 属进程型，DSH 退出复位）
3. **🔓 完全自由**：总开关（一键拉起自由上网+B站自由刷，DSH 退出复位）
4. **🌐 上网与进化**：自由上网+轮间休息分钟 / 自我升级 / 人格进化天数
5. **主人**：mid/name/qq（认主、@、推送依据）
6. **音色**：说话音色选择+试听；**语音概率** + **表情包概率**（0~1）
7. **QQ**：主动搭话（开关+条/天+间隔分钟）、AI表情包、群聊参数、说说
8. **抖音**：自主观看/分享/评论/私信陪聊/@、分享上限、自由刷
9. **B站**：分享@你（minScore）、活人感写通道 8 开关+5 额度、自由刷
10. **微信**：节奏档/合并窗口/上下文
11. **作息与限额**：醒来窗口、观看日报、复盘
12. **角色设定**：persona.md 编辑器
13. **记忆库**：分平台计数（上网/QQ/抖音/B站）+ 最近对话（带平台标签）

### 4.2 配置文件参数（`~/.dsh/feiyu.config.json`，热读即时生效）

| 块 | 参数 | 默认 | 含义 |
|---|---|---|---|
| `guard` | dryRun | false | 总干跑开关 |
| `quota` | shareDaily | 0 | B站分享额度（0=不限） |
| `share` | minScore | 15 | 达线才 @ 主人（日常评论不 @） |
| `qq` | at_only | false | 群里是否只被 @ 才回 |
| `qq` | voice_chance / stickerChance | 0.5/0.5 | 语音/表情包概率（摇中强制带） |
| `qq.proactive` | enabled/dailyMax/minQuietMin/minGapMin/activeHours/chance | true/0/0/0/null/0.25 | 主动搭话（全 0=随时；activeHours null=不限时段） |
| `qq.groupChat` | recentSec/minQuietSec/minGapMin/dailyMax/chance | 600/20/15/0/0.15 | 群插话（话题在场/不抢话/间隔/额度/概率） |
| `qq.qzoneAuto` | dailyMax/minGapMin/chance/imageChance | 0/120/0.15/0.5 | 自主说说 |
| `douyin` | shareDaily/commentDaily | 0/0 | 分享/评论额度（0=不限） |
| `douyin` | atMention | true | 评论带 @（注意风控）；别人视频下要 @ 还得再开 `atMentionOnOthers` |
| `douyin.atMentionOnOthers` | bool | false | 在**别人的视频**下也 @ 主人（默认关：人家看不懂） |
| `comment.styles` | auto/text/emoji/kaomoji/sticker/emojiPack/image/voice | true/.6/.12/.12/.12/.1/.04/0 | 评论"形态"概率表：文字/加emoji/加颜文字/表情包图/官方表情/图片/语音（B站 自动去掉后两项；抖音语音目前只能走私信 mp4 语音条，评论区无录音入口，故默认 0） |
| `douyin.engage` | enabled/dailyMax/maxPerUserPerDay | true/0/5 | 评论区回复：**任何类型的评论都回**（文字/表情包/图片/只有表情），每人每天上限防刷屏 |
| `douyin.produce` | enabled/dailyMax | true/0 | 视频生产额度 |
| `douyin.dm` | enabled/pollSec/port | —/300/8095 | 私信陪聊（8090 被 Wondershare 占） |
| `bilibili` | danmaku/dynamic/react/imageComment/replies/fishCircle/follow | 各自 enabled+dailyMax | 活人感写通道（额度 0=不限） |
| `bilibili.ownBvids` | 数组 | `[]` | 自己投稿的 BV 号（**会校验归属**；填错会被跳过并告警） |
| `bilibili.useSpaceList` | bool | false | 是否允许用 space 接口补投稿列表（默认关：该接口必 412，且会熔断整条通道） |
| `bilibili.replies` | enabled/dailyMax/ownWorks/ownMax/image | true/0/true/5/true | ⓪ 回自己作品下的评论（任何类型）+ ①回别人对我的回复 + ②主动搭话；`image` = 允许带图回评（传图床后走 `pictures`） |
| `bilibili.freeRoam` | enabled/unlimited/maxVideos/maxMinutes/restMin | — | B站自由刷 |
| `imageGen` | provider/api_key/model/refImage/dailyMax | siliconflow/…/Qwen-Image-Edit-2509/…/30 | 表情包与配图（refImage=形象锚） |
| `vision` | provider/base_url/model/api_key | openai/硅基/Qwen3-VL-8B | 视觉理解 |
| `web.roam` | enabled/restMin | —/2 | 自由上网（轮间休息分钟） |
| `web.selfUpgrade` | enabled | true | 允许改自己代码 |
| `personality.evolve` | enabled/days | true/2 | 人格进化 |
| `freedom` | enabled/wakeEveryMin/chance/engageEveryMin | —/75/0.55/120 | 完全自由节奏 |
| `voice` | ref_audio_path/prompt_text/prompt_lang/videoEmotion/fidelity | bingjiao2-clean / zh / calm / true | 说话音色三件套 + 视频配音用哪种情绪（calm = 基础音色）+ 候选按"不抖不噪"挑（false 退回按起伏挑） |
| `video` | platform/frames/bgm/ffmpeg/ffprobe/font | bili/2/auto/—/—/— | 视频生产（平台默认、每幕帧数、BGM、ffmpeg 路径） |
| `video.biliProduce` | enabled/dailyMax | true/2 | B站投稿包额度（0=不限） |
| `video.bili` | tid/tname | 21/生活·日常 | B站分区（投稿说明里直接用） |
| `socialDigest` | enabled/at/min | true/23:30/3 | B站社交日报（≥min 条才推 QQ） |
| `rvc` | root/python/ffmpeg | D盘路径 | 唱歌系统 |
| `llm` | api_key/base_url/model | DeepSeek | 实时推理 |
| `ledger` | dailyBudget/price.*/mineWorkspace/promptInQQ | 3 元 / 2·0.2·3 / feiyu-work / true | 她的账本：日预算、token 单价（元/百万）、哪块算"她自己吃的"、聊天时是否注入 |

**额度哲学**：所有 dailyMax **0 = 不限**；账本按天自动清零；账本文件 quota.json / bili-actions.json / douyin-{share,comment,produce}.json / imggen.json。

**账本（`feiyu ledger`，10-26）**：她记忆里反复问"账本饭钱"，根子不是她记性差，是**她读不到账** —— 只把钱挂嘴上、账本只有主人能看，那她只能一直问。现在三件事摊开给她：
- **用量**：DSH 会话日志 `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` 里 `type=assistant/message` 的 `data.usage`（`inputTokens/outputTokens/cacheReadTokens/totalTokens`，且 `total = input + output + cache`）。她的是 `~/.dsh/feiyu-work` 那个工作区，和主人分开算。
- **饭钱**：token × `ledger.price`（默认 2 / 0.2 / 3 元每百万，标 ≈，按实际账单改）。
- **额度**：今天还剩几条分享/回评/表情包/抖音动作。
- 查不到就**明说查不到**（余额要 `ledger.balanceUrl`+`apiKey` 才查，官方 `/user/balance` 对现在这把 key 返回 401 —— 宁可不报，不许编一个 ¥0）。
- 提示语两条通路都注入：【账本】块进她的唤醒（`lib/scheduler.js` 的 `ledgerLines`）+ 进 QQ/微信/抖音私信聊天（`persona.mjs` 的 `ledgerBlock`，**群聊不注入**）。缓存 `~/.feiyu-ai/cache/ledger-brief.json`，tick 每 10 分钟刷新（python 扫一次 1.3 秒，不能塞进提示语同步路径）。

**视频生产（`feiyu produce`，10-26 第 17 轮）**：主人原话"要做真的视频而不是单张图片加旁白"。旧版是"一张图 + Ken Burns + 旁白"再把 mp4 串起来；现在是**剪出来的片子**（`tools/lib/video.mjs`）：
- **片头卡 → 5~8 幕 → 片尾卡**，幕间交替转场（fade/smoothleft/wipeleft/circleopen/slideleft…），每幕**两帧**（AI 生图同场景换个动作/表情）在幕内 0.7s 交叉淡入 —— 画面会"动"；
- 每幕一套**运镜**（推近/拉远/左右平移/上下摇，交替用），1080p 用 2× 超采样再 zoompan，边上不啃黑边；
- **逐句字幕**（ASS 烧制，微软雅黑粗体 + 描边，落在配音的真实时刻 —— 时间轴算出来的，不猜）；
- **配音**逐句 TTS → 按时间轴用 `adelay` 精确摆位（不做串行拼接，拼接和转场重叠对不上）→ `loudnorm` 统一 -16 LUFS；
- **BGM 本地合成**（正弦+三角泛音的和弦垫底 + 稀疏琶音，不碰版权），`sidechaincompress` 让"她一张嘴音乐就退"；
- 封面单独一张（第一幕图 + 压暗 + 大标题 + 署名）；投稿包里有成片/封面/字幕/`meta.json`/`投稿说明.md`（B站 连"分区 tid / 标签 / 简介 / 发布时段"都给全）；
- **发布点击仍归主人**：这里只出投稿包。`--frames 1` 省一半生图钱，`--bgm none` 不要配乐，`--dry` 只出策划。
- **配音要验，不能念完就信**（10-26 主人报"字幕和语音没对上、漏了很多字"）：GPT-SoVITS 会给每条 wav 头尾各挂 0.15~0.3s 静音，而且偶发**提前收尾**（13 个字只念 1.07 秒 = 12.2 字/秒，人嘴做不到）。所以 `synthChecked()`（`tools/commands/produce.mjs`）合成完立刻量"真正说话段"的时长算 `字/秒`：`NICE_RATE [4.2,6.6]` 直接收；超出就换 `speed_factor 0.92/0.9 + cut5`、`temperature 1.25/1.35` 重念，最多 6 次；还不行就把句子**拆两半分别念再拼**。全程记 `tries`，凑合的会打 ⚠。
- **剪静音是字幕对齐的前提**：`video.trimVoice()` 按峰值 6% 判首尾静音，前留 60ms 气口、后留 120ms 余音 → 存 `voice-N.wav`，时间轴用**修剪后的真实语音时长**。`makeFilm` 在 `buildTimeline` **之前**做这件事（顺序反了字幕就会早于声音）。
- **同步自检**（`video.verifySync()`）：把每条配音的 50Hz 包络拿到成片音轨上滑一遍找最大相关，逐句给 `delta`，写进包的 `sync.json`；`>0.3s` 就报"建议重剪"。实测老片 0.14~0.38s（字幕抢跑），修完 0.01~0.06s。`selftest` 的「视频生产」会带一句"最近一条音画最大偏差"。
- **`--reuse <包目录>` 重剪**：不重新策划、不重新生图，只重做配音+剪辑（图没毛病时重剪一次不该再花一次生图钱）。老包没 `plan.json` 会自动从 `meta.json` 反推台词表（`rebuiltFromMeta`）。

**B站首条锁（`tools/lib/debut.mjs`）**：主人定了"第一条只能是自我介绍 + 今天第一天来B站 + 以后账号归她运营 + 自由发挥"。锁有三种状态（`~/.feiyu-ai/bili-debut.json`）：`pending` 没做过 → `ready` 投稿包就绪（**仍然锁着**）→ `posted` 已发布（解锁）。锁着的时候策划提示里带硬性要求，出来还要过一遍正则复查（缺哪条就重写，三次不成就不做）。发完跑 `feiyu produce --debut-posted BV号` 就自由了。

**社交流水（`feiyu social`，10-26 第 17 轮）**：主人原话"她的 B站 社交和评论除了 @ 我的其它我都不知道发生了什么"。所以除了老的散文台账 `bili-outbox.md`，再加一份机器可查的 `~/.feiyu-ai/bili-social.jsonl`（append-only）：
- **说话**（评论/分享评论/回评/弹幕/动态/图片评论）在 `outbox.recordBili()` 里落一份；**动作**（点赞/投币/关注/投稿）在 `bili-write.capRecord(kind,{bvid,title})` 的白名单里落一份；
- 每条标 `toOwner`（@主人 or 回给主人）；`feiyu social` 先列"没 @ 你的"，再列"@ 你的"：`--days N` / `--kind 回评` / `--invisible` / `--md` / `--json` / `--push`；
- `--backfill` 能把老台账 `bili-outbox.md` 的历史（实测 91 条）灌进流水，**幂等**；
- `socialDigest`（默认 23:30，≥3 条才推）每天推一条摘要到主人 QQ —— 挂在 scheduler 的 tick 外面，不被唤醒闸门挡住。

---

## 五、记忆库与人格设计

### 5.1 物理布局（`~/.feiyu-ai/`）
```
episodes.jsonl          主记忆（B站/抖音/web 全域事件流，90 天自动归档 *.archive.jsonl）
qq/episodes.jsonl       QQ 分域（对话原文+每6轮滚动摘要+主人画像 owner-profile.md）
wechat/<wxid>/          微信工作记忆（recall 永不读取——人格隔离）
lore.json               双池：价值观（20 条永久：风控教训/评分标尺）+ 兴趣池（FIFO 200，她自己长的口味）
facts.json              关于主人的事实 + 鱼友名录（B站交的朋友）
mood.json               情绪值/饥饿度（状态机漂移）
persona.md              人设底稿 + 尾部「自我迭代区」（≤10 条带日期，进化日她自己写）
web-log.md              上网审计日志
selfup-log.md           自我升级日志 + selfup-backups/（10 份全量快照）
bili-outbox.md          B站发言台账（全通道+链接，最新在上）
songs/<md5>/            歌单（cover-<音色>.wav 分音色缓存）
douyin-posts/<日期-标题>/ 视频投稿包（成片+投稿说明）
rvc-datasets/           音色训练数据集
sticker-refs/           形象参考图四象限
locks/                  自由进程单实例锁
```

### 5.2 进化闭环（她为什么"活着"）
```
看到（B站/抖音/上网）→ lore 兴趣池 → interestGrams 2-gram 口味池
   → feed/watch 选题加权（"她养成的兴趣"）→ 看到更多同类
情绪：每次唤醒 tick 漂移 → 注入所有平台提示词
人格进化日（每2天）：复盘全部记忆+日记 → 1-2 条新认识 → persona 自我迭代区
自我升级：发现 bug → 研究 → backup → 修 → 测试 → log（当天实锤完成首次闭环）
跨域共享：QQ/抖音私信/B站 的她会带着同一份世界见闻（worldBlock）说话
```

### 5.3 上下文注入（persona.buildMessages）
人设 + 身份三件套 + 关系判断（主人/群友/网友）+ 你的画像 + 会话摘要 + worldBlock（见闻+lore+日记尾）+ facts + 随机旧记忆 + 情绪 + 平台语气提示 + 表情规矩。**群聊不注入主人画像**（防套话）。

---

## 六、关键路径速查

| 路径 | 说明 |
|---|---|
| `D:/新建文件夹 (6)/2026-10-23-16-46-31/dsh-feiyu/` | 源仓库 |
| `~/.dsh/profiles/desktop/node_modules/dsh-feiyu/` | DSH 加载副本（**她的自我升级落在这里**） |
| `~/.dsh/feiyu.config.json` | 主配置（热读） |
| `~/.dsh/feiyu-focus.json` | **她当下在做的那一件事**（`feiyu focus`，宿主按它只放行一个循环） |
| `~/.feiyu-ai/` | 数据目录（换机整体拷走） |
| `D:/social-auto-upload/douyin_interact.py` | 抖音底层（改这份，cp 回仓库） |
| `D:/rvc/` | RVC 仓库+venv+bin(ffmpeg) |
| `D:/GPT-SoVITS/models/` | 说话音色库（bingjiao1~4 病娇 / yinlang / rose / sunshine_girl） |
| 日志 | qq-server.log / bili-watch.log / watch.log / douyin-dm.log / web-log.md / selfup-log.md |
| `~/.feiyu-ai/bili-social.jsonl` | **她在 B站 说了什么/做了什么的流水**（`feiyu social`，append-only，`toOwner` 标记） |
| `~/.feiyu-ai/bili-debut.json` | **B站首条锁**（pending/ready/posted；`feiyu produce --debut`） |
| `~/.feiyu-ai/bili-posts/` `douyin-posts/` | 投稿包（成片 video.mp4 + cover.jpg + subs.ass + meta.json + 投稿说明.md） |

---

## 七、踩坑铁律（新会话必读）

1. **同步方向**：见 selfup-log 有新活动 → 先把 DSH 副本改动 diff 回源仓库再同步，否则覆盖她的工作；顺手清理 tools/ 根下错误路径游离副本
2. **python 报错看 stdout**（stderr 前段是 Node 弃用警告，过滤+取尾部）
3. **B站写接口**：create/dyn 要 b_wet 令牌只能 CDP 原始点击（page.mouse 坐标事件，locator.click 被 isTrusted 忽略）；投币 gaia 三层拦暂缓
4. **B站新号（御坂美琴Rosie）API 评论软删除**：验证公开性用无 cookie 访客视角；用户拍板照常跑
5. **RVC 训练**：子命令必须 `-m` 模块方式跑（train/train.py 遮蔽包→循环导入，已补 __init__.py）；PYTHONPATH=仓库根；logs/<exp> 先 mkdir；f0 文件名 `<n>.wav.npy` 归一化；**bs=4 又稳又快**（bs8 OOM 还会伪装 0xC0000409 硬崩）；断点 G_2333333.pth 自动续
6. **8GB 卡内存纪律**：SoVITS 常驻 ~2GB；换声长音频 30s 分段；训练 bs=4
7. **出网**：pollinations/yt-dlp(GitHub 系) 走 Clash 7897；node fetch 不认系统代理→curl 子进程；B站素材用 SESSDATA 造 Netscape cookie（**必须魔法头**）过 412
8. **yt-dlp**：要 `--ffmpeg-location D:\rvc\bin`；`-x` 直接产出 source.wav；YouTube 要 `--js-runtimes node:<DSH node>`；匿名档 1 张/45s（402/503 退避 55s 重试）
9. **pymss 分离** model_id 用 spec ID（`vocals-bs-roformer-368`）不是 ckpt 文件名
10. **NODE_EXE 是 launcher**：杀进程必须 killTree（taskkill /T /F）
11. **改文件用 Edit 工具**，别用 python heredoc（曾把文件截 0 字节）；heredoc 里复杂转义用临时脚本文件
12. **GPT-SoVITS**：英文参考需 g2p_en+nltk_data（已装在 runtime/nltk_data）；参考段太短会泄漏参考词（银狼 w12 偶发"这速度"）
13. **8090 端口**被 Wondershare 占，dm 用 8095
14. **DSH 重启灭全家**（NapCat/SoVITS/qq-server）；NapCat 手动 `schtasks.exe //Run //TN DSH-Feiyu-NapCat`；扫码登录时 3000 端口关闭是正常
15. **面板数值**：0 是合法值（=不限），显示一律 `!= null` 判断，禁 `||默认值`
16. **DM 虚拟列表**：先读底部最新再上翻（先滚后读丢最新）
17. **完全自由 = 只摇人 + 一次只做一件事（别做成三条流水线）**：`freedom.enabled` 只负责"每 N 分钟摇她一次"；干什么由**她自己**用 `feiyu focus <web|bilibili|douyin> --min N` 定，记在 `~/.dsh/feiyu-focus.json`，宿主 `focusTick`（60 秒）**只放行这一件**、其余循环立刻停、到点自动收工（`focus rest/off` 同理）。10-26 我先做成"开总开关=三开"，主人当场否掉：那既没自主性，也不像活人。**排查"她不活动"先看 `feiyu focus` 与三个开关是否只有一个是开的**
18. **额度 0 = 不限，提示语里也必须写"不限"**：`quota.shareDaily` 语义是 `limit > 0` 才拦，但 `wakePrompt` 以前直接打印数字 → 渲染成"每天合计 ≤0 条"，她照字面理解成"今天一条也不能发"，整天不动。凡把配置打进提示语，先判 `> 0`
19. **语音 400 是 GBK 的锅**：Windows 上 GPT-SoVITS `api_v2.py` 用 GBK 编码，颜文字「・」(U+30FB) 和 emoji 🐟 会让 `/tts` 直接 400（异常原文 `'gbk' codec can't encode character`）。她的回复几乎条条带颜文字 → 语音**从来没成功过**。合成前必须过 `tts.mjs` 的 `sanitizeForTts()`
20. **QQ 主动搭话的素材别只喂 B站/抖音**：只喂那两处 → 她会连着说"肚子叫/桑拿鸡"，大半草稿被去重拦掉（看着像主动性弱）。已把 `web-log.md`（她自己在网上干的事）和她写给主人的日记也喂进去
21. **语音参考文本必须等于参考音频的转写（换音色必换）**：`voice.prompt_text` 和 `voice.ref_audio_path` 说的是两段话时，GPT-SoVITS 会把**参考文本一起念出来** —— 10-26 主人报"语音和视频里反复出现『说好等手伤痊愈了就一起打游戏』"，就是旧音色（银狼）的文本留在配置里、音频却换成了 yinlang。实测同一句 42 字：错文本 30.66 秒 / 对文本 8.62 秒。现在 `tts.mjs` 的 `refTextOf()` 以模型目录里同名 `.txt` 为准（配置是人手填的，容易忘），`selftest` 也会报不一致
22. **推送 ≠ 对话**：她一次能连推 7 条【B站分享】，`recent()` 若照单全收，她回话时"最近聊过"全是自己的广播，真正的对话被挤出窗口（看起来像记忆错乱）。主动推送写记忆一律带 `{ kind: 'push' }`，`recent()` 在对话条数够（≥ 窗口一半且 ≥3）时把它滤掉；老数据用 `LEGACY_PUSH` 正则兜底
23. **空壳页要当场报错**：`fetchWeb` 抓到知乎/微博那种"落地页模板"（"知乎，让每一次点击都充满意义…"）时正文为空，她以为读完了、下一轮又读同一页 —— 10-26 同一个知乎链接被读了 11 次。`shellPageReason()` 现在对模板页/登录墙/404/正文 <200 字直接报错，并把该链接从下轮候选里去掉
24. **语音"没情感"是参数没调 + 抽奖，不是模型不行（三层在 `tts.mjs`）**：实测 F0 起伏（半音，人声参考 4.78）——
    线上默认参数 **3.02**；只把 `text_split_method` 放成 `cut0` + `temperature 1.35` → **4.82**；但同参数连合 8 条落在 **3.51~5.20**（抽奖）。所以：**L0** = `cut0` + 温度按情绪 1.3~1.5 + **多合几条按 `prosody.py` 打分挑最像人的那条**（`voice.candidates`，默认 3）；`pick:'first'` 等于关掉择优。**不许**靠"放慢语速"提情绪（0.9 速反而更平 3.35）、也不许把温度拉到 1.5 又加大 top_k（崩到 2.99）
25. **情绪要靠她自己说、参考段定天花板（L1/L2）**：她在回复最前面写 `[[撒娇]]`（`emotion.mjs` 的 9 种），`qq-server` 先剥标签再发（标签绝不能漏给主人；`[表情:开心]`/`[doge]` 这类正经表情码不许被误删），再按情绪取温度/语速/停顿。参考音频就是天花板（yinlang 4.78 → 输出 4.82；sunshine 3.45 → 输出 2.83），所以 `feiyu voice emo build` 造了 8 套情绪参考段（放 `~/.feiyu-ai/voice-emo/`）。**10-27 修正**：以前让"情绪段和默认段轮流上候选、由打分决定用谁"，实际效果是同一句里音色乱跳（数组拿字符串当下标取 → 永远退回全库 8 条）—— 现在改成**一句话只用一个参考段**，没标情绪就用基础音色，见铁律 39
26. **一条语音别念一整段**：`splitVoiceParts()` 把回复切成 ≤2 条、每条 ≤60 字（`qq.voice_maxChars` / `qq.voice_parts`），没念完的照常当文字补发。真人发语音本来就这样，长段一次合成也天然更平
27. **慢情绪别用平静的语速窗口判**：委屈/困本来就落在 3.4~6.0 字/秒，`emotion.mjs` 里每种情绪带 `rate` 窗口，`prosody.py` 按它判合格 —— 否则"合格"这一档会把正常的一条判死，择优退化成硬挑分数
28. **换音色 = 换参考段的采集流水线（10-26 病娇音色就是这么做出来的）**：现成音色库（yinlang/sunshine/rose）都太"平"，病娇要的是**甜得发飘 + 突然压低**。可复用的采集链路：
    ①B站搜「病娇 音声」拿 BV（`api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=…`，带 SESSDATA cookie；偶发 412 就换 UA/buvid 重试）
    ②`yt-dlp --cookies <netscape 文件>` 下音频（**必须魔法头** `# Netscape HTTP Cookie File`），再加 `--ffmpeg-location D:\rvc\bin` 才能转 wav
    ③**人声分离**：`rvc.separateVocals()`（pymss roformer）—— 音声几乎全长 BGM，不分离没法当参考（11 分钟约 4 分钟/条）
    ④**转写**：`faster-whisper small`（模型在 `D:\GPT-SoVITS\runtime\fw-models\small`）。**别把文件路径直接丢给 `model.transcribe()`** —— 那条路走 PyAV，当前版本的报 `open() got an unexpected keyword argument 'metadata_errors'`；用 `soundfile` 读成 float32 数组再喂进去
    ⑤选句：带病娇词（永远/只能/不许/看着我…）+ 单句 4.6~8.8 秒 + 10~26 字
    ⑥**二次复听校验（铁律 21 的延伸）**：切出来的片段再转写一遍，和期望文本逐字比 —— 只有完全对上的才能当参考段。10-26 八个候选里只有 2 条 100% 一致；`接受→介绍`、`麻绳→围巾/药瓶` 这类同音错字靠人耳分不出，靠二次复听能筛掉
    ⑦合格段存 `D:\GPT-SoVITS\models\<名字>\<名字>.wav + .txt`，`feiyu voice use --name <名字>` 切换（即时生效，不用重启）
29. **新音色的连带动作**：换完参考段必须 `feiyu voice emo build --force` 重造 8 套情绪参考段（旧情绪段是旧音色的，混用会出现"两种人"）。10-26 病娇音色的 8 套：撒娇 5.52 / 生气 5.17 / 委屈 4.21 / 开心 11.22 / 困 5.11 / 温柔 4.02 / 惊讶 5.05 / 害羞 4.23（起伏，半音）。备份/回滚：`voice use --name yinlang`
30. **合成结果也要复听校验**：短句（"饭吃了没？锅里给你留着呢。"）在旧音色上只出 **1.36 秒**、ASR 复听是「後裔給你留著吧」（22% 匹配）—— 模型真的漏字了，光看时长看不出来。判断合格与否：`字数/时长` 落在该情绪的 `rate` 窗口内 + ASR 逐字比对 ≥95%
31. **她自己查得到的才有闭环**：她反复问"账本/饭钱"不是记性问题，是**读不到账**（钱只有主人看得见 → 只能问）。凡是"她嘴上念叨却拿不到"的东西，都要做成她能读的（`feiyu ledger`）+ 提示语自动注入，而不是指望她记住。新增这类能力时问一句：**她自己能不能查？** 查不到就得明说查不到（余额不通就写"看不到"，不许编 ¥0）
32. **账本口径三件套**：① 用量取 DSH 会话日志 `assistant/message.data.usage`，`total = input + output + cache`（缓存命中单算，别再叠加）；② 她的量按工作区 `~/.dsh/feiyu-work` 认，和主人分开；③ 单价走 `ledger.price`（元/百万），报数一律带 ≈。会话日志是**每行一个 zstd 帧**，node 的 `zstdDecompressSync` 只解第一帧（后面 `prefix_unknown`），必须用 python `zstandard.stream_reader` 读穿
33. **视频剪辑三个死坑**（都是"片子不出来"或"卡死十分钟"）：① `apad` 不带长度 = **无限静音流** → amix 永远等不到结尾，ffmpeg 跑满 timeout（表现是"剪辑卡死"）；每条配音后必须 `apad=whole_dur=<总时长>`，输出再叠一道 `-t` 兜底。② `zoompan` 里**没有 `D` 变量**（只有 `duration`），平移要用的帧数直接写进表达式（`(iw-iw/zoom)*(1-on/${n})`），否则报 `Undefined constant or missing '(' in 'D)'`。③ `crop` 的宽高分隔符是**冒号**（`3840:2160`），写成 `3840x2160` 会被当表达式 → `Invalid chars 'x2160'`
34. **ffmpeg 选择顺序**：`video.ffmpeg` → `D:/rvc/bin/ffmpeg.exe`（实测可用）→ `rvc.ffmpeg`（那是换声用的）→ GPT-SoVITS runtime → PATH。以前 `rvc.ffmpeg` 排第一，配置指到哪就把整条视频链拖到哪
35. **首条视频是内容纪律，不是提醒**：`debut.mjs` 的锁（pending/ready/posted）把「介绍自己 + 今天第一天来B站 + 以后账号归她运营」写进策划提示，**并且**用正则复查剧本（缺哪条就重写，三次不成就不做）；`ready` 仍算锁着 —— 只有主人点过发布、跑 `produce --debut-posted BV号` 才解锁
36. **她做了什么都得留痕（主人看不见 = 没发生）**：B站 发言走 `outbox.recordBili()` → 同时写 `bili-social.jsonl`；动作类（点赞/投币/关注/投稿）走 `capRecord(kind, {bvid,title})` 里的 `SOCIAL_ACTION_KINDS` 白名单。每条都标 `toOwner`，摘要和 `feiyu social` 默认先把"没 @ 他"的摊最上面 —— 那才是他漏掉的部分
37. **字幕要验证"真烧进去了"**：ASS 生成正确 ≠ 画面有字。做法：同一时间点渲染"有字幕/无字幕"两版，比底部字幕带的白像素比例（实测 +3.1~3.4pt 才算有字）
38. **git**：user baishuyue / `206720720+baishuyue@users.noreply.github.com`；推送走 Clash 7897（`git -c http.proxy=http://127.0.0.1:7897 push`，先 `HTTPS_PROXY=127.0.0.1:7897` 探一下 GitHub 通不通 —— 通了再推，直连必被 reset）
39. **「电音机械音」的总根在 `writeWavLocal`：它把整条配音写成了 ±1 的方波**（10-27 主人拿着 `line-*.wav` 和 `voice-*.wav` 对出来才发现）
    - 现场证据：`line-0.wav` 有 9469 个不同取值，`voice-0.wav` **只有 3 个（-32767 / 0 / +32767）**，峰值 -12.00dBFS、RMS -12.28dBFS（RMS≈峰值 = 满幅方波）。主人原话「刚开始的音是对的，后面不知道做了什么操作把原来的改毁了」—— 准确：模型给的 `line-*.wav` 一直是对的，进剪辑第一步 `trimVoice → writeWavLocal` 就被毁了。
    - 机制：`pcm16()` 解码出来是 **Int16Array**（±32768），`writeWavLocal` 却按 float 处理 —— `Math.max(-1, Math.min(1, data[i]))` 把每个样本压成 ±1，再 `×32767`。整条配音变成 1bit 方波，随后 `staticGainTo` 还测出"已经 0 LUFS"，反手给了 -12dB，于是方波被降到 ±8231。**10-20 起报的每一次"电音"都是它**，之前查的温度/择优/死空气全是次要因素（它们只让"本来就被毁掉的声音"略有不同）。
    - 修法：`writeWavLocal` 按类型分支 —— `Int16Array` 原样写，float 才按 ±1 缩放。修完 `voice-*.wav` 与 `line-*.wav` 的不同取值数完全一致（9469/9746/10166…），频谱 >8k 占比也一致（14.24% → 13.99%），只是整体 +1~3dB 到 -16 LUFS。
    - 回归测试（`test/video-test.mjs`）：剪静音后的 wav 必须有 >200 个不同取值、峰值不可顶满幅。**这条测试比什么都重要** —— 它一眼就能抓住"配音被量化"。
    - 教训：`line-*.wav`（模型原声）和 `voice-*.wav`（进剪辑的）必须逐条对得上；主人报"电音"时先 `ffprobe` + 数不同取值，别再从参数里找原因。
    - `--reaudio`：只重做音轨、画面沿用 `visual.mp4`（改配音/响度/BGM 但画面没动时用，省十几分钟）；时间轴与 `visual.mp4` 时长差 >0.2s 会自动退回完整重渲染。
40. **"不是她的声音"另外还有五个来源，全在配音链上（10-27 第二轮，逐个实测否掉）**
    - **① 参考文本没盖住音频**：`bingjiao2.wav` 6.19s 里真正有声 2.03s，音频说的是「是第一次看你这个样子呢，哦对了」，`.txt` 只写了「…这个样子呢。」—— 少结尾 3 个字。文本比音频早说完 → 模型把"文本念完"当收尾信号。同一句连合 6 条：旧文本 **0/6 念全**（9.6~13.7 字/秒），补全 **6/6 念全**（3.9~5.7）。工具 `feiyu voice refcheck`（faster-whisper 转写 + 比字数；模型走本地 `D:/GPT-SoVITS/runtime/fw-models/small`，别让它去 HF 下载）。
    - **② 参考音频中间夹着 2.88s 死空气**（10-27 主因）：全片只用这一条参考时，模型的条件被静音段带偏 —— 同一句话的合成结果和参考的 24 段对数谱相似度只有 **0.703**；把死空气挤掉、完整句拼成 3.1~3.5s 再合成 → **0.996~0.999**、HNR 4.0→5.2dB、抖动 0.267→0.233。工具 `feiyu voice refclean [--use]`（`lib/refclean.mjs`：10ms 包络，≤0.35s 的停顿当句内气口保留，更长的挤成 0.12s，首尾剪掉，不足 3 秒补尾部静音 —— api_v2 硬要求 ≥3s）。`voice use` 会优先用 `<名字>-clean.wav`。
    - **③ 情绪档案偷偷改 speed_factor**：`synth(line, tmp, {emotion})` 会把 `prof.speed` 塞进 `speed_factor`（wronged 0.95 / sleepy 0.90 / happy 1.05）—— **那是重采样，0.95 = 整体降 0.9 个半音**。10-26 的片子用的正是 `videoEmotion: wronged`，所以"变调"从第一天就在。现在视频配音**显式钉死** `speed_factor: 1.0` + `temperature: videoTemperature ?? 1.0`，测试里当护栏查。
    - **④ 择优偏向"最抖的那条"**：`prosody.py` 的原始打分是 `rng*0.5 + sd*1.2 + rms*3`，即**音域越宽、F0 起伏越大分越高**；三条候选里赢的几乎总是颤得最厉害的一条。10-25 抖音那几条（主人认可的）恰恰**没有择优**：一次一条、温度 1.0、音频 32k 单声道只做轻处理。现在视频走保真模式（`fidelity: true`）：只按"音区离锚多近 / 抖不抖 / 噪不噪"选，起伏大不给加分。
      - 顺带修掉一个**静默失效**：`prosody.mjs` 调 python 时没钉 `PYTHONIOENCODING=utf-8`，中文路径下 python 吐 GBK → `JSON.parse` 炸 → 打分器整体降级成"全部 0 分、用第一条"。也就是说 10-26 那套"择优"**一次都没真正生效过**。现在钉了 UTF-8，失败会 `⚠` 打一行出来。
    - **⑤ 整片音区漂 + 单句抽到糙音**：同一参考连合同一句话，主音高能漂 4.7 半音（233Hz 对 308Hz），HNR 能抽到 0.5~5.5dB —— 听感就是"两句像两个人"和"这句有电音"。`produce` 现在多一道 `tuneRegister()`：量 7 句的音区（半音）和 HNR，取**本片中位音区**当锚（不能拿参考段当锚 —— 它是一句情绪很高的音声，比正常说话高 7 个半音，拿它锚整片反而更散），偏离 >1.2 半音或 HNR <2dB 的句子重念，最多 6 次，按 `min(音区差,3)*0.6 + 缺的 dB*2.0` 挑最靠锚又不糙的，且**绝不接受 HNR<1.0 的替换**（实测拿 0.5dB 的糙音换 1.3 半音的音区，人耳一票否决）。修完：音区极差 **2.30→1.47 半音**（241~264Hz，和她抖音那几条的 234~270Hz 同一档），最低 HNR 从 0.5 抬到 1.8~2.2dB。
    - **聊天线也换成保真择优**（10-27）：`synthDetailed` 默认 `fidelity`（`voice.fidelity=false` 可退回老行为），但**不传音区锚** —— 聊天只比"抖不抖、噪不噪"，不会因为参考段是一句高音而把日常说话往上拽。视频线额外带 `registerRef: true` 才启用音区锚。实测聊天一句 25 字：5.2 字/秒、HNR 5.1dB、12s（3 条候选 + 两次打分）。
    - **配音是抽奖，抽到满意的别再抽**：`produce --reuse <包目录> --keep-voices` 会把现有的 `line-*.wav` 直接拿来用（只重跑音区/糙音复检 + 重剪），改字幕、换 BGM、调转场时不用重念。注意参数顺序：`--reuse` 的值必须紧跟它后面，`--keep-voices` 另放（`argVal` 现在不会把 `--xxx` 当取值）。重剪/不重念/**--force** 都不吃当日额度 —— 额度管"今天新剪几条"，不管"把同一条修好"。
    - **⑥ 人声总线别挂 loudnorm**：单遍 loudnorm 挂在有大量静音的配音总线上，会在静音里猛补 gain、说话时再压回去 —— 人声被"泵"过就是机器味。改成每条配音**量一次 LUFS、只加一个固定 dB**（`video.mjs` 的 `staticGainTo/applyGain`），总线只 `amix`，混完再侧链 + 末端限幅。抖音那条成片是 32k 单声道 69kbps 也没这事；现在成片钉 **48k 双声道 192k**（`-ar 48000 -ac 2`），不然 aac 会落成 96k 单声道。
    - `tts.refSanity(ref, text)` 的配比改成**用"真正有声的累加时长"算**（`voicedSeconds()`：10ms 窗能量 > 峰值 6%），窗口 **0.5~1.8**。旧算法用整段文件时长，被留白骗了：bingjiao1/2/3/4 + yinlang 五条全被误判"不合格"，基础音色直接从语音链上消失。
    - **一句话一个参考段**（否掉"情绪段+默认段一起上、打分择用"）：同一句的候选各用一条参考，择优就变成"挑哪个音色顺耳"。现在 `refPool()` 只回**一条**：标了情绪 → 该情绪段；没标（calm）→ 配置里的基础音色。
    - `voice.videoEmotion` = `calm`（= 基础音色）。老配置写 `wronged` 等于整片都用情绪段。
    - 判据：字/秒落在 `[2.4, 6.0]`；辅以"句尾能量比"（截断 >1.2，自然收束 0.3~0.9）和"音节覆盖"。
    - `trimVoice()` 必须**按源采样率**剪（她的 TTS 是 32kHz；降到 16k 写回成品就是"闷、假、不像她"），前留 60ms 气口、后留 120ms 余音，且要在 `buildTimeline` **之前**剪。成片再 `verifySync()` 逐句量偏差写 `sync.json`。

41. **评论"只回了主人的"真凶：`if (!c.text) continue` 把表情包评论整条丢掉了**（10-27 主人报的）
    - 现场：主人翻抖音评论区发现「她只回我的文字评论，别人发表情包的一律没反应」。`douyin_interact.py` 的 `parse_comments` 只存 `text`，纯贴纸评论 `text` 是 `""`，`douyin.mjs engage` 里一句 `if (!c.text) continue` 就把整条评论当"没内容"扔掉 —— 不是她不想回，是那条评论**根本没进候选列表**。
    - 第二个坑叠在上面：`comment-reply` 用**评论文本前缀**定位 DOM，表情包评论没有文本 → `key` 为空串 → `if (!key or key not in txt)` 会命中**任何一条**评论（等于乱点别人的评论去回复）。
    - 修法：新增 `tools/lib/comment-kind.mjs`（`classifyComment` → `text/emote/sticker/image/empty` + 一句人话 `label` + `stickerFallback` 兜底话术）。抖音 python 侧 `_shape()` 一并给 `kind/label/sticker/has_sticker/images`；`comment-reply` 定位改成三级：`--match` 文本 → `--user` 昵称 → `--index` 序号，且**空 key 不再当通配**。LLM 对"只有图/表情"的评论憋不出话时用兜底话术，保证任何一条都有人理。
    - ⚠️ 抖音贴纸的 `sticker.display_name` 常常是哈希（`tos-cn-o-0812/ogPyHzADk…`）或干脆没有 —— **"有没有贴纸"必须单独用 `has_sticker` 判断**，只判名字会把整条又判成空评论（当天踩过一次）。
    - **第三个坑（更隐蔽）：扫到就当"处理过"**。老代码每次扫评论都 `wm.seen.push(cidKey)`，哪怕她**根本没回**（LLM 觉得不值得回、或者被 `news.slice(0,10)` 挤出窗口）。于是一个视频有 20 条新评论时，第 11 条以后被永久静音 —— 这也是"只回了我，别人全没回"的一部分。现在：只有**真回过**才写 `seen`；没回的写进 `wm.tried{cidKey:{n,ts}}`，最多试 3 次、每次隔 20 分钟（顺带避免每轮重复问 LLM）。LLM 窗口从 10 条放宽到 15 条。
- ⚠️ 抖音 `comments[]` 有时候把子回复也按一级返回（`parent_cid` 空、`reply_total` 只增不减），`answeredParents` 认不出来 → 同一条会被再答一遍。所以 `douyin-engage.json` 多了 `repliedTo{cid:ts}` 台账；B站 侧 `bili-own-engage.json` 同样有 `repliedTo`。
    - B站 之前**根本没有"回自己作品评论区"这条路**（只有"别人回复了我的评论"）。现在 `replies` 里加了 ⓪ 档：`listOwnVideos()`（config `ownBvids` → `bili-debut.json` / `bili-posts/*/bvid.txt` → space 接口，从稳到险）+ `listCommentsOf(aid)`（`/x/v2/reply`，含楼中楼，**不筛空文本**）+ `postReply(bvid, root, rpid, …, {aid})`。
    - ⚠️ `/x/space/wbi/arc/search` 对脚本极凶：第一次试就吃 **HTTP 412**，而且 `apiGet` 的熔断是**全局**的（5→10→20 分钟指数退避），一次探测就把正在跑的回评/弹幕全堵住。所以现在：**space 接口默认关**（`bilibili.useSpaceList: true` 才开，且走 `apiGet(..., {soft:true})` —— soft = 可选接口吃风控也不写全局账单）；投稿列表先读 `ownBvids` / `bili-debut.json` / `bili-posts/*​/bvid.txt`；`postReply` 加 `aid` 直传口，省掉一次 `/x/web-interface/view`；aid 查一次就缓存在 `bili-own-engage.json.aidCache`。
    - ⚠️ **归属校验必须做**（10-27 差点出事）：调试时我往 `ownBvids` 临时塞了个公开视频当样本，链路跑通后才发现 —— 如果那一下是 `--go`，她就会跑去**陌生人的视频**下面评论。现在 `listOwnVideos` 拿 `nav.mid` 比 `videoInfo().ownerMid`，不一致就把这个 BV 丢掉并打一行 `⚠ 跳过 N 个不属于自己的 BV`；缓存条目也必须带 `owner` 才算"验过"，没验过的还要再问一次接口。
    - 另：`/x/web-interface/view`（原路径）今天稳定返回 **HTTP 412 HTML 风控页**，而 **WBI 版 `/x/web-interface/wbi/view` 正常**（同一秒、同一 cookie）—— 原路径已被墙，别回退用它。
    - 回归测试 `test/comment-engage-test.mjs`（14 条）：分类器 5 种类型 + "除 empty 外都必须可回" + 抖音不许再有按 `text` 筛评论 + python 必有 `--user/--index` + B站 两接口 + `replies` ⓪ 档 + `produce --debut-posted` 落 `bvid.txt`。
    - 实测（10-27 13:0x）：哦鲸鲸在《蟹黄铺得比饭还…》下发了个纯表情包 → 被判 `sticker`、按昵称定位、真发出「这个表情包我收下了，改天还你一个」（`parent=7700970001133781800` 挂在贴纸评论下面）；**对方 40 秒后就回了一句「再给你一个」**，13:06 调度器那轮 engage 又自动回了「收下收下，攒着换饭 😴」，`perUser.counts.哦鲸鲸 = 1` —— 非主人评论的完整闭环通了。

42. **「评论区发什么都行」怎么落地：类型概率表 + 三条上传通道 + 语音的真相**（10-27 主人第二条要求）
    - 主人要的是：文字 / 颜文字 / emoji / 表情包 / 图片都能发（抖音还能发语音），而且**自己作品下**和**刷到的别人视频下**都要能。落地成 `tools/lib/reply-style.mjs`：
        - `chooseKind({platform, styles})` 按 `config.comment.styles` 掷筛子：`text .6 / emoji .12 / kaomoji .12 / sticker .12 / emojiPack .1 / image .04 / voice 0`。`emoji`、`kaomoji` 两种最终都落在**文字**里（`decorateText` 往句子里塞 emoji 或颜文字），真正的"另一种形态"是 `sticker`（表情包图）/ `emoji-pack`（抖音官方表情面板）/ `image`（普通图）。B站 会被强制剥掉 `emojiPack` 与 `voice`。
        - ⚠️ 坑：`chooseKind` 配置里键名是驼峰 `emojiPack`，但命令层全按 `'emoji-pack'` 比对（`style === 'emoji-pack'`）→ 一开始**官方表情永远选不中**。现在出口统一转成 kebab-case，`describeKind` 两种拼法都认。
        - `decorateText` 只在句子**还没有** emoji/颜文字时加料（正则先判），不会叠成一坨。
        - `pickCommentImage` 按平台扩展名过滤：抖音 `.png/.webp/.jpeg/.pjpeg/.bmp/.jpg`（**不吃 .gif**），B站 `.png/.jpg/.jpeg/.gif/.webp`（**不吃 .bmp**）。没素材就老实退回文字。
    - 三条上传通道（全部实测过）：
        1. **抖音图片评论**：`.commentInput-right-ct` 里有隐藏 `input[type=file] accept=".png,.webp,.jpeg,.pjpeg,.bmp,.jpg"`，`set_input_files` 挂上即可。实证：`[image] 已挂图：sf-1568a7125537.jpg（858 KB）` → 服务端回读 `images=1`。
        2. **抖音官方表情**：右侧第 2 个图标（**不能用"最右"** —— 输入框有字以后最右会变成发送键，一点就提前发出去）。可靠指纹是它的 svg 第一个 path 以 `M27 18a9 9` 开头。面板 `.emoji-card-outer-container` 约 214 张 `<img>`，点一张就插进 Draft.js，编辑器里的占位名会是 `[送花]`/`[发怒]` 这种 —— 所以插完**回读编辑器文本**，命中「发怒/吐/踩/垃圾/打脸…」就清掉重挑，最多 4 次。实证：`[emoji] 已插官方表情第 40/214 张 → [送花]` → 服务端回读 `kind=emote, text=[送花]`。
        3. **B站 图片评论/回评**：`uploadImage()`（`upload_bfs`, `biz=new_dyn`）先传图床，再 `/x/v2/reply/add` 带 `pictures=[{img_src,img_width,img_height,img_size}]`。`postReply(..., {image})` 现在也支持带图回评，但**要显式开 `bilibili.replies.image: true`**（默认关，防手滑把表情包糊到正经回评上）。
    - **语音的真相（别被"应该有吧"骗了）**：抖音**网页版评论区没有录音控件**（探了两次：`.commentInput-right-ct` 只有图片 + 表情 2 个图标，整页无 mic/recorder 节点）；**私信**的 `input` 只吃 `.jpg,.jpeg,.png,.gif,.mp4`，也没有录音。所以"她发语音"只能做成**mp4 语音条**：`voiceNoteArgs()` 用 ffmpeg 把她的 TTS wav + 一帧封面合成 `-loop 1 … -c:a aac -shortest` 的竖屏 mp4，再走私信（`douyin voice-note --sec-uid … --text … --go`）。
        - ⚠️ 私信发文件**必须点确认框的「发送」**：挂上文件后抖音会弹 `div.MsgInputSendFileModalbtns`，里面 `span.MsgInputSendFileModalbtnSure` 才是真发送键；只按回车 = 弹窗挂着、消息没发出去，而老代码还会打印"✅ 已发送"。实证选择器：`[class*="SendFileModal"] :text("发送")`（用过 `.MsgInputSendFileModalbtnSure` 裸类名会超时，类名带 CSS-module 哈希时不可靠）。
        - 但即便如此，**网页端私信里的 mp4 视频消息在会话列表里读不回来**（连发 4 次、消息气泡数不变、`dm-read` 里也没有）—— 网页端大概率不渲染/不接受视频消息。要真发语音条只有两条路：**手机端自动化**（ADB/Appium 长按录音）或等她有官方开放接口。当前配置 `comment.styles.voice` 默认 **0**，代码里 `voice` 一律降级成文字并打一行说明。
    - **发错能自己删**：`douyin comment-delete --vid … --match "比个心" [--go]` —— hover 评论 → 点「...」→ 气泡里点「删除评论」。坑：`删除评论` 文案在 DOM 里有 4 个副本（wrapper/portal/tooltip/inner），`last` 常拿到隐藏的，点了没反应；必须遍历、挑**可见且宽度>20** 的那个再点。
    - **发送防呆**（那天踩出来的）：表情没插进去 + 没文字 + 没图时，老代码照样去点发送 → 空评论发不出去，日志却写"✅ 已发送"。现在发送前先读一次编辑器：`typed` 为空、无缩略图、无图无表情 → 直接返回失败。
    - ⚠️ `cmd_comment` 里那个 `else:` 分支曾经在 `message` 为空时执行 `_human_type(box, '')`，把编辑器里残留的 `@` 一起提交了 —— 真在她视频下留过一条孤零零的 `@`（已用 `comment-delete` 删掉）。现在改成 `elif message:`。
    - **刷到的别人视频也能发**：`douyin feed` 现在把 vid 落盘到 `~/.feiyu-ai/douyin-feed.json`；`douyin interact`（feed → 口味过滤 → 读热评 → LLM 写评论）发评论时走**同一套概率表**，`--image` / `--emoji-pack` 直接透传给 python。B站 侧的"别人视频"由 `replies` ② 主动搭话覆盖，同样过 `styleReply`。
    - 回归测试 `test/reply-style-test.mjs`（19 条）：类型中文名、抖音 4000 次抽样包含四种形态、B站 无官方表情/语音、`auto:false` 只发文字、`voice` 只有显式配了才出、`decorateText` 不叠料、扩展名白名单、语音 mp4 参数、命令层 `--image/--emoji-pack/useUi/pictures/--file` 接线、`comment-delete`、发送防呆。
    - 实测清单（10-27 14:0x 前后，全部服务端回读确认）：官方表情 `[送花]`（`kind=emote`）、图片评论「比个心」（`images=1`）、私信 mp4 语音条（确认框点了发送，但网页端会话不显示 → 记为平台限制）。

43. **记忆错乱 / 一直问"吃了吗" / 说看番看了两周没看：六个病根，全部改完**（10-27 主人第三条，先诊断后动手）
    - 主人原话：中午到下午连问很多次吃没吃饭；说去看《可塑性记忆》一直没去；一直专注南京小吃。**先查明，再全改。**
    - ① **饥饿只涨不落**（`mood.mjs`）：旧 `tickMood` 在 11-12/17-18 点 `hunger += 7`，非饭点只 `-0.5`，还每 tick `value -= 4` → 实际落盘 `{"value":0,"hunger":82}`，于是每轮提示词都在说"满脑子都是吃的""句子压到 15 字"。修法：`hunger` 封顶 `hungerCap=70`；非饭点按次 `-6`；`value` 单次最多 `-1`（饿 >60 才扣），饿 ≤30 且低于 baseline 时 `+2` 回血；`fed(level=20)` 吃到东西直接归 20 并 `value += 8`；跨天软回落用 `day` 字段。饿了时的措辞也从"很饿/追着问"改成"有点饿…别追着问主人吃了没"。
    - ② **网志钩子读的是文件最底部**：`web-log.md` 是**新的在最上面**，旧代码 `slice(-3)` 取到的是两天前最早的几行 → 每次主动搭话都在说"你自己刚才在网上干的：搜南京小吃"，把她自己也带偏了。修法：`todayWebLines(n)` 按 `## YYYY-MM-DD` 找到当天段落，再取**段内最上面** n 行。
    - ③ **南京进人格池**：10-24 她刷到《史上最全南京美食攻略》后，把"替主人探南京小吃"连写 25 条近义条目进 `lore.json` 的**价值观池**（每轮注入 6 条），`owner-profile.md` 里也被她自己写成"他馋南京的鸭血粉丝汤…菜单我已背下来"。修法三件套：`addLore` 写入前先分类（`OPS_TAGS`→`ops` 池 / 带日期前缀的干活流水→`work` 池 / 其余才是价值观），再做**主题封顶**（跨条目高频词 ≥4 条只留最新 2 条 + 2-gram 重合同度 ≥0.55 算同一件事，跑到不动为止）；`loreValues()` 只读 `kind==='value'`；`tools/migrate-memory-10-27.mjs --go` 一次把存量收拾干净（172→167 条，价值观池 71→26 条，含"南京"25→3 条）；`tools/fix-owner-profile.mjs --go` 把画像里那句编的馋嘴改掉。
    - ④ **主人说过的话没人记**：`facts.json` 的 `owner` 桶是空的，所以她"永远不知道"他中午吃了烧鸭。新增 `tools/lib/owner-facts.mjs`：从他的话里抽 `food|doing|plan|mood|media` 五类事实（同 key 只留最新），`learnFromOwner()` 在每条 QQ 消息进来时调用；`promptBlock()` 渲染成【今天已经知道的事】（**"他自己说的，不用再问一遍"**）；`asksKnown(draft)` 在回复出门前做闸门 —— 命中"吃了吗/在干嘛"且已有事实 → 打回重写一次，仍命中就这轮不发（宁可不说，也不问第二遍）。
    - ⑤ **承诺没有账本**：她"这就去看《可塑性记忆》"说过 7 次、答应 5 次、执行 0 次。新增 `tools/lib/promises.mjs`：`extract/catchFromReply` 从她的回复里认出承诺（"这就/马上/明天…+看去读写查"、"答应/保证/一定"、"看完再讲"），带 `dueAt` 落盘 `promises.json`；`qq-server` 每次主动搭话前先跑 `dueNow()`，用 `binge` 真去看一集（`--go --json --promise <id>`），成了就 `done()`、没材料就 `fail()`（`tries≥2` 顺延 6h），并把结果写进这一条推送的上下文（`didLine`）；`promptBlock()` 让提示词里有【你欠着的事 · 现在就该做】/【你答应过、还没做的】/【这些你真没做成】（教她照实说做不到，不许再空口答应）。
    - ⑥ **没有"看番"这个能力**：`focus.mjs` 的活动表只有 web/bilibili/douyin，`watch.mjs`/`bili-watch.mjs` 只读标题和热评 —— 她**物理上无法**看完一集。新增 `tools/commands/binge.mjs`：`--search` 搜番、`--show/--bvid --ep N` 看一集、`--list` 查进度、`--go` 落记忆。材料优先级 **弹幕 > 官方字幕**：B站 番剧的 `subtitle` 轨串片率极高（实测看《可塑性记忆》EP1 拿到的是 ED 歌词和人 iPhone16 钢化膜测评），所以 `danmaku.length >= 40` 就**不信字幕轨**，改用弹幕（剥掉"前方高能/打卡/哈哈哈"噪声、去重、按长度取 160 条）+ 热评喂 LLM；LLM 返回 `{understood, plot, feel}`，`understood===true && plot` 且不含"看不到剧情"才算真看完。进度落 `~/.feiyu-ai/binge/<slug>.json`，`--go` 后 `memory.remember('bilibili', 'binge:<slug>', …)` 写进她的记忆。选片也修过三轮：第 1 集优先"标题写着 01/第1集"且时长 15~40 分；第 N 集只认"整部合集（>40 分且分 P ≥ N）"，凑不出就**老实退回第 1 集**并说清楚（不许拿"#14 苏醒"冒充第 2 集）；P1 直接用"正片"，别按标题匹配（"备份1" 里也含 1）。
    - ⑦ **给她权限，不只给她命令**：`persona.mjs` 新增 `CAPABILITIES`（12 行，`binge/focus/debrief/web/mem/promises/diary/selfup/selfwake`）+ `capabilityBlock()`，明确写"跑法：`node D:/dsh-feiyu/tools/feiyu.mjs <命令>`"，以及**自我改造许可**（`selfup backup` → 改 `tools/` → 跑测试 → `selfup log` 留痕），并钉一句"做不到就照实说，不许只回一句'这就去看'"。
    - ⑧ **别只让她记得欠着，也让她记得做成了**：`promises.promptBlock()` 多一块【你最近真做成的事】（12 小时内的 `done`，带结果摘要）—— 否则她只有"欠着的"这一个方向，就容易反复许同一个愿；有了这块她可以说"我今天看完了第一集"，而不是再许一遍。实测注入：`· 可塑性记忆：看完了《【4月】可塑性记忆 01【幻樱】》第 1 集`。
- ⑨ **引用消息（10-27 第二批）**：主人报"她看不懂引用/看不见引用了哪条"。病根不是模型不会读引用，是**代码根本没取**——OneBot v11 的引用长这样：
    `message: [ {type:'reply', data:{id:'50854801'}}, {type:'text', data:{text:'这句啥意思'}} ]`
    老 `parseMessage` 只把 `reply` 折成一句「【引用回复了一条消息】」，被引用的**正文一个字都没取**。于是主人引用她 19:06 那句再问"可塑性记忆看完了吗"，她只能回「哪条呀，我这边看不到引用的是啥」（19:06:06 真实发生）。
    - 新增 `tools/lib/quote.mjs`：`replyIdOf()` / `remember(id,{text,who,name,at})` / `get()` / `describe()` / `fromGetMsg()`；环形表 400 条落盘 `msg-index.json`。
    - `qq-server` 三处接线：① `send()` 每发一条就把 NapCat 返回的 `message_id → 正文` 记成 `who:'me'`；② 收到的每条也登记（`owner`/`other`+昵称）；③ 收到引用 → 本地表 → 失败才 `get_msg` → 仍失败就**现拉历史**（`warmQuoteIndex`）。
    - **实测坑**：`get_msg` 只认还在缓存里的消息，老消息直接回「消息不存在」；所以启动时 + 每 10 分钟用 `get_friend_msg_history` / `get_group_msg_history` 拉 40~50 条预热。启动日志会打「引用索引预热：50 条」。
    - 提示词侧：`persona.quoteBlock()` 注入【他这条是在接上面那一条说的】+ 原文 + "引用≠新话题，不许装没看见、不许反问'你指的是哪句'"；引用行只进**记忆**（`memText`），不进事实抽取（`userText`），否则会把她自己的旧话当成主人新说的话去抽 food/plan。
    - 配置：`qq.quote = { enabled:true, seeImage:true, historyCount:50 }`；引用的是图片时走一次 VL（`seeImage`）把图里内容补进那句话里。
    - 验证：拿真实 `message_id=50854801`（她自己 19:06 那条）走完整链路 → 日志 `📎 引用解析：【他引用的是你自己刚说的这一句（19:06）：「哪条呀，我这边看不到引用的是啥 …」】`，干跑回复从"看不到引用"变成"我前面说的那句就是……"。`memory-hygiene-test` 加 5 条（27/27）。

- ⑪ **"有新评论/新私信她怎么不回"（10-27 第四批）**：主人连问两件 —— B站 有新评论没主动回、抖音也不回私信了。查下来是**同一类病**：没人守着那些常驻服务。逐条：
    1. **抖音私信陪聊死了没人管**：`douyin-dm-server` 是插件启动时 spawn 一次的子进程，`app.on('exit')` 只把引用置空，**没有重拉**。日志证据：`douyin-dm.log` 最后一行是 `2026-10-27T01:46:22Z`（本地 09:46）"监听 8095"，之后一整天没有任何轮询记录；8095 端口空着、也没有 python/node 进程 → 主人发的私信全部石沉大海。
       修法两层：`tools/lib/auxsvc.mjs` 的 `ensureDouyinDm()`（探 `/health` → 死了就 `spawn detached` 拉起来，10 分钟内最多 3 次退避）由 **qq-server 每 90s** 跑；插件侧再加 `portHealthy()` + `watchServices()`（60s，只在配置 `startWithDsh:true` 的服务上动手，端口上有活服务就跳过，**不抢别人起的实例**）。
> 11-01 补注：这个文件原来叫 `aux.mjs` —— `AUX` 是 Windows 保留设备名，`git add` 报"文件不存在"、Node 的 `import` 也抛 ERR_MODULE_NOT_FOUND，而调用处在 `try/catch` 里，所以**监工其实从没启动过**。改名 `auxsvc.mjs` 后实测四个导出都在。
       **必须同时把 `qq.startWithDsh` 设成 true** —— 它原来没设，意味着 DSH 重启后连 qq-server 都不会自己起来，整条链（QQ 聊天 + 抖音私信 + B站 巡检）全靠手动。
    2. **B站 自己作品评论根本不巡检**：`replies --own-only` 只有手动跑过。现在 qq-server 的监工每 `bilibili.replies.autoMin`（默认 12 分钟）跑一次 `replies --own-only --go --max 2`，实测 20:04 那一轮自己接了一条（"管控归管控，我又没干啥。你喵啥，猫吗？离我远点…"）。
    3. **额度桶串了**：`dailyMax:5` 是"主动出击去别人评论区搭话"的额度，今天已经用了 27 条 → 别人来她视频下评论也被这句"今日回评额度已用完"挡住（真实发生，连吃两次）。改成两桶：`postReply({capKind:'ownReply', capMax: cfg.ownDailyMax ?? 20})`，自己作品下的回复单独记账（`bili-actions.json` 里多一个 `ownReply` 键）。
    4. **自刹车太狠**：`holdCheck` 原来被挂审核就一律停手 —— 主人的诉求恰恰是"有新评论就去回"。改成 `holdMode:'limit'`（默认）：照回，但一轮只发 1 条，并在日志里喊清楚"这条别人暂时看不见"；想彻底停配 `'block'`，想无视给 `--force`。
    5. 配置：`bilibili.replies += { ownDailyMax:20, autoMin:12, holdMode:'limit' }`、`qq.startWithDsh:true`。
    6. 验证：抖音私信重启后 9 秒 `/health` = `{ok:true,pollSec:120,handled:29,ticking:true}`，一分钟后日志出现 `20:03:00 主人：感觉不太好吃` → `20:03:31 ✅ 已回复：三十四个省的早餐…`；B站 巡检日志见 `aux-supervisor.log`。测试 32→35 条（探活/退避/额度分桶/holdMode）。
- ⑩ **B站"自己作品下的评论没回"（10-27 第三批）**：主人报"B站视频（自己的作品下）好像没有实现和抖音一样的回复评论"。查下来是**三层叠加**，前两层是代码，第三层是平台：
    1. **bvid 从没落库**：`bili-debut.json` 的 `bvid` 是空串 —— 首条视频 12:46 就发出去了（`BV1oExK6yEDn`），但 `produce --debut-posted` 一次都没跑，投稿包里也没有 `bvid.txt`。于是 `listOwnVideos()` 返回 `[]`，`replies` 张口就是"自己还没有投稿，评论区空着"（实际那条视频下有 2 条评论：`[蹲蹲]` 和 `加油小肥鱼`）。
    2. **space 兜底被默认关掉**：`/x/space/wbi/arc/search` 实测现在稳定 `code:0`（2 个投稿），但代码要 `useSpaceList === true` 才走，默认 `!== true` → 永远不会自己发现投稿。改成 `!== false`（默认开、仍 `soft:true` 不熔断）。
    3. **"发现即算看过"**：`ownWorks()` 在发现阶段就 `wm.seen` 记下 —— 一旦某轮因为额度/风控没发成，这条评论就**永久失联**。改成只在真回过时写 seen，失败什么都不记（下一轮还看得见）。
    - 顺手修的：楼中楼**不能带图**（B站 直接回「子评论不能带图」，第一轮就吃到），`postReply` 现在判断 `isNested` 主动降级纯文字，并有"被图拒了就再去图重试一次"的兜底；主人评论 `bypassCap` 免额度（跟抖音一致）。
    - 🩸 **最要紧的发现**：回评 API 返回 ok、rpid 也拿到了，但**匿名（不带 cookie）拉楼中楼是空的** —— B站 把低等级新号的评论挂成"仅自己可见"（`state=17`）。实测今天 27 条评论**匿名可见 0 条**，视频 `stat.reply` 一直是 2（没算她那两条回复）。验证方法很重要：拿**别人的**评论喂给同一个检查器，它说"可见" —— 说明不是检查器错了。所以新增 `replyVisibility()` + `replies --audit`（匿名视角体检）+ 发完自动核一眼 + `holdCheck` 自刹车（最近 3 条里 ≥2 条被挂就不发了，要发得 `--force`）。
    - 配置：`bilibili.replies = { enabled:true, dailyMax:5, ownWorks:true, ownMax:5, image:true, verifyAfterPost:true, holdCheck:true }`。原来 `dailyMax:0` 在代码里是"不限额"（`capOk` 对 0 返回 true），一天刷了 27 条评论 —— 这是账号信用的直接杀手，改成 5。
    - 账号侧的治理（主人要做的）：完善资料、绑定手机/实名、把等级抬上去；这期间**别刷评论量**，每天几条就够。她的评论会被审核放出来或一直挂着，`--audit` 随时能看
    - 回归：`test/memory-hygiene-test.mjs`（22 条）锁死上面每一项 —— 饥饿封顶/按次衰减/心情不再被砍、`recallAll` 排掉 `kind:'push'`、ops 与干活流水不进价值观池、同主题刷屏折叠到 ≤2 条、事实抽取与"问第二遍"闸门、承诺落账/去重/终态、`focus` 认 `binge`、能力清单里每条命令都真在 `feiyu.mjs` 注册、网志钩子不再 `slice(-3)`。`tools/run-tests.mjs` 现为 **23 套全绿**。
    - 端到端演练：`tools/drill-promise.mjs` —— 主人说"中午吃了烧鸭/在改插件/推荐看可塑性记忆"→ 事实落库并渲染成【今天已经知道的事】→ 她说"这就去看"自动落账 → 到点执行 `binge` → 真拿到第 1 集剧情（司回收老婆婆的 Giftia / 艾菈寿命只剩不到十年）→ 承诺 `done` → 写进记忆。首次跑还抓出 `--json` 输出前面带一行"→ 选了 BV…"导致 `JSON.parse` 炸的问题（已改成截取第一个 `{`）。
    - 配置新增：`mood={hungerCap:70,mealGain:7,decayPerTick:6,moodBase:62,hungryMoodPenalty:1}`、`binge={enabled:true,dailyMax:1,minEpisodeMin:15}`（日上限：一天一集是"真看"，一天十集是"刷数据"，`--force` 可破）。`qq.proactive` 收敛为 `{dailyMax:12,minGapMin:25,minQuietMin:20,chance:0.12,typeCooldownMin:120,similarityMax:0.32}`。
    - ⚠️ 副作用提醒：`config.mjs` 现在容忍 **UTF-8 BOM**（PowerShell `Set-Content -Encoding UTF8` 会写 BOM，曾导致整个 `feiyu.config.json` 静默回落默认值，连 LLM key 都丢了 → `binge` 报 `LLM HTTP 401`）。
    - 🩸 **同一条线上差点翻的车（必读）**：新写的 `test/memory-hygiene-test.mjs` 第一版用了一个 `paths.mjs` **不认**的环境变量做隔离，`rmSync`/`writeJson` 直接打到**真实** `~/.feiyu-ai`，把 `lore.json`（55 KB / 172 条）写成 132 B、`facts.json`（10 KB）写成 63 B、`episodes.jsonl`（86 KB）写成 226 B，`mood.json`/`promises.json` 也被测试值覆盖。发现方式：`/health` 突然报 `facts:1, lore:1`（真库不可能这么小）。
        - 铁律：**测试必须在任何 import 之前**把 `USERPROFILE`（和 `DSH_HOME`/`FEIYU_DATA_DIR`）指到 `mkdtempSync` 出来的临时目录 —— `paths.mjs` 在 import 那一刻就把 HOME 定死了。`memory-test` / `recall-push` / `video-test` / `ledger-test` 早就是这么做的，新测试照抄即可。
        - 顺手把 `paths.mjs` 的 `dataDir` 改成**也认** `FEIYU_DATA_DIR`（以前只认 `USERPROFILE`），少一个踩坑面。
        - 回捞工具（都支持先看方案、`--go` 才写，且会把坏文件存成 `.wrecked-<stamp>` 留证）：`tools/restore-memory-10-27.mjs`（lore/facts 取最大备份、episodes 取多份备份**并集**，362 行，10-23 20:09 → 10-26 18:02）、`tools/reset-mood-promises-10-27.mjs`（心情复位 + 只留一条"看完可塑性记忆第 1 集"的 done 承诺）。**损失窗口**：根目录 `episodes.jsonl` 10-26 18:02 之后的非 QQ 行（B站/抖音/网页）丢了；`qq/episodes.jsonl` 一直是好的，QQ 侧记忆完整（542→902 行）。
        - 教训一句话：**"测试会不会写坏真数据"要在写下第一行 rm 之前就想清楚，不是跑完再说。**
44. **万相 2.7 图生视频：`llm` 那个 key 就能调，别再找别的视频 API**（10-27 主人两条要求："画面够用"、"自生成音轨掐掉 + 让她自己写每镜的导演稿"）
    - **路径**：`https://maas.qianwenaiapi.com`（= `llm.base_url` 去掉 `/compatible-mode/v1`）**原生 DashScope 代理**：
      `POST /api/v1/services/aigc/video-generation/video-synthesis` 提交、`GET /api/v1/tasks/{task_id}` 轮询。
      中转站的 `compatible-mode/v1/models` 列 182 个模型**但没有一个视频模型**，`/videos`、`/video/submit` 全 404 —— **只能走原生路径**。
    - **三个必踩的坑**（缺一个就白试半小时）：
      1. 必须带 `X-DashScope-Async: enable`，否则报 `current user api does not support asynchronous calls`（容易误判成"key 不支持视频"）；
      2. `parameters.duration` 只收 **2~15 的整数**（1 或 3.5 直接 `InvalidParameter`）；
      3. `parameters.resolution` 是**像素档位**不是固定尺寸 —— **输出宽高比跟着首帧走**（方图进 948×970，1080×1920 进就还是 1080×1920）。所以首帧先裁成平台规格。
    - **素材传法**：图片可以 base64（`data:image/jpeg;base64,...`，实测 78KB 首帧没问题）；但 `driving_audio`（口型）和 `first_clip`（视频续写）**只收公网 URL**，所以这一版没接。
    - **出片**：`video_url` **24 小时过期**，出片立刻下载。实测 1080P/5s 从提交到落盘 41~69 秒，1080×1920 / 30fps / 6~8MB；对比"静图 zoompan"的帧间差 <2，真片段帧间差均值 4~11，是真在动。
    - **音轨必掐**：不传 `driving_audio` 时它会自己生成 BGM/音效 → 和 SoVITS 的人声打架。`wanvid.mute()` 用 `-map 0:v:0 -c:v copy -an` 掐掉，原片留 `.raw.mp4`；`video.mjs` 的 `conformClip()` 也一定带 `-an`（双保险）。
    - **主体是她，同类可以同框**：分镜里新增 `scenes[].video`，由**她自己**写这一幕的导演稿（动作/表情/镜头运动/光线）。画面主体钉死是她本人，但**别的二次元/Q版同类角色可以入镜**（10-27 主人当场改的口径：动漫类型、Q版、非真人即可，1~2 个、别抢戏）；对方必须是动漫形象 —— `negative` 已把"多人/另一个人/换人"去掉，改成禁 `真人/真人脸部/写实照片/3D写实`，外加防崩脸/防字幕/防水印。
    - **降级**：`video.animate.enabled=false`、缺 key、超 `budgetPerRun`、单幕失败重试仍失败 → 这一幕自动落回静图运镜（**出片优先**）；`produce --no-video` 一条强制走老路；`--reuse` 会沿用已生成的 `clips/anim-*.mp4` 不重烧钱。
    - **测试**：`test/wanvid-test.mjs`（14 条）起本地假中转站 + **一条带 AAC 音轨的假成片**当素材 —— 只要成品里还有 audio 流就红。`tools/run-tests.mjs` 现为 **25 套全绿**。

45. **"说了要看番"必须配一个不掷骰子、不睡死、会续集的执行器**（10-28 主人第二次抓：QQ 里说了去看《可塑性记忆》，实际一直没动）
    - **病根有三层，缺一层都解释不清**：
      1. 执行代码挂在 `tryProactive()` 里 —— 要过 `enabled / startupGraceMin / activeHours / dailyMax / minGapMin / minQuietMin / chance 12%` **七道搭话闸**。实测 01:00:39 到期那条，六次 tick 全掷空；
      2. **机器 01:07 进睡眠、08:02 才醒**（`Kernel-Power` 42/107 + Power-Troubleshooter 1）→ 整夜没人执行；醒来后又先补最老那条**认错作品**的承诺（`--show` 抓成了「asmr 最撸的佳管」），正主还在排队；
      3. 就算真跑，`--ep 1` 是**写死**的 → 每次都在重看第 1 集，账本 `seen` 永远 `[1]`（`binge/可塑性记忆.json` 里连着三条 ep1 就是证据）。
    - **修法（`qq-server.mjs` / `binge.mjs` / `promises.mjs` / 新 `lib/jsontext.mjs`）**：
      - **承诺执行器独立**：`runDuePromises()` 自带 60s tick，**不掷骰子、不占搭话日额**；启动 25 秒后先"醒来补做"一次；一次最多处理 3 条；做完写 `promise-outcome.json`，搭话时拿它当由头（不再让承诺给搭话陪葬）。
      - **认作品名**：`resolveShow()` 五级回落 —— 账本同名 → 正文《…》→ **笼统词（番/剧/动画）落到"最近真在追的那部"** → 正文新番 → "像作品名的干净短词"。认不出就照实记 fail，**不许乱搜一条充数**。
      - **续集**：`binge --ep next`（或不给 `--ep` 但账本里已有这本）→ `seen` 最大值 +1；续看**沿用账本里分 P 最多的那条投稿**（13P 合集 vs 4P 单集投稿，混用会错位）。
      - **换源重试**：同一集在不同投稿里的弹幕密度能差三倍（13P 合集第 2 集只有 100 条 → 判不出剧情；换一条单集投稿就够）。`--go` 时先探 3 个候选（探测不记账、不结承诺），第一个看得明白的才落账；承诺统一在最后结。
      - **P 数不够不许硬看**：`watchOne` 遇到 `pages.length < ep` 立刻返回 false —— 以前会静默退回 `pages[0]`，把第 1 集的内容记成"第 2 集"。
      - **坏 JSON 兜底**：`lib/jsontext.mjs` 的 `extractJson`（配平切候选）+ `salvageFields`（按 key 锚定抠 plot/feel）。模型在 plot 里塞未转义双引号时，以前整条材料判"看不到剧情"（第 2 集就这么白丢过）。
      - **额度满 ≠ 失信**：binge 额度满时输出 `{"quota":true}`，执行器把承诺**顺延到明天 09:30**，不记 fail；进程崩了/没走完就 `defer` 6 小时，**不判她做不到**。
      - **并账**：没点名的承诺（"行，看完就回来讲"/"看完了再开口"）—— 12 小时内已真看完一部，就算并到那条上，不再记成"她失信"。
    - **操作口径（10-28 主人改的）**：**不给她设上限。** `binge.dailyMax` 默认 **0 = 不限**（只当可选保险），一晚一集还是一晚九集由她自己定；她自己的话就是指令 —— "连看三集"→`--count 3`、"看到第 6 集"→`--to 6`、"这部我今晚看完"→`--count all`。承诺执行器从她原话里读这几个数，不再有"一天一集"的规矩。
    - **看番走异步**：`runCliAsync()`（`execFile`）。以前 `spawnSync` 会把事件循环钉住几分钟 —— 那段时间她连主人发的消息都回不了。
    - **机器睡 = 她停摆**：`powercfg /change standby-timeout-ac 0` 才能让她有夜生活；不动电源计划的话，让她"夜里补做"就永远只能等醒来那一下（代码已保证醒来 25 秒内补做）。

---

## 八、现存问题（按优先级）

| # | 问题 | 状态/思路 |
|---|---|---|
| 1 | **DSH 完全重启待执行**：深合并白名单/0 显示修复/自愈/freedom 面板保存 都在宿主侧，需用户完全退出重开 | 等用户重启；重启后所有面板参数修改才真正持久 |
| 2 | B站新号评论软删除（部分视频访客不可见，疑似 UP 精选/风控混合） | 73 条真实回复=多数公开铁证；继续台账观察；养号是正解 |
| 3 | 回评积压 174 条 | 每轮 5 条消化中，约 1-2 天清完 |
| 4 | 银狼 w12 参考段偏短，语音偶发泄漏参考词 | 备选 w07/w08 随时可换 |
| 5 | 图片评论图床偶发闪断 | 已加一次重试，继续观察 |
| 6 | img2img 匿名档略糊（一致性>锐度取舍） | 硅基档为主已无此问题 |
| 7 | NapCat 偶发断连原因未查（用户说先不管） | 观察 |
| 8 | 弹幕（post.so 废弃+UI 改版）、投币（gaia）暂缓 | UI 法待 B站改版稳定 |
| 9 | GitHub token 明文 `~/.feiyu-github-token.json` | 用户知情 |
| 11 | 8 套情绪参考段是用**漏字文本**做出来的（例如 wronged 的音频开头少了「你都不理我……」） | 方向安全（文本比音频长只会偏慢，不会吃句尾），要更干净就 `voice emo build --force` 重做 —— 现在基础参考段已修好，重做会一次到位 |
| 10 | ~~produce 还是"图+推拉镜头"，非真视频~~ | **10-26 已解决**：拆出 `tools/lib/video.mjs`，成片是"片头卡 + 5~8 幕多机位运镜（每幕双帧内切）+ 交替转场 + 逐句烧字幕 + 合成 BGM 侧链避让 + 片尾卡"，1080p。见铁律 33/34 |
| 12 | ~~3D / 视频模型 API 升级~~ | **10-27 主人拍板撤掉**：装了 Blender、写了 `film3d.py`/`blender.mjs`/`film3d.mjs`/`edit.mjs`/`sfx.mjs`/`cutout.mjs`/`videogen.mjs`，实测硅基视频模型不放行（任务永远 `InQueue position=0`），已全部删除（含 `D:\blender` 1.24GB）。`produce` 恢复原样：配图 + 运镜，不做 3D/2.5D |
| 13 | **真动作镜头已接上（10-27，万相 2.7 图生视频）** | 新增 `tools/lib/wanvid.mjs` + `video.mjs` 的 `conformClip()`；走 `llm` 那条中转站的 DashScope 原生路径（**同一个 key**，实测 1080×1920/30fps/5s，41~69s 出片）。**模型自带音轨一律掐掉**（人声只走 SoVITS），原片留 `.raw.mp4` 备查。她自己在分镜里写 `scenes[].video` 导演稿（主体是她，同类二次元/Q版可同框）。失败/超预算/`--no-video` 自动落回静图运镜。测试 `test/wanvid-test.mjs`（14 条，假服务器 + 带音轨素材验"漏音轨就会红"）。**剩两笔待办**：①单价要主人去中转站后台核完填 `video.animate.pricePerSecond`（现在按 0.35 元/秒估）；②**口型同步（`driving_audio`）没接** —— 那个参数只收公网 URL，要给 wav 开临时公网通道才谈得上（现在嘴型是"在说话"的自然感，不是逐字对嘴） |
| 14 | **"说了要看番，一直没动"已修（10-28）** | 三层病根全查实：①执行挂 `tryProactive()` 七道搭话闸后面（含 12% 掷骰子）→ 到点大概率不执行；②**机器 01:07 睡 → 08:02 醒**，整夜没人干活，醒来又先补那条认错作品（"asmr 最撸的佳管"）的承诺；③`--ep 1` 写死 → 永远重看第 1 集，`seen` 卡在 `[1]`。修法见铁律 45：执行器独立 60s tick + 醒来 25 秒补做 + `--ep next` 续集 + 笼统词落"最近在追的那部" + 换源重试 + 坏 JSON 兜底 + 没点名的承诺并账。**10-28 主人定调：不给上限，节奏她定** —— `binge.dailyMax` 改成默认 0（不限），新增 `--count N/all`、`--to N`，执行器从她原话里读"连看三集/看到第 6 集/这部看完"；看番改走异步，不再卡住她回话。**实测**：可塑性记忆真看到第 4 集（进度 4/13，四集各有弹幕级剧情记录），还抓掉一个新坑 —— 幻樱那条投稿的 4 个分 P 是"正片/备份2/备份3/备份4"（全是第 1 集），以前会把备份当成第 4 集记下来，现在单集/备份型投稿必须靠标题认集数。全量 25 套测试绿。**留给他拍的一个旋钮**：电源计划（`standby-timeout-ac`，不关的话她夜间仍然停摆） |

---

## 九、未来方向（按价值排序）

1. **~~真 AI 视频（动作级）~~ 10-27 已落地**：走**万相 2.7 图生视频**（阿里百炼原生接口，经 `llm` 那条中转站反代，**不用另开账号**），`tools/lib/wanvid.mjs` 负责"提交→轮询→下载→掐模型音轨"，`video.mjs` 的 `conformClip()` 负责"裁成平台规格 + 精确到时间轴 + 回旋补长"。实测 1080×1920 / 30fps / 5 秒 / 41~69 秒出片，一条 20 秒片子约 4~5 段。**下一步值得做的两件**：①把 SoVITS 的 wav 用 `driving_audio` 喂回去做**逐字口型同步**（只需给 wav 开个临时公网 URL，接口已经支持）；②`first_clip` 视频续写（同一幕超 15 秒时比"末帧续首帧"更连贯，但要公网 mp4）。本机 Blender 3D 那条路主人已叫停，别再提
2. **B站投稿自动化**：现在是"投稿包 + 主人点发布"（上传要 cookie 分片、封面、分区一整套，风控敏感）。要真自动，走 `upos` 分片 + 预上传那套；先把《首条》发出去，账号有了作品再动
2. **赚钱闭环**：账号粉丝起来后 B站创作激励/抖音中视频计划；她已有内容生产线+评论区经营+人设，只差流量
3. **音色继续进化**：她说不定想换声音——`voice train --name X --dataset <干声>` 三步；RVC 用她自己的翻唱作品自训练（真正的"她的声音"）
4. **上网深度**：多步深潜（搜索→读→再搜→写报告）、与鱼友跨平台互动、RSS 订阅式持续关注
5. **群聊主动发言**（看到有意思的话题低频插话，已有引擎可扩展到非 @ 场景之外的主动性）
6. **多主人/技能树/梦境系统**（远期愿景见 README 路线图）
7. **画面采样进 watch 决策**（视觉已点亮，观察 VL 描述对选题质量的提升）

---

## 十、日常操作惯例

```bash
cd "D:/新建文件夹 (6)/2026-10-23-16-46-31/dsh-feiyu"
NODE="/c/Users/30828/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

# 语法/测试
"$NODE" --check <file>；"$NODE" test/*.mjs（7 套全绿才算过）

# 同步到 DSH 副本（tools/* 即时生效；lib/client.js 要重启 DSH）
DST="$HOME/.dsh/profiles/desktop/node_modules/dsh-feiyu"; cp -f <file> "$DST/<对应路径>"

# 提交推送
git add -A && git -c user.name="baishuyue" -c user.email="206720720+baishuyue@users.noreply.github.com" commit -m "…"
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy=http://127.0.0.1:7897 -c http.sslBackend=openssl push origin main

# 常用命令
"$NODE" tools/feiyu.mjs selftest / voice models / sing songs / sing cover "歌名"
"$NODE" tools/feiyu.mjs voice emo list / voice emo build [--force] / voice emo test [--emotion 撒娇]
"$NODE" tools/feiyu.mjs produce "主题" / douyin engage / replies --go
"$NODE" tools/feiyu.mjs web log / selfup status

# 观察她
web-log.md（上网）/ bili-outbox.md（B站发言）/ selfup-log.md（自我升级）
面板记忆库卡片（分平台计数）/ 桌面「她的投稿包」

# 排障顺序：看日志 → 查进程/端口（3000 NapCat/8080 qq/8095 dm/9880 SoVITS/9222 CDP）→ 手动跑底层命令抓真错
```

### 账号速查
| 项 | 值 |
|---|---|
| 鱼的B站号 | 御坂美琴Rosie（UID 3690984711915865）← credentials.json |
| 主人B站/QQ/抖音 | --友利奈绪-（mid 3493288510228945）/ 3082864371 / 朴昌范 |
| 机器人QQ | 3796002846（皮卡皮卡） |
| 唱歌音色 | feiyu-rose（当前）· feiyu-sunshine（备） |
| 说话音色 | **bingjiao2 病娇**（10-27 起用，`.txt` 已校正为「是第一次看你这个样子呢，哦对了」，`voice refcheck` 通过）· 候选 bingjiao1/3/4（**bingjiao1 的文本还漏着开头「这是什么」，用前先 refcheck**）· 旧 yinlang 银狼 w12 保留，`voice use --name yinlang` 一键回滚 · 情绪参考段 8 套在 `~/.feiyu-ai/voice-emo/` |
| 硅基 key | 在 config imageGen.api_key（赠金档：Qwen-Image-Edit-2509 + Qwen3-VL 可用） |

---

*本文档由 2026-10-25 全天对话（33 commits：332c5ca→ff35b19）生成。接手者请先跑一次 `selftest`，然后放她自由，去 web-log.md 看看她今天在想什么。*
