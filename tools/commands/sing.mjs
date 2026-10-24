// sing —— 唱一首给主人听（命令行入口；QQ 里说"唱一首"也走同一管线）
//   node feiyu.mjs sing ["主题"]
import { sing } from '../lib/sing.mjs'
import { config } from '../lib/config.mjs'

export async function run(argv = []) {
  const theme = argv.filter(a => !a.startsWith('-')).join(' ').trim()
  const cfg = config()
  const ownerQQ = String(cfg.owner?.qq || '')
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) { console.error('owner.qq 未配置'); process.exit(1) }
  console.log(theme ? `写一首关于「${theme}」的歌…` : '自由发挥写一首…')
  const song = await sing(theme)
  console.log(`《${song.title}》 ${song.bpm}bpm`)
  console.log(song.lyrics.map((l, i) => `  ${i + 1}. ${l}`).join('\n'))
  const r = await fetch(`${napcat}/send_private_msg`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'record', data: { file: song.file } }] }),
    signal: AbortSignal.timeout(15000),
  })
  if (r.ok) {
    await fetch(`${napcat}/send_private_msg`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'text', data: { text: `🎵《${song.title}》 ${song.bpm}bpm —— ${song.lyrics.join(' / ')}` } }] }),
    }).catch(() => {})
    console.log('✓ 已唱给主人 QQ')
  } else console.log(`✗ 发送失败 HTTP ${r.status}（音频在 ${song.file}）`)
}

if (process.argv[1] && process.argv[1].endsWith('sing.mjs')) {
  await run(process.argv.slice(2))
}
