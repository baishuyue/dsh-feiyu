// bili-watch —— 静默自助刷 B站一轮：feed → 深读 → LLM 生成 @评论 → 干跑/真发。
// 复用现有 feed/debrief/comment 三个命令（子进程调用，不重写），不写日记、少打印，是"静默"。
//
//   node feiyu.mjs bili-watch [--max 2] [--dry]
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FEIYU = path.join(HERE, '..', 'feiyu.mjs')

function runFeiyu(args) {
  return execFileSync(process.execPath, [FEIYU, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return {}; try { return JSON.parse(m[0]) } catch { return {} } }
function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }
function has(argv, name) { return argv.includes(name) }

export async function run(argv = []) {
  const cfg = config()
  const max = Number(arg(argv, '--max', 2)) || 2
  const dry = has(argv, '--dry') || cfg.guard?.dryRun !== false
  const ownerName = cfg.owner?.name || ''

  console.log(`[bili-watch] 静默刷一轮（最多 ${max} 条，${dry ? '干跑' : '真发'}）`)

  let items = []
  try { items = jsonOf(runFeiyu(['feed', '--json'])).items || [] } catch (e) { console.error('[bili-watch] feed 失败：' + e.message); return }

  let done = 0
  for (const it of items.slice(0, max)) {
    const bvid = it.bvid
    console.log(`\n[bili-watch] 看《${it.title}》(${bvid})`)
    let ctx = ''
    try { ctx = runFeiyu(['debrief', '--bvid', bvid]) } catch { ctx = it.title }
    const ctxBrief = ctx.replace(/\n+/g, ' ').slice(0, 1200)

    let comment = '', reason = '', score = 15
    try {
      const msgs = [
        { role: 'system', content: '你是"大肥鱼"，替主人在 B站 评论区写一条 @ 主人的分享评论。只输出 JSON：'
          + '{"comment":"15~60字，开头 @' + (ownerName || '主人') + '，像真人、有梗","reason":"至少8字，为什么值得分享给主人","score":0到20的整数}' },
        { role: 'user', content: `视频《${it.title}》\n看懂的信息：${ctxBrief}\n写评论：` },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.85 })
      const m = String(resp?.content ?? resp ?? '').match(/\{[\s\S]*\}/)
      if (m) { const j = JSON.parse(m[0]); comment = String(j.comment || ''); reason = String(j.reason || ''); score = Number(j.score) || 15 }
    } catch (e) { console.error('[bili-watch] 评论生成失败：' + e.message); continue }

    if (!comment) { console.log('  ✗ 评论为空，跳过'); continue }
    const args = ['comment', '--share', '--bvid', bvid, '--message', comment, '--reason', reason, '--score', String(Math.round(score)), '--rank', '1']
    if (!dry) args.push('--go')
    try { console.log(runFeiyu(args)) } catch (e) { console.error('[bili-watch] 评论失败：' + e.message) }
    done++
  }
  console.log(`\n[bili-watch] 结束：处理 ${done} 条。`)
}

if (process.argv[1] && process.argv[1].endsWith('bili-watch.mjs')) {
  await run(process.argv.slice(2))
}
