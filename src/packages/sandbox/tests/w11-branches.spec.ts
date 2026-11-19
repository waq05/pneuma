/**
 * 沙箱长尾分支自检（W11）：`policy.ts` 的解析/判定分支 + `win/setup.ts` 的
 * 互斥体与三路结论残部。
 *
 * policy 全部是纯函数（除了 realpath），路径用真实的临时目录 + 少量 Windows 形状串；
 * 不存在的盘符在用例里现找（找不到就跳过那一条）。setup 的 `node:child_process` 换成
 * 可编排的假子进程、`win/ffi.js` 换成可控底座：不弹 UAC、不创建真实账号、不碰系统。
 *
 * @module @pneuma/sandbox/tests/w11-branches
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** 假子进程脚本：close = 正常结束（code 可为 null），error = spawn 失败，throw = 同步抛，hang = 永不返回。 */
interface SpawnBehavior {
  kind: 'close' | 'error' | 'throw' | 'hang'
  code?: number | null
  stdout?: string
  /** 分块写 stdout（测「输出封顶」那条分支）。 */
  stdoutChunks?: string[]
  stderr?: string
  message?: string
  beforeClose?: () => void
}

const spawnState = vi.hoisted(() => ({
  behaviors: [] as SpawnBehavior[],
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      const behavior = spawnState.behaviors.shift() ?? { kind: 'close' as const }
      spawnState.calls.push({ file, args, options })
      if (behavior.kind === 'throw') throw new Error(behavior.message ?? 'spawn 同步炸了')
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: ReturnType<typeof vi.fn>
        unref: ReturnType<typeof vi.fn>
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn(() => true)
      child.unref = vi.fn()

      if (behavior.kind === 'close') {
        setTimeout(() => {
          if (behavior.stdout !== undefined) child.stdout.write(behavior.stdout)
          for (const [index, chunk] of (behavior.stdoutChunks ?? []).entries()) {
            setTimeout(() => child.stdout.write(chunk), index * 2)
          }
          if (behavior.stderr !== undefined) child.stderr.write(behavior.stderr)
          setTimeout(() => {
            behavior.beforeClose?.()
            child.stdout.end()
            child.stderr.end()
            child.emit('close', behavior.code === undefined ? 0 : behavior.code)
          }, 20)
        }, 1)
      } else if (behavior.kind === 'error') {
        setTimeout(() => child.emit('error', new Error(behavior.message ?? 'spawn 失败')), 1)
      }
      return child
    },
  }
})

/** 可控 FFI 底座：只保留 setup 用到的几个入口 + account.js 的命名导入。 */
const ffiState = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'ffi-off' | 'bind-throws' | 'no-handle' | 'create-throws',
  lastError: 0,
  lastErrorThrows: false,
  releaseThrows: false,
  closeThrows: false,
  releaseCalls: 0,
  closeCalls: 0,
}))

/** WFP 探测的假 fwpuclnt：每次调用现读状态，所以绑定缓存一次也能逐用例换结论。 */
const wfpState = vi.hoisted(() => ({
  bindThrows: false,
  openCode: 0,
  engine: 0x77,
  openThrows: false,
  subCode: 0,
  subThrows: false,
  layerCode: 0,
  layerThrows: false,
  closeThrows: false,
  freeCalls: 0,
  closeCalls: 0,
}))

vi.mock('../win/ffi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/ffi.js')>()
  const dispatchWfp = (name: string): ((...args: unknown[]) => unknown) => {
    switch (name) {
      case 'FwpmEngineOpen0':
        return (...args: unknown[]) => {
          if (wfpState.openThrows) throw new Error('engine open 炸了')
          const slot = args[4] as { v: number }
          slot.v = wfpState.engine
          return wfpState.openCode
        }
      case 'FwpmEngineClose0':
        return () => {
          wfpState.closeCalls += 1
          if (wfpState.closeThrows) throw new Error('engine close 炸了')
        }
      case 'FwpmSubLayerGetByKey0':
        return () => {
          if (wfpState.subThrows) throw new Error('sublayer 查询炸了')
          return wfpState.subCode
        }
      case 'FwpmLayerGetByKey0':
        return (...args: unknown[]) => {
          if (wfpState.layerThrows) throw new Error('layer 查询炸了')
          ;(args[2] as { v: number }).v = 1
          return wfpState.layerCode
        }
      case 'FwpmFreeMemory0':
        return () => {
          wfpState.freeCalls += 1
        }
      default:
        return () => 0
    }
  }
  const fakeKoffi = {
    load: () => ({ func: (_convention: string, name: string) => dispatchWfp(name) }),
    alloc: () => ({ v: 0 }),
    decode: (slot: unknown) =>
      typeof slot === 'object' && slot !== null && 'v' in slot ? (slot as { v: number }).v : 0,
    address: () => 0n,
    errno: () => 0,
  }
  const bound = {
    koffi: fakeKoffi,
    formatMessageW: () => 0,
    createMutexW: () => {
      if (ffiState.mode === 'create-throws') throw new Error('CreateMutexW 炸了')
      if (ffiState.mode === 'no-handle') return 0
      return 77
    },
    getLastLastError: () => {
      if (ffiState.lastErrorThrows) throw new Error('读不到 LastError')
      return ffiState.lastError
    },
    closeHandle: () => {
      ffiState.closeCalls += 1
      if (ffiState.closeThrows) throw new Error('CloseHandle 失败')
      return 1
    },
    releaseMutex: () => {
      ffiState.releaseCalls += 1
      if (ffiState.releaseThrows) throw new Error('ReleaseMutex 失败')
      return 1
    },
  }
  return {
    ...actual,
    tryLoadFfi: () =>
      ffiState.mode === 'ffi-off'
        ? ({ ok: false, why: '测试里关掉 FFI' } as const)
        : ({ ok: true, ffi: { fake: true } } as const),
    loadFfi: () => ({ fake: true }),
    bindAll: () => {
      if (ffiState.mode === 'bind-throws' || wfpState.bindThrows) throw new Error('绑定失败')
      return bound
    },
  }
})

import * as policy from '../policy.js'
import * as setup from '../win/setup.js'
import * as sweep from '../win/sweep.js'
import { guidStringToBuffer, probeWfpSublayer } from '../win/wfp.js'
import {
  CONTAINER_ENV_PASSTHROUGH,
  createDockerRunner,
  probeDocker,
  unwrapShellCommand,
} from '../backends.js'
import { FWP_E_LAYER_NOT_FOUND, FWP_E_SUBLAYER_NOT_FOUND } from '../win/net-abi.js'
import { sandboxDir, setupScriptPath, setupStatePath } from '../win/account.js'
import type { SpawnPlan } from '../../../core/tools/command-runner.js'

const ORIGINAL_PLATFORM = process.platform
/** 当前跑在 Windows 上吗：反斜杠 / 盘符路径的用例依赖 node:path 的 win32 语义，只在 win32 上有意义。 */
const WIN32 = ORIGINAL_PLATFORM === 'win32'
const homes: string[] = []

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  }
}

function tempHome(prefix = 'dsc-w11-policy-'): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  homes.push(home)
  return home
}

/** 找一个本机确实不存在的盘符（不存在才拿得到 unresolvable 分支）。 */
function findAbsentDrive(): string | null {
  for (const letter of ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'N', 'O', 'P']) {
    const root = `${letter}:\\`
    try {
      realpathSync.native(root)
    } catch {
      return root
    }
  }
  return null
}

