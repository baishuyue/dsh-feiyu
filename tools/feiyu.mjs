#!/usr/bin/env node
// feiyu —— 大肥鱼·私享版 工具链总入口。
// 结构仿 dsh-bili-whale 的 tools/bili.mjs：命令分发到 tools/commands/*.mjs。
//
//   node feiyu.mjs <命令> [参数]
// 常用：
//   node feiyu.mjs selftest          # 装完立刻跑
//   node feiyu.mjs nav               # 我是谁 / 登录验证
//   node feiyu.mjs feed [--json]     # 选题 ≤5 条
//   node feiyu.mjs debrief --bvid BV1xx   # 看懂一条
//   node feiyu.mjs comment --share --bvid BV1xx --message "…" --reason "…" --score 15 --rank 1   # 干跑；--go 真发
//   node feiyu.mjs quota show        # 今天额度
//   node feiyu.mjs diary --book owner --append "…"   # 写日记
//   node feiyu.mjs mem stats         # 记忆库
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const COMMANDS = {
  selftest: '启动体检（装完立刻跑）',
  nav: '登录验证 / 我是谁',
  feed: '选题：热门+搜索，偏好加权',
  debrief: '看懂一条视频（元信息+字幕+热评+简介）',
  comment: '发评论（--share = 分享 @ 主人）',
  quota: '额度账本（check/record/show）',
  ledger: '账本：今天吃了多少饭钱/还能吃多少/今天还能干几件事（她自己查，不用问主人）',
  diary: '两本日记（--book owner|private）',
  mem: '三层记忆（remember/fact/lore/recall/old/stats）',
  'qq-server': 'QQ 常驻聊天服务（NapCat OneBot v11，实时秒回）',
  qzone: '发 QQ 空间说说（NapCat send_qzone_msg）',
  douyin: '抖音互动 + 运营：login/feed/comments/comment/interact/engage（评论区任何类型的评论都回：文字/表情包/图片）/produce（短视频生产）',
  report: '观看日报（B站/抖音 聚合 Markdown，不调模型）',
  watch: '抖音自主观看（feed→决策→兴趣记忆，时长限制）',
  review: '复盘学习日记（B站/抖音 提炼，写进私人日记）',
  'bili-watch': 'B站静默自助刷一轮（feed→深读→@评论）',
  'douyin-dm-server': '抖音私信陪聊（常驻轮询主人私信，像 QQ 那样）',
  act: 'B站活人感动作：act danmaku|dyn|like|coin|pic|follow（默认干跑）',
  replies: 'B站社交：⓪回自己作品下面的评论（任何类型：文字/表情/图片）①回别人对我的回复 ②主动搭话（默认干跑）',
  voice: '音色工坊：list/try/tryall/use/import + refcheck（ASR 核对参考文本，漏字会漏配音）+ refclean（挤掉参考段死空气，死空气会把音色带偏）| models（她的RVC音色）| train [--name] [--epochs]（训她自己的声音）| use-model --name',
  sing: '唱一首：["主题"] 原创（说唱/旋律）| cover "歌名" [--url 链接|--file 本地] 专业翻唱（换她的声音混伴奏）| songs 歌单',
  sticker: '表情包工坊：sticker gen "文案" [--tag 标签] [--send]（AI 画图入库，免费无 key）',
  web: '上网工具：web search "关键词" | web fetch <url> | web log（她的全网冲浪手脚）',
  selfup: '自我升级底座：selfup backup（改前备份）| selfup log "改了什么" | selfup status',
  produce: '视频生产（真剪辑的片子）：produce ["主题"] [--platform bili|douyin] [--frames 1|2]（她策划→生图→配音→运镜→转场→烧字幕→配乐→1080p成片+封面；B站首条锁死自我介绍）| --debut 看首条锁 | --debut-posted BV号 解锁',
  social: 'B站社交流水：social [--days 3] [--kind 回评] [--invisible] [--md] [--push]（她今天跟谁说了什么，重点是不 @ 主人的那些）',
  vision: '视觉理解：status（看配置）| probe --image <图>（多模态描述，等视觉 key 点亮）',
  selfwake: '她自己定下次几点醒：selfwake 23:40 [--note "…"]｜--show｜--clear',
  focus: '她决定"接下来这一段时间干什么"：focus web|bilibili|douyin|binge --min 25 ｜focus rest --min 40 ｜focus off ｜focus（看现在在干什么）',
  binge: '看番/看剧（真的看完一集）：binge --search "番名" | binge --show "番名" --ep 2 --go | binge --bvid BV1xx --go | binge --list',
  promises: '承诺账本：promises（列）| promises done <id> | promises fail <id> "为什么" | promises --due（到点的）',
}

const cmd = process.argv[2]
if (!cmd || !(cmd in COMMANDS)) {
  console.log('大肥鱼·私享版 v' + (JSON.parse(await import('node:fs').then(m => m.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')))).version)
  console.log('')
  console.log('用法：node feiyu.mjs <命令> [参数]')
  for (const [name, desc] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(10)} ${desc}`)
  process.exit(cmd ? 1 : 0)
}

// Windows 绝对路径不能直接进动态 import —— 必须 file:// URL（node:internal/modules/esm/load 会拒 d: 协议）
const mod = await import(pathToFileURL(path.join(HERE, 'commands', `${cmd}.mjs`)).href)
const run = mod.run ?? mod.default
if (typeof run !== 'function') { console.error(`命令 ${cmd} 没有 run 导出`); process.exit(1) }
await run(process.argv.slice(3))
