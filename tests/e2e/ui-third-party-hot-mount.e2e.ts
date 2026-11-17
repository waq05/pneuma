/**
 * 第三方界面插件「安装 → 信任 → 界面出现」的端到端走查
 * （迁自 `scripts/ui-third-party-hot-mount-e2e.mjs`，断言 1:1）：全程不刷新页面。
 *
 * 为什么要有这一条：装包换图、壳侧对账、真机换代各自都绿，但「往 `~/.dsc/plugins/`
 * 放一个第三方界面插件包、点一次信任、界面当场把它画出来」这条用户真正走的路，
 * 之前只有两段间接证据拼起来。这里把它一次走通：
 *
 *   1. 宿主跑着、页面已加载，放一枚页内哨兵（刷新就丢）；
 *   2. 往 `~/.dsc/plugins/demo-hot/` 写一份合法的第三方界面插件，**还没信任**——
 *      启动图里不许有它、账本里不许有它；
 *   3. 经宿主 stdio 调 `setUiTrust('demo-hot')`（与插件中心那颗「确认信任」同一个方法）；
 *   4. 不等刷新：哨兵还在、`timeOrigin` 没变，账本里出现且 `loaded`，DOM 里有它的行，
 *      它自己 `apply()` 写下的标记也在——这才叫「界面真的把它装上了」；
 *   5. 删掉插件目录：热更轮询发现 `ui/client.js` 没了，图少一条，页面当场卸载它。
 *
 * 与探针的差异：截图落 tmpdir；驱动协议（回环 TCP 命令通道）与宿主 stdio 客户端
 * 是这条探针专属（Windows 上 stdin 不通，且宿主协议要 pipe），所以宿主在本文件内起，
 * 不走外壳 startUiHost。断言读数在 beforeAll 一次取齐，test 只读事实；
 * 信任装载失败时把宿主图与页内账本一起塞进断言消息（原探针的诊断 dump）。
 *
 * @module dsc/tests/e2e/ui-third-party-hot-mount.e2e
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ELECTRON, ROOT, freePort, probeFreshness, skipReason, sleep } from './support/host.js'

const DRIVER = join(ROOT, 'scripts', '_ui-hmr-machine-main.cjs')
/** 第三方界面插件的目录名（也是它的 id）。 */
const PLUGIN = 'demo-hot'
/** 壳的界面契约版本（`ui-shell/package.json` 的 version）：样板的 `api` 区间要对着它写。 */
const SHELL_VERSION = JSON.parse(readFileSync(join(ROOT, 'ui-shell', 'package.json'), 'utf8'))['version'] as string

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

