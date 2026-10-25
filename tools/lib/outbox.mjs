// outbox —— 她的公开发言台账（B站）：评论/回评/弹幕/动态/图片评论，主人随时翻。
// 动机（10-25 用户）：她在 B站 说了什么、回了谁，主人很难自己去翻 —— 一个文件看尽她的社交进化。
// 位置 ~/.feiyu-ai/bili-outbox.md，按天分组、最新在上，带视频链接点进去就看得到上下文。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const MD = () => dataPath('bili-outbox.md')
const HEADER = '# 大肥鱼 · B站发言台账\n\n> 她在 B站 公开说的每一句话，按天记录（最新在上）。点链接看视频和评论上下文。\n\n'

/** 记一条公开发言。kind: 评论|分享评论|回评|弹幕|动态|图片评论 */
export function recordBili({ kind, title = '', bvid = '', to = '', text = '', extra = '' }) {
  try {
    const now = new Date()
    const day = now.toLocaleDateString('sv-SE')
    const time = now.toTimeString().slice(0, 5)
    const md = MD()
    let content = ''
    try { content = fs.readFileSync(md, 'utf8') } catch {}
    if (!content.startsWith('# 大肥鱼 · B站发言台账')) content = HEADER
    if (!content.includes(`## ${day}\n`)) content = content.replace(HEADER, HEADER + `## ${day}\n\n`)
    const link = bvid ? `[《${String(title || bvid).slice(0, 24)}》](https://www.bilibili.com/video/${bvid})` : (title ? `《${String(title).slice(0, 24)}》` : '')
    const toPart = to ? ` →回应「${String(to).slice(0, 24)}」` : ''
    const extraPart = extra ? ` _(${extra})_` : ''
    const line = `- ${time} **${kind}** ${link}${toPart}：${String(text).slice(0, 160)}${extraPart}\n`
    // 最新插到当天小节最上（当天的从上往下 = 从新到旧）
    const at = content.indexOf(`## ${day}\n`) + `## ${day}\n\n`.length
    content = content.slice(0, at) + line + content.slice(at)
    fs.mkdirSync(path.dirname(md), { recursive: true })
    fs.writeFileSync(md, content)
  } catch { /* 台账失败绝不影响发评本身 */ }
}
