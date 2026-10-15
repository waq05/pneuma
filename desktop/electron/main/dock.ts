/**
 * dock 基建：内置浏览器视图（WebContentsView 原生层，renderer 提供 rect）。
 * 终端（管道模式）与 git/文件能力经 dsc 宿主协议（desktop-dock 服务）。
 *
 * 2026-10 起浏览器页签可以多开，这一份就从「单例视图」变成**多视图管理器**：
 * 一台视图一个 id，壳拿页签 id 当这个 id；旧渲染层那条直连 IPC 不传 id，回落
 * `'main'`（它一直只有一台，行为一字不变）。
 *
 * 一台视图出栈要过三道门，全在这里（页面只说「哪一台、摆哪里、去哪」）：
 *   - **会话策略**：权限弹窗全拒、下载直接拦掉、不弹原生登录框——不留「网站问一句就放行」的口子；
 *   - **导航闸门**：只有 http/https 能进。壳发起的那次 `load` 在 {@link navigateDockBrowser}
 *     里校验，页面自己发起的跳转与重定向在 `will-navigate` / `will-redirect` 里拦
 *     （没有后者的话，网页能把自己带到 `file://` 上去）；
 *   - **弹窗转页签**：`window.open` / `target="_blank"` 一律 deny 原生窗，改推
 *     `browser-open-requested` 让壳开一张新页签——旧做法是就地 `loadURL` 到同一台视图，
 *     那等于把用户正在看的页面顶掉。
 *
 * 2026-10 又补了一层**CDP 执行端**（{@link sendDockCommand}）：agent 侧的宿主进程经协议
 * 请桌面主进程在某一台上执行一条 CDP 命令。住在这里而不是另起一份台账，是因为「谁可以被
 * 指名」必须与「谁真的存在」是同一个事实来源。五道闸门的顺序与理由见那个函数的注释。
 *
 * @module desktop/main/dock
 */
import { BrowserWindow, WebContentsView, app, ipcMain, type Session, type WebContents } from 'electron'
import {
  DOCK_CALL_TIMEOUT_MS,
  dockNavigateTarget,
  isAllowedDockCommand,
  shouldForwardDockEvent,
  type DockBrowserEventPush,
  type DockViewInfo,
} from '@dsc/runtime/core/dock-browser.js'

/** 壳不给 id 时回落它（旧渲染层的单例视图）。 */
const DEFAULT_BROWSER_ID = 'main'

/** 视图小到这个尺寸就不摆：页签被 `display:none` 藏起来时报上来的就是零矩形。 */
const MIN_RECT = 10

/**
 * 旧渲染层的初始页。
 *
 * 为什么留着这个常量：旧渲染层自己不发起首次导航（它只在地址栏回车时 `browserNav`），
 * 现在开视图时不再由主进程无条件 `loadURL`，所以那条路得把首页显式带进来。
 * 插件壳那条路不传，由页签自己 load（新页签是空态，对齐 dsh）。
 */
const LEGACY_HOME = 'https://www.bing.com'

interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** 浏览器视图的导航动作（与桥的规格、壳的工具条一字不差）。 */
type NavAction = 'load' | 'back' | 'forward' | 'reload'

interface BrowserGuest {
  view: WebContentsView
  /** 现在挂在窗口上没有（决定 addChildView / removeChildView）。 */
  attached: boolean
}

const guests = new Map<string, BrowserGuest>()

/** 已装过会话策略的分区（分区是共享的，装 N 遍只会叠 N 份监听）。 */
const hardened = new WeakSet<Session>()

function mainWindowRef(): BrowserWindow | null {
  return (globalThis as { __dscMainWindow?: BrowserWindow }).__dscMainWindow ?? null
}

/**
 * 内嵌浏览器的会话分区：一份**持久**分区，登录过一遍下次还认。
 *
 * 为什么不做「每个工作区一份」（dsh 的做法）：那是多用户机器的隔离取向，单用户桌面
 * 下的代价是每次启动都要重新登录。要改成那样只动这一处——把工作区路径拼进去当后缀，
 * 并把 partition 名作为实参从壳那边带过来。
 */
function browserPartition(): string {
  return 'persist:dsc-browser'
}

