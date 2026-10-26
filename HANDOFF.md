# dsh-feiyu 项目交接文档 v2

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
│   ├── scheduler.js        60s tick：生物钟 + 动态定时 + 人格进化 + 完全自由唤醒 + 抖音巡检
│   └── node-runtime.js     探测 DSH 自带 node
├── client.js               面板（13 张卡片，深合并镜像）
├── tools/                  工具链（spawn 真 node，改完即时生效）
│   ├── feiyu.mjs           CLI 分发（24 命令）
│   ├── commands/           act/bili-watch/comment/debrief/diary/douyin/douyin-dm-server/
│   │                       feed/mem/nav/produce/qq-server/quota/qzone/replies/report/
│   │                       review/selftest/selfup/sing/sticker/vision/voice/watch/web
│   └── lib/                bili-api/bili-write/config/cred/guard/llm/lock/mood/memory/
│                           night-plan/notify/paths/persona/qq-memory/rvc/share-policy/
│                           sing/stickers/tts/vision/imggen(含 editImage)/outbox
├── douyin_interact.py      镜像副本（实际运行 D:/social-auto-upload/，改 D 盘后 cp 回来）
└── test/                   7 套测试（client-smoke/render/stickers/memory/qq-human/imggen/vision）
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
- **说话音色三迁**：sunshine → rose（太糊被否）→ **银狼 yinlang w12**（B站纯人声合集 → 17 窗 SenseVoice 转录打分选段，「战斗体验该优化了，哼就这速度太慢了」傲娇浓度拉满）

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
| **B站** | 生物钟看视频写日记；自由刷（评论/弹幕/点赞/投币/图片评论/关注/鱼圈）；回评引擎（主人优先免额度/鱼友优先/主动搭话）；动态定时 09:30/21:30 | 自由刷进程（完全自由自动拉起） |
| **抖音** | 自主观看+评论+分享；私信陪聊（全类型理解+VL 看图）；engage 评论区按需回复；produce 短视频生产（投稿包，发布权在主人） | 完全自由定时/手动 |
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
| `douyin` | atMention | true | 评论带 @（注意风控） |
| `douyin.engage` | enabled/dailyMax | true/0 | 评论区按需回复 |
| `douyin.produce` | enabled/dailyMax | true/0 | 视频生产额度 |
| `douyin.dm` | enabled/pollSec/port | —/300/8095 | 私信陪聊（8090 被 Wondershare 占） |
| `bilibili` | danmaku/dynamic/react/imageComment/replies/fishCircle/follow | 各自 enabled+dailyMax | 活人感写通道（额度 0=不限） |
| `bilibili.freeRoam` | enabled/unlimited/maxVideos/maxMinutes/restMin | — | B站自由刷 |
| `imageGen` | provider/api_key/model/refImage/dailyMax | siliconflow/…/Qwen-Image-Edit-2509/…/30 | 表情包与配图（refImage=形象锚） |
| `vision` | provider/base_url/model/api_key | openai/硅基/Qwen3-VL-8B | 视觉理解 |
| `web.roam` | enabled/restMin | —/2 | 自由上网（轮间休息分钟） |
| `web.selfUpgrade` | enabled | true | 允许改自己代码 |
| `personality.evolve` | enabled/days | true/2 | 人格进化 |
| `freedom` | enabled/wakeEveryMin/chance/engageEveryMin | —/75/0.55/120 | 完全自由节奏 |
| `voice` | ref_audio_path/prompt_text/prompt_lang | 银狼 w12/zh | 说话音色三件套 |
| `rvc` | root/python/ffmpeg | D盘路径 | 唱歌系统 |
| `llm` | api_key/base_url/model | DeepSeek | 实时推理 |

**额度哲学**：所有 dailyMax **0 = 不限**；账本按天自动清零；账本文件 quota.json / bili-actions.json / douyin-{share,comment,produce}.json / imggen.json。

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
| `D:/GPT-SoVITS/models/` | 说话音色库（yinlang/rose/sunshine_girl） |
| 日志 | qq-server.log / bili-watch.log / watch.log / douyin-dm.log / web-log.md / selfup-log.md |

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
17. **git**：user baishuyue / `206720720+baishuyue@users.noreply.github.com`；推送走 Clash 7897（`env -u http_proxy … git -c http.proxy=… push`）

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
| 10 | produce 还是"图+推拉镜头"，非真视频 | 见未来方向 |

---

## 九、未来方向（按价值排序）

1. **真 AI 视频**：接入即梦/可灵 API（付费）生成动态分镜，替换 Ken Burns 静图——produce 质变
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
| 说话音色 | yinlang 银狼 w12（傲娇） |
| 硅基 key | 在 config imageGen.api_key（赠金档：Qwen-Image-Edit-2509 + Qwen3-VL 可用） |

---

*本文档由 2026-10-25 全天对话（33 commits：332c5ca→ff35b19）生成。接手者请先跑一次 `selftest`，然后放她自由，去 web-log.md 看看她今天在想什么。*
