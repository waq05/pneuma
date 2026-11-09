/**
 * P2 探针：压缩时「原样带过去的清单 / 目标」必须取自**被压缩的那条会话**。
 *
 * 病根（`docs/code-review/2026-11-09/P0-6-7-9-复审.md` 真问题 5）：`compact/index.ts` 的
 * `carry()` 把登记回调当无参函数调，`todo` / `goal` 的携带回调只能问 `ctx.session.current()`。
 * 后果：后台会话压缩时，用户眼前那条会话的清单与目标被塞进了后台会话的摘要。
 *
 * 这个电池真装三个插件（compact / todo / goal），造两条会话：
 *   A = 用户正看着的那条，有清单、有目标；B = 后台会话，清单与目标都空。
 * 对 B 触发压缩（`compact.check(signal, B)`），截住交给摘要的那段 `extra`：
 *   - 修前：extra 里是 A 的清单与目标（FAIL）；
 *   - 修后：extra 是空串（B 没有清单也没有目标），且登记回调收到的会话是 B。
 * 再验两条兼容路径：调用方不带会话时仍按 `ctx.session.current()` 算；轮尾提醒投影
 * 与压缩携带问的是同一个「请求那条会话」。
 *
 * 摘要模型那一层换成记账桩（`compactSession` 不真发请求，只记第 5 个参数 `extra`），
 * 其余全是真插件代码。纯 Node 跑（不需要 build）：`@pneuma/runtime/*` 映射到 `src/*`，
 * `.js` 说明符回落 `.ts`，其余交给 Node 的类型擦除。
 *
 * 运行：node scripts/compact-carry-session-check.mjs
 *
 * @module dsc/scripts/compact-carry-session-check
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// 自检不碰真实 ~/.dsc：插件读配置（`resolvePluginConfig`）与语言（`hostT`）都落在这里。
process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-compact-carry-'))

// ── 摘要调用桩：只为截住「原样带过去的文本」──────────────────────────────────
// 真 `compactSession` 要发一次模型请求，探针不需要模型，只需要它收到的 `extra`。
const stubDir = join(process.env.DSC_HOME, 'stub')
mkdirSync(stubDir, { recursive: true })
const stubPath = join(stubDir, 'session-core-compact.mjs')
writeFileSync(
  stubPath,
  [
    '/** compact 插件要的四个导出：真值换成记账版。 */',
    'export const calls = []',
    'export const DEFAULT_KEEP_RECENT = 20',
    'export const DEFAULT_PRUNE_OPTIONS = { imageBudget: 4, toolResultChars: 2000 }',
    '/** 恒比阈值大：check() 每次都判成「超了」，压缩一定跑起来。 */',
    'export function estimateTokens() {',
    '  return 1_000_000',
    '}',
    'export async function compactSession(session, route, stream, signal, extra) {',
    '  calls.push({ sessionId: session.meta.id, extra })',
    '  return { outcome: "compacted", beforeTokens: 0, afterTokens: 0 }',
    '}',
    '',
  ].join('\n'),
)

// `@pneuma/runtime/*` → src/*；`@pneuma/session-core/compact.js` → 上面那个桩；
// `.js` 说明符回落成 `.ts`。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@pneuma/session-core/compact.js') {
      return { url: pathToFileURL(stubPath).href, shortCircuit: true }
    }
    const mapped = specifier.startsWith('@pneuma/runtime/')
      ? pathToFileURL(join(root, 'src', specifier.slice('@pneuma/runtime/'.length))).href
      : specifier
    try {
      return nextResolve(mapped, context)
    } catch (error) {
      if (mapped.endsWith('.js')) {
        try {
          return nextResolve(`${mapped.slice(0, -3)}.ts`, context)
        } catch {
          // 落到下面把原始错误抛出去
        }
      }
      throw error
    }
  },
})

let pass = 0
let fail = 0

