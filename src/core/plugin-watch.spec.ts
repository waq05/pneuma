/**
 * 功能包热更轮询（`core/plugin-watch.ts`）：行改代码 / 库包变更 / profile 清单 / 外部插件目录。
 *
 * 全部走注入面：目标、目录、重挂、重算、扫目录都是假的，只有磁盘指纹是真的。
 * 不依赖定时器（`pollIntervalMs` 调大，靠 `pollNow()` 手动驱动），不碰 `~/.dsc`。
 *
 * @module dsc/core/plugin-watch.spec
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createPluginWatch,
  startPluginWatch,
  stopPluginWatch,
  watchDirsOf,
  type PluginWatchLogger,
  type PluginWatchOptions,
} from './plugin-watch.js'

let root = ''

/** 每个用例一个独立目录树。 */
function tempDir(): string {
  root = mkdtempSync(join(tmpdir(), 'dsc-plugin-watch-'))
  return root
}

afterEach(() => {
  stopPluginWatch()
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

/** 写一个文件并确保指纹变化（同一毫秒内连写两次也认得出）。 */
function writeChanged(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
  const later = new Date(Date.now() + 1_000)
  utimesSync(file, later, later)
}

function loggerSpy(): PluginWatchLogger & { infos: string[]; warns: string[] } {
  const infos: string[] = []
  const warns: string[] = []
  return {
    infos,
    warns,
    info: (line) => infos.push(line),
    warn: (line) => warns.push(line),
  }
}

describe('watchDirsOf', () => {
  test('再导出桩：盯真实代码目录 + 包目录', () => {
    const dir = tempDir()
    const pkg = join(dir, 'pkg')
    const real = join(pkg, '..', 'real')
    mkdirSync(pkg, { recursive: true })
    mkdirSync(real, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    writeFileSync(join(pkg, 'index.js'), `export * from '${join('..', 'real', 'index.js').replace(/\\/g, '/')}';\n`, 'utf8')
    const dirs = watchDirsOf(join(pkg, 'index.js'))
    expect(dirs).toContain(real)
    expect(dirs).toContain(pkg)
  })

  test('散装插件：只有自己的包（清单带 pneuma/dsh 身份段）才整目录盯', () => {
    const dir = tempDir()
    const own = join(dir, 'own')
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, 'package.json'), JSON.stringify({ name: 'x', dsh: {} }), 'utf8')
    writeFileSync(join(own, 'index.js'), 'module.exports = { apply() {} }\n', 'utf8')
    expect(watchDirsOf(join(own, 'index.js'))).toEqual([own])

    const foreign = join(dir, 'foreign')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'not-a-plugin' }), 'utf8')
    writeFileSync(join(foreign, 'plugin.js'), 'x\n', 'utf8')
    expect(watchDirsOf(join(foreign, 'plugin.js'))).toEqual([])
  })

  test('文件不在 / 桩太大：当作普通模块，不猜', () => {
    const dir = tempDir()
    expect(watchDirsOf(join(dir, 'missing.js'))).toEqual([])
    const big = join(dir, 'big.js')
    writeFileSync(big, 'x'.repeat(5_000), 'utf8')
    expect(watchDirsOf(big)).toEqual([])
  })
})

