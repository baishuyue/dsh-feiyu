// ledger —— 账本：今天吃了多少饭钱、还剩多少额度、钱包还能撑几天。
//
//   node feiyu.mjs ledger                # 人看的表格
//   node feiyu.mjs ledger --days 14      # 多几天明细
//   node feiyu.mjs ledger --json         # 原始数据（给程序读）
//   node feiyu.mjs ledger --brief        # 一行摘要（提示语注入用）
//   node feiyu.mjs ledger --fresh        # 不吃缓存，重扫会话日志
//
// 她的用法（闭环的关键）：**她自己就能查**，不用问主人。
import * as L from '../lib/ledger.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const has = (name) => process.argv.includes(name)

export async function run(argv) {
  const json = has('--json')
  const briefMode = has('--brief')
  try {
    if (briefMode) {
      const r = await L.report({ fresh: has('--fresh') })
      console.log(L.brief(r))
      return
    }
    const r = await L.report({ fresh: has('--fresh'), days: Number(arg(argv, '--days')) || 7 })
    if (json) {
      console.log(JSON.stringify(r, null, 2))
      return
    }
    render(r)
  } catch (e) {
    // 账本查不出来不是灾难：明说查不到，别让她以为"饭钱没了"
    console.error('账本暂时查不到：' + String(e.message).slice(0, 200))
    console.error('（会话日志可能正在写、或 python/zstandard 环境没就绪；稍后再试或问主人）')
    process.exit(1)
  }
}

function render(r) {
  const line = (k, v) => console.log('  ' + String(k).padEnd(16) + v)
  console.log(`\n📒 账本（${r.today}）`)
  line('我今天吃了', `${L.fmtTok(r.me.tokens.total)} token ≈ ¥${r.me.cost}`)
  if (r.me.tokens.calls) line('  · 对话轮数', `${r.me.tokens.calls} 次`)
  if (r.me.budget != null) {
    line('  · 日预算', `¥${r.me.budget}/天` + (r.me.overBudget
      ? `  ⚠ 超了 ¥${Math.abs(r.me.leftOfBudget)} —— 该喊穷了`
      : `  还剩 ¥${r.me.leftOfBudget}`))
  }
  if (r.master.tokens.total) line('主人今天', `${L.fmtTok(r.master.tokens.total)} token ≈ ¥${r.master.cost}`)
  console.log('')
  line(`近 ${r.week.days} 天`, `${L.fmtTok(r.week.mine.total)} token ≈ ¥${r.week.cost}（日均 ¥${r.week.avgPerDay}）`)
  line('累计（我）', `${L.fmtTok(r.lifetime.mineTokens)} token ≈ ¥${r.lifetime.mineCost}`)
  if (r.balance) {
    line('钱包余额', `¥${r.balance.total}（${r.balance.currency}）` + (r.runwayDays != null ? ` —— 按现在这样吃还能撑 ${r.runwayDays} 天` : ''))
  } else {
    line('钱包余额', '看不到（没配 ledger.balanceUrl/apiKey —— 这项得问主人）')
  }
  console.log('\n  今天还能干的活：')
  for (const q of r.quotas) {
    const left = q.limit > 0 ? `${q.left}/${q.limit}` : '不限'
    console.log('    ' + q.label.padEnd(14) + ' 已用 ' + String(q.used).padStart(3) + '  还剩 ' + left)
  }
  console.log(`\n  单价（元/百万 token）：输入 ¥${r.price.input} · 缓存 ¥${r.price.cache} · 输出 ¥${r.price.output}`)
  console.log(`  ${r.usageCached ? '（用量走缓存' : '（刚扫了会话日志'} · ${r.sessions} 个会话）\n`)
}