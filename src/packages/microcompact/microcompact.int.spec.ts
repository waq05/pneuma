/**
 * 每轮旧工具结果微压缩（迁自 `scripts/microcompact-test.mjs`）。
 *
 * 契约见 `docs/context-token-plan.md` 的「### WS1 每轮旧工具结果微压缩」。四段：
 *   [1] 纯函数：保留窗口 / 最小节省门槛 / 各类跳过 / 幂等 / 不改输入 / 工具名回填——把跳过
 *       规则逐条钉成行为；
 *   [1b] 冻结计划：同一轮的清理集合可以原样复用（轮次键只数真人发言）；
 *   [1c] 插件策略：清理量不到门槛就一条都不清、队友汇报不翻轮、`provide` 的 projectedTokens；
 *   [2] 接线：真内核里注册的 `microcompact` 投影落在 env-facts(600) 与 drop-images(900)
 *       中间（用两条 649 / 651 哨兵投影夹出微压缩到底在哪一段跑），配置开关也在这里验；
 *   [3] 端到端：真内核 + 假端点跑一段八次工具调用 + 一轮新对话，断言**后一轮请求体**里旧的
 *       工具结果已变占位符，而会话日志原文一个字节没动。
 *
 * @module dsc/packages/microcompact/microcompact.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { ChatContentPart } from '@pneuma/runtime/core/llm.js'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-microcompact-')

type MicrocompactModule = typeof import('./microcompact.js')
type MicrocompactPluginModule = typeof import('./index.js')

let micro: MicrocompactModule
let pluginModule: MicrocompactPluginModule
let llm: FakeLLM
let kernel: BootedKernel

/**
 * 一条够长、够「像日志」的正文：约 4500 个汉字 ≈ 2900 token（稳稳超过 256 的门槛）。
 *
 * 为什么是 4500 而不是更短：默认 `refresh:'budget'` 要「新增条目合计省够 8192 字符」
 * 才推进一次清理点。单条正文约 4500 字符、清一条省约 4485 字符，正好让「2 条候选」
 * （约 8970 字符）过推进线、「1 条候选」过不了——这样下面钉的「清 2 条 / 清 3 条」既有
 * 意义，又不会因为正文太短被预算卡住。
 */
const longText = (): string => `日志行：${'错'.repeat(4500)}`
/** 一段短正文：约 30 个汉字 ≈ 20 token（省不到 256，门槛以内）。 */
const shortText = (): string => '错误'.repeat(15)

/** 一条工具调用。 */
const toolCall = (id: string, name: string): { id: string; type: 'function'; function: { name: string; arguments: string } } => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
})
/** 一条带工具调用的 assistant。 */
const assistant = (id: string, name: string): ChatMessage => ({ role: 'assistant', content: '', tool_calls: [toolCall(id, name)] })
/** 一条工具结果。 */
const toolMsg = (id: string, content: string, extra: Record<string, unknown> = {}): ChatMessage =>
  ({ role: 'tool', content, tool_call_id: id, ...extra }) as ChatMessage
/** 这条工具结果是否已经变成占位符。 */
const isCleared = (content: unknown): boolean => typeof content === 'string' && content.startsWith('[旧工具结果已清理')

beforeAll(async () => {
  micro = await import('./microcompact.js')
  pluginModule = await import('./index.js')
})

