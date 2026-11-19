/**
 * approval 包级测试：插件对象 + 审批卡「将做的改动」的推演（纯函数，不碰内核）
 * + 判官输出解析（安全决策的闭集协议）。
 *
 * 旧文件有两条读 `index.ts` 源码文本的断言（三档权限 / 两档审阅者的 `id:` 字面量、
 * 等待时限常量与夹取表达式）。这两个符号都没有导出，唯一的公开接缝是 `apply()` 里的
 * `surface()`，起真内核只为读两个文案表不划算，所以按手册第 2 节**删掉文本断言、补行为用例**：
 * 「哪些工具能推演改动、文件不存在/old 对不上/多处匹配时给出什么状态」是这块代码真正的契约，
 * 也比「文件里有没有这串字符」值钱。用例 8 → 9，删掉的两条在提交正文里写明。
 *
 * @module @pneuma/approval/tests
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest } from '@pneuma/runtime/contract.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { approvalDiffOf, approvalPlugin, parseReviewOutput } from '../index.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsc-approval-spec-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 一次审批请求：推演只读 toolName / args / cwd。 */
const requestOf = (toolName: string, args: Record<string, unknown>, cwd = root): ApprovalRequest => ({
  toolName,
  argsSummary: '',
  args,
  cwd,
})

test('插件对象：名字、提供服务、五个注入、可 apply', () => {
  expect(approvalPlugin.name).toBe('approval')
  expect(approvalPlugin.provide).toBe('approval')
  expect([...(approvalPlugin.inject as string[])]).toEqual(['llm', 'session', 'guards', 'surfaces', 'waiting'])
  expect(typeof approvalPlugin.apply).toBe('function')
})

test('只给写类工具推演差异：只读与命令工具直接不给', async () => {
  for (const toolName of ['read', 'bash', 'glob', 'todo_write']) {
    expect(await approvalDiffOf(requestOf(toolName, { command: 'ls' })), toolName).toBeNull()
  }
})

test('write 到还不存在的文件：从空串起算，added 两条、标 fellBack', async () => {
  const view = await approvalDiffOf(requestOf('write', { path: 'new-dir/x.txt', content: 'a\nb\n' }))
  expect(view).not.toBeNull()
  expect(view?.status).toBe('added')
  expect(view?.fellBack).toBe(true)
  expect(view?.added).toBe(2)
})

test('write 覆盖已有文件：按真实差异算，不再走 fallback', async () => {
  const file = join(root, 'existing.txt')
  writeFileSync(file, 'a\nb\n', 'utf8')
  const view = await approvalDiffOf(requestOf('write', { path: file, content: 'a\nc\n' }))
  expect(view?.status).toBe('modified')
  expect(view?.fellBack).toBeUndefined()
  expect(view?.added).toBe(1)
  expect(view?.removed).toBe(1)
})

test('edit 的推演看 old 的命中情况：唯一命中才给真实差异，缺失/多处只报 mismatch', async () => {
  const unique = join(root, 'edit-unique.txt')
  writeFileSync(unique, 'a\nb\nc\n', 'utf8')
  const applied = await approvalDiffOf(requestOf('edit', { path: unique, old: 'b', new: 'B' }))
  expect(applied?.mismatch).toBeUndefined()
  expect(applied?.added).toBe(1)
  expect(applied?.removed).toBe(1)

  const missing = await approvalDiffOf(requestOf('edit', { path: unique, old: '不在文件里', new: 'x' }))
  expect(missing?.mismatch).toBe('missing')

  const ambiguous = join(root, 'edit-ambiguous.txt')
  writeFileSync(ambiguous, 'x\nx\n', 'utf8')
  const multiple = await approvalDiffOf(requestOf('edit', { path: ambiguous, old: 'x', new: 'y' }))
  expect(multiple?.mismatch).toBe('ambiguous')
})

test('ops 写类工具同一套推演：新建/删除/复制各自给出正确的 status', async () => {
  const source = join(root, 'copy-source.txt')
  writeFileSync(source, 'one\ntwo\n', 'utf8')

  const created = await approvalDiffOf(requestOf('ops_write_file', { path: join(root, 'ops-new.txt'), content: 'z\n' }))
  expect(created?.status).toBe('added')

  const removed = await approvalDiffOf(requestOf('ops_remove', { path: source }))
  expect(removed?.status).toBe('deleted')
  expect(removed?.removed).toBe(2)

  const copied = await approvalDiffOf(requestOf('ops_copy', { path: source, to: join(root, 'copy-target.txt') }))
  expect(copied?.status).toBe('added')
  expect(copied?.added).toBe(2)

  // 目标是目录 / 参数不齐 → 算不出来，卡片回到只有参数摘要的常态。
  expect(await approvalDiffOf(requestOf('ops_remove', {}))).toBeNull()
})

test('判官输出：四种合法形状原样落地', () => {
  const cases = [
    ['{"risk":"low","decision":"allow"}', { risk: 'low', decision: 'allow' }],
    ['{"risk":"medium","decision":"allow"}', { risk: 'medium', decision: 'allow' }],
    ['{"risk":"medium","decision":"deny"}', { risk: 'medium', decision: 'deny' }],
    ['{"risk":"high","decision":"deny","reason":"外泄"}', { risk: 'high', decision: 'deny', reason: '外泄' }],
  ] as const
  for (const [text, expected] of cases) expect(parseReviewOutput(text), text).toEqual(expected)
})

test('判官输出：自相矛盾的组合按保守解释落地', () => {
  expect(parseReviewOutput('{"risk":"low","decision":"deny"}')).toEqual({
    risk: 'medium',
    decision: 'deny',
    reason: '判官判了低风险却又否决，按否决处理',
  })
  const high = parseReviewOutput('{"risk":"high","decision":"allow"}')
  expect(high.risk).toBe('high')
  expect(high.decision).toBe('deny')
})

test('判官输出：越界形状一律算失败', () => {
  const cases = [
    ['{"risk":"low","decision":"allow","reason":"x"}', /只能有 risk 与 decision/],
    ['{"risk":"critical","decision":"deny"}', /未知风险档/],
    ['不是 JSON', /判官没有输出 JSON 对象/],
    ['{ 坏掉的 }', /不是合法 JSON/],
    ['{"risk":"high","risk":"low","decision":"allow"}', /重复字段/],
  ] as const
  for (const [text, reason] of cases) expect(() => parseReviewOutput(text), text).toThrow(reason)
})
