/**
 * 工具守卫链（`core/tool-guards.ts`）的补齐：观察者注册/退订、会话归属解析器的
 * 多跳与成环保护、守卫抛错按拒处理（fail closed）、审批包装的三档。
 *
 * @module dsc/core/w12-tool-guards.spec
 */
import { describe, expect, test } from 'vitest'
import type { ToolGuard, ToolGuardInput } from './tool-guards.js'
import { ToolGuardRegistry, toolApprovalGuard } from './tool-guards.js'

/** 一次守卫入参：只填被测逻辑会读的字段。 */
function input(sessionId = 's1'): ToolGuardInput {
  return {
    toolName: 'bash',
    risk: 'exec',
    cwd: '/work',
    args: {},
    signal: new AbortController().signal,
    sessionId,
    sessionPath: `/sessions/${sessionId}.jsonl`,
  }
}

describe('ToolGuardRegistry 的注册面', () => {
  test('chain 按 order 升序、同 order 按 id 稳定排序', () => {
    const registry = new ToolGuardRegistry()
    const make = (id: string, order: number): ToolGuard => ({
      id,
      order,
      decide: () => ({ action: 'defer' }),
    })
    registry.register(make('b', 30))
    registry.register(make('a', 30))
    registry.register(make('floor', 5))
    expect(registry.chain.map((guard) => guard.id)).toEqual(['floor', 'a', 'b'])
  })

  test('观察者按 order 串行加工；同 id 顶替后旧退订不误删新注册', () => {
    const registry = new ToolGuardRegistry()
    const first = registry.registerObserver({ id: 'redact', order: 10, observe: (_n, t) => `[1]${t}` })
    const second = registry.registerObserver({ id: 'redact', order: 10, observe: (_n, t) => `[2]${t}` })
    expect(registry.observe('bash', 'x')).toBe('[2]x')
    // 旧退订函数看到的是新注册者，不能把新注册者删掉。
    first()
    expect(registry.observe('bash', 'x')).toBe('[2]x')
    second()
    expect(registry.observe('bash', 'x')).toBe('x')
  })

  test('观察者按 order 从小到大，后一位看到前一位的输出', () => {
    const registry = new ToolGuardRegistry()
    registry.registerObserver({ id: 'later', order: 20, observe: (_n, t) => `${t}+later` })
    registry.registerObserver({ id: 'earlier', order: 10, observe: (_n, t) => `${t}+earlier` })
    expect(registry.observe('bash', 'raw')).toBe('raw+earlier+later')
  })
})

describe('会话归属解析', () => {
  test('多个解析器按取第一个认得出的；facts 并进入参且身份被改写', () => {
    const registry = new ToolGuardRegistry()
    const noop = registry.registerSessionResolver('noop', () => undefined)
    registry.registerSessionResolver('team', (sessionId) =>
      sessionId === 'child' ? { sessionId: 'parent', sessionPath: '/p.jsonl', facts: { teammate: 'cov' } } : undefined,
    )
    const resolved = registry.resolveSession(input('child'))
    expect(resolved.sessionId).toBe('parent')
    expect(resolved.sessionPath).toBe('/p.jsonl')
    // 解析器并进来的 `facts` 是开放键（见 `ToolGuardSessionAlias.facts`），不写进 `ToolGuardInput` 的固定字段。
    expect(resolved).toMatchObject({ teammate: 'cov' })
    // 认不出时返回同一个对象（非队友调用不付拷贝代价）。
    const untouched = input('solo')
    expect(registry.resolveSession(untouched)).toBe(untouched)
    noop()
  })

  test('别名成环时在 MAX 跳前停住，不无限套', () => {
    const registry = new ToolGuardRegistry()
    registry.registerSessionResolver('cycle', (sessionId) =>
      sessionId === 'a' ? { sessionId: 'b', sessionPath: '/b.jsonl' } : { sessionId: 'a', sessionPath: '/a.jsonl' },
    )
    const resolved = registry.resolveSession(input('a'))
    expect(resolved.sessionId).toBe('b')
  })

  test('解析器退订后不再生效；同 id 顶替后旧退订不误删', () => {
    const registry = new ToolGuardRegistry()
    const old = registry.registerSessionResolver('r', () => ({ sessionId: 'x', sessionPath: '/x.jsonl' }))
    registry.registerSessionResolver('r', () => ({ sessionId: 'y', sessionPath: '/y.jsonl' }))
    expect(registry.resolveSession(input('start')).sessionId).toBe('y')
    old()
    expect(registry.resolveSession(input('start')).sessionId).toBe('y')
  })
})

describe('gate 的裁决', () => {
  test('第一位非 defer 的裁决赢：deny 原样返回、pass 放行后不再问后面', async () => {
    const registry = new ToolGuardRegistry()
    let laterAsked = false
    registry.register({ id: 'first', order: 10, decide: () => ({ action: 'pass' }) })
    registry.register({
      id: 'later',
      order: 20,
      decide: () => {
        laterAsked = true
        return { action: 'deny', reason: '不该问到我' }
      },
    })
    await expect(registry.gate(input())).resolves.toEqual({ action: 'pass' })
    expect(laterAsked).toBe(false)
  })

  test('全链 defer 时放行（defer）；守卫抛错一律按拒（fail closed）', async () => {
    const registry = new ToolGuardRegistry()
    registry.register({ id: 'quiet', order: 10, decide: async () => ({ action: 'defer' }) })
    await expect(registry.gate(input())).resolves.toEqual({ action: 'defer' })

    registry.register({
      id: 'broken',
      order: 20,
      decide: () => {
        throw new Error('守卫内部炸了')
      },
    })
    const denied = await registry.gate(input())
    expect(denied.action).toBe('deny')
    if (denied.action === 'deny') expect(denied.reason).toContain('守卫内部炸了')

    // 抛非 Error 也把值转成文字，不吞成空串。
    const registry2 = new ToolGuardRegistry()
    registry2.register({
      id: 'broken-string',
      order: 30,
      decide: () => {
        throw '字符串错误'
      },
    })
    const denied2 = await registry2.gate(input())
    if (denied2.action === 'deny') expect(denied2.reason).toContain('字符串错误')
  })
})

describe('toolApprovalGuard', () => {
  test('只读工具不问人直接 defer；危险工具按审批结果给 pass / deny', async () => {
    const asked: string[] = []
    const guard = toolApprovalGuard({
      id: 'approval',
      deniedReason: '用户拒绝了这次调用',
      approve: async (item) => {
        asked.push(item.toolName)
        return item.toolName === 'bash'
      },
    })
    expect(guard.order).toBe(30)
    expect(await guard.decide({ ...input(), risk: 'read' })).toEqual({ action: 'defer' })
    expect(asked).toEqual([])
    expect(await guard.decide({ ...input(), toolName: 'bash', risk: 'exec' })).toEqual({ action: 'pass' })
    expect(await guard.decide({ ...input(), toolName: 'write_file', risk: 'write' })).toEqual({
      action: 'deny',
      reason: '用户拒绝了这次调用',
    })
  })
})