describe('① 纯函数：保留窗口 / 门槛 / 跳过规则 / 幂等', () => {
  test('默认值与参考实现对齐（保留 5 条、最小省 256）', () => {
    expect(micro.DEFAULT_KEEP_RECENT_TOOL_RESULTS).toBe(5)
    expect(micro.DEFAULT_MIN_SAVE_TOKENS).toBe(256)
  })

  test('20 条里前 15 条被清，最后 5 条逐字未动', () => {
    // 保留窗口是「最近 5 条原文」：上下文刚用过的结果最可能还要看第二眼。
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '开跑' }]
    for (let index = 1; index <= 20; index += 1) messages.push(assistant(`c${String(index)}`, 'bash'), toolMsg(`c${String(index)}`, longText()))
    const out = micro.microcompact(messages, {})
    const outTools = out.filter((message) => message.role === 'tool')
    expect(outTools.filter((message) => isCleared(message.content))).toHaveLength(15)
    for (const message of outTools.slice(-5)) {
      const original = messages.find((item) => item.tool_call_id === message.tool_call_id)
      expect(message.content).toBe(original?.content)
    }
  })

  test('占位符回填真实工具名；条数与 role 序列不变；非 tool 条目原样传过', () => {
    // 工具名要留着：模型看到「bash 的结果已清理」才知道要不要重跑。
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '开跑' }]
    for (let index = 1; index <= 20; index += 1) messages.push(assistant(`c${String(index)}`, 'bash'), toolMsg(`c${String(index)}`, longText()))
    const out = micro.microcompact(messages, {})
    const outTools = out.filter((message) => message.role === 'tool')
    expect(outTools[0]?.content).toBe('[旧工具结果已清理：bash]')
    expect(out).toHaveLength(messages.length)
    expect(out.every((message, index) => message.role === messages[index]?.role)).toBe(true)
    expect(out[0]).toBe(messages[0])
    expect(out[1]).toBe(messages[1])
    expect(out[2]).toBe(messages[2])
  })

  test('不改输入数组，且幂等（连跑两次逐字节相等）', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    for (let index = 1; index <= 8; index += 1) messages.push(assistant(`c${String(index)}`, 'bash'), toolMsg(`c${String(index)}`, longText()))
    const before = JSON.stringify(messages)
    const out = micro.microcompact(messages, {})
    expect(JSON.stringify(messages)).toBe(before)
    expect(JSON.stringify(micro.microcompact(out, {}))).toBe(JSON.stringify(out))
  })

  test('省不到 256 token 的短结果不清；门槛设 0 时也清', () => {
    // 门槛是「清了不值」：占位符本身也要几十 token，省不到就是净亏。
    const shortList: ChatMessage[] = [
      { role: 'user', content: 'go' },
      assistant('s1', 'bash'),
      toolMsg('s1', shortText()),
      assistant('s2', 'bash'),
      toolMsg('s2', longText()),
    ]
    expect(micro.microcompact(shortList, { keepRecent: 1 })[2]?.content).toBe(shortText())
    expect(micro.microcompact(shortList, { keepRecent: 1, minSaveTokens: 0 })[2]?.content).toBe('[旧工具结果已清理：bash]')
  })

  test('keepRecent=0 时窗口不保护任何一条', () => {
    const twoLong: ChatMessage[] = [
      { role: 'user', content: 'go' },
      assistant('z1', 'bash'),
      toolMsg('z1', longText()),
      assistant('z2', 'bash'),
      toolMsg('z2', longText()),
    ]
    const zeroKeep = micro.microcompact(twoLong, { keepRecent: 0 })
    expect(isCleared(zeroKeep[2]?.content)).toBe(true)
    expect(isCleared(zeroKeep[4]?.content)).toBe(true)
  })

  test('跳过规则：失败结果 / 自带 error / 提到 image_url / 已 spill / 已是占位符 / 数组正文', () => {
    // 六条都用「2 条工具结果 + keepRecent 1」把第一条顶成候选。
    const firstToolAfter = (firstContent: string | ChatContentPart[], options: Record<string, unknown> = {}, firstExtra: Record<string, unknown> = {}): ChatMessage => {
      const list: ChatMessage[] = [
        { role: 'user', content: 'go' },
        assistant('a1', 'bash'),
        toolMsg('a1', firstContent as string, firstExtra),
        assistant('a2', 'bash'),
        toolMsg('a2', longText()),
      ]
      return micro.microcompact(list, { keepRecent: 1, ...options })[2] as ChatMessage
    }
    // 失败/被拒的结果不清：报错正文本身就是要重读的东西。
    expect(firstToolAfter(longText(), { errorCallIds: new Set(['a1']) }).content).toBe(longText())
    expect(firstToolAfter(longText(), {}, { error: 'tool-error' }).content).toBe(longText())
    expect(String(firstToolAfter(`${longText()} image_url: data:image/png;base64,AAA`).content).includes('image_url')).toBe(true)
    expect(String(firstToolAfter(`${longText()}\n[完整输出已落盘：C:\\tmp\\x.log]`).content).includes('[完整输出已落盘：')).toBe(true)
    expect(firstToolAfter('[旧工具结果已清理：bash]').content).toBe('[旧工具结果已清理：bash]')
    expect(Array.isArray(firstToolAfter([{ type: 'text', text: longText() }]).content)).toBe(true)
  })

  test('查不到工具名时只写「旧工具结果已清理」；没有工具结果时原样返回', () => {
    const orphan: ChatMessage[] = [{ role: 'user', content: 'go' }, toolMsg('p1', longText()), toolMsg('p2', longText())]
    expect(micro.microcompact(orphan, { keepRecent: 1 })[1]?.content).toBe('[旧工具结果已清理]')
    const plain: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    expect(JSON.stringify(micro.microcompact(plain, {}))).toBe(JSON.stringify(plain))
  })
})

