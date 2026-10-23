// comment —— 发评论：唯一的公开写通道。
// 链路：凭据 → 分享标尺（--share）→ 风控闸门（guard）→ 额度闸（quota）→ POST → 记账。
// 撞到风控码（-352/-799/10031/12015/12051）→ 明确停手提示，别连发 ✗
//
//   node feiyu.mjs comment --bvid BV1xx --message "…" [--root rpid --parent rpid] [--go]
//   node feiyu.mjs comment --share --bvid BV1xx --message "…" --reason "至少八字" --score 15 --rank 1 [--go]
//   不带 --go = 干跑：全链路检查但只打印要发什么，不 POST ✓
import { makeHeaders } from '../lib/bili-api.mjs'
import { loadCred, missingForWrite, looksLikeJct, explainCode, HARD_STOP_CODES } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'
import { validateShare } from '../lib/share-policy.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

async function bvidToAid(bvid, H) {
  const u = new URL('https://api.bilibili.com/x/web-interface/view')
  u.searchParams.set('bvid', bvid)
  const r = await (await import('../lib/bili-api.mjs')).apiGet(u.href, H)
  if (Number(r?.code) !== 0) throw new Error(`读视频元信息失败：${r?.message ?? '未知'}`)
  return { aid: r.data.aid, title: r.data.title }
}

export async function run(argv = []) {
  const cfg = config()
  const bvid = arg(argv, '--bvid')
  let message = arg(argv, '--message')
  const root = arg(argv, '--root')
  const parent = arg(argv, '--parent')
  const isShare = argv.includes('--share')
  const go = argv.includes('--go')

  if (!bvid || !message) {
    console.error('用法：node feiyu.mjs comment --bvid BV1xx --message "…" [--root rpid --parent rpid] [--share --reason … --score … --rank 1] [--go]')
    process.exit(2)
  }

  // ① 凭据
  const cred = loadCred()
  const miss = missingForWrite(cred)
  if (miss.length) { console.error(`✗ 缺凭据：${miss.join('、')}`); process.exit(1) }
  if (!looksLikeJct(cred.bili_jct)) console.warn('⚠️ bili_jct 不是 32 位十六进制 —— 可能复制截断，发大概率 CSRF 失败')

  // ② 分享标尺（只对 --share 收紧：理由 ≥8 字、0–20 分、只允许第一名）
  if (isShare) {
    try {
      validateShare(cfg, { reason: arg(argv, '--reason'), score: arg(argv, '--score'), rank: arg(argv, '--rank') || 1 })
    } catch (e) { console.error('✗ ' + e.message); process.exit(1) }
    // @ 主人前缀（评论区 @ 的正路：正文开头写 @昵称）
    const ownerName = cfg.owner?.name
    if (ownerName && !message.startsWith('@')) message = `@${ownerName} ${message}`
  }

  // ③ 风控闸门（dafeiyu guard：dryRun / 间隔 / 复读）
  const chatId = `bilibili:${bvid}`
  const verdict = guard.allow(chatId, message, cfg)
  if (!verdict.ok) { console.error(`✗ 被风控闸门拦下：${verdict.why}`); process.exit(1) }
  message = guard.clean(message, cfg)
  if (!message) { console.error('✗ 清洗后内容为空'); process.exit(1) }

  // ④ 额度闸（分享才占额度）
  if (isShare) {
    const quota = await import('./quota.mjs')
    try { quota.run(['check', '--type', 'share', '--target', bvid]) } catch { process.exit(1) }
  }

  const H = makeHeaders(cred)
  const { aid, title } = await bvidToAid(bvid, H)

  if (!go) {
    console.log('【干跑 ✓】以下内容未发送（加 --go 真发）：')
    console.log(`  视频：《${title}》(${bvid}, aid=${aid})`)
    console.log(`  ${root ? `回复 rpid=${root} ` : ''}内容：${message}`)
    return
  }

  // ⑤ 真发（POST /x/v2/reply/add，form 编码，csrf=bili_jct）
  const body = new URLSearchParams({ type: '1', oid: String(aid), message, plat: '1', csrf: cred.bili_jct })
  if (root) body.set('root', root)
  if (parent) body.set('parent', parent)
  const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  })
  let j = null
  try { j = await res.json() } catch {}
  if (Number(j?.code) !== 0) {
    console.error(`✗ 发送失败：${explainCode(j?.code)}` + (j?.message ? `（B站原文：${j.message}）` : ''))
    if (HARD_STOP_CODES.has(Number(j?.code))) {
      console.error('⛔ 撞到平台风控 —— **立刻停手**，今天别再发任何东西，等几分钟在浏览器里人工过一次验证。')
    }
    process.exit(1)
  }

  // ⑥ 成功：三本账一起记（guard 输出流水 / quota 额度 / memory 情节）
  guard.commit(chatId, message)
  const quota = await import('./quota.mjs')
  quota.run(['record', '--type', isShare ? 'share' : 'reply', '--target', bvid, '--note', title.slice(0, 30)])
  memory.remember('bilibili', chatId, cfg.identity?.name ?? 'feiyu', 'assistant', message)
  console.log(`✓ 已发送（rpid=${j?.data?.rpid ?? '?'}）${isShare ? ' · 分享额度已扣' : ''}`)
  console.log(`  ${title} → ${message.slice(0, 60)}`)
}
