// 表情包 / 颜文字 —— QQ、微信、B站、抖音共用的一套约定。
//
// 三层能力，按平台降级：
//   1. 颜文字 / emoji   —— 哪儿都能用（评论也行）
//   2. B站自带表情码     —— 评论区的"表情包"：写 [大笑] [doge] [吃瓜]，B站会渲染成图
//   3. 图片表情          —— 只有 QQ/微信 能发：
//        · [表情:开心]      → ~/.feiyu-ai/stickers/开心/ 里随机一张（AI 画好的那套）
//        · [自制表情:困死了] → 当场用 PIL 画一张文字贴纸（不联网、不花额度）
//
// 图片目录：~/.feiyu-ai/stickers/<标签>/<任意名>.png|gif|webp
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homePath } from './paths.mjs'

export const STICKER_DIR = homePath('.feiyu-ai', 'stickers')

/** 内置兜底标签（文件夹空着也不影响 prompt 里出现这几个）。 */
export const DEFAULT_TAGS = ['开心', '无语', '委屈', '生气', '困', '比心']

/** B站评论区能渲染成图的表情码：内置这 16 个（已用真实账号核对，全部存在）。 */
export const BILI_FACES = [
  '大笑', '笑哭', 'doge', '吃瓜', '妙啊', '星星眼', '辣眼睛', '酸了',
  '疑惑', '惊喜', '委屈', '大哭', '点赞', '打call', '滑稽', '微笑',
]

// 完整名单（447 个）从 B站表情面板拉，缓存 24h；拉不到就用上面那 16 个
const FACE_CACHE = homePath('.feiyu-ai', 'bili-faces.json')

/** 读缓存；过期或没有就返回 null。 */
export function readFaceCache() {
  try {
    const j = JSON.parse(fs.readFileSync(FACE_CACHE, 'utf8'))
    if (Array.isArray(j.names) && j.names.length && Date.now() - Number(j.at) < 86400e3) return j.names
  } catch {}
  return null
}

