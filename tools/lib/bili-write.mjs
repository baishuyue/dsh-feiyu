// bili-write —— B站「活人感」写通道：弹幕 / 动态 / 点赞 / 投币 / 图片评论 / 回评论 / 关注。
// 所有动作都遵守同一条铁律：默认 dry（只打印）、走额度账本（bili-actions.json 按天计数）、
// 文本过 guard.clean —— 新号养号期宁可少发，别被风控盯上（10-24 软删除教训）。
import fs from 'node:fs'
import path from 'node:path'
import { apiGet, makeHeaders } from './bili-api.mjs'
import { loadCred } from './cred.mjs'
import { config } from './config.mjs'
import * as guard from './guard.mjs'
import { classifyComment } from './comment-kind.mjs'
import { dataPath } from './paths.mjs'

// ── 日额度账本 ───────────────────────────────────────────────────────────
const ACT_FILE = dataPath('bili-actions.json')
const dayKey = () => new Date().toLocaleDateString('sv-SE')
function readActs() { try { return JSON.parse(fs.readFileSync(ACT_FILE, 'utf8')) } catch { return {} } }
function actCount(kind) {
  const j = readActs()
  return j.day === dayKey() ? Number(j[kind] ?? 0) : 0
}
/** 0 = 不限（随便玩），>0 = 当日上限。 */
export function capOk(kind, max) { return !(Number(max) > 0) || actCount(kind) < max }
/**
 * 记一次动作。
 * @param {string} kind like/coin/follow/danmaku/dyn/reply/imgComment
 * @param {object} info {bvid,title,text,to,extra} —— 有就顺手记进社交流水（主人要看得见）
 */
export function capRecord(kind, info = {}) {
  const j = readActs()
  const fresh = j.day !== dayKey()
  // ⚠️ 展开顺序：旧值必须在前，新值在后 —— 以前写反了（...j 在后把刚 +1 的值又覆盖回去，账本永远 1）
  const next = fresh ? { day: dayKey(), [kind]: 1 } : { ...j, day: dayKey(), [kind]: Number(j[kind] ?? 0) + 1 }
  fs.mkdirSync(path.dirname(ACT_FILE), { recursive: true })
  fs.writeFileSync(ACT_FILE, JSON.stringify(next))
  // 只说"动作"类（点赞/投币/关注/投稿）；"说话"类由 outbox.recordBili 记，避免一条事记两遍
  if (SOCIAL_ACTION_KINDS.has(kind)) {
    import('./social-log.mjs').then((s) => s.append({ kind, ...info, cfg: config() })).catch(() => {})
  }
}
const SOCIAL_ACTION_KINDS = new Set(['like', 'coin', 'follow', 'video'])
export const actStats = () => { const j = readActs(); return j.day === dayKey() ? j : {} }

// ── 我的评论登记（回评论扫描用）───────────────────────────────────────────
const MY_COMMENTS = dataPath('my-comments.json')
export function recordMyComment(bvid, aid, rpid) {
  let list = []
  try { list = JSON.parse(fs.readFileSync(MY_COMMENTS, 'utf8')) } catch {}
  list.push({ bvid, aid, rpid, ts: Date.now() })
  try { fs.writeFileSync(MY_COMMENTS, JSON.stringify(list.slice(-100), null, 1)) } catch {}
}

