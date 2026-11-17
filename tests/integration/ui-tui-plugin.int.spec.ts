/**
 * TUI 同进程载体：终端壳装 `platform: 'tui'` 的界面插件（迁自 `scripts/ui-tui-plugin-test.mjs`）。
 *
 * ## 被测的是什么（对齐 ui-plugin-parity-plan §3 阶段 6 的验收口径）
 *
 * 1. TUI 里至少一个槽位由插件贡献：样本 bundle 装进注册表，ink 帧里出现它的话。
 * 2. **同一份插件源码**在 web 与 tui 两种载体下各跑一次：自造清单里 sample 两条
 *    （platform web / tui）指向同一个 client.js（演示插件已按拍板移除，样本自造）。
 * 3. 装载语义与浏览器壳一致：失败报告不静默、白名单外 require 被拒、顺序依赖
 *    （先注册后声明）靠重试一轮自愈；组合包界面半按 `pneuma.client.platforms` 进终端壳，
 *    被停用的依赖单列一档。
 * 4. invoke 与 web 通道同一张面：排除清单的方法拒、实参不合规格拒、合规的通。
 * 5. 平台种子与 external：cordis / zod 两载体共用；`external` 指向本图另一条插件时按
 *    「已装好的导出」解析；声明了终端给不了的模块（react-virtual 要 DOM）装载前就拒。
 *
 * ## ink 渲染（真帧，不走 jsdom）
 *
 * `renderFrame` 用 PassThrough 假 stdin/stdout 起 `@pneuma/tui/app/App`（ink 的 node
 * 渲染路径），把注册表渲染进通知区扩展槽。帧的等待是探针同款固定 500ms 一拍——
 * ink 的帧是异步 reconcile，负向断言（「不该出现的行」）只能靠等满一拍。
 *
 * ## 落位与隔离
 *
 * 夹具 bundle 落临时目录；`DSC_HOME` 已由 setup 换成临时目录（用例三往里写 profiles 与
 * plugins.json），`DSC_PROFILE` 用完还原。不起内核、不开 HTTP 端口。
 *
 * @module dsc/tests/integration/ui-tui-plugin
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SlotRegistry } from '@pneuma/ui-core/slots.js'
import { loadTuiPlugins } from '@pneuma/ui-core/tui-plugins.js'
import { TUI_SLOTS } from '@pneuma/ui-core/tui-plugin-api.js'
import { SlotOutlet } from '@pneuma/ui-core/slots-ink.js'
import { App } from '@pneuma/tui/app/App.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-tui-'))

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

/** 探针往 globalThis 落的 invoke 契约读数（bundle 在宿主进程里执行）。 */
interface ProbeGlobals {
  __PROBE_INVOKE_EXCLUDED?: string
  __PROBE_INVOKE_BADARGS?: string
  __PROBE_INVOKE_OK?: string
  __PROBE_PROVIDED?: unknown
  __PROBE_CONSUMED?: unknown
  __PROBE_BETA_APPLIED?: boolean
  __PROBE_SEED?: string
  __PROBE_PROVIDER?: string
}
const probeGlobals = globalThis as unknown as ProbeGlobals

