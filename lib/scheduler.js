// 生物钟 —— 精简自 dsh-bili-whale 的 lib/scheduler.js（MIT），注入层换成 dafeiyu 的设计。
//
// 每 60 秒 tick → night-plan 重算 → 到点 → 用 ctx.sessionController.prompt 塞会话。
// 提示里注入（dafeiyu 骨架的"三段式 prompt"）：
//   [身份层] identity 三件套 + ~/.feiyu-ai/persona.md（人设文件优先）
//   [状态层] 情绪/饥饿/时段/今日轮次（mood.mjs 的状态机）
//   [记忆层] 关于主人的 facts + 一条随机旧记忆（memory.mjs）
//   [行为层] 编号流程（selftest → 选题 → 深读 → 打分 → 分享 → 两本日记 → 收工）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as spawnChild } from 'node:child_process'

import { makePlan, completePlan, historyOf } from '../tools/lib/night-plan.mjs'
import { config as readToolConfig } from '../tools/lib/config.mjs'
import { tickMood, stateBlock, distract } from '../tools/lib/mood.mjs'
import * as memory from '../tools/lib/memory.mjs'
import { nightStatePath, dataPath, homePath, configPath } from '../tools/lib/paths.mjs'
import { resolveNodeRuntime } from './node-runtime.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')

/** 身份层：三件套 + 专属人设文件（人设文件优先 —— bili-whale 踩过的"两处人设打架"坑）。 */
function personaLine(cfg) {
  const p = cfg.identity ?? {}
  const bits = []
  if (p.name) bits.push(`你是「${p.name}」`)
  if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
  if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
  let extra = ''
  try {
    const txt = fs.readFileSync(homePath('.feiyu-ai', 'persona.md'), 'utf8').trim()
    if (txt) extra = `\n\n［她的人设］以下是你的专属设定，选题/说话/写日记都以它为准；与上面冲突时以这一份为准：\n${txt.slice(0, 3000)}`
  } catch {}
  return bits.length ? `［身份］${bits.join('，')}。（以此为准 ✓）${extra}` : extra
}

/** 记忆层：主人事实 + 一条 7 天前的旧事（dafeiyu「主动回忆」）。 */
function memoryLines(cfg) {
  const lines = []
  const facts = memory.facts('owner')
  if (facts.length) lines.push('你记得关于主人的事：\n- ' + facts.slice(-8).join('\n- '))
  const old = memory.randomOld()
  if (old.length) lines.push(`你隐约记得这句话（可以自然提起，不要逐字复述）：「${old[0]}」`)
  return lines
}

/** 行为层：编号流程（对齐 AGENTS.md 的「看的那晚」）。 */
export function wakePrompt(st, cfg, feiyuMjs) {
  const cli = `node "${feiyuMjs}"`
  return [
    personaLine(cfg),
    '',
    `【生物钟】你醒了 —— ${st.atText ?? ''}（窗口 ${st.window}${st.withinWindow ? ' · ' + st.withinWindow : ''}）。`,
    '',
    stateBlock(memory.recent('share', 50).length, 'bilibili'),
    '',
    ...memoryLines(cfg),
    '',
    distract(),   // 10% 概率走神注入（多了就是噪音）
    '',
    ...(fs.existsSync(dataPath('selftest-passed.json')) ? [] : [
      `【还没跑启动体检】先提醒主人跑一次：${cli} selftest`,
      '  并告诉他两件事：① 你的会话在 工作区 → 未分组 里 ② 要给那个会话「完全访问」权限',
      '',
    ]),
    '按 AGENTS.md 的「看的那晚」流程走一遍（不要等主人说话，直接做）：',
    `1) ${cli} selftest —— 有 ✗ 就报备主人、只做读、别对外发`,
    `2) ${cli} feed —— 选题 ≤${st.maxVideos ?? cfg.night?.maxVideos ?? 5} 条（偏好命中 + 弹幕密度，不看播放量）`,
    `3) 挑 2–3 条深读：${cli} debrief --bvid <BV>`,
    `4) 按「标尺」给深读过的打分（0–20），只对第一名考虑分享`,
    `   ✅ 走【评论区 @】：${cli} comment --share --bvid <BV> --message "<想说的话>" --reason "<至少八字>" --score <0-20> --rank 1`,
    '   先不带 --go 干跑 ✓ 主人在配置里关掉 guard.dryRun 且你对结果有把握，才加 --go 真发',
    '   身份透明：评论保持"本鱼"的口吻（AI鱼不装人，鱼圈规矩）；这条视频特别有共鸣的话，也可以顺手发一条弹幕：' + cli + ' act danmaku --bvid <BV> --text "<10-20字>" --go',
    `   硬限制：每天合计 ≤${cfg.quota?.shareDaily ?? 3} 条 · 同一视频 ${cfg.quota?.sameVideoDays ?? 7} 天内一次 · 评分 <${cfg.share?.minScore ?? 13} 就不分享（合法结果 ✓）`,
    '5) 写两本日记（散文体，不要流水账）：',
    `   ${cli} diary --book owner --append "…"   ← 给主人的信（有细节有情绪）`,
    `   ${cli} diary --book private --append "…"  ← 你自己的（不加滤镜：偏好校准/今天哪里做得不对）`,
    `6) 把今天学到的东西记进记忆：${cli} mem lore --tag <主题> --text "…"（顺手的事，别跳过）`,
    '7) 收工。别自己加戏 ✓',
    ...(cfg.guard?.dryRun ? ['\n⚠️ 现在是 DRY_RUN 模式：所有发送都只会打印 —— 正常走流程，把要发的评论原文展示给主人看即可。'] : []),
  ].filter(Boolean).join('\n')
}

