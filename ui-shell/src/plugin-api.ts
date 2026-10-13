/**
 * 插件作者看到的那个模块：`import { defineUiPlugin, useHostSnapshot } from '@dsc/ui'`。
 *
 * 加载器把这一份**原样**交给插件（`require('@dsc/ui')` 拿到它），
 * 所以插件 bundle 里不要内联它——只能当外部模块引用，这样壳与插件共用同一套类型与
 * 同一份实现（按类型写代码，按依赖换实现）。
 *
 * 刻意只放"写插件需要的东西"：槽位类型、组件 props 契约、宿主身份、运行时 hook、
 * defineUiPlugin。React 与 react-dom 也从白名单里拿（插件 bundle 里是 `require('react')`），
 * 不另开端口——否则 React 会有两份，hooks 立刻崩。
 *
 * @module dsc-ui-shell/plugin-api
 */
import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type {
  FactoryChildrenOf as FactoryChildrenOfMap,
  FactoryInputPropsOf as FactoryInputPropsOfMap,
  FactoryLocalInputPropsOf as FactoryLocalInputPropsOfMap,
  FactoryLocalNameOf as FactoryLocalNameOfMap,
  FactoryStoreOf as FactoryStoreOfMap,
  HostSnapshot,
  PropsStoreOf,
  SlotEntry,
  SlotKind,
  SlotKindOf as SlotKindOfMap,
  SlotMatchedOf as SlotMatchedOfMap,
  SlotOwnerOf as SlotOwnerOfMap,
  SlotRegistry,
  UiHostInfo,
  UiPluginApi as CoreUiPluginApi,
  UiPluginModule,
  UiRuntimeApi,
  UiSlotApi,
} from '@dsc/ui-core'
import { NATIVE_BRIDGE_VERSION, type NativeEvent, type NativeOp } from '@dsc/ui-core'
import {
  subscribeDock,
  type DockReview,
} from './dock-state'
import { shellPage, subscribePage } from './page-state'

// 载体基元与槽名契约：终端壳的对应物在 `src/ui/tui-plugin-api.ts`。
// 槽名两边导出同名常量——插件 import 它写注册目标，字符串字面量不散落。
export { Text } from './plugin-text.js'
export const TUI_SLOTS = {
  /** 通知盒下方的插件扩展行（list）：插件在这里放一行状态说明。 */
  noticeExtensions: 'tui.notice.extensions',
} as const

/**
 * ── 槽位契约表（D1）────────────────────────────────────────────────────────────
 *
 * 槽名 → `{ kind; owner?; matched? }`。壳与插件都用 `declare module '@dsc/ui'` 往上并键。
 * 为什么表声明在这个模块（而不是 @dsc/ui-core 再转出）：`declare module` 的合并只认
 * **词法相邻**的声明，re-export 不参与——声明必须落在插件 import 的那个模块里。
 * 壳在 `ui-shell/src/slots.ts` 并进 9 个壳槽，插件就近并自己开出来的子槽
 * （例：transcript 的 `transcript.toolview`）。
 */
export interface SlotMap {}

/** Factory 契约表（D2）：Factory 名 → `{ props; children?; slots?; store? }`。 */
export interface SlotFactoryMap {}

/** 表里的槽名（联合类型）；写错槽名在调用点就编不过。 */
export type SlotName = keyof SlotMap & string
/** 某个槽的形态。 */
export type SlotKindOf<K extends SlotName> = SlotKindOfMap<SlotMap, K>
/** 某个槽的 owner 份额（父在渲染调用点传的 props）。 */
export type SlotOwnerOf<K extends SlotName> = SlotOwnerOfMap<SlotMap, K>
/** 某个 chain 槽的 matched 类型（选择器返回值，组件 `matched` prop 从它推）。 */
export type SlotMatchedOf<K extends SlotName> = SlotMatchedOfMap<SlotMap, K>