// ── 基础：表单 POST（B站的写接口全是 form 编码 + csrf）─────────────────────
async function formPost(cred, url, params) {
  const body = new URLSearchParams({ ...params, csrf: cred.bili_jct, csrf_token: cred.bili_jct })
  const r = await fetch(url, {
    method: 'POST',
    headers: makeHeaders(cred, { referer: 'https://www.bilibili.com/', 'content-type': 'application/x-www-form-urlencoded' }),
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json().catch(() => ({ code: -1, message: '响应不是 JSON' }))
}

/** 一个校验通过的回复码（0 才算成功，其余原样带 message 回来）。 */
function okOf(j) { return { ok: Number(j?.code) === 0, code: j?.code, message: j?.message ?? '' } }

/** 视频 aid/cid/duration（弹幕和点赞都要）。 */
export async function videoInfo(bvid) {
  const cred = loadCred()
  const v = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, makeHeaders(cred))
  if (Number(v?.code) !== 0) throw new Error('读不到视频：' + (v?.message || bvid))
  return { aid: v.data.aid, cid: v.data.cid, duration: v.data.duration, title: v.data.title, ownerMid: v.data.owner?.mid, owner: v.data.owner?.name }
}

// ── ① 弹幕 ────────────────────────────────────────────────────────────────
/** 发一条弹幕（看视频的"在场感"）。atSec：出现在第几秒。 */
export async function sendDanmaku(bvid, rawText, { go = false, atSec = 0 } = {}) {
  const cfg = config().bilibili?.danmaku ?? {}
  const text = guard.clean(String(rawText || ''), config()).slice(0, 30)
  if (!text) return { ok: false, why: '弹幕清洗后为空' }
  const info = await videoInfo(bvid)
  const at = Math.max(0, Math.min(Math.round(atSec) || Math.floor(Math.random() * Math.max(1, info.duration - 5)), Math.max(0, info.duration - 1)))
  if (!go) return { ok: true, dry: true, why: `【干跑】弹幕 →《${info.title.slice(0, 24)}》第 ${at}s：${text}` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (!cfg.enabled) return { ok: false, why: 'bilibili.danmaku.enabled 是关的' }
  if (!capOk('danmaku', Number(cfg.dailyMax ?? 5))) return { ok: false, why: `今日弹幕额度已用完（${actCount('danmaku')}/${cfg.dailyMax ?? 5}）` }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/v1/dm/post.so', {
    type: 1, oid: String(info.aid), cid: String(info.cid), bvid, mid: '', msg: text,
    progress: String(at * 1000), fontsize: '25', pool: '0', mode: '1', color: '16777215', rnd: String(Date.now()).slice(0, -3), plat: '1',
  })
  const res = okOf(j)
  if (res.ok) { capRecord('danmaku'); try { const { recordBili } = await import('./outbox.mjs'); recordBili({ kind: '弹幕', title: info.title, bvid, text, extra: `第${at}s` }) } catch {} return { ...res, why: `弹幕已发（第 ${at}s）：${text}` } }
  // 直连被拦（B站对脚本直连的写接口回 HTML 拦截页，json 解析失败 code=-1）→ CDP 真浏览器页内发
  if (Number(res.code) === -1 || Number(res.code) === -400) {
    try {
      const { execFile } = await import('node:child_process')
      const full = await import('./config.mjs')
      const py = full.config().douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe'
      const out = await new Promise((resolve) => {
        execFile(py, ['D:/social-auto-upload/bili_act_cdp.py', 'dm', bvid, text, String(info.aid), String(info.cid), String(at)],
          { encoding: 'utf8', timeout: 180000, windowsHide: true }, (e2, so, se) => resolve(String((so || se || e2?.message) || '')))
      })
      // post.so 老接口成功时返回 {"code":0,...}；失败时 code!=0 或 NEED_LOGIN
      if (out.includes('SEND_DM') && /"code"\s*:\s*0/.test(out)) {
        capRecord('danmaku'); return { ok: true, why: `弹幕已发（CDP 通道，第 ${at}s）：${text}` }
      }
      if (out.includes('NEED_LOGIN')) return { ok: false, why: '弹幕需要先在 CDP Chrome 里登录一次B站（扫码）' }
      if (out.includes('NO_INPUT')) return { ok: false, why: '弹幕暂不可用：B站已把 dm 接口 protobuf 化且播放器弹幕框改版（待适配），这条跳过' }
      return { ok: false, why: '弹幕失败：' + out.slice(-120) }
    } catch (e2) { return { ok: false, why: 'CDP 弹幕失败：' + String(e2?.message ?? e2).slice(0, 120) } }
  }
  return { ...res, why: `弹幕失败 code=${res.code} ${res.message}` }
}

