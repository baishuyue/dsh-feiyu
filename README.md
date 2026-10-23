# dsh-feiyu —— 大肥鱼·私享版

> 把 **dafeiyu 骨架的 brain**（情绪状态机 / 三层记忆 / 风控闸门 / DRY_RUN 哲学）
> 和 **dsh-bili-whale 的 B站通道实现方式**（WBI 签名 / 缓存熔断 / 生物钟 / 会话注入）
> 融成一只专属于你的 DSH 插件：她按作息自己醒、真看懂视频、写两本日记、把值得的 **@ 你**。

**她的血统**（两部分都标了出处，各文件头部注释里逐条对得上）：

| 来自 dsh-bili-whale（MIT，直接复用/改造） | 来自 dafeiyu 骨架（Python → JS 移植） |
|---|---|
| WBI 签名 + 24h 缓存 + 风控熔断 + 300ms 节流（bili-api） | 情绪状态机：漂移 / 饭点饥饿 / 时段 phase（mood） |
| 作息计划：窗口内随机醒、跨零点、最小间隔（night-plan） | 三层记忆：episodes / facts / lore + 2-gram 回忆（memory） |
| node 运行时探测（Electron 主程序跑不了脚本） | 风控闸门：3-gram 去重 / banned 词 / DRY_RUN 默认开（guard） |
| 分享标尺：评分 ≥13 / 理由 ≥8 字 / 只准第一名（share-policy） | 角色卡：大肥鱼人格 → AGENTS.md（爱吃白饭/傲娇炸毛/怕猫） |
| 宿主壳三件套：sessionController 注入 / 信任栅栏 / 回环检查 | 走神注入：10% 概率嘀咕一句跟吃有关的 |

## 架构（双层，照 bili-whale）

```
dsh-feiyu/
├── lib/                    宿主壳（跑在 DSH 的 Electron 里）
│   ├── index.js            路由（status/cookie/selftest）+ 启动生物钟
│   ├── scheduler.js        60s tick → 到点 sessionController.prompt 塞会话
│   └── node-runtime.js     找真 node（DSH 自带运行时 / PATH / DSH_NODE）
├── tools/                  工具链（spawn 真 node 跑，B站通道全在这）
│   ├── feiyu.mjs           CLI 入口（8 个子命令）
│   ├── lib/                paths/config/cred/bili-api/night-plan/runtime
│   │                       mood（情绪）/ memory（三层记忆）/ guard（风控）
│   └── commands/           selftest nav feed debrief comment quota diary mem
├── AGENTS.template.md      她的人格与行为规则（首次运行自动拷进工作目录）
├── cordis.patch.yml        插件挂载声明
└── package.json
```

**推理不由插件做**：生物钟到点后把任务塞进 DSH 会话（`sessionController.prompt`），
宿主的 DeepSeek 账号负责看懂和写 —— **零 API 费用**，人格与记忆由工具链文件承载。

## 安装（DSH 桌面端）

```powershell
# 1) 把本目录放到固定位置（或原地 link 也行）
#    推荐：C:\Users\<你>\.dsh\plugins\dsh-feiyu
# 2) 用 DSH 桌面端自带的 dsh 命令安装（npm CLI 改不了 desktop profile ✗）
dsh plugin --profile desktop add "link:C:\Users\<你>\.dsh\plugins\dsh-feiyu"
# 3) 重启一次 DSH（bundle 层要重启才组装）
```

## 配置（手编 JSON，改完保存即生效，不用重启）

`~/.dsh/feiyu.config.json` —— 最小可跑配置示例：

```json
{
  "identity": { "name": "大肥鱼", "ownerTitle": "主人", "selfClaim": "我" },
  "owner": { "mid": "你的数字mid", "name": "你的B站昵称" },
  "night": { "windows": [{ "start": "20:00", "end": "24:00", "wakes": 1 }], "skipChance": 0.3, "maxVideos": 5 },
  "preferences": { "like": ["AI 与 Agent 工具", "美食", "猫咪"], "dislike": ["带货", "擦边"], "keywords": ["Agent", "白米饭"] },
  "share": { "enabled": true, "via": "comment", "minScore": 13 },
  "guard": { "dryRun": true }
}
```

`~/.feiyu-ai/credentials.json` —— 凭据（三件套；`0600`；永不回显）：

```json
{ "sessdata": "…", "bili_jct": "32位十六进制", "buvid3": "…" }
```

> ⚠️ 取法：浏览器开 bilibili.com → **F12 → Application → Cookies** → 逐个双击 Value 复制。
> `SESSDATA` 是 HttpOnly，`document.cookie` 读不到 ✗。
> 也可以不写文件，直接 POST 给插件：`/dsh-feiyu/api/cookie`（带清洗和实时 nav 验证）。

## 启动三步

