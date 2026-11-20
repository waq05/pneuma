/**
 * cdp 包收尾缺口：launch 的重连失败/取消、`killProcessTree` 的 POSIX 分支、
 * actions 里预取消的睡眠、transport 的内置 WebSocket 工厂。
 *
 * 三条重连用例都在「进程还活着但 CDP 连接断了」的状态上跑：`launched` / `transport`
 * 是 BrowserProcess 的私有字段，这里直接按运行时形状填（不 spawn 真浏览器），
 * 假 socket 一连就报错，于是重连额度、回退延时与错误文案都能逐条钉住。
 *
 * @module @pneuma/cdp/tests/w14-tail-gaps.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BrowserProcess, killProcessTree, waitForEndpoint, type LaunchedBrowser } from '../launch.js'
import { CdpTransport, type CdpCommandTarget, type CdpSocket } from '../transport.js'
import { waitForPageLoad } from '../actions.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 偶发 EPERM：留给系统清
    }
  }
})

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-cdp-w14-'))
  dirs.push(dir)
  return dir
}

const CONFIG = (): { executablePath: string; profileDir: string; headless: boolean } => ({
  executablePath: 'C:\\fake\\chrome.exe',
  profileDir: '',
  headless: true,
})

/** 一连上就失败的假 socket：`onerror` 赋值后下一拍报错，CdpTransport.open 随即拒绝。 */
class ErrorSocket implements CdpSocket {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  private errorHandler: ((event: unknown) => void) | null = null

  get onerror(): ((event: unknown) => void) | null {
    return this.errorHandler
  }

  set onerror(handler: ((event: unknown) => void) | null) {
    this.errorHandler = handler
    if (handler !== null) queueMicrotask(() => handler({}))
  }

  send(): void {}

  close(): void {}
}

/** BrowserProcess 的私有字段在运行期就是普通属性：按形状填，避免真起浏览器。 */
interface BrowserProcessHole {
  launched: LaunchedBrowser | null
  transport: { closed: boolean } | null
  budget: { reconnects: number; restarts: number; noteRestart(): void }
}

const holeOf = (proc: BrowserProcess): BrowserProcessHole => proc as unknown as BrowserProcessHole

/** 造一个「进程活着、连接已断」的 BrowserProcess。 */
function brokenProcess(): BrowserProcess {
  const proc = new BrowserProcess(() => CONFIG(), { socketFactory: () => new ErrorSocket(), label: '测试连接' })
  const hole = holeOf(proc)
  hole.launched = {
    exe: 'C:\\fake\\chrome.exe',
    pid: 0,
    profileDir: '',
    ownedProfile: false,
    endpoint: 'ws://127.0.0.1:1/devtools/browser/x',
    isAlive: () => true,
  }
  hole.transport = { closed: true }
  return proc
}

describe('waitForEndpoint 的读文件失败', () => {
  test('DevToolsActivePort 是个目录（readFileSync 抛 EISDIR）时不崩，照常等到超时', async () => {
    const dir = workdir()
    mkdirSync(join(dir, 'DevToolsActivePort'))
    // 目录上的 readFileSync 抛 EISDIR；这条分支读完会把原因覆盖成「内容不合法」，
    // 外部能看到的只有超时文案——所以钉的是「没被这个异常打断」。
    await expect(waitForEndpoint(dir, { timeoutMs: 50, intervalMs: 10 })).rejects.toThrow(/等浏览器调试端点超时/)
  })
})

describe('BrowserProcess 重连失败', () => {
  test('三次重连都失败：报「第 1 次重连也没成功」并记一次重连额度', async () => {
    const proc = brokenProcess()
    await expect(proc.browserTransport()).rejects.toThrow(/CDP 连接断了，第 1 次重连也没成功/)
    expect(holeOf(proc).budget.reconnects).toBe(1)
  })

  test('重连回退期间被取消：延时立刻结束，错误里带取消原因', async () => {
    const proc = brokenProcess()
    const controller = new AbortController()
    const pending = proc.browserTransport(controller.signal)
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toThrow(/操作已取消/)
    await expect(pending).rejects.toThrow(/CDP 连接断了/)
  })

  test('传进来的 signal 已经取消：第一次回退延时立刻拒绝', async () => {
    const proc = brokenProcess()
    const controller = new AbortController()
    controller.abort()
    await expect(proc.browserTransport(controller.signal)).rejects.toThrow(/操作已取消/)
  })

  test('进程死了且重开额度用完：直接报「反复退出或连不上」', async () => {
    const proc = new BrowserProcess(() => CONFIG(), { socketFactory: () => new ErrorSocket() })
    const hole = holeOf(proc)
    hole.launched = null
    hole.transport = null
    hole.budget.noteRestart()
    hole.budget.noteRestart()
    await expect(proc.browserTransport()).rejects.toThrow(/受控浏览器反复退出或连不上/)
  })
})

describe('killProcessTree 的 POSIX 分支', () => {
  test('非 win32 走 process.kill 的 SIGKILL', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      killProcessTree(4321)
      expect(kill).toHaveBeenCalledWith(4321, 'SIGKILL')
    } finally {
      kill.mockRestore()
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }
  })
})

describe('actions 里预取消的睡眠', () => {
  test('waitForPageLoad 拿到已取消的 signal：不再轮询，直接报取消', async () => {
    let reads = 0
    const target: CdpCommandTarget = {
      sessionId: 'w14',
      send: async <T>() => {
        reads += 1
        return { result: { value: { readyState: 'loading' } } } as T
      },
      on: () => () => undefined,
    }
    await expect(waitForPageLoad(target, 5_000, AbortSignal.abort())).rejects.toThrow(/操作已取消/)
    expect(reads).toBe(1)
  })
})

describe('transport 的内置 WebSocket 工厂', () => {
  test('没注入 socketFactory 时用全局 WebSocket 建连；取消后拒绝', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(CdpTransport.open('ws://127.0.0.1:1/devtools/browser/x', {}, controller.signal)).rejects.toThrow(/建连被取消/)
  })
})
