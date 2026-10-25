// feed —— 选题：从热门 + 关键词搜索里筛一批候选。
// 权重思路来自 bili-whale：偏好命中 + 弹幕密度，**不看播放量**（冷门但对的也可以看）。
//
//   node feiyu.mjs feed [--n 5] [--json]
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import fs from 'node:fs'
import * as memory from '../lib/memory.mjs'

// 偏好词是"话题名"（美食 / 猫咪 / AI 与 Agent 工具），标题和简介里几乎不会原样出现。
// 只做整串 includes = 永远漏（10-23、10-24 连续两天把"康师傅桶面""现钓渔获做餐"判成无命中）。
// 这里把每条偏好拆成：话题名 + 内置同义词 + 主人可在 preferences.synonyms 里追加的词。
const DEFAULT_SYNONYMS = {
  '美食': ['吃', '饭', '好吃', '馋', '菜', '汤', '肉', '烤', '炖', '煮', '炒', '蒸', '锅', '卤', '酱', '馅',
    '泡面', '拉面', '面条', '面粉', '面馆', '米饭', '白饭', '炒饭', '盖饭', '餐', '小吃', '探店', '饭店', '饭馆',
    '做饭', '食谱', '厨房', '厨艺', '料理', '火锅', '烧烤', '肉串', '烤串', '饺子', '包子', '牛肉', '猪肉', '鸡腿',
    '炸鸡', '海鲜', '螃蟹', '蟹黄', '甜品', '奶茶', '零食', '夜宵', '宵夜', '下饭', '口味', '试吃', '大胃王', '烟火气'],
  '猫咪': ['猫', '喵', '小猫', '猫猫', '橘猫', '吸猫', '毛茸茸', 'kitty', 'cat', 'mew'],
  '鬼畜与怀旧': ['鬼畜', '怀旧', '老歌', '童年', '回忆', '经典', '音MAD', '老番', '小时候', '九十年代', '红白机', '港片', '重制'],
  'AI 与 Agent 工具': ['AI', '人工智能', '大模型', '智能体', 'agent', 'gpt', 'claude', 'llm', '提示词', 'prompt',
    '算法', '编程', '代码', '开源', '模型', 'MCP', 'cursor', '自动化'],
}

/** 词命中判断：纯 ASCII 词按词边界匹配（避免 ai 命中 said / wait），中文按子串。 */
function matches(hay, term) {
  if (!term) return false
  if (/^[\x00-\x7f]+$/.test(term)) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(hay)
  }
  return hay.includes(term)
}

/** 一条偏好是否命中；命中返回 { term, weight }（方便在 feed 输出里看清是哪个词中的）。
 *  多字词算强命中（2 分）；单字词（吃/猫/汤…）太容易撞车，只在标题+简介里算 1 分。 */
function matchPreference(hay, hayCore, pref, synonyms = {}) {
  const key = pref.trim()
  const extra = synonyms[key] ?? DEFAULT_SYNONYMS[key] ?? []
  const terms = [...new Set([key, ...extra].map(s => String(s).toLowerCase()).filter(Boolean))]
  for (const t of terms) {
    if (t.length >= 2 && matches(hay, t)) return { term: t, weight: 2 }
  }
  for (const t of terms) {
    if (t.length === 1 && matches(hayCore, t)) return { term: t, weight: 1 }
  }
  return null
}

