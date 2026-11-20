/**
 * `tools-default/index.ts` 的三处设置分区边角（W14）。
 *
 * 补的缺口：
 *   - 预算分区的 `fields()` 从没被调过（294 行）——只有 `values()` 被调过；
 *   - 终端分区在「当前选择已不可用」时仍要把它塞进下拉（344-345 行），以及保存不可用档位时
 *     要拒绝并点名（386-387 行）；
 *   - 冷探测的预热定时器（417 行）：12 秒后自动探一次，本文件用假时钟把它拨快。
 *
 * 终端探测换成受控假件：真机上四档全都装着时，「不可用」那条分支永远走不到。
 *
 * @module dsc/packages/tools-default/tests/w14-index-sections
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsField, SettingsMutationOk } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14-index-'))
process.env['DSC_HOME'] = HOME
process.env['X'] = process.env['X']
mkdirSync(join(HOME, 'plugins'), { recursive: true })
writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')

// ── 受控的终端探测 / 当前选择 ────────────────────────────────────────────

const env = vi.hoisted(() => ({
  detectCalls: 0,
  unavailable: null as null | string,
}))

vi.mock('@pneuma/runtime/core/terminal-env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/terminal-env.js')>()
  return {
    ...actual,
    shellsCached: () => false,
    forgetShellDetection: () => {},
    detectShells: () => {
      env.detectCalls += 1
      const unavailable = env.unavailable
      return [
        {
          value: 'auto',
          label: '跟随平台默认',
          available: true,
          detail: 'auto',
        },
        {
          value: 'pwsh',
          label: 'PowerShell 7',
          available: unavailable !== 'pwsh',
          detail: 'pwsh.exe',
        },
      ]
    },
    readShellChoice: () => env.unavailable ?? 'auto',
  }
})

type IndexModule = typeof import('../index.js')
let toolsDefaultPlugin: IndexModule['toolsDefaultPlugin']

const cleanups: Array<() => void> = []

function mount(): { sections: SettingsSectionSpec[]; cleanup: () => void } {
  const sections: SettingsSectionSpec[] = []
  const off = () => {}
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : off
    },
    on() {
      return off
    },
    emit() {},
    tools: {
      register() {
        return off
      },
    },
    surfaces: {
      register() {
        return off
      },
    },
    settings: {
      registerSection(section: SettingsSectionSpec) {
        sections.push(section)
        return off
      },
    },
    provide() {},
    session: {
      current: () => ({
        meta: { id: 's1', cwd: HOME },
        filePath: join(HOME, 's.jsonl'),
        messages: [],
        state: () => undefined,
        appendState: () => {},
        appendNote: () => {},
      }),
    },
    agent: { followup() {} },
    get() {
      return undefined
    },
  }
  const cleanup = toolsDefaultPlugin.apply?.(ctx as never, undefined)
  const dispose = typeof cleanup === 'function' ? (cleanup as () => void) : () => {}
  cleanups.push(dispose)
  return { sections, cleanup: dispose }
}

const sectionOf = (sections: SettingsSectionSpec[], id: string): SettingsSectionSpec => {
  const hit = sections.find((section) => section.id === id)
  if (hit === undefined) throw new Error(`没有注册设置分区 ${id}`)
  return hit
}

afterEach(() => {
  env.unavailable = null
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      /* 已收 */
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

describe('设置分区：fields() 与不可用档位', () => {
  test('预算分区的 fields() 能返回四个字段', async () => {
    const { toolsDefaultPlugin: plugin } = await import('../index.js')
    toolsDefaultPlugin = plugin
    const harness = mount()
    const fields = sectionOf(harness.sections, 'tools-default').fields() as SettingsField[]
    expect(fields.map((field) => ('key' in field ? field.key : ''))).toEqual([
      'bashTimeoutMs',
      'bashMaxTimeoutMs',
      'bashOutputChars',
      'readLineLimit',
    ])
  }, 30_000)

  test('当前选择的终端已不可用：仍出现在下拉里（标注为缺失），保存被拒并点名', async () => {
    const { toolsDefaultPlugin: plugin } = await import('../index.js')
    toolsDefaultPlugin = plugin
    env.unavailable = 'pwsh'
    const harness = mount()
    const section = sectionOf(harness.sections, 'terminal-env')
    const fields = section.fields() as SettingsField[]
    const select = fields.find((field) => 'key' in field && field.key === 'bashShell') as
      { type: string; options?: Array<{ value: string }> } | undefined
    // 不可用的 pwsh 也要在下拉里，否则界面显示成第一项、用户以为已经改掉了。
    expect(select?.options?.some((option) => option.value === 'pwsh')).toBe(true)

    const save = section.save as (key: string, value: unknown) => string | SettingsMutationOk | void
    expect(String(save('bashShell', 'pwsh'))).toContain('没检测到')
  }, 30_000)

  test('冷探测：apply 后 12 秒的预热定时器会触发一次 detectShells', async () => {
    const { toolsDefaultPlugin: plugin } = await import('../index.js')
    toolsDefaultPlugin = plugin
    vi.useFakeTimers()
    env.detectCalls = 0
    const harness = mount()
    expect(env.detectCalls).toBe(0)
    vi.advanceTimersByTime(12_500)
    expect(env.detectCalls).toBeGreaterThan(0)
    harness.cleanup()
  }, 30_000)
})
