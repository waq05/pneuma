/**
 * @pneuma/superagent 命令层的包级测试：转写自上游 `tests/commands.spec.ts`（vitest → node:test）。
 *
 * 为什么这些要单独钉：`Commands` 是 worker 与部署账号之间的唯一出口——GitHub 调用能不能越出配置的
 * 仓库（`path` 的拒绝规则）、失败时上报的是不是「程序名 + 结局」而不是带消息正文的 argv（错误里漏出
 * 回复文本就等于把工单内容写进日志）、飞书「消息已撤回 / 机器人不在群」与 GitHub「Issue 已删 / 已锁」
 * 该丢还是该重试，全由这里判定。判错一次就是重复发帖或永久丢消息。
 *
 * 假件只有 `run` / `gh` / `pages` 三个方法（上游用 `vi.spyOn`，这里直接换方法体），以及一份手写部署；
 * 真跑的子进程只用 `node -e`，不依赖 POSIX 的 `sh` / `sleep`。上游用 `sh -c 'kill -9 $$'` 测的
 * 「被信号停」在本机（Windows）没有对应物，改为直接喂 `commandError` 上游同形的错误对象，语义一致。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/commands
 */
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'

const { CliError, Commands, commandError } = await import('../../../../lib/packages/superagent/infra/commands.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { githubKind } = await import('../../../../lib/packages/superagent/sources/github.js')
const { githubChannel } = await import('../../../../lib/packages/superagent/sources/github-trigger.js')
const { feishuKind } = await import('../../../../lib/packages/superagent/sources/feishu.js')
const { feishuChannel } = await import('../../../../lib/packages/superagent/sources/feishu-trigger.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { key } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一份解析完成的部署（上游 `testDeployment` 的同形夹具）。 */
const deployment = {
  stateDir: '/state',
  promptMaxChars: 100000,
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000,
  repository: 'acme/widgets',
  github: { cli: '/path/agent-gh', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/path/lark-bot', appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' },
}

const commands = () => new Commands(() => deployment, {}, new AbortController().signal)

/** 上游的 `sources` 注册表：出站消息按 channel.source 找到对应 kind 的 channel。 */
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(feishuKind)
sources.register(githubKind)
const send = (value, message) => sources.send(message, value)

/** 上游一条稳定的出站回复；`stable-operation` 同时是重试时的幂等键与去重标记。 */
const reply = { id: 'stable-operation', channel: githubChannel(8), text: 'Done', kind: 'reply' }

/**
 * 换掉一个方法：按顺序返回 `results` 里的值（`Error` 就抛，函数就带着参数调用，队列见底后重复最后一个）。
 * 返回调用记录 `calls`，每项是那次调用的参数数组——替代上游的 `vi.spyOn(...).mockResolvedValue`。
 */
function stub(target, name, ...results) {
  const calls = []
  target[name] = async (...args) => {
    calls.push(args)
    const next = results.length > 1 ? results.shift() : results[0]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(...args) : next
  }
  return calls
}

/** 飞书/命令错误的假件：JSON 诊断里的 code + message 会被 `commandError` 解析出来。 */
const larkError = (code, message) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })

// ── 1. 账号隔离的操作 ──────────────────────────────────────────────────────

test('gh：用部署里配置的 agent GitHub CLI，shell 元字符原样进 argv（不经过 shell）', async () => {
  const value = commands()
  const run = stub(value, 'run', '{}')
  await value.gh(['api', 'some-path', '-f', 'body=`whoami` $(touch x)'])
  assert.deepEqual(run, [['/path/agent-gh', ['api', 'some-path', '-f', 'body=`whoami` $(touch x)']]])
  passed += 1
})

test('run：环境覆盖在 process.env 之上，值为 undefined 的键从子进程环境里删掉', async () => {
  process.env.GH_TOKEN = 'personal'
  try {
    const value = new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal)
    const script = 'console.log(`probe=${process.env.DSH_SUPERAGENT_PROBE};gh=${process.env.GH_TOKEN}`)'
    const output = await value.run(process.execPath, ['-e', script])
    assert.equal(output.includes('probe=agent'), true, '覆盖值要进子进程')
    assert.equal(output.includes('gh=undefined'), true, 'undefined 表示删掉，而不是空串')
    assert.equal(output.includes('personal'), false, '宿主的个人令牌不能漏给 worker')
  } finally {
    delete process.env.GH_TOKEN
  }
  passed += 1
})

