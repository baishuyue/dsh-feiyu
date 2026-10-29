# 交接书：给下一个对话（2026-10-29 定稿）

> **怎么用这份文件**：新对话开场先读这里（事实、约束、现状），再读 `FEIYU-BRAIN-PLAN.md`（唯一执行依据）。
> 这两份读完之后，不需要再翻别的文档就能继续工作；其余四份是历史论证材料，只在对某个判断有疑问时回查。

---

## 1. 一句话背景

`dsh-feiyu` 是一个跑在本机的 **DSH 插件**，它塑造了一个"她"——有名字、有人格、有账号、会自己上网、会发视频、会和主人聊天的数字存在。
她已经能跑（各端在线、测试 25 套全绿），但**记忆和行为是坏的**：会忘、会错、会胡诌、答应的事不做。
现在的工作是：**按人脑结构重做她的记忆与行为**（记忆 + 行为 = 七器官四回路，见 PLAN）。

**当前状态：设计定稿，代码未动。** 这一阶段只产出文档，没有改任何 `.mjs`。

---

## 2. 谁是谁

| 角色 | 事实 |
|---|---|
| **她** | 名字 `友利奈绪的大肥鱼`；自称"我"；对外人设是鲸鱼（怕猫）；B站账号昵称 `御坂美琴Rosie`；抖音号 `朴昌范`（douyin_id `30614312689`，uid `3584822243764652`）；微信只做代工、只读 |
| **主人** | `--友利奈绪-`，QQ `3082864371`；B站 mid 见 config `owner.mid`；抖音即上面那个号 |
| **QQ 群** | `2161082407`（她会在这个群里和群友聊天，群里另有 `与光同尘`、`IU♥` 等） |
| **称呼** | 她叫他"主人"；他叫她"大肥鱼" |

---

## 3. 要做什么（目标，一句话）

**把五个各自生成她的进程，收成一个中央统筹的脑**：一份自传、一个注意力、七器官、四回路。
判据三条：任何通道问同一件事答案一致；说过要做的事一定有下落；可以记不清但不许说"没发生过"、不许无证据声称做过。

---

## 4. 已拍板的决定（不要再重新讨论）

| # | 决定 | 出处 |
|---|---|---|
| D1 | **看番/看剧不设上限**，节奏她自己定（`binge.dailyMax=0`）。她的话就是指令："连看三集"→`--count 3`、"看到第 6 集"→`--to 6`、"这部今晚看完"→`--count all` | 10-28 |
| D2 | **痛感记忆不启用**：失败/被骂不加情绪权重、不进长期高显著。但失败仍进 `debts/audit`（问责与诚实需要） | 10-29 |
| D3 | **人格允许她自己维护**，主人也可以改，**主人优先**；每次改动留版本 + 理由 + 漂移检测 | 10-29 |
| D4 | **微信只读**：她知道自己在微信干了什么活，但不进自传体叙事 | 既有 |
| D5 | **群聊经历必须保留**（`scope` 只影响渲染，不影响能否知道）；群聊里**不许注入主人私事** | 10-29 |
| D6 | **不引入 npm/pip 依赖**；先倒排索引，向量检索留后面 | 环境限制 |
| D7 | 不 commit / 不 push，除非他明确要求 | 家规 |

---

## 5. 现状（本轮实测，10-29 16:45）

| 项 | 数值 |
|---|---|
| QQ 私聊记录 | 625 行（`qq/episodes.jsonl` 共 740 行） |
| 群聊记录 | 106 行（`chatId=qq:2161082407`，带 `isGroup:true`） |
| 写入速率 | 平均 **166 条/天**（10-25 峰值 301 条） |
| 她的对话视野 | `recent(chatId, 24)` → **≈2.9 小时** |
| 跨通道视野 | `recallAll({hours:12,max:12})` → 超过 12h 不可见 |
| 长期记忆总量 | `owner-profile.md` 0.7KB + `summary-qq_*.json` 0.4KB |
| 事实库 | `facts.json` 55 个桶，`owner` 桶仅 4 条（且只有时分、无日期） |
| 价值观池 | `lore.json` 203 条，其中 **180 条仍在注入**（含抖音标题×2、运维笔记） |
| 承诺账本 | 6 条全 done（含 1 条剧情转述、3 条同一部番重复） |
| 追番账本 | 《可塑性记忆》`seen=[1,2,3,4,5]`，total 13 |
| 提示词体量 | QQ 私聊 system 段 **7249 字**（人格 3038 / 世界见闻 1013 / 最近真实 851 / 能力 693） |
| 运行态 | qq-server `:8080` HTTP 200；微信关闭；B站/抖音巡检每 90s |
| 测试 | `node tools\run-tests.mjs` → **25 套全绿** |

