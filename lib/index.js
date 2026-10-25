/**
 * dsh-feiyu —— 宿主侧插件壳（设置壳 + 生物钟）。
 * 结构照 dsh-bili-whale 的 lib/index.js（MIT）：职责只有三件，
 *   1. 状态 API：GET /dsh-feiyu/api/status —— 生物钟/额度/情绪/干跑一览
 *   2. 凭据写入：POST /dsh-feiyu/api/cookie —— 清洗 + 写盘 + nav 实时验证（永不回显）
 *   3. 启动生物钟（lib/scheduler.js）—— 60 秒 tick，到点叫醒会话
 * 配置本体（feiyu.config.json）第一版手编（README 有完整说明），不做 GUI 设置页。
 *
 * 所有路由都过 DSH 信任栅栏（connection.requestRejection）+ 本机回环检查：
 * fail-closed —— 栅栏不可用就拒绝，而不是放行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { startScheduler } from './scheduler.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { config as readToolConfig } from '../tools/lib/config.mjs'
import { configPath, credentialsPath, dataPath, WORK_DIR, nightStatePath, homePath } from '../tools/lib/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')
const FEIYU_MJS = path.join(PLUGIN_ROOT, 'tools', 'feiyu.mjs')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 生物钟状态：设置/体检用它回答「时钟是不是活的」。 */
let SCHED_STATUS = { ok: false, reason: '未初始化', at: null }

// Electron 主程序跑不了脚本 —— 必须找到真 node（找不到时显式报错，不静默 ✗）
const NODE_EXE = (() => {
  try {
    return resolveNodeRuntime(DSH_HOME)
  } catch (e) {
    globalThis.__feiyuNodeError = String(e?.message ?? e)
    return null
  }
})()

