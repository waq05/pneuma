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
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
  gradeDesktopAction,
  keyScript,
  killAllPowerShell,
  listAppsScript,
  listWindowsScript,
  observeScript,
  pasteScript,
  parseFrame,
  resetFrames,
  resolveTarget,
  screenshotScript,
  scrollScript,
  screensScript,
  settleObserve,
  typeScript,
} from '../desktop-control.js'

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
