/**
 * 移植自上游 `src/app/setup.ts`（99 行，原生重写）。
 * 上游 import 了 `@deepseek-ai/cordis`，本文件照上游的模块边界、类形状、判定顺序与错误文案重写，
 * 只把「DSH 宿主调用」换成本仓原生能力。改动逐条：
 *   ① import 路径：`../core/index.ts` → `../core/index.js`；`../deployment.ts`、`../infra/environment.ts`、
 *      `../setup.ts` 只差 NodeNext 的 `.js` 扩展名；`../policy.ts` → `../core/policy.js`（本仓 Policy 在 `core/`）。
 *   ② `SetupHost.context` 仍是 cordis `Context`（本仓同为 cordis 宿主）：上游从这里取
 *      `context.subprocess` 与 `context.logger`，本仓没有子进程服务，只剩 `context.logger.warn` 一处用途。
 *   ③ `private probe()`：上游 `workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)`（4 参）
 *      → 本仓 `workerProbe(machine.stateDir, machine.stateDir, lifetime)`（3 参，`infra/environment.ts:92`
 *      用 node 原生 spawn 跑检查，不再收子进程服务）。
 *   ④ `resolve()` 里 `verifyEnvironment(resolved, context.subprocess, lifetime)`（3 参）
 *      → `verifyEnvironment(resolved, lifetime)`（2 参，`infra/environment.ts:184`，同上换成原生 spawn）。
 * 其余逐字：`setupFields` / `setupChanged` / `SETUP_FIELDS` 用法、`Setup` 的 `resolved` / `problem` /
 * `feishuProblem` 属性、`commandEnvironment` / `deployment` / `configured` / `run` / `check` / `restart` /
 * `checkAccounts` / `blockCommands` / `restore` / `resolve` 的划分与 `SetupError` 处理顺序一个没动；
 * 英文 doc 注释保留原文。
 *
 * Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness.
 *
 * @module dsc/packages/superagent/app/setup
 */
/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.js'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.js'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.js'
import type { Settings, SettingsBlock } from '../core/policy.js'
import { SetupError, type SetupProblem } from '../setup.js'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { machine, lifetime } = this.host
    return workerProbe(machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
