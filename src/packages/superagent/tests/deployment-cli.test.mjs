/**
 * @pneuma/superagent 的命令层与部署校验包级测试：GitHub 路径限本仓库、命令错误归一化、配置 schema、
 * 可执行文件解析、GitHub/飞书账号检查（全部用假 probe，不跑真 gh / lark-cli）。
 *
 * 为什么这些要单独钉：`Commands.path` 是「worker 的 GitHub 调用不许越出配置的仓库」这条边界，
 * 判错一次就是 worker 能拿部署账号调任意 API；`resolveDeployment` 的判定顺序决定面板上报哪个
 * 设置错误（仓库没填 vs CLI 没装 vs 没登录），顺序一变文案就指错地方；这些全都靠假 probe 断言，
 * 真跑 gh 既不稳定也要网络。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/deployment-cli
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { z } from 'zod'

const { Commands, CliError, commandError, validItems } =
  await import('../../../../lib/packages/superagent/infra/commands.js')
const { Config, SETUP_FIELDS, executable, machineOf, resolveDeployment, resolveFeishuBot } =
  await import('../../../../lib/packages/superagent/deployment.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一份解析完成的部署：`github.cli` 给个不存在的程序，真跑必然报错——正好证明「该拒的在跑之前就拒了」。 */
const deployment = {
  stateDir: '/state',
  promptMaxChars: 100000,
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000,
  repository: 'owner/repo',
  github: { cli: '/definitely/not/a/real/gh', login: 'bot', noreply: '' },
}

/** 造一个 Commands，并把 `run` 换成记录参数的假实现（不 spawn 任何进程）。 */
function makeCommands(output = '') {
  const calls = []
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  commands.run = async (program, args, cwd) => {
    calls.push({ program, args, cwd })
    return typeof output === 'function' ? output(program, args) : output
  }
  return { commands, calls }
}

/** 机器配置夹具（部署校验只读 stateDir 与三个读数）。 */
const machine = { stateDir: '/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }

// ── 1. GitHub 路径限本仓库 ─────────────────────────────────────────────────

test('api：绝对路径、URL、点目录全部拒绝，且一次 gh 都没跑', async () => {
  const { commands, calls } = makeCommands()
  for (const outside of ['/users/x', 'https://api.github.com/users/x', '../x', './x', 'a/../b', 'a/./b']) {
    await assert.rejects(commands.api(outside), { message: 'GitHub calls are restricted to the configured repository' }, `应该拒绝：${outside}`)
  }
  await assert.rejects(commands.api(z.object({}), '../x'), { message: 'GitHub calls are restricted to the configured repository' })
  assert.deepEqual(calls, [], '被拒的路径不许先跑 gh 再报错')
  passed += 1
})

test('api：仓库内的相对路径拼成 repos/<repository>/<path>，空路径落到仓库根', async () => {
  const { commands, calls } = makeCommands()
  assert.equal(await commands.api('issues'), '', '不解析的重载返回原始 stdout（这里空串）')
  assert.equal(await commands.api(''), '', '空路径 = 仓库根')
  assert.deepEqual(calls, [
    { program: deployment.github.cli, args: ['api', 'repos/owner/repo/issues'], cwd: undefined },
    { program: deployment.github.cli, args: ['api', 'repos/owner/repo'], cwd: undefined },
  ])
  assert.equal(commands.repository, 'owner/repo')
  passed += 1
})

test('api：带 schema 的重载解析 JSON，flags 原样跟在路径后', async () => {
  const { commands, calls } = makeCommands('{"ok":true}')
  const result = await commands.api(z.object({ ok: z.boolean() }), 'issues', '--jq', '.')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls[0].args, ['api', 'repos/owner/repo/issues', '--jq', '.'])
  const wrong = makeCommands('{"ok":"yes"}')
  await assert.rejects(wrong.commands.api(z.object({ ok: z.boolean() }), 'issues'), 'JSON 不符合 schema 要抛')
  passed += 1
})

test('pages：按页拍平、跳过坏条目并记进 tally', async () => {
  const { commands } = makeCommands('[[{"a":1},{"b":2}],[{"a":3}]]')
  const tally = { skipped: 0 }
  const items = await commands.pages(z.object({ a: z.number() }), 'issues', tally)
  assert.deepEqual(items, [{ a: 1 }, { a: 3 }], '坏条目（缺 a）跳过')
  assert.equal(tally.skipped, 1)
  passed += 1
})

