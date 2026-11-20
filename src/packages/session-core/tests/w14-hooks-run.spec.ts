/**
 * session-core 钩子脚本执行面的长尾补盲（w14）：`runHookScript` 的两条「进程没起来」
 * 路径——`spawn` 同步抛错（参数里有 NUL 字节）与子进程异步 `error`（工作目录不存在）。
 *
 * 隔离：`HOME/USERPROFILE` 在任何内核模块被加载之前指向临时目录（import 是动态的），
 * 不碰真实 `~/.dsc`。脚本执行走真 `cmd.exe /c`，但两条用例都在建进程那一步就失败，
 * 不会真的跑用户脚本。
 *
 * @module dsc/packages/session-core/tests/w14-hooks-run.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-w14-'))
const savedHome = process.env['HOME']
const savedProfile = process.env['USERPROFILE']
const savedDscHome = process.env['DSC_HOME']
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME
delete process.env['DSC_HOME']
mkdirSync(join(HOME, '.dsc'), { recursive: true })

let hooks: typeof import('../hooks.js')

beforeAll(async () => {
  hooks = await import('../hooks.js')
})

afterAll(() => {
  for (const [name, value] of [
    ['HOME', savedHome],
    ['USERPROFILE', savedProfile],
    ['DSC_HOME', savedDscHome],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

/** 最小脚本钩子：只有命令对这两条用例有意义。 */
function script(command: string): import('../hooks.js').HookScript {
  return {
    id: 's-w14',
    enabled: true,
    event: 'pre-tool',
    matcher: '*',
    command,
    timeoutMs: 1_000,
    failClosed: true,
  }
}

/** 递给脚本的完整载荷（字段与 hooks.ts 的 HookPayload 一致）。 */
const payload = {
  hook_event_name: 'pre-tool',
  tool_name: 'bash',
  tool_input: {},
  args_summary: '',
  session_id: 'sess-w14',
  cwd: HOME,
  policy: 'default',
  mode: 'default',
  command: '',
  target: '',
  extra: {},
} as never

const signal = new AbortController().signal

test('命令里有 NUL 字节：spawn 同步抛错被接住，返回 spawnError 而不是炸掉调用方', async () => {
  const result = await hooks.runHookScript(script('node bad\0path'), payload, HOME, signal, 1_000)
  expect(result.exitCode).toBe(-1)
  expect(result.spawnError).toContain('null bytes')
  expect(result.timedOut).toBe(false)
})

test('工作目录不存在：子进程异步 error 记进 spawnError，close 后按失败结清', async () => {
  const result = await hooks.runHookScript(script('node -e "0"'), payload, join(HOME, 'gone-dir'), signal, 1_000)
  expect(result.exitCode).toBe(-1)
  expect(result.spawnError).toContain('ENOENT')
  expect(result.timedOut).toBe(false)
})
