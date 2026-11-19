/**
 * hooks 插件装配面的补盲（`packages/hooks/index.ts`）：脚本批准状态、事件投影细节、
 * 外部命令钩子的失败与并发分支、配置回落与设置保存边界。
 *
 * 与 `wiring.spec.ts` 不重复：那一份钉的是「挂在哪一档、规则/脚本的主路径」，
 * 这一份专挑没走到的分支——missing/changed/untrusted 三种批准状态、session-start
 * 与 turn-end 的载荷与信号过滤、PreToolUse 的白名单/block/ask、PostToolUse 留言
 * 如何进下一次请求、旧 `lifecycle-hooks` 配置的只读回落。
 *
 * 全部走「假 ctx + 真 apply」；`DSC_HOME` 在任何 import 之前指进临时目录。
 *
 * @module dsc/packages/hooks/tests/wiring-extra.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-extra-'))
process.env['DSC_HOME'] = HOME

/**
 * 假会话目录：钩子脚本以它当 `cwd` 被 spawn，所以必须真实存在。
 *
 * 这里原来写死 Windows 风格的 `C:/repo`：Linux 上 `/bin/sh` 一看到不存在的 cwd 就 ENOENT
 * （错误文案是 `钩子脚本没能启动（spawn /bin/sh ENOENT）`）；Windows 上它能不能过取决于
 * 机器上恰好有没有 `C:\repo`，同样是坏前提。
 */
const REPO = join(HOME, 'repo')
mkdirSync(REPO, { recursive: true })

const HOOKS_FILE = join(HOME, 'hooks.json')
const TRUST_FILE = join(HOME, 'hooks-trusted.json')
const LIFECYCLE_FILE = join(HOME, 'lifecycle-hooks.json')
const PLUGINS_FILE = join(HOME, 'plugins.json')

let hooksPlugin: typeof import('../index.js').hooksPlugin
let readHooks: typeof import('../../session-core/hooks.js').readHooks

beforeAll(async () => {
  readHooks = (await import('../../session-core/hooks.js')).readHooks
  hooksPlugin = (await import('../index.js')).hooksPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
})

let mtimeBump = 0
/** 写文件并把 mtime 往前推：`readHooks` 的缓存按 mtime+size 判新，同毫秒同长度会读到旧份。 */
function writeFresh(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
  mtimeBump += 1
  const stamp = new Date(Date.now() + mtimeBump * 1000)
  try {
    utimesSync(file, stamp, stamp)
  } catch {
    // 文件系统不允许改时间就算了，文件名各不相同也能避开缓存
  }
}

function writeHooks(doc: { rules?: unknown[]; scripts?: unknown[]; settings?: Record<string, unknown> }): void {
  writeFresh(
    HOOKS_FILE,
    JSON.stringify({ version: 1, settings: doc.settings ?? {}, rules: doc.rules ?? [], scripts: doc.scripts ?? [] }),
  )
}

function writeLifecycle(doc: unknown): void {
  writeFresh(LIFECYCLE_FILE, JSON.stringify(doc))
}

function writePlugins(entries: unknown[]): void {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFresh(PLUGINS_FILE, JSON.stringify({ version: 1, entries }))
}

beforeEach(() => {
  mtimeBump = 0
  writeHooks({})
  writeLifecycle({ hooks: {} })
  writePlugins([])
  rmSync(TRUST_FILE, { force: true })
  rmSync(join(HOME, 'audit.jsonl'), { force: true })
})

function scriptFile(name: string, body: string): string {
  const file = join(HOME, name)
  writeFileSync(file, body, 'utf8')
  return file
}

function input(overrides: Record<string, unknown> = {}): never {
  return {
    toolName: 'bash',
    risk: 'exec',
    cwd: REPO,
    args: { command: 'rm -rf build' },
    command: 'rm -rf build',
    target: '',
    signal: new AbortController().signal,
    sessionId: 'sess-1',
    sessionPath: join(REPO, '.dsc', 'sessions', 'a.jsonl'),
    ...overrides,
  } as never
}

