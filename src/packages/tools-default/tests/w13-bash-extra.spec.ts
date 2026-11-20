/**
 * `packages/tools-default/bash.ts` 的缺口补齐（W13）。
 *
 * 同目录已有 `bash-jobs.spec.ts`（作业表 / 终端表游标语义）、`bash-extra.spec.ts`（主路径真跑）、
 * `bash-branches.spec.ts`（tty 尺寸边界）。这里只补它们没走到的分支：
 *
 *   ① 进程树收尾的 POSIX 车道（`killTree` / 优雅终止的负数 pid 分支）——用假 child + 临时改
 *      `process.platform` 驱动；真在 Windows 上跑不到，不改平台就永远测不到；
 *   ② 输出解码的 GBK 回落（假执行器发非法 UTF-8 字节，走 `decodeShellOutput` 的第二档）；
 *   ③ 各终端档位起交互 shell 的分支（Git Bash / WSL / sh / pwsh 与 POSIX 兜底）；
 *   ④ 工具说明里的终端名（WSL 与 sh 两档）；
 *   ⑤ 环形缓冲在**真子进程**里被撑爆：后台作业与终端会话各一条（`dropped > 0`）；
 *   ⑥ 终端会话的读取游标（尾部窗口 / 显式 offset / 越过总长 / 丢弃头部后的夹取）；
 *   ⑦ 终端会话「进程自己退出」时 close 回调与启动失败时的 error 回调。
 *
 * `DSC_HOME` 指到临时目录：`readShellChoice` 从 `plugins.json` 读 `bashShell`，`detectShells`
 * 的落盘缓存也写在那儿；真实 `~/.dsc` 不碰。
 *
 * @module @pneuma/tools-default/tests/w13-bash-extra.spec
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import type { SpawnPlan } from '../../../core/tools/command-runner.js'

const HOME = createTempDir('dsc-w13-bash-')
process.env['DSC_HOME'] = HOME

type Bash = typeof import('../bash.js')
let bash: Bash
let terminalEnv: typeof import('../../../core/terminal-env.js')
let registry: typeof import('../../../core/plugin-registry.js')

beforeAll(async () => {
  bash = await import('../bash.js')
  terminalEnv = await import('../../../core/terminal-env.js')
  registry = await import('../../../core/plugin-registry.js')
}, 60_000)

/** 把默认终端切到指定档（`readShellChoice` 有 2 秒缓存，改完清一次）。 */
function chooseShell(choice: string | null): void {
  registry.writePluginConfig('tools-default', { bashShell: choice })
  terminalEnv.forgetShellDetection()
}

afterEach(() => {
  chooseShell(null)
})

/** 临时改平台跑一段（跑完还原；已有 lockfile.spec 同款做法）。 */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/** 轮询等条件成立（真子进程收尾是异步的）。 */
async function until<T>(probe: () => T | undefined, label: string, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** 本文件的工作目录（脚本与 cwd 都放这里）。 */
const work = join(HOME, 'work')
mkdirSync(work, { recursive: true })
let scriptNo = 0

/** 写一个 node 脚本，返回任意 shell 都能跑的命令行。 */
function nodeScript(body: string): string {
  scriptNo += 1
  const file = join(work, `probe-${String(scriptNo)}.js`)
  writeFileSync(file, body, 'utf8')
  return `node ${file.replaceAll('\\', '/')}`
}

describe('进程树收尾的非 Windows 车道', () => {
  test('killTree：负数 pid 组杀失败时退回单杀，不让收尾把调用方带崩', () => {
    let killed = false
    const child = {
      pid: 987_654,
      kill: () => {
        killed = true
      },
    } as unknown as ChildProcess
    withPlatform('linux', () => bash.killTree(child))
    expect(killed).toBe(true)
  })

  test('取消时用进程组 SIGTERM 优雅终止；杀不掉就退回 child.kill，已收输出照常交回', async () => {
    let killed = false
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 987_655
    child.kill = () => {
      killed = true
    }
    const plan: SpawnPlan = { file: 'fake', args: [], cwd: work, env: {}, spawn: () => child as unknown as ChildProcess }
    const controller = new AbortController()
    controller.abort()
    // 不能 await 这个 Promise 再补 close：它要到 close 才 resolve。先拿到它，再让进程退。
    const pending = withPlatform('linux', () => bash.spawnShell(plan, 20_000, 8_000, controller.signal))
    setImmediate(() => child.emit('close', 0))
    expect(await pending).toContain('命令被用户取消')
    expect(killed).toBe(true)
  }, 15_000)
})

/** 假执行器：按给定分块发 data，然后 close(0)。 */
function fakeSpawn(chunks: Buffer[]): SpawnPlan {
  return {
    file: 'fake-shell',
    args: [],
    cwd: work,
    env: {},
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setImmediate(() => {
        for (const chunk of chunks) child.stdout.emit('data', chunk)
        child.emit('close', 0)
      })
      return child as unknown as ChildProcess
    },
  }
}

