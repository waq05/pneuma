/**
 * cordis 装配探针：起隔离宿主 + 真 Chromium，量「statusbar 走 cordis」这条链路。
 *
 * 断言：
 *   1. 19 条插件全装上；statusbar 的 via='cordis'、fiber=2（生效），其余 18 条仍是 ledger；
 *   2. 状态栏那一段在 DOM 里只有 1 份（多份 = 卸载不干净）；
 *   3. 换装一轮后新代码真的执行（产物里的标记出现），段数仍是 1；
 *   4. 全程没有槽位故障、没有同步失败、没有页面报错；
 *   5. 还原轮之后仍是 1 份（再卸再装仍然干净）。
 *
 * 踩过的两个坑（别再改回去）：
 *   - ELECTRON_RUN_AS_NODE 必须从环境里摘掉，否则 electron.exe 退回成普通 node，
 *     require('electron') 拿到的是一串路径，主进程一上来就崩；
 *   - 给 electron.exe 的命令行只能带入口地址这一个位置参数：多带一个（哪怕空串）
 *     它会直接退出，退出码 127（实测）。产物路径与截图路径走环境变量。
 *
 * 用法：node scripts/ui-cordis-test.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-cordis-main.cjs')
const BUNDLE = join(root, 'lib', 'ui', 'plugins', 'statusbar', 'client.js')
const SHOT = join(root, 'desktop', 'shots', 'cordis-probe.png')
const RESULT_FILE = join(root, 'desktop', 'shots', 'cordis-probe.json')

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
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolvePort(port))
    })
  })
}

function startHost({ port, home }) {
  const child = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: join(home, '.dsc'),
      DSC_UI_SERVER: '1',
      DSC_UI_HMR: '1',
      DSC_UI_HMR_POLL_MS: '250',
      DSC_UI_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr = []
  const waitUrl = new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error('等界面地址超时：' + stderr.slice(-5).join(' | '))), 90000)
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(index + 1).trim()
        buffer = line === '' ? buffer.slice(index + 1) : buffer
        const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(chunk)
        if (found !== null) {
          clearTimeout(timer)
          resolveUrl(found[0])
          return
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr.push(...String(chunk).split('\n').filter((line) => line.trim() !== ''))
      if (stderr.length > 60) stderr.splice(0, stderr.length - 60)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectUrl(new Error('宿主提前退出（code=' + String(code) + '）：' + stderr.slice(-5).join(' | ')))
    })
  })
  return { child, waitUrl }
}

/**
 * cordis 的 `inject` 语义自检（不开浏览器，先钉住我们依赖的那三条假设）。
 *
 * 拆 `inject` 双关之后，服务名那一半交给 cordis 等；这条自检证明等待的形状真是我们以为的那样：
 *   1. 依赖没就绪时 `await fiber` **直接放行**（不抛、不卡），纤维停在状态 0；
 *   2. apply **不跑**（不能拿半份服务就开工）；
 *   3. 服务后来补上 → apply 跑起来、状态到 2，且 `internal/status` 事件确实发得出来
 *      （壳的账本靠它从「等待」翻成「已生效」）。
 */
async function checkInjectSemantics() {
  console.log('\n[0] cordis inject 语义自检')
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  const events = []
  const off = ctx.on('internal/status', (fiber, old) => {
    events.push(`${String(old)}->${String(fiber.state)}`)
  })
  let started = 0
  const fiber = ctx.plugin({
    name: 'needs-service',
    inject: ['notYetProvided'],
    apply: () => {
      started += 1
    },
  })
  const settled = await Promise.race([
    fiber.then(() => 'resolved'),
    sleep(1500).then(() => 'timeout'),
  ])
  check('依赖缺席时 await fiber 直接放行（不卡住）', settled === 'resolved', String(settled))
  check('依赖缺席时纤维停在待装（state=0）', fiber.state === 0, String(fiber.state))
  check('依赖缺席时 apply 不跑', started === 0, String(started))
  ctx.provide('notYetProvided', {})
  await sleep(200)
  check('服务补上后 apply 跑了', started === 1, String(started))
  check('服务补上后纤维生效（state=2）', fiber.state === 2, String(fiber.state))
  check('状态变化有事件（壳的账本靠它刷新）', events.length >= 2, JSON.stringify(events))
  off()
}

