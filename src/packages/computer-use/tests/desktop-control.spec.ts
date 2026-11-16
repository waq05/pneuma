/**
 * 电脑操作（Computer Use）parity 自检（迁自 `scripts/computer-use-test.mjs`）：
 * **不操作这台电脑**，只对纯函数、生成的 PowerShell 脚本文本、危险分级/审计、settle
 * 逻辑做断言，另用桩 ctx 挂一次插件核对工具名与 schema 形状。
 *
 * ## 为什么单独一张网
 *
 * 电脑操作是「看 → 定位 → 动手 → 再确认」的闭环，任何一环写错都可能是灾难性的
 * （点错位置、元素没了却按旧坐标点、粘贴没还原用户剪贴板）。全部断言都钉在
 * **可离线验证的契约**上：脚本长什么样、目标怎么解析、审计行什么形状。
 *
 * ## 五组
 *
 *   ① 工具名与 schema 形状（枚举项 / 必填 / `{type:'element'|'coordinate'}` 判别）；
 *   ② 目标解析纯函数（element 越界/不存在/state_id 不匹配 → fail-closed；coordinate 越界 → 报错）；
 *   ③ 脚本生成（UIA 枚举 / 点击 / 拖拽分步（finally 保证抬起）/ 滚轮 / 粘贴还原剪贴板）；
 *   ④ 危险分级与审计（审计行格式、路径来自 home、只读观察不进审批）；
 *   ⑤ settle/超时（注入假时钟与假观察函数）。
 *
 * ## 为什么③ 保留「对脚本文本断言」
 *
 * 那些字符串是 `screenshotScript()` 这类纯函数的**运行输出**——真正被 PowerShell 执行的
 * 就是它。这不是源码文本断言（扫 `src/**` 的写法）：函数改一个参数，输出就变，断的是
 * 生成出来的东西。
 *
 * 全部跑在临时主目录上，真实 `~/.dsc` 一个字节都不动。
 *
 * ## 为什么插件是动态 import 的
 *
 * `apply()` 里的 `readConfig()` 走 `resolvePluginConfig`，而它读的 `plugins.json` 路径
 * 来自 `path-policy` 的模块顶层常量 `DSC_HOME`。静态 import 会在模块体执行前就把这个
 * 常量定死成**真实主目录**——于是插件的配置会读到开发者自己那份
 * （实测本机 `computer-use.lookWithoutApproval = true`），「免审批关时含只读动作」这类
 * 断言就跟着环境飘。所以 `tempHome()` 要跑在 `index.js` 被加载之前，那个模块只能动态 import。
 *
 * @module @pneuma/computer-use/tests/desktop-control.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'
import {
  appendComputerAudit,
  auditLine,
  canonicalAction,
  clickScript,
  computerAuditPath,
  diffFrames,
  dragScript,
  elementActionScript,
  frameForWindow,
  gradeDesktopAction,
  keyScript,
  killAllPowerShell,
  listAppsScript,
  listWindowsScript,
  observeScript,
  pasteScript,
  parseFrame,
  probeWindowScript,
  resetFrames,
  resolveScreenPoint,
  resolveTarget,
  runPowerShell,
  screenshotScript,
  scrollScript,
  screensScript,
  settleObserve,
  toSendKeys,
  typeScript,
} from '../desktop-control.js'

/**
 * 假 PowerShell 子进程句柄。
 *
 * `runPowerShell` 只用到 stdout/stderr 的 `data`、child 的 `close`/`error` 与 `kill`；
 * 这里按这四个事件造一个可手动触发的桩，测试自己决定什么时候吐数据、什么时候退出。
 * 用 `vi.hoisted` 是因为 `vi.mock` 的工厂会在 import 之前执行，普通顶层变量还拿不到。
 */
const childProcessMock = vi.hoisted(() => {
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

  const created: FakeChild[] = []
  const spawn = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
    const listeners = new Map<string, Listener[]>()
    const listen = (key: string, fn: Listener): void => {
      const list = listeners.get(key) ?? []
      list.push(fn)
      listeners.set(key, list)
    }
    const fire = (key: string, ...args: unknown[]): void => {
      for (const fn of listeners.get(key) ?? []) fn(...args)
    }
    const child: FakeChild = {
      stdout: { on: (event, fn) => listen(`stdout:${event}`, fn) },
      stderr: { on: (event, fn) => listen(`stderr:${event}`, fn) },
      on: (event, fn) => {
        listen(event, fn)
        return child
      },
      kill: vi.fn(() => {
        child.killed = true
        return true
      }),
      killed: false,
      emit: (event, ...args) => fire(event, ...args),
      emitStdout: (chunk) => fire('stdout:data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      emitStderr: (chunk) => fire('stderr:data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    }
    created.push(child)
    return child
  })

  return { spawn, created }
})

// 整个文件替换掉 spawn：`runPowerShell` 在 import 时解构了这个绑定。
vi.mock('node:child_process', () => ({ spawn: childProcessMock.spawn }))

/** 临时主目录：插件读配置与审计落盘都只往这里写（`tempHome` 一个文件只能调一次）。 */
const home = tempHome('dsc-computer-use-')
/** 本包的插件入口（动态 import：见文件头的理由）。 */
let idx: typeof import('../index.js')

beforeAll(async () => {
  idx = await import('../index.js')
  // 先确认隔离真的生效，否则下面「免审批关」那一组会读到使用者自己的配置。
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME.startsWith(home.home)).toBe(true)
})

afterAll(() => {
  home.restore()
})

/** JSON Schema 里测试要用到的字段。 */
interface Schema {
  type?: string
  enum?: string[]
  properties?: Record<string, Schema>
  required?: string[]
}

/** 桩 ctx 捕获到的工具条目（只声明断言用到的字段）。 */
interface CapturedTool {
  name: string
  risk: string
  waitsForHuman?: boolean
  parameters: Schema
}