---

## 6. 现在的架构长什么样（要改的就是它）

```
DSH (Electron 宿主)
└── dsh-feiyu 插件（D:\dsh-feiyu）
    ├── lib\           ← 插件层（scheduler.js 的 freedomTick、persona 挂钩等），改完需重启 DSH
    └── tools\
        ├── feiyu.mjs        CLI 入口
        ├── commands\        qq-server.mjs / douyin-dm-server.mjs / binge.mjs / selfwake.mjs …
        └── lib\             memory.mjs（流水账+检索）/ persona.mjs（提示词装配）/
                             promises.mjs（承诺）/ owner-facts.mjs / qq-memory.mjs / mood.mjs …
```

**五个"她"**：qq-server（私聊）、qq 群聊分支、douyin-dm-server（抖音私信）、B站巡检、抖音互动——各自装配提示词、各自生成。

**数据目录** `C:\Users\30828\.feiyu-ai\`（其中 `qq\` 是 QQ 专属，`binge\` 追番账本，`wechat\` 微信，根目录放 `episodes.jsonl / facts.json / lore.json / promises.json …`）。

---

## 7. 已诊断的缺陷（细节见 PLAN，这里只做索引）

| 类 | 核心几条 |
|---|---|
| 记忆 | 视野 2.9h；3h~7 天无通路；`summary` 是原文前 120 字；65 条 user 行无 summary；双写重复；**事实无日期却贴"今天"标签**；正则把疑问句当事实；`lore` 变成收藏夹；平台割裂靠 12h 补丁；长期记忆只剩 1.1KB；**无巩固、无遗忘、无元认知**；提示词命令"绝对不许说不知道" |
| 行为 | 承诺=自由文本+正则（抓到剧情转述）；去重按全文相等；动作路由只有 binge；无中间态/租约；说=即时奖励、做=无反馈；无声称校验；**闹钟从来没有实体**；三套时钟互不知情 |
| 在场 | `memory.mjs:214` 的 `r.isGroup !== true` 把群聊经历**整段删掉**（注释却说会带 `[QQ群]` 标签注入）；于是她在群里写完快排 50 秒后，私聊答"我就守着你这一个窗口" |

---

## 8. 环境事实（写代码前必须知道）

| 项 | 值 |
|---|---|
| Node | `C:\Users\30828\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0） |
| **没有** | npm / npx / pip（装不了依赖，方案必须纯 JS + 纯文本） |
| 配置 | `C:\Users\30828\.dsh\feiyu.config.json`（**可能带 BOM**，读取要容错；当前无 BOM） |
| 数据 | `C:\Users\30828\.feiyu-ai\` |
| 插件 | `D:\dsh-feiyu`（remote `https://github.com/baishuyue/dsh-feiyu.git`） |
| DSH 宿主 | `D:\新建文件夹 (7)\resources\app\dsh\`（当前 checkout，只用于看宿主实现） |
| LLM | `https://maas.qianwenaiapi.com/compatible-mode/v1` / `deepseek-v4.1-flash-1017`（备用 deepseek-chat） |
| 语音 | GPT-SoVITS `:9880`，音色 `bingjiao2`（**不要动** `D:\GPT-SoVITS`、`D:\rvc`） |
| ffmpeg | `D:\rvc\bin\ffmpeg.exe` |
| 端口 | qq-server `:8080`（`/health`）；napcat `:3000`；sovits `:9880` |
| 原生模块 | better-sqlite3 是 ABI 137，本机 node 是 137 —— **对得上，但方案仍建议纯文本，先不引入 DB** |

**热更新差异（踩过坑）**：`lib/**` 改完要**完整重启 DSH**；`tools/**` 每次 spawn 重读，改完只重启对应进程。

---

## 9. 常用核验命令（只读，安全）

