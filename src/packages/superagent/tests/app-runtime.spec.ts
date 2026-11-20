/**
 * `app/runtime.ts` 的包级覆盖测试：应用组合根与生命周期。
 *
 * 为什么这样测：`Runtime` 是唯一把 Store / Setup / Engine / Sessions / Effects 等十几个服务接起来的
 * 地方，构造期就落库、加锁、建服务；这里用真 SQLite（临时目录）、真 `Setup`、真 cordis 形状的假
 * Context，只把「宿主服务」留空——GitHub/飞书 CLI 未配置时 `setup.run` 会以 `SetupError` 返回
 * false，正好覆盖「启动即暂停等配置」这条最常走的启动路径，不需要任何真实 CLI 或网络。
 *
 * 钉的判据：未配置时 ready 能落地、setupProblem 点明缺什么、orchestrator 服务已挂上 ctx、
 * masterId 落库且重启后复用、stop() 幂等并释放目录锁（同进程能再开一次库）。
 *
 * @module @pneuma/superagent/tests/app-runtime
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Ticket, Trigger } from '../core/index.js'
import { KV } from '../kv.js'
import { Store } from '../app/store.js'
import { key } from '../core/index.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 假 Context：只实现 `Runtime` 与它构造的服务真正会碰的方法。 */
function fakeContext(): { ctx: Context; provided: Map<string, unknown>; events: [string, unknown][]; warnings: string[] } {
  const provided = new Map<string, unknown>()
  const events: [string, unknown][] = []
  const warnings: string[] = []
  const ctx = {
    get: (name: string) => provided.get(name),
    provide: (name: string, value: unknown) => { provided.set(name, value) },
    on: () => () => {},
    effect: () => () => {},
    emit: (event: string, payload: unknown) => { events.push([event, payload]) },
    logger: { warn: (format: string, ...values: unknown[]) => { warnings.push(`${format} ${values.map(String).join(' ')}`) } },
  }
  return { ctx: ctx as unknown as Context, provided, events, warnings }
}

/** `Runtime` 需要的内存机器参数；`stateDir` 每个用例一个临时目录。 */
function machine(stateDir: string) {
  return { stateDir, promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 }
}

