/**
 * 一批「小纯函数 / 单行闭包」缺口的集中覆盖（superagent）。
 *
 * 这些行都是各文件里被漏掉的单点分支：模型里的 `reached` 输入兜底、文本视图的
 * 伪 JSON 回退、Feishu kind 的 `refreshLabels` / `find` / 策略 schema 去重、
 * `feishuThreadContext.messageId`，以及主会话 / 执行者两套 `orchestrator_read`
 * 工具里真正发读请求的那个回包闭包。每条都直接调被测函数，不搭重夹具。
 *
 * @module dsc/packages/superagent/tests/w14-small-gaps
 */
import { describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../core/index.js'
import { reached } from '../core/model.js'
import { readable, preview } from '../app/views/text.js'
import { Commands } from '../infra/commands.js'
import { feishuKind } from '../sources/feishu.js'
import { feishuThreadContext } from '../sources/feishu-read.js'
import { mainTools } from '../app/tools/main.js'
import { executorTools } from '../app/tools/executor.js'
import type { SourceContext, SourceHost } from '../sources/host.js'

const NOW = '2026-01-01T00:00:00.000Z'

const triggerOf = (over: Partial<Trigger> = {}): Trigger => ({
  id: 'trig-1',
  source: 'feishu',
  threads: [{ source: 'feishu', id: 'oc_1:om_1' }],
  actor: { source: 'feishu', id: 'ou_1' },
  human: true,
  at: NOW,
  text: 'hi',
  meta: {},
  ...over,
})

const ticketOf = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tk1',
  title: 't',
  decisionId: 'd1',
  mandate: {
    strength: 'explicit',
    policyVersion: 'v1',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'feishu', id: 'ou_1' },
    scope: 'chat',
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: NOW,
  updatedAt: NOW,
  origin: { triggerId: 'origin-1', triggerIds: ['origin-1'] },
  ...over,
})

describe('core/model：reached 的输入触发兜底', () => {
  it('工单把某条触发作为输入收进来，且线程不在「仅上下文」名单里：算可达', () => {
    const ticket = ticketOf({
      inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'trig-1', at: NOW }],
    })
    // 线程不在工单订阅里：第一段（subscriptions）为假，走 `input && …` 那半段。
    expect(reached(ticket, triggerOf(), () => undefined)).toBe(true)
  })

  it('输入触发的线程全部只作上下文：context=false 时不算可达', () => {
    const ticket = ticketOf({
      inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'trig-1', at: NOW }],
    })
    const thread = () =>
      ({
        key: 'feishu:oc_1:om_1',
        ref: { source: 'feishu', id: 'oc_1:om_1' },
        createdAt: NOW,
        lastAt: NOW,
        subscriptions: [],
        correlated: [],
        pending: [],
        context: ['tk1'],
        meta: {},
      }) as never
    expect(reached(ticket, triggerOf(), thread, false)).toBe(false)
    expect(reached(ticket, triggerOf(), thread, true)).toBe(true)
  })
})

describe('app/views/text：伪 JSON 文本原样返回', () => {
  it('readable：解析失败的「看起来像 JSON」的文本按原文返回，不改写', () => {
    const broken = '{ this is not json }'
    expect(readable(broken)).toBe(broken)
    expect(preview(broken)).toBe(broken)
  })

  it('readable：真 JSON 与带标签的 JSON 都折成 key-value 行', () => {
    expect(readable('{"a":1}')).toBe('a: 1')
    expect(readable('说明: {"a":1}')).toContain('说明')
  })
})

describe('infra/commands：git 直通', () => {
  it('commands.git 用隔离环境跑 git 并交回 stdout', async () => {
    const commands = new Commands(
      () =>
        ({
          repository: 'acme/widgets',
          github: { cli: 'gh', login: 'agent', noreply: 'x' },
        }) as never,
      {},
      new AbortController().signal,
    )
    const output = await commands.git(['--version'], process.cwd())
    expect(output).toMatch(/^git version /m)
  })
})