/** Factory 名（表里的键）。 */
export type FactoryName = keyof SlotFactoryMap & string
/** Factory occurrence 的输入 props（父在 renderFactorySlot 调用点传的）。 */
export type FactoryInputProps<F extends FactoryName> = FactoryInputPropsOfMap<SlotFactoryMap, F>
/** 局部位置名。 */
export type FactoryLocalName<F extends FactoryName> = FactoryLocalNameOfMap<SlotFactoryMap, F>
/** 某个局部位置的输入 props。 */
export type FactoryLocalInputProps<F extends FactoryName, N extends FactoryLocalName<F>> =
  FactoryLocalInputPropsOfMap<SlotFactoryMap, F, N>
/** Factory 声明的普通子槽表。 */
export type FactoryChildren<F extends FactoryName> = FactoryChildrenOfMap<SlotFactoryMap, F>
/** Factory 声明的席位句柄（没声明是 undefined）。 */
export type FactoryStore<F extends FactoryName> = FactoryStoreOfMap<SlotFactoryMap, F>

/**
 * 壳交给插件组件的渲染能力（每个条目、每个 Factory occurrence 都有）。
 *
 * 为什么要交给组件而不是从 `ui.slots` 里直接渲染：槽是**位置**，位置归渲染它的人管。
 * 一个工具卡要在自己尾巴上留个洞，得由它说明「这个洞叫什么」，别人再往里放东西；
 * 这样 `renderSlot` 只能渲染本条目自己声明过的名字，拼错当场报装配错误。
 */
export interface SlotRenderApi<ChildKeys extends string = never> {
  /** 渲染本条目声明过的子槽（没声明过的名字调用会抛装配错误）。 */
  renderSlot: <K extends ChildKeys & SlotName>(name: K, props?: SlotOwnerOf<K>) => ReactNode
  /** 本条目声明出来的子槽名（诊断用）。 */
  childSlots: readonly string[]
  /** 渲染一次 Factory occurrence（定义缺席画 fallback）——D2 的复用面。 */
  renderFactorySlot: RenderFactorySlot
}

/**
 * Factory 定义与局部组件共享的注册面（定义声明的 children 渲染 + Factory 渲染 + 席位）。
 * 局部组件与定义组件收到的是**同一份**，所以局部位置也能开自己的子槽、读同一个席位。
 */
export type FactoryRegistrationShare<F extends FactoryName> = SlotRenderApi<keyof FactoryChildren<F> & string> & PropsStoreOf<FactoryStore<F>>

/** 父按 occurrence 选的局部组件（或定义自己给的 fallback）。 */
export type FactoryLocalProps<F extends FactoryName, N extends FactoryLocalName<F>> = FactoryLocalInputProps<F, N> & FactoryRegistrationShare<F>

export type FactoryLocalComponent<F extends FactoryName, N extends FactoryLocalName<F>> = (
  props: FactoryLocalProps<F, N>,
) => ReactNode

/** 定义内部选局部组件的 hook（返回组件；父没选就用 fallback）。 */
export type UseFactorySlot<F extends FactoryName> = <N extends FactoryLocalName<F>>(
  name: N,
  fallback: FactoryLocalComponent<F, N>,
) => (props: FactoryLocalInputProps<F, N>) => ReactNode

/** Factory 定义组件收到的完整 props：occurrence 输入 + 注册面 + useFactorySlot。 */
export type FactoryComponentProps<F extends FactoryName> = FactoryInputProps<F>
  & FactoryRegistrationShare<F>
  & { useFactorySlot: UseFactorySlot<F> }

/**
 * 渲染一次 Factory occurrence：父传 occurrence 输入，`options.slots` 按本次 occurrence
 * 选局部组件（没选的位置由定义自己的 fallback 顶上）；定义缺席画 `options.fallback`。
 */
export type RenderFactorySlot = <F extends FactoryName>(
  name: F,
  props?: FactoryInputProps<F>,
  options?: {
    slots?: Partial<{ [N in FactoryLocalName<F>]: FactoryLocalComponent<F, N> }>
    fallback?: ReactNode
  },
) => ReactNode

