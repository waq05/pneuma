/**
 * @pneuma/approval-floor 的第二组包级测试：补既有 `approval-floor.spec.ts` 没钉到的判定分支，
 * 以及 `index.ts` 的插件装配面。
 *
 * 既有 spec 钉的是「灾难命令、默认黑名单、白名单、无人值守、坏配置、熔断」六条主干。
 * 这里补的是主干旁边的分叉：配置文本入口的三种坏形状、结构扫描（引号/括号/命令替换）、
 * 两种 shell 的转义差异、灾难地板的关机类命令、`.env` 模板与存在性探测两条例外、
 * 用户 deny 规则、内联脚本拆开后的写目标判定、白名单的多段/重定向拒绝、熔断开关与 reset，
 * 以及装配面（守卫/服务/命令/设置分区/保存校验/启动告警/session-open 复位）。
 *
 * 环境隔离：`index.ts` 在模块加载时把 `dscPath('plugins.json')` 冻成常量，所以先设
 * `DSC_HOME` 到临时目录，再动态 import 产品模块；审计落盘关掉（判定会写 audit.jsonl）。
 *
 * @module @pneuma/approval-floor/tests/rules-extra
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrefixRule } from '@pneuma/runtime/core/command-policy.js'
import type { ToolGuard, ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-floor-extra-'))
const pluginsFile = join(home, 'plugins.json')

let floorMod: typeof import('../approval-floor.js')
let pluginMod: typeof import('../index.js')

beforeAll(async () => {
  process.env.DSC_HOME = home
  floorMod = await import('../approval-floor.js')
  pluginMod = await import('../index.js')
  const audit = await import('@pneuma/runtime/core/audit.js')
  audit.setAuditEnabled(false)
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  rmSync(pluginsFile, { force: true, maxRetries: 5, retryDelay: 50 })
})

/** 一次 bash 调用：地板只读 command / risk / target / cwd。 */
const inputOf = (command: string, risk: ToolGuardInput['risk'] = 'exec', target?: string): ToolGuardInput => ({
  toolName: 'bash',
  risk,
  cwd: process.cwd(),
  args: command === '' ? {} : { command },
  ...(command === '' ? {} : { command }),
  ...(target === undefined ? {} : { target }),
  signal: new AbortController().signal,
  sessionId: 'test-session',
  sessionPath: 'test-session.jsonl',
})

/** 出厂配置 + 指定规则 + POSIX / PowerShell 口径的地板。 */
function floorOf(overrides: {
  config?: import('../approval-floor.js').FloorConfig
  problems?: string[]
  rules?: readonly PrefixRule[]
  shell?: 'posix' | 'powershell'
  now?: () => number
} = {}) {
  // 默认关掉熔断：本组用例常把多条拒命令串在一起来比理由，熔断会把后面的理由盖掉。
  // 熔断本身由单独的用例显式打开。
  const config = overrides.config ?? { ...floorMod.DEFAULT_FLOOR_CONFIG, circuitBreakerEnabled: false }
  return floorMod.createApprovalFloor({
    readConfig: () => ({ config, problems: overrides.problems ?? [] }),
    rules: () => overrides.rules ?? [],
    shell: () => overrides.shell ?? 'posix',
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  })
}

/** 取裁决的拒绝理由；不是拒绝时返回空串，方便逐条断言文案。 */
const reasonOf = (verdict: { action: string; reason?: string }): string => (verdict.action === 'deny' ? (verdict.reason ?? '') : '')

// ── 配置文本入口 ─────────────────────────────────────────────────────────────

