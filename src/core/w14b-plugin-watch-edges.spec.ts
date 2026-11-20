/**
 * `core/plugin-watch.ts` 的缺口补齐：缺省日志落 stderr、坏清单/读不动的目录、库包清单坏掉的
 * 那一条、界面换图通知失败、缺省「扫外部目录」实现、去抖/轮询两条错误兜底、定时器分支，
 * 以及 `loggerOf` 的两种取 logger 方式。
 *
 * 夹具沿用 `plugin-watch.spec.ts` 的口径：目标、目录、重挂都可注入，只有磁盘指纹是真的；
 * 轮询靠 `pollNow()` 手动驱动（只有定时器那两条用假时钟）。`DSC_HOME` 指到临时目录。
 *
 * @module dsc/core/w14b-plugin-watch-edges.spec
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

/** 被测的 loader 面：只替换「扫外部目录」与「重算组合包」两个动态 import 的入口。 */
const loaderMock = vi.hoisted(() => ({
  adopt: null as null | ((only: ReadonlySet<string>) => Promise<unknown>),
  reconcile: null as null | ((root: unknown, dir: string) => Promise<unknown>),
  adopted: [] as string[],
}))

vi.mock('./plugin-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugin-loader.js')>()
  return {
    ...actual,
    adoptPluginsFromDisk: async (only: ReadonlySet<string>) => {
      loaderMock.adopted.push(...only)
      if (loaderMock.adopt !== null) return loaderMock.adopt(only)
      return { mounted: [], unmounted: [], failures: [] }
    },
    reconcileProfileBundles: async (root: unknown, dir: string) => {
      if (loaderMock.reconcile !== null) return loaderMock.reconcile(root, dir)
      return { mounted: [], unmounted: [], failures: [], warnings: [] }
    },
  }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-watch-'))
process.env['DSC_HOME'] = HOME
delete process.env['DSC_HOT']

type Watch = typeof import('./plugin-watch.js')
let watchModule: Watch

/** 每个用例一个独立目录树。 */
let root = ''

function tempDir(): string {
  root = mkdtempSync(join(HOME, 'case-'))
  return root
}

/**
 * 写文件并让指纹一定变化。
 *
 * 时钟必须**单调递增**：`Date.now() + 1000` 在同一毫秒里连写两次会得到相同的 mtimeMs，
 * 指纹（mtimeMs + size）不变，第二轮变更就被漏检（CI Node 22 上实测偶发）。这里用
 * 模块级计数器往前推，保证每次写都比上一次晚，跟机器快慢无关。
 */
let fingerprintClock = Date.now()
function writeChanged(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
  fingerprintClock += 1_500
  const later = new Date(fingerprintClock)
  utimesSync(file, later, later)
}

/** 记日志的 logger。 */
function loggerSpy() {
  const infos: string[] = []
  const warns: string[] = []
  return { infos, warns, info: (line: string) => infos.push(line), warn: (line: string) => warns.push(line) }
}

/** 一行 + 它自己的目录。 */
function rowSetup(overrides: Record<string, unknown> = {}) {
  const dir = tempDir()
  const rowDir = join(dir, 'row')
  mkdirSync(rowDir, { recursive: true })
  const file = join(rowDir, 'index.js')
  writeFileSync(file, 'v1\n', 'utf8')
  const calls: string[] = []
  const logger = loggerSpy()
  const handle = watchModule.createPluginWatch({
    appDir: join(dir, 'app'),
    pollIntervalMs: 60_000,
    targets: () => [{ identity: 'row1', file }],
    dirsOf: () => [rowDir],
    remount: async (identity) => {
      calls.push(identity)
      return { ok: true, generation: 7 }
    },
    logger,
    ...overrides,
  })
  return { dir, file, rowDir, calls, logger, handle }
}

async function importWatch(): Promise<void> {
  if (watchModule === undefined) watchModule = await import('./plugin-watch.js')
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  loaderMock.adopt = null
  loaderMock.reconcile = null
  loaderMock.adopted = []
  watchModule?.stopPluginWatch()
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  root = ''
})

