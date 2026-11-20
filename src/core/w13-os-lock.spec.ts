/**
 * `core/os-lock.ts` 的缺口补齐（W13）：`flock` 底座在「koffi 已经加载过」之后被问到时的
 * 探测序列，以及 Windows 命名互斥量的同进程重入语义。
 *
 * ## 为什么要先「热身」
 *
 * `loadKoffi()` 是懒加载缓存。把 `process.platform` 临时改成 `linux` 再去 require koffi，
 * koffi 会按假平台挑原生二进制、直接加载失败 —— 于是永远停在「koffi 不可用」那条早退上，
 * `loadFlock` 的候选库探测一行都跑不到。先按真平台拿一次锁，把 koffi 塞进缓存，再改平台，
 * 才能真正走到 `flock` 的探测循环。这是本文件与 `w12-lock-fallback.spec.ts` 的差别。
 *
 * 平台分支的断言写成「两种结果都接受」：Windows 上没有 libc，结果是 `unsupported`（原因必须
 * 具体）；Linux CI 上 `flock` 可用，结果是 `ok`。两种都是实现承诺过的行为。
 *
 * @module dsc/core/w13-os-lock.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'
import { tryOsLock } from './os-lock.js'

const dir = createTempDir('dsc-w13-os-lock-')
let seq = 0

/** 一个新的锁目标路径（父目录存在；`tryOsLock` 自己建 .lock 锚点）。 */
function target(): string {
  seq += 1
  const sub = join(dir, `case-${String(seq)}`)
  mkdirSync(sub, { recursive: true })
  return join(sub, 'session.jsonl')
}

/** 临时把平台改成指定值，跑完还原。 */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

describe('Windows 命名互斥量：同一路径同一把锁', () => {
  test.skipIf(process.platform !== 'win32')('同进程第二次拿同一路径是 busy；释放后能重新拿到', () => {
    const name = target()
    const first = tryOsLock(name)
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return

    const second = tryOsLock(name)
    expect(second.kind).toBe('busy')

    first.lock.release()
    const third = tryOsLock(name)
    expect(third.kind).toBe('ok')
    if (third.kind === 'ok') {
      // 重复释放是空操作（FFI 失败被吞掉），不该把调用方带崩。
      expect(() => third.lock.release()).not.toThrow()
      expect(() => third.lock.release()).not.toThrow()
    }
  })

  test.skipIf(process.platform !== 'win32')('路径大小写不同命中同一把锁（win32 下规范化成小写）', () => {
    const name = target()
    const upper = `${name.toUpperCase()}`
    const first = tryOsLock(upper)
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const lower = tryOsLock(name.toLowerCase())
    expect(lower.kind).toBe('busy')
    first.lock.release()
  })
})

describe('flock 底座的探测序列（koffi 已加载后）', () => {
  test('候选库逐个试：拿不到 flock 时返回 unsupported 且原因里带每个候选', () => {
    // 热身：先按真平台拿一次锁，让 loadKoffi 的缓存就位（理由见文件头）。
    const warm = tryOsLock(target())
    if (warm.kind === 'ok') warm.lock.release()

    const name = target()
    const attempt = withPlatform('linux', () => tryOsLock(name))
    if (attempt.kind === 'ok') {
      // Linux CI：flock 可用 —— 同进程再拿是 busy，释放后能再拿。
      const second = withPlatform('linux', () => tryOsLock(name))
      expect(second.kind).toBe('busy')
      attempt.lock.release()
      const third = withPlatform('linux', () => tryOsLock(name))
      expect(third.kind).toBe('ok')
      if (third.kind === 'ok') third.lock.release()
      return
    }
    expect(attempt.kind).toBe('unsupported')
    if (attempt.kind === 'unsupported') {
      // 原因必须说清试过哪些库（不能是一句空话）。
      expect(attempt.why).toContain('找不到 flock')
      expect(attempt.why.length).toBeGreaterThan('找不到 flock（）'.length)
    }
  })

  test('未知平台：直接回 unsupported，原因写明平台名', () => {
    const attempt = withPlatform('aix', () => tryOsLock(target()))
    expect(attempt.kind).toBe('unsupported')
    if (attempt.kind === 'unsupported') expect(attempt.why).toContain('aix')
  })

  test('POSIX 车道的锚点打不开（父路径是文件）：降级并说明打不开锁文件', () => {
    const parentFile = join(dir, 'not-a-dir')
    writeFileSync(parentFile, 'x', 'utf8')
    const attempt = withPlatform('linux', () => tryOsLock(join(parentFile, 'child.jsonl')))
    expect(attempt.kind).toBe('unsupported')
    if (attempt.kind === 'unsupported') expect(attempt.why).toContain('打不开锁文件')
  })
})