```powershell
$node = "C:\Users\30828\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 测试
& $node D:\dsh-feiyu\tools\run-tests.mjs          # 期望：25 套全绿

# 健康
Invoke-WebRequest 'http://127.0.0.1:8080/health' -UseBasicParsing

# 重启 qq-server（先杀旧进程）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'qq-server' } | % { Stop-Process -Id $_.ProcessId -Force }
cmd /c "start /b "" ""$node"" D:\dsh-feiyu\tools\feiyu.mjs qq-server 8080 >> %USERPROFILE%\.feiyu-ai\qq-server.log 2>&1"

# 看状态
node -e "const fs=require('fs'),R=process.env.USERPROFILE+'/.feiyu-ai/';console.log(JSON.parse(fs.readFileSync(R+'promises.json','utf8')).items.map(x=>x.state+':'+x.what))"
```

> PowerShell 5.1 注意：不要 `Invoke-WebRequest -Uri $null`；长脚本用 here-string 写进 `$env:TEMP\*.mjs` 再 `node` 跑；不要直接 `cat` 大文件。

---

## 10. 下一步第一步（S1 影子期，可直接开工）

1. 建 `~/.feiyu-ai/brain/` 骨架 + `config.brain.json`（阈值先用 PLAN §12 的默认值）。
2. **影子写入**：在现有 `memory.remember()` 旁边再写一条到 `brain/episodic/`，带 `scope / speaker / feel / salience / evidence`（缺的给默认值），**老逻辑一个字不改**。
3. 写一个**只读校验脚本**：比对老/新行数、字段完整率、时间分布；跑够 2~3 天，字段完整率 ≥98% 才进 S2。

**S2 起才碰读取路径**（`recall2` + 8 槽装配 + 单写者 + 单注意力），且必须留一个开关能一键切回老装配。

---

## 11. 已知的坑（省你半天时间）

1. **时间戳全是毫秒整数**，渲染要转本地时区；历史上有过 UTC/本地混用。
2. **`spawnSync` 会钉住事件循环**：跑长任务（看番/发视频）必须用 `execFile` 异步，否则她那几分钟不能回话。
3. **群聊行有 `isGroup:true`**，文本带 "昵称：" 前缀；不做结构化 speaker 就会把群友当主人。
4. **`[sad]`/`[[平静]]` 标签**：私聊剥了，群聊漏剥，正文里露出来过。
5. **BOM**：配置读入要 `replace(/^\uFEFF/,'')`，历史事故。
6. **测试隔离**：测试要在 `mkdtempSync` 里设 `USERPROFILE/HOME/DSH_HOME/FEIYU_DATA_DIR`，且必须在 import `paths.mjs` **之前**设。
7. **机器会睡**（实测 01:07→08:02）：所有到点任务必须有 `catchUp`，否则"闹钟没响"。
8. **promise-outcome.json 是一次性的**（用完 `used:true`），别指望它当记忆。

---

## 12. 如果只能做一件事

**做 S1 的影子写入 + 校验脚本。**

理由：它是唯一"零风险、可停可删、且一旦跑起来就开始积累不可再造数据"的一步——`brain/episodic` 从今天起每写一行，将来 S2/S3 就有真实底账可用；而其它所有环节（检索、巩固、行为）都可以在事后补做，**只有"当时那一眼"补不回来**。

---

## 13. 文档地图

| 文件 | 作用 | 新对话是否需要读 |
|---|---|---|
| `FEIYU-BRAIN-HANDOFF.md` | **本文**：事实、约束、现状、下一步 | **必读** |
| `FEIYU-BRAIN-PLAN.md` | **最终方案**：七器官四回路、schema、算法、S1~S4、29 条探针 | **必读** |
| `BRAIN-AUDIT.md` | 现状取证（13 记忆缺陷 + 10 行为缺陷，含实测数字与代码行号） | 质疑某个判断时回查 |
| `BRAIN-DESIGN.md` | 器官设计推演（含人格自维护护栏、痛感记忆决定） | 需要设计理由时回查 |
| `BRAIN-UNITY.md` | 跨端一致 + 承诺履约的推演 | 同上 |
| `BRAIN-PRESENCE.md` | 群聊事故复盘（scope/speaker/presence 的由来） | 同上 |
| `HANDOFF.md` / `README.md` | 项目历史铁律与功能地图（86KB / 43KB，很旧但有用） | 需要历史决策时查 |

---

## 14. 语气与做事方式（他明确表达过的偏好）

