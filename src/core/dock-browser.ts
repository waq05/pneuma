/**
 * dock 浏览器控制的**契约纯模块**：宿主进程（agent 所在）与桌面壳主进程共用这一份。
 *
 * 为什么单独落一个模块：这两侧在两个进程、两套编译产物里（`src/**` → `lib/`，
 * 桌面端 → `out/`），线上跑的是消息而不是函数调用。方法白名单、动作枚举、消息形状、
 * 超时预算放在一处，两侧 import 同一个常量——加一条命令时不可能只改一边。
 *
 * **这一份不许 import electron，也不许 import 任何有副作用的东西**：宿主侧那个
 * `node lib/headless.js` 的进程也要引用它，探针还要用类型擦除直读它。
 *
 * 信任模型（为什么白名单是硬性的）：dock 视图跑在 `persist:dsc-browser` 这个**持久**
 * 分区里，带着用户自己的登录态。裸 CDP 里能读 cookie、能 `Runtime.evaluate`、
 * 能导航到 `file://`——所以桌面侧对每一条命令都做白名单校验，导航参数还要重过一遍
 * 与壳相同的 http/https 闸门（见 {@link dockNavigateTarget}）。
 *
 * @module dsc/core/dock-browser
 */

/** 宿主协议版本（破坏性变更时递增）。两侧都从这里取，不再各写一份。 */
export const HOST_PROTOCOL_VERSION = 3

/**
 * 允许转发到 dock 视图的 CDP 方法。
 *
 * 收口原则：**只放 `src/core/cdp/` 那套动作与快照真正用得到的域**（Page / DOM /
 * Accessibility / Runtime / Network / Input / Emulation）。故意不放的几类：
 *   - `Target.*` / `Browser.*`：那是浏览器级命令，会打到别的 target 上（dock 视图的
 *     debugger 本来就只作用于这一页，放开它们等于越出这台视图）；
 *   - `Storage.*` / `Network.getAllCookies` 之类：直接读用户登录态；
 *   - `DOM.setFileInputFiles`：ZCode 的内嵌浏览器也明确不支持上传，这里不放。
 */