// ── ② 文字动态 ────────────────────────────────────────────────────────────
/** 发一条文字动态（opus）。内容建议 ≤240 字（动态折叠线）。 */
export async function postDynamic(rawText, { go = false } = {}) {
  const cfg = config().bilibili?.dynamic ?? {}
  const text = String(rawText || '').trim().slice(0, 1000)
  if (!text) return { ok: false, why: '动态内容为空' }
  if (!go) return { ok: true, dry: true, why: `【干跑】动态 → ${text.slice(0, 80)}` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (!cfg.enabled) return { ok: false, why: 'bilibili.dynamic.enabled 是关的' }
  if (!capOk('dyn', Number(cfg.dailyMax ?? 2))) return { ok: false, why: `今日动态额度已用完（${actCount('dyn')}/${cfg.dailyMax ?? 2}）` }
  const cred = loadCred()
  const dynReq = {
    dyn_req: JSON.stringify({
      scene: 2, business_id: 3, box_type: 1, upload_id: Date.now(),
      text: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
      attach_card: {}, topic: [], attachment: [], algorithm: { lite_benefit: 0 }, dynamic_id: 0, pics: [],
    }),
  }
  const j = await formPost(cred, 'https://api.bilibili.com/x/dynamic/feed/create/dyn', dynReq)
  const res = okOf(j)
  if (res.ok) { capRecord('dyn'); try { const { recordBili } = await import('./outbox.mjs'); recordBili({ kind: '动态', text }) } catch {} return { ...res, why: '动态已发' } }
  // 直连被 -400 拦（B站对脚本直连有风控）→ 走 CDP 真浏览器页面内发（借官方之口，登录一次永久有效）
  if (Number(res.code) === -400) {
    try {
      const { execFile } = await import('node:child_process')
      const full = await import('./config.mjs')
      const py = full.config().douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe'
      const out = await new Promise((resolve) => {
        execFile(py, ['D:/social-auto-upload/bili_act_cdp.py', 'dyn', text],
          { encoding: 'utf8', timeout: 180000, windowsHide: true }, (e2, so, se) => resolve(String((so || se || e2?.message) || '')))
      })
      if (/"code"\s*:\s*0/.test(out) && out.includes('CREATE_DYN')) {
        capRecord('dyn')
        // 台账（10-27 补）：以前这条 CDP 成功路径只记额度、不写台账，于是"我发过一条动态"在
        // 账本里查不到（当天 social-log 里 dynamic 条数 = 0）。说不清自己说过什么，等于没记。
        try { const { recordBili } = await import('./outbox.mjs'); recordBili({ kind: '动态', text }) } catch {}
        return { ok: true, why: '动态已发（CDP 真浏览器通道）' }
      }
      if (out.includes('NEED_LOGIN')) return { ok: false, why: '动态需要先在 CDP Chrome 窗口里登录一次B站（扫码），之后永久免登' }
      if (out.includes('CDP_CONNECT_FAIL')) return { ok: false, why: 'CDP Chrome(9222) 没开（动态的兜底通道）' }
      return { ok: false, why: '动态失败：' + out.slice(-150) }
    } catch (e2) { return { ok: false, why: 'CDP 动态失败：' + String(e2?.message ?? e2).slice(0, 150) } }
  }
  return { ...res, why: `动态失败 code=${res.code} ${res.message}` }
}

// ── ③ 点赞 / 投币 ─────────────────────────────────────────────────────────
/** 给视频点赞（真爱一键，零风险）。 */
export async function likeVideo(bvid, { go = false } = {}) {
  const cfg = config().bilibili?.react ?? {}
  const info = await videoInfo(bvid)
  if (!go) return { ok: true, dry: true, why: `【干跑】点赞 →《${info.title.slice(0, 24)}》` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (cfg.like === false) return { ok: false, why: 'bilibili.react.like 是关的' }
  if (!capOk('like', Number(cfg.likeDaily ?? 10))) return { ok: false, why: '今日点赞额度已用完' }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/web-interface/archive/like', { aid: String(info.aid), like: '1' })
  // "重复点赞"（code 65006）是幂等结果：已经赞过，当成功处理（不占当日额度）
  const dup = Number(j?.code) === 65006 || /重复/.test(String(j?.message ?? ''))
  const res = { ...okOf(j), ok: Number(j?.code) === 0 || dup }
  if (res.ok && !dup) capRecord('like', { bvid, title: info.title })
  return { ...res, why: res.ok ? (dup ? '已赞过（幂等）' : '已点赞') : `点赞失败 ${res.message}` }
}

/** 投币（真金白银，默认 1 枚、每天 1 枚上限）。 */
export async function coinVideo(bvid, { go = false, num = 1 } = {}) {
  const cfg = config().bilibili?.react ?? {}
  const info = await videoInfo(bvid)
  if (!go) return { ok: true, dry: true, why: `【干跑】投币 x${num} →《${info.title.slice(0, 24)}》` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (cfg.coin !== true) return { ok: false, why: 'bilibili.react.coin 是关的（投币要显式开）' }
  if (!capOk('coin', Number(cfg.coinDaily ?? 1))) return { ok: false, why: '今日投币额度已用完' }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/web-interface/coin/add', { aid: String(info.aid), multiply: String(num), select_like: '0' })
  // B站给投币上了 gaia 风控闸（-401 非法访问 + risk_level obtain 挑战），页内 fetch 和 UI 点击都过不去
  // —— 全站防护最重的接口之一（真金白银），暂缓自动化，想要投币去 App 手动
  if (Number(j?.code) === -401 || /非法访问/.test(String(j?.message ?? ''))) {
    return { ok: false, why: '投币暂不可用：B站 gaia 风控闸（接口/页内/UI 三层都拦），去 App 手动投吧' }
  }
  const res = okOf(j)
  if (res.ok) capRecord('coin', { bvid, title: info.title, extra: num + ' 枚' })
  return { ...res, why: res.ok ? `已投 ${num} 枚` : `投币失败 ${res.message}` }
}

// ── ④ 图片评论（先传B站图床，再带 pictures 发评论）────────────────────────
/** 上传图片到B站图床（动态 draw 通道，评论图片用一个 URL）。返回 {img_src,img_width,img_height,img_size}。 */
export async function uploadImage(filePath) {
  const cred = loadCred()
  const buf = fs.readFileSync(filePath)
  const form = new FormData()
  form.append('csrf', cred.bili_jct)
  form.append('category', 'daily')
  form.append('biz', 'new_dyn')
  form.append('file_up', new Blob([buf]), path.basename(filePath))
  const r = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
    method: 'POST', headers: makeHeaders(cred, { referer: 'https://t.bilibili.com/' }), body: form, signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => ({ code: -1 }))
  if (Number(j?.code) !== 0 || !j?.data?.image_url) throw new Error('图床上传失败：' + JSON.stringify(j).slice(0, 150))
  return { img_src: j.data.image_url, img_width: j.data.image_width, img_height: j.data.image_height, img_size: j.data.img_size }
}

/** 带图评论：文字 + 图片（生图表情包 / PIL 贴纸）。 */
export async function commentWithPicture(bvid, rawMessage, imagePath, { go = false } = {}) {
  const cfg = config().bilibili?.imageComment ?? {}
  const message = guard.clean(String(rawMessage || ''), config()).slice(0, 200)
  if (!message) return { ok: false, why: '评论文本为空' }
  const info = await videoInfo(bvid)
  if (!go) return { ok: true, dry: true, why: `【干跑】图片评论 →《${info.title.slice(0, 20)}》：${message} [图:${path.basename(imagePath)}]` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (!cfg.enabled) return { ok: false, why: 'bilibili.imageComment.enabled 是关的' }
  if (!capOk('imgComment', Number(cfg.dailyMax ?? 2))) return { ok: false, why: '今日图片评论额度已用完' }
  const verdict = guard.allow(`bilibili:${bvid}`, message, config())
  if (!verdict.ok) return { ok: false, why: '被风控闸门拦下：' + verdict.why }
  const pic = await uploadImage(imagePath)
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/v2/reply/add', {
    oid: String(info.aid), type: '1', plat: '1', message,
    pictures: JSON.stringify([pic]), has_vote_option: 'true', gaia_source: 'main_web', at_name_to_mid: '{}',
  })
  const res = okOf(j)
  if (res.ok) { capRecord('imgComment'); guard.commit(`bilibili:${bvid}`, message); recordMyComment(bvid, info.aid, j?.data?.rpid); try { const { recordBili } = await import('./outbox.mjs'); recordBili({ kind: '图片评论', title: info.title, bvid, text: message, extra: path.basename(imagePath) }) } catch {} }
  return { ...res, why: res.ok ? '图片评论已发' : `图片评论失败 ${res.message}` }
}

// ── ⑤ 关注 ────────────────────────────────────────────────────────────────
/** 关注一个 UP（社交图谱自己长）。 */
export async function followUser(mid, { go = false } = {}) {
  const cfg = config().bilibili?.follow ?? {}
  if (!go) return { ok: true, dry: true, why: `【干跑】关注 → mid ${mid}` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (cfg.enabled !== true) return { ok: false, why: 'bilibili.follow.enabled 是关的' }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/relation/modify', { fid: String(mid), act: '1', re_src: '11' })
  const res = okOf(j)
  if (res.ok) capRecord('follow', { url: 'https://space.bilibili.com/' + mid, title: 'mid ' + mid })
  return { ...res, why: res.ok ? '已关注' : '关注失败 ' + j?.message }
}

// ── ⑥ 回评论扫描：别人回复了我的评论 → 交给上层 LLM 生成回复 ──────────────
/** 扫描我发过的评论下面的新回复（来自别人）。返回 [{bvid, aid, rootRpid, reply:{rpid,uname,text}, ts}] */
export async function scanReplies({ sinceMs } = {}) {
  const since = sinceMs ?? 0
  let mine = []
  try { mine = JSON.parse(fs.readFileSync(MY_COMMENTS, 'utf8')) } catch {}
  const cred = loadCred()
  const H = makeHeaders(cred)
  const out = []
  for (const c of mine.slice(-30)) {
    try {
      const d = await apiGet(`https://api.bilibili.com/x/v2/reply?type=1&oid=${c.aid}&root=${c.rpid}&ps=20`, H, { noCache: true })
      for (const r of d?.data?.replies ?? []) {
        if (String(r.rpid) === String(c.rpid)) continue
        if (Number(r.ctime ?? 0) * 1000 <= Math.max(since, c.ts)) continue
        out.push({ bvid: c.bvid, aid: c.aid, rootRpid: c.rpid, reply: { rpid: r.rpid, uname: r.member?.uname ?? '', text: String(r.content?.message ?? '').slice(0, 120) }, ts: Number(r.ctime ?? 0) * 1000 })
      }
    } catch {}
  }
  return out
}

/** 回复别人（楼中楼）：不带 @主人（社交回应，不是分享），不过 share 标尺，但照走 guard + 日额度。
 *  opts.inReplyTo：「对方昵称:对方的话」—— 发言台账用。
 *  opts.aid / opts.title：已知就传进来 —— 省掉一次 /x/web-interface/view（那个接口今天已经被
 *  B站 412 限流过两回，回评论不该被"查 aid"卡死；aid 在评论区接口里本来就有）。 */
// ── ⑧ 审核可见性核查（10-27）──────────────────────────────────────────
// 真实翻车：回评 API 返回 ok、rpid 也拿到了，但匿名（不带 cookie）拉楼中楼是空的 ——
// B站 对低等级新号的评论会先**仅自己可见**（带 cookie 查得到，别人看不到）。
// 光看"已回复"三个字会以为送达了，其实对方一个字都没收到。
const ANON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
}
async function anonJson(u) {
  try {
    const r = await fetch(u, { headers: ANON_HEADERS, signal: AbortSignal.timeout(12000) })
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status }
    const j = await r.json().catch(() => null)
    return { ok: true, j }
  } catch (e) { return { ok: false, why: e.message } }
}

