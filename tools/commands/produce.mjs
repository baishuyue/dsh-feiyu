// produce —— 她的视频生产管线（第 17 轮升级：静图+旁白 → 真剪辑的片子）。
//
//   node feiyu.mjs produce ["主题"] [--platform bili|douyin] [--frames 1|2] [--bgm auto|none|<wav>] [--dry]
//   node feiyu.mjs produce --debut-posted [BV号]      # 首条发出去了，解锁
//   node feiyu.mjs produce --debut                     # 看首条锁的状态
//
// 一条片子怎么来的（细节在 tools/lib/video.mjs 顶上）：
//   策划（她自己的兴趣/见闻 → 分镜+台词）→ 每幕生图（1~2 帧）→ 逐句 TTS 配音
//   → 运镜镜头 → 幕间转场 → 逐句烧字幕 → 合成 BGM 侧链避让 → 片头/片尾卡 → 1080p 成片 + 封面
//
// B站首条被主人锁死成「自我介绍 + 第一天来B站 + 账号归她运营 + 自由发挥」（tools/lib/debut.mjs），
// 发过之后自动解锁。发出去的点击永远归主人：这里只出投稿包。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { config } from '../lib/config.mjs'
import * as memory from '../lib/memory.mjs'
import * as llm from '../lib/llm.mjs'
import { synth } from '../lib/tts.mjs'
import { dataPath } from '../lib/paths.mjs'
import * as debut from '../lib/debut.mjs'
import * as V from '../lib/video.mjs'

const BRAND = '大肥鱼 · 一条住在主人电脑里的蓝鲸鱼娘'

function argVal(argv, k, d = '') {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}
function hasFlag(argv, k) {
  return argv.includes(k)
}
function probeDurOf(f) {
  try { return V.probeDur(f) } catch { return 0 }
}

// ── 策划 ────────────────────────────────────────────────────────────────────
async function makePlan({ topic, platform, lockedDebut }) {
  const { personaText } = await import('../lib/persona.mjs')
  const persona = personaText()
  const interests = memory.loreInterests(4)
  const recent = memory.recent('qq:web-roam-self', 3).map((m) => String(m.content).slice(0, 40))
  const where = platform === 'bili' ? 'B站' : '抖音'
  const system = (persona ? persona.slice(0, 600) + '\n\n' : '')
    + `你是"大肥鱼"——一条开了自媒体账号的蓝鲸鱼娘 AI，要给自己策划一条${where}视频。\n`
    + '**主角必须是你自己的鲸鱼娘形象**（参考图那个蓝发鱼尾少女）：每一幕都是她在画面里演绎内容，第一人称叙事，她的表情动作是戏。\n'
    + '选题从你真实感兴趣的东西里来（下面素材），别做无根内容。\n'
    + '只输出 JSON：\n'
    + '{"title":"视频标题，≤20字，有钩子","scenes":[{"acting":"这一幕鲸鱼娘在做什么：动作+表情+剧情（中文，如：系着围裙笨拙地拆螃蟹，满手是黄，眼睛瞪圆）",'
    + '"line":"这一幕的中文口播台词，10~18字，口语","shot":"远/中/近 (可选)"}],'
    + '"tags":["标签1","标签2","标签3"],"intro":"投稿简介，40字内",'
    + '"cover":"封面上的大字，≤10字"}\n'
    + '5~7 个 scenes。**台词铁律：必须以「本鱼」第一人称**——鱼的视角（游/泡水里/鱼尾/鳃）、鱼的生活（白饭/主人/刷视频）、'
    + '带傲娇小情绪，像她对镜头说话。台词连起来是一条完整顺口的口播稿。'
  const user = [
    '素材（选题从这里来）：',
    '- 兴趣：' + interests.join('；').slice(0, 150),
    recent.length ? '- 刚在网上看的：' + recent.join('；').slice(0, 120) : '',
    topic ? '- 主人点的主题：' + topic : '',
    lockedDebut ? '\n' + debut.DEBUT_BRIEF : '',
    '\n策划：',
  ].filter(Boolean).join('\n')

  let plan = null
  for (let attempt = 1; attempt <= (lockedDebut ? 3 : 1); attempt++) {
    const resp = await llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: lockedDebut ? 0.8 : 0.95, max_tokens: 1000 })
    const m = String(resp ?? '').match(/\{[\s\S]*\}/)
    if (!m) throw new Error('策划 JSON 解析失败')
    plan = JSON.parse(m[0])
    if (!Array.isArray(plan.scenes) || plan.scenes.length < 3) throw new Error('分镜不足')
    if (!lockedDebut) break
    const chk = debut.check(plan)
    if (chk.ok) break
    console.log(`  首条剧本缺了「${chk.missing.join('、')}」，重写（第 ${attempt} 次）…`)
    plan = null
  }
  if (!plan) throw new Error('首条剧本连续几次都没讲到「自我介绍 / 第一天来B站 / 账号归我运营」，先别发')
  return plan
}

