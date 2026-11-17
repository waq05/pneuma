/**
 * 会话写租约的锁（`core/lockfile.ts` + `core/os-lock.ts`）：OS 原生互斥、重入计数、`.lock` 说明文件。
 *
 * glibc 的 flock 与 Windows 命名互斥量都由真实内核对象承载；拿不到就返回 busy，
 * 本文件钉的正是「非阻塞、可重入、放锁不删锚点」这三条。
 *
 * @module dsc/core/lockfile.spec
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { acquireLock, LOCK_SUFFIX, withExclusiveLock } from './lockfile.js'
import { tryOsLock } from './os-lock.js'

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function target(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsc-lock-'))
  return join(dir, 'session.jsonl')
}

describe('tryOsLock', () => {
  test('同一把锁第二次是 busy，放掉后又能拿到', () => {
    const name = target()
    const first = tryOsLock(name)
    if (first.kind === 'unsupported') {
      expect(first.why).not.toBe('')
      return
    }
    if (first.kind !== 'ok') {
      expect(first.kind).toBe('ok')
      return
    }
    const second = tryOsLock(name)
    expect(second.kind).toBe('busy')
    first.lock.release()
    const third = tryOsLock(name)
    expect(third.kind).toBe('ok')
    if (third.kind === 'ok') third.lock.release()
    // release 可以重复调（句柄异常吞掉）。
    expect(() => first.lock.release()).not.toThrow()
  })

  test('不支持的平台给出原因，交给文件锁兜底', () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })
    try {
      const attempt = tryOsLock(target())
      expect(attempt).toMatchObject({ kind: 'unsupported' })
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })
})

describe('acquireLock', () => {
  test('拿锁写一份说明文件：后缀、pid 与 how', () => {
    const path = target()
    const lock = acquireLock(path)
    expect(lock).not.toBeNull()
    expect(existsSync(`${path}${LOCK_SUFFIX}`)).toBe(true)
    const info = JSON.parse(readFileSync(`${path}${LOCK_SUFFIX}`, 'utf8')) as { pid: number; how: string }
    expect(info.pid).toBe(process.pid)
    expect(['os', 'file']).toContain(info.how)
    lock!.release()
  })

  test('同一进程可重入：拿两次、放一次仍算持有，再放一次才自由', () => {
    const path = target()
    const first = acquireLock(path)
    const second = acquireLock(path)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    first!.release()
    // 计数还在：另一次 acquire 仍走重入分支（不碰 OS 锁），不会返回 busy。
    const third = acquireLock(path)
    expect(third).not.toBeNull()
    second!.release()
    third!.release()
  })

  test('不同目标的锁互不影响', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsc-lock-'))
    const a = acquireLock(join(dir, 'a.jsonl'))
    const b = acquireLock(join(dir, 'b.jsonl'))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    a!.release()
    b!.release()
  })
})

describe('withExclusiveLock', () => {
  test('跑完就放锁（嵌套拿同一把也不锁死）；fn 抛错也会放', () => {
    const path = target()
    const value = withExclusiveLock(path, '忙', () => {
      // 临界区里再拿同一把是可重入的。
      const inner = acquireLock(path)
      expect(inner).not.toBeNull()
      inner!.release()
      return 42
    })
    expect(value).toBe(42)

    expect(() =>
      withExclusiveLock(path, '忙', () => {
        throw new Error('里面炸了')
      }),
    ).toThrow('里面炸了')
    // 锁已经放掉：再拿一次仍成功。
    const again = acquireLock(path)
    expect(again).not.toBeNull()
    again!.release()
  })
})
