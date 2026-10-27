// 记忆库回捞（10-27）
//
// 事故：`test/memory-hygiene-test.mjs` 第一版只设了一个 paths.mjs 不认的变量，
// 于是 rmSync/writeJson 打到了**真实**的 ~/.feiyu-ai：
//   lore.json      55 KB(172 条) → 132 B
//   facts.json     10 KB        → 63 B
//   episodes.jsonl 86 KB        → 226 B
// 这个脚本把三样都从备份捞回来（episodes 取两份备份的并集），并列出损失窗口。
//
//   node tools/restore-memory-10-27.mjs          # 只看方案
//   node tools/restore-memory-10-27.mjs --go     # 真写
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './lib/paths.mjs'

const GO = process.argv.includes('--go')
const bakOf = (base) => fs.readdirSync(path.dirname(dataPath(base)))
  .filter((f) => f.startsWith(path.basename(base) + '.bak') || f.includes(path.basename(base) + '.pre-clean') || f.includes(path.basename(base) + '.bak-'))
  .map((f) => path.join(path.dirname(dataPath(base)), f))
  .map((f) => ({ f, st: fs.statSync(f) }))
  .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)

const plan = []

// ① lore.json：拿最早那份"原始 172 条"，之后重跑迁移脚本封顶
const loreBaks = bakOf('lore.json')
const loreSrc = loreBaks.find((x) => x.st.size > 50000)
plan.push({ name: 'lore.json', from: loreSrc?.f, size: loreSrc?.st.size, note: '恢复原始 172 条，再跑 migrate-memory-10-27.mjs --go 重新封顶' })

// ② facts.json：同理，拿最大的那份（真实事实库）
const factsBaks = bakOf('facts.json')
const factsSrc = factsBaks.find((x) => x.st.size > 2000)
plan.push({ name: 'facts.json', from: factsSrc?.f, size: factsSrc?.st.size, note: '恢复真实事实库（含 owner 桶与各 userId 桶）' })

// ③ episodes.jsonl：多份备份取并集（按 ts+role+text 去重），尽量少丢
const epBaks = bakOf('episodes.jsonl').filter((x) => x.st.size > 20000)
plan.push({ name: 'episodes.jsonl', from: epBaks.map((x) => path.basename(x.f)).join(' + '), size: epBaks.reduce((s, x) => s + x.st.size, 0), note: '并集合并（qq/episodes.jsonl 一直没坏，QQ 侧记忆完整）' })

for (const p of plan) console.log(`· ${p.name}\n    来源：${p.from ?? '(没有可用备份)'}　${p.size ?? ''}\n    做法：${p.note}`)

if (!GO) { console.log('\n（没加 --go：只报告）'); process.exit(0) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
// 先备份当前（虽然已经是坏的，但留证据）
for (const n of ['lore.json', 'facts.json', 'episodes.jsonl']) {
  const cur = dataPath(n)
  if (fs.existsSync(cur)) fs.copyFileSync(cur, cur + '.wrecked-' + stamp)
}

// ① lore
if (loreSrc) fs.copyFileSync(loreSrc.f, dataPath('lore.json'))
// ② facts
if (factsSrc) fs.copyFileSync(factsSrc.f, dataPath('facts.json'))
// ③ episodes 并集
if (epBaks.length) {
  const rows = new Map()
  for (const b of epBaks) {
    for (const line of fs.readFileSync(b.f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        const k = `${r.ts}|${r.role}|${String(r.text || '').slice(0, 40)}`
        if (!rows.has(k)) rows.set(k, r)
      } catch {}
    }
  }
  const merged = [...rows.values()].sort((a, b) => Number(a.ts) - Number(b.ts))
  fs.writeFileSync(dataPath('episodes.jsonl'), merged.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  console.log(`\nepisodes 合并：${merged.length} 行（最早 ${new Date(merged[0]?.ts).toLocaleString('zh-CN')} → 最新 ${new Date(merged.at(-1)?.ts).toLocaleString('zh-CN')}）`)
}
console.log('✓ 已回捞。下一步：node tools/migrate-memory-10-27.mjs --go')
