/**
 * 第三方界面插件「安装 → 信任 → 界面出现」的端到端走查：全程不刷新页面。
 *
 * 为什么要有这一条：装包换图（`profile-hot-mount-test`）、壳侧对账（`ui-hmr-test`）、
 * 真机换代（`ui-hmr-machine`）各自都绿，但「往 `~/.dsc/plugins/` 放一个第三方界面插件包、
 * 点一次信任、界面当场把它画出来」这条用户真正走的路，之前只有两段间接证据拼起来。
 * 这里把它一次走通：
 *
 *   1. 宿主跑着、页面已加载，放一枚页内哨兵（刷新就丢）；
 *   2. 往 `~/.dsc/plugins/demo-hot/` 写一份合法的第三方界面插件（有 `plugin.json` 与
 *      `ui/client.js`），**还没信任**——启动图里不许有它、账本里不许有它；
 *   3. 经宿主 stdio 调 `setUiTrust('demo-hot')`（与插件中心那颗「确认信任」同一个方法）；
 *   4. 不等刷新：哨兵还在、`timeOrigin` 没变，账本里出现且 `loaded`，DOM 里有它的行，
 *      它自己 `apply()` 写下的标记也在——这才叫「界面真的把它装上了」；
 *   5. 删掉插件目录：热更轮询发现 `ui/client.js` 没了，图少一条，页面当场卸载它。
 *
 * 跑法：pnpm run build && pnpm run build:ui && node scripts/ui-third-party-hot-mount-e2e.mjs
 * 留下：desktop/shots/third-party-hot-mount.png
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-hmr-machine-main.cjs')
const SHOT = join(root, 'desktop', 'shots', 'third-party-hot-mount.png')
/** 第三方界面插件的目录名（也是它的 id）。 */
const PLUGIN = 'demo-hot'

let total = 0
const failures = []
const check = (name, ok, detail = '') => {
  total += 1
  if (ok) {
    console.log(`  PASS  ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

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

function connectPort(port) {
  return new Promise((ok, bad) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      bad(new Error(`连不上驱动的命令通道（:${String(port)}）`))
    }, 15000)
    socket.once('connect', () => {
      clearTimeout(timer)
      ok(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      bad(error)
    })
  })
}

/** 驱动（`_ui-hmr-machine-main.cjs`）的客户端：命令走回环 TCP（Windows 上 stdin 不通）。 */
class Driver {
  constructor(child) {
    this.child = child
    this.seq = 0
    this.pending = new Map()
    this.socket = null
    this.console = []
    this.ready = new Promise((settle) => {
      this.readyResolve = settle
    })
    this.exited = new Promise((settle) => {
      child.on('exit', (code) => settle(code ?? 0))
    })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          console.log(`[驱动] ${line}`)
          continue
        }
        if (message.type === 'ready') {
          this.readyResolve(message)
          continue
        }
        console.log(`[驱动] ${line}`)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write(`[驱动] ${String(chunk)}`))
  }

  async attach(port) {
    this.socket = await connectPort(port)
    this.socket.setEncoding('utf8')
    let buffer = ''
    this.socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') this.dispatch(line)
      }
    })
    this.socket.on('error', (error) => {
      for (const waiter of this.pending.values()) waiter({ ok: false, error: `命令通道出错：${error.message}` })
      this.pending.clear()
    })
  }

  dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.type === 'console') {
      this.console.push(message)
      if (message.level === 'error' || message.level === 'warning') {
        console.log(`  [页面/${message.level}] ${String(message.message).slice(0, 200)}`)
      }
      return
    }
    if (message.type === 'result') {
      const waiter = this.pending.get(message.id)
      if (waiter !== undefined) {
        this.pending.delete(message.id)
        waiter(message)
      }
    }
  }

  call(cmd, extra = {}) {
    const id = ++this.seq
    const timeoutMs = extra.clientTimeoutMs ?? 60000
    return new Promise((settle, fail) => {
      if (this.socket === null) {
        fail(new Error(`命令通道还没接上：${cmd}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`驱动命令超时：${cmd}`))
      }, timeoutMs)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.ok !== true) {
          fail(new Error(String(message.error ?? `${cmd} 失败`)))
          return
        }
        settle(message.value)
      })
      this.socket.write(`${JSON.stringify({ id, cmd, ...extra })}\n`)
    })
  }

  async quit() {
    try {
      await this.call('quit', { clientTimeoutMs: 4000 })
    } catch {
      // 已经退了
    }
    try {
      this.child.kill()
    } catch {
      // 已经退了
    }
  }
}

/** 宿主进程：stdio JSONL（协议）+ 界面服务（DSC_UI_SERVER=1）+ 热更轮询（DSC_UI_HMR=1）。 */
function startHost(home, port) {
  const child = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: join(home, '.dsc'),
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      DSC_UI_HMR: '1',
      DSC_UI_HMR_POLL_MS: '120',
      DSC_RESUME_SESSION: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = { child, url: null, pending: new Map(), seq: 0, stderr: [] }
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      if (state.url === null) {
        const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(line)
        if (found !== null) state.url = found[0]
      }
      try {
        const message = JSON.parse(line)
        if (message !== null && typeof message === 'object' && message.type === 'result') {
          const waiter = state.pending.get(message.id)
          if (waiter !== undefined) {
            state.pending.delete(message.id)
            waiter(message)
          }
        }
      } catch {
        // 非协议行（启动日志、界面地址）
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    state.stderr.push(...String(chunk).split('\n').filter((line) => line.trim() !== ''))
    if (state.stderr.length > 80) state.stderr.splice(0, state.stderr.length - 80)
  })
  return state
}

