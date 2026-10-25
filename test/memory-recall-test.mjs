// 记忆重构的回归测试（10-25）：统一时序回忆 / 占位符归一 / 全文检索 / 时间常驻层
//
// 跑法：node test/memory-recall-test.mjs
//
// ⚠️ 隔离：路径模块在 **import 时**就把 HOME 定死了（paths.mjs: USERPROFILE || HOME || os.homedir()），
// 而且要读 ~/.feiyu-ai 里的人都是这么解析的。所以必须在任何 import 之前把 USERPROFILE / DSH_HOME
// 指到临时目录 —— 否则测试会往她真实的记忆里写假数据（10-25 踩过一次，还误删了真实的行）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-mem-'))
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
fs.mkdirSync(path.join(tmp, '.feiyu-ai'), { recursive: true })

const { normalizeMemoryText, hasPlaceholder } = await import('../tools/lib/normalize.mjs')
const paths = await import('../tools/lib/paths.mjs')
const memory = await import('../tools/lib/memory.mjs')

if (!paths.dataDir.startsWith(tmp)) {
  console.error(`✗ 隔离失败：dataDir=${paths.dataDir} 指向了真实目录，测试中止`); process.exit(2)
}

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('\n[1] 占位符归一（normalize）')
{
  const a = normalizeMemoryText('这个看起来好好吃\n顾思苡：[分享视频]')
  ok('裸分享卡片变成带解释的占位符', a.includes('分享视频（只有卡片标题，正文看不到是正常的）'), a)
  const b = normalizeMemoryText(a)
  ok('幂等：再归一一次不变', b === a, JSON.stringify(b))
  const c = normalizeMemoryText('看这个 ![](http://127.0.0.1:50251/api/memes/a.png)')
  ok('本地死链变 [图片]', c.includes('[图片') && !c.includes('127.0.0.1'), c)
  ok('hasPlaceholder 认得出占位符', hasPlaceholder(a) && !hasPlaceholder('普通一句话'))
}

console.log('\n[2] 统一时序回忆（recallAll）')
{
  const now = Date.now()
  // 造三通道的假记忆
  memory.remember('qq', 'qq:1', '1', 'user', 'QQ 这边：我刚说明天想去芒市')
  memory.remember('web', 'web:roam', 'self', 'assistant', '（写了小说片段：夜里的白饭——深夜厨房只剩一盏灯）')
  memory.remember('douyin', 'douyin-dm:owner', 'owner', 'assistant', '抖音这边：滑肉片那家我记得，汤汁看着就下饭')
  memory.remember('wechat', 'wechat:work', 'boss', 'user', '微信工作记录不该出现')
  const r = memory.recallAll('qq:1', { hours: 12, max: 12, now })
  const joined = r.lines.join('\n')
  ok('看得到别的通道（抖音）', joined.includes('[抖音]'), joined)
  ok('看得到她自己做的事（上网写小说）', joined.includes('写了小说片段'), joined)
  ok('看不到微信', !joined.includes('微信工作记录'))
  ok('排除当前通道（避免和 recent 重复）', !joined.includes('我刚说明天想去芒市'))
  ok('从新到旧（第一条时间不早于最后一条）', r.lines.length >= 2
    ? (r.lines[0].slice(0, 5) >= r.lines[r.lines.length - 1].slice(0, 5))
    : true, joined)
  ok('每行都带时间+通道标记', r.lines.every(l => /^\d{2}:\d{2} \[.+\] (主人|我)：/.test(l)), joined)
}

console.log('\n[3] 全文检索（grepEpisodes）')
{
  const hits = memory.grepEpisodes('小说', { days: 1 })
  ok('按关键词翻得到旧账', hits.length >= 1 && hits.some(h => h.text.includes('写了小说片段')), JSON.stringify(hits).slice(0, 120))
  const none = memory.grepEpisodes('根本不存在的词xyz', { days: 1 })
  ok('搜不到时返回空', none.length === 0)
  const byRole = memory.grepEpisodes('小说', { days: 1, role: 'user' })
  ok('role 过滤有效', byRole.length === 0)
}

console.log('\n[4] 时间常驻层（lastByRole）')
{
  const r = memory.lastByRole('qq:1')
  ok('能拿到主人最后一次说话的时间', Number(r.lastUser) > 0, JSON.stringify(r))
  ok('能拿到她最后一次说话的时间（此通道没说过 → 0）', r.lastAssistant === 0, JSON.stringify(r))
}

console.log('\n[5] recent 不吃 event 行（10-25 抖音 422 的根因）')
{
  memory.remember('douyin', 'douyin:vid1', 'author', 'event', '某条视频的标题')
  memory.remember('douyin', 'douyin:vid1', 'author', 'assistant', '本鱼来评论一句')
  const rows = memory.recent('douyin:vid1', 10)
  ok('recent 只出 user/assistant', rows.every(x => x.role === 'user' || x.role === 'assistant'), JSON.stringify(rows))
  ok('event 行被挡掉', !rows.some(x => x.content === '某条视频的标题'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
