/**
 * ptc 的 w14 补测：`createDeadline` 到点掐断脚本、脚本调未知工具、调用次数用满。
 *
 * 用假 ctx 跑真 `apply`（与 `wiring.spec.ts` 同一套），脚本在真的 `node:vm` 里跑；
 * 时限那条用假计时器推进时间，不起真睡眠。
 *
 * @module dsc/packages/ptc/tests/w14-gaps
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-ptc-w14-'))
process.env['DSC_HOME'] = HOME

type PtcIndex = typeof import('../index.js')
let ptcPlugin: PtcIndex['ptcPlugin']

beforeAll(async () => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  ptcPlugin = (await import('../index.js')).ptcPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上偶发 EPERM：临时目录交给系统清
  }
})

interface FakeTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: 'read' | 'write' | 'exec'
  run: (args: Record<string, unknown>, ctx: unknown) => Promise<string> | string
}

interface RegisteredTool {
  name: string
  run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<unknown>
}

/** 假 ctx：工具表只有几条固定工具，守卫链一律放行，转录只收集事件。 */
function mount(): RegisteredTool {
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
      run: async () => 'wrote',
    },
  ]
  const registered: RegisteredTool[] = []
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    tools: {
      list: () => registry,
      register(tool: RegisteredTool) {
        registered.push(tool)
        return () => undefined
      },
    },
    guards: {
      gate: async () => ({ action: 'defer' }),
      observe: (_name: string, text: string) => text,
    },
    transcript: {
      emit: () => undefined,
    },
  }
  ptcPlugin.apply?.(ctx as never, undefined)
  expect(registered).toHaveLength(1)
  return registered[0]!
}

const runCtx = (): Record<string, unknown> => ({
  cwd: 'C:/repo',
  signal: new AbortController().signal,
  sessionId: 'sess-w14',
  sessionPath: 'C:/repo/.dsc/sessions/sess-w14.jsonl',
  callId: 'parent-w14',
})

const runCode = async (tool: RegisteredTool, code: string): Promise<string> => {
  const result = (await tool.run({ code }, runCtx())) as string | { text: string }
  return typeof result === 'string' ? result : result.text
}

test('脚本挂住不返回：总时限到点由计时器回调掐断，交回「脚本没跑完」', async () => {
  const tool = mount()
  vi.useFakeTimers()
  try {
    const pending = runCode(tool, 'await new Promise(() => {}); return 1')
    // 默认时限 300 秒（PTC_LIMITS.deadlineMs）：推过 1 毫秒让计时器回调落地。
    await vi.advanceTimersByTimeAsync(300_001)
    const text = await pending
    expect(text).toContain('【脚本没跑完】')
    expect(text).toContain('脚本跑了超过 300 秒，被掐断了')
  } finally {
    vi.useRealTimers()
  }
})

test('脚本调了不在快照里的工具名：报「没有名为…的工具」并列出可用工具', async () => {
  const tool = mount()
  // 只让注册表查名字这一下失手：sdk.echo 存在，但 registry.get('echo') 返回 undefined，
  // 走到「没有名为…的工具」这条防御分支（正常脚本拿到的名字一定在快照里）。
  const realGet = Map.prototype.get
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
    if (key === 'echo') return undefined
    return realGet.call(this, key)
  })
  try {
    const text = await runCode(tool, 'return await sdk.echo({ text: 1 })')
    expect(text).toContain('没有名为「echo」的工具')
    expect(text).toContain('可用：echo、write_file')
    expect(text).toContain('这一轮没有调用任何工具。')
  } finally {
    spy.mockRestore()
  }
})

test('调用次数用满 200 次后再调一条工具：脚本被拒，结果里点明上限与次数', async () => {
  const tool = mount()
  const text = await runCode(tool, ['for (let i = 0; i < 201; i += 1) { await sdk.echo({ i }) }', "return 'done'"].join('\n'))
  expect(text).toContain('【脚本没跑完】')
  expect(text).toContain('一段脚本最多调 200 次工具，已经用完了')
  expect(text).toContain('这一轮调了 200 次工具（echo×200）')
})
