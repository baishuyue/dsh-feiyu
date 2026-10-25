// comment —— 发评论：唯一的公开写通道。
// 链路：凭据 → 分享标尺（--share）→ 风控闸门（guard）→ 额度闸（quota）→ POST → 记账。
// 撞到风控码（-352/-799/10031/12015/12051）→ 明确停手提示，别连发 ✗
//
//   node feiyu.mjs comment --bvid BV1xx --message "…" [--root rpid --parent rpid] [--go]
//   node feiyu.mjs comment --share --bvid BV1xx --message "…" --reason "至少八字" --score 15 --rank 1 [--go]
//   不带 --go = 干跑：全链路检查但只打印要发什么，不 POST ✓
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred, missingForWrite, looksLikeJct, explainCode, HARD_STOP_CODES } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'
import { validateShare } from '../lib/share-policy.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import { sanitizeFor, loadBiliFaces } from '../lib/stickers.mjs'

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
  }

  // 真 @ 主人只在分享评论（--share）时带：日常评论不 @（存活率优先，10-25 用户拍板——
  // 每条都 @ 又是软删除重灾区，且 @ 通知走 QQ 推送兜底）
  const ownerName = cfg.owner?.name
  const ownerMid = cfg.owner?.mid
  if (isShare && ownerName && ownerMid && !message.startsWith('@')) message = `@${ownerName} ${message}`

  // ③ 内容清洗（预览和真发都要）
  message = guard.clean(message, cfg)
  // 评论区发不了图片：剥掉 [表情:x]，只留文字 + 颜文字 + B站自带表情码（[大笑]/[doge]）
  const faces = await loadBiliFaces()   // 447 个官方表情码，缓存 24h
  message = sanitizeFor('bilibili', message, faces)
  if (!message) { console.error('✗ 清洗后内容为空'); process.exit(1) }
  const chatId = `bilibili:${bvid}`

  const H = makeHeaders(cred)
  const { aid, title } = await bvidToAid(bvid, H)

  // ④ 预览（不带 --go）：只打印，不查风控、不占额度、不真发
  if (!go) {
    console.log('【干跑预览 ✓】以下内容未发送（加 --go 真发）：')
    console.log(`  视频：《${title}》(${bvid}, aid=${aid})`)
    console.log(`  ${root ? `回复 rpid=${root} ` : ''}内容：${message}`)
    if (cfg.guard?.dryRun) console.log('  （提示：guard.dryRun=true，即使 --go 也不会真发）')
    return
  }

  // ⑤ 真发前闸门 1：DRY_RUN 总开关（只拦 --go 真发，不拦预览）
  if (cfg.guard?.dryRun) {
    console.log('【DRY_RUN 拦截】未发送（把 feiyu.config.json 的 guard.dryRun 改 false 才真发）')
    console.log(`  视频：《${title}》(${bvid})`)
    console.log(`  本要发送：${message}`)
    return
  }

  // ⑥ 真发前闸门 2：间隔 + 复读（跳过 dryRun 检查，上面已单独拦）
  const verdict = guard.allow(chatId, message, cfg, { checkDryRun: false })
  if (!verdict.ok) { console.error(`✗ 被风控闸门拦下：${verdict.why}`); process.exit(1) }

  // ⑦ 额度闸（分享才占额度，真发才查）
  if (isShare) {
    const quota = await import('./quota.mjs')
    try { quota.run(['check', '--type', 'share', '--target', bvid]) } catch { process.exit(1) }
  }

  // ⑤ 真发（POST /x/v2/reply/add，form 编码，csrf=bili_jct）
  const body = new URLSearchParams({ type: '1', oid: String(aid), message, plat: '1', csrf: cred.bili_jct })
  if (root) body.set('root', root)
  if (parent) body.set('parent', parent)
  // ⑤ 真 @：at_name_to_mid 携带 昵称→mid 映射（不带 @ 的昵称作为 key）
  if (ownerName && ownerMid) body.set('at_name_to_mid', JSON.stringify({ [ownerName]: ownerMid }))
  // 防呆：凭据若是主人自己的号，@ 主人 = 自己 @ 自己，B站不会发通知（10-24 实锤）。
  // 不拦发送（QQ 推送会兜底通知），但必须喊出来让主人知道该换鱼的凭据。
  try {
    const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', H)
    if (String(nav?.data?.mid ?? '') === String(ownerMid)) {
      console.error(`⚠️ 当前凭据是主人自己的号（${nav.data.uname}）：这条评论会以主人身份发出、@ 不会弹任何通知。`)
      console.error('   请在浏览器登录鱼的号（御坂美琴Rosie）后重新提交凭据 —— 面板「凭据」或 POST /api/cookie。')
    }
  } catch { /* nav 挂了不拦发送 */ }
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

  // ⑥ 成功：三本账一起记（guard 输出流水 / quota 额度 / memory 情节）+ 发言台账
  guard.commit(chatId, message)
  const quota = await import('./quota.mjs')
  quota.run(['record', '--type', isShare ? 'share' : 'reply', '--target', bvid, '--note', title.slice(0, 30)])
  memory.remember('bilibili', chatId, cfg.identity?.name ?? 'feiyu', 'assistant', message)
  try { const { recordBili } = await import('../lib/outbox.mjs'); recordBili({ kind: isShare ? '分享评论' : (root ? '回评' : '评论'), title, bvid, text: message }) } catch {}
  // 登记 rpid：回评论扫描（replies 命令）靠它找到这条评论下的新回复
  try { const { recordMyComment } = await import('../lib/bili-write.mjs'); recordMyComment(bvid, aid, j?.data?.rpid) } catch {}
  console.log(`✓ 已发送（rpid=${j?.data?.rpid ?? '?'}）${isShare ? ' · 分享额度已扣' : ''}`)
  console.log(`  ${title} → ${message.slice(0, 60)}`)

  // 分享还要让主人真的"收到"：B站凭据是主人自己的账号（鱼没有独立小号），
  // "@主人" 实际是自己的号 @ 自己 —— B站永远不给这种 @ 发通知。
  // 所以真发成功后用 QQ 私信把链接推过去，这才是主人能收到的那条通知。
  if (isShare) {
    try {
      const { sendOwnerQQ } = await import('../lib/notify.mjs')
      const ok = await sendOwnerQQ(`【B站分享】《${title.slice(0, 40)}》\n${message.slice(0, 80)}\nhttps://www.bilibili.com/video/${bvid}`)
      console.log(ok ? '  📨 已推送到主人 QQ（评论区 @ 自己账号不会弹通知）' : '  ⚠️ QQ 推送失败（NapCat 没起？主人可能注意不到这条分享）')
    } catch {}
  }
}
