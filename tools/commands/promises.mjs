// promises —— 命令行入口（她自己查账用）
//
//   node feiyu.mjs promises              # 全部（含已完成/失败）
//   node feiyu.mjs promises --due        # 现在到点的
//   node feiyu.mjs promises done p1abc "看完了第一集"
//   node feiyu.mjs promises fail p1abc "这条没有字幕"
import * as promises from '../lib/promises.mjs'

export function run(argv = []) {
  const sub = String(argv[0] || '')
  if (sub === 'done' || sub === 'fail') {
    const id = String(argv[1] || '')
    const note = String(argv[2] || '')
    if (!id) { console.error(`用法：promises ${sub} <id> "说明"`); process.exit(2) }
    const it = sub === 'done' ? promises.done(id, note) : promises.fail(id, note)
    if (!it) { console.error(`✗ 没有这个承诺：${id}`); process.exit(1) }
    console.log(`${sub === 'done' ? '✓ 完成' : '✗ 记为没做成'}：${it.what}${note ? '　' + note : ''}`)
    return
  }

  const list = argv.includes('--due') ? promises.dueNow() : promises.list()
  if (!list.length) { console.log('（还没有承诺记录）'); return }
  const fmt = (x) => {
    const due = new Date(Number(x.dueAt) || 0).toLocaleString('zh-CN', { hour12: false })
    const tag = x.state === 'done' ? '✓' : x.state === 'failed' ? '✗' : '·'
    return `  ${tag} ${x.id}  ${x.what}　到期 ${due}${x.tries ? '　拖了 ' + x.tries + ' 次' : ''}${x.why ? '　' + x.why : ''}`
  }
  for (const x of list) console.log(fmt(x))
  const open = list.filter((x) => x.state === 'open').length
  console.log(`\n未完成 ${open} 条（到点 ${promises.dueNow().length} 条）`)
}