/**
 * 插件加载器：把宿主给的启动清单变成「界面里真的多了几块」。
 *
 * 与 dsh 的模块系统同一个形状，只是小了一号：
 *   - 宿主组图（顺序 + 地址 + 版本），页面只负责取回来执行；
 *   - 插件 bundle 是 CommonJS 工厂（`module.exports = { apply }`），
 *     执行时拿到的 `require` **只看白名单表**——表外一律抛错，这是插件代码的边界；
 *   - 一个插件加载失败只记一条报告，不拖垮壳与别的插件（失败的列在诊断区里）。
 *
 * 为什么用 `new Function` 而不是 `<script>`：这些 bundle 是 CJS 工厂不是 ESM，
 * 而且我们要给它们注入受控的 require/module/exports。代价是这份代码必须与
 * 「不放开全局 unsafe-eval」共存——本壳是宿主自己伺服的本机页面，没有第三方脚本，
 * 所以只在这一个受控入口里执行字节码。
 *
 * @module dsc-ui-shell/boot
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import type { UiBootGraph, UiHostInfo, UiPluginLoadReport } from '@dsc/ui-core'
import * as pluginApi from './plugin-api'
import type { UiPluginApi, UiSlots } from './plugin-api'

/** 启动图注入页面时用的全局名（宿主 `core/ui-server.ts` 里同一个名字）。 */
const BOOT_GLOBAL = '__DSC_BOOT__'

/**
 * 插件能 require 的模块表。
 *
 * 这里是**唯一**的依赖边界：表外的模块名一律拒绝。React 由壳提供，
 * 所以壳与所有插件共用同一份 React 实例（两份 React 会让 hooks 直接崩）。
 */
const MODULES: Readonly<Record<string, unknown>> = {
  react: React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': jsxRuntime,
  '@dsc/ui': pluginApi,
}

/** 白名单里的模块名（诊断与提前校验用）。 */
export const ALLOWED_MODULES: readonly string[] = Object.keys(MODULES)

/** 执行插件 bundle 时要注入的三个参数。 */
type Factory = (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void

/**
 * 取启动图：优先用宿主注入的那一份（不必多一次请求，也不会慢一拍），
 * 本地 `pnpm dev` 直连 vite 时注入不存在，回落到 `/api/boot`。
 */
export async function readBootGraph(): Promise<UiBootGraph> {
  const injected = (globalThis as Record<string, unknown>)[BOOT_GLOBAL]
  if (injected !== undefined && injected !== null) return injected as UiBootGraph
  const response = await fetch('/api/boot', { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`取启动清单失败：HTTP ${String(response.status)}`)
  return (await response.json()) as UiBootGraph
}

/**
 * 按清单顺序加载并安装每个插件。
 * @param graph - 宿主给的启动图（entries 已按依赖排好）
 * @param options - 槽位注册表与宿主身份
 * @returns 每个插件一条报告（成功的也记，诊断区看得见谁装上了）
 */
export async function loadUiPlugins(
  graph: UiBootGraph,
  options: { slots: UiSlots; host: UiHostInfo },
): Promise<UiPluginLoadReport[]> {
  const reports: UiPluginLoadReport[] = []
  for (const entry of graph.entries) {
    try {
      for (const spec of entry.external ?? []) {
        if (!(spec in MODULES)) throw new Error(`声明要的模块「${spec}」不在白名单里`)
      }
      const response = await fetch(entry.url, { headers: { accept: 'text/javascript' } })
      if (!response.ok) throw new Error(`取 bundle 失败：HTTP ${String(response.status)}`)
      const code = await response.text()
      const exported = evaluate(code, entry.id)
      const module_ = (exported as { default?: unknown } | null)?.default ?? exported
      const apply = (module_ as { apply?: unknown } | null)?.apply
      if (typeof apply !== 'function') throw new Error('插件没有导出 apply(ui)')
      const api: UiPluginApi = { id: entry.id, slots: options.slots, host: options.host }
      ;(apply as (ui: UiPluginApi) => void)(api)
      reports.push({ id: entry.id, ok: true })
    } catch (error) {
      reports.push({ id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return reports
}

/** 执行一段 CJS 工厂代码，返回它导出的东西。 */
function evaluate(code: string, id: string): unknown {
  const module_ = { exports: {} as unknown }
  const require_ = (spec: string): unknown => {
    if (!(spec in MODULES)) {
      throw new Error(`插件 ${id} 请求了白名单外的模块「${spec}」（允许：${ALLOWED_MODULES.join('、')}）`)
    }
    return MODULES[spec]
  }
  const factory = new Function('require', 'module', 'exports', code) as Factory
  factory(require_, module_, module_.exports)
  return module_.exports
}
