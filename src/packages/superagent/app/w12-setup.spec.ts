/**
 * 覆盖补齐（W12）：`app/setup.ts` 的启动配置探测状态。
 *
 * 这一层的错法是「面板说有错但不知道去哪修」或「修好了还不重启」，所以断言钉的是
 * 问题分类（place）、重启时机与命令环境；真正跑 CLI 的探测（`resolve`）走不到成功分支，
 * 用例只覆盖可确定失败的路径，不假装跑过真实 git / lark-cli。
 *
 * @module @pneuma/superagent/app
 */
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../deployment.js'
import { SETUP_FIELDS } from '../deployment.js'
import { SettingsSchema } from '../core/policy.js'
import { UserError } from '../core/index.js'
import { workerBin } from '../infra/environment.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { Setup, setupChanged, type SetupHost } from './setup.js'

const savedPath = process.env.PATH
afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

function machine(stateDir = createTempDir('dsc-sa-setup-')): Machine {
  return { stateDir, promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 1000 }
}
/** 一组 setup 宿主：真 machine（临时 state 目录），restart 只计数。 */
function host(overrides: Partial<SetupHost> = {}) {
  const restarts: number[] = []
  const warnings: unknown[][] = []
  const value: SetupHost = {
    context: { logger: { warn: (...args: unknown[]) => { warnings.push(args) } } } as unknown as Context,
    machine: machine(),
    lifetime: new AbortController().signal,
    restart: () => { restarts.push(Date.now()) },
    ...overrides,
  }
  return { host: value, restarts, warnings }
}
const settings = (github: Record<string, unknown> = {}) => SettingsSchema.parse({
  sources: { github: { enabled: true, config: github }, feishu: { enabled: false, config: {} } },
  executor: { blockedCommands: ['rm'] },
})
const wait = () => new Promise(resolve => setTimeout(resolve, 10))

describe('app/setup：配置变更判定与命令环境', () => {
  test('setupChanged 只比来源的配置字段，改执行器设置不算需要重启的变更', () => {
    const before = settings({ repository: 'o/r', cli: 'gh' })
    expect(setupChanged(before, settings({ repository: 'other/repo', cli: 'gh' }))).toBe(true)
    expect(setupChanged(before, settings({ repository: 'o/r', cli: 'gh!' }))).toBe(true)
    expect(setupChanged(before, before)).toBe(false)
    expect(setupChanged(before, { ...before, executor: { ...before.executor, blockedCommands: ['curl'] } })).toBe(false)
    // 每个来源各比各的：飞书配置变也算。
    expect(setupChanged(settings(), { ...settings(), sources: { ...settings().sources,
      feishu: { enabled: true, config: { cli: 'lark-cli' } } } })).toBe(true)
    expect(Object.keys(SETUP_FIELDS)).toEqual(['github', 'feishu'])
  })

  test('commandEnvironment 从 PATH 里去掉 worker shim 目录，并带上 agent 变量', () => {
    const harness = host()
    const bin = workerBin(harness.host.machine.stateDir)
    process.env.PATH = [bin, savedPath ?? ''].join(delimiter)
    const setup = new Setup(harness.host)
    const environment = setup.commandEnvironment
    expect(environment.PATH).toBe(savedPath)
    expect(environment.PATH).not.toContain(bin)
    // git 只认这份隔离配置，不吃宿主环境里的 git 变量。
    expect(String(environment.GIT_CONFIG_GLOBAL)).toContain(harness.host.machine.stateDir)
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(environment.GH_TOKEN).toBeUndefined()
  })
})