interface FakeSection {
  values(): Record<string, unknown>
  fields(): Array<Record<string, unknown>>
  save(key: string, value: unknown): string | void
  action(name: string): string | void
}

/** 假 ctx：挂载点、事件处理器、通知和会话都收下来；审批永远放行。 */
function fakeCtx(options: { passed?: unknown } = {}) {
  const guards: Array<{ id: string; order: number; decide: (value: unknown) => Promise<unknown> }> = []
  const observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }> = []
  const commands: Array<{ spec: { name: string }; run: (args: unknown) => unknown }> = []
  const projections: Array<{ id: string; fn: (messages: unknown[]) => unknown }> = []
  const sections: FakeSection[] = []
  const services = new Map<string, unknown>()
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const notices: string[] = []
  const notes: Array<{ kind: string; text: string }> = []
  const session = {
    meta: { id: 'sess-1', cwd: REPO },
    filePath: join(REPO, '.dsc', 'sessions', 'a.jsonl'),
    messages: [{ role: 'assistant', content: '刚说完的话' }],
    appendNote: (kind: string, text: string): void => {
      notes.push({ kind, text })
    },
  }
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    guards: {
      register(guard: { id: string; order: number }) {
        guards.push(guard as never)
        return () => undefined
      },
      registerObserver(observer: { id: string; order: number }) {
        observers.push(observer as never)
        return () => undefined
      },
    },
    approval: {
      policy: 'auto-edit',
      decide: async () => 'allow-once',
    },
    session: { current: () => session },
    llm: { model: 'dsc-model' },
    commands: {
      register(spec: { name: string }, run: (args: unknown) => unknown) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    prompt: {
      registerProjection(id: string, fn: (messages: unknown[]) => unknown) {
        projections.push({ id, fn })
        return () => undefined
      },
    },
    settings: {
      registerSection(value: FakeSection) {
        sections.push(value)
        return () => undefined
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit(event: string, text?: string) {
      if (event === 'dsc/notice' && text !== undefined) notices.push(text)
    },
  }
  const defaultPassed = {
    enabled: true,
    configPath: LIFECYCLE_FILE,
    timeoutMs: 5_000,
    failClosed: false,
    commandAllowlist: '',
  }
  const cleanup = hooksPlugin.apply?.(
    ctx as never,
    'passed' in options ? options.passed : defaultPassed,
  )
  if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
  return { guards, observers, commands, projections, sections, services, handlers, notices, notes, session, section: sections[0]! }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('脚本批准状态', () => {
  test('命令里写了脚本、文件却不在：missing 状态停跑，同一状态只提示一次', async () => {
    const missing = join(HOME, 'gone-guard.mjs')
    writeHooks({
      settings: { autoAccept: true },
      scripts: [{ id: 's-missing', event: 'pre-tool', matcher: 'bash', command: `node ${missing}` }],
    })
    const harness = fakeCtx()

    expect(await harness.guards[0]!.decide(input())).toEqual({ action: 'defer' })
    expect(harness.notices.join('\n')).toContain('钩子脚本文件不存在')
    expect(harness.notices.filter((text) => text.includes('钩子脚本文件不存在'))).toHaveLength(1)

    // 同一状态再来一次：不再刷屏。
    expect(await harness.guards[0]!.decide(input())).toEqual({ action: 'defer' })
    expect(harness.notices.filter((text) => text.includes('钩子脚本文件不存在'))).toHaveLength(1)

    const service = harness.services.get('hooks') as {
      trustOf(id: string): { state: string; runnable: boolean; scriptPath: string }
    }
    expect(service.trustOf('s-missing')).toMatchObject({
      state: 'missing',
      runnable: false,
      scriptPath: missing,
    })
    expect(service.trustOf('nope')).toBeNull()
  }, 20_000)

  test('没批准不执行；开了「新脚本不询问」后状态仍是 untrusted 但真的会跑', async () => {
    const marker = join(HOME, 'ran-untrusted.txt')
    const script = scriptFile(
      'untrusted.mjs',
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    )
    writeHooks({ scripts: [{ id: 's-untrusted', event: 'pre-tool', matcher: 'bash', command: `node ${script}` }] })
    const harness = fakeCtx()
    const service = harness.services.get('hooks') as {
      trustOf(id: string): { state: string; runnable: boolean; detail: string }
    }

    expect(service.trustOf('s-untrusted')).toMatchObject({ state: 'untrusted', runnable: false })
    expect(await harness.guards[0]!.decide(input())).toEqual({ action: 'defer' })
    expect(existsSync(marker)).toBe(false)
    expect(harness.notices.join('\n')).toContain('没批准过')

    // 打开免批准：状态照实报，但 runnable 变成 true，脚本真的执行。
    writeHooks({
      settings: { autoAccept: true },
      scripts: [{ id: 's-untrusted', event: 'pre-tool', matcher: 'bash', command: `node ${script}` }],
    })
    expect(service.trustOf('s-untrusted')).toMatchObject({ state: 'untrusted', runnable: true })
    expect(service.trustOf('s-untrusted').detail).toContain('新脚本不询问')
    expect(await harness.guards[0]!.decide(input())).toEqual({ action: 'defer' })
    expect(existsSync(marker)).toBe(true)
  }, 20_000)

  test('批准后执行；脚本改动后进入 changed 停跑；重新批准恢复 trusted', async () => {
    const script = scriptFile(
      'trusted.mjs',
      'process.stdout.write(JSON.stringify({ action: "note", message: "批准后放行" }))\n',
    )
    writeHooks({ scripts: [{ id: 's-trust', event: 'pre-tool', matcher: 'bash', command: `node ${script}` }] })
    const harness = fakeCtx()
    const service = harness.services.get('hooks') as {
      trustOf(id: string): { state: string; runnable: boolean; detail: string }
    }

    harness.section.save('scriptId', 's-trust')
    expect(harness.section.action('scriptTrust')).toBeTypeOf('string')
    expect(service.trustOf('s-trust')).toMatchObject({ state: 'trusted', runnable: true })
    expect(existsSync(TRUST_FILE)).toBe(true)

    // 批准后脚本被改：状态变 changed，守卫跳过并只说一次。
    const future = new Date(Date.now() + 60_000)
    utimesSync(script, future, future)
    expect(service.trustOf('s-trust')).toMatchObject({ state: 'changed', runnable: false })
    expect(service.trustOf('s-trust').detail).toContain('改动过')
    expect(await harness.guards[0]!.decide(input())).toEqual({ action: 'defer' })
    expect(harness.notices.join('\n')).toContain('改动过')
    const changedNotices = harness.notices.filter((text) => text.includes('改动过')).length
    await harness.guards[0]!.decide(input())
    expect(harness.notices.filter((text) => text.includes('改动过'))).toHaveLength(changedNotices)

    // 重新批准当前内容：恢复执行，脚本的 note 结论变成给模型留的话。
    expect(harness.section.action('scriptTrust')).toBeTypeOf('string')
    expect(service.trustOf('s-trust')).toMatchObject({ state: 'trusted', runnable: true })
    expect(await harness.guards[0]!.decide(input())).toEqual({ action: 'defer' })
    expect(harness.notices.join('\n')).toContain('安全钩子留了一句：批准后放行')
  }, 20_000)
})

describe('事件投影细节', () => {
  test('session-start 拿到会话来源与载荷字段；turn-end 只认当前会话的回合', async () => {
    const log = join(HOME, 'payloads.jsonl')
    const script = scriptFile(
      'dump.mjs',
      [
        "import { appendFileSync } from 'node:fs'",
        "let body = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => { body += chunk })",
        "process.stdin.on('end', () => { appendFileSync(process.argv[2], body + '\\n') })",
      ].join('\n'),
    )
    writeHooks({
      settings: { autoAccept: true },
      scripts: [
        { id: 's-dump-start', event: 'session-start', matcher: '', command: `node ${script} ${log}` },
        { id: 's-dump-end', event: 'turn-end', matcher: '', command: `node ${script} ${log}` },
      ],
    })
    const harness = fakeCtx()

    const lines = (): Array<Record<string, unknown>> =>
      existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
        : []

    // 新开会话（没有 filePath）→ source=startup。
    for (const handler of harness.handlers.get('dsc/session-open') ?? []) {
      handler({ session: { meta: { id: 'sess-open', cwd: REPO } }, filePath: undefined })
    }
    await waitFor(() => lines().length >= 1)
    const started = lines()[0]!
    expect(started).toMatchObject({
      hook_event_name: 'session-start',
      session_id: 'sess-1',
      cwd: REPO,
      tool_name: '',
      mode: '',
      policy: 'auto-edit',
    })
    expect(started.extra).toMatchObject({ session_id: 'sess-open' })

    // 另一个会话的 turn-end 不触发（0.6.48 的口径）。
    for (const handler of harness.handlers.get('dsc/turn-end') ?? []) {
      handler('completed', { sessionId: 'other-session' })
    }
    await delay(400)
    expect(lines()).toHaveLength(1)

    // 当前会话的 turn-end 才跑，并把结束原因放进 extra。
    for (const handler of harness.handlers.get('dsc/turn-end') ?? []) {
      handler('completed', { sessionId: 'sess-1' })
    }
    await waitFor(() => lines().length >= 2)
    expect(lines()[1]).toMatchObject({ hook_event_name: 'turn-end', extra: { reason: 'completed' } })
  }, 30_000)
})

describe('外部命令钩子的判断分支', () => {
  test('PreToolUse：白名单按入口词挡；failClosed 决定挡下还是只提示', async () => {
    writeLifecycle({
      hooks: {
        PreToolUse: [
          { matcher: 'bash', hooks: [{ type: 'command', command: 'python guard.py' }] },
          { matcher: 'read', hooks: [{ type: 'command', command: `node ${scriptFile('external-deny.mjs', 'process.stdout.write(JSON.stringify({action:"deny",message:"外部不许"}))')}` }] },
          { matcher: 'grep', hooks: [{ type: 'command', command: `node ${scriptFile('external-ask.mjs', 'process.stdout.write(JSON.stringify({action:"ask",message:"要人确认"}))')}` }] },
        ],
      },
    })
    const strict = fakeCtx({ passed: { enabled: true, configPath: LIFECYCLE_FILE, timeoutMs: 5_000, failClosed: true, commandAllowlist: 'node' } })
    const externalGuard = strict.guards.find((guard) => guard.id === 'lifecycle-hooks')!

    const blocked = (await externalGuard.decide(input())) as { action: string; reason: string }
    expect(blocked.action).toBe('deny')
    expect(blocked.reason).toContain('不在命令白名单里')
    expect(strict.notices.filter((text) => text.includes('没生效'))).toHaveLength(1)
    await externalGuard.decide(input())
    expect(strict.notices.filter((text) => text.includes('没生效'))).toHaveLength(1)

    expect(await externalGuard.decide(input({ toolName: 'read' }))).toMatchObject({ action: 'deny' })
    const denied = (await externalGuard.decide(input({ toolName: 'read' }))) as { reason: string }
    expect(denied.reason).toContain('外部不许')

    const asked = (await externalGuard.decide(input({ toolName: 'grep' }))) as { action: string; reason: string }
    expect(asked.action).toBe('deny')
    expect(asked.reason).toContain('没有审批卡可弹')
    expect(asked.reason).toContain('要人确认')

    // failClosed=false：白名单挡下的钩子只留提示，不拦这次调用。
    const lenient = fakeCtx({ passed: { enabled: true, configPath: LIFECYCLE_FILE, timeoutMs: 5_000, failClosed: false, commandAllowlist: 'node' } })
    const lenientGuard = lenient.guards.find((guard) => guard.id === 'lifecycle-hooks')!
    expect(await lenientGuard.decide(input())).toEqual({ action: 'defer' })
    expect(lenient.notices.join('\n')).toContain('不在命令白名单里')
  }, 30_000)

  test('PostToolUse：钩子留言攒到下一次请求，围栏标来源、落 note、只补一次', async () => {
    const script = scriptFile(
      'external-note.mjs',
      'process.stdout.write(JSON.stringify({ action: "note", message: "外部说了一句" }))\n',
    )
    writeLifecycle({
      hooks: { PostToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `node ${script}` }] }] },
    })
    const harness = fakeCtx()
    const observer = harness.observers.find((item) => item.id === 'lifecycle-hooks')!
    expect(observer.observe('bash', '工具结果')).toBe('工具结果')

    const projection = harness.projections.find((item) => item.id === 'user-prompt-submit')!
    const messages = [{ role: 'user', content: '继续' }]
    // 留言是后台跑完才入队的：投影本身是幂等读取，没攒到时原样返回，攒到就补一次。
    let next = projection.fn(messages) as Array<{ role: string; content: string }>
    const deadline = Date.now() + 10_000
    while (next.length === messages.length && Date.now() < deadline) {
      await delay(50)
      next = projection.fn(messages) as Array<{ role: string; content: string }>
    }
    expect(next).toHaveLength(2)
    expect(next[1]!.content).toContain('<external_content source="hook:PostToolUse">')
    expect(next[1]!.content).toContain('外部说了一句')
    expect(harness.notes.some((note) => note.kind === 'lifecycle-hooks')).toBe(true)

    // 交过一次就清空：同一批消息不再重复补。
    expect(projection.fn(messages)).toEqual(messages)
  }, 30_000)

  test('旧 lifecycle-hooks 配置只读回落；hooks 条目逐键覆盖；设置保存夹取与校验', () => {
    writePlugins([
      {
        file: 'lifecycle-hooks',
        disabled: true,
        config: {
          enabled: true,
          configPath: '~/legacy.json',
          timeoutMs: 999_999,
          failClosed: 'true',
          commandAllowlist: 'node',
        },
      },
    ])
    // passed 缺省（undefined）：全部走磁盘回落，才看得到旧条目的作用。
    const legacy = fakeCtx({ passed: undefined })
    expect(legacy.section.values()).toMatchObject({
      externalEnabled: false,
      externalConfigPath: join(homedir(), 'legacy.json'),
      externalTimeoutMs: 120_000,
      externalFailClosed: true,
      externalCommandAllowlist: 'node',
    })

    // hooks 条目只写一部分：没写的键继续回落旧条目；enabled 显式 true 压过旧条目的停用标记。
    writePlugins([
      {
        file: 'lifecycle-hooks',
        disabled: true,
        config: {
          enabled: true,
          configPath: '~/legacy.json',
          timeoutMs: 999_999,
          failClosed: 'true',
          commandAllowlist: 'node',
        },
      },
      { file: 'hooks', config: { enabled: true, timeoutMs: 2_500 } },
    ])
    const merged = fakeCtx({ passed: undefined })
    expect(merged.section.values()).toMatchObject({
      externalEnabled: true,
      externalConfigPath: join(homedir(), 'legacy.json'),
      externalTimeoutMs: 2_500,
      externalFailClosed: true,
      externalCommandAllowlist: 'node',
    })

    // 设置面保存：写 hooks 条目，非法值给出原因、合法值夹取后落盘。
    const harness = fakeCtx()
    expect(harness.section.save('externalTimeoutMs', 'abc')).toContain('数字')
    expect(harness.section.save('externalConfigPath', '   ')).toContain('不能空着')
    expect(harness.section.save('externalEnabled', false)).toBeUndefined()
    expect(harness.section.save('externalFailClosed', true)).toBeUndefined()
    expect(harness.section.save('externalTimeoutMs', 20)).toBeUndefined()
    expect(harness.section.save('externalConfigPath', ` ${join(HOME, 'mine.json')} `)).toBeUndefined()
    expect(harness.section.save('externalCommandAllowlist', ' node,uv ')).toBeUndefined()

    expect(harness.section.values()).toMatchObject({
      externalEnabled: false,
      externalFailClosed: true,
      externalTimeoutMs: 500,
      externalConfigPath: join(HOME, 'mine.json'),
      externalCommandAllowlist: 'node,uv',
    })
    const saved = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) as {
      entries: Array<{ file: string; config: Record<string, unknown> }>
    }
    expect(saved.entries.find((entry) => entry.file === 'hooks')?.config).toMatchObject({
      enabled: false,
      failClosed: true,
      timeoutMs: 500,
      configPath: join(HOME, 'mine.json'),
      commandAllowlist: 'node,uv',
    })
  }, 20_000)
})

