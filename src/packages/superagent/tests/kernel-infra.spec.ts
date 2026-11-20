/**
 * 基础设施层（`infra/`、`paths.ts`、`setup.ts`、`kv.ts`）的包级测试。
 *
 * 这一层的判据都是「护栏准不准」：shim 会不会自己递归、gitconfig 会不会漏读操作员配置、
 * `runAsWorker` 会不会把令牌漏给子进程、`Commands` 失败时会不会把消息正文写进错误、
 * 工单 id 会不会把会话写到数据根外、`{占位符}` 有没有漏填。所以断言具体文件内容与具体文案，
 * 不只断言「没抛」。
 *
 * 跨平台取舍：只跑文件生成、所有权、PATH 去重、`runAsWorker`（用 `process.execPath`，不依赖
 * POSIX `sh`）与纯函数；**真正执行 shim 脚本**和需要 `git` 的 `verifyEnvironment` /
 * `verifyDirectory` 留给了同目录的 `environment.test.mjs` 探针，不在这里伪造。
 *
 * @module dsc/packages/superagent/tests/kernel-infra
 */
import { readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import type { Deployment } from '../deployment.js'
import { CliError, Commands, commandError, validItems } from '../infra/commands.js'
import {
  GIT_LOCATION,
  WORKER_COMMANDS,
  agentVariables,
  applyEnvironment,
  credentialHelper,
  runAsWorker,
  sameDirectory,
  withoutDirectory,
  workerBin,
  workerGitConfig,
  writeEnvironment,
} from '../infra/environment.js'
import { HealthBoard } from '../infra/health.js'
import { IM_WORDS, NOTE_WORDS, checkedImText, escapeRegExp, fill, sameName, wordCount } from '../infra/text.js'
import { KV, family, record } from '../kv.js'
import { orchestratorDbPath, orchestratorLockPath, promptsDir, sessionsDir, superagentRoot } from '../paths.js'
import { SETUP_PROBLEMS, SetupError } from '../setup.js'

const read = (file: string): string => readFileSync(file, 'utf8')
const MARKER = '# Written by dsh-superagent on every start; edits are lost.'

/** 一份最小部署：只带 `writeEnvironment` 读的字段。 */
function deploymentOf(stateDir: string, overrides: Record<string, unknown> = {}) {
  return {
    stateDir,
    repository: 'acme/widgets',
    github: { cli: '/opt/agent tools/gh', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/opt/lark-cli', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...overrides,
  }
}

// ── infra/text ──────────────────────────────────────────────────────────────

describe('infra/text：字数与文案工具', () => {
  test('wordCount：英文按词、标点不算、中文按词典切词、中英混排各算各的', () => {
    expect(IM_WORDS).toBe(100)
    expect(NOTE_WORDS).toBe(30)
    expect(wordCount('hello, world!')).toBe(2)
    expect(wordCount('!!!')).toBe(0)
    expect(wordCount('')).toBe(0)
    expect(wordCount("don't stop")).toBe(2)
    expect(wordCount('你好世界')).toBe(2)
    expect(wordCount('hello 世界, 你好 world')).toBe(4)
    expect(wordCount('a '.repeat(100).trim())).toBe(100)
  })

  test('checkedImText：到上限放行，超一个词按上游文案抛错', () => {
    const atLimit = 'a '.repeat(IM_WORDS).trim()
    expect(checkedImText(atLimit)).toBe(atLimit)
    expect(() => checkedImText('a '.repeat(IM_WORDS + 1).trim())).toThrow(
      `IM message has ${String(IM_WORDS + 1)} words; maximum is ${String(IM_WORDS)}. Rewrite as a short high-level update. Do not split it into multiple messages.`,
    )
  })

  test('fill：没给的占位符填空串；sameName 大小写不敏感；escapeRegExp 让正则符号按字面匹配', () => {
    expect(fill('@{account} cannot read {repository}.', { account: 'alice', repository: 'owner/repo' })).toBe('@alice cannot read owner/repo.')
    expect(fill('{a}-{b}', { a: 'x' })).toBe('x-')
    expect(fill('no placeholders', { a: 'x' })).toBe('no placeholders')
    expect(fill('{a}{a}', { a: 'x' })).toBe('xx')
    expect(sameName('Alice', 'alice')).toBe(true)
    expect(sameName('alice', 'alice2')).toBe(false)
    const source = 'a.b*c(d)[e]{f}$^|\\+?'
    expect(new RegExp(`^${escapeRegExp(source)}$`).test(source)).toBe(true)
    expect(escapeRegExp('plain')).toBe('plain')
  })
})

// ── infra/health ────────────────────────────────────────────────────────────

describe('infra/health：单写者登记表', () => {
  test('claim 带初始值、set 覆盖、all 可读；同名再领抛错', () => {
    const board = new HealthBoard()
    const entry = board.claim('runtime', { state: 'starting', detail: 'booting' })
    expect(entry.get()).toEqual({ state: 'starting', detail: 'booting' })
    entry.set({ state: 'ready', detail: 'ok' })
    expect(board.all).toEqual({ runtime: { state: 'ready', detail: 'ok' } })
    expect(() => board.claim('runtime', { state: 'error', detail: 'x' })).toThrow('The health entry runtime is reported by another part')
  })

  test('release 后读不到、写入变 no-op、名字可重新领；别的格子不受影响', () => {
    const board = new HealthBoard()
    const first = board.claim('settings', { state: 'ready', detail: 'old' })
    const other = board.claim('sources')
    other.set({ state: 'error', detail: 'poll failed' })
    first.release()
    first.release()
    expect(first.get()).toBeUndefined()
    expect(board.all).toEqual({ sources: { state: 'error', detail: 'poll failed' } })
    first.set({ state: 'error', detail: 'late write' })
    expect(board.all.settings).toBeUndefined()
    const second = board.claim('settings', { state: 'starting', detail: 'new' })
    expect(second.get()).toEqual({ state: 'starting', detail: 'new' })
  })
})

// ── infra/commands ──────────────────────────────────────────────────────────

describe('infra/commands：子进程封装与失败上报', () => {
  // 按 `Deployment` 的真实形状标注：`feishu.brand` 是 'feishu' | 'lark' 的枚举，字面量直接写会被推宽成 string。
  const deployment: Deployment = {
    stateDir: '/state',
    promptMaxChars: 100_000,
    admissionContextMaxPages: 10,
    admissionContextTimeoutMs: 15_000,
    repository: 'acme/widgets',
    github: { cli: '/path/agent-gh', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/path/lark-bot', appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' },
  }
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)

  test('commandError：飞书 JSON 诊断取 code+message；非 JSON stderr 取前 2000 字与 HTTP 码', () => {
    const membership = commandError({ stderr: `[page 1] fetching...\n${JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })}`, code: 1 })
    expect(membership).toBeInstanceOf(CliError)
    expect(membership.message).toBe('operator is not in the chat (232011)')
    expect((membership as CliError).code).toBe(232011)
    expect((membership as CliError).exitCode).toBe(1)
    const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
    expect(notFound.message).toBe('gh: Not Found (HTTP 404)')
    expect((notFound as CliError).code).toBe(404)
  })

  test('commandError：没有 stderr 时只报程序名与结局，绝不回显参数', () => {
    expect(commandError(undefined, '/no/such/program').message).toBe('program failed')
    expect(commandError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'gh').message).toBe('gh printed more output than it may')
    expect(commandError({ killed: true, signal: 'SIGTERM' }, 'lark-bot').message).toBe('lark-bot timed out after 90 s')
    expect(commandError({ signal: 'SIGKILL' }, 'sh').message).toBe('sh was stopped by SIGKILL')
    expect(commandError({ code: 3 }, 'git').message).toBe('git exited with code 3')
    expect(commandError({ code: 'ENOENT' }, 'git').message).toBe('git could not run: ENOENT')
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    expect(commandError(aborted)).toBe(aborted)
  })

  test('validItems：合格的留下，不合格的跳过并计数', () => {
    const tally = { skipped: 0 }
    expect(validItems(z.looseObject({ id: z.number() }), [{ id: 1 }, { id: 'two' }, { id: 3 }], tally)).toEqual([{ id: 1 }, { id: 3 }])
    expect(tally).toEqual({ skipped: 1 })
  })

  test('run：真跑一个 node 子进程，返回 stdout；env 覆盖里 undefined 表示删掉', async () => {
    process.env.GH_TOKEN = 'personal'
    try {
      const value = new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal)
      const script = 'console.log(`probe=${process.env.DSH_SUPERAGENT_PROBE};gh=${process.env.GH_TOKEN}`)'
      const output = await value.run(process.execPath, ['-e', script])
      expect(output).toContain('probe=agent')
      expect(output).toContain('gh=undefined')
    } finally {
      delete process.env.GH_TOKEN
    }
  })

  test('run：非零退出与起不来都变成 CliError，且不带参数正文', async () => {
    const secret = 'secret reply text'
    await expect(commands().run(process.execPath, ['-e', 'process.exit(3)', secret])).rejects.toMatchObject({ exitCode: 3 })
    await expect(commands().run('/no/such/program', [secret])).rejects.toThrow('could not run: ENOENT')
    const failed = await commands().run(process.execPath, ['-e', 'console.error("nope"); process.exit(3)']).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(CliError)
    expect((failed as CliError).message).toBe('nope')
    expect(String((failed as Error).message).includes(secret)).toBe(false)
  })

  test('run：信号取消立刻停，withSignal 叠在宿主信号上', async () => {
    const lifetime = new AbortController()
    const work = new AbortController()
    const value = new Commands(() => deployment, {}, lifetime.signal)
    const controller = new AbortController()
    const running = value.withSignal(controller.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    const other = value.withSignal(new AbortController().signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
    work.abort()
    lifetime.abort()
    await expect(other).rejects.toBeInstanceOf(Error)
  })

  test('lark：没配机器人直接拒；成功解析 data；业务失败带业务码', async () => {
    const noFeishu = { ...deployment, feishu: undefined }
    await expect(new Commands(() => noFeishu, {}, new AbortController().signal).lark(['im', '+chat-list']))
      .rejects.toThrow('The Feishu Source has no working bot CLI')
    const value = commands()
    value.run = async () => JSON.stringify({ ok: true, data: { items: [1] } })
    expect(await value.lark(['im', '+chat-list'], '/cwd')).toEqual({ items: [1] })
    value.run = async () => JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } })
    await expect(value.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
    value.run = async () => { throw commandError({ stderr: JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } }), code: 1 }) }
    await expect(value.lark(['im', '+chat-member-list'])).rejects.toMatchObject({ code: 232011, exitCode: 1 })
  })

  test('gh / api / pages：路径只能在配置仓库内，schema 校验 GitHub 的回答，坏条目跳过', async () => {
    const value = commands()
    const calls: string[][] = []
    value.run = async (program: string, args: string[]) => {
      calls.push([program, ...args])
      return '{"number":12,"title":"Login fails"}'
    }
    expect(await value.gh(['api', 'x'])).toEqual({ number: 12, title: 'Login fails' })
    expect(calls.at(-1)).toEqual(['/path/agent-gh', 'api', 'x'])

    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toMatchObject({ number: 12 })
    expect(calls.at(-1)).toEqual(['/path/agent-gh', 'api', 'repos/acme/widgets/issues/12'])
    for (const outside of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), outside)).rejects.toThrow('GitHub calls are restricted to the configured repository')
    }
    // 空路径与不带 schema 的两支。
    expect(await value.api(z.unknown(), '')).toBeTruthy()
    expect(calls.at(-1)).toEqual(['/path/agent-gh', 'api', 'repos/acme/widgets'])
    value.run = async () => 'raw file'
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')

    value.run = async () => '[[{"id":1}],[{"id":2},{"id":"two"}]]'
    const tally = { skipped: 0 }
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally)).toEqual([{ id: 1 }, { id: 2 }])
    expect(tally).toEqual({ skipped: 1 })
  })

  test('deployment / repository 读的是解析函数当下给出的那份', () => {
    let repository = 'first/repo'
    const value = new Commands(() => ({ ...deployment, repository }), {}, new AbortController().signal)
    expect(value.repository).toBe('first/repo')
    repository = 'second/repo'
    expect(value.repository).toBe('second/repo')
    expect(value.deployment.stateDir).toBe('/state')
  })
})

