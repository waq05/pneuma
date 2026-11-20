/**
 * `ui-core` 终端壳插件装载器（`tui-plugins.ts`）的补盲。
 *
 * 既有 `tests/integration/ui-tui-plugin.int.spec.ts` 铺了主流程；这里补它走不到的几条：
 *
 *   - `require` 一个「在图里但还没装好」的插件：报「等」而不是「没有」（否则作者会去翻模块表，
 *     而问题在另一条插件的装载报告里）；
 *   - bundle 没注册工厂（形状不对）：点名拒绝，不是 undefined 崩；
 *   - 插件 apply 中途抛错时的回滚：登记账本逐条退订，退订自己再抛错只记日志、不把异常扔给装载器；
 *   - 进程内 `UiRuntimeApi` 适配（`tuiRuntime`）：快照按 web 通道同一形状投影（seq 自增、
 *     sessionId 空串兜底、正负 id 拆成 entries / liveEntries）、订阅转发、`invoke` 的
 *     白名单 / 实参校验 / 运行期抛错三条出口。
 *
 * `DSC_HOME` 必须在装载器被 import 之前换成临时目录（`core/path-policy.ts` 的 `DSC_HOME`
 * 是模块级常量），所以装载器用动态 import，类型走 `typeof import(...)`，不另起进程。
 *
 * @module dsc/packages/ui-core/ui/w14-tui-plugins
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

/** 夹具总目录；成功时 afterAll 删，失败现场留着翻。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-w14-tui-'))
/** 假的主目录：第三方插件发现落在这里，绝不碰真的 `~/.dsc`。 */
const FAKE_HOME = join(WORK, 'home')

const previousHome = process.env['DSC_HOME']
let loadTuiPlugins: typeof import('../tui-plugins.js').loadTuiPlugins
let SlotRegistry: typeof import('../slots.js').SlotRegistry

beforeAll(async () => {
  mkdirSync(FAKE_HOME, { recursive: true })
  process.env['DSC_HOME'] = FAKE_HOME
  const pluginLoader = await import('../tui-plugins.js')
  loadTuiPlugins = pluginLoader.loadTuiPlugins
  const slots = await import('../slots.js')
  SlotRegistry = slots.SlotRegistry
})

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

/** 一条夹具插件：id + bundle 代码 + 清单行上的额外字段。 */
interface FixturePlugin {
  id: string
  code: string
  row?: Record<string, unknown>
}

/** 按「内置产物目录」的形状落一棵夹具树（`manifest.json` + `<id>/client.js`）。 */
function writeTree(name: string, plugins: readonly FixturePlugin[]): string {
  const dir = join(WORK, name)
  mkdirSync(dir, { recursive: true })
  const rows = plugins.map((plugin) => {
    mkdirSync(join(dir, plugin.id), { recursive: true })
    writeFileSync(join(dir, plugin.id, 'client.js'), plugin.code, 'utf8')
    return { id: plugin.id, file: 'client.js', platform: 'tui', ...plugin.row }
  })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, apiVersion: '2.0.0', plugins: rows }), 'utf8')
  return dir
}

/** 装一轮的最小 runtime（只有 `getSnapshot` / `subscribe` / 两个方法）。 */
interface FakeRuntime {
  runtime: never
  listeners: Set<() => void>
}

function fakeRuntime(): FakeRuntime {
  const listeners = new Set<() => void>()
  const runtime = {
    getSnapshot: () => ({
      entries: [{ id: 3 }, { id: -2 }, { id: 0 }],
      status: { sessionId: 'sid-1' },
    }),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    interrupt: (): void => {
      throw new Error('中断炸了')
    },
    listModels: (): unknown[] => [],
  }
  return { runtime: runtime as never, listeners }
}

