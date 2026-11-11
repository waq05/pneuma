/**
 * JSONL 落盘：按天分片、单文件轮转、按天与总量清理。
 *
 * **为什么是同步写**：崩溃那一刻进程只剩同步 IO 可用。异步流（`createWriteStream`）在
 * `uncaughtException` 里来不及把最后一行送出去，而「最后一行」恰恰是最值钱的那行。
 * 代价是主线程上多一次 `writeSync`，靠 100 ms 批量攒一攒就摊薄了。
 *
 * **为什么按天分片而不是按文件大小滚**：清理要能整目录删。按大小滚的话，删哪一段都得
 * 先读文件头判断时间，清理逻辑自己会长成一棵树。
 *
 * @module pneuma/log/sink
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** 天目录名：只能长这样，清理时按字符串比较就能判新旧。 */
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/

/** 攒够这么多条就立刻写一次，不等到定时器。 */
const FLUSH_EVERY = 64

/** 默认值：单文件 8 MiB、留 10 天、总量 64 MiB、每小时扫一次旧文件。 */
const DEFAULTS = {
  maxFileBytes: 8 * 1024 * 1024,
  keepDays: 10,
  maxTotalBytes: 64 * 1024 * 1024,
  sweepIntervalMs: 60 * 60 * 1000,
} as const

/** sink 的构造参数。全部可注入，测试里就能把时钟按死。 */
export interface LogSinkOptions {
  /** 根目录，通常是 `~/.dsc/logs`。 */
  dir: string
  /** 单文件字节上限，超了就轮转到 `.1`。 */
  maxFileBytes?: number
  /** 保留多少天。 */
  keepDays?: number
  /** 整个目录的字节预算，超了从最旧的一天开始整目录删。 */
  maxTotalBytes?: number
  /** 注入时钟（测试用），缺省 `Date.now`。 */
  now?: () => number
  /** 清理间隔，缺省 1 小时。设 0 = 每次写入都检查（测试用）。 */
  sweepIntervalMs?: number
}

/**
 * 本地日期串 `YYYY-MM-DD`。
 *
 * 用本地时区而不是 UTC：用户说「今天的日志」指的是自己时钟上的今天。
 */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一次把 buffer 写完（`writeSync` 可能只写一部分）。 */
function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset)
  }
}

/** 递归统计一个目录的字节数；读不到就当 0（清理不该因为队友的权限问题而中断）。 */
function dirBytes(dir: string): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirBytes(path)
      else if (entry.isFile()) total += statSync(path).size
    } catch {
      // 单个文件读不到就跳过，不影响整体预算判断
    }
  }
  return total
}

/**
 * 一个进程一份文件的有界 JSONL 写入器。
 *
 * 用法：`write()` 只入队，`flush()` 才真正落盘；`close()` 在卸载与退出时调。
 */
export class LogSink {
  private readonly dir: string
  private readonly maxFileBytes: number
  private readonly keepDays: number
  private readonly maxTotalBytes: number
  private readonly now: () => number
  private readonly sweepIntervalMs: number
  private fd: number | undefined
  private day = ''
  private bytes = 0
  private queue: string[] = []
  private lastSweepAt = 0
  private currentPath = ''

  constructor(options: LogSinkOptions) {
    this.dir = options.dir
    this.maxFileBytes = options.maxFileBytes ?? DEFAULTS.maxFileBytes
    this.keepDays = options.keepDays ?? DEFAULTS.keepDays
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULTS.maxTotalBytes
    this.now = options.now ?? Date.now
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs
  }

  /** 当前文件路径。还没落过盘时给出「将要写的那份」，方便 `/log` 提前告诉用户。 */
  file(): string {
    return this.currentPath === '' ? join(this.dir, dayKey(this.now()), this.fileName()) : this.currentPath
  }

  /** 当前文件已写字节数。 */
  size(): number {
    return this.bytes
  }

  /** 根目录。改设置时拿它和新区比，判断要不要重建。 */
  dirOf(): string {
    return this.dir
  }

  /** 单文件上限。同上。 */
  limitOf(): number {
    return this.maxFileBytes
  }

  /** 入队一行（不含换行符）。 */
  write(line: string): void {
    this.queue.push(line)
    if (this.queue.length >= FLUSH_EVERY) this.flush()
  }

  /**
   * 把队列同步写进当前文件。
   *
   * **按行判容量**，而不是把整批一次写完：一批 64 行可能比单文件上限还大，一次写完
   * 就等于「先超了再说」，上限形同虚设。逐行写、写不下就当场换一份，上限才是硬的。
   *
   * 写失败只关掉句柄、把这一批丢掉：日志写不进去不该让宿主崩，更不该拖慢用户那一轮。
   */
  flush(): void {
    if (this.queue.length === 0) return
    const lines = this.queue
    this.queue = []
    const day = dayKey(this.now())
    for (const line of lines) {
      const buffer = Buffer.from(`${line}\n`, 'utf8')
      if (!this.ensureOpen(day, buffer.length)) return
      if (this.fd === undefined) return
      try {
        writeAll(this.fd, buffer)
        this.bytes += buffer.length
      } catch {
        this.closeFd()
        return
      }
    }
  }

