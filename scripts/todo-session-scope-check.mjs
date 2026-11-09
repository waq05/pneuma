/**
 * P0-7 探针：`todo` / `goal` 的工具按**调用方会话**读写，存储按会话分表。
 *
 * 病根（`docs/code-review/2026-11-09/07-agent-orchestration.md` P0-7）：两个工具落状态一律走
 * `ctx.session.current()`，也就是「用户此刻在看的那条会话」；内存里又只有一份 store。
 * 后台会话或队友调一次 `todo_write` / `goal`，清单与目标会写进别人那条 jsonl，
 * 两条会话并行时互相覆盖。
 *
 * 这个电池真装插件、真调工具（不是读源码猜），验四件事：
 *   1. 工具带 `sessionId/sessionPath` 调进来时，状态写进**那条**会话，不写当前查看的；
 *   2. 两条会话的清单 / 目标互不可见（存储按会话分表）；
 *   3. `goal` 的自动续跑只被**自己那条会话**的挂卡挡住（P0-6 的消费侧）；
 *   4. 没带会话身份的老调用方仍按「当前查看的会话」算（兼容）；
 *   5. **队友会话**（不在 `agent` 名册里，只有 `ToolContext.sessionPath` 指向它）也写进自己那份。
 *
 * 纯 Node 跑（不需要 build）：源码按 NodeNext 写 `.js` 说明符、`@pneuma/runtime/*` 是构建期
 * 映射，这里用官方 resolve hook 补这两条，剩下的交给 Node 的类型擦除。
 *
 * 运行：node scripts/todo-session-scope-check.mjs
 *
 * @module dsc/scripts/todo-session-scope-check
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// 自检不碰真实 ~/.dsc：插件读配置（`resolvePluginConfig`）与语言（`hostT`）都落在这里。
process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-session-scope-'))

// `@pneuma/runtime/*` → src/*（tsconfig paths 的那条映射）；`.js` 说明符回落成 `.ts`。
registerHooks({
  resolve(specifier, context, nextResolve) {
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

const guard = (name, fn) => {
  try {
    fn()
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}  <- 抛错：${error.message}`)
  }
}

/** 一条假会话：只需要 meta / filePath / state / appendState 这四样。 */
const makeSession = (id, filePath) => {
  const states = new Map()
  const writes = []
  return {
    meta: { id, cwd: '/work' },
    filePath,
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

/** 一份最小的宿主上下文：只实现插件真正用到的那几个面。 */
const makeCtx = (current, waiting) => {
  const ctx = {
    current,
    provided: {},
    /** 注册进来的工具（`ctx.tools` 是服务本身，注册表另存一份）。 */
    registeredTools: [],
    registeredCommands: [],
    surfaces: {},
    events: new Map(),
    notices: [],
    followups: [],
    agent: undefined,
    provide(name, service) {
      ctx.provided[name] = service
    },
    get(name) {
      return name === 'agent' ? ctx.agent : name === 'waiting' ? waiting : undefined
    },
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on(event, handler) {
      const list = ctx.events.get(event) ?? []
      list.push(handler)
      ctx.events.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      if (event === 'dsc/notice') ctx.notices.push(args[0])
    },
    session: { current: () => ctx.current },
    tools: {
      register(entry) {
        ctx.registeredTools.push(entry)
        return () => {}
      },
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
    compact: { registerCarry: () => () => {} },
    prompt: { registerProjection: () => () => {} },
    settings: { registerSection: () => () => {} },
    transcript: {
      system(text) {
        ctx.notices.push(text)
      },
    },
    waiting,
  }
  return ctx
}

/** 一份真的 waiting 登记表（goal 的挂卡闸要真服务，不能是假布尔）。 */
const makeWaiting = async () => {
  const { waitingPlugin } = await import(pathToFileURL(join(root, 'src/packages/waiting/index.ts')).href)
  const provided = {}
  waitingPlugin.apply({
    provide(name, service) {
      provided[name] = service
    },
  })
  return provided.waiting
}

const runCtxOf = (session, signal = new AbortController().signal) => ({
  sessionId: session.meta.id,
  sessionPath: session.filePath,
  cwd: session.meta.cwd,
  signal,
})

const { todoPlugin } = await import(pathToFileURL(join(root, 'src/packages/todo/index.ts')).href)
const { goalPlugin } = await import(pathToFileURL(join(root, 'src/packages/goal/index.ts')).href)

// ── todo ────────────────────────────────────────────────────────────────────
console.log('[1] todo_write：写进发起调用的会话')
const sessionA = makeSession('sess-a', '/sessions/a.jsonl')
const sessionB = makeSession('sess-b', '/sessions/b.jsonl')
const todoCtx = makeCtx(sessionA, await makeWaiting())
todoCtx.agent = {
  sessionById: (id) => [sessionA, sessionB].find((session) => session.meta.id === id),
  sessionFor: (path) => [sessionA, sessionB].find((session) => session.filePath === path),
}
todoPlugin.apply(todoCtx)
const todoTool = todoCtx.registeredTools.find((entry) => entry.name === 'todo_write')
check('todo_write 工具已注册', todoTool !== undefined)

await todoTool.run({ todos: [{ id: 'a1', content: 'A 的活', status: 'pending' }] }, runCtxOf(sessionA))
check('A 的清单落进 A 的会话记录', sessionA.writes.some((write) => write.name === 'todos'), JSON.stringify(sessionA.writes))
check('A 的写入没有溅到 B', sessionB.writes.length === 0, JSON.stringify(sessionB.writes))

await todoTool.run({ todos: [{ id: 'b1', content: 'B 的活', status: 'in_progress' }] }, runCtxOf(sessionB))
check('B 的清单落进 B 的会话记录', sessionB.writes.some((write) => write.name === 'todos'), JSON.stringify(sessionB.writes))
check(
  'B 的写入没有溅到 A（P0-7 核心断言）',
  sessionA.writes.filter((write) => write.name === 'todos').length === 1,
  JSON.stringify(sessionA.writes),
)

console.log('[2] todo 存储按会话分表：两条会话的清单互不可见')
check(
  '当前查看 A 时，界面只看到 A 的清单',
  todoCtx.surfaces.todos().items.map((item) => item.id).join(',') === 'a1',
  JSON.stringify(todoCtx.surfaces.todos().items),
)
todoCtx.current = sessionB
check(
  '切到 B 后只看到 B 的清单',
  todoCtx.surfaces.todos().items.map((item) => item.id).join(',') === 'b1',
  JSON.stringify(todoCtx.surfaces.todos().items),
)
check('提示词投影跟着会话走', todoCtx.provided.todo.todoPrompt().includes('B 的活'))
todoCtx.current = sessionA
check('切回 A 的提示词投影是 A 的清单', todoCtx.provided.todo.todoPrompt().includes('A 的活'))

console.log('[3] 老调用方（不带会话身份）仍按当前查看的会话')
{
  const legacy = makeSession('sess-c', '/sessions/c.jsonl')
  const ctx = makeCtx(sessionA, await makeWaiting())
  ctx.agent = todoCtx.agent
  todoPlugin.apply(ctx)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'todo_write')
  // PTC / 老式调用只给 cwd + signal：会话身份缺省，按当前查看的会话算。
  await tool.run({ todos: [{ id: 'c1', content: '当前会话的活', status: 'pending' }] }, { cwd: '/work', signal: new AbortController().signal })
  check('缺省会话身份时写进当前查看的会话', sessionA.writes.some((write) => write.value?.some?.((item) => item.id === 'c1')), JSON.stringify(sessionA.writes))
  check('没有凭空造出别的会话的写入', legacy.writes.length === 0)
}

// ── goal ────────────────────────────────────────────────────────────────────
console.log('[4] goal 工具：写进发起调用的会话')
const goalA = makeSession('sess-a', '/sessions/a.jsonl')
const goalB = makeSession('sess-b', '/sessions/b.jsonl')
const waiting = await makeWaiting()
const goalCtx = makeCtx(goalA, waiting)
goalCtx.agent = {
  sessionById: (id) => [goalA, goalB].find((session) => session.meta.id === id),
  sessionFor: (path) => [goalA, goalB].find((session) => session.filePath === path),
  followup: (text, images, sessionId, origin) => goalCtx.followups.push({ text, sessionId, origin }),
}
goalPlugin.apply(goalCtx)
const goalTool = goalCtx.registeredTools.find((entry) => entry.name === 'goal')
check('goal 工具已注册', goalTool !== undefined)

/** 调一次 goal 工具；抛错当 FAIL（修复前「两条会话共用一个目标」会当场拒建）。 */
const runGoal = async (name, args, session) => {
  try {
    await goalTool.run(args, runCtxOf(session))
    return true
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}  <- 抛错：${error.message}`)
    return false
  }
}

await runGoal('A 建目标', { action: 'create', objective: '把 A 的目标做完' }, goalA)
check('A 的目标落进 A 的会话记录', goalA.writes.some((write) => write.name === 'goal'), JSON.stringify(goalA.writes))

await runGoal('B 建目标', { action: 'create', objective: '后台会话自己的目标' }, goalB)
check('B 的目标落进 B 的会话记录', goalB.writes.some((write) => write.name === 'goal'), JSON.stringify(goalB.writes))
check(
  'B 的目标没有写进 A 的会话记录（P0-7 核心断言）',
  goalA.writes.filter((write) => write.name === 'goal').length === 1,
  JSON.stringify(goalA.writes),
)
check('当前查看 A 时，目标投影仍是 A 的', goalCtx.provided.goal.goalView()?.objective === '把 A 的目标做完', JSON.stringify(goalCtx.provided.goal.goalView()))
goalCtx.current = goalB
check('切到 B 后，目标投影是 B 的', goalCtx.provided.goal.goalView()?.objective === '后台会话自己的目标', JSON.stringify(goalCtx.provided.goal.goalView()))
goalCtx.current = goalA

console.log('[5] 目标续跑只被自己那条会话的挂卡挡住（P0-6 消费侧）')
{
  // 后台会话 B 挂一张审批卡：A 的续跑不许受影响。
  waiting.register('approval', (owner) => owner === undefined || owner === 'sess-b')
  guard('别的会话挂着卡时，A 的续跑照走', () => {
    const reminder = goalCtx.provided.goal.takeGoalRound()
    check('takeGoalRound 给出续跑指令', typeof reminder === 'string' && reminder.includes('把 A 的目标做完'), String(reminder))
    check('轮次记到了 A 身上', goalCtx.provided.goal.goalView()?.rounds === 1, JSON.stringify(goalCtx.provided.goal.goalView()))
  })

  // 自己那条会话挂卡：必须停下来等用户。
  waiting.register('plan', (owner) => owner === undefined || owner === 'sess-a')
  guard('自己挂着卡时，A 的续跑停下', () => {
    check('takeGoalRound 返回 null', goalCtx.provided.goal.takeGoalRound() === null)
  })
}

console.log('[6] 队友会话（不在 agent 名册里）：按 ToolContext.sessionPath 认领')
{
  // 队友会话由 subagent 直接 `Session.create/load` 出来，**不进 agent 名册**
  // （`src/packages/agent/index.ts:327-335` 的 `agents` 表只在 attach 时登记）。
  // 这里造一份真的 jsonl（只有 meta 首行），它的路径就是 ToolContext.sessionPath。
  const teammateDir = join(process.env.DSC_HOME, 'sessions', '.teammates')
  mkdirSync(teammateDir, { recursive: true })
  const seed = (name, id) => {
    const file = join(teammateDir, `${name}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'meta', id, cwd: '/work', createdAt: Date.now() })}\n`)
    return file
  }
  /** 等落盘流刷出去：Session.appendState 走的是 createWriteStream，不是同步写。 */
  const recordsOf = async (file) => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
  }
  const rosterOf = (viewed) => ({
    sessionById: (id) => (id === viewed.meta.id ? viewed : undefined),
    sessionFor: (path) => (path === viewed.filePath ? viewed : undefined),
  })

  // ── todo：队友的清单落进队友自己那份 ──
  const viewedTodo = makeSession('sess-viewed-todo', '/sessions/viewed-todo.jsonl')
  const todoMateCtx = makeCtx(viewedTodo, await makeWaiting())
  todoMateCtx.agent = rosterOf(viewedTodo)
  todoPlugin.apply(todoMateCtx)
  const mateTodoTool = todoMateCtx.registeredTools.find((entry) => entry.name === 'todo_write')
  const mateTodoPath = seed('mate-todo', 'sess-mate-todo')
  await mateTodoTool.run({ todos: [{ id: 't1', content: '队友的活', status: 'in_progress' }] }, {
    cwd: '/work',
    signal: new AbortController().signal,
    sessionId: 'sess-mate-todo',
    sessionPath: mateTodoPath,
  })
  const mateTodoLog = await recordsOf(mateTodoPath)
  check(
    '队友的清单写进队友自己的 jsonl',
    mateTodoLog.some(
      (record) =>
        record.type === 'state' && record.id === 'todos' && (record.payload ?? []).some((item) => item.id === 't1'),
    ),
    JSON.stringify(mateTodoLog),
  )
  check('用户正看着的会话一条 todo 都没收到（P0-7 队友用例）', viewedTodo.writes.length === 0, JSON.stringify(viewedTodo.writes))

  // ── goal：同一个判定顺序，队友的目标也落进自己那份 ──
  const viewedGoal = makeSession('sess-viewed-goal', '/sessions/viewed-goal.jsonl')
  const goalMateCtx = makeCtx(viewedGoal, await makeWaiting())
  goalMateCtx.agent = rosterOf(viewedGoal)
  goalPlugin.apply(goalMateCtx)
  const mateGoalTool = goalMateCtx.registeredTools.find((entry) => entry.name === 'goal')
  const mateGoalPath = seed('mate-goal', 'sess-mate-goal')
  await mateGoalTool.run({ action: 'create', objective: '队友自己的目标' }, {
    cwd: '/work',
    signal: new AbortController().signal,
    sessionId: 'sess-mate-goal',
    sessionPath: mateGoalPath,
  })
  const mateGoalLog = await recordsOf(mateGoalPath)
  check(
    '队友的目标写进队友自己的 jsonl',
    mateGoalLog.some((record) => record.type === 'state' && record.id === 'goal' && record.payload?.objective === '队友自己的目标'),
    JSON.stringify(mateGoalLog),
  )
  check('用户正看着的会话一条 goal 都没收到（P0-7 队友用例）', viewedGoal.writes.length === 0, JSON.stringify(viewedGoal.writes))
  check(
    '用户自己的目标投影没被队友顶掉',
    goalMateCtx.provided.goal.goalView() === null,
    JSON.stringify(goalMateCtx.provided.goal.goalView()),
  )

  // ── 已知取舍：sessionPath 指向的文件不存在时，退回「当前查看的会话」 ──
  await mateTodoTool.run({ todos: [{ id: 'm1', content: '路径不存在时的退路', status: 'pending' }] }, {
    cwd: '/work',
    signal: new AbortController().signal,
    sessionId: 'sess-missing',
    sessionPath: join(teammateDir, 'missing.jsonl'),
  })
  check(
    'sessionPath 文件不存在时回落当前查看的会话（已知取舍）',
    viewedTodo.writes.some((write) => (write.value ?? []).some((item) => item.id === 'm1')),
    JSON.stringify(viewedTodo.writes),
  )
}

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
