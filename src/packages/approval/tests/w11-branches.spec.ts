/**
 * approval 的补盲：审批卡「中文含义」的截断/包装词/操作数边界，以及改动推演在
 * 目录、源不可读、参数不齐时的降级（`packages/approval/call-meaning.ts` / `index.ts`）。
 *
 * 纯函数 + 临时文件，不挂插件、不碰 ~/.dsc。
 *
 * @module dsc/packages/approval/tests/w11-branches.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { ApprovalRequest } from '@pneuma/runtime/contract.js'
import { approvalDiffOf } from '../index.js'
import { callMeaning, commandMeaning } from '../call-meaning.js'

const root = mkdtempSync(join(tmpdir(), 'dsc-approval-w11-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const request = (toolName: string, args: Record<string, unknown>, cwd = root): ApprovalRequest => ({
  toolName,
  argsSummary: '',
  args,
  cwd,
})

describe('call-meaning 补盲', () => {
  test('长路径只有两段：保留原值，不做「…/最后两级」', () => {
    const target = `C:\\${'x'.repeat(40)}`
    expect(callMeaning({ toolName: 'write', target })).toContain(target)
  })

  test('长路径多于两段：只留最后两级', () => {
    const target = `C:\\a\\b\\c\\${'x'.repeat(40)}`
    const text = callMeaning({ toolName: 'write', target })
    expect(text).toContain('…/c/')
    expect(text).not.toContain('C:\\a')
  })

  test('git add 只有开关时没有目标；赋值前缀被跳过；只有包装词是空命令', () => {
    expect(commandMeaning('git add --all')).toBe('暂存改动')
    expect(commandMeaning('FOO=1 rm a.txt')).toBe('删除 a.txt')
    expect(commandMeaning('sudo')).toBe('空命令')
  })

  test('超过三个操作数只取前三个', () => {
    expect(commandMeaning('node a b c d e')).toBe('跑 Node 脚本 a')
  })
})

describe('approvalDiffOf 降级', () => {
  test('ops_replace 目标是目录：不做推演', async () => {
    const dir = join(root, 'a-dir')
    mkdirSync(dir, { recursive: true })
    expect(await approvalDiffOf(request('ops_replace', { path: dir, pattern: 'x', replacement: 'y' }))).toBeNull()
  })

  test('ops_copy 源是目录 / 目标已存在：都不给 diff', async () => {
    const dir = join(root, 'src-dir')
    mkdirSync(dir, { recursive: true })
    expect(await approvalDiffOf(request('ops_copy', { path: dir, to: join(root, 'out.txt') }))).toBeNull()

    const source = join(root, 'source.txt')
    const target = join(root, 'target.txt')
    writeFileSync(source, 's\n', 'utf8')
    writeFileSync(target, 't\n', 'utf8')
    expect(await approvalDiffOf(request('ops_copy', { path: source, to: target }))).toBeNull()
  })

  test('参数不齐：write 缺 content / edit 缺旧新 / ops_edit_file 空清单都回 null', async () => {
    expect(await approvalDiffOf(request('write', { path: join(root, 'x.txt') }))).toBeNull()
    expect(await approvalDiffOf(request('edit', { path: join(root, 'x.txt'), old: 'a' }))).toBeNull()
    expect(await approvalDiffOf(request('ops_edit_file', { path: join(root, 'x.txt'), edits: [] }))).toBeNull()
    expect(await approvalDiffOf(request('ops_edit_file', { path: join(root, 'x.txt'), edits: [{}] }))).toBeNull()
  })

  test('盘上读不到时 edit 用参数差异兜底并标 fellBack', async () => {
    const view = await approvalDiffOf(request('edit', { path: join(root, 'missing.txt'), old: '旧', new: '新' }))
    expect(view).toMatchObject({ fellBack: true })
    expect(view?.added).toBe(1)
  })
})
