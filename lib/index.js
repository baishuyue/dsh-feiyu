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
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { startScheduler } from './scheduler.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { config as readToolConfig } from '../tools/lib/config.mjs'
import { configPath, credentialsPath, dataPath, WORK_DIR, nightStatePath } from '../tools/lib/paths.mjs'

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

    // ── QQ 常驻聊天服务（qq.enabled 时自动 spawn，随 DSH 起停）───────────────
    let qqProc = null
    try {
      if (readToolConfig().qq?.enabled) {
        if (!NODE_EXE) throw new Error('未找到 node 运行时（DSH_NODE）')
        qqProc = spawn(NODE_EXE, [FEIYU_MJS, 'qq-server', '8080'], {
          env: nodeEnv(DSH_HOME), windowsHide: true, stdio: 'ignore',
        })
        qqProc.on('exit', (code) => { try { console.log(`[feiyu] qq-server 退出 code=${code}`) } catch {} })
        console.log('[feiyu] qq-server 已启动 → http://127.0.0.1:8080/onebot')
      }
    } catch (e) {
      try { console.warn('[feiyu] qq-server 启动失败：' + e.message) } catch {}
    }

    ctx.effect(() => () => {
      try { sched?.stop() } catch {}
      try { qqProc?.kill() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try {
      console.log(`[feiyu] 已挂载：/dsh-feiyu/api/* · 配置 ${configPath} · 工作目录 ${WORK_DIR}`)
    } catch {}
  },
}
