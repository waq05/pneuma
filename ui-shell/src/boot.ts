/**
 * 插件加载器：把宿主给的启动清单变成「界面里真的多了几块」。
 *
 * 与 dsh 的模块系统同一个形状，只是小了一号：
 *   - 宿主组图（顺序 + 地址 + 版本），页面只负责取回来执行；
 *   - 插件 bundle 是 CommonJS 工厂（`module.exports = { apply }`），执行时拿到的
 *     `require` **只看白名单表**——表外一律抛错，这是插件代码的依赖边界
 *     （它是「一致性边界」不是安全沙箱：插件照样拿得到 window/fetch/DOM，
 *     真正的信任边界是「谁能往插件的产物目录里放文件」）；
 *   - 一个插件加载失败只记一条报告，不拖垮壳与别的插件（失败的列在诊断区里）。
 *
 * 为什么用 `<script>` 标签而不是 `new Function`：后者要求页面放开 `unsafe-eval`。
 * 现在这份页面没设 CSP 所以能跑，但一旦加上（安全审查最自然的下一步），
 * 所有插件会**同时**失效，而且报错来自浏览器的安全策略，不会出现在我们的诊断里。
 * `<script src>` 让浏览器自己执行字节码，要的 CSP 只有 `script-src 'self'`。
 *
 * @module dsc-ui-shell/boot
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import type {
  UiBootGraph,
  UiHostInfo,
  UiPluginEntry,
  UiPluginLoadReport,
  UiPluginLoadResult,
  UiRuntimeApi,
  UiSlotApi,
} from '@dsc/ui-core'
import * as pluginApi from './plugin-api'
import platformModules from './platform-modules.json'
import type { UiComponent, UiPluginApi, UiSlots } from './plugin-api'

/** 启动图注入页面时用的全局名（宿主 `core/ui-server.ts` 里同一个名字）。 */
const BOOT_GLOBAL = '__DSC_BOOT__'

/** bundle 往这个全局名下注册自己的工厂（构建脚本按同一个名字包一层）。 */
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

/**
 * 插件能 require 的模块表。
 *
 * 这里是**唯一**的依赖边界：表外的模块名一律拒绝。React 由壳提供，
 * 所以壳与所有插件共用同一份 React 实例（两份 React 会让 hooks 直接崩）。
 * `react-dom/client` 必须在表里：漏了它，插件里 `createRoot` 的 import
 * 会被打包器内联成第二份 react-dom，同页两套协调器，症状是 hooks 报错或事件失灵。
 *
 * 故意不在表里的：`@dsc/ui-core`（壳的内部实现，插件只该用 `@dsc/ui`；
 * 它被构建期保留成 require，所以真当值用了会得到一句明确的「白名单外的模块」）。
 */
const MODULES: Readonly<Record<string, unknown>> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': jsxRuntime,
  '@dsc/ui': pluginApi,
}

/** 白名单里的模块名（诊断与提前校验用）。 */
export const ALLOWED_MODULES: readonly string[] = Object.keys(MODULES)

// 构建期把同一张表交给了打包器（`build-plugins.mjs` 也读 platform-modules.json）。
// 万一有人只改了一边，这里立刻指出来：否则插件会在加载那一刻才炸，报错还指不到根因。
const PLATFORM_MODULES: readonly string[] = platformModules
const MODULE_DRIFT = [
  ...PLATFORM_MODULES.filter((spec: string) => !(spec in MODULES)),
  ...Object.keys(MODULES).filter((spec) => !PLATFORM_MODULES.includes(spec)),
]
if (MODULE_DRIFT.length > 0) {
  console.error(`[ui-shell] 平台模块表与运行时 require 表对不上：${MODULE_DRIFT.join('、')}`)
}

