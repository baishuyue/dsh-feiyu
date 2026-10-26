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
import { concatWav } from '../lib/tts.mjs'
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

// ── 配音：念一遍不够，得验一遍 ────────────────────────────────────────────────
// 主人 10-26 报"字幕和语音没对上，漏了很多字"。实测那 7 句里有 4 句被 GPT-SoVITS
// 提前收尾：13 个字只念 1.07 秒（12.2 字/秒，人嘴做不到），字幕还挂着、声音早没了。
// 所以这里不是"合成完就用"，而是：量真实说话时长 → 算字/秒 → 不像人话就重合成
// （换温度/换切分/换建议语速），实在不行把句子拆成两半分别念再拼起来。
const CHARS_PER_SEC = [2.6, 7.0]     // 中文口播的合理区间（配她的情绪语速窗口，放宽一点）
const NICE_RATE = [4.2, 6.6]         // 直接收下的"像人话"区间

/** 去掉标点后的"实际要念的字数"。 */
export function speakChars(line) {
  return String(line || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
}

/**
 * 合成 + 校验 + 重试，返回 {file, dur, rate, tries, trimmed}。
 * dur 是**剪掉首尾静音后的真实语音时长**（字幕就按它对齐）。
 */
export async function synthChecked(line, out, { log = console.log } = {}) {
  const chars = speakChars(line)
  const want = chars / 5.0                        // 期望时长（5 字/秒 ≈ 她的正常语速）
  // 提前收尾的元凶多半是"语速太快/整句一口气" → 前几次专挑慢速+细切分去试
  const tweaks = [
    {},
    { speed_factor: 0.92 },
    { speed_factor: 0.9, text_split_method: 'cut5' },
    { temperature: 1.25, speed_factor: 0.9 },
    { temperature: 1.35, text_split_method: 'cut0', repetition_penalty: 1.25 },
    { speed_factor: 0.85, temperature: 0.95 },
  ]
  // 选中的那条落地成 out（留一份原始，排查"为什么这句这么念"时有用），临时 take 一律清掉
  const finalize = (tmp) => {
    if (path.resolve(tmp) !== path.resolve(out)) fs.copyFileSync(tmp, out)
    for (const f of fs.readdirSync(path.dirname(out))) {
      if (!f.startsWith(path.basename(out) + '.')) continue
      if (f === path.basename(out)) continue
      try { fs.rmSync(path.join(path.dirname(out), f), { force: true }) } catch {}
    }
    return out
  }
  let fallback = null
  for (const [k, tweak] of tweaks.entries()) {
    const tmp = `${out}.try${k}.wav`
    try {
      await synth(line, tmp, { candidates: 2, ...tweak })
    } catch (e) {
      log(`    ✗ 第 ${k + 1} 次合成失败：${String(e.message).slice(0, 40)}`)
      continue
    }
    const sp = V.speechSpan(tmp)
    const dur = Math.max(0.2, sp.off - sp.on)
    const rate = chars / dur
    if (rate >= NICE_RATE[0] && rate <= NICE_RATE[1]) {
      finalize(tmp)
      log(`    配音 ✓ ${chars} 字 / ${dur.toFixed(2)}s（${rate.toFixed(1)} 字/秒，第 ${k + 1} 次）`)
      return { file: out, dur, rate, tries: k + 1, span: sp }
    }
    const usable = rate >= CHARS_PER_SEC[0] && rate <= CHARS_PER_SEC[1]
    if (usable && (!fallback || Math.abs(rate - 5) < Math.abs(fallback.rate - 5))) fallback = { tmp, dur, rate, sp }
    log(`    配音偏了：${chars} 字 / ${dur.toFixed(2)}s = ${rate.toFixed(1)} 字/秒（第 ${k + 1} 次${usable ? '，先留着' : '，重来'}）`)
  }

  // 最后一招：拆两半念，再拼起来（提前收尾多是"一句太长/中途断气"引起的）
  const parts = String(line).split(/(?<=[，。！？、；])/).filter((s) => s.trim())
  if (parts.length >= 2) {
    const mid = Math.ceil(parts.length / 2)
    const a = parts.slice(0, mid).join('')
    const b = parts.slice(mid).join('')
    try {
      const fa = `${out}.a.wav`
      const fb = `${out}.b.wav`
      await synth(a, fa, { candidates: 2 })
      await synth(b, fb, { candidates: 2 })
      concatWav([fa, fb], out, 0.12)
      const sp = V.speechSpan(out)
      const dur = Math.max(0.2, sp.off - sp.on)
      const rate = chars / dur
      if (rate >= CHARS_PER_SEC[0] && rate <= CHARS_PER_SEC[1]) {
        log(`    配音 ✓ ${chars} 字 / ${dur.toFixed(2)}s（拆两句念，${rate.toFixed(1)} 字/秒）`)
        return { file: finalize(out), dur, rate, tries: tweaks.length + 1, span: sp }
      }
      if (!fallback || Math.abs(rate - 5) < Math.abs(fallback.rate - 5)) fallback = { tmp: out, dur, rate, sp }
      log(`    拆句重念还是偏（${rate.toFixed(1)} 字/秒）`)
    } catch (e) { log('    ✗ 拆句合成失败：' + String(e.message).slice(0, 40)) }
  }
  if (!fallback) throw new Error('配音全部失败')
  finalize(fallback.tmp)
  log(`    ⚠ 这条只能凑合（${chars} 字 / ${fallback.dur.toFixed(2)}s，期望 ≈${want.toFixed(1)}s，${fallback.rate.toFixed(1)} 字/秒）`)
  return { file: out, dur: fallback.dur, rate: fallback.rate, tries: tweaks.length + 1, forced: true, span: fallback.sp }
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

  // --reuse <包目录>：不重新策划、不重新生图，只重做配音和剪辑。
  // 用途很实在：图没毛病但配音/字幕有问题时，重剪一次不该再花一次生图钱。
  const reuseDir = argVal(argv, '--reuse', '')
  let plan
  let dir
  let title
  if (reuseDir) {
    dir = path.resolve(reuseDir)
    const planFile = path.join(dir, 'plan.json')
    const metaFile = path.join(dir, 'meta.json')
    if (fs.existsSync(planFile)) {
      plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    } else if (fs.existsSync(metaFile)) {
      // 老包里没有 plan.json（早期版本只写 meta）—— 用 meta 反推一个够用的策划：
      // 重剪只用得到 title/台词/标签/简介，画面和分镜原样不动。
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      plan = {
        title: m.title || 'untitled',
        intro: m.intro || m.title || '',
        tags: m.tags || [],
        cover: m.title || 'untitled',
        scenes: (m.scenes || []).map((line) => ({ acting: '', line, shot: '中' })),
        outro: '明天见',
        rebuiltFromMeta: true,
      }
      console.log('ℹ 这包是老版本（只有 meta.json），已从 meta 反推台词表')
    } else {
      console.error(`✗ 这包里既没有 plan.json 也没有 meta.json，没法重剪：${dir}`)
      process.exit(1)
    }
    title = String(plan.title || 'untitled').slice(0, 40)
    console.log(`♻ 重剪现有投稿包：${path.basename(dir)}`)
    if (lockedDebut) {
      const chk = debut.check(plan)
      if (!chk.ok) { console.error(`✗ 这个包不满足首条要求（缺：${chk.missing.join('、')}），不能当首条`); process.exit(1) }
    }
  } else {
    console.log(`🎬 策划中（${spec.label} ${spec.w}×${spec.h} · ${frames} 帧/幕 · 她的真实兴趣选题）…`)
    plan = await makePlan({ topic, platform, lockedDebut })
    title = String(plan.title || 'untitled').slice(0, 40)
    const slug = title.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || String(Date.now())
    dir = path.join(V.postsDir(platform), `${dayKey}-${slug}`)
    fs.mkdirSync(dir, { recursive: true })
  }
  console.log(`选题：《${title}》· ${plan.scenes.length} 幕${plan.cover ? ` · 封面「${plan.cover}」` : ''}`)
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2))
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
    let img2 = path.join(dir, `img-${i}b.jpg`)
    if (reuseDir) {
      // 重剪模式：图是现成的，只用管配音
      if (!fs.existsSync(img)) { console.log('    ✗ 这幕没有图，跳过'); continue }
      if (!fs.existsSync(img2) || fs.statSync(img2).size < 1024) img2 = ''
      console.log('    画面 ♻ 沿用已有配图')
    } else {
      try {
        await shootScene({ acting: sc.acting || line, out: img })
      } catch (e) {
        console.log('    ✗ 配图失败（' + String(e.message).slice(0, 40) + '），这幕跳过'); continue
      }
      if (frames === 2) {
        try {
          // 同一幕的第二帧：换个动作/表情 —— 幕内交叉淡入，画面就"活"了
          await shootScene({ acting: `${sc.acting || line}（同一场景，换一个动作或表情，保持构图和光线一致）`, out: img2, seedNote: '这是同一镜头的第二帧。' })
          if (!fs.existsSync(img2) || fs.statSync(img2).size < 1024) img2 = ''
        } catch { img2 = '' }
      } else img2 = ''
    }
    const wav = path.join(dir, `line-${i}.wav`)
    let voice = null
    try {
      voice = await synthChecked(line, wav, { log: console.log })
    } catch (e) { console.log('    ✗ 配音失败，这幕跳过：' + String(e.message).slice(0, 50)); continue }
    if (!voice?.dur) { console.log('    ✗ 配音时长读不到，这幕跳过'); continue }
    scenes.push({ img, img2, voice: voice.file, voiceDur: voice.dur, line, acting: sc.acting || '', rate: +voice.rate.toFixed(2), ttsTries: voice.tries })
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