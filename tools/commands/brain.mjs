// brain 命令 —— 脑的体检 / 检索 / 巩固 / 迁移 / 评测（v3 §12/§15）。
//
//   node tools/feiyu.mjs brain doctor              # 8 条不变量 + 数字
//   node tools/feiyu.mjs brain stats
//   node tools/feiyu.mjs brain recall "烧鸭"        # 看它现在能召回什么
//   node tools/feiyu.mjs brain consolidate [--llm] [--dry]
//   node tools/feiyu.mjs brain intents [--all]
//   node tools/feiyu.mjs brain facts [--conflicts]
//   node tools/feiyu.mjs brain migrate [owner|lore|all]
//   node tools/feiyu.mjs brain eval [--calibrate]
//   node tools/feiyu.mjs brain self [show|owner|narrative]
//   node tools/feiyu.mjs brain emit "一句话" [--platform qq] [--role user|assistant]
//   node tools/feiyu.mjs brain tick
//   node tools/feiyu.mjs brain schema [--show]      # O6 图式（30 天 × 5 次才归纳）
//   node tools/feiyu.mjs brain competence [--show]  # O13 能力自评（成功 3 次才算会）
//   node tools/feiyu.mjs brain task [list|add|done|fail|history]  # 身体/工具协议
//   node tools/feiyu.mjs brain backfill [N]         # 把旧 episodes.jsonl 导进脑
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import * as brain from '../brain/index.mjs'
import * as episode from '../brain/episode.mjs'
import * as facts from '../brain/facts.mjs'
import * as intents from '../brain/intents.mjs'
import * as consolidate from '../brain/consolidate.mjs'
import * as recall from '../brain/recall.mjs'
import * as evalMod from '../brain/eval.mjs'
import * as selfM from '../brain/self.mjs'
import * as attention from '../brain/attention.mjs'
import * as working from '../brain/working.mjs'
import * as metrics from '../brain/metrics.mjs'
import * as inv from '../brain/index-inv.mjs'
import * as backfill from '../brain/backfill.mjs'
import * as schema from '../brain/schema.mjs'
import * as competence from '../brain/competence.mjs'
import * as tasks from '../brain/taskqueue.mjs'

const has = (flag) => process.argv.includes(flag)
// run(argv) 收到的是 feiyu.mjs 的 slice(3)：argv[0] 才是子命令，argv[1..] 是它的参数
let ARGV = []
const rest = () => ARGV.slice(1).filter((a) => !a.startsWith('--'))

function printDoctor() {
  const r = brain.doctor.run({ measurePrompt: !has('--no-prompt') })
  console.log(`脑体检 · mode=${r.mode} · ${r.ok ? '全绿' : '有项要修'}`)
  for (const it of r.items) console.log(`  ${it.ok ? '✓' : '✗'} ${it.name}${it.detail ? ' —— ' + it.detail : ''}`)
  console.log('\n数字：')
  console.log(JSON.stringify(r.numbers, null, 1))
}