test('清单解析：前缀与 glob 两套文本入口，成功归一化、坏条目与空清单都报出来', () => {
  expect(floorMod.parsePrefixListText('pnpm run build\ngit diff *')).toEqual({
    ok: true,
    values: ['pnpm run build', 'git diff *'],
  })
  const star = floorMod.parsePrefixListText('a * b')
  expect(star.ok).toBe(false)
  expect(star.ok ? '' : star.error).toContain('前缀「a * b」用不了')
  const emptyPrefix = floorMod.parsePrefixListText(' , \n ')
  expect(emptyPrefix.ok).toBe(false)
  expect(emptyPrefix.ok ? '' : emptyPrefix.error).toContain('白名单不能是空的')

  expect(floorMod.parseGlobListText(' *etc/passwd* ,\n*.key ')).toEqual({
    ok: true,
    values: ['*etc/passwd*', '*.key'],
  })
  const emptyGlob = floorMod.parseGlobListText('\n')
  expect(emptyGlob.ok).toBe(false)
  expect(emptyGlob.ok ? '' : emptyGlob.error).toContain('黑名单不能是空的')
})

test('配置解析：非对象、字段形状与区间错误全部进 problems，坏值回落默认且不静默采用', () => {
  const notObject = floorMod.resolveFloorConfig([])
  expect(notObject.problems).toEqual(['配置不是一个对象'])
  expect(notObject.config.maxCommandLength).toBe(floorMod.DEFAULT_FLOOR_CONFIG.maxCommandLength)

  const shapes = floorMod.resolveFloorConfig({ allowPrefixes: 'x', denyGlobs: {} })
  expect(shapes.problems).toHaveLength(2)
  expect(shapes.config.allowPrefixes).toBe(floorMod.DEFAULT_FLOOR_CONFIG.allowPrefixes)
  expect(shapes.config.denyGlobs).toBe(floorMod.DEFAULT_FLOOR_CONFIG.denyGlobs)

  const mixed = floorMod.resolveFloorConfig({
    allowPrefixes: ['git diff *', 42, 'a * b'],
    denyGlobs: ['*.key', '  ', 7],
    maxCommandLength: 99,
    circuitBreakerThreshold: 1.5,
    circuitBreakerCooldownMs: 3_600_001,
    circuitBreakerEnabled: 'yes',
    unattended: 1,
  })
  // 能用的留下、坏掉的跳过；其余字段各自回落默认值并各报一条。
  expect(mixed.config.allowPrefixes).toEqual([['git', 'diff', '*']])
  expect(mixed.config.denyGlobs).toEqual(['*.key'])
  expect(mixed.config.maxCommandLength).toBe(floorMod.DEFAULT_FLOOR_CONFIG.maxCommandLength)
  expect(mixed.config.circuitBreakerThreshold).toBe(floorMod.DEFAULT_FLOOR_CONFIG.circuitBreakerThreshold)
  expect(mixed.config.circuitBreakerCooldownMs).toBe(floorMod.DEFAULT_FLOOR_CONFIG.circuitBreakerCooldownMs)
  expect(mixed.config.circuitBreakerEnabled).toBe(floorMod.DEFAULT_FLOOR_CONFIG.circuitBreakerEnabled)
  expect(mixed.config.unattended).toBe(floorMod.DEFAULT_FLOOR_CONFIG.unattended)
  expect(mixed.problems).toHaveLength(9)
  expect(mixed.problems.join('\n')).toContain('allowPrefixes 里混进了非字符串：42')
  expect(mixed.problems.join('\n')).toContain('maxCommandLength 要在 100~100000 之间')

  const bounds = floorMod.resolveFloorConfig({ maxCommandLength: 100, circuitBreakerThreshold: 100, circuitBreakerCooldownMs: 0 })
  expect(bounds.problems).toEqual([])
  expect(bounds.config.maxCommandLength).toBe(100)
  expect(bounds.config.circuitBreakerCooldownMs).toBe(0)
})

// ── 判定：空命令 / 结构 / 替换 ───────────────────────────────────────────────

