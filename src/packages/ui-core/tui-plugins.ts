/**
 * TUI 载体的插件装载器（node 侧）：把清单里 `platform: 'tui'` 的 bundle 装进终端壳。
 *
 * 与浏览器壳的装载器（`src/packages/ui-boot/ui/boot.ts`）同一套语义，三处差异都是载体的：
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
import * as Cordis from '@deepseek-ai/cordis'
import * as zod from 'zod'
import {
  collectUiArtifactsForPlatform,
  readThirdPartyUiPluginBundle,
  readUiArtifactBytes,
  readUiPluginBundle,
  type UiPluginManifestEntry,
} from '../../core/ui-bundles.js'
import { stripClientSuffix } from '../../core/ui-manifest.js'
import { isUiMethod, validateUiArgs } from '../../core/ui-methods.js'
import type { DscRuntime } from '../../contract.js'
import { SlotRegistry } from './slots.js'
import { createScopedSlotApi } from './scoped-slots.js'
import { ServiceRegistry, unmetDependencies, type PluginDeps } from './services.js'
import type { UiHostInfo, UiPluginLoadReport, UiPluginLoadResult, UiRuntimeApi } from './plugin.js'
import * as tuiPluginApi from './tui-plugin-api.js'
import type { UiPluginModule } from './plugin.js'

/** 终端壳里的「组件」：ink 组件（App.tsx 全家都是）。 */
export type InkComponent = React.ComponentType<Record<string, unknown>>

/** 工厂注册用的全局名（与浏览器壳、构建包装同一个名字）。 */
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

/**
 * 终端壳的 require 白名单。
 *
 * 前两项与最后一项与 `tui-plugin-api.ts` 的值面一一对应；`cordis` 与 `zod` 是
 * **跨载体共用的平台种子**（浏览器壳的种子表里也有这两项，见
 * `ui-boot/ui/platform-modules.json`）：一个插件两份产物都能 require 到同一份，
 * 不必各自内联一份实例。
 *
 * 为什么终端壳**不**收齐浏览器那 14 项：`react-dom` / `@tanstack/react-virtual` /
 * `@xterm/*` 这些要么要 DOM、要么是浏览器渲染专用的东西，终端里根本没有对应物；
 * 摆进来只会让插件以为自己拿到了能用的模块，apply 时炸在更远的地方。
 */
