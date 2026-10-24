// bili-watch —— 静默自助刷 B站一轮：feed → 深读 → LLM 生成 @评论 → 干跑/真发。
// 复用现有 feed/debrief/comment 三个命令（子进程调用，不重写），不写日记、少打印，是"静默"。
//
//   node feiyu.mjs bili-watch [--max 2] [--dry]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import * as memory from '../lib/memory.mjs'
import { dataPath } from '../lib/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FEIYU = path.join(HERE, '..', 'feiyu.mjs')

// 宿主 stdio:ignore 起进程，不打文件日志等于瞎 —— 出问题只能靠猜
const LOG = dataPath('bili-watch.log')
const log = (...a) => { const m = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); try { console.log(m) } catch {}; try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`) } catch {} }

function runFeiyu(args) {
  return execFileSync(process.execPath, [FEIYU, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return {}; try { return JSON.parse(m[0]) } catch { return {} } }
function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }
function has(argv, name) { return argv.includes(name) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function run(argv = []) {
  const cfg = config()
  const dry = has(argv, '--dry') || cfg.guard?.dryRun !== false
  const ownerName = cfg.owner?.name || ''
  // 自由刷：大肥鱼自己长时间刷 B站，不限条数/时长（unlimited）或按限度
  const free = has(argv, '--free') || cfg.bilibili?.freeRoam?.enabled === true
  const fr = cfg.bilibili?.freeRoam || {}
  let max, restMs   // sleep 收毫秒 —— 间隔直接算成毫秒（曾把 5 分钟喂成 5ms 级）
  if (free) {
    const unlimited = fr.unlimited !== false
    max = unlimited ? 999999 : (Number(fr.maxVideos) || 999999)
    const restMin = Number(fr.restMin)
    restMs = Math.max(0, Number.isFinite(restMin) ? restMin : 5) * 60_000
  } else {
    max = Number(arg(argv, '--max', 2)) || 2
    restMs = 0
  }

  log(`[bili-watch] ${free ? '自由刷' : '静默刷一轮'}开始（${free && max > 99998 ? '不限量' : '最多 ' + max + ' 条'}，${dry ? '干跑' : '真发'}）`)

  let done = 0
  let items = []
  let shareQuotaOut = false   // 分享额度用完 → 后面只看不 @，别每条都报错刷屏
  while (done < max) {
    try { items = jsonOf(runFeiyu(['feed', '--json'])).items || [] } catch (e) {
      // 自由刷不能因为一次 feed 失败就退出（进程一死面板开关还亮着）—— 歇 5 分钟再试
      if (free) { log('[bili-watch] feed 失败，歇 5 分钟再试（自由刷不退出）：' + e.message); await sleep(5 * 60_000); continue }
      log('[bili-watch] feed 失败：' + e.message); break
    }
      if (!items.length) { if (free) { log('[bili-watch] 没刷到视频，歇会儿再试'); await sleep(restMs || 30_000); continue } break }
    for (const it of items) {
      if (done >= max) break
      const bvid = it.bvid
      log(`\n[bili-watch] 看《${it.title}》(${bvid})`)
      memory.remember('bilibili', `bilibili:${bvid}`, it.owner || '', 'event', String(it.title).slice(0, 120))
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
      } catch (e) { log('[bili-watch] 评论生成失败：' + e.message); continue }

      if (!comment) { log('  ✗ 评论为空，跳过'); continue }
      if (shareQuotaOut) { log('  💤 分享额度已用完，这条只看不 @'); done++; if (restMs > 0) await sleep(restMs + Math.random() * 60_000); continue }
      const args = ['comment', '--share', '--bvid', bvid, '--message', comment, '--reason', reason, '--score', String(Math.round(score)), '--rank', '1']
      if (!dry) args.push('--go')
      try { log(runFeiyu(args)) } catch (e) {
        if (/额度|上限/.test(String(e.message))) { shareQuotaOut = true; log('  💤 分享额度用完，后面只看不 @') }
        else log('[bili-watch] 评论失败：' + e.message)
      }
      done++
      if (restMs > 0) await sleep(restMs + Math.random() * 60_000)
    }
    if (!free) break
  }
  log(`\n[bili-watch] 结束：处理 ${done} 条。`)
}

if (process.argv[1] && process.argv[1].endsWith('bili-watch.mjs')) {
  await run(process.argv.slice(2))
}