test('没有命令时只看写目标：无目标是 defer，命中黑名单先于无人值守拒，区外写也拒、区内照常 defer', async () => {
  const plain = floorOf()
  expect(await plain.guard.decide(inputOf(''))).toEqual({ action: 'defer' })
  expect(await plain.guard.decide(inputOf('', 'write', join(process.cwd(), 'notes.txt')))).toEqual({ action: 'defer' })

  const unattended = floorOf({ config: { ...floorMod.DEFAULT_FLOOR_CONFIG, unattended: true } })
  const secret = await unattended.guard.decide(inputOf('', 'write', join(process.cwd(), '.env')))
  expect(secret.action).toBe('deny')
  expect(reasonOf(secret)).toContain('写目标命中用户 deny 黑名单（*.env）')

  const outside = await unattended.guard.decide(inputOf('', 'write', join(tmpdir(), 'dsc-floor-outside.txt')))
  expect(outside.action).toBe('deny')
  expect(reasonOf(outside)).toContain('无人值守场景只放行工作区内的写入')

  const inside = await unattended.guard.decide(inputOf('', 'write', join(process.cwd(), 'notes.txt')))
  expect(inside).toEqual({ action: 'defer' })
})

test('结构不可验证一律拒：超长、引号没闭合、多余右括号、括号没闭合都给出各自理由', async () => {
  const short = floorOf({ config: { ...floorMod.DEFAULT_FLOOR_CONFIG, maxCommandLength: 20 } })
  const long = await short.guard.decide(inputOf(`echo ${'a'.repeat(30)}`))
  expect(long.action).toBe('deny')
  expect(reasonOf(long)).toContain('超过上限 20')

  const floor = floorOf()
  for (const [command, needle] of [
    ['echo "abc', '没闭合'],
    ['echo )', '多余的右括号'],
    ['echo (', '括号没闭合'],
  ] as const) {
    const verdict = await floor.guard.decide(inputOf(command))
    expect(verdict.action, command).toBe('deny')
    expect(reasonOf(verdict), command).toContain(needle)
  }
})

test('结构扫描按实际 shell 判：POSIX 的反斜杠会把右引号吃掉，PowerShell 不会', async () => {
  // `echo "C:\"`：POSIX 里 `\"` 是转义后的引号，整条命令的引号没闭合；
  // PowerShell 里反斜杠是普通字符，右引号照常闭合。
  const command = 'echo "C:\\"'
  const posix = await floorOf({ shell: 'posix' }).guard.decide(inputOf(command))
  expect(posix.action).toBe('deny')
  expect(reasonOf(posix)).toContain('没闭合')
  expect(await floorOf({ shell: 'powershell' }).guard.decide(inputOf(command))).toEqual({ action: 'defer' })
})

test('命令替换：内层灾难单独拒；内层干净也不放行，理由给出改法', async () => {
  const floor = floorOf()
  const clean = await floor.guard.decide(inputOf('echo $(git status)'))
  expect(clean.action).toBe('deny')
  expect(reasonOf(clean)).toContain('命令替换')
  expect(reasonOf(clean)).toContain('改成两步')

  const disaster = await floor.guard.decide(inputOf('echo $(rm -rf /)'))
  expect(disaster.action).toBe('deny')
  expect(reasonOf(disaster)).toContain('命令替换里的片段被判为灾难性动作')
  expect(reasonOf(disaster)).toContain('删掉文件系统根目录')
})

// ── 判定：灾难 / 黑名单 / 规则 ───────────────────────────────────────────────

test('灾难地板补的那部分：fork 炸弹与关机重启类命令按命令位置识别，grep 同名词不误伤', async () => {
  const floor = floorOf()
  for (const [command, needle] of [
    [':(){ :|:& };:', 'fork 炸弹'],
    ['shutdown -h now', '关机命令'],
    ['reboot', '重启命令'],
    ['init 6', '停机或重启档'],
    ['systemctl poweroff', 'systemctl poweroff'],
    ['kill -1 1234', 'kill -1'],
  ] as const) {
    const verdict = await floor.guard.decide(inputOf(command))
    expect(verdict.action, command).toBe('deny')
    expect(reasonOf(verdict), command).toContain(needle)
  }
  expect(await floor.guard.decide(inputOf('grep shutdown README.md'))).toEqual({ action: 'defer' })
})

