/**
 * 「停用旁问（界面）」的真机走查：三张证据图 + 一组读数。
 *
 * 为什么要真机：入口卡、页签、快捷键、命令面板动作这四样的消失都发生在**真浏览器的
 * 那一帧**——纯 Node 探针只能压注册表与源码接线（见 `ui-plugin-disable-test.mjs`），
 * 压不到「宿主推了新图、页面把插件卸了、右侧栏跟着重画」这条链路。
 *
 * 走用户的真实路径（驱动 `_ui-plugin-disable-main.cjs`）：
 *   1. 右侧栏开始页点「旁问」→ 开出一张旁问页签；
 *   2. 侧栏「插件」→ 插件中心 → 停用 ui-ask；
 *   3. 断言：页签被清掉、开始页入口卡没了、命令面板搜「旁问」没有动作、Ctrl+Shift+K 不再开页签；
 *   4. 留三张图（停用前开始页 / 停用后开始页 / 停用后命令面板搜旁问）。
 *
 * 跑法：pnpm run build && pnpm run build:ui && node scripts/ui-plugin-disable-e2e.mjs
 *
 * @module dsc/scripts/ui-plugin-disable-e2e
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 平台包名不同：Windows 是 electron.exe，Linux/macOS 是 electron（无后缀）。
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
// Linux 无头 CI：Electron 的 SUID sandbox helper 没有 setuid，直接起会退出（探针只在
// 等结果文件超时，看起来像「卡住」）；xvfb 环境也没有 GPU。三项都是 Chromium 的标准 CI 开关。
const ELECTRON_FLAGS = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []
const DRIVER = join(root, 'scripts', '_ui-plugin-disable-main.cjs')
const SHOT_BEFORE = join(root, 'desktop', 'shots', 'dock-disable-before.png')
const SHOT_AFTER = join(root, 'desktop', 'shots', 'dock-disable-after.png')
const SHOT_PALETTE = join(root, 'desktop', 'shots', 'dock-disable-palette.png')
const SHOT_END = join(root, 'desktop', 'shots', 'dock-disable-all.png')
const RESULT = join(root, 'desktop', 'shots', 'dock-disable.json')

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
  console.log('[dock-disable] 真机：停用 ui-ask 之后右侧栏不留残骸')
  check('Electron 在', existsSync(ELECTRON), ELECTRON)
  check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))
  check('ask 产物在', existsSync(join(root, 'lib', 'ui', 'plugins', 'ask', 'client.js')))

  const home = mkdtempSync(join(tmpdir(), 'dsc-dock-disable-'))
  const port = await freePort()
  for (const file of [RESULT, SHOT_BEFORE, SHOT_AFTER, SHOT_PALETTE, SHOT_END]) rmSync(file, { force: true })
  const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: join(home, '.dsc'),
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      // 这里验的是「停用 → 宿主换图 → 推一帧」，不是产物热更；关掉轮询少一份噪音。
      DSC_UI_HMR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr = []
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => {
    stderr.push(...String(chunk).split(String.fromCharCode(10)).filter((line) => line.trim() !== ''))
    if (stderr.length > 80) stderr.splice(0, stderr.length - 80)
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
  env['DSC_DISABLE_RESULT'] = RESULT
  env['DSC_DISABLE_BEFORE'] = SHOT_BEFORE
  env['DSC_DISABLE_AFTER'] = SHOT_AFTER
  env['DSC_DISABLE_PALETTE'] = SHOT_PALETTE
  env['DSC_DISABLE_END'] = SHOT_END
  env['DSC_DISABLE_USER_DATA'] = join(home, 'electron-user-data')
  const electron = spawn(ELECTRON, [...ELECTRON_FLAGS, DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
  for (let waited = 0; waited < 180000; waited += 500) {
    if (existsSync(RESULT)) break
    await sleep(500)
  }
  check('驱动写出读数文件', existsSync(RESULT), RESULT)
  try {
    if (existsSync(RESULT)) {
      const parsed = JSON.parse(readFileSync(RESULT, 'utf8'))
      if (parsed.error !== undefined) console.log('  ..    驱动报错：' + String(parsed.error))
      check('走完了全程（驱动没有报错）', parsed.error === undefined, String(parsed.error ?? ''))
      const has = (list, text) => Array.isArray(list) && list.some((item) => String(item).includes(text))
      const none = (list, text) => Array.isArray(list) && list.every((item) => !String(item).includes(text))

      check('右侧栏打开了，停在开始页', parsed.opened === true)
      check('停用前：开始页五张卡（含旁问）', has(parsed.initial?.cards, '旁问') && parsed.initial.cards.length === 5, JSON.stringify(parsed.initial?.cards))
      check('停用前：页签条只有开始页', JSON.stringify(parsed.initial?.chips) === JSON.stringify(['开始']), JSON.stringify(parsed.initial?.chips))
      check('停用前：侧栏有「技能 / 插件」两颗整页入口', has(parsed.initial?.nav, '插件') && has(parsed.initial?.nav, '技能'), JSON.stringify(parsed.initial?.nav))

      // ── 1. 旁问：卡 + 页签 + 命令面板动作 ---------------------------------------
      check('旁问：停用前有入口卡、点卡开出了页签', parsed.ask?.openedTab === true && has(parsed.ask?.cardsBefore, '旁问') && has(parsed.ask?.chipsBefore, '旁问'), JSON.stringify({ cards: parsed.ask?.cardsBefore, chips: parsed.ask?.chipsBefore }))
      check('旁问：插件中心那一行开关开着，扳完被页面卸掉', parsed.ask?.toggle?.on === 'true' && parsed.ask?.toggle?.gone === true, JSON.stringify(parsed.ask?.toggle))
      check('旁问：停用后页签被清掉', none(parsed.ask?.chipsAfter, '旁问'), JSON.stringify(parsed.ask?.chipsAfter))
      check('旁问：停用后页签体不再渲染（不是空壳）', parsed.ask?.bodyGone === true)
      check('旁问：停用后开始页入口卡消失', none(parsed.ask?.cardsAfter, '旁问'), JSON.stringify(parsed.ask?.cardsAfter))
      check('旁问：停用后命令面板搜「旁问」没有动作', none(parsed.ask?.palette?.rows, '旁问') && parsed.ask?.palette?.empty === true, JSON.stringify(parsed.ask?.palette))
      check('旁问：停用后其余四张卡还在（不是整块清空）', parsed.ask?.cardsAfter?.length === 4, JSON.stringify(parsed.ask?.cardsAfter))

      // ── 2. 预览 + 文件：两个 kind 各自被清，且互不牵连 ---------------------------
      check('预览：停用前点文件树里的一个文件，开出了预览页签', typeof parsed.preview?.label === 'string' && parsed.preview.label !== '' && has(parsed.preview?.chipsBefore, parsed.preview.label), JSON.stringify(parsed.preview))
      check('预览：停用后预览页签消失、页签体不再渲染', none(parsed.preview?.chipsAfter, parsed.preview?.label ?? '\u0000') && parsed.preview?.previewBodyGone === true, JSON.stringify({ chips: parsed.preview?.chipsAfter, gone: parsed.preview?.previewBodyGone }))
      check('预览：停用后文件页签仍在（只清自己那一种 kind）', parsed.preview?.filesStillThere === true && has(parsed.preview?.chipsAfter, '文件'), JSON.stringify(parsed.preview?.chipsAfter))
      check('文件：停用前有文件页签与文件树', parsed.files?.opened === true && has(parsed.files?.chipsBefore, '文件'), JSON.stringify(parsed.files?.chipsBefore))
      check('文件：停用后页签被清掉、文件树不再渲染', none(parsed.files?.chipsAfter, '文件') && parsed.files?.bodyGone === true, JSON.stringify({ chips: parsed.files?.chipsAfter, gone: parsed.files?.bodyGone }))
      check('文件：停用后开始页的「工作区文件 / Git 管理」两张卡一起消失', none(parsed.files?.cardsAfter, '工作区文件') && none(parsed.files?.cardsAfter, 'Git'), JSON.stringify(parsed.files?.cardsAfter))

      // ── 3. 终端 ---------------------------------------------------------------
      check('终端：停用前有终端页签', parsed.terminal?.opened === true && has(parsed.terminal?.chipsBefore, '终端'), JSON.stringify(parsed.terminal?.chipsBefore))
      check('终端：停用后页签与页签体都没了', none(parsed.terminal?.chipsAfter, '终端') && parsed.terminal?.bodyGone === true, JSON.stringify({ chips: parsed.terminal?.chipsAfter, gone: parsed.terminal?.bodyGone }))

      // ── 4. 浏览器 -------------------------------------------------------------
      check('浏览器：停用前有浏览器页签', parsed.browser?.opened === true && has(parsed.browser?.chipsBefore, '浏览器'), JSON.stringify(parsed.browser?.chipsBefore))
      check('浏览器：停用后页签与页签体都没了', none(parsed.browser?.chipsAfter, '浏览器') && parsed.browser?.bodyGone === true, JSON.stringify({ chips: parsed.browser?.chipsAfter, gone: parsed.browser?.bodyGone }))

      // ── 5. 插件中心整页：侧栏那颗钮（死钮） ------------------------------------
      check('插件中心：停用前侧栏有「插件」入口', has(parsed.plugins?.navBefore, '插件'), JSON.stringify(parsed.plugins?.navBefore))
      check('插件中心：停用后侧栏那颗「插件」钮消失', none(parsed.plugins?.navAfter, '插件'), JSON.stringify(parsed.plugins?.navAfter))
      check('插件中心：停用后主区回到对话页（不是空白）', parsed.plugins?.pageGone === true && parsed.plugins?.chatBack === true && parsed.plugins?.blank === false, JSON.stringify({ pageGone: parsed.plugins?.pageGone, chatBack: parsed.plugins?.chatBack, blank: parsed.plugins?.blank }))
      check('插件中心：那颗钮消失了，但「技能」还在', has(parsed.plugins?.navAfter, '技能'), JSON.stringify(parsed.plugins?.navAfter))

      // ── 6. 总闸：五个被停用的插件都不许在这四处留名字 ---------------------------
      const disabled = [
        { name: '旁问', chips: parsed.ask?.chipsAfter, cards: parsed.ask?.cardsAfter, palette: parsed.ask?.palette?.rows },
        { name: '预览', chips: parsed.preview?.chipsAfter, cards: parsed.files?.cardsAfter, palette: null },
        { name: '文件', chips: parsed.files?.chipsAfter, cards: parsed.files?.cardsAfter, palette: null },
        { name: '终端', chips: parsed.terminal?.chipsAfter, cards: null, palette: null },
        { name: '浏览器', chips: parsed.browser?.chipsAfter, cards: null, palette: null },
      ]
      const residue = []
      for (const item of disabled) {
        if (item.chips !== null && item.chips !== undefined && has(item.chips, item.name)) residue.push(item.name + '：页签条')
        if (item.cards !== null && item.cards !== undefined && has(item.cards, item.name)) residue.push(item.name + '：开始页入口卡')
        if (item.palette !== null && item.palette !== undefined && has(item.palette, item.name)) residue.push(item.name + '：命令面板动作')
      }
      if (has(parsed.plugins?.navAfter, '插件')) residue.push('插件中心：侧栏导航钮')
      check('总闸：停用后「页签条 / 开始页入口卡 / 命令面板 / 侧栏导航钮」四处都没有残留', residue.length === 0, residue.join('、'))
      check('全部停用后：开始页不再有入口卡（面板类插件全关的诚实状态）', Array.isArray(parsed.final?.cards) && parsed.final.cards.length === 0, JSON.stringify(parsed.final?.cards))
      check('全部停用后：页签条只剩开始页', JSON.stringify(parsed.final?.chips) === JSON.stringify(['开始']), JSON.stringify(parsed.final?.chips))
      check('全部停用后：侧栏只剩「技能」（插件钮已随插件消失）', JSON.stringify(parsed.final?.nav) === JSON.stringify(['技能']), JSON.stringify(parsed.final?.nav))
      check('全程页面没有 error/warning', Array.isArray(parsed.console) && parsed.console.length === 0, JSON.stringify(parsed.console).slice(0, 500))
    }
    check('停用前截图在', existsSync(SHOT_BEFORE), SHOT_BEFORE)
    check('停用后截图在', existsSync(SHOT_AFTER), SHOT_AFTER)
    check('命令面板截图在', existsSync(SHOT_PALETTE), SHOT_PALETTE)
    check('全部停用后的截图在', existsSync(SHOT_END), SHOT_END)
  } finally {
    try {
      electron.kill()
    } catch {}
    try {
      host.kill()
    } catch {}
    await sleep(400)
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
  }
  if (failures.length > 0) {
    console.log('── 宿主 stderr（最后 10 行）──')
    console.log(stderr.slice(-10).join(String.fromCharCode(10)))
  }
}

await main()
console.log(String.fromCharCode(10) + (failures.length === 0 ? '全部通过' : String(failures.length) + ' 条失败：' + failures.join('、')))
process.exit(failures.length === 0 ? 0 : 1)
