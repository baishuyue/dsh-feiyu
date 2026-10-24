// feed —— 选题：从热门 + 关键词搜索里筛一批候选。
// 权重思路来自 bili-whale：偏好命中 + 弹幕密度，**不看播放量**（冷门但对的也可以看）。
//
//   node feiyu.mjs feed [--n 5] [--json]
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'
import * as memory from '../lib/memory.mjs'

export async function run(argv = []) {
  const cfg = config()
  const json = argv.includes('--json')
  const nIdx = argv.indexOf('--n')
  const n = Math.min(20, Math.max(1, nIdx >= 0 ? Number(argv[nIdx + 1]) || cfg.night.maxVideos : cfg.night.maxVideos))

  const cred = loadCred()
  const H = makeHeaders(cred)

  const candidates = new Map()   // bvid -> item

  // ① 热门榜（一页 20 条，不用 WBI）
  const popular = await apiGet('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', H)
  for (const v of popular?.data?.list ?? []) {
    if (v?.bvid) candidates.set(v.bvid, {
      bvid: v.bvid, aid: v.aid, title: v.title?.replace(/<[^>]+>/g, '') ?? '',
      owner: v.owner?.name ?? '', desc: (v.desc ?? '').replace(/<[^>]+>/g, ''), play: v.stat?.view ?? 0, danmaku: v.stat?.danmaku ?? 0,
      duration: v.duration ?? 0, source: 'popular',
    })
  }

  // ② 关键词搜索（有 keywords 才查；要 WBI 签名，bili-api 已处理）
  for (const kw of (cfg.preferences?.keywords ?? []).slice(0, 2)) {
    const u = new URL('https://api.bilibili.com/x/web-interface/search/type')
    u.searchParams.set('search_type', 'video')
    u.searchParams.set('keyword', String(kw))
    u.searchParams.set('page', '1')
    const res = await apiGet(u.href, { ...H, referer: 'https://search.bilibili.com/' })
    for (const v of res?.data?.result ?? []) {
      if (v?.bvid && !candidates.has(v.bvid)) {
        const f = (v.description ?? '').replace(/<[^>]+>/g, '')
        candidates.set(v.bvid, {
          bvid: v.bvid, aid: v.aid, title: (v.title ?? '').replace(/<[^>]+>/g, '') || f.slice(0, 40),
          owner: v.author ?? '', desc: f, play: v.play ?? 0, danmaku: v.video_review ?? 0,
          duration: v.duration ?? 0, source: `search:${kw}`,
        })
      }
    }
  }

  // ③ 打分：偏好命中加权；dislike 命中剔除；弹幕密度做次级信号；
  //    兴趣加权 —— 她在 lore 里养成的口味（"想再看美食"这类记忆）反哺选题，
  //    静态 preferences 是主人给的起点，口味由她自己长（进化闭环）。
  const like = cfg.preferences?.like ?? []
  const dislike = cfg.preferences?.dislike ?? []
  const grams = memory.interestGrams()
  const out = []
  for (const it of candidates.values()) {
    const hay = (it.title + ' ' + it.owner + ' ' + (it.desc ?? '')).toLowerCase()
    if (dislike.some(w => hay.includes(String(w).toLowerCase()))) continue
    let hit = 0
    const why = []
    for (const w of like) {
      if (hay.includes(String(w).toLowerCase())) { hit += 2; why.push(w) }
    }
    const iHit = grams.size ? memory.interestScore(hay, grams) : 0
    if (iHit >= 3) { hit += Math.min(iHit, 6); why.push(`她养成的兴趣(${iHit})`) }
    const density = Number(it.play) > 0 ? it.danmaku / it.play : 0   // 弹幕密度：互动质量信号
    out.push({ ...it, hit, density: Number(density.toFixed(4)), why: why.join('、') || '无偏好命中（靠密度入选）' })
  }
  out.sort((a, b) => b.hit - a.hit || b.density - a.density)
  const picked = out.slice(0, n)

  if (json) { console.log(JSON.stringify({ ok: true, n: picked.length, items: picked }, null, 2)); return }

  if (!picked.length) { console.log('（没筛出候选 —— 试试在 preferences.keywords 里加几个搜索词）'); return }
  console.log(`筛出 ${picked.length} 条（偏好命中在前，同分按弹幕密度）：\n`)
  for (const [i, v] of picked.entries()) {
    console.log(`${i + 1}. ${v.title}`)
    console.log(`   UP：${v.owner} · 播放 ${v.play} · 弹幕 ${v.danmaku} · ${Math.round(v.duration / 60)} 分钟 · 来源 ${v.source}`)
    console.log(`   偏好：${v.why}`)
    console.log(`   BV：${v.bvid}\n`)
  }
  console.log('下一步：挑 2–3 条深读 —— node feiyu.mjs debrief --bvid <BV>')
}
