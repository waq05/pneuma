/**
 * Windows 沙箱 runner 入口（`win/runner-entry.ts`）的参数校验与失败语义补测（W14）。
 *
 * ## 为什么必须「跑真入口」而不是单测内部函数
 *
 * `runner-entry.ts` 的模块体末尾无条件执行 `main().then(...)`：它没有 `import.meta.main` 之类的守卫，
 * 谁 import 谁就解析本进程的 `argv`。所以这里不 import 完再调函数，而是**喂真 argv 跑真入口**：
 * 临时改写 `process.argv`、截住 `process.stderr.write`、读入口写回的 `process.exitCode`，
 * 跑完再原样还原。走的正是宿主 spawn runner 时的同一个模块、同一条错误包装路径
 * （`dsc-sandbox-run: …` + 127），不是另写一份模拟。
 *
 * 所有用例都让参数校验**先失败**：校验全部通过时入口会去 `loadFfi()` 并真建受限令牌/作业对象，
 * 那是「需要真实受限进程」的面，属于集成层的活（见 `win-token.int.spec.ts`），不在 unit 里跑。
 *
 * ## 子进程用例
 *
 * 另外拿构建产物 `lib/packages/sandbox/win/runner-entry.js` 真 spawn 两个进程，断言真实退出码
 * 127 与 stderr 前缀——这一层验的是「宿主看到的进程行为」。产物不存在或非 win32 时跳过：
 * runner 是 Windows 专属入口，产物要 `pnpm run build` 才有。
 *
 * @module @pneuma/sandbox/tests/w14-runner-args
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { rootWriteSid } from '../win/workspace-sid.js'

/** 仓库根：本文件在 `src/packages/sandbox/tests/` 下三层。 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const LIB_RUNNER = `${ROOT}lib/packages/sandbox/win/runner-entry.js`
const RUNNER_SIGNATURE = 'dsc-sandbox-run: '

/**
 * 跑一次真入口。
 * @param argv - 喂给入口的参数（不含 `node` 与脚本名）。
 * @returns 入口写到 stderr 的全文与它写回的 `process.exitCode`。
 */
async function runEntry(argv: readonly string[]): Promise<{ stderr: string; exitCode: number | string | undefined }> {
  const savedArgv = process.argv
  const savedExitCode = process.exitCode
  const chunks: string[] = []
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as never)
  process.argv = ['node', 'runner-entry.js', ...argv]
  process.exitCode = undefined
  try {
    // 模块体只跑一次；resetModules 让每个用例都重新求值（等价于宿主每 spawn 一次）。
    vi.resetModules()
    await import('../win/runner-entry.js')
    // 入口的 `.catch` 是同步抛错触发的微任务；await import 之后已经跑完，这里再让一拍兜底。
    await Promise.resolve()
    return { stderr: chunks.join(''), exitCode: process.exitCode }
  } finally {
    write.mockRestore()
    process.argv = savedArgv
    process.exitCode = savedExitCode
  }
}

/** 断言这一组 argv 按 runner 失败语义收场，并返回错误正文。 */
async function failureOf(argv: readonly string[]): Promise<string> {
  const result = await runEntry(argv)
  expect(result.stderr.startsWith(RUNNER_SIGNATURE), `stderr 应以签名开头，实际 ${JSON.stringify(result.stderr)}`).toBe(true)
  expect(result.exitCode, 'runner 自身失败固定 127').toBe(127)
  const message = result.stderr.slice(RUNNER_SIGNATURE.length).trim()
  expect(message, '错误正文不能为空').not.toBe('')
  return message
}

// ── argv 分隔符与受限命令 ────────────────────────────────────────────────────

test('缺 `--` 分隔符：报「argv 缺少 `--`」', async () => {
  expect(await failureOf(['--mode', 'read-only'])).toContain('argv 缺少 `--` 分隔符')
})

test('`--` 之后没有命令 / 命令名为空：各有各的文案', async () => {
  expect(await failureOf(['--mode', 'read-only', '--'])).toContain('`--` 之后没有受限命令')
  expect(await failureOf(['--mode', 'read-only', '--', ''])).toContain('第一个参数必须是非空可执行文件名')
})

// ── --mode / --temp / --timeout ─────────────────────────────────────────────

test('--mode 只认两档：非法值原样出现在报错里', async () => {
  expect(await failureOf(['--mode', '', '--', 'cmd'])).toContain('--mode 只认 read-only / workspace-write')
  expect(await failureOf(['--mode', 'write', '--', 'cmd'])).toContain('收到「write」')
})

test('--temp 必填、非空、不许重复', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', '', '--', 'cmd'])).toContain('--temp 需要一个非空目录')
  expect(await failureOf(['--mode', 'read-only', '--temp', 'a', '--temp', 'b', '--', 'cmd'])).toContain('--temp 给重复了')
})

test('--timeout 只认非负十进制整数；缺值、负数、重复都拦下', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--timeout', '--', 'cmd'])).toContain('--timeout 需要一个毫秒数')
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--timeout', '-1', '--', 'cmd'])).toContain(
    '--timeout 只认非负十进制整数',
  )
  expect(
    await failureOf(['--mode', 'read-only', '--temp', 't', '--timeout', '1000', '--timeout', '2000', '--', 'cmd']),
  ).toContain('--timeout 给重复了')
})

// ── --root / --account / --dsc-home ─────────────────────────────────────────

test('--root 的三种写法错误：缺值、没有 =、目录为空', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--root', '--', 'cmd'])).toContain('--root 需要 <sid>=<dir>')
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--root', '=dir', '--', 'cmd'])).toContain(
    '--root 的值要写成 <sid>=<dir>',
  )
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--root', 'sid=', '--', 'cmd'])).toContain('--root 的目录是空的')
})

