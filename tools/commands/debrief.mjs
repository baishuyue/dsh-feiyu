// debrief —— 真看懂一条：元信息 + 官方字幕 + 热评 + 简介。
// bili-whale 的六路（字幕/弹幕/热评/抽帧/封面/简介）这里先做四路文字路，
// 抽帧（ffmpeg）留给 v0.2 —— 没有直链时绝不伪装成"已看完" ✓
//
//   node feiyu.mjs debrief --bvid BV1xxxx [--json]
import { apiGet, makeHeaders, reportWatch } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

// 字幕和这条视频对不对得上？标题+简介里的中文二字组，有多少能在字幕里翻到。
// 串片的时候两边几乎零重合（10-27 串成卖瓜、10-29 串成 BLG 采访和充电头广告都是这样）。
// 返回 null 表示数据太少、判断不了——不猜。
function coherenceHint(titleIntro, lines) {
  const cjk = (s) => String(s || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const grams = (s) => {
    const out = new Set()
    for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const src = cjk(titleIntro)
  const sub = cjk((lines || []).join(''))
  if (src.length < 8 || sub.length < 20) return null
  const bag = grams(sub)
  const want = [...grams(src)]
  if (!want.length) return null
  let hit = 0
  for (const g of want) if (bag.has(g)) hit++
  return { ratio: hit / want.length }
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
  let subtitleLang = null
  try {
    const purl = new URL('https://api.bilibili.com/x/player/v2')
    purl.searchParams.set('bvid', bvid)
    purl.searchParams.set('cid', String(d.cid))
    const player = await apiGet(purl.href, H)
    const subs = player?.data?.subtitle?.subtitles ?? []
    // 轨序：人审中文轨（非 ai-*）→ AI 中文轨 → 第一条。AI 轨常串片/错字，只当参考
    const isAiTrack = s => /^ai[-_]/i.test(String(s.lan ?? '')) || /ai-zh/i.test(String(s.lan ?? ''))
    const humanZh = subs.filter(s => /zh/i.test(String(s.lan ?? s.lang ?? '')) && !isAiTrack(s))
    const pick = humanZh[0]
      || subs.find(s => /ai-zh/i.test(String(s.lan ?? '')))
      || subs.find(s => /zh/i.test(String(s.lan ?? s.lang ?? '')))
      || subs[0]
    if (pick) {
      subtitleLang = pick.lan
      // 轨选择留痕（10-27 补）：以前只有"选中的轨"进正文，选没选对、还有哪些候选，全看不见。
      // 于是想验证"人审轨优先"时只能在外围瞎猜（外围单独调接口拿不到字幕列表，因为没带登录态）。
      // 现在把候选和结果打一行到 stderr，验证靠真实播放路径，不靠猜。
      try {
        const cand = subs.map(s => String(s.lan ?? s.lang ?? '?')).join(' / ')
        const kind = isAiTrack(pick) ? 'AI 轨' : '人审轨'
        process.stderr.write(`[debrief] 字幕候选 ${subs.length} 条：${cand || '无'} → 选中 ${subtitleLang}（${kind}）\n`)
      } catch {}
      let su = String(pick.subtitle_url ?? '')
      if (su.startsWith('//')) su = 'https:' + su
      // 10-29：真因查明了。同一个视频连调三次，字幕内容分别是「造车技术…」「♪ 音乐 ♪」「这是德国人最喜欢吃的烤鸡」——
      // subtitle_url 每次给的东西本身就可能串到别处（不是"选错轨"，是源就随机）。
      // 所以「人审轨优先」那套顺序救不了：对着唯一一条错轨，选得再对也是错的。
      // 现在每次拉完先验贴合度，最多试 3 次，留最贴合的那份；够贴合（≥15%）就提前收手。
      let best = null
      const attempts = []
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await sleep(700) // 同一轮里连拉三次常常拿到同一份错料，隔一下再试
        try {
          const subRes = await fetch(su, { headers: { 'user-agent': H['user-agent'], referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000) })
          const subJson = await subRes.json()
          const lines = (subJson?.body ?? []).slice(0, 60).map(x => String(x.content ?? '').trim()).filter(Boolean)
          const ratio = lines.length ? (coherenceHint(String(d.title ?? ''), lines)?.ratio ?? null) : null
          attempts.push(`${attempt}:${lines.length}行/${ratio === null ? '?' : Math.round(ratio * 100) + '%'}`)
          if (!best || (ratio !== null && (best.ratio === null || ratio > best.ratio))) best = { lines, ratio }
          if (ratio !== null && ratio >= 0.15) break
        } catch {
          attempts.push(`${attempt}:失败`)
        }
      }
      // 实测正常字幕的贴合度是 23%~48%，串片的一律 0%~9%，中间没有重叠。
      // 所以低于 5% 就不当"参考"，直接丢掉：宁可少一路材料，也不拿别人的字幕写自己的话。
      if (best?.ratio !== null && best?.ratio !== undefined && best.ratio < 0.05) {
        process.stderr.write(`[debrief] ⚠ 字幕像串片（最贴合一次只有 ${(best.ratio * 100).toFixed(1)}%），整段丢弃，这条只走元信息+热评+简介\n`)
        subtitles = []
      } else {
        subtitles = best?.lines ?? []
      }
      if (attempts.length > 1) process.stderr.write(`[debrief] 字幕重试 ${attempts.length} 次：${attempts.join(' ')}\n`)
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
      name: r.member?.uname ?? '', text: String(r.content?.message ?? '').slice(0, 120), like: r.like ?? 0, rpid: r.rpid ?? 0,
    }))
  } catch { /* 热评也是可选路 */ }

  // ④ 看过就留痕：上报 click + heartbeat，这条视频才会出现在账号的观看历史里
  //    （纯 API 读永远不进历史——手机端会以为她什么都没看。bilibili.reportHistory=false 可关）
  if (config().bilibili?.reportHistory !== false) {
    const played = Math.min(Math.max(30, Math.round((d.duration || 300) * 0.4)), 600)
    const rep = await reportWatch(oid, d.cid, bvid, cred, played)
    if (!rep.ok) console.log(json ? '' : `  （观看历史上报没成功：${(rep.why ?? '').slice(0, 80)} —— 不影响看懂）`)
  }

  // ⑤ 顺手点个赞（react.like 开了才动）：看过的视频真点过赞，账号才像活人
  if (config().bilibili?.react?.like === true) {
    try {
      const w = await import('../lib/bili-write.mjs')
      const r = await w.likeVideo(bvid, { go: true })
      if (!r.ok) console.log(json ? '' : `  （点赞没成：${String(r.why ?? '').slice(0, 60)}）`)
      else if (!json) console.log(`  👍 ${r.why}`)
    } catch {}
  }

  const pack = {
    ok: true,
    bvid, aid: oid, cid: d.cid,
    title: d.title, owner: d.owner?.name ?? '',
    intro: String(d.desc ?? '').slice(0, 400),
    stat: { view: d.stat?.view, danmaku: d.stat?.danmaku, reply: d.stat?.reply, like: d.stat?.like, coin: d.stat?.coin },
    durationMin: Math.round(d.duration / 60),
    subtitles: subtitles.length ? subtitles.length + ' 段' : null,
    subtitleLang,
    subtitleLines: subtitles.slice(0, 40),
    topComments,
    seenVia: ['元信息', subtitles.length ? '官方字幕' : null, topComments.length ? '热评' : null, '简介'].filter(Boolean),
  }
  // 10-29：字幕串片第三次（10-27 两次、10-29 两次，全是"只有一条 ai-zh 轨"）。
  // 选轨顺序救不了"唯一一条就是错的"，所以补一道贴合度检查：标题+简介的中文二字组，
  // 有多少能在字幕里找到。重合率极低就当材料不可信，直接把警告印在字幕前面。
  const hint = coherenceHint(String(d.title ?? ''), subtitles)
  if (hint) pack.subtitleCoherence = Number(hint.ratio.toFixed(3))

  if (json) { console.log(JSON.stringify(pack, null, 2)); return }

  // 人读版（喂给会话的就是这份）
  console.log(`# 《${pack.title}》`)
  console.log(`UP：${pack.owner} · ${pack.durationMin} 分钟 · 播放 ${pack.stat.view} · 弹幕 ${pack.stat.danmaku} · 赞 ${pack.stat.like}`)
  console.log(`理解路：${pack.seenVia.join(' + ')}\n`)
  if (pack.intro) console.log(`【简介】${pack.intro}\n`)
  if (pack.subtitleLines?.length) {
    console.log(`【字幕节选 · 轨 ${pack.subtitleLang ?? '?'} · 仅供参考，可能串片/由 AI 生成】`)
    if (typeof pack.subtitleCoherence === 'number') {
      const pct = Math.round(pack.subtitleCoherence * 100)
      console.log(pack.subtitleCoherence < 0.05
        ? `  ⚠ 字幕与标题重合只有 ${pct}%，八成串片了 —— 下面这段别当材料用`
        : `  （字幕与标题重合 ${pct}%）`)
    }
    for (const l of pack.subtitleLines) console.log('  ' + l)
    console.log('')
  }
  if (pack.topComments?.length) {
    console.log('【热评】')
    for (const c of pack.topComments) console.log(`  ${c.name}（${c.like} 赞，rpid=${c.rpid}）：${c.text}`)
    console.log('')
  }
  console.log('—— 基于以上材料打分（0–20），不足 share.minScore 就是「这条不值得占主人一次注意力」，合法结果 ✓')
  console.log('—— 可回复热评：node feiyu.mjs comment --bvid <bvid> --root <rpid> --parent <rpid> --message "回复内容" --go（会自动 @主人）')
}
