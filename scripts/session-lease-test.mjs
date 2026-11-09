/**
 * 会话写租约的自检：OS 原生互斥（命名互斥量 / flock）是否真的替掉了「pid 文件锁」。
 *
 * 报障形状：老 Pneuma 崩溃留下的 `.lock` 记着 pid，Windows 把同一个 pid 复用了给
 * 无关程序，判定「主人还活着」，于是归档/打开会话被 `会话正在另一个 Pneuma 窗口使用`
 * 永久挡死。这个脚本要证明四件事：
 *
 *   1. 同进程可重入：同一路径 `Session.load` 两次都成功，两次 close 不炸；
 *   2. 跨进程互斥：子进程握着租约时父进程 load 必须报「另一个 Pneuma 窗口」，子进程
 *      退出后立刻能 load（锁随进程消失）；
 *   3. 幽灵锁回归：锁文件写着「本进程 pid + birth=1」（模拟 pid 被复用），load 必须
 *      成功——判定不再看锁文件内容；
 *   4. 同一把幽灵锁存在时，归档也必须成功（用户报的那个场景）。
 *
 * 第 3、4 条在两条路径下都必须成立：OS 锁路径根本不读锁文件；文件锁降级路径靠新增的
 * 「pid 是自己但 birth 不是这一次」接管规则。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/session-lease-test.mjs
 *
 * @module dsc/scripts/session-lease-test
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-lease-home-'))
// 必须在 import 核心之前换掉 HOME / USERPROFILE：会话落盘位置按 homedir 算。
process.env.HOME = home
process.env.USERPROFILE = home

const { Session, archiveSession, sessionsRoot, slugCwd } = await import('../lib/core/session.js')
const { tryOsLock } = await import('../lib/core/os-lock.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ---- 造会话：cwd 是临时工作目录，日志放 sessions/<slugCwd(cwd)>/ ----
const work = join(home, 'work')
mkdirSync(work, { recursive: true })
const dir = join(sessionsRoot(), slugCwd(work))
mkdirSync(dir, { recursive: true })

const writeSession = (id, text) => {
  const file = join(dir, `${id}.jsonl`)
  const lines = [
    { type: 'meta', id, cwd: work, createdAt: Date.now() },
    { type: 'user', text },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}

const liveFile = writeSession('33333333-3333-4333-8333-333333333333', '租约回归用')
const archiveFile = writeSession('44444444-4444-4444-8444-444444444444', '幽灵锁下归档')

/** 模拟「pid 被回收复用」：锁文件里的 pid 就是本进程，但 birth 是 1（不是这一次）。 */
const writeGhostLock = (file) => {
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, birth: 1, at: 1 }), 'utf8')
}

// 先报一下这次走的是哪条路：OS 锁可用就一定是 OS 路径。
const probe = tryOsLock(join(home, 'probe.jsonl'))
const osPath = probe.kind === 'ok'
if (probe.kind === 'ok') {
  probe.lock.release()
  console.log('  INFO  本次使用 OS 原生锁')
} else {
  console.log(`  INFO  OS 锁不可用（${probe.kind === 'busy' ? 'busy' : probe.why}），走文件锁降级`)
}

// ---- 1. 同进程可重入 ----
{
  let first
  let second
  let error
  try {
    first = Session.load(liveFile, true)
    second = Session.load(liveFile, true)
  } catch (caught) {
    error = caught
  }
  check('同进程重复 load 同一会话成功（可重入）', first !== undefined && second !== undefined, error?.message ?? '')
  let closeError
  try {
    first?.close()
    second?.close()
  } catch (caught) {
    closeError = caught
  }
  check('两次 close 不炸', closeError === undefined, closeError?.message ?? '')
  // 计数归零后应该真的放锁：第三次 load 仍能成功。
  let third
  let thirdError
  try {
    third = Session.load(liveFile, true)
  } catch (caught) {
    thirdError = caught
  }
  check('全部 close 之后还能再 load（计数归零真放锁）', third !== undefined, thirdError?.message ?? '')
  third?.close()
}

