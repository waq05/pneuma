/**
 * P2 探针：定时任务的「挂卡闸」要按**任务自己那条会话**判，不是整批一个布尔。
 *
 * 病根（`docs/code-review/2026-11-09/P0-6-7-9-复审.md` 真问题 4）：`ScheduleRunnerDeps.waiting`
 * 原来是 `() => boolean`，一次判定管一整批（含手动 `fireNow`）；插件侧只能取「所有启用任务的
 * 目标会话 + 当前会话」这个安全超集。结果是：任务 A 投会话 X、任务 B 投会话 Y，Y 挂着审批卡，
 * A 的投递也推迟一轮。
 *
 * 这个电池真装 `waiting` 插件、真起 `ScheduleRunner`（不是读源码猜），验四件事：
 *   1. 到点投递：A 有卡、B 没有 → B 照常投，A 被挡；
 *   2. 手动跑：`fireNow(B)` 不被 A 的卡挡住，`fireNow(A)` 被挡；
 *   3. 旧任务（没存 sessionId）回退到「当前会话」判卡；
 *   4. 崩后补投（recoverPending）同样逐条判。
 *
 * 判据为什么这么写：探针里的闸是 `(sessionId) => sessionId === '' ? false : waiting.anyFor(sessionId)`
 * ——这正是插件装配要换成的那一句。修复前调度器一次都不传会话（`undefined`），`anyFor(undefined)`
 * 就是全进程口径，等于整批推迟；修复后逐条传 `task.sessionId`，A / B 才分得开。
 *
 * 纯 Node 跑（不需要 build）：源码按 NodeNext 写 `.js` 说明符，这里用官方 resolve hook 补
 * 「`.js` → `.ts`」与 `@pneuma/runtime/*` 两条映射，剩下的交给 Node 的类型擦除。
 *
 * 运行：node scripts/schedule-session-gate-check.mjs
 *
 * @module dsc/scripts/schedule-session-gate-check
 */
import { mkdtempSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// 自检不碰真实 ~/.dsc：调度器会往 data 目录写 tasks.json / .lock。
process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-schedule-gate-home-'))

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

/** 跑一段可能抛错的断言：抛错算 FAIL，不让整份探针中断。 */
const guard = async (name, fn) => {
  try {
    await fn()
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}  <- 抛错：${error.message}`)
  }
}

/** 固定时刻：排期与投递都按它算，结果不受机器时钟影响。 */
const NOW = 1_800_000_000_000

/** 一小时一次的周期任务：宽限按半周期算（1800 秒），迟到 1 秒必在宽限内。 */
const RULE = { kind: 'every', seconds: 3_600, anchorMs: NOW - 7_200_000 }

const { waitingPlugin } = await import(pathToFileURL(join(root, 'src/packages/waiting/index.ts')).href)
const { ScheduleRunner } = await import(pathToFileURL(join(root, 'src/core/schedule/runner.ts')).href)
const { ScheduleStore } = await import(pathToFileURL(join(root, 'src/core/schedule/store.ts')).href)

/** 起一份真的 `waiting` 登记表：卡挂在会话 A，只算 A 自己那条会话。 */
const makeWaiting = () => {
  const provided = {}
  waitingPlugin.apply({
    provide(name, service) {
      provided[name] = service
    },
  })
  const waiting = provided.waiting
  waiting.register('approval', (owner) => owner === undefined || owner === 'sess-a')
  return waiting
}

/**
 * 一份调度器现场：独立的临时数据目录 + 记录投递与卡闸入参。
 * @param {object} [options]
 * @param {string} [options.currentSession] 「当前查看的会话」，旧任务回退时用它
 */
const makeHarness = async ({ currentSession = 'sess-current' } = {}) => {
  const waiting = makeWaiting()
  const store = new ScheduleStore({ dir: mkdtempSync(join(tmpdir(), 'dsc-schedule-gate-data-')), now: () => NOW })
  /** 真投出去的那些（标题 + 目标会话）。 */
  const delivered = []
  /** 卡闸收到的会话 id（修复前是 `undefined`：一次判定管一整批）。 */
  const gateCalls = []
  const runner = new ScheduleRunner({
    store,
    config: () => ({ enabled: true, timeZone: 'UTC', maxRunSeconds: 600 }),
    route: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', model: 'test-model' }),
    deliver: (text, task, slot) => {
      delivered.push({ title: task.title, session: task.sessionId, slot, text })
    },
    // 与插件装配要换成的那一句同形：空串 = 定不下目标会话，不拿全进程口径去挡。
    waiting: (sessionId) => {
      gateCalls.push(sessionId)
      return sessionId === '' ? false : waiting.anyFor(sessionId)
    },
    sessionId: () => currentSession,
    now: () => NOW,
  })
  /** 建一条到点的任务（`sessionId` 留空 = 旧任务）。 */
  const addTask = async (title, sessionId, nextRunAt = NOW - 1_000) => {
    const task = await store.create({ title, prompt: `做 ${title}`, rule: RULE, timeZone: 'UTC', sessionId })
    await store.setNextRunAt(task.id, nextRunAt)
    return store.get(task.id)
  }
  return { store, runner, delivered, gateCalls, addTask }
}

console.log('[1] 到点投递：A 有卡、B 没有 → B 照常投，A 被挡')
await guard('到点投递', async () => {
  const harness = await makeHarness()
  const taskA = await harness.addTask('A 的活', 'sess-a')
  const taskB = await harness.addTask('B 的活', 'sess-b')

  await harness.runner.tick()

  check(
    'B 照常投出去（P2 核心断言）',
    harness.delivered.some((entry) => entry.title === 'B 的活' && entry.session === 'sess-b'),
    JSON.stringify(harness.delivered.map((entry) => entry.title)),
  )
  check(
    'A 被自己那条会话的卡挡住，没有投',
    !harness.delivered.some((entry) => entry.title === 'A 的活'),
    JSON.stringify(harness.delivered.map((entry) => entry.title)),
  )
  check(
    'A 的排期一动没动（下一轮还会再试）',
    harness.store.get(taskA.id)?.nextRunAt === NOW - 1_000 && harness.store.get(taskA.id)?.pendingSlot === null,
    JSON.stringify(harness.store.get(taskA.id)),
  )
  check('B 记成投递成功', harness.store.get(taskB.id)?.lastStatus === 'ok', String(harness.store.get(taskB.id)?.lastStatus))
  check(
    '卡闸是逐条问的：入参能看见两条会话',
    harness.gateCalls.includes('sess-a') && harness.gateCalls.includes('sess-b'),
    JSON.stringify(harness.gateCalls),
  )
})

console.log('[2] 手动 fireNow：只被自己那条会话的卡挡')
await guard('fireNow(B)', async () => {
  const harness = await makeHarness()
  const taskB = await harness.addTask('B 的活', 'sess-b')
  const message = await harness.runner.fireNow(taskB.id)
  check(
    'fireNow(B) 不被 A 的卡挡住',
    harness.delivered.some((entry) => entry.title === 'B 的活') && message.startsWith('已把'),
    message,
  )
})
await guard('fireNow(A)', async () => {
  const harness = await makeHarness()
  const taskA = await harness.addTask('A 的活', 'sess-a')
  const message = await harness.runner.fireNow(taskA.id)
  check('fireNow(A) 被自己那条会话的卡挡住', harness.delivered.length === 0 && message.includes('卡片'), message)
  check(
    '被挡时不推进槽位、不记投递',
    harness.store.get(taskA.id)?.lastStatus === 'never' && harness.store.get(taskA.id)?.deliveryHistory.length === 0,
    JSON.stringify(harness.store.get(taskA.id)),
  )
})

console.log('[3] 旧任务（没存 sessionId）回退到「当前会话」判卡')
await guard('旧任务回退当前会话', async () => {
  const harnessB = await makeHarness({ currentSession: 'sess-b' })
  await harnessB.addTask('旧任务投 B', '')
  await harnessB.runner.tick()
  check(
    '当前会话是 B（没卡）时照常投',
    harnessB.delivered.some((entry) => entry.title === '旧任务投 B'),
    JSON.stringify(harnessB.delivered.map((entry) => entry.title)),
  )
  check('回退时问的是当前会话', harnessB.gateCalls.includes('sess-b'), JSON.stringify(harnessB.gateCalls))

  const harnessA = await makeHarness({ currentSession: 'sess-a' })
  await harnessA.addTask('旧任务投 A', '')
  await harnessA.runner.tick()
  check(
    '当前会话是 A（有卡）时被挡',
    harnessA.delivered.length === 0 && harnessA.gateCalls.includes('sess-a'),
    JSON.stringify({ delivered: harnessA.delivered.length, gates: harnessA.gateCalls }),
  )
})

console.log('[4] 崩后补投（recoverPending）也逐条判')
await guard('补投', async () => {
  const harness = await makeHarness()
  const taskA = await harness.addTask('A 的补投', 'sess-a', NOW + 3_600_000)
  const taskB = await harness.addTask('B 的补投', 'sess-b', NOW + 3_600_000)
  await harness.store.beginSlot(taskA.id, NOW - 5_000, NOW + 3_600_000)
  await harness.store.beginSlot(taskB.id, NOW - 5_000, NOW + 3_600_000)

  await harness.runner.tick()

  check(
    'B 的悬空槽位补投出去',
    harness.delivered.some((entry) => entry.title === 'B 的补投'),
    JSON.stringify(harness.delivered.map((entry) => entry.title)),
  )
  check('A 的悬空槽位留着，等卡处理完再补', harness.store.get(taskA.id)?.pendingSlot === NOW - 5_000)
})

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
