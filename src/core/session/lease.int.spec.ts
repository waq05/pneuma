/**
 * 会话写租约：OS 原生互斥是否真的替掉了「pid 文件锁」（integration 层）。
 *
 * 事故形状（原 `scripts/session-lease-test.mjs` 逐条复刻）：老 Pneuma 崩溃留下的
 * `.lock` 记着 pid，Windows 把同一个 pid 复用给了无关程序，判定「主人还活着」，
 * 于是归档/打开会话被「会话正在另一个 Pneuma 窗口使用」永久挡死。
 *
 * 四件事分四组钉：
 *   ① 同进程可重入：同一路径 load 两次都成功，两次 close 不炸，计数归零后还能再 load；
 *   ② 跨进程互斥：子进程握着租约时父进程 load 必须报「另一个 Pneuma 窗口」，子进程
 *      退出后立刻能 load（锁随进程消失）；
 *   ③ 幽灵锁不挡 load：锁文件写着「本进程 pid + birth=1」、或「父进程 pid」（pid 被
 *      无关的活进程复用），判定都不该看锁文件内容；
 *   ④ 同一把幽灵锁存在时归档也必须成功（用户报的那个场景）。
 *
 * ## 为什么 HOME 交给 `tests/setup/temp-home.ts`，而不是调 `tempHome()`
 *
 * `core/path-policy.ts:23` 的 `DSC_HOME` 是**模块顶层常量**，`sessionsRoot()` 在模块
 * 加载那一刻就定死了。本文件静态 import `@pneuma/runtime/core/session.js`，模块加载
 * 发生在任何测试代码之前；此时再 `tempHome()` 换一个新目录，只会让 `homedir()` 与
 * `DSC_HOME` 分裂成两个不同的临时目录——那不是更严的隔离，是「一半隔离」。所以这里
 * 与样板 `session.int.spec.ts` 同口径：integration 层的 setup 文件负责 HOME，本文件
 * 只断言「当前 HOME 与 sessions 根都在系统临时目录里」作为保险。
 *
 * ## 子进程为什么带一个自写的模块加载钩子
 *
 * 跨进程互斥必须真的起第二个进程。子进程要跑的是**源码** `src/core/session.ts`，
 * 而本仓库的测试层禁止 import `lib/`（编译产物会掩盖源码改动，见 `vitest.config.ts`
 * 文件头），也没有装 tsx / vite-node。所以子进程用一个 20 行的 `node:module`
 * `registerHooks` 引导：把 `.js` 说明符落到同名 `.ts`，再用
 * `module.stripTypeScriptTypes` 去类型。被测代码是同一份源码，锁协议没有被测试重写。
 *
 * @module dsc/core/session/lease.int.spec
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { archiveSession, Session, sessionsRoot, slugCwd } from '@pneuma/runtime/core/session.js'
import { tryOsLock } from '@pneuma/runtime/core/os-lock.js'

/** 仓库根：本文件在 `src/core/session/`。子进程的加载钩子要靠它把 `@pneuma/runtime/*` 映射回源码。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 本文件自己的临时工作区（放会话文件、子进程脚本与日志）。 */
let work: string
/** 会话文件所在的规范目录：`sessions/<slugCwd(cwd)>/`，与真实布局一致。 */
let sessionDir: string

beforeAll(() => {
  // 保险：integration 层必须跑在临时主目录上，否则这里会往真实 ~/.dsc 写会话、抢真实租约。
  const home = process.env.HOME ?? ''
  const sessions = sessionsRoot()
  const insideTemp = (target: string): boolean => {
    const rel = relative(resolve(tmpdir()), resolve(target))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  expect(insideTemp(home), `HOME 不是临时目录：${home}`).toBe(true)
  expect(insideTemp(sessions), `sessions 根不是临时目录：${sessions}`).toBe(true)

  work = mkdtempSync(join(tmpdir(), 'dsc-lease-work-'))
  sessionDir = join(sessionsRoot(), slugCwd(work))
  mkdirSync(sessionDir, { recursive: true })
})

/** 起过的子进程：失败路径也要收掉，否则 worker 被句柄钉住。 */
const children = new Set<ChildProcess>()

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  children.clear()
  rmSync(work, { recursive: true, force: true })
})

