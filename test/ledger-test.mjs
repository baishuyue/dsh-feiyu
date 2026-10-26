// 账本（ledger）回归测试 —— 10-26「让她自己查账」这一轮的契约。
//
// 背景：她的记忆里反复问"账本/饭钱"。查了原因才发现根子是**她读不到账** ——
// 只把钱挂在嘴上、账本却只有主人能看的角色，只能一直问。这一轮给她三样东西：
//   ① 真实 token 用量（DSH 会话日志里的 data.usage，不是估的）
//   ② 折算成"饭钱"的口径（单价可配，标 ≈，绝不假装精确到分）
//   ③ 今天剩余的动作额度（她自己那几本账）
// 测的是"契约"：算账、额度口径、提示语注入、查不到时的老实交代、以及源码防线
// （python 侧必须读穿多帧 zstd；账本查不到时绝不许编一个 ¥0）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 先把 HOME 指到沙箱 —— 账本会读 ~/.feiyu-ai 下那几本，不能碰主人真实的
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-ledger-test-'))
process.env.DSH_HOME = path.join(sandbox, '.dsh')
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const DATA = path.join(sandbox, '.feiyu-ai')
fs.mkdirSync(DATA, { recursive: true })

const L = await import('../tools/lib/ledger.mjs')

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const TODAY = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

// ── ① 算账：单价 × 三类 token ───────────────────────────────────────────────
ok('costOf 按 元/百万 token 折算', () => {
  const cfg = { ledger: { price: { inputPerM: 2, cachePerM: 0.2, outputPerM: 3 } } }
  const u = { input: 1e6, cache: 1e6, output: 1e6 }
  assert.equal(L.costOf(u, cfg), 5.2)              // 2 + 0.2 + 3
})

ok('costOf 空用量 = 0，不抛', () => {
  assert.equal(L.costOf(null), 0)
  assert.equal(L.costOf({}), 0)
  assert.equal(L.costOf({ input: 0, output: 0, cache: 0 }), 0)
})

ok('没配单价时用默认档位（输入2/缓存0.2/输出3）', () => {
  const p = L.price({ ledger: {} })
  assert.deepEqual(p, { input: 2, cache: 0.2, output: 3 })
  // 配坏了（字符串/NaN）也要落回默认值，不能算出 NaN 元
  const bad = L.price({ ledger: { price: { inputPerM: 'x', cachePerM: null, outputPerM: undefined } } })
  assert.deepEqual(bad, { input: 2, cache: 0.2, output: 3 })
})

ok('token 格式化：万/亿，小数字不美化', () => {
  assert.equal(L.fmtTok(1234), '1234')
  assert.equal(L.fmtTok(12345), '1.2 万')
  assert.equal(L.fmtTok(24125719), '2412.6 万')
  assert.equal(L.fmtTok(186000000), '1.86 亿')
  assert.equal(L.fmtTok(0), '0')
  assert.equal(L.fmtTok(undefined), '0')
})

// ── ② 额度：她自己那几本账的口径 ────────────────────────────────────────────
ok('quota.json 里 share:true 才算分享，其余算回评', () => {
  const dir = fs.mkdtempSync(path.join(sandbox, 'q-'))
  const iso = (h) => new Date(new Date().setHours(h, 0, 0, 0)).toISOString()
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({
    log: [
      { at: iso(9), type: 'share', share: true, target: 'BV1' },
      { at: iso(10), type: 'share', share: true, target: 'BV2' },
      { at: iso(11), type: 'reply', target: 'BV3' },
      { at: '2020-01-01T00:00:00.000Z', type: 'share', share: true, target: 'OLD' },  // 不是今天
    ],
  }))
  const cfg = { quota: { shareDaily: 3 } }
  const rows = L.quotas(cfg, TODAY, dir)
  const share = rows.find((r) => r.key === 'share')
  const reply = rows.find((r) => r.key === 'reply')
  assert.equal(share.used, 2)
  assert.equal(share.left, 1)
  assert.equal(reply.used, 1)
  assert.equal(reply.left, null)          // 回评不设上限 → 不限
})

ok('额度为 0 = 不限（这是 10-26 的真凶之一，不能渲染成"0 条"）', () => {
  const dir = fs.mkdtempSync(path.join(sandbox, 'q0-'))
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ log: [] }))
  const cfg = { quota: { shareDaily: 0 } }
  const rows = L.quotas(cfg, TODAY, dir)
  assert.equal(rows.find((r) => r.key === 'share').left, null)
})

