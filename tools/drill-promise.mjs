// 端到端演练：她答应"这就去看《可塑性记忆》" → 到点 → 真去看一集 → 结清承诺 → 进记忆
//
//   node tools/drill-promise.mjs            # 全流程
//   node tools/drill-promise.mjs --plan     # 只落账，不执行（给她自己第二天跑）
import * as promises from './lib/promises.mjs'
import * as ownerFacts from './lib/owner-facts.mjs'
import * as memory from './lib/memory.mjs'

const planOnly = process.argv.includes('--plan')

// ① 主人说他在干什么 + 吃了什么（这两条原本压根没记，所以她一直问）
const said = [
  '我中午吃了烧鸭，撑死了',
  '我在改插件呢，晚饭再说',
  '我推荐你去看一部番叫做可塑性记忆',
]
for (const s of said) {
  const got = ownerFacts.learnFromOwner(s)
  console.log(`主人：${s}\n  → 记下 ${got.map((g) => g.key + '=' + g.value).join('、') || '(无)'}`)
}
console.log('\n【今天已经知道的事】实际注入的样子：')
console.log(ownerFacts.promptBlock().split('\n').map((l) => '  ' + l).join('\n'))

// ② 她的回复里出现承诺 → 自动落账
const reply = '这就去看《可塑性记忆》第一集，看完讲给你听'
const got = promises.catchFromReply(reply, { userText: '我推荐你去看一部番叫做可塑性记忆' })
console.log(`\n她说：${reply}\n  → 落账 ${got.map((p) => `${p.id}「${p.what}」`).join('、') || '(无)'}`)

if (planOnly) {
  console.log('\n（--plan：只落账。到点后 qq-server 会自己执行）')
  process.exit(0)
}

// ③ 把到期时间改成现在，模拟"到点了" → 走 binge
const fs = await import('node:fs')
const path = await import('node:path')
const P = path.join(process.env.USERPROFILE, '.feiyu-ai', 'promises.json')
const j = JSON.parse(fs.readFileSync(P, 'utf8'))
for (const it of j.items) if (it.state === 'open') it.dueAt = Date.now() - 1000
fs.writeFileSync(P, JSON.stringify(j, null, 1) + '\n')

const due = promises.dueNow()
console.log(`\n到点的承诺：${due.map((d) => `${d.id}「${d.what}」`).join('、')}`)

// ④ 真的去看（等价于 qq-server 里 runCli(['binge', ... --go --json --promise id])）
const { execFileSync } = await import('node:child_process')
const id = due[0].id
const out = execFileSync(process.execPath, [
  path.join(import.meta.dirname, 'feiyu.mjs'), 'binge', '--show', due[0].what, '--ep', '1', '--go', '--json', '--promise', id,
], { encoding: 'utf8', timeout: 240000 })
const txt = String(out)
const r = JSON.parse(txt.slice(txt.indexOf('{')).trim() || '{}')
console.log(`\n执行结果：ok=${r.ok}  材料=${r.via}`)
console.log(`  剧情：${String(r.plot || '').slice(0, 120)}`)
console.log(`  感受：${String(r.feel || '').slice(0, 80)}`)

// ⑤ 账本与记忆
const after = promises.list().find((x) => x.id === id)
console.log(`\n承诺状态：${after?.state}　${after?.why || ''}`)
console.log('她自己的记忆（回 QQ 时能讲出来）：')
for (const row of memory.recent('qq:3082864371', 3)) console.log(`  [${row.role}] ${String(row.content ?? row.text).slice(0, 110)}`)

