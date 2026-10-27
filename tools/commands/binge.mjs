// binge —— 她真的"看完一集"的能力（10-27 主人要求："给她能完成这件事的能力和权限"）
//
// 背景：她说"这就去看《可塑性记忆》"说了 7 次、看了 0 次。不是记性差，是**没有这个动作**：
//   · watch 只能读抖音热评（watch.mjs 头注释写死了"画面/音频理解属于下一阶段"）
//   · bili-watch 是"刷一轮 feed 顺手评论"，不能指定某部番、也不保存看过的剧情
// 所以这里给她一条真路：
//   ① 搜：`binge --search 可塑性记忆` → 候选（bvid/标题/时长/UP/播放）
//   ② 看：`binge --bvid BVxxx` 或 `binge --show 可塑性记忆 --ep 2`
//        → debrief 四路材料（元信息 + 官方字幕 + 热评 + 简介）
//        → LLM 只根据**材料**写"这一集讲了什么 + 我的感受"（没字幕就照实说没看成）
//   ③ 记账：`~/.feiyu-ai/binge/<slug>.json` 存进度（第几集/到哪儿了），`binge --list` 能看
//   ④ 落记忆：记住"我看完了第 X 集，剧情是…"，下次主人问起她真能答
//   ⑤ 结承诺：`--promise p1abc` 传进来 → 成功 done / 失败 fail（写明为什么）
//
//   node feiyu.mjs binge --search "可塑性记忆"
//   node feiyu.mjs binge --show 可塑性记忆 --ep 1 [--go]
//   node feiyu.mjs binge --bvid BV1xx [--go] --promise p1abc
//   node feiyu.mjs binge --list
import fs from 'node:fs'
import path from 'node:path'
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import * as memory from '../lib/memory.mjs'
import * as promises from '../lib/promises.mjs'

const DIR = dataPath('binge')
const arg = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}
const slug = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
const fileOf = (name) => path.join(DIR, slug(name) + '.json')

function load(name) {
  try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf8')) } catch { return null }
}
function save(name, obj) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(fileOf(name), JSON.stringify(obj, null, 1) + '\n')
  } catch {}
}

/**
 * 弹幕（第三路材料）。
 * 为什么必须有：番剧投稿的字幕轨**经常是片尾曲歌词**（实测《可塑性记忆》01 的 40 段全是 ED 歌词），
 * 光靠它写出来的"剧情"是假的。弹幕是观众当场打的，谁死了、谁哭了、第几分钟反转都有人喊 ——
 * 按弹幕还原剧情比她硬编靠谱得多（prompt 里会声明"这是弹幕，不是官方字幕"）。
 */
async function fetchDanmaku(cid, H) {
  try {
    const zlib = await import('node:zlib')
    const r = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
      headers: { 'user-agent': H['user-agent'], referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) return []
    const buf = Buffer.from(await r.arrayBuffer())
    let xml = ''
    try { xml = zlib.inflateRawSync(buf).toString('utf8') } catch { xml = buf.toString('utf8') }
    const out = []
    const re = /<d p="[^"]*">([\s\S]*?)<\/d>/g
    let m
    while ((m = re.exec(xml))) {
      const t = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
      // 刷屏弹幕（打卡/前排/时间）对"这集讲了什么"零信息量，先掐掉
      if (!t || t.length < 4) continue
      if (/^(前[方排]|打卡|第一|来了|签到|空降|哈哈+|awsl|1+|啊+|哦+|？+|\?+)$/i.test(t)) continue
      out.push(t)
    }
    // 去重（弹幕大量重复），保留信息量大的（长一点、字不重复）
    const uniq = [...new Set(out)]
    uniq.sort((a, b) => b.length - a.length)
    return uniq.slice(0, 160)
  } catch { return [] }
}

/** ① 搜番/剧：只认"能点开看"的普通投稿（番剧 PGC 走不了字幕接口）。 */
async function search(keyword) {
  const cred = loadCred()
  const H = makeHeaders(cred)
  const u = new URL('https://api.bilibili.com/x/web-interface/search/type')
  u.searchParams.set('search_type', 'video')
  u.searchParams.set('keyword', keyword)
  u.searchParams.set('page', '1')
  const j = await apiGet(u.href, H, { soft: true })
  const list = (j?.data?.result ?? []).filter((x) => x.bvid)
  return list.slice(0, 10).map((x) => ({
    bvid: x.bvid,
    title: String(x.title ?? '').replace(/<[^>]+>/g, ''),
    author: x.author ?? '',
    duration: x.duration ?? '',
    play: x.play ?? 0,
    pages: x.videos ?? 1,
  }))
}

