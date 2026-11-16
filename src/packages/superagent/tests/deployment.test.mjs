/**
 * @pneuma/superagent 部署校验的包级测试：转写自上游 `tests/deployment.spec.ts`（vitest → node:test）。
 *
 * 为什么这些要单独钉：`resolveDeployment` / `resolveFeishuBot` 的**判定顺序**决定面板上报哪条设置错误
 * （仓库没填 vs CLI 没装 vs 没登录 vs 没推权限）；顺序一变，操作员照着提示改的地方就错了。`machineOf`
 * 的未知键检查是「旧配置搬家后不静默忽略」的唯一提示，`executable` 的排除规则决定 worker 会不会绕回
 * 自己的 shim 目录。全部靠假 probe 断言，不跑真 gh / lark-cli，也不碰网络与 `~/.dsc`。
 *
 * 上游夹具用 `#!/bin/sh` 脚本当假 CLI，本仓（Windows 也在跑）改成「真文件 + 假 probe」：
 * `executable` 仍解析临时目录里的真文件（`bin/gh`、`bin/lark-cli`），账号检查的返回由 `probe` 给。
 * 与上游的 API 差异按实现文件的移植说明办：`Config` 是 zod 对象（`Config.parse(...)`，上游是
 * `Config(...)`）、`Machine` 里的三个读数是普通 number（上游是 cordis 的 `Volatile`，测试里 `.get()`）。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/deployment
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { after, test } from 'node:test'

const { Config, executable, machineOf, resolveDeployment, resolveFeishuBot } =
  await import('../../../../lib/packages/superagent/deployment.js')
const { SetupError } = await import('../../../../lib/packages/superagent/setup.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  rmSync(dir, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'deployment-'))
/** 真 stateDir：它的 worker-bin 里放同名假 CLI，用来证明 PATH 扫描会跳过 shim 目录。 */
const stateDir = join(dir, 'state')
/** 假 CLI 所在的普通目录。 */
const bin = join(dir, 'bin')
mkdirSync(join(stateDir, 'worker-bin'), { recursive: true })
mkdirSync(bin, { recursive: true })
/** 写一个「可执行文件」；`executable` 只看是不是文件 + 有没有执行位，内容并不跑。 */
const program = (file, body = '') => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
program(join(bin, 'gh'))
program(join(bin, 'lark-cli'))
program(join(stateDir, 'worker-bin', 'gh'))

/** 上游夹具同款的 PATH：shim 目录（两种写法）+ 假 CLI 目录 + 系统目录。 */
const path = [
  join(stateDir, 'worker-bin'), `${join(stateDir, 'worker-bin')}${sep}`,
  bin, '/usr/bin', '/bin',
].join(delimiter)

/** 机器配置：三个读数已是普通 number（上游是 Volatile，测试里 `.get()`）。 */
const base = { stateDir, promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }

/**
 * 假 probe：`handler(argv, env)` 的返回值原样交给调用方，抛错就当 CLI 失败；记下每次调用的 argv / env。
 */
function probeOf(handler) {
  const calls = []
  const probe = async (argv, env) => {
    calls.push({ argv, env })
    return handler(argv, env)
  }
  probe.calls = calls
  return probe
}

/** 真 resolved deployment 的 GitHub probe：`api user` 与 `api repos/...` 各回一份 JSON。 */
const githubProbe = (login = 'Agent-Bot', push = true) => probeOf((argv) => argv[2] === 'user'
  ? JSON.stringify({ login, id: 7 })
  : JSON.stringify({ name: 'acme/widgets', push }))

/** 断言一个 SetupError：位置、代码、以及点名提到的 values（RegExp 用 match，其余相等）。 */
async function rejectsSetup(promise, place, code, values = {}) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof SetupError, true)
    assert.equal(error.place, place)
    assert.equal(error.code, code)
    for (const [name, expected] of Object.entries(values)) {
      if (expected instanceof RegExp) assert.match(String(error.values[name]), expected)
      else assert.equal(error.values[name], expected)
    }
    return true
  })
}

// ── 1. 配置 schema ─────────────────────────────────────────────────────────

