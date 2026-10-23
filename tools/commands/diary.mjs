// diary —— 两本日记：给你的那本（有细节有情绪）+ 她自己的那本（不加滤镜）。
// 写日记不可关 —— "今天不想看"也得写清楚为什么（dafeiyu 与 bili-whale 共同的坚持）。
//
//   node feiyu.mjs diary --book owner  --append "…"
//   node feiyu.mjs diary --book owner  --show [--tail 20]
//   node feiyu.mjs diary --path
import fs from 'node:fs'
import { diaryPath, WORK_DIR } from '../lib/paths.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export function run(argv = []) {
  const book = arg(argv, '--book') === 'private' ? 'private' : 'owner'
  const file = diaryPath(book)

  if (argv.includes('--path')) { console.log(file); return }

  if (argv.includes('--append')) {
    const text = arg(argv, '--append')
    if (!text) { console.error('✗ --append 后面要有内容'); process.exit(2) }
    fs.mkdirSync(WORK_DIR, { recursive: true })
    const head = fs.existsSync(file) ? '' : `# ${book === 'private' ? '她自己的日记（不加滤镜）' : '给主人的信（有细节有情绪）'}\n\n`
    const stamp = new Date().toLocaleString('sv-SE', { hour12: false })
    fs.appendFileSync(file, `${head}## ${stamp}\n\n${text}\n\n`)
    console.log(`✓ 已写进${book === 'private' ? '她自己的' : '给主人的'}日记（${file}）`)
    return
  }

  if (argv.includes('--show')) {
    if (!fs.existsSync(file)) { console.log('（这本日记还是空的）'); return }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    const tailIdx = argv.indexOf('--tail')
    const tail = tailIdx >= 0 ? Math.max(1, Number(lines[tailIdx + 1]) || 20) : 40
    console.log(lines.slice(-tail).join('\n'))
    return
  }

  console.log(`用法：--book owner|private --append "…" | --show [--tail N] | --path`)
  console.log(`两本：${diaryPath('owner')}\n     ${diaryPath('private')}`)
}
