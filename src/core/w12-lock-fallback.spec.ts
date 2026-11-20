/**
 * 会话锁的两条底座（`core/os-lock.ts` + `core/lockfile.ts`）的补充：
 * 平台强制降级后的探测路径、`flock` 加载失败原因、文件锁兜底（O_EXCL 抢锁、
 * 陈锁接管、退订时删锚点）。
 *
 * 平台用 `Object.defineProperty(process, 'platform')` 临时改写（现有 lockfile.spec 同款），
 * 每条用例 finally 还原；真锁用临时目录里的文件，不碰真实会话。
 *
 * @module dsc/core/w12-lock-fallback.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { acquireLock, LOCK_SUFFIX } from './lockfile.js'
import { tryOsLock } from './os-lock.js'

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** 临时目标路径（不建文件，锁会自己建 .lock）。 */
function target(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsc-w12-lock-'))
  return join(dir, 'session.jsonl')
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

describe('tryOsLock 的平台分支', () => {
  test('POSIX 车道：flock 可用就拿到，不可用给出原因（两种 CI 都不红）', () => {
    const name = target()
    const attempt = withPlatform('linux', () => tryOsLock(name))
    if (attempt.kind === 'ok') {
      const second = withPlatform('linux', () => tryOsLock(name))
      expect(second.kind).toBe('busy')
      attempt.lock.release()
      const third = withPlatform('linux', () => tryOsLock(name))
      expect(third.kind).toBe('ok')
      if (third.kind === 'ok') third.lock.release()
      return
    }
    // Windows 上 koffi 可能整个加载不起来（原生模块缺失），原因必须是具体文字，不能是空串。
    expect(attempt.kind).toBe('unsupported')
    if (attempt.kind === 'unsupported') {
      expect(attempt.why.length).toBeGreaterThan(0)
    }
  })

  test('锚点文件建不出来（父路径是文件）：降级并说明打不开锁文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsc-w12-lock-'))
    const parentFile = join(dir, 'not-a-dir')
    writeFileSync(parentFile, 'x')
    const attempt = withPlatform('linux', () => tryOsLock(join(parentFile, 'child')))
    expect(attempt.kind).toBe('unsupported')
    if (attempt.kind === 'unsupported') expect(attempt.why).toContain('打不开锁文件')
  })
})

describe('文件锁兜底（OS 底座不支持时）', () => {
  test('拿到锁写 how=file 的说明；释放后删掉锚点，下一任还能抢到', () => {
    const name = target()
    const path = `${name}${LOCK_SUFFIX}`
    withPlatform('aix', () => {
      const lock = acquireLock(name)
      expect(lock).not.toBeNull()
      expect(existsSync(path)).toBe(true)
      expect(JSON.parse(read(path))).toMatchObject({ how: 'file' })
      lock?.release()
      expect(existsSync(path)).toBe(false)
      const again = acquireLock(name)
      expect(again).not.toBeNull()
      again?.release()
    })
  })

  test('同进程重入计数：acquire 两次要 release 两次才真放锁', () => {
    const name = target()
    const path = `${name}${LOCK_SUFFIX}`
    withPlatform('aix', () => {
      const first = acquireLock(name)
      const second = acquireLock(name)
      first?.release()
      // 还有一层计数，锚点不该消失
      expect(existsSync(path)).toBe(true)
      second?.release()
      expect(existsSync(path)).toBe(false)
    })
  })

  test('陈锁接管：主人 pid 已死 / pid 是自己但 birth 不对 / JSON 写坏，三种都清掉再抢', () => {
    const name = target()
    const path = `${name}${LOCK_SUFFIX}`
    withPlatform('aix', () => {
      writeFileSync(path, JSON.stringify({ pid: 999_999, birth: 1 }))
      const dead = acquireLock(name)
      expect(dead).not.toBeNull()
      dead?.release()

      writeFileSync(path, JSON.stringify({ pid: process.pid, birth: 0 }))
      const ghost = acquireLock(name)
      expect(ghost).not.toBeNull()
      ghost?.release()

      writeFileSync(path, '{"pid":')
      const broken = acquireLock(name)
      expect(broken).not.toBeNull()
      broken?.release()
    })
  })

  test('锁路径被同名目录占着（非 EEXIST 之外写不进去）：返回 null 而不是抛', () => {
    const name = target()
    const path = `${name}${LOCK_SUFFIX}`
    mkdirSync(path)
    const lock = withPlatform('aix', () => acquireLock(name))
    expect(lock).toBeNull()
  })
})

/** 读一个文本文件（测试专用小工具）。 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}