/**
 * 槽条目组件收到的 props：owner 份额 + （chain 的）matched 份额 + 渲染能力 + 席位份额。
 *
 * 写组件时按这个别名声明 props，`register` 的约束就按它校验（拼错槽名、拿错 owner、
 * 漏声明子槽都会在调用点报错）。三个可选参数的缺省就是「无 owner / 无子槽 / 非 chain」。
 */
export type SlotComponentProps<
  Owner = Record<never, never>,
  ChildKeys extends string = never,
  Matched = never,
  Store = undefined,
> = Owner
  & ([Matched] extends [never] ? object : { matched: Matched })
  & SlotRenderApi<ChildKeys>
  & PropsStoreOf<Store>

/**
 * 浏览器壳里「组件」就是 React 组件。
 *
 * 写成 `(props: never) => ReactNode` 是刻意的（D1）：注册位的约束靠参数逆变做起——
 * 任何声明了具体 props 的组件都天然满足「props=never」这个宽形状，而真正的 props
 * 检查发生在 `register` 调用点（约束要求组件装得下组装出来的 props）。写 `any` 会把
 * 那层检查整个挡掉（这正是收窄前的问题）。
 */
export type UiComponent = (props: never) => ReactNode

/** 壳内部的槽位注册表：渲染与诊断都要用到壳的那几个能力（订阅、退位、故障表）。 */
export type UiSlots = SlotRegistry<UiComponent, SlotMap, SlotFactoryMap>

/** 插件 `apply(ui)` 拿到的那一份（核心定义 + 组件类型特化，不再手抄一遍）。 */
export type UiPluginApi = CoreUiPluginApi<UiComponent, SlotMap, SlotFactoryMap>

/** 插件 bundle 要导出的形状。 */
export type UiPlugin = UiPluginModule<UiComponent, SlotMap, SlotFactoryMap>

/**
 * 标识函数：`export default defineUiPlugin({ apply })`。
 * 作用只是让类型检查提前发现「apply 写错了」「组件类型不对」这类笔误。
 */
export function defineUiPlugin(module: UiPlugin): UiPlugin {
  return module
}

/** 宿主状态的那几个字段（快照里的 status）；宿主换形状时这里是唯一要改的地方。 */
export interface HostStatusView {
  sessionId: string | null
  model: string
  effort: string | null
  turnState: string
  usage: { inputTokens: number; outputTokens: number } | null
  contextWindow?: number
}

/**
 * 从快照里取状态字段。取不到就给 null——插件不必自己写一遍防御式解构。
 * @param snapshot - `useHostSnapshot()` 的返回值
 */
export function hostStatus(snapshot: HostSnapshot | null): HostStatusView | null {
  if (snapshot === null) return null
  const status = snapshot['status']
  if (status === null || typeof status !== 'object') return null
  const record = status as Record<string, unknown>
  const usage = record['usage']
  return {
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : null,
    model: typeof record['model'] === 'string' ? record['model'] : '',
    effort: typeof record['effort'] === 'string' ? record['effort'] : null,
    turnState: typeof record['turnState'] === 'string' ? record['turnState'] : 'unknown',
    usage:
      usage !== null && typeof usage === 'object'
        ? {
            inputTokens: Number((usage as Record<string, unknown>)['inputTokens'] ?? 0),
            outputTokens: Number((usage as Record<string, unknown>)['outputTokens'] ?? 0),
          }
        : null,
    ...(typeof record['contextWindow'] === 'number' ? { contextWindow: record['contextWindow'] } : {}),
  }
}

/**
 * ── 原生桥 ─────────────────────────────────────────────────────────────────────
 *
 * 桌面窗口里，preload 会额外挂一个 `window.dscNative`（一条极窄的原生能力通道：
 * 窗口控件区颜色、原生弹层深浅、系统对话框、通知、退出/重启…，规格见
 * `core/native-bridge.ts`，宿主与壳共用那一份）。浏览器与远程壳里**没有**这个对象——
 * 插件因此必须把"没有原生能力"当常态处理，而不是当异常。
 */

