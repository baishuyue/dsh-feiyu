// feiyu focus —— 她决定"接下来这一段时间干什么"
//
// 这是完全自由里"自主"那半边：宿主只负责按时叫醒她，**干什么由她自己定**。
// 定下来之后宿主半边（lib/index.js 的 focusTick）会只放行这一件事的常驻循环，
// 其余关掉 —— 一个人一次只能做一件事，这样才像活的。
//
//   node feiyu.mjs focus                              # 我现在在干什么
//   node feiyu.mjs focus web      --min 25            # 接下来 25 分钟上网
//   node feiyu.mjs focus bilibili --min 30 --note "想看那个唱见的新投稿"
//   node feiyu.mjs focus douyin   --min 15
//   node feiyu.mjs focus rest     --min 40 --note "吃饱了犯困"   # 歇着也是正经事
//   node feiyu.mjs focus off                          # 收工，回到没安排的自由时间
import fs from 'node:fs'
import { configPath } from '../lib/config.mjs'
import {
  FOCUS_PATH, LOOP_ACTIVITIES, focusSnapshot, isLoopActivity,
  labelOf, normActivity, readFocus, syncSwitches, writeFocus,
} from '../lib/focus.mjs'

const arg = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function writeCfg(activity) {
  // 读原始文件再写回（别用 config() —— 那是 DEFAULTS 合并后的结果，写回去会把默认值全平铺进配置文件）
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (syncSwitches(j, isLoopActivity(activity) ? activity : '')) {
      fs.writeFileSync(configPath, JSON.stringify(j, null, 2) + '\n')
    }
    return true
  } catch { return false }
}

export async function run(argv = []) {
  const first = normActivity(argv[0])

  // 纯查看
  if (!first || first === 'status') {
    const s = focusSnapshot()
    if (!s.activity) {
      console.log('（没有记录：现在是自由时间，什么都没在跑 —— 可以挑一件事了）')
      console.log('挑法：node feiyu.mjs focus web|bilibili|douyin --min <分钟>  ／ focus rest --min <分钟>')
      return
    }
    const tail = s.expired
      ? '（时限已到 —— 该收工了）'
      : s.remainMin > 0 ? `（还剩 ${s.remainMin} 分钟）` : '（没设时限）'
    console.log(`现在在做：${s.label}${s.min ? ` · 计划 ${s.min} 分钟` : ''}${tail}`)
    if (s.note) console.log(`  由头：${s.note}`)
    console.log(`  记录于 ${s.setAgoMin} 分钟前 → ${FOCUS_PATH.replace(process.env.USERPROFILE || '', '~')}`)
    return
  }

  if (first === 'off' || first === 'clear') {
    writeFocus('off', 0, arg(argv, '--note') || '收工')
    writeCfg('off')
    console.log('✓ 收工了：三个循环都停，回到自由时间（下次醒来自个儿再挑）')
    return
  }

  if (first === 'rest') {
    const min = Number(arg(argv, '--min') || 0)
    const note = arg(argv, '--note') || ''
    writeFocus('rest', min, note)
    writeCfg('rest')
    console.log(`✓ 接下来${min > 0 ? ' ' + min + ' 分钟' : ''}歇着${note ? '：' + note : ''} —— 什么都不跑（刷东西的循环都停了）`)
    return
  }

  if (!isLoopActivity(first)) {
    console.log(`不认识的活法：${argv[0]}。可选：web / bilibili / douyin / rest / off`)
    process.exit(1)
  }

  const min = Number(arg(argv, '--min') || 0)
  const note = arg(argv, '--note') || ''
  const meta = LOOP_ACTIVITIES[first]
  writeFocus(first, min, note)
  writeCfg(first)
  console.log(`✓ 接下来${min > 0 ? ' ' + min + ' 分钟' : ''}${meta.label}（${meta.hint}）${note ? '：' + note : ''}`)
  console.log('  宿主会在 1 分钟内把它拉起来，其余活动自动停；到点自动收工。')
  console.log(`  （想提前收工：node feiyu.mjs focus off）`)
}

export default run