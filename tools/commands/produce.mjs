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
import { scoreWavs } from '../lib/prosody.mjs'
import { dataPath } from '../lib/paths.mjs'
import * as debut from '../lib/debut.mjs'
import * as V from '../lib/video.mjs'

const BRAND = '大肥鱼 · 一条住在主人电脑里的蓝鲸鱼娘'

function argVal(argv, k, d = '') {
  const i = argv.indexOf(k)
  if (i < 0) return d
  const v = argv[i + 1]
  // 后面紧跟另一个开关时不算取值（否则 `--reuse --keep-voices <目录>` 会把开关当成目录）
  return v === undefined || String(v).startsWith('--') ? d : v
}
function hasFlag(argv, k) {
  return argv.includes(k)
}
function probeDurOf(f) {
  try { return V.probeDur(f) } catch { return 0 }
}

// ── 配音：念一遍不够，得验一遍 ────────────────────────────────────────────────
// 主人 10-26 / 10-27 三次报同一件事：先"字幕和语音没对上、漏了很多字"，改参数重念后变成
// "电音、不是原来的声音"，10-27 又一次"还是机械和电音"。三轮查下来，教训写在这儿：
//   ① 漏字的真根因是**参考段**，不是采样：①文本没盖住音频（少一个字就早收尾）
//      ②音频里夹着大段死空气（bingjiao2 有 2.88 秒），模型条件被带偏。两件事都已在
//      `voice refcheck` / `voice refclean` 里做成前置 —— 别再用"多合几条碰运气"去盖。
//   ② **择优本身就是元凶**：prosody 打分偏爱"音域宽、F0 起伏大"的那条，
//      三条里最抖的一条永远赢 —— 听感就是电音/颤音。抖音那几条（10-25，主人认可的）
//      恰恰没有择优：一次一条、温度 1.0、只做很轻的响度处理。
//   ③ 所以视频配音现在的策略是**一次一条**：温度 1.0、不择优；没念全就重念（换运气，
//      不换音色参数）。speed_factor 永远是 1.0 —— 它是重采样，改了就是变调。
// 判据：去掉标点后的字/秒。她说中文的正常区间 3.0~6.2 字/秒；>6.2 基本就是句尾被吃了。
const RATE_OK = [2.4, 6.0]   // 情绪参考段的语气更慢，下限放到 2.4（2.4~3.5 是她的'温柔/撒娇'档）
const BATCHES = 4              // 最多重念 4 次
const PER_BATCH = 2            // 一次 2 条，按**保真度**选（音区贴参考段、不抖不噪），不是按"起伏大"选