describe('② 冻结计划：同一轮的清理集合可以原样复用', () => {
  /** 8 条工具结果的历史（最旧 3 条该进计划）。 */
  function eightResults(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '开跑' }]
    for (let index = 1; index <= 8; index += 1) messages.push(assistant(`p${String(index)}`, 'bash'), toolMsg(`p${String(index)}`, longText()))
    return messages
  }

  test('8 条结果里最旧 3 条进计划；计划只改那 3 条；再应用一次逐字节不变', () => {
    // 冻结到「轮」的理由：同一轮内计划不随着新结果往下滑，请求前缀才稳、服务端缓存才命中。
    const messages = eightResults()
    const plan = micro.planMicrocompact(messages, {})
    expect(plan.size).toBe(3)
    const applied = micro.applyMicrocompactPlan(messages, plan)
    expect(applied.filter((message) => isCleared(message.content))).toHaveLength(3)
    expect(applied.slice(-5).every((message) => !isCleared(message.content))).toBe(true)
    expect(JSON.stringify(micro.applyMicrocompactPlan(applied, plan))).toBe(JSON.stringify(applied))
  })

  test('轮次键只数真人发言：环境快照与任务提醒不算新一轮', () => {
    const messages = eightResults()
    const withSynthetic: ChatMessage[] = [
      ...messages,
      { role: 'user', content: '环境事实：\n- 今天：2026-10-28\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）' },
      { role: 'user', content: '（提醒：任务清单有未完成项，做完一步就把状态改掉）' },
    ]
    expect(micro.roundKeyOf(withSynthetic)).toBe(1)
    expect(micro.roundKeyOf([...withSynthetic, { role: 'user', content: '继续' }])).toBe(2)
  })

  test('队友汇报不改变轮次键，冻结计划也不受影响', () => {
    const messages = eightResults()
    const plan = micro.planMicrocompact(messages, {})
    const withReport: ChatMessage[] = [
      ...messages,
      { role: 'user', content: '<teammate-report id="s1">干完了：改了 3 个文件</teammate-report>' },
    ]
    expect(micro.roundKeyOf(withReport)).toBe(1)
    expect(JSON.stringify([...micro.planMicrocompact(withReport, {})])).toBe(JSON.stringify([...plan]))
  })
})

