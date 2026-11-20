/**
 * sandbox 非 runner 面的补测（W14）：预览的「算不出来」分支 + 容器执行器的命令解包兜底。
 *
 * 覆盖目标（对照 W14 缺口清单）：
 * - `review.ts`：二进制嗅探自己读不动时按「不是二进制」处理、旧文件读取的非 ENOENT 错误、
 *   旧文件超过预览上限、渲染「逐行 diff 未给出」的那一支；
 * - `backends.ts`：`unwrapShellCommand` 认不出 shell 形态时返回 null（不猜）。
 *
 * 为什么挑这几处：它们不需要 koffi / 受限令牌 / 真实网络，纯文件系统与纯函数就能造出
 * 真实现场（目录当文件读、2MB+ 旧文件、未知可执行文件名）。其余缺口行（FFI 探测失败、
 * 防火墙查询异常、ACL/作业对象操作、代理上游连接错误）要么需要真实 Win32 受限进程，
 * 要么需要跨进程网络故障注入，属于 integration 面，见本文件末尾的说明与报告。
 *
 * @module @pneuma/sandbox/tests/w14-review-backends
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnPlan } from '../../../core/tools/command-runner.js'
import type { ToolGuardInput } from '../../../core/tool-guards.js'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { unwrapShellCommand } from '../backends.js'
import { buildPreview, renderReview, REVIEW_DEFAULTS } from '../review.js'

/** 用例之间的临时工作区。 */
let dir = ''
const dirs: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-sandbox-w14-review-'))
  dirs.push(dir)
})

afterAll(() => {
  for (const path of dirs)
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
})

/** 守卫链上的输入（与 `review.spec.ts` 同形）。 */
function guardInput(overrides: Partial<ToolGuardInput> = {}): ToolGuardInput {
  return {
    toolName: 'write',
    risk: 'write',
    cwd: dir,
    args: { path: join(dir, 'a.txt'), content: 'new\n' },
    target: join(dir, 'a.txt'),
    signal: new AbortController().signal,
    sessionId: 'w14-s1',
    sessionPath: join(dir, '.sessions', 'w14-s1.jsonl'),
    ...overrides,
  }
}

/** 一份最小执行计划。 */
function plan(overrides: Partial<SpawnPlan>): SpawnPlan {
  return { file: 'sh', args: [], env: {}, cwd: dir, ...overrides }
}

test('unwrapShellCommand：认不出的可执行文件、以及 shell 不带命令参数时都返回 null', () => {
  expect(unwrapShellCommand(plan({ file: 'python3', args: ['-c', 'print(1)'] }))).toBeNull()
  // powershell 认得，但没有 -Command / -c：flagValue 走「找不到就 null」的兜底。
  expect(unwrapShellCommand(plan({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive'] }))).toBeNull()
  // 正常形态仍然解包（钉住这次补测没把原路径改坏）。
  expect(unwrapShellCommand(plan({ file: 'cmd.exe', args: ['/c', 'echo hi'] }))).toBe('echo hi')
})

test('buildPreview：目标是目录 → 嗅探读不动按「不是二进制」，旧文件读取报错写进预览但不抛', () => {
  const folder = join(dir, 'as-dir')
  mkdirSync(folder)
  const preview = buildPreview(
    guardInput({
      toolName: 'edit',
      target: folder,
      args: { path: folder, old: 'nothing', new: 'x' },
    }),
    REVIEW_DEFAULTS,
  )
  // 预览不能为 null（守卫链上抛错会被当拒），但内容退成一句说明。
  expect(preview).not.toBeNull()
  expect(preview?.diff.ok).toBe(false)
  expect(preview?.summary).toContain('预览算不出')
})

test('buildPreview：旧文件超过 2MB 预览上限 → 不读全文，只给一句摘要', () => {
  const big = join(dir, 'big.txt')
  writeFileSync(big, `${'x'.repeat(2 * 1024 * 1024)}tail`, 'utf8')
  const preview = buildPreview(
    guardInput({
      toolName: 'write',
      target: big,
      args: { path: big, content: 'replaced\n' },
    }),
    REVIEW_DEFAULTS,
  )
  expect(preview).not.toBeNull()
  expect(preview?.diff.ok).toBe(false)
  expect(preview?.summary).toContain('超过')
})

test('renderReview：逐行 diff 没给出时渲染成一行「算不出逐行差异」的说明', () => {
  const missing = join(dir, 'missing.txt')
  const preview = buildPreview(
    guardInput({
      toolName: 'edit',
      target: missing,
      args: { path: missing, old: 'x', new: 'y' },
    }),
    REVIEW_DEFAULTS,
  )
  // edit 对不存在的文件：预览直接为 null（工具自己会回一句 old 不存在），换 write 造 noteOnly。
  expect(preview).toBeNull()
  const big = join(dir, 'too-big.txt')
  writeFileSync(big, `${'y'.repeat(2 * 1024 * 1024)}tail`, 'utf8')
  const noteOnly = buildPreview(
    guardInput({
      toolName: 'write',
      target: big,
      args: { path: big, content: 'z\n' },
    }),
    REVIEW_DEFAULTS,
  )
  expect(noteOnly).not.toBeNull()
  const rendered = renderReview(noteOnly!, REVIEW_DEFAULTS)
  expect(rendered.text).toContain('逐行 diff 未给出')
  expect(rendered.text).toContain('旧文件有')
})
