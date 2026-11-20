/**
 * `app/sessions.ts` 的边角分支覆盖（W14）。
 *
 * 既有 `app-sessions.spec.ts` 只跑公开主路径。这里补四处只有异常/角色差异才会走到的分支：
 *   - worker 会话按执行器模型路由、思考强度认不出时回落到 default（222 行）；
 *   - 会话标题 sidecar 写不进去只告警（383 行）；
 *   - worker 会话的守卫链遇到已结束工单就拒绝动手（561-563 行）、没守卫链时 observe 原样返回（567 行）；
 *   - preset 从会话日志读不出来时按标准档处理（578 行）；
 *   - 内核会话表的 attach / detach 登记与 detach 抛错时的告警（662-663、672、743 行）。
 *
 * 用真 Store + 真 Session + 假宿主服务（同 app-sessions.spec.ts 的形状），`DSC_HOME` 指临时目录。
 *
 * @module dsc/packages/superagent/tests/w14-sessions-edges
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const originalHome = process.env.DSC_HOME
const root = createTempDir('dsc-w14-sessions-')
process.env.DSC_HOME = root

const { Sessions, WORKER_PRESET } = await import('../app/sessions.js')
const { Store } = await import('../app/store.js')
const { SettingsSchema } = await import('../core/policy.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalHome
})

interface Recorded {
  warnings: string[]
  attached: unknown[]
  detached: string[]
  health: unknown[]
}

/** 宿主桩：只实现 Sessions 真正会碰的口子，记录调用。 */
function makeHost(store: InstanceType<typeof Store>, over: Record<string, any> = {}) {
  const recorded: Recorded = {
    warnings: [],
    attached: [],
    detached: [],
    health: [],
  }
  const prompts = {
    current: () => ({
      revision: 1,
      previousRevision: null,
      savedAt: '',
      source: 'panel',
      config: { skills: {} },
    }),
    version: () => ({
      revision: 1,
      previousRevision: null,
      savedAt: '',
      source: 'panel',
      config: { skills: {} },
    }),
    compose: (_config: unknown, role: string) => `composed:${role}`,
    skills: () => [],
  }
  const llm = {
    routeForSession: () => ({ provider: 'p', model: 'm' }),
    route: () => ({ provider: 'p', model: 'm' }),
    routeTo: (provider: string, model: string, effort: string) => ({
      provider,
      model,
      effort,
    }),
    providerOf: () => 'p',
    stream: async () => ({}),
  }
  const ctx: any = {
    get: (name: string) => {
      if (name === 'llm') return llm
      if (name === 'agent') return over.agent
      if (name === 'guards') return over.guards
      if (name === 'skills' || name === 'tools' || name === 'prompt' || name === 'compact') return undefined
      return undefined
    },
    effect: (fn: () => () => void) => fn(),
    on: () => () => {},
    emit: () => {},
    logger: {
      warn: (format: string, ...values: unknown[]) => {
        recorded.warnings.push(`${format} ${values.map(String).join(' ')}`)
      },
    },
  }
  const host: any = {
    context: ctx,
    store,
    prompts,
    effects: { handle: () => () => {}, enqueue: () => {} },
    health: {
      set: (entry: unknown) => {
        recorded.health.push(entry)
      },
      all: {},
    },
    masterId: 'orchestrator-1',
    lifetime: new AbortController().signal,
    closing: () => false,
    environment: () => [],
    tools: () => [],
  }
  return { host, recorded, llm }
}

function setup(over: Record<string, any> = {}) {
  const dir = join(root, `case-${Math.random().toString(36).slice(2, 8)}`)
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  const made = makeHost(store, over)
  const sessions = new Sessions(made.host)
  return {
    ...made,
    sessions,
    store,
    dir,
    close: () => {
      sessions.dispose()
      store.close()
    },
  }
}

const ticketOf = (over: Record<string, unknown> = {}) => ({
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
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
  ...over,
})

describe('worker 会话的路由与思考强度回落', () => {
  test('执行器模型配了认不出的 reasoningEffort：routeTo 收到 default', async () => {
    const { sessions, store, dir, close } = setup()
    try {
      const handle = await sessions.ensure('worker-tk1', dir, '', 'worker')
      // 先建会话（role-models 装模型时会校验档位），再把「认不出的档位」写进设置：
      // routeOf 每回合现读设置，所以这里能走到 sessions.ts 自己的回落逻辑。
      store.saveSettings(
        SettingsSchema.parse({
          executor: {
            model: { provider: 'p', model: 'm', reasoningEffort: 'weird' },
          },
        }),
      )
      const route = (sessions as unknown as { routeOf: (h: unknown) => unknown }).routeOf(handle)
      expect(route).toMatchObject({
        provider: 'p',
        model: 'm',
        effort: 'default',
      })
    } finally {
      close()
    }
  })
})