/**
 * 一个本机确实不存在的盘符（不存在才拿得到 unresolvable 分支）。
 *
 * 只在 win32 上找：POSIX 上「盘符路径」不是绝对路径，会被 resolve 到 cwd 下，永远解析得出来，
 * 那个 unresolvable 分支在 Linux 上根本走不到。
 */
const ABSENT_DRIVE = WIN32 ? findAbsentDrive() : null

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  spawnState.behaviors.length = 0
  spawnState.calls.length = 0
  ffiState.mode = 'ok'
  ffiState.lastError = 0
  ffiState.lastErrorThrows = false
  ffiState.releaseThrows = false
  ffiState.closeThrows = false
  ffiState.releaseCalls = 0
  ffiState.closeCalls = 0
  wfpState.bindThrows = false
  wfpState.openCode = 0
  wfpState.engine = 0x77
  wfpState.openThrows = false
  wfpState.subCode = 0
  wfpState.subThrows = false
  wfpState.layerCode = 0
  wfpState.layerThrows = false
  wfpState.closeThrows = false
  wfpState.freeCalls = 0
  wfpState.closeCalls = 0
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
})

afterAll(() => {
  for (const home of homes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      // 临时目录交给系统清。
    }
  }
})

// ── resolveSandboxConfig：每个坏值都回落默认 + 报一句 ──────────────────────

describe('resolveSandboxConfig', () => {
  test('非对象 / 数组 / null 一律给默认配置', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      const result = policy.resolveSandboxConfig(raw)
      expect(result.config).toEqual(policy.DEFAULT_SANDBOX_CONFIG)
      expect(result.problems).toEqual([])
      expect(result.explicitBackend).toBe(false)
    }
  })

  test('所有控件都给坏值：九条问题逐条说清楚，配置仍是默认', () => {
    const result = policy.resolveSandboxConfig({
      mode: 'yolo',
      networkAccess: 'yes',
      extraWritableRoots: 42,
      readOnlySubpaths: {},
      networkAllowlist: 42,
      backend: 'nsjail',
      image: 'has space',
      onUnavailable: 'explode',
      grantCacheRoots: 'yes',
    })
    expect(result.config.mode).toBe('workspace-write')
    expect(result.config.backend).toBe('policy')
    expect(result.config.onUnavailable).toBe('degrade')
    expect(result.config.image).toBe(policy.DEFAULT_SANDBOX_IMAGE)
    expect(result.config.networkAccess).toBe(false)
    expect(result.config.grantCacheRoots).toBe(true)
    expect(result.problems).toHaveLength(9)
    expect(result.problems.join('\n')).toContain('档位只能是')
    expect(result.problems.join('\n')).toContain('网络开关要 true/false')
    expect(result.problems.join('\n')).toContain('extraWritableRoots 要一个字符串数组')
    expect(result.problems.join('\n')).toContain('readOnlySubpaths 要一个字符串数组')
    expect(result.problems.join('\n')).toContain('networkAllowlist 要字符串数组')
    expect(result.problems.join('\n')).toContain('后端只能是')
    expect(result.problems.join('\n')).toContain('容器镜像名')
    expect(result.problems.join('\n')).toContain('「后端建不起来时」只能是')
    expect(result.problems.join('\n')).toContain('「缓存目录也放行」要 true/false')
  })

  test('数组与分号文本都接受；空白项过滤、重复项去掉', () => {
    const arrayForm = policy.resolveSandboxConfig({
      extraWritableRoots: ['C:\\a', '  ', 'C:\\b'],
      readOnlySubpaths: ['C:\\ro', ''],
    })
    expect(arrayForm.config.extraWritableRoots).toEqual(['C:\\a', 'C:\\b'])
    expect(arrayForm.config.readOnlySubpaths).toEqual(['C:\\ro'])

    const textForm = policy.resolveSandboxConfig({
      extraWritableRoots: 'C:\\a; C:\\b\nC:\\a;;',
      readOnlySubpaths: 'C:\\ro\r\nC:\\ro2',
    })
    expect(textForm.config.extraWritableRoots).toEqual(['C:\\a', 'C:\\b'])
    expect(textForm.config.readOnlySubpaths).toEqual(['C:\\ro', 'C:\\ro2'])
  })

  test('白名单：数组/文本逐项校验，坏项进 problems，归一后去重', () => {
    const arrayForm = policy.resolveSandboxConfig({
      networkAllowlist: ['API.Example.COM.', 'api.example.com', 'http://x/y', '', '*..bad'],
    })
    expect(arrayForm.config.networkAllowlist).toEqual(['api.example.com'])
    expect(arrayForm.problems).toHaveLength(1)
    expect(arrayForm.problems[0]).toContain('不像域名')

    const textForm = policy.resolveSandboxConfig({ networkAllowlist: 'a.example.com; *.cdn.example.com; bad_entry' })
    expect(textForm.config.networkAllowlist).toEqual(['a.example.com', '*.cdn.example.com'])
    expect(textForm.problems[0]).toContain('bad_entry')
  })

  test('合法值原样收下；显式 backend 键标记 explicitBackend', () => {
    const result = policy.resolveSandboxConfig({
      mode: 'read-only',
      networkAccess: false,
      backend: 'docker',
      image: 'ubuntu:22.04',
      onUnavailable: 'fail-closed',
      grantCacheRoots: false,
    })
    expect(result.explicitBackend).toBe(true)
    expect(result.config).toMatchObject({
      mode: 'read-only',
      networkAccess: false,
      backend: 'docker',
      image: 'ubuntu:22.04',
      onUnavailable: 'fail-closed',
      grantCacheRoots: false,
    })
    expect(result.problems).toEqual([])
  })

  test('空镜像名 / 纯空白镜像名都报问题', () => {
    for (const image of ['', '   ']) {
      const result = policy.resolveSandboxConfig({ image })
      expect(result.problems).toHaveLength(1)
      expect(result.config.image).toBe(policy.DEFAULT_SANDBOX_IMAGE)
    }
  })
})

// ── 缓存目录候选：平台 / 环境变量 / 存在性 ─────────────────────────────────

