// notify —— 主动发消息给主人（QQ，走 NapCat OneBot）。
// 用途：抖音/B站看到有意思的视频，直接发一条 QQ 给主人，附链接 + 她自己的吐槽。
// ⚠️ 发出去的话必须同步写进 QQ 对话记忆（10-24 实锤的脱节坑）：不记的话，
// 鱼看自己的 QQ 聊天流不知道"我刚分享过"，主人问起就一脸懵。
import { config } from './config.mjs'
import * as memory from './memory.mjs'

/**
 * 给主人发一条 QQ 私聊（成功后记进 QQ 记忆，对话流里她"记得自己说过"）。
 * @returns {Promise<boolean>} 是否发送成功（失败不抛，静默返回 false，由调用方决定）
 */
export async function sendOwnerQQ(text) {
  const cfg = config()
  if (cfg.guard?.dryRun) { console.log('[notify] 干跑（guard.dryRun）：这条不真发 → ' + String(text || '').slice(0, 60)); return false }
  const ownerQQ = String(cfg.owner?.qq || '').trim()
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) { console.log('[notify] owner.qq 未配置，跳过'); return false }
  const content = String(text || '').slice(0, 500)
  const body = JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'text', data: { text: content } }] })
  try {
    const r = await fetch(`${napcat}/send_private_msg`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => ({}))
    const ok = r.ok && (j.retcode === 0 || j.status === 'ok' || j.message_id)
    if (!ok) { console.log(`[notify] 发主人失败：HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return false }
    // 发送成功 = 她"亲口说过"这句话：记进 QQ 对话记忆，主人接着聊才接得上
    try { memory.remember('qq', `qq:${ownerQQ}`, ownerQQ, 'assistant', content, { kind: 'push' }) } catch {}
    return true
  } catch (e) {
    console.log('[notify] 发主人异常：' + e.message)
    return false
  }
}
