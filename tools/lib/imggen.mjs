// imggen —— AI 表情包自动生成（Pollinations flux，免费、无需 key）。
//
// 为什么用 curl 子进程出网：image.pollinations.ai 直连被墙（实测 HTTP 000），
// 必须走本机 Clash 代理；而 node fetch（undici）不认系统代理环境变量 ——
// spawn curl -x 代理 是版本无关、行为最确定的通道（实测 200 / 31KB / ~4s）。
//
// 生成结果按文案 md5 缓存进表情库：标签模式存 ~/.feiyu-ai/stickers/<标签>/ai-*.jpg
// （图库自己长大，下次同样式直接从图库拿）；自制模式存 自制/ 目录。
// 日额度账本 ~/.feiyu-ai/imggen.json（0 = 不限），防 Pollinations 免费档被刷限流。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { dataPath, homePath } from './paths.mjs'
import { config } from './config.mjs'
import { STICKER_DIR } from './stickers.mjs'

const GEN_FILE = () => dataPath('imggen.json')
const REF_CACHE = () => dataPath('imggen-ref.json')
const dayKey = () => new Date().toLocaleDateString('sv-SE')
/** 固定形象基底：鲸鱼娘（2D 动漫贴纸风，蓝发鱼尾少女 —— 参考主人给的形象），成品才像"她的"表情包。
 *  情绪/动作/服装由每条文案的 LLM 翻译自由发挥 —— 基底不变，风格她自己探索。 */
const STYLE = 'flat 2D anime chibi sticker illustration, cute whale-girl, long wavy navy-blue hair with light blue gradient, whale tail and small fin ears, big sparkling blue eyes, soft blush, kawaii, bold clean lineart, flat cel shading, simple pale background, high quality'
const TAG_CAP = 12   // 每个标签目录最多留几张 ai- 生成图（老的删掉，只删自己生成的）

// ── 图生图参考图（10-25）：形象锚定用主人给的参考图集，img2img 才"像" ─────────
// ~/.feiyu-ai/sticker-refs/ref-<情绪>.jpg（哭/举手/得意/微笑）—— 按文案情绪自动挑最贴的一张；
// Pollinations 的 &image= 参数要一个公网可达的图片 URL —— 本地图自动传 tmpfiles.org
// （60 分钟过期）并按文件缓存 URL，过期自动重传。
const REF_UPLOAD_PROXY = () => config().imageGen?.proxy || 'http://127.0.0.1:7897'
function refCacheRead() {
  try {
    const j = JSON.parse(fs.readFileSync(REF_CACHE(), 'utf8'))
    if (j && j.urls) return j.urls
    if (j && j.url) return { __legacy: { url: j.url, at: j.at } }   // 旧格式兼容
  } catch {}
  return {}
}
function refUrlCached(refPath) {
  const hit = refCacheRead()[refPath]
  if (hit && hit.url && Date.now() - Number(hit.at) < 50 * 60_000) return hit.url
  return ''
}
function uploadRef(localPath) {
  const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
  const r = execFileSync(exe, ['-sS', '-m', '90', '-x', REF_UPLOAD_PROXY(), '-F', `file=@${String(localPath).replace(/\//g, path.sep)}`, 'https://tmpfiles.org/api/v1/upload'],
    { encoding: 'utf8', timeout: 100000, windowsHide: true })
  const j = JSON.parse(r)
  const page = String(j?.data?.url || '')
  if (!page) throw new Error('tmpfiles 上传失败：' + r.slice(0, 120))
  const url = page.replace('tmpfiles.org/', 'tmpfiles.org/dl/')   // 页面链 → 直链
  const urls = refCacheRead()
  urls[localPath] = { url, at: Date.now() }
  const keep = Object.entries(urls).sort((a, b) => b[1].at - a[1].at).slice(0, 8)
  try { fs.writeFileSync(REF_CACHE(), JSON.stringify({ urls: Object.fromEntries(keep) })) } catch {}
  return url
}
/** 按文案情绪挑参考图：大哭/举手/得意/微笑 四象限，关键词粗分（够用，别过度设计）。 */
function pickRefFor(cap) {
  const fallback = String(config().imageGen?.refImage || '').trim()
  try {
    const dir = homePath('.feiyu-ai', 'sticker-refs')
    const files = fs.readdirSync(dir).filter((f) => /^ref-/.test(f) && /\.(jpg|jpeg|png)$/i.test(f))
    if (!files.length) return fallback
    const c = String(cap || '')
    let want = '微笑'
    if (/哭|难过|委屈|伤心|呜|泪|崩|绷不住|可怜/.test(c)) want = '哭'
    else if (/发现|好奇|为什么|什么|原来|注意|重大|举手|疑问|想通/.test(c)) want = '举手'
    else if (/得意|骄傲|强大|厉害|哼|赢|叉腰|傲娇|不服|最强|嚣张/.test(c)) want = '得意'
    const hit = files.find((f) => f.includes(want))
    return path.join(dir, hit || files[0])
  } catch { return fallback }
}
/** 参考图公网直链：返回 {path, url} 或 null。 */
function refImageUrl(cap) {
  const ref = pickRefFor(cap)
  if (!ref || !fs.existsSync(ref)) return null
  if (/^https?:\/\//.test(ref)) return { path: ref, url: ref }
  try {
    const cached = refUrlCached(ref)
    if (cached) return { path: ref, url: cached }
    return { path: ref, url: uploadRef(ref) }
  } catch { return null }
}

// ── 日额度 ────────────────────────────────────────────────────────────────
export function genQuotaOk(max, file = GEN_FILE()) {
  if (!(Number(max) > 0)) return true   // 0 = 不限
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (j.day === dayKey() ? Number(j.count ?? 0) : 0) < max
  } catch { return true }
}
export function genQuotaRecord(file = GEN_FILE()) {
  let count = 0
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); count = j.day === dayKey() ? Number(j.count ?? 0) : 0 } catch {}
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ day: dayKey(), count: count + 1 })) } catch {}
}

