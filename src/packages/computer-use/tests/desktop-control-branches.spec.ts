/**
 * `desktop-control.ts` 的分支补测（与 `desktop-control.spec.ts` 分工，不重复）。
 *
 * 既有那张网钉了纯函数、脚本生成与 `runPowerShell` 生命周期；这里补的是它没走到的
 * **决策分支**：
 *   - `runDesktopAction` 的整张 switch（每个动作的成功/拒绝/回退、窗口绑定、白名单、
 *     坐标与元素目标、参数夹取）；
 *   - `takeScreenshot` 的裁切校验、输出解析、缩放系数与失败包装；
 *   - `observeAppState` 的全树 / 增量 / 换窗口基线 / 失败；
 *   - `parseFrame` / `normalizeElement` 的畸形输入与缺省；
 *   - `diffText`、`gradeDesktopAction` 的 JSON 失败、审计写入失败、急停杀进程异常；
 *   - `index.ts` 里既有 wiring spec 没走到的 `describeTarget` / `dropStaleScreenshots` /
 *     设置按钮的无标题分支。
 *
 * 仍然**不操作这台电脑**：`node:child_process` 整个换成按队列应答的假 spawn，
 * 每个 PowerShell 调用拿一份预置 stdout/stderr/退出码；不碰真实桌面、不跑真实脚本。
 *
 * @module @pneuma/computer-use/tests/desktop-control-branches.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'
import {
  appendComputerAudit,
  DESKTOP_ACTIONS,
  diffText,
  foregroundWindow,
  gradeDesktopAction,
  killAllPowerShell,
  listScreens,
  parseFrame,
  resetFrames,
  runDesktopAction,
  runPowerShell,
  settleObserve,
  takeScreenshot,
  toSendKeys,
  type DesktopAction,
  type DesktopArgs,
} from '../desktop-control.js'

/** 一条假 PowerShell 应答。 */
interface Reply {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  /** 不自动退出（留给急停 / kill 抛错的用例）。 */
  hold?: boolean
  /** `child.kill()` 抛错（急停要吞掉这种异常）。 */
  killThrows?: boolean
}

type Listener = (...args: unknown[]) => void

interface FakeChild {
  stdout: { on: (event: string, fn: Listener) => void }
  stderr: { on: (event: string, fn: Listener) => void }
  on: (event: string, fn: Listener) => FakeChild
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  emit: (event: string, ...args: unknown[]) => void
  emitStdout: (chunk: string | Buffer) => void
  emitStderr: (chunk: string | Buffer) => void
}

/**
 * 假 spawn：每次调用按队列取一条应答，异步把 stdout/stderr 与 close（或 error）发出去。
 * 队列空时给一个成功空输出，避免某条用例因为少排一次 spawn 而挂住。
 */
const shell = vi.hoisted(() => {
  const replies: Reply[] = []
  const created: FakeChild[] = []
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []

  const spawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    const reply: Reply = replies.shift() ?? { stdout: '', code: 0 }
    const listeners = new Map<string, Listener[]>()
    const listen = (key: string, fn: Listener): void => {
      const list = listeners.get(key) ?? []
      list.push(fn)
      listeners.set(key, list)
    }
    const fire = (key: string, ...values: unknown[]): void => {
      for (const fn of listeners.get(key) ?? []) fn(...values)
    }
    const child: FakeChild = {
      stdout: { on: (event, fn) => listen(`stdout:${event}`, fn) },
      stderr: { on: (event, fn) => listen(`stderr:${event}`, fn) },
      on: (event, fn) => {
        listen(event, fn)
        return child
      },
      kill: vi.fn(() => {
        if (reply.killThrows === true) throw new Error('kill 失败')
        child.killed = true
        return true
      }),
      killed: false,
      emit: (event, ...values) => fire(event, ...values),
      emitStdout: (chunk) => fire('stdout:data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      emitStderr: (chunk) => fire('stderr:data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    }
    created.push(child)
    if (reply.hold !== true) {
      setTimeout(() => {
        if (reply.error !== undefined) {
          fire('error', reply.error)
          return
        }
        if (reply.stdout !== undefined) fire('stdout:data', Buffer.from(reply.stdout))
        if (reply.stderr !== undefined) fire('stderr:data', Buffer.from(reply.stderr))
        fire('close', reply.code === undefined ? 0 : reply.code)
      }, 0)
    }
    return child
  })

  return { spawn, replies, created, calls }
})

vi.mock('node:child_process', () => ({ spawn: shell.spawn }))

/** 临时主目录：index.ts 的配置与审计只往这里写。 */
const home = tempHome('dsc-computer-use-branches-')
let idx: typeof import('../index.js')

beforeAll(async () => {
  idx = await import('../index.js')
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME.startsWith(home.home)).toBe(true)
})

afterAll(() => {
  home.restore()
})

beforeEach(() => {
  shell.replies.length = 0
  shell.created.length = 0
  shell.calls.length = 0
  resetFrames()
})

afterEach(() => {
  killAllPowerShell()
})

/** 排一条或多条 spoofed PowerShell 应答（按 spawn 顺序消费）。 */
function queue(...replies: Reply[]): void {
  shell.replies.push(...replies)
}

/** 一次成功退出、stdout 为空。 */
const OK: Reply = { stdout: 'Done', code: 0 }

/** 一次成功退出、stdout 是一行 JSON。 */
function json(value: unknown): Reply {
  return { stdout: JSON.stringify(value), code: 0 }
}

