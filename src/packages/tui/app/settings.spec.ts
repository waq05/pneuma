/**
 * TUI 设置页（/settings）的整屏帧与调用记录（整条迁自 `scripts/settings-test.mjs`；
 * backlog 第三节把它归 `tui` project）。
 *
 * ## 覆盖与分层
 *
 * 原探针 mock 分区注册表的四个方法，走真命令链（输入 /settings 回车）驱动 App 渲染浮层，
 * 逐键断言帧内容与调用记录。覆盖：两级导航（根页分区行 → 分区页字段 → 组子页，Esc 逐级
 * 退栈）· 字段渲染（卡片顶边/字段值区右对齐）· select 循环即存 · switch 翻转即存 ·
 * text 编辑（进入/输入/提交/Esc 取消）· number 校验（非法留编辑态弹红）· info.copyable
 * 复制 · button 执行动作 · custom 分区指引行跳转 · Esc 关页 · 鼠标点行激活（分区/组/字段
 * 三级）· 滚轮移动焦点 · 思考块默认展开分区。
 *
 * 被测对象是 `src/packages/tui/app/App.tsx` + `SettingsOverlay` + `settings-model`，全部落在
 * tui 层（node + 假终端，直读 src），所以整条迁过来、探针可整删。
 *
 * ## 时序
 *
 * 探针每个键固定 sleep 160ms；这里照搬——设置页的按键是**状态依赖**的（同 chunk 到达的
 * 多个键共享旧闭包），固定节奏是测试注入口的物理约束，不是实现的锅。
 *
 * @module dsc/packages/tui/app/settings.spec
 */
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import { tempHome } from '../../../../tests/harness.js'
import { commandsPlugin, runCommand } from '../../commands/index.js'

const home = tempHome('dsc-settings-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

/** 与 `_tui-commands.mjs` 同款的最小假 ctx：挂真的 commands 插件（/settings 走同一路径）。 */
const commandCtx = {
  provide() {},
  get() {
    return undefined
  },
  effect(fn: () => void) {
    if (typeof fn === 'function') fn()
  },
  on() {
    return () => {}
  },
  emit() {},
  session: { current: () => ({ meta: { cwd: '/w', id: 'test' }, filePath: '/w/test.jsonl' }) },
  llm: {},
}
;(commandsPlugin.apply as (ctx: unknown) => void)(commandCtx)
const dispatchCommand = (input: string, runtime: DscRuntime, ui: unknown): boolean =>
  runCommand(input, runtime, ui as Parameters<typeof runCommand>[2])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** mock 分区表：一个全字段类型的声明式分区 + custom 分区 + 两个带组的分区。 */
const SECTIONS = [
  {
    id: 'general',
    title: '通用',
    subtitle: '测试分区',
    order: 0,
    builtin: true,
    custom: false,
    fields: [
      { type: 'select', key: 'policy', label: '权限模式', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], help: '选一个' },
      { type: 'switch', key: 'toggle', label: '开关项', help: '切一下' },
      { type: 'text', key: 'name', label: '文本项', help: '填点字' },
      { type: 'number', key: 'count', label: '数字项', min: 1, max: 10, help: '1 到 10' },
      { type: 'text', key: 'empty', label: '空文本项', help: '没值' },
      { type: 'info', label: '只读项', text: 'C:\\some\\path', mono: true, copyable: true, help: '回车复制' },
      { type: 'info', label: '说明项', text: '不能聚焦的信息' },
      { type: 'button', label: '执行动作', action: 'check-update', help: '按了就知道' },
    ],
  },
  { id: 'models', title: '模型', subtitle: '端点与 key', order: 10, builtin: true, custom: true, fields: [] },
  {
    id: 'browser',
    title: '浏览器自动化',
    subtitle: '测试分组',
    order: 34,
    builtin: false,
    custom: false,
    groups: [
      { id: 'startup', title: '启动与实例', description: '从哪启动' },
      { id: 'safety', title: '安全策略', description: '放行口径' },
    ],
    fields: [
      { type: 'switch', key: 'headless', label: '无窗口运行', group: 'startup', help: '不开窗' },
      { type: 'text', key: 'profileDir', label: 'profile 目录', group: 'startup', help: '实例目录' },
      { type: 'select', key: 'dialogPolicy', label: '对话框策略', group: 'safety', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], help: '弹窗怎么办' },
      { type: 'button', label: '关闭浏览器', action: 'close-browser', group: 'safety', help: '杀进程' },
    ],
  },
  {
    id: 'tui',
    title: '终端界面',
    subtitle: 'TUI 偏好',
    order: 35,
    builtin: true,
    custom: false,
    groups: [{ id: 'status-bar', title: '状态栏', description: '选底栏显示哪些信息' }],
    fields: [
      { type: 'switch', key: 'reasoningDefaultOpen', label: '思考块默认展开', help: '新会话默认摊开' },
      { type: 'switch', key: 'statusBar.model', label: '显示模型', group: 'status-bar' },
      { type: 'switch', key: 'statusBar.cost', label: '显示会话费用', group: 'status-bar' },
    ],
  },
]

