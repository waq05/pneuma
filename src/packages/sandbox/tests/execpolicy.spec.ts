/**
 * 命令围栏（`src/packages/sandbox/execpolicy.ts`）：机器级改动 forbidden、网络开关、写目标、前缀规则。
 *
 * 这一层只答「沙箱同不同意」，不管审批卡；所以 allow 的用例只证明规则命中，不证明免审批。
 * 用 `win32: true` 固定平台分支，避免测试跟着开发机平台走。
 *
 * @module dsc/packages/sandbox/tests/execpolicy.spec
 */
import { describe, expect, test } from 'vitest'
import type { PathCheck } from '../policy.js'
import { BUILTIN_EXEC_RULES, evaluateCommand } from '../execpolicy.js'

/** 默认：写目标都在可写根内、网络关。 */
function options(overrides: Partial<{ networkAccess: boolean; checkWrite: (raw: string) => PathCheck }> = {}) {
  return {
    networkAccess: false,
    checkWrite: (): PathCheck => ({ allowed: true, rule: 'inside-root', reason: '在可写根内' }),
    win32: true,
    ...overrides,
  }
}

describe('forbidden：机器级改动面', () => {
  test('计划任务 / 注册表 / 防火墙 / 引导 / 所有权 / 分区 / 卷影 / 备份', () => {
    const cases = [
      'schtasks /create /tn x /tr calc',
      'reg add HKCU\\Software\\X /v y /d z',
      'reg delete HKCU\\Software\\X /f',
      'reg import evil.reg',
      'netsh advfirewall set allprofiles state off',
      'bcdedit /set safeboot minimal',
      'takeown /f C:\\Windows\\System32',
      'diskpart /s script.txt',
      'vssadmin delete shadows /all',
      'wbadmin delete catalog',
      'bootrec /fixmbr',
    ]
    for (const command of cases) {
      const verdict = evaluateCommand(command, options())
      expect(verdict.decision, command).toBe('forbidden')
      expect(verdict.reason, command).toContain('禁止这一段')
    }
  })

  test('icacls：只有带 /grant 这类参数才 forbidden，只读查询走 prompt', () => {
    expect(evaluateCommand('icacls C:\\data /grant Everyone:F', options()).decision).toBe('forbidden')
    expect(evaluateCommand('icacls C:\\data', options()).decision).toBe('prompt')
  })

  test('多段命令里只要一段 forbidden 就整体 forbidden', () => {
    const verdict = evaluateCommand('git status && schtasks /query', options())
    expect(verdict).toMatchObject({ decision: 'forbidden', rule: 'schtasks' })
  })

  test('可执行后缀（schtasks.exe）也认', () => {
    expect(evaluateCommand('schtasks.exe /query', options()).decision).toBe('forbidden')
  })

  test('内层脚本会拆开再判（cmd /c）', () => {
    const verdict = evaluateCommand('cmd /c "schtasks /create /tn x /tr calc"', options())
    expect(verdict.decision).toBe('forbidden')
  })
})

describe('网络开关', () => {
  test('关网时联网命令 forbidden，并指明「先打开网络开关」', () => {
    const verdict = evaluateCommand('curl https://example.com', options({ networkAccess: false }))
    expect(verdict).toMatchObject({ decision: 'forbidden', rule: 'network-off', network: true })
    expect(verdict.reason).toContain('网络开关是关的')
  })

  test('开网时不再 forbidden；没命中放行规则就是 prompt', () => {
    const verdict = evaluateCommand('curl https://example.com', options({ networkAccess: true }))
    expect(verdict.decision).toBe('prompt')
    expect(verdict.network).toBe(true)
  })
})

describe('写目标', () => {
  test('写目标越界：forbidden write-target，并把目标带出来', () => {
    const verdict = evaluateCommand(
      'echo hi > out.txt',
      options({
        checkWrite: (raw) =>
          raw.endsWith('out.txt')
            ? { allowed: false, rule: 'inside-root', reason: '不在可写根里' }
            : { allowed: true, rule: 'inside-root', reason: 'ok' },
      }),
    )
    expect(verdict.decision).toBe('forbidden')
    expect(verdict.rule).toBe('write-target:inside-root')
    expect(verdict.writeTargets.length).toBeGreaterThan(0)
  })

  test('写目标在根内：不因写而 forbidden（命令本身没命中放行规则 → prompt）', () => {
    const verdict = evaluateCommand('echo hi > out.txt', options())
    expect(verdict.decision).toBe('prompt')
    expect(verdict.writeTargets.length).toBeGreaterThan(0)
  })
})

describe('allow 规则', () => {
  test('只读/构建前缀命中 allow；未命中 prompt', () => {
    for (const command of ['git status', 'git diff HEAD', 'git log --oneline', 'ls -la', 'dir /b', 'pnpm run build', 'pnpm test']) {
      expect(evaluateCommand(command, options()).decision, command).toBe('allow')
    }
    expect(evaluateCommand('rm -rf build', options()).decision).toBe('prompt')
  })

  test('prompt 的理由列出未命中放行规则的段（最多三段）', () => {
    const verdict = evaluateCommand('foo && bar && baz && qux', options())
    expect(verdict.decision).toBe('prompt')
    expect(verdict.reason).toContain('foo')
    expect(verdict.reason).toContain('baz')
    expect(verdict.reason).not.toContain('qux')
  })
})

describe('自定义规则表', () => {
  test('传 rules 时不再看内置表', () => {
    const verdict = evaluateCommand('git status', { ...options(), rules: [] })
    expect(verdict.decision).toBe('prompt')
    // 内置表仍然导出（给插件与自检对号入座）。
    expect(BUILTIN_EXEC_RULES.some((rule) => rule.name === 'schtasks')).toBe(true)
  })
})