// ── 自造样本：一份双载体清单（web + tui 两行同一个文件）+ 两个坏样本 ─────────────
// 演示插件（hello/echo/runtime）已按拍板移除（阶段 8），样本不再借内置产物：
// 双载体语义由这份自造清单钉住，与内置清单的内容解耦。
const SAMPLE_BUNDLE = [
  `(globalThis.__DSC_UI_FACTORIES__ ??= {})['sample'] = function (require, module, exports) {`,
  `  const React = require('react');`,
  `  const { defineUiPlugin, TUI_SLOTS, Text } = require('@dsc/ui');`,
  `  module.exports = defineUiPlugin({`,
  `    name: '探针样本',`,
  `    apply(ui) {`,
  `      if (ui.host.platform === 'tui') {`,
  `        ui.slots.injectSlot(TUI_SLOTS.noticeExtensions, () =>`,
  `          ui.slots.register(TUI_SLOTS.noticeExtensions, { id: 'sample.line', order: 1 }, function () {`,
  `            return React.createElement(Text, null, '探针样本已接入终端壳');`,
  `          }),`,
  `        );`,
  `        // invoke 契约探针：两个载体同一张面（webserver.ts 的 invoke 同款顺序）——`,
  `        // 白名单外拒、实参不合规格拒、白名单内且合规的通。结果落全局，宿主侧断言取用。`,
  `        ui.runtime.invoke('runCommand', ['/anything']).then(`,
  `          function () { globalThis.__PROBE_INVOKE_EXCLUDED = '放行'; },`,
  `          function (cause) { globalThis.__PROBE_INVOKE_EXCLUDED = '拒：' + String(cause && cause.message); },`,
  `        );`,
  `        ui.runtime.invoke('submit', [12345]).then(`,
  `          function () { globalThis.__PROBE_INVOKE_BADARGS = '放行'; },`,
  `          function (cause) { globalThis.__PROBE_INVOKE_BADARGS = '拒：' + String(cause && cause.message); },`,
  `        );`,
  `        ui.runtime.invoke('listModels', []).then(`,
  `          function (value) { globalThis.__PROBE_INVOKE_OK = '通：' + JSON.stringify(value); },`,
  `          function (cause) { globalThis.__PROBE_INVOKE_OK = '拒：' + String(cause && cause.message); },`,
  `        );`,
  `      }`,
  `    },`,
  `  });`,
  `};`,
  ``,
].join('\n')

/** 双载体清单 + 两个坏样本（没有 apply / 白名单外 require）。 */
function writeSampleTree(): string {
  const pluginsDir = join(WORK, 'plugins')
  mkdirSync(join(pluginsDir, 'sample'), { recursive: true })
  mkdirSync(join(pluginsDir, 'noapply'), { recursive: true })
  mkdirSync(join(pluginsDir, 'badimport'), { recursive: true })
  writeFileSync(join(pluginsDir, 'sample', 'client.js'), SAMPLE_BUNDLE, 'utf8')
  writeFileSync(
    join(pluginsDir, 'noapply', 'client.js'),
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})['noapply'] = function (require, module, exports) {\nmodule.exports = { name: '没有 apply 的插件' };\n};\n`,
    'utf8',
  )
  writeFileSync(
    join(pluginsDir, 'badimport', 'client.js'),
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})['badimport'] = function (require, module, exports) {\nrequire('node:fs');\nmodule.exports = { apply() {} };\n};\n`,
    'utf8',
  )
  writeFileSync(
    join(pluginsDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      apiVersion: '1.0.0',
      plugins: [
        { id: 'sample', file: 'client.js', platform: 'web' },
        { id: 'sample', file: 'client.js', platform: 'tui' },
        { id: 'noapply', file: 'client.js', platform: 'tui' },
        { id: 'badimport', file: 'client.js', platform: 'tui' },
      ],
    }),
    'utf8',
  )
  return pluginsDir
}

// ── 顺序依赖样本：先给一个「还没被声明」的槽**注册**（当场抛装配错），等声明者出现后重试自愈。
//    注意 injectSlot 本来就是「等槽出现」的语义、不抛错；这里要钉的是裸 register 的那条路。
function writeLateTree(): string {
  const lateDir = join(WORK, 'late')
  mkdirSync(join(lateDir, 'early'), { recursive: true })
  mkdirSync(join(lateDir, 'late'), { recursive: true })
  writeFileSync(
    join(lateDir, 'early', 'client.js'),
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})['early'] = function (require, module, exports) {
module.exports = { apply(ui) { ui.slots.register('late.slot', { id: 'early.row', order: 1 }, () => null) } };
};
`,
    'utf8',
  )
  writeFileSync(
    join(lateDir, 'late', 'client.js'),
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})['late'] = function (require, module, exports) {
module.exports = { apply(ui) { ui.slots.declare('late.slot', 'list') } };
};
`,
    'utf8',
  )
  writeFileSync(
    join(lateDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      apiVersion: '2.0.0',
      plugins: [
        { id: 'early', file: 'client.js', platform: 'tui' },
        { id: 'late', file: 'client.js', platform: 'tui' },
      ],
    }),
    'utf8',
  )
  return lateDir
}

