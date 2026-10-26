// 抖音私信「分享卡片认错人/认错条」回归测试（10-26 第二次）
//
// 起因（用户原话）：「我刚刚发的是木又寸_那个视频给她，但是他说的是之前发给他的」。
//
// 真因链条（都实测取证）：
//   ① card-open 点开卡片后，用的是 document.querySelector('[data-e2e="video-desc"]')
//      和 '[data-e2e="user-info"] h1' 读标题/作者 —— 而弹窗是个 **feed 列表**，
//      DOM 里同时躺着前后两条；前者拿到的是**预加载的邻居**（上一条 第18集/莲压抑/19s），
//      后者拿到的是**左侧聊天栏**（聊天对象 朴昌范）。
//      → 于是把上一条视频的标题、作者、时长，套在了这张新卡片上。
//   ② 点哪张卡也只是"取列表里最后一张可见"的猜测 —— 私信列表是 rotate(180deg) 的
//      反向虚拟列表，DOM 顺序和视觉顺序相反。
//
// 修法：卡片按文案点名（--expect），弹窗只读**与视口中线相交**那条的 info 栏，
//      作者对不上就丢弃帧（宁可不说，也不能拿错视频的画面去聊）。
//
// 跑法：node test/card-match-test.mjs（需要 python 能 import douyin_interact）
import { execFileSync } from 'node:child_process'

const PY = process.env.FEIYU_PY || 'D:/social-auto-upload/.venv/Scripts/python.exe'
const CODE = `
import json, sys
sys.path.insert(0, r"D:\\\\dsh-feiyu")
import douyin_interact as d
cases = []
# 解析：卡片文案 → 卡片上那行字
for raw in ["[分享的视频：木又寸_（os 好想要女粉宝宝呀！]", "[分享视频：舌尖序]", "[分享视频]", ""]:
    cases.append(["parse", raw, d._parse_expect(raw)])
# 核对：卡片 vs 弹窗当前条目
pairs = [
    ("[分享的视频：木又寸_（os 好想要女粉宝宝呀！]", "木又寸_（os", "好想要女粉宝宝呀！ · 终于降温", True),
    # 这一组就是 10-26 的事故现场：卡片是木又寸_，弹窗当时却读到邻居 @莲压抑 / 第18集
    ("[分享的视频：木又寸_（os 好想要女粉宝宝呀！]", "莲压抑", "第18集：和姐姐纠缠一辈子也不是什么坏事吧", False),
    ("[分享的视频：莲压抑]", "莲压抑", "第18集", True),
    ("[分享的视频：舌尖序]", "舌尖序", "", True),
    ("[分享视频]", "随便谁", "随便啥", True),   # 老占位符没有期望值 → 不判定
]
for raw, author, desc, _want in pairs:
    cases.append(["match", raw, d._card_matches(d._parse_expect(raw), author, desc)])
print(json.dumps(cases, ensure_ascii=False))
`

let raw
try {
  raw = execFileSync(PY, ['-c', CODE], { encoding: 'utf8', timeout: 120000, windowsHide: true })
} catch (e) {
  console.log('✗ 起不来 python（' + PY + '）：' + String(e.message).slice(0, 200))
  process.exit(1)
}
const rows = JSON.parse(raw.trim().split('\n').pop())
const parse = new Map(rows.filter(r => r[0] === 'parse').map(r => [r[1], r[2]]))
const match = new Map(rows.filter(r => r[0] === 'match').map(r => [r[1] + '|' + r[2] + '|' + (r[3] === undefined ? '' : ''), r[2]]))

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ① 卡文案解析
ok('解析 → 带"分享的视频："前缀', parse.get('[分享的视频：木又寸_（os 好想要女粉宝宝呀！]') === '木又寸_（os 好想要女粉宝宝呀！',
  String(parse.get('[分享的视频：木又寸_（os 好想要女粉宝宝呀！]')))
ok('解析 → "分享视频：" 短前缀', parse.get('[分享视频：舌尖序]') === '舌尖序')
ok('解析 → 老占位符给空串（无法核对）', parse.get('[分享视频]') === '')
ok('解析 → 空输入不炸', parse.get('') === '')

// ② 核对（顺序：卡片、弹窗作者、弹窗文案 → 是否算对上）
const m = rows.filter(r => r[0] === 'match').map(r => r[2])
ok('核对 → 木又寸_ 卡片 vs 木又寸_ 条目 = true', m[0] === true)
ok('核对 → 木又寸_ 卡片 vs 莲压抑 条目 = false（10-26 事故现场）', m[1] === false)
ok('核对 → 莲压抑 卡片 vs 莲压抑 条目 = true', m[2] === true)
ok('核对 → 文案为空也能靠作者名对上', m[3] === true)
ok('核对 → 没期望值时不拦（老占位符）', m[4] === true)

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)