test('lark：部署里没有飞书机器人时，跑都不跑直接拒', async () => {
  const noFeishu = { ...deployment, feishu: undefined }
  await assert.rejects(new Commands(() => noFeishu, {}, new AbortController().signal).lark(['im', '+chat-list']),
    { message: 'The Feishu Source has no working bot CLI' })
  passed += 1
})

test('GitHub 重发对账：页面上已有同一 marker 的自家评论时判已发，不再 POST', async () => {
  const value = commands()
  stub(value, 'pages', [{ body: '<!-- dsh-superagent:stable-operation -->', user: { login: 'agent-bot' } }])
  const gh = stub(value, 'gh', {})
  assert.equal(await send(value, reply), 'sent')
  assert.equal(gh.length, 0, '对账命中就不该再发')
  passed += 1
})

test('GitHub 发送：正文按模型原样发，只发到固定仓库，并带上幂等 marker', async () => {
  const value = commands()
  stub(value, 'pages', [])
  const gh = stub(value, 'gh', {})
  assert.equal(await send(value, reply), 'sent')
  assert.deepEqual(gh[0][0], ['api', 'repos/acme/widgets/issues/8/comments', '--method', 'POST', '-f',
    'body=Done\n\n<!-- dsh-superagent:stable-operation -->'])
  // 路径必须在配置的仓库内。
  await assert.rejects(commands().pages(z.unknown(), '../../someone/else/issues'),
    { message: 'GitHub calls are restricted to the configured repository' })
  passed += 1
})

test('GitHub 发送：review 讨论的回复发到根评论的 replies', async () => {
  const value = commands()
  stub(value, 'pages', [])
  const url = 'https://github.com/acme/widgets/pull/8#discussion_r7'
  const gh = stub(value, 'gh', { id: 7, in_reply_to_id: 3 }, {})
  assert.equal(await send(value, { ...reply, channel: githubChannel(8, url) }), 'sent')
  assert.equal(gh[1][0][1], 'repos/acme/widgets/pulls/8/comments/3/replies')
  assert.equal(gh[1][0][5].includes('Done'), true)
  passed += 1
})

test('飞书发送：用 bot 身份，重试时沿用同一条幂等键', async () => {
  const value = commands()
  const run = stub(value, 'run', '{"ok":true,"data":{}}')
  assert.equal(await send(value, { ...reply, channel: feishuChannel('oc_1', 'om_1') }), 'sent')
  const args = run[0][1]
  const flag = (name) => args[args.indexOf(name) + 1]
  assert.equal(flag('--as'), 'bot')
  assert.equal(flag('--idempotency-key'), 'stable-operation')
  assert.equal(flag('--message-id'), 'om_1')
  assert.equal(flag('--format'), 'json')
  passed += 1
})

test('commandError：飞书失败报 message 与业务码，且不回显命令参数', () => {
  const membership = commandError({ stderr: `[page 1] fetching...\n${JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })}` })
  assert.equal(membership.message, 'operator is not in the chat (232011)')
  assert.equal(membership.code, 232011)
  assert.equal(commandError({ stderr: JSON.stringify({ error: { code: 999, message: 'scope missing' } }) }).message, 'scope missing (999)')
  passed += 1
})

// ── 2. 通道：丢还是重试 ────────────────────────────────────────────────────

