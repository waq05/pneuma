/**
 * 真包验收（**手动跑**，要联网）：把真的 `dsh-cost-meter` 装进隔离 profile，起真宿主 +
 * 假端点跑一轮带工具的对话，然后回答三个问题：
 *
 *   1. 包挂得上吗（插件中心那一行、有没有 problem）；
 *   2. 账本落得下吗（`~/.dsc/storages/cost-meter/ledger.json`）；
 *   3. 成本条有数吗（`ledger.days` 有没有这一轮）。
 *
 * 为什么**不**进 `check:dsh`：它要 `numa plugin add` 走 npm、要 pnpm，跑一次十几秒到一分钟；
 * 默认门禁不该依赖网络。改会话桥 / 事件流之后手动跑它，看第 3 问翻了没有。
 *
 * 现状（2026-10-26）：1、2 过，3 不过——它记实时花费走 dsh 事件流
 * （`ctx.on('llm/stream')` / `ctx.on('session/event')`），我们还不发这两类事件。
 * 细节见 docs/dsh-service-bridge-plan.md 第 7 节。
 *
 * 用法：cd D:\dsc && pnpm run build && node scripts/dsh-real-package-e2e.mjs
 * 环境变量：DSC_REAL_PKG_HOME=<已有 HOME>（复用装好的包，省一次安装）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { console.log('  PASS ' + name); return }
  failures.push(name)
  console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((ok) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => ok(port)) }) })

const home = process.env['DSC_REAL_PKG_HOME'] ?? mkdtempSync(join(tmpdir(), 'dsc-real-pkg-'))
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
process.env['HOME'] = home
process.env['USERPROFILE'] = home
process.env['DSC_HOME'] = dsc

if (process.env['DSC_REAL_PKG_HOME'] === undefined) {
  console.log('[dsh-real-pkg] 装 dsh-cost-meter 到隔离 profile（要联网）')
  writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  const added = spawn(process.execPath, [join(root, 'bin', 'dsc.js'), 'plugin', 'add', 'dsh-cost-meter', '--profile', 'demo'], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let addOut = ''
  added.stdout.on('data', (chunk) => (addOut += chunk))
  added.stderr.on('data', (chunk) => (addOut += chunk))
  const code = await new Promise((done) => added.on('close', done))
  check('包装上了（numa plugin add）', code === 0 && existsSync(join(dsc, 'profiles', 'demo', 'node_modules', 'dsh-cost-meter')), addOut.slice(-300))
  if (code !== 0) process.exit(1)
}

const llmPort = await freePort()
const port = await freePort()
writeFileSync(
  join(dsc, 'config.yaml'),
  [
    'default:', '  provider: fake', '  model: fake-chat', 'providers:', '  fake:',
    '    displayName: 自检假端点', '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-chat', '        name: Fake Chat',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
  'utf8',
)

const registry = await import(pathToFileURL(join(root, 'lib', 'core', 'plugin-registry.js')).href)
registry.writePluginEnabled('dsh-compat', true)

const llm = spawn(process.execPath, [join(root, 'scripts', '_fake-llm.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    DSC_FAKE_LLM_PORT: String(llmPort),
    DSC_FAKE_LLM_DELAY: '0',
    DSC_FAKE_LLM_TOOL: JSON.stringify({ name: 'read', arguments: { path: join(root, 'README.md') } }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await sleep(500)

const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSC_HOME: dsc,
    DSC_FAKE_KEY: 'k',
    DSC_PROFILE: 'demo',
    DSC_UI_SERVER: '1',
    DSC_UI_PORT: String(port),
    DSC_UI_HMR: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let url = null
host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(String(chunk))
  if (found !== null) url = found[0]
})
for (let waited = 0; waited < 240 && url === null; waited += 1) await sleep(250)
check('宿主起来了', url !== null)
if (url === null) { host.kill(); llm.kill(); process.exit(1) }

// 换票拿 cookie，然后走页面同款的数据通道
const res = await fetch(url, { redirect: 'manual' })
const cookie = (res.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
const invoke = async (method, args) => {
  const response = await fetch(new URL(url).origin + '/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method, args }),
  })
  return response.json()
}
const valueOf = (payload) => (payload?.result?.ok === true ? payload.result.value : payload?.value)

const plugins = valueOf(await invoke('listPlugins', []))
const row = Array.isArray(plugins) ? plugins.find((item) => String(item.name ?? '').includes('cost-meter') || String(item.file ?? '').includes('cost-meter')) : undefined
check('组合包里的 cost-meter 挂上了', row !== undefined && row.enabled !== false, JSON.stringify(row ?? null))
check('挂载没有报问题', (row?.problem ?? '') === '', String(row?.problem ?? ''))

await invoke('submit', ['读一下 README，然后告诉我成本条有没有数。', null])
for (let waited = 0; waited < 60; waited += 1) {
  await sleep(500)
  const snapshot = valueOf(await invoke('getSnapshot', []))
  if (snapshot?.turnState === 'idle' && waited > 2) break
}
await sleep(1500)

const ledgerFile = join(dsc, 'storages', 'cost-meter', 'ledger.json')
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
check('账本落在 ~/.dsc/storages/cost-meter', ledger !== null, ledgerFile)
const days = ledger?.days === null || typeof ledger?.days !== 'object' ? {} : ledger.days
// 第 3 问现在是**已知未通**：默认只当读数打印（打印出来的就是现状），
// 设 DSC_REAL_PKG_EXPECT_COSTS=1 才当断言——等事件流那条做完了，用它来钉「翻了」。
if (process.env['DSC_REAL_PKG_EXPECT_COSTS'] === '1') {
  check('账本里有这一轮的花费', Object.keys(days).length > 0, JSON.stringify(Object.keys(days)))
} else {
  console.log('  ..    账本里的花费日期：' + (Object.keys(days).length === 0 ? '（空，已知未通）' : JSON.stringify(Object.keys(days))))
}

host.kill()
llm.kill()
console.log('')
if (Object.keys(days).length === 0) {
  console.log('  说明：实时花费走 dsh 事件流（ctx.on("llm/stream") / ctx.on("session/event")），')
  console.log('  只做会话历史读取不会让这一条变绿。见 docs/dsh-service-bridge-plan.md 第 7 节。')
}
console.log(failures.length === 0 ? '全部通过' : failures.length + ' 条失败：' + failures.join('、'))
process.exit(failures.length === 0 ? 0 : 1)