- 他要**直接答案**，不要铺垫、不要"我建议您考虑"；先把活干了再说理由。
- 他会拿"她说的话"和"账本"对质——**一切结论要有证据（文件/行号/时间戳）**。
- 他讨厌"嘴上答应"；对他而言"做了但没留痕"≈"没做"。
- 回复用**简体中文**；代码标识符、路径、命令保持原样。
- 别 commit、别 push、别删那两个大资产目录、别复活旧方向（Blender/3D/videogen/cutout/edit/sfx/film.mjs）。

---

## 15. 已落地（2026-10-29 晚：v3 全量实现，一次改完）

### 15.1 新增代码（`tools/brain/`，20 个文件，全部零依赖）

| 文件 | 职责 |
|---|---|
| `json.mjs` | 原子写（temp+rename）、JSONL 追加/尾读、坏行跳过 |
| `paths.mjs` | 脑的全部路径（`brain/ep`、`inbox`、`sem`、`intent`、`self`、`meta`、`log`、`cons`） |
| `clock.mjs` | 本地 +08:00 ISO、人话相对时间（"昨天下午"）、相对时间解析（"明天9点半"） |
| `store.mjs` | TTL 写锁（pid 存活 + 接管）、`mutateJson`、单持有者排他锁 |
| `metrics.mjs` | 每日计数（`meta/metrics.json`，留 90 天） |
| `event.mjs` | 事件规范化（who/scope/act 在写入时定死）、分片 inbox、**微信直接 reject** |
| `episode.mjs` | 情景：gist/feel/salience/entities、`ingest`（msgId 重放去重） |
| `index-inv.mjs` | 中文 bigram 倒排索引（不换存储，2 字词能搜到） |
| `recall.mjs` | 混合召回（词面/新鲜/显著/情绪/自我/命中/实体）+ 群聊 audience 过滤 |
| `working.mjs` | 工作记忆 7 槽（≤1000 字） |
| `attention.mjs` | 注意力：急迫度打分、生成租约、队列上限 |
| `affect.mjs` | 情绪底色（EMA）+「兑现才给奖励」的调质层 |
| `facts.mjs` | 结构化事实：闭环谓词、**无 prov 拒收**、冲突标 disputed、`classifyLore` |
| `intents.mjs` | 意图三态（intent/blocked/wish）、租约+fencing、**无证据不算完成**、`catchUp` 分级 |
| `delivery.mjs` | 交付账（她真说出去的每一句） |
| `claim.mjs` | 声称-证据闸（没证据就把"我看完了"降成"正要接着看"） |
| `self.mjs` | 自我模型三层（主人层只读 / 自助层要理由 / 每周叙事）+ 历史版本 + 漂移检测 |
| `consolidate.mjs` | 睡眠巩固：聚类→抽事实→日记→情绪衰减→强度衰减→周日叙事；幂等可续跑 |
| `assemble.mjs` | 8 槽装配 + 硬预算 5650 字 + 三级诚实块 |
| `doctor.mjs` / `eval.mjs` / `backfill.mjs` / `index.mjs` | 体检 8 条不变量 / 评测台+权重标定 / 历史导入 / 门面（IO 只跟它打交道） |

### 15.2 改动的现有文件（都留了回滚口）

- `tools/lib/persona.mjs`：`:306` 那句「绝对不许说"我不知道""我没做过"」换成**三级诚实 + 保留「绝对不许说这事没发生过」**；把 7 个内部函数/常量导出（装配要用）。
- `tools/lib/config.mjs`：新增 `brain` 段（`mode: shadow|live|off`、`livePlatforms:['qq']`、`liveChats`、`budget`、`claim`、`wechatIsolated`）。
- `tools/lib/promises.mjs`：`add/done/fail` 镜像进脑的意图账本（`process.env.FEIYU_BRAIN_MIRROR=0` 可关）。
- `tools/lib/notify.mjs`：推送成功 → 记交付 + 发事件（"我刚说过"有账）。
- `tools/commands/qq-server.mjs`：用户/她自己每条消息 `brain.onEvent`；装配 `brain.assembleFor(...) ?? buildMessages(...)`；出站前过声称闸；发出后 `brain.onSent`；60s 心跳（catchUp + 该巩固时**spawn 子进程**，不钉事件循环）；`/health` 带脑摘要；新增 `POST /event`、`POST /sent`。
- `tools/commands/douyin-dm-server.mjs`：抖音私信同样进脑（`scope=private`）+ 交付记账。
- `tools/commands/brain.mjs` + `tools/feiyu.mjs`：`feiyu brain …` 12 个子命令。
- `lib/index.js`：只读路由 `GET /dsh-feiyu/api/brain`（面板用，不调模型不写盘）。
- `tools/run-tests.mjs`：注册 5 套脑测试，30 套全绿。