test('--account / --dsc-home 必填、不许重复、必须成对', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--account', '--', 'cmd'])).toContain('--account 需要一个账号名')
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--account', 'a', '--account', 'b', '--', 'cmd'])).toContain(
    '--account 给重复了',
  )
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--dsc-home', '--', 'cmd'])).toContain('--dsc-home 需要一个目录')
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--dsc-home', 'a', '--dsc-home', 'b', '--', 'cmd'])).toContain(
    '--dsc-home 给重复了',
  )
  // 只给一半：定位不到密码文件，必须拦。
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--account', 'a', '--', 'cmd'])).toContain(
    '--account 与 --dsc-home 必须成对给',
  )
  // 成对给了就组装 account；后面还有别的校验要过（这里用「给了尺寸没给 --pty」拦下）。
  expect(
    await failureOf(['--mode', 'read-only', '--temp', 't', '--account', 'a', '--dsc-home', 'h', '--cols', '80', '--', 'cmd']),
  ).toContain('--cols/--rows 只对 --pty 有效')
})

// ── --pty / --cols / --rows ─────────────────────────────────────────────────

test('--pty 不带值、不许重复', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--pty', '--pty', '--', 'cmd'])).toContain('--pty 给重复了')
})

test('--cols / --rows 只认正整数、不许重复，且没有 --pty 时不许给', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--cols', '--', 'cmd'])).toContain('--cols 需要一个正整数')
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--cols', '80', '--', 'cmd'])).toContain('没有给 --pty')
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--pty', '--cols', '0', '--', 'cmd'])).toContain(
    '--cols 只认正整数',
  )
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--pty', '--cols', '80', '--cols', '90', '--', 'cmd'])).toContain(
    '--cols 给重复了',
  )
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--pty', '--rows', 'abc', '--', 'cmd'])).toContain(
    '--rows 只认正整数',
  )
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--pty', '--rows', '24', '--rows', '25', '--', 'cmd'])).toContain(
    '--rows 给重复了',
  )
})

// ── 组合校验 ────────────────────────────────────────────────────────────────

test('不认识的参数：整串原样报出来（不猜）', async () => {
  expect(await failureOf(['--mode', 'read-only', '--temp', 't', '--nope', 'x', '--', 'cmd'])).toContain(
    '不认识的 runner 参数：「--nope」',
  )
})

test('缺 --mode / 缺 --temp 分别报各自的文案', async () => {
  expect(await failureOf(['--temp', 't', '--', 'cmd'])).toContain('缺少 --mode')
  expect(await failureOf(['--mode', 'read-only', '--', 'cmd'])).toContain('缺少 --temp')
})

test('workspace-write 至少要一个 --root', async () => {
  expect(await failureOf(['--mode', 'workspace-write', '--temp', 't', '--', 'cmd'])).toContain(
    'workspace-write 模式至少要有一个 --root',
  )
})

test('--root 的 SID 与路径对不上：拒绝并给出期望 SID', async () => {
  const message = await failureOf([
    '--mode',
    'workspace-write',
    '--temp',
    '/w14-temp',
    '--root',
    'S-1-5-21-1-2-3-4=bad-root',
    '--',
    'cmd',
  ])
  expect(message).toContain('--root 的 SID 与路径对不上')
  expect(message).toContain('bad-root')
})

test('temp 与可写根相交：双向包含都拒绝', async () => {
  const root = '/w14-ws/root'
  const sid = rootWriteSid(root)
  const message = await failureOf([
    '--mode',
    'workspace-write',
    '--temp',
    `${root}/temp`,
    '--root',
    `${sid}=${root}`,
    '--',
    'cmd',
  ])
  expect(message).toContain('临时目录与可写根相交')
})

test('重复的可写根、以及把 temp 写进 --root：都拒绝', async () => {
  const root = '/w14-dup/root'
  const sid = rootWriteSid(root)
  const duplicate = await failureOf([
    '--mode',
    'workspace-write',
    '--temp',
    '/w14-temp2',
    '--root',
    `${sid}=${root}`,
    '--root',
    `${sid}=${root}`,
    '--',
    'cmd',
  ])
  expect(duplicate).toContain('--root 给重复了')

  const tempAsRoot = await failureOf(['--mode', 'workspace-write', '--temp', root, '--root', `${sid}=${root}`, '--', 'cmd'])
  expect(tempAsRoot).toContain('--root 里不许出现临时目录')
})

// ── 真实子进程：宿主看到的退出码与 stderr ───────────────────────────────────

const canSpawnBuilt = process.platform === 'win32' && existsSync(LIB_RUNNER)

describe.skipIf(!canSpawnBuilt)('构建产物 runner 子进程（win32 + 已构建）', () => {
  test('缺 --mode：退出码 127、stderr 带 `dsc-sandbox-run: ` 前缀', () => {
    const result = spawnSync(process.execPath, [LIB_RUNNER, '--temp', 't', '--', 'cmd'], { encoding: 'utf8' })
    expect(result.status).toBe(127)
    expect(result.stderr.startsWith(RUNNER_SIGNATURE)).toBe(true)
    expect(result.stderr).toContain('缺少 --mode')
  })

  test('非法 --timeout：退出码 127、错误文案与同进程入口一致', () => {
    const result = spawnSync(
      process.execPath,
      [LIB_RUNNER, '--mode', 'read-only', '--temp', 't', '--timeout', '1e3', '--', 'cmd'],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(127)
    expect(result.stderr.startsWith(RUNNER_SIGNATURE)).toBe(true)
    expect(result.stderr).toContain('--timeout 只认非负十进制整数')
  })
})
