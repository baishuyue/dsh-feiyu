// 她在 B站 干了什么 —— 结构化流水（10-26 第 17 轮，主人："除了@我的其它我都不知道发生了什么"）。
//
// 以前只有两处痕迹：bili-outbox.md（人读的散文台账）和 quota.json（只有计数）。
// 主人要看"她今天到底跟谁说了什么、点了谁、转了什么"，散文不好筛，计数更不够。
// 所以这里再记一份 append-only 的 JSONL（机器可查、可统计、可生成摘要推给他）：
//   ~/.feiyu-ai/bili-social.jsonl
//
// 记录两类：
//   说话 —— 评论 / 分享评论 / 回评 / 弹幕 / 动态 / 图片评论（带正文、视频标题、回给谁）
//   动作 —— 点赞 / 投币 / 关注 / 投稿（谁、哪条视频）
// 并且每条都标出**是不是 @ 主人**：主人最想知道的就是"没 @ 我的那部分"。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'

export const LOG_FILE = () => dataPath('bili-social.jsonl')

export const KIND_LABEL = {
  comment: '评论',
  share: '分享评论',
  reply: '回评',
  danmaku: '弹幕',
  dynamic: '动态',
  imgComment: '图片评论',
  like: '点赞',
  coin: '投币',
  follow: '关注',
  video: '投稿',
}
const SPEAK_KINDS = new Set(['comment', 'share', 'reply', 'danmaku', 'dynamic', 'imgComment'])

/** 这条是不是 @ 了主人？（主人在 B站 可能被叫"主人"，也可能被他自己的昵称 @） */
export function mentionsOwner(rec = {}, cfg = {}) {
  const to = String(rec.to || '')
  if (/主人/.test(to)) return true                       // 回给主人的（to 里写着主人）
  const s = `${rec.text || ''} ${rec.extra || ''}`
  if (/(@|＠)\s*主人/.test(s)) return true
  const nick = String(cfg.owner?.biliName || cfg.owner?.nickname || '').trim()
  if (nick && (s.includes('@' + nick) || s.includes('＠' + nick))) return true
  return false
}

/**
 * 记一条。
 * @param {object} o {kind, bvid, title, to, text, extra, url, meta}
 */
export function append(o = {}) {
  try {
    const now = new Date()
    const kind = String(o.kind || 'comment')
    const rec = {
      ts: now.toISOString(),
      day: now.toLocaleDateString('sv-SE'),
      kind,
      label: KIND_LABEL[kind] || kind,
      speak: SPEAK_KINDS.has(kind),
      bvid: String(o.bvid || ''),
      title: String(o.title || '').slice(0, 80),
      to: String(o.to || '').slice(0, 80),
      text: String(o.text || '').slice(0, 400),
      extra: String(o.extra || '').slice(0, 120),
      url: String(o.url || (o.bvid ? `https://www.bilibili.com/video/${o.bvid}` : '')),
    }
    rec.toOwner = mentionsOwner(rec, o.cfg || {})
    const f = LOG_FILE()
    fs.mkdirSync(dataPath(), { recursive: true })
    fs.appendFileSync(f, JSON.stringify(rec) + '\n')
    return rec
  } catch {
    return null // 记录失败绝不影响她社交本身
  }
}

/** 读流水：{days|since, kind, onlySpeak, excludeOwner} */
export function read({ days = 1, since = 0, kind = '', onlySpeak = false, excludeOwner = false, cfg = {} } = {}) {
  const from = since || (days > 0 ? Date.now() - days * 86400_000 : 0)
  const out = []
  let raw = ''
  try { raw = fs.readFileSync(LOG_FILE(), 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (Number(new Date(r.ts).getTime()) < from) continue
      if (kind && r.kind !== kind && r.label !== kind) continue
      if (onlySpeak && !r.speak) continue
      if (excludeOwner && r.toOwner) continue
      if (r.toOwner === undefined) r.toOwner = mentionsOwner(r, cfg)
      out.push(r)
    } catch {}
  }
  return out
}

/** 按天 × 类型的计数（给摘要用）。 */
export function stats(recs = []) {
  const byDay = new Map()
  for (const r of recs) {
    const d = byDay.get(r.day) || { day: r.day, total: 0, kinds: {}, toOwner: 0, seenByOwner: 0 }
    d.total++
    d.kinds[r.label] = (d.kinds[r.label] || 0) + 1
    if (r.toOwner) d.toOwner++
    else d.seenByOwner++
    byDay.set(r.day, d)
  }
  return [...byDay.values()].sort((a, b) => String(b.day).localeCompare(String(a.day)))
}

/** 一行计数：评论3 · 回评2 · 点赞5 */
export function countLine(d) {
  return Object.entries(d?.kinds || {}).map(([k, v]) => `${k}${v}`).join(' · ') || '（没有）'
}

/**
 * 给主人看的摘要（推 QQ 用）：重点是「没 @ 你的那些」。
 * @param {Array} recs
 * @param {{title?:string, limit?:number}} o
 */