/** 桥缺席时给插件的一句话（浏览器里就是这样：没有 Electron，也就没有原生桥）。 */
export const NATIVE_UNAVAILABLE = '这条能力来自桌面外壳的原生桥，浏览器里没有它'

/** 原生桥的调用面。 */
export interface HostNative {
  /** 桥在不在：桌面窗口里 true，浏览器 / 远程壳里 false。 */
  readonly available: boolean
  /** 桥的协议版本；缺席时 null。壳拿它跟自己的规格对一下，不一致可以在诊断区说明白。 */
  readonly version: number | null
  /**
   * 调一个原生操作。
   *
   * 桥缺席时返回**拒绝的 Promise**（而不是同步抛）：调用点因此可以统一写一个 try/catch，
   * 不必先判 available 再包一层。
   */
  invoke<T = unknown>(op: NativeOp, args?: readonly unknown[]): Promise<T>
  /**
   * 订阅桥推上来的事件（现在只有终端输出流）。
   *
   * 与 `invoke` 的取向不同：桥缺席时**返回一个空的退订函数**，不抛也不拒。
   * 理由是这类订阅都写在组件的 `useEffect` 里——"浏览器里没有终端"不该让插件崩，
   * 只该让它收不到东西（订阅本身没有"失败"这个语义）。
   */
  on(event: NativeEvent, listener: (data: unknown) => void): () => void
}

/** `window.dscNative` 在页面上的形状（preload 暴露的那个对象）。 */
interface NativeBridgeGlobal {
  version?: unknown
  call?: (op: string, args: unknown[]) => Promise<unknown>
  on?: (event: string, listener: (data: unknown) => void) => () => void
}

/** 读一次全局对象；形状不对就当桥不在（宁可降级，也不要调到一个半残的对象）。 */
function bridgeGlobal(): NativeBridgeGlobal | null {
  const value = (globalThis as { dscNative?: unknown }).dscNative
  if (value === null || typeof value !== 'object') return null
  const record = value as NativeBridgeGlobal
  return typeof record.call === 'function' ? record : null
}

/**
 * 取原生桥。插件这样用：
 *
 *     const native = useHostNative()
 *     if (!native.available) return <p>这条能力只在桌面版里有</p>
 *     await native.invoke('openPath', ['D:\\dsc'])
 *
 * 每次调用都重新读一遍全局对象：自检会在同一个页面里把桥拿掉再调一次（验证降级那条路），
 * 缓存下来就把结论钉死了。读一个对象引用是常数开销，不值得为它冒这个险。
 */
export function getHostNative(): HostNative {
  const bridge = bridgeGlobal()
  const listeners = bridge?.on
  return {
    available: bridge !== null,
    version: bridge === null ? null : typeof bridge.version === 'number' ? bridge.version : NATIVE_BRIDGE_VERSION,
    invoke<T = unknown>(op: NativeOp, args: readonly unknown[] = []): Promise<T> {
      if (bridge === null) return Promise.reject(new Error(NATIVE_UNAVAILABLE))
      return bridge.call!(op, [...args]) as Promise<T>
    },
    on(event: NativeEvent, listener: (data: unknown) => void): () => void {
      if (listeners === undefined) return () => undefined
      return listeners(event, listener)
    },
  }
}

/**
 * {@link getHostNative} 的 hook 形态（桥在页面生命周期内不会出现/消失，所以取一次就够）。
 * 需要"桥回来了要重画"的场景才用它，否则直接调 `getHostNative()` 更省。
 */
export function useHostNative(): HostNative {
  return useMemo(() => getHostNative(), [])
}