describe('缺省日志与缺省实现', () => {
  test('没传 logger：info / warn 都写 stderr（不静默）', async () => {
    await importWatch()
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const dir = tempDir()
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, 'v1\n', 'utf8')
    let fail = false
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [{ identity: 'row1', file }],
      dirsOf: () => [rowDir],
      remount: async () => {
        if (fail) throw new Error('重挂炸了')
        return { ok: true, generation: 1 }
      },
    })
    writeChanged(file, 'v2\n')
    await handle.pollNow()
    await vi.waitFor(() => expect(writes.some((line) => line.includes('已换成新代码'))).toBe(true), {
      timeout: 3_000,
    })

    fail = true
    writeChanged(file, 'v3\n')
    await handle.pollNow()
    await vi.waitFor(() => expect(writes.some((line) => line.includes('重挂出错'))).toBe(true), {
      timeout: 3_000,
    })
    handle.stop()
  })

  test('没给 adopt：缺省实现动态 import loader 扫外部目录', async () => {
    await importWatch()
    const dir = tempDir()
    const installDir = join(dir, 'installed')
    mkdirSync(installDir, { recursive: true })
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      installDir,
      targets: () => [],
      dirsOf: () => [],
      remount: async () => ({ ok: true, generation: 1 }),
      logger: loggerSpy(),
    })
    writeFileSync(join(installDir, 'new.js'), 'x\n', 'utf8')
    // 第一轮只记指纹，第二轮指纹稳定才交给 adopt。
    await handle.pollNow()
    await handle.pollNow()
    expect(loaderMock.adopted).toEqual(['new.js'])
    handle.stop()
  })

  test('等指纹稳定期间文件又变了：重新记指纹，下一轮稳定才交出去', async () => {
    await importWatch()
    const dir = tempDir()
    const installDir = join(dir, 'installed')
    mkdirSync(installDir, { recursive: true })
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      installDir,
      targets: () => [],
      dirsOf: () => [],
      remount: async () => ({ ok: true, generation: 1 }),
      logger: loggerSpy(),
    })
    const file = join(installDir, 'new.js')
    writeFileSync(file, 'x\n', 'utf8')
    await handle.pollNow()
    // 指纹变了：这一轮不能算写完（否则会挂半个文件）。
    writeChanged(file, 'x-longer\n')
    await handle.pollNow()
    expect(loaderMock.adopted).toEqual([])
    await handle.pollNow()
    expect(loaderMock.adopted).toEqual(['new.js'])
    handle.stop()
  })
})

describe('坏清单与读不动的目录', () => {
  test('isOwnPackageDir：package.json 坏掉按「不是自己的包」处理', async () => {
    await importWatch()
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), '{坏清单', 'utf8')
    writeFileSync(join(dir, 'plugin.js'), 'x\n', 'utf8')
    expect(watchModule.watchDirsOf(join(dir, 'plugin.js'))).toEqual([])
  })

  test('listSourceFiles：目录读不动给空表，不炸整轮扫描', async () => {
    await importWatch()
    const dir = tempDir()
    const file = join(dir, 'row.js')
    writeFileSync(file, 'v1\n', 'utf8')
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [{ identity: 'row1', file }],
      dirsOf: () => [join(dir, 'missing-dir')],
      remount: async () => ({ ok: true, generation: 1 }),
      logger,
    })
    await handle.pollNow()
    expect(logger.warns).toEqual([])
    handle.stop()
  })

  test('库包清单坏掉的那一条跳过，其余照常建图', async () => {
    await importWatch()
    const dir = tempDir()
    const libs = join(dir, 'app', 'lib', 'node_modules', '@pneuma')
    mkdirSync(join(libs, 'broken'), { recursive: true })
    writeFileSync(join(libs, 'broken', 'package.json'), '{坏清单', 'utf8')
    const file = join(dir, 'row.js')
    writeFileSync(file, "import '@pneuma/broken'\n", 'utf8')
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [{ identity: 'row1', file }],
      dirsOf: () => [dir],
      remount: async () => ({ ok: true, generation: 1 }),
      logger: loggerSpy(),
    })
    await expect(handle.pollNow()).resolves.toBeUndefined()
    handle.stop()
  })
})

describe('库包变更：一批重挂失败各记一行', () => {
  test('重挂失败的行写 warn（旧版本继续运行）', async () => {
    await importWatch()
    const dir = tempDir()
    const libs = join(dir, 'app', 'lib', 'node_modules', '@pneuma')
    mkdirSync(join(libs, 'libpkg'), { recursive: true })
    writeFileSync(
      join(libs, 'libpkg', 'package.json'),
      JSON.stringify({ name: '@pneuma/libpkg', pneuma: { library: true } }),
      'utf8',
    )
    const libFile = join(libs, 'libpkg', 'index.js')
    writeFileSync(libFile, 'export const v = 1\n', 'utf8')
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, "import '@pneuma/libpkg'\n", 'utf8')
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [{ identity: 'row1', file }],
      dirsOf: () => [rowDir],
      remount: async () => ({ ok: true, generation: 1 }),
      remountMany: async (ids) => ids.map(() => ({ ok: false, generation: 3, problem: '新版本炸了' })),
      logger,
    })
    writeChanged(libFile, 'export const v = 2\n')
    await handle.pollNow()
    expect(logger.warns.some((line) => line.includes('热重挂失败，旧版本继续运行'))).toBe(true)
    handle.stop()
  })
})

