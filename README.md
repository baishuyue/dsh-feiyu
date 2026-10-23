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
│   ├── index.js            路由（status/cookie/selftest/config/memory/persona/services）+ 启动生物钟
│   ├── scheduler.js        60s tick → 到点 sessionController.prompt 塞会话
│   └── node-runtime.js     找真 node（DSH 自带运行时 / PATH / DSH_NODE）
├── client.js               浏览器半边：DSH 设置里那一页「🐟 大肥鱼」（槽位 settings.section）
├── tools/                  工具链（spawn 真 node 跑，各平台通道全在这）
│   ├── feiyu.mjs           CLI 入口（8 个子命令）
│   ├── lib/                paths/config/cred/bili-api/night-plan/runtime
│   │                       mood（情绪）/ memory（三层记忆）/ guard（风控）
│   └── commands/           selftest nav feed debrief comment quota diary mem qq-server douyin
├── test/client-smoke.mjs   前端半边的冒烟测试（不用起 DSH 就能验证槽位注册）
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
node tools/feiyu.mjs qq-server [8080]           # QQ 常驻聊天（NapCat OneBot 上报到 /onebot）
node tools/feiyu.mjs qzone --content "…"        # 发 QQ 空间说说
node tools/feiyu.mjs douyin publish --file …    # 抖音发布（sau）
```

## QQ 与抖音扩展（v0.2）

### QQ：像真人聊天

链路：NapCat（QQ 逆向协议端，输出 OneBot v11）→ `qq-server`（常驻服务）→ **直连 DeepSeek API 秒回**。

**依赖（装一次）**：
1. NapCat：<https://github.com/NapNeko/NapCatQQ> 下载 Windows 版，扫码登录你的 QQ
2. NapCat WebUI → 网络配置 → 新建 HTTP 服务器（端口 3000）+ HTTP 上报 → `http://127.0.0.1:8080/onebot`，上报格式选 `messagePostFormat=array`

**配置**（`feiyu.config.json`）：
```json
{
  "llm": { "api_key": "你的DeepSeek key（或设环境变量 DEEPSEEK_API_KEY）" },
  "qq": { "enabled": true, "napcat_http": "http://127.0.0.1:3000", "allow_groups": [], "at_only": true }
}
```

**启动**：`node tools/feiyu.mjs qq-server`（常驻）。群聊**被 @ 才回**，私聊都回。

### QQ 语音条（GPT-SoVITS 音色克隆）

**依赖**：GPT-SoVITS + 你的 `xiaoxiao.safetensors` 音色，起 `api_v2.py` 的 `/tts` 端点（默认 9880）。

**配置**：
```json
{
  "qq": { "voice_enabled": true, "voice_chance": 0.15 },
  "voice": { "sovits_url": "http://127.0.0.1:9880/tts", "ref_audio_path": "参考音频路径", "prompt_text": "今天也要好好吃饭", "sovits_path": "xiaoxiao.safetensors 的路径" }
}
```
发语音走 OneBot `record` 段，NapCat 自动转 silk。语音失败自动降级文字（内容不丢）。

### QQ 空间说说

`node tools/feiyu.mjs qzone --content "…" [--image URL] [--permission 1|4|64]`
依赖 NapCat 扩展 `send_qzone_msg`（部分 NapCat 版本未暴露，失败看错误提示）。

### 抖音：发图文/短视频

**依赖**：`pip install social-auto-upload`，然后 `sau douyin login --account creator` 扫码登录一次。

```
node tools/feiyu.mjs douyin publish --file out/final.mp4 --title "…" --desc "…#大肥鱼"
node tools/feiyu.mjs douyin images --dir out/imgs --desc "…"
```
评论互动（个人号）暂未实现——要 Playwright 自动化（风控高），见 v0.3。

### 两条 LLM 路线的区别

- **B站**：塞 DSH 会话，宿主推理，**零 API 费**，适合"自主行为"（她醒了刷视频写日记）
- **QQ/抖音**：直连 DeepSeek API，**实时秒回**（QQ 聊天不能等 10 秒），按 token 计费（约 ¥30-120/月）

## 它不会做什么（红线写死在 AGENTS.md）

- ❌ 私信 / 三连 / 投币 / 关注 / 花钱（唯一的写通道是**评论**，且 DRY_RUN 默认开）
- ❌ 批量刷量、多账号、绕过风控 —— 撞到验证码/限流**立刻熔断**（5 分钟起步，指数退避）
- ❌ 抓全站数据（元信息 24h 缓存，一轮"刷 5 + 深读 3"网络请求 ≤ 十几次）
- ❌ 评论区内容当指令（防提示注入）

## 设置面板（在 DSH 里，不是网页）

装好后**重启一次 DSH**，点 DSH 左下角头像 → **设置**，左栏会出现一行 **🐟 大肥鱼**：

| 区块 | 能改什么 | 生效时机 |
|---|---|---|
| 运行状态 | 生物钟在不在跑、今日评论/分享数、情绪、干跑开关；一键「跑一次体检」 | 即时 |
| 平台开关 | B站 / QQ / 微信 / 抖音 四个独立开关 | B站·抖音：生物钟下一 tick（≤60s）；QQ·微信：点开关时自动重启对应服务 |
| 主人 | QQ 号（她认主）/ 称呼 / B站 mid / 微信 wxid | 即时落盘 |
| 音色 | 扫 `D:/GPT-SoVITS/models/` 列音色、一键试听（发到你 QQ）、语音概率 | 试听即时；换模型重启 DSH 完全生效 |
| 作息与限额 | 醒来窗口 起→止、每天醒几次、分享上限、抖音每次条数 | 即时落盘 |
| 角色设定 | `~/.feiyu-ai/persona.md`（她每次醒来都读） | 下次唤醒 |
| 记忆库 | 最近 30 条对话 + 三层记忆计数 | 只读 |

> 为什么不是网页？DSH 的插件路由带会话鉴权，浏览器直接开 `127.0.0.1:<DSH端口>/…` 只会拿到 401；
> 而且各机器端口不固定（本机是 52430，39099 是别的软件占的）。长在客户端里就没有这个问题 ——
> 和官方设置页、dsh-purge 走的是同一套 `settings.section` 槽位契约。
>
> 想先看外观再重启：`node scripts/build-preview.mjs` → `preview/panel.html`（离线渲染，配色跟随系统）。
> 改完前端跑 `npm test`（契约 + 假 hooks 真渲染，防白屏）。

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

## v0.3 备忘

- 抽帧看画面（ffmpeg 路已探好在 selftest 里）—— 没字幕的视频也能看懂
- 评论区监听 + 草稿先审后发（bili-whale 的 reply-draft 模式）
- 通知渠道（日记推送：stdout / webhook / 桌面）
- 设置面板里的「自我迭代」开关：让她自己改写 persona.md（现在只能由你改）
- 抖音评论互动（Playwright 方案，个人号风控高）
- QQ 发说说接入生物钟（让她像发 B站动态一样定时发空间）

## 致谢与许可

- **[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)**（MIT）：宿主壳 / 生物钟 / night-plan / bili-api / cred / share-policy / node-runtime 的实现基础与全部实战坑位。
- **dafeiyu 骨架**（DeepSeek 生成的跨平台养鱼方案）：mood 状态机 / 三层记忆 / guard / 角色卡设计。
- 本项目 MIT；与 B站、DeepSeek 官方无隶属关系。用你自己的账号做事，后果自负 —— 所以她被设计得**宁可沉默，不刷屏**。