/**
 * ── 外观改动的请求口（插件写、壳落地）────────────────────────────────────────────
 *
 * 为什么不让插件直接调 `applyAppearance`：那份实现的模块级状态（最近一次报出去的控件条
 * 颜色、跟随系统的监听）**只能有一份**——插件 bundle 里内联一份就会出现两个 applier
 * 各记各的状态。所以插件只说"改成这样"，落地由壳里那一份做。
 *
 * 用法与写入顺序（照旧界面的口径）：先 `requestAppearance(patch)` 让界面立刻跟手，
 * 再 `setUiPrefs(patch)` 落盘；写失败就再 `requestAppearance(原值)` 回滚。
 */
export type AppearancePatch = {
  themeMode?: 'dark' | 'light' | 'system'
  fontSize?: number
  density?: 'compact' | 'standard' | 'roomy'
}

const appearanceListeners = new Set<(patch: AppearancePatch) => void>()

/** 请求壳把外观改成这样（没有监听者时是空操作——插件单独跑时不该崩）。 */
export function requestAppearance(patch: AppearancePatch): void {
  for (const listener of appearanceListeners) listener(patch)
}

/** 壳注册外观落地函数；返回退订。 */
export function onAppearanceRequest(listener: (patch: AppearancePatch) => void): () => void {
  appearanceListeners.add(listener)
  return () => {
    appearanceListeners.delete(listener)
  }
}

/**
 * ── 右侧栏（dock：多页签面板）─────────────────────────────────────────────────
 *
 * 插件这样用：`registerDockTab` 报名自己那种页签（kind → 图标 / 标题 / 渲染组件，
 * 见 `DockTabKindMeta`），壳的页签条与页签体照它画；开合、分栏、全屏、拖拽都归壳。
 * 布局按会话走（`useDockSurface`）；打开动作走 `dockActions` / `openDockTab`。
 */
export {
  setDockPreview,
  setDockReview,
  /** 把某个子智能体的运行记录开到右侧栏（队友行、状态面板点一行都走它）。 */
  setDockSubagent,
  registerDockTab,
  dockActions,
  openDockTab,
  useActivePreviewPath,
  useDockReview,
  useDockSurface,
} from './dock-state'
export { subscribeDock, dockSurface } from './dock-state'
export type { DockReview, DockTabBodyProps, DockTabKindMeta } from './dock-state'

/**
 * ── 主区整页（插件中心这类「顶上来的整页」）────────────────────────────────────
 *
 * 页条目注册在 `shell.page` 槽里，自己读 `useShellPage()` 比对自己的 id：
 * 不是自己就返回 null。侧栏入口（或页自己的返回钮）写 `setShellPage`。
 */
export { setShellPage } from './page-state'

/** 现在顶在主区的是哪一页（订阅式；`null` = 对话页）。 */
export function useShellPage(): string | null {
  return useSyncExternalStore(subscribePage, shellPage, () => null)
}

/** 槽名常量表也从这里转出去：插件写 `SLOT.header` 比手打字符串不容易错。 */
export { SLOT, type ShellSlot } from './slots'
export { subscribePage, shellPage } from './page-state'

/**
 * ── 正文区的两张脸（对话 / 轨迹）──────────────────────────────────────────────
 *
 * 顶栏页签、会话右键的「查看轨迹」、工具行的「在轨迹中查看」药丸都往这里写；
 * 轨迹插件读 `useThreadView()` 决定画不画、读 `useTraceFocus()` 拿一次性聚焦目标。
 */
import { clearTraceFocus, openTrace, setThreadView, shellThreadView, subscribeThreadView, traceFocusStep } from './thread-view'
export { clearTraceFocus, openTrace, setThreadView, subscribeThreadView, traceFocusStep, shellThreadView }
export type { ThreadView } from './thread-view'

/** 正文区现在显示的是对话还是轨迹（订阅式）。 */
export function useThreadView(): 'chat' | 'trace' {
  return useSyncExternalStore(subscribeThreadView, shellThreadView, () => 'chat')
}

/** 待处理的聚焦目标步骤 id（没设过是 null）。消费方滚到位后调 `clearTraceFocus`。 */
export function useTraceFocus(): number | null {
  return useSyncExternalStore(subscribeThreadView, traceFocusStep, () => null)
}