function connectPort(port: number): Promise<Socket> {
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

type AnyRecord = Record<string, unknown>

/** 驱动（`_ui-hmr-machine-main.cjs`）的客户端：命令走回环 TCP（Windows 上 stdin 不通）。 */
class Driver {
  private socket: Socket | null = null
  private seq = 0
  private pending = new Map<number, (value: unknown) => void>()
  readonly ready: Promise<AnyRecord>

  constructor(private readonly child: ChildProcess) {
    this.ready = new Promise<AnyRecord>((settle) => {
      let buffer = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        buffer += String(chunk)
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) break
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          let message: AnyRecord
          try {
            message = JSON.parse(line) as AnyRecord
          } catch {
            console.log(`[驱动] ${line}`)
            continue
          }
          if (message.type === 'ready') {
            settle(message)
            continue
          }
          console.log(`[驱动] ${line}`)
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => process.stderr.write(`[驱动] ${String(chunk)}`))
    })
  }

  async attach(port: number): Promise<void> {
    this.socket = await connectPort(port)
    this.socket.setEncoding('utf8')
    let buffer = ''
    this.socket.on('data', (chunk) => {
      buffer += String(chunk)
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') this.dispatch(line)
      }
    })
    this.socket.on('error', (error) => {
      for (const waiter of this.pending.values()) waiter({ ok: false, error: `命令通道出错：${String(error.message)}` })
      this.pending.clear()
    })
  }

  private dispatch(line: string): void {
    let message: AnyRecord
    try {
      message = JSON.parse(line) as AnyRecord
    } catch {
      return
    }
    if (message.type === 'console') return
    if (message.type === 'result') {
      const id = Number(message.id)
      const waiter = this.pending.get(id)
      if (waiter !== undefined) {
        this.pending.delete(id)
        waiter(message.value)
      }
    }
  }

  /** 返回驱动给的 value（原探针同款：attr 是 string|null，wait-boot/wait-change 是带 ok 的对象）。 */
  call(cmd: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.seq
    const timeoutMs = Number(extra['clientTimeoutMs'] ?? 60000)
    return new Promise<unknown>((settle, fail) => {
      if (this.socket === null) {
        fail(new Error(`命令通道还没接上：${cmd}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`驱动命令超时：${cmd}`))
      }, timeoutMs)
      this.pending.set(id, (value) => {
        clearTimeout(timer)
        settle(value)
      })
      this.socket.write(`${JSON.stringify({ id, cmd, ...extra })}\n`)
    })
  }

  async quit(): Promise<void> {
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

interface DescribeProbe {
  sentinel?: string
  timeOrigin?: number
  pluginRows?: string[]
  syncFailures?: string[]
  boot?: { plugins?: Record<string, { state?: string }>; requests?: string[] } | null
}

interface HostState {
  child: ChildProcess
  url: string | null
  pending: Map<number, (message: AnyRecord) => void>
  seq: number
  stderr: string[]
}

/** 宿主进程：stdio JSONL（协议）+ 界面服务（DSC_UI_SERVER=1）+ 热更轮询（DSC_UI_HMR=1）。 */
function startHotMountHost(home: string, port: number): HostState {
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'headless.cjs')], {
    cwd: ROOT,
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
  const state: HostState = { child, url: null, pending: new Map(), seq: 0, stderr: [] }
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk)
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
        const message = JSON.parse(line) as AnyRecord
        if (message !== null && typeof message === 'object' && message.type === 'result') {
          const waiter = state.pending.get(Number(message.id))
          if (waiter !== undefined) {
            state.pending.delete(Number(message.id))
            waiter(message)
          }
        }
      } catch {
        // 非协议行（启动日志、界面地址）
      }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    state.stderr.push(
      ...String(chunk)
        .split('\n')
        .filter((line) => line.trim() !== ''),
    )
    if (state.stderr.length > 80) state.stderr.splice(0, state.stderr.length - 80)
  })
  return state
}

/** 经宿主 stdio 调一个运行时方法（与桌面壳同一条协议），返回 { ok, value?, error? }。 */
function hostInvoke(state: HostState, method: string, args: unknown[]): Promise<AnyRecord> {
  const id = ++state.seq
  state.child.stdin?.write(`${JSON.stringify({ type: 'invoke', id, method, args })}\n`)
  return new Promise<AnyRecord>((settle, fail) => {
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
async function waitForDescribe(driver: Driver, predicate: (value: DescribeProbe) => boolean, label: string, timeoutMs = 25000): Promise<DescribeProbe> {
  const startedAt = Date.now()
  for (;;) {
    const value = (await driver.call('describe')) as DescribeProbe
    if (predicate(value)) return value
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等不到：${label}`)
    await sleep(150)
  }
}

describe.skipIf(!fresh.ok)('ui-third-party-hot-mount e2e：安装 → 信任 → 界面当场出现（真机，不刷新）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsc-third-party-'))
  const outDir = join(home, 'out')
  const shot = join(outDir, 'third-party-hot-mount.png')

  let host: HostState | null = null
  let driver: Driver | null = null
  let electron: ChildProcess | null = null
  /** 各阶段的读数：beforeAll 一次取齐，test 只读事实。 */
  const state: {
    uiPort: number | null
    readyUrl: string | null
    bootedOk: boolean
    bootedDetail: unknown
    before: DescribeProbe | null
    untrusted: DescribeProbe | null
    untrustedMark: unknown
    trusted: AnyRecord | null
    settledOk: boolean
    settledDetail: unknown
    after: DescribeProbe | null
    ownMark: unknown
    removed: DescribeProbe | null
    gone: DescribeProbe | null
    shotError: string
    settledDiag: string
  } = {
    uiPort: null,
    readyUrl: null,
    bootedOk: false,
    bootedDetail: null,
    before: null,
    untrusted: null,
    untrustedMark: null,
    trusted: null,
    settledOk: false,
    settledDetail: null,
    after: null,
    ownMark: null,
    removed: null,
    gone: null,
    shotError: '',
    settledDiag: '',
  }

  beforeAll(async () => {
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

    const port = await freePort()
    state.uiPort = port
    host = startHotMountHost(home, port)
    for (let waited = 0; waited < 60000 && host.url === null; waited += 250) await sleep(250)
    if (host.url === null) {
      throw new Error(`宿主没给出界面地址（60s）：${host.stderr.slice(-5).join(' | ')}`)
    }

    const env: Record<string, string | undefined> = { ...process.env, DSC_UI_HMR_USER_DATA: join(home, 'electron-user-data') }
    delete env['ELECTRON_RUN_AS_NODE']
    electron = spawn(ELECTRON, [DRIVER, host.url], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    driver = new Driver(electron)
    const ready = await driver.ready
    await driver.attach(Number(ready['port']))
    state.readyUrl = String(ready['url'] ?? '')

    const booted = (await driver.call('wait-boot', { timeoutMs: 60000, clientTimeoutMs: 75000 })) as AnyRecord
    state.bootedOk = booted['ok'] === true
    state.bootedDetail = booted
    await driver.call('mark', { value: 'third-party-hot-mount' })
    state.before = (await driver.call('describe')) as DescribeProbe

    // 1. 装目录（还没信任）：图里不该有它——第三方界面插件进图的前提是「信任这一份字节」。
    const pluginDir = join(home, '.dsc', 'plugins', PLUGIN)
    mkdirSync(join(pluginDir, 'ui'), { recursive: true })
    // api 写的是对「壳的 @dsc/ui 契约版本」的区间（产物清单顶层 apiVersion，当前就是
    // SHELL_VERSION），不是 pneuma 自己的版本号。写死一个旧区间，抬版本号那天这里会被门禁
    // 当场拒掉（失败关闭），所以按壳版本拼；区间判定本身由 ui-api-gate-test 覆盖。
    writeFileSync(join(pluginDir, 'plugin.json'), `${JSON.stringify({ api: '^' + SHELL_VERSION, platforms: ['web'] }, null, 2)}\n`, 'utf8')
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
    state.untrusted = (await driver.call('describe')) as DescribeProbe
    state.untrustedMark = await driver.call('attr', { selector: 'html', name: 'data-demo-hot' })

    // 2. 信任：与插件中心那颗「确认信任」同一个方法（runtime.setUiTrust）。
    const trusted = await hostInvoke(host, 'setUiTrust', [PLUGIN])
    state.trusted = trusted
    // 3. 不刷新，界面当场装载（信任成功会发 dsc/ui-graph-dirty → 推帧 → 壳对账）。
    const settled = (await driver.call('wait-change', { plugin: PLUGIN, from: '', timeoutMs: 30000, clientTimeoutMs: 35000 })) as AnyRecord
    state.settledOk = settled['ok'] === true
    state.settledDetail = settled
    state.after = (await driver.call('describe')) as DescribeProbe
    if (settled['ok'] !== true || state.after?.boot?.plugins?.[PLUGIN] === undefined) {
      // 红的时候别让人猜：把宿主图与页内账本一起摆出来（图里有、账本没有 = 壳侧对账的问题；
      // 两边都没有 = 宿主组图的问题）。
      const graph = (await driver.call('graph').catch((error: Error) => ({ entries: String(error) }))) as AnyRecord
      const parts = [
        `宿主图里的行：${JSON.stringify(graph.entries)}`,
        `页内账本：${JSON.stringify(state.after?.boot?.plugins ?? null).slice(0, 1500)}`,
        `页内请求：${JSON.stringify((state.after?.boot?.requests ?? []).slice(-8))}`,
        `驱动 wait-change 读数：${JSON.stringify(settled)}`,
      ]
      state.settledDiag = parts.join('\n')
    }
    state.ownMark = await driver.call('attr', { selector: 'html', name: 'data-demo-hot' })

    // 4. 删目录：热更轮询按图行 stat `ui/client.js`，文件没了 → 换图 → 页面卸载它。
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      state.removed = await waitForDescribe(
        driver,
        (value) => value.boot !== null && value.boot?.plugins?.[PLUGIN]?.state === 'removed',
        '删掉目录之后这一行被卸载',
        20000,
      )
    } catch (error) {
      state.removed = { boot: null, sentinel: `等不到卸载：${String(error)}` }
    }
    state.gone = (await driver.call('describe')) as DescribeProbe

    try {
      await driver.call('shot', { file: shot })
    } catch (error) {
      state.shotError = String(error)
    }
  }, 600_000)

  afterAll(async () => {
    if (driver !== null) await driver.quit()
    try {
      host?.child.kill()
    } catch {
      // 已经退了
    }
    // 原探针：失败现场留着（打印隔离 HOME 路径），绿了才删。
    const clean = state.removed?.boot?.plugins?.[PLUGIN]?.state === 'removed' && state.shotError === ''
    if (clean) rmSync(home, { recursive: true, force: true })
    else console.log(`隔离 HOME 留在 ${home}（失败现场）`)
  })

  const pluginState = (probe: DescribeProbe | null): { state?: string } | undefined => probe?.boot?.plugins?.[PLUGIN]

  test('真机驱动在（scripts/_ui-hmr-machine-main.cjs）', () => {
    expect(existsSync(DRIVER), DRIVER).toBe(true)
  })
  test('宿主起来了并给出界面地址（gate：beforeAll 抛错时整组红）', () => {
    expect(host?.url !== null, host?.stderr.slice(-5).join(' | ') ?? '').toBe(true)
  })
  test('真浏览器加载的就是宿主伺服的页面', () => {
    const uiPort = state.uiPort
    expect(state.readyUrl !== null && state.readyUrl.includes(`:${String(uiPort)}/`), String(state.readyUrl ?? '')).toBe(true)
  })
  test('页面启动落定（插件都装上或明确失败）', () => {
    expect(state.bootedOk, JSON.stringify(state.bootedDetail)).toBe(true)
  })
  test('哨兵已就位（刷新就丢的标记）', () => {
    expect(state.before?.sentinel, String(state.before?.sentinel ?? '')).toBe('third-party-hot-mount')
  })
  test('基线账本里没有这个第三方插件', () => {
    expect(state.before?.boot !== null && state.before?.boot?.plugins?.[PLUGIN] === undefined, JSON.stringify(Object.keys(state.before?.boot?.plugins ?? {}))).toBe(true)
  })
  test('未信任时启动图里没有它', () => {
    expect(state.untrusted?.boot !== null && state.untrusted?.boot?.plugins?.[PLUGIN] === undefined, JSON.stringify(Object.keys(state.untrusted?.boot?.plugins ?? {}))).toBe(true)
  })
  test('未信任时页面上没有它的装载行', () => {
    expect(state.untrusted?.pluginRows?.includes(PLUGIN), (state.untrusted?.pluginRows ?? []).join('、')).toBe(false)
  })
  test('未信任时它自己的代码一行都没执行（没有 data-demo-hot）', () => {
    expect(state.untrustedMark, String(state.untrustedMark)).toBeNull()
  })
  test('setUiTrust 返回成功（信任落盘）', () => {
    const trusted = state.trusted ?? {}
    expect(
      trusted['ok'] === true && (trusted['value'] as AnyRecord | undefined)?.['ok'] === true,
      JSON.stringify(trusted['value'] ?? trusted['error']),
    ).toBe(true)
  })
  test('信任之后这一行被装上了（不重启、不刷新）', () => {
    const detail = state.settledDiag === '' ? JSON.stringify(state.settledDetail) : state.settledDiag
    expect(state.settledOk, detail).toBe(true)
  })
  test('页内哨兵没丢（页面没刷新）', () => {
    expect(state.after?.sentinel, String(state.after?.sentinel ?? '')).toBe('third-party-hot-mount')
  })
  test('timeOrigin 未变（页面没刷新）', () => {
    expect(state.after?.timeOrigin, `${String(state.after?.timeOrigin)} vs ${String(state.before?.timeOrigin)}`).toBe(state.before?.timeOrigin)
  })
  test('账本里这条是 loaded', () => {
    expect(pluginState(state.after)?.state, JSON.stringify(pluginState(state.after) ?? null)).toBe('loaded')
  })
  test('DOM 里出现了它的装载行', () => {
    expect(state.after?.pluginRows?.includes(PLUGIN), (state.after?.pluginRows ?? []).join('、')).toBe(true)
  })
  test('插件自己的 apply 真的执行了（页面上有它写的 data-demo-hot）', () => {
    expect(state.ownMark, String(state.ownMark)).toBe('v1')
  })
  test('页内没有同步失败', () => {
    expect(state.after?.syncFailures ?? [], (state.after?.syncFailures ?? []).join('、')).toEqual([])
  })
  test('删掉插件目录之后页面当场卸载它（图少一条 + 账本 removed）', () => {
    const detail = JSON.stringify(state.removed?.sentinel ?? pluginState(state.removed) ?? null)
    expect(state.removed?.boot !== undefined && pluginState(state.removed)?.state === 'removed', detail).toBe(true)
  })
  test('DOM 里的装载行也消失了', () => {
    expect(state.gone?.pluginRows?.includes(PLUGIN), (state.gone?.pluginRows ?? []).join('、')).toBe(false)
  })
  test('截图在', () => {
    expect(state.shotError === '' && existsSync(shot), state.shotError === '' ? shot : state.shotError).toBe(true)
  })
})
