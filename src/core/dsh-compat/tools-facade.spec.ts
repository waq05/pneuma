/**
 * dsh 工具定义 → dsc ToolEntry 的兼容层（`core/dsh-compat/tools-facade.ts`）。
 *
 * 这一层最容易出的错是「看着像兼容、跑起来行为不对」：risk 映射、输出 schema 校验、
 * render/内容钩子的顺序、失败也过 finalizeContent、并发分类抛错当独占。逐条用真调用钉住。
 *
 * @module dsc/core/dsh-compat/tools-facade.spec
 */
import { describe, expect, test } from 'vitest'
import type { ToolContext } from '../tools.js'
import {
  dshToolToEntry,
  dshToolsFacade,
  looksLikeDshToolDefinition,
  type DshRiskConfig,
  type DshToolDefinitionLike,
} from './tools-facade.js'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/w',
    signal: new AbortController().signal,
    sessionId: 's1',
    sessionPath: '/home/.dsc/sessions/s1.jsonl',
    ...overrides,
  }
}

function definition(overrides: Partial<DshToolDefinitionLike> = {}): DshToolDefinitionLike {
  return {
    name: 'demo',
    description: '演示工具',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async () => ({ ok: true }),
    ...overrides,
  }
}

describe('looksLikeDshToolDefinition', () => {
  test('有 name + execute、没有 dsc 的 run 才算', () => {
    expect(looksLikeDshToolDefinition(definition())).toBe(true)
    expect(looksLikeDshToolDefinition(null)).toBe(false)
    expect(looksLikeDshToolDefinition({ name: 'x' })).toBe(false)
    expect(looksLikeDshToolDefinition({ name: 'x', execute: () => undefined, run: () => undefined })).toBe(false)
  })
})

describe('risk 映射', () => {
  test('缺省 exec；全局 risk 生效；按工具名覆盖优先级更高', () => {
    expect(dshToolToEntry(definition(), {}).risk).toBe('exec')
    expect(dshToolToEntry(definition(), { risk: 'read' }).risk).toBe('read')
    const config: DshRiskConfig = { risk: 'read', risks: { demo: 'write' } }
    expect(dshToolToEntry(definition(), config).risk).toBe('write')
  })

  test('认不出的 risk 回落 exec（宁可多问一次）', () => {
    expect(dshToolToEntry(definition(), { risk: 'root' }).risk).toBe('exec')
    expect(dshToolToEntry(definition(), { risks: { demo: 'root' } }).risk).toBe('exec')
  })
})

describe('entry 字段', () => {
  test('description / parameters 缺省与透传；timeout 只认正数', () => {
    const bare = dshToolToEntry(definition({ description: undefined, parameters: undefined }), {})
    expect(bare.description).toBe('')
    expect(bare.parameters).toEqual({ type: 'object', properties: {} })
    expect(bare.timeoutMs).toBeUndefined()

    const withTimeout = dshToolToEntry(definition({ timeoutMs: 1_500 }), {})
    expect(withTimeout.timeoutMs).toBe(1_500)
    expect(dshToolToEntry(definition({ timeoutMs: -1 }), {}).timeoutMs).toBeUndefined()
  })
})