test('withSignal：不传信号原样返回自己，传了就基于合并信号造新的执行器', () => {
  const { commands } = makeCommands()
  assert.equal(commands.withSignal(), commands)
  const scoped = commands.withSignal(new AbortController().signal)
  assert.notEqual(scoped, commands)
  assert.equal(scoped.repository, 'owner/repo', '新执行器读同一份部署')
  passed += 1
})

// ── 2. 命令错误归一化 ──────────────────────────────────────────────────────

test('commandError：JSON 诊断取 message 与 GitHub 错误码，不回显 argv', () => {
  const error = commandError({ code: 1, stderr: '{"error":{"message":"Not Found","code":404}}' }, 'gh')
  assert.equal(error instanceof CliError, true)
  assert.equal(error.message, 'Not Found (404)')
  assert.equal(error.code, 404)
  assert.equal(error.exitCode, 1)
  passed += 1
})

test('commandError：非 JSON 的 stderr 保留，并从 HTTP 行取状态码', () => {
  const withHttp = commandError({ code: 1, stderr: 'gh: Not Found (HTTP 404)\n' }, 'gh')
  assert.equal(withHttp.message, 'gh: Not Found (HTTP 404)', '首尾空白要去掉')
  assert.equal(withHttp.code, 404)
  const plain = commandError({ code: 1, stderr: 'boom\n' }, 'gh')
  assert.equal(plain.message, 'boom')
  assert.equal(plain.code, undefined)
  passed += 1
})

test('commandError：超时、被信号停、输出超上限、退出码各有一句能看的话', () => {
  assert.equal(commandError({ killed: true, signal: 'SIGTERM' }, 'gh').message, 'gh timed out after 90 s')
  assert.equal(commandError({ signal: 'SIGKILL' }, 'gh').message, 'gh was stopped by SIGKILL')
  assert.equal(commandError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'gh').message, 'gh printed more output than it may')
  assert.equal(commandError({ code: 2 }, 'gh').message, 'gh exited with code 2')
  assert.equal(commandError({ code: 'ENOENT' }, 'gh').message, 'gh could not run: ENOENT')
  assert.equal(commandError({}, 'gh').message, 'gh failed')
  passed += 1
})

test('commandError：AbortError 原样返回（调用方按取消处理，不当成命令失败）', () => {
  const aborted = new Error('This operation was aborted')
  aborted.name = 'AbortError'
  assert.equal(commandError(aborted), aborted)
  passed += 1
})

test('validItems：按 schema 逐条解析，跳过的条数记进 tally', () => {
  const schema = z.object({ a: z.number() })
  const tally = { skipped: 0 }
  assert.deepEqual(validItems(schema, [{ a: 1 }, { a: 'x' }, { b: 2 }, { a: 3 }], tally), [{ a: 1 }, { a: 3 }])
  assert.equal(tally.skipped, 2)
  assert.deepEqual(validItems(schema, [{ a: 1 }]), [{ a: 1 }], '不传 tally 也能用')
  passed += 1
})

// ── 3. 配置 schema 与可执行文件解析 ────────────────────────────────────────

test('Config：stateDir 必填且必须是绝对路径，三个读数有上游默认值', () => {
  assert.throws(() => Config.parse({}), 'stateDir 必填')
  assert.throws(() => Config.parse({ stateDir: 'relative/dir' }), 'stateDir 必须是绝对路径')
  const parsed = Config.parse({ stateDir: '/state' })
  assert.deepEqual(machineOf(parsed), machine, '默认值：100000 / 10 / 15000')
  assert.equal(Config.parse({ stateDir: '/state', promptMaxChars: 123456 }).promptMaxChars, 123456, '范围内照收')
  assert.throws(() => Config.parse({ stateDir: '/state', promptMaxChars: 1 }), '小于 LIMITS 下限要拒')
  passed += 1
})

test('SETUP_FIELDS：GitHub 两个字段、飞书一个，供设置页判断「改完要不要重启部署检查」', () => {
  assert.deepEqual(SETUP_FIELDS, { github: ['repository', 'cli'], feishu: ['cli'] })
  passed += 1
})

