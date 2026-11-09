/**
 * 会话写租约的 OS 原生互斥底座：Windows 用命名互斥量，Linux/macOS 用 `flock`。
 *
 * 为什么不再用「pid 文件锁」：Windows 会回收复用 pid。老进程崩溃留下的锁文件里记着
 * pid，后来一个毫不相干的程序（新的 Pneuma、Typora、java……）拿到同一个 pid，判定
 * 「主人还活着」，锁就永远解不开——用户归档或打开会话时被一句「会话正在另一个
 * Pneuma 窗口使用」挡死。OS 原生互斥的持有者是内核对象，进程一死句柄就关、锁就没了，
 * 陈锁在机制上不存在。
 *
 * 两条路径的口径完全一致：拿不到立即返回 busy，绝不等待；release 只放锁不删文件。
 *
 * 底座是 koffi（仓库既有 FFI 依赖）。koffi 缺失、平台不认识或绑定失败时返回
 * `unsupported`，由调用方静默退回文件锁——会话层绝不能因为 FFI 不可用而崩。
 *
 * @module dsc/core/os-lock
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/**
 * 锁文件后缀：追加在目标路径后面（`foo.jsonl` → `foo.jsonl.lock`）。
 * 放在这里是为了让 OS 锁与文件锁共用同一个锚点文件名；`lockfile.ts` 原样 re-export，
 * 对外导出位置不变。
 */
export const LOCK_SUFFIX = '.lock'

/** 一把握在手里的 OS 锁：放锁时调 `release()`，可以重复调（第二调是空操作由调用方计数保证）。 */
export interface OsLock {
  release(): void
}

/**
 * 拿一次 OS 锁的结果：
 *   - `ok`：拿到了；
 *   - `busy`：底座可用，但锁在别的进程手里（或刚被抢走）；
 *   - `unsupported`：底座不可用，调用方退回文件锁。
 */
export type OsLockAttempt =
  | { kind: 'ok'; lock: OsLock }
  | { kind: 'busy' }
  | { kind: 'unsupported'; why: string }

/** koffi 模块的最小形状（只声明用到的那几个入口，不拉整包类型）。 */
interface KoffiLike {
  load(name: string | null): KoffiLibrary
}

interface KoffiLibrary {
  func(convention: string, name: string, result: string, args: string[]): NativeFn
}

type NativeFn = (...args: unknown[]) => unknown

/** koffi 只加载一次（懒加载：模块加载时不碰 FFI）。 */
let koffiCache: { ok: true; koffi: KoffiLike } | { ok: false; why: string } | null = null

function loadKoffi(): { ok: true; koffi: KoffiLike } | { ok: false; why: string } {
  if (koffiCache !== null) return koffiCache
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as KoffiLike
    if (typeof koffi?.load !== 'function') {
      koffiCache = { ok: false, why: 'koffi 模块形状不对（版本不匹配？）' }
      return koffiCache
    }
    koffiCache = { ok: true, koffi }
  } catch (error) {
    koffiCache = { ok: false, why: errorText(error) }
  }
  return koffiCache
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Windows：命名互斥量 ─────────────────────────────────────────────────────

/** CreateMutexW 成功但名字已存在（别人握着）时 GetLastError 的值。 */
const ERROR_ALREADY_EXISTS = 183

interface MutexApi {
  createMutexW: NativeFn
  releaseMutex: NativeFn
  closeHandle: NativeFn
  getLastError: NativeFn
}

/** kernel32 绑定只做一次。 */
let mutexCache: { ok: true; api: MutexApi } | { ok: false; why: string } | null = null

function loadMutexApi(): { ok: true; api: MutexApi } | { ok: false; why: string } {
  if (mutexCache !== null) return mutexCache
  const koffi = loadKoffi()
  if (!koffi.ok) {
    mutexCache = { ok: false, why: koffi.why }
    return mutexCache
  }
  try {
    const k32 = koffi.koffi.load('kernel32.dll')
    mutexCache = {
      ok: true,
      api: {
        createMutexW: k32.func('__stdcall', 'CreateMutexW', 'uintptr_t', ['void *', 'int', 'str16']),
        releaseMutex: k32.func('__stdcall', 'ReleaseMutex', 'int', ['uintptr_t']),
        closeHandle: k32.func('__stdcall', 'CloseHandle', 'int', ['uintptr_t']),
        getLastError: k32.func('__stdcall', 'GetLastError', 'uint32', []),
      },
    }
  } catch (error) {
    mutexCache = { ok: false, why: errorText(error) }
  }
  return mutexCache
}

/**
 * 互斥量名字：`Local\pneuma-lease-<sha1(规范化路径) 前 32 位>`。
 * 规范化 = 绝对路径 + win32 下转小写：同一路径写成不同大小写必须命中同一把锁。
 */
function mutexName(target: string): string {
  const absolute = resolve(target)
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 32)
  return `Local\\pneuma-lease-${digest}`
}

