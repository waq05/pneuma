/**
 * 缓存归因探针与工具定义排序（`packages/agent/cache-probe.ts`）。
 *
 * 钉两件事：
 * 1. 断点判定（system 变 / tools 变 / 第 3 条消息变 / 只追加）与来源标记对得上，
 *    关闭开关时一个字节都不算、不记；
 * 2. 工具定义按名字排序：浅拷贝、不改原请求、非工具字段原样、两次不同注册顺序
 *    序列化结果逐字节相同。
 *
 * 这些用例直接喂假 `StreamRequest`，不经过真内核：断点判定是纯函数，起内核只会
 * 把断言拖进流与插件的时序里。
 *
 * @module dsc/packages/agent/tests/cache-probe.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChatMessage, StreamRequest, ToolSchema } from '@pneuma/runtime/core/llm.js'
import { CacheProbe, cacheProbeEnabled, comparePrefix, requestPrefix, sortToolSchemas } from '../cache-probe.js'

/** 一条系统提示消息。 */
const system = (text: string): ChatMessage => ({ role: 'system', content: text })
/** 一条用户消息。 */
const user = (text: string): ChatMessage => ({ role: 'user', content: text })
/** 一条助手消息。 */
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text })

/** 一个最小工具定义（名字不同即定义不同）。 */
const tool = (name: string): ToolSchema => ({
  name,
  description: `${name} 的说明`,
  parameters: { type: 'object', properties: {} },
})

/** 基准请求：system + 三条对话消息。 */
const BASE_MESSAGES: ChatMessage[] = [system('提示 A'), user('第一问'), assistant('答一'), user('第二问')]

beforeEach(() => {
  process.env['DSC_CACHE_PROBE'] = '1'
})

afterEach(() => {
  delete process.env['DSC_CACHE_PROBE']
})

describe('开关', () => {
  test('只认字面 1：默认关，true / false / 空串都当关', () => {
    delete process.env['DSC_CACHE_PROBE']
    expect(cacheProbeEnabled()).toBe(false)
    process.env['DSC_CACHE_PROBE'] = 'true'
    expect(cacheProbeEnabled()).toBe(false)
    process.env['DSC_CACHE_PROBE'] = '0'
    expect(cacheProbeEnabled()).toBe(false)
    process.env['DSC_CACHE_PROBE'] = '1'
    expect(cacheProbeEnabled()).toBe(true)
  })

  test('关着时 observe 不算签名、不记会话，take 恒为 undefined', () => {
    delete process.env['DSC_CACHE_PROBE']
    const probe = new CacheProbe()
    probe.observe('s1', { messages: BASE_MESSAGES })
    probe.observe('s1', { messages: [system('提示 B'), ...BASE_MESSAGES.slice(1)] })
    expect(probe.trackedSessions).toBe(0)
    expect(probe.take('s1')).toBeUndefined()
  })
})

describe('断点判定（四种场景）', () => {
  /** 先记一次基准请求，再记一次改过的，返回那次的断点。 */
  function breakAfter(baseline: RequestPrefixInput, changed: RequestPrefixInput): ReturnType<CacheProbe['take']> {
    const probe = new CacheProbe()
    probe.observe('s1', baseline)
    probe.observe('s1', changed)
    return probe.take('s1')
  }

  test('会话第一次请求没有可比的上一次：不产生断点', () => {
    const probe = new CacheProbe()
    probe.observe('s1', { messages: BASE_MESSAGES })
    expect(probe.take('s1')).toBeUndefined()
  })

  test('system 变：断在第 0 条，sys 标记，role=system', () => {
    expect(breakAfter({ messages: BASE_MESSAGES }, { messages: [system('提示 B'), ...BASE_MESSAGES.slice(1)] })).toEqual({
      at: 0,
      role: 'system',
      sys: true,
    })
  })

  test('tools 变：消息前缀没变，at=-1，只带 tools 标记', () => {
    const baseline = { messages: BASE_MESSAGES, tools: [tool('bash'), tool('read')] }
    const changed = { messages: BASE_MESSAGES, tools: [tool('bash'), tool('read'), tool('write')] }
    expect(breakAfter(baseline, changed)).toEqual({ at: -1, tools: true })
  })

  test('工具定义只是顺序不同：不算断点（签名按名字排序）', () => {
    const baseline = { messages: BASE_MESSAGES, tools: [tool('bash'), tool('read'), tool('write')] }
    const changed = { messages: BASE_MESSAGES, tools: [tool('write'), tool('bash'), tool('read')] }
    expect(breakAfter(baseline, changed)).toBeUndefined()
  })

  test('第 3 条消息内容变：断在下标 2，带该条角色', () => {
    const changed = [...BASE_MESSAGES]
    changed[2] = assistant('答一（改写）')
    expect(breakAfter({ messages: BASE_MESSAGES }, { messages: changed })).toEqual({ at: 2, role: 'assistant' })
  })

  test('只追加消息（旧前缀全同、长度变长）不算断点', () => {
    expect(breakAfter({ messages: BASE_MESSAGES }, { messages: [...BASE_MESSAGES, user('第三问')] })).toBeUndefined()
  })

  test('消息变短（压缩删历史）：断在被删掉的第一条', () => {
    expect(
      breakAfter({ messages: BASE_MESSAGES }, { messages: [system('提示 A'), user('第一问')] }),
    ).toEqual({ at: 2, role: 'assistant' })
  })

  test('system 变 + 消息只追加：断点落在 system 上（at=0, sys）', () => {
    expect(
      breakAfter(
        { messages: BASE_MESSAGES },
        { messages: [system('提示 B'), ...BASE_MESSAGES, user('第三问')] },
      ),
    ).toEqual({ at: 0, role: 'system', sys: true })
  })

  test('take 取走即清：同一条请求不会被重复归因', () => {
    const probe = new CacheProbe()
    probe.observe('s1', { messages: BASE_MESSAGES })
    probe.observe('s1', { messages: [system('提示 B'), ...BASE_MESSAGES.slice(1)] })
    expect(probe.take('s1')).toBeDefined()
    expect(probe.take('s1')).toBeUndefined()
  })

  test('会话之间互不干扰：两条会话各比各的', () => {
    const probe = new CacheProbe()
    probe.observe('s1', { messages: BASE_MESSAGES })
    probe.observe('s2', { messages: [system('别的会话'), user('x')] })
    probe.observe('s2', { messages: [system('别的会话'), user('y')] })
    expect(probe.take('s1')).toBeUndefined()
    expect(probe.take('s2')).toEqual({ at: 1, role: 'user' })
  })
})

