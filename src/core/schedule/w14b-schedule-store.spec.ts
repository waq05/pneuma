/**
 * `core/schedule/store.ts` 的缺口补齐：读盘失败的兜底（任务文件/台账文件读不动或读不到）、
 * 台账 FIFO 链上「上一个失败不影响后一个」，以及台账行数缓存的两条盘面异常。
 *
 * 夹具是临时目录里的真文件；大部分失败用「把目标路径做成目录」制造，另外三条
 * （文件在、但这一瞬间读不到 / 看不见）用一层可替换的 `node:fs` 模拟——那是并发进程
 * 正在替换文件的窗口，真盘上没法稳定制造。不 sleep、不碰真实 `~/.dsc`。
 *
 * @module dsc/core/schedule/w14b-schedule-store.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScheduleStore, type ScheduleRun } from './store.js'

/** 假盘面的控制面：为 null = 透传真实现。 */
const control = vi.hoisted(() => ({
  /** 这个路径的 existsSync 说「看不见」（文件其实在）。 */
  invisible: '' as string,
  /** 这个路径的 readFileSync 一律抛。 */
  unreadable: '' as string,
  /** 这个路径的 readFileSync 从第 2 次起抛（第一次要拿到行数）。 */
  unreadableAfterFirst: '' as string,
  reads: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: unknown) => {
      if (control.invisible !== '' && String(path) === control.invisible) return false
      return actual.existsSync(path as never)
    },
    readFileSync: (...args: unknown[]) => {
      const path = String(args[0] ?? '')
      if (control.unreadable !== '' && path === control.unreadable) throw new Error('正在被替换，读不到')
      if (control.unreadableAfterFirst !== '' && path === control.unreadableAfterFirst) {
        control.reads += 1
        if (control.reads > 1) throw new Error('正在被替换，读不到')
      }
      return (actual.readFileSync as unknown as (...args: unknown[]) => unknown)(...args)
    },
  }
})

const NOW = Date.UTC(2026, 2, 9, 9, 30)

let root = ''
let dir = ''
let store: ScheduleStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsc-w14b-store-'))
  dir = join(root, 'schedule')
  mkdirSync(dir, { recursive: true })
  store = new ScheduleStore({ dir, now: () => NOW })
  control.invisible = ''
  control.unreadable = ''
  control.unreadableAfterFirst = ''
  control.reads = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

/** 一条台账记录。 */
function run(): ScheduleRun {
  return { at: NOW, id: 'sched-1', title: 'T', slot: NOW, status: 'ok', detail: 'due' }
}

describe('load：任务文件读不动（是个目录）', () => {
  test('按空清单处理并把原因写进 problem，不抛', () => {
    mkdirSync(store.tasksFile, { recursive: true })
    const loaded = store.load()
    expect(loaded.tasks).toEqual([])
    expect(loaded.problem).toContain('任务文件读不动')
    expect(store.problem).toContain('任务文件读不动')
  })
})

describe('recentRuns：台账读不动（是个目录）', () => {
  test('给空数组，不抛', () => {
    mkdirSync(store.runsFile, { recursive: true })
    expect(store.recentRuns()).toEqual([])
  })
})

describe('写盘串行链：上一次失败不阻塞下一次', () => {
  test('台账是目录时 appendRun 失败；下一行仍然照常开始（FIFO 链不断）', async () => {
    mkdirSync(store.runsFile, { recursive: true })
    await expect(store.appendRun(run())).rejects.toThrow()
    // 链尾仍是「已完成」：第二次调用照样执行并给出它自己的失败，而不是永远挂住。
    await expect(store.appendRun(run())).rejects.toThrow()
  })
})

describe('台账行数缓存：盘面并发替换的那一瞬间', () => {
  test('文件刚被别的进程删掉：行数按 0 算，这一条照常写入', async () => {
    control.invisible = store.runsFile
    await expect(store.appendRun(run())).resolves.toBeUndefined()
    control.invisible = ''
    expect(store.recentRuns()).toHaveLength(1)
  })

  test('数行时读不到台账：行数按 0 算，不抛', async () => {
    control.unreadable = store.runsFile
    await expect(store.appendRun(run())).resolves.toBeUndefined()
    control.unreadable = ''
    expect(store.recentRuns()).toHaveLength(1)
  })

  test('压缩台账时读不到：这一轮不压缩，写入本身照常完成', async () => {
    writeFileSync(store.runsFile, `${JSON.stringify(run())}\n${JSON.stringify(run())}\n${JSON.stringify(run())}\n`, 'utf8')
    const limited = new ScheduleStore({ dir, now: () => NOW, runLimit: 1 })
    control.unreadableAfterFirst = store.runsFile
    await expect(limited.appendRun(run())).resolves.toBeUndefined()
    control.unreadableAfterFirst = ''
    // 压缩那一步失败，文件保留 4 行（写入成功、压缩没做）。
    expect(limited.recentRuns(10)).toHaveLength(4)
  })
})

describe('正常路径：台账写入与读取', () => {
  test('appendRun 落一行，recentRuns 新的在前；空文件不算条目', async () => {
    await store.appendRun(run())
    writeFileSync(store.runsFile, `${JSON.stringify(run())}\n\n`, 'utf8')
    expect(store.recentRuns()).toHaveLength(1)
    expect(store.recentRuns()[0]).toMatchObject({ id: 'sched-1', status: 'ok' })
  })
})