### 15.3 实测（真数据，不是估算）

- 历史导入：2 个旧文件 1175 行 → **1045 条情景**，跳过 85 条重复，**拦掉 45 条微信行**（旧记忆里确实混进过微信，这就是 I7 要防的）。
- 巩固：6 轮把 1045 条吃完 → **29 条结构化事实**（25 新增 / 4 合并 / **0 条无证据**），第 7 轮 `processed=0`（幂等）。
- 评测台：120 道真实题 → **Recall@6 0.875 / MRR 0.757**（校准前 0.85 / 0.70），权重已写回 `recall.mjs`。
- 提示词：真主人私聊装配 **5608 字**（旧版实测 7371 字），预算 5650，`dropped=[]`。
- `feiyu brain doctor`：**8 条不变量全绿**。

### 15.4 开关与回滚

```
config.json → brain.mode = "off"       # 一行关掉全部新行为（旧路径原样）
config.json → brain.mode = "shadow"    # 默认：只写不读，新旧并行对照
config.json → brain.mode = "live"      # 新装配接管 QQ 私聊（群聊仍走旧装配做对照）
config.json → brain.livePlatforms = [] # 一个通道都不切
```
脑的所有数据都在 `~/.feiyu-ai/brain/`：**删掉这个目录等于回到今天早上**，旧记忆文件一个都没动。

### 15.5 第二轮补齐（10-29 深夜，用户要求"没改完的改完"）

| 项 | 落地 | 门槛/开关 | 测试 |
|---|---|---|---|
| **O6 图式** `brain/schema.mjs` | 同 (主语,谓词) **≥5 条且跨度 ≥30 天**才归纳成一条规律（规则文本，不烧 LLM），举例取最近 3 条 | 不到门槛 `built:0`，一个字不写 | `brain-meta-test` 4 条不够 / 5 条才成 / 2 天跨度不归纳 |
| **O13 能力自评** `brain/competence.mjs` | 同一类活**成功 ≥3 次且带证据**才写进能力表；`canDo('我想唱歌')` → `not-enough-evidence` | 做一次就自夸 = 吹牛 | `brain-meta-test` 2 次不够 / 3 次才成 / 没做过就说不会 |
| **S4 执行者切换** `brain.executor` | `promises`（默认，旧账本执行）→ `intents`（脑的账本执行）：认领走租约+fencing、结算必须有证据、额度满走 `defer` 不算失信 | `config.brain.executor` | `brain-meta-test` 延后语义；qq-server `dueJobs()/finishJob()/deferJob()` |
| **身体/工具协议** `brain/taskqueue.mjs` | 白名单 kind（`binge/produce/dm-read/card-open/tts/web-search/backup`）+ args 数组逐项透传（**绝不拼 shell**）；`claim` 带租约、`complete` 落 `task-log.jsonl` | `config.brain.task` / `POST /task`、`GET /task` | `brain-meta-test` 白名单/租约/不重复执行/收尾留史 |
| **逐通道切换** | `livePlatforms:['qq','douyin-dm']` + `liveGroups:[…]`（群聊必须逐群列进来才切）；抖音私信已接线 | `config.brain` | `brain-isolation-test`、`brain-prompt-test` |
| 体检扩到 17 项 | 新增 O6 门槛、O13 门槛、任务队列堵死检查 | — | `brain doctor` 实跑全绿 |

### 15.6 仍然保留的旧路径（故意不删）

- `promises` 旧账本仍在，`executor=promises` 时是唯一执行者；切到 `intents` 它退成**只读历史**（`promises` 命令照旧能查）。
- `memory.remember` / `persona.buildMessages` 一行未改：`mode=shadow` 时仍是唯一实际路径，脑只旁听。
- `promise-outcome.json` 仍是一次性；脑这边用 `intents.verifyState.evidence` 代替它。