function tryWindowsMutex(target: string): OsLockAttempt {
  const loaded = loadMutexApi()
  if (!loaded.ok) return { kind: 'unsupported', why: loaded.why }
  const { createMutexW, releaseMutex, closeHandle, getLastError } = loaded.api
  let handle: unknown
  try {
    // bInitialOwner = 1：拿到就持有；name 已存在时这个参数不影响判定。
    handle = createMutexW(null, 1, mutexName(target))
  } catch (error) {
    return { kind: 'unsupported', why: `CreateMutexW 调用失败：${errorText(error)}` }
  }
  // ⚠ GetLastError 必须紧跟在 CreateMutexW 后面：中间插任何一次 FFI 调用都会把它覆盖。
  const lastError = Number(getLastError()) >>> 0
  // 先判错误码再判句柄：即使返回了非 0 句柄，也可能是「名字已存在」。
  if (lastError === ERROR_ALREADY_EXISTS) {
    try {
      closeHandle(handle)
    } catch {
      // 关不掉也不影响判定：这把锁本来就不归我们
    }
    return { kind: 'busy' }
  }
  const value = Number(handle)
  if (value === 0) return { kind: 'unsupported', why: 'CreateMutexW 失败' }
  return {
    kind: 'ok',
    lock: {
      release: () => {
        try {
          releaseMutex(handle)
        } catch {
          // 已释放/句柄异常：吞掉，别让放锁把调用方带崩
        }
        try {
          closeHandle(handle)
        } catch {
          // 同上
        }
      },
    },
  }
}

// ── Linux / macOS：flock ────────────────────────────────────────────────────

/** `flock` 操作位（<sys/file.h>）：LOCK_EX=2、LOCK_NB=4、LOCK_UN=8。 */
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

interface FlockApi {
  flock: NativeFn
}

/** libc 只在第一次真正拿锁时探测（顺序：进程自身符号表 → glibc → macOS libSystem）。 */
let flockCache: { ok: true; api: FlockApi } | { ok: false; why: string } | null = null

function loadFlock(): { ok: true; api: FlockApi } | { ok: false; why: string } {
  if (flockCache !== null) return flockCache
  const koffi = loadKoffi()
  if (!koffi.ok) {
    flockCache = { ok: false, why: koffi.why }
    return flockCache
  }
  const candidates: (string | null)[] = [null, 'libc.so.6', 'libSystem.B.dylib']
  const failures: string[] = []
  for (const name of candidates) {
    try {
      const lib = koffi.koffi.load(name)
      const flock = lib.func('cdecl', 'flock', 'int', ['int', 'int'])
      flockCache = { ok: true, api: { flock } }
      return flockCache
    } catch (error) {
      failures.push(`${name ?? '进程自身符号表'}：${errorText(error)}`)
    }
  }
  flockCache = { ok: false, why: `找不到 flock（${failures.join('；')}）` }
  return flockCache
}

function tryPosixFlock(target: string): OsLockAttempt {
  // 锚点文件不删：见下面 release 的说明。
  const path = `${target}${LOCK_SUFFIX}`
  let fd: number
  try {
    mkdirSync(dirname(path), { recursive: true })
    fd = openSync(path, 'a+')
  } catch (error) {
    return { kind: 'unsupported', why: `打不开锁文件：${errorText(error)}` }
  }
  const loaded = loadFlock()
  if (!loaded.ok) {
    closeQuietly(fd)
    return { kind: 'unsupported', why: loaded.why }
  }
  const { flock } = loaded.api
  try {
    const rc = Number(flock(fd, LOCK_EX | LOCK_NB))
    if (rc === 0) {
      return {
        kind: 'ok',
        lock: {
          release: () => {
            // 只解锁 + 关 fd，绝不 unlink：文件是 flock 的锚点。谁 unlink，谁就会让
            // 「A 释放后删文件、B 还锁着旧 inode、C 新建并锁住新 inode」变成两个持有者。
            try {
              flock(fd, LOCK_UN)
            } catch {
              // 解锁失败也继续关 fd（关 fd 本身会释放 flock）
            }
            closeQuietly(fd)
          },
        },
      }
    }
    // 不区分 errno：拿不到就按 busy 处理（非阻塞，绝不重试）。
    closeQuietly(fd)
    return { kind: 'busy' }
  } catch (error) {
    closeQuietly(fd)
    return { kind: 'unsupported', why: `flock 调用失败：${errorText(error)}` }
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // fd 已经关了或本来就无效：忽略
  }
}

/**
 * 尝试拿一把 OS 锁。同步、非阻塞：拿不到立刻返回，绝不等待或重试。
 * 不支持/底座不可用时返回 `unsupported`（调用方退回 pid/birth 文件锁）。
 */
export function tryOsLock(target: string): OsLockAttempt {
  if (process.platform === 'win32') return tryWindowsMutex(target)
  if (process.platform === 'linux' || process.platform === 'darwin') return tryPosixFlock(target)
  return { kind: 'unsupported', why: `不支持的平台：${process.platform}` }
}