/**
 * ── 读一个 CSS 变量算出来的颜色 ─────────────────────────────────────────────────
 *
 * 有些地方拿不到"令牌名"，只能拿到**算完的颜色**：xterm 的配色、桌面原生窗口控件区的
 * 两个色（要报给主进程，系统那侧只收 `#rrggbb`）。读法统一成这一处，免得每个调用点
 * 各写一份"挂个隐藏探针读 getComputedStyle 再解析"。
 */

/** 隐藏探针（零尺寸、不可见、不参与布局）；挂在 <html> 上，懒建一次。 */
let colorProbe: HTMLDivElement | undefined

/**
 * 读一个 CSS 变量在当前主题下算出来的颜色。
 *
 * @param token 变量名（含 `--`），例如 `--dsc-chrome-bar`
 * @returns `#rrggbb`；变量不存在、算出来带 alpha、或不是 sRGB 时给 null
 */
export function readCssColor(token: string): string | null {
  if (typeof document === 'undefined') return null
  if (colorProbe === undefined) {
    colorProbe = document.createElement('div')
    colorProbe.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none'
    document.documentElement.append(colorProbe)
  }
  colorProbe.style.backgroundColor = `var(${token})`
  return toHexColor(getComputedStyle(colorProbe).backgroundColor)
}

/**
 * 读一个 CSS 变量的原始文本值（要像素数、字号这类不进颜色的场合用）。
 * @param token 变量名（含 `--`）
 * @param fallback 读不出来时的回落值
 */
export function readCssValue(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return value === '' ? fallback : value
}

/**
 * 把浏览器算出来的颜色转成 `#rrggbb`。
 *
 * 同一个 `color-mix()` 令牌在不同内核版本里可能被写成 `rgb(13, 13, 15)` 或
 * `color(srgb 0.051 0.051 0.059)`，两种都要认。
 *
 * @param color getComputedStyle 读到的 background-color
 * @returns 不透明颜色的十六进制写法；带 alpha 或不是 sRGB 时给 null
 */
export function toHexColor(color: string): string | null {
  const parts = /^(rgb|color)\((.+)\)$/i.exec(color.trim())
  if (!parts) return null
  const srgb = parts[1].toLowerCase() === 'color'
  const body = srgb ? parts[2].replace(/^\s*srgb\s+/i, '') : parts[2]
  const nums = body.split(/[,/\s]+/).filter((piece) => piece !== '').map(Number)
  if (nums.length < 3 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) return null
  if (nums.length > 3 && nums[3] < 0.999) return null
  const scale = srgb ? 255 : 1
  const hex = (n: number): string =>
    Math.min(255, Math.max(0, Math.round(n * scale)))
      .toString(16)
      .padStart(2, '0')
  return `#${hex(nums[0])}${hex(nums[1])}${hex(nums[2])}`
}

export { useChannelStatus, useHostChannel, useHostError, useHostSelector, useHostSnapshot } from './runtime-context'
/**
 * 服务表的 React 订阅面（A1）：插件用它读别的插件提供的服务，并跟着服务的出现/消失
 * 换数据源（D3 的 status 面板靠它从本地轮询切到 team 的共享席位，无需刷新页面）。
 */
export { useService } from '@dsc/ui-core'
/**
 * 席位的读 hook（D3）：拿到实例后按 selector 读（实例缺席给 undefined，调用方自行回落）。
 * 席位契约类型同址转出——插件写 handle 类型、action 表都从这里拿。
 */
