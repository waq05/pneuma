/**
 * A1 服务注入：provide / consume、inject 硬依赖、缺依赖的两档文案、冲突人话
 * （迁自 `scripts/ui-plugin-test.mjs` 的 [6] 段）。
 *
 * ## 被测的是什么
 *
 * - 乱序清单按 inject 拓扑排好（`orderUiPlugins`，提供者在前）。
 * - **真装载**：A provide、B consume 拿到同一个对象；装载结果带服务名快照；
 *   `services.providerOf` 登记提供者；`disposeAll` 后服务释放。
 * - 提供者缺席 → 消费者不 apply，报告一行中文原因（「服务 X 还没有提供者」），
 *   缺席的服务不进装载结果快照。
 * - 提供者 apply 抛错 → 消费者报告「插件 X 没装上：…」，两个失败者都重试过一轮（attempts=2）。
 * - 重复 provide 抛 `ServiceConflictError`，人话里带两个插件 id。
 * - `unmetDependencies`：依赖分两档（plugins / services）各说各的；同一个名字两边都写时
 *   各按各的查；inject 里的名字不再回落当服务名查；被停用的依赖单列一档
 *   （不混成「不在清单里」——说成那样会把人指去重装一个已装好的插件）。
 *
 * ## 落位与隔离
 *
 * 夹具 bundle（工厂格式与真实产物一致）落临时目录；`loadTuiPlugins` 走 TUI 同进程装载器
 * （`runtime` 给最小 mock，插件只在 provide / consume 上互动，不需要 ink 渲染）；临时 HOME
 * 由 setup 给。服务表每轮注入隔离的那张，免得上一轮泄漏进下一轮。
 *
 * @module dsc/tests/integration/ui-plugin-services
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SlotRegistry } from '@pneuma/ui-core/slots.js'
import { loadTuiPlugins } from '@pneuma/ui-core/tui-plugins.js'
import type { UiPluginLoadReport } from '@pneuma/ui-core/plugin.js'
import { ServiceRegistry, ServiceConflictError, unmetDependencies, type PluginDeps } from '@pneuma/ui-core/services.js'
import { orderUiPlugins, type UiPluginRow } from '@pneuma/runtime/core/ui-manifest.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-services-'))

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

/** 造一个临时目录树；`files` 是相对路径 → 内容。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(WORK, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  return dir
}

/** 造一个 TUI 插件 bundle（工厂格式与真实产物一致）。 */
const bundle = (id: string, body: string): string =>
  `(globalThis.__DSC_UI_FACTORIES__ ??= {})[${JSON.stringify(id)}] = function (require, module, exports) {\n${body}\n};\n`

/** 最小 runtime mock（装载器只在这一段用到 getSnapshot / subscribe）。 */
const runtime = {
  getSnapshot: (): Record<string, unknown> => ({}),
  subscribe: (): (() => void) => (): void => {},
}
const host = { name: '探针', version: '0.0.0-spec', platform: 'tui' }

/** 一轮装载的入参形状（registry / services / onReport 由用例自备）。 */
interface LoadArgs {
  registry: SlotRegistry
  pluginsDir: string
  services?: ServiceRegistry
  onReport?: (report: UiPluginLoadReport) => void
}

/** 装一轮（把 mock runtime / host 固定住）。 */
function load(args: LoadArgs): ReturnType<typeof loadTuiPlugins> {
  return loadTuiPlugins({
    registry: args.registry as never,
    runtime: runtime as never,
    host: host as never,
    pluginsDir: args.pluginsDir,
    ...(args.services === undefined ? {} : { services: args.services }),
    ...(args.onReport === undefined ? {} : { onReport: args.onReport }),
  })
}