/** `probeScreen` 的固定输出（虚拟屏 1920×1080 + 前台窗口）。 */
function screen(left = 0, top = 0, width = 1920, height = 1080, foreground = 'notepad.exe|无标题 - 记事本'): Reply {
  return { stdout: `${left},${top},${width},${height}|${foreground}`, code: 0 }
}

/** 最近一次 spawn 的 PowerShell 脚本文本。 */
function lastScript(): string {
  const args = shell.calls.at(-1)?.args
  if (args === undefined) throw new Error('没有 spawn 过子进程')
  return args[5] ?? ''
}

/** 默认选项。 */
const OPTS = { scale: 1, allowedApps: [] as readonly string[], actionDelayMs: 0 }

/** 跑一个动作（默认选项可按需覆盖）。 */
function act(action: DesktopAction, args: DesktopArgs = {}, options: Partial<typeof OPTS> = {}) {
  return runDesktopAction(action, args, { ...OPTS, ...options })
}

/** 目标联合的构造入口（spec 里不逐个窄化）。 */
type Target = NonNullable<DesktopArgs['target']>
const target = (value: unknown): Target => value as Target

/** 一次三元素的观察结果（#0 窗口、#1 文本框、#2 保存按钮）。 */
function installFrame(windowId = 42): ReturnType<typeof parseFrame> {
  return parseFrame(
    JSON.stringify({
      ok: true,
      app: 'notepad',
      window: { id: windowId, title: '无标题 - 记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      elements: [
        { index: 0, controlType: 'Window', title: '无标题 - 记事本', bounds: { x: 0, y: 0, width: 800, height: 600 }, patterns: [] },
        { index: 1, controlType: 'Edit', title: '文本编辑器', automaid: '15', value: 'hi', bounds: { x: 10, y: 60, width: 760, height: 480 }, patterns: ['Text', 'Value'] },
        { index: 2, controlType: 'Button', title: '保存', automaid: 'save', bounds: { x: 100, y: 200, width: 40, height: 20 }, patterns: ['Invoke'] },
      ],
      text: '[0] Window "无标题 - 记事本"',
    }),
  )
}

/** 一次窗口探测的成功输出。 */
function windowJson(id = 99, title = '目标窗口', bounds = { x: 10, y: 20, width: 300, height: 200 }): Reply {
  return json({ ok: true, error: '', id, title, bounds })
}

// ── runDesktopAction：分发与拒绝 ─────────────────────────────────────────────

describe('runDesktopAction：分发与拒绝', () => {
  test('未知 action → 报错并列出全部可选动作；screenshot/stop 是内部错误入口', async () => {
    await expect(act('nope' as DesktopAction)).rejects.toThrow(/不认识的 action「nope」/)
    await expect(act('nope' as DesktopAction)).rejects.toThrow(new RegExp(DESKTOP_ACTIONS.join(' / ')))
    await expect(act('screenshot')).rejects.toThrow(/takeScreenshot/)
    await expect(act('stop')).rejects.toThrow(/由插件处理/)
    expect(shell.created).toHaveLength(0)
  })

  test('get_app_state：无基线时返回全树与索引说明', async () => {
    queue(json({ ok: true, app: 'notepad', window: { id: 42, title: '记事本', bounds: null }, elements: [{ index: 0, controlType: 'Window', title: '记事本' }], text: '[0] Window "记事本"' }))
    const result = await act('get_app_state')
    expect(result.frame?.state_id).toBe('st-1')
    expect(result.text).toContain('元素索引只对「这次观察」有效')
    expect(result.text).toContain('[0] Window "记事本"')
  })

  test('get_app_state：第二次同窗口且无变化 → diff 模式 + 没有变化', async () => {
    const payload = { ok: true, app: 'notepad', window: { id: 42, title: '记事本', bounds: null }, elements: [{ index: 0, controlType: 'Window', title: '记事本' }], text: 'tree' }
    queue(json(payload), json(payload))
    await act('get_app_state')
    const second = await act('get_app_state')
    expect(second.frame?.snapshot_mode).toBe('diff')
    expect(second.frame?.base_state_id).toBe('st-1')
    expect(second.text).toContain('没有变化')
    expect(second.text).toContain('增量模式')
  })

  test('get_app_state：元素变化时给新增/移除/变化明细', async () => {
    queue(
      json({ ok: true, app: 'a', window: { id: 42, title: 'A', bounds: null }, elements: [{ index: 0, controlType: 'Edit', title: 'a', value: '1' }, { index: 1, controlType: 'Button', title: '旧' }], text: '' }),
      json({ ok: true, app: 'a', window: { id: 42, title: 'A', bounds: null }, elements: [{ index: 0, controlType: 'Edit', title: 'a', value: '2' }, { index: 1, controlType: 'Button', title: '新' }, { index: 2, controlType: 'Text', title: '加' }], text: '' }),
    )
    await act('get_app_state')
    const second = await act('get_app_state')
    expect(second.frame?.diff).toEqual({ removed: [], added: [2], changed: [0, 1] })
    expect(second.text).toContain('新增 [2]')
    expect(second.text).toContain('[0] Edit "a" = "2"')
  })

  test('get_app_state：disableDiffing 强制全树；换窗口不拿旧窗口当基线', async () => {
    queue(json({ ok: true, app: 'a', window: { id: 42, title: 'A', bounds: null }, elements: [], text: 'a' }))
    await act('get_app_state')
    queue(json({ ok: true, app: 'a', window: { id: 42, title: 'A', bounds: null }, elements: [], text: 'a' }))
    const full = await act('get_app_state', { disableDiffing: true })
    expect(full.frame?.snapshot_mode).toBe('full')
    expect(full.text).toContain('元素索引只对')

    queue(json({ ok: true, app: 'b', window: { id: 43, title: 'B', bounds: null }, elements: [], text: 'b' }))
    const other = await act('get_app_state')
    expect(other.text).toContain('元素索引只对')
  })

  test('get_app_state：脚本失败包装成「无障碍观察失败」；数字串窗口走句柄', async () => {
    queue({ stderr: 'UIA 不可用', code: 1 })
    await expect(act('get_app_state')).rejects.toThrow(/无障碍观察失败：UIA 不可用/)

    queue(json({ ok: true, app: 'a', window: { id: 7, title: 'A', bounds: null }, elements: [], text: '' }))
    await act('get_app_state', { window: '7' })
    expect(shell.calls.at(-1)!.args[5]).toContain('Resolve-Win 7')
  })
})

