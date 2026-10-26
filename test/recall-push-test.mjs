// 回忆窗口不能被自己的推送淹没（10-26）
//
// 主人报「记忆错乱」。查出来一半是这个：她一次连推 7 条【B站分享】给主人，
// recent() 又把它们当普通对话 —— 她下次回话时看到的"最近聊过"里 12 条有 7 条是自己的广播，
// 真正的对话被挤出窗口，回起来就像忘了刚说过什么。
//
// 隔离做法：先把 USERPROFILE 指到临时目录，再 import memory.mjs（paths.mjs 在 import 时读 env），
// 这样不会碰真实的 ~/.feiyu-ai。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-recall-'))
process.env.USERPROFILE = TMP_HOME
process.env.HOME = TMP_HOME
delete process.env.DSH_HOME

const REPO = path.dirname(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const memory = await import(pathToFileURL(path.join(REPO, 'tools', 'lib', 'memory.mjs')).href + '?t=' + Date.now())

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ① 对话够多时，推送被排除
const CHAT = 'qq:10001'
memory.remember('qq', CHAT, '10001', 'user', '你今天是不是做了视频啊')
for (let i = 0; i < 7; i++) memory.remember('qq', CHAT, '10001', 'assistant', `【B站分享】《测试视频 ${i}》\n好看`, { kind: 'push' })
memory.remember('qq', CHAT, '10001', 'assistant', '那个不算我做…我就出了几个字的题')
memory.remember('qq', CHAT, '10001', 'user', '那你写了啥')
memory.remember('qq', CHAT, '10001', 'assistant', '写了点小说片段，撒撇摊那几碗')
memory.remember('qq', CHAT, '10001', 'user', '撒撇是啥')
memory.remember('qq', CHAT, '10001', 'assistant', '云南的一种凉拌，苦的')

const got = memory.recent(CHAT, 8)
ok('窗口里没有【B站分享】', !got.some((m) => String(m.content).includes('【B站分享】')), JSON.stringify(got.map((m) => String(m.content).slice(0, 12))))
ok('真实对话还在', got.some((m) => String(m.content).includes('撒撇摊')), JSON.stringify(got.map((m) => String(m.content).slice(0, 10))))
ok('条数按 n 截断', got.length <= 8, String(got.length))
ok('带时间戳（她能感知"刚才/很久前"）', got.every((m) => typeof m.at === 'number' && m.at > 0))

// ② 打标记之前的老数据（没有 kind 字段）也要被认出来
const CHAT2 = 'qq:10002'
for (let i = 0; i < 7; i++) memory.remember('qq', CHAT2, '10002', 'assistant', `【B站分享】《旧数据 ${i}》`)
for (let i = 0; i < 5; i++) memory.remember('qq', CHAT2, '10002', 'user', `老对话 ${i}`)
const got2 = memory.recent(CHAT2, 8)
ok('老推送行也当广播', !got2.some((m) => String(m.content).includes('【B站分享】')), JSON.stringify(got2.map((m) => String(m.content).slice(0, 12))))

// ③ 对话很少时不许把她搞失忆 —— 推送照给
const CHAT3 = 'qq:10003'
memory.remember('qq', CHAT3, '10003', 'assistant', '【B站分享】《只有一个》')
memory.remember('qq', CHAT3, '10003', 'user', '嗯')
const got3 = memory.recent(CHAT3, 8)
ok('对话少时推送仍然可见', got3.some((m) => String(m.content).includes('【B站分享】')), JSON.stringify(got3.map((m) => String(m.content).slice(0, 10))))

// ④ 别的会话不串
const gotOther = memory.recent('qq:10004', 8)
ok('不存在的会话不串数据', gotOther.length === 0, String(gotOther.length))

// ⑤ 源码守卫：推送必须带 kind，recent 必须有过滤
const memSrc = fs.readFileSync(path.join(REPO, 'tools', 'lib', 'memory.mjs'), 'utf8')
const notifySrc = fs.readFileSync(path.join(REPO, 'tools', 'lib', 'notify.mjs'), 'utf8')
const qqSrc = fs.readFileSync(path.join(REPO, 'tools', 'commands', 'qq-server.mjs'), 'utf8')
ok('notify 推送带 kind:push', notifySrc.includes("{ kind: 'push' }"))
ok('主动搭话推送带 kind:push', qqSrc.includes("{ kind: 'push' }"))
ok('recent 过滤 push', memSrc.includes("r.kind !== 'push'"))
ok('recent 兼容老数据', memSrc.includes('LEGACY_PUSH'))

fs.rmSync(TMP_HOME, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)