export function digestText(recs = [], o = {}) {
  const limit = o.limit ?? 12
  const days = stats(recs)
  if (!days.length) return ''
  const lines = []
  for (const d of days.slice(0, 3)) {
    lines.push(`${d.day}：${d.total} 条 —— ${countLine(d)}` + (d.toOwner ? `（其中 ${d.toOwner} 条 @ 你）` : ''))
  }
  const invisible = recs.filter((r) => !r.toOwner).slice(-limit).reverse()
  if (invisible.length) {
    lines.push('', '你没看到的那部分：')
    for (const r of invisible) {
      const where = r.title ? `《${String(r.title).slice(0, 18)}》` : (r.bvid || '')
      const who = r.to ? `→${String(r.to).slice(0, 14)}：` : '：'
      lines.push(`· ${String(r.ts).slice(11, 16)} ${r.label} ${where}${who}${String(r.text).slice(0, 60)}`)
    }
  }
  return lines.join('\n')
}

/** 完整 Markdown（存文件 / 面板看）。 */
export function markdown(recs = [], o = {}) {
  const days = stats(recs)
  const head = [`# 大肥鱼 · B站社交流水 ${o.title || ''}`.trim(), '']
  if (!days.length) return head.concat(['（这段时间她没在 B站 动过）']).join('\n')
  head.push(`共 ${recs.length} 条 · ${days.length} 天 · 没 @ 主人的 ${recs.filter((r) => !r.toOwner).length} 条`)
  head.push('')
  for (const d of days) {
    head.push(`## ${d.day}（${countLine(d)}）`)
    head.push('')
    const rows = recs.filter((r) => r.day === d.day).sort((a, b) => Number(new Date(b.ts)) - Number(new Date(a.ts)))
    head.push('| 时间 | 做了什么 | 在哪 | 说了什么 | @主人 |')
    head.push('|---|---|---|---|---|')
    for (const r of rows) {
      const where = r.bvid
        ? `[《${String(r.title || r.bvid).slice(0, 20)}》](https://www.bilibili.com/video/${r.bvid})`
        : (r.title || '—')
      const said = String(r.text || '').replace(/\|/g, '\\|').slice(0, 120)
      head.push(`| ${String(r.ts).slice(11, 16)} | ${r.label}${r.to ? ` → ${String(r.to).slice(0, 14)}` : ''} | ${where} | ${said || '—'} | ${r.toOwner ? '✓' : ''} |`)
    }
    head.push('')
  }
  return head.join('\n')
}

/** 落一份 Markdown 到 ~/.feiyu-ai/bili-social-<day>.md */
export function writeMarkdown(recs = [], day = new Date().toLocaleDateString('sv-SE')) {
  const f = dataPath(`bili-social-${day}.md`)
  fs.mkdirSync(dataPath(), { recursive: true })
  fs.writeFileSync(f, markdown(recs, { title: day }))
  return f
}

// ── 补录历史：bili-outbox.md 是老的散文台账，里面有几天的真事 ────────────────
/**
 * 把 bili-outbox.md 里已有的发言灌进 JSONL（主人第一次打开就能看到前几天的）。
 * 行格式：`- 20:29 **分享评论** [《标题》](链接)：正文` / `- 20:17 **回评** […] →回应「人：…」：正文`
 * 幂等：同一天同一时刻同一段正文已在流水里就跳过。
 */
export function backfillFromOutbox(file = dataPath('bili-outbox.md')) {
  const KIND_MAP = { 评论: 'comment', 分享评论: 'share', 回评: 'reply', 弹幕: 'danmaku', 动态: 'dynamic', 图片评论: 'imgComment' }
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return 0 }
  const have = new Set(read({ days: 0 }).map((r) => `${String(r.ts).slice(0, 16)}|${r.text.slice(0, 60)}`))
  let day = ''
  let n = 0
  const out = []
  for (const line of raw.split('\n')) {
    const dh = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/)
    if (dh) { day = dh[1]; continue }
    const m = line.match(/^-\s+(\d{2}:\d{2})\s+\*\*(.+?)\*\*\s*(.*)$/)
    if (!m || !day) continue
    const [, time, kindLabel, rest] = m
    const link = rest.match(/\[《(.*?)》\]\((https?:\/\/[^)]+)\)/) || rest.match(/\[(.*?)\]\((https?:\/\/[^)]+)\)/)
    const bvid = link ? (String(link[2]).match(/BV[0-9A-Za-z]{10}/)?.[0] || '') : ''
    const title = link ? String(link[1]).replace(/^《|》$/g, '') : ''
    const toM = rest.match(/→回应「(.+?)」/)
    const to = toM ? toM[1] : ''
    // 正文 = 最后一个「：」之后（"→回应「…」：" 和 "《…》：" 都在前面）
    const idx = rest.lastIndexOf('：')
    const text = idx >= 0 ? rest.slice(idx + 1).trim() : rest.trim()
    if (!text) continue
    const ts = `${day}T${time}:00.000Z`
    const key = `${ts.slice(0, 16)}|${text.slice(0, 60)}`
    if (have.has(key)) continue
    have.add(key)
    out.push({
      ts, day, kind: KIND_MAP[kindLabel] || 'comment', label: kindLabel,
      speak: true, bvid, title, to, text: text.slice(0, 400), extra: '',
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : (link ? link[2] : ''),
      toOwner: /(@|＠)\s*主人/.test(`${to} ${text}`),
      backfilled: true,
    })
    n++
  }
  if (out.length) {
    const f = LOG_FILE()
    fs.mkdirSync(dataPath(), { recursive: true })
    fs.appendFileSync(f, out.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return n
}