/** 只放行 http/https（`javascript:` / `file:` / `data:` / 带凭据的内嵌地址都不算）。 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** 一台视图的会话策略：权限弹窗全拒、下载直接拦掉。 */
function hardenSession(ses: Session): void {
  if (hardened.has(ses)) return
  hardened.add(ses)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.on('will-download', (event) => event.preventDefault())
}

/** 把这一台现在的状态推给页面（地址 / 标题 / 前后退 / 加载中，几条路都推同一条事件）。 */
function reportState(id: string, contents: WebContents): void {
  const win = mainWindowRef()
  if (win === null || win.isDestroyed()) return
  win.webContents.send('dsc:browser-state', {
    id,
    url: contents.getURL(),
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    loading: contents.isLoading(),
  })
}

/** 页面自己要开新窗口：转成事件让壳开新页签（只转 http/https，别的静默丢掉）。 */
function reportOpenRequested(id: string, url: string): void {
  const win = mainWindowRef()
  if (win === null || win.isDestroyed() || !isHttpUrl(url)) return
  win.webContents.send('dsc:browser-open-requested', { id, url })
}

/** 造一台视图：策略、闸门、状态上报一次装齐。**不加载任何地址**，加载由调用方说。 */
function createGuest(id: string): BrowserGuest {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 开发态留 devtools（要调的是网页本身），打包后不留
      devTools: !app.isPackaged,
      partition: browserPartition(),
    },
  })
  const contents = view.webContents
  hardenSession(contents.session)
  contents.setWindowOpenHandler(({ url }) => {
    reportOpenRequested(id, url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
  contents.on('login', (event) => event.preventDefault())
  const now = (): void => reportState(id, contents)
  contents.on('did-navigate', now)
  contents.on('did-navigate-in-page', now)
  contents.on('did-start-loading', now)
  contents.on('did-stop-loading', now)
  contents.on('page-title-updated', now)
  return { view, attached: false }
}

/** 取这一台的视图（没有就造一台）。`initialUrl` 只为旧渲染层那条路服务。 */
function guestFor(id: string, initialUrl?: string): BrowserGuest {
  const known = guests.get(id)
  if (known !== undefined) return known
  const created = createGuest(id)
  guests.set(id, created)
  // 建/销各记一行：一台视图带一个渲染进程，这两行是"有没有漏杀"的唯一账本
  // （自检脚本也靠它证「关页签真的销毁了」——原生层不进 DOM，拍不到）
  process.stderr.write(`[dock] browser view created: ${id}\n`)
  if (initialUrl !== undefined && isHttpUrl(initialUrl)) {
    void created.view.webContents.loadURL(initialUrl).catch(() => undefined)
  }
  return created
}

/** 从窗口上摘下来（**不销毁**：切回那个页签时页面还在）。 */
function detach(guest: BrowserGuest, win: BrowserWindow): void {
  if (!guest.attached) return
  win.contentView.removeChildView(guest.view)
  guest.attached = false
}

/**
 * dock 内置浏览器：显示/隐藏某一台 + 定位（rect 为 renderer 坐标，窗口内容坐标一致）。
 *
 * @param id 哪一台（插件壳给页签 id；旧渲染层那条 IPC 回落 `'main'`）
 * @param visible 这一台现在该不该露出来
 * @param rect 露出来时摆哪儿；藏起来时可以不给
 * @param initialUrl 只为旧渲染层留的首页（见 {@link LEGACY_HOME}）
 */
export function setDockBrowser(
  id: string,
  visible: boolean,
  rect?: BrowserRect,
  initialUrl?: string,
): boolean {
  const win = mainWindowRef()
  if (win === null) return false
  const guest = guests.get(id)
  // 隐藏 / 还没量出尺寸：只摘下来，视图留着
  if (!visible || rect === undefined || rect.width <= MIN_RECT || rect.height <= MIN_RECT) {
    if (guest !== undefined) detach(guest, win)
    return true
  }
  // 摆到窗口之外要留一行账：Chromium 会把窗口外那台视图的视口**塌成 0×0**
  // （页面 `document.hidden` 变 true、`elementFromPoint` 恒 null），于是点击落在空处、
  // 截图一片空白，而壳那边只看得到自己的 DOM 占位区——现象是「点了没反应」，成因在几何。
  // 实测踩过一次：侧栏从右缘滑入的过渡里 `getBoundingClientRect()` 带着 transform，
  // 报出来的矩形整块在窗口外（窗口 1440 宽、报 1861）。壳那边已经改成「等落定再报」，
  // 这行是它没兜住时的现场证据。
  const content = win.getContentBounds()
  if (rect.x >= content.width || rect.y >= content.height || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) {
    process.stderr.write(
      `[dock] 视图 ${id} 被摆到窗口之外（rect ${String(Math.round(rect.x))},${String(Math.round(rect.y))} ` +
        `${String(Math.round(rect.width))}x${String(Math.round(rect.height))}，窗口内容区 ${String(content.width)}x${String(content.height)}）：` +
        '它的视口会塌成 0，点击与截图都会失效\n',
    )
  }
  const target = guest ?? guestFor(id, initialUrl)
  if (!target.attached) {
    // 新挂上去的排在最上：分栏时两台北视图各占各的矩形，不重叠
    win.contentView.addChildView(target.view)
    target.attached = true
  }
  target.view.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  })
  return true
}