async function main() {
  console.log('[cordis-probe] 真机走查：界面插件装配走 cordis')
  await checkInjectSemantics()
  check('Electron 在', existsSync(ELECTRON), ELECTRON)
  check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))
  check('statusbar 产物在', existsSync(BUNDLE), BUNDLE)

  if (existsSync(RESULT_FILE)) rmSync(RESULT_FILE, { force: true })
  const home = mkdtempSync(join(tmpdir(), 'dsc-cordis-probe-'))
  const port = await freePort()
  const host = startHost({ port, home })
  let electron = null
  try {
    const url = await host.waitUrl
    console.log('  ..    宿主端口 ' + String(port) + '，界面地址已取到')

    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    env['DSC_CORDIS_RESULT_FILE'] = RESULT_FILE
    env['DSC_CORDIS_USER_DATA'] = join(home, 'electron-user-data')
    env['DSC_CORDIS_BUNDLE'] = BUNDLE
    env['DSC_CORDIS_SHOT'] = SHOT
    env['DSC_CORDIS_DIAG'] = process.env['DSC_CORDIS_DIAG'] ?? ''
    // 只带入口地址一个位置参数（多带一个 electron 就退出 127）。
    // `DSC_CORDIS_DIAG=1` 时驱动会在令牌跳转之后再跳一次 `/?diag=1`（见驱动里的注释）。
    electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })

    for (let waited = 0; waited < 240000; waited += 500) {
      if (existsSync(RESULT_FILE)) break
      await sleep(500)
    }
    check('驱动写出读数文件', existsSync(RESULT_FILE), RESULT_FILE)
    if (!existsSync(RESULT_FILE)) return
    const result = JSON.parse(readFileSync(RESULT_FILE, 'utf8'))
    if (result.error !== undefined) console.log('  ..    驱动报错：' + String(result.error))
    const first = result.steps[0]?.probe
    check('拿到首帧落定读数', first !== undefined && first.settled === true)
    if (first === undefined) return

    const ids = Object.keys(first.rows)
    check('插件全部装上（' + String(ids.length) + ' 条）', ids.length >= 19 && ids.every((id) => first.rows[id].state === 'loaded'), ids.filter((id) => first.rows[id].state !== 'loaded').join('、'))
    check('statusbar 走 cordis（via=cordis）', first.rows['statusbar']?.via === 'cordis', JSON.stringify(first.rows['statusbar']))
    check('statusbar 的纤维已生效（fiber=2）', first.rows['statusbar']?.fiber === 2, String(first.rows['statusbar']?.fiber))
    const others = ids.filter((id) => id !== 'statusbar')
    check('其余 ' + String(others.length) + ' 条也走 cordis（via=cordis）', others.every((id) => first.rows[id].via === 'cordis'), others.filter((id) => first.rows[id].via !== 'cordis').map((id) => id + '=' + String(first.rows[id].via)).join('、'))
    check('全部纤维都生效（fiber=2）', ids.every((id) => first.rows[id].fiber === 2), ids.filter((id) => first.rows[id].fiber !== 2).map((id) => id + '=' + String(first.rows[id].fiber)).join('、'))
    check('状态栏在 DOM 里只有 1 份', first.statusbarEntries === 1, String(first.statusbarEntries))
    check('状态栏有内容', typeof first.statusbarText === 'string' && first.statusbarText.length > 0, String(first.statusbarText))
    if (first.viaAttrs !== undefined && first.viaAttrs.length > 0) {
      check('诊断区每行都写着装配路径（' + String(first.viaAttrs.length) + ' 行）', first.viaAttrs.length === ids.length && first.viaAttrs.every((v) => v === 'cordis'), JSON.stringify(first.viaAttrs))
      check('诊断区每行的纤维状态都是 2', first.fiberAttrs.every((v) => v === '2'), JSON.stringify(first.fiberAttrs))
    }
    check('没有槽位故障', first.faults.length === 0, first.faults.join('、'))
    check('没有同步失败', first.syncFailures.length === 0, first.syncFailures.join('、'))
    check('两批都落定', first.batches.length >= 2 && first.batches.every((b) => b.state === 'done'), JSON.stringify(first.batches))
    console.log('  ..    状态栏文本：' + String(first.statusbarText).replace(/\n/g, ' / '))

    const swapped = result.steps.find((s) => s.label.startsWith('换装'))
    check('跑到了换装轮', swapped !== undefined)
    if (swapped !== undefined) {
      check('换装后新代码真的执行（标记出现）', swapped.probe.hmrMark === swapped.nonce, String(swapped.probe.hmrMark) + ' vs ' + String(swapped.nonce))
      check('换装后状态栏仍是 1 份（卸旧装新干净）', swapped.probe.statusbarEntries === 1, String(swapped.probe.statusbarEntries))
      check('换装后仍是 via=cordis 且 fiber=2', swapped.probe.rows['statusbar']?.via === 'cordis' && swapped.probe.rows['statusbar']?.fiber === 2, JSON.stringify(swapped.probe.rows['statusbar']))
      check('换装后没有槽位故障', swapped.probe.faults.length === 0, swapped.probe.faults.join('、'))
    }
    const final = result.steps.find((s) => s.label === '还原轮')
    if (final !== undefined) {
      check('还原后状态栏仍是 1 份', final.probe.statusbarEntries === 1, String(final.probe.statusbarEntries))
      check('还原后没有槽位故障', final.probe.faults.length === 0, final.probe.faults.join('、'))
    }
    check('全程页面没有 error/warning', result.console.length === 0, JSON.stringify(result.console).slice(0, 600))
    if (result.shot !== undefined) console.log('  ..    证据图：' + result.shot)
  } finally {
    try {
      electron?.kill()
    } catch {}
    try {
      host.child.kill()
    } catch {}
    await sleep(300)
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
  }
  console.log('')
  console.log(failures.length === 0 ? '[cordis-probe] 全部通过（' + String(failures.length) + ' 条失败）' : '[cordis-probe] 失败 ' + String(failures.length) + ' 条：' + failures.join('、'))
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