// ── infra/environment ───────────────────────────────────────────────────────

describe('infra/environment：worker 环境与 shim', () => {
  const cases: string[] = []
  const caseDir = (): string => {
    const dir = createTempDir('dsc-infra-')
    cases.push(dir)
    return dir
  }

  test('worker shim：首两行是 shebang 与归属标记，先剥掉 shim 目录再 exec 真 CLI', async () => {
    const stateDir = caseDir()
    await writeEnvironment(deploymentOf(stateDir) as never, [])
    const bin = workerBin(stateDir)
    const shim = read(join(bin, 'gh'))
    const lines = shim.split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1]).toBe(MARKER)
    expect(shim.includes(`self='${bin}'`)).toBe(true)
    expect(shim.includes(`exec '/opt/agent tools/gh' "$@"`)).toBe(true)
    expect(shim.includes('PATH=$rest')).toBe(true)
    expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])
  })

  test('没有飞书机器人时 lark-cli 直接失败；被封命令按智能体登录名提示；三个白名单命令不重复写', async () => {
    const stateDir = caseDir()
    await writeEnvironment(deploymentOf(stateDir, { feishu: undefined }) as never, ['personal-gh', ...WORKER_COMMANDS])
    const bin = workerBin(stateDir)
    expect(read(join(bin, 'lark-cli'))).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
    expect(read(join(bin, 'personal-gh'))).toContain('personal-gh is blocked in this installation; use gh, which acts as agent-bot.')
    expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
  })

  test('只替换自己写的文件：标记不在前两行、符号链接、外来 gitconfig 一律拒绝且不改写', async () => {
    const stateDir = caseDir()
    await writeEnvironment(deploymentOf(stateDir) as never, ['old-cli'])
    await writeEnvironment(deploymentOf(stateDir) as never, [])
    const bin = workerBin(stateDir)
    expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])

    writeFileSync(join(bin, 'notes'), `notes\nmore\n${MARKER}\n`)
    await expect(writeEnvironment(deploymentOf(stateDir) as never, [])).rejects.toMatchObject({ code: 'foreignFile' })
    unlinkSync(join(bin, 'notes'))
    // 符号链接也不算自己写的；没有建链接权限的环境跳过这一小段。
    let linked = true
    try {
      symlinkSync(join(bin, 'gh'), join(bin, 'link'))
    } catch {
      linked = false
    }
    if (linked) {
      await expect(writeEnvironment(deploymentOf(stateDir) as never, [])).rejects.toThrow('was not written by dsh-superagent')
      unlinkSync(join(bin, 'link'))
    }
    writeFileSync(workerGitConfig(stateDir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(deploymentOf(stateDir) as never, [])).rejects.toThrow('worker-gitconfig was not written by dsh-superagent')
    expect(read(workerGitConfig(stateDir))).toBe('[user]\n\tname = someone\n')
  })

  test('早期名字写过（dsh-tag / dsh-go / dsh-freelancer）的文件也归本插件所有并替换', async () => {
    const stateDir = caseDir()
    await writeEnvironment(deploymentOf(stateDir) as never, ['old-cli'])
    const bin = workerBin(stateDir)
    writeFileSync(join(bin, 'old-cli'), read(join(bin, 'old-cli')).replace('Written by dsh-superagent', 'Written by dsh-tag'))
    writeFileSync(workerGitConfig(stateDir), read(workerGitConfig(stateDir)).replace('Written by dsh-superagent', 'Written by dsh-freelancer'))
    await writeEnvironment(deploymentOf(stateDir) as never, [])
    expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])
    expect(read(workerGitConfig(stateDir))).toContain(MARKER)
  })

  test('agentVariables：清掉令牌与指路变量、隔离 git 全局配置，GIT_CEILING_DIRECTORIES 不碰', () => {
    const variables = agentVariables('/state')
    expect(variables.GH_TOKEN).toBeUndefined()
    expect(variables.GITHUB_TOKEN).toBeUndefined()
    for (const name of GIT_LOCATION) expect(variables[name]).toBeUndefined()
    expect(variables.GIT_CONFIG_GLOBAL).toBe(workerGitConfig('/state'))
    expect(variables.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(variables.GIT_ASKPASS).toBe('')
    expect(variables.GIT_TERMINAL_PROMPT).toBe('0')
    expect(Object.hasOwn(variables, 'GIT_CEILING_DIRECTORIES')).toBe(false)
  })

  test('credentialHelper 转义引号；withoutDirectory 去掉同一目录的各种写法；sameDirectory 认 realpath', () => {
    expect(credentialHelper("/opt/agent tools/gh")).toBe(`!'/opt/agent tools/gh' auth git-credential`)
    expect(credentialHelper("a'b")).toBe(`!'a'\\''b' auth git-credential`)
    const stateDir = caseDir()
    const bin = workerBin(stateDir)
    const entries = [`${bin}${sep}`, bin, join(stateDir, 'usr-bin')]
    expect(withoutDirectory(entries.join(delimiter), bin)).toBe(join(stateDir, 'usr-bin'))
    expect(sameDirectory(stateDir, stateDir)).toBe(true)
    expect(sameDirectory(stateDir, join(stateDir, 'missing'))).toBe(false)
  })

  test('applyEnvironment：覆盖变量与 PATH 前缀，restore 之后原样还原', () => {
    const stateDir = caseDir()
    const before = process.env.DSH_SUPERAGENT_PROBE
    const restore = applyEnvironment({ DSH_SUPERAGENT_PROBE: 'agent', GIT_TERMINAL_PROMPT: '0' }, stateDir, '/usr/bin')
    try {
      expect(process.env.DSH_SUPERAGENT_PROBE).toBe('agent')
      expect(process.env.PATH!.split(delimiter)[0]).toBe(workerBin(stateDir))
    } finally {
      restore()
    }
    expect(process.env.DSH_SUPERAGENT_PROBE).toBe(before)
  })

  test('runAsWorker：非零退出抛 CliError 带 stderr 与退出码，名字像凭证的变量不进子进程', async () => {
    const stateDir = caseDir()
    const signal = new AbortController().signal
    const error = await runAsWorker([process.execPath, '-e', 'console.error("nope"); process.exit(3)'], stateDir, signal)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe('nope')
    expect((error as CliError).exitCode).toBe(3)

    const script = 'console.log(JSON.stringify({ token: process.env.SOME_TOKEN ?? null, plain: process.env.PLAIN ?? null }))'
    expect(JSON.parse(await runAsWorker([process.execPath, '-e', script], stateDir, signal, { SOME_TOKEN: 'leak', PLAIN: 'kept' })))
      .toEqual({ token: null, plain: 'kept' })
  })

  test('runAsWorker：空命令拒绝；被信号停掉时文案说清；退出码为 null 也有话说', async () => {
    await expect(runAsWorker([], process.cwd(), new AbortController().signal)).rejects.toThrow('runAsWorker needs a command to run')
    const controller = new AbortController()
    const running = runAsWorker([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], process.cwd(), controller.signal)
    controller.abort()
    await expect(running).rejects.toBeInstanceOf(CliError)
    await expect(runAsWorker([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], process.cwd(),
      AbortSignal.timeout(50))).rejects.toThrow('was stopped before it finished')
  })

  afterEach(() => {
    cases.length = 0
  })
})

