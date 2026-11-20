/**
 * spill 插件的装配与行为测试：落盘、预览、失败提示、设置保存、清理按钮与卸载。
 *
 * 落盘是真的写临时目录（`DSC_HOME` 指过去），断言看磁盘；失败路径用一个**普通文件冒充目录**
 * 让 `mkdirSync` 报错，不靠权限或不跨平台的手段。
 *
 * @module @pneuma/spill/tests/wiring
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-spill-wiring-')
const spillDir = join(home, 'spill')

interface CapturedObserver {
  id: string
  order: number
  observe(tool: string, text: string): string
}
interface CapturedSection {
  id: string
  fields: () => Array<{ key?: string; type: string; text?: string }>
  values: () => Record<string, unknown>
  save: (key: string, value: string) => string | void
  action: (name: string) => string | void
}
interface Captured {
  observers: CapturedObserver[]
  section: CapturedSection
  systems: string[]
}

let spillPlugin: typeof import('../index.js')['spillPlugin']

beforeAll(async () => {
  process.env['DSC_HOME'] = home
  ;({ spillPlugin } = await import('../index.js'))
})

/** 装一次插件：passed 是装配时那份配置（磁盘上没有 spill 条目时以它为底）。 */
function mount(passed: Record<string, unknown>): { captured: Captured; dispose: () => void } {
  const captured: Captured = { observers: [], section: undefined as unknown as CapturedSection, systems: [] }
  const ctx = {
    guards: {
      registerObserver: (observer: CapturedObserver) => {
        captured.observers.push(observer)
        return () => {
          captured.observers.length = 0
        }
      },
    },
    settings: {
      registerSection: (section: CapturedSection) => {
        captured.section = section
        return () => {}
      },
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    transcript: {
      system: (text: string) => {
        captured.systems.push(text)
      },
    },
    session: { current: () => ({ meta: { id: 'spill-session' } }) },
  }
  const dispose = spillPlugin.apply(ctx as unknown as Context, {
    dir: spillDir,
    thresholdChars: 50,
    keepLines: 2,
    readChunkLines: 10,
    ...passed,
  }) as unknown as () => void
  return { captured, dispose }
}

test('短输出与 read 的输出原样通过；观察者排在遮红之后', () => {
  const { captured, dispose } = mount({})
  const observer = captured.observers[0]!
  expect(observer.id).toBe('spill')
  expect(observer.order).toBeGreaterThanOrEqual(50)
  expect(observer.observe('bash', '短输出')).toBe('短输出')
  // read 的结果就是模型点名要的那一段，再落盘只是让它去读另一个文件。
  expect(observer.observe('read', 'x'.repeat(10_000))).toBe('x'.repeat(10_000))
  dispose()
})

test('长输出落盘：回给模型的是头几行 + 路径 + 续读写法，磁盘上是完整原文', () => {
  const { captured, dispose } = mount({ dir: join(home, 'spill-a') })
  const observer = captured.observers[0]!
  const lines = Array.from({ length: 120 }, (_, index) => `第 ${String(index + 1)} 行：${'内容'.repeat(20)}`)
  const long = lines.join('\n')
  const preview = observer.observe('bash', long)

  expect(preview.length).toBeLessThan(long.length)
  expect(preview).toContain('第 1 行')
  expect(preview).toContain('第 2 行')
  // 中间省略，提示续读；路径是绝对路径且在溢出目录下。
  expect(preview).toContain('read(')
  const path = /read\(path=([^,]+)/.exec(preview)?.[1]?.replace(/^['"]|['"]$/g, '') ?? ''
  expect(path.startsWith(join(home, 'spill-a'))).toBe(true)
  expect(existsSync(path)).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe(long)
  dispose()
})

test('落盘失败（目录位置被普通文件占着）：原文照给，只提醒一次', () => {
  const blocked = join(home, 'blocked-dir')
  writeFileSync(blocked, 'not a directory')
  const { captured, dispose } = mount({ dir: blocked })
  const observer = captured.observers[0]!
  const long = 'x'.repeat(500)

  expect(observer.observe('bash', long)).toBe(long)
  expect(captured.systems).toHaveLength(1)
  expect(captured.systems[0]).toContain('长输出转存没能落盘')
  expect(captured.systems[0]).toContain('这条提醒本次会话只说一次')

  // 第二次失败不再刷屏，但仍返回原文。
  expect(observer.observe('bash', long)).toBe(long)
  expect(captured.systems).toHaveLength(1)
  dispose()
})

test('设置字段与当前值：目录现状按真实文件数算；保存数字/目录/未知键', () => {
  const dir = join(home, 'spill-b')
  const { captured, dispose } = mount({ dir })
  const section = captured.section
  // 先落一份，让「目录现状」有东西可数。
  captured.observers[0]!.observe('bash', 'y'.repeat(200))

  const fields = section.fields()
  expect(fields.map((field) => field.key ?? field.type)).toStrictEqual([
    'thresholdChars',
    'keepLines',
    'readChunkLines',
    'maxBytes',
    'retentionDays',
    'maxTotalBytes',
    'dir',
    'info',
    'button',
  ])
  const info = fields.find((field) => field.type === 'info')
  expect(info?.text).toContain(dir)
  expect(info?.text).toMatch(/\d+ 个文件/)

  expect(section.values()).toMatchObject({ dir, keepLines: 2, readChunkLines: 10 })

  expect(String(section.save('thresholdChars', 'not-a-number'))).toContain('数字')
  expect(section.save('thresholdChars', '1234')).toBeUndefined()
  expect(section.values()['thresholdChars']).toBe(1234)
  expect(String(section.save('dir', '  '))).toContain('溢出目录不能空着')

  const moved = join(home, 'spill-moved')
  expect(section.save('dir', moved)).toBeUndefined()
  expect(section.values()['dir']).toBe(moved)
  expect(String(section.save('bogus', '1'))).toContain('bogus')
  dispose()
})

test('清理按钮：真扫一遍并回报删了几个、还剩几个；未知按钮名给提示', () => {
  const dir = join(home, 'spill-c')
  const { captured, dispose } = mount({ dir })
  captured.observers[0]!.observe('bash', 'z'.repeat(200))
  expect(String(captured.section.action('鬼按钮'))).toContain('没有这个按钮')
  const done = String(captured.section.action('cleanup'))
  expect(done).toContain('清掉')
  expect(done).toMatch(/还剩 \d+ 个/)
  dispose()
})

test('卸载会再扫一遍溢出目录（只删过期与超量，刚写的那份保住）', () => {
  const dir = join(home, 'spill-d')
  const { captured, dispose } = mount({ dir, thresholdChars: 50 })
  const preview = captured.observers[0]!.observe('bash', Array.from({ length: 60 }, () => 'q'.repeat(20)).join('\n'))
  const path = /read\(path=([^,]+)/.exec(preview)?.[1]?.replace(/^['"]|['"]$/g, '') ?? ''
  expect(existsSync(path)).toBe(true)
  dispose()
  // 刚落盘的那份被 keepPath 保住：卸载清理不会把它删掉。
  expect(existsSync(path)).toBe(true)
})