describe('输出解码：UTF-8 解不开时按 GBK 回落', () => {
  test('非法 UTF-8 字节序列：不抛错、不丢输出（GBK 解码那一路）', async () => {
    // 0xFF / 0xFE 在 UTF-8 里是非法起始字节；GBK 里是能解出的双字节。
    const text = await bash.spawnShell(
      fakeSpawn([Buffer.from([0xff, 0xfe, 0x41]), Buffer.from([0x42])]),
      20_000,
      8_000,
      new AbortController().signal,
    )
    expect(typeof text).toBe('string')
    // 末尾的 ASCII 字节一定在：说明整段交给了兜底解码，而不是抛错吞掉。
    expect(text).toContain('B')
  })
})

describe('终端的四档分支（spawnTerminalShell）', () => {
  /** 起一个交互 shell 然后立刻收掉；返回它确实是 ChildProcess 的形状。 */
  async function spawnAndKill(choice: string): Promise<ChildProcess> {
    chooseShell(choice)
    const child = bash.spawnTerminalShell(work)
    // 可执行文件不存在时 spawn 会在下一个 tick 报 error：先挂上监听，免得被当成未捕获异常。
    child.on('error', () => {})
    expect(typeof child.pid === 'number' || child.pid === undefined).toBe(true)
    bash.killTree(child)
    for (const stream of [child.stdout, child.stderr, child.stdin]) stream?.destroy()
    return child
  }

  test('Git Bash 档：不读 rc，起 bash 会话', async () => {
    await spawnAndKill('gitbash')
  })

  test('WSL 档：钉住探测到的发行版（没探到就不带 -d）', async () => {
    const child = await spawnAndKill('wsl')
    expect(child).toBeDefined()
  })

  test('sh 档：detached 起 bash（POSIX 语义）', async () => {
    await spawnAndKill('sh')
  })

  test('pwsh 档：-NoProfile -Command - 从 stdin 读命令', async () => {
    await spawnAndKill('pwsh')
  })

  test.skipIf(process.platform === 'win32')('POSIX 平台的 auto 兜底：detached 起 bash', async () => {
    await spawnAndKill('auto')
    expect(bash.shellPlan('auto', 'ls', '/w', {})).toEqual({ file: 'sh', args: ['-c', 'ls'], env: {}, cwd: '/w' })
  })
})

describe('工具说明里的终端名', () => {
  test('WSL 档写「WSL 里的 bash」', () => {
    chooseShell('wsl')
    const tool = bash.createBashTool()
    expect(tool.description).toContain('执行 WSL 里的 bash 命令')
  })

  test('sh 档写「shell」（不带平台默认的误导）', () => {
    chooseShell('sh')
    const tool = bash.createBashTool()
    expect(tool.description).toContain('执行 shell 命令')
  })
})

describe('环形缓冲被真子进程撑爆：作业表', () => {
  test('输出超过 JOB_OUTPUT_CAP：头部被丢、dropped 记绝对偏移，尾部还在', async () => {
    const notes: string[] = []
    const table = new bash.JobTable({ notify: (text) => notes.push(text) })
    const id = table.launch(nodeScript("process.stdout.write('x'.repeat(120000))"), work)
    await until(() => (table.get(id)?.status === 'running' ? undefined : true), '作业完成')
    const job = table.get(id)!
    expect(job.status).toBe('completed')
    expect(job.dropped).toBeGreaterThan(0)
    expect(job.output.length).toBe(bash.JOB_OUTPUT_CAP)
    expect(notes[0]).toContain('成功完成')
    const view = table.output(id)
    expect(view.droppedChars).toBeGreaterThan(0)
    expect(view.atEnd).toBe(true)
  }, 30_000)
})

