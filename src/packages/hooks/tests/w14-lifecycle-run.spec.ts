/**
 * hooks 包外部命令执行面的长尾补盲（w14）：`runLifecycleCommand` 的四条分支——
 * stderr 有输出（按上限收）、`spawn` 同步抛错（NUL 字节）、子进程异步 error（工作目录
 * 不存在）与 close 后按失败结清。
 *
 * 环境用临时 HOME，不碰真实 `~/.dsc`；脚本是真 `node` 子进程，但都很快退出。
 *
 * @module dsc/packages/hooks/tests/w14-lifecycle-run.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { LifecyclePayload } from '../lifecycle-hooks.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-lifecycle-w14-'))
const savedDscHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = join(HOME, '.dsc')

let lifecycle: typeof import('../lifecycle-hooks.js')

beforeAll(async () => {
  lifecycle = await import('../lifecycle-hooks.js')
})

afterAll(() => {
  if (savedDscHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedDscHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

const payload: LifecyclePayload = {
  session_id: 'sess-lifecycle-w14',
  transcript_path: null,
  cwd: HOME,
  hook_event_name: 'PreToolUse',
  model: 'fake/model',
  permission_mode: 'default',
}

/** 写一个「吐 stdout、吐 stderr、退出 0」的小脚本，返回 `node <文件>` 形式的命令。 */
function scriptWithStderr(): string {
  const file = join(HOME, 'noisy-w14.mjs')
  writeFileSync(file, "process.stdout.write('out-text')\nprocess.stderr.write('boom-w14')\n", 'utf8')
  return `node ${file}`
}

test('脚本写了 stderr：stderr 原文收进结果，stdout 也照收', async () => {
  const run = await lifecycle.runLifecycleCommand(scriptWithStderr(), 5_000, payload, HOME, new AbortController().signal)
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain('out-text')
  expect(run.stderr).toContain('boom-w14')
  expect(run.spawnError).toBe('')
})

test('命令里有 NUL 字节：spawn 同步抛错被接住，返回 spawnError', async () => {
  const run = await lifecycle.runLifecycleCommand('node bad\0path', 1_000, payload, HOME, new AbortController().signal)
  expect(run.exitCode).toBe(-1)
  expect(run.spawnError).toContain('null bytes')
  expect(run.timedOut).toBe(false)
})

test('工作目录不存在：子进程 error 记进 spawnError，close 后按失败结清', async () => {
  const run = await lifecycle.runLifecycleCommand(
    'node -e "0"',
    1_000,
    payload,
    join(HOME, 'gone-dir'),
    new AbortController().signal,
  )
  expect(run.exitCode).toBe(-1)
  expect(run.spawnError).toContain('ENOENT')
})
