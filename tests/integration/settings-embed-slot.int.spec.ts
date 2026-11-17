/**
 * 「分区并进某一页」（设置注册契约的 `parent` 位）的集成用例
 * （迁自 `scripts/settings-embed-slot-test.mjs` 的第 [1]–[4] 与 [6] 段）。
 *
 * 用户要求：设置左导航里不再单列「终端环境」，内容并进「通用」页，交互一项不少。
 * 实现刻意**不在界面壳里写「如果是 terminal-env 就…」**：`tools-default` 在自己的分区
 * 声明里写 `parent: 'general'`，界面壳只按宿主给的声明把子分区整块画到父页末尾。
 *
 * 本文件钉宿主侧的那一半：分区仍然注册、`parent` 指向「通用」、导航按 `parent` 链过滤、
 * 读写与按钮动作仍按**子分区自己的 id** 走、切换之后检测结果真的跟着变，以及两份中英
 * 字典仍然键键对应。
 *
 * ## 没有搬的两类
 *
 * - 原第 [5] 段 11 条是 ui-settings / tools-default 的**源码文本断言**
 *   （`/['"]terminal-env['"]/.test(shell)` 这类）。按迁移手册第 2 节不搬：改个引号就假红、
 *   逻辑改坏但字面量还留着就假绿。原探针因此保留未删（覆盖不齐不删，D24）。
 * - 第 [5] 段里「界面壳按 parent 链滤掉子分区」的**规则**在本文件第 ② 组用数据验了
 *   （导航集合里没有子分区），但界面壳真的这么渲染要 ui 层才测得到，不是这一层的事。
 *
 * @module dsc/tests/integration/settings-embed-slot.int.spec
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type * as TerminalEnv from '@pneuma/runtime/core/terminal-env.js'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 仓库根：字典与真包清单都从这里读。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** 临时主目录；`DSC_HOME` 由它派生（注册表、检测缓存都落在这里）。 */
const home = tempHome('dsc-settings-embed-')

/** 设置分区视图里本文件用到的字段。 */
interface SectionView {
  id: string
  title: string
  subtitle?: string
  parent?: string
  builtin?: boolean
  custom?: boolean
  order?: number
  fields: Array<{
    type: string
    key?: string
    label?: string
    text?: string
    help?: string
    options?: Array<{ value: string; label: string }>
  }>
}

/** 内核里本文件用到的服务面：只声明用到的成员，不把整个 Context 类型拖进来。 */
interface SettingsSurface {
  sections(): SectionView[]
  values(id: string): Promise<Record<string, unknown>>
  save(id: string, key: string, value: unknown): Promise<{ ok: boolean; notice?: string }>
  action(id: string, name: string): Promise<{ ok: boolean; notice?: string }>
}

let llm: FakeLLM
let kernel: BootedKernel
let settings: SettingsSurface
let env: typeof TerminalEnv
/** ③ 第一条用例存下的那一档；第二条用例拿它算「当前：…」应该是哪一档。 */
let savedChoice = ''

/** 找某个分区。 */
function sectionOf(sections: SectionView[], id: string): SectionView | undefined {
  return sections.find((section) => section.id === id)
}

