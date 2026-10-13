/**
 * 插件加载器：把宿主给的启动清单变成「界面里真的多了几块」，并按**批**分时段装。
 *
 * 与参考实现的模块系统同一个形状，只是小了一号：
 *   - 宿主组图（顺序 + 地址 + 版本 + 批），页面只负责取回来执行；
 *   - 插件 bundle 是 CommonJS 工厂（`module.exports = { apply }`），执行时拿到的
 *     `require` **只看白名单表**——表外一律抛错，这是插件代码的依赖边界
 *     （它是「一致性边界」不是安全沙箱：插件照样拿得到 window/fetch/DOM，
 *     真正的信任边界是「谁能往插件的产物目录里放文件」）；
 *   - 一个插件加载失败只记一条报告，不拖垮壳与别的插件（失败的列在诊断区里）。
 *
 * A2/A3 起多出来的四件事：
 *
 *   1. **分批**：`early` 批装完就交还控制权（`main.tsx` 立刻画首帧），`application` 批
 *      在首帧之后的空闲时刻才取字节、才 apply——「第二批未物化时第一批已可交互」。
 *      phase 是**页面加载级**的属性，HMR 重更不会改它。
 *   2. **批取数**：一个批一条 combo URL（`plugins/??…&rev=…`），失败按
 *      `@dsc/ui-core` 的 arrival 协议回退到单资源（最多三次请求/每条缺行）。
 *      批只在首装时取；HMR 重更只按该行的单资源 URL 取一个新 rev，绝不重放批。
 *   3. **可观测**：`globalThis.__DSC_UI_BOOT_STATE__` 记批次时刻、每插件 phase/rev/状态、
 *      每次 /plugins 取数（探针与桌面自检读它；诊断区画它）。
 *   4. **可换装**：`reload(id)` 走账本卸载再装（HMR 用），并剔除该插件物化时插进来的样式。
 *
 * 为什么用 `<script>` 标签而不是 `new Function`：后者要求页面放开 `unsafe-eval`。
 * 宿主的 CSP 已经加上（`core/ui-server.ts`，script-src 'self'）——插件走 `<script src>`
 * 正好在放行面里；eval 一旦进了某段代码，报错来自浏览器安全策略，不会出现在诊断区。
 *
 * @module dsc-ui-shell/boot
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as xterm from '@xterm/xterm'
import * as xtermFit from '@xterm/addon-fit'
import { UiArrivalLedger, type UiArrivalHost } from '@dsc/ui-core'
import type {
  UiBootBatch,
  UiBootGraph,
  UiBootPhase,
  UiHostInfo,
  UiPluginEntry,
  UiPluginLoadReport,
  UiRuntimeApi,
} from '@dsc/ui-core'
import { createScopedSlotApi, ServiceRegistry, unmetInjections } from '@dsc/ui-core'
import * as pluginApi from './plugin-api'
import platformModules from './platform-modules.json'
import type { UiComponent, UiPluginApi, UiSlots } from './plugin-api'

/** 启动图注入页面时用的全局名（宿主 `core/ui-server.ts` 里同一个名字）。 */
const BOOT_GLOBAL = '__DSC_BOOT__'

/** bundle 往这个全局名下注册自己的工厂（构建脚本按同一个名字包一层）。 */
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

/** 启动账本挂的全局名（探针与桌面自检的读数面；诊断区也画它）。 */
export const BOOT_STATE_GLOBAL = '__DSC_UI_BOOT_STATE__'

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
 *
 * `@xterm/xterm` 与 `@xterm/addon-fit` 在表里（2026-10-10 加的）：终端插件要用它们，
 * 而"每个插件自带一份 xterm"会让每个用到终端的插件都拖进 ~400KB。放进平台表之后
 * 只有壳带一份（xterm 的 CSS 也由壳在 `main.tsx` 里静态 import，插件拿不到样式文件）。
 */
const MODULES: Readonly<Record<string, unknown>> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': jsxRuntime,
  '@dsc/ui': pluginApi,
  '@xterm/xterm': xterm,
  '@xterm/addon-fit': xtermFit,
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

