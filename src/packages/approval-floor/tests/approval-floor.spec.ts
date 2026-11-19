/**
 * @pneuma/approval-floor 的包级测试：钉 16 条不变量。
 *
 * 为什么这些：地板判的是「这条命令能不能放行」，写错就是 fail-open。纯配置面（白名单解析、
 * 缺省配置）原来只测了两条，真正的判定只有起守卫才看得到；这里用 `createApprovalFloor` 注入
 * 配置、规则、时钟与 shell，把「谁被拒、拒在哪一层、理由是什么」逐条钉住——灾难命令、deny 黑名单、
 * 危险命令交审批、只读工具不归地板管、无人值守、坏配置、熔断，全部是真实裁决路径，不读 `lib/`。
 *
 * 审计落盘关掉（`setAuditEnabled(false)`）：判定会写 `~/.dsc/audit.jsonl`，测试不碰真实家目录。
 *
 * @module @pneuma/approval-floor/tests
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setAuditEnabled } from '@pneuma/runtime/core/audit.js'
import type { ToolGuardInput, ToolGuardVerdict } from '@pneuma/runtime/core/tool-guards.js'
import { beforeAll, expect, test } from 'vitest'
import { approvalFloorPlugin } from '../index.js'
import {
  createApprovalFloor,
  DEFAULT_FLOOR_CONFIG,
  parseGlobEntry,
  parsePrefixEntry,
  resolveFloorConfig,
  splitListText,
  type FloorConfig,
} from '../approval-floor.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

beforeAll(() => {
  setAuditEnabled(false)
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

/** 一份「出厂配置 + 无用户规则 + POSIX 口径」的地板，每条用例只改需要改的那几项。 */
function floorOf(overrides: { config?: FloorConfig; problems?: string[]; now?: () => number } = {}) {
  return createApprovalFloor({
    readConfig: () => ({ config: overrides.config ?? DEFAULT_FLOOR_CONFIG, problems: overrides.problems ?? [] }),
    rules: () => [],
    // 固定 POSIX：不让用例结果跟着宿主是 Windows 还是 Linux 变。
    shell: () => 'posix',
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  })
}

