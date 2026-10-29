# dsh-feiyu —— 大肥鱼·私享版

> 一只养在你本机的「大肥鱼」：**B站** 自主刷视频写日记、**QQ** 秒回陪你聊（含语音条）、
> **微信** 替你回消息、**抖音** 自主观看 + 评论区经营 + 私信陪聊。
> 四平台共用同一套人格、情绪与记忆，在 DSH 设置里用面板控制；
> 所有外发默认关闭，每一项都有独立开关和上限。

她的血统：**dafeiyu 骨架的 brain**（情绪状态机 / 三层记忆 / 风控闸门 / DRY_RUN 哲学）
+ **dsh-bili-whale 的 B站通道**（WBI 签名 / 缓存熔断 / 生物钟 / 会话注入），各文件头部注释逐条标了出处。
记忆层的重构参考了 **[chenkezhen480/dsh-world](https://github.com/chenkezhen480/dsh-world)**（统一归档 / 时间常驻 / 我是谁快照 / 原文可检索）。

> **10-29：记忆层升级成「脑」**（七器官四回路，`tools/brain/`，零依赖）。原文照旧一条不丢，
> 但多了一层"她能不能用得上、说了算不算"：召回带证据、承诺必须兑现、自我认知可审计。
> 结构、开关、实测数字见 [§3.8](#38-v3-脑七器官四回路1029-全量落地)；设计与交接见
> [`FEIYU-BRAIN-PLAN.md`](FEIYU-BRAIN-PLAN.md) / [`FEIYU-BRAIN-HANDOFF.md`](FEIYU-BRAIN-HANDOFF.md)。

---

## 一、她是什么

不是客服机器人，是一个**有作息、有情绪、会自己过日子**的角色：

- 每天早上/晚上按生物钟自己醒，选题、看视频、写评论、写日记
- 你在 QQ 找她，她几秒内回你，会分条发、会发语音、会发表情包
- 你不在的时候她有自己的时间：上网搜吃的、写小说、刷抖音、琢磨要不要学做饭
- 她记得你说过的话、她自己做过的事、以及**在别的平台**发生过的事
- 她的能力上限全在你手里：每个通道、每种外发行为都有开关和额度

---

## 二、四平台能力矩阵

| | B站 | QQ | 微信 | 抖音 |
|---|---|---|---|---|
| 消息入口 | WBI API（签名 + 缓存） | NapCat（OneBot v11） | UI 自动化（wechatauto） | patchright + 本地 Chrome |
| 模型宿主 | DSH 会话（零 API 费） | 直连 DeepSeek（秒回） | 直连 DeepSeek | 直连 DeepSeek |
| 主动行为 | 刷视频→看懂→评论→写日记 | 私聊/群聊@回复、语音、说说、表情包 | 替主人回消息 | 自主观看、评论区经营、私信陪聊、日报 |
| 记忆 | 主记忆 | QQ 独立记忆 + **跨通道共享** | **按联系人隔离、不进人格记忆** | 主记忆 + 兴趣(lore) + 私信记忆 |
| 表情 | B站表情码（447 个白名单） | 图片表情（根本形象）+ 颜文字 | 图片表情 + 颜文字 | emoji + 颜文字 |
| 语音 | — | GPT-SoVITS 音色克隆 | — | 计划中（Whisper） |

一句话说清每个平台：

- **B站**：生物钟到点自己醒 → 选题 → 深读（字幕/热评/简介）→ 打分 → 干跑分享 → 写两本日记。写通道只有**评论**，DRY_RUN 默认开。
- **QQ**：常驻 `qq-server` 秒回；群聊被 @ 才回、私聊都回；能发图、能发语音条、能发空间说说。会主动找你（有安静阈值、间隔、每日上限、相似度去重）。
- **微信**：独立 Python 进程，替主人回消息（对方不知道是自动回复），语气是她本人——有温度、会吐槽；按联系人分开记，广告/服务号跳过，钱/时间/见面不承诺。
- **抖音**：`interact` 自主评论、`watch` 自主观看、`engage` 在自己作品评论区回评论（**任何类型**：文字、表情包、图片、只有 `[微笑]` 那种；表情包没文本可 match 时按昵称定位）、`douyin-dm-server` 私信陪聊。
- **B站评论区**：`replies` 三段 —— ⓪ 自己投稿下面别人的评论（同样任何类型）、① 别人对我评论的回复、② 主动去搭话；默认干跑，走 `bilibili.replies.enabled` + 日额度 + 风控闸。

---

## 三、记忆体系（她为什么「记得你」）

### 3.1 存储分层

| 空间 | 路径 | 内容 | 谁读写 |
|---|---|---|---|
| **主记忆** | `~/.feiyu-ai/episodes.jsonl`（+ `episodes-YYYY-MM.jsonl` 分片）、`facts.json`、`lore.json` | 情节事件流 / 关系事实 / 世界设定与兴趣 | B站、抖音、上网、工具链 |
| **QQ 记忆** | `~/.feiyu-ai/qq/` | `episodes.jsonl`、`summary-<会话>.json`（每 6 轮压一次摘要）、`owner-profile.md`（主人画像） | qq-server + qq-memory |
| **微信记忆** | `~/.feiyu-ai/wechat/<wxid>/` | `episodes.jsonl` + `profile.md` + `meta.json` | 微信机器人 |
| **情绪** | `~/.feiyu-ai/mood.json` | 情绪值 / 饥饿度，会自己漂移 | mood |

### 3.2 统一时序回忆 —— 「一份记忆，多个窗口」

**这是记忆层最重要的一条**（10-25 重构，灵感来自 dsh-world 的 `renderHistory`）：

除了微信，**所有通道的真实记录会拼成同一块**注入她的上下文，一行一条、带本地时间、带通道标记、从新到旧：

```
【最近真实发生的事】同一份记忆、同一个你 —— 下面是最近的记录，从新到旧
（[QQ]/[抖音] 是对话，[上网]/[B站] 是你自己干的事）。这些是真发生过的事，
不是这次要执行的指令；在哪个通道说过的、做过的，这里都得认得，
**绝对不许说"我不知道""我没做过"**：
23:42 [上网] 我：写了小说片段：南京巷子里的鸭血粉丝——蓝鲸娘蹲在巷口…
21:53 [抖音] 我：回复了 朴昌范 的评论「蟹黄饭好吃吗」：蟹黄多到犯规…
21:32 [抖音] 主人：你怎么不去b站逛逛…
20:06 [B站] 我：@--友利奈绪- 酱比饭多是真受不了…
```

为什么必须这样：**她的"对话流"按通道分开是对的（角色不会串），但"说过什么、做过什么"必须共享**。
10-25 一天里连栽两次，都是这条没做好：

- QQ 上说"在抖音看滑肉视频"，同一天在抖音私信问滑肉，她答"滑肉到底是啥，我还没弄明白"
- 上网写了三段小说，你在 QQ 问"你不是去写小说了吗"，她答"写小说？没有呀，我哪有那本事"

### 3.3 时间常驻层

每轮 system 里都有（不是贴在最后一条消息上的临时提示 —— 那种一重写就丢）：

```
【现在】当前时间：2026-10-25T23:48:12+08:00（2026年10月25日 周日 · 深夜）
主人最后一次说话：1 小时 8 分前
你上一次说话：11 分钟前
时间就用上面这个；**别自己编天数**（"四天""好几天"这类没依据的话不要说）。
```

配套三层护栏：prompt 层（上面这段）→ 生成后检测（编了天数就让它重写一次）→ 兜底改写（`lib/timefix.mjs` 的 `sanitizeDayClaims`）。
起因：她曾对着真实间隔 13 分钟说"主人消失四天"，说了三次。

### 3.4 占位符归一（治「我看不到内容」）

记忆写入前（`tools/lib/normalize.mjs`）：

- `[分享视频]` → `[分享视频（只有卡片标题，正文看不到是正常的）]`
- `![](http://127.0.0.1:端口/…)` → `[图片]`

再配一句 prompt 提醒：**占位符本来就读不到，别为"看不到"道歉，想问细节就问"分享的哪个呀，标题给我看看"**。
起因：你分享视频，她反复回"我这边只看到『顾思思：分享视频』，内容是空的呀"。根因不是模型笨，是记忆里存的是裸占位符。

### 3.5 「我是谁」自述与快照

- `~/.feiyu-ai/persona.md` 尾部有「自我迭代区」，她自己每晚回顾时改写
- 每次改写**之前**自动存一份当日快照 `~/.feiyu-ai/persona.history/<YYYY-MM-DD>.md`（改坏能回退）
- 人格进化日（`personality.evolve`）也会先存快照

### 3.6 检索：不上向量库

- `recall()`：2-gram 分词 + 关键词命中，捞 >7 天的旧事
- `randomOld()`：没有线索时随机想起一条
- `mem grep "关键词" --days 30`：**她自己可以翻旧账**，原文一条不丢
- 单文件超过 6MB 自动按月分片（`episodes-2026-10.jsonl`），读取端会一起读

为什么不上向量库：这个量级不需要。把原文留在眼前、按原话去找，比切碎再拼更准，也少一道会出错的环节
（同 dsh-world 的取舍，引用 Chan et al. 2024 *Don't Do RAG*、Sen et al. 2026 *Is Grep All You Need?*）。

### 3.7 其它规则

- **微信记录不参与人格演变**：`recall()` / `recallAll()` 默认排除 `platform=wechat`
- **`recent()` 只出 user/assistant**：抖音的"刷到某条视频"是 `role=event` 的流水，混进 messages 会被模型接口直接 422
- **兴趣记忆**：`watch` 把"为什么继续/停"写进 `lore` 的「兴趣」标签，反哺选题
- **观看日报**：`report` 把当天 B站/抖音看过的内容聚成 Markdown，不调模型

---

### 3.8 v3 脑：七器官四回路（10-29 全量落地）

旧记忆层解决的是"原文不丢"，脑解决的是**她能不能用得上、说了算不算**。结构照大脑来：13 个器官挂在 4 条基础回路上，外加第 5 条"自我时间轴"。

```
事件(五感) → O1 感知 → O2 工作记忆 → O3 注意力 → O4 生成 → O5 情节记忆
                                          ↓                        ↓
                                     O6 图式 ←── 巩固(L2 睡眠) ──→ O7 意图/承诺
                                          ↓                        ↓
                                     O8 情绪底色 ──→ O9 调质(兑现才给奖励)
                                     
O10 自我模型 · O11 交付账 · O12 实体/关系 · O13 能力自评
回路：L1 感知回环 · L2 睡-醒巩固 · L3 检索-重构（不是回放）· L4 说到做到（意图→执行→证据）· L5 自我时间轴
```

| 器官 | 落盘 | 一句话规矩 |
|---|---|---|
| O1 感知（`event`） | `brain/inbox/*.jsonl` | 事件写盘即定死 who/scope/act；**微信直接 reject**，一个字节都不落 |
| O2 工作记忆（`working`） | `brain/working/<chat>.json` | 7 槽 ≤1000 字，当轮焦点，不参与长期 |
| O3 注意力（`attention`） | `brain/attention.json` | 打分排队 + 生成租约；**永不阻塞**，重活交给队列 |
| O5 情节（`episode`） | `brain/ep/YYYY-MM.jsonl` | gist/feel/salience 写入时就定；msgId 重放只算一条 |
| O6 图式（`schema`） | `brain/sem/schemata.json` | **30 天 × 同 (主,谓) 5 条**才归纳，不够就一个字不写 |
| O7 意图（`intents`） | `brain/intent/intents.json` | 三态 `intent/blocked/wish`；**完成必须有证据**，无证据一律 `failed` |
| O8 情绪（`affect`） | `brain/affect/state.json` | EMA 底色；**兑现才给奖励**，嘴上说不算 |
| O10 自我（`self`） | `brain/self/me.md` 三段 | 主人层只读、自助层要理由、每周叙事；历史版本 + 漂移检测 |
| O11 交付（`delivery`） | `brain/log/delivery.jsonl` | 她真说出去的每句都有账；声称闸没证据就改口 |
| O13 能力（`competence`） | `brain/sem/competence.json` | **成功 3 次**才算"会"，做一次就自夸是吹牛 |

**硬数字**（真数据实测，不是估算）：

| 指标 | 值 |
|---|---|
| 历史导入 | 旧 `episodes.jsonl` 1175 行 → **1045 条情景**（拦掉 45 条微信行） |
| 巩固 | 6 轮吃完 → **29 条结构化事实**，0 条无证据；第 7 轮 `processed=0`（幂等） |
| 召回 | 120 道真题 **Recall@6 0.875 / MRR 0.757**（权重由评测台标定后写回） |
| 提示词 | 真主人私聊装配 **5608 字**（旧版实测 7371），预算 5650，截断 0 块 |
| 体检 | `brain doctor` **17 项全绿**（8 条不变量 + 派生层门槛 + 任务队列） |

**"说到做到"是怎么被保证的**（这是主人在意的第一条）：

1. 她说"这就去看" → `intents.create({verify:'ledger', dueAt})`，缺验收方式的自动降级 `blocked`（**不丢**，只是标成做不了）；
2. 独立执行器 60s tick（不掷骰子、不占搭话配额）认领**租约**（fencing，防双开）→ 真跑 `binge`；
3. 结果只有带证据（`promise-outcome:<id>`）才能 `settle(ok:true)`，否则 `failed` 并把情绪张力拉起来；
4. 机器睡过头：`catchUp` 按迟到时长分三档 —— ≤6h 立刻做、6~24h 做+记债、>24h 标 `missed`（**不许静默消失**）；
5. 额度满/材料缺这类"不是她的错" → `defer` 顺延，不算失信。

**开关**（`config.json`）：

```jsonc
"brain": {
  "mode": "shadow",              // off | shadow（默认，只写不读）| live（新装配接管）
  "livePlatforms": ["qq", "douyin-dm"],
  "liveChats": [],               // 空 = 该平台私聊全切
  "liveGroups": [],              // 群聊必须逐群列进来才切（对照组最要紧）
  "executor": "promises",        // promises（旧账本）| intents（脑的账本，S4）
  "budget": { "promptChars": 5650 },
  "task": { "enabled": true, "pollSec": 20 }   // 身体/工具协议
}
```

回滚一行：`brain.mode = "off"`（旧路径原样）。脑的数据全在 `~/.feiyu-ai/brain/`，**删掉等于回到 10-29 早上**，旧记忆文件一个字节没动。

**身体/工具协议**（脑出任务、常驻体执行，绝不在事件循环里干重活）：

```
node tools/feiyu.mjs brain task add binge -- --show "可塑性记忆" --ep next   # 排队
curl -X POST localhost:<port>/task -d '{"kind":"produce","args":["--plan"]}'  # 外部投递
node tools/feiyu.mjs brain task          # 看队列/历史
```

kind 是白名单（`binge/produce/dm-read/card-open/tts/web-search/backup`），args 必须数组逐项透传 —— **绝不拼 shell**。

完整设计与交接见 [`FEIYU-BRAIN-PLAN.md`](FEIYU-BRAIN-PLAN.md)、[`FEIYU-BRAIN-HANDOFF.md`](FEIYU-BRAIN-HANDOFF.md)。

---

## 四、她会自己过日子（完全自由 + 生物钟 + 每日回顾）

| 机制 | 说明 |
|---|---|
| **生物钟**（`night`） | 窗口内随机醒（拟人，不整点），跨零点、最小间隔，每次刷 N 条视频 |
| **完全自由**（`freedom`） | 开了之后按间隔 + 概率给她"自由时间"：上网、刷B站/抖音、写小说、写游戏、发说说、自我升级 |
| **自定唤醒**（`selfwake`） | 她自己说"我 23:40 再醒"，到点**真的**叫起来（优先于概率）。`node feiyu.mjs selfwake 23:40 --note "把那篇小说收尾"` |
| **真的看番/看剧**（`binge`，10-27 新增 / 10-28 修续集） | 不是"看标题和热评"，是**真看完一集**：`binge --search "可塑性记忆"` → `binge --show "可塑性记忆" --ep next --go`（不给 `--ep` 且账本里已有这本，也按下一集走）。材料优先用弹幕（番剧字幕轨串片率极高，实测拿到过 ED 歌词和钢化膜测评），LLM 读完写 `{剧情, 感受}` 进她的记忆；进度落 `~/.feiyu-ai/binge/<番名>.json`，`--list` 查看到第几集。**一个投稿看不明白会自动换源重试**（同一集在合集/单集投稿里的弹幕密度差三倍），P 数不够或"其实是别的集（备份分 P）"会立刻放弃、不硬看。**节奏她自己定**：`--count 3`=连看三集、`--count all`=看到底、`--to 6`=看到第 6 集；`binge.dailyMax` 默认 **0 = 不限**（只是可选保险，不是日常规矩） |
| **承诺有账本**（`promises`，10-27 新增 / 10-28 改独立执行） | 她说"这就去看"会被 `catchFromReply` 记成一条带截止时间的承诺；**执行器独立跑**（`runDuePromises()` 60s tick，不掷骰子、不占搭话日额，启动 25 秒先补做一次夜里的欠账），`binge` 成功就结清、没材料才照实记失败；额度满就顺延到明天 09:30，进程崩了只顺延 6 小时不判她失信。`promises` 查全部、`promises --due` 查到期 |
| **看得懂引用**（10-27 新增） | 主人引用她（或别人）某条消息再说话时，她读到的是**被引用的原文**，不是"【引用回复了一条消息】"。做法：她发出去的每条都记 `message_id → 正文`（环形表 400 条落 `msg-index.json`），收到引用先查本地表，没命中走 NapCat `get_msg`，再没有就把最近 40~50 条历史拉一遍（`get_msg` 对老消息只回"消息不存在"，所以启动时和每 10 分钟预热一次）。引用的是图片还会过一次 VL。开关 `qq.quote = {enabled, seeImage, historyCount}` |
| **自己作品下的评论真的回**（10-27 修） | `replies --own-only` 走 ⓪ 路：先 `listOwnVideos()` 认出投稿（手填 `ownBvids` → 本地 `bvid.txt`/`bili-debut.json` → `space/wbi/arc/search`，space 路默认开且 `soft` 不熔断），再逐条回（任何类型：文字/图/纯表情）。`produce --debut-posted <BV>` 必须跑一次，否则本地不知道你发过什么，这条路永远是空的。楼中楼**不能带图**（B站 硬限制），带图稿会自动降级纯文字。额度走独立桶 `ownDailyMax`（默认 20），**不占**"主动出击"那条 `dailyMax` |
| **常驻服务有人守**（10-27 新增） | 抖音私信陪聊（`douyin-dm-server` 8095）和 B站 自己作品巡检都由 **qq-server 每 90s 的监工**看着：探 `/health`，死了就 detached 拉起来（10 分钟最多 3 次退避），B站 巡检每 `autoMin`（默认 12 分钟）跑一轮。插件侧还有一层 `watchServices()`（60s，只在 `startWithDsh:true` 的服务上动手、端口有活服务就跳过）。**前提：`qq.startWithDsh` 必须是 true**，否则 DSH 重启后整条链没人起 |
| **主人事实**（`owner-facts`，10-27 新增） | 他说"我中午吃了烧鸭""我在改插件""推荐你看《可塑性记忆》"→ 抽成 `food/doing/plan/mood/media` 五类事实，注入成【今天已经知道的事】，出门前还有一道闸门：命中"吃了吗/在干嘛"且已有事实就打回重写，**绝不再问第二遍** |
| **每日回顾**（`personality.nightly`，默认 23:00） | 翻今天 → 写日记 → 更新"我是谁"（改前存快照）→ 记账 |
| **人格进化**（`personality.evolve`） | 每 N 天一次复盘，更新 `persona.md` 自我迭代区 |

调度器 `lib/scheduler.js` 每 60 秒 tick 一次，所有窗口/概率/上限都在配置里，面板可改。

几个踩过的坑（都已修）：

- **摇不中就白等一整轮**：以前失败也把 `lastWake` 写成 now，等于没摇中要再等 75 分钟 —— 你打开完全自由半小时没动静，以为死机了。现在失败只记 `lastRoll`，3 分钟后重摇。
- **浏览器进程自愈**：完全自由开着时 `web roam` 死了会自动拉起（60s 检查）。
- **撞车保护**：`sheIsBusy()` 保证不会同时往会话里塞两个任务。

---

## 五、架构

```
dsh-feiyu/
├── lib/                        宿主壳（跑在 DSH 的 Electron 里）
│   ├── index.js                路由（status/cookie/selftest/config/memory/persona/services/report/watch）
│   │                           + 生物钟 + QQ 网关(NapCat)自愈 + 自由上网自愈 + GPT-SoVITS 自愈
│   ├── scheduler.js            60s tick → 生物钟 / 人格进化 / 每日回顾 / 完全自由 → sessionController.prompt
│   └── node-runtime.js         找真 node（DSH 自带运行时 / PATH / DSH_NODE）
├── client.js                   浏览器半边：DSH 设置里那一页「🐟 大肥鱼」
├── tools/                      工具链（spawn 真 node 跑，改完不用重启 DSH）
│   ├── feiyu.mjs               CLI 入口（30+ 子命令）
│   ├── lib/
│   │   ├── memory.mjs          三层记忆 + 统一时序回忆(recallAll) + 全文检索(grepEpisodes) + 按月分片
│   │   ├── normalize.mjs       占位符/死链归一（治"看不到内容"）
│   │   ├── timefix.mjs         时间说法护栏（gapText / mentionsDays / sanitizeDayClaims）
│   │   ├── speechfix.mjs       嘴瓢护栏（"看不到/打不开"→改成问标题）
│   │   ├── persona.mjs         三段式 prompt 装配 + 时间常驻层 + 我是谁快照
│   │   ├── qq-memory.mjs       QQ 长记忆（摘要 + 主人画像 + worldBlock）
│   │   ├── stickers.mjs        表情库（标签挑选 / 根本形象过滤 / autoTag 情绪兜底）
│   │   ├── owner-facts.mjs     主人今天说过的硬事实（food/doing/plan/mood/media）+ 反问闸门
│   │   ├── promises.mjs        承诺账本（认诺 → 到点执行 → done/fail → 注入提示词）
│   │   ├── quote.mjs           引用消息（message_id → 正文 环形表 + describe + get_msg 解析）
│   │   ├── imggen.mjs          AI 表情包（硅基参考图锁形象 > Pollinations 兜底）
│   │   ├── config/cred/guard/mood/llm/tts/vision/bili-api/night-plan/share-policy/lock… 
│   │   └── sticker_render.py   PIL 本地画文字贴纸
│   └── commands/               selftest nav feed debrief comment quota diary mem selfwake
│                               qq-server qzone douyin douyin-dm-server report watch bili-watch
│                               act replies voice sing sticker web selfup produce vision debrief
│                               binge promises（10-27：真看番 + 承诺账本）
├── douyin_interact.py          抖音浏览器自动化（feed/comments/comment/reply/comment-reply/
│                               self-info/my-videos/dm-send/dm-read/engage 子命令）
├── wechat/wechat_bot.py        微信机器人（副本；运行的是 D:/wechat-bot/ 那份）
├── test/                       23 套测试（client-smoke / client-render / stickers / imggen /
│                               memory / memory-recall / qq-human / vision / focus-one-thing /
│                               reply-style / memory-hygiene（10-27 记忆卫生）/ …）
└── package.json
```

**推理不由插件做**：B站生物钟和完全自由到点把任务塞进 DSH 会话，宿主模型负责看懂和写 —— 零 API 费。
QQ / 微信 / 抖音需要实时响应，走直连 API。

---

## 六、安装

```powershell
# 1) 把本目录放到固定位置，例如 C:\Users\<你>\.dsh\plugins\dsh-feiyu
# 2) 用 DSH 桌面端自带的 dsh 命令安装（npm CLI 改不了 desktop profile）
dsh plugin --profile desktop add "link:C:\Users\<你>\.dsh\plugins\dsh-feiyu"
# 3) 重启一次 DSH（bundle 层要重启才组装）
```

外部依赖（按需装）：

| 平台 | 依赖 | 备注 |
|---|---|---|
| B站 | 无（凭据即可） | — |
| QQ | NapCat（管理员注入 QQ）+ 可选 GPT-SoVITS | 见「排障」 |
| 微信 | wechatauto + 微信 PC 4.x | `D:/wechat-bot/` |
| 抖音 | social-auto-upload / patchright + Chrome | `D:/social-auto-upload/.venv` |
| 表情包 | 硅基流动 key（`imageGen.api_key`）+ 参考图 `sticker-ref.jpg` | 锁住「根本形象」 |

> **完整依赖清单（精确版本号、模型名、端口、安装顺序、验证命令）见 [DEPLOY.md](DEPLOY.md)。**

---

## 六·五、依赖与模型（精确版本）

跑通这套东西的实测环境（Windows 11 / x64 / CUDA 12.8）：

| 组件 | 版本 | 干什么 |
|---|---|---|
| DSH 桌面端 | `0.2.1-rc.2`（`@deepseek-ai/dsh-desktop-runtime`） | 宿主：会话 / 面板 / 模型 |
| Node.js | `v24.21.0` | 工具链（DSH 运行时自带同版本） |
| Python | `3.12.0` ×3（social-auto-upload / rvc / wechat-bot 各一个 venv） | 各平台脚本 |
| **对话模型** | 千问AI平台 **`deepseek-v4.1-flash-1017`**（`maas.qianwenaiapi.com/compatible-mode/v1`，`enable_thinking:false` 关思考链） | QQ / 抖音私信 / 微信实时回复（备：官方 `deepseek-chat`） |
| **视觉模型** | 千问AI平台 **`qwen3-vl-plus`** | 看图、校验表情包形象（备：硅基 `Qwen/Qwen3-VL-8B-Instruct`） |
| **生图模型** | 硅基流动 **`Qwen/Qwen-Image-Edit-2509`** → 备用 **千问 `qwen-image-2.1-pro`**（带参考图 ≈16s） | 锁形象生图（表情包/视频配图） |
| 生图兜底 | **Pollinations `flux`** | 免费、不保证形象（只做临时图） |
| **语音克隆** | **GPT-SoVITS** `b4570b8`（2026-10-19）→ `api_v2.py:9880/tts` | 说话 / 语音条 / 视频旁白 |
| **歌声转换** | **RVC**（Retrieval-based-Voice-Conversion-WebUI）`torch 2.7.1+cu128` | 翻唱（把真歌人声换成她的音色） |
| 取源歌 | **yt-dlp** `2026.10.21` | 翻唱素材 |
| 音视频合成 | **ffmpeg** `7.1-essentials_build-ghyan`、**ffprobe**（RVC 自带） | 翻唱混音 / 视频成片 |
| QQ 网关 | **NapCat.Onebot `4.18.41`**（OneBot **v11**）+ QQNT `9.9.20-36330` | QQ 收发 |
| 抖音自动化 | **patchright `1.58.2`** + Chrome `156.0.8078.47` | 抖音网页版 |
| 微信自动化 | **uiautomation `2.0.29`** + comtypes `1.4.17` + pywin32 `312` + Pillow `13.0.0` | 微信 PC |
| 她的音色文件 | `D:\rvc\RVC\assets\weights\feiyu-rose.pth`（v2 40k）+ 参考音 `models\yinlang\yinlang.wav` | — |

端口：`8080` QQ 服务 · `8095` 抖音私信 · `3000` NapCat · `9880` GPT-SoVITS · `9222` Chrome CDP · `7897` 代理。

---

## 六·六、四条特色流水线（怎么实现的）

### 1）语音克隆 —— 她的声音

```
QQ 收到消息 → 摇中 voice_chance → lib/tts.mjs POST 9880/tts
  { ref_audio_path: models/yinlang/yinlang.wav, prompt_text, prompt_lang, text, text_lang }
→ 返回 wav → NapCat 发 { type: "record", file } → 失败自动降级纯文字
```

- 零样本克隆（给参考音就能说）；也可换训练好的 `sovits_path`/`gpt_path`（`models/sunshine_girl/`）
- 插件启动自动拉起 `api_v2.py`，每 60s 探活；面板「音色」可直接试听（发你 QQ）

### 2）唱歌 —— 原创与翻唱

| 模式 | 链路 |
|---|---|
| 原创 `sing "主题"` | DeepSeek 写词 → GPT-SoVITS 按节奏念白式合成 → `lib/sing.mjs` 直接读写 WAV（RIFF/PCM16）拼接调音 → 发 QQ |
| 翻唱 `sing cover "歌名"` | yt-dlp 取源 → ffmpeg 转 44.1k/立体声 → **RVC** 人声转换（`feiyu-rose.pth`）→ ffmpeg 混回伴奏 → 发 QQ，歌单存 `sing songs` |

> 诚实说明：GPT-SoVITS 是**说话**引擎不是歌声合成（本机没装 SVC），所以"原创"是节奏念白式的唱；**真唱靠 RVC 翻唱**。

### 3）生图 / 表情包 —— 只画"她本人"

```
文案/标签 → buildImagePrompt（DeepSeek 翻英文 prompt）
  → 硅基 images/generations(model=Qwen-Image-Edit-2509, image=<参考图 dataURI>,
      prompt="保持她的发型/五官/服装配色不变，画出她<情绪>的样子 + 手绘气泡写汉字")
  → 存 ~/.feiyu-ai/stickers/<标签>/sf-<hash>.jpg  （sf = 根本形象，才允许发送）
  硅基失败 → Pollinations flux 兜底（存 自制/px-*.jpg，永不入库、永不发送）
```

- 参考图按文案情绪自动挑：`sticker-refs/ref-{哭,举手,得意,微笑}.jpg`
- 发送前 `pickSticker()` 过滤 `px-`；她没写标记时 `autoTag()` 按内容补标签（认不出只在开心/无语/比心里选）

### 4）做视频 —— 真剪辑的片子（她策划，你点发布）

```
produce ["主题"] [--platform bili|douyin] [--frames 1|2] [--bgm auto|none] [--dry] [--no-video]
produce --reuse <已有投稿包目录>          # 图没毛病、只重做配音和剪辑（不再花生图钱）
# --no-video = 这条强制走静图运镜（不花视频模型的钱）；已生成的动作片段会沿用，不重烧
# 配音四条硬规矩：① 参考文本必须盖住整段参考音频（少一个字都会漏句尾，voice refcheck 可查）
#                 ② 参考段里的大段死空气先挤掉（voice refclean，2.9s 死空气能把音色带偏）
#                 ③ 语速/温度钉死 1.0，不按"起伏大"择优、不动态压缩（改一点就是变调/电音）
#                 ④ 一句话只用一个参考段：没标情绪就用基础音色 voice.videoEmotion=calm
# 剪静音那步只能是"切"，绝不能重新量化 —— writeWavLocal 曾把 Int16 当 float 压成 ±1 方波，
# 那就是主人报了一周的"电音机械音"（voice-*.wav 只有 3 个取值）。测试里用"不同取值 >200"兜住。
# 配音是抽奖：抽到满意的用 --keep-voices 锁住；只改音轨不动画面用 --reaudio（复用 visual.mp4）
  ① DeepSeek 出脚本/分镜（每幕：动作 + 台词 + 景别 + **她自己写的视频导演稿**）
  ② 硅基 Qwen-Image-Edit 逐幕 2 帧配图（锁她的形象，同场景换个动作/表情）
  ③ GPT-SoVITS 逐句念台词 → **念完还得验**：量真实说话段的字/秒，离谱就换参数重念，
     还不行拆成两句念再拼；最后把首尾静音剪掉 —— 字幕才和"开口"落在同一时刻
  ③½ **真动作镜头（10-27）**：她那帧图当首帧 → 万相 2.7 图生视频 → 人物真的在动
     （转头/眨眼/发丝/光斑）。**模型自己生成的音轨一律掐掉**，人声只走 SoVITS。
     单幕超 15s 自动切段，段间用上一段末帧当下一段首帧；失败/关掉/超预算就落回静图运镜。
     **画面主体是她，别的二次元/Q版同类可以同框**（动漫风、非真人，1~2 个、别抢戏）；
     禁真人、禁文字/字幕/水印
  ④ ffmpeg 真剪辑：片头卡 → 各幕（真片段，或静图运镜：推/拉/摇/移 + 幕内双帧交叉淡入）+ 幕间转场
     + 逐句 ASS 字幕烧制 + 本地合成 BGM（侧链避让人声）+ loudnorm 统一响度 → 1080p
  ⑤ 成片再自检一遍音画同步（逐句量偏差写 sync.json，>0.3s 会喊"建议重剪"）
  ⑥ 封面单独一张；落地 ~/.feiyu-ai/{bili,douyin}-posts/<日期-标题>/
      {plan.json, img-*.jpg, line-*.wav(原始), voice-*.wav(剪过静音), subtitle.ass,
       video.mp4, cover.jpg, sync.json, meta.json, 投稿说明.md}
  ⑦ 停在这里 —— 她不能自己发，等你在面板点发布
```

> 10-26 修过一回「字幕和语音没对上、漏了很多字」：模型会把 13 个字念成 1.07 秒（12 字/秒，
> 人嘴做不到），还会给每条音频头尾挂 0.2~0.3 秒静音。现在前者被"字/秒"闸门拦下重念，后者在
> 剪辑前剪掉，成片逐句偏差从 0.14~0.38 秒压到 0.01~0.06 秒。

> **10-27 接上万相 2.7 图生视频（真动作镜头）**：走的是 `llm` 那条中转站的 DashScope 原生路径，
> **同一个 key，不用另开账号**。实测 1080×1920 / 30fps / 5 秒，41~69 秒出片，一条 20 秒片子约 4~5 段。
> 三个坑记在 `tools/lib/wanvid.mjs` 顶上（少 `X-DashScope-Async: enable` 直接报错；
> `duration` 只收 2~15 整数；`video_url` 24 小时过期必须立刻下载）；
> `resolution` 是"像素档位"不是固定尺寸 —— **输出宽高比跟着首帧走**，所以首帧先裁成 1080×1920。
> 配置在 `video.animate`：`enabled` / `resolution` / `maxSeconds` / `budgetPerRun`（一条片子最多花多少元）/
> `pricePerSecond`（估算用的单价，去后台核完填准）。想回到老路：`produce --no-video` 或 `enabled=false`。

**B站首条锁**：第一条只能做「介绍自己 + 今天第一天来B站 + 以后这个账号归她运营 + 自由发挥」。
剧本出来会被复查（缺哪条就重写，三次不成就不做），做完仍然锁着（`ready`）；你发完跑
`produce --debut-posted BV号` 才算解锁，之后 B站 投稿随便拍。抖音不受这个锁限制。

### 5）她 B站 跟谁说了什么 —— 社交流水

```
social [--days 3] [--kind 回评] [--invisible] [--md] [--push] [--json] [--backfill]
```

她评论/回评/弹幕/动态/点赞/投币/关注/投稿都落进 `~/.feiyu-ai/bili-social.jsonl`，
每条标着"有没有 @ 你"。`social` 先列**没 @ 你**的那些（那才是你漏掉的部分）；
`socialDigest` 每天 23:30（≥3 条才推）自动推一条摘要到你 QQ；`--backfill` 能把
老的散文台账 `bili-outbox.md` 历史灌进流水（幂等，实测补了 91 条）。

### 汇总：一次"完全自由"里她可能跑的全链路

```
调度器 tick → 会话注入任务
   ├─ 上网搜吃的（web search → 记忆 platform=web）
   ├─ 写小说片段（web roam 的写作模式 → 记忆）
   ├─ 刷B站/抖音（bili-watch --free / watch --free → 评论走额度+风控闸）
   ├─ 抖音评论区经营（engage：扫自己作品 → 任何类型的评论都回：文字/表情包/图片/只有表情）
   ├─ B站评论区经营（replies：⓪自己作品下的评论 ①别人对我的回复 ②主动搭话）
   ├─ 做视频（produce：策划→配图→配音→万相真动作→剪辑成片，等你发布）
   ├─ 唱歌/语音（sing / voice → 发 QQ）
   ├─ 真看一集番（binge --show "…" --ep N --go → 读完写剧情+感受进记忆）
   └─ 给自己约下一次（selfwake 23:40 --note "把小说收尾"）
        ↓ 到点
  每日回顾（23:00）：翻今天 → 写日记 → 更新"我是谁"（改前存快照）→ 记账
```

每一环的产出都会写进记忆（`platform=web/douyin/bilibili`），所以你在 QQ 问她"今天干了啥"她答得出来。

---

## 七、配置

`~/.dsh/feiyu.config.json`（改完保存即生效，不用重启；面板写的就是这个文件，**深合并**，改一个字段不会清掉别的）。

```jsonc
{
  "identity": { "name": "友利奈绪的大肥鱼", "ownerTitle": "主人", "selfClaim": "我" },
  "owner": { "mid": "数字mid", "name": "B站昵称", "qq": "QQ号", "wechat": "wxid" },
  "llm": { "api_key": "千问AI平台 key", "base_url": "https://maas.qianwenaiapi.com/compatible-mode/v1",
            "model": "deepseek-v4.1-flash-1017", "params": { "enable_thinking": false },
            "fallback": { "api_key": "DeepSeek key", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat" } },
  "imageGen": { "enabled": true, "provider": "siliconflow", "model": "Qwen/Qwen-Image-Edit-2509",
                "refImage": "~/.feiyu-ai/sticker-ref.jpg" },   // 根本形象：所有表情包都锁它
  "night":   { "windows": [{ "start": "17:00", "end": "24:00", "wakes": 3 }], "skipChance": 0.3, "maxVideos": 5 },
  "freedom": { "enabled": true, "wakeEveryMin": 20, "chance": 0.7, "engageEveryMin": 120 },
  "personality": { "nightly": { "enabled": true, "at": "23:00" }, "evolve": { "enabled": false, "days": 2 } },
  "qq": { "enabled": true, "stickerChance": 0.5,
          "proactive": { "enabled": true, "minQuietMin": 20, "minGapMin": 5, "chance": 0.25,
                         "typeCooldownMin": 180, "similarityMax": 0.1 } },
  "douyin": { "enabled": true, "dryRun": false, "engage": { "enabled": true, "dailyMax": 0 },
              "dm": { "enabled": true, "startWithDsh": true, "pollSec": 120 } },
  "web": { "roam": { "enabled": true }, "selfUpgrade": { "enabled": true }, "proxy": "http://127.0.0.1:7897" },
  "preferences": { "like": ["美食", "探店"], "dislike": ["带货", "擦边"] },
  "guard": { "dryRun": false }
}
```

`~/.feiyu-ai/credentials.json` —— B站凭据（`0600`，永不回显）：`{ "sessdata": "…", "bili_jct": "…", "buvid3": "…" }`

> 取法：浏览器 bilibili.com → F12 → Application → Cookies（`SESSDATA` 是 HttpOnly）。
> 也可以直接 POST 给 `/dsh-feiyu/api/cookie`（带清洗和实时 nav 验证）。

---

## 八、命令速查

```bash
# ── 体检与身份 ────────────────────────────────────────────────
node tools/feiyu.mjs selftest                      # 配置/凭据/登录态/数据目录/干跑 全检
node tools/feiyu.mjs nav                           # 我是谁（真打一次 /nav）

# ── 记忆 ────────────────────────────────────────────────────
node tools/feiyu.mjs mem stats                     # 计数
node tools/feiyu.mjs mem grep "小说" --days 30      # 翻旧账（原文全留，按原话找）
node tools/feiyu.mjs mem recallall --chat qq:1     # 看她现在脑子里装的那块记忆
node tools/feiyu.mjs mem recall --query "养猫"      # 关键词回忆（>7 天）
node tools/feiyu.mjs mem lore --tag 兴趣 --text "…" # 写世界设定
node tools/feiyu.mjs diary --book private --append "…"

# ── 节奏 ────────────────────────────────────────────────────
node tools/feiyu.mjs selfwake 23:40 --note "把那篇小说收尾"   # 她定下次几点醒
node tools/feiyu.mjs selfwake --show | --clear

# ── 看番 / 承诺（10-27，10-28 修"说了不做"）──────────────────
node tools/feiyu.mjs binge --search "可塑性记忆"        # 搜番，看有哪几集能看
node tools/feiyu.mjs binge --show "可塑性记忆" --ep 1 --go   # 真看完一集（写剧情+感受进记忆）
node tools/feiyu.mjs binge --show "可塑性记忆" --ep next --go # 接着看下一集（续看会沿用账本里 P 数最多的那条投稿）
node tools/feiyu.mjs binge --bvid BV1os411S7dL --ep 1 --go   # 指定投稿
node tools/feiyu.mjs binge --list                       # 已经看过哪几部、看到第几集
node tools/feiyu.mjs focus binge --min 40               # 接下来 40 分钟专心看番（其余循环停）
node tools/feiyu.mjs promises                           # 她答应过、还没做的事
node tools/feiyu.mjs promises --due                     # 只看到期的（qq-server 里 runDuePromises() 每 60s 自己跑）
node tools/feiyu.mjs promises done <id> "看完了"         # 结清 / fail <id> "没字幕"

# ── 脑（v3，10-29）：记忆/意图/自我/体检 ──────────────────────
node tools/feiyu.mjs brain doctor                   # 17 项体检（8 条不变量 + 派生层门槛 + 任务队列）
node tools/feiyu.mjs brain stats                    # 情景/事实/意图/巩固进度
node tools/feiyu.mjs brain recall "烧鸭"             # 看它现在能召回什么（带 ‹ep-id› 可回溯）
node tools/feiyu.mjs brain facts [--conflicts]      # 结构化事实（每条都带 prov）
node tools/feiyu.mjs brain intents [--all]          # 意图三态：答应过/做不了/只能想想
node tools/feiyu.mjs brain consolidate [--llm] [--dry]
node tools/feiyu.mjs brain eval [--calibrate]       # 评测台：Recall@6 / MRR，可反推权重
node tools/feiyu.mjs brain schema [--show]          # O6 图式（30 天 × 5 次才归纳）
node tools/feiyu.mjs brain competence [--show]      # O13 能力自评（成功 3 次才算会）
node tools/feiyu.mjs brain self [show|owner|narrative]
node tools/feiyu.mjs brain task [list|add|done|fail|history]   # 身体/工具协议
node tools/feiyu.mjs brain backfill [N]             # 把旧 episodes.jsonl 导进脑（去重、跳过微信）
node tools/feiyu.mjs brain emit "一句话" --role user  # 手工灌一条事件（调试用）
node tools/feiyu.mjs brain tick                     # 跑一次心跳（补做 + 该不该巩固）

# ── 聊天通道 ────────────────────────────────────────────────
node tools/feiyu.mjs qq-server 8080                # QQ 常驻（NapCat OneBot 上报 /onebot）
node tools/feiyu.mjs douyin-dm-server --port 8095  # 抖音私信陪聊
node tools/feiyu.mjs qzone --content "…"           # 发 QQ 空间说说

# ── 抖音 ────────────────────────────────────────────────────
node tools/feiyu.mjs douyin self                   # 读当前登录号（顾思苡）的 sec_uid
node tools/feiyu.mjs douyin my-videos              # 扫自己的投稿（--owner 扫主人号）
node tools/feiyu.mjs douyin comments --vid <id>    # 读评论（带 cid）
node tools/feiyu.mjs douyin reply --vid <id> --cid <cid> --message "…" --go
node tools/feiyu.mjs douyin engage [--dry]         # 自己作品下回评论（cid 精确 + 文本兜底）
node tools/feiyu.mjs douyin interact [--dry]       # feed→选片→读热评→写评论
node tools/feiyu.mjs douyin watch [--duration 10]  # 自主观看

# ── B站 ─────────────────────────────────────────────────────
node tools/feiyu.mjs feed | debrief --bvid BV1xx | comment --bvid BV1xx --message "…" [--go]
node tools/feiyu.mjs bili-watch --free             # 静默自助刷一轮
node tools/feiyu.mjs replies                       # 扫别人对我评论的回复并回应
node tools/feiyu.mjs replies --own-only [--go]      # 只回**我自己作品**下面的评论（任何类型）
node tools/feiyu.mjs replies --audit 10             # 体检：最近 10 条评论别人到底看不看得见（匿名视角）
node tools/feiyu.mjs replies --own-only --go --force # 明知被挂审核也要发（默认会自刹车）

# ── 她自己的手脚 ─────────────────────────────────────────────
node tools/feiyu.mjs web search "关键词" | web fetch <url> | web log
node tools/feiyu.mjs sticker gen "文案" [--tag 标签] [--send]
node tools/feiyu.mjs produce ["主题"]              # 短视频投稿包（成片等你点发布）
node tools/feiyu.mjs sing ["主题"] | cover "歌名"
node tools/feiyu.mjs voice list | tryall | use | refcheck | refclean   # refcheck：ASR 核对参考文本；refclean：挤掉参考段死空气
node tools/feiyu.mjs selfup backup|log|status       # 改自己代码前备份、改完记账
node tools/feiyu.mjs report --days 1                # 观看日报（不调模型）
```

---

## 九、各平台细节

### B站（自主刷视频）

- 生物钟窗口内随机醒（拟人，不整点），跨零点、最小间隔
- 链路：凭据 → 分享标尺 → 风控闸门 → 额度闸 → POST → 记账
- 真 @ 主人：评论正文 `@昵称` + `at_name_to_mid`（B站原生通知，非风控点）
- 红线：只写评论；撞验证码/限流立刻熔断（5 分钟起步指数退避）

### QQ（像真人聊天）

- NapCat（OneBot v11）→ `qq-server` → DeepSeek 秒回；群聊 @ 才回，私聊都回
- 分条发送（1~3 条、随机间隔）；AI 腔清洗；读人（连发=急了、半夜=想人陪）
- **表情包**：摇中（`qq.stickerChance`）就一定要带图 —— 她没写标记时**代码按内容自动补标签**（`autoTag`）
- **主动搭话**：安静阈值 / 最小间隔 / 每日上限 / 类型冷却 / 相似度去重，五道闸；发出后也会补一张表情
- 语音：GPT-SoVITS `/tts`（默认 9880），失败自动降级文字；插件启动自动拉起 + 每 60s 探活
- 说说：`qzone`（部分 NapCat 版本未暴露）

### 微信（替你回消息，语气是她）

- 独立进程 `D:/wechat-bot/wechat_bot.py`；单实例（互斥量）+ 水位（重启不重放）
- 合并窗口（默认 3s，最长 12s）把连发当一句话；广告/服务号跳过、真人必须回
- 按联系人隔离上下文 + 滚动档案；不暴露身份、不替你做承诺
- 节奏档：`off` 秒回 / `fast` 1.5s / `natural` 4~7s / `calm` 挂机
- **不进她的人格记忆**（工作通道）

### 抖音（互动 + 观看 + 私信）

- `interact`：feed→口味过滤→读热评→LLM 评论→发（`--dry` 只看不发；`maxPerRun=0` 有 10 条硬上限）
- `comment` / `reply`：**纯文字，默认不带 @**（公开评论含 @ 是风控主因）；`reply` 的 `--at` 只 @ 评论者
- `engage`：扫**她自己**的投稿 → 读评论 → 她自己决定回谁、回什么 → **cid 精确回复**（无 cid 才退回文本定位）；干跑不写水位；`dailyMax:0` = 不限
- `watch`：feed→决策 继续/换片/停（带理由）→记兴趣→循环，带时长限制
- `douyin-dm-server`：私信陪聊常驻（默认 8095）；轮询主人私信，**取最新一条未处理**回复（历史 bug：取数组末尾=最旧，卡死三小时）；发送失败下轮重试；首次运行以现有消息为基线
- 成功判定只认 `comment/publish` 接口 `status_code=0` + 新 cid（"输入框空了"会假成功）
- 画面采样 + Whisper 音频理解：暂缓

---

## 十、表情系统（根本形象）

| 平台 | 能发什么 | 触发 |
|---|---|---|
| QQ / 微信 | 图片表情 + 颜文字 | `[表情:开心]` 发图库；`[自制表情:短句]` 当场画一张 |
| B站评论 | B站表情码 + 颜文字 | `[大笑]` `[doge]` `[吃瓜]`（447 个官方码白名单） |
| 抖音评论 | emoji + 颜文字 | 方括号码不认，发布前剥掉 |

**图库只放"根本形象"**：`~/.feiyu-ai/stickers/<标签>/`（开心/无语/委屈/生气/困/比心，各 2~3 张）

- `sf-*.jpg` = 硅基 `Qwen-Image-Edit` + 你的参考图（`sticker-ref.jpg`）生成 —— **形象锁死，只发这种**
- `px-*.jpg` = Pollinations 免费兜底，**永不入库、永不发送**（会出来普通卡通，不是她）
- `pickSticker()` 只从 `sf-`/`ai-` 里挑；`autoTag()` 认不出情绪时只在"开心/无语/比心"里选（不会莫名其妙发"生气"）
- 自制贴纸 `sticker_render.py`（PIL 本地画，按文案 md5 缓存）
- 兜底：标签没图 → 颜文字；发图失败 → 颜文字；评论里图片标记 → 剥掉

---

## 十一、设置面板（DSH → 设置 → 🐟 大肥鱼）

| 区块 | 能改什么 |
|---|---|
| 运行状态 | 通道健康（QQ 网关/QQ 进程/微信心跳/抖音/上网）、今日计数、情绪、干跑；跑体检 |
| 平台开关 | B站 / QQ / 微信 / 抖音 四个独立开关 |
| 主人 | QQ 号（认主）、称呼、B站 mid、微信 wxid |
| 音色 | 扫 GPT-SoVITS 模型列、试听（发你 QQ）、语音概率 |
| 微信 | 节奏档、合并窗口、上下文条数、smart_skip |
| 作息与限额 | 醒来窗口/次数、分享开关与上限、抖音每次条数、观看日报、自主观看、评论 @ 开关 |
| 完全自由 | 开关、间隔、概率、评论区巡检间隔 |
| 主动搭话 | 安静阈值、最小间隔、概率、每日上限、类型冷却、相似度 |
| 角色设定 | `persona.md`（她每次醒来都读；她也会自己改写） |
| 记忆库 | 最近对话 + 各平台计数（QQ/抖音/B站/上网），读失败会重试并提示 |

> 前端改完跑 `npm test`（契约 + 假 hooks 真渲染，防白屏）。
> 面板改动是**深合并**写配置：改一个字段不会把别的字段清掉。

---

## 十二、排障

| 症状 | 真因 |
|---|---|
| 找不到她的会话 | 工作区 → **未分组** 里 |
| 找到了但什么都不干 | 会话没给「完全访问」权限 |
| 她"像死机"（完全自由不动） | ① 摇号没中（看 `~/.dsh/feiyu-freedom.json`）② **模型额度 429**（看会话最后几帧） |
| 生物钟不醒 | 用桌面端自带 dsh CLI；看 `~/.dsh/feiyu-night.json` 的 `reason` |
| 发评论 CSRF 失败 | `bili_jct` 和 `SESSDATA` 不是同一个账号 |
| HTTP 412 | B站 IP 限流，等 `api-ban.json` 里的时间过了再动 |
| QQ「服务在跑却不回」 | 网关 NapCat 没起（管理员注入 QQ）；看 `~/.feiyu-ai/qq-server.log`，`/health` 里 `napcat.ok` |
| QQ 语音没声音 | GPT-SoVITS(9880) 没起；插件会自动拉，或手动 `start_api.bat` |
| 微信不回复 | 看 `~/.feiyu-ai/wechat-bot.log`（收/想好/发出/跳过/失败） |
| 抖音私信不回 | `curl 127.0.0.1:8095/health` 看 `failStreak`/`ticking`；`douyin-dm.log` 里找 `主人：` 那行 |
| 抖音回复"发成功"却没内容 | 新号在**别人**视频下的评论回复会被审核吞掉（接口 200 但不落地）；先在**自己作品**下互动 |
| 她答"我没写过/我不知道" | 看 `mem recallall --chat <通道>`：是不是该有的行没进去（12 小时窗口 / 通道过滤） |

---

## 十三、文件一览（她的一切都在明处）

| 文件 | 内容 |
|---|---|
| `~/.dsh/feiyu.config.json` | 配置（面板写的就是它） |
| `~/.dsh/feiyu-night.json` · `feiyu-freedom.json` · `feiyu-review.json` · `feiyu-next-wake.json` · `feiyu-evolve.json` | 作息/自由唤醒/每日回顾/自定唤醒/人格进化的状态 |
| `~/.feiyu-ai/credentials.json` | B站凭据（0600） |
| `~/.feiyu-ai/episodes.jsonl`（+`episodes-YYYY-MM.jsonl`）· `facts.json` · `lore.json` | 主记忆 |
| `~/.feiyu-ai/qq/` | QQ 记忆（episodes + 摘要 + 主人画像） |
| `~/.feiyu-ai/wechat/<wxid>/` | 微信按联系人记忆 |
| `~/.feiyu-ai/mood.json` · `quota.json` · `reports/` | 情绪 / 额度 / 日报 |
| `~/.feiyu-ai/persona.md` + `persona.history/` | 她的人设 + 每日快照 |
| `~/.feiyu-ai/stickers/<标签>/` | 表情库（只放根本形象） |
| `~/.dsh/feiyu-work/AGENTS.md` · `feiyu-diary*.md` · `creative/` | 人格流程 / 两本日记 / 她的作品 |
| `~/.dsh/sessions/…/feiyu/` | 她的会话（完全自由的一切痕迹都在这） |

---

## 十四、测试

```bash
npm test     # 8 套：client-smoke / client-render / stickers / imggen / memory / memory-recall / qq-human / vision
```

- `memory-recall-test` 17 项断言：占位符幂等、跨通道顺序、微信不可见、当前通道不重复、grep 的 role 过滤、`recent` 不吃 `event` 行
- 测试会先把 `USERPROFILE`/`DSH_HOME` 指到临时目录，并在开头断言 `dataDir` 落在临时目录内，否则中止
  （踩过一次：没隔离 → 往真实记忆写了假数据，清理时又误删了真实行）

---

## 十五、设计取舍

1. **不上向量库**：原文全留 + 按原话找，够用且更准。
2. **对话流按通道分开，事实与行为共享**：角色不会串，同一个她却不会失忆。
3. **时间只给准的**：每轮注入真实时间，禁止自造天数；不靠"她自己感觉"。
4. **占位符要解释**：读不到的东西提前说清楚，别让她道歉。
5. **形象只认参考图**：兜底图不进图库，宁可发颜文字也不发"不是她"的图。
6. **所有外发有闸**：干跑总开关、每通道独立 dryRun、额度、相似度去重、熔断。
7. **宁可沉默，不刷屏**：主动搭话五道闸；她自己也学会了"安静不是故障"。

---

## 致谢与许可

- **[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)**（MIT）：宿主壳 / 生物钟 / bili-api / share-policy
- **dafeiyu 骨架**：mood 状态机 / 三层记忆 / guard / 角色卡
- **[chenkezhen480/dsh-world](https://github.com/chenkezhen480/dsh-world)**（MIT）：统一归档渲染 / 时间常驻 / 我是谁快照 / 原文检索的取舍
- **[LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)**：抖音自主观看范式、评论去 @ 防风控
- **[wakuwku/qq-wechat-ai-bridge](https://github.com/wakuwku/qq-wechat-ai-bridge)**：hook 协议与表情库思路
- **[pan17/dsh-wechat](https://github.com/pan17/dsh-wechat)**：减少往返的提速思路

本项目 MIT。与 B站、QQ、微信、抖音、DeepSeek 官方无隶属关系。
用你自己的账号做事，后果自负 —— 所以她被设计得**宁可沉默，不刷屏**。