/**
 * 这条评论/回复对外（未登录）看得见吗？
 * @param {object} p { aid, rpid, rootRpid? }
 * @returns {{checked:boolean, visible:boolean, how:string}}
 */
export async function replyVisibility({ aid, rpid, rootRpid = '' } = {}) {
  const oid = encodeURIComponent(String(aid))
  const rp = String(rpid || '')
  const root = String(rootRpid || rp)
  // ① 先当楼中楼查：root 下的子回复里有没有我这条
  if (root) {
    const { ok, j, why } = await anonJson(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${oid}&root=${encodeURIComponent(root)}&ps=20&pn=1`)
    if (ok) {
      const rows = j?.data?.replies || []
      if (rows.some((x) => String(x?.rpid) === rp)) return { checked: true, visible: true, how: '楼中楼' }
      if (rows.length && root === rp) {
        // root 就是它自己 → 说明它是别人的楼的楼中楼，我拿错了 root；往下走顶层扫描
      }
    } else if (why) return { checked: false, visible: false, how: why }
  }
  // ② 再当顶层评论查：翻前 3 页找 rpid
  for (let pn = 1; pn <= 3; pn++) {
    const { ok, j } = await anonJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&ps=20&sort=2&nohot=1&pn=${pn}`)
    if (!ok) break
    const rows = j?.data?.replies || []
    if (!rows.length) break
    if (rows.some((x) => String(x?.rpid) === rp)) return { checked: true, visible: true, how: '顶层第' + pn + '页' }
  }
  return { checked: true, visible: false, how: '匿名查不到（仅自己可见/审核中）' }
}