describe('run：渲染、schema、内容钩子、卡片', () => {
  test('没有 render：字符串原样，其它值 JSON 化', async () => {
    const entry = dshToolToEntry(definition({ execute: async () => 'done' }), {})
    expect(await entry.run({}, ctx())).toBe('done')
    const object = dshToolToEntry(definition(), {})
    expect(await object.run({}, ctx())).toBe(JSON.stringify({ ok: true }, null, 2))
  })

  test('render 返回内容块：文本拼接，图像块给占位说明', async () => {
    const entry = dshToolToEntry(
      definition({
        output: {
          render: () => [
            { type: 'text', text: '第一段' },
            { type: 'image', data: '...' },
          ],
        },
      }),
      {},
    )
    const rendered = await entry.run({}, ctx())
    expect(rendered).toContain('第一段')
    expect(rendered).toContain('图像块已省略')
  })

  test('声明了 output.schema 就校验；不合 schema 的结果不当成功', async () => {
    const ok = dshToolToEntry(
      definition({ output: { schema: { type: 'string' } }, execute: async () => 'good' }),
      {},
    )
    expect(await ok.run({}, ctx())).toBe('good')

    const bad = dshToolToEntry(
      definition({ output: { schema: { type: 'string' } }, execute: async () => 42 }),
      {},
    )
    await expect(bad.run({}, ctx())).rejects.toThrow(/不符合它自己声明的 output\.schema/)
  })

  test('projectContent → finalizeContent 依次替换；返回非数组则保持原内容', async () => {
    const entry = dshToolToEntry(
      definition({
        output: { render: () => [{ type: 'text', text: 'raw' }] },
        projectContent: () => [{ type: 'text', text: 'projected' }],
        finalizeContent: () => [{ type: 'text', text: 'final' }],
      }),
      {},
    )
    expect(await entry.run({}, ctx())).toBe('final')

    const staying = dshToolToEntry(
      definition({
        output: { render: () => [{ type: 'text', text: 'raw' }] },
        projectContent: () => 'not-an-array',
      }),
      {},
    )
    expect(await staying.run({}, ctx())).toBe('raw')
  })

  test('内容钩子抛错不把结果变成错误（保留前一步内容）', async () => {
    const entry = dshToolToEntry(
      definition({
        output: { render: () => [{ type: 'text', text: 'raw' }] },
        finalizeContent: () => {
          throw new Error('hook boom')
        },
      }),
      {},
    )
    expect(await entry.run({}, ctx())).toBe('raw')
  })

  test('失败也过 finalizeContent：错误文案被改写，类型与 message 保留', async () => {
    const entry = dshToolToEntry(
      definition({
        execute: async () => {
          throw new Error('原始错误')
        },
        finalizeContent: (_exec, result) => {
          const view = result as { isError?: boolean }
          return view.isError === true ? [{ type: 'text', text: '截断后的错误' }] : undefined
        },
      }),
      {},
    )
    await expect(entry.run({}, ctx())).rejects.toThrow('截断后的错误')
  })

  test('presentCall / presentResult / presentationMeta 合成卡片', async () => {
    const entry = dshToolToEntry(
      definition({
        presentCall: (args) => ({ card: 'generic', title: String((args as { path?: string }).path) }),
        presentResult: (_args, result) => ({ card: 'generic', text: String((result as { text?: string }).text) }),
        output: { presentationMeta: () => ({ kind: 'demo' }) },
      }),
      {},
    )
    const out = await entry.run({ path: 'a.txt' }, ctx())
    expect(out).toMatchObject({
      presentation: {
        call: { card: 'generic', title: 'a.txt' },
        result: { card: 'generic', text: expect.any(String) },
        meta: { kind: 'demo' },
      },
    })
  })
})

describe('超时与并发分类', () => {
  test('timeoutMs 到点拒绝（协作式）', async () => {
    const entry = dshToolToEntry(
      definition({ timeoutMs: 20, execute: () => new Promise(() => undefined) }),
      {},
    )
    await expect(entry.run({}, ctx())).rejects.toThrow(/超时（20ms）/)
  })

  test('isConcurrencySafe 只认明确的 true；抛错当独占', () => {
    const safe = dshToolToEntry(definition({ isConcurrencySafe: () => true }), {})
    expect(safe.isConcurrencySafe?.({})).toBe(true)
    const unsafe = dshToolToEntry(definition({ isConcurrencySafe: () => 'yes' }), {})
    expect(unsafe.isConcurrencySafe?.({})).toBe(false)
    const throwing = dshToolToEntry(
      definition({
        isConcurrencySafe: () => {
          throw new Error('boom')
        },
      }),
      {},
    )
    expect(throwing.isConcurrencySafe?.({})).toBe(false)
  })

  test('没有 isConcurrencySafe 就不挂这个字段', () => {
    expect(dshToolToEntry(definition(), {}).isConcurrencySafe).toBeUndefined()
  })
})

describe('dshToolsFacade', () => {
  test('register 收 dsh 定义并转成 entry；risk 每次注册现读', () => {
    const registered: Array<{ name: string; risk: string }> = []
    let risk: 'read' | 'write' | 'exec' = 'read'
    const facade = dshToolsFacade(
      (entry) => {
        registered.push({ name: entry.name, risk: entry.risk })
        return () => undefined
      },
      () => ({ risk }),
    ) as { register: (value: unknown) => () => void }

    facade.register(definition())
    risk = 'write'
    facade.register(definition({ name: 'second' }))
    expect(registered).toEqual([
      { name: 'demo', risk: 'read' },
      { name: 'second', risk: 'write' },
    ])
  })

  test('非 dsh 定义当场报错；不支持的成员响亮报错', () => {
    const facade = dshToolsFacade(
      () => () => undefined,
      () => ({}),
    ) as { register: (value: unknown) => void; list?: () => void }
    expect(() => facade.register({ name: 'x' })).toThrow(/不是 dsh 风格/)
    expect(() => facade.register({ name: 'x', execute: () => undefined, run: () => undefined })).toThrow(/不是 dsh 风格/)
    expect(() => facade.list).toThrow(/只支持 ctx\.tools\.register/)
  })
})
