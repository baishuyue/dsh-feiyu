# dsh-feiyu —— 大肥鱼·私享版

> 一只养在你本机的「大肥鱼」：**B站** 自主刷视频写日记、**QQ** 秒回陪你聊（含语音条）、
> **微信** 替你回消息、**抖音** 自主观看 + 评论互动。四平台共用同一套人格、情绪与记忆，
> 在 DSH 设置里用面板控制，所有外发默认关闭、每一项都有独立开关和上限。

她的血统：**dafeiyu 骨架的 brain**（情绪状态机 / 三层记忆 / 风控闸门 / DRY_RUN 哲学）
+ **dsh-bili-whale 的 B站通道**（WBI 签名 / 缓存熔断 / 生物钟 / 会话注入），各文件头部注释逐条标了出处。

---

## 一、功能总览

### 四平台能力矩阵

| | B站 | QQ | 微信 | 抖音 |
|---|---|---|---|---|
| 消息入口 | WBI API（签名 + 缓存） | NapCat（OneBot v11） | UI 自动化（wechatauto） | patchright + 本地 Chrome |
| 模型宿主 | DSH 会话（零 API 费） | 直连 DeepSeek（秒回） | 直连 DeepSeek | 直连 DeepSeek |
| 主动行为 | 刷视频→看懂→评论→写日记 | 私聊/群聊@回复、语音、说说 | 替主人回消息 | 自主观看、评论、日报 |
| 记忆 | 主记忆（episodes/facts/lore） | **独立记忆**（episodes+摘要+画像） | **按联系人隔离** | 主记忆 + 兴趣(lore) |
| 表情 | B站表情码（447 个白名单） | 图片表情 + 颜文字 | 图片表情 + 颜文字 | emoji + 颜文字 |
| 语音 | — | GPT-SoVITS 音色克隆 | — | 计划中（Whisper） |

### 一句话说清每个平台

- **B站**：生物钟到点自己醒 → 选题 → 深读（字幕/热评/简介）→ 打分 → 干跑分享 → 写两本日记。写通道只有**评论**，DRY_RUN 默认开。
- **QQ**：常驻 `qq-server` 秒回；群聊被 @ 才回、私聊都回；能发图片表情、能发语音条（概率可控）；能发空间说说。认主、会撒娇、有情绪。
- **微信**：独立 Python 进程，替主人回消息（对方不知道是自动回复），语气是大肥鱼本人——有温度、会吐槽，但按联系人分开记，广告/服务号跳过，钱/时间/见面不承诺。
- **抖音**：`interact` 全流程（feed→选题→LLM 评论→发）；`watch` 自主观看（feed→决策→兴趣记忆）；`comment` 纯文字评论（默认不带 @ 防风控）。

---

## 二、记忆体系（她为什么「记得你」）

记忆分四块，物理隔离，互不污染：

| 空间 | 路径 | 内容 | 谁读写 |
|---|---|---|---|
| **主记忆** | `~/.feiyu-ai/episodes.jsonl` `facts.json` `lore.json` | 情节事件流 / 关系事实 / 世界设定与兴趣 | B站、抖音、工具链 |
| **QQ 独立记忆** | `~/.feiyu-ai/qq/` | `episodes.jsonl`（对话原文）、`summary-<会话>.json`（每 6 轮压一次摘要）、`owner-profile.md`（主人画像，可手改） | qq-server + qq-memory |
| **微信按联系人隔离** | `~/.feiyu-ai/wechat/<wxid>/` | `episodes.jsonl` + `profile.md`（对方是谁/关系/聊到哪/等我回复的事）+ `meta.json` | 微信机器人 |
| **情绪** | `~/.feiyu-ai/mood.json` | 情绪值 / 饥饿度，会自己漂移 | mood |

关键规则：

- **QQ 人格 = 你设的 persona.md + 她刷 B站/抖音 看来的世界 + 跟你聊出来的积累**。`worldBlock()` 把 B站/抖音最近见闻、`lore`、日记尾段拼成「你最近在外面看到的」注入 QQ 提示词；压缩记忆时也一起喂进去，画像是滚雪球式长的。
- **微信记录不参与人格演变**：`recall()`/`randomOld()` 默认排除 `platform=wechat`，只有显式 `{ includeWechat: true }` 才读——微信是在帮你干活，不是她的人生经历。
- **检索**：2-gram 分词 + 关键词命中（十万条以内够用，不上一开始就上向量库）。
- **兴趣记忆**：`watch` 自主观看把「为什么继续/停」写成 `lore` 的 `兴趣` 标签，反哺 feed 选题。
- **观看日报**：`report` 把当天 B站/抖音看过的内容聚成 Markdown，**不调模型**。