export async function postReply(bvid, rootRpid, parentRpid, rawMessage, { go = false, inReplyTo = '', aid = 0, title = '', image = '', bypassCap = false } = {}) {
  const cfg = config().bilibili?.replies ?? {}
  const message = guard.clean(String(rawMessage || ''), config()).slice(0, 100)
  // 10-27：回复不再只有文字 —— 带图回复走同一个 /x/v2/reply/add（`pictures` 参数），
  // 图先上传到B站图床（和图片评论复用 uploadImage）。纯图回复允许文字为空。
  if (!message && !image) return { ok: false, why: '回复内容为空' }
  const info = Number(aid) > 0 ? { aid: Number(aid), title: String(title || bvid) } : await videoInfo(bvid)
  const tag = image ? ` [图:${path.basename(image)}]` : ''
  if (!go) return { ok: true, dry: true, why: `【干跑】回评 →《${String(info.title).slice(0, 18)}》：${message}${tag}` }
  if (cfg.enabled !== true) return { ok: false, why: 'bilibili.replies.enabled 是关的' }
  // bypassCap：主人的评论永远不受日额度限制（跟抖音那边一致 —— 主人说话不许因为额度被吞掉）
  if (!bypassCap && !capOk('reply', Number(cfg.dailyMax ?? 10))) return { ok: false, why: '今日回评额度已用完' }
  const verdict = guard.allow(`bilibili:${bvid}`, message || '[图]', config())
  if (!verdict.ok) return { ok: false, why: '被风控闸门拦下：' + verdict.why }
  const cred = loadCred()
  let pics = ''
  // 10-27 实测硬约束：**子评论（楼中楼）不能带图** —— B站 直接回「子评论不能带图」。
  // 只有直接在视频下发的一级评论能带 pictures。回别人的评论时一律降级成纯文字。
  const isNested = String(rootRpid ?? '0') !== '0' || String(parentRpid ?? '0') !== '0'
  let useImage = image
  if (image && isNested) {
    useImage = ''
  }
  if (useImage) {
    if (config().bilibili?.replies?.image !== true) return { ok: false, why: 'bilibili.replies.image 没开（带图回复要显式开启）' }
    const pic = await uploadImage(useImage)
    pics = JSON.stringify([pic])
  }
  const post = (withPics) => formPost(cred, 'https://api.bilibili.com/x/v2/reply/add', {
    oid: String(info.aid), type: '1', plat: '1', message, root: String(rootRpid), parent: String(parentRpid),
    ...(withPics ? { pictures: withPics } : {}),
  })
  let j = await post(pics)
  let res = okOf(j)
  // 兜底重试：万一还有别的情况带图被拒（文案会变，但意思很硬），去掉图再来一次，别让整条回复丢掉
  if (!res.ok && pics && /图/.test(String(res.message || ''))) {
    j = await post('')
    res = okOf(j)
    if (res.ok) useImage = ''
  }
  if (res.ok) {
    capRecord('reply')
    guard.commit(`bilibili:${bvid}`, message || '[图]')
    recordMyComment(bvid, info.aid, j?.data?.rpid)
    try { const { recordBili } = await import('./outbox.mjs'); recordBili({ kind: image ? '回评(图)' : '回评', title: info.title, bvid, to: inReplyTo, text: message, extra: useImage ? path.basename(useImage) : '' }) } catch {}
  }
  const why = res.ok
    ? `已回复「${(message || '[图]').slice(0, 30)}」${image && !useImage ? '（楼中楼不能带图，已降级纯文字）' : ''}`
    : `回评失败 ${res.message}`
  return { ...res, why, rpid: j?.data?.rpid ?? 0, checkedVisibility: false }
}

