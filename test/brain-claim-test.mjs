// 声称闸（O11）的语义测试：**不许把完成态拗成将来态**。
// 10-29 实测事故（主人当场引用质问）：
//   「我看完了第3集」→「我正要接着看第3集」
//   「我追到第8集了」→「我正要接着看第8集了」
// 这是逻辑错乱：证据缺失 ≠ 没发生。现在的规矩是三条：
//   ① 账本有证据 → 原样放行；
//   ② 账本有**反证** → 改成「还没…」（不许出现"正要"）；
//   ③ 查不到 → 一个字都不改，只记账（verdict=unknown）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-claim-'))
process.env.FEIYU_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.FEIYU_BRAIN_MIRROR = '0'

// 造一份看番账本：测试番 已看 1~3 集
fs.mkdirSync(path.join(tmp, 'binge'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'binge', '测试番.json'), JSON.stringify({ show: '测试番', seen: [1, 2, 3] }), 'utf8')

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const claim = await import('../tools/brain/claim.mjs')
const intents = await import('../tools/brain/intents.mjs')

const rewrite = (text) => claim.gate(text, { chat: 'qq:claim-test' })
const NO_FUTURE = (s) => !/正要接着看|这就去|马上/.test(String(s))

// ① 有证据（账本 seen 含第 3 集）→ 原样放行，不许改
const a = rewrite('我看完了第3集，女主最后还是走了')
ok('账本里有第3集 → 原句不动', a.text === '我看完了第3集，女主最后还是走了' && a.changed === false, a.text)
ok('放行时 verdict=ok', a.findings[0]?.verdict === 'ok', String(a.findings[0]?.verdict))
ok('证据来自看番账本', (a.findings[0]?.evidence || []).some((x) => x.kind === 'binge'), JSON.stringify(a.findings[0]?.evidence))

// ② 反证（账本只到第 3 集）→ 改成「还没看」，绝不出现"正要"
const b = rewrite('我看完了《测试番》第9集')
ok('反证时改成「还没看」', b.text === '我还没看《测试番》第9集', b.text)
ok('反证时不出现将来态', NO_FUTURE(b.text), b.text)
ok('反证时 verdict=contradicted', b.findings[0]?.verdict === 'contradicted', String(b.findings[0]?.verdict))
ok('反证理由来自账本', /只看到第3集/.test(b.findings[0]?.contra?.why || ''), String(b.findings[0]?.contra?.why))

// ③ 查不到 → 不改字（这是 10-29 事故的根因，必须钉死）
const c = rewrite('我追到第8集了')
ok('没有账本能核对时原句不动', c.text === '我追到第8集了' && c.changed === false, c.text)
ok('未核对时 verdict=unknown', c.findings[0]?.verdict === 'unknown', String(c.findings[0]?.verdict))

// ④ 句子里没有作品名、只有集数：能找到同集证据就放行，找不到就不动
const d = rewrite('我看完了第3集')
ok('只报集数也能用账本核对（同集存在即放行）', d.changed === false && d.findings[0]?.verdict === 'ok', d.text)

// ⑤ 活句里的过去时虚指（"看了个标题"）不许被改
const e = rewrite('没学会，那条我就看了个标题和简介')
ok('「看了个标题和简介」原句不动', e.text === '没学会，那条我就看了个标题和简介' && e.changed === false, e.text)

// ⑥ 意图账本给反证：答应发照片但过期没做 → 「还没发给你照片」
intents.create({ object: '把照片发给你', verify: 'delivery', dueAt: Date.now() - 3600_000 })
const f = claim.gate('发给你了照片', { chat: 'qq:claim-test' })
ok('意图过期未完成 → 改成「还没发给你」', /^还没发给你照片/.test(f.text), f.text)
ok('意图反证理由写进 findings', Boolean(f.findings[0]?.contra?.why), String(f.findings[0]?.contra?.why))

// ⑦ 没有任何账本可核的发送类，不许乱改
const g = rewrite('已经发给你了')
ok('「已经发给你了」无账可核 → 不动', g.text === '已经发给你了' && g.changed === false, g.text)

// ⑧ dryRun 只记不改
const h = claim.gate('我看完了《测试番》第9集', { chat: 'qq:claim-test', dryRun: true })
ok('dryRun 只记账不改字', h.changed === false && h.text === '我看完了《测试番》第9集', h.text)

// ⑨ 普通闲聊一个字都不动
const i = rewrite('今天有点困，你呢')
ok('普通闲聊不动', i.text === '今天有点困，你呢' && i.changed === false, i.text)

// ⑩ 全篇扫一遍：无论怎么改，输出里都不许出现"正要接着看"
const corpus = ['我看完了第3集', '我追到第8集了', '写完了，等下给你看', '做好了，你听听', '这首歌我唱完了', '回他了', '我看完了《测试番》第9集']
const outs = corpus.map((t) => claim.gate(t, { chat: 'qq:claim-test' }).text)
ok('十个例子全都不出现将来态替换', outs.every(NO_FUTURE), outs.join(' / '))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)