describe('profile 清单变了：重算与换图通知', () => {
  test('emit 抛错只记一行 warn（通知失败不影响已挂的行）', async () => {
    await importWatch()
    loaderMock.reconcile = async () => ({ mounted: ['row-new'], unmounted: [], failures: [], warnings: [] })
    const dir = tempDir()
    const appDir = join(dir, 'app')
    const profileDir = join(dir, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    const warns: string[] = []
    const root = {
      logger: { info: () => {}, warn: (line: string) => warns.push(line) },
      emit: () => {
        throw new Error('界面通道断了')
      },
      get: () => undefined,
    }
    const handle = watchModule.startPluginWatch(root as never, { appDir, profileDir })
    writeChanged(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: {} }))
    await handle.pollNow()
    expect(warns.some((line) => line.includes('通知界面换图失败'))).toBe(true)
  })

  test('root 没有 logger：退回 stderr，并且重算出错也看得见', async () => {
    await importWatch()
    loaderMock.reconcile = async () => {
      throw new Error('组合包重算炸了')
    }
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const dir = tempDir()
    const profileDir = join(dir, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    const handle = watchModule.startPluginWatch({} as never, { appDir: join(dir, 'app'), profileDir })
    writeChanged(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: {} }))
    await handle.pollNow()
    expect(writes.some((line) => line.includes('已开'))).toBe(true)
    expect(writes.some((line) => line.includes('重算组合包出错'))).toBe(true)
  })
})

describe('轮询与 flush 的错误兜底', () => {
  test('定时轮询里 scan 抛错：记一行 warn，轮询不停', async () => {
    await importWatch()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(HOME, 'no-app'),
      pollIntervalMs: 100,
      debounceMs: 10,
      targets: () => {
        throw new Error('读行清单挂了')
      },
      dirsOf: () => [],
      remount: async () => ({ ok: true, generation: 1 }),
      logger,
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(logger.warns.some((line) => line.includes('轮询出错'))).toBe(true)
    handle.stop()
  })

  test('定时轮询里 flush 抛错：记一行 warn', async () => {
    await importWatch()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = tempDir()
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, 'v1\n', 'utf8')
    let calls = 0
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 100,
      debounceMs: 10,
      targets: () => {
        calls += 1
        // 建表那一次正常；轮询的 scan 正常；flush 里再取一次行清单时才炸。
        if (calls >= 3) throw new Error('flush 里读挂了')
        return [{ identity: 'row1', file }]
      },
      dirsOf: () => [rowDir],
      remount: async () => ({ ok: true, generation: 1 }),
      logger,
    })
    writeChanged(file, 'v2\n')
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(10)
    expect(logger.warns.some((line) => line.includes('重挂出错'))).toBe(true)
    handle.stop()
  })

  test('pollNow 里 scan 抛错：记一行 warn 后直接返回', async () => {
    await importWatch()
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(HOME, 'no-app'),
      pollIntervalMs: 60_000,
      targets: () => {
        throw new Error('读行清单挂了')
      },
      dirsOf: () => [],
      remount: async () => ({ ok: true, generation: 1 }),
      logger,
    })
    await handle.pollNow()
    expect(logger.warns.some((line) => line.includes('轮询出错'))).toBe(true)
    handle.stop()
  })

  test('pollNow 里 flush 抛错：记一行 warn', async () => {
    await importWatch()
    const dir = tempDir()
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, 'v1\n', 'utf8')
    let calls = 0
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => {
        calls += 1
        if (calls >= 3) throw new Error('flush 里读挂了')
        return [{ identity: 'row1', file }]
      },
      dirsOf: () => [rowDir],
      remount: async () => ({ ok: true, generation: 1 }),
      logger,
    })
    writeChanged(file, 'v2\n')
    await handle.pollNow()
    expect(logger.warns.some((line) => line.includes('重挂出错'))).toBe(true)
    handle.stop()
  })

  test('pollNow 会清掉已经排上的去抖定时器（不让它再跑一遍）', async () => {
    await importWatch()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = tempDir()
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, 'v1\n', 'utf8')
    let calls = 0
    const logger = loggerSpy()
    const handle = watchModule.createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 100,
      debounceMs: 10_000,
      targets: () => [{ identity: 'row1', file }],
      dirsOf: () => [rowDir],
      remount: async (identity) => {
        calls += 1
        return { ok: true, generation: 1 }
      },
      logger,
    })
    writeChanged(file, 'v2\n')
    // 轮询这一下只把去抖定时器排上，不立刻重挂。
    await vi.advanceTimersByTimeAsync(100)
    await handle.pollNow()
    expect(calls).toBe(1)
    handle.stop()
  })
})
