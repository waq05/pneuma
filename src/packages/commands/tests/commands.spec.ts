/**
 * commands 包级测试：插件对象 + 两个纯函数（/status、/usage 的文本组装）+ 内置命令清单与派发。
 *
 * 原来「二十四个内置命令都用 builtinSpec(名字) 注册，顺序固定」读的是 `index.ts` 源码，
 * 正则抓 `builtinSpec('x')` 的出现顺序。现在分两层：
 *   1. `BUILT_IN_COMMANDS` 是那张唯一的内置命令表（插件注册时按名字从它取 spec），
 *      直接断言导出的表：菜单顺序固定、每条都有 args/description；
 *   2. 真的跑一遍 `apply()`，把本插件负责的 24 个名字逐个喂给服务的 `run()`，每个都必须
 *      被派发，不能回「未知命令」——少注册一条会在这里红。
 *
 * 表里比 24 条多一条 `compact`：它由 compact 包自己 `ctx.commands.register` 注册，
 * 表只是提供 spec，所以这里显式排除，不把它算进本包的注册面。
 *
 * @module @pneuma/commands/tests
 */
import { BUILT_IN_COMMANDS } from '@pneuma/commands-core/commands-completion.js'
import type { CommandService } from '@pneuma/runtime/services/types.js'
import { expect, test, vi } from 'vitest'
import { commandsPlugin, runCommand, statusReport, usageReport } from '../index.js'

/** 本包在 apply 里逐个注册的 24 条（按源码注册顺序）。 */
const COMMAND_NAMES = [
  'help',
  'new',
  'resume',
  'agents',
  'settings',
  'model',
  'status',
  'usage',
  'export',
  'review',
  'review-status',
  'review-cancel',
  'diff',
  'copy',
  'policy',
  'reviewer',
  'permission',
  'effort',
  'fork',
  'thinking',
  'plugins',
  'update',
  'ui-trust',
  'exit',
]

/** 内置表固定的菜单顺序（25 条，含别的包注册的 compact）。 */
const MENU_ORDER = [
  'new',
  'resume',
  'agents',
  'compact',
  'model',
  'policy',
  'reviewer',
  'permission',
  'effort',
  'thinking',
  'fork',
  'plugins',
  'ui-trust',
  'update',
  'status',
  'usage',
  'diff',
  'copy',
  'export',
  'review',
  'review-status',
  'review-cancel',
  'settings',
  'help',
  'exit',
]

let service: CommandService | undefined
const notices: string[] = []

/** 最小界面桩：notice 收文本，其余入口记一笔就行。 */
const ui = {
  shell: false,
  notice: (text: string) => {
    notices.push(text)
  },
  openPicker: () => {},
  openAgents: () => {},
  openSettings: () => {},
  openModels: () => {},
}

/** 最小 runtime 桩：只给内置 handler 会读的那几项。 */
const runtime = {
  getSnapshot: () => ({
    status: { turnState: 'idle', effort: 'default', sessionPath: '' },
    entries: [],
    surfaces: {
      policy: {
        current: 'readonly',
        options: [{ id: 'readonly', label: '只读', hint: '' }],
        reviewer: 'user',
        reviewerOptions: [{ id: 'user', label: '本人', hint: '' }],
      },
      permissionPresets: { current: 'custom', options: [] },
    },
  }),
  openSession: () => {},
  setModel: async () => {},
  usageStats: async () => ({ totalTurns: 0 }),
  submit: () => {},
  dock: async () => ({}),
  listUserMessages: async () => [],
  forkSession: async () => ({ ok: false, error: '测试里不分叉' }),
  listPlugins: () => [],
  setPolicy: () => {},
  setReviewer: () => {},
  setEffort: async () => {},
  usePermissionPreset: () => ({ ok: true }),
  exit: () => {},
}

