// 「一次只做一件事」回归测试（10-26 主人纠正）
//
// 主人原话：「原本的完全自由设计是让他具有很高的权限可以自己去做自己想做的事情，
//            现在一起把三个开关打开了其实就失去了自主性，不符合原来的设计，
//            而且也不像活生生的人 —— 活人感强怎么可能同时做那么多事」
//
// 所以设计定死两条：
//   ① 完全自由**不**连带点亮三个循环（那是我上一版的错，等于三条流水线并行）
//   ② 她一次只挑**一件**，`feiyu focus <活动> --min N` 定下来；宿主只放行这一件，
//      到点自动收工；歇着（rest）也照样把循环收干净
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = path.dirname(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const focusMod = await import(pathToFileURL(path.join(REPO, 'tools', 'lib', 'focus.mjs')).href)
const { normActivity, isLoopActivity, syncSwitches, focusSnapshot, labelOf, writeFocus, readFocus, clearFocus, LOOP_ACTIVITIES } = focusMod

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ① 别名归一（她可能写 bili / B站 / 抖音 / 歇着）
ok('bili → bilibili', normActivity('bili') === 'bilibili')
ok('B站 → bilibili', normActivity('B站') === 'bilibili')
ok('抖音 → douyin', normActivity('抖音') === 'douyin')
ok('歇着 → rest', normActivity('歇着') === 'rest')
ok('收工 → off', normActivity('收工') === 'off')
ok('web 认', normActivity('web') === 'web')

// ② 只有三种活动会占住一个循环进程（rest/off 不占）
ok('web/bilibili/douyin 算常驻活动', ['web', 'bilibili', 'douyin'].every(isLoopActivity))
ok('rest 不占循环', !isLoopActivity('rest'))
ok('off 不占循环', !isLoopActivity('off'))
ok('三种活动各有开关路径', Object.values(LOOP_ACTIVITIES).every((m) => Array.isArray(m.sw) && m.sw.length === 2))

// ③ 核心不变量：任何一个活动，配置里同时只能有一个开关是 true
const mkCfg = () => ({
  web: { roam: { enabled: true, restMin: 2 } },
  bilibili: { freeRoam: { enabled: true } },
  douyin: { freeRoam: { enabled: true } },
  freedom: { enabled: true },
})
for (const act of ['web', 'bilibili', 'douyin']) {
  const cfg = mkCfg()
  syncSwitches(cfg, act)
  const on = Object.entries(LOOP_ACTIVITIES).filter(([k, m]) => cfg[m.sw[0]][m.sw[1]].enabled === true).map(([k]) => k)
  ok(`挑「${act}」时只有它一个是开的`, on.length === 1 && on[0] === act, JSON.stringify(on))
  // 别的字段不能被顺手抹掉
  ok(`挑「${act}」时不动其它字段`, cfg.web.roam.restMin === 2)
}
// rest / off → 三个全关
for (const act of ['rest', 'off', '']) {
  const cfg = mkCfg()
  syncSwitches(cfg, act)
  const on = Object.values(LOOP_ACTIVITIES).filter((m) => cfg[m.sw[0]][m.sw[1]].enabled === true)
  ok(`「${act || '空'}」时三个循环全停`, on.length === 0)
}

// ④ 状态快照：剩余时间 / 到期
const now = Date.now()
writeFocus('bilibili', 30, '看那个唱见的新投稿')
const s1 = focusSnapshot(now)
ok('快照认得 bilibili', s1.activity === 'bilibili' && s1.label === '刷B站', JSON.stringify(s1))
ok('剩余分钟算得出', s1.remainMin === 30, String(s1.remainMin))
ok('由头带着', s1.note.includes('唱见'))
const s2 = focusSnapshot(now + 31 * 60_000)
ok('过点标记为到期', s2.expired === true)
ok('到期后剩余为 0', s2.remainMin === 0)
writeFocus('rest', 0, '')
ok('rest 不设时限也算有状态', focusSnapshot().activity === 'rest')
clearFocus()
ok('clear 之后没有状态（= 自由时间）', readFocus() === null || !focusSnapshot().activity)

// ⑤ 源码守卫：完全自由不许再连带三开；必须存在 focusTick 单件放行
const idx = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
ok('完全自由不再连带点亮三个子循环', !/body\.freedom\.enabled === 'boolean'[\s\S]{0,600}setSwitch/.test(idx))
ok('宿主有 focusTick 单件放行', idx.includes('const focusTick') && idx.includes('syncSwitches(cfg2, want'))
ok('到点自动收工', idx.includes("writeFocus('', 0, '到点收工')"))
ok('让位日志（一次只做一件事）', idx.includes('一次只做一件事'))

const sch = fs.readFileSync(path.join(REPO, 'lib', 'scheduler.js'), 'utf8')
ok('唤醒语念"当下在做的事"', sch.includes('focusSnapshot()') && sch.includes('你现在正在做的'))
ok('唤醒语写了"一次只做一件事"', sch.includes('一次只做一件事'))
ok('唤醒语给了 focus 的用法', sch.includes("focus bilibili --min 30"))
ok('不在做别的事时才有评论区巡检', sch.includes('busyElsewhere'))

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)