/** 一次插件取数（探针读数：一条页面加载花了几次 /plugins 请求就是数它）。 */
export interface UiBootRequestLog {
  url: string
  /** `batch` = combo 批地址；`single` = 单资源。 */
  kind: 'batch' | 'single'
  /** 触发这次取数的插件 id（批被多条 entry 共享时记第一条）。 */
  id: string
  phase: UiBootPhase
  at: number
  ok: boolean
}

/** 一个插件在页面里的现况（诊断与探针读它）。 */
export interface UiBootPluginState {
  id: string
  phase: UiBootPhase
  rev: string
  state: 'pending' | 'loading' | 'loaded' | 'failed' | 'removed'
  attempts: number
  error?: string
  /** 装好（或失败）的时刻。 */
  at?: number
}

/** 一个批的现况（`at` 们是探针断言时序的读面）。 */
export interface UiBootBatchState {
  phase: UiBootPhase
  entries: string[]
  state: 'pending' | 'scheduled' | 'loading' | 'done' | 'failed'
  scheduledAt?: number
  startedAt?: number
  doneAt?: number
  failures: string[]
}

/** 启动账本：批次时刻、每插件状态、每次取数（挂 `globalThis.__DSC_UI_BOOT_STATE__`）。 */
export interface UiBootState {
  rev: string
  host: { name: string; version: string }
  startedAt: number
  /** `main.tsx` 画完首帧打点的时刻（A2 的验收：early 装完 ≤ 它 < application 开始）。 */
  firstFrameAt: number | null
  batches: UiBootBatchState[]
  plugins: Record<string, UiBootPluginState>
  requests: UiBootRequestLog[]
}

/** 界面壳读启动账本的入口（没起过壳时 null）。 */
export function bootState(): UiBootState | null {
  const value = (globalThis as Record<string, unknown>)[BOOT_STATE_GLOBAL]
  return value === undefined || value === null ? null : (value as UiBootState)
}

/** 订阅启动账本变化（诊断区重渲染用；探针直接读全局就行）。 */
export function subscribeBootState(listener: () => void): () => void {
  const box = bootStateListeners
  box.add(listener)
  return () => {
    box.delete(listener)
  }
}

const bootStateListeners = new Set<() => void>()

function notifyBootState(): void {
  for (const listener of [...bootStateListeners]) {
    try {
      listener()
    } catch {
      // 一个订阅者炸了不该拖垮装载（回调里通常就是 setState）
    }
  }
}

/**
 * 取启动图：优先用宿主注入的那一份（外链 /boot.js 在 `</head>` 前同步执行完，
 * 页面脚本跑起来时全局已就位），本地 `pnpm dev` 直连 vite 时没有它，回落到 `/api/boot`。
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

/** 壳的一次装载会话：分批装、可单条换装（HMR）、给 App 读报告与账本。 */
export interface UiBootSession {
  readonly graph: UiBootGraph
  /** 已尝试过的插件报告（按图里的顺序；还没轮到的批不在里面）。 */
  getReports(): UiPluginLoadReport[]
  getState(): UiBootState
  subscribe(listener: () => void): () => void
  /** `main.tsx` 画完首帧后打点（账本里的 `firstFrameAt`）。 */
  markFirstFrame(): void
  /** 首帧之后继续装 application 批（幂等；不调它第二批就永远不装）。 */
  startApplication(): void
  /** HMR 换装一条：账本卸载旧条目，再按新 entry 的单资源 URL 取数安装。 */
  reload(entry: UiPluginEntry): Promise<string | null>
  /** 卸载一条（HMR 的 removed 帧；也用于回滚）。 */
  uninstall(id: string): void
  /** 已经装上的 rev（HMR 幂等判据：同 rev 忽略）。 */
  installedRev(id: string): string | undefined
  /** 服务表（A1）：装载期「谁提供、谁消费」的那张表；`main.tsx` 用它包 ServicesProvider。 */
  readonly services: ServiceRegistry
  /** 卸载全部并停止（页面卸载/失败兜底用）。 */
  disposeAll(): void
}

