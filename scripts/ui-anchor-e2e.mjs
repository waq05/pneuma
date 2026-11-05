/**
 * 浮层锚定（CSS 锚点定位）的真机走查：真宿主 + 真 Chromium，量打开下拉之后的终态。
 *
 * 为什么要真机：锚点定位是浏览器的活，纯逻辑测不出来「贴上去了没有」。这里量的是
 * 真实矩形——左缘对齐、间距等于 gap、不窄于触发钮、打开当帧就不是隐藏态。
 *
 * 跑法：cd D:\\dsc && pnpm run build && pnpm run build:ui && node scripts/ui-anchor-e2e.mjs
 * 留下：desktop/shots/anchor-popover.png 与 desktop/shots/anchor-popover.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-anchor-main.cjs')
const SHOT = join(root, 'desktop', 'shots', 'anchor-popover.png')
const RESULT = join(root, 'desktop', 'shots', 'anchor-popover.json')

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log('  PASS  ' + name)
    return
  }
  failures.push(name)
  console.log('  FAIL  ' + name + (detail === '' ? '' : ' — ' + detail))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((ok, bad) => {
    const probe = createServer()
    probe.once('error', bad)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => ok(address.port))
    })
  })
}

async function main() {
  console.log('[anchor] 真机走查：下拉浮层贴锚点')
  check('Electron 在', existsSync(ELECTRON), ELECTRON)
  check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))
  const home = mkdtempSync(join(tmpdir(), 'dsc-anchor-'))
  const port = await freePort()
  if (existsSync(RESULT)) rmSync(RESULT, { force: true })
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
  if (url === null) {
    host.kill()
    return
  }
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['DSC_ANCHOR_RESULT'] = RESULT
  env['DSC_ANCHOR_SHOT'] = SHOT
  env['DSC_ANCHOR_USER_DATA'] = join(home, 'electron-user-data')
  const electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
  for (let waited = 0; waited < 180000; waited += 500) {
    if (existsSync(RESULT)) break
    await sleep(500)
  }
  check('驱动写出读数文件', existsSync(RESULT), RESULT)
  if (existsSync(RESULT)) {
    const parsed = JSON.parse(readFileSync(RESULT, 'utf8'))
    if (parsed.error !== undefined) check('驱动没有报错', false, String(parsed.error))
    const measured = parsed.measure ?? {}
    const trigger = measured.trigger ?? {}
    const pop = measured.pop ?? {}
    check('设置里找到了一个下拉并打开了浮层', measured.error === undefined && pop.width > 0, JSON.stringify(measured.error ?? pop))
    if (measured.error === undefined && pop.width > 0) {
      check('浮层左缘对齐触发钮（±1px）', Math.abs(Number(pop.left) - Number(trigger.left)) <= 1, `${String(pop.left)} vs ${String(trigger.left)}`)
      const below = Number(pop.top) - Number(trigger.bottom)
      const above = Number(trigger.top) - (Number(pop.top) + Number(pop.height))
      check('浮层贴着触发钮（下方或上方，间距 4px ±2）', Math.abs(below - 4) <= 2 || Math.abs(above - 4) <= 2, `下 ${String(below)} / 上 ${String(above)}`)
      check('浮层不窄于触发钮', Number(pop.width) + 0.5 >= Number(trigger.width), `${String(pop.width)} vs ${String(trigger.width)}`)
      check('打开当帧就不是隐藏态（没有「先画错再挪」的空窗）', measured.visibility !== 'hidden', String(measured.visibility))
      check('浏览器真的用上了锚点定位（触发钮有 anchor-name，浮层有 position-anchor）', String(measured.anchorName ?? '').startsWith('--') && String(measured.positionAnchor ?? '').startsWith('--'), JSON.stringify({ anchorName: measured.anchorName, positionAnchor: measured.positionAnchor }))
      // 放不下要往上翻：这条靠 position-try-fallbacks。它要是被 React 丢了，翻向就静默失效。
      check('放不下时的翻向真的生效（position-try-fallbacks 含 flip-block）', String(measured.tryFallbacks ?? '').includes('flip-block'), String(measured.tryFallbacks))
    }
    // 翻向机制：窗口底部粘一个锚点 + 120 高的浮层，下方放不下时必须翻到上方。
    const flip = parsed.flip ?? {}
    const flipTrigger = flip.trigger ?? {}
    const flipPop = flip.pop ?? {}
    check('翻向探针量到了（锚点与浮层都在）', Number(flipPop.height) > 0, JSON.stringify(flip))
    if (Number(flipPop.height) > 0) {
      check('下方放不下时翻到锚点上方', Number(flipPop.bottom) <= Number(flipTrigger.top) + 1, `浮层底 ${String(flipPop.bottom)} vs 锚点顶 ${String(flipTrigger.top)}`)
      check('翻上去之后仍在窗口里', Number(flipPop.top) >= -1, `${String(flipPop.top)} / 窗口 ${String(flip.viewport)}`)
    }
    check('截图在', existsSync(SHOT), SHOT)
  }
  electron.kill()
  host.kill()
  if (failures.length > 0) {
    console.log('── 宿主 stderr（最后 8 行）──')
    console.log(stderr.slice(-8).join(String.fromCharCode(10)))
  }
}

await main()
console.log(String.fromCharCode(10) + (failures.length === 0 ? '全部通过' : failures.length + ' 条失败：' + failures.join('、')))
process.exit(failures.length === 0 ? 0 : 1)
