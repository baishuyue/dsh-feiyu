// mem —— 三层记忆的命令行入口（dafeiyu brain/memory.py 的用法移植）。
//
//   node feiyu.mjs mem remember --chat share --text "…" [--role user]
//   node feiyu.mjs mem fact   --user owner --text "爱吃辣，周三加班"
//   node feiyu.mjs mem lore    --tag origin --text "第一次见到主人是在下雨的下午"
//   node feiyu.mjs mem recall  --query "上次说想养猫"
//   node feiyu.mjs mem old | stats
import * as memory from '../lib/memory.mjs'
import { config } from '../lib/config.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export function run(argv = []) {
  const cmd = argv[0] ?? 'stats'
  const self = config().identity?.name ?? 'feiyu'

  if (cmd === 'remember') {
    memory.remember('bilibili', arg(argv, '--chat') || 'share', arg(argv, '--user') || 'owner',
      arg(argv, '--role') === 'assistant' ? 'assistant' : 'user', arg(argv, '--text'))
    console.log('✓ 已记入情节')
    return
  }
  if (cmd === 'fact') { memory.addFact(arg(argv, '--user') || 'owner', arg(argv, '--text')); console.log('✓ 已记入关系事实'); return }
  if (cmd === 'lore') { memory.addLore(arg(argv, '--tag') || 'misc', arg(argv, '--text')); console.log('✓ 已记入世界设定'); return }
  if (cmd === 'recall') {
    const hits = memory.recall(arg(argv, '--query'))
    if (!hits.length) { console.log('（没有命中旧记忆）'); return }
    for (const h of hits) console.log(`· ${h}`)
    return
  }
  if (cmd === 'old') {
    const old = memory.randomOld()
    console.log(old.length ? `· ${old[0]}` : '（还没有 7 天以上的旧事）')
    return
  }
  // grep —— 翻旧账（灵感来自 dsh-world：不做向量库，靠"原文全留 + 按原话找"）
  if (cmd === 'grep') {
    // 位置参数拼成关键词；带值的开关要跳过它的值（以前会把 `--days 2` 的 2 拼进关键词，永远搜不到）
    const FLAGS = new Set(['--days', '--limit', '--role', '--q', '--query'])
    const parts = []
    for (let i = 1; i < argv.length; i++) {
      const a = String(argv[i])
      if (a.startsWith('--')) { if (FLAGS.has(a)) i++; continue }
      parts.push(a)
    }
    const pattern = arg(argv, '--q') || arg(argv, '--query') || parts.join(' ')
    if (!pattern) { console.error('用法：node feiyu.mjs mem grep "关键词" [--days 7] [--limit 30] [--role user|assistant]'); process.exit(2) }
    const hits = memory.grepEpisodes(pattern, {
      days: Number(arg(argv, '--days') || 0) || 0,
      limit: Number(arg(argv, '--limit') || 30) || 30,
      role: arg(argv, '--role') || '',
    })
    if (!hits.length) { console.log('（没找到）'); return }
    for (const h of hits) {
      const d = new Date(Number(h.ts))
      const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      console.log(`${ts} [${h.platform}] ${h.role}：${h.text.slice(0, 200)}`)
    }
    console.log(`\n共 ${hits.length} 条`)
    return
  }
  if (cmd === 'facts') {
    for (const f of memory.facts(arg(argv, '--user') || 'owner')) console.log(`· ${f}`)
    return
  }
  // recallall —— 看"她现在脑子里装的那块记忆"长什么样（排查用）
  if (cmd === 'recallall') {
    const chatId = arg(argv, '--chat') || 'qq:0'
    const r = memory.recallAll(chatId, { hours: Number(arg(argv, '--hours') || 12), max: Number(arg(argv, '--max') || 12) })
    if (!r.lines.length) { console.log('（这块是空的）'); return }
    for (const l of r.lines) console.log('· ' + l)
    return
  }
  // stats
  console.log('记忆库：', JSON.stringify(memory.stats()))
}