// ── external 样本：种子 / 本图插件 / 终端给不了的 DOM 模块 ──────────────────────
function writeExtTree(): string {
  const extDir = join(WORK, 'ext')
  mkdirSync(join(extDir, 'seed'), { recursive: true })
  mkdirSync(join(extDir, 'provider'), { recursive: true })
  mkdirSync(join(extDir, 'consumer'), { recursive: true })
  mkdirSync(join(extDir, 'domexternal'), { recursive: true })
  writeFileSync(
    join(extDir, 'seed', 'client.js'),
    [
      `(globalThis.__DSC_UI_FACTORIES__ ??= {})['seed'] = function (require, module, exports) {`,
      `  const zod = require('zod');`,
      `  const cordis = require('@deepseek-ai/cordis');`,
      `  module.exports = { apply() {`,
      `    globalThis.__PROBE_SEED = (typeof zod.z?.object === 'function' ? 'zod' : 'no-zod') + '/' + (typeof cordis.Context === 'function' ? 'cordis' : 'no-cordis');`,
      `  } };`,
      `};`,
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(extDir, 'provider', 'client.js'),
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})['provider'] = function (require, module, exports) {\nmodule.exports = { name: '供方', marker: 'provider-value', apply() {} };\n};\n`,
    'utf8',
  )
  writeFileSync(
    join(extDir, 'consumer', 'client.js'),
    [
      `(globalThis.__DSC_UI_FACTORIES__ ??= {})['consumer'] = function (require, module, exports) {`,
      `  const provider = require('provider');`,
      `  module.exports = { apply() { globalThis.__PROBE_PROVIDER = provider.marker } };`,
      `};`,
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(extDir, 'domexternal', 'client.js'),
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})['domexternal'] = function (require, module, exports) {\nmodule.exports = { apply() {} };\n};\n`,
    'utf8',
  )
  writeFileSync(
    join(extDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      apiVersion: '2.0.0',
      plugins: [
        { id: 'seed', file: 'client.js', platform: 'tui' },
        { id: 'provider', file: 'client.js', platform: 'tui' },
        { id: 'consumer', file: 'client.js', platform: 'tui', external: ['provider'] },
        { id: 'domexternal', file: 'client.js', platform: 'tui', external: ['@tanstack/react-virtual'] },
      ],
    }),
    'utf8',
  )
  return extDir
}

// ── mock runtime（形状照 tui-features-test 的最小集）─────────────────────────
const entries = [{ id: 1, kind: 'system', text: '探针会话' }]
const makeSnapshot = (): Record<string, unknown> => ({
  entries,
  sessions: [],
  sessionsLoading: false,
  sessionStates: {},
  status: {
    turnState: 'idle',
    model: 'test-model',
    effort: 'medium',
    usage: null,
    contextWindow: 1_000_000,
    sessionId: '/w/s.jsonl',
    cwd: '/w',
  },
  surfaces: {
    pendingApproval: null,
    pendingQuestion: null,
    pendingPlan: null,
    goal: null,
    todos: { total: 0, done: 0, active: null },
    mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
    policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
  },
})
const listeners = new Set<() => void>()
const snapshot = makeSnapshot()
const runtime = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot(): unknown {
    return snapshot
  },
  listModels: (): Array<unknown> => [],
  dock: (): Promise<unknown> => Promise.resolve({ entries: [] }),
  submit(): void {},
  openSession(): void {},
  refreshSessions: (): Promise<void> => Promise.resolve(),
  listArchivedSessions: (): Promise<unknown> => Promise.resolve({ items: [] }),
  archiveSessions: (): Promise<unknown> => Promise.resolve({ ok: true }),
  restoreSessions: (): Promise<unknown> => Promise.resolve({ ok: true }),
  setModel(): void {},
  interrupt(): void {},
  exit(): void {},
}