ok('日计数器文件：跨天自动归零，当天才认', () => {
  const dir = fs.mkdtempSync(path.join(sandbox, 'q1-'))
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ log: [] }))
  fs.writeFileSync(path.join(dir, 'imggen.json'), JSON.stringify({ day: TODAY, count: 18 }))
  fs.writeFileSync(path.join(dir, 'douyin-share.json'), JSON.stringify({ day: '2020-01-01', count: 99 }))
  fs.writeFileSync(path.join(dir, 'douyin-comment.json'), JSON.stringify({ day: TODAY, count: 18 }))
  const cfg = { imageGen: { dailyMax: 30 }, douyin: { shareDaily: 5, commentDaily: 0 } }
  const rows = L.quotas(cfg, TODAY, dir)
  assert.equal(rows.find((r) => r.key === 'img').used, 18)
  assert.equal(rows.find((r) => r.key === 'img').left, 12)
  assert.equal(rows.find((r) => r.key === 'douyin-share').used, 0)     // 昨天的数字不算今天
  assert.equal(rows.find((r) => r.key === 'douyin-share').left, 5)
  assert.equal(rows.find((r) => r.key === 'douyin-comment').left, null) // 0 = 不限
})

ok('账本文件缺失/坏掉时不炸，按 0 算', () => {
  const dir = fs.mkdtempSync(path.join(sandbox, 'q2-'))
  fs.writeFileSync(path.join(dir, 'quota.json'), '{ 这不是 json')
  const rows = L.quotas({}, TODAY, dir)
  assert.equal(rows.length, 7)
  assert.ok(rows.every((r) => r.used === 0))
})

// ── ③ 摘要行：给她看的、也是给她说的 ────────────────────────────────────────
ok('brief：一行里要有饭钱、预算状态、有上限的额度', () => {
  const r = {
    me: { tokens: { total: 24_125_719 }, cost: 7.06, budget: 3, leftOfBudget: -4.06, overBudget: true },
    master: { tokens: { total: 1 }, cost: 1 },
    week: { days: 4, cost: 10.71, avgPerDay: 2.68 },
    balance: null,
    runwayDays: null,
    quotas: [
      { key: 'share', label: 'B站 分享', used: 19, limit: 0, left: null },
      { key: 'img', label: '表情包生成', used: 18, limit: 30, left: 12 },
    ],
  }
  const s = L.brief(r)
  assert.match(s, /今天吃了 2412\.6 万 token ≈ ¥7\.06/)
  assert.match(s, /超了预算 ¥4\.06/)
  assert.match(s, /表情包生成 12\/30/)
  assert.doesNotMatch(s, /B站 分享/)            // 不限的额度不进摘要（噪音）
  assert.doesNotMatch(s, /余额/)                 // 查不到余额就不写余额
})

ok('brief 有余额时补一句"还能撑几天"', () => {
  const r = {
    me: { tokens: { total: 1e6 }, cost: 0.5, budget: null, leftOfBudget: null, overBudget: false },
    balance: { total: 30, currency: 'CNY' },
    runwayDays: 11,
    quotas: [],
  }
  const s = L.brief(r)
  assert.match(s, /余额 ¥30/)
  assert.match(s, /还能撑 11 天/)
  assert.doesNotMatch(s, /预算/)                 // 没设预算就别提预算
})

ok('brief 没数据返回空串（提示语里就整块不出现）', () => {
  assert.equal(L.brief(null), '')
})

// ── ④ 查不到就老实说：绝不编余额 ────────────────────────────────────────────
ok('没配 balanceUrl/apiKey 时余额返回 null（不是 0）', async () => {
  const v = await L.balance({ ledger: {} })
  assert.equal(v, null)
})

ok('余额接口通了：多币种都留下，主数取 CNY（照 dsh-pet 的教训）', async () => {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '1.50', granted_balance: '0.50', topped_up_balance: '1.00' },
        { currency: 'CNY', total_balance: '88.20', granted_balance: '8.20', topped_up_balance: '80.00' },
      ],
    }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const v = await L.balance({ ledger: { balanceUrl: `http://127.0.0.1:${port}/user/balance`, apiKey: 'k' } })
    assert.ok(v)
    assert.equal(v.currency, 'CNY')
    assert.equal(v.total, 88.2)
    assert.equal(v.wallets.length, 2)                 // 只取首条会让 USD 凭空消失
    assert.deepEqual(v.wallets.map((w) => w.currency).sort(), ['CNY', 'USD'])
  } finally {
    srv.close()
  }
})

