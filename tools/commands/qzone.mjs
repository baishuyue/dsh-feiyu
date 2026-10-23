// qzone —— 发 QQ 空间说说（NapCat 扩展 API send_qzone_msg）。
// 不是标准 OneBot v11，是 NapCat 扩展；部分版本未暴露（调用会失败，看错误）。
//
//   node feiyu.mjs qzone --content "今天吃了三碗白饭…吧" [--image URL] [--permission 1]
//     permission: 1=所有人可见(默认) 4=好友可见 64=仅自己
import { config } from '../lib/config.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export async function run(argv = []) {
  const cfg = config()
  const QQ = cfg.qq ?? {}
  if (!QQ.enabled) { console.error('✗ qq.enabled=false —— 先在 feiyu.config.json 里开 QQ 开关'); process.exit(1) }
  const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')

  const content = arg(argv, '--content') || argv.find(a => !a.startsWith('--')) || ''
  if (!content) { console.error('用法：node feiyu.mjs qzone --content "…" [--image URL] [--permission 1|4|64]'); process.exit(2) }

  const images = argv.filter((a, i) => argv[i - 1] === '--image').map(s => s.trim()).filter(Boolean)
  const perm = Number(arg(argv, '--permission')) || 1

  const body = { content, ugc_right: perm }
  if (images.length) body.images = images.slice(0, 9)   // 最多 9 张

  if (cfg.guard?.dryRun) {
    console.log('【干跑 ✓】以下说说未发布（guard.dryRun=true）：')
    console.log(`  ${content}` + (images.length ? `\n  附图 ${images.length} 张` : ''))
    return
  }

  const r = await fetch(`${NAPCAT}/send_qzone_msg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  let j = null
  try { j = await r.json() } catch {}
  if (!r.ok || (j && j.status === 'failed')) {
    console.error(`✗ 发说说失败：${JSON.stringify(j ?? r.status).slice(0, 200)}`)
    console.error('  提示：send_qzone_msg 是 NapCat 扩展，部分版本未暴露；确认 NapCat 版本支持，或改用 qzone-bridge 桥接')
    process.exit(1)
  }
  console.log(`✓ 说说已发布${j?.data?.tid ? `（tid=${j.data.tid}）` : ''}`)
}
