// sticker —— 表情包工坊：AI 生成一张入库（Pollinations 免费无 key，走本机 Clash 代理）。
// 生成完存进 ~/.feiyu-ai/stickers/<标签|自制>/，QQ/B站表情系统立刻能用它。
//
//   node feiyu.mjs sticker gen "本鱼饿了" [--tag 生气] [--send]
//   · --tag  → 生成"标签"样式存进标签目录（图库增长，以后 [表情:标签] 直接用）
//   · --send → 生成完顺手把图发给主人 QQ 看效果
import fs from 'node:fs'
import { generateStickerImage } from '../lib/imggen.mjs'
import { config } from '../lib/config.mjs'
import { pickSticker } from '../lib/stickers.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }
const has = (argv, name) => argv.includes(name)

async function sendToOwnerQQ(file) {
  const cfg = config()
  if (cfg.guard?.dryRun) { console.log('   （干跑 guard.dryRun：贴纸不发 QQ，图已经存进图库）'); return false }
  const ownerQQ = String(cfg.owner?.qq || '')
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) throw new Error('owner.qq 未配置')
  const r = await fetch(`${napcat}/send_private_msg`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'image', data: { file: 'file:///' + String(file).replace(/\\/g, '/') } }] }),
    signal: AbortSignal.timeout(15000),
  })
  return r.ok
}

export async function run(argv = []) {
  const sub = argv[0] || 'help'

  if (sub === 'gen') {
    const caption = String(argv[1] || '').trim()
    if (!caption || caption.startsWith('--')) {
      console.log('用法：sticker gen "表情文案" [--tag 标签] [--send]')
      return
    }
    const tag = has(argv, '--tag') ? arg(argv, '--tag') : ''
    if (tag) {
      const have = pickSticker(tag)
      if (have) { console.log(`标签「${tag}」图库已有现成的：${have}\n（还想画新的就换个文案再跑一次）`) }
    }
    console.log(`🎨 生成中：${caption}${tag ? `（标签 ${tag}）` : ''} —— LLM 译 prompt + flux 出图，约 10~40s`)
    const file = await generateStickerImage(caption, { tag: tag || undefined })
    if (!file) { console.error('✗ 生成失败（看 imageGen 配置 / 代理 7897 是否活着 / 今日额度）'); process.exit(1) }
    console.log(`✓ 已入库：${file}`)
    if (has(argv, '--send')) {
      try { console.log((await sendToOwnerQQ(file)) ? '✓ 已发主人 QQ 看效果' : '✗ 发送失败（NapCat 没起？）') }
      catch (e) { console.error('✗ 发送失败：' + e.message) }
    }
    return
  }

  console.log('用法：sticker gen "表情文案" [--tag 标签] [--send]')
}

if (process.argv[1] && process.argv[1].endsWith('sticker.mjs')) {
  await run(process.argv.slice(2))
}
