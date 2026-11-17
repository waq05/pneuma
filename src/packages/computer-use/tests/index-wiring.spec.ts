/**
 * computer-use 装配与工具面补测（`src/packages/computer-use/index.ts`）。
 *
 * 与 `desktop-control.spec.ts` 的分工：那边钉纯函数、生成的 PowerShell 脚本文本、
 * 目标解析与 `runPowerShell` 生命周期；这里钉 `apply()` 里的**决策层**：
 *   - 两个工具的动作枚举（禁用清单 / 免审批档）与 `computer_look` 的运行时闸门；
 *   - `act()` 的截图、只读观察、动手动作上限、输入内容体检、return_state 证据与错误审计；
 *   - 设置分区的 fields / values / save 校验 / 三个按钮；
 *   - 系统提示段里的白名单与动作上限。
 *
 * 桌面控制整包换成可编排的假实现（`vi.mock('../desktop-control.js')`）：不操作这台电脑、
 * 不启动 PowerShell、不写真实审计文件。DSC_HOME 在动态 import 之前指进临时目录，
 * 免得读到开发者自己那份 `computer-use` 配置。
 *
 * @module @pneuma/computer-use/tests/index-wiring.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-computer-use-wiring-'))
process.env['DSC_HOME'] = HOME

/** 可编排的假桌面控制状态。 */
const m = vi.hoisted(() => {
  interface Shot {
    scale?: number
    text: string
    images?: string[]
  }
  interface Reply {
    text?: string
    frame?: Record<string, unknown>
    error?: string
  }
  const s: {
    audits: Array<Record<string, unknown>>
    shotResult: Shot
    shotError: string | null
    shotCalls: Array<Record<string, unknown>>
    runCalls: Array<{ action: string; args: Record<string, unknown>; options: Record<string, unknown> }>
    runReplies: Reply[]
    settleResult: { stable: boolean; attempts: number; waitedMs: number; fingerprint: string }
    settleCalls: number
    killCount: number
    foreground: string
  } = {
    audits: [],
    shotResult: { scale: 1, text: 'shot-text', images: ['data:image/jpeg;base64,AA'] },
    shotError: null,
    shotCalls: [],
    runCalls: [],
    runReplies: [],
    settleResult: { stable: true, attempts: 2, waitedMs: 20, fingerprint: 'x' },
    settleCalls: 0,
    killCount: 0,
    foreground: 'notepad.exe|无标题 - 记事本',
  }

  return {
    s,
    takeScreenshot: async (options: Record<string, unknown>): Promise<Shot> => {
      s.shotCalls.push(options)
      if (s.shotError !== null) throw new Error(s.shotError)
      return s.shotResult
    },
    runDesktopAction: async (action: string, args: Record<string, unknown>, options: Record<string, unknown>) => {
      s.runCalls.push({ action, args, options })
      const reply = s.runReplies.shift() ?? { text: `${action} ok` }
      if (reply.error !== undefined) throw new Error(reply.error)
      return { text: reply.text ?? `${action} ok`, ...(reply.frame === undefined ? {} : { frame: reply.frame }) }
    },
    settleObserve: async () => {
      s.settleCalls += 1
      return s.settleResult
    },
    foregroundWindow: async () => s.foreground,
    killAllPowerShell: () => {
      s.killCount += 1
      return s.killCount
    },
    appendComputerAudit: (_home: string, record: Record<string, unknown>) => {
      s.audits.push(record)
    },
  }
})

/* 桌面控制：只替换「会碰机器」的入口，动作表与危险分级保持真的。 */
vi.mock('../desktop-control.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop-control.js')>()
  return {
    ...actual,
    takeScreenshot: (options: Record<string, unknown>) => m.takeScreenshot(options),
    runDesktopAction: (action: string, args: Record<string, unknown>, options: Record<string, unknown>) =>
      m.runDesktopAction(action, args, options),
    settleObserve: () => m.settleObserve(),
    foregroundWindow: () => m.foregroundWindow(),
    killAllPowerShell: () => m.killAllPowerShell(),
    appendComputerAudit: (home: string, record: Record<string, unknown>) => m.appendComputerAudit(home, record),
  }
})

type IndexModule = typeof import('../index.js')
let idx: IndexModule

beforeAll(async () => {
  idx = await import('../index.js')
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME.startsWith(HOME)).toBe(true)
})

