// 一次性数据迁移：清掉今天查出来的三类污染（10-27）
//
//  ① lore.json 里的**运维排障笔记**被当成"价值观"每轮注入 → 标 kind:'ops'，不再进人格池
//  ② 同主题重复条目（她 10-25 夜里连写 10 条「南京菜单定稿」）→ 折叠成一条并记 n
//  ③ facts.json 里 owner 桶只有一条空字符串 `""` → 清掉（它让「关于主人的记忆」永远为空但不报错）
//
//   node tools\migrate-memory-10-27.mjs [--go]
// 不加 --go 只报告，不动文件（批量改记忆必须先看清单）。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath, homePath } from './lib/paths.mjs'

const GO = process.argv.includes('--go')
const LORE = homePath('.feiyu-ai', 'lore.json')
const FACTS = homePath('.feiyu-ai', 'facts.json')

const OPS_TAGS = new Set(['运维', '排障', '调试', '工具', 'bug', 'Bug', 'BUG', '工程'])
const isInterest = (x) => x.kind === 'interest' || x.tag === '兴趣'
const topicKey = (t) => String(t ?? '').replace(/[「」『』（）()《》【】\s·:：,，。.!！?？]/g, '').slice(0, 12)
/** 带日期前缀 = 干活流水（"10-27 16:05 统计了…"），不是人生观念。 */
const DATED = /^\s*\d{1,2}-\d{1,2}\s/
const CJK = /[\u4e00-\u9fa5]{2,6}/g
const tokensOf = (t) => new Set(String(t ?? '').match(CJK) || [])

// 工程/运维味道的文本（tag 没标对，但内容是排障笔记）
const OPS_TEXT = /(\d+\s*字\s*[✓✗]|URL|接口|返回|报错|参数|缓存|风控|抓不到|超时|正则|JSON|html|UA|header|API|脚本|日志|重试|熔断)/i

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
const writeJson = (f, v) => { fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n', 'utf8') }

const lore = readJson(LORE, [])
if (!Array.isArray(lore)) { console.error('✗ lore.json 不是数组，停'); process.exit(1) }

let ops = 0
let work = 0
const kept = []
const folded = new Map()
for (const item of lore) {
  const t = String(item.text ?? '')
  const isOps = OPS_TAGS.has(String(item.tag)) || (OPS_TEXT.test(t) && !isInterest(item))
  const isWork = DATED.test(t)
  if (isOps && item.kind !== 'ops') ops++
  if (isWork && !isOps && item.kind !== 'work') work++
  const it = isOps ? { ...item, kind: 'ops' } : isWork ? { ...item, kind: 'work' } : item
  if (isInterest(it) || it.kind === 'ops' || it.kind === 'work') { kept.push(it); continue }
  const k = topicKey(t)
  if (folded.has(k)) {
    const prev = kept[folded.get(k)]
    prev.n = Number(prev.n || 1) + 1
    prev.text = t
    prev.ts = Math.max(Number(prev.ts || 0), Number(it.ts || 0))
    continue
  }
  folded.set(k, kept.length)
  kept.push(it)
}
const removed = lore.length - kept.length

// 主题封顶：跨条目高频词（≥5 条）只保留最新 2 条，其余标 superseded。
// 要**跑到不动为止**：同一件事会踩到好几个高频词（南京/盐水鸭/夫子庙…），
// 只跑一遍时每个词各留 2 条，主题整体还能剩七八条 —— 跑 5 遍才收得住。
const isPlain = (x) => !isInterest(x) && x.kind !== 'ops' && x.kind !== 'work' && x.kind !== 'superseded'
let superseded = 0
for (let pass = 0; pass < 5; pass++) {
  const pool = kept.filter(isPlain)
  const freq = new Map()
  for (const x of pool) for (const tk of tokensOf(x.text)) freq.set(tk, (freq.get(tk) || 0) + 1)
  const hotTokensNow = [...freq].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])
  if (!hotTokensNow.length) break
  const hotSetNow = new Set(hotTokensNow.map(([t]) => t))
  const seenCnt = new Map()
  let droppedThisPass = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    const x = kept[i]
    if (!isPlain(x)) continue
    const toks = [...tokensOf(x.text)].filter((t) => hotSetNow.has(t)).sort((a, b) => freq.get(b) - freq.get(a))
    if (!toks.length) continue
    const main = toks[0]
    const n = seenCnt.get(main) || 0
    if (n >= 2) { kept[i] = { ...x, kind: 'superseded' }; superseded++; droppedThisPass++ } else seenCnt.set(main, n + 1)
  }
  if (!droppedThisPass) break
}

const facts = readJson(FACTS, {})
const ownerArr = Array.isArray(facts.owner) ? facts.owner : []
const ownerClean = ownerArr.filter((x) => String(x ?? '').trim())
const ownerDropped = ownerArr.length - ownerClean.length

console.log(`lore.json：${lore.length} 条 → ${kept.length} 条（折叠 ${removed} 条；新标 ops ${ops} 条 / 干活流水 ${work} 条 / 主题封顶标掉 ${superseded} 条）`)
const opsList = kept.filter((x) => x.kind === 'ops')
console.log(`  其中 ops（不再注入人格）：${opsList.length} 条`)
for (const o of opsList.slice(-4)) console.log(`    · [ops] ${String(o.text).slice(0, 50)}`)
const injectable = kept.filter((x) => x.kind !== 'ops' && x.kind !== 'work' && x.kind !== 'superseded' && x.tag !== '兴趣')
console.log(`  价值观池（每轮注入 6 条）剩 ${injectable.length} 条，其中含"南京"的 ${injectable.filter((x) => /南京/.test(x.text)).length} 条`)
if (injectable.length) {
  const f2 = new Map()
  for (const x of injectable) for (const tk of tokensOf(x.text)) f2.set(tk, (f2.get(tk) || 0) + 1)
  const top = [...f2].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (top.length) console.log(`  注入池里还偏多的主题词：${top.map(([t, n]) => `${t}×${n}`).join('、')}`)
}
console.log(`facts.json：owner 桶 ${ownerArr.length} 条 → ${ownerClean.length} 条（清掉 ${ownerDropped} 条空值）`)
if (ownerClean.length) for (const x of ownerClean.slice(0, 5)) console.log(`    · ${String(x).slice(0, 60)}`)

if (!GO) { console.log('\n（没加 --go：只报告，没动文件）'); process.exit(0) }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(LORE, LORE + '.bak-' + stamp)
fs.copyFileSync(FACTS, FACTS + '.bak-' + stamp)
if (ownerClean.length) facts.owner = ownerClean
else delete facts.owner
writeJson(LORE, kept)
writeJson(FACTS, facts)
console.log('\n✓ 已写入（备份：lore.json.bak-' + stamp + ' / facts.json.bak-' + stamp + '）')