test('飞书通道：撤回 / 找不到的消息判 gone，机器人不在群给出加群提示，其余照抛', async () => {
  const value = commands()
  const feishu = { ...reply, channel: feishuChannel('oc_1', 'om_1') }
  const run = stub(value, 'run', larkError(230011, 'The message is recalled'), larkError(230001, 'message not found'),
    larkError(231003, 'The message is withdrawn'), larkError(232011, 'operator is not in the chat'), larkError(99991400, 'rate limited'))
  for (let index = 0; index < 3; index += 1) assert.equal(await send(value, feishu), 'gone')
  await assert.rejects(send(value, feishu), { message: 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.' })
  await assert.rejects(send(value, feishu), { message: 'rate limited (99991400)' })
  assert.equal(run.length, 5)
  passed += 1
})

test('飞书通道：命令超时算重试，不因正文里出现 withdrawn 而丢掉回复', async () => {
  const value = commands()
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
  stub(value, 'run', commandError(timedOut, 'lark-bot'))
  await assert.rejects(send(value, { ...reply, channel: feishuChannel('oc_1', 'om_1'), text: 'The change was withdrawn' }),
    { message: 'lark-bot timed out after 90 s' })
  passed += 1
})

test('GitHub 通道：Issue 被删（410）或已锁（403）判 gone，404 / 500 照抛等重试', async () => {
  const value = commands()
  stub(value, 'pages', [])
  const gh = stub(value, 'gh', commandError({ stderr: 'gh: This issue was deleted (HTTP 410)', code: 1 }),
    commandError({ stderr: 'gh: Unable to create comment because issue is locked. (HTTP 403)', code: 1 }),
    commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 }), commandError({ stderr: 'gh: Server Error (HTTP 500)', code: 1 }))
  for (let index = 0; index < 2; index += 1) assert.equal(await send(value, reply), 'gone')
  // 私有仓库掉权限时 GitHub 也回 404，所以 404 不能当成「已删」。
  await assert.rejects(send(value, reply), { message: 'gh: Not Found (HTTP 404)' })
  await assert.rejects(send(value, reply), { message: 'gh: Server Error (HTTP 500)' })
  assert.equal(gh.length, 4)
  passed += 1
})

test('GitHub 通道：review 评论不在了就退回 PR 会话里回', async () => {
  const value = commands()
  const pages = stub(value, 'pages', [])
  const url = 'https://github.com/acme/widgets/pull/8#discussion_r7'
  const gh = stub(value, 'gh', commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 }), {})
  assert.equal(await send(value, { ...reply, channel: githubChannel(8, url) }), 'sent')
  assert.equal(pages[0][1], 'issues/8/comments')
  assert.deepEqual(gh[1][0], ['api', 'repos/acme/widgets/issues/8/comments', '--method', 'POST', '-f',
    'body=Done\n\n<!-- dsh-superagent:stable-operation -->'])
  passed += 1
})

test('link：每个地址都连到它的页面，标签分普通 Issue、review 讨论与飞书消息', () => {
  const links = { repository: 'acme/widgets', feishu: deployment.feishu }
  assert.deepEqual(githubKind.channel.link(githubChannel(8).address, links),
    { url: 'https://github.com/acme/widgets/issues/8', label: { zh: 'GitHub #8', en: 'GitHub #8' } })
  const review = 'https://github.com/acme/widgets/pull/8#discussion_r7'
  assert.deepEqual(githubKind.channel.link(githubChannel(8, review).address, links),
    { url: review, label: { zh: 'GitHub #8 的 review 讨论', en: 'Review discussion on GitHub #8' } })
  assert.equal(githubKind.channel.link(githubChannel(8).address, {}).url, '')
  assert.deepEqual(feishuKind.channel.link(feishuChannel('oc_1', 'om_1').address, links), {
    url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
    label: { zh: '飞书消息', en: 'Feishu message' },
    triggerId: key('feishu', 'om_1'),
  })
  passed += 1
})

// ── 3. GitHub 调用 ─────────────────────────────────────────────────────────