describe('③ 插件策略：清理量不到门槛不清 / 队友汇报不翻轮', () => {
  /** 插件 apply 的桩 ctx：只提供 apply 用到的那几个面。 */
  interface PluginHarness {
    projection: ((messages: ChatMessage[], session: unknown) => ChatMessage[]) | null
    section: {
      values(): { minFreePercent: number }
      save(key: string, value: unknown): unknown
    } | null
    provided: { projectedTokens(messages: readonly ChatMessage[]): number } | null
  }

  /** 装一次插件，拿到注册进去的三件东西。 */
  function mountPlugin(): PluginHarness {
    const out: PluginHarness = { projection: null, section: null, provided: null }
    const stub = {
      prompt: {
        registerProjection: (_id: string, fn: (messages: ChatMessage[], session: unknown) => ChatMessage[]) => {
          out.projection = fn
          return () => {}
        },
      },
      settings: {
        registerSection: (spec: PluginHarness['section']) => {
          out.section = spec
          return () => {}
        },
      },
      session: {
        current: () => {
          throw new Error('测试里应显式传会话')
        },
      },
      provide: (_name: string, service: PluginHarness['provided']) => {
        out.provided = service
        return () => {}
      },
      // 插件用 ctx.effect 注册（停用即注销）；桩 ctx 跟着 cordis 的语义跑一遍回调。
      effect: (execute: () => unknown) => {
        const off = execute()
        return typeof off === 'function' ? off : () => {}
      },
    }
    pluginModule.microcompactPlugin.apply(stub as never, {})
    return out
  }

  /** 一份假会话：投影只读 `meta.id` 与 `toolErrors`。 */
  const sessionOf = (id: string): { meta: { id: string }; toolErrors: Map<string, string> } => ({ meta: { id }, toolErrors: new Map() })

  /** n 条带长结果的工具往返。 */
  function conversation(count: number, text: string): ChatMessage[] {
    const list: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '开跑' }]
    for (let index = 1; index <= count; index += 1) list.push(assistant(`h${String(index)}`, 'bash'), toolMsg(`h${String(index)}`, text))
    return list
  }

  /** 一份消息里被清掉的条数。 */
  const cleared = (list: ChatMessage[]): number => list.filter((message) => message.role === 'tool' && isCleared(message.content)).length

  test('provide 了 microcompact 服务（projectedTokens）', () => {
    expect(typeof mountPlugin().provided?.projectedTokens).toBe('function')
  })

  test('设置分区默认 25%，能存盘读回，超过 80 也夹到 80', () => {
    // 区间外不留脏值：界面填 100 与填 80 应得到同一个结果。
    const { section } = mountPlugin()
    expect(section?.values().minFreePercent).toBe(25)
    section?.save('minFreePercent', 80)
    expect(section?.values().minFreePercent).toBe(80)
    section?.save('minFreePercent', 100)
    expect(section?.values().minFreePercent).toBe(80)
    section?.save('minFreePercent', 25)
  })

  test('清理量高于门槛时照旧清，脚本判定为值得清', () => {
    // 8 条长结果、正文约 16 千字符：清 3 条约省 6 千（约 37%），过 25% 门槛。
    const { projection } = mountPlugin()
    const roomy = conversation(8, longText())
    const roomyOut = projection?.(roomy, sessionOf('probe-roomy')) ?? roomy
    expect(cleared(roomyOut)).toBe(3)
    expect(micro.planWorthApplying(roomy, micro.planMicrocompact(roomy, {}), 25)).toBe(true)
  })

  test('清理量低于门槛时一条都不清（5.6 万字符里只省 6 千）', () => {
    // 系统提示被一条 4 万字符的说明撑大：清理省下的占比不够，清了只会让缓存前缀白变一次。
    const { projection } = mountPlugin()
    const diluted = conversation(8, longText())
    diluted[0] = { role: 'system', content: `sys${'说明'.repeat(20_000)}` }
    const dilutedOut = projection?.(diluted, sessionOf('probe-diluted')) ?? diluted
    expect(cleared(dilutedOut)).toBe(0)
    expect(micro.planWorthApplying(diluted, micro.planMicrocompact(diluted, {}), 25)).toBe(false)
  })

  test('队友汇报后计划仍冻结：仍只清首轮那 2 条', () => {
    // 汇报若被当成新的一轮，会重算成「8 条清 3 条」；冻结生效则仍只清首轮那 2 条。
    const { projection } = mountPlugin()
    const teamSession = sessionOf('probe-team')
    const first = projection?.(conversation(7, longText()), teamSession) ?? []
    expect(cleared(first)).toBe(2)
    const withReport: ChatMessage[] = [
      ...conversation(7, longText()),
      { role: 'user', content: '<teammate-report id="s1">干完了：改了 3 个文件</teammate-report>' },
      assistant('h8', 'bash'),
      toolMsg('h8', longText()),
    ]
    expect(micro.roundKeyOf(withReport)).toBe(1)
    const second = projection?.(withReport, teamSession) ?? []
    expect(cleared(second)).toBe(2)
  })
})

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface SessionView {
  meta: { id: string; cwd: string; }
  messages: ChatMessage[]
  filePath: string
}