// ── 用例一：A provide、B consume，拿到的是同一个对象 ────────────────────────────
describe('A1 服务注入：provide / consume 真装载', () => {
  const facts: Record<string, unknown> = {}
  /** 探针往 globalThis 落的读数（bundle 在宿主进程里执行）。 */
  const probe = globalThis as unknown as { __PROBE_PROVIDED?: unknown; __PROBE_CONSUMED?: unknown; __PROBE_BETA_APPLIED?: boolean }

  beforeAll(() => {
    delete probe.__PROBE_PROVIDED
    delete probe.__PROBE_CONSUMED
    delete probe.__PROBE_BETA_APPLIED
    const good = makeTree('a1-good', {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [
          { id: 'beta', file: 'client.js', platform: 'tui', inject: ['alpha'] },
          { id: 'alpha', file: 'client.js', platform: 'tui' },
        ],
      }),
      'alpha/client.js': bundle(
        'alpha',
        `module.exports = { name: '甲方', apply(ui) { const seat = { kind: 'shared', n: 1 }; globalThis.__PROBE_PROVIDED = seat; ui.provide('probe.seat', seat) } };`,
      ),
      'beta/client.js': bundle(
        'beta',
        `module.exports = { name: '乙方', apply(ui) { globalThis.__PROBE_CONSUMED = ui.consume('probe.seat'); globalThis.__PROBE_BETA_APPLIED = true } };`,
      ),
    })
    const services = new ServiceRegistry()
    const reports: UiPluginLoadReport[] = []
    const registry = new SlotRegistry()
    const loadResult = load({ registry, pluginsDir: good, services, onReport: (report) => reports.push(report) })
    const alphaReport = reports.find((report) => report.id === 'alpha')
    const betaReport = reports.find((report) => report.id === 'beta')
    facts['alphaOk'] = alphaReport?.ok === true
    facts['betaOk'] = betaReport?.ok === true
    facts['sameObject'] = probe.__PROBE_CONSUMED === probe.__PROBE_PROVIDED && probe.__PROBE_PROVIDED !== undefined
    facts['provides'] = alphaReport?.provides?.join(',')
    facts['servicesSnapshot'] = loadResult.services.join(',')
    facts['providerOf'] = services.providerOf('probe.seat')
    loadResult.disposeAll()
    facts['released'] = services.names().length
  })

  afterAll(() => {
    delete probe.__PROBE_PROVIDED
    delete probe.__PROBE_CONSUMED
    delete probe.__PROBE_BETA_APPLIED
  })

  test('乱序清单按 inject 拓扑排好（提供者在前）', () => {
    const ordered = orderUiPlugins([
      { id: 'beta', inject: ['alpha'] } as UiPluginRow & { rev?: string },
      { id: 'alpha' } as UiPluginRow & { rev?: string },
    ])
    expect(ordered.map((row) => row.id).join(',')).toBe('alpha,beta')
  })

  test('提供者先装上', () => {
    expect(facts['alphaOk'], JSON.stringify(facts['provides'])).toBe(true)
  })
  test('消费者装上（乱序清单由拓扑 + 重试兜底）', () => {
    expect(facts['betaOk']).toBe(true)
  })
  test('consume 拿到 provide 的同一个对象', () => {
    expect(facts['sameObject']).toBe(true)
  })
  test('报告记录 provide 过的服务名', () => {
    expect(facts['provides'], String(facts['provides'])).toBe('probe.seat')
  })
  test('装载结果带服务名快照', () => {
    expect(facts['servicesSnapshot'], String(facts['servicesSnapshot'])).toBe('probe.seat')
  })
  test('服务表登记了提供者', () => {
    expect(facts['providerOf'], String(facts['providerOf'])).toBe('alpha')
  })
  test('卸载后服务被释放', () => {
    expect(facts['released']).toBe(0)
  })
})

// ── 用例二：提供者缺席 → 消费者不 apply，报告一行中文原因 ────────────────────────
describe('A1 服务注入：提供者缺席', () => {
  const facts: Record<string, unknown> = {}
  const probe = globalThis as unknown as { __PROBE_BETA_APPLIED?: boolean }

  beforeAll(() => {
    delete probe.__PROBE_BETA_APPLIED
    const missing = makeTree('a1-missing', {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [{ id: 'beta', file: 'client.js', platform: 'tui', services: ['probe.seat'] }],
      }),
      'beta/client.js': bundle(
        'beta',
        `module.exports = { apply(ui) { globalThis.__PROBE_BETA_APPLIED = true } };`,
      ),
    })
    const loadResult = load({ registry: new SlotRegistry(), pluginsDir: missing, onReport: (): void => undefined })
    const betaReport = loadResult.reports.find((report) => report.id === 'beta')
    facts['notApplied'] = betaReport?.ok === false && probe.__PROBE_BETA_APPLIED === undefined
    facts['error'] = String(betaReport?.error ?? '')
    facts['servicesSnapshot'] = loadResult.services.length
    loadResult.disposeAll()
    delete probe.__PROBE_BETA_APPLIED
  })

  test('提供者缺席时消费者不 apply', () => {
    expect(facts['notApplied'], JSON.stringify(facts['error'])).toBe(true)
  })
  test('报告里有一行中文原因（服务还没有提供者）', () => {
    expect(facts['error']).toContain('服务 probe.seat 还没有提供者')
  })
  test('缺席的服务不进装载结果快照', () => {
    expect(facts['servicesSnapshot']).toBe(0)
  })
})

