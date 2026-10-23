/**
 * client.js 冒烟测试 —— 不需要 DSH 起前端，也能验证：
 *   1. 文件能被 __ModuleLoader__ 正常装载；
 *   2. 导出了 name / inject / apply；
 *   3. apply 注册的槽位是 settings.section（id、label、组件都对）；
 *   4. 组件第一次渲染（loading 态）不抛错。
 *
 * 跑法：node test/client-smoke.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(root, 'client.js')

// —— 极简 React：只要能建树、能跑 hooks 就行 ——
function createElement(type, props, ...children) {
  const flat = []
  for (const c of children.flat(Infinity)) flat.push(c)
  return { type, props: props || {}, children: flat }
}
const reactStub = {
  createElement,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, remove() {} }),
}

require(clientPath)

assert.ok(loaded, 'client.js 没有调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-feiyu', '模块 id 必须是包名 dsh-feiyu')

const mod = loaded.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('未预期的 require：' + name)
})

assert.equal(mod.name, 'dsh-feiyu')
assert.deepEqual(mod.inject, ['slots'], 'inject 只要 slots（不要再加不存在的服务）')
assert.equal(typeof mod.apply, 'function')

// —— 模拟 ctx.slots ——
const registered = []
const ctx = {
  slots: {
    inject(slotName, fn) {
      assert.equal(slotName, 'settings.section')
      return fn()
    },
    register(spec, Component) {
      registered.push({ spec, Component })
      return () => {}
    },
  },
}

mod.apply(ctx)
assert.equal(registered.length, 1, '应该只注册一个槽位')

const { spec, Component } = registered[0]
assert.equal(spec.name, 'settings.section')
assert.equal(spec.id, 'dsh-feiyu', '二建插件的槽位 id 必须全局唯一')
assert.equal(typeof spec.label, 'function')
assert.equal(spec.label(), '大肥鱼')
assert.equal(typeof spec.order, 'number')

// —— 首次渲染（loading 态，不发请求）——
const tree = Component({ close: () => {} })
assert.ok(tree && tree.type === 'div', '首渲染应返回一个 div')
assert.ok(JSON.stringify(tree).includes('读取大肥鱼配置'), '首渲染应显示读取提示')

// —— 包清单契约：dsh-client-modules 只认 exports["./client"] + dsh.client ——
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.ok(pkg.dsh && pkg.dsh.client, 'package.json 必须声明 dsh.client，否则宿主不会去装浏览器半边')
assert.equal(typeof pkg.exports['./client'], 'string', 'exports["./client"] 必须是字符串路径')
const clientOnDisk = path.resolve(root, pkg.exports['./client'])
assert.ok(fs.existsSync(clientOnDisk), 'exports["./client"] 指向的文件必须存在：' + clientOnDisk)
assert.equal(clientOnDisk, clientPath, 'exports["./client"] 应指向仓库根的 client.js')
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 必须是数组')

console.log('client-smoke ✓  槽位已注册：', spec.name, '/', spec.id, 'order=', spec.order)