export const DOCK_CDP_COMMANDS: readonly string[] = [
  'Page.enable',
  'Page.navigate',
  'Page.reload',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.focus',
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Network.enable',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]

/** 命令白名单判定（桌面侧每条命令都过它；不在名单里直接拒，不做「尽量执行」）。 */
export function isAllowedDockCommand(method: string): boolean {
  return DOCK_CDP_COMMANDS.includes(method)
}

/**
 * 允许推给宿主的 CDP 事件。
 *
 * 与命令白名单同一条收口逻辑：只放那套动作订阅的事件（控制台 / 异常 / 对话框 /
 * 跳转 / 网络），`Target.*` 与渲染相关的高频事件一概不推。
 * 事件是**推**的，跨进程成本按条算——宿主只在真的要看了才 `*.enable`，桌面侧也只
 * 对已经挂上 debugger 的视图转发。
 */
export const DOCK_CDP_EVENTS: readonly string[] = [
  'Page.frameNavigated',
  'Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Runtime.executionContextsCleared',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
]

/** 事件白名单判定。 */
export function shouldForwardDockEvent(method: string): boolean {
  return DOCK_CDP_EVENTS.includes(method)
}

/**
 * 从一条命令里抽出「这条命令其实在导航到某个地址」那个地址，没有就返回 null。
 *
 * 为什么必须有这一步：壳那条 `browserNav` 走的是 `navigateDockBrowser`，只有 http/https
 * 能进。而 `Page.navigate` 是**绕开那道闸门**的直通车——不在这儿补一刀，agent 就能
 * 把用户那台带登录态的浏览器导到 `file://` 上去。桌面侧收到这两个方法时，
 * 一律用这个函数的返回值再过一次 {@link isHttpUrl} 同款判定。
 */
export function dockNavigateTarget(method: string, params: Record<string, unknown> | undefined): string | null {
  if (method !== 'Page.navigate') return null
  const url = params === undefined ? undefined : params['url']
  return typeof url === 'string' ? url : null
}

/** 一台 dock 视图现在的样子（`views` 动作与 `browser-views` 的回执）。 */
export interface DockViewInfo {
  /** 视图 id（壳那边就是页签 id；agent 自己开的那几张是 `agent-N`）。 */
  id: string
  url: string
  title: string
  loading: boolean
  /** 现在挂在窗口上（= 侧栏展开且这张页签是激活的那张）。藏起来的视图截不了图。 */
  visible: boolean
}

/** 一条命令的默认超时：跨进程 + 可能等页面，给得比 CDP 那层（20s）宽一点。 */
export const DOCK_CALL_TIMEOUT_MS = 25_000

/** 开一张页签（要等壳把页签建出来、把原生视图挂上）的超时。 */
export const DOCK_OPEN_TIMEOUT_MS = 8_000

/** `views`/`snapshot`/`screenshot`/`console`/`network`/`wait_for`：只看不动。 */
export const DOCK_LOOK_ACTIONS: readonly string[] = [
  'views',
  'snapshot',
  'screenshot',
  'console',
  'network',
  'wait_for',
]

/** `open`/`navigate`/`click`/`hover`/`type`/`press`/`scroll`/`evaluate`/`close`：会改页面。 */
export const DOCK_ACTIONS: readonly string[] = [
  'open',
  'navigate',
  'click',
  'hover',
  'type',
  'press',
  'scroll',
  'evaluate',
  'close',
]

/**
 * agent 自己开的那几张页签的 id 前缀。
 *
 * 为什么要有前缀：`views` 会把用户自己开的页签一起列出来（那些是同一台持久分区，
 * 地址栏里可能是他登录着的后台）。前缀让「这是 agent 开的」这件事在 id 上就看得出，
 * 审批卡与工具输出里都能直接标出来。
 */
export const DOCK_AGENT_VIEW_PREFIX = 'agent-'

/** 这张视图是不是 agent 自己开的。 */
export function isAgentView(viewId: string): boolean {
  return viewId.startsWith(DOCK_AGENT_VIEW_PREFIX)
}

// ── 线上消息（两侧的联合类型都引用这里，保证一字不差） ────────────────────────

/** runtime → host：宿主请桌面壳办事的四条请求（都带 id，等同一条应答）。 */
export type DockBrowserRequest =
  /** 在某台视图上执行一条 CDP 命令（method 过 {@link isAllowedDockCommand}）。 */
  | { type: 'browser-call'; id: number; viewId: string; method: string; params?: Record<string, unknown> }
  /** 开一张浏览器页签（并聚焦它）——`viewId` 不给时由桌面侧发号 `agent-N`。 */
  | { type: 'browser-open'; id: number; url: string; viewId?: string }
  /** 关掉一台（连带壳里那张页签一起关）。 */
  | { type: 'browser-close'; id: number; viewId: string }
  /** 列出现在活着的视图。 */
  | { type: 'browser-views'; id: number }

/** host → runtime：请求的应答（ok 为假时 error 是一句能给用户看的人话）。 */
export type DockBrowserReply =
  | { type: 'browser-result'; id: number; ok: true; value: unknown }
  | { type: 'browser-result'; id: number; ok: false; error: string }

/** host → runtime：CDP 事件推送（只推 {@link DOCK_CDP_EVENTS} 里的）。 */
export interface DockBrowserEventPush {
  type: 'browser-event'
  viewId: string
  method: string
  params: Record<string, unknown>
}

// ── 桌面壳 → 界面（壳里的页签归渲染层管，这两条走原生桥的事件面） ─────────────

/**
 * 请壳开一张浏览器页签并聚焦（`id` 由桌面侧指定，壳必须照用，否则宿主对不上号）。
 *
 * 为什么要绕渲染层：原生视图的矩形与页签的激活态都在壳里（`dockBrowser` 的 rect 由
 * 组件量出来），桌面主进程不知道侧栏现在在哪儿。ZCode 同样是「建页签顺手把右侧栏
 * 打开并激活」——我们这条走同一形状。
 */
export const DOCK_TAB_OPEN_EVENT = 'browser-tab-open-request'

/** 请壳关掉某张浏览器页签（`browser-close` 走它，免得留下一个点不开的空页签）。 */
export const DOCK_TAB_CLOSE_EVENT = 'browser-tab-close-request'