// ── 纯逻辑（测试用）─────────────────────────────────────────────────────────
/** 文案 → 文生图 prompt：LLM 翻译成英文（flux 对中文很糊），失败/没 LLM 用模板兜底。 */
export async function buildImagePrompt(caption, chat) {
  const cap = String(caption || '').trim().slice(0, 20)
  if (!cap) return STYLE
  const fallback = `${STYLE}, mood: ${cap}, adorable`
  if (typeof chat !== 'function') return fallback
  try {
    const out = await Promise.race([
      chat([
        { role: 'system', content: '你是文生图提示词工程师。把一条中文表情包文案翻译成英文文生图 prompt：描述这只圆滚滚卡通蓝鲸鱼娘在此场景下的表情、动作、情绪。只输出英文短语（50 词以内），不要解释不要换行。' },
        { role: 'user', content: `文案：${cap}\n英文 prompt：` },
      ], { temperature: 0.7, max_tokens: 120 }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('prompt 翻译超时')), 15000)),
    ])
    const t = String(out || '').trim().replace(/\s+/g, ' ')
    return t ? `${STYLE}, ${t.slice(0, 300)}` : fallback
  } catch { return fallback }
}

/** 是不是一张真图（JPEG/PNG 魔数 + 大小下限，防把 HTML 拦截页存进图库）。 */
export function isImageFile(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 2048) return false
    const head = fs.readFileSync(file).subarray(0, 4)
    return (head[0] === 0xff && head[1] === 0xd8) || (head[0] === 0x89 && head[1] === 0x50)
  } catch { return false }
}

