// 宿主侧的真 node 解析（薄包装，与 tools/lib/runtime.mjs 共用一套探测逻辑）。
// 复用 dsh-bili-whale 的 lib/node-runtime.js（MIT）结构。
import { resolveRuntime } from '../tools/lib/runtime.mjs'

const cache = new Map()
export function nodeRuntime(dshHome) {
  if (!cache.has(dshHome)) cache.set(dshHome, resolveRuntime(dshHome))
  return cache.get(dshHome)
}
export const resolveNodeRuntime = dshHome => nodeRuntime(dshHome).file
export const nodeEnv = dshHome => nodeRuntime(dshHome).env