// ---- 2. 跨进程互斥 ----
{
  const sessionUrl = pathToFileURL(join(process.cwd(), 'lib', 'core', 'session.js')).href
  const childCode =
    `const { Session } = await import(${JSON.stringify(sessionUrl)});` +
    `const session = Session.load(${JSON.stringify(liveFile)}, true);` +
    `process.stdout.write('HELD\\n');` +
    `await new Promise((resolve) => setTimeout(resolve, 3000));` +
    `session.close();`
  // 子进程的 stdout 落到普通文件而不是管道：DSH 的 Windows 沙箱会拦掉带管道的 stdio
  // （spawn EPERM），普通文件 fd 在受限与正常环境里都能跑。语义不变——等它打印 HELD。
  const childLog = join(home, 'lease-child.out')
  const childErr = join(home, 'lease-child.err')
  const outFd = openSync(childLog, 'w')
  const errFd = openSync(childErr, 'w')
  let child
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      // 子进程必须用同一个 HOME，否则两边算出来的锁不在一处（Windows 上 USERPROFILE 生效）。
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', outFd, errFd],
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }

  let exitCode = null
  const exited = new Promise((resolve) => child.once('exit', (code) => {
    exitCode = code
    resolve(code)
  }))
  const readChildLog = () => {
    try {
      return readFileSync(childLog, 'utf8') + readFileSync(childErr, 'utf8')
    } catch {
      return ''
    }
  }
  const held = await new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      const text = readChildLog()
      if (text.includes('HELD')) {
        resolve(true)
        return
      }
      if (exitCode !== null) {
        reject(new Error(`子进程提前退出（code=${String(exitCode)}）：${text}`))
        return
      }
      if (Date.now() - startedAt > 20_000) {
        reject(new Error(`子进程 20 秒内没打印 HELD：${text}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
  check('子进程拿租约并打印 HELD', held === true)

  let busyError
  try {
    Session.load(liveFile, true)
  } catch (caught) {
    busyError = caught
  }
  check('子进程持锁时父进程 load 抛错', busyError !== undefined, '没抛错，锁没互斥住')
  check(
    '错误文案含「另一个 Pneuma 窗口」',
    busyError instanceof Error && busyError.message.includes('另一个 Pneuma 窗口'),
    busyError instanceof Error ? busyError.message : String(busyError),
  )

  const code = await exited
  check('子进程正常退出', code === 0, `exit code ${String(code)}`)
  let after
  let afterError
  try {
    after = Session.load(liveFile, true)
  } catch (caught) {
    afterError = caught
  }
  check('子进程退出后 load 成功（锁随进程消失）', after !== undefined, afterError?.message ?? '')
  after?.close()
}

// ---- 3. 幽灵锁回归：pid 撞上自己、birth 不是这一次 ----
{
  writeGhostLock(liveFile)
  let ghost
  let ghostError
  try {
    ghost = Session.load(liveFile, true)
  } catch (caught) {
    ghostError = caught
  }
  check(
    '幽灵锁（本进程 pid + 旧 birth）不挡 load',
    ghost !== undefined,
    ghostError instanceof Error ? ghostError.message : String(ghostError ?? ''),
  )
  ghost?.close()
}

// ---- 4. 同一把幽灵锁存在时归档也必须成功 ----
{
  writeGhostLock(archiveFile)
  let archived
  let archiveError
  try {
    archived = archiveSession(archiveFile)
  } catch (caught) {
    archiveError = caught
  }
  check(
    '幽灵锁存在时归档成功',
    typeof archived === 'string' && existsSync(archived) && archived.includes('.archived'),
    archiveError instanceof Error ? archiveError.message : String(archiveError ?? archived ?? ''),
  )
}

// ---- 5. 幽灵锁的另一种形状：pid 被「无关的活进程」复用 ----
// 真实事故里三条会话的锁分别是 pid 40620（后来的 Pneuma）、9364（后来的 Typora）、
// 42880（后来的 java）：pid 活着，但根本不是当年那个进程。OS 锁路径不读锁文件内容，
// 必须照样放行；文件锁降级路径无从核实别人的启动时刻，只能保守当 busy（如实跳过）。
{
  writeFileSync(`${liveFile}.lock`, JSON.stringify({ pid: process.ppid, birth: 1, at: 1 }), 'utf8')
  let loaded
  let loadError
  try {
    loaded = Session.load(liveFile, true)
  } catch (caught) {
    loadError = caught
  }
  if (osPath) {
    check(
      '幽灵锁（pid 是无关的活进程）不挡 load',
      loaded !== undefined,
      loadError instanceof Error ? loadError.message : String(loadError ?? ''),
    )
    // 顺手证明说明被改写成了本次持有者，报错文案里那个 pid 才是可信的。
    let how
    try {
      how = JSON.parse(readFileSync(`${liveFile}.lock`, 'utf8')).how
    } catch {
      how = undefined
    }
    check('拿到锁之后锁文件说明改写成本次持有者', how === 'os', String(how))
  } else {
    console.log('  SKIP  幽灵锁（pid 是无关的活进程）：文件锁降级路径无从核实别人的启动时刻')
  }
  loaded?.close()
}

console.log(failures === 0 ? 'session-lease: ALL PASS' : `session-lease: ${String(failures)} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