---

## 三、架构（双层，照 bili-whale）

```
dsh-feiyu/
├── lib/                    宿主壳（跑在 DSH 的 Electron 里）
│   ├── index.js            路由（status/cookie/selftest/config/memory/persona/services/report/watch）
│   │                       + 生物钟 + QQ网关(NapCat)自愈 + GPT-SoVITS 自愈
│   ├── scheduler.js        60s tick → 到点 sessionController.prompt 塞会话
│   └── node-runtime.js     找真 node（DSH 自带运行时 / PATH / DSH_NODE）
├── client.js               浏览器半边：DSH 设置里那一页「🐟 大肥鱼」（settings.section）
├── tools/                  工具链（spawn 真 node 跑）
│   ├── feiyu.mjs           CLI 入口（13 个子命令）
│   ├── lib/                config/cred/bili-api/night-plan/runtime
│   │                       mood(情绪)/memory(三层记忆)/qq-memory(QQ长记忆)/guard(风控)
│   │                       persona/stickers(表情)/tts(语音)/share-policy(分享标尺)/llm
│   └── commands/           selftest nav feed debrief comment quota diary mem
│                           qq-server qzone douyin report watch
├── wechat/wechat_bot.py    微信机器人（副本；运行的是 D:/wechat-bot/ 那份）
├── test/                   5 套测试（client-smoke/client-render/stickers/memory/qq-human）
└── package.json
```

**推理不由插件做**：B站生物钟到点把任务塞进 DSH 会话，宿主 DeepSeek 负责看懂和写——零 API 费。
QQ/微信/抖音需要实时响应，走直连 API。

---

## 四、安装（DSH 桌面端）

```powershell
# 1) 把本目录放到固定位置，例如 C:\Users\<你>\.dsh\plugins\dsh-feiyu
# 2) 用 DSH 桌面端自带的 dsh 命令安装（npm CLI 改不了 desktop profile）
dsh plugin --profile desktop add "link:C:\Users\<你>\.dsh\plugins\dsh-feiyu"
# 3) 重启一次 DSH（bundle 层要重启才组装）
```

外部依赖（按需装）：

| 平台 | 依赖 | 装一次 |
|---|---|---|
| B站 | 无（凭据即可） | — |
| QQ | NapCat（管理员注入 QQ）+ 可选 GPT-SoVITS（语音） | 见下方 |
| 微信 | wechatauto + 微信 PC 4.x | `D:/wechat-bot/` |
| 抖音 | social-auto-upload / patchright + Chrome | 见下方 |

---

## 五、配置

`~/.dsh/feiyu.config.json`（改完保存即生效，不用重启）。最小示例：

```json
{
  "identity": { "name": "大肥鱼", "ownerTitle": "主人", "selfClaim": "我" },
  "owner": { "mid": "数字mid", "name": "B站昵称", "qq": "QQ号", "wechat": "wxid" },
  "llm": { "api_key": "DeepSeek key（或环境变量 DEEPSEEK_API_KEY）", "model": "deepseek-chat" },
  "night": { "windows": [{ "start": "20:00", "end": "24:00", "wakes": 1 }], "skipChance": 0.3, "maxVideos": 5 },
  "preferences": { "like": ["AI 与 Agent 工具", "美食", "猫咪"], "dislike": ["带货", "擦边"] },
  "share": { "enabled": true, "via": "comment", "minScore": 13 },
  "guard": { "dryRun": true }
}
```

`~/.feiyu-ai/credentials.json` —— B站凭据（`0600`，永不回显）：

```json
{ "sessdata": "…", "bili_jct": "32位十六进制", "buvid3": "…" }
```

> 取法：浏览器 bilibili.com → F12 → Application → Cookies（`SESSDATA` 是 HttpOnly，`document.cookie` 读不到）。
> 也可以直接 POST 给 `/dsh-feiyu/api/cookie`（带清洗和实时 nav 验证）。

---

## 六、命令速查

