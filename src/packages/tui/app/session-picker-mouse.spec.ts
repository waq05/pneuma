/**
 * 整屏视口 + 全局鼠标（整条迁自 `scripts/session-picker-mouse-test.mjs`，B1）。
 *
 * ## 覆盖与分层
 *
 * 原探针用自定义 stdin/stdout 驱动 ink 渲染整只 App（mock runtime + 最小假命令 ctx），
 * 逐事件断言输出帧。覆盖：恒定帧（帧内容行数恒等于终端行数 − 1）/ 聊天视口底对齐裁剪 /
 * 滚轮与 PgUp·PgDn 回看 + 回底提示条点击 / 会话选择器（窗口指示、点击选中、再点打开、
 * 改名态免疫、两级工作区导航）/ 审批卡页脚按钮点击 / 提问卡选项点击 / 鼠标跟踪
 * （DECSET 1000+1002+1003+1006）全时开启。
 *
 * 被测对象是 `src/packages/tui/app/App.tsx` 及其浮层，全部落在 tui 层（node + 假终端，
 * 直读 src），所以整条迁过来、探针可整删。
 *
 * ## 读帧
 *
 * 与探针同款：每次 `press` 清空累计输出，`frame()` 从「本次按键后新写的内容」取最后
 * `\x1b[2K` 之后的尾巴。序里有一条「改名态点击被吞」必须读「本次没写任何东西」，
 * 所以不能换成「没新帧沿用上一帧」的读法。
 *
 * ## 隔离
 *
 * `tempHome()` + `DSC_HOME` 在 App 被加载之前换好；App 动态 import。真实 `~/.dsc` 一个
 * 字节都不动。
 *
 * @module dsc/packages/tui/app/session-picker-mouse.spec
 */
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import { tempHome } from '../../../../tests/harness.js'
import { commandsPlugin, runCommand } from '../../commands/index.js'

const home = tempHome('dsc-picker-mouse-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

/** 与 `_tui-commands.mjs` 同款的最小假 ctx：挂真的 commands 插件（/resume 走同一路径）。 */
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

const SESSION_COUNT = 60
const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
  id: `/tmp/sessions/sess-${String(i).padStart(2, '0')}.jsonl`,
  cwd: '/w',
  createdAt: 1_700_000_000_000 + i * 60_000,
  updatedAt: 1_800_000_000_000 - i * 1_000,
  title: `标题${i}`,
}))

const ENTRY_COUNT = 120
const entries = Array.from({ length: ENTRY_COUNT }, (_, i) => ({ id: i, kind: 'system', text: `条目-${i}` }))

/** 探针的 makeSnapshot：只填 App 会读到的字段，overrides 整字段覆盖。 */
function makeSnapshot(overrides: Record<string, unknown> = {}): RuntimeSnapshot {
  const base: Record<string, unknown> = {
    entries,
    sessions,
    sessionsLoading: false,
    sessionStates: {},
    status: {
      turnState: 'idle',
      model: 'test-model',
      effort: 'medium',
      usage: null,
      sessionId: null,
      cwd: '/w',
    },
    surfaces: {
      pendingApproval: null,
      pendingQuestion: null,
      pendingPlan: null,
      goal: null,
      todos: { total: 0, done: 0, active: null },
      mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
      policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
    },
  }
  return {
    ...base,
    ...overrides,
    surfaces: { ...(base.surfaces as object), ...((overrides.surfaces as object) ?? {}) },
  } as unknown as RuntimeSnapshot
}

const listeners = new Set<() => void>()
let snapshot: RuntimeSnapshot = makeSnapshot()
const openedSessions: string[] = []
const approvalAnswers: string[] = []
const questionAnswers: string[] = []