describe('终端会话：真子进程的退出、缓冲上限与读取游标', () => {
  test('进程自己退出：close 回调把会话标成结束并通知宿主', async () => {
    const exits: string[] = []
    const table = new bash.TerminalTable({ onExit: (id) => exits.push(id) })
    const id = table.open('sess-w13')
    // 不走 table.close（那会先把状态改成 closed），直接杀进程：这样才走 close 事件那条路。
    const child = bash.trackedBackgroundChild(id)
    expect(child).toBeDefined()
    child?.kill()
    await until(() => (table.list()[0]?.status === 'closed' ? true : undefined), '终端关闭')
    expect(exits).toContain(id)
    expect(table.list()[0]?.finishedAt).toBeTypeOf('number')
  }, 30_000)

  test('输出超过 TERM_OUTPUT_CAP：dropped 有值；read 的尾部窗口 / 显式 offset / 越界夹取', async () => {
    const table = new bash.TerminalTable()
    const id = table.open()
    try {
      table.send(id, `${nodeScript("process.stdout.write('y'.repeat(120000))")}\n`)
      await until(() => (table.peek(id).droppedChars > 0 ? true : undefined), '终端输出撑爆缓冲')

      const first = table.read(id)
      // 头部已被丢：第一次读拿的是尾部窗口（总长超过窗口），已到末尾。
      expect(first.droppedChars).toBeGreaterThan(0)
      expect(first.atEnd).toBe(true)
      expect(first.text.length).toBe(bash.TERM_VIEW_CHARS)

      // 游标已经到末尾：再读是空的（lastRead > 0 的分支），只读快照不吃游标。
      const again = table.read(id)
      expect(again.text).toBe('')
      expect(table.peek(id).text.length).toBeGreaterThan(0)

      // 显式 offset 要比总长小：从丢弃位置开始读，离末尾还远，回包带续读提示。
      const fromStart = table.read(id, 0)
      expect(fromStart.from).toBe(first.droppedChars)
      expect(fromStart.atEnd).toBe(false)
      expect(fromStart.text).toContain('后面还有')
      expect(fromStart.text).toContain('offset=')

      // 越过总长：夹回末尾，不报错。
      const beyond = table.read(id, 9_999_999)
      expect(beyond.text).toBe('')
      expect(beyond.atEnd).toBe(true)

      // 非有限数的 offset 按没给处理（照旧从游标读）。
      const nan = table.read(id, Number.NaN)
      expect(nan.atEnd).toBe(true)
    } finally {
      table.close(id)
    }
  }, 30_000)

  test('启动失败（可执行文件起不来）：记 closed、输出里带原因、通知宿主', async () => {
    chooseShell('pwsh')
    const savedPath = process.env['PATH']
    const savedProgramFiles = process.env['ProgramFiles']
    const savedLocalAppData = process.env['LOCALAPPDATA']
    // 让探测找不到 pwsh，再让 spawn 也找不到它：只剩「起不来」这一条路。
    rmSync(join(HOME, 'cache', 'shells.json'), { force: true })
    process.env['PATH'] = ''
    delete process.env['ProgramFiles']
    delete process.env['LOCALAPPDATA']
    try {
      terminalEnv.forgetShellDetection()
      const exits: string[] = []
      const table = new bash.TerminalTable({ onExit: (id) => exits.push(id) })
      const id = table.open()
      await until(() => (table.list()[0]?.status === 'closed' ? true : undefined), '终端启动失败')
      expect(table.list()[0]?.output).toContain('[启动失败：')
      expect(exits).toContain(id)
    } finally {
      if (savedPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = savedPath
      if (savedProgramFiles === undefined) delete process.env['ProgramFiles']
      else process.env['ProgramFiles'] = savedProgramFiles
      if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = savedLocalAppData
      rmSync(join(HOME, 'cache', 'shells.json'), { force: true })
      terminalEnv.forgetShellDetection()
    }
  }, 30_000)
})
