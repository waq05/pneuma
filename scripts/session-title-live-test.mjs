/**
 * session-title-live 的自测：用桩 ctx 跑一遍回合内刷新标题的真实代码。
 *
 * 为什么不在真实宿主里测：起标题会消耗模型请求并改真实 meta.json。这里用
 * 临时 DSC_HOME（插件读的 meta.json 落在临时目录）+ 假 LLM，验证的是「什么时候
 * 该请求、什么时候不许动、收摊之后还跑不跑」这三件事。
 *
 * 跑法：node scripts/session-title-live-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP = 'D:/dsc'
const PLUGIN_DIR = join(APP, 'examples/plugins')
const home = mkdtempSync(join(tmpdir(), 'dsc-title-live-'))
// 必须在 import 插件之前设：path-policy 在模块加载时求值
process.env.DSC_HOME = home

const hook = await import(pathToFileURL(join(APP, 'lib/core/dsh-compat/resolve-hook.js')).href)
hook.ensureResolveHook([PLUGIN_DIR], APP)

const file = join(PLUGIN_DIR, 'session-title-live.js')
const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

// ── 桩：一个会话、一个假 LLM、一张事件表 ──────────────────────────────────
const session = {
  meta: { id: 's1' },
  messages: [{ role: 'user', content: '帮我把登录页的样式修一下' }],
}
const listeners = new Map()
let streamCalls = []
let refreshCount = 0
const routes = []

const ctx = {
  get: (name) => (name === 'agent' ? { sessionFor: () => session } : undefined),
  on: (name, fn) => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn])
    return () => {
      listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn))
    }
  },
  emit: () => {},
  session: {
    current: () => session,
    refresh: async () => { refreshCount += 1 },
  },
  llm: {
    routeForSession: (target) => {
      routes.push(target.meta.id)
      return { api: 'fake', baseUrl: 'http://fake', apiKey: 'sk-not-real', model: 'fake-model' }
    },
    stream: async (_api, request) => {
      streamCalls.push(request)
      return { text: '「修登录页样式」' }
    },
  },
}

const emit = (name, ...args) => {
  for (const fn of listeners.get(name) ?? []) fn(...args)
}

const readMeta = () => JSON.parse(readFileSync(join(home, 'sessions', 'meta.json'), 'utf8')).sessions

console.log('session-title-live 自测')
const dispose = mod.apply(ctx, { intervalMs: 20, maxUpdates: 3 })
emit('dsc/turn-start', { sessionId: 's1', sessionPath: 'p1' })

// 1) 只有用户一句话：不起名（否则就是把第一句话抄一遍）
await sleep(80)
check('只有用户消息时不请求', () => assert.equal(streamCalls.length, 0))

// 2) 助手产出内容：请求一次，标题清洗后写 autoTitle
session.messages.push({ role: 'assistant', content: '先看样式文件，再改按钮颜色' })
await sleep(80)
check('有进展后请求一次', () => assert.equal(streamCalls.length, 1))
check('cleanTitle 洗掉引号', () => assert.equal(mod.cleanTitle('「修登录页样式」'), '修登录页样式'))
check('写进 autoTitle', () => assert.equal(readMeta().s1?.autoTitle, '修登录页样式'))
check('按会话取路由', () => assert.deepEqual(routes, ['s1']))
check('列表刷新过', () => assert.ok(refreshCount >= 1))

// 3) 同一份消息不重复请求
await sleep(80)
check('消息没变不重复请求', () => assert.equal(streamCalls.length, 1))

// 4) 用户改名：立刻收摊，之后不再请求
// 直接取插件解析到的同一份 runtime 文件（单实例），而不是裸说明符——测试脚本不在插件目录里
const { patchSessionMeta } = await import(
  pathToFileURL(join(APP, 'lib/node_modules/@pneuma/runtime/core/session-meta.js')).href
)
patchSessionMeta('s1', { title: '我自己的名字' })
session.messages.push({ role: 'assistant', content: '按钮颜色改好了' })
await sleep(100)
check('用户改名后不再请求', () => assert.equal(streamCalls.length, 1))
check('用户改名不被覆盖', () => assert.equal(readMeta().s1.title, '我自己的名字'))

// 5) 回合结束：收摊
session.meta = { id: 's2' }
session.messages = [{ role: 'user', content: '第二个会话' }]
emit('dsc/turn-start', { sessionId: 's2', sessionPath: 'p2' })
session.messages.push({ role: 'assistant', content: '处理中' })
await sleep(60)
const before = streamCalls.length
emit('dsc/turn-end', 'completed', { sessionId: 's2', sessionPath: 'p2' })
session.messages.push({ role: 'assistant', content: '又有进展' })
await sleep(80)
check('回合结束后不再请求', () => assert.equal(streamCalls.length, before))

// 6) 停用：disposer 之后事件不再触发，定时器清掉
dispose()
const afterDispose = streamCalls.length
emit('dsc/turn-start', { sessionId: 's1', sessionPath: 'p1' })
await sleep(80)
check('停用后事件不再生效', () => assert.equal(streamCalls.length, afterDispose))
check('停用后监听已退订', () => assert.equal((listeners.get('dsc/turn-start') ?? []).length, 0))

rmSync(home, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