// ── paths / setup / kv ──────────────────────────────────────────────────────

describe('paths：落盘坐标与工单 id 校验', () => {
  const saved = process.env.DSC_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = saved
  })

  test('DSC_HOME 变，四个坐标跟着变；工单 id 不合法直接拒绝', () => {
    process.env.DSC_HOME = join('/', 'tmp', 'dsc-home-probe')
    expect(superagentRoot()).toBe(join('/', 'tmp', 'dsc-home-probe', 'superagent'))
    expect(orchestratorDbPath()).toBe(join('/', 'tmp', 'dsc-home-probe', 'superagent', 'orchestrator.sqlite'))
    expect(orchestratorLockPath()).toBe(join('/', 'tmp', 'dsc-home-probe', 'superagent', 'orchestrator.lock'))
    expect(promptsDir()).toBe(join('/', 'tmp', 'dsc-home-probe', 'superagent', 'prompts'))
    expect(sessionsDir('abc123')).toBe(join('/', 'tmp', 'dsc-home-probe', 'superagent', 'sessions', 'abc123'))
    for (const bad of ['../evil', '.hidden', '', 'a/b']) expect(() => sessionsDir(bad)).toThrow('工单 id 不能当目录名')
  })
})

describe('setup：结构化错误与文案填充', () => {
  test('SetupError 带 place / code / values 与填好的 detail；output 追加在下一行', () => {
    const error = new SetupError('foreignFile', { file: '/state/worker-bin/gh' })
    expect(error).toBeInstanceOf(Error)
    expect(error.place).toBe('deployment')
    expect(error.code).toBe('foreignFile')
    expect(error.message).toBe('/state/worker-bin/gh was not written by dsh-superagent; move it, or choose another state directory.')
    expect(error.problem).toMatchObject({ place: 'deployment', code: 'foreignFile', values: { file: '/state/worker-bin/gh' } })

    const withOutput = new SetupError('gitTooOld', { output: 'git says no' })
    expect(withOutput.message).toContain('dsh-superagent needs git 2.32 or later.')
    expect(withOutput.message.split('\n')).toEqual([
      SETUP_PROBLEMS.gitTooOld[1],
      'git says no',
    ])
    // 每个 code 的 {占位符} 都填得上（不留下的花括号）。
    for (const [code, [place, text]] of Object.entries(SETUP_PROBLEMS)) {
      const filled = new SetupError(code as never, { file: 'f', account: 'a', repository: 'r', app: 'x', status: 's', mode: 'm' }).message
      expect(filled.includes('{'), `${code} 的占位符没填干净`).toBe(false)
      expect(place === 'deployment' || place === 'github' || place === 'feishu').toBe(true)
      expect(text.length).toBeGreaterThan(0)
    }
  })
})

describe('kv：带类型的键与键族', () => {
  test('record 原样返回；family 拼前缀与名字，prefix 可列举', () => {
    expect(record<number>('schema')).toBe('schema')
    const blocks = family<number, [block: string]>('settings-block-revision:', (block) => block)
    expect(blocks.prefix).toBe('settings-block-revision:')
    expect(blocks('executor')).toBe('settings-block-revision:executor')
    // `family` 的名字元组由泛型参数决定；两个名字就写 [string, string]。
    expect(family<unknown, [string, string]>('x:')('a', 'b')).toBe('x:a:b')
    expect(KV.github.cursor(12)).toBe('github-cursor:12')
    expect(KV.settings.block('executor')).toBe('settings-block-revision:executor')
    expect(KV.prompts.builtIn('a.md')).toBe('prompt-built-in:a.md')
  })
})