/** 在本文件的会话目录里写一条最小会话；返回它的绝对路径。 */
function writeSession(id: string, text: string): string {
  const file = join(sessionDir, `${id}.jsonl`)
  const lines = [
    { type: 'meta', id, cwd: work, createdAt: Date.now() },
    { type: 'user', text },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return file
}

/**
 * 模拟「pid 被回收复用」：锁文件里的 pid 就是本进程，但 birth 是 1（不是这一次）。
 *
 * 只写这一个形状、不改锁的实现：OS 锁路径根本不读锁文件；文件锁降级路径靠
 * 「pid 是自己但 birth 不是这一次」接管规则放行。
 */
function writeGhostLock(file: string, pid: number): void {
  writeFileSync(`${file}.lock`, `${JSON.stringify({ pid, birth: 1, at: 1 })}\n`, 'utf8')
}

/** 读锁文件的 `how` 字段（「这次是谁的」由它说明）；读不到就是 undefined。 */
function lockHow(file: string): unknown {
  try {
    return (JSON.parse(readFileSync(`${file}.lock`, 'utf8')) as { how?: unknown }).how
  } catch {
    return undefined
  }
}

/** 捕获同步调用抛出的错误；不抛就是 undefined。 */
function caught(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * 子进程的模块加载钩子：`.js` 说明符落到同名 `.ts`，`@pneuma/runtime/*` 映射回 `src/*`，
 * 然后用 Node 自带的 `stripTypeScriptTypes` 去类型（Node 24 支持，仓库要求 >= 22.19）。
 */
function loaderSource(): string {
  return `
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO = ${JSON.stringify(REPO_ROOT)}
const toTs = (path) => path.replace(/\\.js$/, '.ts')
const asUrl = (path) => pathToFileURL(path).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@pneuma/runtime/')) {
      const target = resolve(REPO, 'src', specifier.slice('@pneuma/runtime/'.length))
      const candidate = toTs(target)
      return { url: asUrl(existsSync(candidate) ? candidate : target), shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL && context.parentURL.startsWith('file:')) {
      const candidate = resolve(dirname(fileURLToPath(context.parentURL)), toTs(specifier))
      if (existsSync(candidate)) return { url: asUrl(candidate), shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
`
}

/**
 * 子进程脚本：拿住租约、打印 HELD，然后**等一个释放哨兵文件**再 close。
 *
 * 为什么不用固定 sleep：探针原来让子进程睡 3 秒，父进程在这 3 秒里赌自己能跑完
 * 「load 必须失败 → 释放 → load 必须成功」。慢机器上父进程跑完时子进程已经退出，
 * 「互斥住了」这条就变成了测一条空锁。哨兵文件把顺序交给被测方：父进程断言完再写。
 */
function childSource(): string {
  return `
import { existsSync } from 'node:fs'

const { Session } = await import('@pneuma/runtime/core/session.js')
const file = process.argv[2]
const sentinel = process.argv[3]
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const session = Session.load(file, true)
process.stdout.write('HELD\\n')
const deadline = Date.now() + 15000
while (!existsSync(sentinel) && Date.now() < deadline) await sleep(20)
session.close()
process.stdout.write('RELEASED\\n')
`
}

/** 轮询读一个文件，直到它包含 `needle`；超时返回已读到的全文（由调用方的断言给出差异）。 */
async function readUntil(file: string, needle: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    if (text.includes(needle) || Date.now() > deadline) return text
    await new Promise((done) => setTimeout(done, 20))
  }
}

/** 起一个「握着租约」的子进程；日志落到普通文件（管道在受限环境里会被拦）。 */
async function holdLeaseInChild(file: string): Promise<{ child: ChildProcess; log: string; release: () => void; exited: Promise<number | null> }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-lease-child-'))
  const loader = join(dir, 'loader.mjs')
  const script = join(dir, 'child.mjs')
  writeFileSync(loader, loaderSource(), 'utf8')
  writeFileSync(script, childSource(), 'utf8')
  const logFile = join(dir, 'child.out')
  const errFile = join(dir, 'child.err')
  const sentinel = join(dir, 'release')
  const outFd = openSync(logFile, 'w')
  const errFd = openSync(errFile, 'w')
  let child: ChildProcess
  try {
    child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, script, file, sentinel], {
      // 同一个 HOME：两边算出来的会话根与锁锚点必须在一处（Windows 上 USERPROFILE 生效）。
      env: { ...process.env, HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '' },
      stdio: ['ignore', outFd, errFd],
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  children.add(child)
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => {
      children.delete(child)
      done(code)
    })
  })
  // 子进程起不来（loader 语法错、源码装载失败）时不要把 15 秒等满：日志里只有 stderr 的栈。
  const held = await readUntil(logFile, 'HELD', 20_000)
  if (!held.includes('HELD')) {
    let stderr = ''
    try {
      stderr = readFileSync(errFile, 'utf8')
    } catch {
      stderr = ''
    }
    throw new Error(`子进程没能打印 HELD（源码装载失败？）\n--- stdout ---\n${held}\n--- stderr ---\n${stderr}`)
  }
  const release = (): void => {
    writeFileSync(sentinel, 'go\n', 'utf8')
  }
  return { child, log: logFile, release, exited }
}

