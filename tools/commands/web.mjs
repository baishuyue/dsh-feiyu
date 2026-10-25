// web —— 她的上网工具（10-25）：全网瞎溜达的手脚。
//   node feiyu.mjs web search "关键词"        # 搜索（Bing 国内直连优先，DDG 走代理兜底）
//   node feiyu.mjs web fetch <url>            # 读网页正文（内网/外网都行，≤4000 字）
//   node feiyu.mjs web log                    # 翻她的上网日志（~/.feiyu-ai/web-log.md）
// 设计给 DSH 会话里的她直接调用：搜到→fetch→记 lore→写日记，是"自由活动"的底座。
// 每次搜索/访问都写 web-log.md —— 活动可审计。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import { dataPath, homePath } from '../lib/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const LOG = () => dataPath('web-log.md')
const PROXY = () => config().web?.proxy || 'http://127.0.0.1:7897'
const CURL = () => (fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl')

function curlGet(url, { proxy = false, timeout = 30000 } = {}) {
  const args = ['-sS', '-L', '-m', String(Math.ceil(timeout / 1000)), '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', url]
  if (proxy) args.splice(1, 0, '-x', PROXY())
  try {
    return execFileSync(CURL(), args, { encoding: 'utf8', timeout: timeout + 5000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`访问失败：${String(e.message).slice(0, 120)}`)
  }
}

function logWeb(kind, what) {
  try {
    const now = new Date()
    const day = now.toLocaleDateString('sv-SE')
    const time = now.toTimeString().slice(0, 5)
    const md = LOG()
    let content = ''
    try { content = fs.readFileSync(md, 'utf8') } catch {}
    if (!content.startsWith('# 大肥鱼 · 上网日志')) content = '# 大肥鱼 · 上网日志\n\n> 她在网上干过什么（搜索/访问/自我升级），按天记录（最新在上）。\n\n'
    if (!content.includes(`## ${day}\n`)) content = content.replace('# 大肥鱼 · 上网日志\n\n> 她在网上干过什么（搜索/访问/自我升级），按天记录（最新在上）。\n\n', `# 大肥鱼 · 上网日志\n\n> 她在网上干过什么（搜索/访问/自我升级），按天记录（最新在上）。\n\n## ${day}\n\n`)
    const at = content.indexOf(`## ${day}\n`) + `## ${day}\n\n`.length
    content = content.slice(0, at) + `- ${time} **${kind}** ${String(what).slice(0, 180)}\n` + content.slice(at)
    fs.mkdirSync(path.dirname(md), { recursive: true })
    fs.writeFileSync(md, content)
  } catch {}
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** 搜索：Bing 国内直连优先，0 结果/失败走 DDG（代理）。返回 [{title, url, snippet}] */
export function searchWeb(kw) {
  const results = []
  try {
    const html = curlGet(`https://cn.bing.com/search?q=${encodeURIComponent(kw)}&count=15`)
    const re = /<h2><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<p[^>]*>([\s\S]*?)<\/p>/g
    let m
    while ((m = re.exec(html)) && results.length < 10) {
      results.push({ title: htmlToText(m[2]).slice(0, 80), url: m[1], snippet: htmlToText(m[4]).slice(0, 150) })
    }
  } catch {}
  if (!results.length) {
    try {
      const html = curlGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(kw)}`, { proxy: true })
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
      let m
      while ((m = re.exec(html)) && results.length < 10) {
        let url = m[1]
        const uddg = url.match(/uddg=([^&]+)/)
        if (uddg) url = decodeURIComponent(uddg[1])
        results.push({ title: htmlToText(m[2]).slice(0, 80), url, snippet: htmlToText(m[3]).slice(0, 150) })
      }
    } catch {}
  }
  logWeb('搜索', `「${kw}」→ ${results.length} 条结果`)
  return results
}

/** 读网页正文（内外网皆可；先直连后代理） */
export function fetchWeb(url) {
  if (!/^https?:\/\//.test(url)) throw new Error('只支持 http(s) 链接：' + url)
  let html = ''
  try {
    html = curlGet(url, { proxy: false, timeout: 25000 })
  } catch {
    html = curlGet(url, { proxy: true, timeout: 40000 })
  }
  const text = htmlToText(html).slice(0, 4000)
  logWeb('访问', url)
  return text
}

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

/** 她的自主漫游循环（--free）：每一轮她自己决定在网上干什么 —— 跟 bili-watch --free 同款哲学。
 *  行动类型：搜索 / 读网页 / 写小说片段 / 学习总结入库 / 自我升级（仅 web.selfUpgrade 开着）。
 *  每轮 LLM 出 JSON 计划 → 执行 → 写日志/记忆 → 休息 restMin → 下一轮。 */
async function roamLoop() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  console.log('🌐 自由上网模式启动：她自己决定逛什么、玩什么、学什么（Ctrl/面板关停）')
  let round = 0
  while (true) {
    const cfg = config()
    const roam = cfg.web?.roam ?? {}
    if (roam.enabled === false) { console.log('（web.roam.enabled 已关，收摊）'); return }
    round++
    try {
      // 素材：她是谁、最近见闻、兴趣、上一轮干了什么（从日志尾捞）
      const { buildMessages } = await import('../lib/persona.mjs')
      const { loreInterests, loreValues, recent } = await import('../lib/memory.mjs')
      let lastDo = ''
      try {
        const logTail = fs.readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).slice(-3).join(' / ')
        lastDo = logTail.slice(0, 200)
      } catch {}
      const built = buildMessages({ platform: 'qq', userText: '', chatId: 'qq:web-roam-self', userId: String(cfg.owner?.qq || ''), turnsToday: round })
      const msgs = [
        built[0],
        { role: 'user', content: '【自由上网 · 第 ' + round + ' 轮】你在网上，自己决定现在干什么。可选行动：'
          + '\n①搜索——搜一个你此刻好奇的关键词（query 字段）'
          + '\n②读网页——深读一个链接（url 字段，可以来自你上轮搜到的结果）'
          + '\n③写小说——写一段你的原创小说/小故事（topic 字段，30~200字正文放进 text）'
          + '\n④学习——把最近见闻沉淀成一条认识（topic+text，会自动入库记忆）'
          + (cfg.web?.selfUpgrade?.enabled === true
            ? '\n⑤自我升级——改自己的代码（query=目标文件相对路径，text=要做的修改描述）。**必须先想清楚为什么改**；系统会自动备份，你改完要跑测试。偶尔为之，别没事重构。'
            : '')
          + '\n手上的素材（自然地用）：\n- 兴趣：' + loreInterests(3).join('；').slice(0, 120)
          + '\n- 最近在忙：' + (recent('qq:web-roam-self', 3).map((m) => String(m.content).slice(0, 30)).join('；') || '刚上线')
          + '\n- 刚才在网上：' + (lastDo || '还没开始')
          + '\n只输出 JSON：{"action":"搜索|读网页|写小说|学习|自我升级","query":"…","url":"…","text":"…","why":"一句话原因"}' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 500 })
      const m = String(resp ?? '').match(/\{[\s\S]*\}/)
      if (!m) { console.log('（这轮没出计划，歇会儿）'); await sleep(60000); continue }
      let plan; try { plan = JSON.parse(m[0]) } catch { await sleep(60000); continue }
      const act = String(plan.action || '搜索')
      console.log(`\n[roam #${round}] ${act}：${String(plan.why || plan.query || plan.topic || plan.url || '').slice(0, 60)}`)

      if (act === '搜索' && String(plan.query || '').trim()) {
        const rs = searchWeb(String(plan.query).trim())
        for (const r of rs.slice(0, 5)) console.log('  ·', r.title, '—', r.url)
        if (rs.length) logWeb('搜索', `「${plan.query}」${plan.why ? '（' + plan.why + '）' : ''} → 首选：${rs[0].url}`)
      } else if (act === '读网页' && String(plan.url || '').trim()) {
        const text = fetchWeb(String(plan.url).trim())
        console.log('  正文前 200 字：' + text.slice(0, 200).replace(/\n/g, ' '))
        // 读完顺手沉淀
        try {
          const { remember } = await import('../lib/memory.mjs')
          remember('qq', 'qq:web-roam-self', cfg.identity?.name ?? 'feiyu', 'assistant', `（读了 ${plan.url}：${text.slice(0, 80)}）`)
        } catch {}
      } else if (act === '写小说' && String(plan.text || '').trim()) {
        const dir = homePath('.dsh', 'feiyu-work', 'creative')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `novel-${new Date().toLocaleDateString('sv-SE')}.md`)
        fs.appendFileSync(file, `\n## ${new Date().toTimeString().slice(0, 5)} ${String(plan.topic || '').slice(0, 30)}\n\n${String(plan.text).slice(0, 800)}\n`)
        console.log('  ✓ 存入', file)
        logWeb('写小说', String(plan.topic || '').slice(0, 40))
      } else if ((act === '学习' || act === '自我升级') && String(plan.text || '').trim()) {
        if (act === '自我升级') {
          if (cfg.web?.selfUpgrade?.enabled !== true) { console.log('  （自我升级未开启，这轮跳过）'); await sleep(60000); continue }
          doBackup()
          console.log('  🔒 已自动备份，升级内容：' + String(plan.text).slice(0, 100))
          logWeb('自我升级', String(plan.text).slice(0, 120))
          // 她在 DSH 会话里才能真正改文件 —— 这里的角色是"记账+备份"，实际修改由她会话执行
        } else {
          const { addLore } = await import('../lib/memory.mjs')
          addLore('学习', `${String(plan.topic || plan.why || '').slice(0, 40)}：${String(plan.text).slice(0, 120)}`)
          console.log('  ✓ 已入库记忆')
          logWeb('学习', String(plan.text).slice(0, 120))
        }
      } else {
        console.log('  （计划不完整，歇会儿）')
        await sleep(60000)
        continue
      }
      const restMin = Number(roam.restMin ?? 2)
      await sleep(restMin * 60_000 + Math.random() * 30_000)
    } catch (e) {
      console.log('[roam] 这轮出错：' + String(e.message).slice(0, 120) + '，歇 2 分钟再来')
      await sleep(120000)
    }
  }
}

function doBackup() {
  // 轻量备份：调 selfup 命令（同目录），避免重复实现
  try { execFileSync(process.execPath, [path.join(HERE, 'selfup.mjs'), 'backup'], { encoding: 'utf8', timeout: 120000, windowsHide: true }) } catch {}
}

export async function run(argv = []) {
  const sub = argv[0] || 'help'
  const has = (n) => argv.includes(n)

  if (sub === 'roam' || has('--free')) { await roamLoop(); return }

  if (sub === 'search') {
    const kw = argv.slice(1).join(' ').trim()
    if (!kw) { console.log('用法：web search "关键词"'); return }
    const rs = searchWeb(kw)
    if (!rs.length) { console.log('（没搜到结果）'); return }
    console.log(`「${kw}」的搜索结果（${rs.length} 条）：`)
    for (const [i, r] of rs.entries()) console.log(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    return
  }

  if (sub === 'fetch') {
    const url = argv[1]
    if (!url) { console.log('用法：web fetch <url>'); return }
    console.log(fetchWeb(url))
    return
  }

  if (sub === 'log') {
    try { console.log(fs.readFileSync(LOG(), 'utf8')) } catch { console.log('（还没上过网）') }
    return
  }

  console.log('用法：web search "关键词" | web fetch <url> | web log | web roam --free（自由上网常驻）')
}

if (process.argv[1] && process.argv[1].endsWith('web.mjs')) {
  await run(process.argv.slice(2))
}