```
node tools/feiyu.mjs selftest                     # 体检（配置/凭据/登录态/数据目录/干跑）
node tools/feiyu.mjs nav                         # 我是谁（真打一次 /nav）
node tools/feiyu.mjs feed [--json]               # B站选题 ≤5 条
node tools/feiyu.mjs debrief --bvid BV1xx        # 看懂一条（元信息+字幕+热评+简介）
node tools/feiyu.mjs comment --share --bvid BV1xx --message "…" --reason "…" --score 15 --rank 1 [--go]
node tools/feiyu.mjs quota show                  # 今天额度
node tools/feiyu.mjs diary --book owner|private --append "…"   # 写日记
node tools/feiyu.mjs mem stats|old|recall --query "…"          # 记忆
node tools/feiyu.mjs qq-server [8080]            # QQ 常驻聊天（NapCat OneBot 上报 /onebot）
node tools/feiyu.mjs qzone --content "…"         # 发 QQ 空间说说
node tools/feiyu.mjs douyin login|feed|comments|comment|interact   # 抖音互动
node tools/feiyu.mjs report [--days 1]           # 观看日报（B站/抖音聚合，不调模型）
node tools/feiyu.mjs watch [--duration 10] [--max 3] [--dry]      # 抖音自主观看
```

---

## 七、各平台细节

### B站（自主刷视频）

- 生物钟窗口内随机醒（拟人，不整点），跨零点、最小间隔
- 链路：凭据 → 分享标尺 → 风控闸门 → 额度闸 → POST → 记账
- 真 @ 主人：评论正文 `@昵称` + `at_name_to_mid`（B站原生通知，非风控点）
- 红线：只写评论；撞验证码/限流立刻熔断（5 分钟起步指数退避）

### QQ（像真人聊天）

- NapCat（OneBot v11）→ `qq-server` → DeepSeek 秒回；群聊 @ 才回，私聊都回
- 分条发送（1~3 条、随机间隔）；AI 腔清洗；读人（连发=急了、半夜=想人陪）
- 称呼：号码只是识别编号，绝不用它当称呼；长上下文 24 条 + 滚动摘要 + 主人画像
- 语音：GPT-SoVITS `/tts`（默认 9880），失败自动降级文字；插件启动自动拉起 + 每 60s 探活
- 说说：`qzone`（部分 NapCat 版本未暴露，失败看提示）

### 微信（替你回消息，语气是大肥鱼）

- 独立进程 `D:/wechat-bot/wechat_bot.py`；单实例（互斥量）+ 水位（重启不重放）
- 合并窗口（默认 3s，最长 12s）把连发当一句话；广告/服务号跳过、真人必须回
- 按联系人隔离上下文 + 滚动档案；不暴露身份、不替你做承诺
- 节奏档：`off` 秒回 / `fast` 1.5s / `natural` 4~7s / `calm` 挂机

### 抖音（互动 + 自主观看）

- `interact`：feed→口味过滤→读热评→LLM 评论→发（独立 `douyin.dryRun`，默认只演练）
- `comment`：**纯文字，默认不带 @**（LockyBee 结论：公开评论含 @ 是抖音风控主因；`douyin.atMention` 可显式开）
- `watch`：feed→决策 继续/换片/停（带理由）→记兴趣→循环，带时长限制
- 画面采样 + Whisper 音频理解：下一阶段（需给 douyin_interact.py 加截图 + 装 Whisper）

---

## 八、表情系统

| 平台 | 能发什么 | 触发 |
|---|---|---|
| QQ / 微信 | 图片表情 + 颜文字 | `[表情:开心]` 发图库里那张；`[自制表情:短句]` 当场画文字贴纸 |
| B站评论 | B站表情码 + 颜文字 | `[大笑]` `[doge]` `[吃瓜]`（447 个官方码白名单，外的一律剥掉） |
| 抖音评论 | emoji + 颜文字 | 方括号码不认，发布前剥掉 |

- 图库 `~/.feiyu-ai/stickers/<标签>/`，自带 6 张 AI 卡通小鱼（开心/无语/委屈/生气/困/比心），丢 png/gif 即用
- 自制贴纸 `tools/lib/sticker_render.py`（PIL 本地画，按文案 md5 缓存）
- 兜底：图库空→颜文字；发图失败→颜文字；评论里图片标记→剥掉

---

