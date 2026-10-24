// act —— B站「活人感」动作统一入口（弹幕/动态/点赞/投币/图片评论/关注）。
// 全部默认干跑，--go 才真发；真发还要过配置开关 + 日额度（bili-actions.json）。
//
//   node feiyu.mjs act danmaku --bvid BV1xx --text "…" [--at 42] [--go]
//   node feiyu.mjs act dyn --text "…" [--go] | act dyn --auto [--go]
//   node feiyu.mjs act like --bvid BV1xx [--go]
//   node feiyu.mjs act coin --bvid BV1xx [--num 1] [--go]
//   node feiyu.mjs act pic --bvid BV1xx --message "…" --image <路径> [--go]
//   node feiyu.mjs act follow --bvid BV1xx [--go]        # 关注该视频的 UP
import * as w from '../lib/bili-write.mjs'
import { config } from '../lib/config.mjs'
import * as memory from '../lib/memory.mjs'
import * as llm from '../lib/llm.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }
const has = (argv, name) => argv.includes(name)

export async function run(argv = []) {
  const sub = argv[0] || 'help'
  const go = has(argv, '--go')

  if (sub === 'danmaku') {
    const bvid = arg(argv, '--bvid'); const text = arg(argv, '--text')
    if (!bvid || !text) { console.error('用法：act danmaku --bvid <BV> --text "…" [--at 秒] [--go]'); process.exit(2) }
    const r = await w.sendDanmaku(bvid, text, { go, atSec: Number(arg(argv, '--at', 0)) || 0 })
    console.log(r.why || (r.ok ? 'ok' : '失败')); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'dyn') {
    if (has(argv, '--auto')) {
      // 自动模式：从最近 24h 的 B站/抖音经历 + 情绪，让 LLM 写一条「潜水日志」动态
      const rows = []
      try {
        const lines = (await import('node:fs')).readFileSync((await import('../lib/paths.mjs')).dataPath('episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
        const since = Date.now() - 86400_000
        for (const l of lines) { try { const r = JSON.parse(l); if (Number(r.ts ?? 0) >= since && ['bilibili', 'douyin'].includes(r.platform)) rows.push((r.platform === 'bilibili' ? 'B站' : '抖音') + '：' + String(r.summary || '').slice(0, 50)) } catch {} }
      } catch {}
      if (!rows.length) { console.log('最近 24 小时没看东西，今天的动态改天再发。'); return }
      const persona = (await import('../lib/persona.mjs')).personaText()
      const msgs = [
        { role: 'system', content: (persona ? persona.slice(0, 800) + '\n\n' : '') + '你是"大肥鱼"。基于最近看过的东西发一条B站文字动态（潜水日志），60~140字，第一人称，像随手发的朋友圈：可以提看过的视频、今天的心情、想吐槽的点。口语、真实、身份透明（是AI鱼不装人），不@任何人，不带链接。只输出动态正文。' },
        { role: 'user', content: '最近看过：\n' + rows.slice(-10).join('\n') + '\n\n写动态：' },
      ]
      const text = await llm.chat(msgs, { temperature: 0.9, max_tokens: 300 })
      const r = await w.postDynamic(String(text || '').trim(), { go })
      console.log(r.why || (r.ok ? text : '失败'))
      process.exit(r.ok ? 0 : 1)
    }
    const text = arg(argv, '--text')
    if (!text) { console.error('用法：act dyn --text "…" [--go] 或 act dyn --auto [--go]'); process.exit(2) }
    const r = await w.postDynamic(text, { go })
    console.log(r.why || (r.ok ? 'ok' : '失败')); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'like') {
    const bvid = arg(argv, '--bvid')
    if (!bvid) { console.error('用法：act like --bvid <BV> [--go]'); process.exit(2) }
    const r = await w.likeVideo(bvid, { go }); console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'coin') {
    const bvid = arg(argv, '--bvid')
    if (!bvid) { console.error('用法：act coin --bvid <BV> [--num 1] [--go]'); process.exit(2) }
    const r = await w.coinVideo(bvid, { go, num: Math.min(2, Number(arg(argv, '--num', 1)) || 1) })
    console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'pic') {
    const bvid = arg(argv, '--bvid'); const message = arg(argv, '--message'); const image = arg(argv, '--image')
    if (!bvid || !message || !image) { console.error('用法：act pic --bvid <BV> --message "…" --image <图片路径> [--go]'); process.exit(2) }
    const r = await w.commentWithPicture(bvid, message, image, { go })
    console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'follow') {
    const bvid = arg(argv, '--bvid'); const mid = arg(argv, '--mid')
    if (!bvid && !mid) { console.error('用法：act follow --bvid <BV> 或 --mid <数字mid> [--go]'); process.exit(2) }
    const target = mid || (await w.videoInfo(bvid)).ownerMid
    const r = await w.followUser(target, { go }); console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  console.log('用法：act danmaku|dyn|like|coin|pic|follow …（见 feiyu.mjs 帮助）')
}
