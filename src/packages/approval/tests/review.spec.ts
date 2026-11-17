/**
 * 审批插件的纯判定面（`packages/approval/index.ts`）：判官 JSON 的收口、改动前预览的 diff 推演。
 *
 * 卡片渲染与审批队列归 integration；这里用临时文件钉「哪些回答算合法」「推演失败时卡片怎么退化」。
 *
 * @module dsc/packages/approval/tests/review.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { approvalDiffOf, parseReviewOutput } from '../index.js'

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function workdir(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsc-approval-'))
  return dir
}

/** 造一个审批请求（只填 diff 推演用到的字段）。 */
function request(toolName: string, args: Record<string, unknown>, cwd = ''): never {
  return { toolName, args, cwd } as never
}

describe('parseReviewOutput：判官回答的收口', () => {
  test('allow 只带 risk/decision；high + allow 按否决处理', () => {
    expect(parseReviewOutput('{"risk":"low","decision":"allow"}')).toEqual({ risk: 'low', decision: 'allow' })
    expect(parseReviewOutput('前缀 ```json\n{"risk":"high","decision":"allow"}\n```')).toMatchObject({
      risk: 'high',
      decision: 'deny',
    })
  })

  test('deny 可带 reason；low + deny 抬成 medium 并改写理由', () => {
    expect(parseReviewOutput('{"risk":"medium","decision":"deny","reason":"会删库"}')).toEqual({
      risk: 'medium',
      decision: 'deny',
      reason: '会删库',
    })
    expect(parseReviewOutput('{"risk":"low","decision":"deny","reason":"x"}')).toMatchObject({
      risk: 'medium',
      decision: 'deny',
      reason: expect.stringContaining('按否决处理'),
    })
  })

  test('形状不对逐条拒绝：没 JSON / 坏 JSON / 数组 / 重复字段 / 未知档 / 多余字段 / 坏理由', () => {
    expect(() => parseReviewOutput('没有对象')).toThrow(/没有输出 JSON 对象/)
    expect(() => parseReviewOutput('{bad}')).toThrow(/不是合法 JSON/)
    expect(() => parseReviewOutput('[1,2]')).toThrow(/没有输出 JSON 对象/)
    expect(() => parseReviewOutput('{"risk":"low","risk":"low","decision":"allow"}')).toThrow(/重复字段/)
    expect(() => parseReviewOutput('{"risk":"weird","decision":"allow"}')).toThrow(/未知风险档/)
    expect(() => parseReviewOutput('{"risk":"low","decision":"allow","reason":"x"}')).toThrow(/只能有 risk 与 decision/)
    expect(() => parseReviewOutput('{"risk":"medium","decision":"deny","reason":1}')).toThrow(/理由必须是字符串/)
    expect(() => parseReviewOutput('{"risk":"medium","decision":"maybe"}')).toThrow(/未知结论/)
  })
})