function execNode(args, options, cb) {
  if (!NODE_EXE) {
    const msg = globalThis.__feiyuNodeError || '未找到可用的 node 运行时'
    cb?.(new Error(msg), '', msg)
    return null
  }
  return execFile(NODE_EXE, args, { ...options, env: { ...nodeEnv(DSH_HOME), ...options?.env } }, cb)
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 写操作只认本机回环（防"服务绑到 0.0.0.0"时局域网里有人改你的 cookie）。 */
function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

export default {
  name: 'dsh-feiyu',
  // ⚠️ 一个数组写全（bili-whale 踩过"写两个 inject 键后者覆盖前者"的坑 → 时钟静默 60 秒空转）
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {

    // 信任栅栏：fail-closed —— connection 缺失/抛错一律拒绝（写操作尤其）
    function rejected(req, res) {
      if (isLoopbackReq(req) === false) {
        json(res, 403, { ok: false, error: '只接受本机回环访问' })
        return true
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) {
            rejected.warned = true
            console.warn('[feiyu] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 处理')
          }
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' })
          return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' })
        return true
      }
    }

    const disposers = []
    function route(pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }

    // ── 状态（只读）：生物钟 / 额度 / 情绪 / 干跑 ─────────────────────────────
    route('/dsh-feiyu/api/status', async (req, res) => {
      const cfg = readToolConfig()
      const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return f } }
      const quota = readJson(dataPath('quota.json'), { log: [] })
      const today = new Date().toLocaleDateString('sv-SE')
      const todays = (quota.log ?? []).filter(x => new Date(x.at).toLocaleDateString('sv-SE') === today)
      const mood = readJson(dataPath('mood.json'), { value: 62, hunger: 0 })
      // 通道健康：QQ 真正的网关是 NapCat（8080 只是中转壳），微信看心跳文件 —— 这两个才是"服务在跑却没回复"的关键
      let qqChannel = null
      // 直接探 NapCat 端口，别再绕 qq-server 的健康接口：中间壳可能起了、也可能被代理拦，
      // 判断「能不能收发」唯一可靠的是 NapCat 本身有没有在监听。
      try {
        const napcatCfg = String((readToolConfig().qq?.napcat_http) || 'http://127.0.0.1:3000')
        const napcatUrl = napcatCfg.replace(/\/+$/, '')
        let port = 3000
        try { port = Number(new URL(napcatUrl).port) || 3000 } catch {}
        const open = await new Promise((resolve) => {
          const sock = net.connect({ host: '127.0.0.1', port })
          const finish = (v) => { try { sock.destroy() } catch {}; resolve(v) }
          sock.setTimeout(1200)
          sock.once('connect', () => finish(true))
          sock.once('error', () => finish(false))
          sock.once('timeout', () => finish(false))
        })
        qqChannel = { napcat: { ok: open, online: open, url: napcatUrl, checkedAt: Date.now() } }
      } catch { qqChannel = { napcat: { ok: false, online: false, checkedAt: Date.now() } } }
      let wxBeat = null
      try { wxBeat = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.feiyu-ai', 'wechat-heartbeat.json'), 'utf8')) } catch {}
      // RVC 唱歌音色（说话音色是 GPT-SoVITS 那套，唱歌走 RVC 换声——两套东西，面板分别显示）
      let rvcVoice = ''
      try { rvcVoice = String(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.feiyu-ai', 'rvc-voice.json'), 'utf8')).current || '') } catch {}
      // NapCat 起了但在等扫码登录时，3000 是关的 —— 这不是故障，要看二维码
      let napcatQr = null
      try {
        const qrPath = 'D:/NapCat/cache/qrcode.png'
        const st = fs.statSync(qrPath)
        const age = Date.now() - st.mtimeMs
        if (age < 15 * 60_000) napcatQr = { path: qrPath, ageSec: Math.round(age / 1000) }
      } catch {}
      json(res, 200, {
        ok: true,
        today,
        scheduler: SCHED_STATUS,
        plan: readJson(nightStatePath, null),
        sharesToday: todays.filter(x => x.share).length,
        sharesMax: cfg.quota?.shareDaily ?? 3,
        commentsToday: todays.length,
        mood: { value: Math.round(Number(mood.value) || 0), hunger: Math.round(Number(mood.hunger) || 0) },
        dryRun: !!cfg.guard?.dryRun,
        selftestPassed: fs.existsSync(dataPath('selftest-passed.json')),
        ownerSet: !!(cfg.owner?.mid && cfg.owner?.name),
        qqChannel,
        wxBeat,
        napcatQr,
        rvcVoice,
        configPath,
      })
    })

    // ── 凭据写入（只写不回显；清洗 + nav 实时验证 —— bili-whale 的实战清洗逻辑）─────
    route('/dsh-feiyu/api/cookie', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      // 自动清洗三种最常见的粘错：带前缀 / 整条 cookie / 带引号分号
      const pick = (raw, key) => {
        let v = String(raw ?? '').trim()
        const m = v.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
        if (m) return m[1].trim()
        v = v.replace(new RegExp('^' + key + '\\s*=', 'i'), '')
        v = v.replace(/^["'\s]+|["';\s]+$/g, '')
        return v
      }
      const sessdata = pick(b.sessdata, 'SESSDATA')
      const bili_jct = pick(b.bili_jct, 'bili_jct')
      const buvid3 = pick(b.buvid3, 'buvid3')
      const problems = []
      if (!sessdata) problems.push('SESSDATA 空着（HttpOnly，document.cookie 读不到 —— 必须 F12 → Application → Cookies 手动复制）')
      else if (sessdata.length < 20) problems.push(`SESSDATA 太短（${sessdata.length}）——大概只复制到一半`)
      if (!bili_jct) problems.push('bili_jct 空着')
      else if (!/^[0-9a-fA-F]{32}$/.test(bili_jct)) problems.push(`bili_jct 格式可疑（${bili_jct.length} 位，应为 32 位十六进制）`)
      if (problems.length) {
        json(res, 400, { ok: false, error: '凭据有问题，没写入：\n  · ' + problems.join('\n  · ') })
        return
      }
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, JSON.stringify({ sessdata, bili_jct, buvid3 }, null, 2) + '\n')
      try { fs.chmodSync(credentialsPath, 0o600) } catch {}
      // 写完立刻问一次 nav，确认登录态
      let who = null, navMsg = ''
      try {
        const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${sessdata}; bili_jct=${bili_jct}; buvid3=${buvid3}` },
        })
        const navJson = await navRes.json().catch(() => ({}))
        if (navJson?.data?.isLogin && navJson.data.mid) who = { mid: String(navJson.data.mid), name: String(navJson.data.uname ?? '') }
        else navMsg = navJson?.message ?? ''
      } catch (e) { navMsg = String(e?.message ?? e).slice(0, 120) }
      json(res, 200, {
        ok: true,
        self: who,
        detail: who ? `已写入 ✓ 当前登录：${who.name}（mid ${who.mid}）`
          : '已写入，但 B站 不认这个 cookie ✗ —— 最常见：SESSDATA 复制截断 / 来自别的浏览器' + (navMsg ? `（nav：${navMsg}）` : ''),
      })
    })

    // ── 体检：spawn 真 node 跑 selftest --json ─────────────────────────────────
    route('/dsh-feiyu/api/selftest', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      execNode([FEIYU_MJS, 'selftest', '--json'], { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout || '{}'))
          json(res, 200, { ...parsed, scheduler: SCHED_STATUS, nodeError: err ? String(err.message).slice(0, 200) : null, stderr: String(stderr ?? '').slice(0, 300) })
        } catch {
          json(res, 200, { ok: false, error: String(stderr || err?.message || 'selftest 跑失败').slice(0, 300), items: [], scheduler: SCHED_STATUS })
        }
      })
    })

    // ── 设置页 UI + 配置读写 / 记忆 / 角色设定 / 音色 ──────────────────────
    const SETTINGS_HTML = path.join(HERE, 'settings.html')
    const VOICE_MODELS_DIR = 'D:/GPT-SoVITS/models'

    function readCfgFile() {
      try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return {} }
    }
    function writeCfgFile(cfg) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const temp = configPath + '.' + process.pid + '.tmp'
      fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + '\n')
      fs.renameSync(temp, configPath)
    }
    /** 音色列表：扫 D:/GPT-SoVITS/models/<name>/ 里同时有 .wav（参考音频）和 .txt（参考文本）的目录。 */
    function listVoices() {
      const out = []
      try {
        for (const name of fs.readdirSync(VOICE_MODELS_DIR)) {
          const dir = path.join(VOICE_MODELS_DIR, name)
          let files = []
          try { files = fs.readdirSync(dir) } catch { continue }
          const wav = files.find((f) => f.toLowerCase().endsWith('.wav'))
          if (!wav) continue
          const txt = files.find((f) => f.toLowerCase().endsWith('.txt'))
          let promptText = ''
          if (txt) { try { promptText = fs.readFileSync(path.join(dir, txt), 'utf8').trim() } catch {} }
          out.push({
            name,
            ref_audio_path: path.join(dir, wav).replace(/\\/g, '/'),
            prompt_text: promptText,
            has_prompt: !!promptText,
          })
        }
      } catch {}
      return out
    }

    // 设置页
    route('/dsh-feiyu/', async (req, res) => {
      try {
        const html = fs.readFileSync(SETTINGS_HTML, 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
      } catch (e) { json(res, 500, { ok: false, error: 'settings.html 读取失败：' + e.message }) }
    })

    // 配置：GET 读（api_key 脱敏）/ POST 写（白名单字段合并）
    route('/dsh-feiyu/api/config', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readCfgFile()
        const safe = JSON.parse(JSON.stringify(cfg))
        // 三处密钥都得脱敏：以前只删 llm.api_key，imageGen / vision 的 key 明文随 GET /config 进了浏览器
        for (const sec of ['llm', 'imageGen', 'vision']) {
          if (safe[sec]) { safe[sec].hasKey = !!safe[sec].api_key; delete safe[sec].api_key }
        }
        json(res, 200, { ok: true, config: safe, voices: listVoices(), configPath })
        return
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const cfg = readCfgFile()
        // 深合并：面板每个控件只发自己那几个字段，浅合并会把同节其它嵌套配置整组冲掉
        // （实测：proactive 的 activeHours、freeRoam 的 maxVideos 都被冲过）。数组整体替换，对象递归合并。
        const deepMerge = (base, over) => {
          const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
          for (const [k, v] of Object.entries(over || {})) {
            out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(out[k], v) : v
          }
          return out
        }
        for (const k of ['platforms', 'owner', 'identity', 'night', 'quota', 'voice', 'qq', 'wechat', 'douyin', 'bilibili', 'llm', 'preferences', 'share', 'imageGen', 'vision', 'rvc', 'sing', 'web', 'personality', 'freedom', 'guard']) {
          if (body[k] !== undefined && typeof body[k] === 'object' && body[k] !== null) {
            cfg[k] = deepMerge(cfg[k] ?? {}, body[k])
          }
        }
        writeCfgFile(cfg)
        json(res, 200, { ok: true })
        return
      }
      json(res, 405, { ok: false })
    })

    // 观看日报：聚合 B站/抖音 当天看过的内容 → Markdown（不调模型）
    route('/dsh-feiyu/api/report', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      execNode([FEIYU_MJS, 'report', '--days', String(b.days || 1)], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { json(res, 200, { ok: false, errors: [err.message, String(stderr || '').slice(0, 200)] }); return }
        const outPath = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
        let markdown = ''
        try { markdown = fs.readFileSync(outPath, 'utf8') } catch {}
        json(res, 200, { ok: true, path: outPath, markdown })
      })
    })

    // 抖音自主观看：长任务，后台跑，立刻返回
    route('/dsh-feiyu/api/watch', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const args = [FEIYU_MJS, 'watch', '--duration', String(b.duration || 10), '--max', String(b.max || 3)]
      // 只在显式传 dry=true 时加 --dry；否则交给 watch 内部按 douyin.dryRun 判断
      if (b.dry === true) args.push('--dry')
      const child = spawn(NODE_EXE, args, { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.unref()
      json(res, 200, { ok: true, note: '自主观看已开始（后台运行），结束后用「观看日报」看结果。' })
    })

    // 复盘学习日记：LLM 提炼当天看过的 → 追加私人日记（前台，快速返回）
    route('/dsh-feiyu/api/review', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      execNode([FEIYU_MJS, 'review', '--days', String(b.days || 1)], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { json(res, 200, { ok: false, errors: [err.message, String(stderr || '').slice(0, 200)] }); return }
        json(res, 200, { ok: true, text: String(stdout || '').trim() })
      })
    })

    // B站静默自助刷一轮（后台）
    route('/dsh-feiyu/api/bili-watch', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const args = [FEIYU_MJS, 'bili-watch', '--max', String(b.max || 2)]
      // 只在显式 dry=true 时才干跑；否则交给 bili-watch 内部按 guard.dryRun 判断
      // （以前这里无条件加 --dry，面板按钮永远干跑，和提示文案"按 guard.dryRun 决定"矛盾）
      if (b.dry === true) args.push('--dry')
      spawn(NODE_EXE, args, { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' }).unref()
      json(res, 200, { ok: true, note: 'B站静默刷已开始（后台），刷完会按 guard.dryRun 决定是否真发评论。' })
    })

    // 记忆摘要（最近对话 + 世界设定 + 主人事实）
    route('/dsh-feiyu/api/memory', async (req, res) => {
      const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return f } }
      // QQ 有自己的记忆文件（~/.feiyu-ai/qq/episodes.jsonl），面板要一起读，否则 QQ 对话看不见
      let episodes = []
      for (const file of [dataPath('episodes.jsonl'), dataPath('qq', 'episodes.jsonl')]) {
        try {
          const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
          episodes = episodes.concat(rows)
        } catch {}
      }
      episodes.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      const lore = readJson(dataPath('lore.json'), [])
      const facts = readJson(dataPath('facts.json'), [])
      const count = (v) => (Array.isArray(v) ? v.length : Object.keys(v || {}).length)
      json(res, 200, {
        ok: true,
        stats: { episodes: episodes.length, lore: count(lore), facts: count(facts), byPlatform: episodes.reduce((m, e) => { const p = String(e.platform || 'misc'); m[p] = (m[p] || 0) + 1; return m }, {}) },
        recent: episodes.slice(-30).map((e) => ({ role: e.role, text: e.text || e.content || '', chatId: e.chatId || '', platform: e.platform || '' })),
      })
    })

    // 角色设定（persona.md 读写）
    const personaFile = homePath('.feiyu-ai', 'persona.md')
    route('/dsh-feiyu/api/persona', async (req, res) => {
      if (req.method === 'GET') {
        let text = ''
        try { text = fs.readFileSync(personaFile, 'utf8') } catch {}
        json(res, 200, { ok: true, text })
        return
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        fs.mkdirSync(path.dirname(personaFile), { recursive: true })
        fs.writeFileSync(personaFile, String(body.text || ''))
        json(res, 200, { ok: true })
        return
      }
      json(res, 405, { ok: false })
    })

    // 音色试听：spawn node 跑 synth + NapCat 发语音到主人 QQ
    route('/dsh-feiyu/api/voice-test', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const cfg = readCfgFile()
      // 允许指定"试听哪个音色"：以前完全不读 body，两个 UI 传来的参数都被丢掉，永远试存盘那个
      const b = JSON.parse(await readBody(req) || '{}')
      const ov = {}
      if (b.ref_audio_path) ov.ref_audio_path = String(b.ref_audio_path)
      if (b.prompt_text) ov.prompt_text = String(b.prompt_text)
      if (b.prompt_lang) ov.prompt_lang = String(b.prompt_lang)
      if (!ov.ref_audio_path && b.name) {
        try {
          const hit = listVoices().find((x) => x.name === String(b.name))
          if (hit) { ov.ref_audio_path = hit.ref_audio_path; if (hit.prompt_text) ov.prompt_text = hit.prompt_text }
        } catch {}
      }
      const qq = cfg.qq || {}
      const ownerQQ = cfg.owner?.qq
      if (!ownerQQ) { json(res, 400, { ok: false, error: '先在「主人」里填 QQ 号（试听要发给你）' }); return }
      const napcat = (qq.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
      const ttsFile = path.join(PLUGIN_ROOT, 'tools', 'lib', 'tts.mjs').replace(/\\/g, '/')
      const code = [
        `import { synth } from 'file:///${ttsFile}'`,
        `const f = await synth('主人，这是我现在的声音，好听吗？', undefined, ${JSON.stringify(ov)})`,
        `const r = await fetch('${napcat}/send_private_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: ${JSON.stringify(String(ownerQQ))}, message: [{ type: 'record', data: { file: f } }] }) })`,
        `const j = await r.json()`,
        `if (!j || j.status !== 'ok') throw new Error(JSON.stringify(j).slice(0, 200))`,
        `console.log('ok')`,
      ].join('\n')
      execNode(['--input-type=module', '-e', code], { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { json(res, 500, { ok: false, error: String(stderr || err.message).slice(0, 300) }); return }
        json(res, 200, { ok: true })
      })
    })

    // 全部音色逐个试听（voice tryall）+ 让她唱一首（sing）—— 后台跑，结果发主人 QQ
    for (const [pathName, args] of [['voice-tryall', ['voice', 'tryall']], ['sing', ['sing']]]) {
      route(`/dsh-feiyu/api/${pathName}`, async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        if (!NODE_EXE) { json(res, 200, { ok: false, errors: [globalThis.__feiyuNodeError || '未找到 node 运行时'] }); return }
        const b = JSON.parse(await readBody(req) || '{}')
        spawn(NODE_EXE, [FEIYU_MJS, ...args, ...(b.theme ? [String(b.theme)] : [])], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' }).unref()
        json(res, 200, { ok: true, note: pathName === 'sing' ? '写词合成中，唱完发你 QQ 🎵' : '逐个试听中，注意 QQ 语音消息 🎧' })
      })
    }

    // ── 常驻服务（QQ / 微信）：随 DSH 起停，也能在设置面板里单独重启 ──────────
    // 平台开关存盘后不必重启整个 DSH：点一下「重启服务」就是 kill + 重新 spawn。
    let qqProc = null
    let wechatProc = null
    let douyinDmProc = null

    const procAlive = (p) => !!p && p.exitCode === null && p.signalCode === null
    // NODE_EXE 是 launcher，会再 spawn 一个真 node；只 kill launcher 会让子进程变孤儿继续占端口。
    const killTree = (proc) => {
      if (!proc) return
      const pid = proc.pid
      try { proc.kill() } catch {}
      try { spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 5000 }) } catch {}
    }
    const procInfo = (p) => ({ running: procAlive(p), pid: (p && p.pid) || null })

    // 端口上残留的旧实例（上次 DSH 没杀干净 / 手动起的 / 崩溃后留的僵尸）必须先清掉：
    // 否则新实例绑不上端口 → 静默退出 → 面板显示"开了"但其实没跑（10-25 抖音私信就是这个现象）。
    // 只杀 node.exe，绝不误伤同端口的第三方服务。
    function killPortListeners(port, tag = '') {
      try {
        const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
        const re = new RegExp(`:${port}\\s+.*LISTENING`, 'i')
        const pids = new Set()
        for (const line of String(r.stdout || '').split('\n')) {
          if (!re.test(line)) continue
          const m = line.trim().match(/(\d+)\s*$/)
          if (m) pids.add(m[1])
        }
        for (const pid of pids) {
          const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
          if (!/node\.exe/i.test(String(tl.stdout || ''))) continue
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
          try { console.log(`[feiyu] 清掉占用 ${port} 的旧${tag}实例 pid=${pid}`) } catch {}
        }
      } catch {}
    }
    function startQQ() {
      const cfg = readCfgFile()
      if (cfg.platforms?.qq === false || cfg.qq?.enabled === false) return { ok: false, error: 'QQ 平台开关是关的' }
      if (procAlive(qqProc)) return { ok: true, already: true, pid: qqProc.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const port = String(cfg.qq?.port || 8080)
      killPortListeners(port, ' QQ ')
      const child = spawn(NODE_EXE, [FEIYU_MJS, 'qq-server', port], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', (code) => { qqProc = null; try { console.log(`[feiyu] qq-server 退出 code=${code}`) } catch {} })
      qqProc = child
      // QQ 开了才拉全家：网关(NapCat) +2.5s、语音(SoVITS) +6s —— 错开启动高峰，别瞬间挤爆电脑
      setTimeout(() => { ensureGateway() }, 2500)
      setTimeout(() => { try { ensureSovits() } catch {} }, 6000)
      return { ok: true, pid: child.pid }
    }
    function stopQQ() {
      if (qqProc) { killTree(qqProc); qqProc = null }
      // 开关关 = QQ 全家收摊：网关（NapCat/QQ 客户端 ~500MB）+ 语音（SoVITS ~450MB）一起停，
      // 不然"关了开关"内存一点没省
      try { stopGateway() } catch {}
      try { killTree(sovitsProc) } catch {}
      return { ok: true }
    }
    function startWechat() {
      const cfg = readCfgFile()
      if (cfg.platforms?.wechat === false || cfg.wechat?.enabled === false) return { ok: false, error: '微信平台开关是关的' }
      if (procAlive(wechatProc)) return { ok: true, already: true, pid: wechatProc.pid }
      const wx = cfg.wechat ?? {}
      if (!wx.python || !wx.script) return { ok: false, error: '配置里缺 wechat.python / wechat.script' }
      const child = spawn(wx.python, [wx.script], { windowsHide: true, stdio: 'ignore' })
      child.on('exit', (code) => { wechatProc = null; try { console.log(`[feiyu] 微信机器人退出 code=${code}`) } catch {} })
      wechatProc = child
      return { ok: true, pid: child.pid }
    }
    function stopWechat() {
      if (wechatProc) { killTree(wechatProc); wechatProc = null }
      return { ok: true }
    }
    function startDouyinDm() {
      const cfg = readCfgFile()
      if (cfg.platforms?.douyin === false || cfg.douyin?.enabled === false) return { ok: false, error: '抖音平台开关是关的' }
      if (cfg.douyin?.dm?.enabled === false) return { ok: false, error: 'douyin.dm.enabled 是关的' }
      if (procAlive(douyinDmProc)) return { ok: true, already: true, pid: douyinDmProc.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const port = String(cfg.douyin?.dm?.port || 8095)
      killPortListeners(port, '抖音私信')
      // 端口上已经有一个活着的实例（比如手动起的、或上次 DSH 没杀干净）→ 上面已经清掉，
      // 这里只记一笔，避免"看起来开了其实没跑"
      const child = spawn(NODE_EXE, [FEIYU_MJS, 'douyin-dm-server', '--port', port], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => { douyinDmProc = null; try { console.log('[feiyu] 抖音私信陪聊退出') } catch {} })
      douyinDmProc = child
      return { ok: true, pid: child.pid }
    }
    function stopDouyinDm() {
      if (douyinDmProc) { killTree(douyinDmProc); douyinDmProc = null }
      return { ok: true }
    }
    // 自由刷（抖音/B站 各一个进程，可同时跑：抖音用无头 Chrome、B站纯 API，互不抢资源）
    let freeRoamDouyinProc = null
    let freeRoamBiliProc = null
    function startFreeRoam(platform) {
      const cfg = readCfgFile()
      const isDouyin = platform === 'douyin'
      const fr = isDouyin ? cfg.douyin?.freeRoam : cfg.bilibili?.freeRoam
      const cur = isDouyin ? freeRoamDouyinProc : freeRoamBiliProc
      if (fr?.enabled === false) return { ok: false, error: `${platform} 自由刷开关（freeRoam.enabled）是关的` }
      if (procAlive(cur)) return { ok: true, already: true, pid: cur.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const cmd = isDouyin ? 'watch' : 'bili-watch'
      const child = spawn(NODE_EXE, [FEIYU_MJS, cmd, '--free'], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => {
        if (isDouyin) freeRoamDouyinProc = null; else freeRoamBiliProc = null
        try { console.log(`[feiyu] ${platform} 自由刷退出`) } catch {}
      })
      if (isDouyin) freeRoamDouyinProc = child; else freeRoamBiliProc = child
      return { ok: true, pid: child.pid }
    }
    function stopFreeRoam(platform) {
      // 不带 platform 或 'all' = 全停（dispose 用）；否则只停对应平台（面板开关各管各的）
      if (!platform || platform === 'all') {
        killTree(freeRoamDouyinProc); killTree(freeRoamBiliProc)
        freeRoamDouyinProc = freeRoamBiliProc = null
      } else if (platform === 'douyin') {
        killTree(freeRoamDouyinProc); freeRoamDouyinProc = null
      } else {
        killTree(freeRoamBiliProc); freeRoamBiliProc = null
      }
      return { ok: true }
    }
    // 自由上网（web --free 常驻）：她在全网瞎溜达/玩/学习/自我升级 —— 跟自由刷同款开关哲学
    let webRoamProc = null
    function startWebRoam() {
      const cfg = readCfgFile()
      if (cfg.web?.roam?.enabled === false) return { ok: false, error: '自由上网开关（web.roam.enabled）是关的' }
      if (procAlive(webRoamProc)) return { ok: true, already: true, pid: webRoamProc.pid }
      if (!NODE_EXE) return { ok: false, error: globalThis.__feiyuNodeError || '未找到 node 运行时' }
      const child = spawn(NODE_EXE, [FEIYU_MJS, 'web', 'roam'], { env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => { webRoamProc = null; try { console.log('[feiyu] 自由上网退出') } catch {} })
      webRoamProc = child
      return { ok: true, pid: child.pid }
    }
    function stopWebRoam() {
      killTree(webRoamProc); webRoamProc = null
      return { ok: true }
    }
    // 自由上网自愈（10-25）：完全自由开着时，web-roam 进程死了自动拉起（不用人管）
    const webRoamHeal = setInterval(() => {
      try {
        const cfg = readCfgFile()
        if (cfg.freedom?.enabled === true && cfg.web?.roam?.enabled !== false && !procAlive(webRoamProc)) {
          const r = startWebRoam()
          if (r.ok && !r.already) try { console.log('[feiyu] 自由上网进程自愈拉起') } catch {}
        }
      } catch {}
    }, 60_000)
    const svcSnapshot = () => ({
      qq: procInfo(qqProc), wechat: procInfo(wechatProc), douyinDm: procInfo(douyinDmProc),
      freeRoamDouyin: procInfo(freeRoamDouyinProc), freeRoamBili: procInfo(freeRoamBiliProc),
      webRoam: procInfo(webRoamProc),
      freeRoam: procInfo(freeRoamDouyinProc) || procInfo(freeRoamBiliProc),
    })

    route('/dsh-feiyu/api/services', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, services: svcSnapshot() }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = JSON.parse((await readBody(req)) || '{}')
      const target = String(body.target || 'all')
      const action = String(body.action || 'restart')
      const errors = []
      const run = (fn, label) => { const r = fn(); if (!r.ok && r.error) errors.push(`${label}：${r.error}`); return r }
      if (target === 'qq' || target === 'all') {
        if (action === 'stop' || action === 'restart') run(stopQQ, 'QQ')
        if (action === 'start' || action === 'restart') {
          await new Promise((r) => setTimeout(r, 400))
          run(startQQ, 'QQ')
        }
      }
      if (target === 'napcat') {
        // QQ 真正的网关是 NapCat（D:/NapCat），它必须管理员权限注入 QQ。
        // install：弹一次 UAC，注册成"登录即启动 + 最高权限"的计划任务，以后不再需要授权。
        // start  ：直接跑那个计划任务（不需要再弹 UAC）。
        const bat = String(body.launcher || 'D:/NapCat/launcher-user.bat')
        const act = String(body.action || 'install')
        const taskName = String(body.task || 'DSH-Feiyu-NapCat')

        if (act === 'start') {
          const r = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true })
          const bad = r.status !== 0
          json(res, 200, {
            ok: !bad,
            services: svcSnapshot(),
            errors: bad ? ['启动计划任务失败：' + String(r.stderr || r.stdout || '').trim()] : [],
            note: bad ? '' : '已启动 QQ 网关（计划任务 ' + taskName + '）',
          })
          return
        }

        // 用自提权 bat：它先注册计划任务（登录自启 + 最高权限），失败就直接把 NapCat 拉起来。
        const helper = String(body.helper || 'D:/NapCat/start-qq-gateway.bat')
        if (!fs.existsSync(bat)) {
          json(res, 200, { ok: false, services: svcSnapshot(), errors: ['没找到 QQ 网关启动器：' + bat] })
          return
        }
        if (!fs.existsSync(helper)) {
          json(res, 200, { ok: false, services: svcSnapshot(), errors: ['缺少自提权脚本：' + helper] })
          return
        }
        // 让 NapCat 用快速登录：账号是「机器人自己的 QQ 号」（NapCat 登录态），不是 owner.qq。
        // 从 NapCat 配置文件 napcat_<QQ>.json 自动探测，其次用显式 qq.account。
        try {
          let acc = ''
          const configDir = path.join(path.dirname(bat), 'config')
          const m = fs.readdirSync(configDir).find(f => /^napcat_(\d+)\.json$/.test(f))
          if (m) acc = m.match(/^napcat_(\d+)\.json$/)[1]
          if (!acc) acc = String((readToolConfig().qq?.account) || '').trim()
          if (acc) fs.writeFileSync(path.join(path.dirname(bat), 'qq-account.txt'), acc + '\n')
        } catch {}
        try {
          spawn('powershell.exe', ['-NoProfile', '-Command',
            `Start-Process -FilePath '${helper}' -WorkingDirectory '${path.dirname(helper)}' -ArgumentList 'elevated' -Verb RunAs`],
          { windowsHide: true, stdio: 'ignore', detached: true }).unref()
          json(res, 200, {
            ok: true,
            services: svcSnapshot(),
            errors: [],
            note: '已请求管理员权限：UAC 弹窗点「是」后会自动注册开机自启并启动 QQ，之后再也不用授权。',
          })
        } catch (e) {
          json(res, 200, { ok: false, services: svcSnapshot(), errors: ['拉起 QQ 网关失败：' + e.message] })
        }
        return
      }
      if (target === 'wechat' || target === 'all') {
        if (action === 'stop' || action === 'restart') run(stopWechat, '微信')
        if (action === 'start' || action === 'restart') run(startWechat, '微信')
      }
      if (target === 'douyin-dm' || target === 'all') {
        if (action === 'stop' || action === 'restart') run(stopDouyinDm, '抖音私信陪聊')
        if (action === 'start' || action === 'restart') run(startDouyinDm, '抖音私信陪聊')
      }
      if (target === 'free-roam') {
        if (action === 'stop' || action === 'restart') run(() => stopFreeRoam(String(body.platform || '')), '自由刷')
        if (action === 'start' || action === 'restart') run(() => startFreeRoam(String(body.platform || 'douyin')), '自由刷')
      }
      if (target === 'web-roam') {
        if (action === 'stop' || action === 'restart') run(stopWebRoam, '自由上网')
        if (action === 'start' || action === 'restart') run(startWebRoam, '自由上网')
      }
      json(res, 200, { ok: errors.length === 0, services: svcSnapshot(), errors })
    })

    // ── 生物钟 ────────────────────────────────────────────────────────────────
    let sched = null
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true })
      sched = startScheduler(ctx, {
        dshHome: DSH_HOME,
        feiyuMjs: FEIYU_MJS,
        cwd: WORK_DIR,
        sessionId: 'feiyu',
        log: (m) => { try { console.log(m) } catch {} },
      })
      SCHED_STATUS = { ok: true, reason: '已启动（每 60 秒 tick）', at: new Date().toISOString() }
    } catch (e) {
      SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      try { console.warn('[feiyu] 生物钟启动失败：' + e.message) } catch {}
    }

    // ── QQ 网关（NapCat）：跟随 QQ 服务按需拉起 ─────────────────────────────
    // QQ 是 Electron 客户端，常驻要 400~700MB。10-24 起不再随 DSH 启动全家桶 ——
    // QQ 开关打开时才拉（startQQ 里调），QQ 开关关着就别动它。
    const GATEWAY_TASK = 'DSH-Feiyu-NapCat'
    const portOpen = (port, timeout = 800) => new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch {} resolve(v) }
      const sock = net.connect({ host: '127.0.0.1', port })
      sock.setTimeout(timeout)
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
      sock.once('timeout', () => finish(false))
    })

    const ensureGateway = async () => {
      try {
        if (await portOpen(3000)) return                    // 已经有人拉起来了，别开第二个
        const r = spawnSync('schtasks.exe', ['/Run', '/TN', GATEWAY_TASK], { windowsHide: true, timeout: 5000 })
        if (r && r.status === 0) console.log('[feiyu] QQ 网关已拉起（计划任务 ' + GATEWAY_TASK + '，QQ 登录约需 3-4 分钟）')
      } catch { /* 没装过任务就算了，面板上会提示 */ }
    }

    /** 语音服务（GPT-SoVITS）随 DSH 起停：有声音开关、服务挂了，等于没声音。 */
    let sovitsProc = null
    const SOVITS_LOCK = path.join(os.homedir(), '.feiyu-ai', 'sovits.lock')
    const startSovits = () => {
      const cfg2 = readToolConfig()
      if (cfg2.qq?.voice_enabled === false || cfg2.voice?.autoStartSovits === false) return
      if (sovitsProc && procAlive(sovitsProc)) return
      const cmd = cfg2.voice?.sovitsCmd || 'D:/GPT-SoVITS/.venv/Scripts/python.exe'
      const script = cfg2.voice?.sovitsScript || 'D:/GPT-SoVITS/api_v2.py'
      if (!fs.existsSync(cmd) || !fs.existsSync(script)) return
      const child = spawn(cmd, [script, '-a', '127.0.0.1', '-p', '9880'],
        { cwd: path.dirname(script), windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => { sovitsProc = null })
      sovitsProc = child
      try { console.log('[feiyu] 已拉起 GPT-SoVITS 语音服务（9880）') } catch {}
    }
    const ensureSovits = async () => {
      try {
        if (await portOpen(9880, 800)) { try { fs.unlinkSync(SOVITS_LOCK) } catch {}; return }
        // 模型加载约 90s：窗口内别重复 spawn 第二个实例
        try { const st = fs.statSync(SOVITS_LOCK); if (Date.now() - st.mtimeMs < 150_000) return } catch {}
        try { fs.mkdirSync(path.dirname(SOVITS_LOCK), { recursive: true }); fs.writeFileSync(SOVITS_LOCK, String(Date.now())) } catch {}
        startSovits()
      } catch {}
    }
    // 语音服务只在 QQ 活着（或显式 startWithDsh）时才自动拉/探活 ——
    // QQ 都没开，450MB 的 SoVITS 就别白占了
    const sovitsWanted = () => procAlive(qqProc) || readCfgFile().qq?.startWithDsh === true
    setTimeout(() => { if (sovitsWanted()) ensureSovits() }, 6000)
    const sovitsTimer = setInterval(() => { if (sovitsWanted()) ensureSovits() }, 60_000)

    /** DSH 退出时收掉网关：先结束计划任务，再兜底关 QQ（它就是 NapCat 的宿主）。 */    const stopGateway = () => {
      try {
        const qqCfg = readToolConfig().qq ?? {}
        if (qqCfg.stopWithDsh === false) return
        try { spawnSync('schtasks.exe', ['/End', '/TN', GATEWAY_TASK], { windowsHide: true, timeout: 8000 }) } catch {}
        try {
          if (qqCfg.killQqOnExit !== false) {
            spawnSync('taskkill.exe', ['/F', '/T', '/IM', 'QQ.exe'], { windowsHide: true, timeout: 8000 })
            spawnSync('taskkill.exe', ['/F', '/IM', 'NapCatWinBootMain.exe'], { windowsHide: true, timeout: 8000 })
          }
        } catch {}
      } catch {}
    }

    // ── 常驻服务按需启动（10-24 用户拍板）─────────────────────────────────
    // DSH 开机不再全家桶（QQ 客户端+SoVITS+微信+dm 的 Chrome 一起起，电脑瞬间卡死）：
    // QQ / 微信 / 抖音私信陪聊 全部由面板开关点开才启动。
    // 想恢复"随 DSH 自动启动"：配置里给对应服务加 "startWithDsh": true。
    if (readCfgFile().qq?.startWithDsh === true) {
      try { startQQ() } catch (e) { try { console.warn('[feiyu] qq-server 自启失败：' + e.message) } catch {} }
    }
    if (readCfgFile().wechat?.startWithDsh === true) {
      try { startWechat() } catch (e) { try { console.warn('[feiyu] 微信机器人自启失败：' + e.message) } catch {} }
    }
    if (readCfgFile().douyin?.dm?.startWithDsh === true) {
      try { startDouyinDm() } catch (e) { try { console.warn('[feiyu] 抖音私信陪聊自启失败：' + e.message) } catch {} }
    }
    // 注意：自由刷也故意不随 DSH 自动启动 —— 它是"手动点开、DSH 在才刷"的东西，
    // 退出时下面 dispose 会把 freeRoam.enabled 复位成 false，下次打开面板看到的就是真实状态。

    /** DSH 退出时把"按需开关"复位：进程都停了，开关留着"开"就是假状态。
     *  自由刷 + QQ + 微信 + 抖音私信陪聊（除非配置了 startWithDsh:true 要自启，那开关本来就是开的）。 */
    const resetOnExitToggles = () => {
      try {
        const cfg = readCfgFile()
        let changed = false
        const turnOff = (get, set) => { if (get() === true) { set(false); changed = true } }
        for (const key of ['douyin', 'bilibili']) {
          turnOff(() => cfg[key]?.freeRoam?.enabled, (v) => { cfg[key].freeRoam.enabled = v })
        }
        turnOff(() => cfg.web?.roam?.enabled, (v) => { cfg.web.roam.enabled = v })
        turnOff(() => cfg.freedom?.enabled, (v) => { cfg.freedom.enabled = v })
        if (cfg.qq?.startWithDsh !== true) turnOff(() => cfg.platforms?.qq, (v) => { cfg.platforms.qq = v })
        if (cfg.wechat?.startWithDsh !== true) turnOff(() => cfg.platforms?.wechat, (v) => { cfg.platforms.wechat = v })
        if (cfg.douyin?.dm?.startWithDsh !== true) turnOff(() => cfg.douyin?.dm?.enabled, (v) => { cfg.douyin.dm.enabled = v })
        if (changed) writeCfgFile(cfg)
      } catch {}
    }

    ctx.effect(() => () => {
      try { resetOnExitToggles() } catch {}
      try { clearInterval(sovitsTimer) } catch {}
      try { sched?.stop() } catch {}
      try { stopGateway() } catch {}
      try { killTree(sovitsProc) } catch {}
      try { killTree(qqProc) } catch {}
      try { killTree(wechatProc) } catch {}
      try { killTree(douyinDmProc) } catch {}
      try { killTree(freeRoamDouyinProc) } catch {}
      try { killTree(freeRoamBiliProc) } catch {}
      try { killTree(webRoamProc) } catch {}
      try { clearInterval(webRoamHeal) } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try {
      console.log(`[feiyu] 已挂载：/dsh-feiyu/api/* · 配置 ${configPath} · 工作目录 ${WORK_DIR}`)
    } catch {}
  },
}