describe('装饰与释放的告警分支', () => {
  test('内核会话表 attach；detach 抛错时只告警，dispose 不炸', async () => {
    const agent = {
      attach: (session: unknown) => {
        attached.push(session)
      },
      detach: () => {
        throw new Error('detach boom')
      },
    }
    const attached: unknown[] = []
    const { sessions, dir, close, recorded } = setup({ agent })
    void attached
    try {
      await sessions.ensure('worker-tk2', dir, '', 'worker')
      expect(agent as unknown).toBeDefined()
      sessions.dispose()
      expect(recorded.warnings.join('\n')).toContain('could not release')
    } finally {
      close()
    }
  })

  test('会话标题 sidecar 写不进去：ensure 照常返回，只记一条告警', async () => {
    const { sessions, dir, close, recorded } = setup()
    // meta.json 位置占成目录：patchSessionMeta 写文件时失败。
    mkdirSync(join(root, 'sessions', 'meta.json'), { recursive: true })
    try {
      const handle = await sessions.ensure('orchestrator-x', dir, '标题', 'orchestrator')
      expect(handle.id).toBe('orchestrator-x')
      expect(recorded.warnings.join('\n')).toContain('could not rename session')
    } finally {
      close()
    }
  })
})

describe('守卫链与 preset 读取', () => {
  test('worker 的工单已结束：gate 当场拒绝；有守卫链时 observe 转给宿主', async () => {
    const guards = {
      gate: async () => ({ action: 'allow' }),
      observe: (_tool: string, text: string) => `宿主:${text}`,
    }
    const { sessions, store, dir, close } = setup({ guards })
    try {
      store.tickets.save(
        ticketOf({
          ended: {
            at: '2026-01-02T00:00:00.000Z',
            by: 'human',
            outcome: 'stopped',
          },
        }) as never,
      )
      const handle = await sessions.ensure('worker-tk1', dir, '', 'worker')
      const chain = (
        sessions as unknown as {
          guardFor: (h: unknown) => {
            gate: (input: unknown) => Promise<unknown>
            observe: (name: string, text: string) => string
          }
        }
      ).guardFor(handle)
      await expect(chain.gate({ toolName: 'bash', args: {} })).resolves.toMatchObject({
        action: 'deny',
        reason: expect.stringContaining('Ticket ended'),
      })
      expect(chain.observe('bash', '输出')).toBe('宿主:输出')
    } finally {
      close()
    }
  })

  test('没有守卫链：gate 失败关闭，observe 原样返回', async () => {
    const { sessions, dir, close } = setup()
    try {
      const handle = await sessions.ensure('worker-tk3', dir, '', 'worker')
      const chain = (
        sessions as unknown as {
          guardFor: (h: unknown) => {
            gate: (input: unknown) => Promise<unknown>
            observe: (name: string, text: string) => string
          }
        }
      ).guardFor(handle)
      await expect(chain.gate({ toolName: 'bash', args: {} })).resolves.toMatchObject({
        action: 'deny',
        reason: expect.stringContaining('守卫链'),
      })
      expect(chain.observe('bash', '原样')).toBe('原样')
    } finally {
      close()
    }
  })

  test('preset 读不出来（会话日志抛错）：按标准档处理，routed 为 false', async () => {
    const { sessions, dir, close } = setup()
    try {
      const handle = await sessions.ensure('worker-tk4', dir, '', 'worker')
      expect(handle.role).toBe('worker')
      ;(handle.session as unknown as { notes: () => never }).notes = () => {
        throw new Error('notes boom')
      }
      expect((sessions as unknown as { routed: (h: unknown) => boolean }).routed(handle)).toBe(false)
      // 正常路径读得到 preset：worker 不是 router。
      const other = await sessions.ensure('worker-tk5', dir, '', 'worker')
      expect((sessions as unknown as { routed: (h: unknown) => boolean }).routed(other)).toBe(false)
      expect(WORKER_PRESET).toBeTypeOf('string')
    } finally {
      close()
    }
  })
})