describe('approvalDiffOf：改动前预览的推演', () => {
  test('不在预览清单里的工具：不推演', async () => {
    const cwd = workdir()
    expect(await approvalDiffOf(request('bash', { command: 'ls' }, cwd))).toBeNull()
  })

  test('write：盘上没有标 fellBack，有就给正常 diff', async () => {
    const cwd = workdir()
    const path = join(cwd, 'a.txt')
    const created = await approvalDiffOf(request('write', { path, content: 'hello' }, cwd))
    expect(created).toMatchObject({ path, fellBack: true })
    expect(created!.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n')).toContain('hello')

    writeFileSync(path, 'old\n', 'utf8')
    const replaced = await approvalDiffOf(request('write', { path, content: 'new\n' }, cwd))
    expect(replaced).toMatchObject({ path })
    expect(replaced).not.toHaveProperty('fellBack')
    expect(replaced!.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n')).toContain('new')
  })

  test('write 缺 content / 目标路径不绝对且没有 cwd：给 null', async () => {
    const cwd = workdir()
    expect(await approvalDiffOf(request('write', { path: join(cwd, 'a.txt') }, cwd))).toBeNull()
    expect(await approvalDiffOf(request('write', { path: 'rel.txt', content: 'x' }))).toBeNull()
  })

  test('edit：唯一命中给改写后的 diff；没命中/多处分别标 missing/ambiguous；盘上读不到标 fellBack', async () => {
    const cwd = workdir()
    const path = join(cwd, 'a.ts')
    writeFileSync(path, 'const a = 1\nconst b = 2\n', 'utf8')

    const ok = await approvalDiffOf(request('edit', { path, old: 'const a = 1', new: 'const a = 42' }, cwd))
    expect(ok!.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n')).toContain('const a = 42')

    expect(await approvalDiffOf(request('edit', { path, old: 'nope', new: 'x' }, cwd))).toMatchObject({ mismatch: 'missing' })

    writeFileSync(path, 'dup\ndup\n', 'utf8')
    expect(await approvalDiffOf(request('edit', { path, old: 'dup', new: 'x' }, cwd))).toMatchObject({ mismatch: 'ambiguous' })

    const missing = join(cwd, 'none.ts')
    expect(await approvalDiffOf(request('edit', { path: missing, old: 'a', new: 'b' }, cwd))).toMatchObject({ fellBack: true })
  })

  test('ops_edit_file：多处编辑一次推演；空清单 / 空 oldText / 对不上各有结论', async () => {
    const cwd = workdir()
    const path = join(cwd, 'b.ts')
    writeFileSync(path, 'one\ntwo\n', 'utf8')

    const ok = await approvalDiffOf(
      request('ops_edit_file', { path, edits: [{ oldText: 'one', newText: '1' }, { oldText: 'two', newText: '2' }] }, cwd),
    )
    const text = ok!.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n')
    expect(text).toContain('1')
    expect(text).toContain('2')

    expect(await approvalDiffOf(request('ops_edit_file', { path, edits: [] }, cwd))).toBeNull()
    expect(await approvalDiffOf(request('ops_edit_file', { path, edits: [{ oldText: '', newText: 'x' }] }, cwd))).toBeNull()
    expect(
      await approvalDiffOf(request('ops_edit_file', { path, edits: [{ oldText: 'zzz', newText: 'x' }] }, cwd)),
    ).toMatchObject({ mismatch: 'missing' })
  })

  test('ops_copy / ops_move：目标是 to；源读不到或目标已存在都给 null', async () => {
    const cwd = workdir()
    const source = join(cwd, 'src.txt')
    const target = join(cwd, 'dst.txt')
    writeFileSync(source, 'bytes\n', 'utf8')

    expect(await approvalDiffOf(request('ops_copy', { path: source, to: target }, cwd))).toMatchObject({
      path: target,
      status: 'added',
    })
    writeFileSync(target, 'exists\n', 'utf8')
    expect(await approvalDiffOf(request('ops_move', { path: source, to: target }, cwd))).toBeNull()
    expect(await approvalDiffOf(request('ops_copy', { path: join(cwd, 'nope'), to: join(cwd, 'x') }, cwd))).toBeNull()
    expect(await approvalDiffOf(request('ops_copy', { path: source }, cwd))).toBeNull()
  })

  test('ops_remove：整篇删除；文件不在给 null', async () => {
    const cwd = workdir()
    const path = join(cwd, 'gone.txt')
    writeFileSync(path, 'bye\n', 'utf8')
    expect(await approvalDiffOf(request('ops_remove', { path }, cwd))).toMatchObject({ status: 'deleted' })
    expect(await approvalDiffOf(request('ops_remove', { path: join(cwd, 'none') }, cwd))).toBeNull()
  })

  test('ops_replace：全文替换；空 pattern / 非文件 / 文件不在都给 null', async () => {
    const cwd = workdir()
    const path = join(cwd, 'c.txt')
    writeFileSync(path, 'a a a', 'utf8')
    const replaced = await approvalDiffOf(request('ops_replace', { path, pattern: 'a', replacement: 'b' }, cwd))
    expect(replaced!.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n')).toContain('b b b')

    expect(await approvalDiffOf(request('ops_replace', { path, pattern: '', replacement: 'x' }, cwd))).toBeNull()
    const sub = join(cwd, 'sub')
    mkdirSync(sub)
    expect(await approvalDiffOf(request('ops_replace', { path: sub, pattern: 'x', replacement: 'y' }, cwd))).toBeNull()
  })
})