/** 起一个 App，把注册表渲染进通知区扩展槽；返回「等一拍后读帧」的口。 */
async function renderFrame(registry: SlotRegistry, slot: string, waitMs = 500): Promise<{ text: string; unmount: () => void }> {
  // 假终端的形状照 `src/packages/tui/app/composer.spec.ts` 的既有模式：PassThrough 打上
  // ink 需要的终端属性，render 入参收窄成 NodeJS.ReadStream / WriteStream。
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = 110
  stdout.rows = 40
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
  })
  const extras = React.createElement(SlotOutlet as React.ComponentType<{ slots: SlotRegistry; slot: string }>, {
    slots: registry,
    slot,
  })
  const instance = render(React.createElement(App as React.ComponentType<{ runtime: unknown; tuiNoticeExtras?: React.ReactNode }>, { runtime, tuiNoticeExtras: extras }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(waitMs)
  return { text: output, unmount: (): void => instance.unmount() }
}

// ── 用例一：自造样本装进终端壳，帧里看得见 ────────────────────────────────────
describe('自造样本装进终端壳（双载体清单 + invoke 契约 + ink 帧）', () => {
  const facts: Record<string, unknown> = {}
  let frame: { text: string; unmount: () => void } | null = null

  beforeAll(async () => {
    const pluginsDir = writeSampleTree()
    const registry = new SlotRegistry()
    registry.declare(TUI_SLOTS.noticeExtensions, 'list')
    const reports: Array<{ id: string; ok?: boolean; error?: string; attempts?: number }> = []
    const load = loadTuiPlugins({
      registry: registry as never,
      runtime: runtime as never,
      host: { name: 'Pneuma', version: '0.0.0-spec', platform: 'tui' },
      pluginsDir,
      onReport: (report) => reports.push(report),
    })
    const sampleReports = reports.filter((report) => report.id === 'sample')
    const noapply = reports.find((report) => report.id === 'noapply')
    const badimport = reports.find((report) => report.id === 'badimport')
    await sleep(50)
    facts['sampleOk'] = sampleReports[0]?.ok === true
    facts['sampleOnce'] = sampleReports.length
    facts['noapplyDenied'] = noapply?.ok === false && (noapply.error ?? '').includes('apply')
    facts['badimportDenied'] = badimport?.ok === false && (badimport.error ?? '').includes('白名单外')
    facts['invokeExcluded'] = String(probeGlobals.__PROBE_INVOKE_EXCLUDED ?? '')
    facts['invokeBadArgs'] = String(probeGlobals.__PROBE_INVOKE_BADARGS ?? '')
    facts['invokeOk'] = String(probeGlobals.__PROBE_INVOKE_OK ?? '')

    frame = await renderFrame(registry, TUI_SLOTS.noticeExtensions)
    load.disposeAll()
  })

  afterAll(() => {
    frame?.unmount()
    delete probeGlobals.__PROBE_INVOKE_EXCLUDED
    delete probeGlobals.__PROBE_INVOKE_BADARGS
    delete probeGlobals.__PROBE_INVOKE_OK
  })

  test('样本装载成功', () => {
    expect(facts['sampleOk']).toBe(true)
  })
  test('双载体清单里只装载 tui 行（web 行留给浏览器壳）', () => {
    expect(facts['sampleOnce']).toBe(1)
  })
  test('没有导出 apply 的插件被点名拒绝', () => {
    expect(facts['noapplyDenied']).toBe(true)
  })
  test('白名单外的 require 被拒并说明允许表', () => {
    expect(facts['badimportDenied']).toBe(true)
  })
  test('排除清单里的方法（runCommand）invoke 被拒', () => {
    expect(String(facts['invokeExcluded'])).toMatch(/^拒：/)
    expect(String(facts['invokeExcluded'])).toContain('界面通道')
  })
  test('白名单内但实参不合规格（submit 吃字符串）被拒', () => {
    expect(String(facts['invokeBadArgs'])).toMatch(/^拒：/)
  })
  test('白名单内且实参合规的方法照常通', () => {
    expect(String(facts['invokeOk'])).toMatch(/^通：/)
  })
  test('帧里出现插件贡献的那一行', () => {
    expect(frame?.text.includes('探针样本已接入终端壳')).toBe(true)
  })
})

// ── 用例二：顺序依赖靠重试一轮自愈（early 先给未声明的槽注册，late 后来声明）───
describe('顺序依赖靠重试一轮自愈', () => {
  const facts: Record<string, unknown> = {}

  beforeAll(() => {
    const lateDir = writeLateTree()
    const registry = new SlotRegistry()
    const reports: Array<{ id: string; ok?: boolean; attempts?: number }> = []
    const load = loadTuiPlugins({
      registry: registry as never,
      runtime: runtime as never,
      host: { name: 'Pneuma', version: '0.0.0-spec', platform: 'tui' },
      pluginsDir: lateDir,
      onReport: (report) => reports.push(report),
    })
    const early = reports.find((report) => report.id === 'early')
    facts['earlyRetried'] = early?.ok === true && early?.attempts === 2
    const lateRow = registry.winners('late.slot')
    facts['lateRow'] = lateRow.length === 1 && lateRow[0]?.id === 'early.row'
    load.disposeAll()
  })

  test('顺序依赖的插件第二次尝试装上', () => {
    expect(facts['earlyRetried']).toBe(true)
  })
  test('声明的槽里真的有了贡献者', () => {
    expect(facts['lateRow']).toBe(true)
  })
})

// ── 用例三：组合包的界面半进终端壳（声明 platforms 才有，缺省只服务浏览器壳）──────
// 2.0 起组合包的界面半默认只给 web；要服务终端必须在 pneuma.client.platforms 里写 tui。
// 这条用例同时钉住「终端也不用去内置目录里瞎找包」——入口由包的 exports 决定。
describe('组合包的界面半进终端壳（platforms 声明 + 停用依赖）', () => {
  const facts: Record<string, unknown> = {}
  let frame: { text: string; unmount: () => void } | null = null

  beforeAll(async () => {
    const pkgDir = join(WORK, 'pkg-builtin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'manifest.json'),
      JSON.stringify({ version: 1, apiVersion: '2.0.0', plugins: [] }),
      'utf8',
    )
    const home = process.env.DSC_HOME ?? join(process.env.HOME ?? '', '.dsc')
    const profileDir = join(home, 'profiles', 'probe')
    const pkgBundle = (id: string, text: string): string =>
      [
        `(globalThis.__DSC_UI_FACTORIES__ ??= {})['${id}'] = function (require, module, exports) {`,
        `  const React = require('react');`,
        `  const { defineUiPlugin, TUI_SLOTS, Text } = require('@dsc/ui');`,
        `  module.exports = defineUiPlugin({`,
        `    name: '${id}',`,
        `    apply(ui) {`,
        `      ui.slots.register(TUI_SLOTS.noticeExtensions, { id: '${id}.line' }, function () {`,
        `        return React.createElement(Text, null, '${text}');`,
        `      });`,
        `    },`,
        `  });`,
        `};`,
        '',
      ].join('\n')
    const writePkg = (name: string, client: Record<string, unknown>, bundleText: string): void => {
      const dir = join(profileDir, 'node_modules', name)
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          exports: { './client': { default: './lib/client.js' } },
          dsh: { client },
        }),
        'utf8',
      )
      writeFileSync(join(dir, 'lib', 'client.js'), pkgBundle(name, bundleText), 'utf8')
    }
    writePkg('pkg-both', { platform: 'pneuma', api: '^2.0.0', platforms: ['web', 'tui'] }, '组合包的界面半也在终端壳里')
    writePkg('pkg-web-only', { platform: 'pneuma', api: '^2.0.0' }, '这一份不该出现在终端壳里')
    // 被停用的依赖：报告要说「被停用了」，不能说「不在清单里」（后者会把人指去重装）。
    writePkg('pkg-off', { platform: 'pneuma', api: '^2.0.0', platforms: ['web', 'tui'] }, '被停用的那份')
    writePkg('pkg-needs-off', { platform: 'pneuma', api: '^2.0.0', platforms: ['web', 'tui'], inject: ['pkg-off'] }, '依赖被停用')
    writeFileSync(
      join(home, 'plugins.json'),
      JSON.stringify({ version: 1, entries: [{ file: 'pkg-off/client', disabled: true, config: {} }] }),
      'utf8',
    )

    const earlierProfile = process.env.DSC_PROFILE
    process.env.DSC_PROFILE = 'probe'
    try {
      const registry = new SlotRegistry()
      registry.declare(TUI_SLOTS.noticeExtensions, 'list')
      const reports: Array<{ id: string; ok?: boolean; error?: string }> = []
      const load = loadTuiPlugins({
        registry: registry as never,
        runtime: runtime as never,
        host: { name: 'Pneuma', version: '0.0.0-spec', platform: 'tui' },
        pluginsDir: pkgDir,
        onReport: (report) => reports.push(report),
      })
      const both = reports.find((report) => report.id === 'pkg-both')
      const needsOff = reports.find((report) => report.id === 'pkg-needs-off')
      facts['bothOk'] = both?.ok === true
      facts['webOnlyAbsent'] = !reports.some((report) => report.id === 'pkg-web-only')
      facts['offReport'] = needsOff?.ok === false && String(needsOff.error).includes('pkg-off 被停用了') && !String(needsOff.error).includes('不在清单里')
      facts['offAbsent'] = !reports.some((report) => report.id === 'pkg-off')
      frame = await renderFrame(registry, TUI_SLOTS.noticeExtensions)
      load.disposeAll()
    } finally {
      if (earlierProfile === undefined) delete process.env.DSC_PROFILE
      else process.env.DSC_PROFILE = earlierProfile
    }
  })

  afterAll(() => {
    frame?.unmount()
  })

  test('声明了 platforms: [web, tui] 的包界面半装进终端壳', () => {
    expect(facts['bothOk']).toBe(true)
  })
  test('没声明 platforms 的包界面半不进终端壳（缺省只服务 web）', () => {
    expect(facts['webOnlyAbsent']).toBe(true)
  })
  test('依赖被停用时报告说「被停用了」，不是「不在清单里」', () => {
    expect(facts['offReport']).toBe(true)
  })
  test('被停用的那份本身不进装载报告（它不在启动图里）', () => {
    expect(facts['offAbsent']).toBe(true)
  })
  test('帧里出现组合包界面半贡献的那一行', () => {
    expect(frame?.text.includes('组合包的界面半也在终端壳里')).toBe(true)
  })
})