export function startScheduler(ctx, opts) {
  const {
    dshHome,
    feiyuMjs,          // tools/feiyu.mjs 绝对路径
    cwd,               // 她的会话工作目录（~/.dsh/feiyu-work）
    sessionId = 'feiyu',
    log = () => {},
  } = opts

  const STATE = nightStatePath
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null } }
  const writeState = (o) => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    const temp = STATE + '.' + process.pid + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(o, null, 2) + '\n')
    fs.renameSync(temp, STATE)
  }

  let stopped = false
  let waking = false
  // 真 node（DSH 是 Electron 主进程，spawn 脚本必须用真 node）
  let NODE_BIN = null
  try { NODE_BIN = resolveNodeRuntime(opts.dshHome || process.env.DSH_HOME) } catch {}

  // ── 动态日更：bilibili.dynamic.times（默认 09:30 / 21:30）到点各发一条「潜水日志」──
  const DYN_STATE = path.join(opts.dshHome || process.env.DSH_HOME || homePath('.dsh'), 'feiyu-dyn.json')
  function dynTick(cfg) {
    try {
      const dynCfg = cfg.bilibili?.dynamic
      if (dynCfg?.enabled !== true || !Array.isArray(dynCfg.times) || !dynCfg.times.length) return
      const day = new Date().toLocaleDateString('sv-SE')
      let st = null
      try { st = JSON.parse(fs.readFileSync(DYN_STATE, 'utf8')) } catch {}
      const fired = st && st.day === day ? [...(st.fired ?? [])] : []
      const nowHM = new Date().toTimeString().slice(0, 5)
      for (const t of dynCfg.times) {
        if (nowHM >= t && !fired.includes(t)) {
          fired.push(t)
          try { fs.writeFileSync(DYN_STATE, JSON.stringify({ day, fired })) } catch {}
          if (NODE_BIN) {
            spawnChild(NODE_BIN, [feiyuMjs, 'act', 'dyn', '--auto', '--go'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
            log('[feiyu] 潜水日志动态已触发（' + t + '）')
          }
        }
      }
    } catch {}
  }

  // 会话与 AGENTS.md：首次 ensure 时把行为模板写进工作目录（DSH 会话热加载 cwd 的 AGENTS.md）
  let sessionReady = false
  async function ensureSession() {
    if (sessionReady) return
    try {
      await ctx.sessionController.create({ sessionId, cwd })
    } catch {
      log(`[feiyu] 未创建新会话（可能已有同名会话）；已有会话保留原 cwd。期望目录：${cwd}`)
    }
    sessionReady = true
    try {
      const agentsFile = path.join(cwd, 'AGENTS.md')
      if (!fs.existsSync(agentsFile)) {
        fs.mkdirSync(cwd, { recursive: true })
        let tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.template.md'), 'utf8')
        tpl = tpl.split('{{TOOLS}}').join(feiyuMjs)
        fs.writeFileSync(agentsFile, tpl)
        log(`[feiyu] 已写入 ${agentsFile}`)
      }
    } catch (e) { log(`[feiyu] AGENTS.md 写入失败：${e.message}`) }
  }

  // 撞车检测：按会话文件 mtime 判断她是不是还在干活（bili-whale 的实测教训：
  // waking 标志只管 prompt 那一瞬，她一干就是好几分钟）
  function findSessionFile() {
    const root = path.join(dshHome, 'sessions')
    const stack = [root]
    let best = null
    let guardCount = 0
    while (stack.length && guardCount < 5000) {
      guardCount += 1
      const d = stack.pop()
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.name === 'session.v4.jsonl.zstd' && p.includes(sessionId)) {
          try {
            const mt = fs.statSync(p).mtimeMs
            if (!best || mt > best.mt) best = { p, mt }
          } catch {}
        }
      }
    }
    return best
  }
  let sessionFileCache = findSessionFile()
  let busyUntil = 0
  const COOLDOWN_MS = 8 * 60 * 1000
  const IDLE_MS = 90 * 1000
  function sheIsBusy() {
    if (Date.now() < busyUntil) return 'cooldown'
    if (!sessionFileCache) sessionFileCache = findSessionFile()
    if (!sessionFileCache) return false
    try {
      const mt = fs.statSync(sessionFileCache.p).mtimeMs
      if (Date.now() - mt < IDLE_MS) return 'still-working'
    } catch {}
    return false
  }

  async function tick() {
    if (stopped || waking || !ctx.sessionController || sheIsBusy()) return
    waking = true
    try {
      const cfg = readToolConfig()
      dynTick(cfg)
      const st = makePlan(cfg.night ?? {}, readState() ?? {})
      writeState(st)
      if (st.action === 'done' || Date.now() < st.atMs) return
      const bilibiliOn = cfg.platforms?.bilibili !== false
      const douyinOn = cfg.platforms?.douyin !== false

      // B站：唤醒 DSH 会话（由 platforms.bilibili 开关控制）
      if (bilibiliOn && ctx.sessionController) {
        await ensureSession()
        if (stopped) return
        // 情绪先漂移一次，再进状态层（dafeiyu：每次唤醒前 tick）
        tickMood()
        const text = st.action === 'skip'
          ? [
              personaLine(cfg), '',
              `【今晚不看】${st.reason ?? '今天不想看'}`,
              stateBlock(0, 'bilibili'), '',
              `照常写两本日记（${'node "' + feiyuMjs + '"'} diary --book owner --append "…"），说清楚为什么今晚不干活；记完收工。`,
            ].join('\n')
          : wakePrompt(st, cfg, feiyuMjs)
        await ctx.sessionController.prompt({
          requestId: 'feiyu-' + Date.now(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, new AbortController().signal)
      }
      const completed = completePlan(st)
      writeState(completed)
      busyUntil = Date.now() + COOLDOWN_MS
      log('[feiyu] 已投递 ' + st.action + ' · ' + st.atText)

      // 抖音定时：复用 night 窗口，到点 spawn 独立进程跑 douyin interact（不阻塞 B 站会话）。
      // 直连不走 DSH 会话，故单独起一个 node 进程；真发需要 CDP Chrome(9222) 开着。
      if (douyinOn && st.action !== 'skip') {
        try {
          const cdpOk = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000) })
            .then((r) => r.ok)
            .catch(() => false)
          if (!cdpOk) {
            log('[feiyu] 抖音定时跳过：CDP Chrome(9222) 未开，先双击 start_douyin_cdp.bat')
          } else {
            const { spawn } = await import('node:child_process')
            const child = spawn('node', [feiyuMjs, 'douyin', 'interact'], { detached: true, stdio: 'ignore', windowsHide: true })
            child.unref()
            log('[feiyu] 已触发抖音 interact（独立进程）')
          }
        } catch (e) {
          log('[feiyu] 抖音触发失败：' + e.message)
        }
      }
    } catch (e) {
      log('[feiyu] 唤醒失败，下一轮重试：' + e.message)
    } finally {
      waking = false
    }
  }

  const timer = setInterval(tick, 60_000)
  tick()   // 起手先 tick 一次，别干等 60 秒

  return {
    stop() { stopped = true; clearInterval(timer) },
    invalidate(resetPlan = false) {
      if (resetPlan) writeState(historyOf(readState() ?? {}))
      tick()
    },
  }
}
