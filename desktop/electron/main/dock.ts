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
 * @module desktop/main/dock
 */
import { BrowserWindow, WebContentsView, app, ipcMain, type Session, type WebContents } from 'electron'

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
