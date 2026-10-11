/**
 * TUI 载体的插件装载器（node 侧）：把清单里 `platform: 'tui'` 的 bundle 装进终端壳。
 *
 * 与浏览器壳的装载器（`ui-shell/src/boot.ts`）同一套语义，三处差异都是载体的：
 *   - bundle 不走 `<script>`，直接读文件求值——node 里没有 CSP，`new Function` 可用；
 *     求值只是把工厂注册进全局表（构建包装保证），副作用为零；
 *   - require 白名单是**终端壳的表**：react 与 `@dsc/ui` 由壳提供（同进程同一份 React
 *     实例，`@dsc/ui` 解析到 `tui-plugin-api.ts` 那份值面），表外一律抛；
 *   - 失败报告不进诊断区（终端没有），打进 transcript 的 system 条目。
 *
 * 信任边界与浏览器壳同一条：这是「一致性边界」不是安全沙箱——插件照样拿得到
 * process/fetch；真正把门的是「谁能往插件的产物目录里放文件」。
 *
 * @module dsc/ui/tui-plugins
 */
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import {
  collectUiArtifactsForPlatform,
  readThirdPartyUiPluginBundle,
  readUiPluginBundle,
} from '../core/ui-bundles.js'
import { isUiMethod, validateUiArgs } from '../core/ui-methods.js'
import type { DscRuntime } from '../contract.js'
import { SlotRegistry } from './slots.js'
import type { UiHostInfo, UiPluginLoadReport, UiPluginLoadResult, UiRuntimeApi } from './plugin.js'
import * as tuiPluginApi from './tui-plugin-api.js'
import type { UiPluginModule } from './plugin.js'

/** 终端壳里的「组件」：ink 组件（App.tsx 全家都是）。 */
export type InkComponent = React.ComponentType<Record<string, unknown>>

/** 工厂注册用的全局名（与浏览器壳、构建包装同一个名字）。 */
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

/** 终端壳的 require 白名单：与 `tui-plugin-api.ts` 的值面一一对应。 */
const MODULES: Readonly<Record<string, unknown>> = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '@dsc/ui': tuiPluginApi,
}

/** 白名单里的模块名（失败报告里给全，省得插件作者翻代码）。 */
const ALLOWED_MODULES: readonly string[] = Object.keys(MODULES)

/** 装载时的那一份 API（不暴露给插件，只给装载器自己）。 */
export interface TuiPluginLoadOptions {
  /** 终端壳的注册表：槽由壳先声明好（`tui-plugin-api.ts` 的 `TUI_SLOTS`）。 */
  registry: SlotRegistry<InkComponent>
  /** 宿主的进程内 runtime（`ctx.ui`）；`invoke` 在这里做白名单转发。 */
  runtime: DscRuntime
  /** 宿主身份（带 `platform: 'tui'`，插件按它分支注册进哪条槽）。 */
  host: UiHostInfo
  /** 插件产物目录（缺省仓库/安装的那份；测试注入隔离目录用）。 */
  pluginsDir?: string
  /** 失败/成功报告的去处（缺省打 stderr——TUI 场景由调用方转 transcript）。 */
  onReport?: (report: UiPluginLoadReport) => void
}

/**
 * 把 `platform: 'tui'` 的插件装进终端壳。
 *
 * 语义对齐浏览器壳的 `loadUiPlugins`：按清单顺序装、失败重试一轮（最常见的失败是
 * 顺序——先装的插件给还没声明的槽登记，等声明者装上再试一次就成了）、每条报告都不静默。
 */