export { useSeat } from '@dsc/ui-core'
export { defineStore } from '@dsc/ui-core'
export type { ActionsDecl, BakedActions, PropsStoreOf, SeatInstance, SnapshotSelectorHook, StoreHandle } from '@dsc/ui-core'
export type { ChannelStatus, HostHello } from './host-channel'
export type { SlotEntry, SlotKind, UiHostInfo, UiRuntimeApi, UiSlotApi, HostSnapshot }
// 图标集原样转出去：插件 bundle 里 `import { IconPin } from '@dsc/ui'` 即可，
// 不必各自内联一份 SVG（同一枚图标在多个插件里内联，改一次要改好几处）。
export * from './icons'
// 彩色文件图标（vscode-icons 常用子集 + FileIcon 组件）与正文 token 粗估：
// 前者轮尾「文件已更改」卡 / 悬停预览 / 审查面板 / 文件树共用一份，
// 后者与宿主自动压缩同源（见 src/ui/index.ts 的说明）——都在壳里只有一份实现。
export { FileIcon, fileIconName } from './platform/file-icons'
export { estimateTextTokens } from '@dsc/ui-core'
// 文本差异算法也转出去（工具卡的「将做的改动」要用；与宿主算轮尾差异同一份实现）。
export { diffLines, type DiffResult } from '@dsc/ui-core'
/**
 * 模型能力枚举与中文标签（设置 → 模型页的思考档位 / 档位字段 / 输入模态三组勾选读它）：
 * 与宿主发请求时用的 `core/model-caps.ts` 是**同一份文件**（见 src/ui/index.ts 的说明），
 * 界面上勾的四档与线上真发的字段不会各说各话。
 */
export {
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  THINKING_PARAMS,
  THINKING_PARAM_LABELS,
  MODALITIES,
  MODALITY_LABELS,
  EFFORT_WIRE_HINT,
  DEFAULT_CAPS,
} from '@dsc/ui-core'
// 壳内置平台层转出（web 值面独有；终端壳的 @dsc/ui 不导出 DOM 组件）：
// shiki / react-markdown / pdfjs 这些重依赖只在壳 vendor 里有一份（平台模块表里
// 没有它们，插件 bundle 不许自带），插件经这里用壳的实现，实现只有一份。
export { highlightLines, langForPath, type HighlightedLine } from './platform/highlight'
export { DiffRows } from './platform/diff-rows'
export { CodeView } from './platform/code-view'
export { MarkdownView, type FsRead } from './platform/markdown'
export { PdfView } from './platform/pdf-view'
export { CsvView, XlsxView } from './platform/table-view'
// 一次性反馈与确认框（桌面端 components/toast.ts / confirm.ts 的同构移植）：
// 插件的失败不能再「静默什么都没发生」，破坏性动作动手前先过确认框。
export { toastOk, toastErr } from './platform/toast'
export { confirmAction, type ConfirmSpec } from './platform/confirm'
// 宿主视图类型原样转出去：插件按它们写渲染，宿主改字段时插件这边编不过（而不是线上画空）。
export type {
  ApprovalAnswer,
  ArchivedPage,
  ArchivedSessionView,
  ApprovalDiffView,
  ApprovalPolicy,
  ApprovalRequestView,
  AskOptionView,
  AskUserView,
  ChangedFileView,
  CollaborationMode,
  ContextSegmentsView,
  DiffHunkView,
  DiffLineView,
  EffortLevel,
  EffortMap,
  GoalView,
  ModeSurface,
  ModelChoiceView,
  ModelConfigView,
  Modality,
  PlanDecision,
  PlanView,
  PolicySurface,
  PresetDraft,
  PresetFileView,
  PresetSurface,
  PresetView,
  ProviderDraft,
  ProviderModelView,
  ProviderView,
  QueuedMessageView,
  SessionRunState,
  SessionSummary,
  SettingsField,
  SettingsGroupView,
  SettingsMutation,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  StatusView,
  SubagentCardView,
  TeammateView,
  ThemeMode,
  ThinkingLevel,
  ThinkingParam,
  TierOption,
  TodoItemView,
  TodoStatus,
  TodoView,
  TokenUsageView,
  ToolCallView,
  ToolEntryView,
  ToolStatus,
  TranscriptEntry,
  TurnEndReason,
  UiDensity,
  UiFontSize,
  UiPrefsView,
  UsageDayView,
  UsageModelView,
  UsageStatsView,
} from '@dsc/ui-core'