/** 去掉标点后的"实际要念的字数"。 */
export function speakChars(line) {
  return String(line || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
}

/** 一句话的"念全了吗"体检：字/秒 + 句尾是否有自然收束（被切断的句尾能量反而高）。 */
export function judgeSpeech(file, chars) {
  const sp = V.speechSpan(file)
  const dur = Math.max(0.2, sp.off - sp.on)
  const rate = chars / dur
  const tailRatio = Number(sp.tailEnergyRatio ?? 0)
  const ok = rate >= RATE_OK[0] && rate <= RATE_OK[1]
  return { ok, rate, dur, span: sp, tailRatio, score: Math.abs(rate - 4.2) + Math.max(0, tailRatio - 1.2) }
}

/**
 * 合成 + 验 + 重挑，返回 {file, dur, rate, tries, forced?}。
 * **只动"多合几条"，不动音色参数** —— 这是上一版把声音搞成电音的根因。
 */
export async function synthChecked(line, out, { log = console.log, emotion = '' } = {}) {
  // 整条片子一个音色（音高才稳）。voice.videoEmotion 留空 = 用配置里的基础音色
  // （bingjiao2，244Hz）—— 参考段体检修好后它就是合格的，不需要再借情绪段。
  const emo = emotion || config().voice?.videoEmotion || ''
  const chars = speakChars(line)
  const finalize = (tmp) => {
    if (path.resolve(tmp) !== path.resolve(out)) fs.copyFileSync(tmp, out)
    for (const f of fs.readdirSync(path.dirname(out))) {
      if (!f.startsWith(path.basename(out) + '.')) continue
      if (f === path.basename(out)) continue
      try { fs.rmSync(path.join(path.dirname(out), f), { force: true }) } catch {}
    }
    return out
  }

  const best = { score: Infinity, tmp: '', judge: null }
  let tries = 0
  // 视频配音的采样参数：温度 1.0（模型自己的默认，最"老实"）、不择优、不改语速。
  // 想调只能动 voice.videoTemperature，别无他路 —— 免得又滑回"调参调出电音"。
  const vox = {
    candidates: PER_BATCH,
    pick: PER_BATCH > 1 ? 'best' : 'first',
    emotion: emo,
    temperature: Number(config().voice?.videoTemperature ?? 1.0),
    speed_factor: 1.0,
    text_split_method: 'cut0',
    fidelity: true,           // 保真打分：不抖不噪者胜（不是"起伏最大"者胜）
    registerRef: true,        // 并且拿参考段当音区锚（视频线要的是"整片同一个人"）
  }
  for (let b = 0; b < BATCHES; b++) {
    const tmp = `${out}.try${b}.wav`
    try {
      await synth(line, tmp, vox)
      tries++
    } catch (e) {
      log(`    ✗ 第 ${b + 1} 次合成失败：${String(e.message).slice(0, 40)}`)
      continue
    }
    const j = judgeSpeech(tmp, chars)
    if (j.ok && j.score < best.score) { best.score = j.score; best.tmp = tmp; best.judge = j }
    if (j.ok) {
      finalize(tmp)
      log(`    配音 ✓ ${chars} 字 / ${j.dur.toFixed(2)}s（${j.rate.toFixed(1)} 字/秒，第 ${b + 1} 次就念全）`)
      return { file: out, dur: j.dur, rate: j.rate, tries, span: j.span }
    }
    log(`    第 ${b + 1} 次没念全：${chars} 字 / ${j.dur.toFixed(2)}s = ${j.rate.toFixed(1)} 字/秒（>6.0 就是句尾被吃了）`)
  }

  // 拆两半分别念（音色参数一律不动，避免又出现"不是她的声音"）
  const parts = String(line).split(/(?<=[，。！？、；])/).filter((s) => s.trim())
  if (parts.length >= 2) {
    const mid = Math.ceil(parts.length / 2)
    const a = parts.slice(0, mid).join('')
    const b = parts.slice(mid).join('')
    try {
      const fa = `${out}.a.wav`
      const fb = `${out}.b.wav`
      await synth(a, fa, vox)
      await synth(b, fb, vox)
      concatWav([fa, fb], out, 0.12)
      const j = judgeSpeech(out, chars)
      log(`    拆两句念：${chars} 字 / ${j.dur.toFixed(2)}s = ${j.rate.toFixed(1)} 字/秒`)
      if (j.ok) {
        finalize(out)
        log('    配音 ✓（拆两句拼回来，音色没动）')
        return { file: out, dur: j.dur, rate: j.rate, tries: tries + 2, span: j.span }
      }
      if (j.score < best.score) { best.score = j.score; best.tmp = out; best.judge = j }
    } catch (e) { log('    ✗ 拆句合成失败：' + String(e.message).slice(0, 40)) }
  }

  if (!best.tmp) throw new Error('配音全部失败')
  finalize(best.tmp)
  log(`    ⚠ 这条只能凑合（${chars} 字 / ${best.judge.dur.toFixed(2)}s = ${best.judge.rate.toFixed(1)} 字/秒）—— 音色没动，只是念快了`)
  return { file: out, dur: best.judge.dur, rate: best.judge.rate, tries, forced: true, span: best.judge.span }
}

/**
 * 音区 + 糙音复检（10-27）：
 *  · 整片"同一个人"的客观判据是每句的主音高（半音，相对 220Hz）。同一参考、同一参数连合，
 *    音区能漂 4.7 半音（233Hz 对 308Hz）—— 听感就是"两句像两个人"。
 *    锚用**本片自己的中位音区**；不能拿参考段当锚（那是一句情绪很高的音声，比正常说话高 7 个半音，
 *    拿它锚会把整片往上拽，实测离散反而从 7.0 变 7.3）。
 *  · 第二个判据是 HNR（谐噪比 dB）：<2dB 的那条就是"机械/毛刺"的来源。实测同一句 5 条能拿到
 *    0.8~3.4dB，纯抽奖 —— 所以糙的也重念。
 *  两条都不满足才留着；每条最多 3 次，取综合最靠锚（音区差 ×1 + 糙度惩罚 ×0.6）的那条。
 */
export async function tuneRegister(scenes, { log = console.log, span = 1.2, hnrMin = 2.0, rounds = 6 } = {}) {
  const med = (arr) => {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y)
    if (!a.length) return NaN
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
  }
  const items = scenes.map((sc) => ({ path: sc.voice, chars: speakChars(sc.line), fidelity: true }))
  let sc0 = scoreWavs(items)
  let regs = sc0.map((s) => Number(s.st))
  let hnrs = sc0.map((s) => (Number.isFinite(Number(s.hnr)) ? Number(s.hnr) : NaN))
  const anchor = med(regs)
  if (!Number.isFinite(anchor)) return scenes
  const hz = (st) => Math.round(220 * 2 ** (st / 12))
  // 排序分：音区差**截到 3 半音**（超过 3 半音再往外拉，听感上区别不大，但拿糙音去换绝对不值），
  // 糙度权重给足（每缺 1dB 罚 2 分）。实测拿 0.5dB 的糙音换 1.3 半音的音区，人耳一票否决。
  const rank = (st, hnr) => {
    const d = Number.isFinite(st) ? Math.min(3, Math.abs(st - anchor)) : 3
    const h = Number.isFinite(hnr) ? hnr : hnrMin
    return d * 0.6 + Math.max(0, hnrMin - h) * 2.0
  }
  log(`    音区：${regs.map((v) => (Number.isFinite(v) ? v.toFixed(1) : '?')).join(' / ')} 半音，中位 ${anchor.toFixed(2)}（${hz(anchor)}Hz）`)
  log(`    糙度：${hnrs.map((v) => (Number.isFinite(v) ? v.toFixed(1) : '?')).join(' / ')} dB（HNR，低于 ${hnrMin} 重念）`)
  const vox = {
    candidates: 1, pick: 'first', temperature: Number(config().voice?.videoTemperature ?? 1.0),
    speed_factor: 1.0, text_split_method: 'cut0', emotion: config().voice?.videoEmotion || '', fidelity: true, registerRef: true,
  }
  for (let i = 0; i < scenes.length; i++) {
    const badReg = Number.isFinite(regs[i]) && Math.abs(regs[i] - anchor) > span
    const badHnr = Number.isFinite(hnrs[i]) && hnrs[i] < hnrMin
    if (!badReg && !badHnr) continue
    const sc = scenes[i]
    const out = sc.voice
    let bestSt = regs[i]
    let bestHnr = hnrs[i]
    let best = out
    log(`    第 ${i + 1} 句${badReg ? `音区偏 ${(regs[i] - anchor).toFixed(1)} 半音（${hz(regs[i])}Hz）` : ''}${badReg && badHnr ? '、' : ''}${badHnr ? `糙（HNR ${hnrs[i].toFixed(1)}dB）` : ''} → 重念`)
    for (let k = 0; k < rounds; k++) {
      const tmp = `${out}.reg${k}.wav`
      try {
        await synth(sc.line, tmp, vox)
        const j = judgeSpeech(tmp, speakChars(sc.line))
        const s = scoreWavs([{ path: tmp, chars: speakChars(sc.line), fidelity: true }])[0] || {}
        const st = Number(s.st)
        const hn = Number(s.hnr)
        if (!j.ok || !Number.isFinite(st)) { try { fs.rmSync(tmp, { force: true }) } catch {} ; continue }
        const better = rank(st, hn) < rank(bestSt, bestHnr) - 0.05 && !(Number.isFinite(hn) && hn < 1.0)
        if (better) {
          if (best !== out) { try { fs.rmSync(best, { force: true }) } catch {} }
          best = tmp
          bestSt = st
          bestHnr = hn
        } else { try { fs.rmSync(tmp, { force: true }) } catch {} }
        if (Math.abs(bestSt - anchor) <= span && !(Number.isFinite(bestHnr) && bestHnr < hnrMin)) break
      } catch (e) { log(`      ✗ 重念失败：${String(e.message).slice(0, 40)}`) }
    }
    if (best !== out) {
      fs.copyFileSync(best, out)
      try { fs.rmSync(best, { force: true }) } catch {}
      const sp = V.speechSpan(out)
      sc.voiceDur = Math.max(0.2, sp.off - sp.on)
      sc.rate = +(speakChars(sc.line) / sc.voiceDur).toFixed(2)
      sc.register = +bestSt.toFixed(2)
      sc.hnr = Number.isFinite(bestHnr) ? +bestHnr.toFixed(1) : undefined
      log(`      ✓ 换掉：${bestSt.toFixed(2)} 半音（${hz(bestSt)}Hz）/ HNR ${Number.isFinite(bestHnr) ? bestHnr.toFixed(1) : '?'}dB，${sc.rate} 字/秒`)
    }
  }
  return scenes
}

