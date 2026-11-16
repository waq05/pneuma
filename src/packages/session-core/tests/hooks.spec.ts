/**
 * 钩子配置与执行的整条链路（`packages/session-core/hooks.ts`）：读写收口、规则匹配、
 * 批准名单、脚本执行、结论解析与裁决。
 *
 * 归 unit 层但会落真文件、起真子进程：
 *   - `HOOKS_FILE` / `HOOK_TRUST_FILE` 在 import 期由 `dscPath()` 算定，所以**先换临时 HOME 再动态 import**；
 *   - 脚本执行用 `node <脚本>` 这种「解释器 + 脚本文件」的真命令；带空格的引号路径
 *     只在 scriptTokenOf 里验（Windows 上 `cmd.exe /c` 再套一层引号会把路径拆坏，那是 shell 的锅）；
 *   - 超时用 300ms、脚本睡 5s，收尾走 `taskkill` 的既有路径，不靠运气等进程自己退。
 *
 * @module dsc/packages/session-core/tests/hooks.spec
 */
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'

const home = tempHome('dsc-hooks-engine-')

type HooksModule = typeof import('../hooks.js')
type HookRule = import('../hooks.js').HookRule
type HookScript = import('../hooks.js').HookScript
type HookRun = import('../hooks.js').HookRun
type HookPayload = import('../hooks.js').HookPayload

let hooks: HooksModule

beforeAll(async () => {
  hooks = await import('../hooks.js')
})

afterAll(() => {
  home.restore()
})

/** 脚本目录（不带空格：`cmd.exe /c` 再套一层引号会把路径拆坏，见文件头）。 */
const scriptDir = join(home.home, 'guards')
mkdirSync(scriptDir, { recursive: true })
mkdirSync(join(home.home, '.dsc'), { recursive: true })

/** 写一个脚本并返回「node 路径」形式的命令（不加引号：`cmd.exe /c` 会把带引号的整串拆坏）。 */
function scriptFile(name: string, body: string): { path: string; command: string } {
  const path = join(scriptDir, name)
  writeFileSync(path, body, 'utf8')
  return { path, command: `node ${path}` }
}

/** 一份最小的守卫入参（真类型由 hookFacts 的参数给出，这里只负责拼形状）。 */
function facts(overrides: Record<string, unknown> = {}): never {
  return { toolName: 'bash', command: 'rm -rf /', target: '', args: {}, ...overrides } as never
}

/** 造一次脚本执行结果。 */
function run(overrides: Partial<HookRun> = {}): HookRun {
  return { exitCode: 0, stdout: '', stderr: '', ms: 40, timedOut: false, spawnError: '', truncated: false, ...overrides }
}

const settings: import('../hooks.js').HookSettings = {
  enabled: true,
  scriptTimeoutMs: 10_000,
  scriptFailClosed: true,
  autoAccept: false,
}

/** 一条 pre-tool 脚本钩子（命令默认指向真文件）。 */
function script(overrides: Partial<HookScript> = {}): HookScript {
  return {
    id: 's1',
    enabled: true,
    event: 'pre-tool',
    matcher: 'bash',
    command: `node ${join(scriptDir, 'guard.mjs')}`,
    timeoutMs: 0,
    failClosed: true,
    ...overrides,
  }
}

