// selftest —— 启动体检：装完立刻跑这一条（bili-whale 实战里"绝大多数人卡住的地方"）。
// 检查：配置 / 凭据 / 格式 / 登录态（真打一次 nav）/ 数据目录可写 / 熔断状态 / ffmpeg（可选）。
// 通过后写 ~/.feiyu-ai/selftest-passed.json，结尾打印"接下来要做的两件事"。
//
//   node feiyu.mjs selftest [--json]
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { configPath, dataPath, credentialsPath, WORK_DIR, diaryPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { apiGet, makeHeaders, apiState } from '../lib/bili-api.mjs'
import { loadCred, looksLikeJct } from '../lib/cred.mjs'

export async function run(argv = []) {
  const json = argv.includes('--json')
  const items = []

  const add = (name, ok, detail) => items.push({ name, ok: !!ok, detail: String(detail ?? '') })

  // ① 配置文件
  const cfg = config()
  add('配置文件', true, `${configPath}${cfg.__hasUserFile ? '（已自定义）' : '（用默认值 —— 也可以，但建议写一份）'}`)

  // ② 凭据文件
  let cred = null
  try {
    cred = loadCred()
    const problems = []
    if (!cred.sessdata) problems.push('SESSDATA 空着')
    if (!cred.bili_jct) problems.push('bili_jct 空着')
    else if (!looksLikeJct(cred.bili_jct)) problems.push(`bili_jct 格式可疑（${cred.bili_jct.length} 位，应是 32 位十六进制）`)
    if (!cred.buvid3) problems.push('buvid3 空着（可选，但建议带上）')
    add('凭据文件', !problems.length, problems.length ? problems.join('；') : `已就绪：${credentialsPath}`)
  } catch (e) {
    add('凭据文件', false, e.message)
  }

  // ③ 登录态（真打一次 nav —— 缓存 10 分钟）+ 凭据账号身份检查
  let self = null
  if (cred?.sessdata) {
    try {
      // ⚠️ 登录态一律不吃缓存：10-25 实锤 —— 缓存让人以为还登着主人的号，
      //    实际凭据早已换成养号（改了凭据但 nav 命中旧缓存 → 体检谎报身份 → 判断全歪）。
      const res = await apiGet('https://api.bilibili.com/x/web-interface/nav', makeHeaders(cred), { noCache: true })
      if (Number(res?.code) === 0 && res.data?.isLogin) {
        self = { mid: String(res.data.mid), name: String(res.data.uname) }
        add('B站 登录态', true, `已登录：${self.name}（mid ${self.mid}）`)
        // 防呆：凭据必须是鱼自己的小号。用主人的号发「@主人」= 主人 @ 自己，永远收不到通知
        // （10-24 实锤：评论发出且公开可见，主人却毫无感知）。
        const ownerMid = String(cfg.owner?.mid ?? '')
        if (ownerMid && self.mid === ownerMid) {
          add('凭据账号', false, `现在登录的是主人自己的号（${self.name}）—— 鱼用它 @ 主人 = 自己 @ 自己，B站不发通知！`
            + ` 请在浏览器登录鱼的号（御坂美琴Rosie）后重新提交凭据`)
        } else {
          add('凭据账号', true, `鱼的号：${self.name} —— 分享 @ 主人（${cfg.owner?.name ?? '?'}）会真正弹通知`)
        }
      } else {
        add('B站 登录态', false, `未登录：${res?.message ?? 'nav 未返回登录态'} —— SESSDATA 大概率复制时截断，双击 Value 全选再复制`)
      }
    } catch (e) { add('B站 登录态', false, e.message) }
  } else add('B站 登录态', false, '没有 SESSDATA，跳过')

  // ④ 数据目录可写（记忆/账本/情绪都住这里）
  try {
    fs.mkdirSync(dataPath(), { recursive: true })
    const probe = dataPath('.write-probe')
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe)
    add('数据目录', true, dataPath())
  } catch (e) { add('数据目录', false, e.message) }

  // ⑤ 工作目录（会话 cwd + 两本日记）
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true })
    add('工作目录', true, `${WORK_DIR}（日记：${diaryPath('owner').split(/[\\/]/).pop()} + ${diaryPath('private').split(/[\\/]/).pop()}）`)
  } catch (e) { add('工作目录', false, e.message) }

  // ⑥ node 运行时（自证：本命令正在 node 里跑）
  add('node 运行时', true, `v${process.versions.node}（selftest 正在用它跑）`)

  // ⑦ ffmpeg（可选 —— 只有将来的"抽帧看画面"要它，v0.1 不用）
  let ffmpeg = false
  try { execFileSync('ffmpeg', ['-version'], { timeout: 8000, windowsHide: true }); ffmpeg = true } catch {}
  add('ffmpeg（可选）', true, ffmpeg ? '已安装（v0.2 抽帧可用）' : '未安装 —— 不影响 v0.1，想要就 winget install Gyan.FFmpeg')

  // ⑧ 熔断状态
  const api = apiState()
  add('B站接口状态', !api.banned, api.banned ? `熔断中（${api.banWhy}），约剩 ${api.banMinutesLeft} 分钟 —— 撞风控了，等它自己恢复` : `正常（缓存 ${api.cacheEntries} 条）`)

  // ⑨ 主人信息（分享 @ 的对象）
  const ownerOk = !!(cfg.owner?.mid && cfg.owner?.name)
  add('主人信息', ownerOk, ownerOk ? `${cfg.owner.name}（mid ${cfg.owner.mid}）—— 分享评论会 @ TA` : 'owner.mid / owner.name 没填 —— @ 不了人，务必补上')

  // ⑩ 干跑状态（dafeiyu 铁律：第一周 DRY_RUN）
  add('风控模式', true, cfg.guard?.dryRun ? 'DRY_RUN 开着 ✓ —— 所有发送只打印不真发，观察满意后改 false' : '⚠️ DRY_RUN 已关 —— 真发了，注意额度与风控')

  // ── 可选平台依赖（不影响 B站核心体检；缺了 B站那条线照常用）─────────────
  // ⑪ LLM 直连（QQ/抖音实时响应用）
  const hasLLMKey = !!(process.env.DEEPSEEK_API_KEY || cfg.llm?.api_key)
  add('LLM 直连（可选）', true, hasLLMKey ? '有 API key（QQ/抖音可实时响应）' : '未设 DEEPSEEK_API_KEY / llm.api_key —— 接 QQ/抖音前补上（B站不受影响）')

  // ⑫ QQ（NapCat）
  const napcatUrl = (cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  let napcatOk = false
  try { const c = new AbortController(); setTimeout(() => c.abort(), 1500); await fetch(napcatUrl, { signal: c.signal }); napcatOk = true } catch {}
  add('QQ·NapCat（可选）', true, napcatOk ? `NapCat 已连（${napcatUrl}）` : 'NapCat 未启动 —— 接 QQ 前先装 NapCat 并扫码登录')

  // ⑬ TTS（GPT-SoVITS）
  const sovitsUrl = cfg.voice?.sovits_url || 'http://127.0.0.1:9880/tts'
  let ttsOk = false
  try { const c = new AbortController(); setTimeout(() => c.abort(), 1500); await fetch(sovitsUrl, { method: 'POST', signal: c.signal, body: '{}' }); ttsOk = true } catch {}
  add('语音 TTS（可选）', true, ttsOk ? `GPT-SoVITS 已连（${sovitsUrl}）` : 'GPT-SoVITS 未启动 —— 发 QQ 语音前先装（xiaoxiao 音色）')

  // ⑬b 参考文本是否和参考音频对得上（10-26 主人报"语音和视频里反复出现同一句话"）
  // 错配时 GPT-SoVITS 会把参考文本一起念出来 —— 这条不查出来，语音听起来就像"记忆错乱"
  try {
    const { refTextOf } = await import('../lib/tts.mjs')
    const ref = cfg.voice?.ref_audio_path || ''
    const configured = String(cfg.voice?.prompt_text || '').trim()
    const truth = refTextOf(ref)
    if (!ref) add('语音参考文本', true, '没配参考音频（用默认音色）')
    else if (truth && configured && truth !== configured) {
      add('语音参考文本', false,
        `配置里的参考文本和「${ref.split(/[\\/]/).pop()}」说的话不一样 —— `
        + `配置：「${configured.slice(0, 24)}…」实际：「${truth.slice(0, 24)}…」。`
        + '这会让每次合成把参考文本也念出来（语音/视频里反复冒同一句）。'
        + `修：把 voice.prompt_text 改成「${truth.slice(0, 40)}」`)
    } else if (!truth && configured) add('语音参考文本', true, '模型目录没有转写文件，按配置里的来（无法自动核对）')
    else add('语音参考文本', true, `和参考音频对齐：「${(truth || configured).slice(0, 30)}」`)
  } catch (e) { add('语音参考文本', true, '跳过（' + String(e.message).slice(0, 40) + '）') }

  // 情绪参考段（L2）：库在不在、文件有没有丢、起伏够不够 —— 参考段就是输出的天花板
  try {
    const { emotionRefs } = await import('../lib/tts.mjs')
    const lib = emotionRefs()
    const keys = Object.keys(lib)
    if (!keys.length) {
      add('情绪参考段', true, '还没建（可选：node feiyu.mjs voice emo build）—— 现在用默认音色 + 择优')
    } else {
      const missing = keys.filter((k) => !lib[k]?.wav || !fs.existsSync(lib[k].wav))
      const flat = keys.filter((k) => Number(lib[k]?.sd) < 3.6)
      if (missing.length) add('情绪参考段', false, `这些情绪段的音频丢了：${missing.join('/')} —— 重跑 voice emo build --force`)
      else if (flat.length) add('情绪参考段', true, `${keys.length} 套可用；偏平的：${flat.join('/')}（会靠默认音色的候选兜底）`)
      else add('情绪参考段', true, `${keys.length} 套可用：${keys.join('/')}`)
    }
  } catch (e) { add('情绪参考段', true, '跳过（' + String(e.message).slice(0, 40) + '）') }

  // 账本（10-26）：她自己查饭钱的那条路必须通 —— 会话日志能读、python 侧能解多帧 zstandard、
  // 缓存是新的。这条挂了，她就会退回去反复问主人"我们还有钱吗"（那就又断圈了）。
  try {
    const L = await import('../lib/ledger.mjs')
    const py = L.pythonPath()
    if (!fs.existsSync(py)) {
      add('账本', false, `找不到 python（${py}）—— 账本查不了，她会一直问主人饭钱`)
    } else {
      const u = await L.usage({})
      const days = Array.isArray(u.days) ? u.days.length : 0
      const b = L.readBrief()
      const total = u.lifetime?.mine?.total ?? 0
      if (!days) {
        add('账本', false, '会话日志里没读到任何用量（python 侧 zstandard 环境没装好？pip install zstandard）')
      } else if (!b) {
        add('账本', true, `${days} 天记录（她累计 ${(total / 1e4).toFixed(1)} 万 token）；摘要缓存还没生成，下次唤醒会自动刷`)
      } else if (b.stale) {
        add('账本', true, `${days} 天记录；摘要缓存 ${Math.round((Date.now() - b.at) / 60000)} 分钟前的（tick 每 10 分钟刷）`)
      } else {
        add('账本', true, `${days} 天记录；${b.line.slice(0, 60)}`)
      }
    }
  } catch (e) { add('账本', false, '查账失败：' + String(e.message).slice(0, 80)) }

  // 视频生产（第 17 轮）：真剪辑靠 ffmpeg 的 xfade/zoompan/subtitles/loudnorm + 中文字体。
  // 少一样就出不了片 —— 而这台机器上的 ffmpeg 藏在 D:/rvc/bin，PATH 里没有。
  try {
    const V = await import('../lib/video.mjs')
    const ff = V.ffmpegBin()
    const fps = V.specOf('bili')
    const fontOk = fs.existsSync(V.fontFile())
    const filters = (() => {
      try { return V.run(ff, ['-hide_banner', '-filters']) } catch { return '' }
    })()
    const haveAll = ['xfade', 'zoompan', 'subtitles', 'loudnorm', 'sidechaincompress']
      .filter((f) => !new RegExp(`\\s${f}\\s`).test(filters))
    if (!fs.existsSync(ff) && ff !== 'ffmpeg') add('视频生产', false, `找不到 ffmpeg（${ff}）—— 成片做不出来`)
    else if (haveAll.length) add('视频生产', false, `这个 ffmpeg 缺滤镜：${haveAll.join('/')}，剪不出真片子`)
    else if (!fontOk) add('视频生产', true, 'ffmpeg 就绪；但没找到中文字体，字幕会变方块（配 video.font 指一个 ttf）')
    else {
      const { locked, describe } = await import('../lib/debut.mjs')
      add('视频生产', true, `${ff.split(/[\\/]/).pop()} · ${fps.w}×${fps.h} · 字幕/BGM/转场齐全；${locked() ? describe() : describe()}`)
    }
  } catch (e) { add('视频生产', false, '视频模块起不来：' + String(e.message).slice(0, 80)) }

  // B站社交流水（第 17 轮）：她要"在 B站 活着"，主人就得看得见 —— 流水文件得能读、摘要能生成。
  try {
    const S = await import('../lib/social-log.mjs')
    const recs = S.read({ days: 7 })
    const st = S.stats(recs)
    const invisible = recs.filter((r) => !r.toOwner).length
    if (!st.length) {
      add('B站社交记录', true, '流水还是空的（她还没在 B站 发过言；跑 feiyu social --backfill 可补历史台账）')
    } else {
      const today = new Date().toLocaleDateString('sv-SE')
      const t = st.find((d) => d.day === today)
      add('B站社交记录', true, `7 天 ${recs.length} 条（没 @ 主人的 ${invisible} 条）；今天 ${t ? S.countLine(t) : '还没动'}`)
    }
  } catch (e) { add('B站社交记录', false, '流水读不出：' + String(e.message).slice(0, 80)) }

  // ⑭ 抖音互动（douyin_interact.py + patchright 环境）
  let dyOk = false
  try { fs.accessSync('D:/social-auto-upload/douyin_interact.py'); fs.accessSync('D:/social-auto-upload/.venv/Scripts/python.exe'); dyOk = true } catch {}
  let dyCookie = fs.existsSync(dataPath('douyin-cookies.json'))
  add('抖音互动（可选）', true, dyOk
    ? (dyCookie ? '脚本+环境+登录态就绪（刷视频/读评论/发评论可用，默认干跑）' : '脚本+环境就绪，但还没扫码登录 —— node feiyu.mjs douyin login')
    : '抖音互动脚本未装 —— 需要 D:/social-auto-upload 下的 patchright 环境')

  const allOk = items.every(i => i.ok)
  if (allOk) {
    try { fs.mkdirSync(dataPath(), { recursive: true }); fs.writeFileSync(dataPath('selftest-passed.json'), JSON.stringify({ at: new Date().toISOString(), node: process.versions.node })) } catch {}
  }

  if (json) { console.log(JSON.stringify({ ok: allOk, items, self, dryRun: !!cfg.guard?.dryRun }, null, 2)); process.exit(allOk ? 0 : 1) }

  for (const it of items) console.log(`${it.ok ? '✓' : '✗'} ${it.name}：${it.detail}`)
  console.log('')
  console.log(allOk ? '══════════ 全部通过 ✓ 可以用了 ══════════' : '══════════ 有 ✗ —— 照着上面每一行的提示修 ══════════')
  console.log('')
  console.log('── 接下来要做的两件事（很多人卡在这）──')
  console.log('')
  console.log('  ① 【找到她的会话】')
  console.log('     插件启动时会自动开一个会话，位置在：')
  console.log('       左侧「工作区」→ 展开「未分组」→ 里面那个 feiyu')
  console.log('     ⚠️ 不点开「未分组」是看不见它的 —— 这一步最容易漏')
  console.log('')
  console.log('  ② 【给她完全权限】')
  console.log('     打开那个会话 → 权限设置 → 选「完全访问 / danger-full-access」')
  console.log('     否则她起来后跑不了命令、看不了视频、写不了日记')
  console.log('')
  if (cfg.guard?.dryRun) {
    console.log('  ③ 【观察一周再关 DRY_RUN】')
    console.log('     feiyu.config.json → guard.dryRun: true → false 之后她才会真发评论')
    console.log('')
  }
  process.exit(allOk ? 0 : 1)
}
