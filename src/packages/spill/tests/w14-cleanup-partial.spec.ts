/**
 * spill 收尾缺口（`packages/spill/index.ts:230-234`）：清理按钮的「部分没删掉」分支。
 *
 * 正常情况下 `sweepSpillDir` 只在文件被杀毒软件占着 / 没有权限时才把条目记进
 * `failed`，用真磁盘很难稳定复现（而且会依赖平台权限）。这里把溢出核心包一层，
 * 只让 `sweepSpillDir` 返回带 `failed` 的结果，其余导出原样交给真实实现；
 * 钉的是插件把失败条目拼成人话这段，不是扫描器本身。
 *
 * `DSC_HOME` 在动态 import 之前指到临时目录，收尾恢复；假 ctx 只实现 apply 碰到的面。
 *
 * @module @pneuma/spill/tests/w14-cleanup-partial.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-spill-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

/** 清理器返回的结果：一条删掉了、一条被占用。 */
const sweep = vi.hoisted(() => ({
  calls: 0,
  result: {
    removed: ['C:/spill/old.txt'],
    removedBytes: 2048,
    keptFiles: 2,
    keptBytes: 100,
    failed: [{ path: 'C:/spill/locked.txt', reason: 'EBUSY: resource busy or locked' }],
  },
}))

vi.mock('@pneuma/runtime/core/spill.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/spill.js')>()
  return {
    ...actual,
    sweepSpillDir: () => {
      sweep.calls += 1
      return sweep.result
    },
  }
})

const { spillPlugin } = await import('../index.js')

interface CapturedSection {
  id: string
  action: (name: string) => string | void
}

/** 假 ctx：只实现 apply 会碰的四个面，并收回注册出来的设置分区。 */
function fakeContext(): { ctx: unknown; captured: { section: CapturedSection } } {
  const captured = { section: undefined as unknown as CapturedSection }
  const ctx = {
    guards: { registerObserver: () => () => undefined },
    settings: {
      registerSection: (spec: CapturedSection) => {
        captured.section = spec
        return () => undefined
      },
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    transcript: { system: () => undefined },
    session: { current: () => ({ meta: { id: 'w14-partial' } }) },
  }
  return { ctx, captured }
}

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：临时目录留给系统清。
  }
})

test('清理按钮：有文件没删掉时把路径与原因逐条列出来，并报「部分完成」', () => {
  const mounted = fakeContext()
  spillPlugin.apply(mounted.ctx as never, { dir: join(HOME, 'spill') })
  const before = sweep.calls

  const text = mounted.captured.section.action('cleanup')
  expect(sweep.calls).toBe(before + 1)
  expect(String(text)).toContain('清掉 1 个')
  expect(String(text)).toContain('还剩 2 个')
  expect(String(text)).toContain('1 个没删掉')
  expect(String(text)).toContain('C:/spill/locked.txt（EBUSY: resource busy or locked）')
  // 成功的那一条不该被当成失败项列出来。
  expect(String(text)).not.toContain('C:/spill/old.txt')
})
