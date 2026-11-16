/**
 * @pneuma/superagent 的 worker 环境与 shim 包级测试：转写自上游 `tests/environment.spec.ts`
 * （vitest → node:test）。
 *
 * 为什么这些要单独钉：`writeEnvironment` 往 stateDir 里写的 shim 与 gitconfig 是 worker 的
 * 默认路径护栏——shim 若没剥掉自己的目录，`gh` 包装脚本会再解析回 shim 形成死循环；gitconfig
 * 若没排除操作员的全局配置，worker 的 push 会走错账号、提交会带上操作员身份；`verifyDirectory`
 * 若把仓库自己配的 `credential.*` 当没事，worker 的 git 会拿仓库里的配置去认证。所以每条都断言
 * 具体的文件内容 / git 行为，而不只是「没抛」。
 *
 * 上游夹具用 `#!/bin/sh` 脚本当 CLI、用 DSH 的子进程运行时当执行器；本仓（Windows 也在跑）的分工是：
 *   - 生成物与文件所有权、git 配置、PATH 去重、`runAsWorker` 的退出码与凭证变量剥离：直接测，跨平台；
 *   - 真正**执行** `/bin/sh` shim、以及用 sh 脚本当 askpass 的两条：本机没有 POSIX `sh`，标记 skip
 *     （在 POSIX 上仍会跑），不伪造通过；
 *   - 上游 `subprocess` 假件没有对应物：本仓的 `runAsWorker` 直接 spawn，测试直接调它。
 * `SENSITIVE_ENV_PATTERN` 来自上游的 DSH 包，本仓对应 `infra/environment.ts` 内部常量，测试里按
 * 同一条规则（`KEY|PASSWORD|SECRET|TOKEN`）复写一份，并在「凭证变量不进子进程」用例里钉住。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/environment
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

const { GIT_LOCATION, agentVariables, applyEnvironment, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment } =
  await import('../../../../lib/packages/superagent/infra/environment.js')
const { CliError } = await import('../../../../lib/packages/superagent/infra/commands.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  rmSync(dir, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'environment-'))
const execute = promisify(execFile)
/** 写一个「可执行文件」；本机只读它的内容，POSIX 用例里才会真的执行。 */
const program = (file, body = '') => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
const read = (file) => readFileSync(file, 'utf8')

/** 每个用例一个自己的目录（含 `real/`），互不干扰。 */
let cases = 0
function caseDir() {
  const value = join(dir, `case-${++cases}`)
  mkdirSync(join(value, 'real'), { recursive: true })
  return value
}

/** 上游 `testDeployment` 的同形夹具：默认账号是 agent-bot，仓库固定 acme/widgets。 */
function deploymentOf(overrides = {}) {
  return {
    stateDir: overrides.stateDir ?? caseDir(),
    promptMaxChars: 100000,
    admissionContextMaxPages: 10,
    admissionContextTimeoutMs: 15000,
    repository: 'acme/widgets',
    github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...overrides,
  }
}

/** 上游 DSH 运行时剥凭证变量的规则；本仓 `infra/environment.ts` 用同一条正则自己剥。 */
const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i
/** worker 看到的进程环境：去掉 undefined，以及名字像凭证的变量。 */
const workerEnv = (env) => Object.fromEntries(Object.entries(env)
  .filter(([name, value]) => value !== undefined && !CREDENTIAL_NAME.test(name)))

/** 测试自己跑 git 用的干净环境：不继承宿主「我在哪个仓库里」的变量（`git rebase --exec` 会传这些）。 */
function cleanGitEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of [...GIT_LOCATION, 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete env[name]
  return { ...env, ...extra }
}

/** 在 `cwd` 跑一条 git，返回 trim 过的 stdout（测试自己的 git，与 worker 的隔离无关）。 */
const gitAt = async (cwd, args, env = {}) => (await execute('git', args, { cwd, env: cleanGitEnv(env) })).stdout.trim()

/**
 * 在隔离的 git 环境里跑一段：全局配置指向临时空文件、关系统配置、清掉指路变量。
 * `verifyDirectory` / `verifyEnvironment` 读的是**当前进程**环境（上游读注入的 subprocess），所以只能这样隔离。
 */