  /** 冲刷并关掉句柄。 */
  close(): void {
    this.flush()
    this.closeFd()
  }

  /**
   * 清理旧日志：先按天数删整目录，再按总量从最旧的一天删起（今天永远不删）。
   *
   * 节流由 `sweepIntervalMs` 控制；`force: true` 用于设置页那按钮与测试。
   *
   * @returns 删掉了几个目录、释放多少字节。
   */
  prune(force = false): { dirs: number; bytes: number } {
    const now = this.now()
    if (!force && this.lastSweepAt !== 0 && now - this.lastSweepAt < this.sweepIntervalMs) {
      return { dirs: 0, bytes: 0 }
    }
    this.lastSweepAt = now

    const today = dayKey(now)
    const cutoffMs = now - this.keepDays * 24 * 60 * 60 * 1000
    const cutoff = dayKey(cutoffMs)

    let days: string[] = []
    try {
      days = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && DAY_DIR.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return { dirs: 0, bytes: 0 }
    }

    let removedDirs = 0
    let removedBytes = 0
    for (const day of days) {
      if (day >= cutoff) continue
      const path = join(this.dir, day)
      const size = dirBytes(path)
      try {
        rmSync(path, { recursive: true, force: true })
        removedDirs += 1
        removedBytes += size
      } catch {
        // 别的进程正占着这一天的文件：跳过，下一轮再删
      }
    }

    const survivors = days.filter((day) => day >= cutoff)
    let total = survivors.reduce((sum, day) => sum + dirBytes(join(this.dir, day)), 0)
    for (const day of survivors) {
      if (total <= this.maxTotalBytes) break
      if (day === today) continue
      const path = join(this.dir, day)
      const size = dirBytes(path)
      try {
        rmSync(path, { recursive: true, force: true })
        total -= size
        removedDirs += 1
        removedBytes += size
      } catch {
        // 同上：删不掉就留着，预算下轮再算
      }
    }
    return { dirs: removedDirs, bytes: removedBytes }
  }

  /** 本进程这一份的文件名。pid 让桌面主进程 / utilityProcess / TUI 各写各的。 */
  private fileName(): string {
    return `dsc-${process.pid}.jsonl`
  }

  /**
   * 确保句柄指向「今天这份、且写完这一行还有空间」的文件；返回是否可用。
   *
   * 顺序是「先跨天、再开文件、最后看容量」：第一次写入时句柄还不存在，若在 open 之前
   * 就判容量，`bytes` 是 0，永远判不出「已经满了要轮转」。
   *
   * @param day 调用方已经算好的今天（一次 flush 只算一次）。
   * @param pendingBytes 这一行的字节数（含换行）。
   */
  private ensureOpen(day: string, pendingBytes: number): boolean {
    if (this.fd !== undefined && day !== this.day) this.closeFd()
    if (this.fd === undefined) {
      this.prune()
      if (!this.open(day)) return false
    }
    // bytes > 0 才轮转：否则一行比上限还长的日志会在这里反复切开、永远写不进去
    if (this.bytes > 0 && this.bytes + pendingBytes > this.maxFileBytes) this.rotate()
    return this.fd !== undefined
  }

  /** 打开（或新建）某一天本进程的文件。 */
  private open(day: string): boolean {
    const dir = join(this.dir, day)
    const path = join(dir, this.fileName())
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.fd = openSync(path, 'a', 0o600)
      this.day = day
      this.currentPath = path
      this.bytes = statSync(path).size
      return true
    } catch {
      this.fd = undefined
      return false
    }
  }

  /** 同一天写满：当前文件挪成 `.1`，再开一个新的。 */
  private rotate(): void {
    const path = this.currentPath
    this.closeFd()
    if (path !== '') {
      const rotated = `${path}.1`
      try {
        // 只留一份历史；覆盖比无限增长重要
        rmSync(rotated, { force: true })
        renameSync(path, rotated)
      } catch {
        // 挪不动就继续往原文件写，总比丢日志强
      }
    }
    this.open(this.day === '' ? dayKey(this.now()) : this.day)
  }

  /** 关句柄并把计数归零（下次 `ensureOpen` 会重开）。 */
  private closeFd(): void {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } catch {
      // 已经关了就算了
    }
    this.fd = undefined
    this.bytes = 0
  }
}