// ── 生图（每幕 1~2 帧：两帧才有"动"的感觉）───────────────────────────────────
async function shootScene({ acting, out, seedNote }) {
  const { editImage } = await import('../lib/imggen.mjs')
  await editImage({ instruction: `演绎这一幕：${String(acting).slice(0, 90)}。${seedNote || ''}构图带一点剧情感`, out })
  return out
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
export async function run(argv = []) {
  const cfg = config()

  // 首条锁的两个开关
  if (hasFlag(argv, '--debut')) {
    console.log('🎬 首条状态：' + debut.describe())
    return
  }
  if (hasFlag(argv, '--debut-posted')) {
    const bvid = String(argv[argv.indexOf('--debut-posted') + 1] || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || ''
    const s = debut.markPosted({ bvid })
    console.log(`🔓 首条已发布${bvid ? `（${bvid}）` : ''} —— produce 从此自由，想剪什么剪什么`)
    void s
    return
  }

  const platform = argVal(argv, '--platform', cfg.video?.platform || 'bili') === 'douyin' ? 'douyin' : 'bili'
  const spec = V.specOf(platform)
  const frames = Number(argVal(argv, '--frames', cfg.video?.frames ?? 2)) === 1 ? 1 : 2
  const bgmOpt = argVal(argv, '--bgm', cfg.video?.bgm || 'auto')
  const dry = hasFlag(argv, '--dry')
  const topic = argv.filter((a, i) => !a.startsWith('-') && !String(argv[i - 1] || '').startsWith('--')).join(' ').trim()

  const lockedDebut = platform === 'bili' && debut.locked()

  // 额度（那套额度模式：0 = 不限）
  const dayKey = new Date().toLocaleDateString('sv-SE')
  const capFile = dataPath(platform === 'bili' ? 'bili-produce.json' : 'douyin-produce.json')
  const capCfg = platform === 'bili' ? (cfg.video?.biliProduce || {}) : (cfg.douyin?.produce || {})
  const capState = (() => { try { return JSON.parse(fs.readFileSync(capFile, 'utf8')) } catch { return { day: '', count: 0 } } })()
  const capMax = Number(capCfg.dailyMax ?? 2)
  if (capCfg.enabled === false) { console.log(`${platform} 视频生产是关的（${platform === 'bili' ? 'video.biliProduce' : 'douyin.produce'}.enabled）`); return }
  if (capMax > 0 && capState.day === dayKey && Number(capState.count) >= capMax) {
    console.log(`⏭ 今天已经剪了 ${capState.count}/${capMax} 条，够了`)
    return
  }

  if (lockedDebut) console.log('🔒 首条还没发：这次只能做「自我介绍 + 第一天来B站 + 账号归我运营」')
  console.log(`🎬 策划中（${spec.label} ${spec.w}×${spec.h} · ${frames} 帧/幕 · 她的真实兴趣选题）…`)
  const plan = await makePlan({ topic, platform, lockedDebut })
  const title = String(plan.title || 'untitled').slice(0, 40)
  const slug = title.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || String(Date.now())
  const dir = path.join(V.postsDir(platform), `${dayKey}-${slug}`)
  fs.mkdirSync(dir, { recursive: true })
  console.log(`选题：《${title}》· ${plan.scenes.length} 幕${plan.cover ? ` · 封面「${plan.cover}」` : ''}`)
  if (dry) {
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2))
    console.log('（--dry：只出策划，不出片）'); return
  }

  // ① 素材：图 + 配音
  const scenes = []
  for (const [i, sc] of plan.scenes.entries()) {
    const line = String(sc.line || '').trim()
    if (!line) continue
    console.log(`  [${i + 1}/${plan.scenes.length}] ${sc.acting || line}`)
    const img = path.join(dir, `img-${i}.jpg`)
    try {
      await shootScene({ acting: sc.acting || line, out: img })
    } catch (e) {
      console.log('    ✗ 配图失败（' + String(e.message).slice(0, 40) + '），这幕跳过'); continue
    }
    let img2 = ''
    if (frames === 2) {
      img2 = path.join(dir, `img-${i}b.jpg`)
      try {
        // 同一幕的第二帧：换个动作/表情 —— 幕内交叉淡入，画面就"活"了
        await shootScene({ acting: `${sc.acting || line}（同一场景，换一个动作或表情，保持构图和光线一致）`, out: img2, seedNote: '这是同一镜头的第二帧。' })
        if (!fs.existsSync(img2) || fs.statSync(img2).size < 1024) img2 = ''
      } catch { img2 = '' }
    }
    const wav = path.join(dir, `line-${i}.wav`)
    try { await synth(line, wav) } catch (e) { console.log('    ✗ 配音失败，这幕跳过'); continue }
    const voiceDur = probeDurOf(wav)
    if (!voiceDur) { console.log('    ✗ 配音时长读不到，这幕跳过'); continue }
    scenes.push({ img, img2, voice: wav, voiceDur, line, acting: sc.acting || '' })
  }
  if (scenes.length < 3) { console.error(`✗ 成片的幕数不够（只有 ${scenes.length} 幕），这次不做`); process.exit(1) }

  // ② 剪
  console.log('🎞 剪辑中（运镜 → 转场 → 字幕 → 配乐）…')
  const res = await V.makeFilm({
    scenes, spec, dir,
    text: { title, brand: BRAND, outro: plan.outro || '明天见' },
    opts: { bgm: bgmOpt === 'none' ? null : (bgmOpt === 'auto' ? 'auto' : bgmOpt), mood: V.moodFor(scenes.map((s) => s.line).join('')) },
    log: (m) => console.log(m),
  })

  // ③ 封面
  const cover = path.join(dir, 'cover.jpg')
  try {
    V.makeCover({ img: scenes[0].img, out: cover, title: plan.cover || title, brand: '大肥鱼', spec })
  } catch (e) { console.log('  ✗ 封面失败（成片不受影响）：' + String(e.message).slice(0, 60)) }

  // ④ 投稿包
  const meta = {
    platform,
    title,
    intro: plan.intro || title,
    tags: (plan.tags || []).slice(0, 10),
    cover: fs.existsSync(cover) ? cover : '',
    durationSec: Math.round(res.dur),
    sizeMB: +(fs.statSync(res.final).size / 1024 / 1024).toFixed(1),
    resolution: `${spec.w}x${spec.h}`,
    subtitle: res.assPath,
    scenes: scenes.map((s) => s.line),
    debut: lockedDebut,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  fs.writeFileSync(path.join(dir, '投稿说明.md'), renderPostDoc({ meta, plan, platform, cfg }))

  // ⑤ 首条锁：投稿包就绪 → ready（还没解锁，等主人点发布）
  if (lockedDebut) {
    debut.markReady({ title, dir })
    console.log('🔒 首条投稿包已就绪：发布之后跑 `feiyu produce --debut-posted BV号` 才解锁（在那之前只能继续做自我介绍）')
  }

  try { fs.writeFileSync(capFile, JSON.stringify({ day: dayKey, count: (capState.day === dayKey ? Number(capState.count) : 0) + 1 })) } catch {}
  try {
    const { spawn } = await import('node:child_process')
    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process explorer.exe "${dir}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {}
  console.log(`📦 投稿包：${dir}`)
  console.log(`   《${title}》${meta.durationSec}s · ${meta.resolution} · ${meta.sizeMB}MB · ${scenes.length} 幕`)
}

// ── 投稿包说明（B站/抖音字段不同，别让人猜）─────────────────────────────────
export function renderPostDoc({ meta, plan, platform, cfg }) {
  const tags = (meta.tags || []).map((t) => String(t).replace(/^#/, ''))
  if (platform === 'bili') {
    const tid = cfg.video?.bili?.tid ?? 21
    const tname = cfg.video?.bili?.tname || '生活·日常'
    return [
      `# 《${meta.title}》B站投稿包`,
      '',
      `**成片**：video.mp4（${meta.durationSec}s · ${meta.resolution} · ${meta.sizeMB}MB）`,
      `**封面**：cover.jpg（${meta.resolution}，投稿页点「上传封面」）`,
      `**字幕**：subtitle.ass（想要可编辑字幕就先转 srt：` + '`ffmpeg -i video.mp4 -vn sub.srt`' + `）`,
      '',
      '## 直接抄的字段',
      '',
      '| 字段 | 内容 |',
      '|---|---|',
      `| 标题 | ${meta.title} |`,
      `| 分区 | ${tname}（tid=${tid}） |`,
      `| 标签 | ${tags.join(' / ')} |`,
      `| 简介 | ${meta.intro} |`,
      '',
      '**简介完整版（连同标签一起粘）**：',
      '```',
      meta.intro || meta.title,
      '',
      tags.map((t) => '#' + t).join(' '),
      '```',
      '',
      '## 发布步骤（点击归主人）',
      '1. B站 → 投稿 → 上传视频 → 选 video.mp4',
      `2. 封面选 cover.jpg；标题/分区/标签/简介照上表粘`,
      '3. 简介末尾勾「自制」，转载/二创都不用勾',
      `4. 发布时间建议：${suggestSlot()}`,
      '',
      meta.debut ? '> ⚠️ 这是**首条**：发完记得跑 `feiyu produce --debut-posted <BV号>` 解锁，之后想剪什么剪什么。' : '',
      '',
      '## 台词稿',
      ...meta.scenes.map((l, i) => `${i + 1}. ${l}`),
    ].filter((x) => x !== '').join('\n')
  }
  return [
    `# 《${meta.title}》抖音投稿包`,
    '',
    `**成片**：video.mp4（${meta.durationSec}s · ${meta.resolution} · ${meta.sizeMB}MB）`,
    `**封面**：cover.jpg`,
    '',
    `**简介**：${meta.intro}`,
    `**标签**：${tags.map((t) => '#' + t).join(' ')}`,
    '',
    '**发布**：抖音 → + → 相册选 video.mp4 → 粘贴简介 → 发布',
    '',
    '## 台词稿',
    ...meta.scenes.map((l, i) => `${i + 1}. ${l}`),
  ].join('\n')
}

function suggestSlot() {
  const h = new Date().getHours()
  if (h < 12) return '今晚 19:00–22:00（B站晚间流量最高）'
  if (h < 19) return '今天 19:00–22:00'
  return '今晚就发（21:00–23:00 还在流量尾巴上）'
}

if (process.argv[1] && process.argv[1].endsWith('produce.mjs')) {
  await run(process.argv.slice(2))
}