export function loadTuiPlugins(options: TuiPluginLoadOptions): UiPluginLoadResult {
  const { registry, runtime, host } = options
  const reportById = new Map<string, UiPluginLoadReport>()
  const disposers = new Map<string, () => void>()

  const artifacts = collectUiArtifactsForPlatform('tui', {
    // 隔离目录测试：内置清单指向注入的目录；第三方目录不由这里传——
    // 它随 DSC_HOME 走（隔离环境自然落在临时 home 的 plugins）。
    ...(options.pluginsDir === undefined ? {} : { builtinDir: options.pluginsDir }),
  })
  for (const problem of artifacts.problems) {
    options.onReport?.({ id: problem, ok: false, error: problem })
  }

  const require_ = (spec: string): unknown => {
    if (!(spec in MODULES)) {
      throw new Error(`插件请求了白名单外的模块「${spec}」（允许：${ALLOWED_MODULES.join('、')}）`)
    }
    return MODULES[spec]
  }

  /** 把 bundle 字节求值成工厂（求值只注册工厂，不物化）。 */
  const factoryOf = (id: string, file: string, origin: string | undefined): (() => unknown) => {
    const code = origin === 'third-party' ? readThirdPartyUiPluginBundle(id) : readUiPluginBundle(id, file, options.pluginsDir)
    if (code === null) throw new Error(`读不到插件 bundle：${id}/${file}`)
    const table = globalThis as unknown as Record<string, Record<string, unknown>>
    const existing = table[FACTORY_GLOBAL]
    const scope = existing !== undefined && typeof existing === 'object' ? existing : ((table[FACTORY_GLOBAL] = {}) as Record<string, unknown>)
    delete scope[id]
    new Function(code.toString('utf8'))()
    const factory = scope[id]
    if (typeof factory !== 'function') {
      throw new Error(`插件 ${id} 的脚本没有注册工厂（bundle 形状不对？）`)
    }
    return factory as () => unknown
  }

  /** 跑工厂拿导出（require 只认白名单——与浏览器壳的 `instantiate` 同形）。 */
  const install = (id: string, file: string, origin: string | undefined, attempt: number): string | null => {
    // 这个插件的登记账本：中途抛错时按它回滚，重试才不会撞「id 已被占用」。
    const ledger: (() => void)[] = []
    const rollback = (): void => {
      for (const release of [...ledger].reverse()) {
        try {
          release()
        } catch (error) {
          console.error(`插件 ${id} 回滚登记时出错：`, error)
        }
      }
      ledger.length = 0
    }
    try {
      const exported = instantiate(factoryOf(id, file, origin), require_)
      // vite 的 cjs 产物把 `export default` 放在 `.default` 上（与浏览器壳 boot.ts 同一处理）。
      const module_ = (exported as { default?: unknown } | null)?.default ?? exported
      const apply = (module_ as { apply?: unknown } | null)?.apply
      if (typeof apply !== 'function') throw new Error('插件没有导出 apply(ui)')
      const ui = {
        id,
        slots: scopedSlots(registry, ledger),
        host,
        runtime: tuiRuntime(runtime),
      }
      const dispose = (apply as (api: unknown) => void | (() => void))(ui)
      if (typeof dispose === 'function') ledger.push(dispose)
      disposers.set(id, rollback)
      const name = (module_ as { name?: unknown } | null)?.name
      reportById.set(id, {
        id,
        ok: true,
        attempts: attempt,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
      })
      return null
    } catch (error) {
      rollback()
      const reason = error instanceof Error ? error.message : String(error)
      reportById.set(id, { id, ok: false, error: reason, attempts: attempt })
      return reason
    }
  }

  const failed: Array<{ id: string; file: string; origin: string | undefined }> = []
  for (const entry of artifacts.entries) {
    const origin = (entry as { origin?: string }).origin
    if (install(entry.id, entry.file, origin, 1) !== null) failed.push({ id: entry.id, file: entry.file, origin })
  }
  // 失败重试一轮（语义同浏览器壳）：真的写错了不能靠反复重试掩盖，但一次失败也不能永久缺席。
  for (const entry of failed) {
    if (reportById.get(entry.id)?.ok === true) continue
    install(entry.id, entry.file, entry.origin, 2)
  }

  const reports = artifacts.entries.map(
    (entry) => reportById.get(entry.id) ?? { id: entry.id, ok: false, error: '没有尝试加载' },
  )
  for (const report of reports) options.onReport?.(report)

  return {
    reports,
    disposeAll(): void {
      for (const [id, dispose] of [...disposers].reverse()) {
        try {
          dispose()
        } catch (error) {
          console.error(`插件 ${id} 卸载时出错：`, error)
        }
      }
      disposers.clear()
    },
  }
}

/** 跑工厂拿导出（require 只认白名单——与浏览器壳的 `instantiate` 同形）。 */
function instantiate(
  factory: (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void,
  require_: (spec: string) => unknown,
): unknown {
  const module_ = { exports: {} as unknown }
  factory(require_, module_, module_.exports)
  return module_.exports
}

/**
 * 给插件的槽位外壳：登记动作全部记账，卸载或重试时按账本回滚。
 * 与浏览器壳 `boot.ts` 的 `scopedSlots` 同形——装载语义两壳一致是契约的一部分。
 */
function scopedSlots(slots: SlotRegistry<InkComponent>, ledger: (() => void)[]) {
  const record = (release: () => void): (() => void) => {
    ledger.push(release)
    return release
  }
  return {
    get slots(): string[] {
      return slots.slots
    },
    spec: (slot: string) => slots.spec(slot),
    declare: (slot: string, kind: Parameters<SlotRegistry<InkComponent>['declare']>[1]) =>
      record(slots.declare(slot, kind)),
    register: (
      slot: string,
      registerOptions: Parameters<SlotRegistry<InkComponent>['register']>[1],
      component: InkComponent,
    ) => record(slots.register(slot, registerOptions, component)),
    injectSlot: (slot: string, contribute: () => void | (() => void)) => record(slots.injectSlot(slot, contribute)),
    entriesOf: (slot: string) => slots.entriesOf(slot),
    winners: (slot: string) => slots.winners(slot),
  }
}

/**
 * 进程内的 `UiRuntimeApi` 适配：快照按 web 通道同一形状投影（`plugins/webserver.ts`
 * 组帧的同一段逻辑——`HostSnapshot` 契约只有一份；seq 终端壳没有帧的概念，
 * 用自增计数顶上，语义是「快照版本号」）。订阅直接转发，`invoke` 与 web 通道**同一张面**
 * （webserver.ts 的 invoke：界面方法白名单收窄 + 实参过同一份规格校验）——同进程不等于
 * 可以绕开契约，白名单就是契约的形状；两个载体能力面不一致的话，插件就会出现
 * 「浏览器里被拒、终端里放行」的暗中分叉。
 */
function tuiRuntime(runtime: DscRuntime): UiRuntimeApi {
  let seq = 0
  return {
    getSnapshot: () => {
      const base = runtime.getSnapshot()
      seq += 1
      return {
        ...base,
        seq,
        sessionId: base.status.sessionId ?? '',
        entries: base.entries.filter((entry) => entry.id > 0),
        liveEntries: base.entries.filter((entry) => entry.id < 0),
      }
    },
    subscribe: (listener) => runtime.subscribe(listener),
    invoke<T = unknown>(method: string, args?: unknown[]): Promise<T> {
      // 顺序照 webserver.ts 的 invoke：先白名单收窄，再实参校验，最后才碰运行期。
      if (!isUiMethod(method)) {
        return Promise.reject(new Error(`界面通道没有这个方法：${method}`))
      }
      const checked = validateUiArgs(method, args ?? [])
      if (!checked.ok) return Promise.reject(new Error(checked.error))
      try {
        const value = (runtime as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[method](
          ...checked.args,
        )
        return Promise.resolve(value as T)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
  }
}