test('api：只走配置仓库内的路径，并按 schema 校验 GitHub 的回答', async () => {
  const value = commands()
  const run = stub(value, 'run', '{"number":12,"title":"Login fails","extra":true}')
  assert.deepEqual(await value.api(z.looseObject({ number: z.number() }), 'issues/12'),
    { number: 12, title: 'Login fails', extra: true })
  assert.deepEqual(run[0], ['/path/agent-gh', ['api', 'repos/acme/widgets/issues/12']])
  await assert.rejects(value.api(z.looseObject({ number: z.string() }), 'issues/12'))
  for (const outside of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
    await assert.rejects(value.api(z.unknown(), outside), { message: 'GitHub calls are restricted to the configured repository' })
  }
  assert.equal(run.length, 2, '被拒的路径不许先跑 gh 再报错')
  // 空路径指向仓库根。
  await value.api(z.unknown(), '')
  assert.deepEqual(run[2], ['/path/agent-gh', ['api', 'repos/acme/widgets']])
  // 不给 schema 时返回 CLI 的原始输出（原始文件、`--include` 头等）。
  stub(value, 'run', 'raw file')
  assert.equal(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw'), 'raw file')
  passed += 1
})

test('pages：读列表的每一页，校验不过的条目跳过并计数', async () => {
  const value = commands()
  const run = stub(value, 'run', '[[{"id":1}],[{"id":2}]]')
  assert.deepEqual(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments?per_page=100'), [{ id: 1 }, { id: 2 }])
  assert.deepEqual(run[0], ['/path/agent-gh', ['api', 'repos/acme/widgets/issues/12/comments?per_page=100', '--paginate', '--slurp']])
  stub(value, 'run', '[[{"id":1}],[{"id":"two"}]]')
  const tally = { skipped: 0 }
  assert.deepEqual(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally), [{ id: 1 }])
  assert.deepEqual(tally, { skipped: 1 })
  stub(value, 'run', '{"message":"not a list"}')
  await assert.rejects(value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments'))
  passed += 1
})

// ── 4. 失败上报 ────────────────────────────────────────────────────────────

test('lark：机器人不在群时附上「怎么把机器人加进群」，并保留业务码与退出码', async () => {
  const value = commands()
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = stub(value, 'run', commandError({ stderr: membership, code: 1 }))
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  await assert.rejects(value.lark(['im', '+chat-members-list']), (error) => {
    assert.equal(error.message, hint)
    assert.equal(error.code, 232011)
    assert.equal(error.exitCode, 1)
    return true
  })
  stub(value, 'run', JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await assert.rejects(value.lark(['im', '+chat-members-list']), (error) => {
    assert.equal(error.message, hint)
    assert.equal(error.code, 232011)
    assert.equal(error.exitCode, undefined, '业务码失败没有退出码')
    return true
  })
  assert.equal(run.length, 1)
  passed += 1
})

test('run：命令没打印诊断时只报程序名与结局，绝不回显参数', async () => {
  const value = commands()
  const secret = 'secret reply text'
  await assert.rejects(value.run(process.execPath, ['-e', 'process.exit(3)', secret]), (error) => {
    assert.equal(error.message, `${basename(process.execPath)} exited with code 3`)
    assert.equal(error.exitCode, 3)
    assert.equal(String(error).includes(secret), false)
    return true
  })
  await assert.rejects(value.run('/no/such/program', ['secret reply text']), { message: 'program could not run: ENOENT' })
  // 本机没有 POSIX 的 `kill -9 $$`，用上游同形的错误对象验结局文案（上游超时用的也是合成对象）。
  assert.equal(commandError({ signal: 'SIGKILL' }, 'sh').message, 'sh was stopped by SIGKILL')
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  const timeout = commandError(timedOut, '/path/lark-bot')
  assert.equal(timeout.message, 'lark-bot timed out after 90 s')
  assert.equal(String(timeout).includes('withdrawn'), false)
  passed += 1
})

test('commandError：失败一律是 CliError，带 CLI 报的码与退出状态；取消仍是 AbortError', async () => {
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  assert.equal(notFound instanceof CliError, true)
  assert.equal(notFound.message, 'gh: Not Found (HTTP 404)')
  assert.equal(notFound.code, 404)
  assert.equal(notFound.exitCode, 1)
  const recalled = commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }), code: 1 })
  assert.equal(recalled.message, 'The message is recalled (230011)')
  assert.equal(recalled.code, 230011)
  // 取消保持 AbortError，调用方才能把「用户停了」与「命令失败」分开。
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  assert.equal(commandError(aborted), aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal)
    .run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  controller.abort()
  await assert.rejects(running, { name: 'AbortError' })
  const value = commands()
  stub(value, 'run', JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await assert.rejects(value.lark(['im', '+messages-reply']), (error) => {
    assert.equal(error.message, 'message not found (231003)')
    assert.equal(error.code, 231003)
    return true
  })
  passed += 1
})

test('withSignal：工作信号取消只停绑定它的命令，lifetime 取消停全部，其他工作照跑', async () => {
  const lifetime = new AbortController()
  const work = new AbortController()
  const value = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = value.withSignal(work.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  work.abort()
  await assert.rejects(running)
  // 只有绑在已取消工作信号上的命令会停。
  assert.equal(await value.run(process.execPath, ['-e', 'console.log("still")']), 'still\n')
  const other = value.withSignal(new AbortController().signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  lifetime.abort()
  await assert.rejects(other)
  assert.equal(Date.now() - started < 4000, true, '取消要立刻生效，不能等命令自己结束')
  passed += 1
})
