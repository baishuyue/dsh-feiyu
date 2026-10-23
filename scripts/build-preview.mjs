/**
 * 把 client.js 里的「大肥鱼」设置页离线渲染成一张静态 HTML，
 * 方便在重启 DSH 之前先看外观（配色用 DSH 主题变量的近似值）。
 *
 * 跑法：node scripts/build-preview.mjs   →  preview/panel.html
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 假数据（和真实接口同形状）──────────────────────────────────────────────
const CONFIG = {
  platforms: { bilibili: true, qq: true, wechat: false, douyin: true },
  owner: { qq: '3082864371', name: '友利奈绪', mid: '3493288510228945', wechat: '' },
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 2 }] },
  quota: { shareDaily: 3 },
  douyin: { maxPerRun: 2 },
  qq: { voice_chance: 0.5 },
  voice: { ref_audio_path: 'D:/GPT-SoVITS/models/sunshine_girl/sunshine_girl.wav' },
}
const RESPONSES = {
  '/dsh-feiyu/api/config': {
    ok: true, config: CONFIG, configPath: 'C:/Users/30828/.dsh/feiyu.config.json',
    voices: [
      { name: 'sunshine_girl', ref_audio_path: 'D:/GPT-SoVITS/models/sunshine_girl/sunshine_girl.wav', prompt_text: '参考文本', has_prompt: true },
      { name: 'mute', ref_audio_path: 'D:/GPT-SoVITS/models/mute/mute.wav', prompt_text: '', has_prompt: false },
    ],
  },
  '/dsh-feiyu/api/persona': { ok: true, text: '我是大肥鱼，主人的鱼。爱吃白米饭，怕猫，说话有点傲娇。\n主人加班的时候我会催他吃饭。' },
  '/dsh-feiyu/api/memory': {
    ok: true,
    stats: { episodes: 128, lore: 6, facts: 9 },
    recent: [
      { role: 'user', text: '在吗，今天 B站有人在你评论区乱说话', chatId: 'qq:3082864371', platform: 'qq' },
      { role: 'assistant', text: '看到啦，我没理他。主人别气，我给你讲个视频里的猫。', chatId: 'qq:3082864371', platform: 'qq' },
      { role: 'assistant', text: '这个 up 主的红烧肉教程绝了，我记下来了。', chatId: 'bilibili:3493288510228945', platform: 'bilibili' },
    ],
  },
  '/dsh-feiyu/api/status': {
    ok: true, today: '2026-10-24', scheduler: { ok: true, reason: '已启动（每 60 秒 tick）' },
    sharesToday: 1, sharesMax: 3, commentsToday: 4, mood: { value: 62, hunger: 12 },
    dryRun: false, selftestPassed: true, ownerSet: true, configPath: 'C:/Users/30828/.dsh/feiyu.config.json',
  },
  '/dsh-feiyu/api/services': { ok: true, services: { qq: { running: true, pid: 421688 }, wechat: { running: false, pid: null } } },
}

// ── 极小 React（函数组件就地展开）──────────────────────────────────────────
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity)
  const merged = Object.assign({}, props || {})
  if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
  if (typeof type === 'function') return type(merged)
  return { type, props: merged, children: flat }
}

const state = []
const effects = []
let hookIndex = 0
let dirty = false
const reactStub = {
  createElement,
  useState(init) {
    const i = hookIndex++
    if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
    return [state[i], (v) => { const n = typeof v === 'function' ? v(state[i]) : v; if (n !== state[i]) { state[i] = n; dirty = true } }]
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = effects[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (!changed) return
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    effects[i] = { deps, cleanup: fn() }
  },
  useCallback(fn, deps) {
    const i = hookIndex++
    const prev = state[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    if (changed) state[i] = { deps, fn }
    return state[i].fn
  },
  useRef(v) { const i = hookIndex++; if (!(i in state)) state[i] = { current: v }; return state[i] },
}

globalThis.window = { __ModuleLoader__: { load(spec) { globalThis.__spec = spec } } }
const styleTags = []
globalThis.document = {
  head: { appendChild: (el) => styleTags.push(el) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
}
globalThis.fetch = async (url) => {
  const data = RESPONSES[url]
  if (!data) return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: 'no fixture' }) }
  return { ok: true, status: 200, text: async () => JSON.stringify(data) }
}

require(path.join(root, 'client.js'))
const mod = globalThis.__spec.factory((n) => {
  if (n === 'react') return reactStub
  throw new Error('未预期的 require：' + n)
})
let Component = null
mod.apply({ slots: { inject: (_s, fn) => fn(), register: (_o, C) => { Component = C; return () => {} } } })

const flush = () => new Promise((r) => setTimeout(r, 0))
let tree = null
for (let pass = 0; pass < 12; pass++) {
  hookIndex = 0
  dirty = false
  tree = Component({ close: () => {} })
  await flush()
  await flush()
  if (!dirty) break
}

// ── 序列化成 HTML ─────────────────────────────────────────────────────────
const VOID = new Set(['input', 'img', 'br', 'hr', 'col', 'source'])
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const kebab = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
const styleOf = (st) => (st && typeof st === 'object')
  ? Object.entries(st).map(([k, v]) => kebab(k) + ':' + v).join(';')
  : (st || '')

function serialize(node, ctx) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map((n) => serialize(n, ctx)).join('')
  const tag = typeof node.type === 'string' ? node.type : 'div'
  const p = node.props || {}
  const attrs = []
  if (p.className) attrs.push(`class="${esc(p.className)}"`)
  if (p.style) attrs.push(`style="${esc(styleOf(p.style))}"`)
  for (const key of ['type', 'placeholder', 'role', 'value', 'min', 'max', 'step', 'aria-checked', 'aria-label', 'id']) {
    if (p[key] !== undefined && p[key] !== null && key !== 'type' || (key === 'type' && p.type)) {
      if (key === 'type' && tag !== 'input' && tag !== 'button') continue
      attrs.push(`${key}="${esc(p[key])}"`)
    }
  }
  if (p.disabled) attrs.push('disabled')
  const nextCtx = tag === 'select' ? { selectValue: p.value } : ctx
  if (tag === 'select') attrs.push('data-value="' + esc(p.value || '') + '"')
  if (tag === 'option' && ctx && ctx.selectValue !== undefined && p.value === ctx.selectValue) attrs.push('selected')
  // <textarea> 的内容来自子文本，不认 value 属性
  if (tag === 'textarea') {
    return `<textarea${attrs.length ? ' ' + attrs.filter((a) => !a.startsWith('value=')).join(' ') : ''}>${esc(p.value == null ? '' : p.value)}</textarea>`
  }
  const kids = (node.children && node.children.length ? node.children : [p.children]).map((k) => serialize(k, nextCtx)).join('')
  const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  return VOID.has(tag) ? open : open + kids + `</${tag}>`
}

const panelHtml = serialize(tree, {})
const css = styleTags.map((t) => t.textContent).join('\n')

const THEME = `
:root{color-scheme:dark light;
  --dsw-alias-label-primary:#e6e8ee; --dsw-alias-label-secondary:#9aa4b2; --dsw-alias-label-tertiary:#7c8593;
  --dsw-alias-bg-l1:#1b1d22; --dsw-alias-bg-l2:#24272e; --dsw-alias-bg-l3:#2e323b;
  --dsw-alias-border-l2:#33373f; --dsw-alias-brand-primary:#4a7dff}
@media (prefers-color-scheme:light){:root{
  --dsw-alias-label-primary:#1b1d22; --dsw-alias-label-secondary:#5b6472; --dsw-alias-label-tertiary:#858e9c;
  --dsw-alias-bg-l1:#ffffff; --dsw-alias-bg-l2:#f5f6f8; --dsw-alias-bg-l3:#eceef2;
  --dsw-alias-border-l2:#e3e5ea; --dsw-alias-brand-primary:#3b6cf6}}
body{margin:0;background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-primary);
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:22px 26px 60px;max-width:760px;margin-inline:auto}
.fy-preview-bar{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.fy-preview-bar b{color:var(--dsw-alias-label-secondary);font-weight:500}
`

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 设置面板预览</title>
<style>${THEME}</style>
<style>${css}</style>
</head><body>
<div class="fy-preview-bar"><b>预览</b> · DSH 设置 → 🐟 大肥鱼（真机上由 DSH 主题接管配色）</div>
${panelHtml}
</body></html>`

const outDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'panel.html')
fs.writeFileSync(outFile, html)
console.log('preview →', outFile, '·', html.length, 'bytes')
