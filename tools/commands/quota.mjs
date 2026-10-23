// quota —— 额度账本：分享每天 ≤shareDaily、同一视频 sameVideoDays 天一次。
// 复用 dsh-bili-whale 的账本思路（quota.json + check/record），克制是活下来的前提。
//
//   node feiyu.mjs quota check --type share --target BV1xxxx
//   node feiyu.mjs quota record --type share --target BV1xxxx --note "…"
//   node feiyu.mjs quota show
import fs from 'node:fs'
import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'

const QUOTA_FILE = dataPath('quota.json')
const dayOf = (v = Date.now()) => new Date(v).toLocaleDateString('sv-SE')

function read() {
  try { return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')) } catch { return { log: [] } }
}
function write(q) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = QUOTA_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(q, null, 1) + '\n')
  fs.renameSync(temp, QUOTA_FILE)
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export function run(argv = []) {
  const cmd = argv[0] ?? 'show'
  const cfg = config()

  if (cmd === 'check') {
    const type = arg(argv, '--type') || 'share'
    const target = arg(argv, '--target')
    const sharesToday = read().log.filter(x => x.share && dayOf(x.at) === dayOf()).length
    const limit = Number(cfg.quota?.shareDaily ?? 3)
    if (sharesToday >= limit) {
      console.log(`✗ 今天已分享 ${sharesToday}/${limit} 条 —— 额度用完，明天再来`)
      process.exit(1)
    }
    if (target) {
      const days = Math.max(1, Number(cfg.quota?.sameVideoDays ?? 7))
      const cutoff = Date.now() - days * 86400_000
      const dup = read().log.find(x => x.target === target && Number(x.at) >= cutoff)
      if (dup) {
        console.log(`✗ 这条视频 ${dayOf(dup.at)} 已发过 —— ${days} 天内同一视频只发一次`)
        process.exit(1)
      }
    }
    console.log(`✓ 可发（今天 ${sharesToday}/${limit}）`)
    return
  }

  if (cmd === 'record') {
    const type = arg(argv, '--type') || 'share'
    const target = arg(argv, '--target') || ''
    const note = arg(argv, '--note') || ''
    const share = type === 'share'
    const q = read()
    q.log.push({ at: new Date().toISOString(), type, target, note: note.slice(0, 60), share })
    q.log = q.log.slice(-400)
    write(q)
    console.log(`✓ 已记账（${type}${target ? ' · ' + target : ''}）`)
    return
  }

  // show
  const q = read()
  const today = q.log.filter(x => dayOf(x.at) === dayOf())
  const shares = today.filter(x => x.share).length
  console.log(`今天：评论/记账 ${today.length} 条，其中分享 ${shares}/${cfg.quota?.shareDaily ?? 3} 条`)
  for (const x of today.slice(-10)) console.log(`  ${new Date(x.at).toLocaleTimeString('sv-SE')} ${x.share ? '[分享]' : '[回复]'} ${x.target || ''} ${x.note ?? ''}`)
  if (!today.length) console.log('  （今天还没发过 —— 安静是美德）')
}
