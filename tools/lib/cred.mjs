// 凭据的共用层。
// 复用 dsh-bili-whale 的 tools/lib/cred.mjs（MIT）的设计与错误码翻译，路径改为 ~/.feiyu-ai。
// ① 读凭据统一 trim ② 缺字段说缺哪个 ③ 把常见错误码翻译成人话（-101/-111/12015/10031/12051/-352）
import fs from 'node:fs'
import { credentialsPath } from './paths.mjs'
export const CRED_PATH = credentialsPath

/** 读凭据：统一 trim，容忍 BOM / 首尾空白。 */
export function loadCred() {
  let raw
  try {
    raw = fs.readFileSync(CRED_PATH, 'utf8')
  } catch {
    throw new Error(`没有凭据文件：${CRED_PATH}\n  先在浏览器 F12 复制 SESSDATA / bili_jct / buvid3，写入这个文件（JSON 三个字段）`)
  }
  let j
  try {
    j = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`凭据文件不是合法 JSON：${CRED_PATH}\n  ${String(e.message).slice(0, 80)}`)
  }
  const clean = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')
  return {
    sessdata: clean(j.sessdata),
    bili_jct: clean(j.bili_jct),
    buvid3: clean(j.buvid3),
  }
}

/** 写操作前检查：返回缺什么（空数组 = 可以继续）。 */
export function missingForWrite(cred, opt = {}) {
  const miss = []
  if (!cred.sessdata) miss.push('SESSDATA（登录态）')
  if (!cred.bili_jct) miss.push('bili_jct（写操作必须的 csrf token）')
  if (opt.needBuvid3 && !cred.buvid3) miss.push('buvid3')
  return miss
}

/** bili_jct 的格式自检：B站 目前是 32 位十六进制。 */
export function looksLikeJct(v) {
  return /^[0-9a-fA-F]{32}$/.test(String(v ?? ''))
}

/** 常见返回码 → 人话 + 怎么办（来自 bili-whale 的实战积累）。 */
export const CODE_HINTS = {
  0: '成功',
  '-101': '账号未登录 —— SESSDATA 失效了，重新复制一次 cookie',
  '-111': 'CSRF 校验失败 —— bili_jct 和当前 SESSDATA 不是同一个账号，或已过期\n' +
    '        怎么办：重新登录 B站 → F12 复制一次【两个都要重抄】（SESSDATA + bili_jct）',
  '-400': '请求参数错误（通常是参数没传对）',
  '-352': '风控拦截 —— 请求太快或太像机器人，等几分钟再来',
  '-799': '请求过于频繁 —— 退避一会儿',
  10031: '操作太快（频率限制）—— 退避，别连发',
  12015: '需要验证码 —— 停下，人在浏览器里手动过一次',
  12051: '疑似刷屏 —— 停下，今天别再发了',
  12002: '评论区已关闭 / 不能评论',
}

/** 风控硬停手码：撞到任何一个，今天都不该再发任何东西。 */
export const HARD_STOP_CODES = new Set([-352, -799, 10031, 12015, 12051])

export function explainCode(code) {
  const k = String(code)
  const h = CODE_HINTS[k]
  return h ? `code=${k} ${h}` : `code=${k}（未知返回码）`
}

/** 组合：写操作失败的统一报错文本。 */
export function writeFailText(code, message) {
  return `✗ 发送失败：HTTP 200 ${explainCode(code)}${message ? `（B站原文：${message}）` : ''}`
}