const MODULES: Readonly<Record<string, unknown>> = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '@dsc/ui': tuiPluginApi,
  '@deepseek-ai/cordis': Cordis,
  zod,
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
  /**
   * 服务表（A1）。缺省新建一张——测试要在同一进程里装载多轮时各自注入，
   * 免得上一轮的服务泄漏进下一轮。
   */
  services?: ServiceRegistry
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
  // 服务表（A1）：与浏览器壳同一份实现；缺省新建一张，测试可注入隔离的那张。
  const services = options.services ?? new ServiceRegistry()

  const artifacts = collectUiArtifactsForPlatform('tui', {
    // 隔离目录测试：内置清单指向注入的目录；第三方目录不由这里传——
    // 它随 DSC_HOME 走（隔离环境自然落在临时 home 的 plugins）。
    ...(options.pluginsDir === undefined ? {} : { builtinDir: options.pluginsDir }),
  })
  for (const problem of artifacts.problems) {
    options.onReport?.({ id: problem, ok: false, error: problem })
  }

  /** 本图里另一条插件**已经装好**的导出（`external` 指向插件时 require 到这里）。 */
  const installedModules = new Map<string, unknown>()
  /** 本图的插件 id 集：`external` 的第二类合法取值（与浏览器壳的 `graphIds` 同一个口径）。 */
  const graphIds = new Set(artifacts.entries.map((entry) => entry.id))
  /** 这个壳能满足的外部模块名：平台表里的，或本图里另一条插件（`/client` 算同一条）。 */
  const isKnownExternal = (name: string): boolean => name in MODULES || graphIds.has(stripClientSuffix(name))
  /** 报错时把「你还能拿到什么」一次列全，省得作者来回试。 */
  const knownNames = (): string => [...ALLOWED_MODULES, ...graphIds].join('、')
  /**
   * 一个插件的 require：平台表 → 本图里已装好的插件 → 报错。
   *
   * 为什么按条目现造：`external` 是逐条声明的，报错要能说「你声明的这个我给不了」，
   * 而不是笼统的「白名单外」。指向另一条插件的那一类只认**已经物化**的导出——工厂是
   * 同步跑的，这里等不了一次异步装载；顺序由两轮装载兜底（第一轮没就绪，第二轮再来）。
   */
  const requireFor = (entry: UiPluginManifestEntry): ((spec: string) => unknown) => (spec: string): unknown => {
    if (spec in MODULES) return MODULES[spec]
    const target = stripClientSuffix(spec)
    const settled = installedModules.get(target)
    if (settled !== undefined) return settled
    if (graphIds.has(target)) {
      // 在图里但还没装好（它自己失败了、或排在后面）：说清是「等」而不是「没有」，
      // 否则作者会去翻模块表，而问题在另一条插件的报告里。
      throw new Error(`插件 ${entry.id} 依赖的插件 ${target} 还没装好（看它自己的装载报告）`)
    }
    if ((entry.external ?? []).includes(spec) || (entry.external ?? []).includes(target)) {
      throw new Error(`插件 ${entry.id} 声明的外部模块「${spec}」终端壳给不了（可用的：${knownNames()}）`)
    }
    throw new Error(`插件请求了白名单外的模块「${spec}」（允许：${ALLOWED_MODULES.join('、')}）`)
  }

  /** 按条目的来源去读它的字节（内置在产物目录、第三方在 ~/.dsc/plugins、组合包在包自己的路径）。 */
  const bytesOf = (entry: UiPluginManifestEntry): Buffer | null => {
    const origin = (entry as { origin?: unknown }).origin
    if (origin === 'package') {
      // 组合包的入口由包的 exports 决定，不在固定位置：发现时已把绝对路径算好。
      return readUiArtifactBytes(entry, options.pluginsDir === undefined ? {} : { builtinDir: options.pluginsDir })
    }
    if (origin === 'third-party') return readThirdPartyUiPluginBundle(entry.id)
    return readUiPluginBundle(entry.id, entry.file, options.pluginsDir)
  }

  /** 把 bundle 字节求值成工厂（求值只注册工厂，不物化）。 */
  const factoryOf = (entry: UiPluginManifestEntry): (() => unknown) => {
    const id = entry.id
    const code = bytesOf(entry)
    if (code === null) throw new Error(`读不到插件 bundle：${id}/${entry.file}`)
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
  const install = (entry: UiPluginManifestEntry, deps: PluginDeps, attempt: number): string | null => {
    const id = entry.id
    // 这个插件的登记账本：中途抛错时按它回滚，重试才不会撞「id 已被占用」。
    const ledger: (() => void)[] = []
    const provides: string[] = []
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
    // 硬依赖先解析：插件 id 与服务名各查各的（2.0 起不再双关）；
    // 被停用的依赖要说「被停用了」，不能说「不在清单里」——后者会把人指去重装。
    // `external` 先验：声明了一个终端壳给不了的模块，与其等 apply 时炸在更远的地方，
    // 不如在这里说清「哪几个给不了、我这儿有什么」（与浏览器壳 boot.ts 的装载前校验同形）。
    const unknownExternal = (entry.external ?? []).filter((name) => !isKnownExternal(name))
    if (unknownExternal.length > 0) {
      const listed = unknownExternal.map((name) => '"' + name + '"').join('、')
      const reason = `插件 ${id} 声明的外部模块 ${listed} 终端壳给不了（可用的：${knownNames()}）`
      reportById.set(id, { id, ok: false, error: reason, attempts: attempt })
      return reason
    }
    const unmet = unmetDependencies(deps, (name) => reportById.get(name), services, new Set(artifacts.disabled))
    if (unmet.length > 0) {
      const reason = `等待：${unmet.join('；')}`
      reportById.set(id, { id, ok: false, error: reason, attempts: attempt })
      return reason
    }
    try {
      const exported = instantiate(factoryOf(entry), requireFor(entry))
      // vite 的 cjs 产物把 `export default` 放在 `.default` 上（与浏览器壳 boot.ts 同一处理）。
      const module_ = (exported as { default?: unknown } | null)?.default ?? exported
      const apply = (module_ as { apply?: unknown } | null)?.apply
      if (typeof apply !== 'function') throw new Error('插件没有导出 apply(ui)')
      const ui = {
        id,
        slots: createScopedSlotApi(registry, (release) => {
          ledger.push(release)
          return release
        }),
        host,
        runtime: tuiRuntime(runtime),
        provide: (name: string, value: unknown) => {
          const release = services.provide(name, value, id)
          ledger.push(release)
          provides.push(name)
        },
        consume: (name: string) => services.consume(name),
      }
      const dispose = (apply as (api: unknown) => void | (() => void))(ui)
      if (typeof dispose === 'function') ledger.push(dispose)
      disposers.set(id, rollback)
      // 装好了才进「可供别人 require」的表：半截的导出交给下一条插件只会更难查。
      installedModules.set(id, module_)
      const name = (module_ as { name?: unknown } | null)?.name
      reportById.set(id, {
        id,
        ok: true,
        attempts: attempt,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
        ...(provides.length === 0 ? {} : { provides: [...provides] }),
      })
      return null
    } catch (error) {
      rollback()
      const reason = error instanceof Error ? error.message : String(error)
      reportById.set(id, { id, ok: false, error: reason, attempts: attempt })
      return reason
    }
  }

  // 两轮装载的键都是「产物条目」本身：组合包的入口在包的绝对路径上（由 exports 决定），
  // 只传 id/file 会读错地方。
  const failed: Array<{ entry: UiPluginManifestEntry; deps: PluginDeps }> = []
  for (const entry of artifacts.entries) {
    const deps: PluginDeps = {
      ...(entry.inject === undefined ? {} : { plugins: entry.inject }),
      ...((entry as { services?: readonly string[] }).services === undefined
        ? {}
        : { services: (entry as { services?: readonly string[] }).services }),
    }
    if (install(entry, deps, 1) !== null) failed.push({ entry, deps })
  }
  // 失败重试一轮（语义同浏览器壳）：真的写错了不能靠反复重试掩盖，但一次失败也不能永久缺席。
  for (const item of failed) {
    if (reportById.get(item.entry.id)?.ok === true) continue
    install(item.entry, item.deps, 2)
  }

  const reports = artifacts.entries.map(
    (entry) => reportById.get(entry.id) ?? { id: entry.id, ok: false, error: '没有尝试加载' },
  )
  for (const report of reports) options.onReport?.(report)

  return {
    reports,
    services: services.names(),
    serviceRegistry: services,
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