// ── ⑦ 自己作品评论区（10-27）──────────────────────────────────────────────
// 主人要的是：**自己投稿下面，别人的评论（任何类型）都要回**。
// 以前 B站 只有「别人回复了我的评论」这一条被动路径，自己作品下的评论根本没人管。
/** 我自己的投稿（最近 N 个）。三路来源，从最稳到最容易风控：
 *   ① config.bilibili.ownBvids（主人手填，永远最准）
 *   ② 本地产出记录：~/.feiyu-ai/bili-debut.json 的 bvid + bili-posts/*​/bvid.txt
 *   ③ /x/space/wbi/arc/search（WBI 签名空间接口，最容易被 412 挡；失败就静默退回）
 * 为什么要有 ②（10-27 实测）：space 接口对脚本很凶，第一次试就吃了 HTTP 412 并被熔断 5 分钟 ——
 * 为了读个投稿列表把整个 B站 通道堵住不值得。本地记过的 bvid 一样能查评论（走 /x/v2/reply 不限流）。
 */
export async function listOwnVideos({ ps = 10 } = {}) {
  const cfg = config().bilibili ?? {}
  const out = []
  const push = (v) => { const b = String(v?.bvid || '').trim(); if (/^BV[0-9A-Za-z]{10}$/.test(b) && !out.some((x) => x.bvid === b)) out.push({ bvid: b, aid: Number(v?.aid || 0), title: String(v?.title || ''), created: Number(v?.created || 0) }) }

  // ① 手填
  for (const b of cfg.ownBvids || []) push({ bvid: b })
  // ② 本地记录：首条锁 + 每个投稿包的 bvid.txt
  try {
    const d = JSON.parse(fs.readFileSync(dataPath('bili-debut.json'), 'utf8'))
    if (d?.bvid) push({ bvid: d.bvid, title: d.title || '' })
  } catch {}
  try {
    const root = dataPath('bili-posts')
    for (const name of fs.readdirSync(root)) {
      const f = path.join(root, name, 'bvid.txt')
      if (!fs.existsSync(f)) continue
      const b = String(fs.readFileSync(f, 'utf8')).trim()
      if (b) push({ bvid: b, title: name })
    }
  } catch {}

  // ③ 空间接口（能拿到标题/时间）
  //    10-27 实测：这个 IP 上 `/x/space/wbi/arc/search` 有时 -412，而且会把 apiGet 熔断 20 分钟，
  //    连带堵住回评/弹幕 —— 所以走 `soft: true`（不熔断），并且**默认开**：
  //    不自己找到投稿，`replies` 那条"回自己作品评论"的路就永远是空的
  //    （10-27 真实翻车：她的简介视频 BV1oExK6yEDn 下有 2 条评论，因为 bvid 没落库，一条都没回）。
  //    真被风控就静默退回本地记录，不影响别的动作。
  if (cfg.useSpaceList !== false && out.length < Math.min(3, ps)) {
    try {
      const cred = loadCred()
      const H = makeHeaders(cred)
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', H, { soft: true })
      const mid = String(nav?.data?.mid ?? cfg.ownMid ?? '')
      if (mid) {
        const u = `https://api.bilibili.com/x/space/wbi/arc/search?mid=${mid}&ps=${Math.max(1, Math.min(30, Number(ps) || 10))}&pn=1&order=pubdate&platform=web`
        const d = await apiGet(u, H, { noCache: true, soft: true })
        for (const v of d?.data?.list?.vlist || []) push({ bvid: v.bvid, aid: v.aid, title: v.title, created: Number(v.created || 0) * 1000 })
      }
    } catch { /* 风控/未登录：忽略，用本地记录 */ }
  }
  // 补齐 aid/标题（/x/v2/reply 只认数字 aid；本地记录里只有 bvid）
  // aid 缓存进 bili-own-engage.json：view 接口被 412 的时候还能靠缓存照常回评论。
  const CACHE = dataPath('bili-own-engage.json')
  let cache = {}
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'))?.aidCache || {} } catch {}
  // 归属校验（10-27 血的教训）：ownBvids 手填错一个号，她就会跑去**别人的视频**下面回评论。
  // 拿 nav 的 mid 跟视频 ownerMid 比，不一样就丢掉这个 BV。
  let myMid = String(cfg.ownMid ?? '')
  if (!myMid) {
    try {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', makeHeaders(loadCred()), { soft: true })
      myMid = String(nav?.data?.mid ?? '')
    } catch {}
  }
  const full = []
  let dirty = false
  const skipped = []
  for (const v of out.slice(0, Math.max(1, Number(ps) || 10))) {
    const hit = cache[v.bvid]
    if (hit?.owner && myMid && String(hit.owner) !== myMid) { skipped.push(v.bvid); continue }
    if (v.aid) {
      // 来自 space 接口的连接（mid 已按 myMid 查过）→ 一定是她自己的
      full.push(v)
      cache[v.bvid] = { ...(cache[v.bvid] || {}), aid: v.aid, title: v.title || cache[v.bvid]?.title || '', owner: myMid || cache[v.bvid]?.owner || '' }
      dirty = true
      continue
    }
    // 缓存里只有 aid、没有 owner 的条目 = 老版本留下的，**归属没验过** → 还得问一次
    if (hit?.aid && (hit.owner || !myMid)) { full.push({ ...v, aid: Number(hit.aid), title: v.title || hit.title || '' }); continue }
    try {
      const info = await videoInfo(v.bvid)
      if (myMid && info.ownerMid && String(info.ownerMid) !== myMid) {
        // 不是她的投稿：记进缓存（带 owner），以后不再问接口
        cache[v.bvid] = { aid: info.aid, title: info.title, owner: String(info.ownerMid) }
        dirty = true
        skipped.push(v.bvid)
        continue
      }
      full.push({ ...v, aid: info.aid, title: v.title || info.title })
      cache[v.bvid] = { ...(cache[v.bvid] || {}), aid: info.aid, title: info.title, owner: String(info.ownerMid ?? '') }
      dirty = true
    } catch { /* 读不到就跳过（412/已删除）—— 下次再说，别把整轮搞挂 */ }
  }
  if (dirty) {
    try {
      const cur = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch { return {} } })()
      cur.aidCache = { ...(cur.aidCache || {}), ...cache }
      fs.mkdirSync(path.dirname(CACHE), { recursive: true })
      fs.writeFileSync(CACHE, JSON.stringify(cur))
    } catch {}
  }
  if (skipped.length) {
    console.warn(`  ⚠ 跳过 ${skipped.length} 个不属于自己的 BV：${skipped.join(' ')}（bilibili.ownBvids 填错了？）`)
  }
  return full
}

