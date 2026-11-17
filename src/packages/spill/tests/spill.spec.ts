/**
 * @pneuma/spill 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：这个包对外只有插件对象，落盘要会话目录与磁盘，留在集成探针里；
 * 能便宜钉住的是装配面、包形态、入口、文档，以及 apply 挂上的观察者与设置分区。
 *
 * 迁移说明：原文件从 `lib/packages/spill/index.js` 取插件对象，现在直接 import 源码入口
 * `../index.js`。假 ctx 保留（它只实现 apply 会碰的四个面），另外把 `DSC_HOME` 与溢出目录
 * 都指到临时目录：apply 的清理函数会扫溢出目录，不能扫到真实的 `~/.dsc`。
 *
 * @module @pneuma/spill/tests
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const home = mkdtempSync(join(tmpdir(), 'dsc-spill-spec-'))
const spillDir = join(home, 'spill')
process.env.DSC_HOME = join(home, '.dsc')

const { spillPlugin } = await import('../index.js')

/** 本包的清单。 */
const pkg = JSON.parse(read('../package.json')) as {
  name: string
  type: string
  exports: Record<string, { default?: string }>
  pneuma: { bundle?: { patch: string }; library?: boolean }
}

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

/** 假 ctx 捕获到的观察者与设置分区。 */
interface Captured {
  observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }>
  section: {
    id: string
    title: string
    fields: () => unknown[]
    save: (key: string, value: unknown) => string | void
    action: (name: string) => string | void
  }
}

// 假 ctx：只实现 apply 会碰的四个面；effect 真跑回调，返回它的清理函数。
function fakeContext(): { ctx: unknown; captured: Captured } {
  const captured = {
    observers: [] as Captured['observers'],
    section: undefined as unknown as Captured['section'],
  }
  const ctx = {
    guards: {
      registerObserver: (observer: Captured['observers'][number]) => {
        captured.observers.push(observer)
        return () => {}
      },
    },
    settings: {
      registerSection: (spec: Captured['section']) => {
        captured.section = spec
        return () => {}
      },
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    transcript: { system: () => {} },
    session: { current: () => ({ meta: { id: 'package-test' } }) },
  }
  return { ctx, captured }
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/spill', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: spill\s*$/m)
  expect(patch).toContain("name: '@pneuma/spill'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma.library === true) {
    expect(pkg.pneuma.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof spillPlugin).toBe('object')
  expect(typeof spillPlugin.name).toBe('string')
  expect(spillPlugin.name).toBe(pkg.name.split('/').pop())
  expect(spillPlugin.name).toBe('spill')
  expect(typeof spillPlugin.apply).toBe('function')
  expect(spillPlugin.inject).toContain('guards')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 顺序不变量：观察者必须排在遮红（order 10）之后，否则磁盘上留下的会是脱敏前的原文。
test('apply 挂上的观察者排在遮红（10）之后，且 read 的输出不落盘', () => {
  const { ctx, captured } = fakeContext()
  spillPlugin.apply(ctx as never, { dir: spillDir })
  expect(captured.observers.length).toBe(1)
  const observer = captured.observers[0]
  expect(observer?.id).toBe('spill')
  expect(observer?.order).toBeGreaterThan(10)
  const long = 'x'.repeat(200_000)
  expect(observer?.observe('read', long)).toBe(long)
})

// 设置面：分区 id 必须与插件键一致，否则界面按 id 找不回自己的设置。
test('设置分区 id 是 spill，字段与保存/按钮回调齐全', () => {
  const { ctx, captured } = fakeContext()
  spillPlugin.apply(ctx as never, { dir: spillDir })
  expect(captured.section.id).toBe('spill')
  expect(typeof captured.section.title).toBe('string')
  expect(typeof captured.section.fields).toBe('function')
  expect(typeof captured.section.save).toBe('function')
  expect(typeof captured.section.action).toBe('function')
})
