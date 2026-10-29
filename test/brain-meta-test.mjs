// brain 元认知层测试（O6 图式 / O13 能力自评 / 意图延后 / 身体任务队列）。
// 这一层的铁律就一条：**不到门槛不许写**。测试的重点全在门槛上。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-brain-meta-'))
process.env.FEIYU_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.FEIYU_BRAIN_MIRROR = '0'

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const facts = await import('../tools/brain/facts.mjs')
const schema = await import('../tools/brain/schema.mjs')
const competence = await import('../tools/brain/competence.mjs')
const intents = await import('../tools/brain/intents.mjs')
const tasks = await import('../tools/brain/taskqueue.mjs')

const now = Date.now()
const DAY = 86400_000
const seed = (n, { spanDays = 40, p = 'food.eat' } = {}) => {
  for (let i = 0; i < n; i++) {
    facts.add({ s: 'owner', p, o: `菜${i}`, validFrom: now - spanDays * DAY + Math.round((i / Math.max(1, n - 1)) * spanDays * DAY), prov: [`seed:${i}`], now })
  }
}

// ① 图式门槛：4 条不够
seed(4)
let r = schema.build({ write: false })
ok('4 条同谓词事实还不够（要 5 条）', r.built === 0, JSON.stringify({ built: r.built, skipped: r.skipped }))

// ② 补到 5 条，且跨度 ≥30 天 → 归纳出一条
seed(5)
r = schema.build({ write: true })
ok('补到 5 条后归纳出 1 条规律', r.built === 1, JSON.stringify(r.items.map((x) => x.text)))
ok('规律带次数和举例', /出现 \d+ 次/.test(r.items[0]?.text || ''), r.items[0]?.text)
ok('规律算得出跨度 ≥30 天', Number(r.items[0]?.spanDays) >= 30, String(r.items[0]?.spanDays))
ok('提示词里能看到这条规律', /规律/.test(schema.promptBlock()))

// ③ 跨度不够也不许归纳（刚记了 6 条但都在 3 天内）
facts.add({ s: 'owner', p: 'media.like', o: '阿A', validFrom: now - 2 * DAY, prov: ['s1'], now })
facts.add({ s: 'owner', p: 'media.like', o: '阿B', validFrom: now - 2 * DAY, prov: ['s2'], now })
facts.add({ s: 'owner', p: 'media.like', o: '阿C', validFrom: now - 2 * DAY, prov: ['s3'], now })
facts.add({ s: 'owner', p: 'media.like', o: '阿D', validFrom: now - 2 * DAY, prov: ['s4'], now })
facts.add({ s: 'owner', p: 'media.like', o: '阿E', validFrom: now - 1 * DAY, prov: ['s5'], now })
const r2 = schema.build({ write: false })
ok('跨度只有 2 天 → 不许归纳（防过拟合）', !r2.items.some((x) => x.p === 'media.like'), JSON.stringify(r2.items.map((x) => x.p)))

// ④ 能力自评门槛：成功 2 次不够，3 次才算
const mk = (o, state, evidence = []) => {
  const c = intents.create({ object: o, verify: 'ledger', now })
  const id = (c.intent || {}).id
  if (state === 'done') intents.settle(id, { ok: true, evidence: evidence.length ? evidence : ['e:1'], now })
  if (state === 'failed') intents.settle(id, { ok: false, reason: '没材料', now })
  return id
}
mk('看《A》第1集', 'done'); mk('看《B》第1集', 'done')
let c = competence.derive({ write: false })
ok('成功 2 次还不算"会"', c.built === 0, JSON.stringify(c.items.map((x) => x.text)))
mk('看《C》第1集', 'done')
c = competence.derive({ write: true })
ok('成功 3 次才写进能力表', c.built === 1, JSON.stringify(c.items.map((x) => x.text)))
ok('能力表带成功率', Number(c.items[0]?.rate) === 1, String(c.items[0]?.rate))
ok('canDo 认得出这类活', competence.canDo('我想看番').ok === true)
ok('没做过的事不许说会', competence.canDo('我想唱歌').ok === false, JSON.stringify(competence.canDo('我想唱歌')))

// ⑤ 意图延后：没做成但不是她的错 → 顺延、不算失信、不进 missed
const late = intents.create({ object: '看《D》第1集', verify: 'ledger', dueAt: now - 3600_000, now })
const before = intents.all().find((x) => x.id === late.intent.id)
ok('到点了、可执行', intents.executable(now).some((x) => x.id === before.id))
intents.defer(before.id, 120, '今天额度满了', { now })
const after = intents.all().find((x) => x.id === before.id)
ok('延后后状态回到 open', after.state === 'open', after.state)
ok('延后后有新的到点时间（＋2 小时）', Number(after.dueAt) >= now + 119 * 60_000, String(after.dueAt - now))
ok('延后计入 deferCount，不算失信', Number(after.deferCount) === 1 && after.state !== 'missed')
ok('延后后当下不可执行', !intents.executable(now + 60_000).some((x) => x.id === before.id))

// ⑥ 任务队列：白名单 + 租约 + 收尾
ok('不认识的 kind 直接拒', tasks.enqueue({ kind: 'rm -rf /' }).ok === false)
ok('args 不是数组就拒', tasks.enqueue({ kind: 'binge', args: 'x' }).ok === false)
const t1 = tasks.enqueue({ kind: 'binge', args: ['--show', '可塑性记忆', '--ep', 'next'], note: '看番' })
ok('排队成功', t1.ok === true && t1.task.state === 'queued')
const c1 = tasks.claim('test-worker')
ok('认领到最早那条', c1.ok && c1.task.id === t1.task.id, JSON.stringify(c1.task?.kind))
ok('认领后带租约和 fencing', c1.task.state === 'leased' && c1.task.fencing >= 1 && Boolean(c1.task.lease?.until))
const c2 = tasks.claim('another-worker')
ok('第二条没活可领（不重复执行）', c2.ok === false, JSON.stringify(c2.reason))
ok('argvOf 还原成白名单命令', JSON.stringify(tasks.argvOf(c1.task)) === JSON.stringify(['binge', '--show', '可塑性记忆', '--ep', 'next']))
ok('不认识的 kind 还原不出命令', tasks.argvOf({ kind: 'nope' }) === null)
tasks.complete(c1.task.id, { ok: true, result: '看了第 3 集' })
ok('收尾后队列清空', tasks.stats().queued === 0 && tasks.stats().leased === 0, JSON.stringify(tasks.stats()))
ok('收尾留下历史', tasks.history(5).some((x) => x.kind === 'binge' && x.ok === true))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)