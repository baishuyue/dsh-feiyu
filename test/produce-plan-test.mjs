// 策划 JSON 抽取的测试（10-27）—— 纯函数，不出网。
//
// 为什么值得单独一套：模型回复里"JSON 后面又补一句带花括号的话"直接把贪婪正则
// `/\{[\s\S]*\}/` 带跑偏，`JSON.parse` 报 "Unexpected non-whitespace character after JSON"，
// 一条片子就此报废（真实发生过：--dry 第一次跑就炸在 position 648）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-plan-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
process.env.DSH_HOME = path.join(SANDBOX, '.dsh')

const ROOT = path.resolve(import.meta.dirname, '..')
const P = await import('file:///' + path.join(ROOT, 'tools/commands/produce.mjs').replace(/\\/g, '/'))

const results = []
const ok = (name, fn) => { try { fn(); results.push([true, name]) } catch (e) { results.push([false, name, e?.message || String(e)]) } }
const PLAN = { title: '第一次吃白饭', scenes: [{ acting: '探头', line: '本鱼第一次吃白饭', video: '我从水面探出上半身，镜头缓慢推近' }], tags: ['白饭'], intro: '简介', cover: '白饭' }

try {
  ok('干净的回复：直接解析', () => {
    assert.equal(P.extractJson(JSON.stringify(PLAN)).title, '第一次吃白饭')
  })

  ok('JSON 后面又补了一句带花括号的话（贪婪正则的老坑）：只取前面那个对象', () => {
    const resp = JSON.stringify(PLAN) + '\n\n补充说明：如果 {不够吃} 就再加一碗。'
    const o = P.extractJson(resp)
    assert.equal(o.title, '第一次吃白饭')
    assert.equal(o.scenes.length, 1)
  })

  ok('吐了两个对象：取第一个完整的', () => {
    const resp = JSON.stringify(PLAN) + '\n' + JSON.stringify({ ...PLAN, title: '第二个' })
    assert.equal(P.extractJson(resp).title, '第一次吃白饭')
  })

  ok('```json 代码块包着也能取', () => {
    const resp = '好的，方案如下：\n```json\n' + JSON.stringify(PLAN, null, 2) + '\n```\n就这些。'
    assert.equal(P.extractJson(resp).title, '第一次吃白饭')
  })

  ok('字符串里的花括号/引号不许把括号计数带偏', () => {
    const tricky = { ...PLAN, intro: '他说"{" 和 "}" 都要算字数 {好} 的' }
    const resp = '前言 {不算} 乱码\n' + JSON.stringify(tricky)
    const o = P.extractJson(resp)
    assert.equal(o.intro, tricky.intro, '字符串里的花括号必须被当成普通字符')
  })

  ok('真没有 JSON：报"策划 JSON 解析失败"（别静默返回空）', () => {
    assert.throws(() => P.extractJson('我今天不想策划，就想躺着。'), /策划 JSON 解析失败/)
    assert.throws(() => P.extractJson(''), /策划 JSON 解析失败/)
  })

  ok('videoPromptFor：她自己写的导演稿优先，没写才有兜底', () => {
    assert.equal(P.videoPromptFor({ video: '我转头看镜头，暖光侧打', line: '台词', acting: '动作' }), '我转头看镜头，暖光侧打')
    const fb = P.videoPromptFor({ line: '本鱼第一次吃白饭', acting: '从水里探出半个脑袋' })
    assert.ok(fb.includes('从水里探出半个脑袋') && fb.includes('镜头缓慢推近'), '兜底要含动作和镜头语言')
    assert.ok(!fb.includes('undefined'), '台词缺失也不许把 undefined 写进提示词')
  })

  const bad = results.filter(([o]) => !o)
  for (const [o, name, err] of results) console.log(`${o ? '✓' : '✗'} ${name}${o ? '' : '\n    ' + err}`)
  console.log(`\n策划解析 ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exitCode = 1
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
}