/** 这次走的是 OS 原生锁吗？OS 锁不可用时锁文件降级路径的信息量不同（见 §④ 的跳过理由）。 */
const osAttempt = tryOsLock(join(tmpdir(), `dsc-lease-probe-${process.pid}-${Date.now()}.jsonl`))
const osAvailable = osAttempt.kind === 'ok'
if (osAvailable) osAttempt.lock.release()

describe('① 同进程可重入', () => {
  test('同一条会话在同一进程里 load 两次都成功', () => {
    const file = writeSession('11111111-1111-4111-8111-111111111111', '同进程可重入')
    const first = Session.load(file, true)
    const second = Session.load(file, true)
    try {
      expect(first).toBeDefined()
      expect(second).toBeDefined()
    } finally {
      first.close()
      second.close()
    }
  })

  test('两次 close 都不抛', () => {
    // 引用计数写错时最典型的症状就是第二次 close 抛（重复放锁）；这条单独钉住它。
    const file = writeSession('22222222-2222-4222-8222-222222222222', '两次 close')
    const first = Session.load(file, true)
    const second = Session.load(file, true)
    const failure = caught(() => {
      first.close()
      second.close()
    })
    expect(failure).toBeUndefined()
  })

  test('两次 close 之后还能再 load（计数归零真放锁）', () => {
    const file = writeSession('33333333-3333-4333-8333-333333333333', '计数归零')
    const first = Session.load(file, true)
    const second = Session.load(file, true)
    first.close()
    second.close()
    const third = Session.load(file, true)
    try {
      expect(third).toBeDefined()
    } finally {
      third.close()
    }
  })
})

describe('② 跨进程互斥', () => {
  test('子进程持锁时父进程 load 抛错，文案指向「另一个 Pneuma 窗口」', async () => {
    const file = writeSession('44444444-4444-4444-8444-444444444444', '跨进程互斥')
    const held = await holdLeaseInChild(file)
    try {
      const failure = caught(() => Session.load(file, true))
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('另一个 Pneuma 窗口')
    } finally {
      held.release()
    }
  })

  test('子进程退出后立刻能 load（锁随进程消失）', async () => {
    const file = writeSession('55555555-5555-4555-8555-555555555555', '锁随进程消失')
    const held = await holdLeaseInChild(file)
    held.release()
    expect(await held.exited).toBe(0)
    const after = Session.load(file, true)
    try {
      expect(after).toBeDefined()
    } finally {
      after.close()
    }
  })
})

describe('③ 幽灵锁不挡 load（pid 被复用）', () => {
  test('锁文件写着本进程 pid + 旧 birth 时照样 load 成功', () => {
    // 事故里最坏的一种：pid 就是自己（老进程崩了，pid 被复用），只看锁文件必然永久挡死。
    const file = writeSession('66666666-6666-4666-8666-666666666666', '幽灵锁 pid 是自己')
    writeGhostLock(file, process.pid)
    const session = Session.load(file, true)
    try {
      expect(session).toBeDefined()
    } finally {
      session.close()
    }
  })

  test.skipIf(!osAvailable)('锁文件写着无关活进程 pid 时照样 load 成功', () => {
    // 真实事故里三条会话的锁分别是 pid 40620（后来的 Pneuma）、9364（后来的 Typora）：
    // pid 活着，但根本不是当年那个进程。OS 锁路径不读锁文件内容，必须照样放行。
    const file = writeSession('77777777-7777-4777-8777-777777777777', '幽灵锁 pid 是别人')
    writeGhostLock(file, process.ppid)
    const session = Session.load(file, true)
    try {
      expect(session).toBeDefined()
    } finally {
      session.close()
    }
  })

  test.skipIf(!osAvailable)('拿到锁之后锁文件说明改写成本次持有者', () => {
    // 报错文案里那个 pid 要可信，靠的是锁文件被改写成「这次是谁」（`how: 'os'`）。
    const file = writeSession('99999999-9999-4999-8999-999999999999', '锁说明改写')
    writeGhostLock(file, process.ppid)
    const session = Session.load(file, true)
    try {
      expect(lockHow(file)).toBe('os')
    } finally {
      session.close()
    }
  })
})

describe('④ 幽灵锁存在时归档', () => {
  test('幽灵锁存在时归档成功（用户报的那个场景）', () => {
    const file = writeSession('88888888-8888-4888-8888-888888888888', '幽灵锁下归档')
    writeGhostLock(file, process.pid)
    const archived = archiveSession(file)
    expect(archived).toContain('.archived')
    expect(existsSync(archived)).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})
