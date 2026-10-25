// produce —— 她的短视频生产管线（10-25 运营核心）：她策划→AI 配图→她的声音旁白→ffmpeg 成片。
// 最后一步留给主人：投稿包里有成片+标题+简介+标签，打开抖音上传粘贴即可（发布点击权在主人）。
//   node feiyu.mjs produce ["主题"]
// 素材来源：她的兴趣池/最近见闻 —— 她做的内容是她生活过的东西，不是无根生成。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from '../lib/config.mjs'
import * as memory from '../lib/memory.mjs'
import * as llm from '../lib/llm.mjs'
import { synth } from '../lib/tts.mjs'
import { dataPath } from '../lib/paths.mjs'

const FFM = () => config().rvc?.ffmpeg || 'D:/GPT-SoVITS/runtime/ffmpeg.exe'
const FFPROBE = 'D:/rvc/bin/ffprobe.exe'
const CURL = () => (fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl')

function sh(args, timeout = 120000) {
  execFileSync(FFM(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout, windowsHide: true })
}
function probe(f) {
  try { return Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) || 0 } catch { return 0 }
}

/** 文生图：硅基 Z-Image-Turbo（便宜快）优先，pollinations 兜底。返回图片文件路径。 */
async function text2img(prompt, out) {
  const ig = config().imageGen ?? {}
  const key = String(ig.api_key || '').trim()
  if (key) {
    try {
      const r = await fetch('https://api.siliconflow.cn/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'Tongyi-MAI/Z-Image-Turbo', prompt, image_size: '720x1280' }),
        signal: AbortSignal.timeout(120000),
      })
      if (r.ok) {
        const j = await r.json()
        const url = String(j?.images?.[0]?.url || '')
        if (url) {
          execFileSync(CURL(), ['-sS', '-m', '90', '-o', out, url], { timeout: 100000, windowsHide: true })
          if (fs.existsSync(out) && fs.statSync(out).size > 5000) return out
        }
      } else { console.log('  （硅基文生图 HTTP ' + r.status + '，落回 pollinations）') }
    } catch (e) { console.log('  （硅基文生图异常：' + String(e.message).slice(0, 60) + '）') }
  }
  const igProxy = ig.proxy || 'http://127.0.0.1:7897'
  execFileSync(CURL(), ['-sS', '-L', '-m', '150', '-x', igProxy, '-o', out,
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=720&height=1280&nologo=true&model=flux`],
    { timeout: 160000, windowsHide: true })
  return fs.existsSync(out) && fs.statSync(out).size > 5000 ? out : null
}

async function makePlan(topic) {
  const { personaText } = await import('../lib/persona.mjs')
  const persona = personaText()
  const interests = memory.loreInterests(4)
  const recent = memory.recent('qq:web-roam-self', 3).map((m) => String(m.content).slice(0, 40))
  const msgs = [
    { role: 'system', content: (persona ? persona.slice(0, 600) + '\n\n' : '')
      + '你是"大肥鱼"——一条开了自媒体账号的蓝鲸鱼娘 AI，要给自己策划一条抖音短视频（口播+配图形式）。'
      + '选题从你真实感兴趣的东西里来（下面素材），别做无根内容。只输出 JSON：'
      + '{"title":"视频标题，≤20字，有钩子","scenes":[{"img":"这一幕的英文文生图提示词（具体画面，9:16 竖构图）","line":"这一幕的中文口播台词，10~18字，口语"}],'
      + '"tags":["标签1","标签2","标签3"],"intro":"投稿简介，40字内"}。4~5 个 scenes，台词连起来是一条完整顺口的口播稿。' },
    { role: 'user', content: '素材（选题从这里来）：\n- 兴趣：' + interests.join('；').slice(0, 150)
      + (recent.length ? '\n- 刚在网上看的：' + recent.join('；').slice(0, 120) : '')
      + (topic ? '\n- 主人点的主题：' + topic : '') + '\n\n策划：' },
  ]
  const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 800 })
  const m = String(resp ?? '').match(/\{[\s\S]*\}/)
  if (!m) throw new Error('策划 JSON 解析失败')
  const plan = JSON.parse(m[0])
  if (!Array.isArray(plan.scenes) || plan.scenes.length < 3) throw new Error('分镜不足')
  return plan
}

export async function run(argv = []) {
  const topic = argv.filter((a) => !a.startsWith('-')).join(' ').trim()
  const cfg = config()
  if (cfg.douyin?.produce?.enabled === false) { console.log('douyin.produce.enabled 是关的'); return }

  console.log('🎬 策划中（选题/分镜/台词来自她的真实兴趣）…')
  const plan = await makePlan(topic)
  const slug = String(plan.title || 'untitled').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || String(Date.now())
  const dir = dataPath('douyin-posts', `${new Date().toLocaleDateString('sv-SE')}-${slug}`)
  fs.mkdirSync(dir, { recursive: true })
  console.log(`选题：《${plan.title}》· ${plan.scenes.length} 幕`)

  const segs = []
  for (const [i, sc] of plan.scenes.entries()) {
    console.log(`  [${i + 1}/${plan.scenes.length}] 配图+旁白：${sc.line}`)
    const img = await text2img(String(sc.img || plan.title).slice(0, 400) + ', vertical composition, high quality', path.join(dir, `img-${i}.jpg`))
    const wav = await synth(String(sc.line), path.join(dir, `line-${i}.wav`))
    if (!img || !fs.existsSync(wav)) { console.log('  ✗ 这幕素材失败，跳过'); continue }
    segs.push({ img, wav, dur: probe(wav) + 0.6 })
  }
  if (segs.length < 2) { console.error('✗ 有效分镜不足 2 幕，成片失败'); process.exit(1) }

  console.log('🎞 剪辑成片…')
  const segFiles = []
  for (const [i, s] of segs.entries()) {
    const seg = path.join(dir, `seg-${i}.mp4`)
    sh(['-loop', '1', '-i', s.img, '-i', s.wav, '-t', String(s.dur), '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,format=yuv420p', '-c:v', 'libx264', '-tune', 'stillimage', '-r', '24', '-c:a', 'aac', '-b:a', '128k', seg])
    segFiles.push(seg)
  }
  const listFile = path.join(dir, 'concat.txt')
  fs.writeFileSync(listFile, segFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'))
  const final = path.join(dir, 'video.mp4')
  sh(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', final])
  console.log(`✓ 成片：${final}（${Math.round(probe(final))}s）`)

  fs.writeFileSync(path.join(dir, '投稿说明.md'), [
    `# 《${plan.title}》投稿包`,
    '',
    `**主人操作**：打开抖音 → + → 相册选 video.mp4 → 粘贴简介 → 发布。`,
    '',
    `**简介**：${plan.intro || plan.title}`,
    `**标签**：${(plan.tags || []).map((t) => '#' + t).join(' ')}`,
    `**台词稿**：`,
    ...plan.scenes.map((sc, i) => `${i + 1}. ${sc.line}`),
  ].join('\n'))
  // 让主人立刻看到：弹资源管理器（桌面有「她的投稿包」常驻入口）
  try {
    const { spawn } = await import('node:child_process')
    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process explorer.exe "${dir}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {}
  console.log(`📦 投稿包就绪：${dir}（已弹窗；桌面「她的投稿包」常驻入口，等你点投稿）`)
}

if (process.argv[1] && process.argv[1].endsWith('produce.mjs')) {
  await run(process.argv.slice(2))
}