test('deny 黑名单：反斜杠路径归一后照旧命中，.env 模板与存在性探测例外不扩大到其它密钥', async () => {
  const floor = floorOf()
  const ssh = await floor.guard.decide(inputOf('Get-Content C:\\Users\\me\\.ssh\\config'))
  expect(ssh.action).toBe('deny')
  expect(reasonOf(ssh)).toContain('*.ssh/*')

  expect(await floor.guard.decide(inputOf('cat .env.example'))).toEqual({ action: 'defer' })
  expect(await floor.guard.decide(inputOf('Test-Path .env'))).toEqual({ action: 'defer' })

  const local = await floor.guard.decide(inputOf('cat .env.local'))
  expect(local.action).toBe('deny')
  expect(reasonOf(local)).toContain('*.env.*')
  const key = await floor.guard.decide(inputOf('Test-Path id_rsa'))
  expect(key.action).toBe('deny')
  expect(reasonOf(key)).toContain('*id_rsa*')
  const pem = await floor.guard.decide(inputOf('cat cert.pem'))
  expect(pem.action).toBe('deny')
  expect(reasonOf(pem)).toContain('*.pem')
})

test('用户 deny 规则排在危险模式前生效；eval 与编码命令按「判不出」拒', async () => {
  const rules: PrefixRule[] = [
    { pattern: ['kubectl', 'delete'], decision: 'deny', justification: '集群删除要人工确认' },
    { pattern: ['deploy'], decision: 'deny' },
  ]
  const floor = floorOf({ rules })
  const kubectl = await floor.guard.decide(inputOf('kubectl delete pod api-0'))
  expect(kubectl.action).toBe('deny')
  expect(reasonOf(kubectl)).toContain('用户规则禁止：集群删除要人工确认')

  const bare = await floor.guard.decide(inputOf('deploy now'))
  expect(bare.action).toBe('deny')
  expect(reasonOf(bare)).toContain('用户规则禁止：deploy')

  const evaluated = await floor.guard.decide(inputOf('eval "rm -rf /"'))
  expect(evaluated.action).toBe('deny')
  expect(reasonOf(evaluated)).toContain('eval 会把字符串当命令跑')
})

// ── 判定：内联脚本 / 白名单 / 无人值守 ────────────────────────────────────────

test('内联脚本：能拆出明文命令的递归判，写目标判不清或内层撞黑名单仍拒，字面量写目标才交回后层', async () => {
  const floor = floorOf()
  const literal = await floor.guard.decide(inputOf('bash -c "rm -rf ./build"'))
  expect(literal.action).toBe('defer')

  const disaster = await floor.guard.decide(inputOf('bash -c "rm -rf /"'))
  expect(disaster.action).toBe('deny')
  expect(reasonOf(disaster)).toContain('里的命令没通过地板判定')
  expect(reasonOf(disaster)).toContain('删掉文件系统根目录')

  const find = await floor.guard.decide(inputOf('bash -c "find / -delete"'))
  expect(find.action).toBe('deny')
  expect(reasonOf(find)).toContain('「find」不在已知写命令名单里')

  const env = await floor.guard.decide(inputOf('bash -c "cat .env"'))
  expect(env.action).toBe('deny')
  expect(reasonOf(env)).toContain('deny 黑名单')

  const empty = await floor.guard.decide(inputOf('bash -c'))
  expect(empty.action).toBe('deny')
  expect(reasonOf(empty)).toContain('后面没有脚本')

  const encoded = await floor.guard.decide(inputOf('powershell -EncodedCommand AAAAAAAAAAAAAAAAAAAA'))
  expect(encoded.action).toBe('deny')
  expect(reasonOf(encoded)).toContain('内容不是明文命令')

  const variable = await floor.guard.decide(inputOf('sh -c "rm -rf $BUILD_DIR"'))
  expect(variable.action).toBe('deny')
  expect(reasonOf(variable)).toContain('不是字面量路径')
})

test('白名单只认单段、无重定向的字面前缀；多段与重定向一律不给白名单', async () => {
  const floor = floorOf()
  expect(floor.whitelist('pnpm run build')).toEqual(['pnpm', 'run', 'build'])
  expect(floor.whitelist('pnpm run build --frozen-lockfile')).toEqual(['pnpm', 'run', 'build'])
  expect(floor.whitelist('pnpm run build && echo hi')).toBeNull()
  expect(floor.whitelist('pnpm run build > out.txt')).toBeNull()
  expect(floor.whitelist('git status')).toBeNull()
  expect(await floor.guard.decide(inputOf('pnpm run build'))).toEqual({ action: 'defer' })
})

