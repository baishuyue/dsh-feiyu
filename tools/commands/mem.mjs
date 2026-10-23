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
  if (cmd === 'facts') {
    for (const f of memory.facts(arg(argv, '--user') || 'owner')) console.log(`· ${f}`)
    return
  }
  // stats
  console.log('记忆库：', JSON.stringify(memory.stats()))
}