describe('行自己的代码变了', () => {
  /** 一行 + 它自己的目录。 */
  function rowSetup(overrides: Partial<PluginWatchOptions> = {}) {
    const dir = tempDir()
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, 'v1\n', 'utf8')
    const calls: string[] = []
    const logger = loggerSpy()
    const handle = createPluginWatch({
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
    return { dir, file, calls, logger, handle }
  }

  test('建轮询器只立基线：没改过就不重挂', async () => {
    const { calls, handle } = rowSetup()
    await handle.pollNow()
    expect(calls).toEqual([])
    handle.stop()
    expect(handle.running).toBe(false)
  })

  test('改了文件：pollNow 立刻重挂一次并记一行 info', async () => {
    const { file, calls, logger, handle } = rowSetup()
    writeChanged(file, 'v2-with-more-bytes\n')
    await handle.pollNow()
    expect(calls).toEqual(['row1'])
    expect(logger.infos.some((line) => line.includes('已换成新代码') && line.includes('代数 7'))).toBe(true)
    expect(handle.running).toBe(true)
  })

  test('重挂失败 / 抛错：各记一行 warn，不打断轮询', async () => {
    const { file, logger, handle } = rowSetup({
      remount: async () => ({ ok: false, generation: 3, problem: '语法错误' }),
    })
    writeChanged(file, 'v2\n')
    await handle.pollNow()
    expect(logger.warns.some((line) => line.includes('热重挂失败') && line.includes('语法错误'))).toBe(true)

    const throwing = rowSetup({
      remount: async () => {
        throw new Error('炸了')
      },
    })
    writeChanged(throwing.file, 'v2\n')
    await throwing.handle.pollNow()
    expect(throwing.logger.warns.some((line) => line.includes('重挂出错') && line.includes('炸了'))).toBe(true)
    throwing.handle.stop()
  })

  test('扫描时还在、flush 前已被卸下的行不重挂', async () => {
    const dir = tempDir()
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const file = join(rowDir, 'index.js')
    writeFileSync(file, 'v1\n', 'utf8')
    let calls = 0
    const callsToRemount: string[] = []
    const handle = createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      // 第一次（scan）还挂着，第二次（flush 里的 alive 集合）已经卸了。
      targets: () => (calls++ === 0 ? [{ identity: 'row1', file }] : []),
      dirsOf: () => [rowDir],
      remount: async (identity) => {
        callsToRemount.push(identity)
        return { ok: true, generation: 1 }
      },
      logger: loggerSpy(),
    })
    writeChanged(file, 'v2\n')
    await handle.pollNow()
    expect(callsToRemount).toEqual([])
    handle.stop()
  })
})

describe('库包变更', () => {
  /** appDir 里一个库包 + 两个引用它的行。 */
  function libSetup(options: { batch?: boolean } = {}) {
    const dir = tempDir()
    const app = join(dir, 'app')
    const libPkg = join(app, 'lib', 'node_modules', '@pneuma', 'lib-x')
    const libReal = join(app, 'lib', 'packages', 'lib-x')
    mkdirSync(libPkg, { recursive: true })
    mkdirSync(libReal, { recursive: true })
    writeFileSync(join(libPkg, 'package.json'), JSON.stringify({ name: '@pneuma/lib-x', pneuma: { library: true } }), 'utf8')
    const libStub = join(libPkg, 'index.js')
    writeFileSync(libStub, "export * from '../../../packages/lib-x/index.js';\n", 'utf8')
    const libFile = join(libReal, 'index.js')
    writeFileSync(libFile, 'export const x = 1\n', 'utf8')

    const rows: string[] = []
    for (const id of ['row1', 'row2']) {
      const rowDir = join(dir, id)
      mkdirSync(rowDir, { recursive: true })
      const file = join(rowDir, 'index.js')
      writeFileSync(file, "import { x } from '@pneuma/lib-x'\nexport const y = x\n", 'utf8')
      rows.push(file)
    }
    const perRow: string[] = []
    const batched: string[][] = []
    const logger = loggerSpy()
    const handle = createPluginWatch({
      appDir: app,
      pollIntervalMs: 60_000,
      targets: () => [
        { identity: 'row1', file: rows[0]! },
        { identity: 'row2', file: rows[1]! },
      ],
      dirsOf: (file) => [join(dir, file.includes('row1') ? 'row1' : 'row2')],
      remount: async (identity) => {
        perRow.push(identity)
        return { ok: true, generation: 9 }
      },
      ...(options.batch === false
        ? {}
        : {
            remountMany: async (identities) => {
              batched.push([...identities])
              return identities.map(() => ({ ok: true, generation: 9 }))
            },
          }),
      logger,
    })
    return { dir, libFile, perRow, batched, logger, handle }
  }

  test('库包改了：引用它的行合并成一批重挂，只写一行 info', async () => {
    const { libFile, batched, perRow, logger, handle } = libSetup()
    writeChanged(libFile, 'export const x = 2\n')
    await handle.pollNow()
    expect(batched).toEqual([['row1', 'row2']])
    expect(perRow).toEqual([])
    expect(logger.infos.some((line) => line.includes('lib-x') && line.includes('已重挂 2 行'))).toBe(true)
    handle.stop()
  })

  test('没给 remountMany 时退化成逐行重挂', async () => {
    const { libFile, perRow, batched, handle } = libSetup({ batch: false })
    writeChanged(libFile, 'export const x = 2\n')
    await handle.pollNow()
    expect(batched).toEqual([])
    expect(perRow.sort()).toEqual(['row1', 'row2'])
    handle.stop()
  })

  test('批量重挂抛错：记一行 warn，不当成成功', async () => {
    const dir = tempDir()
    const app = join(dir, 'app')
    const libPkg = join(app, 'lib', 'node_modules', '@pneuma', 'lib-y')
    const libReal = join(app, 'lib', 'packages', 'lib-y')
    mkdirSync(libPkg, { recursive: true })
    mkdirSync(libReal, { recursive: true })
    writeFileSync(join(libPkg, 'package.json'), JSON.stringify({ name: '@pneuma/lib-y', pneuma: { library: true } }), 'utf8')
    writeFileSync(join(libPkg, 'index.js'), "export * from '../../../packages/lib-y/index.js';\n", 'utf8')
    const libFile = join(libReal, 'index.js')
    writeFileSync(libFile, 'export const y = 1\n', 'utf8')
    const rowDir = join(dir, 'row')
    mkdirSync(rowDir, { recursive: true })
    const rowFile = join(rowDir, 'index.js')
    writeFileSync(rowFile, "import { y } from '@pneuma/lib-y'\n", 'utf8')
    const spy = loggerSpy()
    const throwing = createPluginWatch({
      appDir: app,
      pollIntervalMs: 60_000,
      targets: () => [{ identity: 'row1', file: rowFile }],
      dirsOf: () => [rowDir],
      remountMany: async () => {
        throw new Error('批量炸了')
      },
      logger: spy,
    })
    writeChanged(libFile, 'export const y = 2\n')
    await throwing.pollNow()
    expect(spy.warns.some((line) => line.includes('库包变更后重挂出错') && line.includes('批量炸了'))).toBe(true)
    throwing.stop()
  })
})