interface Services {
  prompt: {
    registerProjection(id: string, fn: (messages: ChatMessage[], session: SessionView) => ChatMessage[], options?: { order: number }): () => void
    rewrite(messages: ChatMessage[], session: SessionView): ChatMessage[]
  }
  session: { current(): SessionView }
  settings: { save(section: string, key: string, value: unknown): Promise<void> }
  tools: { register(spec: Record<string, unknown>): () => void }
}

describe('④ 接线：投影在 env-facts(600) 与 drop-images(900) 之间跑', () => {
  /** 649 哨兵看到的请求体（微压缩之前）。 */
  const seenBefore: { messages: ChatMessage[] | null } = { messages: null }
  /** 651 哨兵看到的请求体（微压缩之后、drop-images 之前）。 */
  const seenAfter: { messages: ChatMessage[] | null } = { messages: null }
  /** 一份 7 条工具结果 + 末尾带图 user 的请求。 */
  let assembled: ChatMessage[]
  /** 投影链跑完的最终请求体。 */
  let out: ChatMessage[]

  beforeAll(async () => {
    llm = await fakeLLM({ turns: ['收到'] })
    kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
    const services = kernel.ctx as unknown as Services
    services.prompt.registerProjection(
      'probe-649',
      (messages) => {
        seenBefore.messages = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
        return messages
      },
      { order: 649 },
    )
    services.prompt.registerProjection(
      'probe-651',
      (messages) => {
        seenAfter.messages = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
        return messages
      },
      { order: 651 },
    )
    assembled = [{ role: 'system', content: 'sys' }, { role: 'user', content: '开跑' }]
    for (let index = 1; index <= 7; index += 1) assembled.push(assistant(`k${String(index)}`, 'bash'), toolMsg(`k${String(index)}`, longText()))
    assembled.push({
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    })
    out = services.prompt.rewrite(assembled, services.session.current())
  })

  afterAll(async () => {
    await kernel?.dispose()
    await llm?.close()
  })

  test('649 哨兵看到工具结果原文（微压缩还没跑）', () => {
    const beforeTools = toolsOf(seenBefore.messages ?? [])
    expect(beforeTools).toHaveLength(7)
    expect(beforeTools.every((message) => !isCleared(message.content))).toBe(true)
  })

  test('649 哨兵看到了 env-facts 追加的末尾环境快照（说明它在 env-facts 之后）', () => {
    expect(
      (seenBefore.messages ?? []).some(
        (message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('本条是程序在每次请求时自动附上的当前环境快照'),
      ),
    ).toBe(true)
  })

  test('651 哨兵看到旧的已被换成占位符（微压缩在 649..651 之间跑）', () => {
    expect(toolsOf(seenAfter.messages ?? []).filter((message) => isCleared(message.content))).toHaveLength(2)
  })

  test('651 哨兵手里图像还在（drop-images 还没跑，说明微压缩在它之前）', () => {
    expect(
      (seenAfter.messages ?? []).some(
        (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
      ),
    ).toBe(true)
  })

  test('最终请求体里图像已被换成文字说明；旧工具结果已清理、最近 5 条原文在', () => {
    expect(
      out.some(
        (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && (part as { text?: string }).text?.includes('图像没有随请求发送')),
      ),
    ).toBe(true)
    expect(out.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))).toBe(false)
    const outTools = toolsOf(out)
    expect(outTools.filter((message) => isCleared(message.content))).toHaveLength(2)
    expect(outTools.slice(-5).every((message) => !isCleared(message.content))).toBe(true)
  })

  test('设置里关掉后投影不再清理，再打开立刻恢复', async () => {
    const services = kernel.ctx as unknown as Services
    await services.settings.save('microcompact', 'enabled', false)
    const off = services.prompt.rewrite(assembled, services.session.current())
    expect(toolsOf(off).every((message) => !isCleared(message.content))).toBe(true)
    await services.settings.save('microcompact', 'enabled', true)
    const backOn = services.prompt.rewrite(assembled, services.session.current())
    expect(toolsOf(backOn).filter((message) => isCleared(message.content))).toHaveLength(2)
  })
})

