/**
 * memory 收尾缺口：`memory.ts` 的 246/446-447/451/777 与 `index.ts` 的 568-571。
 *
 * 两组场景真磁盘造不出来、也不该靠权限碰运气，所以把 `node:fs` 的三个调用包一层
 * （其余原样透传）：
 *   - 读路径发现外部改动、且留副本失败 → `backupFile` 的兜底空串（246）；
 *   - 读的时候还没改、落盘前一瞬被外面改掉 → 写前复检的拒绝与「现状回读」（446-447、451）；
 *   - `statSync` 抛错 → 整理时用「现在」当陈旧基准兜底（777）；
 *   - 设置页条目下拉的搜索命中：真有条目且关键词命中时才走到 map/filter（568-571）。
 *
 * 三格文件分别用 global / user / workspace 三个目标，避免模块级 `lastKnown` 互相干扰；
 * `DSC_HOME` 在动态 import 之前指到临时目录，一个字节都不碰真实 `~/.dsc`。
 *
 * @module @pneuma/memory/tests/w14-drift-and-entry-options.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-memory-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = join(HOME, '.dsc')

/** 三个 fs 调用的可控替身；为 null = 透传真实现。 */
const control = vi.hoisted(() => ({
  copyFileSync: null as null | ((...args: unknown[]) => unknown),
  readFileSync: null as null | ((...args: unknown[]) => unknown),
  statSync: null as null | ((...args: unknown[]) => unknown),
  actualReadFileSync: null as null | ((...args: unknown[]) => unknown),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  control.actualReadFileSync = actual.readFileSync as unknown as (...args: unknown[]) => unknown
  return {
    ...actual,
    copyFileSync: (...args: unknown[]) => {
      if (control.copyFileSync === null) return (actual.copyFileSync as unknown as (...args: unknown[]) => unknown)(...args)
      return control.copyFileSync(...args)
    },
    readFileSync: (...args: unknown[]) => {
      if (control.readFileSync === null) return (actual.readFileSync as unknown as (...args: unknown[]) => unknown)(...args)
      return control.readFileSync(...args)
    },
    statSync: (...args: unknown[]) => {
      if (control.statSync === null) return (actual.statSync as unknown as (...args: unknown[]) => unknown)(...args)
      return control.statSync(...args)
    },
  }
})

const mem = await import('../memory.js')
const { memoryPlugin } = await import('../index.js')

/** 每个用例自己的 cwd：workspace 那格的文件路径按它算，互不干扰。 */
function workdir(name: string): string {
  const dir = join(HOME, `ws-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 直接把某格文件写出来（绕过写入面，造前置状态）。 */
function seedCell(target: 'global' | 'user' | 'workspace', cwd: string, entries: string[]): string {
  const file = mem.memoryFileOf(target, cwd)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, mem.joinEntries(entries), 'utf8')
  return file
}

/** 取某格文件在磁盘上的真实内容（绕过 mock 的直读）。 */
function actualText(file: string): string {
  const read = control.actualReadFileSync
  return read === null ? '' : String(read(file, 'utf8'))
}

afterEach(() => {
  control.copyFileSync = null
  control.readFileSync = null
  control.statSync = null
})

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：临时目录留给系统清。
  }
})

test('写前复检：读完之后文件又被外面改过，就拒绝写入并把现状留副本、回吐条目', () => {
  const cwd = workdir('drift-before-write')
  const file = seedCell('global', cwd, ['原有事实'])
  // 先登记一次指纹（真实用法里本来就是读写过的）。
  mem.readCell('global', cwd)

  // 第一次读（这个文件在 applyMemoryOperations 开头的 readCell）仍返回旧内容，
  // 第二次读（落盘前的复检）返回外部改动后的内容——模拟「读与写之间被人改了」。
  let reads = 0
  control.readFileSync = (path: unknown, options: unknown) => {
    if (String(path) !== file) return control.actualReadFileSync!(path, options)
    reads += 1
    return reads === 1 ? mem.joinEntries(['原有事实']) : mem.joinEntries(['外面改成的新事实'])
  }

  const result = mem.applyMemoryOperations([{ action: 'add', target: 'global', content: '这条不该落盘' }], cwd)
  const failedCells = result.cells ?? []

  expect(result.ok).toBe(false)
  expect(result.error).toContain('写之前发现这份文件又被外面改过了')
  expect(result.error).toContain('现状留了副本')
  expect(failedCells).toHaveLength(1)
  // 回吐的是重新读回来的现状（readCell 第二次读到外部那份，因此带上 problem）。
  expect(failedCells[0]!.entries).toEqual(['外面改成的新事实'])
  expect(failedCells[0]!.problem).toContain('被外面改动过')
  // 磁盘上的原文没被这次写入覆盖。
  control.readFileSync = null
  expect(actualText(file)).toBe(mem.joinEntries(['原有事实']))
})

test('读路径发现外部改动但留副本失败：problem 照报，只是不提副本（backupFile 兜底空串）', () => {
  const cwd = workdir('backup-fail')
  const file = seedCell('user', cwd, ['旧的用户偏好'])
  // 登记一次指纹。
  mem.readCell('user', cwd)

  writeFileSync(file, mem.joinEntries(['外面改过的用户偏好']), 'utf8')
  control.copyFileSync = () => {
    throw new Error('EACCES: permission denied')
  }

  const cell = mem.readCell('user', cwd)
  expect(cell.problem).toContain('用户偏好那格记忆文件被外面改动过')
  expect(cell.problem).not.toContain('副本')
  // 内容照常读出来，这一轮只读不写。
  expect(cell.entries).toEqual(['外面改过的用户偏好'])
})

test('整理时 statSync 抛错：用「现在」当陈旧基准，条目照样被移进归档', () => {
  const cwd = workdir('prune-stat-fail')
  const file = seedCell('workspace', cwd, ['从没被引用过的旧条目'])
  // pruneCells 只对参与整理的这一格调 statSync：直接让它抛错就是 777 那条兜底。
  control.statSync = () => {
    throw new Error('EACCES: permission denied')
  }

  const now = Date.now()
  const result = mem.pruneCells(
    cwd,
    mem.MEMORY_LIMIT_DEFAULTS,
    { global: false, user: false, workspace: true },
    {
      afterDays: 0,
      now,
      usage: {},
    },
  )

  expect(result.moved.workspace).toEqual(['从没被引用过的旧条目'])
  expect(result.archivePaths.workspace).toContain('MEMORY.archive.md')
  control.statSync = null
  expect(actualText(result.archivePaths.workspace)).toContain('从没被引用过的旧条目')
  expect(actualText(file)).toBe('')
})

// ── 插件设置面：条目下拉的搜索命中 ──────────────────────────────────────────────

/** 捕获到的设置分区。 */
interface CapturedSection {
  save: (key: string, value: unknown) => string | void
  values: () => Record<string, unknown>
}

/** 假 ctx：apply 用到的面都实现；`effect` 真跑回调，否则注册不会发生。 */
function mountMemory(): CapturedSection {
  const captured = { section: undefined as unknown as CapturedSection }
  const ctx = {
    tools: { register: () => () => undefined },
    commands: { register: () => () => undefined },
    prompt: { register: () => () => undefined, registerProjection: () => () => undefined },
    transcript: { system: () => undefined },
    approval: { decide: async () => 'allow' },
    session: { current: () => ({ meta: { cwd: workdir('settings'), id: 'w14-memory' }, messages: [] }) },
    settings: {
      registerSection: (spec: CapturedSection) => {
        captured.section = spec
        return () => undefined
      },
    },
    provide: () => () => undefined,
    on: () => () => undefined,
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    emit: () => undefined,
    agent: { followup: () => undefined },
  }
  memoryPlugin.apply(ctx as never, undefined)
  return captured.section
}

test('设置页条目下拉：搜索词命中若干条时按原下标给出选项，第一条命中被自动选中', () => {
  const cwd = workdir('settings')
  seedCell('global', cwd, ['甲条：构建命令是 pnpm build', '乙条：命名口径用中文'])
  const section = mountMemory()

  section.save('cell', 'global')
  section.save('search', '命名')
  const values = section.values()
  // 命中第二条（下标 1）：下拉第一项被自动选中。
  expect(values.entry).toBe('1')
  expect(values.search).toBe('命名')

  // 清掉搜索词后：全部条目重新进入下拉，选中回到第一条（下标 0）。
  section.save('search', '')
  expect(section.values().entry).toBe('0')
})