/** 装一次插件（惰性：`runCommand` 那条要在模块级 serviceRef 还是空的时候跑）。 */
function ensureApplied(): CommandService {
  if (service !== undefined) return service
  const fakeCtx = {
    get: () => undefined,
    emit: () => {},
    provide: (_name: string, value: CommandService) => {
      service = value
    },
    // /status 与 /export 会读当前会话，给一条空会话就够。
    session: { current: () => ({ messages: [], meta: { cwd: process.cwd(), id: 'test-session' } }) },
    llm: { provider: 'deepseek', model: 'chat', contextWindow: 100_000 },
  }
  // 假 ctx 只实现 apply 与内置 handler 用到的成员。
  ;(commandsPlugin.apply as (ctx: unknown, config?: unknown) => void)(fakeCtx)
  // apply 里通过 provide 回调把服务赋了回来；上面的 if 已经排除了未赋值的情况。
  if (service === undefined) throw new Error('apply 没有 provide commands 服务')
  return service
}

/** 派发一条命令，返回这次产生的提示文本。 */
function dispatch(name: string): string[] {
  notices.length = 0
  ensureApplied().run(`/${name}`, runtime as never, ui as never)
  return [...notices]
}

test('插件对象：名字、提供服务、两个注入', () => {
  expect([commandsPlugin.name, commandsPlugin.provide]).toEqual(['commands', 'commands'])
  expect([...(commandsPlugin.inject as string[])]).toEqual(['session', 'llm'])
  expect(typeof commandsPlugin.apply).toBe('function')
})

test('没有插件实例时 runCommand 不派发也不抛', () => {
  // 这条必须跑在任何一次 apply 之前：插件装过之后模块级 serviceRef 就指向那个注册表了。
  expect(service).toBeUndefined()
  expect(runCommand('/help', {} as never, {} as never)).toBe(false)
})

test('/status 文本按窗口算占用与还差多少', () => {
  const text = statusReport({
    provider: 'deepseek',
    model: 'chat',
    window: 100_000,
    tokens: 50_000,
    messageCount: 12,
    toolCount: 3,
    autoCompactPercent: 80,
  })
  expect(text).toMatch(/窗口 100,000/)
  expect(text).toMatch(/约占窗口 50%/)
  expect(text).toMatch(/还差 30,000/)
})

test('/usage 没有记录时直说，有记录时换算 M/k 与缓存命中率', () => {
  expect(usageReport({ totalTurns: 0 } as never)).toMatch(/还没有用量记录/)
  const text = usageReport({
    sinceTs: null,
    days: [],
    totalTurns: 3,
    activeDays: 2,
    totalInputTokens: 1_500_000,
    totalOutputTokens: 2_000,
    totalCacheHitTokens: 1_000,
    totalCacheMissTokens: 3_000,
    peakDay: null,
    currentStreakDays: 2,
    longestStreakDays: 5,
    models: [],
  })
  expect(text).toMatch(/输入 1\.5M \/ 输出 2\.0k/)
  expect(text).toMatch(/前缀缓存命中：25%/)
})

test('内置命令表：菜单顺序固定，24 条都真的注册进了派发器', () => {
  // 表是唯一真源：名字与顺序钉死，每条都要有说明与参数占位（否则 /help 与补全会缺字）。
  expect(BUILT_IN_COMMANDS.map((entry) => entry.name)).toEqual(MENU_ORDER)
  for (const entry of BUILT_IN_COMMANDS) {
    expect(entry.description.length, entry.name).toBeGreaterThan(0)
    expect(typeof entry.args, entry.name).toBe('string')
  }
  // 本包负责的 24 条一条不少（另外那条 compact 由 compact 包注册）。
  expect([...COMMAND_NAMES].sort()).toEqual(MENU_ORDER.filter((name) => name !== 'compact').sort())

  // 注册面：逐条派发，谁都不能回「未知命令」。/update 会查更新源，这里拦住全局 fetch，
  // 让测试不联网、也不因网络快慢抖动。
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试不联网'))
  try {
    for (const name of COMMAND_NAMES) {
      expect(dispatch(name).join('\n'), `${name} 没注册`).not.toContain(`未知命令：/${name}`)
    }
    expect(dispatch('没有这条命令').join('\n')).toContain('未知命令：/没有这条命令')
  } finally {
    fetchStub.mockRestore()
  }
})