/** bundle 注册的那种工厂：壳把受控的 require/module/exports 传进去。 */
type Factory = (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void

/**
 * 取启动图：优先用宿主注入的那一份（不必多一次请求，也不会慢一拍），
 * 本地 `pnpm dev` 直连 vite 时注入不存在，回落到 `/api/boot`。
 */
export async function readBootGraph(): Promise<UiBootGraph> {
  const injected = (globalThis as Record<string, unknown>)[BOOT_GLOBAL]
  if (injected !== undefined && injected !== null) return injected as UiBootGraph
  const response = await fetch('/api/boot', { headers: { accept: 'application/json' } })
  if (!response.ok) {
    // 这条兜底只在「页面不是宿主伺服的那一份」时才走：说清楚，省得去查网络。
    throw new Error(
      `取启动清单失败：HTTP ${String(response.status)}（这一页不是宿主伺服的页面？` +
        '宿主启动时会打印一个带令牌的地址，用那个地址打开）',
    )
  }
  return (await response.json()) as UiBootGraph
}

/**
 * 按清单顺序加载并安装每个插件。
 * @param graph - 宿主给的启动图（entries 已按依赖排好）
 * @param options - 槽位注册表与宿主身份
 * @returns 每个插件一条报告（成功的也记）与一个总卸载口
 */
export async function loadUiPlugins(
  graph: UiBootGraph,
  options: { slots: UiSlots; host: UiHostInfo; runtime: UiRuntimeApi },
): Promise<UiPluginLoadResult> {
  const reportById = new Map<string, UiPluginLoadReport>()
  const disposers = new Map<string, () => void>()

  // 第一档预取：清单里标了 immediately 的先**并发**把工厂拿回来（只注册工厂，不物化），
  // 首页要用的那几块就不必排在队尾。取字节与物化分开，正是为了让这一步有用。
  const factories = new Map<string, Factory>()
  await Promise.all(
    graph.entries
      .filter((entry) => entry.immediately === true && factories.get(entry.id) === undefined)
      .map(async (entry) => {
        try {
          factories.set(entry.id, await fetchFactory(entry))
        } catch {
          // 预取失败不算数：下面按顺序加载时会再试一次，那时才记报告。
        }
      }),
  )

  /** 装一个插件；成功返回 null，失败返回原因（报告也由它写）。 */
  const install = async (entry: UiPluginEntry, attempt: number): Promise<string | null> => {
    // 这个插件的登记账本：中途抛错时按它回滚，重试才不会撞「id 已被占用」。
    const ledger: (() => void)[] = []
    const rollback = (): void => {
      for (const release of [...ledger].reverse()) {
        try {
          release()
        } catch (error) {
          console.error(`插件 ${entry.id} 回滚登记时出错：`, error)
        }
      }
      ledger.length = 0
    }
    try {
      const cached = factories.get(entry.id)
      const factory = cached ?? (await fetchFactory(entry))
      factories.set(entry.id, factory)
      const exported = instantiate(factory, entry.id)
      const module_ = (exported as { default?: unknown } | null)?.default ?? exported
      const apply = (module_ as { apply?: unknown } | null)?.apply
      if (typeof apply !== 'function') throw new Error('插件没有导出 apply(ui)')
      const ui: UiPluginApi = {
        id: entry.id,
        slots: scopedSlots(options.slots, ledger),
        host: options.host,
        runtime: options.runtime,
      }
      const dispose = (apply as (api: UiPluginApi) => void | (() => void))(ui)
      if (typeof dispose === 'function') ledger.push(dispose)
      disposers.set(entry.id, rollback)
      const name = (module_ as { name?: unknown } | null)?.name
      reportById.set(entry.id, {
        id: entry.id,
        ok: true,
        attempts: attempt,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
      })
      return null
    } catch (error) {
      rollback()
      const reason = error instanceof Error ? error.message : String(error)
      reportById.set(entry.id, { id: entry.id, ok: false, error: reason, attempts: attempt })
      return reason
    }
  }

  const failed: UiPluginEntry[] = []
  for (const entry of graph.entries) {
    if ((await install(entry, 1)) !== null) failed.push(entry)
  }

  // 失败重试一轮。最常见的失败不是插件写错了，而是**顺序**：先加载的插件给一个
  // 还没被声明出来的槽登记（UndeclaredSlotError），等声明它的插件装完再试一次就成了。
  // 只重试一轮——真的写错了不能靠反复重试掩盖，但也不能一次失败就让这块永久缺席。
  for (const entry of failed) {
    if (reportById.get(entry.id)?.ok === true) continue
    await install(entry, 2)
  }

  return {
    reports: graph.entries.map(
      (entry) => reportById.get(entry.id) ?? { id: entry.id, ok: false, error: '没有尝试加载' },
    ),
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

/**
 * 给一个插件的槽位外壳：登记动作全部记账，插件卸载（或这次装载失败要重试）时按账本回滚。
 *
 * 为什么不让插件直接拿注册表：`apply` 抛错时它可能已经登记了一半，直接重试会撞
 * 「同一个格子已经有人了」；而且插件不需要知道谁崩了、怎么退位——那是壳的事。
 */
function scopedSlots(slots: UiSlots, ledger: (() => void)[]): UiSlotApi<UiComponent> {
  const record = (release: () => void): (() => void) => {
    ledger.push(release)
    return release
  }
  return {
    get slots(): string[] {
      return slots.slots
    },
    spec: (slot) => slots.spec(slot),
    declare: (slot, kind) => record(slots.declare(slot, kind)),
    register: (slot, registerOptions, component) => record(slots.register(slot, registerOptions, component)),
    injectSlot: (slot, contribute) => record(slots.injectSlot(slot, contribute)),
    entriesOf: (slot) => slots.entriesOf(slot),
    winners: (slot) => slots.winners(slot),
  }
}

/** 让浏览器把 bundle 跑起来，并把它注册的工厂取回来。 */
async function fetchFactory(entry: UiPluginEntry): Promise<Factory> {
  const table = factoryTable()
  // 同一个 id 重新加载时不许拿到上一份：先清掉，脚本跑完再看有没有人写进来。
  delete table[entry.id]
  await appendScript(entry.url, entry.id)
  const factory = table[entry.id]
  if (typeof factory !== 'function') {
    throw new Error(`插件 ${entry.id} 的脚本没有注册工厂（bundle 形状不对？）`)
  }
  return factory
}

/** 插 `<script>` 并等它执行完。 */
function appendScript(url: string, id: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    // async=false 让动态插入的脚本保持插入顺序执行（壳里本来就按清单顺序来）。
    script.async = false
    script.dataset['dscPlugin'] = id
    script.addEventListener('load', () => {
      script.remove()
      resolve()
    })
    script.addEventListener('error', () => {
      script.remove()
      reject(new Error(`取 bundle 失败：${url}`))
    })
    document.head.append(script)
  })
}

/** 全局工厂表（bundle 里的那一层包装写的就是它）。 */
function factoryTable(): Record<string, Factory> {
  const scope = globalThis as unknown as Record<string, unknown>
  const existing = scope[FACTORY_GLOBAL]
  if (existing !== undefined && typeof existing === 'object' && existing !== null) {
    return existing as Record<string, Factory>
  }
  const created: Record<string, Factory> = {}
  scope[FACTORY_GLOBAL] = created
  return created
}

/** 跑一个工厂拿到它导出的东西（require 只认白名单）。 */
function instantiate(factory: Factory, id: string): unknown {
  const module_ = { exports: {} as unknown }
  const require_ = (spec: string): unknown => {
    if (!(spec in MODULES)) {
      throw new Error(`插件 ${id} 请求了白名单外的模块「${spec}」（允许：${ALLOWED_MODULES.join('、')}）`)
    }
    return MODULES[spec]
  }
  factory(require_, module_, module_.exports)
  return module_.exports
}
