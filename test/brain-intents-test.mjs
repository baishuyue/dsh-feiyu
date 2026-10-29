// brain 意图测试（O7）：三态都不许静默丢、完成必须有证据、租约单持有、补做分级。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-brain-intent-'))
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

const intents = await import('../tools/brain/intents.mjs')
const metrics = await import('../tools/brain/metrics.mjs')

const now = Date.now()
const mk = (o) => (intents.create(o).intent || {})

// ① 缺验收方式 → 降级 blocked，但不丢
const noVerify = mk({ object: '把房间收拾一下', now })
ok('缺 verify 的意图降级成 blocked（不丢）', noVerify.kind === 'blocked' && noVerify.state === 'blocked', `${noVerify.kind}/${noVerify.state}`)
ok('blocked 带重试时间', Number(noVerify.retryAt) > now, String(noVerify.retryAt))

// ② wish（做不到的心愿）也留在账上，且能出现在提示词里
const wish = mk({ kind: 'wish', object: '想去看一次海', now })
ok('wish 落账', wish.state === 'wish' && Boolean(wish.id), wish.state)
ok('提示词里能看到 wish', /海/.test(intents.promptBlock({ now })))

// ③ 补做分级：2 小时前 → doing；8 小时前 → debt；26 小时前 → missed
const late2 = mk({ object: '把这周的账算一下', verify: 'ledger', dueAt: now - 2 * 3600_000, now })
const late8 = mk({ object: '看《可塑性记忆》第1集', verify: 'ledger', dueAt: now - 8 * 3600_000, now })
const late26 = mk({ object: '给主人剪那条视频', verify: 'file', dueAt: now - 26 * 3600_000, now })
const cu = intents.catchUp(now)
ok('2 小时前的事进了补做队列', cu.doing.some((x) => x.id === late2.id), JSON.stringify(cu.doing.map((x) => x.object)))
ok('8 小时前的事记成欠着（6~24 小时）', cu.debt.some((x) => x.id === late8.id) || intents.debts(now).some((x) => x.id === late8.id), JSON.stringify(cu.debt.map((x) => x.object)))
ok('26 小时前的事标 missed（不静默消失）', cu.missed.some((x) => x.id === late26.id) || intents.all().find((x) => x.id === late26.id)?.state === 'missed')

// ④ 完成必须有证据
intents.settle(late8.id, { ok: true, now })
const after1 = intents.all().find((x) => x.id === late8.id)
ok('没有证据的"做完了"不算 done', after1.state === 'failed', after1.state)
ok('无证据被记进 metrics', Number(metrics.today().intentNoEvidence || 0) >= 1, String(metrics.today().intentNoEvidence))

const ev8 = mk({ object: '看《可塑性记忆》第2集', verify: 'ledger', dueAt: now - 60_000, now })
intents.settle(ev8.id, { ok: true, evidence: ['binge:ep2:done'], now })
ok('带证据的结算 → done', intents.all().find((x) => x.id === ev8.id).state === 'done')
ok('证据留在账上', (intents.all().find((x) => x.id === ev8.id).verifyState?.evidence || []).length >= 1)

// ⑤ 租约：同一时刻只有一个持有者
const l1 = intents.lease(noVerify.id, 'holderA', { now })
const l2 = intents.lease(noVerify.id, 'holderB', { now: now + 1000 })
ok('A 拿到租约', l1.ok === true, JSON.stringify(l1.reason))
ok('B 拿不到（busy）', l2.ok === false && l2.reason === 'busy', JSON.stringify(l2.reason))
ok('租约带 fencing（防双写）', Number(l1.fencing) >= 1, String(l1.fencing))
const l3 = intents.lease(noVerify.id, 'holderA', { now: now + 2000 })
ok('同一持有者可以续租', l3.ok === true)

// ⑥ 统计口径
const st = intents.stats()
ok('stats 报得出缺验收/无证据的条数', st.missingVerify === 0 && st.noEvidenceDone === 0, JSON.stringify(st))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)