ok('余额接口挂了/字段缺 → null，不抛也不编', async () => {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ is_available: false, balance_infos: [] }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const v = await L.balance({ ledger: { balanceUrl: `http://127.0.0.1:${port}/x`, apiKey: 'k' } })
    assert.equal(v, null)
  } finally {
    srv.close()
  }
  // 连不上（端口关掉）也是 null
  assert.equal(await L.balance({ ledger: { balanceUrl: 'http://127.0.0.1:1/x', apiKey: 'k' } }), null)
})

// ── ⑤ 缓存：提示语同步读，不能每次都跑 python ───────────────────────────────
ok('readBrief 没缓存时返回 null', () => {
  assert.equal(L.readBrief(), null)
})

ok('writeBrief 缓存能读回，且行内带账本口径', async () => {
  const prev = process.env.FEIYU_TEST_SKIP_LEDGER
  void prev
  // 直接用 refreshBrief 会跑 python（1.5s）；这里模拟它落盘的那份结构
  const file = path.join(DATA, 'cache', 'ledger-brief.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    at: Date.now(),
    today: TODAY,
    line: '今天吃了 1.2 万 token ≈ ¥0.03',
    report: { me: { cost: 0.03 }, week: { cost: 0.1, avgPerDay: 0.03 }, quotas: [] },
  }))
  const b = L.readBrief()
  assert.ok(b)
  assert.match(b.line, /今天吃了/)
  assert.equal(b.stale, false)
  // 过期标记：超过 30 分钟要能标出来（她会知道数字不是刚刷的）
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 31 * 60_000, line: '旧的', report: {} }))
  assert.equal(L.readBrief().stale, true)
})

// ── ⑥ 源码防线（这几条都是踩过的坑）────────────────────────────────────────
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