export async function run(argv = []) {
  ARGV = argv
  const sub = String(argv[0] || 'doctor').toLowerCase()
  const cfg = config()
  brain.configure(cfg)

  if (sub === 'doctor') return printDoctor()

  if (sub === 'stats') {
    console.log(JSON.stringify({
      mode: brain.mode(),
      episodes: episode.allEpisodes().length,
      index: inv.stats(),
      facts: facts.stats(),
      intents: intents.stats(),
      consolidation: consolidate.status(),
      attention: attention.state().inbox?.length || 0,
      metrics: metrics.snapshot().last30,
    }, null, 1))
    return
  }

  if (sub === 'recall') {
    const q = rest().join(' ') || '最近'
    const isGroup = has('--group')
    const b = recall.bundle({ platform: 'qq', chatId: has('--chat') ? argv[argv.indexOf('--chat') + 1] : 'qq:cli', userText: q, isGroup })
    console.log(`线索：${q}${isGroup ? '（群聊 audience）' : ''}`)
    console.log('情景：\n' + (b.lines.map((l) => '  ' + l).join('\n') || '  （没有）'))
    console.log('事实：\n' + (b.facts.map((f) => `  · ${facts.P_LABEL[f.p] || f.p}：${f.o}`).join('\n') || '  （没有）'))
    console.log(`字数：${b.chars}`)
    return
  }

  if (sub === 'consolidate') {
    const dryRun = has('--dry')
    let chatFn = null
    if (has('--llm')) {
      const llm = await import('../lib/llm.mjs')
      chatFn = (messages) => llm.chat(messages, { temperature: 0.3, max_tokens: 400 })
    }
    const r = brain.runConsolidation({ dryRun, chatFn })
    console.log(JSON.stringify(r, null, 1))
    return
  }

  if (sub === 'intents') {
    const rows = has('--all') ? intents.all() : intents.all().filter((x) => ['open', 'leased', 'blocked', 'missed'].includes(x.state))
    for (const x of rows) {
      const late = Number(x.dueAt) < Date.now() ? ` 晚 ${Math.round((Date.now() - x.dueAt) / 3600000)}h` : ''
      console.log(`${x.id} [${x.state}/${x.kind}] ${x.object}  验收=${x.verify || '-'}${late}${x.verifyState?.reason ? '  ' + x.verifyState.reason : ''}`)
    }
    if (!rows.length) console.log('（空）')
    return
  }

  if (sub === 'schema') {
    const r = has('--show') ? { items: schema.all() } : brain.rebuildDerived({ write: true })
    console.log(JSON.stringify(has('--show') ? r : { schema: r.schema, competence: r.competence }, null, 1))
    return
  }

  if (sub === 'competence') {
    const r = has('--show') ? { items: competence.all(), stats: competence.stats() } : brain.rebuildDerived({ write: true })
    console.log(JSON.stringify(has('--show') ? r : { competence: r.competence }, null, 1))
    return
  }

  // 身体/工具协议：脑出任务、常驻体认领执行（node tools/feiyu.mjs brain task add binge -- --show X）
  if (sub === 'task') {
    const act = rest()[0] || 'list'
    if (act === 'add') {
      const kind = rest()[1] || ''
      const dash = ARGV.indexOf('--')
      const args = dash >= 0 ? ARGV.slice(dash + 1) : ARGV.slice(3)
      console.log(JSON.stringify(tasks.enqueue({ kind, args, note: rest()[2] || '' }), null, 1))
      return
    }
    if (act === 'done') {
      console.log(JSON.stringify(tasks.complete(rest()[1] || '', { ok: true, result: rest()[2] || '' }), null, 1))
      return
    }
    if (act === 'fail') {
      console.log(JSON.stringify(tasks.complete(rest()[1] || '', { ok: false, error: rest()[2] || '' }), null, 1))
      return
    }
    if (act === 'history') {
      console.log(JSON.stringify(tasks.history(Number(rest()[1]) || 20), null, 1))
      return
    }
    console.log(JSON.stringify({ stats: tasks.stats(), rows: tasks.list() }, null, 1))
    return
  }

  if (sub === 'facts') {
    if (has('--conflicts')) {
      console.log(JSON.stringify(facts.conflicts(), null, 1))
      return
    }
    for (const f of facts.active()) console.log(`${f.p}  ${f.o}  [${f.source}] conf=${f.belief?.conf} prov=${(f.prov || []).join(',')}`)
    return
  }

  if (sub === 'migrate') {
    const what = rest()[0] || 'all'
    const out = {}
    if (what === 'owner' || what === 'all') {
      const legacy = (() => {
        try {
          const j = JSON.parse(fs.readFileSync(dataPath('facts.json'), 'utf8').replace(/^\uFEFF/, ''))
          return Array.isArray(j?.owner) ? j.owner : []
        } catch { return [] }
      })()
      out.owner = { rows: legacy.length, ...facts.migrateOwnerFacts({ legacyRows: legacy }) }
    }
    if (what === 'lore' || what === 'all') {
      const lore = (() => { try { return JSON.parse(fs.readFileSync(dataPath('lore.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null } })()
      out.lore = facts.classifyLore({ lore })
    }
    console.log(JSON.stringify(out, null, 1))
    return
  }

  if (sub === 'eval') {
    if (has('--calibrate')) {
      const r = evalMod.calibrate({ rounds: 2 })
      console.log(JSON.stringify(r, null, 1))
    } else {
      const r = evalMod.run({ limit: Number(rest()[0]) || 120 })
      console.log(JSON.stringify({ n: r.n, recallAt6: r.recallAt6, mrr: r.mrr }, null, 1))
      for (const m of r.misses) console.log(`  漏了：${m.cues} → 期望 ${m.expect}，拿到 ${m.got.join(',')}`)
    }
    return
  }

  if (sub === 'self') {
    const what = rest()[0] || 'show'
    const s = selfM.read()
    if (what === 'owner') console.log(s.owner || '（空）')
    else if (what === 'narrative') console.log(s.narrative || '（空）')
    else console.log(JSON.stringify({ owner: s.owner, self: s.self, narrative: s.narrative, meta: selfM.readMeta(), manifest: selfM.manifest() }, null, 1))
    return
  }

  if (sub === 'emit') {
    const text = rest().join(' ')
    const role = has('--role') ? argv[argv.indexOf('--role') + 1] : 'user'
    const platform = has('--platform') ? argv[argv.indexOf('--platform') + 1] : 'qq'
    const r = brain.onEvent({ proc: 'brain-cli', platform, chatId: 'qq:cli', userId: 'cli', role, text })
    console.log(JSON.stringify({ ok: r.ok, id: r.ep?.id, gist: r.ep?.gist, reason: r.reason }, null, 1))
    return
  }

  if (sub === 'backfill') {
    const r = backfill.importLegacy({ limit: Number(rest()[0]) || 20000 })
    console.log(JSON.stringify(r, null, 1))
    return
  }

  if (sub === 'tick') {
    console.log(JSON.stringify(brain.tick(), null, 1))
    return
  }

  if (sub === 'working') {
    const chat = has('--chat') ? argv[argv.indexOf('--chat') + 1] : 'qq:cli'
    console.log(working.render(chat) || '（空）')
    return
  }

  console.log(`不认识的子命令：${sub}`)
  console.log('可用：doctor / stats / recall / consolidate / intents / facts / migrate / eval / self / emit / tick / working')
  process.exit(1)
}

export default { run }