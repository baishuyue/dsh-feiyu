// 声称闸（O11）的措辞测试：改口必须能直接嵌回原句，不许留残句。
// 10-29 线上真的吐出过「我正要接着看了第3集」「还在写，写完给你看等下给你看」——
// 这两类都不是逻辑错，是**替换区间与降级短语没对齐**，所以这里逐个钉住。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-claim-'))
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

const claim = await import('../tools/brain/claim.mjs')
const intents = await import('../tools/brain/intents.mjs')

const rewrite = (text) => claim.gate(text, { chat: 'qq:claim-test' }).text

// ① 时态降级不许把「了」留在动词后面
const a = rewrite('我看完了第3集，女主最后还是走了')
ok('「看完了第3集」→「正要接着看第3集」', a === '我正要接着看第3集，女主最后还是走了', a)

// ② 「第」是量词，不是动词短语的一部分
const b = rewrite('我追到第8集了')
ok('「追到第8集」保留「第」', b === '我正要接着看第8集了', b)

// ③ 降级短语不许自带后半截（否则和原句重复）
const c = rewrite('写完了，等下给你看')
ok('「写完了，等下给你看」不重复后半截', c === '还没写完，等下给你看', c)

// ④ 最长匹配优先：不能把「已经发给你了」拆成「这就发你给你了」
const d = rewrite('已经发给你了')
ok('「已经发给你了」→「这就发你」', d === '这就发你', d)

// ⑤ 整句里只有一个动词被改，其余原样
const e = rewrite('我把整部都刷完了')
ok('「刷完了」→「正要接着看」且不留「了」', e === '我把整部都正要接着看', e)

// ⑥ 有证据就不许改口（意图账本里有一条 done + evidence）
const c1 = intents.create({ object: '看《可塑性记忆》第3集', verify: 'ledger' })
intents.settle(c1.intent.id, { ok: true, evidence: ['binge:可塑性记忆:E3'] })
const f = claim.gate('我看完了第3集', { chat: 'qq:claim-test' })
ok('账本里有证据时原句不动', f.changed === false && f.text === '我看完了第3集', JSON.stringify({ changed: f.changed, text: f.text }))
ok('证据引用被记进 findings', (f.findings[0]?.evidence || []).some((x) => x.kind === 'intent'), JSON.stringify(f.findings[0]?.evidence))

// ⑦ 干跑只记不改
const g = claim.gate('我已经发给你了', { chat: 'qq:claim-test', dryRun: true })
ok('dryRun 只记账不改字', g.changed === false && g.text === '我已经发给你了', g.text)

// ⑧ 没有可验证动词的句子一个字都不动
const h = rewrite('今天有点困，你呢')
ok('普通闲聊不动', h === '今天有点困，你呢', h)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)