// ── click / drag ────────────────────────────────────────────────────────────

describe('runDesktopAction：click', () => {
  test('coordinate 目标 + 默认左键：换算、点击脚本、回执文案', async () => {
    queue(screen(), OK)
    const result = await act('click', { target: target({ type: 'coordinate', x: 100, y: 120 }) })
    expect(result.text).toContain('单击left')
    expect(shell.calls).toHaveLength(2)
    expect(lastScript()).toContain('[DscMouse]::SetCursorPos(100, 120)')
    expect(lastScript()).toContain('mouse_event(2,0,0,0')
  })

  test('双击 + 右键：事件位与文案都变', async () => {
    queue(screen(), OK)
    const result = await act('click', { target: target({ type: 'coordinate', x: 1, y: 2 }), button: 'right', double: true })
    expect(result.text).toContain('双击right')
    expect(lastScript().match(/mouse_event\(8,0,0,0/g) ?? []).toHaveLength(2)
    expect(lastScript().match(/mouse_event\(16,0,0,0/g) ?? []).toHaveLength(2)
  })

  test('绑定窗口：先探测窗口（失败路径），成功时坐标按窗口左上角偏移并激活', async () => {
    queue(screen(), json({ ok: false, error: '找不到窗口「x」' }))
    await expect(
      act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }), window: 'x' }),
    ).rejects.toThrow(/找不到窗口「x」/)

    queue(screen(), windowJson(99), OK)
    const bound = await act('click', {
      target: target({ type: 'coordinate', x: 30, y: 40 }),
      window: 99,
    })
    expect(bound.text).toContain('窗口内坐标 (30, 40) → 屏幕 (40, 60)')
    expect(lastScript()).toContain('SetForegroundWindow([IntPtr]99)')
    expect(lastScript()).toContain('SetCursorPos(40, 60)')
  })

  test('不认识的鼠标键 / 缺目标 / 屏幕边界读不出 都在点击前拒绝', async () => {
    queue(screen())
    await expect(act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }), button: 'wheel' })).rejects.toThrow(
      /不认识的鼠标键「wheel」/,
    )

    queue(screen())
    await expect(act('click')).rejects.toThrow(/要带 target/)

    queue({ stdout: 'bad,0,0,0|fg' })
    await expect(act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }) })).rejects.toThrow(
      /读屏幕边界失败/,
    )
  })

  test('应用白名单：进程名命中、标题命中放行；都不中则拦下；空项忽略', async () => {
    queue(screen(), OK)
    await expect(
      act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }) }, { allowedApps: ['notepad'] }),
    ).resolves.toMatchObject({ text: expect.stringContaining('单击left') })

    queue(screen(), OK)
    await expect(
      act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }) }, { allowedApps: ['记事本'] }),
    ).resolves.toBeDefined()

    // 这一支会在 probeScreen 之后抛错：只排屏幕那一条，别把多余的应答漏给下一条用例。
    queue(screen())
    await expect(
      act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }) }, { allowedApps: ['', '  ', 'code'] }),
    ).rejects.toThrow(/不在你设的应用白名单/)

    queue(screen(), OK)
    await expect(
      act('click', { target: target({ type: 'coordinate', x: 1, y: 1 }) }, { allowedApps: [] }),
    ).resolves.toBeDefined()
  })

  test('元素目标：用最近一次观察的索引，标签带控件类型与标题', async () => {
    installFrame()
    queue(screen(), OK)
    const result = await act('click', { target: target({ type: 'element', index: 2 }) })
    expect(result.text).toContain('元素 #2（Button「保存」）')
    expect(lastScript()).toContain('SetCursorPos(120, 210)')
  })
})

describe('runDesktopAction：drag', () => {
  test('默认 24 步；amount 夹到 2..200；脚本插值并保证抬起', async () => {
    queue(screen(), OK)
    const plain = await act('drag', {
      from: target({ type: 'coordinate', x: 10, y: 10 }),
      to: target({ type: 'coordinate', x: 100, y: 50 }),
    })
    expect(plain.text).toContain('分 24 步')
    expect(lastScript()).toContain('$i -le 24')

    queue(screen(), OK)
    const bounded = await act('drag', {
      from: target({ type: 'coordinate', x: 10, y: 10 }),
      to: target({ type: 'coordinate', x: 100, y: 50 }),
      amount: 500,
    })
    expect(bounded.text).toContain('分 200 步')

    queue(screen(), OK)
    const low = await act('drag', {
      from: target({ type: 'coordinate', x: 10, y: 10 }),
      to: target({ type: 'coordinate', x: 100, y: 50 }),
      amount: 0,
    })
    expect(low.text).toContain('分 2 步')
    expect(lastScript()).toContain('finally')
  })

  test('缺起点/终点 → 在动作前报错', async () => {
    queue(screen())
    await expect(
      act('drag', { to: target({ type: 'coordinate', x: 1, y: 1 }) }),
    ).rejects.toThrow(/要带 target/)
  })
})