let values: Record<string, Record<string, unknown>> = {
  general: { policy: 'a', toggle: false, name: '初始', count: 5, empty: '' },
  models: {},
  browser: { headless: false, profileDir: '', dialogPolicy: 'a' },
  tui: { reasoningDefaultOpen: false, 'statusBar.model': true, 'statusBar.cost': true },
}

const saveCalls: Array<[string, string, unknown]> = []
const actionCalls: Array<[string, string]> = []
const listeners = new Set<() => void>()
const snapshot: RuntimeSnapshot = {
  entries: [],
  sessions: [],
  sessionsLoading: false,
  sessionStates: {},
  status: { turnState: 'idle', model: 'test-model', effort: 'medium', usage: null, contextWindow: 1_000_000, sessionId: '/w/s.jsonl', cwd: '/w' },
  surfaces: {
    pendingApproval: null,
    pendingQuestion: null,
    pendingPlan: null,
    goal: null,
    todos: { total: 0, done: 0, active: null },
    mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
    policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
  },
} as unknown as RuntimeSnapshot

const runtime: Record<string, unknown> = {
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot: () => snapshot,
  listModels: () => [],
  dock: () => Promise.resolve({ entries: [] }),
  submit() {},
  openSession() {},
  refreshSessions: () => Promise.resolve(),
  listArchivedSessions: () => Promise.resolve({ items: [] }),
  renameSession: () => Promise.resolve({ ok: true }),
  archiveSessions: () => Promise.resolve({ ok: true }),
  restoreSessions: () => Promise.resolve({ ok: true }),
  purgeSessions: () => Promise.resolve({ ok: true }),
  listUserMessages: () => Promise.resolve([]),
  forkSession: () => Promise.resolve({ ok: true, path: '/w/fork.jsonl' }),
  listTeammates: () => [],
  peekTranscript: () => Promise.resolve([]),
  setModel() {},
  interrupt() {},
  exit() {},
  answerApproval() {},
  answerQuestion() {},
  answerPlan() {},
  // ── 设置页四件套 ──
  getSettingsSections: () => SECTIONS,
  getSectionValues: (id: string) => Promise.resolve(values[id] ?? {}),
  setSettingValue(id: string, key: string, value: unknown) {
    saveCalls.push([id, key, value])
    values = { ...values, [id]: { ...values[id], [key]: value } }
    return Promise.resolve({ ok: true, notice: '已保存测试' })
  },
  runSettingAction(id: string, action: string) {
    actionCalls.push([id, action])
    return Promise.resolve({ ok: true, notice: '已是最新版' })
  },
  getUiPrefs: () => ({ reasoningDefaultOpen: false }),
}

const stdin = new PassThrough() as PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}
const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false
let output = ''
stdout.on('data', (chunk: Buffer) => {
  output += String(chunk)
})

let instance: ReturnType<typeof render> | null = null

