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
  diary: '两本日记（--book owner|private）',
  mem: '三层记忆（remember/fact/lore/recall/old/stats）',
  'qq-server': 'QQ 常驻聊天服务（NapCat OneBot v11，实时秒回）',
  qzone: '发 QQ 空间说说（NapCat send_qzone_msg）',
  douyin: '抖音互动（login/feed/comments/comment/interact）',
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