async function isolated(state, run) {
  const globalConfig = join(state, 'global-gitconfig')
  writeFileSync(globalConfig, '')
  const names = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_CEILING_DIRECTORIES', ...GIT_LOCATION]
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  try {
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    for (const name of names.slice(2)) delete process.env[name]
    return await run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

// ── 1. 生成物：shim 与 gitconfig 的内容 ────────────────────────────────────

test('worker shim：首两行是 shebang 与归属标记，先剥掉 shim 目录再从 PATH 里 exec 真 CLI', async () => {
  const state = caseDir()
  const cli = join(state, 'real', 'gh')
  await writeEnvironment(deploymentOf({ stateDir: state, github: { ...deploymentOf().github, cli }, feishu: undefined }), [])
  const bin = workerBin(state)
  const shim = read(join(bin, 'gh'))
  const lines = shim.split('\n')
  assert.equal(lines[0], '#!/bin/sh')
  assert.equal(lines[1], '# Written by dsh-superagent on every start; edits are lost.')
  assert.equal(shim.includes(`self='${bin}'`), true, '按绝对路径认出自己，才能从 PATH 里剥掉')
  assert.equal(shim.includes(`exec '${cli}' "$@"`), true, '最后 exec 真 CLI，参数与 stdin 原样透传')
  assert.equal(shim.includes('PATH=$rest'), true, '其他 PATH 项按原顺序保留')
  assert.deepEqual(readdirSync(bin).sort(), ['gh', 'lark-cli'])
  passed += 1
})

test('worker shim：没有飞书机器人时 lark-cli 直接失败，被封命令按智能体登录名提示', async () => {
  const state = caseDir()
  await writeEnvironment(deploymentOf({ stateDir: state, feishu: undefined }), ['personal-gh'])
  const bin = workerBin(state)
  const lark = read(join(bin, 'lark-cli'))
  assert.equal(lark.includes('lark-cli is unavailable: this installation has no Feishu bot.'), true)
  assert.equal(lark.includes('exit 1'), true)
  assert.equal(read(join(bin, 'personal-gh')).includes('personal-gh is blocked in this installation; use gh, which acts as agent-bot.'), true)
  passed += 1
})

test('worker shim：blockedCommands 点名 gh / git / lark-cli 时不重复写 shim，git 永远不写', async () => {
  const state = caseDir()
  await writeEnvironment(deploymentOf({ stateDir: state }), ['gh', 'git', 'lark-cli'])
  const bin = workerBin(state)
  assert.deepEqual(readdirSync(bin).sort(), ['gh', 'lark-cli'])
  assert.equal(readdirSync(bin).includes('git'), false)
  passed += 1
})

// ── 2. 文件所有权 ──────────────────────────────────────────────────────────

test('只替换自己写的文件：标记不在前两行、符号链接、外来的 gitconfig 一律拒绝且不改写', async () => {
  const state = caseDir()
  await writeEnvironment(deploymentOf({ stateDir: state }), ['old-cli'])
  await writeEnvironment(deploymentOf({ stateDir: state }), [])
  const bin = workerBin(state)
  assert.deepEqual(readdirSync(bin).sort(), ['gh', 'lark-cli'])
  // 标记出现在第三行的文件不算自己写的。
  const marker = read(join(bin, 'gh')).split('\n')[1]
  writeFileSync(join(bin, 'notes'), `notes\nmore\n${marker}\n`)
  await assert.rejects(writeEnvironment(deploymentOf({ stateDir: state }), []), (error) => {
    assert.equal(error.code, 'foreignFile')
    assert.match(error.message, /notes was not written by dsh-superagent/)
    return true
  })
  rmSync(join(bin, 'notes'))
  // 符号链接也不算自己写的；Windows 没有建链接的权限时跳过这一小段。
  let linked = true
  try { symlinkSync(join(bin, 'gh'), join(bin, 'link')) } catch { linked = false }
  if (linked) {
    await assert.rejects(writeEnvironment(deploymentOf({ stateDir: state }), []), /link was not written by dsh-superagent/)
    rmSync(join(bin, 'link'))
  }
  // 外来的 gitconfig：拒绝，且一个字节都不改。
  writeFileSync(workerGitConfig(state), '[user]\n\tname = someone\n')
  await assert.rejects(writeEnvironment(deploymentOf({ stateDir: state }), []), /worker-gitconfig was not written by dsh-superagent/)
  assert.equal(read(workerGitConfig(state)), '[user]\n\tname = someone\n')
  passed += 1
})

test('项目早期名字（dsh-tag / dsh-go / dsh-freelancer）写过的文件也归本插件所有并替换', async () => {
  const state = caseDir()
  await writeEnvironment(deploymentOf({ stateDir: state }), ['old-cli', 'older-cli'])
  const bin = workerBin(state)
  const legacy = (file, name) => writeFileSync(file, read(file).replace('Written by dsh-superagent', `Written by ${name}`))
  legacy(join(bin, 'old-cli'), 'dsh-tag')
  legacy(join(bin, 'older-cli'), 'dsh-freelancer')
  legacy(workerGitConfig(state), 'dsh-go')
  await writeEnvironment(deploymentOf({ stateDir: state }), [])
  assert.deepEqual(readdirSync(bin).sort(), ['gh', 'lark-cli'])
  assert.equal(read(workerGitConfig(state)).includes('Written by dsh-superagent'), true)
  passed += 1
})

// ── 3. agent 的 git 配置 ───────────────────────────────────────────────────

test('agent git 配置：忽略操作员的全局/系统配置与凭证变量，提交身份只认显式给出的', async () => {
  const state = caseDir()
  const home = join(state, 'home')
  mkdirSync(home)
  // 操作员的全局配置：把 HTTPS 写成 SSH、强制签名、给一个凭证助手。worker 的 git 一条都不该读到。
  writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n'
    + '[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
  const agent = join(state, 'real', 'gh')
  program(agent, 'exit 0')
  const cli = '/opt/agent tools/gh'
  const base = deploymentOf({ stateDir: state })
  await writeEnvironment({ ...base, github: { ...base.github, cli } }, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev',
    GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(state) })
  const git = async (...args) => (await execute('git', args, { cwd: state, env })).stdout.trim()
  await git('init', '-q', 'repo')
  await execute('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: state, env })
  // insteadOf 来自 worker 的 gitconfig，不是操作员的：push 地址改写成 HTTPS。
  assert.equal(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin'), 'https://github.com/acme/widgets.git')
  const [origin, helper] = (await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).split('\t')
  assert.equal(helper, credentialHelper(cli))
  // Git for Windows 会带引号、并把路径里的反斜杠转义成 `\\`；去掉引号、统一斜杠并折叠后比对（大小写不敏感）。
  const originPath = (value) => value.replace(/^file:"?/i, '').replace(/"$/, '').replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/').toLowerCase()
  assert.equal(originPath(origin), originPath(`file:${workerGitConfig(state)}`))
  assert.equal(await git('config', '--get-all', 'credential.helper'), '', '操作员的凭证助手被清空')
  await assert.rejects(git('config', 'commit.gpgsign'), '操作员的 gpgsign 不该生效')
  await assert.rejects(git('config', 'core.abbrev'), '环境传进来的 git 配置不该生效')
  assert.equal(Object.hasOwn(env, 'GIT_AUTHOR_NAME'), false)
  assert.equal(Object.hasOwn(env, 'GIT_COMMITTER_EMAIL'), false)
  // useConfigOnly：没有显式身份时必须拒绝提交，而不是拿操作系统用户名猜一个。
  await assert.rejects(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity'), (error) => {
    assert.match(String(error.stderr), /no email was given/)
    return true
  })
  await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
  assert.equal(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'Alice <alice@example.com> / Alice <alice@example.com>')
  passed += 1
})

test('credential helper 没答案时直接失败，不去问操作员的 askpass', {
  skip: process.platform === 'win32' ? '需要 POSIX sh 执行 askpass 脚本' : false,
}, async () => {
  const state = caseDir()
  const log = join(state, 'asked')
  const askpass = program(join(state, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const deployment = deploymentOf({ stateDir: state, github: { ...deploymentOf().github, cli: program(join(state, 'real', 'gh'), 'exit 0') } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: state, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(state) })
  await execute('git', ['init', '-q', 'repo'], { cwd: state, env })
  await execute('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: state, env })
  const fill = execute('git', ['-C', 'repo', 'credential', 'fill'], { cwd: state, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await assert.rejects(fill, (error) => {
    assert.match(String(error.stderr), /terminal prompts disabled/)
    return true
  })
  assert.throws(() => read(log), 'askpass 一次都不该被调用')
  passed += 1
})

// ── 4. PATH 去重与 runAsWorker ─────────────────────────────────────────────

test('withoutDirectory：同一目录的每种写法（末尾分隔符、符号链接）都从 PATH 里去掉，其他项保留', () => {
  const state = caseDir()
  const bin = workerBin(state)
  mkdirSync(bin, { recursive: true })
  const link = join(state, 'link')
  let linked = true
  try { symlinkSync(state, link, 'junction') } catch { linked = false }
  const keepA = join(state, 'usr-bin')
  const keepB = join('node_modules', '.bin')
  const entries = [`${bin}${sep}`, bin]
  if (linked) entries.push(join(link, 'worker-bin'))
  entries.push(keepA, keepB)
  assert.equal(withoutDirectory(entries.join(delimiter), bin), [keepA, keepB].join(delimiter))
  passed += 1
})

test('runAsWorker：非零退出抛 CliError 带 stderr 与退出码，名字像凭证的变量不进子进程', async () => {
  const state = caseDir()
  const signal = new AbortController().signal
  const error = await runAsWorker([process.execPath, '-e', 'console.error("nope"); process.exit(3)'], state, signal)
    .catch((caught) => caught)
  assert.equal(error instanceof CliError, true)
  assert.equal(error.message, 'nope')
  assert.equal(error.exitCode, 3)
  const script = 'console.log(JSON.stringify({ token: process.env.SOME_TOKEN ?? null, plain: process.env.PLAIN ?? null }))'
  const output = await runAsWorker([process.execPath, '-e', script], state, signal, { SOME_TOKEN: 'leak', PLAIN: 'kept' })
  assert.deepEqual(JSON.parse(output), { token: null, plain: 'kept' }, 'TOKEN 形态的变量要剥掉，普通变量照传')
  passed += 1
})

test('POSIX：跑 shim 时按名字解析 gh 不回环、保留调用方其他 PATH 项，lark-cli 与被封命令以 1 退出', {
  skip: process.platform === 'win32' ? '本机没有 POSIX sh，无法执行 shim 脚本' : false,
}, async () => {
  const state = caseDir()
  program(join(state, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
  const wrapper = program(join(state, 'gh-agent'), `GH_CONFIG_DIR=${state}/agent-config exec gh "$@"`)
  const base = deploymentOf({ stateDir: state, github: { ...deploymentOf().github, cli: wrapper }, feishu: undefined })
  await writeEnvironment(base, ['personal-gh'])
  const bin = workerBin(state)
  const path = [bin, join(state, 'venv'), join(state, 'real'), '/usr/bin', '/bin'].join(':')
  const { stdout } = await execute('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
  assert.deepEqual(JSON.parse(stdout), { login: 'agent-bot', config: `${state}/agent-config`,
    path: [join(state, 'venv'), join(state, 'real'), '/usr/bin', '/bin'].join(':') })
  await assert.rejects(execute(join(bin, 'lark-cli'), ['im', '+chat-list']),
    { code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
  await assert.rejects(execute(join(bin, 'personal-gh'), []),
    { code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  passed += 1
})

// ── 5. 工单目录检查 ────────────────────────────────────────────────────────

test('verifyDirectory：仓库自己没配凭证相关键时放行，不在任何仓库里的目录也放行', async () => {
  const state = caseDir()
  const repo = join(state, 'repo')
  await gitAt(state, ['init', '-q', 'repo'])
  const signal = new AbortController().signal
  assert.equal(await isolated(state, () => verifyDirectory(repo, signal)), undefined)
  assert.equal(await isolated(state, () => verifyDirectory(join(state, 'real'), signal)), undefined,
    'git config --get-regexp 没命中时以 1 退出，也算通过')
  passed += 1
})

test('verifyDirectory：点名仓库自己配置里的 credential / http.extraheader 键', async () => {
  const state = caseDir()
  const repo = join(state, 'repo')
  await gitAt(state, ['init', '-q', 'repo'])
  await gitAt(repo, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x'])
  const signal = new AbortController().signal
  await assert.rejects(isolated(state, () => verifyDirectory(repo, signal)), /sets http\.https:\/\/github\.com\/\.extraheader/)
  passed += 1
})

test('verifyDirectory：git 读不了仓库配置时失败，而不是当成没问题', async () => {
  const state = caseDir()
  const repo = join(state, 'repo')
  await gitAt(state, ['init', '-q', 'repo'])
  writeFileSync(join(repo, '.git', 'config'), '[core\n')
  const signal = new AbortController().signal
  await assert.rejects(isolated(state, () => verifyDirectory(repo, signal)), /bad config/)
  passed += 1
})

test('宿主环境指名的仓库：worker 环境里一个指路变量都不留，GIT_CEILING_DIRECTORIES 保留', async () => {
  const state = caseDir()
  const scratch = join(state, 'scratch')
  await gitAt(state, ['init', '-q', 'scratch'])
  const config = () => read(join(scratch, '.git', 'config'))
  const before = config()
  const names = [...GIT_LOCATION, 'GIT_CEILING_DIRECTORIES']
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  try {
    // 模拟宿主是在 `git rebase --exec` 里启动的：它指名的仓库与工单目录不是同一个。
    process.env.GIT_DIR = join(scratch, '.git')
    process.env.GIT_WORK_TREE = scratch
    process.env.GIT_CEILING_DIRECTORIES = state
    const env = workerEnv({ ...process.env, ...agentVariables(state) })
    for (const name of GIT_LOCATION) assert.equal(Object.hasOwn(env, name), false, `${name} 不该出现在 worker 环境里`)
    assert.equal(env.GIT_CEILING_DIRECTORIES, state, '运营者设的搜索上界要保留')
    // 应用 worker 环境后，工单目录检查读的是工单仓库，碰不到宿主指名的仓库。
    const repo = join(state, 'repo')
    await gitAt(state, ['init', '-q', 'repo'])
    const restore = applyEnvironment(agentVariables(state), state, process.env.PATH)
    try { await verifyDirectory(repo, new AbortController().signal) } finally { restore() }
    assert.equal(config(), before, '宿主指名的仓库配置一个字都不许改')
    assert.equal(readdirSync(repo).includes('.git'), true)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  passed += 1
})