const runtime: Record<string, unknown> = {
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot: () => snapshot,
  setSnapshot(next: RuntimeSnapshot) {
    snapshot = next
    for (const listener of [...listeners]) listener()
  },
  listModels: () => [],
  getUiPrefs: () => ({ statusBar: undefined }),
  dock: () => Promise.resolve({ entries: [] }),
  openSession(path: string) {
    openedSessions.push(path)
  },
  refreshSessions: () => Promise.resolve(),
  listArchivedSessions: () => Promise.resolve({ items: [] }),
  renameSession: () => Promise.resolve({ ok: true }),
  setSessionPinned: () => Promise.resolve({ ok: true }),
  archiveSessions: () => Promise.resolve({ ok: true }),
  restoreSessions: () => Promise.resolve({ ok: true }),
  purgeSessions: () => Promise.resolve({ ok: true }),
  forkSession: () => Promise.resolve({ ok: true, path: '/tmp/sessions/fork.jsonl' }),
  listUserMessages: () => Promise.resolve([]),
  setModel() {},
  interrupt() {},
  exit() {},
  answerApproval(answer: string) {
    approvalAnswers.push(answer)
  },
  answerQuestion(answer: string) {
    questionAnswers.push(answer)
  },
  answerPlan: () => {},
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
// 列数给 200：选择器提示行很长，110 列会被 truncate-end 截掉行尾的 Esc 提示。
const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
stdout.columns = 200
stdout.rows = 40
stdout.isTTY = false
let output = ''
stdout.on('data', (chunk: Buffer) => {
  output += String(chunk)
})

let instance: ReturnType<typeof render> | null = null

/** 敲一段键，等固定一拍；返回本次新写出的内容（空 = 屏幕没动）。 */
async function press(keys: string, ms = 150): Promise<string> {
  output = ''
  stdin.write(keys)
  await sleep(ms)
  return output
}

/** 最后一帧：standard 渲染每次重绘前必写擦行序列，取最后一次擦除之后的裸帧。 */
const lastFrame = (): string => {
  const idx = output.lastIndexOf('\x1b[2K')
  const tail = idx >= 0 ? output.slice(idx) : output
  return tail.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}
/** 帧内容行数（ink 帧自带尾随换行，剥掉再拆）。 */
const contentLines = (frame: string): string[] => frame.replace(/\n$/, '').split('\n')
/** 帧里包含某段文本的第一行的 0 基行号（找不到返回 -1）。 */
const lineOf = (frame: string, needle: string): number => contentLines(frame).findIndex((line) => line.includes(needle))
const selectedLine = (frame: string): string | undefined =>
  contentLines(frame).find((line) => line.includes('❯') && line.includes('sess-'))
const workspaceLine = (frame: string): string | undefined =>
  contentLines(frame).find((line) => line.includes('❯') && (line.includes('alpha') || line.includes('beta')))

beforeAll(async () => {
  const { App } = await import('./App.js')
  instance = render(createElement(App as React.ComponentType<Record<string, unknown>>, { runtime, dispatchCommand }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(150)
})

afterAll(() => {
  instance?.unmount()
  stdin.end()
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})

describe('① 恒定帧 + 聊天视口裁剪 + 全时鼠标跟踪', () => {
  test('初始帧 39 行；最新条目可见、最老被裁；DECSET 含 1002/1003', () => {
    const frame = lastFrame()
    expect(contentLines(frame)).toHaveLength(39)
    expect(frame).toContain('条目-119')
    expect(frame).not.toContain('条目-0')
    expect(output).toContain('\x1b[?1000;1002;1003;1006h')
  })
})

describe('② 滚轮回看 / 回底提示条 / PgUp·PgDn', () => {
  test('滚轮上×3 退 9 行（顶条 = 76），提示条出现，帧仍 39 行', async () => {
    await press('\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<64;10;5M')
    const frame = lastFrame()
    expect(frame).toContain('条目-76')
    expect(frame).not.toContain('条目-75')
    expect(frame).toContain('回到底部')
    expect(frame).toContain('Enter/End')
    expect(contentLines(frame)).toHaveLength(39)
  })

  test('点击提示条回到底部', async () => {
    // 提示条的行号从当前这一帧取；press 会清空输出，先读再点。
    const indicatorRow = lineOf(lastFrame(), '回到底部') + 1
    await press(`\x1b[<0;10;${indicatorRow}M`)
    const frame = lastFrame()
    expect(frame).not.toContain('回到底部')
    expect(frame).toContain('条目-119')
  })

  test('PgUp 回看一屏出现提示条；PgDn 往回一屏', async () => {
    await press('\x1b[5~')
    expect(lastFrame()).toContain('回到底部')
    expect(lastFrame()).toContain('Enter/End')
    const topOf = (frame: string): number =>
      Number(
        contentLines(frame)
          .filter((line) => line.includes('条目-'))
          .map((line) => line.replace(/[^0-9]/g, ''))[0],
      )
    const pgUpTop = topOf(lastFrame())
    await press('\x1b[6~')
    const pgDownTop = topOf(lastFrame())
    expect(pgDownTop).toBeGreaterThan(pgUpTop + 20)
  })
})

describe('③ 会话选择器：窗口指示、键盘与鼠标、两级导航', () => {
  test('打开：全量条数、窗口 1–33、首项选中、帧仍 39 行', async () => {
    await press('/resume')
    await press('\r')
    const frame = lastFrame()
    expect(frame).toContain('恢复会话')
    expect(frame).toContain('（60 条）')
    expect(frame).toContain('显示 1–33')
    expect(selectedLine(frame)).toContain('sess-00')
    expect(contentLines(frame)).toHaveLength(39)
  })

  test('↓×2 选中 sess-02；滚轮上选中 sess-01；点击选中 sess-10（释放被忽略）', async () => {
    await press('\x1b[B\x1b[B')
    expect(selectedLine(lastFrame())).toContain('sess-02')
    await press('\x1b[<64;10;5M')
    expect(selectedLine(lastFrame())).toContain('sess-01')
    // 列表行从顶边框+标题+筛选行之后起排（行 3，0 基）→ 第 10 项在屏幕第 14 行（1 基）
    await press('\x1b[<0;10;14M\x1b[<0;10;14m')
    expect(selectedLine(lastFrame())).toContain('sess-10')
  })

  test('再点已选中行打开会话；选择器关闭回聊天', async () => {
    await press('\x1b[<0;10;14M')
    expect(openedSessions).toHaveLength(1)
    expect(openedSessions[0]).toContain('sess-10')
    expect(lastFrame()).toContain('条目-119')
  })

  test('改名态不响应鼠标；Esc 退出改名', async () => {
    await press('/resume')
    await press('\r')
    await press('\x12') // Ctrl+R
    expect(lastFrame()).toContain('改名：标题0')
    expect(contentLines(lastFrame())).toHaveLength(39)
    await press('\x1b[<0;10;14M')
    expect(openedSessions).toHaveLength(1)
    expect(output.trim()).toBe('') // 无重绘、不开门
    await press('\x1b')
    expect(lastFrame()).not.toContain('改名：')
    await press('\x1b')
  })
})

describe('④ 两级导航（多工作区）：工作区层 → 钻入 → Esc 返回 → Esc 关', () => {
  const multiSessions = [
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `/tmp/ta/a-${i}.jsonl`,
      cwd: '/proj/alpha',
      createdAt: 1_700_000_000_000 + i * 60_000,
      updatedAt: 1_800_000_000_000 - i * 2_000,
      title: `甲${i}`,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `/tmp/tb/b-${i}.jsonl`,
      cwd: '/proj/beta',
      createdAt: 1_700_100_000_000 + i * 60_000,
      updatedAt: 1_800_000_500_000 - i * 3_000,
      title: `乙${i}`,
    })),
  ]

  test('落工作区层：标题带个数、行带条数与最近时间、beta 置顶且首选、帧 39 行', async () => {
    ;(runtime.setSnapshot as (next: RuntimeSnapshot) => void)(makeSnapshot({ sessions: multiSessions }))
    await press('/resume')
    await press('\r')
    const frame = lastFrame()
    expect(frame).toContain('恢复会话 · 选工作区')
    expect(frame).toContain('2 个工作区')
    expect(frame).toContain('8 条')
    expect(frame).toContain('5 条')
    expect(frame).toContain('最近 2027-')
    expect(lineOf(frame, 'beta')).toBeGreaterThanOrEqual(0)
    expect(lineOf(frame, 'beta')).toBeLessThan(lineOf(frame, 'alpha'))
    expect(workspaceLine(frame)).toContain('beta')
    expect(contentLines(frame)).toHaveLength(39)
  })

  test('Enter 钻入 beta；会话层只显示乙会话；Enter 打开 b-0', async () => {
    await press('\r')
    const frame = lastFrame()
    expect(frame).toContain('恢复会话 › beta')
    expect(frame).toContain('（5 条）')
    expect(frame).toContain('乙0')
    expect(frame).not.toContain('甲0')
    expect(frame).toContain('Esc 返回工作区列表')
    await press('\r')
    expect(openedSessions).toHaveLength(2)
    expect(openedSessions[1]).toContain('b-0')
  })

  test('会话层 Esc 回工作区层；再 Esc 关闭选择器', async () => {
    await press('/resume')
    await press('\r')
    await press('\r')
    await press('\x1b')
    expect(lastFrame()).toContain('恢复会话 · 选工作区')
    await press('\x1b')
    expect(lastFrame()).toContain('条目-119')
  })
})

