/**
 * plugin-manager 收尾缺口（`packages/plugin-manager/index.ts:175-176,208`）：
 * install_remote 下载成功但热挂载失败时的两条真话分支，以及 apply 返回的退订函数。
 *
 * 真挂载失败的形态是「文件在、模块里没有插件对象」，要么改真插件目录造一个坏模块，
 * 要么把三条腿（市场下载 / 热挂载 / 注册表）换成假实现。这里用后者：本地插件文件、
 * 网络与热挂载都不是本文件要验的东西，`wiring.spec.ts` 已经按真实现覆盖了它们；
 * 这里只钉「失败原因优先取注册表里的 problem，取不到才说挂载失败」与退订真的调了 offTool。
 *
 * `DSC_HOME` 在动态 import 之前指到临时目录（install_remote 要算插件目录），收尾恢复。
 *
 * @module @pneuma/plugin-manager/tests/w14-install-remote-fail.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-plugin-manager-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

/** 三条腿的可控替身：下载落一个路径，热挂载恒失败，注册表清单逐用例改。 */
const legs = vi.hoisted(() => ({
  infos: [] as Array<Record<string, unknown>>,
  mountCalls: 0,
  downloaded: [] as string[],
}))

vi.mock('@pneuma/config-core/market.js', () => ({
  browsePluginMarketSource: async () => [],
  installPluginMarketEntry: async (entry: { name: string }, dir: string) => {
    const target = `${dir}/${entry.name}`
    legs.downloaded.push(target)
    return target
  },
}))
vi.mock('@pneuma/runtime/core/plugin-loader.js', () => ({
  mountExternalPlugin: async () => {
    legs.mountCalls += 1
    return false
  },
  setPluginEnabledHot: async () => ({ ok: true }),
}))
vi.mock('@pneuma/runtime/core/plugin-registry.js', () => ({
  canTogglePlugin: () => true,
  isPluginEnabled: () => true,
  listPluginInfos: () => legs.infos,
}))

const { pluginManagerPlugin } = await import('../index.js')

interface CapturedTool {
  name: string
  run: (args: Record<string, unknown>) => Promise<string>
}

/** 假 ctx：收工具、记账退订；apply 的返回值就是它自己的退订函数。 */
function mount(): { run: (args: Record<string, unknown>) => Promise<string>; cleanup: () => void; disposed: () => number } {
  let tool!: CapturedTool
  let disposed = 0
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        tool = entry
        return () => {
          disposed += 1
        }
      },
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
  }
  const returned = pluginManagerPlugin.apply?.(ctx as never, undefined as never)
  return {
    run: (args) => tool.run(args),
    cleanup: typeof returned === 'function' ? (returned as () => void) : () => undefined,
    disposed: () => disposed,
  }
}

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：临时目录留给系统清。
  }
})

test('install_remote 下载成功但挂载失败：优先报注册表里的 problem，并说明文件已下载到哪', async () => {
  legs.infos = [
    {
      file: 'probe-broken.js',
      name: '坏探针',
      enabled: true,
      source: 'external',
      toggleable: true,
      problem: '模块里找不到插件对象',
    },
  ]
  const mounted = mount()
  const text = await mounted.run({ action: 'install_remote', file: 'https://example.com/probe-broken.js' })
  expect(legs.mountCalls).toBe(1)
  expect(text).toContain('错误：模块里找不到插件对象')
  expect(text).toContain('文件已下载到')
  expect(text).toContain('probe-broken.js')
  expect(text).toContain('可修复后重新启用')
})

test('install_remote 挂载失败且注册表里没有这条：退回「挂载失败」', async () => {
  legs.infos = []
  const mounted = mount()
  const text = await mounted.run({ action: 'install_remote', file: 'https://example.com/probe-ghost.js' })
  expect(text).toContain('错误：挂载失败')
  expect(text).toContain('文件已下载到')
})

test('apply 返回的退订函数真的调用注册时拿到的 offTool', () => {
  const mounted = mount()
  expect(mounted.disposed()).toBe(0)
  mounted.cleanup()
  expect(mounted.disposed()).toBe(1)
})