describe('⑤ 端到端：后一轮请求体里旧工具结果已清，日志原文不动', () => {
  /** 端到端要跑几轮工具调用：默认保留 5 条，跑 8 轮才有旧结果可清。 */
  const MAX_TOOL_RESULTS = 8
  /** 一个内核跑完两轮：第二轮才是「旧结果可清」的那一轮。 */
  let booted: BootedKernel
  let services: Services
  /** 已经跑到第几轮（`retry: 1` 会重跑用例；重复推进会让请求序号漂）。 */
  let stage = 0
  /** 第一轮结束时的请求条数（第二轮的起点）。 */
  let mark = 0

  beforeAll(async () => {
    // 8 轮工具调用 + 一次收尾文本 + 第二轮的一句「收到」（fakeLLM 用完续用最后一条）。
    const turns: Array<{ toolCall: { name: string; args: unknown } } | string> = []
    for (let index = 0; index < MAX_TOOL_RESULTS; index += 1) turns.push({ toolCall: { name: 'bulk', args: {} } })
    turns.push('收尾：都收到了', '收到')
    llm = await fakeLLM({ turns })
    booted = await bootKernel({ providerBaseUrl: llm.baseUrl })
    services = booted.ctx as unknown as Services
    // 本用例只测微压缩：把 spill 的落盘阈值调高，免得上万字符的测试结果先被 spill 换成
    // 「完整输出已落盘」指针——微压缩对那种正文是故意跳过的，会把预算推进的夹具搅浑。
    await services.settings.save('spill', 'thresholdChars', 20_000)
    services.tools.register({
      name: 'bulk',
      description: '测试用长输出工具',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => longText(),
    })
  })

  afterAll(async () => {
    await booted?.dispose()
  })

  test('同一轮内不清理旧结果（冻结计划，缓存友好），会话日志原文不动', async () => {
    if (stage < 1) {
      await booted.runTurn('开跑')
      mark = llm.bodies.length
      stage = 1
    }
    const maxToolRequest = llm.bodies
      .slice(0, mark)
      .map((body) => body as ChatMessage[])
      .filter((messages) => messages.filter((message) => message.role === 'tool').length === MAX_TOOL_RESULTS)
      .at(-1)
    expect(maxToolRequest).toBeDefined()
    const requestTools = toolsOf(maxToolRequest ?? [])
    expect(requestTools).toHaveLength(MAX_TOOL_RESULTS)
    // 同一轮内不随新工具结果往下清：请求前缀稳，缓存才命中。
    expect(requestTools.every((message) => String(message.content).startsWith('日志行：'))).toBe(true)
    expect(
      services.session.current().messages.filter((message) => message.role === 'tool').every((message) => String(message.content).startsWith('日志行：')),
    ).toBe(true)
  })

  test('新一轮请求体里最旧 3 条已变占位符（保留窗口 5 条）', async () => {
    if (stage < 2) {
      await booted.runTurn('再来一轮')
      stage = 2
    }
    const nextRound = llm.bodies
      .slice(mark)
      .map((body) => body as ChatMessage[])
      .filter((messages) => messages.filter((message) => message.role === 'tool').length >= MAX_TOOL_RESULTS)
      .at(-1)
    const nextTools = toolsOf(nextRound ?? [])
    expect(nextTools.slice(0, 3).every((message) => message.content === '[旧工具结果已清理：bulk]')).toBe(true)
    expect(nextTools.slice(3).every((message) => String(message.content).startsWith('日志行：'))).toBe(true)
  })
})

/** 一份消息里所有工具结果（文件级共享）。 */
function toolsOf(list: readonly ChatMessage[]): ChatMessage[] {
  return list.filter((message) => message.role === 'tool')
}
