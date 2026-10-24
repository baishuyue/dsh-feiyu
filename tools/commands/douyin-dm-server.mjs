// douyin-dm-server —— 抖音私信陪聊（参照 qq-server 的常驻模式，但收发走抖音网页私信）。
// 轮询：dm-read 读主人会话 → 只挑主人的新消息 → LLM 回 → dm-send 发出。
// 复用 guard（去重/清洗）、persona、记忆、llm，省掉一套独立逻辑。
//
//   node feiyu.mjs douyin-dm-server [8090]
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from '../lib/config.mjs'
import * as persona from '../lib/persona.mjs'
import * as llm from '../lib/llm.mjs'
import * as guard from '../lib/guard.mjs'
import { dataPath } from '../lib/paths.mjs'

const WM_FILE = dataPath('douyin-dm-watermark.json')

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

function runPy(args, cfg) {
  const cmd = [cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py', ...args,
    '--cookie', cfg.douyin?.cookie || path.join(os.homedir(), '.feiyu-ai', 'douyin-cookies.json')]
  return execFileSync(cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe', cmd,
    { encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }

const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 60)

export async function run(argv = []) {
  const cfg = config()
  const ownerName = String(cfg.douyin?.owner?.name || '').trim()
  const secUid = String(cfg.douyin?.owner?.sec_uid || '').trim()
  if (!secUid) { console.error('[douyin-dm] 未配置 douyin.owner.sec_uid，无法陪聊'); process.exit(1) }
  const pollSec = Number(cfg.douyin?.dm?.pollSec || 20)
  const dry = cfg.douyin?.dryRun !== false

  // 水位：最近处理过的主人消息（文本指纹），重启不重放
  let handled = readJson(WM_FILE, { handled: [] }).handled || []
  let lastInbound = ''   // 上一条主人的消息（合并用）

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, owner: ownerName, dry, pollSec, handled: handled.length }))
      return
    }
    res.end(JSON.stringify({ ok: true }))
  })
  const port = Number(arg(argv, '--port', cfg.douyin?.dm?.port || 8090))
  server.listen(port, '127.0.0.1', () => console.log(`[douyin-dm] 监听 http://127.0.0.1:${port}/health · 每 ${pollSec}s 轮询主人私信`))

  async function tick() {
    try {
      const out = runPy(['dm-read', '--sec-uid', secUid, '--name', ownerName, '--n', '20'], cfg)
      const data = jsonOf(out)
      const msgs = (data && data.messages) || []
      // 只看主人发来的、最新的
      const inbound = msgs.filter(m => m.dir === 'in').map(m => String(m.text || '').trim()).filter(Boolean)
      if (!inbound.length) return
      const text = inbound[inbound.length - 1]
      const key = norm(text)
      if (!key || key === lastInbound || handled.includes(key)) return

      lastInbound = key
      console.log(`[douyin-dm] 主人：${text.slice(0, 50)}`)

      // 复用 QQ 那套：人格 + 记忆 + 清洗
      const msgsOut = persona.buildMessages({ platform: 'douyin', userText: text, chatId: 'douyin-dm:owner', turnsToday: handled.length })
      const resp = await llm.chat(msgsOut, { temperature: 0.85 })
      const reply = guard.clean(String(resp?.content ?? resp ?? ''))
      if (!reply || reply.toUpperCase() === 'SKIP') { console.log('[douyin-dm] 不接话，跳过'); return }

      if (dry) {
        console.log(`[douyin-dm] 【干跑 ✓】本要回复：${reply.slice(0, 50)}`)
      } else {
        runPy(['dm-send', '--sec-uid', secUid, '--name', ownerName, '--message', reply, '--go', '--cdp'], cfg)
        console.log(`[douyin-dm] ✅ 已回复：${reply.slice(0, 50)}`)
      }
      handled.push(key)
      if (handled.length > 200) handled = handled.slice(-200)
      writeJson(WM_FILE, { handled })
    } catch (e) {
      console.error('[douyin-dm] tick 失败：' + String(e.stderr || e.message).slice(0, 200))
    }
  }

  setInterval(tick, pollSec * 1000)
  tick()
}

if (process.argv[1] && process.argv[1].endsWith('douyin-dm-server.mjs')) {
  await run(process.argv.slice(2))
}
