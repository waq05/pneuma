/**
 * 插件产物层（B31/B49）：直接执行 `lib/ui/plugins/<id>/client.js`，验「真产物」而不是源码。
 *
 * ## 为什么这层必须存在
 *
 * `scripts/ui-plugin-disable-test.mjs` 里最硬的一段是「受控 require 执行产物工厂」：
 * 它证明构建后的 bundle 仍然导出 `apply`、仍然报名页签、cleanup 仍然交回撤销函数。
 * 这段以前只在夜跑裸脚本里；改坏 `build-plugins.mjs` 或插件入口形状，PR 门看不见。
 * 这里把同一机制搬进 Vitest 的 built 层（DSH 的 `.built.e2e.ts` 口径）：
 *
 * 1. 枚举 `lib/ui/plugins/<id>/client.js`，逐个执行工厂并断言导出了 `apply`；
 * 2. 对 `ask` 做完整闭环：报名页签 → 打开入口卡 → cleanup 后报名消失。
 *
 * 被测对象是产物，不解析 `src`；先 `pnpm run build && pnpm -C ui-shell build`。
 *
 * @module dsc/tests/built/plugin-client.built.e2e
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIR = join(ROOT, 'lib', 'ui', 'plugins')

if (!existsSync(PLUGINS_DIR)) {
  console.warn(`plugin-client built：插件产物不在（${PLUGINS_DIR}）——先 pnpm run build && pnpm -C ui-shell build`)
}

/** 产物工厂：bundle 顶层把自己挂到 `globalThis.__DSC_UI_FACTORIES__[id]`。 */
type Factory = (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void

/** 读一个插件目录的 client.js（没有就返回 null）。 */
function clientOf(id: string): string | null {
  const file = join(PLUGINS_DIR, id, 'client.js')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** 平台种子模块的受控桩：插件只拿得到 `@dsc/ui` 与 `@dsc/ui-primitives` 的形态。 */
function stubRequire(captured: Array<Record<string, unknown>>): (spec: string) => unknown {
  return (spec: string): unknown => {
    if (spec === 'react' || spec === 'react-dom') return new Proxy({}, { get: () => () => null })
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: {} }
    if (spec === '@dsc/ui-primitives') return new Proxy({}, { get: () => () => null })
    if (spec === '@dsc/ui') {
      return new Proxy(
        {
          createT: () => (key: string) => key,
          defineUiPlugin: (module: unknown) => module,
          registerDockTab: (meta: Record<string, unknown>) => {
            captured.push(meta)
            return () => undefined
          },
        },
        { get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : () => null) },
      )
    }
    throw new Error(`built 桩不认识的模块：${spec}`)
  }
}

/** 执行 bundle 工厂，返回插件模块（`exports.default ?? exports`）。 */
function loadPlugin(id: string, captured: Array<Record<string, unknown>>): { apply?: unknown } {
  const source = clientOf(id)
  if (source === null) throw new Error(`没有 ${id} 的 client.js`)
  const globals = globalThis as unknown as { __DSC_UI_FACTORIES__?: Record<string, Factory> }
  globals.__DSC_UI_FACTORIES__ = {}
  // eslint-disable-next-line no-new-func
  new Function(source)()
  const factory = globals.__DSC_UI_FACTORIES__[id]
  if (typeof factory !== 'function') throw new Error(`${id} 的产物没有注册工厂`)
  const module_ = { exports: {} as unknown }
  factory(stubRequire(captured), module_, module_.exports)
  const exported = module_.exports as { default?: { apply?: unknown }; apply?: unknown } | undefined
  return (exported?.default ?? exported ?? {}) as { apply?: unknown }
}

describe.skipIf(!existsSync(PLUGINS_DIR))('插件产物（client.js）', () => {
  const ids = existsSync(PLUGINS_DIR)
    ? readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(PLUGINS_DIR, entry.name, 'client.js')))
        .map((entry) => entry.name)
        .sort()
    : []

  test('每个插件产物都注册了工厂、导出了 apply（静态形状）', () => {
    expect(ids.length, JSON.stringify(ids)).toBeGreaterThanOrEqual(10)
    const broken: string[] = []
    for (const id of ids) {
      const source = clientOf(id)
      if (source === null) {
        broken.push(`${id}: 没有 client.js`)
        continue
      }
      // 构建器把每个插件包成 `(globalThis.__DSC_UI_FACTORIES__ ??= {})["<id>"] = function (...)`
      // 少这一行，壳装载时根本拿不到工厂；导出里没有 apply，插件装上也不会做任何事。
      if (!source.includes('__DSC_UI_FACTORIES__')) broken.push(`${id}: 没挂工厂表`)
      if (!new RegExp(`__DSC_UI_FACTORIES__[^\\n]*\\["${id}"\\]`).test(source)) broken.push(`${id}: 工厂没登记成自己的 id`)
      if (!source.includes('exports')) broken.push(`${id}: 没有 CJS exports`)
      if (!/apply\s*[:(=]/.test(source)) broken.push(`${id}: 导出里找不到 apply`)
    }
    expect(broken, broken.join('; ')).toEqual([])
  })

  test('ask 的真实产物：报名页签 + 入口卡 + cleanup 撤销', () => {
    const captured: Array<Record<string, unknown>> = []
    const plugin = loadPlugin('ask', captured)
    expect(typeof plugin.apply, 'ask 产物没有导出 apply').toBe('function')

    const slots: Array<{ slot: string; id: string }> = []
    const ui = {
      id: 'ask',
      slots: {
        register: (slot: string, options: { id: string }) => {
          slots.push({ slot, id: options.id })
          return () => undefined
        },
      },
      host: {},
      runtime: {},
      provide: () => undefined,
      consume: () => undefined,
    }
    const cleanup = (plugin.apply as (ui: unknown) => unknown)(ui)
    const meta = captured.find((item) => item['kind'] === 'ask')
    expect(meta, JSON.stringify(captured)).toBeDefined()
    expect(meta?.['label']).toBe('ask.tab.label')
    expect(meta?.['keepMounted']).toBe(true)
    const guide = meta?.['guide'] as Record<string, unknown> | undefined
    expect(guide?.['tone']).toBe('tone-ask')
    expect(guide?.['shortcut']).toBe('Ctrl + Shift + K')
    expect(guide?.['title']).toBe('ask.tab.label')
    expect(guide?.['description']).toBe('ask.guide.desc')
    expect(slots.some((item) => item.slot === 'shell.header'), '浮钮 / 快捷键没挂到 shell.header').toBe(true)
    expect(typeof cleanup, 'apply 没有交回撤销函数').toBe('function')
    if (typeof cleanup === 'function') cleanup()
  })
})