test('无人值守：危险命令与 ask 级命令拒，白名单与只读命令照常 defer', async () => {
  const floor = floorOf({ config: { ...floorMod.DEFAULT_FLOOR_CONFIG, unattended: true } })
  const danger = await floor.guard.decide(inputOf('rm -rf ./build'))
  expect(danger.action).toBe('deny')
  expect(reasonOf(danger)).toContain('无人值守场景不放行危险命令')

  const ask = await floor.guard.decide(inputOf('npm install left-pad'))
  expect(ask.action).toBe('deny')
  expect(reasonOf(ask)).toContain('无人值守场景不弹审批卡')

  expect(await floor.guard.decide(inputOf('pnpm run build'))).toEqual({ action: 'defer' })
  expect(await floor.guard.decide(inputOf('git status'))).toEqual({ action: 'defer' })
})

// ── 熔断 / 坏配置 ────────────────────────────────────────────────────────────

test('熔断：冷却期拒且不续期，冷却按秒向上取整；关掉开关只计数不熔断；reset 清空状态', async () => {
  let now = 1_000
  const config: import('../approval-floor.js').FloorConfig = {
    ...floorMod.DEFAULT_FLOOR_CONFIG,
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownMs: 60_000,
  }
  const floor = floorOf({ config, now: () => now })
  expect((await floor.guard.decide(inputOf('cat /etc/passwd'))).action).toBe('deny')
  expect((await floor.guard.decide(inputOf('cat /etc/passwd'))).action).toBe('deny')
  expect(floor.breaker()).toEqual({ consecutiveDenies: 0, openUntil: 61_000, tripped: true })

  const cooling = await floor.guard.decide(inputOf('git status'))
  expect(cooling.action).toBe('deny')
  expect(reasonOf(cooling)).toContain('还有约 60 秒')
  // 熔断期的拒不再计数：否则每次重试都续一次冷却。
  expect(floor.breaker().consecutiveDenies).toBe(0)

  floor.reset()
  expect(floor.breaker()).toEqual({ consecutiveDenies: 0, openUntil: 0, tripped: false })

  const disabled = floorOf({
    config: { ...config, circuitBreakerEnabled: false, circuitBreakerThreshold: 1 },
    now: () => 2_000,
  })
  expect((await disabled.guard.decide(inputOf('cat /etc/passwd'))).action).toBe('deny')
  expect(disabled.breaker()).toEqual({ consecutiveDenies: 1, openUntil: 0, tripped: false })
  expect(await disabled.guard.decide(inputOf('git status'))).toEqual({ action: 'defer' })
  // defer 把连续拒绝计数清零。
  expect(disabled.breaker().consecutiveDenies).toBe(0)
})

test('坏配置一律拒且不计入熔断，问题原文进理由，用户能看到该改哪里', async () => {
  const floor = floorOf({ problems: ['maxCommandLength 要是整数'] })
  const verdict = await floor.guard.decide(inputOf('git status'))
  expect(verdict.action).toBe('deny')
  expect(reasonOf(verdict)).toContain('配置读不通')
  expect(reasonOf(verdict)).toContain('maxCommandLength 要是整数')
  expect(floor.breaker()).toEqual({ consecutiveDenies: 0, openUntil: 0, tripped: false })
})

// ── 装配面：index.ts ────────────────────────────────────────────────────────

interface Mounted {
  state: {
    guard?: ToolGuard
    services: Record<string, { whitelist(command: string): readonly string[] | null; count(): number }>
    command?: { name: string; args?: string; description?: string }
    commandHandler?: (args: { ui: { notice(text: string): void } }) => Promise<void> | void
    section?: import('@pneuma/runtime/services/types.js').SettingsSectionSpec
    handlers: Map<string, () => void>
    emitted: Array<[string, unknown]>
    offCalls: number
  }
  ctx: Record<string, unknown>
  dispose: () => void
}