/**
 * 某个视频下的评论（含楼中楼），带类型（文字/表情占位/图片评论/空）。
 * 主人 10-27 的原话：「任何类型」—— 所以这里**不筛空文本**，交给上层按 kind 处理。
 * @returns {Promise<Array<{rpid,rootRpid,parentRpid,mid,uname,text,kind,label,plain,pictures,ctime,isUp}>>}
 */
export async function listCommentsOf(aid, { ps = 20, bvid = '', upMid = '' } = {}) {
  const cred = loadCred()
  const H = makeHeaders(cred)
  const d = await apiGet(`https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(String(aid))}&ps=${ps}&sort=2&nohot=1`, H, { noCache: true })
  if (Number(d?.code) !== 0) return []
  const rows = []
  const push = (r, root) => {
    const c = r?.content || {}
    const k = classifyComment({ text: c.message, pictures: c.pictures, emote: c.emote })
    rows.push({
      bvid,
      aid: Number(aid),
      rpid: String(r.rpid ?? ''),
      rootRpid: String(root || r.rpid || ''),
      parentRpid: String(r.parent_str || '0'),
      mid: String(r.mid ?? ''),
      uname: String(r.member?.uname ?? ''),
      text: String(c.message ?? ''),
      kind: k.kind,
      label: k.label,
      plain: k.plain,
      pictures: k.pictures,
      ctime: Number(r.ctime ?? 0) * 1000,
      isUp: upMid ? String(r.mid ?? '') === String(upMid) : false,
    })
  }
  for (const r of d?.data?.replies || []) {
    push(r, r.rpid)
    for (const sub of r.replies || []) push(sub, r.rpid)   // 楼中楼：她答过一轮后对方再说的话也在这里
  }
  return rows
}