/** ② 看一集：四路材料 → 只根据材料写观后感。 */
async function watchOne(bvid, opt = {}) {
  const cred = loadCred()
  const H = makeHeaders(cred)
  const v = new URL('https://api.bilibili.com/x/web-interface/view')
  v.searchParams.set('bvid', bvid)
  const view = await apiGet(v.href, H)
  if (Number(view?.code) !== 0 || !view?.data) return { ok: false, why: view?.message || '元信息读不到' }
  const d = view.data
  const pages = Array.isArray(d.pages) ? d.pages : []
  const ep = Math.max(1, Number(opt.ep) || 1)
  // 分 P 合集：第 1 集直接用 P1（"正片"）；第 2 集往后先按分 P 标题对"第 N 集/0N"，对不上再退回 pages[ep-1]
  const epRe = new RegExp(`(?:^|[^0-9])(?:0?${ep}|第\\s*${ep}\\s*[集话])(?:[^0-9]|$)`)
  const byTitle = ep > 1 ? pages.findIndex((p) => epRe.test(String(p?.part ?? ''))) : -1
  const page = pages[byTitle >= 0 ? byTitle : ep - 1] || pages[0] || null
  const cid = page?.cid ?? d.cid
  const part = page?.part || ''

  // 字幕（player/v2）：人审中文轨优先，其次 AI 轨
  let subs = []
  let subLang = ''
  try {
    const p = new URL('https://api.bilibili.com/x/player/v2')
    p.searchParams.set('bvid', bvid)
    p.searchParams.set('cid', String(cid))
    const player = await apiGet(p.href, H, { soft: true })
    const tracks = player?.data?.subtitle?.subtitles ?? []
    const isAi = (s) => /^ai[-_]/i.test(String(s.lan ?? ''))
    const pick = tracks.filter((s) => /zh/i.test(String(s.lan ?? '')) && !isAi(s))[0]
      || tracks.find((s) => /ai-zh/i.test(String(s.lan ?? '')))
      || tracks.find((s) => /zh/i.test(String(s.lan ?? '')))
      || tracks[0]
    if (pick) {
      subLang = pick.lan
      let su = String(pick.subtitle_url ?? '')
      if (su.startsWith('//')) su = 'https:' + su
      const r = await fetch(su, {
        headers: { 'user-agent': H['user-agent'], referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(20000),
      })
      const jj = await r.json()
      subs = (jj?.body ?? []).map((x) => String(x.content ?? '').trim()).filter(Boolean)
    }
  } catch { /* 字幕是可选路 */ }

  const hot = []
  try {
    const r = new URL('https://api.bilibili.com/x/v2/reply')
    r.searchParams.set('type', '1'); r.searchParams.set('oid', String(d.aid))
    r.searchParams.set('sort', '2'); r.searchParams.set('ps', '5')
    const jr = await apiGet(r.href, H, { soft: true })
    for (const c of (jr?.data?.replies ?? []).slice(0, 5)) hot.push({ name: c.member?.uname ?? '', text: String(c.content?.message ?? '').slice(0, 120) })
  } catch {}

  const material = subs.length
    ? subs.slice(0, 240).join('\n')
    : ''
  const danmaku = await fetchDanmaku(cid, H)

  // 弹幕够多的时候**不用字幕轨**：番剧投稿的字幕轨串片率极高（实测本片字幕是"iPhone16 钢化膜测评"），
// 拿它当剧情来源等于让她编。弹幕是观众当场打在现场的，反而最贴这一集。
  const useSubs = Boolean(material) && danmaku.length < 40

  // ③ 只根据材料写观后感（没有材料就承认没看懂 —— 绝不编剧情）
  let take = { plot: '', feel: '', via: subs.length ? '字幕轨' : '只有简介和热评', understood: false }
  try {
    const { chat } = await import('../lib/llm.mjs')
    const persona = await import('../lib/persona.mjs')
    const base = persona.buildMessages({ platform: 'qq', userText: '', chatId: 'qq:binge', turnsToday: 0 })
    const msgs = [
      base[0],
      {
        role: 'user',
        content: `你刚在看《${d.title}》${part ? ' · ' + part : ''}（第 ${ep} 集${pages.length ? ' / 共 ' + pages.length + ' 集' : ''}）。`
          + `\n\n【简介】${String(d.desc ?? '').slice(0, 300)}`
          + (useSubs
            ? `\n\n【字幕轨节选 · 轨 ${subLang || '?'}】（⚠️ 番剧投稿的字幕轨经常串片或只是片尾曲歌词；对不上就忽略它）\n${material.slice(0, 3000)}`
            : (subs.length ? '\n\n（有字幕轨，但内容跟本片对不上，已忽略）' : '\n\n（这条没有字幕轨）'))
          + (danmaku.length ? `\n\n【弹幕 · 观众当场打的，主要材料】\n${danmaku.slice(0, 120).join(' / ').slice(0, 3800)}` : '')
          + (hot.length ? `\n\n【热评】${hot.map((x) => x.text).slice(0, 4).join(' / ')}` : '')
          + '\n\n只根据上面这些写，输出 JSON：'
          + '{"understood":true|false,"plot":"这一集讲了什么（60~140字，只能用材料里出现过的人名/事件）；看不出来就 understood=false 且 plot 写「这条看不到剧情」",'
          + '"feel":"你自己的感受（30~60字，第一人称，像看完一集随口跟人说）"}',
      },
    ]
    const resp = await chat(msgs, { temperature: 0.85, max_tokens: 600 })
    const m = String(resp ?? '').match(/\{[\s\S]*\}/)
    if (m) {
      const j = JSON.parse(m[0])
      take = {
        plot: String(j.plot || '').trim(),
        feel: String(j.feel || '').trim(),
        understood: j.understood !== false && !/看不到剧情/.test(String(j.plot || '')),
        via: [useSubs ? '字幕轨' : '', danmaku.length ? `弹幕${danmaku.length}条` : '', hot.length ? '热评' : ''].filter(Boolean).join('+') || '只有简介',
      }
    }
  } catch (e) {
    take = { plot: '', feel: '', via: 'LLM 失败：' + e.message, understood: false }
  }

  const watched = take.understood === true && Boolean(take.plot) && !/看不到剧情/.test(take.plot)
  const rec = { bvid, ep, title: d.title, part, cid, total: pages.length || 1, at: Date.now(), subs: subs.length, via: take.via, plot: take.plot, feel: take.feel, ok: watched }

  // ④ 记账 + 落记忆（只有 --go 才落 —— 干跑不该污染记忆，这是全项目的铁律）
  const name = opt.show || d.title
  if (!opt.go) {
    return { ok: watched, ...rec, show: name, total: pages.length || 1, seen: 0, dry: true }
  }
  const book = load(name) || { show: name, seen: [], log: [] }
  book.total = Math.max(Number(book.total || 0), pages.length || 1)
  book.log.push(rec)
  if (watched && !book.seen.includes(ep)) book.seen.push(ep)
  save(name, book)

  if (watched) {
    memory.remember('bilibili', `binge:${slug(name)}`, 'me', 'assistant',
      `看完了《${d.title}》第 ${ep} 集${part ? '（' + part + '）' : ''}：${rec.plot}${rec.feel ? ' 感受：' + rec.feel : ''}`)
  }

  // ⑤ 承诺结清
  if (opt.promise) {
    if (watched) promises.done(opt.promise, `看完了《${d.title}》第 ${ep} 集`)
    else promises.fail(opt.promise, `《${d.title}》这条没有字幕轨，只看得到简介`)
  }

  return { ok: watched, ...rec, show: name, total: book.total, seen: book.seen.length }
}

/** 今天已经看了几集（按 binge/*.json 里今天的记录数算）。 */
function dailyUsed() {
  const today = new Date().toLocaleDateString('sv-SE')
  let n = 0
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
      for (const r of j.log ?? []) if (new Date(Number(r.at)).toLocaleDateString('sv-SE') === today && r.ok) n++
    }
  } catch {}
  return n
}