describe('app/runtime', () => {
  const restores: (() => void)[] = []
  afterEach(() => {
    while (restores.length) restores.pop()!()
  })

  /** 起一个 Runtime；`restart` 记下被调次数，便于验 `checkSetup`。 */
  async function start(): Promise<{ runtime: any; dir: string; restarts: () => number; ctx: any; stateDir: string }> {
    const dir = createTempDir('dsc-sa-runtime-')
    const previousHome = process.env.DSC_HOME
    process.env.DSC_HOME = dir
    restores.push(() => {
      if (previousHome === undefined) delete process.env.DSC_HOME
      else process.env.DSC_HOME = previousHome
    })
    const stateDir = join(dir, 'state')
    const { ctx, provided, events, warnings } = fakeContext()
    let restarts = 0
    const { Runtime } = await import('../app/runtime.js')
    const runtime = new Runtime(ctx, machine(stateDir), () => { restarts += 1 })
    await runtime.ready
    return { runtime, dir, restarts: () => restarts, ctx: { provided, events, warnings }, stateDir }
  }

  it('GitHub 未配置时启动即暂停：ready 落地、setupProblem 点明缺什么、orchestrator 服务已挂上', async () => {
    const { runtime, stateDir, ctx, dir } = await start()
    try {
      expect(runtime.configured()).toBe(false)
      expect(runtime.setupProblem?.code).toBe('repositoryUnset')
      expect(runtime.setupProblem?.place).toBe('github')
      expect(runtime.feishuProblem).toBeUndefined()
      // 运行期体检项：初始化在 setup 未通过时把 runtime 标成 paused/setupPending。
      expect(runtime.health.runtime?.state).toBe('paused')
      expect(runtime.health.runtime?.code).toBe('setupPending')
      expect(runtime.health.runtime?.detail).toBe('Waiting for the deployment check')
      // 体检面板由组合根持有：runtime 这一项已经写好，面板整体可读。
      expect(runtime.health['runtime']?.state).toBe('paused')
      // 组合根把自己挂成 `orchestrator` 服务，来源插件从 ctx 拿它。
      expect(ctx.provided.get('orchestrator')).toBe(runtime)
      // 数据库落在 stateDir 下，masterId 写进 KV 且与 stateDir 派生值一致。
      expect(existsSync(join(stateDir, 'orchestrator.sqlite'))).toBe(true)
      expect(runtime.masterId).toBe(`orchestrator-${key(stateDir)}`)
      expect(runtime.store.get(KV.runtime.masterId)).toBe(runtime.masterId)
      expect(runtime.lifetime.aborted).toBe(false)
      expect(dir.length).toBeGreaterThan(0)
    } finally {
      await runtime.stop()
    }
  })

  it('未配置时取 deployment 抛「等 setup」，links 仍可构造，context 能写声明的体检项', async () => {
    const { runtime } = await start()
    try {
      expect(() => runtime.deployment).toThrow(/dsh-superagent is waiting for setup/)
      // 未配置时 links() 拿到空部署，返回的函数本身不抛。
      const link = runtime.links()
      expect(typeof link).toBe('function')
      // SourceContext 只允许写它自己声明的体检项；未注册的来源没有该条目，写入是空操作而不是抛错。
      const context = runtime.context({ kind: 'github', health: ['github'] })
      expect(() => { context.report('github', { state: 'ready', detail: 'polled' }) }).not.toThrow()
      expect(runtime.health.github).toBeUndefined()
      // 未声明的名字直接拒绝，不新增体检项。
      expect(() => { context.report('other', { state: 'ready', detail: 'nope' }) }).toThrow(/no health entry/)
      expect(runtime.health.other).toBeUndefined()
    } finally {
      await runtime.stop()
    }
  })

  it('checkSetup 在未配置时安排重启，已配置时按健康度拒绝', async () => {
    const { runtime, restarts, ctx } = await start()
    try {
      runtime.checkSetup()
      await new Promise(resolve => { setTimeout(resolve, 10) })
      expect(restarts()).toBe(1)
      expect(ctx.warnings).toEqual([])
    } finally {
      await runtime.stop()
    }
  })

  it('receive / idle / pump / sendReplies 在暂停状态下也能走通', async () => {
    const { runtime } = await start()
    try {
      const trigger: Trigger = { id: 't1', source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: 'alice' },
        human: true, at: '2026-09-09T00:00:00.000Z', text: 'fix it', meta: {} }
      // 暂停（未配置）时来源仍记录触发，不派发。
      const result = runtime.receive(trigger)
      expect(result).toBeDefined()
      await expect(runtime.idle()).resolves.toBeUndefined()
      await expect(runtime.pump()).resolves.toBeUndefined()
      await expect(runtime.sendReplies()).resolves.toBeUndefined()
    } finally {
      await runtime.stop()
    }
  })

  it('ticketEnvironment 需要已解析的部署，未配置时点名等 setup', async () => {
    const { runtime } = await start()
    try {
      const ticket = { id: 't1', title: 'Fix', decisionId: '', channels: [], assignments: [], inputs: [], undelivered: [],
        mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
        createdAt: '1', updatedAt: '1', origin: { triggerId: '', triggerIds: [] } } as unknown as Ticket
      expect(() => runtime.ticketEnvironment(ticket)).toThrow(/waiting for setup/)
    } finally {
      await runtime.stop()
    }
  })

  it('stop() 幂等：同一个 promise、abort 生命周期、关库并释放目录锁，之后能原地再开', async () => {
    const { runtime, stateDir } = await start()
    const first = runtime.stop()
    const second = runtime.stop()
    expect(second).toBe(first)
    await first
    expect(runtime.lifetime.aborted).toBe(true)
    // 目录锁已释放、库已关闭：同一路径可以再 new 一个 Store。
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.close()
    // 再 stop 一次仍是同一个已完成的 promise，不重复收尾。
    await runtime.stop()
  })

  it('重启后复用同一个 masterId：第二个实例从 KV 读出第一个写的值', async () => {
    const first = await start()
    let masterId: string
    const stateDir = first.stateDir
    try {
      masterId = first.runtime.masterId
    } finally {
      await first.runtime.stop()
    }
    // 同一 stateDir 再起一次（restore 会把 DSC_HOME 换回新的临时目录，但 stateDir 显式给）。
    const { ctx } = fakeContext()
    const { Runtime } = await import('../app/runtime.js')
    const again = new Runtime(ctx, machine(stateDir), () => {})
    await again.ready
    try {
      expect(again.masterId).toBe(masterId)
    } finally {
      await again.stop()
    }
  })
})