/** 拿 B站表情码白名单（优先缓存 → 在线拉 → 内置兜底）。 */
export async function loadBiliFaces() {
  const cached = readFaceCache()
  if (cached) return cached
  try {
    const { loadCred, missingForWrite } = await import('./cred.mjs')
    const c = loadCred()
    if (missingForWrite(c).length) return BILI_FACES
    const cookie = `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3 || ''}`
    const r = await fetch('https://api.bilibili.com/x/emote/user/panel/web?business=reply', {
      headers: { cookie, 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
    })
    const j = await r.json()
    const names = []
    for (const pkg of (j?.data?.packages ?? [])) {
      for (const e of (pkg.emote ?? [])) {
        const t = String(e.text || '').replace(/^\[|\]$/g, '').trim()
        if (t && !names.includes(t)) names.push(t)
      }
    }
    if (!names.length) return BILI_FACES
    try { fs.writeFileSync(FACE_CACHE, JSON.stringify({ at: Date.now(), names })) } catch {}
    return names
  } catch {
    return BILI_FACES
  }
}

const IMG = /\.(png|jpe?g|gif|webp)$/i
const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.join(HERE, 'sticker_render.py')

/** 扫描本机表情包：返回 { 标签: [绝对路径...] }。 */
export function listStickers() {
  const out = {}
  let dirs = []
  try {
    dirs = fs.readdirSync(STICKER_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch { return out }
  for (const tag of dirs) {
    const dir = path.join(STICKER_DIR, tag)
    let files = []
    try { files = fs.readdirSync(dir).filter(f => IMG.test(f)).map(f => path.join(dir, f)) } catch { continue }
    if (files.length) out[tag] = files
  }
  return out
}

/** 可用标签（本机有图的优先；一张图都没有时退回内置标签，只走颜文字）。 */
export function availableTags() {
  // 自制 是渲染缓存目录，不算一个可选标签
  const have = Object.keys(listStickers()).filter(t => t !== '自制')
  return have.length ? have : DEFAULT_TAGS
}

/** 取某个标签的一张图；没有就返回 null。 */
export function pickSticker(tag, random = Math.random) {
  const files = listStickers()[tag]
  if (!files || !files.length) return null
  return files[Math.floor(random() * files.length) % files.length]
}

// [表情:开心] / 【表情：无语】
const MARK = /[[【]\s*表情\s*[:：]\s*([^\]】\s]{1,10})\s*[\]】]/g
// [自制表情:困死了] —— 里面允许空格和标点
const MAKE = /[[【]\s*自制表情\s*[:：]\s*([^\]】]{1,20})\s*[\]】]/g

/**
 * 从回复里摘出表情标记。
 * @returns {{text: string, tag: string|null, caption: string|null}}
 */
export function splitSticker(reply) {
  let tag = null
  let caption = null
  let text = String(reply || '')
  text = text.replace(MAKE, (_m, cap) => { if (!caption) caption = cap.trim(); return '' })
  text = text.replace(MARK, (_m, t) => { if (!tag && !caption) tag = t.trim(); return '' })
  return { text: text.replace(/[ \t]+\n/g, '\n').trim(), tag, caption }
}

/** 剥掉所有图片表情标记（评论用）。 */
export function toPlain(reply) {
  return splitSticker(reply).text
}

/** 去掉不在白名单里的 [xx] —— 只处理"像表情码"的短词，别误伤正常文字。 */
function stripUnknownFaces(text, allow) {
  const set = new Set(allow)
  return text.replace(/\[([^\[\]\s]{1,8})\]/g, (m, inner) => (set.has(inner) ? m : ''))
}

/** 按平台清洗：B站留白名单表情码；抖音只留 unicode emoji；QQ/微信原样。 */
export function sanitizeFor(platform, text, faces) {
  const base = toPlain(text)
  if (platform === 'bilibili') return stripUnknownFaces(base, faces || readFaceCache() || BILI_FACES).replace(/\s{2,}/g, ' ').trim()
  if (platform === 'douyin') return stripUnknownFaces(base, []).replace(/\s{2,}/g, ' ').trim()
  return base
}

/** 当场画一张文字贴纸，返回图片路径（失败返回 null）。 */
export function ensureSelfSticker(caption, cfg) {
  const cap = String(caption || '').trim().slice(0, 16)
  if (!cap) return null
  const dir = path.join(STICKER_DIR, '自制')
  const hash = crypto.createHash('md5').update(cap).digest('hex').slice(0, 12)
  const out = path.join(dir, hash + '.png')
  if (fs.existsSync(out)) return out
  const py = cfg?.wechat?.python
  if (!py || !fs.existsSync(py)) return null
  try {
    fs.mkdirSync(dir, { recursive: true })
    execFileSync(py, [RENDERER, cap, out], { timeout: 25000, stdio: 'ignore', windowsHide: true })
    return fs.existsSync(out) ? out : null
  } catch {
    return null
  }
}

/** 注入 prompt 的「发表情规矩」。 */
export function stickerPrompt(platform = 'qq') {
  const canImage = platform === 'qq' || platform === 'wechat'
  const tags = availableTags()
  const lines = ['【表情的规矩】聊得轻松时，**大约一半的回复要带一个颜文字或 emoji**（(๑•̀ㅂ•́)و✧ / 😴 / (・_・;) / 哈哈 / 嘿嘿）。别一句都不带，也别每句都带。']

  if (canImage) {
    lines.push(`情绪到点的时候，直接在回复句尾写 [表情:标签]（标签：${tags.join('/')}）发一张图，一次最多一个。`)
    lines.push('想要更贴的图就写 [自制表情:不超过八个字的短句]（比如 [自制表情:本鱼饿了]）——会现场画一张只属于这句话的专属表情包，勇敢用，图库还会越用越丰富。')
  } else if (platform === 'bilibili') {
    const live = readFaceCache() || BILI_FACES
    const faces = BILI_FACES.filter(f => live.includes(f)).slice(0, 10)   // 按精选顺序，别按面板顺序
    lines.push('这里是B站评论区，发不了图片，但可以用B站自带表情码，只能用这些：' +
      faces.map(f => `[${f}]`).join(' ') + '（一条最多一个，写在句尾自然的位置）。')
  } else {
    lines.push('这里是抖音评论区，只有 emoji 和颜文字，不要写 [xx] 这种方括号表情码，也不要用 [表情:…]。')
  }
  return lines.join('\n')
}

/** 没图时按标签给个颜文字兜底（发送失败降级用）。 */
export const FACE_FALLBACK = {
  开心: '(๑˃̵ᴗ˂̵)و', 无语: '(・_・;)', 委屈: '(｡•́︿•̀｡)',
  生气: '(╯°□°）╯', 困: '(－_－) zzZ', 比心: '(♡˙︶˙♡)',
}
