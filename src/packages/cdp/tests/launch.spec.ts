/**
 * 受控浏览器的启动面（`packages/cdp/launch.ts`）：探测、参数、端点文件、重连账与清理。
 *
 * 真起 Chrome 归集成层（需要一台装了浏览器的机器）；这里钉的是启动前后那些纯判断与
 * 文件/HTTP 读取：路径优先级、`DevToolsActivePort` 的容忍度、端点等待的退路与超时、
 * 重连/重开额度、profile 目录清理。`fetch` 走本机临时 HTTP 服务，不碰外网。
 *
 * @module dsc/packages/cdp/tests/launch.spec
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildLaunchArgs,
  candidateExecutables,
  fetchBrowserWebSocket,
  killProcessTree,
  launchBrowser,
  parseDevToolsActivePort,
  probeEnv,
  probeExecutable,
  reconnectDecision,
  ReconnectBudget,
  removeProfileDirSync,
  sleepSync,
  waitForEndpoint,
  type BrowserLaunchConfig,
  type BrowserProbeEnv,
} from '../launch.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-cdp-launch-'))
  dirs.push(dir)
  return dir
}

const ENV: BrowserProbeEnv = {
  localAppData: 'C:\\Users\\u\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
}

const CONFIG: BrowserLaunchConfig = { executablePath: '', profileDir: '', headless: true }

describe('探测浏览器可执行文件', () => {
  test('probeEnv 读三个安装根；缺省值兜底', () => {
    const saved = {
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ProgramFiles: process.env.ProgramFiles,
      PROGRAMFILES: process.env.PROGRAMFILES,
      'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    }
    try {
      process.env.LOCALAPPDATA = 'L'
      delete process.env.ProgramFiles
      delete process.env.PROGRAMFILES
      delete process.env['ProgramFiles(x86)']
      expect(probeEnv()).toEqual({
        localAppData: 'L',
        programFiles: 'C:\\Program Files',
        programFilesX86: 'C:\\Program Files (x86)',
      })
      process.env.ProgramFiles = 'PF'
      process.env['ProgramFiles(x86)'] = 'PFX'
      expect(probeEnv()).toMatchObject({ programFiles: 'PF', programFilesX86: 'PFX' })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('候选顺序：Program Files 的 Chrome → Edge，再退用户级安装；没有 localAppData 就少两条', () => {
    const list = candidateExecutables(ENV)
    expect(list[0]).toBe(join(ENV.programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    expect(list[1]).toBe(join(ENV.programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    expect(list[2]).toBe(join(ENV.programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    expect(list).toHaveLength(5)
    expect(candidateExecutables({ ...ENV, localAppData: '' })).toHaveLength(3)
  })

  test('配置的路径优先但要存在；否则按候选顺序取第一个存在的；都没有给 null', () => {
    const configured = 'C:\\custom\\chrome.exe'
    expect(probeExecutable({ ...CONFIG, executablePath: configured }, { exists: (path) => path === configured })).toBe(
      configured,
    )
    expect(probeExecutable({ ...CONFIG, executablePath: configured }, { exists: () => false })).toBeNull()

    const candidates = candidateExecutablePaths()
    const third = candidates[2] as string
    expect(probeExecutable(CONFIG, { env: ENV, exists: (path) => path === third })).toBe(third)
    expect(probeExecutable(CONFIG, { env: ENV, exists: () => false })).toBeNull()
  })
})

function candidateExecutablePaths(): string[] {
  return candidateExecutables(ENV)
}

describe('启动参数', () => {
  test('固定开关 + profile 目录；headless 才加 --headless=new；about:blank 在最后', () => {
    const headless = buildLaunchArgs(CONFIG, 'C:\\p')
    expect(headless).toEqual([
      '--remote-debugging-port=0',
      '--user-data-dir=C:\\p',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      'about:blank',
    ])
    expect(buildLaunchArgs({ ...CONFIG, headless: false }, 'C:\\p')).not.toContain('--headless=new')
    expect(headless.at(-1)).toBe('about:blank')
  })
})

describe('DevToolsActivePort 与端点等待', () => {
  test('端口合法才认；第二行必须是 / 开头，缺行给空串', () => {
    expect(parseDevToolsActivePort('9333\n/devtools/browser/abc')).toEqual({
      port: 9333,
      browserPath: '/devtools/browser/abc',
    })
    expect(parseDevToolsActivePort(' 9333 \r\n')).toEqual({ port: 9333, browserPath: '' })
    expect(parseDevToolsActivePort('9333\nnot-a-path')).toEqual({ port: 9333, browserPath: '' })
    expect(parseDevToolsActivePort('')).toBeNull()
    expect(parseDevToolsActivePort('0')).toBeNull()
    expect(parseDevToolsActivePort('65536')).toBeNull()
    expect(parseDevToolsActivePort('1.5')).toBeNull()
    expect(parseDevToolsActivePort('abc')).toBeNull()
  })

  test('文件里带路径：直接拼 ws 地址；probe 说连不上就继续等到超时', async () => {
    const dir = workdir()
    writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n', 'utf8')
    await expect(waitForEndpoint(dir, { timeoutMs: 300 })).resolves.toBe('ws://127.0.0.1:9333/devtools/browser/abc')

    await expect(
      waitForEndpoint(dir, { timeoutMs: 150, intervalMs: 30, probe: () => false }),
    ).rejects.toThrow(/端点存在但连不上/)
  })

  test('文件只有端口：退回 /json/version 取 webSocketDebuggerUrl', async () => {
    const { server, port } = await versionServer({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/browser/from-http',
    })
    try {
      const dir = workdir()
      writeFileSync(join(dir, 'DevToolsActivePort'), `${String(port)}\n`, 'utf8')
      await expect(waitForEndpoint(dir, { timeoutMs: 3_000, intervalMs: 20 })).resolves.toBe(
        'ws://127.0.0.1:9999/devtools/browser/from-http',
      )
    } finally {
      await closeServer(server)
    }
  })

  test('没有文件 / 内容不合法 / 取消：分别给超时原因与取消', async () => {
    const empty = workdir()
    await expect(waitForEndpoint(empty, { timeoutMs: 100, intervalMs: 20 })).rejects.toThrow(
      /等浏览器调试端点超时.*还没出现/,
    )

    const bad = workdir()
    writeFileSync(join(bad, 'DevToolsActivePort'), 'abc', 'utf8')
    await expect(waitForEndpoint(bad, { timeoutMs: 100, intervalMs: 20 })).rejects.toThrow(/还不是合法端口/)

    const controller = new AbortController()
    controller.abort()
    await expect(waitForEndpoint(empty, { timeoutMs: 1_000, signal: controller.signal })).rejects.toThrow()
  })

  test('fetchBrowserWebSocket：200 给地址；非 200 与缺字段各有错误', async () => {
    const ok = await versionServer({ webSocketDebuggerUrl: 'ws://x/y' })
    try {
      await expect(fetchBrowserWebSocket(ok.port, 2_000)).resolves.toBe('ws://x/y')
    } finally {
      await closeServer(ok.server)
    }

    const denied = await versionServer({}, 500)
    try {
      await expect(fetchBrowserWebSocket(denied.port, 2_000)).rejects.toThrow(/HTTP 500/)
    } finally {
      await closeServer(denied.server)
    }

    const missing = await versionServer({})
    try {
      await expect(fetchBrowserWebSocket(missing.port, 2_000)).rejects.toThrow(/没有 webSocketDebuggerUrl/)
    } finally {
      await closeServer(missing.server)
    }
  })
})

describe('启动失败与清理', () => {
  test('找不到浏览器 / 配置的路径不存在：不 spawn，直接给能照做的错', async () => {
    await expect(
      launchBrowser(CONFIG, new AbortController().signal, { env: ENV, exists: () => false }),
    ).rejects.toThrow(/没找到 Chrome 或 Edge.*executablePath/)
    await expect(
      launchBrowser(
        { ...CONFIG, executablePath: 'C:\\nope\\chrome.exe' },
        new AbortController().signal,
        { exists: () => false },
      ),
    ).rejects.toThrow(/配置的浏览器路径不存在/)
  })

  test('killProcessTree 只认正整数；removeProfileDirSync 幂等；sleepSync 0 立刻返回', () => {
    expect(() => killProcessTree(0)).not.toThrow()
    expect(() => killProcessTree(-1)).not.toThrow()
    expect(() => killProcessTree(1.5)).not.toThrow()

    const dir = workdir()
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'x'), 'x', 'utf8')
    removeProfileDirSync(dir)
    expect(existsSync(dir)).toBe(false)
    expect(() => removeProfileDirSync(dir)).not.toThrow()

    const start = Date.now()
    sleepSync(0)
    expect(Date.now() - start).toBeLessThan(100)
  })

  test('重连决策：进程活着且有余量才重连，否则能重开就重开，都不行就失败', () => {
    expect(reconnectDecision({ processAlive: true, canReconnect: true, canRestart: true })).toBe('reconnect')
    expect(reconnectDecision({ processAlive: true, canReconnect: false, canRestart: true })).toBe('restart')
    expect(reconnectDecision({ processAlive: false, canReconnect: true, canRestart: true })).toBe('restart')
    expect(reconnectDecision({ processAlive: false, canReconnect: true, canRestart: false })).toBe('fail')
  })

  test('ReconnectBudget：重连用满 5 次、重开用满 2 次；重开清空重连额度；reset 全清', () => {
    const budget = new ReconnectBudget(2, 1)
    expect(budget.canReconnect()).toBe(true)
    budget.noteReconnect()
    budget.noteReconnect()
    expect(budget.canReconnect()).toBe(false)
    expect(budget.reconnects).toBe(2)

    budget.noteRestart()
    expect(budget.restarts).toBe(1)
    expect(budget.canRestart()).toBe(false)
    expect(budget.reconnects).toBe(0)

    budget.reset()
    expect(budget).toMatchObject({ restarts: 0, reconnects: 0 })
  })
})

// ── 测试用的小 HTTP 服务（/json/version） ─────────────────────────────────────

async function versionServer(body: Record<string, unknown>, status = 200): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('服务没监听在端口上')
  return { server, port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((done) => server.close(() => done()))
}