/** 落一轮装载，返回报告表（按 id 索引，重试后的那份在）。 */
function load(
  pluginsDir: string,
  extra: {
    services?: unknown
    onReport?: (report: { id: string }) => void
    runtime?: FakeRuntime
  } = {},
): ReturnType<typeof loadTuiPlugins> {
  const registry = new SlotRegistry()
  const runtime = extra.runtime ?? fakeRuntime()
  return loadTuiPlugins({
    registry: registry as never,
    runtime: runtime.runtime,
    host: { name: 'Pneuma', version: '0.0.0-spec', platform: 'tui' },
    pluginsDir,
    ...(extra.services === undefined ? {} : { services: extra.services as never }),
    ...(extra.onReport === undefined ? {} : { onReport: extra.onReport as never }),
  })
}

describe('装载失败的三种形状', () => {
  test('require 图里别的插件：还没装好时说「等」，不是「给不了」；没注册工厂的点名拒绝', () => {
    const tree = writeTree('failures', [
      {
        id: 'consumer',
        code: [
          `(globalThis.__DSC_UI_FACTORIES__ ??= {})['consumer'] = function (require, module, exports) {`,
          `  const provider = require('provider');`,
          `  module.exports = { apply() { void provider } };`,
          `};`,
          '',
        ].join('\n'),
      },
      {
        id: 'provider',
        code: `(globalThis.__DSC_UI_FACTORIES__ ??= {})['provider'] = function () { globalThis.__W14_PROVIDER_RAN__ = true };\n`,
      },
      {
        id: 'nofactory',
        code: 'globalThis.__W14_NO_FACTORY__ = true\n',
      },
    ])
    const result = load(tree)
    const reports = new Map(result.reports.map((report) => [report.id, report]))
    expect(reports.get('consumer')?.ok).toBe(false)
    expect(String(reports.get('consumer')?.error)).toContain('还没装好')
    expect(String(reports.get('consumer')?.error)).toContain('provider')
    expect(String(reports.get('nofactory')?.error)).toContain('没有注册工厂')
    // 两轮都失败：attempts 停在 2，不会被重试掩盖。
    expect(reports.get('consumer')?.attempts).toBe(2)
    result.disposeAll()
    delete (globalThis as Record<string, unknown>)['__W14_PROVIDER_RAN__']
    delete (globalThis as Record<string, unknown>)['__W14_NO_FACTORY__']
  })

  test('apply 中途抛错：按登记账本回滚，退订再抛错只记日志，报告里仍是 apply 的原错', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let released = 0
    const services = {
      has: () => false,
      consume: () => undefined,
      names: () => [],
      provide: (): (() => void) => () => {
        released += 1
        throw new Error('退订炸了')
      },
    }
    const tree = writeTree('rollback', [
      {
        id: 'prover',
        code: [
          `(globalThis.__DSC_UI_FACTORIES__ ??= {})['prover'] = function (require, module, exports) {`,
          `  module.exports = { apply(ui) {`,
          `    ui.provide('svc', 1);`,
          `    throw new Error('apply 炸了');`,
          `  } };`,
          `};`,
          '',
        ].join('\n'),
      },
    ])
    const result = load(tree, { services })
    const report = result.reports.find((item) => item.id === 'prover')
    expect(report?.ok).toBe(false)
    expect(report?.error).toBe('apply 炸了')
    // 两轮装载各回滚一次：第一次失败后还会重试一轮。
    expect(report?.attempts).toBe(2)
    expect(released).toBe(2)
    expect(error.mock.calls.some((call) => String(call[0]).includes('回滚登记时出错'))).toBe(true)
    expect(services.names()).toEqual([])
    result.disposeAll()
    vi.restoreAllMocks()
  })
})

