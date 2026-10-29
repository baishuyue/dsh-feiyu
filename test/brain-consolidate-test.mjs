// brain 巩固测试（L2）：幂等、可续跑、事实带证据、日记落盘。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-brain-cons-'))
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

const event = await import('../tools/brain/event.mjs')
const episode = await import('../tools/brain/episode.mjs')
const facts = await import('../tools/brain/facts.mjs')
const consolidate = await import('../tools/brain/consolidate.mjs')
const paths = await import('../tools/brain/paths.mjs')

const now = Date.now()
const lines = [
  '我中午吃了烧鸭饭，皮太油了',
  '我下午在公司开会，一直开到五点',
  '我明天要去看牙，有点怕',
  '我今天有点累，想早点睡',
  '我最近在看《可塑性记忆》，挺好看的',
  '我在改代码，那个记忆模块',
]
for (const [i, text] of lines.entries()) {
  event.emit({ proc: 'c', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text, isOwner: true, msgId: `c-${i}` })
}
const ing = episode.ingest({ limit: 50 })
ok('6 条事件都进了情景', episode.allEpisodes().length >= 6, `ep=${episode.allEpisodes().length} ingested=${ing.ingested}`)

// 第一次巩固
const r1 = consolidate.run({ now, limit: 100 })
ok('第一次巩固跑完', r1.ok && r1.processed >= 6, JSON.stringify({ processed: r1.processed, facts: r1.facts }))
const total1 = facts.stats().total
const doneLines1 = fs.existsSync(path.join(paths.consDir(), 'done.jsonl'))
  ? fs.readFileSync(path.join(paths.consDir(), 'done.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
ok('抽出了事实（≥2 条）', total1 >= 2, `facts=${total1}`)
const withProv = facts.all().filter((f) => (f.prov || []).length)
ok('每条事实都带证据 id', withProv.length === facts.all().length, `${withProv.length}/${facts.all().length}`)
ok('done.jsonl 记了已处理的 ep', doneLines1 >= 6, `${doneLines1} 行`)

// 第二次巩固：幂等（事实不翻倍、done 不重复记）
const r2 = consolidate.run({ now: now + 1000, limit: 100 })
const total2 = facts.stats().total
const doneLines2 = fs.readFileSync(path.join(paths.consDir(), 'done.jsonl'), 'utf8').split('\n').filter(Boolean).length
ok('重复巩固不新增事实', total2 === total1, `${total1} → ${total2}`)
ok('重复巩固不重复记 done', doneLines2 === doneLines1, `${doneLines1} → ${doneLines2}`)
ok('第二次没有待处理（续跑游标正确）', r2.processed === 0, `processed=${r2.processed}`)

// 日记落盘
const diaries = fs.existsSync(paths.consDir()) ? fs.readdirSync(paths.consDir()).filter((f) => f.endsWith('.md')) : []
ok('写了复盘日记', diaries.length >= 1, diaries.join(','))

// 事实的时间带绝对锚点（不是只有 HH:MM）
const f = facts.all()[0]
ok('事实带 valid.from（绝对时间）', Number(f?.valid?.from) > 0, String(f?.valid?.from))
ok('事实带 source', Boolean(f?.source), String(f?.source))

// 预算：不传 chatFn 时一次 LLM 都不调
ok('规则阶段不烧 LLM', r1.llmCalls === 0, `llmCalls=${r1.llmCalls}`)

// 状态可查
const st = consolidate.status()
ok('status 报得出进度', st.processed >= 6 && st.total >= 6, JSON.stringify(st))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)