const KEY = { down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', left: '\u001b[D', esc: '\u001b', enter: '\r', backspace: '\u007f' }

/** 敲一段键，等 160ms；返回最后一帧。 */
async function press(keys: string): Promise<string> {
  output = ''
  stdin.write(keys)
  await sleep(160)
  const idx = output.lastIndexOf('\x1b[2K')
  const tail = idx >= 0 ? output.slice(idx) : output
  return tail.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}
const lines = (frame: string): string[] => frame.replace(/\n$/, '').split('\n')
/** 找到含 needle 的行；focus=true 时只认 ❯ 开头的聚焦行。 */
const lineOf = (frame: string, needle: string, focus = false): string | undefined =>
  lines(frame).find((line) => line.includes(needle) && (!focus || line.includes('❯')))

beforeAll(async () => {
  const { App } = await import('./App.js')
  instance = render(createElement(App as React.ComponentType<Record<string, unknown>>, { runtime, dispatchCommand }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(120)
})

afterAll(() => {
  instance?.unmount()
  stdin.end()
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})

describe('① 根页：只列分区导航行（两级导航）', () => {
  test('整屏浮层出现，根页只列分区，分区行带 › 与副标题，首个聚焦 1/4 且 Esc 关闭', async () => {
    await press('/settings')
    const frame = await press(KEY.enter)
    expect(frame).toContain('设置（4 个分区）')
    expect(lineOf(frame, '通用', true)?.includes('›')).toBe(true)
    expect(lineOf(frame, '浏览器自动化')?.includes('›')).toBe(true)
    expect(lineOf(frame, '终端界面')?.includes('›')).toBe(true)
    expect(lineOf(frame, '通用', true)?.includes('测试分区')).toBe(true)
    expect(frame).not.toContain('权限模式')
    expect(frame).not.toContain('开关项')
    expect(frame).not.toContain('打开模型选择器')
    expect(frame).toContain('1/4')
    expect(frame).toContain('Enter 切换/编辑 · Esc 关闭')
  })
})

describe('② 通用分区页：字段展开与渲染', () => {
  test('面包屑、卡片顶边、select 右对齐、switch 空、文本与未设置占位、Esc 返回', async () => {
    const frame = await press(KEY.enter)
    expect(frame).toContain('设置 › 通用')
    expect(frame).toContain('╭─ 通用 · 测试分区')
    expect(lineOf(frame, '权限模式', true)).toContain('‹ 甲 ›')
    expect(lineOf(frame, '开关项')).toContain('[  ]')
    expect(frame).toContain('初始')
    expect(lineOf(frame, '空文本项')).toContain('（未设置）')
    expect(frame).toContain('Enter 切换/编辑 · Esc 返回')
  })

  test('→ 循环 select 改值即存；← 循环回第一个选项', async () => {
    let frame = await press(KEY.right)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|policy|b')
    expect(lineOf(frame, '权限模式')).toContain('‹ 乙 ›')
    expect(frame).toContain('✓ 已保存测试')
    frame = await press(KEY.left)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|policy|a')
  })

  test('Enter 翻转 switch 存 true / false', async () => {
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|toggle|true')
    expect(lineOf(frame, '开关项')).toContain('[✓]')
    frame = await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|toggle|false')
  })

  test('text 编辑：进入草稿态、输入跟随、Enter 提交并退出编辑', async () => {
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(lineOf(frame, '文本项')).toContain('初始▌')
    await press(KEY.backspace)
    await press(KEY.backspace)
    frame = await press('新值')
    expect(lineOf(frame, '文本项')).toContain('新值▌')
    frame = await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|name|新值')
    expect(lineOf(frame, '文本项')).toContain('新值')
    expect(frame).not.toContain('▌')
  })

  test('number：Esc 取消不写入；非法值弹红留编辑态；合法值提交', async () => {
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(lineOf(frame, '数字项')).toContain('5▌')
    frame = await press(KEY.esc)
    expect(saveCalls.some((call) => call[1] === 'count')).toBe(false)
    await press(KEY.enter)
    await press(KEY.backspace)
    await press('99')
    frame = await press(KEY.enter)
    expect(frame).toContain('✕ 无效输入')
    expect(lineOf(frame, '数字项')).toContain('99▌')
    await press(KEY.backspace)
    await press(KEY.backspace)
    await press('9')
    frame = await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|count|9')
  })

  test('空文本项：空草稿直接提交空串', async () => {
    await press(KEY.down)
    await press(KEY.enter)
    await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('general|empty|')
  })

  test('info.copyable 复制；button 执行动作并把回执放进 notice 行', async () => {
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(frame.includes('已复制') || frame.includes('复制失败')).toBe(true)
    await press(KEY.down)
    frame = await press(KEY.enter)
    expect(actionCalls.at(-1)?.join('|')).toBe('general|check-update')
    expect(frame).toContain('✓ 已是最新版')
  })

  test('分区页 Esc 回根页，焦点回第一个分区', async () => {
    const frame = await press(KEY.esc)
    expect(frame).toContain('设置（4 个分区）')
    expect(lineOf(frame, '通用', true)?.includes('›')).toBe(true)
  })
})

describe('③ custom 分区与关页', () => {
  test('模型分区显示指引行；Enter 关设置页开模型浮层', async () => {
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(frame).toContain('打开模型选择器')
    expect(frame).toContain('端点与 API key 在桌面端设置')
    expect(lineOf(frame, '打开模型选择器', true)).toBeDefined()
    frame = await press(KEY.enter)
    expect(frame).toContain('模型选择（')
    expect(frame).not.toContain('设置（4 个分区）')
  })

  test('Esc 关模型浮层；重开设置页落回根页；根页 Esc 关闭', async () => {
    await press(KEY.esc)
    await press('/settings')
    let frame = await press(KEY.enter)
    expect(frame).toContain('设置（4 个分区）')
    frame = await press(KEY.esc)
    expect(frame).not.toContain('设置（4 个分区）')
  })
})

describe('④ 鼠标与滚轮：分区 / 组 / 字段三级', () => {
  test('点分区行进入；点 switch 翻转；滚轮移动焦点 2/7 → 1/7 → 3/7', async () => {
    await press('/settings')
    let frame = await press(KEY.enter)
    frame = await press('\x1b[<0;10;3M')
    expect(frame).toContain('设置 › 通用')
    frame = await press('\x1b[<0;10;5M')
    expect(saveCalls.at(-1)?.join('|')).toBe('general|toggle|true')
    frame = await press('\x1b[<65;10;8M')
    expect(frame).toContain('2/7')
    frame = await press('\x1b[<64;10;8M')
    expect(frame).toContain('1/7')
    await press('\x1b[<65;10;8M')
    frame = await press('\x1b[<65;10;8M')
    expect(frame).toContain('3/7')
  })
})

describe('⑤ 终端界面分区与组子页', () => {
  test('↓×3 进终端界面，翻转思考块默认展开；组子页只渲染组内字段并写 statusBar.cost', async () => {
    await press(KEY.esc)
    await press(KEY.down)
    await press(KEY.down)
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(frame).toContain('设置 › 终端界面')
    expect(lineOf(frame, '思考块默认展开')).toBeDefined()
    frame = await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('tui|reasoningDefaultOpen|true')

    frame = await press(KEY.down)
    expect(frame).toContain('2/2')
    frame = await press(KEY.enter)
    expect(frame).toContain('设置 › 终端界面 › 状态栏')
    expect(frame).toContain('╭─ 状态栏 · 终端界面')
    expect(frame).not.toContain('思考块默认展开')
    expect(frame).toContain('Enter 切换/编辑 · Esc 返回')
    await press(KEY.down)
    frame = await press(KEY.enter)
    expect(saveCalls.at(-1)?.join('|')).toBe('tui|statusBar.cost|false')
    frame = await press(KEY.esc)
    expect(frame).toContain('设置 › 终端界面')
    expect(frame).not.toContain('› 状态栏')
    frame = await press(KEY.esc)
    expect(frame).toContain('设置（4 个分区）')
  })
})

describe('⑥ 浏览器自动化分区：只列组行，组内字段照常渲染', () => {
  test('分区页只列组行；组子页字段齐全；Esc 回分区页', async () => {
    await press(KEY.down)
    await press(KEY.down)
    let frame = await press(KEY.enter)
    expect(frame).toContain('设置 › 浏览器自动化')
    expect(lineOf(frame, '启动与实例', true)?.includes('›')).toBe(true)
    expect(lineOf(frame, '安全策略')?.includes('›')).toBe(true)
    frame = await press(KEY.enter)
    expect(frame).toContain('设置 › 浏览器自动化 › 启动与实例')
    expect(lineOf(frame, '无窗口运行')).toBeDefined()
    expect(lineOf(frame, 'profile 目录')).toBeDefined()
    expect(lineOf(frame, '无窗口运行')).toContain('[  ]')
    frame = await press(KEY.esc)
    expect(frame).toContain('设置 › 浏览器自动化')
    expect(frame).not.toContain('› 启动与实例')
    await press(KEY.esc)
  })
})

describe('⑦ 鼠标全链路：分区 → 组 → 子页 switch，Esc 三级退栈', () => {
  test('点分区行进 browser；点组行进子页；点子页 switch 翻转；两级 Esc 回根页，再 Esc 关页且按键不再进路由', async () => {
    let frame = await press('\x1b[<0;10;5M')
    expect(frame).toContain('设置 › 浏览器自动化')
    frame = await press('\x1b[<0;10;4M')
    expect(frame).toContain('设置 › 浏览器自动化 › 启动与实例')
    frame = await press('\x1b[<0;10;4M')
    expect(saveCalls.at(-1)?.join('|')).toBe('browser|headless|true')
    await press(KEY.esc)
    frame = await press(KEY.esc)
    expect(frame).toContain('设置（4 个分区）')
    frame = await press(KEY.esc)
    expect(frame).not.toContain('设置（4 个分区）')
    await press(KEY.down)
    frame = await press(KEY.down)
    expect(frame).not.toContain('设置（4 个分区）')
    expect(frame).not.toContain('设置 ›')
  })
})