/** 经宿主 stdio 调一个运行时方法（与桌面壳同一条协议）。 */
function hostInvoke(state, method, args) {
  const id = ++state.seq
  state.child.stdin.write(`${JSON.stringify({ type: 'invoke', id, method, args })}\n`)
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      fail(new Error(`宿主方法超时：${method}`))
    }, 30000)
    state.pending.set(id, (message) => {
      clearTimeout(timer)
      settle(message)
    })
  })
}

/** 反复读页面，直到 predicate 满足或超时。 */
async function waitForDescribe(driver, predicate, label, timeoutMs = 25000) {
  const startedAt = Date.now()
  for (;;) {
    const value = await driver.call('describe')
    if (predicate(value)) return value
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等不到：${label}`)
    await sleep(150)
  }
}

async function main() {
  console.log('[third-party-hot-mount] 第三方界面插件：安装 → 信任 → 界面当场出现（不刷新）')
  check('Electron 在（desktop/node_modules）', existsSync(ELECTRON), ELECTRON)
  check('真机驱动在', existsSync(DRIVER), DRIVER)
  const assets = join(root, 'lib', 'ui', 'assets', 'index.html')
  check('界面壳产物在（先 pnpm run build:ui）', existsSync(assets), assets)
  if (failures.length > 0) return

  const home = mkdtempSync(join(tmpdir(), 'dsc-third-party-'))
  const port = await freePort()
  mkdirSync(join(home, '.dsc'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  // 假端点：启动不联网，也不会因为「没有 provider」把启动拖住。
  writeFileSync(
    join(home, '.dsc', 'config.yaml'),
    [
      'default:',
      '  provider: fake',
      '  model: fake-chat',
      'providers:',
      '  fake:',
      '    displayName: 走查假端点',
      '    baseURL: http://127.0.0.1:9/v1',
      '    apiKeyEnv: E2E_FAKE_KEY',
      '    models:',
      '      - id: fake-chat',
      '        name: Fake Chat',
      '        contextWindow: 128000',
      '        maxTokens: 4096',
      '',
    ].join('\n'),
    'utf8',
  )

  const host = startHost(home, port)
  let electron = null
  let driver = null
  try {
    for (let waited = 0; waited < 60000 && host.url === null; waited += 250) await sleep(250)
    check('宿主起来了并给出界面地址', host.url !== null, host.stderr.slice(-5).join(' | '))
    if (host.url === null) return

    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    env['DSC_UI_HMR_USER_DATA'] = join(home, 'electron-user-data')
    electron = spawn(ELECTRON, [DRIVER, host.url], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    driver = new Driver(electron)
    const ready = await driver.ready
    await driver.attach(Number(ready.port))
    check('真浏览器加载的就是宿主伺服的页面', typeof ready.url === 'string' && ready.url.includes(`:${String(port)}/`), String(ready.url))

    const booted = await driver.call('wait-boot', { timeoutMs: 60000, clientTimeoutMs: 75000 })
    check('页面启动落定（插件都装上或明确失败）', booted.ok === true, JSON.stringify(booted))
    await driver.call('mark', { value: 'third-party-hot-mount' })
    const before = await driver.call('describe')
    check('哨兵已就位（刷新就丢的标记）', before.sentinel === 'third-party-hot-mount', String(before.sentinel))
    check('基线账本里没有这个第三方插件', before.boot !== null && before.boot.plugins[PLUGIN] === undefined, JSON.stringify(Object.keys(before.boot?.plugins ?? {})))

    // 1. 装目录（还没信任）：图里不该有它——第三方界面插件进图的前提是「信任这一份字节」。
    const pluginDir = join(home, '.dsc', 'plugins', PLUGIN)
    mkdirSync(join(pluginDir, 'ui'), { recursive: true })
    // api 写的是对「壳的 @dsc/ui 契约版本」的区间（产物清单顶层 apiVersion，当前 0.8.1），
    // 不是 pneuma 自己的版本号；写错区间会被门禁当场拒（失败关闭），这里顺手把那句报错也验了。
    writeFileSync(join(pluginDir, 'plugin.json'), `${JSON.stringify({ api: '^0.8.0', platforms: ['web'] }, null, 2)}\n`, 'utf8')
    writeFileSync(
      join(pluginDir, 'ui', 'client.js'),
      [
        '// 走查样本：界面半边是 CJS 工厂（注册名必须等于目录 id），不是 ESM——',
        '// 壳用 <script> 执行它、从 __DSC_UI_FACTORIES__ 取工厂，写成 export 会语法错误。',
        "(globalThis.__DSC_UI_FACTORIES__ ??= {})['demo-hot'] = function (require, module, exports) {",
        '  module.exports = {',
        `    name: '${PLUGIN}',`,
        '    apply() {',
        "      document.documentElement.setAttribute('data-demo-hot', 'v1')",
        '    },',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    // 给热更轮询（120ms）留够一轮多：如果它不该被发现，这一段等待就是「没被发现」的证据窗口。
    await sleep(900)
    const untrusted = await driver.call('describe')
    check('未信任时启动图里没有它', untrusted.boot !== null && untrusted.boot.plugins[PLUGIN] === undefined, JSON.stringify(Object.keys(untrusted.boot?.plugins ?? {})))
    check('未信任时页面上没有它的装载行', !untrusted.pluginRows.includes(PLUGIN), untrusted.pluginRows.join('、'))
    const untrustedMark = await driver.call('attr', { selector: 'html', name: 'data-demo-hot' })
    check('未信任时它自己的代码一行都没执行（没有 data-demo-hot）', untrustedMark === null, String(untrustedMark))

    // 2. 信任：与插件中心那颗「确认信任」同一个方法（runtime.setUiTrust）。
    const trusted = await hostInvoke(host, 'setUiTrust', [PLUGIN])
    check(
      'setUiTrust 返回成功（信任落盘）',
      trusted.ok === true && trusted.value?.ok === true,
      JSON.stringify(trusted.value ?? trusted.error),
    )
    // 3. 不刷新，界面当场装载（信任成功会发 dsc/ui-graph-dirty → 推帧 → 壳对账）。
    const settled = await driver.call('wait-change', { plugin: PLUGIN, from: '', timeoutMs: 30000, clientTimeoutMs: 35000 })
    const after = await driver.call('describe')
    if (settled.ok !== true || after.boot?.plugins[PLUGIN] === undefined) {
      // 红的时候别让人猜：把宿主图与页内账本一起摆出来（图里有、账本没有 = 壳侧对账的问题；
      // 两边都没有 = 宿主组图的问题）。
      const graph = await driver.call('graph').catch((error) => ({ error: String(error) }))
      console.log('  .. 宿主图里的行：', JSON.stringify(graph.entries))
      console.log('  .. 页内账本：', JSON.stringify(after.boot?.plugins ?? null).slice(0, 1500))
      console.log('  .. 页内请求：', JSON.stringify((after.boot?.requests ?? []).slice(-8)))
      console.log('  .. 驱动 wait-change 读数：', JSON.stringify(settled))
    }
    check('信任之后这一行被装上了（不重启、不刷新）', settled.ok === true, JSON.stringify(settled))
    check('页内哨兵没丢（页面没刷新）', after.sentinel === 'third-party-hot-mount', String(after.sentinel))
    check('timeOrigin 未变（页面没刷新）', after.timeOrigin === before.timeOrigin, `${String(after.timeOrigin)} vs ${String(before.timeOrigin)}`)
    check('账本里这条是 loaded', after.boot?.plugins[PLUGIN]?.state === 'loaded', JSON.stringify(after.boot?.plugins[PLUGIN] ?? null))
    check('DOM 里出现了它的装载行', after.pluginRows.includes(PLUGIN), after.pluginRows.join('、'))
    const ownMark = await driver.call('attr', { selector: 'html', name: 'data-demo-hot' })
    check('插件自己的 apply 真的执行了（页面上有它写的 data-demo-hot）', ownMark === 'v1', String(ownMark))
    check('页内没有同步失败', after.syncFailures.length === 0, after.syncFailures.join('、'))

    // 4. 删目录：热更轮询按图行 stat `ui/client.js`，文件没了 → 换图 → 页面卸载它。
    rmSync(pluginDir, { recursive: true, force: true })
    const removed = await waitForDescribe(
      driver,
      (value) => value.boot !== null && value.boot.plugins[PLUGIN]?.state === 'removed',
      '删掉目录之后这一行被卸载',
      20000,
    ).catch((error) => ({ error: String(error) }))
    check(
      '删掉插件目录之后页面当场卸载它（图少一条 + 账本 removed）',
      removed !== null && removed.boot !== undefined && removed.boot.plugins[PLUGIN]?.state === 'removed',
      JSON.stringify(removed?.error ?? removed?.boot?.plugins[PLUGIN] ?? null),
    )
    const gone = await driver.call('describe')
    check('DOM 里的装载行也消失了', !gone.pluginRows.includes(PLUGIN), gone.pluginRows.join('、'))

    await driver
      .call('shot', { file: SHOT })
      .then(() => check('截图在', existsSync(SHOT), SHOT))
      .catch((error) => check('截图在', false, String(error)))
  } finally {
    if (driver !== null) await driver.quit()
    try {
      host.child.kill()
    } catch {
      // 已经退了
    }
    if (failures.length > 0) {
      console.log(`隔离 HOME 留在 ${home}（失败现场）`)
      console.log('── 宿主 stderr（最后 10 行）──')
      console.log(host.stderr.slice(-10).join('\n'))
    } else {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

await main()
console.log(`\n${String(total - failures.length)}/${String(total)} 通过`)
process.exit(failures.length === 0 ? 0 : 1)