// ── type / paste / set_value / select_text / perform_action ──────────────────

describe('runDesktopAction：文本输入与元素动作', () => {
  test('type：空文本与超长文本都在 spawn 前拒绝', async () => {
    await expect(act('type', { text: '' })).rejects.toThrow(/type 要带 text/)
    await expect(act('type', { text: 'a'.repeat(4001) })).rejects.toThrow(/一次最多输 4000 字/)
    expect(shell.created).toHaveLength(0)
  })

  test('type：绑定窗口时先发激活脚本，再走剪贴板粘贴', async () => {
    queue(screen(), windowJson(99), OK, OK)
    const result = await act('type', { text: "it's", window: 99 })
    expect(result.text).toContain('已输入 4 个字符')
    expect(shell.calls).toHaveLength(4)
    expect(shell.calls[2]!.args[5]).toContain('SetForegroundWindow([IntPtr]99)')
    expect(lastScript()).toContain("Set-Clipboard -Value 'it''s'")
  })

  test('paste：不带 text 不动剪贴板；带 text 写入并还原', async () => {
    queue(screen(), OK)
    const current = await act('paste')
    expect(current.text).toContain('没有改动剪贴板')
    expect(lastScript()).not.toContain('Set-Clipboard -Value')

    queue(screen(), OK)
    const typed = await act('paste', { text: '粘贴内容' })
    expect(typed.text).toContain('已把 4 个字符经剪贴板粘贴进去')
    expect(lastScript()).toContain("Set-Clipboard -Value '粘贴内容'")
    expect(lastScript()).toContain('Set-Clipboard -Value $old')
  })

  test('set_value：缺元素目标拒绝；ValuePattern 成功回执', async () => {
    await expect(act('set_value', { value: 'x' })).rejects.toThrow(/set_value 要带/)
    installFrame()
    queue(screen(), json({ ok: true, method: 'value' }))
    const result = await act('set_value', { target: target({ type: 'element', index: 1 }), value: '新值' })
    expect(result.text).toContain('已把元素 #1 的值设为「新值」（ValuePattern）')
    expect(lastScript()).toContain("SetValue('新值')")
  })

  test('set_value：没有 ValuePattern 时回退成点击后输入', async () => {
    installFrame()
    queue(screen(), json({ ok: true, method: 'none' }), OK, OK)
    const result = await act('set_value', { target: target({ type: 'element', index: 1 }), value: 'abc' })
    expect(result.text).toContain('不支持直接设值，已回退为「点击后输入」3 个字符')
    expect(shell.calls).toHaveLength(4)
    expect(lastScript()).toContain("Set-Clipboard -Value 'abc'")
  })

  test('set_value：窗口标题（非数字）用最近观察的窗口句柄 + 标题转义', async () => {
    installFrame()
    queue(screen(), windowJson(42), json({ ok: true, method: 'value' }))
    await act('set_value', { target: target({ type: 'element', index: 1 }), value: 'x', window: "记事本'" })
    expect(shell.calls[2]!.args[5]).toContain("Resolve-Win 42 '记事本'''")
  })

  test('元素动作返回 ok:false / 缺 method：前者抛原文，后者按 none 处理', async () => {
    installFrame()
    queue(screen(), json({ ok: false, error: '元素动作失败' }))
    await expect(
      act('set_value', { target: target({ type: 'element', index: 1 }), value: 'x' }),
    ).rejects.toThrow(/元素动作失败/)

    installFrame()
    queue(screen(), json({ ok: true }), OK, OK)
    const fallback = await act('set_value', { target: target({ type: 'element', index: 1 }), value: 'x' })
    expect(fallback.text).toContain('已回退为「点击后输入」')
  })

  test('select_text：缺目标、模式不支持、成功三条路', async () => {
    await expect(act('select_text')).rejects.toThrow(/select_text 要带/)

    installFrame()
    queue(screen(), json({ ok: true, method: 'none' }))
    await expect(
      act('select_text', { target: target({ type: 'element', index: 1 }) }),
    ).rejects.toThrow(/不支持选择文本/)

    installFrame()
    queue(screen(), json({ ok: true, method: 'select' }))
    const ok = await act('select_text', { target: target({ type: 'element', index: 1 }) })
    expect(ok.text).toContain('已选中元素 #1 的文本（select）')
  })

  test('perform_action：缺 index / 空 pattern / 模式不支持 / 成功', async () => {
    await expect(act('perform_action', { pattern: 'invoke' })).rejects.toThrow(/perform_action 要带/)
    await expect(act('perform_action', { target: target({ type: 'element', index: 1 }), pattern: '  ' })).rejects.toThrow(
      /要带 pattern/,
    )

    installFrame()
    queue(screen(), json({ ok: true, method: 'none' }))
    await expect(
      act('perform_action', { target: target({ type: 'element', index: 2 }), pattern: 'toggle' }),
    ).rejects.toThrow(/不支持 pattern「toggle」/)

    installFrame()
    queue(screen(), json({ ok: true, method: 'invoke' }))
    const ok = await act('perform_action', { target: target({ type: 'element', index: 2 }), pattern: 'invoke' })
    expect(ok.text).toContain('已对元素 #2 执行 invoke（invoke）')
  })
})

// ── key / scroll / cursor / list_* ──────────────────────────────────────────

