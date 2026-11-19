/**
 * ptc 插件装配面（`packages/ptc/index.ts`）：`run_code` 工具、脚本周边的 SDK、守卫链、
 * 读写闸、调用清单、遮红、打断与改动回传。
 *
 * 用假 ctx 跑真 `apply`：脚本在真的 `node:vm` 里跑，工具表是假的（它们只需要
 * `name / risk / run`），守卫链与观察者也是假的——这样每个分支都能精确触发。
 *
 * @module dsc/packages/ptc/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-ptc-wiring-'))
process.env['DSC_HOME'] = HOME

type PtcIndex = typeof import('../index.js')
let ptcPlugin: PtcIndex['ptcPlugin']

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上偶发 EPERM：临时目录交给系统清。
  }
})

beforeAll(async () => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  ptcPlugin = (await import('../index.js')).ptcPlugin
})

interface FakeTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: 'read' | 'write' | 'exec'
  waitsForHuman?: boolean
  run: (args: Record<string, unknown>, ctx: unknown) => Promise<string | { text: string; changes?: unknown; changesList?: unknown[] }> | string
}

interface GateInput {
  toolName: string
  risk: string
  cwd: string
  args: Record<string, unknown>
  sessionId: string
  sessionPath: string
}

interface TranscriptEvent {
  type: string
  callId?: string
  name?: string
  args?: string
  text?: string
  error?: string
  parentCallId?: string
}

interface Harness {
  tools: Array<{
    name: string
    description: string
    risk: string
    presets?: readonly string[]
    run: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>
  }>
  gates: GateInput[]
  observed: Array<{ name: string; text: string }>
  events: Array<{ event: TranscriptEvent; sessionId?: string }>
  verdict: () => { action: 'defer' } | { action: 'deny'; reason: string }
  observe: (name: string, text: string) => string
}

function fakeCtx(extra: FakeTool[] = []): Harness {
  const registry: FakeTool[] = [
    {
      name: 'echo',
      description: '原样回显参数',
      parameters: { type: 'object' },
      risk: 'read',
      run: async (args) => `echo:${JSON.stringify(args)}`,
    },
    {
      name: 'write_file',
      description: '写文件',
      parameters: { type: 'object' },
      risk: 'write',
      run: async () => ({
        text: 'wrote a.ts',
        changes: { path: 'C:/repo/a.ts', added: 1, removed: 0, hunks: [], status: 'modified' },
      }),
    },
    {
      name: 'boom',
      description: '总是失败',
      parameters: { type: 'object' },
      risk: 'read',
      run: async () => {
        throw new Error('炸了')
      },
    },
    ...extra,
  ]

  const registered: Harness['tools'] = []
  const gates: Harness['gates'] = []
  const observed: Harness['observed'] = []
  const events: Harness['events'] = []
  const harness: Harness = {
    tools: registered,
    gates,
    observed,
    events,
    verdict: () => ({ action: 'defer' }),
    observe: (name, text) => `[ob:${name}]${text}`,
  }

  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    tools: {
      list: () => registry,
      register(tool: Harness['tools'][number]) {
        registered.push(tool)
        return () => undefined
      },
    },
    guards: {
      gate: async (input: GateInput) => {
        gates.push(input)
        return harness.verdict()
      },
      observe: (name: string, text: string) => {
        observed.push({ name, text })
        return harness.observe(name, text)
      },
    },
    transcript: {
      emit: (event: TranscriptEvent, sessionId?: string) => events.push({ event, ...(sessionId === undefined ? {} : { sessionId }) }),
    },
  }

  ptcPlugin.apply?.(ctx as never, undefined)
  expect(registered).toHaveLength(1)
  return harness
}

const runCtx = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  cwd: 'C:/repo',
  signal: new AbortController().signal,
  sessionId: 'sess-1',
  sessionPath: 'C:/repo/.dsc/sessions/sess-1.jsonl',
  callId: 'parent-1',
  ...overrides,
})

const runCode = async (harness: Harness, code: string, overrides: Record<string, unknown> = {}) =>
  harness.tools[0]!.run({ code }, runCtx(overrides)) as Promise<string | { text: string; changesList?: unknown[] }>

describe('注册与正常路径', () => {
  test('run_code 只属于 ptc 模式，风险 exec，说明里带 sdk 签名与调用上限', () => {
    const harness = fakeCtx()
    expect(harness.tools[0]).toMatchObject({ name: 'run_code', risk: 'exec', presets: ['ptc'] })
    expect(harness.tools[0]!.description).toContain('await sdk.<工具名>')
    expect(harness.tools[0]!.description).toContain('最多调 200 次工具')
    expect(harness.tools[0]!.description).toContain('最多跑 300 秒')
  })

  test('脚本里批量调工具：守卫链、父子卡片、遮红、调用清单、改动清单都到位', async () => {
    const harness = fakeCtx()
    const result = (await runCode(
      harness,
      [
        "const a = await sdk.echo({ text: 'hi' })",
        "const b = await sdk.write_file({ path: 'a.ts' })",
        "console.log('done', a, b)",
        'return { a, b }',
      ].join('\n'),
    )) as { text: string; changesList?: unknown[] }

    expect(result.text).toContain('这一轮调了 2 次工具（echo、write_file）')
    expect(result.text).toContain('返回值：')
    expect(result.text).toContain('echo:{\\"text\\":\\"hi\\"}')
    expect(result.text).toContain('脚本输出（最后 1 行）：\ndone [ob:echo]')
    // 观察者（遮红）加工过的正文才是脚本里拿到的文本。
    expect(result.text).toContain('[ob:echo]')
    expect(result.changesList).toHaveLength(1)

    // 每次内部调用都带着真名与真实风险过守卫链，归属是发起脚本的会话。
    expect(harness.gates.map((gate) => [gate.toolName, gate.risk])).toEqual([
      ['echo', 'read'],
      ['write_file', 'write'],
    ])
    expect(harness.gates[0]!.sessionId).toBe('sess-1')
    expect(harness.gates[0]!.cwd).toBe('C:/repo')

    // 界面的实时卡片：两条 call + 两条 result，且挂到 run_code 的父卡上。
    const calls = harness.events.filter((item) => item.event.type === 'tool/call')
    const results = harness.events.filter((item) => item.event.type === 'tool/result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    expect(calls.every((item) => item.event.parentCallId === 'parent-1')).toBe(true)
    expect(calls.every((item) => item.sessionId === 'sess-1')).toBe(true)
    expect(results.every((item) => item.sessionId === 'sess-1')).toBe(true)
  })

  test('sdk.describe / sdk.list / JSON 串参数 / 循环引用日志都能用', async () => {
    const harness = fakeCtx()
    const result = (await runCode(
      harness,
      [
        "const names = sdk.list().sort().join(',')",
        "const desc = sdk.describe('echo')",
        "const data = await sdk.echo('{\"text\":\"从字符串\"}')",
        'const loop = {}',
        'loop.self = loop',
        'console.log(loop)',
        'return [names, desc, data]',
      ].join('\n'),
    )) as { text: string }

    expect(result.text).toContain('boom,echo,write_file')
    expect(result.text).toContain('工具 echo（风险：read）')
    expect(result.text).toContain('参数 schema：')
    expect(result.text).toContain('从字符串')
    expect(result.text).toContain('[ob:echo]')
    // 循环引用走 safeJson 的兜底分支：不抛错，日志里有一行 [object Object]。
    expect(result.text).toContain('[object Object]')
  })
})

describe('失败与打断分支', () => {
  test('守卫链拒绝：脚本拿到「被拒绝」，执行不落盘，清单里记失败', async () => {
    const harness = fakeCtx()
    harness.verdict = () => ({ action: 'deny', reason: '这个工具现在不许用' })
    const result = (await runCode(harness, "return await sdk.echo({ text: 'x' })")) as { text: string }

    expect(result.text).toContain('返回值：\n【被拒绝】这个工具现在不许用')
    expect(result.text).toContain('失败 1 条')
    expect(result.text).toContain('✗ echo')
    // 被拒的调用没有执行，观察者一次都不该被问。
    expect(harness.observed).toHaveLength(0)
    expect(harness.events.some((item) => item.event.type === 'tool/result' && item.event.error === 'rejected')).toBe(true)
  })

  test('工具抛错与未知工具名分别转成「执行失败」和脚本级 trouble', async () => {
    const harness = fakeCtx()

    const failed = (await runCode(harness, 'return await sdk.boom({})')) as { text: string }
    expect(failed.text).toContain('返回值：\n【执行失败】炸了')
    expect(failed.text).toContain('✗ boom')

    const unknown = (await runCode(harness, "return sdk.describe('nope')")) as { text: string }
    expect(unknown.text).toContain('没有名为「nope」的工具')
    expect(unknown.text).toContain('可用：echo、write_file、boom')
  })

  test('signal 已打断：脚本连同内部调用一起停，交回「没跑完」的说明', async () => {
    const harness = fakeCtx()
    const controller = new AbortController()
    controller.abort()
    const result = (await runCode(harness, 'return 1', { signal: controller.signal })) as { text: string }
    expect(result.text).toContain('【脚本没跑完】用户打断了这一轮，脚本停止')
  })

  test('读写闸：写调用独占，脚本里的读要等写结束（T38）', async () => {
    const order: string[] = []
    const harness = fakeCtx([
      {
        name: 'slow_write',
        description: '慢写',
        parameters: { type: 'object' },
        risk: 'write',
        run: async () => {
          order.push('startW')
          await new Promise((resolve) => setTimeout(resolve, 20))
          order.push('endW')
          return 'w'
        },
      },
      {
        name: 'echo_read',
        description: '读',
        parameters: { type: 'object' },
        risk: 'read',
        run: async () => {
          order.push('read')
          return 'r'
        },
      },
    ])

    const result = (await runCode(
      harness,
      [
        'const write = sdk.slow_write({})',
        'await sleep(1)',
        'const read = await sdk.echo_read({})',
        'await write',
        "return read + '/ok'",
      ].join('\n'),
    )) as { text: string }

    // 写先拿到闸并跑完，读才被放行；不会出现读写交错。
    expect(order).toEqual(['startW', 'endW', 'read'])
    expect(result.text).toContain('r/ok')
  })
})