/** 桩 ctx 捕获到的设置分区 / 守卫。 */
interface CapturedSection {
  id: string
}
interface CapturedGuard {
  id: string
  order?: number
}

/** 挂一次插件：`withLook` = 打开 `lookWithoutApproval`。 */
function mount(withLook: boolean): {
  tools: CapturedTool[]
  sections: CapturedSection[]
  guards: CapturedGuard[]
} {
  const tools: CapturedTool[] = []
  const sections: CapturedSection[] = []
  const guards: CapturedGuard[] = []
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        tools.push(entry)
        return () => {}
      },
    },
    guards: {
      register: (guard: CapturedGuard) => {
        guards.push(guard)
        return () => {}
      },
    },
    prompt: { register: () => () => {}, registerProjection: () => () => {} },
    settings: {
      registerSection: (section: CapturedSection) => {
        sections.push(section)
        return () => {}
      },
      about: () => ({ version: '0', apiVersion: 0, home: home.home, skillsDir: '', pluginsDir: '' }),
    },
    // 2026-11-04：插件的注册改成 ctx.effect 了（停用即注销）。桩 ctx 跟着 cordis。
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  // 桩 ctx 只实现 apply 用到的面；真实 Context 的字段远多于它。
  idx.computerUsePlugin.apply(ctx as unknown as Context, withLook ? { lookWithoutApproval: true } : {})
  return { tools, sections, guards }
}

/** 按名字取注册出来的工具（找不到时报出实际注册了哪些）。 */
function toolNamed(list: CapturedTool[], name: string): CapturedTool {
  const found = list.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`没有注册 ${name}，只有 ${list.map((tool) => tool.name).join('、')}`)
  return found
}

/** `resolveTarget` 的 target 形参类型（不从模块里导出，这里按签名取）。 */
type Target = Parameters<typeof resolveTarget>[0]
/** 把一段普通对象当 target 传（判别联合在这里没必要逐个窄化）。 */
const asTarget = (value: unknown): Target => value as Target

/** 一次观察结果的帧（脚本里那份 JSON 的形状）。 */
function frameOf(payload: unknown): ReturnType<typeof parseFrame> {
  return parseFrame(JSON.stringify(payload))
}

describe('① 工具名与 schema 形状', () => {
  test('注册了急停守卫，且排在审批（30）之前', () => {
    const plain = mount(false)
    const stop = plain.guards.find((guard) => guard.id === 'computer-use-stop')
    expect(stop, `实际守卫：${plain.guards.map((guard) => `${guard.id}@${String(guard.order)}`).join('、')}`).toBeDefined()
    expect(stop?.order).toBeLessThan(30)
  })

  test('注册了动手工具 computer，风险等级是 exec（每次过审批）', () => {
    const act = toolNamed(mount(false).tools, 'computer')
    expect(act.risk).toBe('exec')
  })

  test('computer 的 action 枚举含新增动作', () => {
    const act = toolNamed(mount(false).tools, 'computer')
    const actions = act.parameters.properties?.['action']?.enum ?? []
    for (const action of [
      'click',
      'drag',
      'get_app_state',
      'list_windows',
      'list_apps',
      'screens',
      'paste',
      'set_value',
      'select_text',
      'perform_action',
      'stop',
    ]) {
      expect(actions).toContain(action)
    }
  })

  test('免审批关时 computer 含只读观察动作', () => {
    const actions = toolNamed(mount(false).tools, 'computer').parameters.properties?.['action']?.enum ?? []
    expect(actions).toContain('screenshot')
    expect(actions).toContain('get_app_state')
  })

  test('computer 参数 required 只有 action', () => {
    expect(toolNamed(mount(false).tools, 'computer').parameters.required).toStrictEqual(['action'])
  })

  test("target 判别字段 type 的枚举是 ['coordinate','element']", () => {
    const target = toolNamed(mount(false).tools, 'computer').parameters.properties?.['target']
    expect(target?.properties?.['type']?.enum).toStrictEqual(['coordinate', 'element'])
  })

  test('target 必填只有 type（其余二选一）', () => {
    const target = toolNamed(mount(false).tools, 'computer').parameters.properties?.['target']
    expect(target?.required).toStrictEqual(['type'])
  })

  test('target 的 index 是 integer，x/y 也是 integer', () => {
    const target = toolNamed(mount(false).tools, 'computer').parameters.properties?.['target']
    expect(target?.properties?.['index']?.type).toBe('integer')
    expect(target?.properties?.['x']?.type).toBe('integer')
    expect(target?.properties?.['y']?.type).toBe('integer')
  })

  test('drag 的 from/to 也是 target 形状', () => {
    const props = idx.argProps() as Record<string, Schema>
    expect(props['from']?.properties?.['type']?.enum?.join(',')).toBe('coordinate,element')
    expect(props['to']?.properties?.['type']?.enum?.join(',')).toBe('coordinate,element')
  })

  test('clip 参数声明了 x/y/width/height 四个必填', () => {
    const props = idx.argProps() as Record<string, Schema>
    expect(props['clip']?.required).toStrictEqual(['x', 'y', 'width', 'height'])
  })

  test('免审批开时另注册 computer_look（read 档）', () => {
    const look = mount(true)
    const lookTool = toolNamed(look.tools, 'computer_look')
    expect(lookTool.risk).toBe('read')
  })

  test('computer_look 覆盖全部只读观察动作', () => {
    const lookTool = toolNamed(mount(true).tools, 'computer_look')
    const actions = lookTool.parameters.properties?.['action']?.enum ?? []
    for (const action of idx.LOOK_ACTIONS) expect(actions).toContain(action)
  })

  test('免审批开时动手工具不再留只读观察动作，get_app_state 归 computer_look', () => {
    const look = mount(true)
    const actActions = toolNamed(look.tools, 'computer').parameters.properties?.['action']?.enum ?? []
    const lookActions = toolNamed(look.tools, 'computer_look').parameters.properties?.['action']?.enum ?? []
    expect(actActions).not.toContain('screenshot')
    expect(actActions).not.toContain('get_app_state')
    expect(lookActions).toContain('get_app_state')
  })

  test('两个参数表都带 target 判别（computer / look 一致）', () => {
    const act = idx.computerToolParameters(['click'], true) as Schema
    const look = idx.computerLookParameters(['screenshot']) as Schema
    expect(act.properties?.['target']?.properties?.['type']?.enum).toContain('element')
    expect(look.properties?.['target']?.properties?.['type']?.enum).toContain('element')
  })
})