/**
 * 内嵌浏览器导航：load / back / forward / reload（IPC 与原生桥共用这一份实现）。
 * load 只收 http/https——页面给的地址不经这一步会被当成任意 URL 交给 Chromium。
 */
export function navigateDockBrowser(
  url: string,
  action: NavAction,
  id: string = DEFAULT_BROWSER_ID,
): { ok: boolean; url?: string; error?: string } {
  const guest = guests.get(id)
  if (guest === undefined) return { ok: false, error: '这一台浏览器视图还没起来' }
  const contents = guest.view.webContents
  if (action === 'back') contents.navigationHistory.goBack()
  else if (action === 'forward') contents.navigationHistory.goForward()
  else if (action === 'reload') contents.reload()
  else {
    if (!isHttpUrl(url)) return { ok: false, error: '仅支持 http/https' }
    void contents.loadURL(url).catch(() => undefined)
  }
  return { ok: true, url: contents.getURL() }
}

/**
 * 关掉一台（页签关了 / 切会话了）：从窗口上摘下来并**销毁**它的渲染进程。
 *
 * 为什么不能只 `setDockBrowser(id, false)`：隐藏只是摘下来，渲染进程还活着——
 * 页签开开关关一路攒下去就是一堆后台网页在吃内存。
 */
export function closeDockBrowser(id: string): void {
  const guest = guests.get(id)
  if (guest === undefined) return
  guests.delete(id)
  // 视图销毁前先摘调试器：挂着的 CDP 会话会盯着一个正在消失的 webContents
  // （disposeDockBrowsers 走的就是这条路，所以关窗时也顺手摘了）
  detachDebugger(id, guest)
  const win = mainWindowRef()
  if (win !== null && !win.isDestroyed() && guest.attached) win.contentView.removeChildView(guest.view)
  guest.view.webContents.close()
  process.stderr.write(`[dock] browser view disposed: ${id}\n`)
}

/** 关窗时把全部视图收掉（否则它们会吊到进程退出）。 */
export function disposeDockBrowsers(): void {
  for (const id of [...guests.keys()]) closeDockBrowser(id)
}

/** 注册 dock 的 IPC（内置浏览器控制；旧渲染层直连这条路，插件壳走原生桥）。 */
export function registerDockIpc(): void {
  ipcMain.handle(
    'dsc:dock-browser',
    (_event, visible: boolean, rect?: BrowserRect) => setDockBrowser(DEFAULT_BROWSER_ID, visible, rect, LEGACY_HOME),
  )
  ipcMain.handle('dsc:browser-nav', (_event, url: string, action: NavAction) => {
    return navigateDockBrowser(url, action, DEFAULT_BROWSER_ID)
  })
}