test('Config：只要求 stateDir 且必须是绝对路径，三个读数有上游默认值', () => {
  assert.throws(() => Config.parse({}), /stateDir/)
  assert.deepEqual(machineOf(Config.parse({ stateDir: '/state' })),
    { stateDir: '/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
  assert.throws(() => Config.parse({ stateDir: 'relative/dir' }))
  assert.throws(() => Config.parse({ stateDir: '~/dir' }))
  passed += 1
})

test('machineOf：配置里没定义的键逐个点名，旧键还要说「搬到哪去了」', () => {
  const raw = Config.parse({ stateDir: '/state', repository: 'acme/widgets', repositoryPath: '/srv/widgets',
    blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
  assert.throws(() => machineOf(raw), {
    message: 'dsh-superagent configuration has keys it does not use: repository (now on the GitHub Source), '
      + 'repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), '
      + 'author (now prompt text), extra; docs/006-deployment.md lists the keys',
  })
  passed += 1
})

// ── 2. 启动校验 ────────────────────────────────────────────────────────────

test('resolveDeployment：仓库名与账号都取自 CLI，PATH 扫描跳过 worker shim，仓库名用 GitHub 回的全名', async () => {
  const deployment = await resolveDeployment(base, { repository: 'acme/widgets', cli: 'gh' }, githubProbe(), path)
  assert.equal(deployment.repository, 'acme/widgets')
  assert.deepEqual(deployment.github,
    { cli: join(bin, 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
  assert.equal(deployment.stateDir, stateDir)
  assert.equal(Object.hasOwn(deployment, 'feishu'), false)
  // 改名后的仓库仍用旧名字查到（通知里带的是 GitHub 当前的全名）。
  const renamed = await resolveDeployment(base, { repository: 'acme/gadgets', cli: 'gh' },
    probeOf((argv) => argv[2] === 'user' ? JSON.stringify({ login: 'Agent-Bot', id: 7 }) : JSON.stringify({ name: 'acme/widgets', push: true })), path)
  assert.equal(renamed.repository, 'acme/widgets')
  passed += 1
})

test('resolveDeployment：依次点名缺什么、在哪设置，CLI 找不到 / 没登录 / 只读各报各的', async () => {
  const repository = 'acme/widgets'
  await rejectsSetup(resolveDeployment(base, { cli: 'gh' }, githubProbe(), path), 'github', 'repositoryUnset')
  await rejectsSetup(resolveDeployment(base, { repository }, githubProbe(), path), 'github', 'agentCliUnset')
  await rejectsSetup(resolveDeployment(base, { repository, cli: join(dir, 'missing') }, githubProbe(), path),
    'github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` })
  await rejectsSetup(resolveDeployment(base, { repository, cli: 'bin/gh' }, githubProbe(), path),
    'github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' })
  await rejectsSetup(resolveDeployment(base, { repository, cli: 'gh' }, probeOf(() => { throw new Error('not signed in') }), path),
    'github', 'agentCliSignedOut', { output: 'not signed in' })
  await rejectsSetup(resolveDeployment(base, { repository, cli: 'gh' }, githubProbe('Agent-Bot', false), path),
    'github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' })
  // 登录了，但读不到仓库（私有仓库掉权限时 GitHub 回 404）。
  const unreadable = probeOf((argv) => {
    if (argv[2] === 'user') return JSON.stringify({ login: 'Agent-Bot', id: 7 })
    throw new Error('HTTP 404')
  })
  await rejectsSetup(resolveDeployment(base, { repository, cli: 'gh' }, unreadable, path),
    'github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output: /HTTP 404/ })
  await rejectsSetup(resolveDeployment(base, { repository, cli: 'gh' }, probeOf(() => '{}'), path), 'github', 'agentCliNoAccount')
  assert.throws(() => executable('nothing-here', bin), { message: 'nothing-here is not an executable file on PATH' })
  passed += 1
})

test('resolveFeishuBot：strict mode 的 bot 身份才认，没配 CLI 时一次 probe 都不跑', async () => {
  const silent = probeOf(() => '')
  assert.equal(await resolveFeishuBot(base, {}, silent, path), undefined)
  assert.equal(await resolveFeishuBot(base, undefined, silent, path), undefined)
  assert.deepEqual(silent.calls, [])
  const probe = probeOf((argv) => {
    if (argv[1] === 'auth') return JSON.stringify({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } })
    if (argv[1] === 'config') return 'strict-mode: bot (source: profile)'
    return JSON.stringify({ bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' } })
  })
  assert.deepEqual(await resolveFeishuBot(base, { cli: 'lark-cli' }, probe, path),
    { cli: join(bin, 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
  assert.equal(probe.calls[0].env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1', '不弹 lark-cli 的更新提示')
  assert.equal(probe.calls[0].env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1', '不弹 lark-cli 的技能提示')
  passed += 1
})

test('resolveFeishuBot：CLI 不通、身份没 ready、允许 user 身份、没报 app、没报 open_id 依次拒绝', async () => {
  /** 造一份假 lark-cli：auth / strict-mode / bot info 三个回答可换。 */
  const feishuProbe = ({ auth, mode = 'bot', bot, error } = {}) => probeOf((argv) => {
    if (error) throw error
    if (argv[1] === 'auth') return auth ?? JSON.stringify({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } })
    if (argv[1] === 'config') return `strict-mode: ${mode} (source: profile)`
    return bot ?? JSON.stringify({ bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' } })
  })
  await rejectsSetup(resolveFeishuBot(base, { cli: 'lark-cli' }, feishuProbe({ error: new Error('not configured') }), path),
    'feishu', 'feishuCliFailed', { output: /not configured/ })
  await rejectsSetup(resolveFeishuBot(base, { cli: 'lark-cli' }, feishuProbe({ auth: JSON.stringify({ identities: { bot: { status: 'ready' } } }) }), path),
    'feishu', 'feishuNoApp')
  await rejectsSetup(resolveFeishuBot(base, { cli: 'lark-cli' }, feishuProbe({
    auth: JSON.stringify({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }),
  }), path), 'feishu', 'feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
  await rejectsSetup(resolveFeishuBot(base, { cli: 'lark-cli' }, feishuProbe({ mode: 'off' }), path),
    'feishu', 'feishuUserIdentity', { mode: 'off' })
  await rejectsSetup(resolveFeishuBot(base, { cli: 'lark-cli' }, feishuProbe({ bot: JSON.stringify({ code: 0, data: {} }) }), path),
    'feishu', 'feishuNoBot')
  passed += 1
})
