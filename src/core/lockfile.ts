/**
 * 跨进程会话锁：底座换成 OS 原生互斥（命名互斥量 / flock），pid 文件锁降为兜底。
 *
 * 为什么换：旧实现用 `O_EXCL` 独占创建 `<目标>.lock`，锁内记 `{pid, birth}`，判定
 * 「主人还在不在」时只看 pid 是否存活，`birth` 从不参与比较。Windows 会回收复用
 * pid——老进程崩溃留下的锁文件配上后来某个无关程序的新 pid，就被误判成「另一个
 * 窗口正开着」，用户归档、打开会话时被 `会话正在另一个 Pneuma 窗口使用` 永久挡死
 * （仓库里已经攒了 183 把这种幽灵锁）。OS 原生互斥的持有者是内核对象：进程一死，
 * 锁自动消失，陈锁在机制上不存在。
 *
 * 分级策略：
 *   1. `tryOsLock` 拿到 → 用 OS 锁（Windows 命名互斥量；Linux/macOS 对同一个
 *      `.lock` 文件 flock）。`.lock` 文件仍会写一份 `{pid, birth, at, how:'os'}`
 *      的说明，只给人和报错文案看，不参与判定。
 *   2. 底座不可用（koffi 缺失、平台不支持）→ 静默退回原来的 pid/birth 文件锁。
 *      兜底修复：锁里 pid 等于自己但 birth 不等于自己的，是「自己上一代遗留的
 *      幽灵锁」，直接接管。
 *
 * 两条路径都不删 `.lock` 文件（POSIX flock 语义要求）：文件是 flock 的锚点，谁
 * unlink，谁就会让「A 释放后删文件、B 已锁住旧 inode、C 新建并锁住新 inode」变成
 * 两个持有者。Windows 也保持同一行为，免得两条路径表现不一致。
 *
 * 同一进程内可重入（计数持有）：会话恢复链路上「load 新会话时旧会话还握着同一把锁」
 * 是真实场景，没有重入计数就是自己锁死自己。
 *
 * @module dsc/core/lockfile
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOCK_SUFFIX, tryOsLock, type OsLock } from './os-lock.js'

/** 对外导出位置不变：后缀常量现在住在 os-lock.ts，两条路径共用。 */
export { LOCK_SUFFIX } from './os-lock.js'

/** 锁文件内容：pid 是持有者，birth 是进程启动指纹（光靠 pid 会被回收复用骗过去）。 */
interface LockContents {
  pid: number
  birth: number
  at: number
  /** 谁写下的这份说明：`os` = OS 锁的附带信息；`file` = 文件锁本身。 */
  how?: 'os' | 'file'
}

/** 本进程的启动指纹（模块加载时定死，进程内恒定）。 */
const BIRTH = Math.round(Date.now() - process.uptime() * 1000)

/** 本进程当前握着的锁（锁路径 → 重入计数）。 */
const held = new Map<string, number>()

/** 走 OS 锁的那些路径对应的句柄（计数归零时还这一把；文件锁不在这里）。 */
const osHeld = new Map<string, OsLock>()

/** 一把握在手里的锁：长期持有的写租约用它自己调 `release()` 还锁。 */
export interface FileLock {
  release(): void
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 锁文件里的主人还算数吗。除了「pid 已死」，这里补一条降级路径的兜底：
 * **pid 是自己、birth 却不是本进程这一次的**，说明 pid 被回收复用后落到了自己头上，
 * 这把锁是自己上一代留下的幽灵锁，按陈锁处理，直接接管。
 */
function isStaleLock(info: Partial<LockContents>): boolean {
  if (typeof info.pid !== 'number') return true // 半截 JSON 或字段缺失：陈锁
  if (info.pid === process.pid && info.birth !== BIRTH) return true
  return !isProcessAlive(info.pid)
}

/**
 * 拿一把长期持有的锁（写租约）。拿不到（别的活进程握着）返回 null。
 * 先试 OS 原生锁；底座不可用时退回文件锁。
 */
export function acquireLock(target: string): FileLock | null {
  const path = `${target}${LOCK_SUFFIX}`
  const reentered = held.get(path)
  if (reentered !== undefined) {
    held.set(path, reentered + 1)
    return { release: () => dropLock(path) }
  }

  const attempt = tryOsLock(target)
  if (attempt.kind === 'busy') return null
  if (attempt.kind === 'unsupported') return acquireFileLock(target)

  // OS 锁拿到了：`.lock` 只写一份说明给人和报错文案看（写不进去不影响锁本身）。
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, birth: BIRTH, at: Date.now(), how: 'os' } satisfies LockContents),
      'utf8',
    )
  } catch {
    // 说明写不进去就算了
  }
  osHeld.set(path, attempt.lock)
  held.set(path, 1)
  return { release: () => dropLock(path) }
}

/**
 * 降级路径：原来的 pid/birth 文件锁（`O_EXCL` 独占创建 + 主人已死就接管）。
 * 只在 OS 锁底座不可用时走到这里。
 */
function acquireFileLock(target: string): FileLock | null {
  const path = `${target}${LOCK_SUFFIX}`
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, birth: BIRTH, at: Date.now(), how: 'file' } satisfies LockContents),
        { flag: 'wx' },
      )
      held.set(path, 1)
      return { release: () => dropLock(path) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null // 目录不可写等：按拿不到锁处理
    }
    // 锁已被占：主人活着就认输；死了（或锁读不出来、或 pid 撞上自己但 birth 不对）就清掉再抢一次
    let stale = true
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockContents>
      if (!isStaleLock(info)) stale = false
    } catch {
      // 半截 JSON 按陈锁处理
    }
    if (!stale) return null
    try {
      unlinkSync(path)
    } catch {
      return null // 抢手速没抢过对方（对方刚重建了锁）：认输
    }
  }
  return null
}

/** 归还一次重入；计数归零才真放锁。 */
function dropLock(path: string): void {
  const count = held.get(path)
  if (count === undefined) return
  if (count > 1) {
    held.set(path, count - 1)
    return
  }
  held.delete(path)
  const osLock = osHeld.get(path)
  if (osLock !== undefined) {
    osHeld.delete(path)
    try {
      osLock.release()
    } catch {
      // OS 锁放不掉（进程快没了）：交给内核随进程回收
    }
    // 不删 `.lock`：它是 POSIX flock 的锚点，删了就会拆出两个持有者（见文件头）。
    return
  }
  // 文件锁：删掉自己写的那份，下一任才能用 O_EXCL 抢到。
  try {
    unlinkSync(path)
  } catch {
    // 删不掉就算了：下一任按「主人已死」接管
  }
}

/**
 * 短临界区：拿锁 → 跑 → 还锁；拿不到就抛 `busy` 给出的错误。
 * 只包同步代码——跨进程的文件移动与读改写都是同步的，这正是它的服务对象。
 */
export function withExclusiveLock<T>(target: string, busy: string, fn: () => T): T {
  const lock = acquireLock(target)
  if (lock === null) throw new Error(busy)
  try {
    return fn()
  } finally {
    lock.release()
  }
}