describe('⑤ 工作区层鼠标与筛选：首行直接钻入、筛选词过滤工作区', () => {
  test('点击首行钻入 beta；筛选 alpha 后只剩 alpha；Enter 钻入筛选结果', async () => {
    await press('/resume')
    await press('\r')
    await press('\x1b[<0;10;4M')
    expect(lastFrame()).toContain('恢复会话 › beta')
    await press('\x1b')
    await press('alp')
    const frame = lastFrame()
    expect(frame).toContain('alpha')
    expect(frame).not.toContain('beta')
    await press('\r')
    expect(lastFrame()).toContain('恢复会话 › alpha')
    await press('\x1b')
    await press('\x1b')
    ;(runtime.setSnapshot as (next: RuntimeSnapshot) => void)(makeSnapshot())
  })
})

describe('⑥ 审批卡 / 提问卡：页脚与选项行点击 = 按键', () => {
  test('审批卡：点击 [y] 允许一次', async () => {
    ;(runtime.setSnapshot as (next: RuntimeSnapshot) => void)(
      makeSnapshot({
        surfaces: {
          pendingApproval: {
            id: 'a1',
            toolName: 'write_file',
            risk: 'high',
            reason: '要写入工作区文件',
            argsSummary: '写 D:/tmp/a.txt',
            policy: 'default',
            mode: '执行',
            scopes: ['session', 'always'],
            hardline: false,
          },
        },
      }),
    )
    await sleep(150)
    const frame = lastFrame()
    const approvalRow = lineOf(frame, '允许一次') + 1
    expect(approvalRow).toBeGreaterThan(0)
    await press(`\x1b[<0;5;${approvalRow}M`)
    expect(approvalAnswers).toEqual(['allow-once'])
    ;(runtime.setSnapshot as (next: RuntimeSnapshot) => void)(makeSnapshot())
  })

  test('提问卡：点击方案乙即作答', async () => {
    ;(runtime.setSnapshot as (next: RuntimeSnapshot) => void)(
      makeSnapshot({
        surfaces: {
          pendingQuestion: {
            id: 'q1',
            question: '选哪个方案？',
            options: [{ label: '方案甲' }, { label: '方案乙' }],
            multiSelect: false,
          },
        },
      }),
    )
    await sleep(150)
    const frame = lastFrame()
    const optionRow = lineOf(frame, '方案乙') + 1
    expect(optionRow).toBeGreaterThan(0)
    await press(`\x1b[<0;10;${optionRow}M`)
    expect(questionAnswers).toEqual(['方案乙'])
  })
})
