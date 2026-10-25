// sing —— 唱一首给主人听（命令行入口；QQ 里说"唱一首"也走同一管线）
//   node feiyu.mjs sing ["主题"]                        # 原创（说唱/旋律）
//   node feiyu.mjs sing cover "孙燕姿 天黑黑"           # 翻唱：搜源歌→分离→换她的声音→混伴奏
//   node feiyu.mjs sing cover "天黑黑" --url <音频直链或本地路径>   # 指定源（不搜索）
//   node feiyu.mjs sing songs                           # 看她学会了哪些歌（歌单）
import { sing } from '../lib/sing.mjs'
import { config } from '../lib/config.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }
const has = (argv, name) => argv.includes(name)

async function sendQQ(file, text) {
  const cfg = config()
  const ownerQQ = String(cfg.owner?.qq || '')
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) throw new Error('owner.qq 未配置')
  const r = await fetch(`${napcat}/send_private_msg`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'record', data: { file } }] }),
    signal: AbortSignal.timeout(60000),
  })
  if (r.ok && text) {
    await fetch(`${napcat}/send_private_msg`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'text', data: { text } }] }),
    }).catch(() => {})
  }
  return r.ok
}

export async function run(argv = []) {
  const sub = argv[0]

  if (sub === 'songs') {
    const { listSongs } = await import('../lib/cover.mjs')
    const songs = listSongs()
    console.log(`她的歌单（${songs.length} 首）：`)
    for (const s of songs) console.log(`  ${s.hasCover ? '🎤' : '⏳'} 《${s.title}》${s.hasCover ? '（会唱了）' : '（学了一半）'}`)
    if (!songs.length) console.log('  （空 —— sing cover "歌名" 教她第一首）')
    return
  }

  if (sub === 'cover') {
    const { coverSong } = await import('../lib/cover.mjs')
    const name = argv.slice(1).filter((a) => !a.startsWith('-') && a !== arg(argv, '--url') && a !== arg(argv, '--file')).join(' ').trim()
    const url = arg(argv, '--url')
    const file = arg(argv, '--file')
    const source = file || url || (name ? `ytsearch1:${name}` : '')
    if (!source) { console.log('用法：sing cover "歌名" [--url 链接 | --file 本地路径]'); return }
    console.log(`🎤 翻唱《${name || source}》（搜源→分离→换她的声音→混伴奏，首次约 3~8 分钟）…`)
    const t0 = Date.now()
    const song = await coverSong({ source, title: name, log: (l) => console.log('  ' + l) })
    console.log(`✓ 唱好了（${song.cache === 'hit' ? '歌单直接点唱' : Math.round((Date.now() - t0) / 60000) + ' 分钟学会'}）：${song.file}`)
    try {
      const ok = await sendQQ(song.file, `🎵 我学会唱《${song.title}》了——用我自己的声音哦～`)
      console.log(ok ? '✓ 已唱给主人 QQ' : '✗ 发送失败（NapCat 没起？音频在上面）')
    } catch (e) { console.log('✗ 发送失败：' + e.message) }
    return
  }

  const theme = argv.filter((a) => !a.startsWith('-') && a !== arg(argv, '--url')).join(' ').trim()
  const mode = argv.includes('--melody') ? 'melody' : 'rap'
  const cfg = config()
  const ownerQQ = String(cfg.owner?.qq || '')
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) { console.error('owner.qq 未配置'); process.exit(1) }
  console.log(theme ? `写一首关于「${theme}」的歌（${mode === 'melody' ? '旋律/WORLD歌声' : '说唱/节拍'}）…` : '自由发挥写一首…')
  const song = await sing(theme, mode)
  console.log(`《${song.title}》 ${song.bpm}bpm`)
  console.log(song.lyrics.map((l, i) => `  ${i + 1}. ${l}`).join('\n'))
  const ok = await sendQQ(song.file, `🎵《${song.title}》 ${song.bpm}bpm —— ${song.lyrics.join(' / ')}`)
  console.log(ok ? '✓ 已唱给主人 QQ' : '✗ 发送失败（音频在 ' + song.file + '）')
}

if (process.argv[1] && process.argv[1].endsWith('sing.mjs')) {
  await run(process.argv.slice(2))
}
