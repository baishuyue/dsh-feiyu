// bili-write —— B站「活人感」写通道：弹幕 / 动态 / 点赞 / 投币 / 图片评论 / 回评论 / 关注。
// 所有动作都遵守同一条铁律：默认 dry（只打印）、走额度账本（bili-actions.json 按天计数）、
// 文本过 guard.clean —— 新号养号期宁可少发，别被风控盯上（10-24 软删除教训）。
import fs from 'node:fs'
import path from 'node:path'
import { apiGet, makeHeaders } from './bili-api.mjs'
import { loadCred } from './cred.mjs'
import { config } from './config.mjs'
import * as guard from './guard.mjs'
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
export function capRecord(kind) {
  const j = readActs()
  const fresh = j.day !== dayKey()
  // ⚠️ 展开顺序：旧值必须在前，新值在后 —— 以前写反了（...j 在后把刚 +1 的值又覆盖回去，账本永远 1）
  const next = fresh ? { day: dayKey(), [kind]: 1 } : { ...j, day: dayKey(), [kind]: Number(j[kind] ?? 0) + 1 }
  fs.mkdirSync(path.dirname(ACT_FILE), { recursive: true })
  fs.writeFileSync(ACT_FILE, JSON.stringify(next))
}
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
  if (!cfg.enabled) return { ok: false, why: 'bilibili.danmaku.enabled 是关的' }
  if (!capOk('danmaku', Number(cfg.dailyMax ?? 5))) return { ok: false, why: `今日弹幕额度已用完（${actCount('danmaku')}/${cfg.dailyMax ?? 5}）` }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/v1/dm/post.so', {
    type: 1, oid: String(info.aid), cid: String(info.cid), bvid, mid: '', msg: text,
    progress: String(at * 1000), fontsize: '25', pool: '0', mode: '1', color: '16777215', rnd: String(Date.now()).slice(0, -3), plat: '1',
  })
  const res = okOf(j)
  if (res.ok) { capRecord('danmaku'); return { ...res, why: `弹幕已发（第 ${at}s）：${text}` } }
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
  if (res.ok) { capRecord('dyn'); return { ...res, why: '动态已发' } }
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
      if (/"code"\s*:\s*0/.test(out) && out.includes('CREATE_DYN')) { capRecord('dyn'); return { ok: true, why: '动态已发（CDP 真浏览器通道）' } }
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
  if (cfg.like === false) return { ok: false, why: 'bilibili.react.like 是关的' }
  if (!capOk('like', Number(cfg.likeDaily ?? 10))) return { ok: false, why: '今日点赞额度已用完' }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/web-interface/archive/like', { aid: String(info.aid), like: '1' })
  // "重复点赞"（code 65006）是幂等结果：已经赞过，当成功处理（不占当日额度）
  const dup = Number(j?.code) === 65006 || /重复/.test(String(j?.message ?? ''))
  const res = { ...okOf(j), ok: Number(j?.code) === 0 || dup }
  if (res.ok && !dup) capRecord('like')
  return { ...res, why: res.ok ? (dup ? '已赞过（幂等）' : '已点赞') : `点赞失败 ${res.message}` }
}

/** 投币（真金白银，默认 1 枚、每天 1 枚上限）。 */
export async function coinVideo(bvid, { go = false, num = 1 } = {}) {
  const cfg = config().bilibili?.react ?? {}
  const info = await videoInfo(bvid)
  if (!go) return { ok: true, dry: true, why: `【干跑】投币 x${num} →《${info.title.slice(0, 24)}》` }
  if (cfg.coin !== true) return { ok: false, why: 'bilibili.react.coin 是关的（投币要显式开）' }
  if (!capOk('coin', Number(cfg.coinDaily ?? 1))) return { ok: false, why: '今日投币额度已用完' }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/web-interface/coin/add', { aid: String(info.aid), multiply: String(num), select_like: '0' })
  const res = okOf(j)
  if (res.ok) capRecord('coin')
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
  if (res.ok) { capRecord('imgComment'); guard.commit(`bilibili:${bvid}`, message); recordMyComment(bvid, info.aid, j?.data?.rpid) }
  return { ...res, why: res.ok ? '图片评论已发' : `图片评论失败 ${res.message}` }
}

// ── ⑤ 关注 ────────────────────────────────────────────────────────────────
/** 关注一个 UP（社交图谱自己长）。 */
export async function followUser(mid, { go = false } = {}) {
  const cfg = config().bilibili?.follow ?? {}
  if (!go) return { ok: true, dry: true, why: `【干跑】关注 → mid ${mid}` }
  if (cfg.enabled !== true) return { ok: false, why: 'bilibili.follow.enabled 是关的' }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/relation/modify', { fid: String(mid), act: '1', re_src: '11' })
  return { ...okOf(j), why: okOf(j).ok ? '已关注' : '关注失败 ' + j?.message }
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
  for (const c of mine.slice(-12)) {
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

/** 回复别人（楼中楼）：不带 @主人（社交回应，不是分享），不过 share 标尺，但照走 guard + 日额度。 */
export async function postReply(bvid, rootRpid, parentRpid, rawMessage, { go = false } = {}) {
  const cfg = config().bilibili?.replies ?? {}
  const message = guard.clean(String(rawMessage || ''), config()).slice(0, 100)
  if (!message) return { ok: false, why: '回复内容为空' }
  const info = await videoInfo(bvid)
  if (!go) return { ok: true, dry: true, why: `【干跑】回评 →《${info.title.slice(0, 18)}》：${message}` }
  if (cfg.enabled !== true) return { ok: false, why: 'bilibili.replies.enabled 是关的' }
  if (!capOk('reply', Number(cfg.dailyMax ?? 10))) return { ok: false, why: '今日回评额度已用完' }
  const verdict = guard.allow(`bilibili:${bvid}`, message, config())
  if (!verdict.ok) return { ok: false, why: '被风控闸门拦下：' + verdict.why }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/v2/reply/add', {
    oid: String(info.aid), type: '1', plat: '1', message, root: String(rootRpid), parent: String(parentRpid),
  })
  const res = okOf(j)
  if (res.ok) { capRecord('reply'); guard.commit(`bilibili:${bvid}`, message); recordMyComment(bvid, info.aid, j?.data?.rpid) }
  return { ...res, why: res.ok ? `已回复「${message.slice(0, 30)}」` : `回评失败 ${res.message}` }
}
