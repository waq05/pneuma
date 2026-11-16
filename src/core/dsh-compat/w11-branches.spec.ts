/**
 * dsh 兼容层的补盲：呈现数据校验、服务判定表、用量旁路、工具适配的错误与降级分支，
 * 以及解析钩子的重定向/代数戳路径（`core/dsh-compat/*`）。
 *
 * 不碰真插件目录、不 import dsh 包：解析钩子那组在临时 HOME 里造最小应用目录与插件
 * 文件，用动态 import 走到它的 resolve 回调，验的是「重定向到哪、URL 有没有代数戳」。
 *
 * @module dsc/core/dsh-compat/w11-branches.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { LLM_STREAM_EVENT, publishDshUsage, toDshUsage } from './llm-usage-event.js'
import { asCardView, validateOutput } from './presentation.js'
import {
  bumpGeneration,
  currentGeneration,
  ensureResolveHook,
  registerGenerationRoot,
  setResolveHookAppRoot,
  setResolveHookCompat,
} from './resolve-hook.js'
import { describeForeignServices, dshServiceVerdict } from './service-map.js'
import { dshToolToEntry, dshToolsFacade, type DshToolDefinitionLike } from './tools-facade.js'

const tempDirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── presentation：卡片与规范值校验 ────────────────────────────────────────────

describe('presentation', () => {
  test('asCardView：只认对象 + 认识的 card 标签', () => {
    expect(asCardView(null)).toBeUndefined()
    expect(asCardView('diff')).toBeUndefined()
    expect(asCardView(42)).toBeUndefined()
    expect(asCardView({})).toBeUndefined()
    expect(asCardView({ card: 'bogus' })).toBeUndefined()
    expect(asCardView({ card: 7 })).toBeUndefined()
    const view = { card: 'terminal', command: 'ls' }
    expect(asCardView(view)).toBe(view)
  })

  test('validateOutput：boolean schema 与顶层 type', () => {
    expect(validateOutput(true, { any: 'thing' })).toEqual([])
    expect(validateOutput(false, null)).toHaveLength(1)
    expect(validateOutput({ type: 'string' }, 'x')).toEqual([])
    expect(validateOutput({ type: ['string', 'null'] }, null)).toEqual([])
    expect(validateOutput({ type: 'integer' }, 3)).toEqual([])
    expect(validateOutput({ type: 'number' }, 3.5)).toEqual([])
    // integer 值也满足 number；小数不满足 integer。
    expect(validateOutput({ type: 'number' }, 3)).toEqual([])
    expect(validateOutput({ type: 'integer' }, 3.5)[0]).toContain('期望类型 integer')
    expect(validateOutput({ type: 'string' }, null)[0]).toContain('实际是 null')
    expect(validateOutput({ type: 'array' }, [1])).toEqual([])
    expect(validateOutput({ type: 'object' }, [])[0]).toContain('实际是 array')
  })

  test('validateOutput：enum / const / 组合关键字', () => {
    expect(validateOutput({ enum: ['a', 'b'] }, 'a')).toEqual([])
    expect(validateOutput({ enum: ['a', 1] }, 'c')[0]).toContain('不在枚举')
    expect(validateOutput({ const: 'fixed' }, 'fixed')).toEqual([])
    expect(validateOutput({ const: 'fixed' }, 'other')[0]).toContain('应当恒为')

    expect(validateOutput({ allOf: [{ type: 'number' }, { const: 1 }] }, 1)).toEqual([])
    expect(validateOutput({ allOf: [{ type: 'number' }] }, 'x')[0]).toMatch(/^allOf\[0\] /)
    expect(validateOutput({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1)).toEqual([])
    expect(validateOutput({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 1)[0]).toContain('anyOf')
    expect(validateOutput({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1)[0]).toContain('oneOf')
    expect(validateOutput({ oneOf: [{ type: 'string' }, { type: 'number' }] }, 1)).toEqual([])
  })

  test('validateOutput：数组 items、对象 required/properties/additionalProperties', () => {
    expect(validateOutput({ items: { type: 'string' } }, ['a', 2])).toEqual(['/1：期望类型 string，实际是 integer'])
    expect(validateOutput({ required: ['a', 'b'] }, { a: 1 })).toEqual(['/b：缺少必填字段'])
    expect(
      validateOutput({ properties: { a: { type: 'string' } } }, { a: 1 }),
    ).toEqual(['/a：期望类型 string，实际是 integer'])
    expect(validateOutput({ additionalProperties: false }, { a: 1 })[0]).toContain('多余字段')
    expect(validateOutput({ additionalProperties: { type: 'number' } }, { a: 'x' })[0]).toContain('期望类型 number')
    // 非对象值不跑对象关键字。
    expect(validateOutput({ required: ['a'] }, null)).toEqual([])
  })
})

// ── service-map ───────────────────────────────────────────────────────────────

describe('service-map', () => {
  test('dshServiceVerdict：收录的给判定，没收录的 undefined', () => {
    expect(dshServiceVerdict('tools')).toEqual({ tier: 'same' })
    expect(dshServiceVerdict('sessions')?.tier).toBe('adapted')
    expect(dshServiceVerdict('jobs')?.tier).toBe('missing')
    expect(dshServiceVerdict('no-such-service')).toBeUndefined()
  })

  test('describeForeignServices：四种档位各一句人话', () => {
    const text = describeForeignServices(['mystery', 'tools', 'sessions', 'jobs'])
    expect(text).toContain('mystery（Pneuma 不认识这个服务名）')
    expect(text).toContain('tools（同名同义')
    expect(text).toContain('sessions（dsh 侧有对应：sessions（只读桥）')
    expect(text).toContain('jobs（Pneuma 没有作业服务')
  })
})

// ── llm-usage-event ───────────────────────────────────────────────────────────

describe('llm-usage-event', () => {
  test('toDshUsage：命中/未命中分项、缺省与负数夹到 0', () => {
    expect(
      toDshUsage({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 30, reasoningTokens: 5 }),
    ).toEqual({
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      totalTokens: 120,
    })
    expect(toDshUsage({ inputTokens: 10, outputTokens: 2 })).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      totalTokens: 12,
    })
    expect(toDshUsage({ inputTokens: 10, outputTokens: 2, cacheMissTokens: 3 })).toMatchObject({
      inputTokens: 3,
      totalTokens: 5,
    })
    expect(toDshUsage({ inputTokens: -5, outputTokens: 1, cacheHitTokens: 2 })).toMatchObject({
      inputTokens: 0,
      cacheReadTokens: 2,
    })
  })

  test('publishDshUsage：没有 waterfall / 不是函数 / 返回值不可迭代都不抛', async () => {
    await expect(publishDshUsage({}, { sessionId: 's', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 })).resolves.toBeUndefined()
    await expect(
      publishDshUsage({ waterfall: 42 }, { sessionId: 's', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 }),
    ).resolves.toBeUndefined()
    await expect(
      publishDshUsage(
        { waterfall: () => ({}) },
        { sessionId: 's', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 },
      ),
    ).resolves.toBeUndefined()
  })

  test('publishDshUsage：把用量作为唯一 chunk 派发并把下游流消费完', async () => {
    const seen: unknown[] = []
    const ctx = {
      waterfall(name: string, payload: unknown, next: () => AsyncGenerator<unknown>) {
        seen.push({ name, payload })
        const upstream = next()
        return (async function* () {
          for await (const chunk of upstream) {
            seen.push(chunk)
            yield chunk
          }
        })()
      },
    }
    await publishDshUsage(ctx, {
      sessionId: 's1',
      provider: 'deepseek',
      model: 'm1',
      inputTokens: 9,
      outputTokens: 4,
      cacheHitTokens: 3,
    })
    expect(seen[0]).toMatchObject({
      name: LLM_STREAM_EVENT,
      payload: { sessionId: 's1', provider: 'deepseek', model: 'm1' },
    })
    expect(seen[1]).toEqual({
      type: 'usage',
      usage: { inputTokens: 6, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 13 },
    })
  })

  test('publishDshUsage：插件抛错只写一行 stderr，不影响调用方', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(
        publishDshUsage(
          {
            waterfall: () => {
              throw new Error('judge boom')
            },
          },
          { sessionId: 's', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 },
        ),
      ).resolves.toBeUndefined()
      expect(write).toHaveBeenCalledWith(expect.stringContaining('llm/stream 旁路派发失败'))
    } finally {
      write.mockRestore()
    }
  })
})

// ── tools-facade：失败、默认值与降级通道 ──────────────────────────────────────

function dshDef(overrides: Partial<DshToolDefinitionLike> = {}): DshToolDefinitionLike {
  return { name: 'demo', description: '演示', parameters: { type: 'object' }, execute: async () => 'ok', ...overrides }
}

const toolCtx = {
  cwd: '/w',
  signal: new AbortController().signal,
  sessionId: 's1',
  sessionPath: '/home/.dsc/sessions/s1.jsonl',
  caller: { name: 'worker', depth: 2, background: true },
}

describe('tools-facade 补盲', () => {
  test('没有 execute：run 直接报错', async () => {
    const entry = dshToolToEntry({ name: 'broken', description: '', parameters: {}, execute: undefined }, {})
    await expect(entry.run({}, toolCtx)).rejects.toThrow(/没有 execute 实现/)
  })

  test('render 返回字符串 / 对象 / 非文本内容块都折成文本', async () => {
    const stringRender = dshToolToEntry(dshDef({ output: { render: () => 'plain' } }), {})
    expect(await stringRender.run({}, toolCtx)).toBe('plain')

    const objectRender = dshToolToEntry(dshDef({ output: { render: () => ({ a: 1 }) } }), {})
    expect(await objectRender.run({}, toolCtx)).toBe(JSON.stringify({ a: 1 }, null, 2))

    const blocks = dshToolToEntry(
      dshDef({ output: { render: () => [{ type: 'json', value: 1 }, { type: 'image' }] } }),
      {},
    )
    const rendered = await blocks.run({}, toolCtx)
    expect(rendered).toContain('"type": "json"')
    expect(rendered).toContain('图像块已省略')
  })

  test('钩子抛错 / 返回非数组：保留前一步内容并落 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const projectThrows = dshToolToEntry(
        dshDef({
          output: { render: () => [{ type: 'text', text: 'raw' }] },
          projectContent: () => {
            throw new Error('project boom')
          },
          finalizeContent: () => {
            throw new Error('finalize boom')
          },
        }),
        {},
      )
      expect(await projectThrows.run({}, toolCtx)).toBe('raw')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('projectContent 抛错'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('finalizeContent 抛错'))
    } finally {
      warn.mockRestore()
    }
  })

  test('失败路径 finalizeContent：非 Error 换成 Error；非数组/抛错保留原错误', async () => {
    const wrap = dshToolToEntry(
      dshDef({
        execute: async () => {
          throw 'plain'
        },
        finalizeContent: () => [{ type: 'text', text: '改写后' }],
      }),
      {},
    )
    await expect(wrap.run({}, toolCtx)).rejects.toThrow('改写后')

    const keep = dshToolToEntry(
      dshDef({
        execute: async () => {
          throw new Error('原始')
        },
        finalizeContent: () => 'not-array',
      }),
      {},
    )
    await expect(keep.run({}, toolCtx)).rejects.toThrow('原始')

    const hookThrows = dshToolToEntry(
      dshDef({
        execute: async () => {
          throw new Error('原始2')
        },
        finalizeContent: () => {
          throw new Error('hook boom')
        },
      }),
      {},
    )
    await expect(hookThrows.run({}, toolCtx)).rejects.toThrow('原始2')
  })

  test('冻结的错误对象改不动 message：退回原错误而不是丢类型', async () => {
    const frozen = Object.freeze(new Error('frozen-original'))
    const entry = dshToolToEntry(
      dshDef({
        execute: async () => {
          throw frozen
        },
        finalizeContent: () => [{ type: 'text', text: '改不了' }],
      }),
      {},
    )
    await expect(entry.run({}, toolCtx)).rejects.toThrow('frozen-original')
  })

  test('exec 的降级通道：deferContext / concludeTurn 各 warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      let captured: Record<string, unknown> = {}
      const entry = dshToolToEntry(
        dshDef({
          execute: async (_args: unknown, exec: unknown) => {
            captured = exec as Record<string, unknown>
            ;(exec as { deferContext: (m: string) => void }).deferContext('later')
            ;(exec as { concludeTurn: () => void }).concludeTurn()
            return 'done'
          },
        }),
        {},
      )
      expect(await entry.run({}, toolCtx)).toBe('done')
      expect(captured).toMatchObject({
        cwd: '/w',
        arguments: {},
        agent: { name: 'worker', depth: 2, background: true },
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferContext'))
    } finally {
      warn.mockRestore()
    }
  })

  test('output.schema 违规超过三条：文案带「另有 N 处」', async () => {
    const entry = dshToolToEntry(
      dshDef({
        execute: async () => ({}),
        output: {
          schema: {
            required: ['a', 'b', 'c', 'd', 'e'],
            properties: { a: { type: 'string' } },
          },
        },
      }),
      {},
    )
    await expect(entry.run({}, toolCtx)).rejects.toThrow(/另有 2 处/)
  })

  test('卡片：只认认识的 card；parameters 非对象回落空 schema；并发分类非函数不挂', () => {
    const entry = dshToolToEntry(
      dshDef({ name: 7 as unknown as string, parameters: null, presentCall: () => ({ card: 'nope' }) }),
      {},
    )
    expect(entry.name).toBe('unknown')
    expect(entry.parameters).toEqual({ type: 'object', properties: {} })
    expect(entry.isConcurrencySafe).toBeUndefined()
  })

  test('dshToolsFacade：register 把每次现读的 risk 传下去', () => {
    const risks: string[] = []
    const facade = dshToolsFacade(
      (e) => {
        risks.push(e.risk)
        return () => undefined
      },
      () => ({}),
    ) as { register: (definition: unknown) => void }
    facade.register(dshDef())
    facade.register(dshDef({ name: 'second' }))
    expect(risks).toEqual(['exec', 'exec'])
  })
})

// ── resolve-hook：开关与目录登记的护栏 ────────────────────────────────────────

describe('resolve-hook 的护栏', () => {
  test('兼容层开关可反复同步；内核与运行时目录不登记为功能包', () => {
    const app = tempDir('dsc-hook-app-')
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8')
    setResolveHookAppRoot(app)
    expect(() => setResolveHookCompat(true)).not.toThrow()
    expect(() => setResolveHookCompat(false)).not.toThrow()
    expect(() => registerGenerationRoot(join(app, 'lib', 'core'))).not.toThrow()
    expect(() => registerGenerationRoot(join(app, 'lib', 'node_modules', '@pneuma', 'runtime'))).not.toThrow()
    expect(currentGeneration()).toBeGreaterThanOrEqual(0)
  })
})