/** 时长统一成分分钟：热门接口给秒数，搜索接口给 "mm:ss" 字符串。 */
function fmtMinutes(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return Math.round(d / 60)
  const s = String(d ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Math.round(Number(s) / 60)
  const p = s.split(':').map(Number)
  if (p.length === 2 && p.every(Number.isFinite)) return Math.round(p[0] + p[1] / 60)
  if (p.length === 3 && p.every(Number.isFinite)) return Math.round(p[0] * 60 + p[1] + p[2] / 60)
  return 0
}

export async function run(argv = []) {
  const cfg = config()
  const json = argv.includes('--json')
  const nIdx = argv.indexOf('--n')
  const n = Math.min(20, Math.max(1, nIdx >= 0 ? Number(argv[nIdx + 1]) || cfg.night.maxVideos : cfg.night.maxVideos))

  const cred = loadCred()
  const H = makeHeaders(cred)

  const candidates = new Map()   // bvid -> item

  // ① 热门榜（随机翻 1-3 页 —— 固定第一页会让候选很快发完陷入枯竭）
  const pn = 1 + Math.floor(Math.random() * 3)
  const popular = await apiGet(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`, H)
  for (const v of popular?.data?.list ?? []) {
    if (v?.bvid) candidates.set(v.bvid, {
      bvid: v.bvid, aid: v.aid, title: v.title?.replace(/<[^>]+>/g, '') ?? '',
      owner: v.owner?.name ?? '', ownerMid: v.owner?.mid ?? '', desc: (v.desc ?? '').replace(/<[^>]+>/g, ''), play: v.stat?.view ?? 0, danmaku: v.stat?.danmaku ?? 0,
      duration: v.duration ?? 0, source: 'popular',
    })
  }

  // ② 关键词搜索（要 WBI 签名，bili-api 已处理）：
  //    固定 keywords + 每轮随机抽 1-2 个偏好词（like 池轮换）—— 内容源源不断，候选不枯竭
  //    鱼圈社交：fishCircle 开了就把「大肥鱼」也当关键词搜 —— 同类鱼聚集地的视频进候选
  const likePool = (cfg.preferences?.like ?? []).filter(Boolean)
  const randLikes = [...likePool].sort(() => Math.random() - 0.5).slice(0, 2)
  const kws = [...new Set([...(cfg.preferences?.keywords ?? []).slice(0, 2), ...randLikes])]
  if (cfg.bilibili?.fishCircle?.enabled === true) kws.push('大肥鱼')
  for (const kw of kws) {
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
          owner: v.author ?? '', ownerMid: v.mid ?? '', desc: f, play: v.play ?? 0, danmaku: v.video_review ?? 0,
          duration: v.duration ?? 0, source: kw === '大肥鱼' ? 'fish:大肥鱼' : `search:${kw}`,
        })
      }
    }
  }

  // ③ 打分：偏好命中加权；dislike 命中剔除；弹幕密度做次级信号；
  //    兴趣加权 —— 她在 lore 里养成的口味（"想再看美食"这类记忆）反哺选题，
  //    静态 preferences 是主人给的起点，口味由她自己长（进化闭环）。
  const like = cfg.preferences?.like ?? []
  const dislike = cfg.preferences?.dislike ?? []
  const synonyms = cfg.preferences?.synonyms ?? {}   // 主人可以在这里按话题追加自己的词
  const grams = memory.interestGrams()
  const out = []
  for (const it of candidates.values()) {
    const hay = (it.title + ' ' + it.owner + ' ' + (it.desc ?? '')).toLowerCase()
    const hayCore = (it.title + ' ' + (it.desc ?? '')).toLowerCase()
    if (dislike.some(w => matches(hay, String(w).toLowerCase()))) continue
    let hit = 0
    const why = []
    for (const w of like) {
      const m = matchPreference(hay, hayCore, String(w), synonyms)
      if (m) { hit += m.weight; why.push(m.term === w ? w : `${w}（${m.term}）`) }
    }
    const iHit = grams.size ? memory.interestScore(hay, grams) : 0
    if (iHit >= 3) { hit += Math.min(iHit, 6); why.push(`她养成的兴趣(${iHit})`) }
    const density = Number(it.play) > 0 ? it.danmaku / it.play : 0   // 弹幕密度：互动质量信号
    out.push({ ...it, hit, density: Number(density.toFixed(4)), why: why.join('、') || '无偏好命中（靠密度入选）' })
  }
  // 已发过的不再端上来（quota.json 里 sameVideoDays 天内的 BV）——以前 feed 只按偏好排序，
  // 每天把 4/5 的已发视频重新推一遍，白挑一遍到 comment 才被"已发过"拦下（10-25 实测）
  let usable = out
  try {
    const days = Number(config().quota?.sameVideoDays ?? 7)
    if (days > 0) {
      const cutoff = Date.now() - days * 86400_000
      const q = JSON.parse(fs.readFileSync(dataPath('quota.json'), 'utf8'))
      const used = new Set((q.log || []).filter((x) => x.target && new Date(x.at).getTime() >= cutoff).map((x) => x.target))
      if (used.size) {
        const kept = out.filter((v) => !used.has(v.bvid))
        if (kept.length !== out.length) console.log(`（已剔除 ${out.length - kept.length} 条 ${days} 天内发过的，剩 ${kept.length} 条）`)
        usable = kept
      }
    }
  } catch {}
  usable.sort((a, b) => b.hit - a.hit || b.density - a.density)
  const picked = usable.slice(0, n)

  if (json) { console.log(JSON.stringify({ ok: true, n: picked.length, items: picked }, null, 2)); return }

  if (!picked.length) { console.log('（没筛出候选 —— 试试在 preferences.keywords 里加几个搜索词）'); return }
  console.log(`筛出 ${picked.length} 条（偏好命中在前，同分按弹幕密度）：\n`)
  for (const [i, v] of picked.entries()) {
    console.log(`${i + 1}. ${v.title}`)
    console.log(`   UP：${v.owner} · 播放 ${v.play} · 弹幕 ${v.danmaku} · ${fmtMinutes(v.duration)} 分钟 · 来源 ${v.source}`)
    console.log(`   偏好：${v.why}`)
    console.log(`   BV：${v.bvid}\n`)
  }
  console.log('下一步：挑 2–3 条深读 —— node feiyu.mjs debrief --bvid <BV>')
}
