// 收拾 binge 台账：同一天同一集只留一条（演练时跑了四五遍，别让它算成"今天看了 5 集"）
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './lib/paths.mjs'

const DIR = dataPath('binge')
if (!fs.existsSync(DIR)) { console.log('（没有 binge 台账）'); process.exit(0) }
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue
  const p = path.join(DIR, f)
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  const seen = new Set()
  const log = []
  for (const r of (j.log ?? []).slice().reverse()) {
    const k = `${r.bvid}:${r.ep}:${new Date(Number(r.at)).toLocaleDateString('sv-SE')}`
    if (seen.has(k)) continue
    seen.add(k)
    log.unshift(r)
  }
  j.log = log
  j.seen = [...new Set(log.filter((r) => r.ok).map((r) => r.ep))].sort((a, b) => a - b)
  j.total = j.total || 1
  fs.writeFileSync(p, JSON.stringify(j, null, 1) + '\n', 'utf8')
  console.log(`${f}：${j.log?.length ?? 0} 条记录，看过第 ${j.seen.join('/')} 集（共 ${j.total}）`)
}