describe('app/setup：运行、问题记录与重启', () => {
  test('未跑完 setup 时拿 deployment 会抛错，并带上已知问题', async () => {
    const harness = host()
    const setup = new Setup(harness.host)
    expect(setup.configured()).toBe(false)
    expect(() => setup.deployment).toThrow('setup has not run')
    const ok = await setup.run(settings())
    expect(ok).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'github', code: 'repositoryUnset' })
    expect(() => setup.deployment).toThrow('The GitHub Source names no repository.')
    expect(setup.configured()).toBe(false)
  })

  test('run 只吞配置类错误；意外错误原样抛出', async () => {
    const harness = host()
    const setup = new Setup(harness.host)
    // 非法仓库名在 schema 解析时抛 ZodError，不是 SetupError。
    await expect(setup.run(settings({ repository: 'not a repo' }))).rejects.toThrow()
    expect(setup.problem).toBeUndefined()
    // 已有人工设置的成功部署可以直接读。
    const deployed = new Setup(harness.host)
    const value: Deployment = { ...harness.host.machine, repository: 'o/r',
      github: { cli: 'gh', login: 'agent', noreply: 'a@b' } }
    ;(deployed as unknown as { resolved?: Deployment }).resolved = value
    expect(deployed.configured()).toBe(true)
    expect(deployed.deployment).toBe(value)
  })

  test('check 在已完成时拒绝重启，否则把重启推迟到下一个宏任务', async () => {
    const harness = host()
    const setup = new Setup(harness.host)
    setup.check()
    await wait()
    expect(harness.restarts).toHaveLength(1)

    // 已经部署好、飞书也没问题时拒绝再重启（免得打断正在跑的工单）。
    ;(setup as unknown as { resolved?: Deployment }).resolved = { ...harness.host.machine, repository: 'o/r',
      github: { cli: 'gh', login: 'agent', noreply: 'a@b' } }
    expect(() => setup.check()).toThrow(UserError)
    expect(() => setup.check()).toThrow('Setup is complete')
    // 飞书有独立问题时仍允许重启去重新探测。
    setup.feishuProblem = { place: 'feishu', code: 'feishuCliFailed', values: {}, detail: 'no cli' }
    setup.check()
    await wait()
    expect(harness.restarts).toHaveLength(2)
  })

  test('checkAccounts 把属于这一来源块的问题抛给保存者，别的块的探测错误不拦', async () => {
    const harness = host()
    const setup = new Setup(harness.host)
    // GitHub 块：仓库未设置正是这一块要修的问题，抛出去。
    await expect(setup.checkAccounts('source:github', settings())).rejects.toThrow('names no repository')
    // 飞书块没配 lark-cli：探测直接返回没有机器人，正常完成。
    await expect(setup.checkAccounts('source:feishu', settings())).resolves.toBeUndefined()
    // 非配置错误（非法配置的字面量）不属于任何块，照抛。
    await expect(setup.checkAccounts('source:github', settings({ repository: 'not a repo' }))).rejects.toThrow()
  })

  test('blockCommands 只在部署解析完之后写 worker 环境；restore 可重复调用', async () => {
    const harness = host()
    const setup = new Setup(harness.host)
    // 还没部署：什么都不写。
    await setup.blockCommands(['rm'])
    expect(existsSync(workerBin(harness.host.machine.stateDir))).toBe(false)

    ;(setup as unknown as { resolved?: Deployment }).resolved = { ...harness.host.machine, repository: 'o/r',
      github: { cli: 'gh', login: 'agent', noreply: 'a@b' } }
    await setup.blockCommands(['rm', 'curl'])
    expect(existsSync(workerBin(harness.host.machine.stateDir))).toBe(true)

    const restored: number[] = []
    ;(setup as unknown as { restoreEnvironment?: () => void }).restoreEnvironment = () => { restored.push(1) }
    setup.restore()
    setup.restore()
    expect(restored).toEqual([1])
  })

  test('construct 时 PATH 缺失也不崩；环境变量按 stateDir 生成', () => {
    delete process.env.PATH
    const harness = host({ machine: machine(join(createTempDir('dsc-sa-setup-path-'), 'state')) })
    const setup = new Setup(harness.host)
    expect(setup.commandEnvironment).toBeDefined()
    expect(setup.commandEnvironment.PATH).toBe('')
  })
})