describe('runDesktopAction：按键、滚动与观察列表', () => {
  test('key：非法键在 spawn 前拒绝；repeat / hold 夹取进脚本', async () => {
    await expect(act('key', { key: 'win+e' })).rejects.toThrow(/不允许按 Win 键/)
    expect(shell.created).toHaveLength(0)

    queue(screen(), OK)
    const result = await act('key', { key: 'ctrl+c', repeat: 999, holdSeconds: 99 })
    expect(result.text).toContain('已按键 ctrl+c × 50')
    expect(lastScript()).toContain('$i -lt 50')
    expect(lastScript()).toContain('Start-Sleep -Milliseconds 10000')
  })

  test('key：repeat 缺省 1、hold 缺省 0；绑定窗口先激活', async () => {
    queue(screen(), windowJson(99), OK, OK)
    const result = await act('key', { key: 'enter', window: 99 })
    expect(result.text).toBe('已按键 enter。')
    expect(shell.calls).toHaveLength(4)
    expect(shell.calls[2]!.args[5]).toContain('SetForegroundWindow([IntPtr]99)')
    expect(lastScript()).toContain('$i -lt 1')
    expect(lastScript()).not.toContain('Start-Sleep -Milliseconds 0')
  })

  test('scroll：默认 3 档；超 30 与非整数拒绝；负数向下', async () => {
    queue(screen(), OK)
    const plain = await act('scroll')
    expect(plain.text).toContain('已滚动 3 档')
    expect(lastScript()).toContain(' 4294967176,')

    await expect(act('scroll', { amount: 31 })).rejects.toThrow(/最多滚 30 档/)
    await expect(act('scroll', { amount: 1.5 })).rejects.toThrow(/amount 必须是整数/)

    queue(screen(), OK)
    const down = await act('scroll', { amount: -2 })
    expect(down.text).toContain('已滚动 -2 档')
    expect(lastScript()).toContain('$i -lt 2')
    expect(lastScript()).toContain(' 120,')
  })

  test('scroll：target / legacy x,y 才生成移动鼠标那行', async () => {
    installFrame()
    queue(screen(), OK)
    await act('scroll', { target: target({ type: 'element', index: 2 }), amount: 1 })
    expect(lastScript()).toContain('[DscMouse]::SetCursorPos(120, 210) | Out-Null')

    queue(screen(), OK)
    await act('scroll', { x: 7, y: 8, amount: 1 })
    expect(lastScript()).toContain('[DscMouse]::SetCursorPos(7, 8) | Out-Null')

    queue(screen(), OK)
    await act('scroll', { amount: 1 })
    expect(lastScript()).not.toContain('[DscMouse]::SetCursorPos')
  })

  test('cursor：解析坐标；缺 y 时给问号', async () => {
    queue({ stdout: '12,34' })
    expect((await act('cursor')).text).toContain('屏幕 (12, 34)')
    queue({ stdout: '5' })
    expect((await act('cursor')).text).toContain('屏幕 (5, ?)')
  })

  test('list_windows：空清单、带标志的条目、单对象（非数组）、ok:false', async () => {
    queue(json({ ok: true, windows: [] }))
    expect((await act('list_windows')).text).toContain('没找到带标题的窗口')

    queue(
      json({
        ok: true,
        windows: [
          {
            window_id: 5,
            app: 'notepad',
            title: '',
            bounds: { x: 1, y: 2, width: 3, height: 4 },
            focused: true,
            main: true,
            onscreen: false,
          },
        ],
      }),
    )
    const line = (await act('list_windows')).text
    expect(line).toContain('id=5 [notepad] （无标题）')
    expect(line).toContain('（前台、主窗口、最小化/屏外）')

    queue(json({ ok: true, windows: { window_id: 6, app: 'a', title: 'T', bounds: { x: 0, y: 0, width: 1, height: 1 } } }))
    expect((await act('list_windows')).text).toContain('id=6 [a] T')

    queue(json({ ok: false, error: '枚举失败' }))
    await expect(act('list_windows')).rejects.toThrow(/列窗口失败：枚举失败/)
  })

  test('list_apps：无标题/前台标记、单对象、ok:false', async () => {
    queue(json({ ok: true, apps: [{ pid: 9, app: 'code', title: '', foreground: true }] }))
    expect((await act('list_apps')).text).toContain('code（pid 9） 【前台】')

    queue(json({ ok: true, apps: { pid: 10, app: 'x', title: 'X' } }))
    expect((await act('list_apps')).text).toContain('x（pid 10） — X')

    queue(json({ ok: false }))
    await expect(act('list_apps')).rejects.toThrow(/列应用失败：未知原因/)
  })

  test('screens：主屏标记、单对象、ok:false', async () => {
    queue(json({ ok: true, screens: [{ device: '\\\\.\\DISPLAY1', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }))
    expect((await act('screens')).text).toContain('\\\\.\\DISPLAY1（主） @ 0,0 1920×1080')

    queue(json({ ok: true, screens: { device: 'D2', primary: false, bounds: { x: -10, y: 0, width: 5, height: 6 } } }))
    expect((await act('screens')).text).toContain('D2 @ -10,0 5×6')

    queue(json({ ok: false, error: '没有显示器' }))
    await expect(act('screens')).rejects.toThrow(/枚举显示器失败：没有显示器/)
  })
})

// ── takeScreenshot ──────────────────────────────────────────────────────────

describe('takeScreenshot：裁切校验、输出解析与缩放', () => {
  test('clip 字段非数字 / 宽高非正 → spawn 前拒绝', async () => {
    await expect(
      takeScreenshot({ maxEdge: 1568, format: 'jpeg', quality: 80, clip: { x: 'a', y: 0, width: 1, height: 1 } as never }),
    ).rejects.toThrow(/clip\.x 要是数字/)
    await expect(
      takeScreenshot({ maxEdge: 1568, format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 0, height: 1 } }),
    ).rejects.toThrow(/clip\.width \/ clip\.height 要大于 0/)
    expect(shell.created).toHaveLength(0)
  })

  test('JPEG + 裁切：脚本带质量与裁切矩形，结果文案带换算系数', async () => {
    queue({ stdout: '200,100,400,200,10,20,0,0,1920,1080|AAAA', code: 0 })
    const result = await takeScreenshot({
      maxEdge: 1568,
      format: 'jpeg',
      quality: 80,
      clip: { x: 10, y: 20, width: 400, height: 200 },
    })
    const script = lastScript()
    expect(script).toContain('Encoder]::Quality, [long]80')
    expect(script).toContain('$ox = 10; $oy = 20')
    expect(script).toContain('$max = 1568')
    expect(result.scale).toBe(2)
    expect(result.images).toEqual(['data:image/jpeg;base64,AAAA'])
    expect(result.text).toContain('裁切区域') // 相对虚拟屏左上角 (0,0) 起点 (10, 20)
    expect(result.text).toContain('起点 (10, 20) 大小 400×200')
    expect(result.text).toContain('换算系数 2.00')
  })

  test('PNG + 无裁切：maxEdge 夹到 640、编码走 Png；缩放为 1', async () => {
    queue({ stdout: '640,480,0,0,0,0,-100,-50,2560,1440|BBBB', code: 0 })
    const result = await takeScreenshot({ maxEdge: 1, format: 'png', quality: 1 })
    const script = lastScript()
    expect(script).toContain('$max = 640')
    expect(script).toContain('ImageFormat]::Png')
    expect(result.images).toEqual(['data:image/png;base64,BBBB'])
    expect(result.scale).toBe(1)
    expect(result.text).toContain('这是整个桌面的截图')
    expect(result.text).toContain('虚拟屏分辨率 2560×1440，起点 (-100, -50)')
  })

  test('输出格式看不懂 / base64 为空 → 明确报错', async () => {
    queue({ stdout: '没有竖线', code: 0 })
    await expect(takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).rejects.toThrow(
      /截屏返回看不懂的格式/,
    )

    queue({ stdout: '100,80,100,80,0,0,0,0,100,80|', code: 0 })
    await expect(takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).rejects.toThrow(/截屏是空的/)
  })

  test('PowerShell 失败 → 包装成「截屏失败」', async () => {
    queue({ stderr: '访问被拒绝', code: 1 })
    await expect(takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).rejects.toThrow(
      /截屏失败：访问被拒绝/,
    )
  })

  test('缩放系数：裁切宽为 0 退回图片宽；图片宽为 0 用裁切宽；全 0 记 1', async () => {
    queue({ stdout: '100,80,0,0,0,0,0,0,1920,1080|AA', code: 0 })
    expect((await takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).scale).toBe(1)

    // imageWidth 非 0 时分母用图片宽：400 / 100 = 4。
    queue({ stdout: '100,80,400,200,0,0,0,0,1920,1080|AA', code: 0 })
    expect((await takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).scale).toBe(4)

    // imageWidth 为 0：分母退回裁剪宽，400 / 400 = 1。
    queue({ stdout: '0,0,400,200,0,0,0,0,1920,1080|AA', code: 0 })
    expect((await takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).scale).toBe(1)

    queue({ stdout: '0,0,0,0,0,0,0,0,0,0|AA', code: 0 })
    expect((await takeScreenshot({ maxEdge: 800, format: 'jpeg', quality: 80 })).scale).toBe(1)
  })
})

// ── foregroundWindow / listScreens ──────────────────────────────────────────

describe('foregroundWindow / listScreens', () => {
  test('前台窗口标题里可以再有竖线（只按第一个竖线切）', async () => {
    queue(screen(0, 0, 1920, 1080, 'proc.exe|标题|第二段'))
    expect(await foregroundWindow()).toBe('proc.exe|标题|第二段')
  })

  test('listScreens：成功映射；非数组单对象；ok:false', async () => {
    queue(json({ ok: true, screens: [{ device: 'S1', primary: true, bounds: { x: -1, y: -2, width: 3, height: 4 } }] }))
    expect(await listScreens()).toEqual([
      { device: 'S1', primary: true, bounds: { x: -1, y: -2, width: 3, height: 4 } },
    ])

    queue(json({ ok: true, screens: { device: 'S2', primary: false, bounds: {} } }))
    expect(await listScreens()).toEqual([
      { device: 'S2', primary: false, bounds: { x: 0, y: 0, width: 0, height: 0 } },
    ])

    queue(json({ ok: false, error: '坏了' }))
    await expect(listScreens()).rejects.toThrow(/坏了/)
  })
})

// ── parseFrame / diffText / grade / audit ───────────────────────────────────

describe('parseFrame 与 normalizeElement 的畸形输入', () => {
  test('非 JSON / ok:false（有、无 error）分别报错', () => {
    expect(() => parseFrame('not json')).toThrow(/不是 JSON/)
    expect(() => parseFrame('{"ok":false}')).toThrow(/无障碍观察失败：未知原因/)
    expect(() => parseFrame('{"ok":false,"error":"UIA 没装"}')).toThrow(/UIA 没装/)
  })

  test('elements 缺失为 []、单对象包成数组；窗口与 bounds 缺失用缺省', () => {
    const empty = parseFrame('{"ok":true,"window":{"id":8},"elements":null}')
    expect(empty.elements).toEqual([])
    expect(empty.window.title).toBe('')
    expect(empty.window.bounds).toBeNull()

    const wrapped = parseFrame(JSON.stringify({ ok: true, window: { id: 9, bounds: { x: 1 } }, elements: { controlType: 'Edit' } }))
    expect(wrapped.elements).toHaveLength(1)
    expect(wrapped.elements[0]).toMatchObject({ controlType: 'Edit', index: 0, bounds: null })
    expect(wrapped.window.bounds).toEqual({ x: 1, y: 0, width: 0, height: 0 })
  })

  test('normalizeElement：null 项、字符串 patterns、非法 index、enabled=false、offscreen=true', () => {
    const frame = parseFrame(
      JSON.stringify({
        ok: true,
        app: 'x',
        window: { id: 11, title: 'W', bounds: { x: 1, y: 2, width: 3, height: 4 } },
        elements: [
          null,
          { index: 'bad', controlType: 'Button', patterns: 'Invoke', enabled: false, offscreen: true, bounds: { x: 5, y: 6, width: 7, height: 8 } },
          { index: 7, patterns: null, value: undefined },
        ],
        text: 't',
      }),
    )
    expect(frame.elements[0]).toMatchObject({ index: 0, controlType: '', bounds: null, patterns: [], enabled: true, offscreen: false })
    expect(frame.elements[1]).toMatchObject({
      index: 1,
      controlType: 'Button',
      patterns: ['Invoke'],
      enabled: false,
      offscreen: true,
      bounds: { x: 5, y: 6, width: 7, height: 8 },
    })
    expect(frame.elements[2]).toMatchObject({ index: 7, patterns: [], value: '' })
    expect(frame.text).toBe('t')
  })
})

describe('diffText / gradeDesktopAction / 审计与急停', () => {
  test('没有明细的 diffText 只给一行头；变化索引越界时跳过明细', () => {
    const base = parseFrame('{"ok":true,"window":{"id":1},"elements":[],"text":""}')
    const next = parseFrame('{"ok":true,"window":{"id":1},"elements":[],"text":""}')
    const none = diffText(base, next, { removed: [], added: [], changed: [] })
    expect(none).toContain('新增 []，移除 []，变化 []')
    expect(none).not.toContain('\n ')

    const stale = diffText(base, next, { removed: [], added: [], changed: [5] })
    // 头部仍会列出变化索引 [5]，但取不到元素时不追加明细行。
    expect(stale).not.toContain('\n  [5]')
  })

  test('gradeDesktopAction：JSON.stringify 抛错时退回 String(args)', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(gradeDesktopAction('click', circular)).toBe('input')
    expect(gradeDesktopAction('screenshot', circular)).toBe('read')
    expect(gradeDesktopAction('stop')).toBe('system')
    expect(gradeDesktopAction('type', { text: 'powershell.exe' })).toBe('system')
  })

  test('审计写入失败被吞掉（home 指向一个普通文件）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsc-cu-audit-'))
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x', 'utf8')
    try {
      expect(() =>
        appendComputerAudit(file, {
          ts: 1,
          action: 'click',
          risk: 'input',
          target: 'x',
          result: 'ok',
          approved: true,
        }),
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test('killAllPowerShell：child.kill 抛错也继续清空集合并返回数量', async () => {
    queue({ hold: true, killThrows: true })
    const pending = runPowerShell('x')
    const child = shell.created.at(-1)
    if (child === undefined) throw new Error('没有 spawn 出子进程')
    expect(killAllPowerShell()).toBe(1)
    expect(killAllPowerShell()).toBe(0)
    child.emit('close', 0)
    await expect(pending).resolves.toBe('')
  })

  test('toSendKeys：KEY_MAP 全表、大小写与多余加号/空格都归一', () => {
    const expected: Record<string, string> = {
      enter: '{ENTER}',
      tab: '{TAB}',
      esc: '{ESC}',
      escape: '{ESC}',
      space: ' ',
      backspace: '{BACKSPACE}',
      delete: '{DELETE}',
      insert: '{INSERT}',
      home: '{HOME}',
      end: '{END}',
      pageup: '{PGUP}',
      pagedown: '{PGDN}',
      up: '{UP}',
      down: '{DOWN}',
      left: '{LEFT}',
      right: '{RIGHT}',
      f1: '{F1}',
      f2: '{F2}',
      f3: '{F3}',
      f4: '{F4}',
      f5: '{F5}',
      f6: '{F6}',
      f7: '{F7}',
      f8: '{F8}',
      f9: '{F9}',
      f10: '{F10}',
      f11: '{F11}',
      f12: '{F12}',
    }
    for (const [key, value] of Object.entries(expected)) expect(toSendKeys(key)).toBe(value)
    expect(toSendKeys(' CTRL + + SHIFT + s ')).toBe('^+s')
    expect(() => toSendKeys(123 as unknown as string)).toThrow(/不认识的按键/)
  })
})

describe('settleObserve：默认参数与超时退出', () => {
  test('缺省 interval/timeout/sleep/now 也收敛（真实 120ms 一次）', async () => {
    const result = await settleObserve(async () => 'same', (value) => value)
    expect(result.stable).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.waitedMs).toBeGreaterThanOrEqual(100)
  })

  test('超时时间到且仍在变化 → stable=false 并带上最后一帧指纹', async () => {
    let tick = 0
    let calls = 0
    const result = await settleObserve(
      async () => `v${String(calls++)}`,
      (value) => value,
      {
        intervalMs: 10,
        timeoutMs: 10,
        now: () => tick,
        sleep: async (ms: number) => {
          tick += ms
        },
      },
    )
    expect(result.stable).toBe(false)
    expect(result.attempts).toBe(2)
    expect(result.fingerprint).toBe('v1')
  })
})