// ── CDP 执行端：agent 驱动侧栏那台浏览器 ──────────────────────────────────────
//
// 为什么这一层住在这一份里（而不是像 ZCode 那样单开一条通道）：只有这里握着 `guests`
// 台账，「谁可以被指名执行命令」与「谁真的存在」必须是同一个事实来源；另起一份台账迟早
// 会在「页签关了但那张表还记着」上分叉。也**不新开远程调试端口**：命令走已有的宿主协议
// （`desktop/electron/main/protocol.ts`），不立一个谁都能连的入口。

/** 挂 debugger 用的 CDP 版本号（`1.3` 是 Electron 44 上实测可用的那一档）。 */
const CDP_VERSION = '1.3'

/**
 * `debugger.on('message')` 的监听函数。
 *
 * 事件对象本身用不上（Electron 那两个参数是 Event 与 sessionId），第三参 `params`
 * 在 Electron 的类型里是 `any`——这里按契约收窄成对象，免得把 `any` 漏进这一层。
 */
type DebuggerMessageHandler = (event: unknown, method: string, params: Record<string, unknown>) => void

/**
 * 我们自己挂上调试器的视图：id → 那条监听函数。
 *
 * 为什么要记下监听函数的引用：`webContents.debugger` 是跟着 webContents 活的**同一个对象**，
 * 摘了再挂不会清掉旧监听——不留引用的话重挂一次就多一份转发。
 */
const debugged = new Map<string, DebuggerMessageHandler>()

/** 订了 CDP 事件推送的监听者（宿主侧的推口接在这里）。 */
const dockEventListeners = new Set<(event: DockBrowserEventPush) => void>()

/** 把 catch 到的东西说成人话（`error` 收窄成 `unknown` 之后取不出 `message`）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 现在活着的视图（`views` 动作与 `browser-views` 的回执）。
 *
 * `visible` 直接用台账里的 `attached`，不另造一份「看得见」的状态：摘下来的视图截不了图，
 * 这件事只能有一个判据，两个判据迟早会各说各话。
 */
export function dockViewList(): DockViewInfo[] {
  const list: DockViewInfo[] = []
  for (const [id, guest] of guests) {
    const contents = guest.view.webContents
    list.push({
      id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      visible: guest.attached,
    })
  }
  return list
}

/** 这一台在不在台账里（`browser-open` 等壳把页签建出来时轮询它）。 */
export function hasDockView(id: string): boolean {
  return guests.has(id)
}

/** 订 CDP 事件推送（视图上的 CDP 事件 → 宿主）；返回退订函数。 */
export function onDockEvent(listener: (event: DockBrowserEventPush) => void): () => void {
  dockEventListeners.add(listener)
  return () => {
    dockEventListeners.delete(listener)
  }
}

/**
 * 惰性挂调试器，挂上之后这台的事件才有转发。
 *
 * 为什么惰性：一条命令都没发过的视图一条事件都不该推（事件是跨进程推的，按条算成本），
 * 所以「挂了 debugger」= 「agent 碰过这一台」就是转发范围本身。
 *
 * @returns 挂不上时一句人话；挂上了（或本来就能用）给 null
 */
function attachDebugger(viewId: string, guest: BrowserGuest): string | null {
  const target = guest.view.webContents.debugger
  if (!target.isAttached()) {
    try {
      target.attach(CDP_VERSION)
    } catch (error) {
      // 最常见的一档是「别人正占着」——开发态开着 DevTools 就是这种情况，
      // 原文是英文的 Electron 报错，翻译成用户能看懂的一句。
      return `调试器挂不上（多半是 DevTools 正开着这一台）：${errorText(error)}`
    }
  }
  if (debugged.has(viewId)) return null
  const handler: DebuggerMessageHandler = (_event, method, params) => {
    // 白名单与转发范围两道都过：只推契约里列的事件，且只在真有人订的时候推
    if (!shouldForwardDockEvent(method)) return
    if (dockEventListeners.size === 0) return
    const event: DockBrowserEventPush = {
      type: 'browser-event',
      viewId,
      method,
      // CDP 事件的 params 按协议一定是对象；真拿到别的形状也只当空对象，不让推送崩掉
      params: params !== null && typeof params === 'object' ? params : {},
    }
    for (const listener of dockEventListeners) listener(event)
  }
  target.on('message', handler)
  debugged.set(viewId, handler)
  return null
}

