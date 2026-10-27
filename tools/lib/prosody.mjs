// 韵律打分器的 Node 包装 —— 给"这条语音像不像活人在说"打分，供 best-of-N 择优用。
//
// 为什么需要：GPT-SoVITS 同参数连合 8 条，F0 起伏能从 3.5 跳到 5.2 半音（抽奖）。
// 直接发出去就是"有时像人有时像念稿"，挑一遍再发才稳。
// 详见 prosody.py 顶部（含 10-26 的实测数据）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'prosody.py')

/** 分析用的 python（要装 librosa）。默认用 GPT-SoVITS 的解释器 —— 那边一定有。 */
export function pythonPath() {
  const v = config().voice ?? {}
  return v.python || process.env.FEIYU_TTS_PYTHON || 'D:/GPT-SoVITS/.venv/Scripts/python.exe'
}

/**
 * 批量打分（一次 python 启动算完所有候选，别一条一条起进程：冷启动要 4 秒）。
 * @param {{path: string, chars?: number}[]} items
 * @returns {{path:string, ok:boolean, score:number, sd?:number, rng?:number, rate?:number, why?:string}[]}
 */
export function scoreWavs(items) {
  const list = (items || []).filter((i) => i && i.path)
  if (!list.length) return []
  const payload = path.join(os.tmpdir(), `feiyu-prosody-${process.pid}-${Date.now()}.json`)
  try {
    fs.writeFileSync(payload, JSON.stringify({ items: list }), 'utf8')
    const out = execFileSync(pythonPath(), [SCRIPT, payload], {
      encoding: 'utf8', timeout: 180_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      // 中文路径 + Windows 控制台代码页：不钉 UTF-8 的话 python 输出是 GBK，JSON.parse 直接炸，
      // 整个打分器会**静默降级成 0 分**（10-27 才发现：择优实际一直是"用第一条"）。
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const parsed = JSON.parse(out)
    const byPath = new Map((parsed.items || []).map((x) => [x.path, x]))
    return list.map((it) => byPath.get(it.path) || { path: it.path, ok: false, score: 0, why: '没拿到评分' })
  } catch (e) {
    // 评分器坏了不能拖累语音：全部返回 0 分，调用方会退化成"用第一条"
    const msg = '评分器不可用：' + String(e.message).slice(0, 80)
    if (!scoreWavs._warned) { scoreWavs._warned = true; console.warn(`   ⚠ ${msg}`) }
    return list.map((it) => ({ path: it.path, ok: false, score: 0, why: msg }))
  } finally {
    try { fs.rmSync(payload, { force: true }) } catch {}
  }
}

/** 挑最好的一条：ok 是硬门槛（ok = 没被判"缺字/念糊/语速离谱/浊音比过低/平得离谱"），
 *  有 ok 的就在 ok 里挑分最高的；一条 ok 都没有（比如整段语速都偏慢）才按分数硬挑。 */
export function bestOf(scores) {
  const list = (scores || []).filter(Boolean)
  if (!list.length) return null
  const okList = list.filter((s) => s.ok)
  const pool = okList.length ? okList : list
  return pool.reduce((a, b) => (Number(b.score || 0) > Number(a.score || 0) ? b : a))
}