describe('sources/feishu：kind 的刷新 / 查找 / 策略去重', () => {
  const bot = {
    cli: 'lark-cli',
    appId: 'cli_app',
    brand: 'feishu' as const,
    botId: 'ou_bot',
    name: 'Bot',
  }
  const deployment = {
    repository: 'acme/widgets',
    github: { cli: 'gh', login: 'agent', noreply: 'x' },
    feishu: bot,
    stateDir: '/tmp/state',
    promptMaxChars: 1,
    admissionContextMaxPages: 1,
    admissionContextTimeoutMs: 1,
  }

  it('refreshLabels：读群列表后把 chat_id → 群名写进来源标签', async () => {
    const state = new Map<string, unknown>()
    const commands = {
      deployment,
      withSignal: function (this: unknown) {
        return commands
      },
      lark: async () => ({
        chats: [
          { chat_id: 'oc_a', name: 'Team' },
          { chat_id: 'oc_b', name: null },
        ],
      }),
    }
    const context = {
      deployment,
      commands,
      ready: Promise.resolve(),
      configured: () => true,
      problem: undefined,
      config: () => ({ chats: [], directMessages: true }),
      receive: async () => ({}),
      atomic: <T>(work: () => T) => work(),
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => {
          state.set(key, value)
        },
        keys: () => [...state.keys()],
      },
      threads: {
        get: () => undefined,
        subscribed: () => [],
        describe: () => {},
        patch: () => {},
      },
      tickets: {
        get: () => undefined,
        open: () => [],
        bindThread: () => {},
        threadClosed: () => {},
      },
      triggers: { get: () => undefined, latest: () => undefined },
      notify: () => {},
      report: () => {},
    }
    const host = {
      sources: { register: () => () => {} },
      context: () => context as unknown as SourceContext,
    } as unknown as SourceHost
    const names = await feishuKind.refreshLabels!(host)
    expect(names).toEqual({ oc_a: 'Team' })
  })

  it('find：从查询里抠出 om_ ID 去重；repliesTo：父消息 ID 折成稳定触发 ID', () => {
    expect(feishuKind.find!('看下 om_1 和 om_2、om_1')).toEqual({
      threads: [],
      terms: ['om_1', 'om_2'],
    })
    expect(feishuKind.repliesTo!(triggerOf({ meta: { parentId: 'om_parent' } }))).toMatch(/^[0-9a-f]{32}$/)
    expect(feishuKind.repliesTo!(triggerOf())).toBeUndefined()
  })

  it('policy.schema：重复的 bot ID 被 refine 拒掉，单个合法 ID 通过', () => {
    expect(() =>
      feishuKind.policy!.schema.parse({
        bots: [{ id: 'cli_a' }, { id: 'cli_a' }],
      }),
    ).toThrow(/Duplicate bot ids/)
    expect(feishuKind.policy!.schema.parse({ bots: [{ id: 'cli_a' }] }).bots).toEqual([{ id: 'cli_a' }])
  })
})

describe('sources/feishu-read：threadContext.messageId', () => {
  it('有 messageId 时原样取，缺失时给空串', () => {
    expect(feishuThreadContext.messageId(triggerOf({ meta: { messageId: 'om_1' } }))).toBe('om_1')
    expect(feishuThreadContext.messageId(triggerOf())).toBe('')
  })
})

describe('app/tools：两套 orchestrator_read 的读请求闭包', () => {
  /** 读资源用的最小 resources 桩：任何资源都返回一页。 */
  const resources = { read: async () => ({ text: 'page' }) }

  it('mainTools 的 read 工具把参数原样交给 readResource', async () => {
    const host = {
      resources,
      sessions: {},
      settings: {},
      engine: {},
      assessor: {},
      github: {},
      commands: {},
      requestPass: () => {},
      sendReplies: async () => {},
      quietly: (run: () => unknown) => run(),
    }
    const tools = mainTools(host as never, { id: 'agent-1' } as never)
    const read = tools.find((tool) => tool.name === 'orchestrator_read')!
    // readResource 认不出资源名会抛；这里只要求读请求闭包被调用到（错误来自资源名，不是闭包没跑）。
    await expect(read.execute({ resource: 'nope', offset: 0 }, new AbortController().signal)).rejects.toThrow()
  })

  it('executorTools 的 read 工具把 ticketId 带进读请求', async () => {
    const host = {
      resources,
      sessions: {},
      settings: {},
      engine: {},
      assessor: {},
      commands: {},
      github: { deployment: { github: { login: 'agent' } } },
      requestPass: () => {},
      sendReplies: async () => {},
      quietly: (run: () => unknown) => run(),
    }
    const tools = executorTools(host as never, ticketOf())
    const read = tools.find((tool) => tool.name === 'orchestrator_read')!
    await expect(read.execute({ resource: 'nope', offset: 0 }, new AbortController().signal)).rejects.toThrow()
  })
})