export async function run(argv = []) {
  if (argv.includes('--list')) {
    const out = []
    try {
      for (const f of fs.readdirSync(DIR)) {
        if (!f.endsWith('.json')) continue
        const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
        out.push({ 剧: j.show, 看过: `${j.seen?.length ?? 0}/${j.total ?? '?'} 集`, 最近: j.log?.at?.(-1)?.at ? new Date(j.log.at(-1).at).toLocaleString('zh-CN', { hour12: false }) : '' })
      }
    } catch {}
    if (!out.length) { console.log('（还没看过任何一部 —— node feiyu.mjs binge --search "番名" 开始）'); return }
    for (const r of out) console.log(`  ${r.剧}　看过 ${r.看过}　最近 ${r.最近}`)
    return
  }

  const keyword = arg(argv, '--search')
  if (keyword) {
    const list = await search(keyword)
    if (!list.length) { console.log(`✗ 搜不到「${keyword}」（B站搜索可能吃风控，等几分钟再试）`); process.exit(1) }
    console.log(`「${keyword}」的候选（${list.length} 条）：`)
    for (const x of list) console.log(`  ${x.bvid}  ${x.title.slice(0, 44)}  ${x.author}  ${x.duration}  播放${x.play}${x.pages > 1 ? '  共' + x.pages + 'P' : ''}`)
    console.log('\n挑一条真的看：node feiyu.mjs binge --bvid <bvid> [--ep 1] --go')
    return
  }

  let bvid = arg(argv, '--bvid')
  const show = arg(argv, '--show')
  let ep = Number(arg(argv, '--ep') || 1)
  if (!bvid && show) {
    const list = await search(show)
    if (!list.length) { console.log(`✗ 搜不到「${show}」`); process.exit(1) }
    // 挑哪一条（同一套规则按目标集数算一遍，所以写成函数）：
    //   第 1 集：标题写着 01/第1集/EP01 → 重加分；时长像单集（15~40 分）再加分。
    //   第 N 集：只有"整部合集"（时长 >40 分且分 P ≥ N）才真能跳到那一集；
    //            单集投稿哪怕标题写着 #14，也不是"第 2 集"。
    const mins = (s) => { const p = String(s).split(':').map(Number); return p.length === 2 ? p[0] : (p.length === 3 ? p[0] * 60 + p[1] : 0) }
    const epTagFor = (n) => new RegExp(`(?:^|[^0-9])(?:0?${n}|第[一${'一二三四五六七八九十'[n - 1] || n}]集|第${n}话|EP\\.?0?${n})(?:[^0-9]|$)`, 'i')
    const choose = (n) => {
      const tag = epTagFor(n)
      const score = (x) => {
        const m = mins(x.duration)
        if (n > 1) return (m > 40 && Number(x.pages) >= n ? 4 : 1) + (tag.test(String(x.title)) ? 1 : 0)
        const dur = m >= 15 && m <= 40 ? 2 : (m > 40 ? 0 : (m < 5 ? -2 : 1))
        return dur + (tag.test(String(x.title)) ? 3 : 0)
      }
      const ranked = list.slice().sort((a, b) => score(b) - score(a) || Math.abs(mins(a.duration) - 24) - Math.abs(mins(b.duration) - 24))
      const exact = n > 1 ? ranked.find((x) => tag.test(String(x.title))) : null
      return { pick: exact || ranked[0], tag }
    }
    let { pick } = choose(ep)
    if (ep > 1 && Number(pick.pages) < ep) {
      // 没有能跳集的分 P 合集，也没有标题写着第 N 集的单集 → 老实退回第 1 集
      console.log(`（搜到的这些都凑不出第 ${ep} 集 —— 改成看第 1 集；想指定就 --bvid）`)
      ep = 1
      pick = choose(1).pick
    }
    bvid = pick.bvid
    console.log(`→ 选了 ${bvid}　${pick.title.slice(0, 50)}（${pick.duration}${pick.pages > 1 ? '，' + pick.pages + 'P' : ''}）`)
  }
  if (!bvid) {
    console.error('用法：binge --search "番名" | --show "番名" [--ep N] | --bvid BVxxx [--ep N] [--promise id] [--go]', 
      '| --list')
    process.exit(2)
  }

  const go = argv.includes('--go')
  // 日上限（默认 1 集）：一天一集是"真看"，一天十集是"刷数据"。她承诺的是前者。
  const cap = Number(config().binge?.dailyMax ?? 1)
  if (go && !argv.includes('--force') && cap > 0 && dailyUsed() >= cap) {
    console.log(`（今天已经看过 ${dailyUsed()} 集了，上限 ${cap} 集 —— 明天再看；真想接着看就加 --force）`)
    return
  }
  const r = await watchOne(bvid, { ep, go, show, promise: arg(argv, '--promise') })
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else if (r.ok) {
    console.log(`📺 《${r.title}》第 ${r.ep}/${r.total} 集${r.part ? '（' + r.part + '）' : ''}　材料：${r.via}（字幕 ${r.subs} 段）`)
    console.log(`【剧情】${r.plot}`)
    if (r.feel) console.log(`【我】${r.feel}`)
    if (!r.dry) console.log(`（看过 ${r.seen}/${r.total} 集，进度存在 ~/.feiyu-ai/binge/）`)
  } else {
    console.log(`✗ 没真看上：${r.via}｜${r.plot || '没有可用的剧情材料'}`)
    console.log('（照实说"这条我看不到内容"，别编 —— 这是设计允许的结果）')
  }
  if (!go) console.log('（干跑：--go 才记账/写记忆/结清承诺）')
}

