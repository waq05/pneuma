/**
 * 「一个包两半」的端到端装配（迁自 `scripts/ui-two-halves-test.mjs`，探针本体保留走真机）。
 *
 * 示例包 `examples/plugin-two-halves` 装进 profile 后，宿主半（工具）与界面半（状态栏那
 * 一段）都要到位。四段：
 *   ① 组合包挂载：mountBundlePlugins 无失败、工具进注册表且能执行、插件中心认得出它来自
 *      组合包、不把会加载的 pneuma 界面半标成「只列不加载」；
 *   ② 界面半收集：collectUiArtifactsForPlatform 收进产物表、来源标 package、进得了启动图；
 *   ③ 路由：按 rev 伺服装载到这份 bundle，rev 对不上给 404（内容寻址）；
 *   ④ 工厂形状：这份 bundle 是手写的（不走构建），壳的工厂协议一变它就静默失效——当场
 *      跑一遍：注册名、工厂产出、require 白名单、apply 注册槽、组件标记。
 *
 * 与探针的差异：内核由 `bootKernel` 起（隔离 HOME + 关记忆/标题插件），内核函数从 `src`
 * 解析（混合平面，D25）——插件半仍在 profile 的 node_modules 里由 Node 直接装载，行为面
 * 一致。`pnpm run build` 先行（`lib/ui/plugins` 是产物收集的内置来源）。
 *
 * 同名 e2e（`ui-two-halves-e2e.mjs`）走真桌面壳，不属本层。
 *
 * @module dsc/tests/integration/two-halves.int.spec
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { collectUiArtifactsForPlatform, toUiPluginRows } from '@pneuma/runtime/core/ui-bundles.js'
import { composeUiBootGraph } from '@pneuma/runtime/core/ui-manifest.js'
import { listPluginInfos } from '@pneuma/runtime/core/plugin-registry.js'
import { mountBundlePlugins } from '@pneuma/runtime/core/plugin-loader.js'
import { resolveUiBundleRequest } from '@pneuma/runtime/core/ui-route.js'
import { bootKernel, type BootedKernel } from '../harness.js'

/** 仓库根：示例包与 `lib/ui/plugins`（内置界面产物）都从这里定位。 */
const ROOT = resolve(import.meta.dirname, '../..')
const EXAMPLE = join(ROOT, 'examples', 'plugin-two-halves')
/** 内置界面插件目录：D32——从 src 导入的 `uiPluginsDir()` 会落到空的 `src/ui/plugins`，必须显式指。 */
const BUILTIN_UI_DIR = join(ROOT, 'lib', 'ui', 'plugins')

/** profile 里的组合包落点（探测期一次性铺好）。 */
const BUNDLE_NAME = 'dsc-demo-two-halves'
let profileDir = ''
let booted: BootedKernel | null = null

/** 内核里本文件用到的服务面（窄化，不把整个 Context 类型拖进来）。 */
interface TwoHalvesSurface {
  tools: {
    list(): Array<{ name: string; run(args: object, meta: { cwd: string; signal: AbortSignal }): Promise<unknown> }>
  }
}

beforeAll(() => {
  // profile 目录铺在 integration 的临时 HOME 下；DSC_PROFILE 让产物收集按它解析组合包。
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home === undefined) throw new Error('two-halves：临时 HOME 没铺好（integration setup 应负责）')
  profileDir = join(home, '.dsc', 'profiles', 'demo')
  const installed = join(profileDir, 'node_modules', BUNDLE_NAME)
  mkdirSync(profileDir, { recursive: true })
  cpSync(EXAMPLE, installed, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'demo-profile', private: true, dsh: { profile: { bundles: [BUNDLE_NAME] } } }, null, 2),
    'utf8',
  )
  process.env.DSC_PROFILE = 'demo'
})

afterAll(async () => {
  delete process.env.DSC_PROFILE
  if (booted !== null) await booted.dispose()
})

let mountFailures: Awaited<ReturnType<typeof mountBundlePlugins>>['failures'] = []

beforeAll(async () => {
  booted = await bootKernel({ providerBaseUrl: 'http://127.0.0.1:9' })
  const mounted = await mountBundlePlugins(booted.ctx as Parameters<typeof mountBundlePlugins>[0], profileDir)
  mountFailures = mounted.failures
})

test('组合包挂上：宿主半的工具进注册表且能执行', async () => {
  expect(mountFailures, JSON.stringify(mountFailures)).toEqual([])
  const ctx = booted!.ctx as unknown as TwoHalvesSurface
  const tool = ctx.tools.list().find((item) => item.name === 'two_halves_hi')
  expect(tool, JSON.stringify(ctx.tools.list().map((item) => item.name).slice(-5))).toBeDefined()
  const output = await tool?.run({}, { cwd: tmpdir(), signal: new AbortController().signal })
  expect(output).toBe('两半都在')
})

