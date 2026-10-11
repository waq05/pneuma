/**
 * 阶段 6 探针：TUI 同进程载体——终端壳装 `platform: 'tui'` 的界面插件。
 *
 * 验收口径（对齐 ui-plugin-parity-plan §3 阶段 6）：
 *   1. TUI 里至少一个槽位由插件贡献：样本 bundle 装进注册表，ink 帧里出现它的话。
 *   2. **同一份插件源码**在 web 与 tui 两种载体下各跑一次：自造清单里 sample 两条
 *      （platform web / tui）指向同一个 client.js（演示插件已按拍板移除，样本自造）。
 *   3. 装载语义与浏览器壳一致：失败报告不静默、白名单外 require 被拒、
 *      顺序依赖（先注册后声明）靠重试一轮自愈。
 *   4. invoke 与 web 通道同一张面：排除清单的方法拒、实参不合规格拒、合规的通。
 *
 * 运行：pnpm build && pnpm -C ui-shell build && node scripts/ui-tui-plugin-test.mjs
 *
 * @module dsc/scripts/ui-tui-plugin-test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-ui-tui-'))
const { SlotRegistry } = await import('../lib/ui/slots.js')
const { loadTuiPlugins } = await import('../lib/ui/tui-plugins.js')
const { TUI_SLOTS } = await import('../lib/ui/tui-plugin-api.js')
const { SlotOutlet } = await import('../lib/ui/slots-ink.js')
const { App } = await import('../lib/app/App.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const work = mkdtempSync(join(tmpdir(), 'dsc-ui-tui-plugins-'))
const pluginsDir = join(work, 'plugins')
mkdirSync(join(pluginsDir, 'sample'), { recursive: true })
mkdirSync(join(pluginsDir, 'noapply'), { recursive: true })
mkdirSync(join(pluginsDir, 'badimport'), { recursive: true })
writeFileSync(join(pluginsDir, 'sample', 'client.js'), SAMPLE_BUNDLE, 'utf8')
// 坏样本一：bundle 形状对，但没有导出 apply。
writeFileSync(
  join(pluginsDir, 'noapply', 'client.js'),
  `(globalThis.__DSC_UI_FACTORIES__ ??= {})['noapply'] = function (require, module, exports) {\nmodule.exports = { name: '没有 apply 的插件' };\n};\n`,
  'utf8',
)
// 坏样本二：白名单外的 require（node 内置模块也不给）。
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

// ── 顺序依赖样本：先给一个「还没被声明」的槽**注册**（当场抛装配错），等声明者出现后重试自愈。
//    注意 injectSlot 本来就是「等槽出现」的语义、不抛错；这里要钉的是裸 register 的那条路。
const lateDir = join(work, 'late')
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
    plugins: [
      { id: 'early', file: 'client.js', platform: 'tui' },
      { id: 'late', file: 'client.js', platform: 'tui' },
    ],
  }),
  'utf8',
)

// ── mock runtime（形状照 tui-features-test 的最小集）─────────────────────────
const entries = [{ id: 1, kind: 'system', text: '探针会话' }]
const makeSnapshot = () => ({
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
const listeners = new Set()
const snapshot = makeSnapshot()
const runtime = {
  subscribe(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot() {
    return snapshot
  },
  listModels: () => [],
  dock: () => Promise.resolve({ entries: [] }),
  submit() {},
  openSession() {},
  refreshSessions: () => Promise.resolve(),
  listArchivedSessions: () => Promise.resolve({ items: [] }),
  archiveSessions: () => Promise.resolve({ ok: true }),
  restoreSessions: () => Promise.resolve({ ok: true }),
  setModel() {},
  interrupt() {},
  exit() {},
}

/** 起一个 App，把注册表渲染进通知区扩展槽；返回「等一拍后读帧」的口。 */
async function renderFrame(registry, slot) {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough()
  stdout.columns = 110
  stdout.rows = 40
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const extras = React.createElement(SlotOutlet, { slots: registry, slot })
  const instance = render(React.createElement(App, { runtime, tuiNoticeExtras: extras }), {
    stdin,
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(500)
  return { text: output, unmount: () => instance.unmount() }
}

// ── 用例一：自造样本装进终端壳，帧里看得见 ────────────────────────────────────
{
  const registry = new SlotRegistry()
  registry.declare(TUI_SLOTS.noticeExtensions, 'list')
  const reports = []
  const load = loadTuiPlugins({
    registry,
    runtime,
    host: { name: 'Muse Code', version: '0.0.0-probe', platform: 'tui' },
    pluginsDir,
    onReport: (report) => reports.push(report),
  })
  const sample = load.reports.find((r) => r.id === 'sample')
  check('样本装载成功', sample?.ok === true, JSON.stringify(sample))
  check('双载体清单里只装载 tui 行（web 行留给浏览器壳）', load.reports.filter((r) => r.id === 'sample').length === 1)
  const noapply = load.reports.find((r) => r.id === 'noapply')
  check('没有导出 apply 的插件被点名拒绝', noapply?.ok === false && (noapply.error ?? '').includes('apply'), JSON.stringify(noapply))
  const badimport = load.reports.find((r) => r.id === 'badimport')
  check('白名单外的 require 被拒并说明允许表', badimport?.ok === false && (badimport.error ?? '').includes('白名单外'), JSON.stringify(badimport))

  // invoke 契约：与 web 通道同一张面（ui-methods 白名单 + validateUiArgs 实参校验）。
  await sleep(50)
  check(
    '排除清单里的方法（runCommand）invoke 被拒',
    String(globalThis.__PROBE_INVOKE_EXCLUDED).startsWith('拒：') && String(globalThis.__PROBE_INVOKE_EXCLUDED).includes('界面通道'),
    String(globalThis.__PROBE_INVOKE_EXCLUDED),
  )
  check(
    '白名单内但实参不合规格（submit 吃字符串）被拒',
    String(globalThis.__PROBE_INVOKE_BADARGS).startsWith('拒：'),
    String(globalThis.__PROBE_INVOKE_BADARGS),
  )
  check(
    '白名单内且实参合规的方法照常通',
    String(globalThis.__PROBE_INVOKE_OK).startsWith('通：'),
    String(globalThis.__PROBE_INVOKE_OK),
  )

  const frame = await renderFrame(registry, TUI_SLOTS.noticeExtensions)
  check('帧里出现插件贡献的那一行', frame.text.includes('探针样本已接入终端壳'))
  frame.unmount()
  load.disposeAll()
}

// ── 用例二：顺序依赖靠重试一轮自愈（early 先给未声明的槽注册，late 后来声明）───
{
  const registry = new SlotRegistry()
  const reports = []
  const load = loadTuiPlugins({
    registry,
    runtime,
    host: { name: 'Muse Code', version: '0.0.0-probe', platform: 'tui' },
    pluginsDir: lateDir,
    onReport: (report) => reports.push(report),
  })
  const early = load.reports.find((r) => r.id === 'early')
  check('顺序依赖的插件第二次尝试装上', early?.ok === true && early?.attempts === 2, JSON.stringify(early))
  const lateRow = registry.winners('late.slot')
  check('声明的槽里真的有了贡献者', lateRow.length === 1 && lateRow[0]?.id === 'early.row')
  load.disposeAll()
}

rmSync(work, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
