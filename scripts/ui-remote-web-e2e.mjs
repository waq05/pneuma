/**
 * 「手机尺寸下的远程壳」真机走查：真宿主 + 真 Chromium，窗口 390×844。
 *
 * 为什么要有这条：移动端此前只有单测（`ui-mobile-shell-test.mjs` 128 条断言行的是纯逻辑）。
 * 真浏览器在窄屏下会不会横向溢出、19 条插件装不装得上、槽位有没有故障，只有真跑一次才算数。
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/ui-remote-web-e2e.mjs
 * 依赖：`lib/`（先 build）、`desktop/node_modules/electron`
 * 留下：`desktop/shots/remote-web-mobile.png`
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-mobile-main.cjs')
const SHOT = join(root, 'desktop', 'shots', 'remote-web-mobile.png')
const RESULT = join(root, 'desktop', 'shots', 'remote-web-mobile.json')
const WIDTH = 390
const HEIGHT = 844

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
  console.log('[remote-web] 真机走查：手机尺寸下的远程壳（' + String(WIDTH) + '×' + String(HEIGHT) + '）')
  check('Electron 在', existsSync(ELECTRON), ELECTRON)
  check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))

  const home = mkdtempSync(join(tmpdir(), 'dsc-remote-web-'))
  const port = await freePort()

  if (existsSync(RESULT)) rmSync(RESULT, { force: true })
  if (existsSync(SHOT)) rmSync(SHOT, { force: true })

  const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: join(home, '.dsc'),
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      DSC_UI_HMR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const hostErr = []
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => {
    hostErr.push(...String(chunk).split(String.fromCharCode(10)).filter((line) => line.trim() !== ''))
    if (hostErr.length > 60) hostErr.splice(0, hostErr.length - 60)
  })
  let url = null
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => {
    const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(String(chunk))
    if (found !== null) url = found[0]
  })
  for (let waited = 0; waited < 90000 && url === null; waited += 250) await sleep(250)
  check('宿主起来了并给出界面地址', url !== null, hostErr.slice(-5).join(' | '))
  if (url === null) {
    host.kill()
    return
  }

  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['DSC_MOBILE_RESULT'] = RESULT
  env['DSC_MOBILE_SHOT'] = SHOT
  env['DSC_MOBILE_W'] = String(WIDTH)
  env['DSC_MOBILE_H'] = String(HEIGHT)
  env['DSC_MOBILE_USER_DATA'] = join(home, 'electron-user-data')
  const electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })

  for (let waited = 0; waited < 180000; waited += 500) {
    if (existsSync(RESULT)) break
    await sleep(500)
  }
  check('驱动写出读数文件', existsSync(RESULT), RESULT)
  if (existsSync(RESULT)) {
    const parsed = JSON.parse(readFileSync(RESULT, 'utf8'))
    if (parsed.error !== undefined) {
      check('驱动没有报错', false, String(parsed.error).split(String.fromCharCode(10))[0])
    } else {
      const probe = parsed.probe ?? {}
      // innerWidth 比窗口窄一条滚动条（390 → 376 实测），所以按「矮不超过窗口、又不小于
      // 常见手机下限」判，而不是死等 390。
      check('窗口就是手机宽度（360~' + String(WIDTH) + '）', probe.width >= 360 && probe.width <= WIDTH, String(probe.width))
      check('输入框在（壳起得来）', probe.composer === true)
      check('19 条插件全装上', probe.plugins >= 19 && probe.loaded === probe.plugins, 'plugins=' + String(probe.plugins) + ' loaded=' + String(probe.loaded))
      check('没有装失败的插件', (probe.failed ?? []).length === 0, JSON.stringify(probe.failed))
      check('没有槽位故障', Number(probe.faults ?? 0) === 0, String(probe.faults))
      // 横向溢出是窄屏最常见的坏样子：多出 1px 就能横向拖动，整页跟着抖。
      check('没有横向溢出', Number(probe.overflow ?? 99) <= 2, '溢出 ' + String(probe.overflow) + 'px')
      check('截图在', existsSync(SHOT), SHOT)
    }
  }

  electron.kill()
  host.kill()
  if (failures.length > 0) {
    console.log('── 宿主 stderr（最后 10 行）──')
    console.log(hostErr.slice(-10).join(String.fromCharCode(10)))
  }
}

await main()
console.log(String.fromCharCode(10) + (failures.length === 0 ? '全部通过' : failures.length + ' 条失败：' + failures.join('、')))
process.exit(failures.length === 0 ? 0 : 1)
