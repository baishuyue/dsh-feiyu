// social —— 她今天在 B站 干了什么（主人："除了@我的其它我都不知道发生了什么"）。
//
//   node feiyu.mjs social                 # 今天：先列"没 @ 你的"，再列"@ 你的"
//   node feiyu.mjs social --days 3        # 近三天
//   node feiyu.mjs social --kind 回评     # 只看某一类（评论/回评/弹幕/动态/点赞/投币/关注/投稿）
//   node feiyu.mjs social --invisible     # 只看她干了但没告诉你的
//   node feiyu.mjs social --md            # 另存一份 Markdown 到 ~/.feiyu-ai/bili-social-<day>.md
//   node feiyu.mjs social --push          # 摘要推到主人 QQ（每日摘要就是走这条）
//   node feiyu.mjs social --json
//
// 数据源：~/.feiyu-ai/bili-social.jsonl（每条都标了 toOwner）
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import * as S from '../lib/social-log.mjs'

function argVal(argv, k, d = '') { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
function has(argv, k) { return argv.includes(k) }

export async function run(argv = []) {
  const cfg = config()

  // 补录优先：第一次用的人应该先看到历史，而不是先看到"她没动过"
  if (has(argv, '--backfill')) {
    const n = S.backfillFromOutbox()
    console.log(`📥 从 bili-outbox.md 补录了 ${n} 条历史${n ? '' : '（流水里已经都有了）'}`)
  }

  const days = Number(argVal(argv, '--days', 1)) || 1
  const kind = argVal(argv, '--kind', '')
  const recs = S.read({ days, kind, cfg })
  const invisible = recs.filter((r) => !r.toOwner)

  if (has(argv, '--json')) {
    console.log(JSON.stringify({ days, kind, total: recs.length, invisible: invisible.length, stats: S.stats(recs), records: recs }, null, 2))
    return
  }

  const onlyInvisible = has(argv, '--invisible')
  const list = onlyInvisible ? invisible : recs

  if (!list.length) {
    console.log(onlyInvisible
      ? `📭 近 ${days} 天她没干什么"没告诉你"的事`
      : `📭 近 ${days} 天她在 B站 没动过（没评论/没弹幕/没动态）`)
  } else {
    const st = S.stats(list)
    console.log(`📣 她在 B站 干了什么（近 ${days} 天 · ${list.length} 条${onlyInvisible ? '，只看没 @ 你的' : ''}）`)
    for (const d of st) {
      console.log(`\n■ ${d.day}　${S.countLine(d)}${d.toOwner ? `　（其中 ${d.toOwner} 条 @ 你）` : ''}`)
      const rows = list.filter((r) => r.day === d.day).sort((a, b) => Number(new Date(b.ts)) - Number(new Date(a.ts)))
      for (const r of rows) {
        const t = String(r.ts).slice(11, 16)
        const where = r.bvid ? `《${String(r.title || r.bvid).slice(0, 20)}》` : (r.title || r.url || '—')
        const to = r.to ? ` → ${String(r.to).slice(0, 16)}` : ''
        const mark = r.toOwner ? ' @你' : ''
        const body = String(r.text || '').replace(/\s+/g, ' ').slice(0, 70)
        console.log(`  ${t} ${r.label}${to} ${where}${mark}${body ? '：' + body : ''}`)
      }
    }
    console.log('')
    console.log(`@ 你的 ${recs.filter((r) => r.toOwner).length} 条 · 没 @ 你的 ${invisible.length} 条`)
    console.log('看单条上下文：https://www.bilibili.com/video/<BV号>')
  }

  if (has(argv, '--md')) {
    const f = S.writeMarkdown(recs)
    console.log('📝 已存：' + f)
  }

  if (has(argv, '--push')) {
    const text = S.digestText(recs, { limit: 14 })
    if (!text) { console.log('（没东西可推，跳过）'); return }
    const { sendOwnerQQ } = await import('../lib/notify.mjs')
    const head = `📣 我在B站今天干了这些（${recs.length} 条，${invisible.length} 条没 @ 你）\n\n`
    const ok = await sendOwnerQQ(head + text)
    console.log(ok ? '✓ 摘要已推到主人 QQ' : '✗ 推送失败（看上面日志）')
  }
}

if (process.argv[1] && process.argv[1].endsWith('social.mjs')) {
  await run(process.argv.slice(2))
}