describe('profile 清单与外部插件目录', () => {
  test('profile 清单变了：重算组合包、写日志、通知界面换图', async () => {
    const dir = tempDir()
    const profile = join(dir, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    const emits: string[] = []
    const logger = loggerSpy()
    const reconciles: string[] = []
    const handle = createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [],
      dirsOf: () => [],
      profileDir: profile,
      root: {
        emit: (name: string) => emits.push(name),
      } as unknown as PluginWatchOptions['root'],
      reconcile: async (profileDir) => {
        reconciles.push(profileDir)
        return { mounted: ['row-x'], unmounted: [], failures: [{ file: 'row-y', name: 'row-y', problem: '缺依赖' }], warnings: ['版本闸没过'] }
      },
      logger,
    })
    writeChanged(join(profile, 'package.json'), JSON.stringify({ name: 'p', version: '2' }))
    await handle.pollNow()
    expect(reconciles).toEqual([profile])
    expect(emits).toContain('dsc/ui-graph-dirty')
    expect(logger.infos.some((line) => line.includes('挂了 1 行 / 卸了 0 行'))).toBe(true)
    expect(logger.warns.some((line) => line.includes('row-y') && line.includes('缺依赖'))).toBe(true)
    expect(logger.warns.some((line) => line.includes('组合包：版本闸没过'))).toBe(true)
    handle.stop()
  })

  test('重算抛错：记一行 warn，不打断轮询', async () => {
    const dir = tempDir()
    const profile = join(dir, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    const logger = loggerSpy()
    const handle = createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [],
      dirsOf: () => [],
      profileDir: profile,
      reconcile: async () => {
        throw new Error('行 id 重复')
      },
      logger,
    })
    writeChanged(join(profile, 'package.json'), JSON.stringify({ name: 'p', version: '2' }))
    await handle.pollNow()
    expect(logger.warns.some((line) => line.includes('重算组合包出错') && line.includes('行 id 重复'))).toBe(true)
    handle.stop()
  })

  test('外部目录：新文件要等两轮指纹稳定才交出去，删文件立刻扫', async () => {
    const dir = tempDir()
    const install = join(dir, 'plugins')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, 'a.js'), 'a\n', 'utf8')
    const calls: string[][] = []
    const logger = loggerSpy()
    const handle = createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [],
      dirsOf: () => [],
      installDir: install,
      adopt: async (only) => {
        calls.push([...only])
        return { mounted: [...only], unmounted: ['a.js'], failures: [{ file: 'bad.js', name: 'bad', problem: '坏了' }] }
      },
      logger,
    })

    writeChanged(join(install, 'b.js'), 'b\n')
    await handle.pollNow()
    expect(calls).toEqual([]) // 刚出现：只记指纹

    await handle.pollNow()
    expect(calls).toEqual([['b.js']]) // 指纹稳定：交出去
    expect(logger.infos.some((line) => line.includes('已挂上 1 个'))).toBe(true)
    expect(logger.infos.some((line) => line.includes('已卸 1 个'))).toBe(true)
    expect(logger.warns.some((line) => line.includes('bad') && line.includes('坏了'))).toBe(true)

    rmSync(join(install, 'a.js'))
    await handle.pollNow()
    expect(calls.at(-1)).toEqual([]) // 少了文件：立刻扫一遍（也许没别的可挂）
    handle.stop()
  })

  test('扫外部目录抛错：记一行 warn', async () => {
    const dir = tempDir()
    const install = join(dir, 'plugins')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, 'a.js'), 'a\n', 'utf8')
    const logger = loggerSpy()
    const handle = createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [],
      dirsOf: () => [],
      installDir: install,
      adopt: async () => {
        throw new Error('目录读不了')
      },
      logger,
    })
    rmSync(join(install, 'a.js'))
    await handle.pollNow()
    expect(logger.warns.some((line) => line.includes('扫外部插件目录出错') && line.includes('目录读不了'))).toBe(true)
    handle.stop()
  })

  test('setProfileDir：null 是空操作；换目录当场立基线，下一轮改了才算', async () => {
    const dir = tempDir()
    const profile = join(dir, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    const reconciles: string[] = []
    const handle = createPluginWatch({
      appDir: join(dir, 'app'),
      pollIntervalMs: 60_000,
      targets: () => [],
      dirsOf: () => [],
      reconcile: async (profileDir) => {
        reconciles.push(profileDir)
        return { mounted: [], unmounted: [], failures: [], warnings: [] }
      },
      logger: loggerSpy(),
    })
    handle.setProfileDir(null)
    handle.setProfileDir(profile)
    await handle.pollNow()
    expect(reconciles).toEqual([])
    writeChanged(join(profile, 'package.json'), JSON.stringify({ name: 'p', version: '2' }))
    await handle.pollNow()
    expect(reconciles).toEqual([profile])
    handle.stop()
  })
})

