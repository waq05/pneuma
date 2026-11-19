/**
 * 「设置 → 终端环境」这张分区的端到端探针（integration 层，原 `scripts/terminal-env-settings-test.mjs`）。
 *
 * `tests/integration/terminal-env.int.spec.ts` 验的是探测与执行计划（纯函数 + 子进程），
 * 这一个验的是**用户从界面上能看见、能改**：分区有没有进设置页、下拉里摆的是不是真的探到的、
 * 存下去有没有落到 `plugins.json`、存坏值会不会被拒。
 *
 * ## 为什么真起内核
 *
 * 这张分区是插件（tools-default）注册的，`builtin` 的判定、字段投影、保存链路都在内核
 * 装配之后才成立。只测纯函数等于没测「用户点得到吗」。
 *
 * ## 跑了什么、没跑什么
 *
 * 探针第 [4] 节末尾有一条 `env.shellFlavor(target) === env.shellFlavor(target)`——同一个
 * 函数用同一个参数调两次比较，恒真，没有信息量。迁移时没有搬（它不可能是红的，也就不
 * 可能防住任何回归）；「选中的档位真的生效」由第 [5] 节「工具说明跟着改口」覆盖。
 *
 * 全部跑在临时 HOME 上，真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/terminal-env-settings.int.spec
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import * as env from '@pneuma/runtime/core/terminal-env.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'

/** 设置分区里本文件用到的形状（只声明读到的字段）。 */
interface SettingsField {
  type: string
  key?: string
  text?: string
  action?: string
  options?: Array<{ value: string; label: string }>
}

interface SettingsSection {
  id: string
  builtin?: boolean
  custom?: boolean
  order?: number
  title?: string
  fields?: SettingsField[]
}

/** 保存 / 动作的回执形状。 */
interface SettingsResult {
  ok: boolean
  notice?: string
  error?: string
}

/** 内核里本文件用到的服务面。 */
interface Services {
  settings: {
    sections(): SettingsSection[]
    values(id: string): Promise<Record<string, unknown>>
    save(id: string, key: string, value: unknown): Promise<SettingsResult>
    action(id: string, name: string): Promise<SettingsResult>
  }
}

let llm: FakeLLM
let kernel: BootedKernel
let services: Services

/** `plugins.json` 里某插件条目的 config（没写过就是空对象）。 */
function configOf(file: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(DSC_HOME, 'plugins.json'), 'utf8')) as {
    entries?: Array<{ file: string; config?: Record<string, unknown> }>
  }
  return doc.entries?.find((entry) => entry.file === file)?.config ?? {}
}

/** 设置页里的终端环境分区。 */
function section(): SettingsSection | undefined {
  return services.settings.sections().find((item) => item.id === 'terminal-env')
}

beforeAll(async () => {
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

describe('① 分区出现在设置页里', () => {
  test('注册了 terminal-env 分区', () => {
    expect(section()).toBeDefined()
  })

  test('builtin=true、custom=false（桌面端设置页按这个筛，走通用表单渲染）', () => {
    expect(section()?.builtin).toBe(true)
    expect(section()?.custom).toBe(false)
  })

  test('排在内核「通用」之后、模型之前', () => {
    // 顺序是设置页的阅读顺序；写成 6 是这一版定下的位置（与已入库的文档一致）。
    expect(section()?.order).toBe(6)
    expect(section()?.title).toBe('终端环境')
  })
})

describe('② 下拉里只有真探到的终端', () => {
  test('有「默认终端」下拉，第一项是 auto', () => {
    const select = section()?.fields?.find((field) => field.type === 'select' && field.key === 'bashShell')
    expect(select).toBeDefined()
    expect(select?.options?.[0]?.value).toBe('auto')
  })

  test('选项里不出现认不得的值', () => {
    const select = section()?.fields?.find((field) => field.type === 'select' && field.key === 'bashShell')
    const options = select?.options ?? []
    // 下拉里冒出一个 `parseShellChoice` 不认识的值，用户选中后会被静默回落成 auto。
    expect(options.every((option) => env.SHELL_CHOICES.includes(option.value as (typeof env.SHELL_CHOICES)[number]))).toBe(true)
  })

  test('非 auto 的选项都是真探到的，或当前值不可用时明确标「不可用」', () => {
    const select = section()?.fields?.find((field) => field.type === 'select' && field.key === 'bashShell')
    const options = select?.options ?? []
    const detected = env.detectShells()
    for (const option of options.filter((item) => item.value !== 'auto')) {
      const hit = detected.find((item) => item.value === option.value)
      expect(hit?.available === true || option.label.includes('不可用')).toBe(true)
    }
  })

  test('有一行检测结果、「重新检测」按钮', () => {
    const info = section()?.fields?.find((field) => field.type === 'info')
    // 检测结果那一行写的是「当前生效的那个解释器」：Windows 是 PowerShell，POSIX 是 sh。
    // 写死一边会让另一半平台红（2026-11-19 Linux CI 就是这么红的）。
    expect(info?.text).toContain(process.platform === 'win32' ? 'PowerShell' : 'sh')
    const button = section()?.fields?.find((field) => field.type === 'button')
    expect(button?.action).toBe('redetect')
  })
})

describe('③ 读出来的默认值', () => {
  test('默认是 auto', async () => {
    const values = await services.settings.values('terminal-env')
    expect(values.bashShell).toBe('auto')
  })
})

describe('④ 存一个真探到的终端', () => {
  test('保存成功、回执写清何时生效、落进 plugins.json 并读得回来', async () => {
    const options = section()?.fields?.find((field) => field.type === 'select' && field.key === 'bashShell')?.options ?? []
    // 优先 gitbash：它是「探测到的、与 PowerShell 不同家族」的样本；探不到就用第二项。
    const target = options.find((option) => option.value === 'gitbash')?.value ?? options[1]?.value
    expect(typeof target).toBe('string')

    const saved = await services.settings.save('terminal-env', 'bashShell', target)
    expect(saved.ok).toBe(true)
    // 回执必须说清生效时机：终端切换只影响下一条命令，用户不该以为当前命令被改了。
    expect(saved.notice ?? '').toContain('下一条命令起生效')
    expect(configOf('tools-default').bashShell).toBe(target)

    env.forgetShellDetection()
    const values = await services.settings.values('terminal-env')
    expect(values.bashShell).toBe(target)
  })
})

describe('⑤ 坏值不落盘', () => {
  test('认不得的终端被拒，且配置没变', async () => {
    const before = JSON.stringify(configOf('tools-default'))
    const bogus = await services.settings.save('terminal-env', 'bashShell', 'fish')
    expect(bogus.ok).toBe(false)
    expect(bogus.error).toContain('不认识的终端')
    // 拒绝必须是真的没写：写一半再报错，下次启动会读到一个坏档。
    expect(JSON.stringify(configOf('tools-default'))).toBe(before)
  })

  test('这个分区没有的键被拒', async () => {
    const wrongKey = await services.settings.save('terminal-env', 'nope', 'auto')
    expect(wrongKey.ok).toBe(false)
  })
})

describe('⑥ 重新检测按钮', () => {
  test('动作返回一行结果', async () => {
    const redetected = await services.settings.action('terminal-env', 'redetect')
    expect(redetected.ok).toBe(true)
    expect(redetected.notice ?? '').toContain('重新检测完成')
  })

  test('认不得的按钮被拒', async () => {
    expect((await services.settings.action('terminal-env', 'nope')).ok).toBe(false)
  })
})