/** 一份够 apply 用的假 ctx：只记录注册结果，不模拟 cordis 的 Fiber。 */
function mountFloor(): Mounted {
  const state: Mounted['state'] = {
    services: {},
    handlers: new Map(),
    emitted: [],
    offCalls: 0,
  }
  const off = (): void => {
    state.offCalls += 1
  }
  const ctx: Record<string, unknown> = {
    guards: { register: (guard: ToolGuard) => ((state.guard = guard), off) },
    provide: (name: string, value: Mounted['state']['services'][string]) => {
      state.services[name] = value
      return off
    },
    commands: {
      register: (spec: NonNullable<Mounted['state']['command']>, handler: NonNullable<Mounted['state']['commandHandler']>) => {
        state.command = spec
        state.commandHandler = handler
        return off
      },
    },
    settings: {
      registerSection: (spec: NonNullable<Mounted['state']['section']>) => ((state.section = spec), off),
    },
    on: (name: string, handler: () => void) => {
      state.handlers.set(name, handler)
    },
    emit: (name: string, payload: unknown) => {
      state.emitted.push([name, payload])
    },
    effect: (execute: () => unknown) => {
      const handle = execute()
      return typeof handle === 'function' ? handle : off
    },
  }
  const dispose = (pluginMod.approvalFloorPlugin.apply as unknown as (ctx: unknown) => () => void)(ctx)
  return { state, ctx, dispose }
}

test('装配：守卫 order 5、approvalFloor 服务、/floor 命令、设置分区与四份清理都在', () => {
  const { state, dispose } = mountFloor()
  expect(state.guard?.id).toBe('approval-floor')
  expect(state.guard?.order).toBe(5)

  const service = state.services['approvalFloor']
  expect(service).toBeDefined()
  expect(service?.whitelist('pnpm run build')).toEqual(['pnpm', 'run', 'build'])
  expect(service?.count()).toBe(floorMod.DEFAULT_FLOOR_CONFIG.allowPrefixes.length)

  expect(state.command?.name).toBe('floor')
  expect(state.section?.id).toBe('approval-floor')
  expect(state.section?.order).toBe(33)
  // 换会话要把熔断清掉：插件必须挂了这个事件。
  expect(state.handlers.has('dsc/session-open')).toBe(true)

  const notices: string[] = []
  void state.commandHandler?.({ ui: { notice: (text: string) => notices.push(text) } })
  expect(notices.join('\n')).toContain('危险命令硬拦截：守卫链 order 5')
  expect(notices.join('\n')).toContain(`白名单（命中由审批层免卡放行，共 ${floorMod.DEFAULT_FLOOR_CONFIG.allowPrefixes.length} 条）`)
  expect(notices.join('\n')).toContain(`配置文件：${pluginsFile} 的 approval-floor 条目`)

  dispose()
  expect(state.offCalls).toBe(4)
})

