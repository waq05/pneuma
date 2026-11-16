/**
 * 改动前预览（`src/packages/sandbox/review.ts`）：配置夹取、路径显示、diff 素材、渲染与守卫。
 *
 * 守卫链上的预览只做观察、恒 defer（pass 会跳过后面的审批卡），所以这里既钉「算出来的 diff
 * 对不对」，也钉「算不出来时只给一句说明、绝不抛错」——预览失败没有资格拦下一次写。
 *
 * 所有文件都在临时目录里，不碰真实 HOME。
 *
 * @module dsc/packages/sandbox/tests/review.spec
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import type { ToolGuardInput } from '../../../core/tool-guards.js'
import {
  buildPreview,
  createReviewGuard,
  displayPathOf,
  parseReviewConfig,
  readReviewConfig,
  renderReview,
  REVIEW_DEFAULTS,
  REVIEW_RANGES,
} from '../review.js'

let dir = ''

function guardInput(overrides: Partial<ToolGuardInput> = {}): ToolGuardInput {
  return {
    toolName: 'write',
    risk: 'write',
    cwd: dir,
    args: { path: join(dir, 'a.txt'), content: 'new\n' },
    target: join(dir, 'a.txt'),
    signal: new AbortController().signal,
    sessionId: 's1',
    sessionPath: '/sessions/s1.jsonl',
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-review-spec-'))
})

describe('parseReviewConfig / readReviewConfig', () => {
  test('缺省值与区间夹取：越界/类型错都落回缺省', () => {
    expect(parseReviewConfig({})).toEqual({
      enabled: REVIEW_DEFAULTS.enabled,
      maxLines: REVIEW_DEFAULTS.maxLines,
      contextLines: REVIEW_DEFAULTS.contextLines,
    })
    // 只有显式 false 才算关。
    expect(parseReviewConfig({ enabled: false }).enabled).toBe(false)
    expect(parseReviewConfig({ enabled: 'no' }).enabled).toBe(true)

    expect(parseReviewConfig({ maxLines: 1 }).maxLines).toBe(REVIEW_RANGES.maxLines.min)
    expect(parseReviewConfig({ maxLines: 99_999 }).maxLines).toBe(REVIEW_RANGES.maxLines.max)
    expect(parseReviewConfig({ maxLines: 'abc' }).maxLines).toBe(REVIEW_DEFAULTS.maxLines)
    expect(parseReviewConfig({ contextLines: -1 }).contextLines).toBe(REVIEW_RANGES.contextLines.min)
    expect(parseReviewConfig({ contextLines: 99 }).contextLines).toBe(REVIEW_RANGES.contextLines.max)
  })

  test('readReviewConfig 能从传入的沙箱配置里读', () => {
    expect(readReviewConfig({ enabled: false, maxLines: 30, contextLines: 1 })).toEqual({
      enabled: false,
      maxLines: 30,
      contextLines: 1,
    })
  })
})

describe('displayPathOf', () => {
  test('工作目录内给相对路径；外面保持绝对；分隔符统一成 /', () => {
    expect(displayPathOf(dir, join(dir, 'sub', 'a.txt'))).toBe('sub/a.txt')
    const outside = join(tmpdir(), 'elsewhere', 'b.txt')
    expect(displayPathOf(dir, outside)).toBe(outside.replace(/\\/g, '/'))
    // 同一路径（rel 为空）按绝对路径显示，不返回空串。
    expect(displayPathOf(dir, dir)).toBe(dir.replace(/\\/g, '/'))
  })
})

describe('buildPreview：素材', () => {
  const config = { enabled: true, maxLines: 120, contextLines: 3 }

  test('不管的工具与缺参数：返回 null', () => {
    expect(buildPreview(guardInput({ toolName: 'read' }), config)).toBeNull()
    expect(buildPreview(guardInput({ toolName: 'bash' }), config)).toBeNull()
    expect(
      buildPreview(guardInput({ args: { content: 'x' }, target: undefined }), config),
    ).toBeNull()
  })

  test('新建文件：action=create，整篇都算新增', () => {
    const preview = buildPreview(guardInput({ args: { path: join(dir, 'new.txt'), content: 'a\nb\n' } }), config)
    expect(preview).toMatchObject({ action: 'create', added: 2, removed: 0, beforeLines: 0, afterLines: 2 })
    expect(preview?.summary).toContain('新建')
    expect(preview?.summary).toContain('+2 -0')
  })

  test('修改文件：新旧 diff 与行数对得上', () => {
    const path = join(dir, 'old.txt')
    writeFileSync(path, 'one\ntwo\nthree\n', 'utf8')
    const preview = buildPreview(
      guardInput({ args: { path, content: 'one\nTWO\nthree\n' }, target: path }),
      config,
    )
    expect(preview).toMatchObject({ action: 'update', added: 1, removed: 1, beforeLines: 3, afterLines: 3 })
    expect(preview?.summary).toContain('修改')
    expect(preview?.summary).toContain('+1 -1')
  })

  test('edit：old 唯一命中才算得出改动', () => {
    const path = join(dir, 'edit.txt')
    writeFileSync(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const preview = buildPreview(
      guardInput({ toolName: 'edit', args: { path, old: 'beta', new: 'BETA' }, target: path }),
      config,
    )
    expect(preview?.after).toBe('alpha\nBETA\ngamma\n')
    expect(preview?.added).toBe(1)
    expect(preview?.removed).toBe(1)
  })

  test('edit：old 找不到 / 匹配多处 / 文件不存在都只给说明', () => {
    const path = join(dir, 'edit.txt')
    writeFileSync(path, 'dup dup\n', 'utf8')
    const missing = buildPreview(
      guardInput({ toolName: 'edit', args: { path, old: 'nope', new: 'x' }, target: path }),
      config,
    )
    expect(missing?.diff.ok).toBe(false)
    expect(missing?.summary).toContain('找不到')

    const ambiguous = buildPreview(
      guardInput({ toolName: 'edit', args: { path, old: 'dup', new: 'x' }, target: path }),
      config,
    )
    expect(ambiguous?.summary).toContain('多处')

    const absent = buildPreview(
      guardInput({ toolName: 'edit', args: { path: join(dir, 'absent.txt'), old: 'a', new: 'b' } }),
      config,
    )
    expect(absent).toBeNull()
  })

  test('读禁路径（.env）：不把旧内容贴出来，只给说明', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SECRET=1\n', 'utf8')
    const preview = buildPreview(guardInput({ args: { path, content: 'SECRET=2\n' }, target: path }), config)
    expect(preview?.diff.ok).toBe(false)
    expect(preview?.summary).toContain('读禁规则')
    expect(preview?.before).toBe('')
    expect(preview?.after).toBe('')
  })

  test('二进制文件：不做逐行 diff', () => {
    const path = join(dir, 'blob.bin')
    writeFileSync(path, Buffer.from([0, 1, 2, 3, 65, 66]))
    const preview = buildPreview(guardInput({ args: { path, content: 'x' }, target: path }), config)
    expect(preview?.summary).toContain('二进制')
  })
})

describe('renderReview：文本与截断', () => {
  test('头部写清动作与计数；正文含 hunk', () => {
    const path = join(dir, 'r.txt')
    writeFileSync(path, 'a\nb\nc\n', 'utf8')
    const preview = buildPreview(guardInput({ args: { path, content: 'a\nB\nc\n' }, target: path }), {
      enabled: true,
      maxLines: 120,
      contextLines: 1,
    })!
    const rendered = renderReview(preview, { enabled: true, maxLines: 120, contextLines: 1 })
    expect(rendered.text).toContain('【改动前预览·尚未落盘】')
    expect(rendered.text).toContain('+1 行 / -1 行')
    expect(rendered.text).toContain('@@')
    expect(rendered.omitted).toBe(0)
  })

  test('内容没变：明说这次写入不改任何一行', () => {
    const path = join(dir, 'same.txt')
    writeFileSync(path, 'same\n', 'utf8')
    const preview = buildPreview(guardInput({ args: { path, content: 'same\n' }, target: path }), {
      enabled: true,
      maxLines: 120,
      contextLines: 3,
    })!
    const rendered = renderReview(preview, { enabled: true, maxLines: 120, contextLines: 3 })
    expect(rendered.text).toContain('不会改动任何一行')
  })

  test('maxLines 截断：写清还剩多少行；extra note 追加在末尾', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line${String(index)}`).join('\n') + '\n'
    const path = join(dir, 'big.txt')
    writeFileSync(path, lines, 'utf8')
    const preview = buildPreview(
      guardInput({ args: { path, content: lines.replace(/line(\d+)/g, 'LINE$1') }, target: path }),
      { enabled: true, maxLines: 5, contextLines: 0 },
    )!
    const rendered = renderReview(preview, { enabled: true, maxLines: 5, contextLines: 0 }, '审批策略：仅查看')
    expect(rendered.shown).toBe(5)
    expect(rendered.omitted).toBeGreaterThan(0)
    expect(rendered.text).toContain(`还有 ${String(rendered.omitted)} 行未显示`)
    expect(rendered.text).toContain('审批策略：仅查看')
  })
})

describe('createReviewGuard', () => {
  test('恒 defer；发预览并计数；关掉后不读文件也不发', () => {
    const path = join(dir, 'g.txt')
    writeFileSync(path, 'old\n', 'utf8')
    const emitted: Array<{ text: string; sessionPath: string }> = []
    let enabled = true
    const handle = createReviewGuard({
      config: () => ({ enabled, maxLines: 120, contextLines: 3 }),
      emit: (text, sessionPath) => emitted.push({ text, sessionPath }),
    })

    const verdict = handle.guard.decide(
      guardInput({ args: { path, content: 'new\n' }, target: path, sessionPath: '/sessions/x.jsonl' }),
    )
    expect(verdict).toEqual({ action: 'defer' })
    expect(handle.guard.id).toBe('file-review')
    expect(handle.guard.order).toBe(25)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.sessionPath).toBe('/sessions/x.jsonl')
    expect(emitted[0]?.text).toContain('改动前预览')
    expect(handle.stats()).toMatchObject({ emitted: 1, truncated: 0 })
    expect(handle.stats().recent[0]).toContain('修改')

    enabled = false
    expect(handle.guard.decide(guardInput({ args: { path, content: 'x' }, target: path }))).toEqual({ action: 'defer' })
    expect(emitted).toHaveLength(1)

    handle.reset()
    expect(handle.stats()).toMatchObject({ emitted: 0, truncated: 0, recent: [] })
  })

  test('只读工具不预览；预览抛错被吞掉并留一句提示', () => {
    const emitted: string[] = []
    const handle = createReviewGuard({
      config: () => ({ enabled: true, maxLines: 120, contextLines: 3 }),
      emit: (text) => emitted.push(text),
    })
    expect(handle.guard.decide(guardInput({ risk: 'read' }))).toEqual({ action: 'defer' })
    expect(emitted).toHaveLength(0)

    // 预览自己抛错（这里是 toolName getter）要被守卫吞掉，只留一句提示。
    const bad = guardInput()
    Object.defineProperty(bad, 'toolName', {
      get() {
        throw new Error('preview boom')
      },
    })
    expect(handle.guard.decide(bad)).toEqual({ action: 'defer' })
    expect(emitted.some((text) => text.includes('不影响这次调用'))).toBe(true)
  })
})