// ── 用例三：提供者 apply 抛错 → 消费者报告「插件 X 没装上」，两个失败者都重试过 ────
describe('A1 服务注入：提供者 apply 抛错', () => {
  const facts: Record<string, unknown> = {}

  beforeAll(() => {
    const broken = makeTree('a1-broken', {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [
          { id: 'beta', file: 'client.js', platform: 'tui', inject: ['alpha'] },
          { id: 'alpha', file: 'client.js', platform: 'tui' },
        ],
      }),
      'alpha/client.js': bundle('alpha', `module.exports = { apply() { throw new Error('甲方的装配炸了') } };`),
      'beta/client.js': bundle('beta', `module.exports = { apply() {} };`),
    })
    const loadResult = load({ registry: new SlotRegistry(), pluginsDir: broken, onReport: (): void => undefined })
    const betaReport = loadResult.reports.find((report) => report.id === 'beta')
    facts['error'] = String(betaReport?.error ?? '')
    facts['attempts'] = betaReport?.attempts
    loadResult.disposeAll()
  })

  test('提供者没装上时消费者报告「插件 alpha 没装上：…」', () => {
    const error = String(facts['error'])
    expect(error.includes('插件 alpha 没装上') && error.includes('甲方的装配炸了'), error).toBe(true)
  })
  test('两个失败者都重试过一轮（attempts=2）', () => {
    expect(facts['attempts'], String(facts['attempts'])).toBe(2)
  })
})

// ── 用例四：重复 provide 抛人话（跨插件重名冲突落在服务表这一处） ──────────────────
describe('A1 服务注入：重复 provide', () => {
  test('重复 provide 抛 ServiceConflictError，人话里带两个插件 id', () => {
    const dup = new ServiceRegistry()
    dup.provide('probe.seat', 1, '甲')
    let conflict: unknown = null
    try {
      dup.provide('probe.seat', 2, '乙')
    } catch (error) {
      conflict = error
    }
    expect(conflict instanceof ServiceConflictError).toBe(true)
    expect((conflict as Error).message.includes('甲') && (conflict as Error).message.includes('乙'), (conflict as Error).message).toBe(true)
  })
})

// ── 用例五~七：unmetDependencies 的分档文案 ────────────────────────────────────
describe('unmetDependencies：依赖分两档、同名不猜、停用单列', () => {
  test('「没有提供者」与「提供者没装上」是两档文案', () => {
    const empty = new ServiceRegistry()
    const missingService = unmetDependencies({ services: ['svc.x'] } as PluginDeps, (): undefined => undefined, empty)
      .join('；')
    const failedPlugin = unmetDependencies({ plugins: ['plug.a'] } as PluginDeps, (): { ok: false; error: string } => ({ ok: false, error: '炸了' }), empty)
      .join('；')
    expect(missingService).toContain('服务 svc.x 还没有提供者')
    expect(failedPlugin).toContain('插件 plug.a 没装上：炸了')
  })

  test('同一个名字两边都写：插件那条满足、服务那条也满足才算齐', () => {
    const both = new ServiceRegistry()
    both.provide('plug.b', { ok: 1 }, 'plug.b')
    const unmet = unmetDependencies(
      { plugins: ['plug.b'], services: ['plug.b'] } as PluginDeps,
      (): { ok: true } => ({ ok: true }),
      both,
    )
    expect(unmet, JSON.stringify(unmet)).toEqual([])
  })

  test('同一个名字两边都写、但服务没提供：仍然报缺服务', () => {
    const empty = new ServiceRegistry()
    const both = new ServiceRegistry()
    both.provide('plug.b', { ok: 1 }, 'plug.b')
    const unmet = unmetDependencies(
      { plugins: ['plug.b'], services: ['plug.b'] } as PluginDeps,
      (): { ok: true } => ({ ok: true }),
      empty,
    )
    expect(unmet.join('；')).toContain('服务 plug.b 还没有提供者')
  })

  test('inject 里的名字不再回落当服务名查（不在清单里就说不在清单里）', () => {
    const both = new ServiceRegistry()
    both.provide('plug.b', { ok: 1 }, 'plug.b')
    const unmet = unmetDependencies({ plugins: ['plug.b'] } as PluginDeps, (): undefined => undefined, both)
    expect(unmet.join('；')).toContain('插件 plug.b 不在清单里')
  })

  test('被停用的依赖单列一档（不混成「不在清单里」）', () => {
    const empty = new ServiceRegistry()
    const reason = unmetDependencies(
      { plugins: ['plug.c'] } as PluginDeps,
      (): undefined => undefined,
      empty,
      new Set(['plug.c']),
    ).join('；')
    expect(reason).toContain('插件 plug.c 被停用了')
    expect(reason.includes('不在清单里')).toBe(false)
  })
})
