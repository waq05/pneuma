/**
 * 阶段 6 探针：TUI 同进程载体——终端壳装 `platform: 'tui'` 的界面插件。
 *
 * 验收口径（对齐 ui-plugin-parity-plan §3 阶段 6）：
 *   1. TUI 里至少一个槽位由插件贡献：真 echo bundle 装进注册表，ink 帧里出现它的话。
 *   2. **同一份插件源码**在 web 与 tui 两种载体下各跑一次：清单里 echo 两条
 *      （platform web / tui）指向同一个 client.js——web 侧由 ui-plugin-test 钉住，
 *      这里钉的是「装载的就是那个文件」。
 *   3. 装载语义与浏览器壳一致：失败报告不静默、白名单外 require 被拒、
 *      顺序依赖（先注册后声明）靠重试一轮自愈。
 *
 * 运行：pnpm build && pnpm -C ui-shell build && node scripts/ui-tui-plugin-test.mjs
 *
 * @module dsc/scripts/ui-tui-plugin-test
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ── 前置：真清单里 echo 是「同一份 bundle、两个载体」──────────────────────────
const manifest = JSON.parse(readFileSync('lib/ui/plugins/manifest.json', 'utf8'))
const echoRows = manifest.plugins.filter((p) => p.id === 'echo')
check('清单里 echo 有 web 与 tui 两行', echoRows.length === 2 && new Set(echoRows.map((r) => r.platform)).size === 2)
check('两行指向同一个 client.js（同一份插件源码）', new Set(echoRows.map((r) => r.file)).size === 1, JSON.stringify(echoRows.map((r) => r.file)))
const echoBundle = join('lib', 'ui', 'plugins', 'echo', echoRows[0]?.file ?? 'client.js')

// ── 隔离插件目录：真 echo bundle + 两个坏样本 ─────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'dsc-ui-tui-plugins-'))
const pluginsDir = join(work, 'plugins')
mkdirSync(join(pluginsDir, 'echo'), { recursive: true })
mkdirSync(join(pluginsDir, 'noapply'), { recursive: true })
mkdirSync(join(pluginsDir, 'badimport'), { recursive: true })
cpSync(echoBundle, join(pluginsDir, 'echo', 'client.js'))
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
    plugins: [
      { id: 'echo', file: 'client.js', platform: 'tui' },
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

// ── 用例一：真 echo 装进终端壳，帧里看得见 ────────────────────────────────────
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
  const echo = load.reports.find((r) => r.id === 'echo')
  check('echo 装载成功', echo?.ok === true, JSON.stringify(echo))
  const normalized = echoBundle.replaceAll('\\', '/')
  check(
    '装载的就是 web 侧同一个 client.js',
    normalized === 'lib/ui/plugins/echo/client.js',
    normalized,
  )
  const noapply = load.reports.find((r) => r.id === 'noapply')
  check('没有导出 apply 的插件被点名拒绝', noapply?.ok === false && (noapply.error ?? '').includes('apply'), JSON.stringify(noapply))
  const badimport = load.reports.find((r) => r.id === 'badimport')
  check('白名单外的 require 被拒并说明允许表', badimport?.ok === false && (badimport.error ?? '').includes('白名单外'), JSON.stringify(badimport))

  const frame = await renderFrame(registry, TUI_SLOTS.noticeExtensions)
  check('帧里出现插件贡献的那一行', frame.text.includes('界面插件 echo 已接入终端壳（同一份 bundle）'))
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