test('machineOf：旧键逐个点名「搬到哪去了」，配置本体原样透传', () => {
  const moved = Config.parse({ stateDir: '/state', repository: 'owner/repo', worktreeRoot: '/tmp/x' })
  assert.equal(moved.repository, 'owner/repo', 'Config 用 loose：未声明键不能被静默剥掉，否则下面的提示成了死代码')
  assert.throws(() => machineOf(moved), {
    message: 'dsh-superagent configuration has keys it does not use: repository (now on the GitHub Source), worktreeRoot (now the ticket directory of the Execution settings); docs/006-deployment.md lists the keys',
  })
  const unknown = Config.parse({ stateDir: '/state', mystery: 1 })
  assert.throws(() => machineOf(unknown), /keys it does not use: mystery; docs\/006-deployment\.md/)
  passed += 1
})

test('executable：命令行与绝对路径两种写法，找不到/写法不对各有原话', () => {
  assert.equal(executable(process.execPath, ''), process.execPath, '绝对路径直接验文件')
  assert.throws(() => executable('bin/gh', ''), { message: 'bin/gh must be a command name or an absolute path' })
  assert.throws(() => executable('/definitely/not/a/real/gh', ''), { message: '/definitely/not/a/real/gh is not an executable file' },
    '绝对路径不再补「on PATH」')
  assert.throws(() => executable('gh', ''), { message: 'gh is not an executable file on PATH' })
  passed += 1
})

// ── 4. GitHub 账号与仓库权限 ───────────────────────────────────────────────

test('resolveDeployment：身份、仓库名、noreply 邮箱一次配齐，仓库名用 GitHub 回的全名', async () => {
  const calls = []
  const probe = async (argv) => {
    calls.push(argv)
    return argv[2] === 'user'
      ? JSON.stringify({ login: 'Alice', id: 42 })
      : JSON.stringify({ name: 'Owner/Repo', push: true })
  }
  const resolved = await resolveDeployment(machine, { repository: 'owner/repo', cli: process.execPath }, probe)
  assert.equal(resolved.repository, 'Owner/Repo', '用 GitHub 回的全名，重命名后的仓库才能对上通知')
  assert.equal(resolved.github.cli, process.execPath)
  assert.equal(resolved.github.login, 'Alice')
  assert.equal(resolved.github.noreply, '42+Alice@users.noreply.github.com')
  assert.equal(resolved.stateDir, '/state')
  assert.deepEqual(calls[1], [process.execPath, 'api', 'repos/owner/repo', '--jq', '{name: .full_name, push: .permissions.push}'])
  passed += 1
})

test('resolveDeployment：判定顺序 仓库未配 → CLI 未配 → CLI 找不到 → 没登录 → 没报账号 → 读不到 → 没报仓库 → 只读', async () => {
  const reject = (promise, message) => assert.rejects(promise, (error) => {
    assert.equal(error.message, message)
    return true
  })
  await reject(resolveDeployment(machine, {}, async () => '{}'), 'The GitHub Source names no repository.')
  await reject(resolveDeployment(machine, { repository: 'owner/repo' }, async () => '{}'), 'The agent GitHub CLI is not set.')
  await reject(resolveDeployment(machine, { repository: 'owner/repo', cli: '/definitely/not/a/real/gh' }, async () => '{}'),
    'The agent GitHub CLI was not found.\n/definitely/not/a/real/gh is not an executable file')
  await reject(resolveDeployment(machine, { repository: 'owner/repo', cli: process.execPath }, async () => { throw new Error('permission denied') }),
    'The agent GitHub CLI cannot read its account.\npermission denied')
  await reject(resolveDeployment(machine, { repository: 'owner/repo', cli: process.execPath }, async () => 'not json'),
    'The agent GitHub CLI did not report a GitHub account.')
  await reject(resolveDeployment(machine, { repository: 'owner/repo', cli: process.execPath }, async () => JSON.stringify({ login: 'Alice', id: 42 })),
    'The agent GitHub CLI did not return owner/repo.')
  await reject(resolveDeployment(machine, { repository: 'owner/repo', cli: process.execPath }, async (argv) => argv[2] === 'user'
    ? JSON.stringify({ login: 'Alice', id: 42 })
    : JSON.stringify({ name: 'owner/repo', push: false })), '@Alice cannot push to owner/repo.')
  passed += 1
})