describe('readHooks：坏配置也要能读出一份能用的', () => {
  test('没有文件给默认值；不是 JSON 时给原因，不让工具调用崩', () => {
    const first = hooks.readHooks()
    expect(first.rules).toEqual([])
    expect(first.scripts).toEqual([])
    expect(first.settings).toEqual(settings)

    writeFileSync(hooks.HOOKS_FILE, '{ 坏掉的', 'utf8')
    const broken = hooks.readHooks()
    expect(broken.rules).toEqual([])
    expect(broken.settings).toEqual(settings)
    expect(broken.problems.join('\n')).toMatch(/不是合法 JSON/)
  })

  test('坏条目逐条跳过并记原因；设置项按缺省与区间收口', () => {
    writeFileSync(
      hooks.HOOKS_FILE,
      JSON.stringify({
        settings: { enabled: false, autoAccept: true, scriptFailClosed: false, scriptTimeoutMs: 1 },
        rules: [
          'not-an-object',
          { pattern: '', action: 'deny' },
          { pattern: 'x', action: 'maybe' },
          { pattern: 'ok', action: 'DENY', field: 'weird', tool: '' },
        ],
        scripts: ['nope', { command: '', event: 'pre-tool' }, { command: 'echo x', event: 'whenever' }],
      }),
      'utf8',
    )
    const doc = hooks.readHooks()
    expect(doc.settings).toEqual({ enabled: false, autoAccept: true, scriptFailClosed: false, scriptTimeoutMs: 500 })
    expect(doc.rules).toHaveLength(1)
    expect(doc.rules[0]).toMatchObject({ pattern: 'ok', action: 'deny', field: 'any', tool: '*' })
    expect(doc.scripts).toEqual([])
    expect(doc.problems.some((item) => item.includes('规则'))).toBe(true)
    expect(doc.problems.some((item) => item.includes('脚本'))).toBe(true)
  })

  test('条数超上限：截断并记原因；非数组的 rules/scripts 当没配', () => {
    const manyRules = Array.from({ length: hooks.HOOK_MAX_RULES + 5 }, (_, index) => ({
      pattern: `r${String(index)}`,
      action: 'deny',
    }))
    const manyScripts = Array.from({ length: 55 }, (_, index) => ({ event: 'pre-tool', command: `echo ${String(index)}` }))
    writeFileSync(hooks.HOOKS_FILE, JSON.stringify({ rules: manyRules, scripts: manyScripts }), 'utf8')
    const doc = hooks.readHooks()
    expect(doc.rules).toHaveLength(hooks.HOOK_MAX_RULES)
    expect(doc.scripts).toHaveLength(50)
    expect(doc.problems.join('\n')).toMatch(/规则条数超过 200/)
    expect(doc.problems.join('\n')).toMatch(/脚本条数超过 50/)

    writeFileSync(hooks.HOOKS_FILE, JSON.stringify({ rules: 'x', scripts: { a: 1 } }), 'utf8')
    expect(hooks.readHooks()).toMatchObject({ rules: [], scripts: [] })
  })

  test('缓存按 mtime+大小复用；写一次配置后立刻读到新内容', () => {
    hooks.addRule({ tool: 'bash', field: 'command', pattern: 'cache-1', action: 'deny', reason: '' })
    const a = hooks.readHooks()
    const b = hooks.readHooks()
    expect(b).toBe(a)
    hooks.addRule({ tool: 'bash', field: 'command', pattern: 'cache-2', action: 'deny', reason: '' })
    const c = hooks.readHooks()
    expect(c).not.toBe(a)
    expect(c.rules.map((rule) => rule.pattern)).toEqual(['cache-1', 'cache-2'])
  })
})