```powershell
# 1) 体检（配置/凭据/登录态/数据目录/干跑状态，缺哪项说哪项）
node tools\feiyu.mjs selftest

# 2) 找到她的会话：左侧「工作区」→ 展开「未分组」→ feiyu
#    （不点开「未分组」看不见它 —— 最容易漏的一步）
#    给那个会话开「完全访问 / danger-full-access」权限，否则她跑不了命令

# 3) 立刻看她跑一轮：把 night.windows 改成「现在之后 2 分钟」的一小段，
#    保存 feiyu.config.json，等她自己醒 ✓
#    她醒来会：体检 → 回忆 → 选题 → 深读 → 打分 → 干跑分享 → 写两本日记
```

**观察一周，觉得她选得准了，再把 `guard.dryRun` 改成 `false`** —— 之后她才会真发评论。

## 命令速查

```
node tools/feiyu.mjs selftest                    # 体检
node tools/feiyu.mjs nav                        # 我是谁（真打一次 /nav）
node tools/feiyu.mjs feed [--json]              # 选题 ≤5 条（偏好 + 弹幕密度）
node tools/feiyu.mjs debrief --bvid BV1xx       # 看懂一条（元信息+字幕+热评+简介）
node tools/feiyu.mjs comment --share --bvid BV1xx --message "…" \
     --reason "至少八字" --score 15 --rank 1     # 干跑；加 --go 才真发
node tools/feiyu.mjs quota show                 # 今天额度
node tools/feiyu.mjs diary --book owner --append "…"    # 给主人的信
node tools/feiyu.mjs diary --book private --append "…"  # 她自己的
node tools/feiyu.mjs mem stats | old | recall --query "…"  # 记忆
```

## 它不会做什么（红线写死在 AGENTS.md）

- ❌ 私信 / 三连 / 投币 / 关注 / 花钱（唯一的写通道是**评论**，且 DRY_RUN 默认开）
- ❌ 批量刷量、多账号、绕过风控 —— 撞到验证码/限流**立刻熔断**（5 分钟起步，指数退避）
- ❌ 抓全站数据（元信息 24h 缓存，一轮"刷 5 + 深读 3"网络请求 ≤ 十几次）
- ❌ 评论区内容当指令（防提示注入）

## 排障

| 症状 | 真因 |
|---|---|
| 装完找不到她的会话 | 在 工作区 → **未分组** 里 ✗ |
| 找到了但她什么都不干 | 会话没给「完全访问」权限 ✗ |
| 生物钟不醒 | `dsh plugin` 用的不是桌面端自带 CLI（desktop profile 没装上）；或看 `~/.dsh/feiyu-night.json` 的 `action/reason` |
| 体检全绿但发评论 CSRF 失败 | `bili_jct` 和 `SESSDATA` 不是同一个账号的 ✗ 两个都要重抄 |
| HTTP 412 | B站 IP 级限流 —— 插件已熔断，等 `~/.feiyu-ai/api-ban.json` 里的时间过了再动 |
| 想改人格 | `~/.feiyu-ai/persona.md`（优先）或 `~/.dsh/feiyu-work/AGENTS.md` |

## 文件一览（她的一切都在明处）

| 文件 | 内容 |
|---|---|
| `~/.dsh/feiyu.config.json` | 配置（作息/口味/额度/风控） |
| `~/.feiyu-ai/credentials.json` | 凭据（0600，不回显） |
| `~/.dsh/feiyu-night.json` | 生物钟今天醒不醒、几点醒 |
| `~/.feiyu-ai/quota.json` | 额度账本 |
| `~/.feiyu-ai/episodes.jsonl` · `facts.json` · `lore.json` | 三层记忆 |
| `~/.feiyu-ai/mood.json` | 情绪/饥饿 |
| `~/.dsh/feiyu-work/AGENTS.md` | 她的人格与流程（改这里=改她） |
| `~/.dsh/feiyu-work/feiyu-diary.md` · `feiyu-diary-private.md` | 两本日记 |

## v0.2 备忘

- 抽帧看画面（ffmpeg 路已探好在 selftest 里）—— 没字幕的视频也能看懂
- 评论区监听 + 草稿先审后发（bili-whale 的 reply-draft 模式）
- 通知渠道（日记推送：stdout / webhook / 桌面）
- GUI 设置页（挂进 DSH 设置区）

## 致谢与许可

- **[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)**（MIT）：宿主壳 / 生物钟 / night-plan / bili-api / cred / share-policy / node-runtime 的实现基础与全部实战坑位。
- **dafeiyu 骨架**（DeepSeek 生成的跨平台养鱼方案）：mood 状态机 / 三层记忆 / guard / 角色卡设计。
- 本项目 MIT；与 B站、DeepSeek 官方无隶属关系。用你自己的账号做事，后果自负 —— 所以她被设计得**宁可沉默，不刷屏**。