// ── 用例四：平台种子与 external（与浏览器壳同一套声明，终端壳给不了的要说清）──────
describe('平台种子与 external（终端壳口径）', () => {
  const facts: Record<string, unknown> = {}

  beforeAll(() => {
    const extDir = writeExtTree()
    const registry = new SlotRegistry()
    const load = loadTuiPlugins({
      registry: registry as never,
      runtime: runtime as never,
      host: { name: 'Pneuma', version: '0.0.0-spec', platform: 'tui' },
      pluginsDir: extDir,
    })
    facts['seed'] = probeGlobals.__PROBE_SEED
    facts['consumerOk'] = load.reports.find((report) => report.id === 'consumer')?.ok === true
    facts['provider'] = probeGlobals.__PROBE_PROVIDER
    const domexternal = load.reports.find((report) => report.id === 'domexternal')
    facts['domRejected'] =
      domexternal?.ok === false && String(domexternal.error).includes('终端壳给不了') && String(domexternal.error).includes('cordis')
    load.disposeAll()
    delete probeGlobals.__PROBE_SEED
    delete probeGlobals.__PROBE_PROVIDER
  })

  test('种子 cordis / zod 在终端壳里都拿得到', () => {
    expect(facts['seed'], String(facts['seed'])).toBe('zod/cordis')
  })
  test('external 指向本图另一条插件时能取到它的导出', () => {
    expect(facts['consumerOk']).toBe(true)
    expect(facts['provider'], String(facts['provider'])).toBe('provider-value')
  })
  test('声明了终端给不了的模块时装载前就拒，并列出可用的', () => {
    expect(facts['domRejected']).toBe(true)
  })
})
