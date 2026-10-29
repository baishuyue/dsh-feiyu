// run-tests —— 不依赖 npm 的测试跑轮（这台机器上 PATH 里没有 node/npm，
// `npm test` 跑不了，而她自己改完代码必须验证）。
//
//   node tools/run-tests.mjs            # 顺序跑全部 32 套，全绿退出 0
//   node tools/run-tests.mjs memory     # 只跑文件名含 "memory" 的
//
// 与 package.json 的 `test` 脚本等价：同样的文件、同样的顺序、失败即停。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS = [
  'client-smoke.mjs',
  'client-render.mjs',
  'stickers-test.mjs',
  'memory-test.mjs',
  'memory-recall-test.mjs',
  'qq-human-test.mjs',
  'group-persona-test.mjs',
  'douyin-card-test.mjs',
  'card-match-test.mjs',
  'freedom-quota-test.mjs',
  'tts-sanitize-test.mjs',
  'focus-one-thing-test.mjs',
  'tts-reftext-test.mjs',
  'voice-emotion-test.mjs',
  'web-shell-test.mjs',
  'recall-push-test.mjs',
  'imggen-test.mjs',
  'vision-test.mjs',
  'ledger-test.mjs',
  'comment-engage-test.mjs',
  'reply-style-test.mjs',
  'memory-hygiene-test.mjs',
  'video-test.mjs',
  'produce-plan-test.mjs',
  'wanvid-test.mjs',
  // 脑（v3）：事件/巩固/装配/意图/隔离 —— 这五套挂了就别切 live
  'brain-event-test.mjs',
  'brain-consolidate-test.mjs',
  'brain-prompt-test.mjs',
  'brain-intents-test.mjs',
  'brain-isolation-test.mjs',
  'brain-meta-test.mjs',
  'brain-claim-test.mjs',
]

const filter = process.argv[2] || ''
const picked = filter ? TESTS.filter((t) => t.includes(filter)) : TESTS
if (!picked.length) {
  console.error(`没找到匹配「${filter}」的测试；可选：${TESTS.join(' / ')}`)
  process.exit(1)
}

// 测试要用同一份"真 node"（Electron 主进程里 process.execPath 不是 node）
const NODE = process.env.FEIYU_NODE || process.execPath
let bad = 0
for (const t of picked) {
  const file = path.join(HERE, '..', 'test', t)
  if (!fs.existsSync(file)) {
    console.log(`✗ ${t} —— 文件不存在`)
    bad++
    continue
  }
  const r = spawnSync(NODE, [file], { stdio: 'inherit', windowsHide: true, cwd: path.join(HERE, '..') })
  if (r.status === 0) console.log(`✓ ${t}`)
  else {
    console.log(`✗ ${t}（exit ${r.status ?? r.signal}）`)
    bad++
  }
}
console.log(bad ? `\n✗ ${bad}/${picked.length} 套没过` : `\n✓ 全部 ${picked.length} 套通过`)
process.exit(bad ? 1 : 0)