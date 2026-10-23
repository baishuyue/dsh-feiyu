// debrief —— 真看懂一条：元信息 + 官方字幕 + 热评 + 简介。
// bili-whale 的六路（字幕/弹幕/热评/抽帧/封面/简介）这里先做四路文字路，
// 抽帧（ffmpeg）留给 v0.2 —— 没有直链时绝不伪装成"已看完" ✓
//
//   node feiyu.mjs debrief --bvid BV1xxxx [--json]
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export async function run(argv = []) {
  const bvid = arg(argv, '--bvid')
  const json = argv.includes('--json')
  if (!bvid) { console.error('用法：node feiyu.mjs debrief --bvid BV1xxxx'); process.exit(2) }

  const cred = loadCred()
  const H = makeHeaders(cred)

  // ① 元信息（WBI 签名 + 24h 缓存由 bili-api 处理）
  const viewUrl = new URL('https://api.bilibili.com/x/web-interface/view')
  viewUrl.searchParams.set('bvid', bvid)
  const view = await apiGet(viewUrl.href, H)
  if (Number(view?.code) !== 0 || !view?.data) {
    console.log(json ? JSON.stringify({ ok: false, error: view?.message ?? '元信息读取失败' }) : `✗ 看不了这条：${view?.message ?? '元信息读取失败'}`)
    process.exit(1)
  }
  const d = view.data
  const oid = d.aid

  // ② 字幕（player/v2 → subtitle 列表 → 拉第一条）
  let subtitles = []
  try {
    const purl = new URL('https://api.bilibili.com/x/player/v2')
    purl.searchParams.set('bvid', bvid)
    purl.searchParams.set('cid', String(d.cid))
    const player = await apiGet(purl.href, H)
    const subs = player?.data?.subtitle?.subtitles ?? []
    if (subs.length) {
      let su = String(subs[0].subtitle_url ?? '')
      if (su.startsWith('//')) su = 'https:' + su
      const subRes = await fetch(su, { headers: { 'user-agent': H['user-agent'], referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000) })
      const subJson = await subRes.json()
      subtitles = (subJson?.body ?? []).slice(0, 60).map(x => String(x.content ?? '').trim()).filter(Boolean)
    }
  } catch { /* 字幕是可选路：没有照样能看懂四路里的其余三路 */ }

  // ③ 热评（sort=2 按热度，取前 5）
  let topComments = []
  try {
    const rurl = new URL('https://api.bilibili.com/x/v2/reply')
    rurl.searchParams.set('type', '1')
    rurl.searchParams.set('oid', String(oid))
    rurl.searchParams.set('sort', '2')
    rurl.searchParams.set('ps', '5')
    const replies = await apiGet(rurl.href, H)
    topComments = (replies?.data?.replies ?? []).slice(0, 5).map(r => ({
      name: r.member?.uname ?? '', text: String(r.content?.message ?? '').slice(0, 120), like: r.like ?? 0,
    }))
  } catch { /* 热评也是可选路 */ }

  const pack = {
    ok: true,
    bvid, aid: oid, cid: d.cid,
    title: d.title, owner: d.owner?.name ?? '',
    intro: String(d.desc ?? '').slice(0, 400),
    stat: { view: d.stat?.view, danmaku: d.stat?.danmaku, reply: d.stat?.reply, like: d.stat?.like, coin: d.stat?.coin },
    durationMin: Math.round(d.duration / 60),
    subtitles: subtitles.length ? subtitles.length + ' 段' : null,
    subtitleLines: subtitles.slice(0, 40),
    topComments,
    seenVia: ['元信息', subtitles.length ? '官方字幕' : null, topComments.length ? '热评' : null, '简介'].filter(Boolean),
  }

  if (json) { console.log(JSON.stringify(pack, null, 2)); return }

  // 人读版（喂给会话的就是这份）
  console.log(`# 《${pack.title}》`)
  console.log(`UP：${pack.owner} · ${pack.durationMin} 分钟 · 播放 ${pack.stat.view} · 弹幕 ${pack.stat.danmaku} · 赞 ${pack.stat.like}`)
  console.log(`理解路：${pack.seenVia.join(' + ')}\n`)
  if (pack.intro) console.log(`【简介】${pack.intro}\n`)
  if (pack.subtitleLines?.length) {
    console.log('【字幕节选】')
    for (const l of pack.subtitleLines) console.log('  ' + l)
    console.log('')
  }
  if (pack.topComments?.length) {
    console.log('【热评】')
    for (const c of pack.topComments) console.log(`  ${c.name}（${c.like} 赞）：${c.text}`)
    console.log('')
  }
  console.log('—— 基于以上材料打分（0–20），不足 share.minScore 就是「这条不值得占主人一次注意力」，合法结果 ✓')
}