test('装配：设置分区字段齐全，保存时校验并落盘，坏值不写、好值立刻生效并广播 dsc/changed', () => {
  const { state, dispose } = mountFloor()
  const section = state.section!
  const fields = section.fields()
  const keys = fields.flatMap((field) => ('key' in field && typeof field.key === 'string' ? [field.key] : []))
  expect(keys).toEqual([
    'allowPrefixes',
    'denyGlobs',
    'maxCommandLength',
    'unattended',
    'circuitBreakerEnabled',
    'circuitBreakerThreshold',
    'circuitBreakerCooldownMs',
  ])
  const values = section.values()
  expect(values.maxCommandLength).toBe(4_000)
  expect(values.unattended).toBe(false)
  expect(String(values.allowPrefixes)).toContain('pnpm run build')

  // 坏值：只返回给用户看的原因，不落盘。
  expect(section.save('allowPrefixes', 'a * b')).toContain('前缀「a * b」用不了')
  expect(section.save('allowPrefixes', '   ')).toContain('白名单不能是空的')
  expect(section.save('maxCommandLength', 10)).toContain('要在 100~100000 之间')
  expect(section.save('maxCommandLength', 'abc')).toContain('要填一个整数')
  expect(section.save('circuitBreakerThreshold', 0)).toContain('要在 1~100 之间')
  expect(section.save('definitely-not-a-key', 1)).toContain('这个分区没有这项：definitely-not-a-key')

  // 好值：写进临时 DSC_HOME 的 plugins.json，读回的值跟着变。
  expect(section.save('allowPrefixes', 'git diff *\npnpm run build')).toBeUndefined()
  expect(section.save('maxCommandLength', '2500')).toBeUndefined()
  expect(section.save('unattended', true)).toBeUndefined()
  expect(section.save('circuitBreakerEnabled', false)).toBeUndefined()
  expect(section.save('circuitBreakerThreshold', 7)).toBeUndefined()
  expect(section.save('circuitBreakerCooldownMs', 1_500)).toBeUndefined()
  expect(section.save('denyGlobs', '*.key\n*credentials.yaml')).toBeUndefined()

  const stored = JSON.parse(readFileSync(pluginsFile, 'utf8')) as {
    entries: Array<{ file: string; config: Record<string, unknown> }>
  }
  const config = stored.entries.find((entry) => entry.file === 'approval-floor')?.config
  expect(config?.allowPrefixes).toEqual(['git diff *', 'pnpm run build'])
  expect(config?.maxCommandLength).toBe(2_500)
  expect(config?.unattended).toBe(true)
  expect(config?.circuitBreakerEnabled).toBe(false)
  expect(config?.circuitBreakerThreshold).toBe(7)
  expect(config?.circuitBreakerCooldownMs).toBe(1_500)
  expect(config?.denyGlobs).toEqual(['*.key', '*credentials.yaml'])

  const after = section.values()
  expect(after.allowPrefixes).toBe('git diff *\npnpm run build')
  expect(after.maxCommandLength).toBe(2_500)
  expect(after.circuitBreakerEnabled).toBe(false)
  expect(state.emitted.filter(([name]) => name === 'dsc/changed').length).toBe(7)
  dispose()
})

test('装配：坏配置启动时发一条 notice，设置页多出问题字段，守卫按最严拒', async () => {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    pluginsFile,
    JSON.stringify({ version: 1, entries: [{ file: 'approval-floor', disabled: false, config: { allowPrefixes: 'nope' } }] }),
    'utf8',
  )
  const { state, dispose } = mountFloor()
  const notice = state.emitted.find(([name]) => name === 'dsc/notice')
  expect(notice).toBeDefined()
  expect(String(notice?.[1])).toContain('危险命令硬拦截配置有问题')

  const problem = state.section
    ?.fields()
    .find((field) => 'label' in field && field.label === '配置有问题，现在一律拒')
  expect(problem).toBeDefined()
  expect('text' in problem! ? problem.text : '').toContain('allowPrefixes 要是一串字符串')

  const verdict = await state.guard!.decide(inputOf('git status'))
  expect(verdict.action).toBe('deny')
  expect(reasonOf(verdict)).toContain('配置读不通')
  dispose()
})

test('装配：session-open 清熔断，/floor 与设置页里的熔断状态随之复位', async () => {
  writeFileSync(
    pluginsFile,
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: 'approval-floor',
          disabled: false,
          config: { circuitBreakerThreshold: 1, circuitBreakerCooldownMs: 60_000 },
        },
      ],
    }),
    'utf8',
  )
  const { state, dispose } = mountFloor()
  expect((await state.guard!.decide(inputOf('cat /etc/passwd'))).action).toBe('deny')
  // 熔断中：/floor 文案会直接写出来。
  const notices: string[] = []
  void state.commandHandler?.({ ui: { notice: (text: string) => notices.push(text) } })
  expect(notices.join('\n')).toContain('正在熔断中')

  state.handlers.get('dsc/session-open')?.()
  const after: string[] = []
  void state.commandHandler?.({ ui: { notice: (text: string) => after.push(text) } })
  expect(after.join('\n')).toContain('当前连续 0 次')
  expect(after.join('\n')).not.toContain('正在熔断中')
  dispose()
})