/** 数音节：中文一个字≈一个能量峰。比"字/秒"稳 —— 快慢不影响，吃掉半句会直接少一半峰。 */
export function countSyllables(file) {
  const sp = V.speechSpan(file)
  const dur = sp.off - sp.on
  if (!(dur > 0.08)) return 0
  const pcm = V.pcmForTest ? V.pcmForTest(file) : null
  // 直接读 16k 包络够了：音节切分用不到高频
  const env = V.envelopeForTest ? V.envelopeForTest(file, 0.01) : null
  if (!env) return 0
  const a = Math.round(sp.on / 0.01)
  const b = Math.round(sp.off / 0.01)
  const seg = env.slice(a, b + 1)
  if (seg.length < 5) return 0
  // 平滑（3 点移动平均），避免把同一个音的抖动数成两个峰
  const sm = seg.map((v, i) => (seg[i - 1] ?? v) * 0.25 + v * 0.5 + (seg[i + 1] ?? v) * 0.25)
  const peak = Math.max(...sm) || 1
  const th = peak * 0.22
  const minGap = Math.round(0.075 / 0.01)     // 两个音节至少隔 75ms
  let n = 0
  let last = -minGap
  for (let i = 0; i < sm.length; i++) {
    const isPeak = sm[i] > th && (i === 0 || sm[i] >= sm[i - 1]) && (i === sm.length - 1 || sm[i] >= sm[i + 1])
    if (isPeak && i - last >= minGap) { n++; last = i }
  }
  // 长元音/连读会把两个峰并成一个：按"每 0.19 秒至少一个音节"兜个底
  return Math.max(n, Math.round(dur / 0.19))
}