ok('python 侧必须用 stream_reader 读穿多帧，不能用能"只解第一帧"的接口', () => {
  const py = read('tools/lib/ledger_usage.py')
  assert.match(py, /stream_reader/)                       // DSH 日志每行一个 zstd 帧
  assert.doesNotMatch(py, /ZstdDecompressor\(\)\.decompress\(/)   // 只解第一帧 = 只拿到会话头
  assert.match(py, /session\.v\*\.jsonl\.zst/)            // 版本前缀要通配
  // 她的主会话目录不叫 session-<uuid>（就叫 feiyu），用 session-* 过滤会漏掉她全部用量
  assert.doesNotMatch(py, /'session-\*'/)
})

ok('python 侧按 assistant/message 的 usage 记账，且区分她与主人', () => {
  const py = read('tools/lib/ledger_usage.py')
  assert.match(py, /assistant\/message/)
  assert.match(py, /inputTokens/)
  assert.match(py, /outputTokens/)
  assert.match(py, /cacheReadTokens/)
  assert.match(py, /--mine/)
})

ok('账本模块不写死余额接口，也不把 0 当余额', () => {
  const m = read('tools/lib/ledger.mjs')
  assert.match(m, /balanceUrl/)                       // 走配置，不硬编码
  assert.match(m, /if \(!url \|\| !key\) return null/)
  assert.match(m, /Number\.isFinite\(w\.total\)/)     // 接口不通/字段缺 → 过滤掉，不是 0
  assert.match(m, /balance_infos/)                    // 官方口径：多币种全留
})

ok('唤醒提示里必须带上账本块，并告诉她"这账你自己能查"', () => {
  const s = read('lib/scheduler.js')
  assert.match(s, /ledgerLines/)
  assert.match(s, /ledgerTick/)
  // 提示语里得给出她真能敲的那条命令（形如 `… feiyu.mjs ledger`）
  assert.match(s, /\$\{cli\} ledger/)
})

ok('账本刷新不能被唤醒闸门挡住（她忙的时候才最需要查账）', () => {
  const s = read('lib/scheduler.js')
  // tick 一开头就有 `if (stopped || waking || … ) return`；刷新必须挂在 setInterval 外面
  assert.match(s, /const tickWithLedger = \(\) => \{[\s\S]{0,160}ledgerTick\(readToolConfig\(\)\)/)
  assert.match(s, /setInterval\(tickWithLedger, 60_000\)/)
  // 别在 tick 体内再调一次（会跟着闸门被跳过、还会双跑）
  const tickBody = s.slice(s.indexOf('async function tick()'), s.indexOf('const tickWithLedger'))
  assert.doesNotMatch(tickBody, /ledgerTick\(/)
})

ok('聊天提示里（QQ/微信/抖音私信）带账本，群聊不带', () => {
  const p = read('tools/lib/persona.mjs')
  assert.match(p, /function ledgerBlock/)
  assert.match(p, /if \(isGroup\) return ''/)        // 家里的账不外扬
  assert.match(p, /readBrief\(\)/)
})

ok('命令表里有 ledger，且 run 导出对得上（feiyu.mjs 只认 run）', () => {
  assert.match(read('tools/feiyu.mjs'), /ledger: '/)
  const c = read('tools/commands/ledger.mjs')
  assert.match(c, /export async function run\(/)
  assert.doesNotMatch(c, /export async function main\(/)
})

ok('两个常驻服务都起了账本刷新（否则聊天里永远是旧数字）', () => {
  for (const f of ['tools/commands/qq-server.mjs', 'tools/commands/douyin-dm-server.mjs']) {
    const s = read(f)
    assert.match(s, /startBriefRefresher/)
  }
})

ok('配置里有账本默认值（预算/单价/工作区）', () => {
  const c = read('tools/lib/config.mjs')
  assert.match(c, /ledger: \{/)
  assert.match(c, /dailyBudget/)
  assert.match(c, /mineWorkspace/)
})

// ── ⑥b 真拼一次唤醒提示：账本块要成行，不能被数组 join(', ') 糊成一坨 ────────
// （踩过：ledgerLines 返回数组，忘记 spread 就把整块数组当字符串塞进去了，
//   渲染成"…¥7.06,  这是你自己能查的账…"—— 她读起来像乱码。）
ok('唤醒提示：账本块按行渲染，且给出她能敲的那条命令', async () => {
  const file = path.join(DATA, 'cache', 'ledger-brief.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    at: Date.now(),
    line: '今天吃了 1.2 万 token ≈ ¥0.03 ； 预算 ¥3/天，还剩 ¥2.97',
    report: { me: { leftOfBudget: 2.97 }, week: { cost: 0.1 }, quotas: [] },
  }))
  const S = await import('../lib/scheduler.js')
  const cfg = { ledger: { enabled: true } }
  const txt = S.wakePrompt({ action: 'look', maxVideos: 3 }, cfg, 'D:/x/tools/feiyu.mjs')
  assert.match(txt, /【账本】今天吃了 1\.2 万 token/)
  assert.match(txt, /feiyu\.mjs"? ledger/)          // 命令要给全（她有 shell，能自己敲）
  assert.doesNotMatch(txt, /¥0\.03, /)              // 别被数组 join 成 ", …"
  const block = txt.split('【账本】')[1].split('\n').slice(0, 4)
  assert.ok(block.every((l) => !l.includes('], ')), '账本块里出现了数组字面量，说明漏了展开')
})

// ── ⑦ 真扫一次（可选，慢）：环境里没 python 就跳过 ──────────────────────────
const py = L.pythonPath()
if (fs.existsSync(py)) {
  const u = await L.usage({ fresh: true })
  ok('真扫会话日志：能算出按天用量', () => {
    assert.ok(Array.isArray(u.days))
    assert.ok(u.sessions >= 0)
    for (const d of u.days) {
      assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(d.mine && d.other)
      // total = input + output + cache（缓存命中单算，别重复加）
      for (const k of ['mine', 'other']) {
        const t = d[k]
        assert.equal(t.total, t.input + t.output + t.cache, `${d.day} ${k} total 口径不对`)
      }
    }
    if (u.days.length) {
      const last = u.days[u.days.length - 1]
      assert.ok(last.all.total >= last.mine.total)
    }
  })
} else {
  console.log(`  ⚠ 没有 python（${py}），跳过真扫用例`)
}

console.log(`\n账本测试：${passed} 项全过`)
fs.rmSync(sandbox, { recursive: true, force: true })