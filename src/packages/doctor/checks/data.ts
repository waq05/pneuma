/**
 * 数据类两项：会话目录、磁盘占用。
 *
 * **为什么这两项要查**：用户最常说的两句抱怨是「打开就报错」和「越用越占地方」。
 * 前者多半是 `~/.dsc` 不可写或残留锁文件，后者是会话与日志堆着没人清。
 *
 * @module pneuma/doctor/checks/data
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'
import type { HealthCheck } from '@pneuma/runtime/services/types.js'
import { dirSize, formatBytes, walkFiles } from './util.js'

/** 「这个 pid 还活着吗」的缺省探针：信号 0 不投递，只做存在性探测。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在、但没权限发信号；只有 ESRCH（没这个进程）才算不在
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 判断一个 `.lock` 是不是「主人已经不在了」。
 *
 * **为什么不能「见到锁就报」**：`lockfile.ts:19` 写明两条路径都**不删** `.lock`——
 * 它是 POSIX flock 的锚点，删了会拆出两个持有者。所以文件常驻是设计，不是残留；
 * 真正的残留要问「里面记的那个 pid 还活着吗」。
 *
 * @param path 锁文件路径。
 * @param alive 存活探针；测试注入假探针就能不依赖真进程。
 * @returns `true` 主人已不在；`false` 还活着或就是本进程；`undefined` 认不出来（半截 JSON、没写 pid）。
 */
export function lockIsStale(path: string, alive: (pid: number) => boolean = pidAlive): boolean | undefined {
  let pid: number
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    if (typeof info.pid !== 'number' || !Number.isInteger(info.pid) || info.pid <= 0) return undefined
    pid = info.pid
  } catch {
    return undefined
  }
  if (pid === process.pid) return false
  return !alive(pid)
}

/** 最近的会话文件按修改时间倒序取几个（只读首行，不解整份）。 */
export function recentSessionFiles(dir: string, limit: number): string[] {
  const files = walkFiles(dir, 3).filter((path) => path.endsWith('.jsonl'))
  return files
    .map((path) => {
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        // 读不到就排最后
      }
      return { path, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => item.path)
}

/** 会话：目录可写、没有残留锁、最近几个会话能打开。 */
export function sessionCheck(): HealthCheck {
  return {
    id: 'session',
    title: '会话',
    order: 50,
    run() {
      const dir = dscPath('sessions')
      let writable = true
      try {
        mkdirSync(dir, { recursive: true })
        const probe = join(dir, `.doctor-probe-${process.pid}`)
        writeFileSync(probe, 'ok', 'utf8')
        unlinkSync(probe)
      } catch {
        writable = false
      }
      if (!writable) {
        return {
          status: 'fail',
          summary: '会话目录不可写',
          detail: `目录：${dir}`,
          fix: '检查该目录的权限（或被安全软件锁住）后重试',
        }
      }

      const locks = walkFiles(dir, 3).filter((path) => path.endsWith('.lock'))
      const states = locks.map((path) => ({ path, stale: lockIsStale(path) }))
      const stale = states.filter((item) => item.stale === true).map((item) => item.path)
      const unknown = states.filter((item) => item.stale === undefined).map((item) => item.path)
      const recent = recentSessionFiles(dir, 5)

      const detail = [
        `目录：${dir}`,
        `最近会话：${recent.length} 份`,
        ...recent.map((path) => `  ${path}`),
        `锁文件：${locks.length} 个（主人已不在 ${stale.length}，认不出 ${unknown.length}）`,
        ...stale.map((path) => `  残留：${path}`),
      ].join('\n')

      if (stale.length > 0) {
        return {
          status: 'warn',
          summary: `有 ${stale.length} 个锁的主人已经不在了`,
          detail,
          fix: '确认没有别的 Pneuma 进程在跑之后，删掉列出的那几个 .lock 文件',
        }
      }
      return { status: 'ok', summary: `可写，最近 ${recent.length} 份会话，锁 ${locks.length} 个均由活进程持有`, detail }
    },
  }
}

/** 磁盘：`~/.dsc` 各子目录占多少，总量过线就提醒。 */
export function diskCheck(): HealthCheck {
  return {
    id: 'disk',
    title: '磁盘',
    order: 60,
    run() {
      const root = dscPath()
      const names = ['sessions', 'logs', 'spill', 'storages', 'memory']
      const parts = names.map((name) => ({ name, bytes: dirSize(join(root, name)) }))
      const total = parts.reduce((sum, part) => sum + part.bytes, 0)
      const detail = [`根目录：${root}`, ...parts.map((part) => `  ${part.name}: ${formatBytes(part.bytes)}`), `合计：${formatBytes(total)}`].join('\n')
      const budget = 2 * 1024 * 1024 * 1024
      if (total > budget) {
        return {
          status: 'warn',
          summary: `已占 ${formatBytes(total)}，超过 ${formatBytes(budget)}`,
          detail,
          fix: '在「设置 → 长输出转存 / 运行日志」里跑一次清理，或删掉不用的旧会话',
        }
      }
      return { status: 'ok', summary: `合计 ${formatBytes(total)}`, detail }
    },
  }
}