describe('缓存目录白名单', () => {
  test('非 win32 给空数组（这份清单只服务受限令牌后端）', () => {
    expect(policy.cacheRootCandidates('linux', { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U' })).toEqual([])
    expect(policy.existingCacheRoots('darwin', {}, () => true)).toEqual([])
  })

  test('win32：按 LOCALAPPDATA / USERPROFILE 拼，缺变量跳过', () => {
    const all = policy.cacheRootCandidates('win32', { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U' })
    expect(all).toHaveLength(11)
    // 期望值也用 join 拼：实现里走的是 node:path，Windows 上给反斜杠、Linux 上给正斜杠，两边都该过。
    expect(all[0]).toBe(join('C:\\L', 'npm-cache'))
    expect(all).toContain(join('C:\\U', '.cargo', 'registry', 'cache'))
    expect(all).toContain(join('C:\\U', '.cache', 'pnpm'))

    const onlyLocal = policy.cacheRootCandidates('win32', { LOCALAPPDATA: 'C:\\L' })
    expect(onlyLocal).toHaveLength(4)
    expect(onlyLocal.every((path) => path.startsWith('C:\\L'))).toBe(true)
    expect(policy.cacheRootCandidates('win32', {})).toEqual([])
  })

  test('existingCacheRoots：只留存在的，顺序保持候选顺序', () => {
    const env = { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U' }
    const exists = (path: string): boolean => path.includes('npm-cache') || path.includes('pip')
    const kept = policy.existingCacheRoots('win32', env, exists)
    expect(kept).toEqual([
      join('C:\\L', 'npm-cache'),
      join('C:\\L', 'pip', 'Cache'),
      join('C:\\U', '.cache', 'pip'),
    ])
    expect(policy.existingCacheRoots('win32', env, () => false)).toEqual([])
  })
})

// ── 文本与白名单纯函数 ────────────────────────────────────────────────────

describe('路径清单文本', () => {
  test('parsePathListText 去空、去重、两种换行都认', () => {
    expect(policy.parsePathListText('A; B\nA;;C\r\nD\r')).toEqual(['A', 'B', 'C', 'D'])
    expect(policy.parsePathListText('')).toEqual([])
  })

  test('formatPathList 用分号+空格拼回去', () => {
    expect(policy.formatPathList(['A', 'B'])).toBe('A; B')
    expect(policy.formatPathList([])).toBe('')
  })
})

describe('normalizeAllowlistEntry / parseAllowlist / allowlistMatches', () => {
  test('归一与拒因：空、空格、路径、形状、非法字段、IDN', () => {
    const cases: Array<[string, boolean, string?]> = [
      ['', false],
      ['   ', false],
      ['bad domain.com', false],
      ['http://x/y', false],
      ['../evil', false],
      ['*..com', false],
      ['a..b.com', false],
      ['-bad.com', false],
      ['bad-.com', false],
      ['例子.com', false],
      ['*.', false],
      ['*x.example.com', false],
      ['Example.COM.', true, 'example.com'],
      ['*.Example.COM', true, '*.example.com'],
      ['localhost', true, 'localhost'],
    ]
    for (const [raw, ok, domain] of cases) {
      const one = policy.normalizeAllowlistEntry(raw)
      expect(one.ok, raw).toBe(ok)
      if (ok && one.ok) expect(one.domain).toBe(domain)
      if (!ok && !one.ok) expect(one.why.length).toBeGreaterThan(0)
    }
  })

  test('parseAllowlist 排序去重、坏项给原因', () => {
    const parsed = policy.parseAllowlist(['a.com', 'A.COM.', 'b.com', 'http://x'])
    expect(parsed.domains).toEqual(['a.com', 'b.com'])
    expect(parsed.bad).toHaveLength(1)
    expect(policy.parseAllowlistText('x.com; *.x.com; bad entry').domains).toEqual(['x.com', '*.x.com'])
  })

  test('allowlistMatches：精确、通配一段、大小写与末尾点、空名', () => {
    expect(policy.allowlistMatches('', ['a.com'])).toBe(false)
    expect(policy.allowlistMatches('  ', [])).toBe(false)
    expect(policy.allowlistMatches('a.com', ['a.com'])).toBe(true)
    expect(policy.allowlistMatches('A.COM.', ['a.com'])).toBe(true)
    expect(policy.allowlistMatches('api.a.com', ['a.com'])).toBe(false)
    expect(policy.allowlistMatches('api.a.com', ['*.a.com'])).toBe(true)
    expect(policy.allowlistMatches('a.com', ['*.a.com'])).toBe(false)
    expect(policy.allowlistMatches('deep.api.a.com', ['*.a.com'])).toBe(false)
    expect(policy.allowlistMatches('x.com', ['b.com', '*.a.com'])).toBe(false)
  })

  test('sandboxTmpDir：会话 id 清洗截断，缺省用 cwd 哈希', () => {
    const one = policy.sandboxTmpDir('C:\\dsc', 'C:\\ws', 'a/b..c_D-1')
    expect(one.split(/[\\/]/).slice(-1)[0]).toBe('abc_D-1')

    const long = policy.sandboxTmpDir('C:\\dsc', 'C:\\ws', 'x'.repeat(100))
    expect(long.split(/[\\/]/).slice(-1)[0]).toHaveLength(64)

    const hashed = policy.sandboxTmpDir('C:\\dsc', 'C:\\ws')
    const hashedToo = policy.sandboxTmpDir('C:\\dsc', 'C:\\other')
    expect(hashed).not.toBe(hashedToo)
    expect(hashed.split(/[\\/]/).slice(-1)[0]).toMatch(/^[0-9a-f]{12}$/)
  })
})

// ── 形状守卫 ───────────────────────────────────────────────────────────────

describe('ntNamespaceReason', () => {
  test('NT 前缀（反斜杠与正斜杠写法）、GLOBALROOT、UNC 都拒', () => {
    expect(policy.ntNamespaceReason(String.raw`\\?\C:\Windows`, true)).toContain('NT 命名空间')
    expect(policy.ntNamespaceReason('//?/C:/Windows', true)).toContain('NT 命名空间')
    expect(policy.ntNamespaceReason(String.raw`C:\x\\.\C:\Windows`, true)).toContain('NT 命名空间')
    expect(policy.ntNamespaceReason(String.raw`\GLOBALROOT\Device\X`, true)).toContain('GLOBALROOT')
    expect(policy.ntNamespaceReason(String.raw`\\server\share`, true)).toContain('UNC')
  })

  test('普通路径放行；非 win32 不看 UNC，但 NT 前缀照样拒', () => {
    expect(policy.ntNamespaceReason('C:\\ws\\a.txt', true)).toBeNull()
    expect(policy.ntNamespaceReason(String.raw`\\server\share`, false)).toBeNull()
    expect(policy.ntNamespaceReason(String.raw`\\?\C:\x`, false)).toContain('NT 命名空间')
  })
})

describe('adsStreamReason', () => {
  test('win32 下带冒号（除盘符）就拒；普通名与非 win32 放行', () => {
    expect(policy.adsStreamReason(String.raw`C:\ws\a.txt:stream`, true)).toContain('备选数据流')
    expect(policy.adsStreamReason('file:stream', true)).toContain('备选数据流')
    expect(policy.adsStreamReason(String.raw`C:\ws\a.txt`, true)).toBeNull()
    expect(policy.adsStreamReason(String.raw`C:\ws\a.txt:stream`, false)).toBeNull()
  })
})

// ── canonicalizePath ──────────────────────────────────────────────────────

describe('canonicalizePath', () => {
  test('相对路径按 cwd 解析；尾部不存在的段进 tail（深→浅）', () => {
    const base = tempHome()
    const result = policy.canonicalizePath(join('no-such-dir-w11', 'a.txt'), { win32: true, cwd: base })
    expect(result.ok).toBe(true)
    expect(result.tail).toEqual(['a.txt', 'no-such-dir-w11'])
    expect(result.path.toLowerCase()).toBe(join(base, 'no-such-dir-w11', 'a.txt').toLowerCase())
  })

  test('尾段里的 8.3 短名保守拒（win32）', () => {
    const base = tempHome()
    const result = policy.canonicalizePath(join(base, 'PROGRA~1', 'x.txt'), { win32: true, cwd: base })
    expect(result.ok).toBe(false)
    expect(result.rule).toBe('short-name')
    expect(result.reason).toContain('PROGRA~1')
  })

  // Windows 专属：只有盘符路径才会出现「盘符不存在、逐级退到根也解不开」，POSIX 上同一串会被当相对路径拼到 cwd 下。
  test.skipIf(!WIN32)('盘符不存在：unresolvable', () => {
    if (ABSENT_DRIVE === null) {
      expect(true).toBe(true)
      return
    }
    const result = policy.canonicalizePath(join(ABSENT_DRIVE, 'nope', 'a.txt'), { win32: true, cwd: ABSENT_DRIVE })
    expect(result.ok).toBe(false)
    expect(result.rule).toBe('unresolvable')
    expect(result.reason).toContain('判不清落点')
  })

  test('path === "/"：stripTrailingSep 保留根', () => {
    const result = policy.canonicalizePath('/', { win32: true, cwd: tempHome() })
    expect(result.path.length).toBeGreaterThan(0)
  })

  // Windows 专属：`C:\` 只有在 win32 的 node:path 下才是绝对路径，Linux 上会被拼到 cwd 后面。
  test.skipIf(!WIN32)('盘根：stripTrailingSep 保留盘根', () => {
    const root = policy.canonicalizePath('C:\\', { win32: true, cwd: 'C:\\' })
    expect(root.path).toBe('C:\\')
  })
})

// ── 受保护名 ───────────────────────────────────────────────────────────────

describe('protectedWriteReason', () => {
  // 样本用 POSIX 形状：函数内部用 node:path 的 basename（跟着当前平台走），Windows 形状串在 Linux 上取不到文件名。
  // win32 标志仍传 true，验的是「归一成反斜杠 + 小写后」的判定；非 win32 口径见下面第三条。
  const home = '/home/me/.dsc'

  test('Git / SSH / .env 家族 / 凭据基名 / 密钥扩展名', () => {
    expect(policy.protectedWriteReason('/ws/.git/config', home, true)).toContain('Git 元数据')
    expect(policy.protectedWriteReason('/ws/.ssh/id_rsa', home, true)).toContain('SSH 凭据')
    expect(policy.protectedWriteReason('/ws/.env.local', home, true)).toContain('.env 家族')
    expect(policy.protectedWriteReason('/ws/id_rsa', home, true)).toContain('凭据/私钥')
    expect(policy.protectedWriteReason('/ws/auth.json', home, true)).toContain('凭据/私钥')
    expect(policy.protectedWriteReason('/ws/server.pem', home, true)).toContain('密钥/证书')
    expect(policy.protectedWriteReason('/ws/store.PFX', home, true)).toContain('密钥/证书')
    expect(policy.protectedWriteReason('/ws/credentials.json', home, true)).toContain('凭据文件')
  })

  test('dsc 家目录里的控制文件才拒；同名的外部文件放行', () => {
    expect(policy.protectedWriteReason('/home/me/.dsc/config.yaml', home, true)).toContain('dsc 自己的配置')
    expect(policy.protectedWriteReason('/home/me/.dsc/plugins.json', home, true)).toContain('dsc 自己的配置')
    expect(policy.protectedWriteReason('/ws/config.yaml', home, true)).toBeNull()
    // 家目录前缀只按完整段匹配：`.dsc-backup` 不算。
    expect(policy.protectedWriteReason('/home/me/.dsc-backup/config.yaml', home, true)).toBeNull()
  })

  test('非 win32 口径（大小写敏感比较）也能判', () => {
    expect(policy.protectedWriteReason('/ws/.git/config', '/home/me/.dsc', false)).toContain('Git 元数据')
    expect(policy.protectedWriteReason('/home/me/.dsc/config.yaml', '/home/me/.dsc', false)).toContain('dsc 自己的配置')
    expect(policy.protectedWriteReason('/ws/a.txt', '/home/me/.dsc', false)).toBeNull()
  })

  test('.env.example / .env.sample / .env.template 不在 .env 家族里', () => {
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      expect(policy.protectedWriteReason(`/ws/${name}`, home, true), name).toBeNull()
    }
  })
})

// ── createPolicy / insideRoot / checkWrite / describePolicy ────────────────

describe('createPolicy 与 checkWrite', () => {
  const makeBase = () => {
    const base = tempHome()
    return {
      base,
      input: {
        mode: 'workspace-write' as const,
        cwd: base,
        tmpDir: join(base, 'tmp'),
        extraWritableRoots: [],
        readOnlySubpaths: [],
        dscHome: join(base, '.dsc'),
        networkAccess: false,
        win32: true,
      },
    }
  }

  test('read-only 档 roots 为空，但候选根仍保留；附加根/只读子路径空白项跳过', () => {
    const { base, input } = makeBase()
    const readOnly = policy.createPolicy({ ...input, mode: 'read-only', extraWritableRoots: ['  '] })
    expect(readOnly.roots).toEqual([])
    expect(readOnly.candidateRoots).toHaveLength(2)
    expect(readOnly.problems).toEqual([])
    expect(policy.describePolicy(readOnly)).toContain('（无，只读档不许写盘）')
    expect(base.length).toBeGreaterThan(0)
  })

  // Windows 专属：靠「不存在的盘符」制造 unresolvable，POSIX 上同一串会被解析到 cwd 下（永远解得开）。
  test.skipIf(!WIN32)('附加根 / 只读子路径解析不了：丢掉并进 problems；tmp 解析不了时回退 resolve', () => {
    if (ABSENT_DRIVE === null) {
      expect(true).toBe(true)
      return
    }
    const base = tempHome()
    const bad = join(ABSENT_DRIVE, 'nope')
    const one = policy.createPolicy({
      mode: 'workspace-write',
      cwd: base,
      tmpDir: bad,
      extraWritableRoots: [bad],
      readOnlySubpaths: [bad],
      dscHome: join(base, '.dsc'),
      networkAccess: true,
      win32: true,
    })
    expect(one.problems).toHaveLength(2)
    expect(one.problems.join('\n')).toContain('附加可写根')
    expect(one.problems.join('\n')).toContain('只读子路径')
    // tmpDir 解析不了时回退 resolve，仍进候选根（只是用不了）；附加根被丢掉。
    expect(one.candidateRoots).toEqual([base, bad])
    expect(one.tmpDir).toBe(bad)
  })

  // Windows 专属：同上，盘符路径在 POSIX 上不是绝对路径，解析失败那条分支走不到。
  test.skipIf(!WIN32)('工作目录解析不了：problems 里说明，cwd 退回 resolve，roots 照常', () => {
    if (ABSENT_DRIVE === null) {
      expect(true).toBe(true)
      return
    }
    const bad = join(ABSENT_DRIVE, 'nope')
    const one = policy.createPolicy({
      mode: 'workspace-write',
      cwd: bad,
      tmpDir: join(bad, 'tmp'),
      extraWritableRoots: [],
      readOnlySubpaths: [],
      dscHome: 'C:\\dsc',
      networkAccess: false,
      win32: true,
    })
    expect(one.problems[0]).toContain('工作目录用不了')
    expect(one.cwd).toBe(bad)
    expect(one.roots).toContain(bad)
  })

  test('insideRoot：非 win32 口径的同路径 / 子路径 / 越界', () => {
    expect(policy.insideRoot('/ws/a', '/ws', false)).toBe(true)
    expect(policy.insideRoot('/other/a', '/ws', false)).toBe(false)
  })

  // Windows 专属：这些样本靠 win32 的 node:path 语义算相对关系，Linux 上 relative() 是 posix 语义，判不出来。
  test.skipIf(!WIN32)('insideRoot：同路径 / 子路径 / 越界 / `..foo` 不误判 / 跨盘', () => {
    expect(policy.insideRoot('C:\\ws', 'C:\\ws', true)).toBe(true)
    expect(policy.insideRoot('C:\\ws\\a\\b.txt', 'C:\\ws', true)).toBe(true)
    expect(policy.insideRoot('C:\\ws2\\a', 'C:\\ws', true)).toBe(false)
    expect(policy.insideRoot('C:\\ws\\..foo', 'C:\\ws', true)).toBe(true)
    expect(policy.insideRoot('D:\\a', 'C:\\ws', true)).toBe(false)
  })

  test('三种档位与只读子路径、受保护名、形状守卫的判定结果', () => {
    const { base, input } = makeBase()
    const ws = policy.createPolicy(input)

    expect(policy.checkWrite(ws, join(base, 'a.txt'))).toMatchObject({ allowed: true, rule: 'allowed' })
    expect(policy.checkWrite(ws, String.raw`\\?\C:\Windows`).rule).toBe('nt-namespace')
    expect(policy.checkWrite(ws, String.raw`C:\ws\a.txt:stream`).rule).toBe('ads-stream')
    expect(policy.checkWrite(ws, join(base, 'PROGRA~1', 'x.txt')).rule).toBe('short-name')
    if (ABSENT_DRIVE !== null) {
      expect(policy.checkWrite(ws, join(ABSENT_DRIVE, 'x')).rule).toBe('unresolvable')
    }
    expect(policy.checkWrite(ws, join(base, '.git', 'config')).rule).toBe('protected-metadata')
    expect(policy.checkWrite(ws, join(base, '..', 'outside.txt')).rule).toBe('outside-writable-roots')

    const readOnly = policy.createPolicy({ ...input, mode: 'read-only' })
    expect(policy.checkWrite(readOnly, join(base, 'a.txt')).rule).toBe('mode-read-only')

    const sub = policy.createPolicy({ ...input, readOnlySubpaths: [join(base, 'ro')] })
    expect(policy.checkWrite(sub, join(base, 'ro', 'x.txt')).rule).toBe('read-only-subpath')

    const open = policy.createPolicy({ ...input, mode: 'danger-full-access' })
    expect(policy.checkWrite(open, join(base, 'a.txt'))).toMatchObject({ allowed: true, rule: 'allowed' })
    // 形状守卫在档位之前：danger 也不放行 NT 命名空间。
    expect(policy.checkWrite(open, String.raw`\\?\C:\Windows`).rule).toBe('nt-namespace')
  })

  test('可写根为空：越界理由写「（无）」', () => {
    const { base, input } = makeBase()
    const ws = policy.createPolicy(input)
    const empty = { ...ws, roots: [] }
    const result = policy.checkWrite(empty, join(base, 'a.txt'))
    expect(result.rule).toBe('outside-writable-roots')
    expect(result.reason).toContain('（无）')
  })

  test('describePolicy：danger 关闭围栏、只读子路径有无两种写法', () => {
    const { base, input } = makeBase()
    const danger = policy.createPolicy({ ...input, mode: 'danger-full-access' })
    expect(policy.describePolicy(danger)).toContain('围栏关闭（不限制）')

    // 样本用临时目录下的真实路径：C:\ro 这类盘符串在 Linux 上会被解析到 cwd 下，拼法变掉。
    const ws = policy.createPolicy({ ...input, readOnlySubpaths: [join(base, 'ro')] })
    const text = policy.describePolicy(ws)
    expect(text).toContain(`只读子路径：${ws.readOnlySubpaths[0]!}`)
    expect(text).toContain('网络：关')
    expect(policy.describePolicy({ ...ws, readOnlySubpaths: [] })).toContain('只读子路径：（无）')
  })

  test('legalWay：九种规则名都有可执行的一句话', () => {
    const rules = [
      'outside-writable-roots',
      'protected-metadata',
      'mode-read-only',
      'read-only-subpath',
      'nt-namespace',
      'ads-stream',
      'short-name',
      'unresolvable',
      'allowed',
    ] as const
    for (const rule of rules) expect(policy.legalWay(rule).length, rule).toBeGreaterThan(10)
  })
})

// ── setup：命名互斥体 ─────────────────────────────────────────────────────

describe('acquireSetupMutex', () => {
  /**
   * 互斥体是 Windows 专属的（`setup.ts:321` 非 win32 直接给空实现），所以这些分支临时把 platform 当 win32
   * 才走得到；FFI 与 node:child_process 已整体换成假的，Linux 上跑也不会碰系统。
   */
  const acquire = (): ReturnType<typeof setup.acquireSetupMutex> =>
    withPlatform('win32', () => setup.acquireSetupMutex())

  test('非 win32 / FFI 不可用 / bindAll 抛错：都退回空实现', () => {
    expect(withPlatform('linux', () => setup.acquireSetupMutex())).toEqual({ ok: true, mutex: { release: expect.any(Function) } })

    ffiState.mode = 'ffi-off'
    const off = acquire()
    expect(off.ok).toBe(true)
    off.ok && off.mutex.release()

    ffiState.mode = 'bind-throws'
    const thrown = acquire()
    expect(thrown.ok).toBe(true)
  })

  test('CreateMutexW 抛错：ok=false 且带上错误文本', () => {
    ffiState.mode = 'create-throws'
    const result = acquire()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.why).toContain('CreateMutexW 调用失败')
  })

  test('空句柄：报 Win32 错误码；读不到 LastError 时退回纯文案', () => {
    ffiState.mode = 'no-handle'
    ffiState.lastError = 5
    const withCode = acquire()
    expect(withCode.ok).toBe(false)
    if (!withCode.ok) expect(withCode.why).toContain('5')

    ffiState.lastErrorThrows = true
    const noCode = acquire()
    expect(noCode.ok).toBe(false)
    if (!noCode.ok) expect(noCode.why).toBe('CreateMutexW 返回空句柄')
  })

  test('重名（183）：关掉自己那份句柄并报「另一个安装正在运行」', () => {
    ffiState.lastError = 183
    const result = acquire()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.why).toBe(setup.SETUP_BUSY_DETAIL)
    expect(ffiState.closeCalls).toBe(1)
  })

  test('拿到锁：release 只放一次、两个系统调用都走，单个失败被吞掉', () => {
    const ok = acquire()
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    ok.mutex.release()
    ok.mutex.release()
    expect(ffiState.releaseCalls).toBe(1)
    expect(ffiState.closeCalls).toBe(1)

    ffiState.releaseCalls = 0
    ffiState.closeCalls = 0
    ffiState.releaseThrows = true
    ffiState.closeThrows = true
    const second = acquire()
    expect(second.ok).toBe(true)
    if (second.ok) expect(() => second.mutex.release()).not.toThrow()
  })

  test('读 LastError 抛错：按「没人持有」继续拿锁', () => {
    ffiState.lastErrorThrows = true
    const result = acquire()
    expect(result.ok).toBe(true)
    if (result.ok) result.mutex.release()
  })
})

// ── setup：runSetupElevated 的三路结论 ─────────────────────────────────────

function writeValidState(home: string, over: Record<string, unknown> = {}): void {
  mkdirSync(sandboxDir(home), { recursive: true })
  writeFileSync(
    setupStatePath(home),
    JSON.stringify({
      version: 1,
      account: 'dsc-sandbox-offline',
      sid: 'S-1-5-21-1-2-3',
      proxyPort: 3128,
      firewallRules: ['r1', 'r2', 'r3', 'r4', 'r5'],
      wfpProviderGuid: '11111111-1111-1111-1111-111111111111',
      wfpSublayerGuid: '22222222-2222-2222-2222-222222222222',
      at: '2026-01-01T00:00:00.000Z',
      ...over,
    }),
    'utf8',
  )
}

describe('runSetupElevated', () => {
  /**
   * 互斥体只在 Windows 上真的拿（`setup.ts:321` 非 win32 直接返回空实现），这段判定是 async 函数开头
   * 同步执行的，所以同步的 withPlatform 包一层就够把 Linux 也带到「抢不到锁」那条分支；FFI/子进程已整体 mock。
   */
  const runSetup = (home: string, options: { proxyPort?: number; timeoutMs?: number } = {}) =>
    withPlatform('win32', () => setup.runSetupElevated(home, options))

  test('互斥体被拒：不落脚本、不弹 UAC，直接返回原因', async () => {
    ffiState.mode = 'no-handle'
    ffiState.lastError = 1
    const result = await runSetup(tempHome())
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('空句柄')
    expect(spawnState.calls).toHaveLength(0)
  })

  test('生成脚本失败（dscHome 带单引号）：带 proxyPort 走到生成再失败', async () => {
    const result = await setup.runSetupElevated("C:\\bad'home", { proxyPort: 3128 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('生成 setup 脚本失败')
    expect(spawnState.calls).toHaveLength(0)
  })

  test('成功：退出码 0 + 账本 ok；wfpFilterCount 缺省时明细写 -1', async () => {
    const home = tempHome()
    writeValidState(home)
    spawnState.behaviors.push({ kind: 'close', code: 0 })
    const result = await setup.runSetupElevated(home, { timeoutMs: 1_000 })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('提权 setup 成功')
    expect(result.detail).toContain('WFP filter -1')
    expect(existsSync(setupScriptPath(home))).toBe(true)
    // 脚本带 BOM（PowerShell 5.1 才按 UTF-8 读）。
    expect(readFileSync(setupScriptPath(home), 'utf8').charCodeAt(0)).toBe(0xfeff)
    expect(spawnState.calls[0]!.args).toContain('Bypass')
  })

  test('退出码非 0 + 账本读不动：明细拼出退出码、脚本报错、stderr、账本原因', async () => {
    const home = tempHome()
    mkdirSync(sandboxDir(home), { recursive: true })
    writeFileSync(setupStatePath(home), 'not json', 'utf8')
    spawnState.behaviors.push({
      kind: 'close',
      code: 3,
      stderr: 'powershell 报错',
      beforeClose: () => writeFileSync(join(sandboxDir(home), 'setup-error.txt'), '\uFEFF脚本炸了', 'utf8'),
    })
    const result = await setup.runSetupElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('退出码 3')
    expect(result.detail).toContain('脚本报错：脚本炸了')
    expect(result.detail).toContain('stderr：powershell 报错')
    expect(result.detail).toContain('账本读不动')
  })

  test('退出码非 0 + 没有账本：说「布防没走完」', async () => {
    const home = tempHome()
    spawnState.behaviors.push({ kind: 'close', code: 2 })
    const result = await setup.runSetupElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('没有 setup-state.json')
  })

  test('退出码非 0 + 账本在：说「半成品，请重跑」', async () => {
    const home = tempHome()
    writeValidState(home)
    spawnState.behaviors.push({ kind: 'close', code: 4 })
    const result = await setup.runSetupElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('半成品')
  })

  test('超时：报「可能在等 UAC」', async () => {
    const home = tempHome()
    spawnState.behaviors.push({ kind: 'hang' })
    const result = await setup.runSetupElevated(home, { timeoutMs: 1 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('超时未结束')
  })

  test('spawn 失败：错误文本进 stderr 再进明细', async () => {
    const home = tempHome()
    spawnState.behaviors.push({ kind: 'error', message: 'spawn 炸了' })
    const result = await setup.runSetupElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('spawn 炸了')
  })

  test('SystemRoot 未设置：powershell 路径回落 C:\\Windows', async () => {
    const home = tempHome()
    writeValidState(home)
    spawnState.behaviors.push({ kind: 'close', code: 0 })
    const saved = process.env.SystemRoot
    delete process.env.SystemRoot
    try {
      const result = await setup.runSetupElevated(home, { timeoutMs: 1_000 })
      expect(result.ok).toBe(true)
      // 只验「回落到 C:\Windows」：分隔符由 node:path 按当前平台拼（Windows 反斜杠、Linux 正斜杠），先归一。
      const spawned = spawnState.calls[0]!.file.toLowerCase().replace(/[\\/]+/g, '\\')
      expect(spawned).toContain('c:\\windows\\system32\\windowspowershell')
    } finally {
      if (saved !== undefined) process.env.SystemRoot = saved
    }
  })
})

// ── setup：runUninstallElevated 的三路结论 ─────────────────────────────────

describe('runUninstallElevated', () => {
  /** 与 runSetupElevated 同一个理由：互斥体是 Windows 专属，临时当 win32 才验得到「抢不到锁」那条。 */
  const runUninstall = (home: string, options: { timeoutMs?: number } = {}) =>
    withPlatform('win32', () => setup.runUninstallElevated(home, options))

  test('互斥体被拒：直接返回原因', async () => {
    ffiState.mode = 'no-handle'
    ffiState.lastError = 1
    const result = await runUninstall(tempHome())
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('空句柄')
    expect(spawnState.calls).toHaveLength(0)
  })

  test('生成卸载脚本失败：dscHome 带单引号', async () => {
    const result = await setup.runUninstallElevated("C:\\bad'home")
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('生成卸载脚本失败')
  })

  test('成功：退出码 0 且账本已不在；timeoutMs 显式给', async () => {
    const home = tempHome()
    spawnState.behaviors.push({ kind: 'close', code: 0 })
    const result = await setup.runUninstallElevated(home, { timeoutMs: 1_000 })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('提权卸载完成')
    expect(existsSync(join(sandboxDir(home), 'uninstall.ps1'))).toBe(true)
  })

  test('卸载后账本还在：报「卸载没走完」', async () => {
    const home = tempHome()
    writeValidState(home)
    spawnState.behaviors.push({ kind: 'close', code: 0 })
    const result = await setup.runUninstallElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('setup-state.json 还在')
  })

  test('卸载后账本坏了：报「账本读不动」', async () => {
    const home = tempHome()
    mkdirSync(sandboxDir(home), { recursive: true })
    writeFileSync(setupStatePath(home), 'not json', 'utf8')
    spawnState.behaviors.push({ kind: 'close', code: 0 })
    const result = await setup.runUninstallElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('账本读不动')
  })

  test('退出码非 0 + 脚本报错 + stderr + 没有账本', async () => {
    const home = tempHome()
    spawnState.behaviors.push({
      kind: 'close',
      code: 9,
      stderr: '卸载报错',
      beforeClose: () => writeFileSync(join(sandboxDir(home), 'setup-error.txt'), '卸载脚本炸了', 'utf8'),
    })
    const result = await setup.runUninstallElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('退出码 9')
    expect(result.detail).toContain('脚本报错：卸载脚本炸了')
    expect(result.detail).toContain('stderr：卸载报错')
  })

  test('close 事件给 null：退出码按 -1 报', async () => {
    const home = tempHome()
    spawnState.behaviors.push({ kind: 'close', code: null })
    const result = await setup.runUninstallElevated(home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('退出码 -1')
  })
})

// ── backends：docker 探测与容器执行器 ─────────────────────────────────────

const shellRun = (cwd = 'C:\\ws'): { command: string; cwd: string; timeoutMs: number; signal: AbortSignal } => ({
  command: 'pnpm test',
  cwd,
  timeoutMs: 1_000,
  signal: new AbortController().signal,
})

/**
 * 计划里的 PowerShell 路径：Windows 上给生产形态的完整路径；其它平台给裸文件名。
 *
 * `unwrapShellCommand` 用 node:path 的 `basename` 认 shell，Linux 的 posix 语义认不出反斜杠路径，
 * 所以非 Windows 上用裸名（照样验「认得出 PowerShell」这条分支，只是不验路径形态）。
 */
const POWERSHELL_FILE = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  : 'powershell.exe'

const shellPlan = (over: Record<string, unknown> = {}): {
  file: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
} => ({
  file: POWERSHELL_FILE,
  args: ['-NoProfile', '-Command', 'pnpm test'],
  env: { PATH: 'C:\\bin', LANG: 'C.UTF-8', HTTP_PROXY: '', NPM_CONFIG_REGISTRY: 'https://r', SECRET: 'no' },
  cwd: 'C:\\ws',
  ...over,
})

describe('probeDocker', () => {
  test('Server 版本成功：只取第一行、trim 后报', async () => {
    spawnState.behaviors.push({ kind: 'close', code: 0, stdout: ' 24.0.7 \nextra\n' })
    const result = await probeDocker({ timeoutMs: 100 })
    expect(result).toEqual({ available: true, detail: 'docker Server 24.0.7' })
    expect(spawnState.calls[0]).toMatchObject({ file: 'docker' })
    expect(spawnState.calls[0]!.args).toEqual(['version', '--format', '{{.Server.Version}}'])
  })

  test('退出码非 0：有输出报输出，没输出报退出码', async () => {
    spawnState.behaviors.push({ kind: 'close', code: 1, stdout: 'daemon down\n' })
    expect((await probeDocker()).detail).toBe('daemon down')

    spawnState.behaviors.push({ kind: 'close', code: 2 })
    expect((await probeDocker()).detail).toBe('docker 返回退出码 2')
  })

  test('spawn 同步抛 / error 事件：都归类为跑不了', async () => {
    spawnState.behaviors.push({ kind: 'throw', message: 'ENOENT' })
    const thrown = await probeDocker()
    expect(thrown.available).toBe(false)
    expect(thrown.detail).toContain('起不来：ENOENT')

    spawnState.behaviors.push({ kind: 'error', message: 'ENOENT2' })
    const errored = await probeDocker({ executable: 'docker-real' })
    expect(errored.detail).toContain('跑不了 docker-real')
    expect(errored.detail).toContain('ENOENT2')
  })

  test('超时：杀进程并说明守护没起来', async () => {
    spawnState.behaviors.push({ kind: 'hang' })
    const result = await probeDocker({ timeoutMs: 1 })
    expect(result.available).toBe(false)
    expect(result.detail).toContain('探测超过 1ms')
  })

  test('输出封顶：超限后的第二块不再累加', async () => {
    spawnState.behaviors.push({ kind: 'close', code: 0, stdoutChunks: ['x'.repeat(4_200), 'tail'] })
    const result = await probeDocker({ timeoutMs: 1_000 })
    expect(result.available).toBe(true)
    expect(result.detail.startsWith('docker Server xxx')).toBe(true)
    expect(result.detail.includes('tail')).toBe(false)
  })
})

describe('unwrapShellCommand', () => {
  test('PowerShell / POSIX / cmd 三种形态与黏写参数', () => {
    expect(unwrapShellCommand(shellPlan() as never)).toBe('pnpm test')
    expect(unwrapShellCommand(shellPlan({ file: 'pwsh.exe', args: ['-Command:echo hi'] }) as never)).toBe('echo hi')
    for (const file of ['sh', 'bash', 'dash', 'zsh', 'ksh', '/bin/bash']) {
      expect(unwrapShellCommand(shellPlan({ file, args: ['-c', 'make test'] }) as never), file).toBe('make test')
    }
    expect(unwrapShellCommand(shellPlan({ file: 'cmd.exe', args: ['/c', 'dir'] }) as never)).toBe('dir')
    expect(unwrapShellCommand(shellPlan({ file: 'cmd.exe', args: ['/k', 'dir'] }) as never)).toBe('dir')
  })

  test('认不出的 shell、缺参数都返回 null', () => {
    expect(unwrapShellCommand(shellPlan({ file: 'node.exe', args: ['-e', 'x'] }) as never)).toBeNull()
    expect(unwrapShellCommand(shellPlan({ args: ['-NoProfile', '-Command'] }) as never)).toBeNull()
  })
})

describe('createDockerRunner', () => {
  test('PowerShell 计划换成 docker run：网络/只读/挂载/环境白名单', () => {
    const runner = createDockerRunner({
      image: 'node:22',
      networkAccess: () => true,
      readOnly: () => true,
      containerName: () => 'fixed-name',
    })
    const plan = runner.plan(shellRun(), shellPlan() as never) as unknown as SpawnPlan
    expect(runner.id).toBe('sandbox-docker')
    expect(runner.order).toBe(20)
    expect(plan.file).toBe('docker')
    expect(plan.cwd).toBe('C:\\ws')
    expect(plan.args.slice(0, 8)).toEqual([
      'run', '--rm', '--name', 'fixed-name',
      '--network', 'bridge',
      '-v', 'C:/ws:/work:ro',
    ])
    expect(plan.args).toContain('-w')
    expect(plan.args.slice(-4)).toEqual(['node:22', 'sh', '-c', 'pnpm test'])
    // 透传只带非空白白名单项；PATH / SECRET / 空 HTTP_PROXY 一律不传。
    expect(plan.args).toContain('LANG=C.UTF-8')
    expect(plan.args).toContain('NPM_CONFIG_REGISTRY=https://r')
    expect(plan.args.join('\n')).not.toContain('PATH=')
    expect(plan.args.join('\n')).not.toContain('SECRET=')
    expect(plan.args.join('\n')).not.toContain('HTTP_PROXY=')
    expect(CONTAINER_ENV_PASSTHROUGH).toContain('NO_COLOR')
  })

  test('网络关 → --network none；没给 readOnly → 挂载不带 :ro', () => {
    const runner = createDockerRunner({
      image: 'alpine:3',
      networkAccess: () => false,
      containerName: () => 'n2',
      envPassthrough: ['LANG'],
    })
    const plan = runner.plan(shellRun('D:\\proj'), shellPlan({ env: { LANG: 'C' } }) as never) as unknown as SpawnPlan
    expect(plan.args[plan.args.indexOf('--network') + 1]).toBe('none')
    expect(plan.args[plan.args.indexOf('-v') + 1]).toBe('D:/proj:/work')
  })

  test('已经是 docker / 认不出 shell / 内层为空：一律返回 null', () => {
    const runner = createDockerRunner({ image: 'alpine:3', networkAccess: () => true })
    expect(runner.plan(shellRun(), shellPlan({ file: 'docker.exe' }) as never)).toBeNull()
    expect(runner.plan(shellRun(), shellPlan({ file: '/usr/bin/docker' }) as never)).toBeNull()
    expect(runner.plan(shellRun(), shellPlan({ file: 'node.exe' }) as never)).toBeNull()
    expect(runner.plan(shellRun(), shellPlan({ args: ['-Command', '   '] }) as never)).toBeNull()
  })

  test('默认容器名带 pid 与递增序号；id/order 可覆盖', () => {
    const runner = createDockerRunner({ image: 'alpine:3', networkAccess: () => true })
    const plan = runner.plan(shellRun(), shellPlan() as never) as unknown as SpawnPlan
    const name = plan.args[plan.args.indexOf('--name') + 1]!
    expect(name).toMatch(new RegExp(`^dsc-sandbox-${String(process.pid)}-\\d+$`))

    const custom = createDockerRunner({
      image: 'alpine:3',
      networkAccess: () => true,
      id: 'my-docker',
      order: 7,
      containerName: () => 'c',
    })
    expect(custom.id).toBe('my-docker')
    expect(custom.order).toBe(7)
  })

  test('done：注入的 remove 优先；没有 --name 时什么都不做', () => {
    const removed: string[] = []
    const runner = createDockerRunner({
      image: 'alpine:3',
      networkAccess: () => true,
      remove: (name) => removed.push(name),
    })
    runner.done!(shellRun(), { file: 'docker', args: ['run', '--name', 'left-over'], env: {}, cwd: 'C:\\ws' })
    expect(removed).toEqual(['left-over'])

    runner.done!(shellRun(), { file: 'docker', args: ['run', '--rm'], env: {}, cwd: 'C:\\ws' })
    expect(removed).toEqual(['left-over'])
  })

  test('done：默认 docker rm -f，失败被吞掉', () => {
    const runner = createDockerRunner({ image: 'alpine:3', networkAccess: () => true, executable: 'docker-x' })
    spawnState.behaviors.push({ kind: 'hang' })
    runner.done!(shellRun(), { file: 'docker-x', args: ['run', '--name', 'c1'], env: {}, cwd: 'C:\\ws' })
    expect(spawnState.calls[0]).toMatchObject({ file: 'docker-x' })
    expect(spawnState.calls[0]!.args).toEqual(['rm', '-f', 'c1'])

    spawnState.behaviors.push({ kind: 'throw', message: '没 docker' })
    expect(() =>
      runner.done!(shellRun(), { file: 'docker-x', args: ['run', '--name', 'c2'], env: {}, cwd: 'C:\\ws' }),
    ).not.toThrow()
  })
})

// ── wfp：只读探测的六条结论与 GUID 编码 ───────────────────────────────────

describe('wfp GUID 与探测', () => {
  test('guidStringToBuffer：Windows GUID 小端布局；非法字面量抛错', () => {
    expect(guidStringToBuffer('c38d57d1-05a7-4c33-904f-7fbceee60e82').toString('hex')).toBe(
      'd1578dc3a705334c904f7fbceee60e82',
    )
    expect(guidStringToBuffer('{c38d57d1-05a7-4c33-904f-7fbceee60e82}').length).toBe(16)
    expect(() => guidStringToBuffer('not-a-guid')).toThrow(/GUID 字面量不合法/)
  })

  test('非法 GUID：探测直接返回不可信结论', () => {
    const result = probeWfpSublayer('not-a-guid')
    expect(result.present).toBe(false)
    expect(result.detail).toContain('子层 GUID 无法解析')
  })

  // 这条必须排在所有「成功绑定」之前：绑定缓存一旦落下，后面就不再走失败路径。
  test('fwpuclnt 绑定失败：返回不可用原因，不抛', () => {
    wfpState.bindThrows = true
    const result = probeWfpSublayer('c38d57d1-05a7-4c33-904f-7fbceee60e82')
    expect(result.present).toBe(false)
    expect(result.detail).toContain('绑定失败')
    expect(result.detail).toContain('探测不了 WFP 子层')
  })

  test('引擎打不开 / 空句柄：两条失败说明', () => {
    wfpState.openCode = FWP_E_LAYER_NOT_FOUND
    const refused = probeWfpSublayer()
    expect(refused.present).toBe(false)
    expect(refused.detail).toContain('0x80320004')
    expect(refused.detail).toContain('FWP_E_LAYER_NOT_FOUND')
    expect(refused.detail).toContain('查不到子层')

    wfpState.openCode = 0
    wfpState.engine = 0
    const empty = probeWfpSublayer()
    expect(empty.detail).toContain('空句柄')
    expect(wfpState.closeCalls).toBe(0)
  })

  test('查到子层：present=true，并释放系统内存', () => {
    wfpState.subCode = 0
    const result = probeWfpSublayer()
    expect(result.present).toBe(true)
    expect(result.detail).toContain('二级 WFP 布防在位')
    expect(wfpState.freeCalls).toBe(1)
    expect(wfpState.closeCalls).toBe(1)
  })

  test('查不到子层：哨兵层可见 → 结论可信；不可见 → 结论不可信', () => {
    wfpState.subCode = FWP_E_SUBLAYER_NOT_FOUND
    wfpState.layerCode = 0
    const visible = probeWfpSublayer()
    expect(visible.present).toBe(false)
    expect(visible.detail).toContain('同会话能查到内置 WFP 层，结论可信')

    wfpState.layerCode = 5
    const blind = probeWfpSublayer()
    expect(blind.present).toBe(false)
    expect(blind.detail).toContain('这条结论不可信')
  })

  test('其它返回码：明确说「不是不存在，属探测失败」', () => {
    wfpState.subCode = 5
    const result = probeWfpSublayer()
    expect(result.present).toBe(false)
    expect(result.detail).toContain('不是「不存在」')
  })

  test('探测过程抛错 / 关句柄失败：都不外抛', () => {
    wfpState.openThrows = true
    expect(probeWfpSublayer().detail).toContain('WFP 探测过程出错')

    wfpState.openThrows = false
    wfpState.subCode = 0
    wfpState.subThrows = true
    expect(probeWfpSublayer().detail).toContain('WFP 探测过程出错')

    wfpState.subThrows = false
    wfpState.closeThrows = true
    const closed = probeWfpSublayer()
    expect(closed.present).toBe(true)
  })
})

// ── sweep：超龄临时目录清扫 ───────────────────────────────────────────────

describe('sweepSandboxTemps', () => {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  test('根不存在：三份空结果，不抛', () => {
    expect(sweep.sweepSandboxTemps({ root: join(tempHome(), 'missing') })).toEqual({
      swept: [],
      kept: [],
      failed: [],
    })
  })

  test('按 mtime 分超龄/年轻；普通文件不算目录；onSweep 拿到 SID 与年龄', () => {
    const root = tempHome('dsc-w11-sweep-')
    const now = Date.now()
    const old = join(root, 'old')
    const young = join(root, 'young')
    mkdirSync(old)
    mkdirSync(young)
    writeFileSync(join(root, 'plain.txt'), 'x')
    utimesSync(old, new Date(now - 2 * DAY), new Date(now - 2 * DAY))
    utimesSync(young, new Date(now - HOUR), new Date(now - HOUR))

    const swept: Array<{ path: string; sid: string; ageMs: number }> = []
    const result = sweep.sweepSandboxTemps({ root, now: () => now, onSweep: (entry) => swept.push(entry) })
    expect(result.swept).toEqual([old])
    expect(result.kept).toEqual([young])
    expect(result.failed).toEqual([])
    expect(swept).toHaveLength(1)
    expect(swept[0]!.sid).toMatch(/^S-1-4-/)
    expect(swept[0]!.ageMs).toBeGreaterThanOrEqual(2 * DAY - 1_000)
  })

  test('单个目录回收失败：进 failed，其余照常', () => {
    const root = tempHome('dsc-w11-sweep-')
    const now = Date.now()
    const bad = join(root, 'bad')
    mkdirSync(bad)
    utimesSync(bad, new Date(now - 2 * DAY), new Date(now - 2 * DAY))
    const result = sweep.sweepSandboxTemps({
      root,
      now: () => now,
      onSweep: () => {
        throw new Error('EBUSY')
      },
    })
    expect(result.swept).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.why).toContain('目录被占用')
  })

  test('默认回收真删目录；olderThanMs 可调', () => {
    const root = tempHome('dsc-w11-sweep-')
    const now = Date.now()
    const old = join(root, 'old')
    const fresh = join(root, 'fresh')
    mkdirSync(old)
    mkdirSync(fresh)
    utimesSync(old, new Date(now - 2 * DAY), new Date(now - 2 * DAY))
    utimesSync(fresh, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR))

    const result = sweep.sweepSandboxTemps({ root, now: () => now, olderThanMs: HOUR })
    expect(result.swept.sort()).toEqual([fresh, old].sort())
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(false)
  })
})