/** 标签目录里 ai- 图超过上限时删最老的（只动自己生成的，内置图不碰）。 */
export function capTagFiles(tag, cap = TAG_CAP, dir = STICKER_DIR) {
  try {
    const d = path.join(dir, tag)
    const files = fs.readdirSync(d).filter(f => f.startsWith('ai-') && /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .map(f => ({ f, mt: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => a.mt - b.mt)
    for (const x of files.slice(0, Math.max(0, files.length - cap))) { try { fs.rmSync(path.join(d, x.f), { force: true }) } catch {} }
  } catch {}
}

// ── 生成主流程 ──────────────────────────────────────────────────────────────
const inflight = new Map()   // 同一文案/标签并发生成去重（qq-server 两条消息先后到时别画两张）

function curlTo(url, file, timeoutMs, proxy) {
  return new Promise((resolve, reject) => {
    const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
    const args = ['-sS', '-L', '-m', String(Math.ceil(timeoutMs / 1000)), '-o', file, '-w', '%{http_code}',
      ...(proxy ? ['-x', proxy] : []), url]
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs + 8000 }, (e, so, se) => {
      if (e && !fs.existsSync(file)) return reject(new Error(String(se || e.message).slice(-200)))
      resolve(String(so || '').trim())
    })
  })
}

/**
 * 生成一张表情包并入库。返回图片绝对路径；失败返回 null（调用方自行降级）。
 * @param {string} caption 表情文案（如「本鱼饿了」「太搞笑了8」）
 * @param {{tag?: string, llmChat?: (msgs, opts) => Promise<string>, timeoutMs?: number}} o
 *   tag 给了就存进 <tag>/ 目录（图库增长）；不给存 自制/（按文案缓存）。
 */
export async function generateStickerImage(caption, o = {}) {
  const ig = config().imageGen ?? {}
  if (ig.enabled === false) return null
  const cap = String(caption || '').trim().slice(0, 20)
  if (!cap) return null
  const dailyMax = Number(ig.dailyMax ?? 30)
  const tag = o.tag ? String(o.tag).replace(/[\\/:*?"<>|]/g, '').slice(0, 10) : ''
  const dir = path.join(STICKER_DIR, tag || '自制')
  const hash = crypto.createHash('md5').update((tag ? `t:${tag}:` : '') + cap).digest('hex').slice(0, 12)
  const out = path.join(dir, `${tag ? 'ai-' : ''}${hash}.jpg`)
  if (isImageFile(out)) return out          // 缓存命中：同文案不重画、不占额度
  const key = `${tag}|${cap}`
  if (inflight.has(key)) return inflight.get(key)

  if (!genQuotaOk(dailyMax)) return null    // 今日额度用完，安静放弃（调用方有 PIL/颜文字兜底）
  const run = (async () => {
    try {
      const chat = o.llmChat ?? (await import('./llm.mjs')).chat
      const prompt = await buildImagePrompt(cap, chat)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = out + '.part'
      const ig2 = config().imageGen ?? {}
      // ── provider 分流：siliconflow(Qwen-Image-Edit 指令式编辑，形象锁死) > pollinations(免费兜底) ──
      if (String(ig2.provider || '') === 'siliconflow' && String(ig2.api_key || '').trim()) {
        const ok = await genSiliconflow(prompt, tmp, ig2, cap)
        if (ok) {
          fs.renameSync(tmp, out)
          genQuotaRecord()
          if (tag) capTagFiles(tag)
          return out
        }
        // 硅基失败（额度/网络）→ 落回 pollinations 免费兜底，内容不丢
      }
      const ref = refImageUrl(cap)   // 图生图锚：按情绪挑参考图，形象才"像"
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
        + `?width=512&height=512&nologo=true&model=${encodeURIComponent(ig.model || 'flux')}&seed=${Math.floor(Math.random() * 1e6)}`
        + (ref ? `&image=${encodeURIComponent(ref.url)}` : '')
      // 免费档 1 张/45s + 服务偶发 503：402/503 退避 55s 重试，最多 3 次
      let code = ''
      for (let attempt = 1; attempt <= 3; attempt++) {
        code = await curlTo(url, tmp, o.timeoutMs ?? 120000, ig.proxy ?? 'http://127.0.0.1:7897')
        if (code === '200') break
        try { fs.rmSync(tmp, { force: true }) } catch {}
        if (attempt < 3 && (code === '402' || code === '503')) {
          await new Promise((r) => setTimeout(r, 55000))
          continue
        }
        return null
      }
      if (code !== '200' || !isImageFile(tmp)) { try { fs.rmSync(tmp, { force: true }) } catch {}; return null }
      fs.renameSync(tmp, out)
      genQuotaRecord()
      if (tag) capTagFiles(tag)
      return out
    } catch { return null }
    finally { inflight.delete(key) }
  })()
  inflight.set(key, run)
  return run
}

// ── 硅基流动 Qwen-Image-Edit（10-25）：指令式图生图，参考图锁形象，≈¥0.25/张 ──
// POST /v1/images/generations {model:"Qwen/Qwen-Image-Edit", prompt, image:<dataURI>} → {images:[{url}]}
// cap 顺带当气泡配文画进图里（Qwen 系中文渲染稳），每次的表情/配文不同 → 适应不同场景。
async function genSiliconflow(prompt, tmpFile, ig, cap = '') {
  try {
    const ref = refImageUrl(cap)
    if (!ref || !fs.existsSync(ref.path)) return false   // 没参考图就不该用编辑模型
    const dataUri = `data:image/jpeg;base64,${fs.readFileSync(ref.path).toString('base64')}`
    const bubble = cap ? `画面加一个手绘对话气泡，气泡里清楚地写着「${String(cap).slice(0, 12)}」这几个汉字（文字必须一字不差、清晰可读）。` : ''
    const editPrompt = '参考图中的鲸鱼娘角色：保持她的发型、发色、五官、脸型、服装配色和形象设定完全不变，'
      + `画出她${prompt}的样子。${bubble}2D 动漫贴纸风格，全身，简洁浅色纯背景，高清。`
    const r = await fetch('https://api.siliconflow.cn/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(ig.api_key).trim()}`, 'Content-Type': 'application/json' },
      // 硅基用 Qwen 系模型；配置里的 flux/turbo 是 pollinations 的，别传错（2509 是新版，形象保持更好）
      body: JSON.stringify({ model: String(ig.model || '').startsWith('Qwen/') ? ig.model : 'Qwen/Qwen-Image-Edit-2509', prompt: editPrompt, image: dataUri }),
      signal: AbortSignal.timeout(180000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`)
    const j = await r.json()
    const url = String(j?.images?.[0]?.url || '')
    if (!url) throw new Error('响应里没有图片 URL：' + JSON.stringify(j).slice(0, 150))
    // 下载成品（国内直连，失败走代理）
    const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
    try {
      execFileSync(exe, ['-sS', '-m', '120', '-o', tmpFile, url], { encoding: 'utf8', timeout: 130000, windowsHide: true })
    } catch {
      execFileSync(exe, ['-sS', '-m', '120', '-x', ig.proxy || 'http://127.0.0.1:7897', '-o', tmpFile, url], { encoding: 'utf8', timeout: 130000, windowsHide: true })
    }
    if (!isImageFile(tmpFile)) throw new Error('下载的不是有效图片')
    return true
  } catch (e) {
    try { fs.rmSync(tmpFile, { force: true }) } catch {}
    try { fs.appendFileSync(dataPath('imggen.log'), `${new Date().toISOString()} siliconflow 失败：${String(e?.message ?? e).slice(0, 200)}\n`) } catch {}
    return false
  }
}
