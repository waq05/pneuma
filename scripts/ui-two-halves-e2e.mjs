// 一个包两半的**真机**走查：把 examples/plugin-two-halves 装进 profile，
// 起真宿主 + 真 Chromium，断言界面半那段真的画到了状态栏上。
// 跑法：cd D:\dsc && pnpm run build && node scripts/ui-two-halves-e2e.mjs
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-cordis-main.cjs')
const STATUS_BUNDLE = join(root, 'lib', 'ui', 'plugins', 'statusbar', 'client.js')
const SHOT = join(root, 'desktop', 'shots', 'two-halves.png')
const RESULT = join(root, 'desktop', 'shots', 'two-halves.json')
const ID = 'dsc-demo-two-halves'

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { console.log('  PASS ' + name); return }
  failures.push(name)
  console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((ok, bad) => {
    const probe = createServer()
    probe.once('error', bad)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => ok(port))
    })
  })
}

async function main() {
  console.log('[two-halves] 真机走查：一个包两半（宿主半 + 界面半）')
  check('Electron 在', existsSync(ELECTRON), ELECTRON)
  check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))
  check('statusbar 产物在（驱动拿它做 HMR 轮）', existsSync(STATUS_BUNDLE), STATUS_BUNDLE)

  const home = mkdtempSync(join(tmpdir(), 'dsc-two-halves-e2e-'))
  mkdirSync(join(home, '.dsc'), { recursive: true })
  writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  const profile = join(home, '.dsc', 'profiles', 'demo')
  mkdirSync(profile, { recursive: true })
  cpSync(join(root, 'examples', 'plugin-two-halves'), join(profile, 'node_modules', ID), { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ name: 'demo-profile', private: true, dsh: { profile: { bundles: [ID] } } }, null, 2),
    'utf8',
  )

  if (existsSync(RESULT)) rmSync(RESULT, { force: true })
  const port = await freePort()
  const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: join(home, '.dsc'),
      DSC_PROFILE: 'demo',
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      DSC_UI_HMR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr = []
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => {
    stderr.push(...String(chunk).split(String.fromCharCode(10)).filter((line) => line.trim() !== ''))
    if (stderr.length > 60) stderr.splice(0, stderr.length - 60)
  })
  let url = null
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => {
    const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(String(chunk))
    if (found !== null) url = found[0]
  })
  for (let waited = 0; waited < 90000 && url === null; waited += 250) await sleep(250)
  check('宿主起来了并给出界面地址', url !== null, stderr.slice(-5).join(' | '))
  if (url === null) { host.kill(); return }

  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['DSC_CORDIS_RESULT_FILE'] = RESULT
  env['DSC_CORDIS_USER_DATA'] = join(home, 'electron-user-data')
  env['DSC_CORDIS_BUNDLE'] = STATUS_BUNDLE
  env['DSC_CORDIS_SHOT'] = SHOT
  const electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })

  for (let waited = 0; waited < 240000; waited += 500) {
    if (existsSync(RESULT)) break
    await sleep(500)
  }
  check('驱动写出读数文件', existsSync(RESULT), RESULT)
  if (existsSync(RESULT)) {
    const result = JSON.parse(readFileSync(RESULT, 'utf8'))
    const first = result.steps?.[0]?.probe
    const row = first?.rows?.[ID]
    check('组合包的界面半被壳装上了', row !== undefined && row.state === 'loaded', JSON.stringify(row))
    check('它走的是 cordis 纤维且已生效', row?.via === 'cordis' && row?.fiber === 2, JSON.stringify(row))
    // 读数取的是 `[data-slot="shell.statusbar"]` 的 innerText，示例那段渲染在它的兄弟容器里，
    // 所以按示例自己的标记数（data-two-halves）判，别按那段文字判。
    check('界面上真的画出了示例那一段（data-two-halves）', first?.twoHalves === 1, String(first?.twoHalves))
    check('没有槽位故障', (first?.faults ?? []).length === 0, JSON.stringify(first?.faults))
    check('没有同步失败', (first?.syncFailures ?? []).length === 0, JSON.stringify(first?.syncFailures))
    check('截图在', existsSync(SHOT), SHOT)
  }

  electron.kill()
  host.kill()
}

await main()
console.log(String.fromCharCode(10) + (failures.length === 0 ? '全部通过' : failures.length + ' 条失败：' + failures.join('、')))
process.exit(failures.length === 0 ? 0 : 1)
