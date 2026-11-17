/**
 * 移植自 dsh-superagent/src/infra/environment.ts（157 行，原生重写）。
 * 改动点（除下面几条外，函数体、判定顺序、错误文案全部照搬）：
 *   ① 去掉 `@deepseek-ai/dsh-subprocess` 的 `SubprocessRuntime` / `SubprocessOutputReader`：本仓没有
 *      那套子进程服务。`runAsWorker` 改用 node 原生 `child_process.spawn` 实现，参数与上游 spawn 一一对应
 *      （stdin 忽略、stdout 上限 1 MiB、stderr 上限 64 KiB、成功返回 stdout、非零退出抛 `CliError`）；
 *      因此 `verifyEnvironment` / `verifyDirectory` 不再收 `subprocess` 参数，改为直接读当前进程环境。
 *   ② DSH 的子进程运行时会把名字像凭证的环境变量（`KEY|PASSWORD|SECRET|TOKEN`）从子进程环境里剥掉，
 *      本文件第一段注释就依赖这条行为；node 的 spawn 不会剥，所以 `runAsWorker` 里按同一条规则显式剥，
 *      否则宿主环境里的令牌会漏给 worker。
 *   ③ `runAsWorker` 多了可选的 `env` 覆盖参数（上游也有这个第五参数，只是 DSH 的 spawn 语义）；`Probe`
 *      用它把 `PATH` 与 `LARKSUITE_CLI_*` 传给子进程，上游那两处是靠 `env NAME=value` 前缀命令实现的
 *      ——POSIX 才有 `env`，本仓原生环境（Windows 也在跑）改成环境变量覆盖，语义等价。
 *   ④ 上游的 `import type { Deployment }` 是 `../deployment.ts`；本仓目录已按上游镜像，路径同样是
 *      `../deployment.ts`，只差 NodeNext 要求的 `.js` 扩展名（`../setup.ts`、`./commands.ts` 同理）。
 *
 * 进程环境与 CLI shim：把 git、gh、lark-cli 绑到部署账号上，并拦住被禁用的命令。
 * worker 读的变量名避开 `KEY|PASSWORD|SECRET|TOKEN`，因为 DSH 会把这类凭证形态的变量从子进程环境里剥掉。
 * 这些是默认路径上的护栏，不是操作系统级的安全边界——worker 仍以操作员的 OS 用户运行。
 *
 * @module dsc/packages/superagent/infra/environment
 */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { Deployment } from '../deployment.js'
import { SetupError } from '../setup.js'
import { CliError } from './commands.js'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** 上游 DSH 子进程运行时剥凭证变量的规则；见文件头第 ② 条，原生 spawn 要自己剥一遍。 */
const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i
/** 子进程的 stdout / stderr 上限，与上游 spawn 的 `{ maxBytes: 1 << 20 }` / `{ maxBytes: 1 << 16 }` 对齐。 */
const STDOUT_MAX_BYTES = 1 << 20
const STDERR_MAX_BYTES = 1 << 16

/** 合并 `process.env` 与调用方的覆盖值，并剥掉名字像凭证的变量。 */
function workerEnvironment(env?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined && !CREDENTIAL_NAME.test(name)) merged[name] = value
  }
  return merged
}

/**
 * Spawns a command as a worker sees it (credential-shaped variables removed) and returns its stdout.
 *
 * `verbatim` passes the arguments to Windows unchanged (`windowsVerbatimArguments`). It exists for one caller: the
 * settings `prepare` command runs as `cmd.exe /d /s /c <command>`, and node's default Windows quoting turns the
 * quotes inside `<command>` into `\"`, which cmd keeps literally — so a quoted path such as `"C:\a b"` would reach
 * the command as `\"C:\a b\"`. No other call site needs it, because they all pass plain argument vectors.
 *
 * @throws CliError when the command cannot start, exits non-zero, or is stopped before it finishes.
 */
export async function runAsWorker(argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>,
  verbatim = false): Promise<string> {
  const [program, ...args] = argv
  if (!program) throw new CliError('runAsWorker needs a command to run')
  const child = spawn(program, args, { cwd, env: workerEnvironment(env), signal, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, windowsVerbatimArguments: verbatim })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { if (stdout.length < STDOUT_MAX_BYTES) stdout += chunk.slice(0, STDOUT_MAX_BYTES - stdout.length) })
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.slice(0, STDERR_MAX_BYTES - stderr.length) })
  const { code, error } = await new Promise<{ code: number | null; error?: Error }>(done => {
    child.once('error', (error: Error) => done({ code: null, error }))
    child.once('close', (code: number | null) => done({ code }))
  })
  if (error) throw new CliError(error.name === 'AbortError' ? `${argv.join(' ')} was stopped before it finished` : error.message)
  if (code === 0) return stdout
  const ended = code === null ? 'was stopped before it finished' : `exited with ${code}`
  throw new CliError(stderr.trim() || `${argv.join(' ')} ${ended}`, undefined, code ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
