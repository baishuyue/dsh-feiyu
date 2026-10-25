// selfup —— 她的自我升级安全底座（10-25）：备份 → 改 → 测试 → 日志。
//   node feiyu.mjs selfup backup              # 改代码前先跑：快照整个插件+配置（保留最近 10 份）
//   node feiyu.mjs selfup log "改了什么为什么"  # 改完必跑：写自我升级日志
//   node feiyu.mjs selfup log                 # 翻日志（~/.feiyu-ai/selfup-log.md）
// 规矩（写进 wake prompt 与 AGENTS.md）：只改自己的项目文件；改完 node --check + npm test 全绿才算数。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import { dataPath, configPath } from '../lib/paths.mjs'

const BACKUP_ROOT = () => dataPath('selfup-backups')
const LOG = () => dataPath('selfup-log.md')
// ⚠️ 别再用 new URL(import.meta.url).pathname：路径里有中文/空格/括号（如「新建文件夹 (6)」）时
// 会变成 %E6%96%B0… 且丢掉盘符，path.resolve 后指向不存在的目录 → 备份直接 ENOENT（10-25 实测）。
const HERE = path.dirname(fileURLToPath(import.meta.url))

function doBackup() {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const dest = path.join(BACKUP_ROOT(), ts)
  fs.mkdirSync(dest, { recursive: true })
  const src = path.resolve(HERE, '..', '..')   // dsh-feiyu 项目根
  // 拷贝代码（排除 .git/node_modules/preview）
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const f of fs.readdirSync(from, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'preview', '.workbuddy'].includes(f.name)) continue
      const a = path.join(from, f.name), b = path.join(to, f.name)
      if (f.isDirectory()) copyDir(a, b)
      else fs.copyFileSync(a, b)
    }
  }
  copyDir(src, path.join(dest, 'dsh-feiyu'))
  // 配置 + 人设也快照
  try { fs.copyFileSync(configPath(), path.join(dest, 'feiyu.config.json')) } catch {}
  try { fs.copyFileSync(dataPath('persona.md'), path.join(dest, 'persona.md')) } catch {}
  // 只留最近 10 份
  const olds = fs.readdirSync(BACKUP_ROOT()).sort().reverse().slice(10)
  for (const o of olds) fs.rmSync(path.join(BACKUP_ROOT(), o), { recursive: true, force: true })
  return dest
}

function logLine(text) {
  const now = new Date()
  const day = now.toLocaleDateString('sv-SE')
  const time = now.toTimeString().slice(0, 5)
  const md = LOG()
  let content = ''
  try { content = fs.readFileSync(md, 'utf8') } catch {}
  if (!content.startsWith('# 大肥鱼 · 自我升级日志')) content = '# 大肥鱼 · 自我升级日志\n\n> 她对自己动的每一次手术：改了什么、为什么、验证结果。\n\n'
  if (!content.includes(`## ${day}\n`)) content = content.replace('# 大肥鱼 · 自我升级日志\n\n> 她对自己动的每一次手术：改了什么、为什么、验证结果。\n\n', `# 大肥鱼 · 自我升级日志\n\n> 她对自己动的每一次手术：改了什么、为什么、验证结果。\n\n## ${day}\n\n`)
  const at = content.indexOf(`## ${day}\n`) + `## ${day}\n\n`.length
  content = content.slice(0, at) + `- ${time} ${String(text).slice(0, 400)}\n` + content.slice(at)
  fs.mkdirSync(path.dirname(md), { recursive: true })
  fs.writeFileSync(md, content)
}

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

export async function run(argv = []) {
  const sub = argv[0] || 'help'

  if (sub === 'backup') {
    const dest = doBackup()
    console.log(`✓ 备份完成：${dest}`)
    logLine(`🔒 备份快照 ${path.basename(dest)}（改代码前）`)
    return
  }

  if (sub === 'log') {
    const text = argv.slice(1).join(' ').trim()
    if (!text) {
      try { console.log(fs.readFileSync(LOG(), 'utf8')) } catch { console.log('（还没有升级记录）') }
      return
    }
    logLine(text)
    console.log('✓ 已记录')
    return
  }

  if (sub === 'status') {
    const root = BACKUP_ROOT()
    const backups = fs.existsSync(root) ? fs.readdirSync(root).sort().reverse() : []
    console.log(`备份份数：${backups.length}（${backups[0] ?? '无'} 最新）`)
    try { console.log('最近日志：\n' + fs.readFileSync(LOG(), 'utf8').split('\n').slice(0, 12).join('\n')) } catch {}
    return
  }

  console.log('用法：selfup backup | selfup log "改了什么为什么" | selfup log | selfup status')
}

if (process.argv[1] && process.argv[1].endsWith('selfup.mjs')) {
  await run(process.argv.slice(2))
}
