/**
 * schedule 插件层补测（W14）：补 `/schedule` 命令与调度器装配的回调边角。
 *
 * 覆盖目标（对照 W14 缺口清单）：
 * - `splitRuleAndTitle` 的空输入（`/schedule add` 后面什么都没写）；
 * - 命令 `add` 的成功回报与 `create` 失败分支；
 * - `delete` / `pause` / `run` 三条 `.catch` 错误回报；
 * - 调度器依赖里的 `sessionId` / `canWriteDir` / `lastErrorText` / `notice` 四个回调真被调到
 *   （老任务 `sessionId` 为空时走「回落当前会话」，沙箱拒绝写数据目录时走 blocked 分支）；
 * - 回合结束对账钩子 `dsc/turn-end` 真的把错误接回 `noteTurnEnd`；
 * - 设置分区 `fields()` 在有任务时渲染任务清单的那一支。
 *
 * 隔离与 `prompt-stability.spec.ts` 同一套：`HOME` / `USERPROFILE` / `DSC_HOME` 指向
 * `mkdtempSync` 的临时目录，动态 import 时 store 的默认目录才落在临时树里；真实 `~/.dsc`
 * 一个字节都不碰。运行期模块全部动态 import——`path-policy` 的 `DSC_HOME` 是模块求值时
 * 算定的常量，静态 import 会把隔离废掉。
 *
 * @module @pneuma/schedule/tests/w14-command-runner
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'

/** 临时主目录；三个环境变量都要在动态 import 之前换好。 */
const HOME = mkdtempSync(join(tmpdir(), 'dsc-schedule-w14-'))
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.DSC_HOME = join(HOME, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

type SchedulePlugin = (typeof import('../index.js'))['schedulePlugin']
type StoreModule = typeof import('../../../core/schedule/store.js')

const { schedulePlugin } = (await import('../index.js')) as {
  schedulePlugin: SchedulePlugin
}
const storeModule = (await import('../../../core/schedule/store.js')) as StoreModule

afterAll(() => {
  for (const name of ['HOME', 'USERPROFILE', 'DSC_HOME'] as const) {
    const before = savedEnv[name]
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  vi.restoreAllMocks()
  rmSync(join(process.env.DSC_HOME!, 'schedule'), {
    recursive: true,
    force: true,
  })
  writeFileSync(join(process.env.DSC_HOME!, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

// ── 假 ctx：apply 真正用到的面 ───────────────────────────────────────────────

/** 命令处理器收到的参数（本插件只读 `args` 与 `ui.notice`）。 */
interface CommandCall {
  args: string[]
  ui: { notice: (text: string) => void }
}

/** 会话状态里的一条记录（`transcript.getSnapshot().entries` 的元素形状）。 */
interface TranscriptEntry {
  kind: string
  text: string
}

interface Wired {
  /** `/schedule` 命令处理器。 */
  command: (call: CommandCall) => void
  tools: Array<Record<string, unknown>>
  section: SettingsSectionSpec | undefined
  notices: string[]
  /** `agent.followup` 的调用记录：投递目标会话在第三参。 */
  followups: Array<{
    text: string
    target: string | undefined
    origin: string | undefined
  }>
  transcriptEntries: TranscriptEntry[]
  /** `transcript.system` 收到的提示：调度器的 `notice` 回调走这里。 */
  systems: string[]
  /** `dsc/turn-end` 的处理器：plugin 用 ctx.on 订。 */
  turnEndHandlers: Array<(reason: string, signal: { sessionId?: string }) => void>
  /** 沙箱探测桩：`ctx.get('sandbox')` 的返回值。 */
  sandbox: { canWrite: () => { allowed: boolean; reason?: string } } | null
  /** `ctx.waiting.anyFor` 的桩：返回 true 表示目标会话挂着卡。 */
  waitingAnyFor: (sessionId: string) => boolean
  dispose: () => void
}

/**
 * 装一次插件。桩 ctx 补齐 apply 用到的全部面；`effect` 按 cordis 语义立即执行并保留注销函数。
 * @param config - 装配时递给插件的第二参数。
 */
function mount(config: Record<string, unknown> = { enabled: true, timeZone: 'UTC' }): Wired {
  const wired: Wired = {
    command: () => {
      throw new Error('插件没有注册 /schedule 命令')
    },
    tools: [],
    section: undefined,
    notices: [],
    followups: [],
    transcriptEntries: [],
    systems: [],
    turnEndHandlers: [],
    sandbox: null,
    waitingAnyFor: () => false,
    dispose: () => undefined,
  }
  const ctx = {
    effect(fn: () => unknown) {
      const off = fn()
      return typeof off === 'function' ? off : () => undefined
    },
    tools: {
      register(spec: Record<string, unknown>) {
        wired.tools.push(spec)
        return () => undefined
      },
    },
    commands: {
      register(_meta: Record<string, unknown>, handler: (call: CommandCall) => void) {
        wired.command = handler
        return () => undefined
      },
    },
    prompt: {
      register: () => () => undefined,
      registerProjection: () => () => undefined,
    },
    surfaces: { register: () => () => undefined },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        wired.section = spec
        return () => undefined
      },
    },
    transcript: {
      getSnapshot: () => ({ entries: wired.transcriptEntries }),
      system: (text: string) => {
        wired.systems.push(text)
      },
    },
    agent: {
      followup: (text: string, _unknown: unknown, target: string | undefined, origin: string | undefined) => {
        wired.followups.push({ text, target, origin })
      },
    },
    waiting: { anyFor: (sessionId: string) => wired.waitingAnyFor(sessionId) },
    session: {
      current: () => ({
        meta: { id: 'w14-schedule-session', cwd: HOME },
        messages: [] as ChatMessage[],
      }),
    },
    llm: {
      route: () => ({
        baseUrl: 'https://api.test',
        apiKey: 'fake-key',
        model: 'test-model',
      }),
    },
    get: (name: string) => (name === 'sandbox' ? wired.sandbox : undefined),
    on: (_event: string, handler: (reason: string, signal: { sessionId?: string }) => void) => {
      wired.turnEndHandlers.push(handler)
      return () => undefined
    },
  }
  wired.dispose = schedulePlugin.apply(ctx as never, config) as unknown as () => void
  return wired
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mounted(config?: Record<string, unknown>): Wired {
  const wired = mount(config)
  cleanup = wired.dispose
  return wired
}

/** 用插件真实的工具面建任务，让 store 走同一条落盘路径。 */
async function createTask(wired: Wired, title = '早报', rule = 'daily:09:30'): Promise<void> {
  const tool = wired.tools[0]!
  await (tool['run'] as (args: unknown) => Promise<unknown>)({
    action: 'create',
    title,
    prompt: `写${title}`,
    rule,
  })
}

/** 当前落盘的第一条任务 id。 */
function firstTaskId(): string {
  return new storeModule.ScheduleStore().load().tasks[0]!.id
}

/** 直接改 tasks.json：模拟「老任务没存 sessionId」的现场（命令处理前 store.reload() 会读到）。 */
function clearTaskSessionId(id: string): void {
  const file = join(process.env.DSC_HOME!, 'schedule', 'tasks.json')
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    tasks: Array<Record<string, unknown>>
  }
  const task = doc.tasks.find((item) => item['id'] === id)
  if (task === undefined) throw new Error(`tasks.json 里找不到任务 ${id}`)
  task['sessionId'] = ''
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/** 跑一次 `/schedule <args>`：处理器是同步入口，异步分支用 waitFor 等。 */
function runCommand(wired: Wired, ...args: string[]): void {
  wired.command({ args, ui: { notice: (text) => wired.notices.push(text) } })
}

/** 设置分区里可复制的那块任务清单（`copyable: true` 的 info 字段）。 */
function taskListText(wired: Wired): string {
  if (wired.section === undefined) throw new Error('插件没有注册设置分区')
  const field = wired.section
    .fields()
    .find((item): item is Extract<SettingsField, { type: 'info' }> => item.type === 'info' && item.copyable === true)
  if (field === undefined) throw new Error('设置分区缺任务清单 info 字段')
  return field.text
}

// ── 1. `/schedule add` 参数的两种失败 ───────────────────────────────────────

test('/schedule add 后面什么都没写：提示要写选择器，不建任务', () => {
  const wired = mounted()
  runCommand(wired, 'add')
  expect(wired.notices).toHaveLength(1)
  expect(wired.notices[0]).toContain('要写「选择器 标题」')
  expect(new storeModule.ScheduleStore().load().tasks).toHaveLength(0)
})

test('/schedule add 规则认不出：把 parseRule 的原文回报出来', () => {
  const wired = mounted()
  runCommand(wired, 'add', 'w14-bogus-rule', '喝水')
  expect(wired.notices).toHaveLength(1)
  expect(wired.notices[0]).not.toBe('')
  expect(new storeModule.ScheduleStore().load().tasks).toHaveLength(0)
})

// ── 2. 命令写路径的成功与失败 ───────────────────────────────────────────────

test('/schedule add 成功：回报下次时间与时区，设置分区清单里能看到它', async () => {
  const wired = mounted()
  runCommand(wired, 'add', 'daily:09:30', '早报')
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  expect(wired.notices[0]).toContain('已建好定时任务')
  expect(wired.notices[0]).toContain('时区：UTC')
  expect(wired.notices[0]).toContain('早报')
  // 有任务时设置分区的清单分支：正文里带标题（不是「没有任务」那句）。
  expect(taskListText(wired)).toContain('早报')
})

test('/schedule add 落盘失败：回报「建任务失败」并带原始错误', async () => {
  const wired = mounted()
  vi.spyOn(storeModule.ScheduleStore.prototype, 'create').mockRejectedValueOnce(new Error('磁盘满了'))
  runCommand(wired, 'add', 'every:30m', '喝水')
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  expect(wired.notices[0]).toBe('建任务失败：磁盘满了')
})

test('/schedule remove 落盘失败与 pause 落盘失败：各回一句带原因的文案', async () => {
  const wired = mounted()
  await createTask(wired)

  vi.spyOn(storeModule.ScheduleStore.prototype, 'remove').mockRejectedValueOnce(new Error('目录只读'))
  runCommand(wired, 'remove', firstTaskId())
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  expect(wired.notices[0]).toBe('删除失败：目录只读')

  vi.spyOn(storeModule.ScheduleStore.prototype, 'update').mockRejectedValueOnce(new Error('锁冲突'))
  runCommand(wired, 'pause', firstTaskId())
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(2)
  })
  expect(wired.notices[1]).toBe('改不动：锁冲突')
})

test('/schedule run：调度器抛错时回报「跑不了」', async () => {
  const wired = mounted()
  await createTask(wired)
  // fireNow 内部先问目标会话的卡闸；这里让它抛，走命令处理器的 catch。
  wired.waitingAnyFor = () => {
    throw new Error('等待表坏了')
  }
  runCommand(wired, 'run', firstTaskId())
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  expect(wired.notices[0]).toBe('跑不了：等待表坏了')
})

// ── 3. 调度器依赖回调：老任务回落当前会话 + 沙箱探测 + 投递 + 回合对账 ──────

test('/schedule run 老任务（sessionId 为空）：回落当前会话；沙箱拒绝写数据目录时 blocked 并提示', async () => {
  const wired = mounted()
  await createTask(wired)
  const id = firstTaskId()
  clearTaskSessionId(id)
  wired.sandbox = { canWrite: () => ({ allowed: false, reason: '路径越界' }) }

  runCommand(wired, 'run', id)
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  expect(wired.notices[0]).toContain('投不出去')
  expect(wired.notices[0]).toContain('路径越界')
  // 被 blocked 的投递不该真的发给模型。
  expect(wired.followups).toHaveLength(0)
})

test('/schedule run 成功投递后，回合以错误结束：把最近一条「错误：」接回重试记账', async () => {
  const wired = mounted()
  await createTask(wired)
  const id = firstTaskId()
  clearTaskSessionId(id)
  wired.sandbox = { canWrite: () => ({ allowed: true }) }
  wired.transcriptEntries.push({ kind: 'system', text: '错误：端点返回 500' })

  runCommand(wired, 'run', id)
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  expect(wired.notices[0]).toContain('已把「早报」立即投给模型')
  // 老任务没存 sessionId：插件按契约不带目标（第三参 undefined），由内核回落到当前会话。
  expect(wired.followups).toHaveLength(1)
  expect(wired.followups[0]?.target).toBeUndefined()
  expect(wired.followups[0]?.origin).toBe('notice')

  // 回合结束钩子：reason=error + 会话归属时，调度器从会话流里捡最近一条「错误：…」。
  expect(wired.turnEndHandlers).toHaveLength(1)
  wired.turnEndHandlers[0]!('error', { sessionId: 'w14-schedule-session' })
  await vi.waitFor(() => {
    expect(wired.systems).toHaveLength(1)
  })
  expect(wired.systems.join('\n')).toContain('这一轮没跑成')
  expect(wired.systems.join('\n')).toContain('端点返回 500')
})

test('回合以错误结束但会话流里没有「错误：」记录：退回一句通用失败原因', async () => {
  const wired = mounted()
  await createTask(wired)
  const id = firstTaskId()
  wired.sandbox = { canWrite: () => ({ allowed: true }) }
  // 会话流里没有 system 级「错误：…」：lastErrorText 走 return '' 的兜底。
  runCommand(wired, 'run', id)
  await vi.waitFor(() => {
    expect(wired.notices).toHaveLength(1)
  })
  wired.turnEndHandlers[0]!('error', { sessionId: 'w14-schedule-session' })
  await vi.waitFor(() => {
    expect(wired.systems).toHaveLength(1)
  })
  expect(wired.systems[0]).toContain('这一轮以错误结束（模型端点报错）')
})

test('设置分区 values 与 save：时区写歪返回文案，合法值与数值区间照用', () => {
  const wired = mounted()
  if (wired.section === undefined) throw new Error('插件没有注册设置分区')
  const section = wired.section as unknown as {
    values: () => SettingsValues
    save: (key: string, value: unknown) => string | void
  }
  expect(section.values().timeZone).toBe('UTC')
  // 时区写歪：返回文案，不改当前值。
  const badZone = section.save('timeZone', 'Mars/Olympus')
  expect(typeof badZone).toBe('string')
  expect(section.values().timeZone).toBe('UTC')
  // 合法时区与两个数值区间都写进临时 plugins.json，不碰真实主目录。
  expect(section.save('timeZone', 'Asia/Shanghai')).toBeUndefined()
  expect(section.values().timeZone).toBe('Asia/Shanghai')
  expect(section.save('maxRunSeconds', 120)).toBeUndefined()
  expect(section.values().maxRunSeconds).toBe(120)
  expect(section.save('historyLimit', 40)).toBeUndefined()
  expect(section.values().historyLimit).toBe(40)
})