const check = (name, condition, detail) => {
  if (condition) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 一条假会话：压缩只要 meta / filePath / messages，清单与目标还要 state / appendState。 */
const makeSession = (id, filePath) => {
  const states = new Map()
  const writes = []
  return {
    meta: { id, cwd: '/work' },
    filePath,
    messages: [],
    writes,
    state(name) {
      return states.get(name)
    },
    appendState(name, value) {
      states.set(name, value)
      writes.push({ name, value })
    },
  }
}

/** 一份最小的宿主上下文：只实现三个插件真正用到的那几个面。 */
const makeCtx = (current) => {
  const ctx = {
    current,
    provided: {},
    registeredTools: [],
    registeredCommands: [],
    surfaces: {},
    projections: new Map(),
    notices: [],
    compact: undefined,
    provide(name, service) {
      ctx.provided[name] = service
    },
    get(name) {
      if (name === 'agent') return ctx.agent
      if (name === 'waiting') return ctx.waiting
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on() {
      return () => {}
    },
    emit(event, ...args) {
      if (event === 'dsc/notice') ctx.notices.push(args[0])
    },
    session: { current: () => ctx.current },
    // 压缩要的模型面：窗口、路由、模态、流式派发。
    llm: {
      stream: async () => ({ text: '' }),
      contextWindowOf: () => 200_000,
      routeForSession: () => ({ api: 'openai', baseUrl: '', apiKey: '', model: 'probe', maxTokens: 8192 }),
      inputModalities: [],
    },
    tools: {
      register(entry) {
        ctx.registeredTools.push(entry)
        return () => {}
      },
      visible: () => [],
    },
    commands: {
      register(spec, handler) {
        ctx.registeredCommands.push({ spec, handler })
        return () => {}
      },
    },
    surfaces: {
      register(id, fn) {
        ctx.surfaces[id] = fn
        return () => {}
      },
    },
    prompt: {
      systemPrompt: () => 'probe system prompt',
      registerProjection(id, fn) {
        ctx.projections.set(id, fn)
        return () => {}
      },
    },
    settings: { registerSection: () => () => {} },
    transcript: {
      system(text) {
        ctx.notices.push(text)
      },
    },
    waiting: { any: false, anyFor: () => false, ids: [], register: () => () => {} },
  }
  return ctx
}

const runCtxOf = (session) => ({
  sessionId: session.meta.id,
  sessionPath: session.filePath,
  cwd: session.meta.cwd,
  signal: new AbortController().signal,
})

const { compactPlugin } = await import(pathToFileURL(join(root, 'src/packages/compact/index.ts')).href)
const { todoPlugin } = await import(pathToFileURL(join(root, 'src/packages/todo/index.ts')).href)
const { goalPlugin } = await import(pathToFileURL(join(root, 'src/packages/goal/index.ts')).href)
const stub = await import(pathToFileURL(stubPath).href)

// ── 装配：compact 先装（它 provide 的 compact 服务是 todo / goal 登记携带的入口）──
const sessionA = makeSession('sess-a', '/sessions/a.jsonl')
const sessionB = makeSession('sess-b', '/sessions/b.jsonl')
const ctx = makeCtx(sessionA)
ctx.agent = {
  sessionById: (id) => [sessionA, sessionB].find((session) => session.meta.id === id),
  sessionFor: (path) => [sessionA, sessionB].find((session) => session.filePath === path),
}
compactPlugin.apply(ctx)
const compactService = ctx.provided.compact
ctx.compact = compactService
todoPlugin.apply(ctx)
goalPlugin.apply(ctx)

console.log('[1] 造现场：A 有清单与目标，B 什么都没有')
const todoTool = ctx.registeredTools.find((entry) => entry.name === 'todo_write')
const goalTool = ctx.registeredTools.find((entry) => entry.name === 'goal')
check('todo_write 工具已注册', todoTool !== undefined)
check('goal 工具已注册', goalTool !== undefined)

await todoTool.run({ todos: [{ id: 'a1', content: 'A 的活', status: 'pending' }] }, runCtxOf(sessionA))
await goalTool.run({ action: 'create', objective: '把 A 的目标做完' }, runCtxOf(sessionA))
check('A 的清单写进了 A 的会话记录', sessionA.writes.some((write) => write.name === 'todos'))
check('A 的目标写进了 A 的会话记录', sessionA.writes.some((write) => write.name === 'goal'))
check('B 的会话记录还是空的', sessionB.writes.length === 0, JSON.stringify(sessionB.writes))
check('A 自己的提示词投影里有清单', ctx.provided.todo.todoPrompt().includes('A 的活'))
check('A 自己的目标投影在', ctx.provided.goal.goalView()?.objective === '把 A 的目标做完')

// 观察者：登记回调收到的会话是哪一个（修前收到 undefined）。
const seen = []
compactService.registerCarry((session) => {
  seen.push(session)
  return ''
})

console.log('[2] 对 B 触发压缩：带过去的必须是 B 的（空），不是 A 的')
await compactService.check(new AbortController().signal, sessionB)
const extras = stub.calls.map((call) => call.extra ?? '')
check('压缩确实跑起来了（截到了 extra）', stub.calls.length > 0, `calls=${stub.calls.length}`)
check('截到的 extra 全部来自 B 这条会话', stub.calls.every((call) => call.sessionId === 'sess-b'), JSON.stringify(stub.calls.map((call) => call.sessionId)))
check('带过去的是 B 的（空串）', extras[0] === '', JSON.stringify(extras[0]))
check('没有把 A 的清单带进 B 的摘要（P2 核心断言）', !extras.some((extra) => extra.includes('A 的活')), JSON.stringify(extras[0]))
check('没有把 A 的目标带进 B 的摘要（P2 核心断言）', !extras.some((extra) => extra.includes('把 A 的目标做完')), JSON.stringify(extras[0]))
check('登记回调收到的会话是 B', seen[0]?.meta?.id === 'sess-b', JSON.stringify(seen.map((session) => session?.meta?.id)))

console.log('[3] 兼容路径：调用方不带会话时，按当前查看的会话算')
stub.calls.length = 0
ctx.current = sessionA
await compactService.check(new AbortController().signal, undefined)
const compat = stub.calls.map((call) => call.extra ?? '')
check('不带会话时仍带 A 的清单（兼容）', compat.some((extra) => extra.includes('A 的活')), JSON.stringify(compat[0]))
check('不带会话时仍带 A 的目标（兼容）', compat.some((extra) => extra.includes('把 A 的目标做完')), JSON.stringify(compat[0]))
check('不带会话时压缩的确实是当前会话', stub.calls.every((call) => call.sessionId === 'sess-a'))

console.log('[4] 三处同一个会话判定：轮尾提醒也问「请求那条会话」')
{
  const reminder = ctx.projections.get('todo-reminder')
  // 9 条 assistant = 9 轮，超过默认的 8 轮节流线，A 有未完成项 → 会补一条提醒。
  const history = Array.from({ length: 9 }, (_, index) => ({ role: 'assistant', content: `第 ${index} 轮` }))
  const forA = reminder(history, sessionA)
  const forB = reminder(history, sessionB)
  check('A 的轮尾提醒会出现（前置条件）', forA.length === history.length + 1, `len=${forA.length}`)
  check('B 没清单，轮尾提醒不出现（与压缩携带同一判定）', forB.length === history.length, `len=${forB.length}`)
}

console.log('[5] 三处同一个会话判定：目标续跑只看当前查看那条（turn-end 已按 sessionId 挡过）')
ctx.current = sessionB
check('当前看 B（没目标）时续跑拿不到东西', ctx.provided.goal.takeGoalRound() === null)
ctx.current = sessionA
check('当前看 A 时续跑拿到 A 的目标', String(ctx.provided.goal.takeGoalRound() ?? '').includes('把 A 的目标做完'))

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