beforeEach(() => {
  // 上一条用例 save 进 plugins.json 的值不能漏到下一条（mount 的 passed 会被磁盘配置盖过）。
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`, 'utf8')
  m.s.audits.length = 0
  m.s.shotResult = { scale: 1, text: 'shot-text', images: ['data:image/jpeg;base64,AA'] }
  m.s.shotError = null
  m.s.shotCalls.length = 0
  m.s.runCalls.length = 0
  m.s.runReplies.length = 0
  m.s.settleResult = { stable: true, attempts: 2, waitedMs: 20, fingerprint: 'x' }
  m.s.settleCalls = 0
  m.s.killCount = 0
  m.s.foreground = 'notepad.exe|无标题 - 记事本'
})

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const dispose of cleanups.splice(0)) {
    try {
      dispose()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // Windows 上偶尔被扫描进程占着：临时目录留给系统清。
  }
})

/** 一处 JSON Schema 的测试形状。 */
interface Schema {
  type?: string
  enum?: string[]
  properties?: Record<string, Schema>
  required?: string[]
}

/** 桩 ctx 捕获到的工具条目。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: Schema
  run: (args: Record<string, unknown>, runCtx: { signal: AbortSignal }) => Promise<unknown>
}

/** 桩 ctx 捕获到的设置分区。 */
interface CapturedSection {
  id: string
  title?: string
  order?: number
  fields: () => Array<{ type: string; key?: string; action?: string; group?: string }>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => string | void
  action: (name: string) => Promise<string>
}

interface Mounted {
  tools: CapturedTool[]
  guards: Array<{ id: string; order?: number; decide: (input: Record<string, unknown>) => unknown }>
  prompts: Array<() => string>
  section: CapturedSection
}

/** 挂一次插件；config 走 `passed`。 */
function mount(config: Record<string, unknown> = {}): Mounted {
  const tools: CapturedTool[] = []
  const guards: Mounted['guards'] = []
  const prompts: Array<() => string> = []
  const noop = (): void => {}
  let section: CapturedSection | null = null

  const ctx = {
    tools: {
      register(entry: CapturedTool) {
        tools.push(entry)
        return noop
      },
    },
    guards: {
      register(guard: Mounted['guards'][number]) {
        guards.push(guard)
        return noop
      },
    },
    prompt: {
      register(_id: string, fn: () => string) {
        prompts.push(fn)
        return noop
      },
    },
    settings: {
      registerSection(value: CapturedSection) {
        section = value
        return noop
      },
      about: () => ({ version: '0', apiVersion: 0, home: HOME, skillsDir: '', pluginsDir: '' }),
    },
    effect(execute: () => unknown) {
      const off = execute()
      return typeof off === 'function' ? off : noop
    },
  }

  const dispose = (idx.computerUsePlugin.apply as unknown as (ctx: unknown, passed: unknown) => () => void)(
    ctx,
    config,
  )
  cleanups.push(dispose)
  if (section === null) throw new Error('插件没有注册设置分区')
  return { tools, guards, prompts, section }
}

/** 取最近一次注册的同名工具（设置保存会重新注册）。 */
function toolNamed(mounted: Mounted, name: string): CapturedTool {
  const found = mounted.tools.filter((tool) => tool.name === name)
  const last = found[found.length - 1]
  if (last === undefined) throw new Error(`没有注册 ${name}，只有 ${mounted.tools.map((tool) => tool.name).join('、')}`)
  return last
}

/** 某个工具参数表里的 action 枚举。 */
function actionEnum(tool: CapturedTool): string[] {
  return tool.parameters.properties?.action?.enum ?? []
}

/** 调一次工具的 run，带上假 runCtx。 */
function runTool(tool: CapturedTool, args: Record<string, unknown>): Promise<unknown> {
  return tool.run(args, { signal: new AbortController().signal })
}

// ── 动作面与运行时闸门 ───────────────────────────────────────────────────────

describe('工具动作面', () => {
  test('不认识的动作：报错并列出可选动作', async () => {
    const mounted = mount()
    await expect(runTool(toolNamed(mounted, 'computer'), { action: 'nope' })).rejects.toThrow(
      /不认识的动作「nope」/,
    )
  })

  test('computer_look 的运行时闸门挡住点击与急停（schema 只是说明）', async () => {
    const mounted = mount({ lookWithoutApproval: true })
    const look = toolNamed(mounted, 'computer_look')
    expect(look.risk).toBe('read')

    await expect(
      runTool(look, { action: 'click', target: { type: 'coordinate', x: 1, y: 1 } }),
    ).rejects.toThrow(/computer_look 只能做只读动作/)
    await expect(runTool(look, { action: 'stop' })).rejects.toThrow(/computer_look 只能做只读动作/)
    expect(m.s.killCount).toBe(0)
    expect(m.s.runCalls).toHaveLength(0)
  })

  test('stop：杀进程、写 system 审计、之后动手动作被暂停', async () => {
    const mounted = mount()
    const computer = toolNamed(mounted, 'computer')

    const result = await runTool(computer, { action: 'stop' })
    expect(String(result)).toContain('已急停电脑操作')
    expect(m.s.killCount).toBe(1)
    expect(m.s.audits.at(-1)).toMatchObject({ action: 'stop', risk: 'system', result: 'ok', approved: true })

    await expect(
      runTool(computer, { action: 'click', target: { type: 'coordinate', x: 5, y: 6 } }),
    ).rejects.toThrow(/电脑操作已急停/)
  })

  test('禁用动作：枚举里移除，运行时也拒；只读工具同样受清单约束', async () => {
    const mounted = mount({ disabledActions: 'click,screenshot', lookWithoutApproval: true })
    const computer = toolNamed(mounted, 'computer')
    const look = toolNamed(mounted, 'computer_look')

    expect(actionEnum(computer)).not.toContain('click')
    expect(actionEnum(look)).not.toContain('screenshot')
    await expect(
      runTool(computer, { action: 'click', target: { type: 'coordinate', x: 1, y: 1 } }),
    ).rejects.toThrow(/「禁用动作」里关掉了/)
    await expect(runTool(look, { action: 'screenshot' })).rejects.toThrow(/「禁用动作」里关掉了/)
    expect(m.s.shotCalls).toHaveLength(0)
  })
})

// ── 动作执行分支 ─────────────────────────────────────────────────────────────

describe('act：截图与只读观察', () => {
  test('screenshot：参数透传、缩放系数记账、只读入口审计 approved=false', async () => {
    const mounted = mount({ lookWithoutApproval: true, maxEdge: 900, format: 'png', quality: 55 })
    const look = toolNamed(mounted, 'computer_look')
    const clip = { x: 1, y: 2, width: 30, height: 40 }

    const result = (await runTool(look, { action: 'screenshot', clip })) as { text: string; images?: string[] }

    expect(result.images).toEqual(['data:image/jpeg;base64,AA'])
    expect(result.text).toContain('<external_content source="screenshot">')
    expect(result.text).toContain('shot-text')
    expect(m.s.shotCalls[0]).toMatchObject({ maxEdge: 900, format: 'png', quality: 55, clip })
    expect(m.s.audits.at(-1)).toMatchObject({
      action: 'screenshot',
      risk: 'read',
      target: `裁切 ${JSON.stringify(clip)}`,
      approved: false,
    })

    // 截图把 lastScale 记下来；后续坐标动作按它换算。
    m.s.shotResult = { scale: 2, text: 'next', images: [] }
    await runTool(look, { action: 'screenshot' })
    m.s.runReplies.push({ text: 'cursor ok' })
    await runTool(look, { action: 'cursor' })
    expect(m.s.runCalls.at(-1)?.options).toMatchObject({ scale: 2 })
  })

  test('get_app_state：参数映射（window / disable_diffing）、文本围栏与审计目标', async () => {
    const mounted = mount({ lookWithoutApproval: true })
    const look = toolNamed(mounted, 'computer_look')
    m.s.runReplies.push({ text: 'tree', frame: { state_id: 'st-1' } })

    const result = String(await runTool(look, { action: 'get_app_state', window: 5, disable_diffing: true }))

    expect(result).toContain('<external_content source="app-state">')
    expect(result).toContain('tree')
    expect(m.s.runCalls[0]).toMatchObject({
      action: 'get_app_state',
      args: expect.objectContaining({ window: 5, disableDiffing: true }),
      options: expect.objectContaining({ scale: 1, allowedApps: [], actionDelayMs: 120 }),
    })
    expect(m.s.audits.at(-1)).toMatchObject({
      action: 'get_app_state',
      risk: 'read',
      target: 'window=5',
      approved: false,
    })
  })
})

describe('act：动手动作的护栏', () => {
  test('动作上限：超限要求先截屏；截屏后计数清零', async () => {
    const mounted = mount({ actionsPerScreenshot: 1 })
    const computer = toolNamed(mounted, 'computer')

    await expect(runTool(computer, { action: 'type', text: 'hello' })).resolves.toBe('type ok')
    expect(m.s.runCalls[0]!.args).toMatchObject({ text: 'hello' })
    expect(m.s.audits.at(-1)).toMatchObject({ action: 'type', risk: 'input', result: 'ok', approved: true })

    await expect(runTool(computer, { action: 'type', text: 'again' })).rejects.toThrow(
      /距离上次截屏已经动手 1 次/,
    )

    await runTool(computer, { action: 'screenshot' })
    await expect(runTool(computer, { action: 'type', text: 'after-shot' })).resolves.toBe('type ok')
  })

  test('输入体检：密钥形状与灾难性命令都不代敲，且写进错误审计', async () => {
    const mounted = mount()
    const computer = toolNamed(mounted, 'computer')

    await expect(runTool(computer, { action: 'type', text: `sk-${'a'.repeat(24)}` })).rejects.toThrow(
      /密钥形状的字符串/,
    )
    await expect(runTool(computer, { action: 'type', text: 'rm -rf /' })).rejects.toThrow(/灾难性命令/)

    expect(m.s.runCalls).toHaveLength(0)
    expect(m.s.audits.filter((record) => record.result === 'error')).toHaveLength(2)
    expect(m.s.audits.at(-1)).toMatchObject({ action: 'type', risk: 'input', result: 'error', approved: true })
  })

  test('return_state：动作后再观察一次，按 diff 是否为空给 effect_evidence', async () => {
    const mounted = mount()
    const computer = toolNamed(mounted, 'computer')
    m.s.runReplies.push(
      { text: 'clicked' },
      {
        text: 'after tree',
        frame: {
          state_id: 'st-9',
          snapshot_mode: 'diff',
          diff: { removed: [], added: [], changed: [] },
        },
      },
    )

    const result = String(
      await runTool(computer, { action: 'click', target: { type: 'coordinate', x: 10, y: 20 }, return_state: true }),
    )

    expect(result).toContain('clicked')
    expect(result).toContain('[动作后观察] effect_evidence: unchanged')
    expect(result).toContain('界面已稳定')
    expect(result).toContain('观察 st-9')
    expect(result).toContain('<external_content source="app-state">')
    expect(m.s.runCalls).toHaveLength(2)
    expect(m.s.runCalls[1]!.args).toMatchObject({ disableDiffing: false })
    expect(m.s.runCalls[1]!.options).toMatchObject({ actionDelayMs: 0 })
    // 自动观察不额外写审计（审计只记用户/模型真正发起的动作）。
    expect(m.s.audits).toHaveLength(1)
    expect(m.s.settleCalls).toBe(1)
  })

  test('执行抛错：原样抛回，并补一条 result=error 的审计', async () => {
    const mounted = mount()
    const computer = toolNamed(mounted, 'computer')
    m.s.runReplies.push({ error: '点击失败：目标窗口不存在' })

    await expect(
      runTool(computer, { action: 'click', target: { type: 'coordinate', x: 1, y: 1 } }),
    ).rejects.toThrow(/点击失败：目标窗口不存在/)

    expect(m.s.audits.at(-1)).toMatchObject({
      action: 'click',
      risk: 'input',
      target: 'coord(1,1)',
      result: 'error',
      approved: true,
      detail: '点击失败：目标窗口不存在',
    })
  })

  test('审计开关关掉：动作照常做，但一行审计都不写', async () => {
    const mounted = mount({ auditEnabled: false })
    const computer = toolNamed(mounted, 'computer')
    await expect(runTool(computer, { action: 'type', text: 'hi' })).resolves.toBe('type ok')
    expect(m.s.audits).toHaveLength(0)
  })
})

// ── 设置分区与提示词 ─────────────────────────────────────────────────────────

describe('设置分区', () => {
  test('fields / values：默认值与禁用动作归一进值表', () => {
    const mounted = mount({
      maxEdge: 2000,
      format: 'png',
      quality: 60,
      actionDelayMs: 50,
      actionsPerScreenshot: 3,
      allowedApps: 'notepad, code',
      disabledActions: 'window_list',
      lookWithoutApproval: true,
      auditEnabled: false,
    })
    const { section } = mounted

    expect(section.id).toBe('computer-use')
    expect(section.order).toBe(45)
    expect(section.values()).toEqual({
      maxEdge: 2000,
      format: 'png',
      quality: 60,
      actionDelayMs: 50,
      actionsPerScreenshot: 3,
      allowedApps: 'notepad, code',
      disabledActions: 'window_list',
      lookWithoutApproval: true,
      auditEnabled: false,
    })
    const keys = section.fields().map((field) => field.key ?? field.action)
    expect(keys).toEqual(
      expect.arrayContaining(['maxEdge', 'format', 'quality', 'disabledActions', 'who-is-front', 'stop-computer', 'resume-computer']),
    )
  })

  test('save：数字校验与夹取、禁用动作归一、未知键', () => {
    const mounted = mount()
    const { section } = mounted

    expect(section.save('maxEdge', 'abc')).toContain('要填数字')
    expect(section.save('maxEdge', 9999)).toBeUndefined()
    expect(section.values()['maxEdge']).toBe(3840)

    expect(section.save('quality', Number.NaN)).toContain('要填数字')
    expect(section.save('actionsPerScreenshot', 'x')).toContain('要填数字')
    expect(section.save('actionDelayMs', 'x')).toContain('要填数字')

    expect(section.save('disabledActions', 'nope, click')).toContain('不认识的动作')
    expect(section.save('disabledActions', 'window_list, click')).toBeUndefined()
    expect(section.values()['disabledActions']).toBe('list_windows,click')

    expect(section.save('format', 'png')).toBeUndefined()
    expect(section.values()['format']).toBe('png')
    expect(section.save('allowedApps', '  notepad  ')).toBeUndefined()
    expect(section.values()['allowedApps']).toBe('notepad')

    expect(section.save('nope', 1)).toContain('这个分区没有这项')
  })

  test('save lookWithoutApproval=true：重新注册工具，computer_look 出现', () => {
    const mounted = mount()
    expect(mounted.tools.some((tool) => tool.name === 'computer_look')).toBe(false)

    expect(mounted.section.save('lookWithoutApproval', true)).toBeUndefined()
    expect(mounted.tools.some((tool) => tool.name === 'computer_look')).toBe(true)
  })

  test('按钮：who-is-front / stop-computer / resume-computer / 未知按钮', async () => {
    const mounted = mount()
    const { section } = mounted
    m.s.foreground = 'notepad.exe|无标题 - 记事本'

    const front = await section.action('who-is-front')
    expect(front).toContain('notepad.exe')
    expect(front).toContain('无标题 - 记事本')

    const stopped = await section.action('stop-computer')
    expect(stopped).toContain('已急停')
    expect(m.s.killCount).toBe(1)
    expect(m.s.audits.at(-1)).toMatchObject({ action: 'stop', risk: 'system', target: '设置页急停', approved: true })

    expect(await section.action('resume-computer')).toContain('已恢复电脑操作')
    await expect(section.action('nope')).rejects.toThrow(/这个分区没有这个按钮/)
  })

  test('提示词：白名单与动作上限各追加一行，缩放系数现读', () => {
    const plain = mount()
    const plainText = plain.prompts.at(-1)!()
    expect(plainText).toContain('computer 一个工具')
    expect(plainText).not.toContain('+ computer_look（截屏')
    expect(plainText).toContain('当前缩放系数是 1.00')

    const limited = mount({ allowedApps: 'notepad, code', actionsPerScreenshot: 5, lookWithoutApproval: true })
    const limitedText = limited.prompts.at(-1)!()
    expect(limitedText).toContain('computer（点击/拖拽/输入/粘贴/按键/滚动/元素动作/急停）+ computer_look')
    expect(limitedText).toContain('你被限定只能操作这些应用：notepad、code')
    expect(limitedText).toContain('自上次截屏起最多连做 5 个动作')
  })
})

// ── 纯函数补遗 ───────────────────────────────────────────────────────────────

describe('dropStaleScreenshots 识别边界', () => {
  test('没有本插件标记的图片、非 tool 消息、纯文本标记都不算截图', () => {
    const plain: Parameters<typeof idx.dropStaleScreenshots>[0] = [
      { role: 'user', content: [{ type: 'text', text: '屏幕物理分辨率 1' }] },
      { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] },
      { role: 'tool', content: [{ type: 'text', text: '屏幕物理分辨率 2' }] },
    ]
    expect(idx.dropStaleScreenshots(plain)).toBe(plain)
  })
})
