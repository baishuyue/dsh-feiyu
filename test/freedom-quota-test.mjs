// 完全自由 / 额度渲染回归测试（10-26）
//
// 主人原话：「为什么我打开完全自由他活动的频率反而变少了很多，大部分时间都是空置状态，
//            没有上网刷抖音刷b站和发作品等等动作」
//
// 取证结论（三条都实测）：
//   ① 完全自由只摇人：三个干活的常驻循环（web.roam / bilibili.freeRoam / douyin.freeRoam）
//      配置里是 false，而且 DSH 退出 resetOnExitToggles 会再复位一次 → 实际只有"叫她起床"。
//      她的会话记录：47 次 free 唤醒，最近几轮**每次 0~9 秒、0 个工具**，回复全是"继续睡"。
//   ② 额度渲染错：quota.shareDaily 的语义是「0 = 不限」（quota.mjs: limit > 0 才拦），
//      但提示语直接打印数字 → 渲染成"每天合计 ≤0 条"，她照字面理解成"今天一条也不能发"。
//   ③ 唤醒语自己写着"也可以选择歇着什么都不干""想歇着就收工" → 给了躺平的许可。
//
// 这个测试盯住 ②：0 必须渲染成"不限"，不能渲染成 0 条。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = path.dirname(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const { wakePrompt } = await import(pathToFileURL(path.join(REPO, 'lib', 'scheduler.js')).href)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const base = {
  identity: { name: '大肥鱼' }, owner: { qq: '3082864371' }, guard: { dryRun: false },
  night: { maxVideos: 5 }, share: { minScore: 15 },
}
const st = { atText: '22:00', window: '17:00-24:00', withinWindow: '第2次', maxVideos: 5 }
const line = (cfg) => String(wakePrompt(st, cfg, 'D:/dsh-feiyu/tools/feiyu.mjs')).split('\n').find(l => l.includes('硬限制')) || ''

// ① 0 = 不限，不能写成"≤0 条"
const l0 = line({ ...base, quota: { shareDaily: 0, sameVideoDays: 7 } })
ok('shareDaily=0 → 渲染「每天不限条数」', l0.includes('每天不限条数'), l0)
ok('shareDaily=0 → 绝不出现「≤0 条」', !l0.includes('≤0 条'), l0)

// ② 有额度时照常显示数字
const l3 = line({ ...base, quota: { shareDaily: 3, sameVideoDays: 7 } })
ok('shareDaily=3 → 渲染「每天合计 ≤3 条」', l3.includes('每天合计 ≤3 条'), l3)

// ③ 缺省（没配 quota）按 3 条算，不崩
const lNone = line({ ...base })
ok('没配 quota → 默认 ≤3 条', lNone.includes('≤3 条'), lNone)

// ④ 生物钟提示里必须带上"同一视频 N 天内一次"这条防重
ok('保留同视频查重说明', l3.includes('同一视频 7 天内一次'), l3)

// ⑤ 完全自由提示语里不许再出现"也可以选择歇着什么都不干"这种躺平许可
const sched = fs.readFileSync(path.join(REPO, 'lib', 'scheduler.js'), 'utf8')
ok('唤醒语不再鼓励躺平', !sched.includes('也可以选择歇着什么都不干'))
ok('唤醒语要求至少跑一个真命令', sched.includes('至少跑一个真命令'))
ok('唤醒语带上真实额度数字', sched.includes('今天的额度（真实数字，别自己猜）'))

// ⑥ 完全自由的语义（10-26 主人纠正后定稿）：只摇人 + 只放行她挑的那一件事，
//    **不再**连带点亮三个循环（那会让自主性消失、也不像活人）。
//    单件放行的不变量在 focus-one-thing-test.mjs 里测，这里只守住"不许回退成三开"。
const idx = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
ok('完全自由不再一键三开', !/body\.freedom\.enabled === 'boolean'[\s\S]{0,600}setSwitch/.test(idx))
ok('完全自由仍能随 DSH 自启（总开关）', idx.includes('freedom?.startWithDsh === true'))
ok('自启时不启动任何循环（等她挑）', /startWithDsh === true[\s\S]{0,900}等她自己挑下一件事/.test(idx))

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)