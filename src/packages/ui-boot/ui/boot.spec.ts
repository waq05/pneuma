/**
 * 界面启动器（`ui-boot/ui/boot.ts`）不碰通道的那一半：启动图、批次规范化、账本读取、
 * 插件脚本的物化（白名单 require、rev 缓存、样式认领与取脚本失败）。
 *
 * 建连/装载会话要真通道与骨架，归快照层；这里只钉「图怎么读、批怎么排、模块怎么跑」。
 *
 * @module dsc-ui-boot/ui/boot.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BOOT_STATE_GLOBAL, bootState, loadPluginModule, normalizeBatches, readBootGraph } from './boot.js'
import type { UiBootGraph, UiPluginEntry } from '@pneuma/runtime/core/ui-manifest.js'

const BOOT_GLOBAL = '__DSC_BOOT__'
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

const scope = globalThis as unknown as Record<string, unknown>

beforeEach(() => {
  delete scope[BOOT_GLOBAL]
  delete scope[BOOT_STATE_GLOBAL]
  delete scope[FACTORY_GLOBAL]
  document.head.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  delete scope[BOOT_GLOBAL]
  delete scope[BOOT_STATE_GLOBAL]
  delete scope[FACTORY_GLOBAL]
})

/** 一张最小的启动图。 */
function graph(entries: string[], batches?: UiBootGraph['batches']): UiBootGraph {
  return {
    rev: 'r1',
    host: { name: 'web', version: '1.0.0' },
    entries: entries.map((id) => ({ id, url: `plugins/${id}/client.js?rev=1`, rev: '1' })),
    batches: batches ?? [],
  }
}

describe('readBootGraph 与账本', () => {
  test('宿主注入的那一份优先；没有就回落到 /api/boot，非 200 给能照做的错', async () => {
    const injected = graph(['a'])
    scope[BOOT_GLOBAL] = injected
    await expect(readBootGraph()).resolves.toBe(injected)

    delete scope[BOOT_GLOBAL]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(graph(['b'])), { status: 200 }))
    await expect(readBootGraph()).resolves.toMatchObject({ entries: [{ id: 'b' }] })
    expect(fetchMock).toHaveBeenCalledWith('/api/boot', { headers: { accept: 'application/json' } })

    fetchMock.mockResolvedValue(new Response('', { status: 503 }))
    await expect(readBootGraph()).rejects.toThrow(/HTTP 503.*宿主伺服/)
  })

  test('bootState：没起过壳给 null，注入后原样交回', () => {
    expect(bootState()).toBeNull()
    const state = { rev: 'r', startedAt: 1, batches: [], plugins: {}, requests: [] }
    scope[BOOT_STATE_GLOBAL] = state
    expect(bootState()).toBe(state)
  })
})

describe('normalizeBatches', () => {
  test('坏 id 过滤、空批丢掉、没覆盖的补进 application、early 排前面', () => {
    const input = graph(['a', 'b', 'c', 'd'], [
      { phase: 'application', entries: ['c', 'missing', 'a'] },
      { phase: 'early', entries: ['b'] },
      { phase: 'early', entries: ['also-missing'] },
    ])
    const batches = normalizeBatches(input)
    expect(batches.map((batch) => batch.phase)).toEqual(['early', 'application', 'application'])
    expect(batches[0]!.entries).toEqual(['b'])
    // 原 application 批过滤掉 missing 后仍保留；d 没被覆盖，单独补一批。
    expect(batches[1]!.entries).toEqual(['c', 'a'])
    expect(batches[2]!.entries).toEqual(['d'])
  })

  test('没有 batches（旧宿主）：整张图补一个 application 批', () => {
    expect(normalizeBatches(graph(['a', 'b']))).toEqual([{ phase: 'application', entries: ['a', 'b'] }])
  })

  test('全部覆盖时不多补批', () => {
    const input = graph(['a'], [{ phase: 'early', entries: ['a'] }])
    expect(normalizeBatches(input)).toEqual([{ phase: 'early', entries: ['a'] }])
  })
})