describe('② 目标解析纯函数（fail-closed）', () => {
  /** 一次三元素的观察结果（#0 窗口、#1 文本框、#2 保存按钮）。 */
  const frame = (() => {
    resetFrames()
    return frameOf({
      ok: true,
      app: 'notepad',
      window: { id: 42, title: '无标题 - 记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      elements: [
        { index: 0, controlType: 'Window', title: '无标题 - 记事本', automaid: '', value: '', bounds: { x: 0, y: 0, width: 800, height: 600 }, patterns: [], enabled: true, offscreen: false },
        { index: 1, controlType: 'Edit', title: '文本编辑器', automaid: '15', value: 'hi', bounds: { x: 10, y: 60, width: 760, height: 480 }, patterns: ['Text', 'Value'], enabled: true, offscreen: false },
        { index: 2, controlType: 'Button', title: '保存', automaid: 'save', value: '', bounds: { x: 100, y: 200, width: 40, height: 20 }, patterns: ['Invoke'], enabled: true, offscreen: false },
      ],
      text: '[0] Window "无标题 - 记事本"',
    })
  })()
  /** 这一组共用的屏幕边界。 */
  const bounds = { left: 0, top: 0, width: 1920, height: 1080 }

  test('parseFrame 产出 state_id = st-1、读出元素数与窗口进程名', () => {
    expect(frame.state_id).toBe('st-1')
    expect(frame.elements).toHaveLength(3)
    expect(frame.app).toBe('notepad')
  })

  test('element #2 解析到控件中心，并带出控件标签', () => {
    const hit = resolveTarget(asTarget({ type: 'element', index: 2 }), undefined, frame, bounds, 1)
    expect(hit.x).toBe(120)
    expect(hit.y).toBe(210)
    expect(hit.label).toMatch(/元素 #2/)
  })

  test('element 越界（#99）→ ELEMENT_UNAVAILABLE', () => {
    expect(() => resolveTarget(asTarget({ type: 'element', index: 99 }), undefined, frame, bounds, 1)).toThrow(
      /ELEMENT_UNAVAILABLE/,
    )
  })

  test('element 索引为负 → 报错', () => {
    expect(() => resolveTarget(asTarget({ type: 'element', index: -1 }), undefined, frame, bounds, 1)).toThrow(
      /ELEMENT_UNAVAILABLE/,
    )
  })

  test('element 但没有观察结果 → fail-closed', () => {
    expect(() => resolveTarget(asTarget({ type: 'element', index: 0 }), undefined, undefined, bounds, 1)).toThrow(/观察结果/)
  })

  test('element 带了过期 state_id → ELEMENT_UNAVAILABLE（索引已失效）', () => {
    expect(() =>
      resolveTarget(asTarget({ type: 'element', index: 0, state_id: 'st-99' }), undefined, frame, bounds, 1),
    ).toThrow(/ELEMENT_UNAVAILABLE/)
  })

  test('coordinate 按缩放系数换算（200/2=100，100/2=50）', () => {
    const point = resolveTarget(asTarget({ type: 'coordinate', x: 200, y: 100 }), undefined, frame, bounds, 2)
    expect(point.x).toBe(100)
    expect(point.y).toBe(50)
  })

  test('coordinate 越界（图外）→ 报错', () => {
    expect(() => resolveTarget(asTarget({ type: 'coordinate', x: 99999, y: 5 }), undefined, frame, bounds, 1)).toThrow(
      /在屏幕外/,
    )
  })

  test('coordinate 非整数 → 报错', () => {
    expect(() => resolveTarget(asTarget({ type: 'coordinate', x: 1.5, y: 5 }), undefined, frame, bounds, 1)).toThrow(
      /整数/,
    )
  })

  test('没有 target → 报错', () => {
    expect(() => resolveTarget(undefined, undefined, frame, bounds, 1)).toThrow(/要带 target/)
  })

  test('绑定窗口后坐标按窗口左上角偏移（500+30, 300+40）', () => {
    const point = resolveTarget(asTarget({ type: 'coordinate', x: 30, y: 40 }), undefined, frame, bounds, 1, {
      x: 500,
      y: 300,
      width: 800,
      height: 600,
    })
    expect(point.x).toBe(530)
    expect(point.y).toBe(340)
  })

  test('差分按索引对齐：识别出变化的 [1] 与新增的 [3]', () => {
    const next = frameOf({
      ok: true,
      app: 'notepad',
      window: { id: 42, title: '无标题 - 记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      elements: [
        frame.elements[0],
        { index: 1, controlType: 'Edit', title: '文本编辑器', automaid: '15', value: 'hello world', bounds: { x: 10, y: 60, width: 760, height: 480 }, patterns: ['Text', 'Value'], enabled: true, offscreen: false },
        frame.elements[2],
        { index: 3, controlType: 'Button', title: '取消', automaid: 'cancel', value: '', bounds: { x: 150, y: 200, width: 40, height: 20 }, patterns: ['Invoke'], enabled: true, offscreen: false },
      ],
      text: '...',
    })
    const diff = diffFrames(frame, next)
    expect(diff.changed).toStrictEqual([1])
    expect(diff.added).toStrictEqual([3])
  })
})

describe('③ 脚本生成（PowerShell 文本断言）', () => {
  test('UIA 枚举脚本：加载 UIAutomationClient、探测模式、递归遍历、注入句柄、输出 JSON、带失败分支与元素上限', () => {
    const obs = observeScript({ windowId: 12_345, maxElements: 50 })
    expect(obs).toContain('UIAutomationClient')
    expect(obs).toContain('TryGetCurrentPattern')
    expect(obs).toContain('function Walk')
    expect(obs).toMatch(/Resolve-Win 12345/)
    expect(obs).toContain('ConvertTo-Json')
    expect(obs).toContain('ok=$false')
    // 元素上限与截断说明：控件树很大时不能把整棵树倒进模型。
    expect(obs).toContain("'…（控件数超过 '")
    expect(obs).toContain('$max = 50')
  })

  test('set_value 脚本用 ValuePattern.SetValue 并转义单引号', () => {
    const script = elementActionScript('set_value', { windowId: 7, index: 2, value: "he'llo" })
    expect(script).toContain('SetValue(')
    expect(script).toContain("he''llo")
  })

  test('set_value 落不到时返回 none（供回退）', () => {
    const script = elementActionScript('set_value', { windowId: 7, index: 2, value: 'x' })
    expect(script).toContain("'value'")
    expect(script).toContain("'none'")
  })

  test('perform_action=toggle 用 TogglePattern', () => {
    const script = elementActionScript('perform_action', { windowId: 7, index: 1, pattern: 'toggle' })
    expect(script).toContain('TogglePattern')
    expect(script).toContain("'toggle'")
  })

  test('select_text 优先 TextPattern，回退 SelectionItemPattern', () => {
    const script = elementActionScript('select_text', { windowId: 7, index: 1 })
    expect(script).toContain('TextPattern')
    expect(script).toContain('SelectionItemPattern')
    expect(script).toContain('selecttext')
  })

  test('元素动作找不到索引时报错（fail-closed）', () => {
    const script = elementActionScript('perform_action', { windowId: 7, index: 1, pattern: 'toggle' })
    expect(script).toContain('已经不在了')
  })

  test('拖拽：按下左键、分步插值、try 里移动、finally 抬起', () => {
    const drag = dragScript({ x: 10, y: 10 }, { x: 100, y: 50 }, 20, 5)
    expect(drag).toMatch(/mouse_event\(2,0,0,0/)
    expect(drag).toMatch(/for \(\$i = 1; \$i -le 20/)
    expect(drag).toMatch(/try \{[\s\S]*for \(\$i = 1/)
    expect(drag).toMatch(/finally \{[\s\S]*mouse_event\(4,0,0,0/)
  })

  test('点击：SetCursorPos 到目标点、按下再抬起、双击 = 两次', () => {
    const click = clickScript({ x: 5, y: 6 }, 'left', false, '', 0)
    expect(click).toContain('SetCursorPos(5, 6)')
    expect(click).toMatch(/mouse_event\(2,0,0,0[\s\S]*mouse_event\(4,0,0,0/)
    expect(clickScript({ x: 1, y: 1 }, 'left', true, '', 0).match(/mouse_event\(2,0,0,0/g) ?? []).toHaveLength(2)
  })

  test('滚轮：向上用正 delta（4294967176）、向下用负 delta（120）、循环次数 = |amount|', () => {
    expect(scrollScript(3, '', 0)).toContain('4294967176')
    expect(scrollScript(-3, '', 0)).toContain(' 120,')
    expect(scrollScript(3, '', 0)).toContain('$i -lt 3')
  })

  test('粘贴：先读旧剪贴板、写入给定文本、Ctrl+V、事后还原', () => {
    const paste = pasteScript('机密内容')
    expect(paste).toContain('Get-Clipboard -TextFormatType Text')
    expect(paste).toContain("Set-Clipboard -Value '机密内容'")
    expect(paste).toContain("SendWait('^v')")
    expect(paste).toMatch(/if \(\$null -ne \$old\) \{ Set-Clipboard -Value \$old \}/)
  })

  test('不带 text 的粘贴不动剪贴板（不写也不还原）', () => {
    expect(pasteScript(undefined)).not.toContain('Set-Clipboard -Value')
  })

  test('type 脚本同样还原剪贴板；key 脚本支持 repeat', () => {
    expect(typeScript('x')).toMatch(/Set-Clipboard -Value \$old/)
    expect(keyScript('{TAB}', 3, 0)).toMatch(/for \(\$i = 0; \$i -lt 3/)
  })

  test('list_windows / list_apps / screens 脚本各自带关键字段', () => {
    expect(listWindowsScript()).toContain('window_id')
    expect(listWindowsScript()).toContain('focused')
    expect(listWindowsScript()).toContain('onscreen')
    expect(listAppsScript()).toContain('foreground')
    expect(screensScript()).toContain('AllScreens')
  })

  test('截图：裁切时 CopyFromScreen 用裁切矩形并输出裁切原点；全屏时原点为 0', () => {
    const shot = screenshotScript(1_568, 'jpeg', 80, { x: 10, y: 20, width: 400, height: 300 })
    expect(shot).toContain('CopyFromScreen($srcRect.Left, $srcRect.Top')
    expect(shot).toContain('$ox = 10; $oy = 20')
    expect(screenshotScript(1_568, 'jpeg', 80)).toContain('$ox = 0; $oy = 0')
  })
})

describe('④ 危险分级与审计', () => {
  test('只读观察全部归 read 档，动手归 input，急停归 system', () => {
    for (const action of idx.LOOK_ACTIONS) expect(gradeDesktopAction(action)).toBe('read')
    expect(gradeDesktopAction('screenshot')).toBe('read')
    expect(gradeDesktopAction('click')).toBe('input')
    expect(gradeDesktopAction('type')).toBe('input')
    expect(gradeDesktopAction('stop')).toBe('system')
  })

  test('目标是任务管理器 / 文本命中 regedit → system', () => {
    expect(gradeDesktopAction('click', { window: '任务管理器' })).toBe('system')
    expect(gradeDesktopAction('type', { text: 'regedit' })).toBe('system')
  })

  test('旧名 window_list 归一成 list_windows，认不出的回 null', () => {
    expect(canonicalAction('window_list')).toBe('list_windows')
    expect(canonicalAction('nope')).toBeNull()
  })

  test('审计路径来自 home（~/.dsc/audit/computer-use.jsonl）', () => {
    expect(computerAuditPath(home.home)).toBe(join(home.home, 'audit', 'computer-use.jsonl'))
  })

  test('审计行以换行结尾、字段齐全', () => {
    const record = {
      ts: 1_700_000_000_000,
      action: 'click',
      risk: 'input',
      target: 'element#2',
      result: 'ok',
      approved: true,
    } as Parameters<typeof auditLine>[0]
    const line = auditLine(record)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
    expect(JSON.parse(line.trim())).toStrictEqual(record)
  })

  test('审计落盘两行且可逐行解析；只读观察那行 approved=false', () => {
    const record = {
      ts: 1_700_000_000_000,
      action: 'click',
      risk: 'input',
      target: 'element#2',
      result: 'ok',
      approved: true,
    } as Parameters<typeof auditLine>[0]
    appendComputerAudit(home.home, record)
    appendComputerAudit(home.home, {
      ...record,
      action: 'screenshot',
      risk: 'read',
      approved: false,
      target: '整个桌面',
    } as Parameters<typeof auditLine>[0])
    const written = readFileSync(join(home.home, 'audit', 'computer-use.jsonl'), 'utf8').trim().split('\n')
    expect(written).toHaveLength(2)
    const parsed = written.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(parsed[0]?.['ts']).toBe(record.ts)
    expect(parsed[1]?.['approved']).toBe(false)
    expect(parsed[1]?.['risk']).toBe('read')
  })

  test('killAllPowerShell 是函数（急停入口）', () => {
    expect(typeof killAllPowerShell).toBe('function')
  })
})

describe('⑤ 观察 settle / 超时（注入假时钟）', () => {
  test('连续两帧相同 → stable=true，且只观察 2 次（不轮询）', async () => {
    const clock = fakeWorld(['a', 'a'])
    const result = await settleObserve(clock.snapshot, (value) => value, {
      intervalMs: 10,
      timeoutMs: 500,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.stable).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.waitedMs).toBe(10)
  })

  test('变化后再稳定 → stable=true（3 次）', async () => {
    const clock = fakeWorld(['a', 'b', 'b'])
    const result = await settleObserve(clock.snapshot, (value) => value, {
      intervalMs: 10,
      timeoutMs: 500,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.stable).toBe(true)
    expect(result.attempts).toBe(3)
  })

  test('一直变化 → 到超时上限后 stable=false（不无限等），并带上观察次数', async () => {
    let tick = 0
    const world = {
      now: () => tick * 10,
      sleep: async (ms: number) => {
        // 假时钟：睡多久就把刻度推多远（这里只关心次数有界）。
        tick += Math.max(1, Math.round(ms / 10))
      },
      snapshot: async () => `帧-${String(tick)}`,
    }
    const result = await settleObserve(world.snapshot, (value) => value, {
      intervalMs: 10,
      timeoutMs: 30,
      sleep: world.sleep,
      now: world.now,
    })
    expect(result.stable).toBe(false)
    expect(result.attempts).toBeGreaterThan(1)
  })
})

/** 造一个受控时钟 + 快照序列（顺序取到最后一个就一直重复）。 */
function fakeWorld(sequence: string[]): {
  now: () => number
  sleep: (ms: number) => Promise<void>
  snapshot: () => Promise<string>
} {
  let clock = 0
  let calls = 0
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    snapshot: async () => {
      const value = sequence[Math.min(calls, sequence.length - 1)] ?? ''
      calls += 1
      return value
    },
  }
}

// ── 以下为覆盖率补充：按键翻译 / 脚本转义 / runPowerShell 生命周期 / 坐标与帧缓存 ──

beforeEach(() => {
  childProcessMock.created.length = 0
  childProcessMock.spawn.mockClear()
})

afterEach(() => {
  // 把还挂着的子进程收尾：触发 close 让 runPowerShell 清掉计时器与 abort 监听。
  for (const child of childProcessMock.created) child.emit('close', 0)
  killAllPowerShell()
  vi.useRealTimers()
})

/** 取最近一次 spawn 出来的假子进程（没有就报错，避免断言静默落空）。 */
function lastChild(): (typeof childProcessMock.created)[number] {
  const child = childProcessMock.created.at(-1)
  if (child === undefined) throw new Error('runPowerShell 没有 spawn 出子进程')
  return child
}

describe('⑥ toSendKeys 键名翻译与拒绝', () => {
  test('修饰键组合、键名映射与大小写归一', () => {
    expect(toSendKeys('CTRL+SHIFT+S')).toBe('^+s')
    expect(toSendKeys('ctrl+alt+delete')).toBe('^%{DELETE}')
    expect(toSendKeys(' Enter ')).toBe('{ENTER}')
    expect(toSendKeys('esc')).toBe('{ESC}')
    expect(toSendKeys('pageup')).toBe('{PGUP}')
    expect(toSendKeys('f12')).toBe('{F12}')
    expect(toSendKeys('space')).toBe(' ')
    expect(toSendKeys('a')).toBe('a')
  })

  test('多键串联：修饰符在前、可执行键按顺序拼接', () => {
    expect(toSendKeys('ctrl+a+b')).toBe('^ab')
    expect(toSendKeys('shift+tab')).toBe('+{TAB}')
  })

  test('Win/Cmd 类按键一律拒绝（会把桌面切走）', () => {
    for (const key of ['win', 'cmd', 'super', 'meta', 'ctrl+win+e']) {
      expect(() => toSendKeys(key)).toThrow(/不允许按 Win 键/)
    }
  })

  test('不认识的键名 / 只有修饰符 / 空串都报错，而不是把原文喂给 SendKeys', () => {
    expect(() => toSendKeys('hyper')).toThrow(/不认识的按键「hyper」/)
    expect(() => toSendKeys('ctrl+shift')).toThrow(/没有可执行的键/)
    expect(() => toSendKeys('')).toThrow(/没有可执行的键/)
    expect(() => toSendKeys('++')).toThrow(/没有可执行的键/)
  })
})

describe('⑦ 脚本生成的转义与边界参数', () => {
  test('observeScript：窗口标题里的单引号加倍、中文保留、负数句柄归零、maxElements 下限 10', () => {
    const script = observeScript({ windowId: -5, windowText: "记事本' 标题", maxElements: 3 })
    expect(script).toContain("$win = Resolve-Win 0 '记事本'' 标题'")
    expect(script).toContain('$max = 10')
    // 元素超限时明确写进文本，模型不会以为看到的是全树。
    expect(script).toContain('$script:idx -ge $max')
  })

  test('observeScript：maxElements 四舍五入、缺省用 OBSERVE_MAX_ELEMENTS', () => {
    expect(observeScript({ windowId: 12.6, maxElements: 50.6 })).toContain('$max = 51')
    expect(observeScript({ windowId: 1 })).toContain('$max = 400')
    expect(observeScript({ windowId: 12.6 })).toContain('Resolve-Win 13')
  })

  test('set_value：值里的单引号双写、换行与中文原样保留（PowerShell 单引号串可跨行）', () => {
    const value = "第一行\na'b"
    const script = elementActionScript('set_value', { windowId: 7, index: 2, value })
    expect(script).toContain("SetValue('第一行\na''b')")
  })

  test('elementActionScript：index 负数归零、小数四舍五入、窗口标题转义', () => {
    expect(elementActionScript('set_value', { windowId: 7, index: -3, value: 'x' })).toContain('$target = 0')
    expect(elementActionScript('set_value', { windowId: 7, index: 3.6, value: 'x' })).toContain('$target = 4')
    expect(
      elementActionScript('set_value', { windowId: 0, windowText: "it's", index: 0, value: 'x' }),
    ).toContain("Resolve-Win 0 'it''s'")
  })

  test('perform_action：认不出的 pattern 生成显式 throw（带可认列表），不静默变 invoke', () => {
    const script = elementActionScript('perform_action', { windowId: 7, index: 1, pattern: 'Destroy' })
    expect(script).toContain("throw '不认识的 action「destroy」")
    expect(script).toContain('scrollintoview')
    // 默认 pattern 才是 invoke。
    expect(elementActionScript('perform_action', { windowId: 7, index: 1 })).toContain('InvokePattern')
  })

  test('dragScript：步数下限 2、延迟取整且不为负、坐标四舍五入', () => {
    const script = dragScript({ x: 10.6, y: 20.4 }, { x: 100.6, y: 50.4 }, 0, -5)
    expect(script).toContain('[DscMouse]::SetCursorPos(11, 20)')
    expect(script).toContain('$i -le 2')
    expect(script).toContain('(101 - 11)')
    expect(script).toContain('(50 - 20)')
    expect(script).toContain('Start-Sleep -Milliseconds 0')
  })

  test('clickScript：右键映射 8/16、未知键回落左键、双击两次、暂停只在 >0 时出现', () => {
    const right = clickScript({ x: 5, y: 6 }, 'right', true, '', 0)
    expect(right.match(/mouse_event\(8,0,0,0/g) ?? []).toHaveLength(2)
    expect(right.match(/mouse_event\(16,0,0,0/g) ?? []).toHaveLength(2)
    expect(right).not.toContain('Start-Sleep -Milliseconds 0')

    const fallback = clickScript({ x: 5, y: 6 }, 'scroll-wheel', false, '', 100)
    expect(fallback).toContain('mouse_event(2,0,0,0')
    expect(fallback).toContain('mouse_event(4,0,0,0')
    expect(fallback).toContain('Start-Sleep -Milliseconds 100')
    expect(fallback).toContain('SetCursorPos(5, 6)')
  })

  test('clickScript：坐标四舍五入（含负数），激活片段原样插在移动之前', () => {
    const script = clickScript({ x: 5.6, y: -3.4 }, 'left', false, '[DscWin]::SetForegroundWindow([IntPtr]9) | Out-Null', 0)
    expect(script).toContain('SetCursorPos(6, -3)')
    expect(script.indexOf('SetForegroundWindow')).toBeLessThan(script.indexOf('SetCursorPos(6, -3)'))
  })

  test('scrollScript：0 档不滚、负数向下用 120、正数向上用 4294967176、move 片段保留', () => {
    const zero = scrollScript(0, '', 0)
    expect(zero).toContain('$i -lt 0')
    expect(zero).toContain(' 120,')

    const down = scrollScript(-2, '[DscMouse]::SetCursorPos(1, 2) | Out-Null', 50)
    expect(down).toContain('$i -lt 2')
    expect(down).toContain(' 120,')
    expect(down).toContain('[DscMouse]::SetCursorPos(1, 2) | Out-Null')

    expect(scrollScript(3, '', 0)).toContain(' 4294967176,')
    expect(scrollScript(3, '', 0)).toContain('$i -lt 3')
  })

  test('keyScript：repeat 下限 1、hold 毫秒取整且非正数不等待、keys 单引号加倍', () => {
    const once = keyScript('^s', 0, 0)
    expect(once).toContain('$i -lt 1')
    expect(once).not.toContain('Start-Sleep')

    const held = keyScript("a'b", 7.6, 0.35)
    expect(held).toContain("SendWait('a''b')")
    expect(held).toContain('$i -lt 8')
    expect(held).toContain('Start-Sleep -Milliseconds 350')

    expect(keyScript('x', 3, -1)).not.toContain('Start-Sleep')
  })

  test('type/paste：先写剪贴板再 Ctrl+V，最后还原旧文本；单引号双写、换行保留', () => {
    const text = "第一行\nit's"
    const typed = typeScript(text)
    expect(typed).toContain("Set-Clipboard -Value '第一行\nit''s'")
    expect(typed.indexOf('Set-Clipboard -Value')).toBeLessThan(typed.indexOf("SendWait('^v')"))
    expect(typed.lastIndexOf('Set-Clipboard -Value $old')).toBeGreaterThan(typed.indexOf("SendWait('^v')"))

    const pasted = pasteScript(text)
    expect(pasted).toContain("Set-Clipboard -Value '第一行\nit''s'")
    expect(pasted).toContain('if ($null -ne $old) { Set-Clipboard -Value $old }')
  })

  test('list_windows / list_apps / screens 脚本带关键 Win32 调用（不是只有字段名）', () => {
    const windows = listWindowsScript()
    expect(windows).toContain('GetForegroundWindow()')
    expect(windows).toContain('GetWindowThreadProcessId')
    expect(windows).toContain('IsOffscreen')

    const apps = listAppsScript()
    expect(apps).toContain('MainWindowHandle -ne 0')
    expect(apps).toContain('Sort-Object ProcessName -Unique')
    expect(apps).toContain('GetForegroundWindow()')

    const screens = screensScript()
    expect(screens).toContain('[System.Windows.Forms.Screen]::AllScreens')
    expect(screens).toContain('$s.DeviceName')
    expect(screens).toContain('$s.Primary')
    expect(screens).toContain('[int]$s.Bounds.X')
  })

  test('probeWindowScript：数字/纯数字串走句柄，其他走标题；负数归零、标题单引号转义', () => {
    const handle = probeWindowScript(12.6)
    expect(handle).toContain('$winId = 13')
    expect(handle).toContain("$winText = ''")

    expect(probeWindowScript(' 42 ')).toContain('$winId = 42')
    expect(probeWindowScript(' 42 ')).toContain("$winText = ''")

    const byTitle = probeWindowScript('记事本')
    expect(byTitle).toContain('$winId = 0')
    expect(byTitle).toContain("$winText = '记事本'")
    expect(probeWindowScript("it's")).toContain("$winText = 'it''s'")

    const negative = probeWindowScript(-7)
    expect(negative).toContain('$winId = 0')
    expect(negative).toContain("$winText = ''")
  })
})

describe('⑧ runPowerShell 生命周期（假 spawn）', () => {
  test('成功：按固定参数启动 powershell.exe，stdout 分块累加后 resolve', async () => {
    const pending = runPowerShell('echo hi')
    const promise = pending.then((value) => ({ value }), (error: unknown) => ({ error }))

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'echo hi'],
      { windowsHide: true },
    )

    const child = lastChild()
    child.emitStdout('he')
    child.emitStdout(Buffer.from('llo'))
    child.emit('close', 0)

    const settled = await promise
    expect(settled).toEqual({ value: 'hello' })
  })

  test('非零退出：优先把 stderr 原文抛给调用方', async () => {
    const pending = runPowerShell('bad')
    const promise = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
    const child = lastChild()
    child.emitStderr('坏掉了\n')
    child.emit('close', 1)

    const settled = await promise
    expect(settled).toHaveProperty('error')
    expect((settled as { error: Error }).error.message).toBe('坏掉了')
  })

  test('非零退出且 stderr 为空：报出退出码，不留空错误', async () => {
    const promise = runPowerShell('bad')
    lastChild().emit('close', 3)
    await expect(promise).rejects.toThrow('powershell 退出码 3')
  })

  test('超时：按 timeoutMs 杀掉子进程并拒绝（假时钟）', async () => {
    vi.useFakeTimers()
    const pending = runPowerShell('slow', 5_000)
    const promise = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
    const child = lastChild()

    await vi.advanceTimersByTimeAsync(5_000)
    const settled = await promise
    expect((settled as { error: Error }).error.message).toBe('桌面操作超时（5 秒）')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  test('abort：立刻杀进程并拒绝；close 之后才 abort 则不再杀（监听已移除）', async () => {
    const controller = new AbortController()
    const pending = runPowerShell('click', 20_000, controller.signal)
    const promise = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
    const child = lastChild()

    controller.abort()
    const aborted = await promise
    expect((aborted as { error: Error }).error.message).toBe('桌面操作被取消')
    expect(child.kill).toHaveBeenCalledTimes(1)

    const finished = runPowerShell('done', 20_000, controller.signal)
    const finishedPromise = finished.then((value) => ({ value }), (error: unknown) => ({ error }))
    const doneChild = lastChild()
    doneChild.emit('close', 0)
    await expect(finishedPromise).resolves.toEqual({ value: '' })
    controller.abort()
    expect(doneChild.kill).not.toHaveBeenCalled()
  })

  test('spawn 失败（error 事件）→ 原样拒绝，并从急停集合移除', async () => {
    const promise = runPowerShell('x')
    lastChild().emit('error', new Error('spawn ENOENT'))
    await expect(promise).rejects.toThrow('spawn ENOENT')
    expect(killAllPowerShell()).toBe(0)
  })

  test('killAllPowerShell：杀掉所有在跑的子进程并返回数量，集合清空后为 0', async () => {
    const first = runPowerShell('a')
    const second = runPowerShell('b')
    const settle = Promise.all([first, second].map((p) => p.then((value) => value, () => '')))

    expect(childProcessMock.created).toHaveLength(2)
    expect(killAllPowerShell()).toBe(2)
    expect(childProcessMock.created[0]!.kill).toHaveBeenCalledTimes(1)
    expect(childProcessMock.created[1]!.kill).toHaveBeenCalledTimes(1)
    expect(killAllPowerShell()).toBe(0)

    for (const child of childProcessMock.created) child.emit('close', 0)
    await settle
  })
})

describe('⑨ resolveScreenPoint / 目标解析补充边界', () => {
  const bounds = { left: 0, top: 0, width: 1920, height: 1080 }

  test('按缩放系数换算并四舍五入', () => {
    expect(resolveScreenPoint({ x: 200, y: 101 }, bounds, 2)).toEqual({ x: 100, y: 51 })
    expect(resolveScreenPoint({ x: 10, y: 10 }, bounds, 1.5)).toEqual({ x: 7, y: 7 })
  })

  test('缺坐标 / 小数坐标 / 屏幕外（含负坐标虚拟屏边界）都报错', () => {
    expect(() => resolveScreenPoint({ x: 1 }, bounds, 1)).toThrow(/要带 x 与 y/)
    expect(() => resolveScreenPoint({ x: 1.5, y: 2 }, bounds, 1)).toThrow(/必须是整数/)
    expect(() => resolveScreenPoint({ x: 1920, y: 5 }, bounds, 1)).toThrow(/在屏幕外/)

    const virtual = { left: -100, top: -50, width: 200, height: 100 }
    expect(resolveScreenPoint({ x: -100, y: -50 }, virtual, 1)).toEqual({ x: -100, y: -50 })
    expect(() => resolveScreenPoint({ x: -101, y: 0 }, virtual, 1)).toThrow(/在屏幕外/)
    expect(() => resolveScreenPoint({ x: 100, y: 0 }, virtual, 1)).toThrow(/在屏幕外/)
  })

  test('resolveTarget 兼容 legacy 扁平 x/y（target 缺省时）', () => {
    expect(resolveTarget(undefined, { x: 10, y: 20 }, undefined, bounds, 1)).toMatchObject({ x: 10, y: 20 })
  })

  test('元素在屏外 / 没有矩形 / 尺寸为 0 → 一律 ELEMENT_UNAVAILABLE', () => {
    resetFrames()
    const frame = parseFrame(
      JSON.stringify({
        ok: true,
        app: 'notepad',
        window: { id: 9, title: '记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        elements: [
          { index: 0, controlType: 'Edit', title: '屏外', bounds: { x: 10, y: 10, width: 10, height: 10 }, offscreen: true },
          { index: 1, controlType: 'Edit', title: '无矩形', bounds: null },
          { index: 2, controlType: 'Edit', title: '零宽', bounds: { x: 10, y: 10, width: 0, height: 10 } },
          { index: 3, controlType: 'Edit', title: '正常', bounds: { x: 100, y: 100, width: 10, height: 20 } },
        ],
        text: '',
      }),
    )

    for (const index of [0, 1, 2]) {
      expect(() => resolveTarget(asTarget({ type: 'element', index }), undefined, frame, bounds, 1)).toThrow(
        /ELEMENT_UNAVAILABLE/,
      )
    }
    expect(resolveTarget(asTarget({ type: 'element', index: 3 }), undefined, frame, bounds, 1)).toMatchObject({
      x: 105,
      y: 110,
    })
  })

  test('state_id 与当前帧一致时放行；元素中心在屏幕外时拒绝', () => {
    resetFrames()
    const frame = parseFrame(
      JSON.stringify({
        ok: true,
        app: 'notepad',
        window: { id: 10, title: '记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        elements: [
          { index: 0, controlType: 'Edit', title: '正常', bounds: { x: 10, y: 10, width: 10, height: 10 } },
          { index: 1, controlType: 'Edit', title: '出屏', bounds: { x: 5000, y: 10, width: 10, height: 10 } },
        ],
        text: '',
      }),
    )

    expect(
      resolveTarget(asTarget({ type: 'element', index: 0, state_id: frame.state_id }), undefined, frame, bounds, 1),
    ).toMatchObject({ x: 15, y: 15 })
    expect(() => resolveTarget(asTarget({ type: 'element', index: 1 }), undefined, frame, bounds, 1)).toThrow(
      /在屏幕外/,
    )
  })
})

describe('⑩ frameForWindow / resetFrames', () => {
  test('按窗口键（数字或字符串）与 latest 取帧；未命中返回 undefined', () => {
    resetFrames()
    expect(frameForWindow()).toBeUndefined()
    expect(frameForWindow(501)).toBeUndefined()

    const first = parseFrame(
      JSON.stringify({ ok: true, app: 'a', window: { id: 501, title: 'A', bounds: null }, elements: [], text: '' }),
    )
    expect(frameForWindow(501)).toBe(first)
    expect(frameForWindow('501')).toBe(first)
    expect(frameForWindow()).toBe(first)

    const second = parseFrame(
      JSON.stringify({ ok: true, app: 'b', window: { id: 502, title: 'B', bounds: null }, elements: [], text: '' }),
    )
    expect(frameForWindow(502)).toBe(second)
    expect(frameForWindow()).toBe(second)
    expect(frameForWindow(501)).toBe(first)
    expect(frameForWindow(999)).toBeUndefined()
  })

  test('resetFrames 清空缓存并把 state_id 计数归零', () => {
    resetFrames()
    const before = parseFrame(
      JSON.stringify({ ok: true, app: 'a', window: { id: 601, title: 'A', bounds: null }, elements: [], text: '' }),
    )
    expect(before.state_id).toBe('st-1')

    resetFrames()
    expect(frameForWindow(601)).toBeUndefined()
    expect(frameForWindow()).toBeUndefined()

    const after = parseFrame(
      JSON.stringify({ ok: true, app: 'a', window: { id: 601, title: 'A', bounds: null }, elements: [], text: '' }),
    )
    expect(after.state_id).toBe('st-1')
  })
})