test('resolveDeployment：读仓库失败时把 GitHub 的原话带上，place 仍是 github', async () => {
  const probe = async (argv) => {
    if (argv[2] === 'user') return JSON.stringify({ login: 'Alice', id: 42 })
    throw new Error('HTTP 403')
  }
  await assert.rejects(resolveDeployment(machine, { repository: 'owner/repo', cli: process.execPath }, probe), (error) => {
    assert.equal(error.message, '@Alice cannot read owner/repo.\nHTTP 403')
    assert.equal(error.place, 'github')
    assert.equal(error.code, 'repositoryUnreadable')
    return true
  })
  passed += 1
})

// ── 5. 飞书机器人身份 ──────────────────────────────────────────────────────

test('resolveFeishuBot：没配就返回 undefined，一次 probe 都不跑', async () => {
  const calls = []
  const probe = async (argv) => { calls.push(argv); return '' }
  assert.equal(await resolveFeishuBot(machine, undefined, probe), undefined)
  assert.equal(await resolveFeishuBot(machine, {}, probe), undefined)
  assert.deepEqual(calls, [])
  passed += 1
})

test('resolveFeishuBot：strict mode 的 bot 身份，返回 app、品牌与 open_id', async () => {
  const seen = []
  const probe = async (argv, env) => {
    seen.push({ args: argv.slice(1), env })
    if (argv[1] === 'auth') return JSON.stringify({ appId: 'cli_abc123', brand: 'lark', identities: { bot: { status: 'ready' } } })
    if (argv[1] === 'config') return 'strict-mode: bot\n'
    return JSON.stringify({ bot: { open_id: 'ou_abc123', app_name: 'Pneuma Bot' } })
  }
  const bot = await resolveFeishuBot(machine, { cli: process.execPath }, probe)
  assert.deepEqual(bot, { cli: process.execPath, appId: 'cli_abc123', brand: 'lark', botId: 'ou_abc123', name: 'Pneuma Bot' })
  assert.equal(seen[0].args[0], 'auth')
  assert.equal(seen[0].env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1', '不弹 lark-cli 的更新提示')
  assert.equal(seen[0].env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1', '不弹 lark-cli 的技能提示')
  assert.deepEqual(seen[2].args, ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'])
  passed += 1
})

test('resolveFeishuBot：CLI 找不到、身份没 ready、允许 user 身份、没报 app、没报 open_id 依次拒绝', async () => {
  const reject = (promise, message) => assert.rejects(promise, (error) => {
    assert.equal(error.message, message)
    return true
  })
  await reject(resolveFeishuBot(machine, { cli: '/definitely/not/a/real/lark-cli' }, async () => ''),
    'The bot lark-cli does not work.\n/definitely/not/a/real/lark-cli is not an executable file')
  await reject(resolveFeishuBot(machine, { cli: process.execPath }, async (argv) => argv[1] === 'auth'
    ? JSON.stringify({ appId: 'cli_abc123', identities: { bot: { status: 'pending' } } })
    : ''), 'The bot identity of app cli_abc123 is pending; configure the app secret with lark-cli.')
  await reject(resolveFeishuBot(machine, { cli: process.execPath }, async (argv) => {
    if (argv[1] === 'auth') return JSON.stringify({ appId: 'cli_abc123', identities: { bot: { status: 'ready' } } })
    if (argv[1] === 'config') return 'strict-mode: user'
    return ''
  }), 'The bot lark-cli allows user identities (strict mode user); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.')
  await reject(resolveFeishuBot(machine, { cli: process.execPath }, async () => 'not json'), 'auth status of the bot lark-cli did not report the app.')
  await reject(resolveFeishuBot(machine, { cli: process.execPath }, async (argv) => {
    if (argv[1] === 'auth') return JSON.stringify({ appId: 'cli_abc123', identities: { bot: { status: 'ready' } } })
    if (argv[1] === 'config') return 'strict-mode: bot'
    return 'not json'
  }), 'The Feishu bot API did not return the bot\'s open_id.')
  passed += 1
})