describe('addRule / removeRule / setRuleEnabled', () => {
  test('空模式、超长、坏正则、未知动作逐条拒绝', () => {
    expect(hooks.addRule({ tool: 'bash', field: 'command', pattern: '   ', action: 'deny', reason: '' })).toEqual({
      ok: false,
      error: expect.stringContaining('模式不能空着'),
    })
    expect(
      hooks.addRule({ tool: 'bash', field: 'command', pattern: 'x'.repeat(hooks.HOOK_PATTERN_MAX + 1), action: 'deny', reason: '' }),
    ).toEqual({ ok: false, error: expect.stringContaining('最长 300') })
    expect(hooks.addRule({ tool: 'bash', field: 'command', pattern: '(', action: 'deny', reason: '' })).toEqual({
      ok: false,
      error: expect.stringContaining('正则用不了'),
    })
    expect(
      hooks.addRule({ tool: 'bash', field: 'command', pattern: 'ok', action: 'allow' as never, reason: '' }),
    ).toEqual({ ok: false, error: expect.stringContaining('动作只认') })
  })

  test('成功时给 id，空工具名回落 *，理由截到上限；启停与删除都落到文件', () => {
    const added = hooks.addRule({
      tool: '  ',
      field: 'command',
      pattern: 'rm -rf',
      action: 'ask',
      reason: 'r'.repeat(hooks.HOOK_REASON_MAX + 50),
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const rule = hooks.readHooks().rules.find((item) => item.id === added.id) as HookRule
    expect(rule).toMatchObject({ tool: '*', pattern: 'rm -rf', action: 'ask' })
    expect(rule.reason).toHaveLength(hooks.HOOK_REASON_MAX)

    hooks.setRuleEnabled(added.id, false)
    expect(hooks.readHooks().rules.find((item) => item.id === added.id)?.enabled).toBe(false)
    hooks.setRuleEnabled('no-such-id', false)
    hooks.removeRule('no-such-id')
    expect(hooks.readHooks().rules.some((item) => item.id === added.id)).toBe(true)
    hooks.removeRule(added.id)
    expect(hooks.readHooks().rules.some((item) => item.id === added.id)).toBe(false)
    // 直接看盘：写出去的是「version + settings + rules + scripts」这份全量文档。
    const onDisk = JSON.parse(readFileSync(hooks.HOOKS_FILE, 'utf8')) as Record<string, unknown>
    expect(onDisk.version).toBe(1)
    expect(Array.isArray(onDisk.rules)).toBe(true)
  })

  test('条数到顶后再加：给一句能照做的提示', () => {
    hooks.addRule({ tool: '*', field: 'any', pattern: 'seed', action: 'deny', reason: '' })
    for (let index = hooks.readHooks().rules.length; index < hooks.HOOK_MAX_RULES; index += 1) {
      const added = hooks.addRule({ tool: '*', field: 'any', pattern: `seed-${String(index)}`, action: 'deny', reason: '' })
      expect(added.ok).toBe(true)
    }
    expect(hooks.addRule({ tool: '*', field: 'any', pattern: 'over', action: 'deny', reason: '' })).toEqual({
      ok: false,
      error: expect.stringContaining('规则最多 200 条'),
    })
  })
})

describe('addScript / removeScript / setScriptEnabled / patchHookSettings', () => {
  test('命令空、超长、事件不认各自拒绝；成功时 matcher 回落 *、超时按区间夹', () => {
    expect(hooks.addScript({ event: 'pre-tool', matcher: '', command: ' ' })).toEqual({
      ok: false,
      error: expect.stringContaining('命令不能空着'),
    })
    expect(hooks.addScript({ event: 'pre-tool', matcher: '', command: `echo ${'x'.repeat(1001)}` })).toEqual({
      ok: false,
      error: expect.stringContaining('最长 1000'),
    })
    expect(hooks.addScript({ event: 'whenever' as never, matcher: '', command: 'echo x' })).toEqual({
      ok: false,
      error: expect.stringContaining('事件名不认'),
    })

    const added = hooks.addScript({ event: 'turn-end', matcher: '  ', command: 'echo done', timeoutMs: 5, failClosed: false })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(hooks.readHooks().scripts.find((item) => item.id === added.id)).toMatchObject({
      event: 'turn-end',
      matcher: '*',
      command: 'echo done',
      timeoutMs: 5,
      failClosed: false,
    })

    hooks.setScriptEnabled(added.id, false)
    expect(hooks.readHooks().scripts.find((item) => item.id === added.id)?.enabled).toBe(false)
    hooks.removeScript(added.id)
    expect(hooks.readHooks().scripts.some((item) => item.id === added.id)).toBe(false)
  })

  test('脚本到顶后拒绝；未知 id 启停不抛错', () => {
    for (let index = hooks.readHooks().scripts.length; index < 50; index += 1) {
      expect(hooks.addScript({ event: 'pre-tool', matcher: '*', command: `echo ${String(index)}` }).ok).toBe(true)
    }
    expect(hooks.addScript({ event: 'pre-tool', matcher: '*', command: 'echo over' })).toEqual({
      ok: false,
      error: expect.stringContaining('脚本钩子最多 50 条'),
    })
    expect(() => {
      hooks.setScriptEnabled('no-such-id', true)
      hooks.removeScript('no-such-id')
    }).not.toThrow()
  })

  test('patchHookSettings：四项都改、超时下限夹到 500、非数回落当前值', () => {
    expect(hooks.patchHookSettings({ scriptTimeoutMs: 10, enabled: false, autoAccept: true, scriptFailClosed: false })).toEqual({
      enabled: false,
      scriptTimeoutMs: 500,
      scriptFailClosed: false,
      autoAccept: true,
    })
    expect(hooks.patchHookSettings({ scriptTimeoutMs: 999_999 })).toMatchObject({ scriptTimeoutMs: hooks.HOOK_TIMEOUT_MAX })
    expect(hooks.patchHookSettings({ scriptTimeoutMs: Number.NaN })).toMatchObject({ scriptTimeoutMs: hooks.HOOK_TIMEOUT_MAX })
    expect(hooks.patchHookSettings({ enabled: true }).enabled).toBe(true)
  })
})

describe('脚本文件识别与批准名单', () => {
  test('scriptFileOf 只认存在的文件；scriptTokenOf 不管在不在；引号里的空格路径也算一个词', () => {
    const real = scriptFile('real.mjs', 'process.exit(0)')
    expect(hooks.scriptFileOf(real.command)).toBe(real.path)
    expect(hooks.scriptFileOf(`node "${join(scriptDir, 'gone.py')}"`)).toBe('')
    expect(hooks.scriptTokenOf(`node "${join(scriptDir, 'gone.py')}"`)).toBe(join(scriptDir, 'gone.py'))
    expect(hooks.scriptFileOf('echo hello')).toBe('')
    expect(hooks.scriptTokenOf('echo hello')).toBe('')
    // 后缀大小写不敏感（Windows 上常见 .EXE / .PS1）。
    const upper = join(scriptDir, 'UP.PS1')
    writeFileSync(upper, 'exit 0', 'utf8')
    expect(hooks.scriptFileOf(`pwsh "${upper}"`)).toBe(upper)
  })

  test('没批准过：autoAccept 关着不跑、开着能跑；状态都照实报 untrusted', () => {
    const only = script({ command: `node "${join(scriptDir, 'untrusted.mjs')}"` })
    writeFileSync(join(scriptDir, 'untrusted.mjs'), 'process.exit(0)', 'utf8')
    expect(hooks.trustOf(only)).toMatchObject({ state: 'untrusted', runnable: false })
    expect(hooks.trustOf(only, true)).toMatchObject({ state: 'untrusted', runnable: true })
    expect(hooks.trustOf(only, true).detail).toContain('新脚本不询问')
  })

  test('命令里写了脚本、文件不在：missing，一律不跑', () => {
    const missing = script({ command: `node "${join(scriptDir, 'deleted.js')}"` })
    expect(hooks.trustOf(missing, true)).toMatchObject({
      state: 'missing',
      runnable: false,
      scriptPath: join(scriptDir, 'deleted.js'),
    })
    expect(hooks.trustOf(missing).detail).toContain('钩子脚本文件不存在')
  })

  test('批准 → trusted；文件改过 → changed；撤销 → untrusted；未知 id 给原因', () => {
    const target = scriptFile('trusted.mjs', 'process.exit(0)')
    const entry = script({ id: 'trust-me', command: target.command })
    expect(hooks.trustScript('no-such-id')).toContain('没有这条脚本钩子')

    // 把这条脚本写进配置，批准名单按「事件 + 命令」认。
    // 前面「条数到顶」的用例把配置塞满了，这里重写一份干净的，免得新脚本被截掉。
    const doc = hooks.readHooks()
    writeFileSync(
      hooks.HOOKS_FILE,
      JSON.stringify({ version: 1, settings: doc.settings, rules: [], scripts: [entry] }),
      'utf8',
    )
    expect(hooks.trustScript('trust-me')).toBeUndefined()
    expect(hooks.trustOf(entry)).toMatchObject({ state: 'trusted', runnable: true, scriptPath: target.path })
    expect(hooks.trustOf(entry).detail).toBe('已批准')

    const later = new Date(Date.now() + 60_000)
    utimesSync(target.path, later, later)
    expect(hooks.trustOf(entry)).toMatchObject({ state: 'changed', runnable: false })
    expect(hooks.trustOf(entry).detail).toContain('重新批准')

    hooks.untrustScript('trust-me')
    expect(hooks.trustOf(entry)).toMatchObject({ state: 'untrusted', runnable: false })
    hooks.untrustScript('no-such-id')
  })

  test('批准名单读坏：当没批准过，不因此在坏名单上放行', () => {
    writeFileSync(hooks.HOOK_TRUST_FILE, '{ 坏掉的', 'utf8')
    const entry = script({ command: `node "${join(scriptDir, 'real.mjs')}"` })
    expect(hooks.trustOf(entry)).toMatchObject({ state: 'untrusted', runnable: false })
  })
})

describe('规则匹配', () => {
  test('工具清单：* / 空 = 全部，| 与 , 分隔且不区分大小写', () => {
    const base: HookRule = {
      id: 'r',
      enabled: true,
      tool: 'bash|Read',
      field: 'command',
      pattern: 'x',
      action: 'deny',
      reason: '',
    }
    expect(hooks.ruleHits(base, hooks.hookFacts(facts({ toolName: 'READ', command: 'x' })))).toBe(true)
    expect(hooks.ruleHits(base, hooks.hookFacts(facts({ toolName: 'write', command: 'x' })))).toBe(false)
    expect(hooks.ruleHits({ ...base, tool: 'bash,write' }, hooks.hookFacts(facts({ toolName: 'write', command: 'x' })))).toBe(true)
    expect(hooks.ruleHits({ ...base, tool: '*' }, hooks.hookFacts(facts({ toolName: 'anything', command: 'x' })))).toBe(true)
  })

  test('field 决定看哪一段；any 三段都看；空文本不算命中', () => {
    const rule: HookRule = { id: 'r', enabled: true, tool: '*', field: 'target', pattern: 'secret', action: 'deny', reason: '' }
    const hit = { toolName: 'write', command: 'ls', target: '/x/secret.txt', args: {} }
    expect(hooks.ruleHits(rule, hooks.hookFacts(hit))).toBe(true)
    expect(hooks.ruleHits({ ...rule, field: 'command' }, hooks.hookFacts(hit))).toBe(false)
    expect(hooks.ruleHits({ ...rule, field: 'args' }, hooks.hookFacts({ ...hit, args: { path: 'secret' } }))).toBe(true)
    expect(hooks.ruleHits({ ...rule, field: 'any' }, hooks.hookFacts({ ...hit, command: '', target: '', args: {} }))).toBe(false)
  })

  test('正则失效退化成字面量；正则命中不区分大小写；matcher 同理', () => {
    const broken: HookRule = { id: 'r', enabled: true, tool: '*', field: 'command', pattern: '(', action: 'deny', reason: '' }
    expect(hooks.ruleHits(broken, hooks.hookFacts(facts({ command: 'echo (x' })))).toBe(true)
    expect(hooks.ruleHits(broken, hooks.hookFacts(facts({ command: 'echo x' })))).toBe(false)

    const loose: HookRule = { ...broken, pattern: 'DeLeTe\\s+ALL' }
    expect(hooks.ruleHits(loose, hooks.hookFacts(facts({ command: 'delete   all' })))).toBe(true)

    expect(hooks.matcherHits('', 'bash')).toBe(true)
    expect(hooks.matcherHits('*', 'bash')).toBe(true)
    expect(hooks.matcherHits('ba..', 'bash')).toBe(true)
    expect(hooks.matcherHits('[', 'x[')).toBe(true)
    expect(hooks.matcherHits('write', 'bash')).toBe(false)
  })

  test('hookFacts 把 args 编成 JSON 文本，ruleJudgement 给默认话术或用户理由', () => {
    const view = hooks.hookFacts({ toolName: 'write', command: '', target: '', args: { path: 'a' } } as never)
    expect(view).toEqual({ toolName: 'write', command: '', target: '', argsText: '{"path":"a"}' })

    const deny = hooks.ruleJudgement({
      id: 'r',
      enabled: true,
      tool: 'bash',
      field: 'command',
      pattern: 'rm',
      action: 'deny',
      reason: '',
    })
    expect(deny).toMatchObject({ action: 'block', message: expect.stringContaining('禁止'), ms: 0, problem: '' })
    expect(deny.source).toContain('/rm/')
    const ask = hooks.ruleJudgement({ ...deny, action: 'ask', reason: '要问我' } as HookRule)
    expect(ask).toMatchObject({ action: 'ask', message: '要问我' })
  })
})

describe('parseScriptVerdict：三套脚本写法', () => {
  test('不是对象 / 坏 JSON / 数组 / 空串：都不表态', () => {
    expect(hooks.parseScriptVerdict('hello')).toBeNull()
    expect(hooks.parseScriptVerdict('{bad}')).toBeNull()
    expect(hooks.parseScriptVerdict('[1,2]')).toBeNull()
    expect(hooks.parseScriptVerdict('null')).toBeNull()
  })

  test('dsc 写法：deny/block/ask/note/pass 各自映射，理由优先 message→reason', () => {
    expect(hooks.parseScriptVerdict('{"action":"deny","message":"不许"}')).toEqual({ action: 'block', message: '不许' })
    expect(hooks.parseScriptVerdict('{"action":"block","reason":"r"}')).toEqual({ action: 'block', message: 'r' })
    expect(hooks.parseScriptVerdict('{"action":"ask"}')).toEqual({ action: 'ask', message: '' })
    expect(hooks.parseScriptVerdict('{"action":"note","message":"只留话"}')).toEqual({ action: 'note', message: '只留话' })
    expect(hooks.parseScriptVerdict('{"action":"whatever"}')).toEqual({ action: 'pass', message: '' })
  })

  test('Claude 写法：decision 的 approve 是自动放行；hookSpecificOutput 的 deny/ask/allow 各归各位', () => {
    expect(hooks.parseScriptVerdict('{"decision":"block","reason":"危险"}')).toEqual({ action: 'block', message: '危险' })
    expect(hooks.parseScriptVerdict('{"decision":"approve","reason":"x"}')).toEqual({ action: 'pass', message: 'x' })
    expect(hooks.parseScriptVerdict('{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"不"}}')).toEqual({
      action: 'block',
      message: '不',
    })
    expect(hooks.parseScriptVerdict('{"hookSpecificOutput":{"permissionDecision":"ask"}}')).toEqual({ action: 'ask', message: '' })
    expect(hooks.parseScriptVerdict('{"hookSpecificOutput":{"permissionDecision":"allow"}}')).toEqual({
      action: 'pass',
      message: '',
    })
    expect(hooks.parseScriptVerdict('{"hookSpecificOutput":{"permissionDecision":"maybe"}}')).toEqual({
      action: 'pass',
      message: '',
    })
  })

  test('Hermes 写法：action=approve 表示交给人确认；超长理由截到 2048', () => {
    expect(hooks.parseScriptVerdict('{"action":"approve","message":"问我"}')).toEqual({ action: 'ask', message: '问我' })
    const long = hooks.parseScriptVerdict(`{"action":"note","message":"${'x'.repeat(3000)}"}`)
    expect(long?.message).toHaveLength(2048)
  })
})

describe('judgeScriptRun：失败方向与三种形态', () => {
  const base = script()

  test('起不来 / 超时：failClosed 拦，关掉开关只记问题', () => {
    const spawnError = run({ exitCode: -1, spawnError: 'ENOENT' })
    expect(hooks.judgeScriptRun(spawnError, base, settings)).toMatchObject({
      action: 'block',
      problem: expect.stringContaining('没能启动'),
    })
    expect(hooks.judgeScriptRun(spawnError, { ...base, failClosed: false }, settings)).toMatchObject({ action: 'pass' })

    const timeout = run({ exitCode: -1, timedOut: true, ms: 900 })
    expect(hooks.judgeScriptRun(timeout, base, settings)).toMatchObject({
      action: 'block',
      problem: expect.stringContaining('超时'),
    })
    expect(hooks.judgeScriptRun(timeout, base, { ...settings, scriptFailClosed: false })).toMatchObject({ action: 'pass' })
  })

  test('退出码 2：有 block 结论用它，没有就用 stderr，再没有给一句兜底', () => {
    expect(hooks.judgeScriptRun(run({ exitCode: 2, stdout: '{"action":"deny","message":"脚本说不行"}' }), base, settings)).toMatchObject({
      action: 'block',
      message: '脚本说不行',
    })
    expect(hooks.judgeScriptRun(run({ exitCode: 2, stderr: '  库表不能动\n第二行' }), base, settings)).toMatchObject({
      action: 'block',
      message: expect.stringContaining('库表不能动'),
    })
    expect(hooks.judgeScriptRun(run({ exitCode: 2 }), base, settings).message).toContain('没给原因')
  })

  test('其它退出码 + 有结论：按结论；0 以外又给放行结论时看 failClosed', () => {
    expect(hooks.judgeScriptRun(run({ stdout: '{"action":"ask","message":"确认"}' }), base, settings)).toMatchObject({
      action: 'ask',
      message: '确认',
    })
    expect(hooks.judgeScriptRun(run({ stdout: '{"action":"note","message":"记一笔"}' }), base, settings).action).toBe('note')
    expect(hooks.judgeScriptRun(run({ exitCode: 4, stdout: '{"action":"pass"}' }), base, settings)).toMatchObject({
      action: 'block',
      message: expect.stringContaining('退出码是 4'),
    })
    expect(
      hooks.judgeScriptRun(run({ exitCode: 4, stdout: '{"action":"pass"}' }), { ...base, failClosed: false }, settings).action,
    ).toBe('pass')
  })

  test('没有结论：退出 0 且无输出 = 不表态；输出看不懂、非 0 退出都带 stderr 首行', () => {
    expect(hooks.judgeScriptRun(run({}), base, settings)).toMatchObject({ action: 'pass', problem: '' })
    const garbage = run({ stdout: 'not json', stderr: '\nCannot find module x\n' })
    expect(hooks.judgeScriptRun(garbage, base, settings)).toMatchObject({
      action: 'block',
      message: expect.stringContaining('Cannot find module x'),
    })
    expect(hooks.judgeScriptRun(garbage, { ...base, failClosed: false }, settings).action).toBe('pass')

    const exited = run({ exitCode: 7, stderr: 'boom' })
    expect(hooks.judgeScriptRun(exited, base, settings)).toMatchObject({
      action: 'block',
      message: expect.stringContaining('boom'),
    })
    expect(hooks.judgeScriptRun(run({ exitCode: 7 }), base, settings).problem).toContain('脚本以 7 退出，没有给出结论')
  })
})

describe('strongestJudgement / hookReasonForModel', () => {
  test('拦 > 问 > 只留话 > 不表态，并列保留先给出的那条原因', () => {
    const pass = { action: 'pass' as const, message: '', source: 'a', ms: 0, problem: '' }
    const note = { ...pass, action: 'note' as const, message: 'n' }
    const ask = { ...pass, action: 'ask' as const, message: 'a1' }
    const ask2 = { ...pass, action: 'ask' as const, message: 'a2' }
    const block = { ...pass, action: 'block' as const, message: 'b' }
    expect(hooks.strongestJudgement([])).toBeNull()
    expect(hooks.strongestJudgement([pass, note, ask])).toBe(ask)
    expect(hooks.strongestJudgement([ask, block, note])).toBe(block)
    expect(hooks.strongestJudgement([ask, ask2])).toBe(ask)
  })

  test('话术：没理由给一句兜底，有理由原样带给模型并说清来源', () => {
    const bare = hooks.hookReasonForModel(
      { action: 'block', message: '', source: '规则 /x/', ms: 0, problem: '' },
      '禁止执行 rm',
    )
    expect(bare).toContain('【安全钩子】禁止执行 rm')
    expect(bare).toContain('没有给出更具体的原因')
    expect(bare).toContain('规则 /x/')
    const real = hooks.hookReasonForModel(
      { action: 'block', message: '库表不能动', source: '脚本 guard.js', ms: 0, problem: '' },
      '禁止执行 rm',
    )
    expect(real).toContain('库表不能动')
    expect(real).toContain('不要重试同一件事')
  })
})

describe('runHookScript：真子进程', () => {
  test('stdin 收到载荷，stdout 的 JSON 结论原样带回', async () => {
    const target = scriptFile(
      'ok.mjs',
      'let s="";process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({action:"note",message:"收到 "+p.session_id+" / "+p.hook_event_name}))})',
    )
    const payload = {
      hook_event_name: 'pre-tool',
      tool_name: 'bash',
      tool_input: {},
      args_summary: '',
      session_id: 'sess-42',
      cwd: home.home,
      policy: 'default',
      mode: 'build',
      command: '',
      target: '',
      extra: {},
    } as HookPayload
    const result = await hooks.runHookScript(script({ command: target.command }), payload, home.home, new AbortController().signal, 5_000)
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, spawnError: '', truncated: false })
    expect(result.stdout).toContain('收到 sess-42 / pre-tool')
    expect(hooks.parseScriptVerdict(result.stdout)).toEqual({ action: 'note', message: '收到 sess-42 / pre-tool' })
  })

  test('非 0 退出把 stderr 带回来；裁决按 failClosed 拦下', async () => {
    const target = scriptFile('fail.mjs', 'process.stderr.write("Cannot find module guard\\n");process.exit(3)')
    const result = await hooks.runHookScript(script({ command: target.command }), {} as HookPayload, home.home, new AbortController().signal, 5_000)
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('Cannot find module guard')
    expect(hooks.judgeScriptRun(result, script(), settings)).toMatchObject({
      action: 'block',
      message: expect.stringContaining('Cannot find module guard'),
    })
  })

  test('超时：到点杀进程、标 timedOut，不等它自己醒', async () => {
    const target = scriptFile('slow.mjs', 'setTimeout(()=>{},5000)')
    const started = Date.now()
    const result = await hooks.runHookScript(
      script({ command: target.command, timeoutMs: 300 }),
      {} as HookPayload,
      home.home,
      new AbortController().signal,
      5_000,
    )
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-1)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  test('打断信号：进程被收掉，Promise 仍然结清', async () => {
    const target = scriptFile('abort.mjs', 'setTimeout(()=>{},1200)')
    const controller = new AbortController()
    const pending = hooks.runHookScript(
      script({ command: target.command, timeoutMs: 10_000 }),
      {} as HookPayload,
      home.home,
      controller.signal,
      10_000,
    )
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.exitCode === 0).toBe(false)
  })

  test('stdout 超过 64KiB：截断标记置上，不把整棵树读进内存', async () => {
    const target = scriptFile('big.mjs', 'process.stdout.write("x".repeat(70000))')
    const result = await hooks.runHookScript(script({ command: target.command }), {} as HookPayload, home.home, new AbortController().signal, 5_000)
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(70_000)
    expect(result.stdout.length).toBeGreaterThanOrEqual(65_000)
  })
})