describe('loadPluginModule：物化缓存与白名单', () => {
  test('工厂已注册：直接执行；require 平台种子可用，未知模块把话说全', async () => {
    let runs = 0
    scope[FACTORY_GLOBAL] = {
      alpha: (require: (spec: string) => unknown, module: { exports: unknown }) => {
        runs += 1
        const react = require('react') as { createElement?: unknown }
        module.exports = { ok: true, hasCreateElement: typeof react.createElement === 'function' }
      },
    }
    const entry: UiPluginEntry = { id: 'alpha', url: 'plugins/alpha/client.js?rev=1', rev: '1' }
    await expect(loadPluginModule(entry)).resolves.toMatchObject({ ok: true, hasCreateElement: true })
    // 同一个 rev 再来一次：工厂只执行一遍。
    await loadPluginModule(entry)
    expect(runs).toBe(1)
    // 换 rev：重新执行。
    await loadPluginModule({ ...entry, rev: '2' })
    expect(runs).toBe(2)

    scope[FACTORY_GLOBAL] = {
      beta: (require: (spec: string) => unknown, module: { exports: unknown }) => {
        module.exports = require('left-pad')
      },
    }
    await expect(loadPluginModule({ id: 'beta', url: 'plugins/beta/client.js?rev=1', rev: '1' })).rejects.toThrow(
      /既不是平台种子.*平台种子：react/,
    )
  })

  test('工厂未注册：插 script 等它；load 后注册工厂再物化，脚本节点会摘掉', async () => {
    const entry: UiPluginEntry = { id: 'late', url: 'plugins/late/client.js?rev=1', rev: '1' }
    const pending = loadPluginModule(entry)
    const script = document.head.querySelector('script[data-dsc-plugin="late"]') as HTMLScriptElement | null
    expect(script).not.toBeNull()
    expect(script!.src).toContain('/plugins/late/client.js?rev=1')

    // 注册表要改**同一个对象**：loadPluginModule 在插脚本前已经把表接过去了。
    const table = scope[FACTORY_GLOBAL] as Record<string, unknown>
    table['late'] = (_require: unknown, module: { exports: unknown }) => {
      module.exports = { late: true }
    }
    script!.dispatchEvent(new Event('load'))
    await expect(pending).resolves.toEqual({ late: true })
    expect(document.head.querySelector('script[data-dsc-plugin="late"]')).toBeNull()
  })

  test('脚本取不到：把地址带回来；load 了却没注册工厂：说 bundle 形状不对', async () => {
    const failing = loadPluginModule({ id: 'bad', url: 'plugins/bad/client.js?rev=1', rev: '1' })
    const script = document.head.querySelector('script[data-dsc-plugin="bad"]')!
    script.dispatchEvent(new Event('error'))
    await expect(failing).rejects.toThrow(/plugins\/bad\/client\.js/)

    const empty = loadPluginModule({ id: 'empty', url: 'plugins/empty/client.js?rev=1', rev: '1' })
    document.head.querySelector('script[data-dsc-plugin="empty"]')!.dispatchEvent(new Event('load'))
    await expect(empty).rejects.toThrow(/没有注册工厂/)
  })

  test('工厂插进来的样式被打上插件标签（HMR 换装时能按 owner 剔除）', async () => {
    scope[FACTORY_GLOBAL] = {
      styled: (_require: unknown, module: { exports: unknown }) => {
        const style = document.createElement('style')
        style.textContent = '.x{}'
        document.head.append(style)
        module.exports = {}
      },
    }
    await loadPluginModule({ id: 'styled', url: 'plugins/styled/client.js?rev=1', rev: '1' })
    expect(document.head.querySelector('style')?.getAttribute('data-dsc-plugin')).toBe('styled')
  })
})