describe('startPluginWatch / stopPluginWatch', () => {
  test('DSC_HOT=0：给一个不建定时器的空句柄', async () => {
    const old = process.env['DSC_HOT']
    process.env['DSC_HOT'] = '0'
    try {
      const handle = startPluginWatch({} as never)
      expect(handle.running).toBe(false)
      await expect(handle.pollNow()).resolves.toBeUndefined()
      handle.stop()
      handle.setProfileDir('/x')
    } finally {
      if (old === undefined) delete process.env['DSC_HOT']
      else process.env['DSC_HOT'] = old
    }
  })

  test('同一个进程只有一个轮询器：第二次只补 profile 这一路', () => {
    const dir = tempDir()
    const profile = join(dir, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8')
    const infos: string[] = []
    const fakeRoot = {
      logger: { info: (line: string) => infos.push(line), warn: () => {} },
      emit: () => {},
    } as never
    const first = startPluginWatch(fakeRoot, { appDir: join(dir, 'app') })
    const second = startPluginWatch(fakeRoot, { appDir: join(dir, 'app'), profileDir: profile })
    expect(second).toBe(first)
    expect(infos.filter((line) => line.includes('热更已开')).length).toBe(1)
    stopPluginWatch()
    expect(first.running).toBe(false)
  })
})