const decide = async (floor: ReturnType<typeof floorOf>, input: ToolGuardInput): Promise<ToolGuardVerdict> =>
  floor.guard.decide(input)

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/approval-floor', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: approval-floor\s*$/m)
  expect(patch).toContain("name: '@pneuma/approval-floor'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string } | string>
    pneuma: { bundle?: { patch?: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/approval-floor')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名、apply 与注入表对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string }
  expect(typeof approvalFloorPlugin).toBe('object')
  expect(typeof approvalFloorPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(approvalFloorPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(approvalFloorPlugin.name).toBe('approval-floor')
  expect(typeof approvalFloorPlugin.apply).toBe('function')
  expect([...(approvalFloorPlugin.inject as string[])]).toEqual(['guards', 'commands', 'settings'])
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 白名单解析是设置页的输入口：星号位置与 shell 特殊字符写错，等于把一条任意命令写进白名单。
test('白名单解析：前缀按词切开，星号只许放末尾，shell 特殊字符不收', () => {
  const cases = [
    { text: 'pnpm run build', ok: true, pattern: ['pnpm', 'run', 'build'] },
    { text: 'git diff *', ok: true, pattern: ['git', 'diff', '*'] },
    { text: 'a * b', ok: false, pattern: null },
    { text: '   ', ok: false, pattern: null },
    { text: 'rm -rf $HOME', ok: false, pattern: null },
    { text: 'echo hi; rm x', ok: false, pattern: null },
  ]
  for (const one of cases) {
    const parsed = parsePrefixEntry(one.text)
    expect(parsed.ok, one.text).toBe(one.ok)
    if (parsed.ok && one.pattern !== null) expect(parsed.pattern, one.text).toEqual(one.pattern)
  }
  // deny glob 拆行：空行不算规则，编译不成也不能悄悄收下。
  expect(parseGlobEntry(' *etc/passwd* ').ok).toBe(true)
  expect(parseGlobEntry('   ').ok).toBe(false)
})

// 清单文本按换行或逗号切；缺省配置字段一个不能少（少一个就会读到 undefined 当阈值）。
test('清单按换行或逗号切，缺省配置字段齐全', () => {
  expect(splitListText('a\nb, c')).toEqual(['a', 'b', 'c'])
  const keys = [
    'allowPrefixes',
    'denyGlobs',
    'maxCommandLength',
    'circuitBreakerThreshold',
    'circuitBreakerCooldownMs',
    'circuitBreakerEnabled',
    'unattended',
  ] as const
  for (const key of keys) expect(key in DEFAULT_FLOOR_CONFIG, `缺省配置缺 ${key}`).toBe(true)
})

// ── 裁决面：谁被拒、理由是什么 ─────────────────────────────────────────────

test('灾难命令任何档位都拒，理由说清是哪一条', async () => {
  const verdict = await decide(floorOf(), inputOf('rm -rf /'))
  expect(verdict.action).toBe('deny')
  expect(verdict.action === 'deny' ? verdict.reason : '').toContain('删掉文件系统根目录')
  expect(verdict.action === 'deny' ? verdict.reason : '').toContain('灾难地板拒绝')
})

test('deny 黑名单先于审批生效：读密钥文件的命令直接拒，理由点名命中的 glob', async () => {
  const floor = floorOf()
  for (const [command, glob] of [
    ['cat /etc/passwd', '*etc/passwd*'],
    ['cat ~/.ssh/id_rsa', '*.ssh/*'],
  ] as const) {
    const verdict = await decide(floor, inputOf(command))
    expect(verdict.action, command).toBe('deny')
    expect(verdict.action === 'deny' ? verdict.reason : '', command).toContain(glob)
  }
})

test('写目标命中黑名单也拒（哪怕这次没有命令）', async () => {
  const verdict = await decide(floorOf(), inputOf('', 'write', join(process.cwd(), '.env')))
  expect(verdict.action).toBe('deny')
  expect(verdict.action === 'deny' ? verdict.reason : '').toContain('写目标命中用户 deny 黑名单')
})

test('普通只读命令与危险命令都不由地板直接拒：前者 defer，后者交审批', async () => {
  const floor = floorOf()
  expect(await decide(floor, inputOf('git status'))).toEqual({ action: 'defer' })
  // 递归删除是「危险」不是「灾难」：有人看着时交给审批卡，而不是地板硬拒。
  expect(await decide(floor, inputOf('rm -rf ./build'))).toEqual({ action: 'defer' })
})

test('只读工具不归地板管：read 风险即便带灾难命令也 defer（路径的事交给路径护栏）', async () => {
  expect(await decide(floorOf(), inputOf('rm -rf /', 'read'))).toEqual({ action: 'defer' })
})

test('白名单命中交出词元，由审批层免卡放行；不主动 pass', async () => {
  const floor = floorOf()
  expect(floor.whitelist('pnpm run build')).toEqual(['pnpm', 'run', 'build'])
  expect(floor.whitelist('rm -rf ./build')).toBeNull()
  expect(await decide(floor, inputOf('pnpm run build'))).toEqual({ action: 'defer' })
})

test('无人值守：危险命令与 ask 级命令一律拒，只读命令照旧放行', async () => {
  const floor = floorOf({ config: { ...DEFAULT_FLOOR_CONFIG, unattended: true } })
  const danger = await decide(floor, inputOf('rm -rf ./build'))
  expect(danger.action).toBe('deny')
  expect(danger.action === 'deny' ? danger.reason : '').toContain('无人值守')
  expect(await decide(floor, inputOf('git status'))).toEqual({ action: 'defer' })
})

test('配置读不通时一律拒：不给坏配置留 fail-open 的口子', async () => {
  const verdict = await decide(floorOf({ problems: ['maxCommandLength 要是整数'] }), inputOf('git status'))
  expect(verdict.action).toBe('deny')
  expect(verdict.action === 'deny' ? verdict.reason : '').toContain('配置读不通')
  expect(verdict.action === 'deny' ? verdict.reason : '').toContain('maxCommandLength 要是整数')
})

test('熔断：连续被拒到阈值后一律拒，冷却过了自动恢复', async () => {
  let now = 1_000
  const config: FloorConfig = { ...DEFAULT_FLOOR_CONFIG, circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 60_000 }
  const floor = floorOf({ config, now: () => now })
  expect((await decide(floor, inputOf('cat /etc/passwd'))).action).toBe('deny')
  expect((await decide(floor, inputOf('cat /etc/passwd'))).action).toBe('deny')
  expect(floor.breaker().tripped).toBe(true)
  const tripped = await decide(floor, inputOf('git status'))
  expect(tripped.action).toBe('deny')
  expect(tripped.action === 'deny' ? tripped.reason : '').toContain('熔断冷却中')
  // 冷却时间过去：熔断解除，普通命令恢复 defer。
  now += 60_001
  expect(floor.breaker().tripped).toBe(false)
  expect(await decide(floor, inputOf('git status'))).toEqual({ action: 'defer' })
})

test('配置解析：区间外的数值回落默认值并报问题，坏配置不静默生效', () => {
  const result = resolveFloorConfig({ maxCommandLength: 10, circuitBreakerThreshold: '5', unattended: true })
  expect(result.config.maxCommandLength).toBe(DEFAULT_FLOOR_CONFIG.maxCommandLength)
  expect(result.config.circuitBreakerThreshold).toBe(DEFAULT_FLOOR_CONFIG.circuitBreakerThreshold)
  expect(result.config.unattended).toBe(true)
  expect(result.problems.length).toBe(2)
})