## 九、设置面板（DSH → 设置 → 🐟 大肥鱼）

| 区块 | 能改什么 |
|---|---|
| 运行状态 | 通道健康（QQ 网关/QQ 进程/微信心跳）、今日分享/评论数、情绪、干跑；跑体检 |
| 平台开关 | B站 / QQ / 微信 / 抖音 四个独立开关 |
| 主人 | QQ 号（认主）、称呼、B站 mid、微信 wxid |
| 音色 | 扫 GPT-SoVITS 模型列、试听（发你 QQ）、语音概率 |
| 微信 | 节奏档（含 off 秒回）、合并窗口、上下文条数、smart_skip |
| 作息与限额 | 醒来窗口、醒几次、分享开关/上限/最低分、抖音每次条数、观看日报、自主观看、评论 @ 开关 |
| 角色设定 | `persona.md`（她每次醒来都读） |
| 记忆库 | 最近对话 + 记忆计数（只读） |

> 想先看外观：`node scripts/build-preview.mjs` → `preview/panel.html`（离线渲染）。
> 改完前端 `npm test`（契约 + 假 hooks 真渲染，防白屏）。

---

## 十、排障

| 症状 | 真因 |
|---|---|
| 找不到她的会话 | 工作区 → **未分组** 里 |
| 找到了但什么都不干 | 会话没给「完全访问」权限 |
| 生物钟不醒 | 用桌面端自带 dsh CLI；看 `~/.dsh/feiyu-night.json` |
| 发评论 CSRF 失败 | `bili_jct` 和 `SESSDATA` 不是同一个账号 |
| HTTP 412 | B站 IP 限流，等 `api-ban.json` 里的时间过了再动 |
| QQ「服务在跑却不回」 | 网关 NapCat 没起（管理员注入 QQ）；看 `~/.feiyu-ai/qq-server.log` |
| QQ 语音没声音 | GPT-SoVITS(9880) 没起；插件会自动拉，或手动 `start_api.bat` |
| 微信不回复 | 看 `~/.feiyu-ai/wechat-bot.log`（收/想好/发出/跳过/失败） |

---

## 十一、文件一览（她的一切都在明处）

| 文件 | 内容 |
|---|---|
| `~/.dsh/feiyu.config.json` | 配置 |
| `~/.feiyu-ai/credentials.json` | B站凭据（0600） |
| `~/.feiyu-ai/episodes.jsonl` · `facts.json` · `lore.json` | 主记忆三层 |
| `~/.feiyu-ai/qq/` | QQ 独立记忆（episodes + 摘要 + 主人画像） |
| `~/.feiyu-ai/wechat/<wxid>/` | 微信按联系人记忆 |
| `~/.feiyu-ai/mood.json` | 情绪/饥饿 |
| `~/.feiyu-ai/quota.json` | 额度账本 |
| `~/.feiyu-ai/reports/` | 观看日报 |
| `~/.feiyu-ai/persona.md` | 角色设定（改这里=改她） |
| `~/.dsh/feiyu-work/AGENTS.md` | 人格与流程 |
| `~/.dsh/feiyu-work/feiyu-diary*.md` | 两本日记 |

---

## 十二、路线图

- 抖音画面采样 + Whisper 音频理解（自主观看完整版）
- 抖音官方作品卡片转发 / 私信（替代评论 @ 通知主人）
- 微信 hook 协议（wakuwku 路线，量级提速，需接受版本锁 + 风控风险）
- 自我迭代开关：让她自己改写 persona.md
- 评论区监听 + 草稿先审后发

---

## 致谢与许可

- **[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)**（MIT）：宿主壳 / 生物钟 / bili-api / share-policy 的实现基础
- **dafeiyu 骨架**：mood 状态机 / 三层记忆 / guard / 角色卡
- 参考 **[LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)**（抖音自主观看范式、评论去 @ 防风控）、**[wakuwku/qq-wechat-ai-bridge](https://github.com/wakuwku/qq-wechat-ai-bridge)**（hook 协议与表情库）、**[pan17/dsh-wechat](https://github.com/pan17/dsh-wechat)**（减少往返的提速思路）
- 本项目 MIT；与 B站、QQ、微信、抖音、DeepSeek 官方无隶属关系。用你自己的账号做事，后果自负——所以她被设计得**宁可沉默，不刷屏**。
