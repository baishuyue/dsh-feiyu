// selfwake —— 她自己定"下一次几点醒"。
//
// 灵感来自 dsh-world 的 src/life/alarm.ts：她说完"我先读到几点"，到点再决定继续还是换一件。
// 我们的自由唤醒原来是固定间隔 + 概率（还会摇空一整轮），本质是**没让她表达意愿**。
// 现在她可以说：`node feiyu.mjs selfwake 23:40 --note "把那篇小说收尾"`，
// 调度器（lib/scheduler.js freedomTick）到点会真的把她叫起来，优先于概率。
//
//   node feiyu.mjs selfwake 23:40 [--note "…"]   定时间（HH:MM，跨天自动算明天）
//   node feiyu.mjs selfwake --show               看现在定的几点
//   node feiyu.mjs selfwake --clear              取消
import fs from 'node:fs'
import path from 'node:path'
import { homePath } from '../lib/paths.mjs'

const FILE = () => path.join(process.env.DSH_HOME || homePath('.dsh'), 'feiyu-next-wake.json')
const pad = (n) => String(n).padStart(2, '0')

function readIt() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch { return null }
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export function run(argv = []) {
  const f = FILE()
  if (argv.includes('--clear')) {
    try { fs.rmSync(f, { force: true }) } catch {}
    console.log('✓ 已取消下一次自定唤醒')
    return
  }
  if (argv.includes('--show') || !argv.filter(a => !a.startsWith('--')).length) {
    const cur = readIt()
    if (!cur || !cur.at) { console.log('（现在没定"下次几点醒"，走默认节奏）'); return }
    const d = new Date(Number(cur.at))
    console.log(`下次自定唤醒：${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
      + (cur.note ? `｜想干：${cur.note}` : ''))
    return
  }
  const spec = argv.find(a => /^\d{1,2}[:：]\d{2}$/.test(a))
  if (!spec) { console.error('用法：node feiyu.mjs selfwake 23:40 [--note "…"] ｜ --show ｜ --clear'); process.exit(2) }
  const [hh, mm] = spec.replace('：', ':').split(':').map(Number)
  if (hh > 23 || mm > 59) { console.error('✗ 时间不合法（HH:MM，0-23 / 0-59）'); process.exit(2) }
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0)
  if (at.getTime() <= now.getTime() + 60_000) at.setDate(at.getDate() + 1)   // 已过点就算明天的
  const note = arg(argv, '--note').slice(0, 80)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ at: at.getTime(), note, createdAt: Date.now() }))
  console.log(`✓ 定好了：${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`
    + `（还有 ${Math.round((at.getTime() - now.getTime()) / 60000)} 分钟）`
    + (note ? `｜到时候想干：${note}` : ''))
}
