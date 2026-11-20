/**
 * 日志落盘器的两条异常兜底（w14）：
 *
 *   - `dirBytes` 读不动某一天的目录时按 0 字节算（清理不因为权限问题中断）；
 *   - `flush` 写盘失败时关掉句柄、丢掉这一批，不让宿主崩掉。
 *
 * 两条都要「文件系统在特定路径上失败」，真实盘上造不出来（得靠权限或竞态），
 * 所以对 `node:fs` 做最小替身：只按开关让 `writeSync` / `readdirSync` 抛错，
 * 其余调用原样交给真实实现。目录都是 mkdtemp，收尾清理。
 *
 * @module dsc/packages/log/tests/w14-gaps.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  failWrite: false,
  failReaddirSuffix: null as string | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const writeSync = (...args: Parameters<typeof actual.writeSync>): number => {
    if (state.failWrite) throw new Error('EBADF: 句柄已经坏了')
    return actual.writeSync(...args)
  }
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    if (state.failReaddirSuffix !== null && String(args[0]).endsWith(state.failReaddirSuffix)) {
      throw new Error('EACCES: 这一天读不动')
    }
    return actual.readdirSync(...args)
  }) as typeof actual.readdirSync
  return { ...actual, writeSync, readdirSync }
})

let LogSink: (typeof import('../sink.js'))['LogSink']

const roots: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  state.failWrite = false
  state.failReaddirSuffix = null
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 句柄：留给系统清
    }
  }
})

test('清理旧日志时某一天读不动：按 0 字节算，目录照样删', async () => {
  ;({ LogSink } = await import('../sink.js'))
  const dir = tempDir('dsc-log-w14-prune-')
  const oldDay = '2020-01-01'
  mkdirSync(join(dir, oldDay), { recursive: true })
  writeFileSync(join(dir, oldDay, 'dsc-1.jsonl'), 'x'.repeat(64), 'utf8')

  const sink = new LogSink({ dir, keepDays: 7 })
  state.failReaddirSuffix = oldDay
  const result = sink.prune(true)
  expect(result.dirs).toBe(1)
  expect(result.bytes).toBe(0)
})

test('写盘失败：关掉句柄、丢掉这一批，之后还能重新打开继续写', async () => {
  ;({ LogSink } = await import('../sink.js'))
  const dir = tempDir('dsc-log-w14-write-')
  const sink = new LogSink({ dir })
  state.failWrite = true
  sink.write('这一行写不进去')
  expect(() => sink.flush()).not.toThrow()
  expect(sink.size()).toBe(0)

  // 失败分支把句柄关了：恢复后下一次 flush 会重新 open，写入正常累加。
  state.failWrite = false
  sink.write('这一行能写进去')
  sink.flush()
  expect(sink.size()).toBeGreaterThan(0)
  sink.close()
})