/** 按台词挑一个情绪参考（她的情绪档案全是她自己的录音，音色不会变）。
 *  视频线一律走情绪参考：默认那条参考段的文本配不上音频，用它每句都会念一半。 */
export function pickEmotion(line = '') {
  const s = String(line)
  const rules = [
    ['happy', /[笑哈嘿嘿]|开心|高兴|太好了|喜欢|爱|诶|耶|棒/],
    ['coquettish', /嘛|啦|呀|哼|人家|本鱼|撒娇|陪我/],
    ['wronged', /委屈|难过|低落|丧|伤心|不要|别走|可惜/],
    ['angry', /生气|恼|讨厌|气|不许|别叫|规矩/],
    ['shy', /害羞|脸红|羞|不好意思|别这样/],
    ['sleepy', /困|累|睡|懒|没精神|眼皮/],
    ['tender', /慢点|别急|认真|谢谢|主人|陪/],
  ]
  for (const [k, re] of rules) if (re.test(s)) return k
  return 'calm'
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
    // 把 bvid 落到投稿包里（10-27）：`replies` 回自己作品评论时靠它认投稿，
    // 不用去啃 space 接口（那条路第一次试就吃 412 熔断）。
    if (bvid && s?.dir) {
      try { fs.writeFileSync(path.join(s.dir, 'bvid.txt'), bvid) } catch {}
    }
    console.log(`🔓 首条已发布${bvid ? `（${bvid}）` : ''} —— produce 从此自由，想剪什么剪什么`)
    if (bvid) console.log(`   已记进投稿包：replies 会自动回这条下面别人的评论（任何类型）`)
    void s
    return
  }

  const platform = argVal(argv, '--platform', cfg.video?.platform || 'bili') === 'douyin' ? 'douyin' : 'bili'
  const spec = V.specOf(platform)
  const frames = Number(argVal(argv, '--frames', cfg.video?.frames ?? 2)) === 1 ? 1 : 2
  const bgmOpt = argVal(argv, '--bgm', cfg.video?.bgm || 'auto')
  const dry = hasFlag(argv, '--dry')
  const keepVoices = hasFlag(argv, '--keep-voices')
  // --reaudio：只重做音轨（画面/字幕沿用上一次的 visual.mp4）。改了配音/响度/BGM 但画面没动时用。
  const reAudio = hasFlag(argv, '--reaudio')
  const topic = argv.filter((a, i) => !a.startsWith('-') && !String(argv[i - 1] || '').startsWith('--')).join(' ').trim()

  const lockedDebut = platform === 'bili' && debut.locked()

  // 额度（那套额度模式：0 = 不限）
  const dayKey = new Date().toLocaleDateString('sv-SE')
  const capFile = dataPath(platform === 'bili' ? 'bili-produce.json' : 'douyin-produce.json')
  const capCfg = platform === 'bili' ? (cfg.video?.biliProduce || {}) : (cfg.douyin?.produce || {})
  const capState = (() => { try { return JSON.parse(fs.readFileSync(capFile, 'utf8')) } catch { return { day: '', count: 0 } } })()
  const capMax = Number(capCfg.dailyMax ?? 2)
  if (capCfg.enabled === false) { console.log(`${platform} 视频生产是关的（${platform === 'bili' ? 'video.biliProduce' : 'douyin.produce'}.enabled）`); return }
  // 重剪 / 不重念 / 强制 都不算额度：额度管的是"今天新剪几条"，不是"把同一条修好"
  const rebake = hasFlag(argv, '--force') || hasFlag(argv, '--reuse') || hasFlag(argv, '--keep-voices') || hasFlag(argv, '--reaudio')
  if (capMax > 0 && !rebake && capState.day === dayKey && Number(capState.count) >= capMax) {
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
    // --keep-voices：配音是抽奖，抽到满意的就别再抽了（改字幕/改画面/换 BGM 时只重剪）
    if (keepVoices && fs.existsSync(wav) && fs.statSync(wav).size > 4096) {
      const sp = V.speechSpan(wav)
      const dur = Math.max(0.2, sp.off - sp.on)
      const rate = speakChars(line) / dur
      if (RATE_OK[0] <= rate && rate <= RATE_OK[1]) {
        voice = { file: wav, dur, rate, tries: 0, kept: true }
        console.log(`    配音 ♻ 沿用已有（${speakChars(line)} 字 / ${dur.toFixed(2)}s，${rate.toFixed(1)} 字/秒）`)
      } else {
        console.log(`    配音 ♻ 已有那条不合格（${rate.toFixed(1)} 字/秒），重念`)
      }
    }
    if (!voice) try {
      voice = await synthChecked(line, wav, { log: console.log })
    } catch (e) { console.log('    ✗ 配音失败，这幕跳过：' + String(e.message).slice(0, 50)); continue }
    if (!voice?.dur) { console.log('    ✗ 配音时长读不到，这幕跳过'); continue }
    scenes.push({ img, img2, voice: voice.file, voiceDur: voice.dur, line, acting: sc.acting || '', rate: +voice.rate.toFixed(2), ttsTries: voice.tries })
  }
  if (scenes.length < 3) { console.error(`✗ 成片的幕数不够（只有 ${scenes.length} 幕），这次不做`); process.exit(1) }

  // ①½ 音区对齐：一条片子必须是"同一个人"——逐句量她的音区（相对 220Hz 的半音），
  //     和这条片子自己的中位音区差 > 1.2 半音的那几句**重念**，在几条里挑最靠中间的。
  //     为什么要按"本片中位"而不是按参考段：参考段是一句情绪很高的音声，它的音区比
  //     她正常说话高 7 个半音；拿它当锚会把整片往上拽（10-27 实测：拽完离散反而更大）。
  try {
    await tuneRegister(scenes, { log: console.log })
  } catch (e) { console.log('  音区对齐跳过（不影响成片）：' + String(e.message).slice(0, 60)) }

  // ② 剪
  console.log('🎞 剪辑中（运镜 → 转场 → 字幕 → 配乐）…')
  const res = await V.makeFilm({
    scenes, spec, dir,
    text: { title, brand: BRAND, outro: plan.outro || '明天见' },
    opts: { bgm: bgmOpt === 'none' ? null : (bgmOpt === 'auto' ? 'auto' : bgmOpt), mood: V.moodFor(scenes.map((s) => s.line).join('')), reuseVisual: reAudio },
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