// ── index.ts 残支：审计目标摘要 / 旧截图降级 / 按钮无标题 ──────────────────────

/** 桩 ctx（与 index-wiring spec 同一套最小面）。 */
interface Mounted {
  tools: Array<Record<string, unknown> & { name: string; run: (args: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown> }>
  section: {
    save: (key: string, value: unknown) => string | void
    action: (name: string) => Promise<string>
  }
}

function mountIndex(config: Record<string, unknown> = {}): Mounted {
  const tools: Mounted['tools'] = []
  let section: Mounted['section'] | null = null
  const noop = (): void => {}
  const ctx = {
    tools: { register: (entry: Mounted['tools'][number]) => (tools.push(entry), noop) },
    guards: { register: () => noop },
    prompt: { register: () => noop },
    settings: {
      registerSection: (value: Mounted['section']) => {
        section = value
        return noop
      },
      about: () => ({ version: '0', apiVersion: 0, home: home.home, skillsDir: '', pluginsDir: '' }),
    },
    effect(execute: () => unknown) {
      const off = execute()
      return typeof off === 'function' ? off : noop
    },
  }
  idx.computerUsePlugin.apply(ctx as unknown as Context, config)
  if (section === null) throw new Error('插件没有注册设置分区')
  return { tools, section }
}

function toolNamed(mounted: Mounted, name: string): Mounted['tools'][number] {
  const found = mounted.tools.filter((tool) => tool.name === name).at(-1)
  if (found === undefined) throw new Error(`没有注册 ${name}`)
  return found
}

/** 读最近写入的那条审计。 */
function lastAudit(): Record<string, unknown> {
  const lines = readFileSync(join(home.home, 'audit', 'computer-use.jsonl'), 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

describe('index.ts：审计目标摘要与旧截图降级', () => {
  test('dropStaleScreenshots：旧截图换成纯文本说明，最新一张原样保留', () => {
    const shot = (text: string): { role: 'tool'; content: Array<Record<string, unknown>> } => ({
      role: 'tool',
      content: [
        { type: 'image_url', image_url: { url: 'data:x' } },
        { type: 'text', text: `屏幕物理分辨率 1920×1080。${text}` },
      ],
    })
    const first = shot('第一张')
    const second = shot('第二张')
    const kept = idx.dropStaleScreenshots([
      { role: 'user', content: [{ type: 'text', text: '看屏幕' }] },
      first,
      second,
    ] as unknown as Parameters<typeof idx.dropStaleScreenshots>[0])
    expect(kept[1]).not.toBe(first)
    expect((kept[1]!.content as Array<Record<string, unknown>>)).toHaveLength(1)
    expect(String((kept[1]!.content as Array<Record<string, unknown>>)[0]!['text'])).toContain('第一张')
    expect(String((kept[1]!.content as Array<Record<string, unknown>>)[0]!['text'])).toContain('已被更新的截图取代')
    expect(kept[2]).toBe(second)
  })

  test('dropStaleScreenshots：非数组 content 不算截图', () => {
    const messages = [{ role: 'tool', content: '屏幕物理分辨率' }] as never
    expect(idx.dropStaleScreenshots(messages)).toBe(messages)
  })

  test('审计 target 摘要：无目标 —、元素、拖拽、按键、窗口', async () => {
    const mounted = mountIndex({ actionsPerScreenshot: 0, auditEnabled: true })
    const computer = toolNamed(mounted, 'computer')

    queue(screen(), OK)
    await computer.run({ action: 'type', text: 'hi' }, { signal: new AbortController().signal })
    expect(lastAudit()['target']).toBe('—')

    installFrame()
    queue(screen(), OK)
    await computer.run(
      { action: 'click', target: { type: 'element', index: 1 } },
      { signal: new AbortController().signal },
    )
    expect(lastAudit()['target']).toBe('element#1')

    queue(screen(), OK)
    await computer.run(
      { action: 'drag', from: { type: 'coordinate', x: 1, y: 2 }, to: { type: 'coordinate', x: 3, y: 4 } },
      { signal: new AbortController().signal },
    )
    expect(String(lastAudit()['target'])).toContain('drag {"type":"coordinate","x":1,"y":2}')

    queue(screen(), OK)
    await computer.run({ action: 'key', key: 'ctrl+c' }, { signal: new AbortController().signal })
    expect(lastAudit()['target']).toBe('key ctrl+c')

    queue(screen(), windowJson(99), OK, OK)
    await computer.run({ action: 'type', text: 'x', window: 99 }, { signal: new AbortController().signal })
    expect(lastAudit()['target']).toBe('window=99')
  })

  test('设置：auditEnabled 关 / 开都能保存；who-is-front 无标题走占位文案', async () => {
    const mounted = mountIndex()
    expect(mounted.section.save('auditEnabled', false)).toBeUndefined()
    expect(mounted.section.save('auditEnabled', 'true')).toBeUndefined()

    queue(screen(0, 0, 1920, 1080, 'notepad.exe|'))
    const text = await mounted.section.action('who-is-front')
    expect(text).toContain('进程 notepad.exe')
    expect(text).toContain('（无标题）')
  })
})