describe('设置与命令的边界', () => {
  test('空表的启停报错、非法选项回落、坏配置进 problems，/lifecycle-hooks 报未接通事件', () => {
    writeFresh(HOOKS_FILE, '{ 这不是 JSON')
    writeLifecycle({
      hooks: {
        PreModelRequest: [{ hooks: [{ type: 'command', command: 'echo never' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
      },
    })
    const harness = fakeCtx()
    const section = harness.section

    expect(String(section.save('ruleEnabled', true))).toContain('规则表是空的')
    expect(String(section.save('scriptEnabled', true))).toContain('脚本表是空的')
    expect(section.save('ruleField', 'weird')).toBeUndefined()
    expect(section.save('scriptEvent', 'weird')).toBeUndefined()
    expect(section.values()).toMatchObject({ ruleField: 'any', scriptEvent: 'pre-tool' })

    const fields = section.fields()
    const problem = fields.find((field) => field['type'] === 'info' && String(field['text'] ?? '').includes('不是合法 JSON'))
    expect(problem).toBeDefined()
    expect(fields.some((field) => field['group'] === 'external')).toBe(true)
    expect(fields.some((field) => String(field['text'] ?? '').includes('PreModelRequest 未接通'))).toBe(true)

    const hooksCommand = harness.commands.find((item) => item.spec.name === 'hooks')!
    const said: string[] = []
    hooksCommand.run({ ui: { notice: (text: string) => said.push(text) } })
    expect(said.join('\n')).toContain('⚠')

    const lifecycleCommand = harness.commands.find((item) => item.spec.name === 'lifecycle-hooks')!
    const report: string[] = []
    lifecycleCommand.run({ ui: { notice: (text: string) => report.push(text) } })
    const text = report.join('\n')
    expect(text).toContain('十四个事件')
    expect(text).toContain('已加载钩子 2 条')
    expect(text).toContain('PreToolUse')
  }, 20_000)

  test('动作边界：空表删/批准、坏正则、空命令都给出可读原因', () => {
    const harness = fakeCtx()
    expect(String(harness.section.action('ruleDelete'))).toContain('规则表是空的')
    expect(String(harness.section.action('scriptDelete'))).toContain('脚本表是空的')
    expect(String(harness.section.action('scriptTrust'))).toContain('脚本表是空的')
    expect(String(harness.section.action('scriptUntrust'))).toContain('脚本表是空的')

    harness.section.save('rulePattern', '[')
    expect(String(harness.section.action('ruleAdd'))).toContain('正则')
    harness.section.save('rulePattern', '')

    harness.section.save('scriptCommand', '')
    expect(String(harness.section.action('scriptAdd'))).toContain('命令不能空着')

    const added = harness.section.action('ruleAdd')
    // 空模式在 addRule 里就被挡下，不会写进配置。
    expect(String(added)).toContain('模式不能空着')
    expect(readHooks().rules).toHaveLength(0)
  }, 20_000)
})