describe('进程内 UiRuntimeApi 适配（tuiRuntime）', () => {
  test('快照投影、订阅转发、invoke 的三条出口', async () => {
    const probe: Record<string, unknown> = {}
    ;(globalThis as unknown as { __W14_RUNTIME__: Record<string, unknown> })['__W14_RUNTIME__'] = probe
    const tree = writeTree('runtime', [
      {
        id: 'prober',
        code: [
          `(globalThis.__DSC_UI_FACTORIES__ ??= {})['prober'] = function (require, module, exports) {`,
          `  const probe = globalThis.__W14_RUNTIME__;`,
          `  module.exports = { apply(ui) {`,
          `    const first = ui.runtime.getSnapshot();`,
          `    const second = ui.runtime.getSnapshot();`,
          `    probe.seqs = [first.seq, second.seq];`,
          `    probe.sessionId = first.sessionId;`,
          `    probe.entries = first.entries.map((entry) => entry.id);`,
          `    probe.liveEntries = first.liveEntries.map((entry) => entry.id);`,
          `    const off = ui.runtime.subscribe(function () { probe.notified = true });`,
          `    probe.unsubscribeType = typeof off;`,
          `    off();`,
          `    ui.runtime.invoke('interrupt', []).then(`,
          `      function () { probe.runtimeThrow = '放行' },`,
          `      function (cause) { probe.runtimeThrow = '拒：' + String(cause && cause.message) },`,
          `    );`,
          `    ui.runtime.invoke('interrupt', [1]).then(`,
          `      function () { probe.badArgs = '放行' },`,
          `      function (cause) { probe.badArgs = '拒：' + String(cause && cause.message) },`,
          `    );`,
          `    ui.runtime.invoke('runCommand', []).then(`,
          `      function () { probe.excluded = '放行' },`,
          `      function (cause) { probe.excluded = '拒：' + String(cause && cause.message) },`,
          `    );`,
          `  } };`,
          `};`,
          '',
        ].join('\n'),
      },
    ])
    const fake = fakeRuntime()
    const result = load(tree, { runtime: fake })
    await vi.waitFor(() => {
      expect(probe['runtimeThrow']).toBeDefined()
      expect(probe['badArgs']).toBeDefined()
      expect(probe['excluded']).toBeDefined()
    })
    expect(result.reports[0]?.ok).toBe(true)
    expect(probe['seqs']).toEqual([1, 2])
    expect(probe['sessionId']).toBe('sid-1')
    expect(probe['entries']).toEqual([3])
    expect(probe['liveEntries']).toEqual([-2])
    expect(probe['unsubscribeType']).toBe('function')
    // 订阅已经退掉：假 runtime 的监听集合为空。
    expect(fake.listeners.size).toBe(0)
    expect(String(probe['runtimeThrow'])).toBe('拒：中断炸了')
    expect(String(probe['badArgs'])).toContain('拒：')
    expect(String(probe['excluded'])).toContain('拒：')
    expect(String(probe['excluded'])).toContain('界面通道')
    result.disposeAll()
    delete (globalThis as Record<string, unknown>)['__W14_RUNTIME__']
  })

  test('订阅转发：宿主侧通知能到插件，退订后不再到', () => {
    const sink: string[] = []
    ;(globalThis as unknown as { __W14_SUB__: string[] })['__W14_SUB__'] = sink
    const tree = writeTree('subscribe', [
      {
        id: 'subber',
        code: [
          `(globalThis.__DSC_UI_FACTORIES__ ??= {})['subber'] = function (require, module, exports) {`,
          `  module.exports = { apply(ui) {`,
          `    ui.runtime.subscribe(function () { globalThis.__W14_SUB__.push('hit') });`,
          `  } };`,
          `};`,
          '',
        ].join('\n'),
      },
    ])
    const fake = fakeRuntime()
    const result = load(tree, { runtime: fake })
    expect(result.reports[0]?.ok).toBe(true)
    expect(fake.listeners.size).toBe(1)
    for (const listener of [...fake.listeners]) listener()
    expect(sink).toEqual(['hit'])
    result.disposeAll()
    delete (globalThis as Record<string, unknown>)['__W14_SUB__']
  })
})
