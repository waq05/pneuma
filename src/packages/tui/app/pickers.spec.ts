/**
 * 三个浮层的渲染冒烟（迁自 `scripts/commands-battery-test.mjs` 的「渲染冒烟」一段）。
 *
 * 为什么单独一层：这三个选择器是**纯展示**组件（键盘与鼠标路由都在 App 顶层），
 * 它们能验的只有「喂进去的数据有没有按约定画出来」——标题条数、当前/默认/内置标记、
 * 选中行的 ❯、行尾的条数与来源标签、提示行里的按键。这些正是用户在浮层上认路的依据，
 * 少一条他就不知道该按什么键。
 *
 * 归 tui project（tui 包里以 `.spec.ts` 结尾的用例）：ink 渲染在 node 里跑，靠假 stdout
 * 拿帧，不是 jsdom。帧内容取「最后一次清行之后」那一段再剥 ANSI——这版 ink 没有
 * `lastFrame`，固定 sleep 在慢机器上会读到半帧，所以等输出长度连续一拍不变再收。
 *
 * @module dsc/packages/tui/app/pickers.spec
 */
import { PassThrough } from 'node:stream'
import { createElement, type ReactElement } from 'react'
import { render } from 'ink'
import { describe, expect, test } from 'vitest'
import { PresetPicker } from './PresetPicker.js'
import { SessionPicker } from './SessionPicker.js'
import { SkillsPicker } from './SkillsPicker.js'

/** 等这么久还没稳定就用手上这份（渲染失败时让断言报出空帧，而不是把用例挂死）。 */
const FRAME_TIMEOUT_MS = 3_000
/** 列数给足 200：提示行很长，110 列会被 truncate-end 截掉 Esc 提示。 */
const COLUMNS = 200

/** 把一次渲染的最后整帧取出来（剥掉 ANSI 与光标控制）。 */
async function renderFrame(element: ReactElement): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number }
  stdout.columns = COLUMNS
  stdout.rows = 30
  let output = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
  })
  const instance = render(element, { stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false })
  // 帧是异步写出来的：等输出长度连续一拍不再变，再当作稳定帧收下。
  const deadline = Date.now() + FRAME_TIMEOUT_MS
  let previous = -1
  while (Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 40))
    if (output.length > 0 && output.length === previous) break
    previous = output.length
  }
  instance.unmount()
  const at = output.lastIndexOf('\x1b[2K')
  const tail = at >= 0 ? output.slice(at) : output
  return tail.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}

describe('① PresetPicker：标题、标记与选中行', () => {
  /** 三份模式：当前用的、默认的、自己编的。 */
  const presets = [
    { name: 'standard', label: '标准', description: '全量工具', builtin: true },
    { name: 'maker', label: '创造', description: '写作向', builtin: true },
    { name: 'mine', label: '我的', description: '自编', builtin: false },
  ]

  /** 三种标记一次画全的帧。 */
  const frameOf = async (): Promise<string> =>
    renderFrame(
      createElement(PresetPicker, {
        presets,
        current: 'maker',
        defaultName: 'standard',
        index: 1,
        query: '',
      } as Parameters<typeof PresetPicker>[0]),
    )

  test('标题写着条数', async () => {
    expect(await frameOf()).toContain('模式选择（3 个）')
  })

  test('当前 / 默认 / 内置三种标记都在', async () => {
    const frame = await frameOf()
    expect(frame).toContain('✓ 当前')
    expect(frame).toContain('默认')
    expect(frame).toContain('内置')
  })

  test('选中行的 ❯ 落在「创造」上（选中项跟着 index 走）', async () => {
    const frame = await frameOf()
    expect(frame.split('\n').find((line) => line.includes('❯'))).toContain('创造')
  })
})

describe('② SkillsPicker：清单、斜杠名与来源标签', () => {
  /** 一条可用技能 + 一条已停用的老技能。 */
  const skills = [
    { name: 'review-pr', description: '审查 PR', source: 'user-dsc', enabled: true, modelInvocable: true, userInvocable: true, toggleable: true },
    { name: 'legacy', description: '老技能', source: 'custom', enabled: false, modelInvocable: false, userInvocable: false, toggleable: true },
  ]

  /** 两行都在的帧。 */
  const frameOf = async (): Promise<string> =>
    renderFrame(createElement(SkillsPicker, { skills, index: 0, query: '' } as Parameters<typeof SkillsPicker>[0]))

  test('标题写着条数，行上带斜杠名（键盘只能回填这个名字）', async () => {
    const frame = await frameOf()
    expect(frame).toContain('技能（2 个）')
    expect(frame).toContain('/review-pr')
  })

  test('已停用与不进目录两个标记都画出来', async () => {
    const frame = await frameOf()
    expect(frame).toContain('已停用')
    expect(frame).toContain('不进目录')
  })

  test('来源标签跟着行画', async () => {
    expect(await frameOf()).toContain('user-dsc')
  })
})

describe('③ SessionPicker：两颗层的标题与提示行', () => {
  test('工作区层：标题与个数，行带条数与「当前」', async () => {
    const frame = await renderFrame(
      createElement(SessionPicker, {
        level: 'workspaces',
        workspaces: [
          { cwd: '/proj/beta', name: 'beta', count: 5, latest: 1_800_000_500_000, current: true },
          { cwd: '/proj/alpha', name: 'alpha', count: 8, latest: 1_800_000_000_000, current: false },
        ],
        sessions: [],
        total: 2,
        start: 0,
        index: 0,
        page: 'active',
        query: '',
        buffer: null,
        armed: false,
        loading: false,
        sessionStates: {},
      } as Parameters<typeof SessionPicker>[0]),
    )
    expect(frame).toContain('恢复会话 · 选工作区')
    expect(frame).toContain('2 个工作区')
    expect(frame).toContain('5 条')
    expect(frame).toContain('← 当前')
    expect(frame).toContain('Enter 进入工作区')
    expect(frame).toContain('Esc 关闭')
  })

  test('会话层：面包屑与 Esc 返回提示', async () => {
    const frame = await renderFrame(
      createElement(SessionPicker, {
        level: 'sessions',
        workspaceTitle: 'beta',
        sessions: [{ id: '/tmp/tb/b-0.jsonl', cwd: '/proj/beta', createdAt: 1_700_000_000_000, updatedAt: 1_800_000_000_000, title: '乙' }],
        total: 1,
        start: 0,
        index: 0,
        page: 'active',
        query: '',
        buffer: null,
        armed: false,
        loading: false,
        sessionStates: {},
      } as Parameters<typeof SessionPicker>[0]),
    )
    expect(frame).toContain('恢复会话 › beta')
    expect(frame).toContain('Esc 返回工作区列表')
  })
})