test('插件中心认得出它来自组合包，且不把 pneuma 界面半标成「只列不加载」', () => {
  const info = listPluginInfos().find((item) => item.name === BUNDLE_NAME)
  expect((info as { bundle?: string } | undefined)?.bundle).toBe(BUNDLE_NAME)
  const capabilities = (info as { clientCapabilities?: string[] } | undefined)?.clientCapabilities ?? []
  expect(capabilities).not.toContain('platform:pneuma')
})

describe('界面半：产物表、启动图与内容寻址路由', () => {
  // 产物收集要在 beforeAll 设完 DSC_PROFILE 之后跑（describe 体执行于收集期，早于钩子）。
  let artifacts: ReturnType<typeof collectUiArtifactsForPlatform>
  let entry: (typeof artifacts)['entries'][number] | undefined

  beforeAll(() => {
    artifacts = collectUiArtifactsForPlatform('web', { force: true, builtinDir: BUILTIN_UI_DIR })
    entry = artifacts.entries.find((item) => item.id === BUNDLE_NAME)
  })

  test('界面半收进了产物表，来源标 package', () => {
    expect(entry, JSON.stringify(artifacts.problems)).toBeDefined()
    expect((entry as { origin?: string } | undefined)?.origin).toBe('package')
  })

  test('进得了启动图', () => {
    const graph = composeUiBootGraph({ name: 'Pneuma', version: 'test' }, toUiPluginRows(artifacts.entries))
    expect(graph.entries.map((item) => item.id)).toContain(BUNDLE_NAME)
  })

  test('路由按 rev 伺服装载到这份 bundle；rev 对不上给 404（内容寻址）', () => {
    expect(entry).toBeDefined()
    const route = resolveUiBundleRequest(`/plugins/${BUNDLE_NAME}/client.js`, String(entry?.rev))
    expect(route.status).toBe(200)
    expect(String(route.body)).toContain('__DSC_UI_FACTORIES__')
    const wrong = resolveUiBundleRequest(`/plugins/${BUNDLE_NAME}/client.js`, '0'.repeat(16))
    expect(wrong.status).toBe(404)
  })
})

describe('示例包的工厂形状（手写 bundle，壳的工厂协议一变它就静默失效）', () => {
  const source = readFileSync(join(EXAMPLE, 'client.bundle.js'), 'utf8')
  const table: Record<string, unknown> = {}

  /** 工厂拿到的 require：只放行白名单里的两个模块，其余报错（白名单外的模块就是横穿）。 */
  const requireStub = (spec: string): unknown => {
    if (spec === 'react') {
      return {
        createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({
          type,
          props: { ...props, ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
        }),
      }
    }
    if (spec === '@dsc/ui') return { defineUiPlugin: (definition: unknown) => definition }
    throw new Error('白名单外的模块：' + spec)
  }

  const registered: Array<{ slot: string; id: string; component: () => unknown }> = []
  let exported: { name?: string; apply?: (host: unknown) => void } | undefined

  test('bundle 注册的工厂名与包名一致，工厂产出的模块有 name 与 apply', () => {
    const previous = (globalThis as { __DSC_UI_FACTORIES__?: unknown }).__DSC_UI_FACTORIES__
    try {
      ;(globalThis as { __DSC_UI_FACTORIES__?: unknown }).__DSC_UI_FACTORIES__ = table
      new Function(source)()
      const factory = table[BUNDLE_NAME]
      expect(typeof factory).toBe('function')
      const mod = { exports: {} as Record<string, unknown> }
      if (typeof factory === 'function') (factory as (r: unknown, m: unknown, e: object) => void)(requireStub, mod, mod.exports)
      exported = mod.exports.default as typeof exported
      expect(typeof exported?.name).toBe('string')
      expect(typeof exported?.apply).toBe('function')
    } finally {
      if (previous === undefined) delete (globalThis as { __DSC_UI_FACTORIES__?: unknown }).__DSC_UI_FACTORIES__
      else (globalThis as { __DSC_UI_FACTORIES__?: unknown }).__DSC_UI_FACTORIES__ = previous
    }
  })

  test('只 require 白名单里的模块（react 与 @dsc/ui）', () => {
    expect(exported).toBeDefined()
    // requireStub 对白名单外的说明符直接抛——能走到这里就说明没横穿。
    expect(() => requireStub('../transcript/review-notice')).toThrow('白名单外的模块')
  })

  test('apply 把一段注册进 shell.statusbar，组件带 data-two-halves 标记与示例文案', () => {
    if (typeof exported?.apply !== 'function') throw new Error('工厂产出的模块没有 apply')
    exported.apply({
      slots: {
        register: (slot: string, meta: { id: string }, component: () => unknown) => {
          registered.push({ slot, id: meta.id, component })
        },
        injectSlot: () => undefined,
        declare: () => undefined,
      },
      host: { name: 'Pneuma', version: 'test', platform: 'web' },
    })
    expect(registered).toHaveLength(1)
    expect(registered[0]?.slot).toBe('shell.statusbar')
    const element = registered[0]?.component() as { props?: Record<string, unknown> } | undefined
    expect(element?.props?.['data-two-halves']).toBe('1')
    expect(element?.props?.children).toBe('两半示例')
  })
})
