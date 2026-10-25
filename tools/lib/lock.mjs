// lock —— 自由进程单实例锁（10-25）：完全自由/面板两条路径都能启动同一进程，
// 双实例 = 重复评论/风控灾难。pid 文件锁 + 存活检测，进程退出自动释放。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const DIR = () => dataPath('locks')

/**
 * 尝试获取锁。拿到返回释放函数；已被其它存活实例持有返回 null。
 * @param {string} name 锁名（如 'bili-watch'）
 */
export function acquire(name) {
  try {
    const f = path.join(DIR(), name + '.lock')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (fs.existsSync(f)) {
      const old = Number(fs.readFileSync(f, 'utf8'))
      if (old) {
        try { process.kill(old, 0); return null } catch { /* 旧进程已死，锁是残留 */ }
      }
    }
    fs.writeFileSync(f, String(process.pid))
    let released = false
    const release = () => { if (!released) { released = true; try { if (fs.readFileSync(f, 'utf8') === String(process.pid)) fs.rmSync(f, { force: true }) } catch {} } }
    process.on('exit', release)
    return release
  } catch { return null }   // 锁系统故障不挡业务
}
