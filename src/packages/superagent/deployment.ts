/**
 * 移植自 dsh-superagent/src/deployment.ts（131 行，原生重写）。
 * 改动点（除下面几条外，导出名、检查顺序、`SetupError` 代码、错误文案全部照搬）：
 *   ① `@deepseek-ai/schemastery` 的 `Config` 换成 zod 对象：本仓根依赖有 `zod@4.4.3`、没有 schemastery，
 *      写法照 `core/policy.ts`（`.default()` / `.describe()`）。上游 `.required()` 在 zod 里本来就是默认；
 *      上游 `.step(1)` 是整数约束，这里用 `.int()`；上游 `.volatile()` 在这个文件里没有对应物（见 ②）。
 *      `machineOf` 的未知键检查随之从 `Config.dict` 改成 `Config.shape`。Config 用 `.loose()` 而不是默认的
 *      「剥掉未声明键」：上游靠 `machineOf` 把那几个搬家过的旧键一个个点名报出（带「now …」提示），
 *      若 zod 先把它们剥掉，这段提示就成了死代码。
 *   ② `@deepseek-ai/cordis` 的 `Volatile<number>` 换成普通 `number`：本仓装的 cordis 4.1.0 没有 `Volatile`
 *      这个导出，也没有「改了配置不重启」这一层；设置页每次现读，字段按普通数导出。
 *   ③ `@deepseek-ai/dsh-subprocess` 的 `SubprocessRuntime` 去掉：本仓没有那套子进程服务。`workerProbe` 改
 *      收 `(stateDir, cwd, signal)`，用 node 原生 `child_process`（`infra/environment.ts` 的 `runAsWorker`）
 *      跑检查；上游那句 `env PATH=...` 命令前缀换成 `runAsWorker` 的 env 覆盖（POSIX 才有 `env`，语义等价）。
 *   ④ `Probe` 多了可选的 `env` 参数（`(argv, env?) => Promise<string>`），供 `resolveFeishuBot` 把
 *      `LARKSUITE_CLI_NO_*` 传给子进程；上游那两处同样是用 `env NAME=value` 前缀实现的。
 *   ⑤ `../limits.ts` → `./core/limits.js`：本仓没有 `src/limits.ts`，上限表在 `core/limits.ts`。
 *      其余 import（`./infra/environment.js`、`./setup.js`）与上游同目录，只差 `.js` 扩展名。
 *
 * 插件的配置与启动校验：GitHub 账号能否读写仓库、飞书机器人 CLI 是不是 strict mode 的 bot 身份。
 *
 * @module dsc/packages/superagent/deployment
 */
import { LIMITS } from './core/limits.js'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.js'
import { SetupError } from './setup.js'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => z.string().regex(/^\//, 'Absolute path.').describe(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = z.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.'),
  promptMaxChars: z.number().int().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).default(100000)
    .describe('Largest saved prompt configuration, in characters.'),
  admissionContextMaxPages: z.number().int().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).default(10)
    .describe('Pages of thread context one assessment may read.'),
  admissionContextTimeoutMs: z.number().int().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).default(15000)
    .describe('Time limit of one context read during an assessment, in milliseconds.'),
}).loose()
export type DeploymentConfig = z.infer<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: number
  admissionContextMaxPages: number
  admissionContextTimeoutMs: number
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in Config.shape))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[], env?: Record<string, string>) => Promise<string>
/** Run startup checks through node's child-process spawn with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return (argv, env) => runAsWorker(argv, cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), { ...env, PATH: path })
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe([cli, ...args], { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
