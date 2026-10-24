// notify —— 主动发消息给主人（QQ，走 NapCat OneBot）。
// 用途：抖音看到有意思的视频，不再评论里 @ 主人（风控），而是直接发一条 QQ 给主人，
// 附视频链接 + 她自己的吐槽。主人回一句，qq-server 就顺着继续聊（记忆都在）。
import { config } from './config.mjs'

/**
 * 给主人发一条 QQ 私聊。
 * @returns {Promise<boolean>} 是否发送成功（失败不抛，静默返回 false，由调用方决定）
 */
export async function sendOwnerQQ(text) {
  const cfg = config()
  const ownerQQ = String(cfg.owner?.qq || '').trim()
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) { console.error('[notify] owner.qq 未配置，跳过'); return false }
  const body = JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'text', data: { text: String(text || '').slice(0, 500) } }] })
  try {
    const r = await fetch(`${napcat}/send_private_msg`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => ({}))
    const ok = r.ok && (j.retcode === 0 || j.status === 'ok' || j.message_id)
    if (!ok) console.error(`[notify] 发主人失败：HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    return ok
  } catch (e) {
    console.error('[notify] 发主人异常：' + e.message)
    return false
  }
}