/**
 * 建一次装载会话：装 early 批（**await 完**再返回，调用方随后画首帧）。
 *
 * application 批不在这里装——调用方画完首帧调 {@link UiBootSession.startApplication}。
 * 缺 `batches` 的旧宿主按「单隐含 application 批」处理（向前兼容，壳与宿主版本会错位）。
 *
 * @param graph - 宿主给的启动图（entries 已按依赖排好）
 * @param options - 槽位注册表、宿主身份与运行时通道
 * @returns 装载会话（报告、批状态、服务表与卸载口都在它上面）
 */
export async function createBootSession(
  graph: UiBootGraph,
  options: { slots: UiSlots; host: UiHostInfo; runtime: UiRuntimeApi },
): Promise<UiBootSession> {
  const batches = normalizeBatches(graph)
  const batchByEntry = new Map<string, UiBootBatch>()
  for (const batch of batches) {
    for (const id of batch.entries) batchByEntry.set(id, batch)
  }

  const state: UiBootState = {
    rev: graph.rev,
    host: { name: graph.host.name, version: graph.host.version },
    startedAt: Date.now(),
    firstFrameAt: null,
    batches: batches.map((batch) => ({ phase: batch.phase, entries: [...batch.entries], state: 'pending', failures: [] })),
    plugins: {},
    requests: [],
  }
  for (const entry of graph.entries) {
    state.plugins[entry.id] = {
      id: entry.id,
      phase: batchByEntry.get(entry.id)?.phase ?? 'application',
      rev: entry.rev,
      state: 'pending',
      attempts: 0,
    }
  }
  // 账本先挂上再开始装：探针在任意时刻读到的都是「进行中的真实状态」。
  ;(globalThis as Record<string, unknown>)[BOOT_STATE_GLOBAL] = state
  notifyBootState()

  const ledger = new UiArrivalLedger()
  const table = factoryTable()
  const disposers = new Map<string, () => void>()
  // 每调用一次装载一张新表：插件之间「谁提供、谁消费」全部经它（A1）。
  const services = new ServiceRegistry()
  const reports = new Map<string, UiPluginLoadReport>()
  const installed = new Map<string, string>()
  /**
   * 报告的展示顺序：首装时 = 图里的顺序；HMR 新装的插件（不在原图里）追到末尾，
   * 否则诊断区会漏掉「刚被宿主加进来」的那几条。
   */
  const entryOrder: UiPluginEntry[] = [...graph.entries]

  const notify = (): void => {
    notifyBootState()
  }

  const setPlugin = (id: string, patch: Partial<UiBootPluginState>): void => {
    const current = state.plugins[id]
    if (current === undefined) return
    Object.assign(current, patch)
    notify()
  }

  /** 给一个插件造 arrival 的宿主面：load 里记一笔取数（探针的请求计数面）。 */
  const arrivalHostFor = (id: string, phase: UiBootPhase): UiArrivalHost => ({
    has: (entryId) => typeof table[entryId] === 'function',
    load: (url) => {
      const log: UiBootRequestLog = {
        url,
        kind: url.includes('??') ? 'batch' : 'single',
        id,
        phase,
        at: Date.now(),
        ok: true,
      }
      state.requests.push(log)
      return appendScript(url, id).catch((error: unknown) => {
        log.ok = false
        notify()
        throw error
      })
    },
  })

  /** 装一条插件；成功返回 null，失败返回原因（报告与账本都由它写）。 */
  const install = async (entry: UiPluginEntry, attempt: number, mode: 'batch' | 'single' = 'batch'): Promise<string | null> => {
    const batch = batchByEntry.get(entry.id)
    const phase = batch?.phase ?? 'application'
    // 这个插件的登记账本：中途抛错时按它回滚，重试才不会撞「id 已被占用」。
    const ledgerOfPlugin: (() => void)[] = []
    const provides: string[] = []
    const rollback = (): void => {
      for (const release of [...ledgerOfPlugin].reverse()) {
        try {
          release()
        } catch (error) {
          console.error(`插件 ${entry.id} 回滚登记时出错：`, error)
        }
      }
      ledgerOfPlugin.length = 0
    }
    // 硬依赖先解析：inject 名单「先插件 id、再服务名」（双关见 manifest.ts），
    // 未满足就不 apply，并留一行中文原因——第一轮没就绪的，重试轮会再试一次。
    const unmet = unmetInjections(entry.inject, (id) => reports.get(id), services)
    if (unmet.length > 0) {
      const reason = `等待：${unmet.join('；')}`
      reports.set(entry.id, { id: entry.id, ok: false, error: reason, attempts: attempt })
      setPlugin(entry.id, { state: 'failed', at: Date.now(), attempts: attempt, error: reason })
      return reason
    }
    setPlugin(entry.id, { state: 'loading', phase, rev: entry.rev, attempts: attempt })
    try {
      // 批 URL 是首选；它不是单资源时带单资源回退（arrival 协议管三态与请求数）。
      // HMR 换装（mode='single'）只走单资源：批地址带的是旧 rev，重放没有任何意义。
      const preferred = mode === 'single' ? entry.url : (batch?.url ?? entry.url)
      const fallback = preferred === entry.url ? undefined : entry.url
      await ledger.arrive({ id: entry.id, preferred, ...(fallback === undefined ? {} : { fallback }) }, arrivalHostFor(entry.id, phase))
      const factory = table[entry.id]
      if (typeof factory !== 'function') throw new Error(`插件 ${entry.id} 的脚本没有注册工厂（bundle 形状不对？）`)
      const exported = instantiate(factory, entry.id)
      const module_ = (exported as { default?: unknown } | null)?.default ?? exported
      const apply = (module_ as { apply?: unknown } | null)?.apply
      if (typeof apply !== 'function') throw new Error('插件没有导出 apply(ui)')
      const ui: UiPluginApi = {
        id: entry.id,
        // 槽位登记与 provide 共用同一条回滚账（外壳在 @dsc/ui-core，与终端壳共用）：
        // apply 抛错时可能只登记了一半，直接重试会撞「同一个格子已经有人了」。
        slots: createScopedSlotApi(options.slots, (release) => record(ledgerOfPlugin, release)),
        host: options.host,
        runtime: options.runtime,
        provide: (name, value) => {
          record(ledgerOfPlugin, services.provide(name, value, entry.id))
          provides.push(name)
        },
        consume: (name) => services.consume(name),
      }
      const dispose = (apply as (api: UiPluginApi) => void | (() => void))(ui)
      if (typeof dispose === 'function') ledgerOfPlugin.push(dispose)
      disposers.set(entry.id, rollback)
      installed.set(entry.id, entry.rev)
      const name = (module_ as { name?: unknown } | null)?.name
      reports.set(entry.id, {
        id: entry.id,
        ok: true,
        attempts: attempt,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
        ...(provides.length === 0 ? {} : { provides: [...provides] }),
      })
      setPlugin(entry.id, { state: 'loaded', at: Date.now(), attempts: attempt, error: undefined })
      return null
    } catch (error) {
      rollback()
      const reason = error instanceof Error ? error.message : String(error)
      reports.set(entry.id, { id: entry.id, ok: false, error: reason, attempts: attempt })
      setPlugin(entry.id, { state: 'failed', error: reason, at: Date.now(), attempts: attempt })
      return reason
    }
  }

  /** 装一个批（两轮：失败重试一次，与全局版同一条纪律）。 */
  const installBatch = async (batch: UiBootBatch, batchState: UiBootBatchState | undefined): Promise<void> => {
    if (batchState !== undefined) {
      batchState.state = 'loading'
      batchState.startedAt = Date.now()
      batchState.failures = []
      notify()
    }
    const failed: UiPluginEntry[] = []
    for (const id of batch.entries) {
      const entry = graph.entries.find((candidate) => candidate.id === id)
      if (entry === undefined) continue
      if ((await install(entry, 1)) !== null) failed.push(entry)
    }
    // 失败重试一轮。最常见的失败不是插件写错了，而是**顺序**：先加载的插件给一个
    // 还没被声明出来的槽登记（UndeclaredSlotError），等声明它的插件装完再试一次就成了。
    // 只重试一轮——真的写错了不能靠反复重试掩盖，但也不能一次失败就让这块永久缺席。
    for (const entry of failed) {
      if (reports.get(entry.id)?.ok === true) continue
      await install(entry, 2)
    }
    if (batchState !== undefined) {
      batchState.failures = batch.entries.filter((id) => reports.get(id)?.ok === false)
      batchState.state = batchState.failures.length > 0 ? 'failed' : 'done'
      batchState.doneAt = Date.now()
      notify()
    }
  }

  // 第一档预取：清单里标了 immediately 的先**并发**把工厂拿回来（只注册工厂，不物化），
  // 首屏要用的那几块就不必排在队尾。取字节与物化分开，正是为了让这一步有用。
  // 预取跨批进行（与 phase 正交）：批是调度档位，immediately 是「谁先被取回来」。
  const prefetch = async (entry: UiPluginEntry): Promise<void> => {
    const batch = batchByEntry.get(entry.id)
    const preferred = batch?.url ?? entry.url
    const fallback = preferred === entry.url ? undefined : entry.url
    try {
      await ledger.arrive({ id: entry.id, preferred, ...(fallback === undefined ? {} : { fallback }) }, arrivalHostFor(entry.id, batch?.phase ?? 'application'))
    } catch {
      // 预取失败不算数：下面按批顺序加载时会再试一次，那时才记报告。
    }
  }
  await Promise.all(
    graph.entries
      .filter((entry) => entry.immediately === true && state.plugins[entry.id]?.state === 'pending')
      .map((entry) => prefetch(entry)),
  )

  // early 批：装完才交还控制权（调用方随后画首帧）。
  for (let index = 0; index < batches.length; index += 1) {
    if (batches[index].phase !== 'early') continue
    await installBatch(batches[index], state.batches[index])
  }

  let applicationStarted = false
  const session: UiBootSession = {
    graph,
    getReports: () =>
      entryOrder
        .map((entry) => reports.get(entry.id))
        .filter((report): report is UiPluginLoadReport => report !== undefined),
    getState: () => state,
    subscribe: (listener) => {
      bootStateListeners.add(listener)
      return () => {
        bootStateListeners.delete(listener)
      }
    },
    markFirstFrame: () => {
      if (state.firstFrameAt === null) {
        state.firstFrameAt = Date.now()
        notify()
      }
    },
    startApplication: () => {
      if (applicationStarted) return
      applicationStarted = true
      const run = (): void => {
        const pending: { batch: UiBootBatch; batchState: UiBootBatchState | undefined }[] = []
        for (let index = 0; index < batches.length; index += 1) {
          if (batches[index].phase !== 'application') continue
          const batchState = state.batches[index]
          if (batchState !== undefined && batchState.state === 'pending') {
            batchState.state = 'scheduled'
            batchState.scheduledAt = Date.now()
          }
          pending.push({ batch: batches[index], batchState })
        }
        notify()
        void (async () => {
          for (const item of pending) await installBatch(item.batch, item.batchState)
        })()
      }
      // 首帧之后挑一个浏览器空闲时刻；没有 requestIdleCallback 的载体用 setTimeout 0。
      const idle = (globalThis as { requestIdleCallback?: (callback: () => void, opts?: { timeout: number }) => number })
        .requestIdleCallback
      if (typeof idle === 'function') idle(run, { timeout: 2000 })
      else setTimeout(run, 0)
    },
    reload: async (entry) => {
      // HMR 新加的插件不在原图的条目表里：补进报告顺序（换装的则原位不动）。
      if (!entryOrder.some((candidate) => candidate.id === entry.id)) entryOrder.push(entry)
      session.uninstall(entry.id)
      return install(entry, 1, 'single')
    },
    uninstall: (id) => {
      const dispose = disposers.get(id)
      if (dispose !== undefined) {
        try {
          dispose()
        } catch (error) {
          console.error(`插件 ${id} 卸载时出错：`, error)
        }
      }
      disposers.delete(id)
      installed.delete(id)
      // 工厂表是后写覆盖的：删掉这一条，HMR 重取时才知道新脚本真的注册了。
      delete table[id]
      removeOwnedStyles(id)
      reports.delete(id)
      setPlugin(id, { state: 'removed', at: Date.now(), error: undefined })
    },
    installedRev: (id) => installed.get(id),
    services,
    disposeAll: () => {
      for (const [id, dispose] of [...disposers].reverse()) {
        try {
          dispose()
        } catch (error) {
          console.error(`插件 ${id} 卸载时出错：`, error)
        }
      }
      disposers.clear()
      installed.clear()
    },
  }
  return session
}