beforeAll(async () => {
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  settings = (kernel.ctx as unknown as { settings: SettingsSurface }).settings
  env = await import('@pneuma/runtime/core/terminal-env.js')
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('① 宿主侧：分区还在，但它并进了「通用」', () => {
  test('terminal-env 仍注册、仍 builtin、仍是通用表单', () => {
    const sections = settings.sections()
    const terminal = sectionOf(sections, 'terminal-env')
    expect(terminal, JSON.stringify(sections.map((section) => section.id))).toBeDefined()
    expect(terminal?.builtin).toBe(true)
    expect(terminal?.custom).toBe(false)
  })

  test('parent 指向 general，「通用」自己不在任何页里', () => {
    const sections = settings.sections()
    expect(sectionOf(sections, 'terminal-env')?.parent).toBe('general')
    expect(sectionOf(sections, 'general')?.parent).toBeUndefined()
  })

  test('order 没变（仍是 6，TUI 那边位次不动）', () => {
    expect(sectionOf(settings.sections(), 'terminal-env')?.order).toBe(6)
  })

  test('字段没缩水：下拉 + 检测结果 + 按钮', () => {
    const fields = sectionOf(settings.sections(), 'terminal-env')?.fields ?? []
    expect(fields.map((field) => field.type).join(',')).toBe('select,info,button')
  })
})

describe('② 导航规则：按 parent 链过滤，子分区不单列', () => {
  test('导航集合里没有 terminal-env，general 还在', () => {
    const nav = settings
      .sections()
      .filter((section) => section.parent === undefined)
      .map((section) => section.id)
    expect(nav).not.toContain('terminal-env')
    expect(nav).toContain('general')
  })
})

describe('③ 读写仍按子分区自己的 id 走，切换后检测结果跟着刷新', () => {
  test('保存带回执；回读的是刚存的那一档', async () => {
    const fields = sectionOf(settings.sections(), 'terminal-env')?.fields ?? []
    const options = fields.find((field) => field.type === 'select')?.options ?? []
    expect(options.length).toBeGreaterThan(1)
    const target = options.find((option) => option.value === 'gitbash')?.value ?? options[1]!.value

    const saved = await settings.save('terminal-env', 'bashShell', target)
    expect(saved.ok).toBe(true)
    expect(saved.notice ?? '').toContain('下一条命令起生效')

    const values = await settings.values('terminal-env')
    expect(values['bashShell']).toBe(target)
    savedChoice = target
  })

  test('右侧「当前：…」换成了新选的那一档，且不重复列表里的其它 shell', () => {
    expect(savedChoice).not.toBe('')
    const fields = sectionOf(settings.sections(), 'terminal-env')?.fields ?? []
    const info = fields.find((field) => field.type === 'info')
    const infoText = info?.text ?? ''
    const infoHelp = info?.help ?? ''
    const label = env.shellChoiceLabel(savedChoice as Parameters<typeof env.shellChoiceLabel>[0])
    const allLabels = env.detectShells().map((item) => item.label)

    // 整张可用性列表在说明里：每个候选一个 ✓/✗（条数按这台机器的真实候选数算，
    // 不写死 3 —— POSIX 上候选本来就少，写死只会在 Linux 上假红）。
    expect((infoHelp.match(/[✓✗]/g) ?? []).length).toBe(env.detectShells().length)
    expect(infoHelp).toContain(label)
    // 右栏只说「当前是哪一档」：不带 ✓/✗，也不复述其它 shell 名。
    expect(/[✓✗]/.test(infoText)).toBe(false)
    expect(infoText).toContain('当前：')
    expect(infoText).toContain(label)
    expect(allLabels.filter((name) => name !== label).every((name) => !infoText.includes(name))).toBe(true)
  })

  test('「重新检测」按钮仍按子分区 id 生效', async () => {
    const redetected = await settings.action('terminal-env', 'redetect')
    expect(redetected.ok).toBe(true)
    expect(redetected.notice ?? '').toContain('重新检测完成')
  })
})

describe('④ 中英字典：两侧键一一对应', () => {
  /** 读某个包的两份字典。 */
  function localesOf(pkg: string): { zh: Record<string, string>; en: Record<string, string> } {
    const read = (name: string): Record<string, string> =>
      JSON.parse(readFileSync(join(ROOT, 'src', 'packages', pkg, 'locale', name), 'utf8')) as Record<string, string>
    return { zh: read('ui.zh.json'), en: read('ui.en.json') }
  }

  test('tools-default 与 ui-settings 两侧键数相同且一一对应', () => {
    for (const pkg of ['tools-default', 'ui-settings']) {
      const { zh, en } = localesOf(pkg)
      const zhKeys = Object.keys(zh).sort()
      const enKeys = Object.keys(en).sort()
      expect(zhKeys, pkg).toEqual(enKeys)
    }
  })

  test('tools-default 的三条关键键中英都有且英文非空', () => {
    const { zh, en } = localesOf('tools-default')
    for (const key of ['section.shell.title', 'section.shell.subtitle', 'field.detected.currentValue']) {
      expect(typeof zh[key], key).toBe('string')
      expect(zh[key], key).not.toBe('')
      expect(typeof en[key], key).toBe('string')
      expect(en[key], key).not.toBe('')
    }
  })
})