describe('有界保留', () => {
  test('最多记 64 条会话，超出淘汰最久没动的那条', () => {
    const probe = new CacheProbe()
    for (let index = 0; index < 65; index += 1) {
      probe.observe(`s${String(index)}`, { messages: [system('提示'), user(String(index))] })
    }
    expect(probe.trackedSessions).toBe(64)
    // s0 被淘汰：再记一次变化后的请求时没有上一次可比，拿不到断点。
    probe.observe('s0', { messages: [system('提示改了'), user('0')] })
    expect(probe.take('s0')).toBeUndefined()
    // 最近记过的 s64 还在：第二次变化照常给出断点。
    probe.observe('s64', { messages: [system('提示'), user('64 改了')] })
    expect(probe.take('s64')).toEqual({ at: 1, role: 'user' })
  })
})

describe('签名本身', () => {
  test('同一份请求签名稳定；ts 这类不上 wire 的字段不参与', () => {
    const withTs = BASE_MESSAGES.map((message) => ({ ...message, ts: 123 }))
    expect(requestPrefix({ messages: withTs })).toEqual(requestPrefix({ messages: BASE_MESSAGES }))
  })

  test('内容 / 工具 / 系统提示任一变化都会改签名', () => {
    const base = requestPrefix({ messages: BASE_MESSAGES, tools: [tool('bash')] })
    const changedMessage = requestPrefix({
      messages: [BASE_MESSAGES[0]!, user('第一问（改）'), ...BASE_MESSAGES.slice(2)],
      tools: [tool('bash')],
    })
    const changedTools = requestPrefix({ messages: BASE_MESSAGES, tools: [tool('read')] })
    expect(changedMessage.messages).not.toEqual(base.messages)
    expect(changedTools.tools).not.toBe(base.tools)
    // 系统提示独立成一份，消息里也含它：两边都会变，断点仍落在第 0 条。
    const changedSystem = requestPrefix({ messages: [system('提示 B'), ...BASE_MESSAGES.slice(1)], tools: [tool('bash')] })
    expect(changedSystem.system).not.toBe(base.system)
    expect(comparePrefix(base, changedSystem)).toMatchObject({ at: 0, sys: true })
  })
})

describe('工具定义确定性排序', () => {
  test('按名字字典序、浅拷贝、原请求不动、非工具字段原样', () => {
    const request: StreamRequest = {
      baseUrl: 'http://fake',
      apiKey: 'k',
      model: 'm',
      messages: BASE_MESSAGES,
      tools: [tool('write'), tool('bash'), tool('read')],
      temperature: 0.2,
      sessionId: 's1',
    }
    const sorted = sortToolSchemas(request)
    expect(sorted.tools?.map((item) => item.name)).toEqual(['bash', 'read', 'write'])
    // 原请求一个字节都不动（浅拷贝，不改调用方那份）。
    expect(request.tools?.map((item) => item.name)).toEqual(['write', 'bash', 'read'])
    // 非工具字段原样带过去。
    const { tools: sortedTools, ...restSorted } = sorted
    const { tools: requestTools, ...restRequest } = request
    expect(restSorted).toEqual(restRequest)
    expect(sortedTools).not.toBe(requestTools)
  })

  test('两次组装注册顺序不同 → 序列化逐字节相同', () => {
    const make = (names: string[]): StreamRequest => ({
      baseUrl: 'http://fake',
      apiKey: 'k',
      model: 'm',
      messages: BASE_MESSAGES,
      tools: names.map(tool),
    })
    expect(JSON.stringify(sortToolSchemas(make(['write', 'bash', 'read'])))).toBe(
      JSON.stringify(sortToolSchemas(make(['read', 'write', 'bash']))),
    )
  })

  test('没有工具（undefined / 空数组）原样返回同一个对象', () => {
    const withoutTools: StreamRequest = { baseUrl: 'http://fake', apiKey: 'k', model: 'm', messages: BASE_MESSAGES }
    expect(sortToolSchemas(withoutTools)).toBe(withoutTools)
    const emptyTools: StreamRequest = { ...withoutTools, tools: [] }
    expect(sortToolSchemas(emptyTools)).toBe(emptyTools)
  })
})

/** `observe` 只吃消息与工具两栏，测试里用这个别名省得写全 `StreamRequest`。 */
type RequestPrefixInput = Parameters<CacheProbe['observe']>[1]
