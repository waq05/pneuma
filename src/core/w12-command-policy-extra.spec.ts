/**
 * 命令审批策略（`core/command-policy.ts`）的规则文件自检与只读判定补齐：
 * 规则文件里的坏条目、match/notMatch 自检、同前缀规则去重、自毁提示、
 * python 只读白名单。
 *
 * @module dsc/core/w12-command-policy-extra.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { appendRule, classifyCommand, readRules, splitSegments } from './command-policy.js'

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** 写一份规则文件并读回来。 */
function readFreshFile(rules: unknown[]): ReturnType<typeof readRules> {
  dir = mkdtempSync(join(tmpdir(), 'dsc-w12-policy-'))
  const file = join(dir, 'policy.rules')
  writeFileSync(file, JSON.stringify({ rules }), 'utf8')
  return readRules(file)
}

describe('readRules 的加载期自检', () => {
  test('坏条目逐条记问题并跳过：不是对象 / 缺 pattern / decision 不认识', () => {
    const loaded = readFreshFile([
      null,
      { decision: 'allow' },
      { pattern: ['git'], decision: 'maybe' },
      { pattern: ['git', 'status'], decision: 'allow' },
    ])
    expect(loaded.rules).toHaveLength(1)
    expect(loaded.rules[0]!.pattern).toEqual(['git', 'status'])
    expect(loaded.problems).toHaveLength(3)
    expect(loaded.problems[0]).toContain('不是对象')
    expect(loaded.problems[1]).toContain('缺 pattern')
    expect(loaded.problems[2]).toContain('decision 只能是')
  })

  test('match 例子没命中 / notMatch 例子却命中，都记成问题', () => {
    const loaded = readFreshFile([
      { pattern: ['git', 'status'], decision: 'allow', match: ['git status'], notMatch: ['git status'] },
      { pattern: ['git', 'push'], decision: 'deny', match: ['git status'] },
    ])
    expect(loaded.problems.some((problem) => problem.includes('match 例子没命中'))).toBe(true)
    expect(loaded.problems.some((problem) => problem.includes('notMatch 例子却命中了'))).toBe(true)
  })

  test('规则文件不是合法 JSON：整份忽略但仍报问题', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsc-w12-policy-'))
    const file = join(dir, 'policy.rules')
    writeFileSync(file, '{不是 JSON', 'utf8')
    const loaded = readRules(file)
    expect(loaded.rules).toEqual([])
    expect(loaded.problems[0]).toContain('不是合法 JSON')
  })
})

describe('appendRule 去重', () => {
  test('同 pattern + 同 decision 覆盖原条目而不是追加', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsc-w12-policy-'))
    const file = join(dir, 'policy.rules')
    appendRule({ pattern: ['rm'], decision: 'ask', justification: '第一版' }, file)
    appendRule({ pattern: ['rm'], decision: 'ask', justification: '第二版' }, file)
    appendRule({ pattern: ['rm'], decision: 'deny', justification: '更严' }, file)
    const loaded = readRules(file)
    expect(loaded.rules).toHaveLength(2)
    expect(loaded.rules.find((rule) => rule.decision === 'ask')!.justification).toBe('第二版')
    expect(loaded.rules.find((rule) => rule.decision === 'deny')).toBeDefined()
  })
})

describe('classifyCommand 的边角', () => {
  test('命令里出现 dsc 自己的程序路径：至少抬到 ask 并说明原因', () => {
    const verdict = classifyCommand('ls /opt/pneuma/bin/node', { selfPaths: ['/opt/pneuma/bin/node'] })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('dsc 自己的程序文件')
    // 空路径不参与匹配
    expect(classifyCommand('ls', { selfPaths: [''] }).decision).toBe('allow')
  })

  test('python 只有 -m pytest/unittest/json.tool 才算只读', () => {
    expect(classifyCommand('python -m pytest tests/').decision).toBe('allow')
    expect(classifyCommand('python -m unittest').decision).toBe('allow')
    expect(classifyCommand('python -c "print(1)"').decision).toBe('ask')
    expect(classifyCommand('python script.py').decision).toBe('ask')
    expect(classifyCommand('python -m http.server').decision).toBe('ask')
  })

  test('建议前缀：三词命令给出可持久化前缀；单段多命令不给建议', () => {
    expect(classifyCommand('git status').prefixRule).toEqual(['git', 'status'])
    expect(classifyCommand('pnpm run build').prefixRule).toEqual(['pnpm', 'run', 'build'])
    expect(splitSegments('ls && rm x')).toHaveLength(2)
    expect(classifyCommand('ls    &&    git status').prefixRule).toBeNull()
  })
})
