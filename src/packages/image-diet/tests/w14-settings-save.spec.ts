/**
 * image-diet 收尾缺口（`packages/image-diet/index.ts:37,82-83,92-94,97,104-107`）：
 * 设置分区的读值（现读磁盘）与保存（开关 / 三个数字 / 未知键 / 非数字）。
 *
 * 既有 `image-diet.spec.ts` 只钉了分区身份与缺省值；这里真调 `values()` 与 `save()`，
 * 每次保存后都从临时 `DSC_HOME/plugins.json` 读回来，验的是「落盘的值与夹回区间后的值」
 * 而不是源码里有没有那句话。`DSC_HOME` 在动态 import 之前指走，收尾恢复。
 *
 * @module @pneuma/image-diet/tests/w14-settings-save.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsSectionSpec, SettingsValues } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-image-diet-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

const { imageDietPlugin } = await import('../index.js')

let section!: SettingsSectionSpec

/** 假 ctx：只收设置分区，effect 真跑回调。 */
function mount(): void {
  imageDietPlugin.apply(
    {
      settings: {
        registerSection: (spec: SettingsSectionSpec) => {
          section = spec
          return () => undefined
        },
      },
      effect: (execute: () => unknown) => {
        const off = execute()
        return typeof off === 'function' ? off : () => undefined
      },
    } as never,
    {} as never,
  )
}

/** 从临时 plugins.json 里读 image-diet 这一条的 config。 */
function diskConfig(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return doc.entries?.find((entry) => entry.file === 'image-diet')?.config ?? {}
}

const values = (): SettingsValues => section.values() as SettingsValues

/** 契约里 save 是可选的（只读分区没有它）；本分区一定有且是同步实现。 */
const save = (key: string, value: unknown): string | void => section.save!(key, value as never) as string | void

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  mount()
})

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：临时目录留给系统清。
  }
})

test('values() 现读磁盘：没配过时四个缺省值都在', () => {
  expect(values()).toEqual({ enabled: true, userImageBudget: 4, toolImageBudget: 2, keepRounds: 2 })
})

test('save(enabled)：字符串 "true" 也算开，false 写盘后 values 立刻变', () => {
  expect(save('enabled', 'true')).toBeUndefined()
  expect(diskConfig().enabled).toBe(true)
  expect(values().enabled).toBe(true)

  expect(save('enabled', false)).toBeUndefined()
  expect(diskConfig().enabled).toBe(false)
  expect(values().enabled).toBe(false)
})

test('save(数字项)：四舍五入并夹回各自区间，三个键分别生效', () => {
  expect(save('userImageBudget', '12.7')).toBeUndefined()
  expect(diskConfig().userImageBudget).toBe(13)

  expect(save('toolImageBudget', -3)).toBeUndefined()
  expect(diskConfig().toolImageBudget).toBe(0)

  // keepRounds 的上限是 50（与其他两项的 20 不同），越界要按自己的区间夹。
  expect(save('keepRounds', 999)).toBeUndefined()
  expect(diskConfig().keepRounds).toBe(50)

  // 保存后再读值：磁盘上的那份才是真值。
  expect(values()).toMatchObject({ userImageBudget: 13, toolImageBudget: 0, keepRounds: 50 })
})

test('save 的失败分支：未知键与非数字都返回人话，且一个字节都不写', () => {
  expect(save('nope', 1)).toBe('这个分区没有这项：nope')
  expect(save('toolImageBudget', 'abc')).toBe('这里要填一个数字')
  expect(diskConfig()).toEqual({})
})