/**
 * 把图里的批规范化成「每个 entry 恰一批、early 在前」的列表。
 *
 * 坏批（id 不在图里）就地过滤；没被任何批覆盖的 entry 补进 application——旧宿主
 * （没有 batches）与手工组图的探针都因此走「单隐含 application 批」，不会丢插件。
 */
export function normalizeBatches(graph: UiBootGraph): UiBootBatch[] {
  const known = new Set(graph.entries.map((entry) => entry.id))
  const batches: UiBootBatch[] = []
  for (const batch of graph.batches ?? []) {
    const entries = batch.entries.filter((id) => known.has(id))
    if (entries.length > 0) batches.push({ ...batch, entries })
  }
  const covered = new Set(batches.flatMap((batch) => batch.entries))
  const rest = graph.entries.filter((entry) => !covered.has(entry.id)).map((entry) => entry.id)
  if (rest.length > 0) batches.push({ phase: 'application', entries: rest })
  const order = (phase: UiBootPhase): number => (phase === 'early' ? 0 : 1)
  return [...batches].sort((a, b) => order(a.phase) - order(b.phase))
}

/** 把一个退订动作挂进插件的账本（provide 与槽位登记共用同一条回滚路径）。 */
function record(ledger: (() => void)[], release: () => void): () => void {
  ledger.push(release)
  return release
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

/** 物化前还没打标的 `<style>`（插件可以自己往页面插样式，HMR 换装时要能剔除它那几份）。 */
function untaggedStyles(): Set<Element> {
  const found = new Set<Element>()
  if (typeof document === 'undefined') return found
  for (const element of document.querySelectorAll('style:not([data-dsc-plugin])')) found.add(element)
  return found
}

/**
 * 物化边界：把这次新出现、还没打标的 `<style>` 记成这个插件的（与参考实现同一个口径）。
 * CSS 注入发生在物化时，所以剔除与重装天然同一节奏（`uninstall` 再 `install`）。
 */
function claimStyles(before: Set<Element>, id: string): void {
  if (typeof document === 'undefined') return
  for (const element of document.querySelectorAll('style:not([data-dsc-plugin])')) {
    if (!before.has(element)) element.setAttribute('data-dsc-plugin', id)
  }
}

/** 剔除一个插件物化时插进来的样式。 */
function removeOwnedStyles(id: string): void {
  if (typeof document === 'undefined') return
  for (const element of document.querySelectorAll('style[data-dsc-plugin]')) {
    if (element.getAttribute('data-dsc-plugin') === id) element.remove()
  }
}

/** 跑一个工厂拿到它导出的东西（require 只认白名单）。 */
function instantiate(factory: Factory, id: string): unknown {
  const styleBefore = untaggedStyles()
  const module_ = { exports: {} as unknown }
  const require_ = (spec: string): unknown => {
    if (!(spec in MODULES)) {
      throw new Error(`插件 ${id} 请求了白名单外的模块「${spec}」（允许：${ALLOWED_MODULES.join('、')}）`)
    }
    return MODULES[spec]
  }
  try {
    factory(require_, module_, module_.exports)
    return module_.exports
  } finally {
    // 失败路径也要认领：半截注入的样式不该在换装时留下脏标签。
    claimStyles(styleBefore, id)
  }
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