/**
 * 摘掉调试器（视图销毁前调）。
 *
 * 只摘**我们自己挂的**那一份：DevTools 也可能正占着同一台，把人家的会话一并摘掉是越权——
 * `debugged` 里没有记录就说明这台不是我们挂的，什么都不做。
 */
function detachDebugger(viewId: string, guest: BrowserGuest): void {
  const handler = debugged.get(viewId)
  if (handler === undefined) return
  debugged.delete(viewId)
  const target = guest.view.webContents.debugger
  target.removeListener('message', handler)
  if (!target.isAttached()) return
  try {
    target.detach()
  } catch (error) {
    // 视图正要销毁，会话已经断了：这一句失败没有后果，记一行就够
    process.stderr.write(`[dock] 调试器摘除失败（${viewId}）：${errorText(error)}\n`)
  }
}

/**
 * 发一条命令并给它一个到期时刻。
 *
 * 为什么不能只等原 promise：视图没露出来那种必然挂住的情况已经在第 4 道闸门挡住了，但
 * 别的挂住（页面自己卡住）同样不该把整次工具调用拖死——到期就回一句带方法名的错。
 * Electron 没有「取消单条命令」的接口，所以那条挂着的 promise 由它自己去结束；
 * 这里只负责让调用方**现在**就能往下走。
 */
async function sendWithTimeout(
  guest: BrowserGuest,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<DockCommandResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`调试命令超时：${method}（${String(timeoutMs)}ms 没有应答）`))
    }, timeoutMs)
  })
  try {
    const value: unknown = await Promise.race([
      guest.view.webContents.debugger.sendCommand(method, params),
      expired,
    ])
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 一条 CDP 命令的结果：与协议里的 `DockBrowserReply` 两个分支同形，调用侧不再翻译一遍。 */
export type DockCommandResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * 在某一台上执行一条 CDP 命令（agent 侧的宿主进程经宿主协议请过来）。
 *
 * 五道闸门，**全部 fail-closed**（任一道不过就当场回错，不做「尽量执行」）：
 *   1. 视图必须在这份台账里。台账里只可能有 dock 视图——主窗口自己的 webContents 从来
 *      没进过这张表，所以「指名一台视图」不可能指到界面那份文档上。这是本层的安全边界。
 *   2. 方法必须过契约的白名单（`isAllowedDockCommand`）。
 *   3. `Page.navigate` 要复检地址：它是**绕开 `navigateDockBrowser` 那道闸门的直通车**，
 *      不在这儿补一刀，agent 就能把带登录态的视图导到 `file://` 上去。
 *   4. `Page.captureScreenshot` 要求这一台此刻真的露出来：实测摘下来的视图被 Chromium
 *      节流，截图会挂到超时，而挂住的那条命令会把整次工具调用拖死。
 *   5. 惰性挂调试器，然后带超时地发命令（超时同样回一句带方法名的人话）。
 *
 * @param viewId 哪一台（必须来自 {@link dockViewList}）
 * @param method CDP 方法名（白名单见 `src/core/dock-browser.ts`）
 * @param params CDP 参数
 * @param timeoutMs 等应答的上限
 */
export async function sendDockCommand(
  viewId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = DOCK_CALL_TIMEOUT_MS,
): Promise<DockCommandResult> {
  const guest = guests.get(viewId)
  if (guest === undefined) return { ok: false, error: `没有这一台浏览器视图：${viewId}` }
  if (!isAllowedDockCommand(method)) return { ok: false, error: `不允许的调试命令：${method}` }
  const navTarget = dockNavigateTarget(method, params)
  if (navTarget !== null && !isHttpUrl(navTarget)) {
    return { ok: false, error: `只允许导航到 http/https：${navTarget}` }
  }
  if (method === 'Page.captureScreenshot' && !guest.attached) {
    return {
      ok: false,
      error: '这一台现在没露出来（侧栏收着或这张页签没激活），截图会挂住；先用 open 把它开出来并聚焦',
    }
  }
  const attachProblem = attachDebugger(viewId, guest)
  if (attachProblem !== null) return { ok: false, error: attachProblem }
  return await sendWithTimeout(guest, method, params, timeoutMs)
}
