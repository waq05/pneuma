/**
 * dsc-desktop 主进程：窗口 + headless 宿主（utilityProcess）生命周期 + IPC。
 *
 * 宿主 = Electron utilityProcess 拉起的 dsc headless 进程（base 插件集 +
 * host-stdio 协议桥的 parentPort 传输，见 dsc 的 src/plugins/host-stdio.ts）。
 * renderer 经 contextBridge 的 window.dsc 与本进程通信。
 *
 * @module desktop/main
 */
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell, utilityProcess, type UtilityProcess } from 'electron'
import type { NativeImage } from 'electron'
import { validateNativeCall, type NativeOp } from '@dsc/runtime/core/native-bridge.js'
import {
  DOCK_AGENT_VIEW_PREFIX,
  DOCK_OPEN_TIMEOUT_MS,
  DOCK_TAB_CLOSE_EVENT,
  DOCK_TAB_OPEN_EVENT,
  type DockBrowserRequest,
  type DockViewInfo,
} from '@dsc/runtime/core/dock-browser.js'
import { HostProtocol } from './protocol.js'
import {
  closeDockBrowser,
  disposeDockBrowsers,
  dockViewList,
  hasDockView,
  navigateDockBrowser,
  onDockEvent,
  registerDockIpc,
  sendDockCommand,
  setDockBrowser,
  type DockCommandResult,
} from './dock.js'
import { readState, resolveHeadlessEntry, writeState } from './dsc-core.js'
import { readSessionUsage } from './session-usage.js'
import { ensureChecked, installNow, startUpdateChecks, stopUpdateChecks } from './update.js'

let mainWindow: BrowserWindow | null = null
let protocol: HostProtocol | null = null
let quitting = false
/** 计划内重启（插件变更）时抑制 host-exit 事件，避免 renderer 误报崩溃。 */
let suppressHostExit = false

/** 当前宿主工作目录（会话 cwd；desktop.json 记忆）。 */
let hostCwd = ''

/** 原生窗口控件区的高度：renderer 的窗口控件条（caption-bar）是 36px，多给 2px 让按钮命中区不裁边。 */
const CAPTION_HEIGHT = 38
/**
 * 主题三档。`system` 在读档时按当前系统深浅解析成 dark / light——窗口与启动页
 * 只认一个确定值。
 */
type UiTheme = 'dark' | 'light' | 'claude'

/**
 * 三档主题的页面底色、控件区符号色与强调色。
 *
 * 数值取自 `ui-shell/src/legacy/tokens.css` 里 `--dsc-bg-page` / `--dsc-chrome-symbol` /
 * `--dsc-accent` 算出来的实际值：窗口在 renderer 报来真颜色之前先按它上色，开窗那一帧
 * 才不会和界面差一个色号。浅色与米白这两档以前没有（只有一份深色的 `DARK_CHROME`），
 * 所以选浅色主题的人每次开窗都先看见一块深色。
 */
const THEME_PAINT: Readonly<Record<UiTheme, { page: string; symbol: string; accent: string }>> = {
  dark: { page: '#151517', symbol: '#b7babf', accent: '#5686fe' },
  light: { page: '#f8f9fe', symbol: '#515154', accent: '#0053fd' },
  claude: { page: '#faf9f5', symbol: '#504d48', accent: '#d97757' },
}

/**
 * 当前窗口主题：读 `settings.json` 的 `ui.themeMode`，`system` 按系统深浅解析。
 *
 * 为什么要主进程自己读一遍：窗口底色、控件区、启动页这三样必须在**第一帧之前**定下，
 * 而壳要到界面脚本跑起来才知道主题（`getUiPrefs` 还是异步的）。读不到就按系统深浅起步，
 * 界面随后会把真颜色推过来。
 */
/**
 * 主进程眼里的 `settings.json`：**和宿主同一份**。
 *
 * 为什么不能只认 `app.getPath('home')`：那个路径走系统账号目录，不认 `USERPROFILE` /
 * `HOME` / `DSC_HOME`，而宿主（node 进程）按环境变量解析。重定向过 HOME 的场合
 * （自检、隔离账户、把配置放到别盘）主进程会读到另一份文件——主题和面板几何于是
 * 和界面里显示的对不上。`DSC_HOME` 是宿主那边既有的开关，这里跟着它走。
 */
function settingsPath(): string {
  const home = process.env.DSC_HOME
  if (home !== undefined && home !== '') return join(home, 'settings.json')
  return join(app.getPath('home'), '.dsc', 'settings.json')
}

function readUiTheme(): UiTheme {
  try {
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      ui?: { themeMode?: unknown }
    }
    const mode = doc.ui?.themeMode
    if (mode === 'dark' || mode === 'light' || mode === 'claude') return mode
  } catch {
    // 首次运行没有 settings.json，或文件坏了：按系统深浅起步即可
  }
  // 没配过 / 文件坏了：跟宿主的出厂默认走（claude 暖米白），不再按系统深浅起步——
  // 出厂默认既然定了 claude，第一帧就该是 claude，否则未选过主题的用户每次开窗都先闪一下深色。
  return 'claude'
}

/**
 * 面板几何从地址里带一份：`panels=sidebar:320,dock:640,collapsed:1`。
 *
 * 为什么不只靠壳启动时那次 `getUiPrefs`：宿主冷启动时数据通道还没连上，那次调用可能
 * 超过壳给的 1.5 秒期限，于是首帧画成默认宽、用户看到的就是「又回默认了」。主进程读的
 * 是同一份 settings.json，同步就能拿到，首帧不必再赌一次网络往返。
 *
 * 坏值一律丢掉：壳那边还会按各自的区间再挡一次，这里不夹取（夹出来的宽度用户没选过）。
 * 没配过 / 文件坏了就给空串，壳照旧走它自己那条路。
 *
 * @returns 拼进 query 的那一段，或空串
 */
function readPanelQuery(): string {
  try {
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      ui?: { panelWidths?: Record<string, unknown> }
    }
    const widths = doc.ui?.panelWidths
    if (widths === undefined || widths === null) return ''
    const parts: string[] = []
    for (const key of ['sidebar', 'thread', 'dock', 'diff'] as const) {
      const px = widths[key]
      if (typeof px !== 'number' || !Number.isFinite(px)) continue
      parts.push(`${key}:${String(Math.round(px))}`)
    }
    if (widths['collapsed'] === true) parts.push('collapsed:1')
    return parts.length === 0 ? '' : `panels=${parts.join(',')}`
  } catch {
    return ''
  }
}

/** 能否交给系统给窗口控件着色：只收 #rrggbb，半透明颜色到了那侧会被丢掉。 */
function isChromeColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

// ── 宿主生命周期 ──────────────────────────────────────────────────────────────

/**
 * 插件壳产物目录：`pnpm -C ui-shell build` 写出的静态产物。
 *
 * 两态路径不同源：开发态在仓库的 `lib/ui/assets`；打包态在 extraResources 的
 * `dsc-core/lib/ui/assets`——`scripts/prepare-runtime.mjs` 把整个 `lib/` 复制进
 * dsc-core，壳产物跟着走，所以它在 asar 之外（与宿主从同一处读 `lib/ui/plugins` 一致）。
 */
function shellDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'dsc-core', 'lib', 'ui', 'assets')
    : join(__dirname, '..', '..', '..', 'lib', 'ui', 'assets')
}

/**
 * 界面形态只剩一种：**插件壳**。
 *
 * 2026-10-28 删掉旧渲染层（21,035 行）之后，"伺服哪份界面"这个问题不再有第二个答案。
 * 档案里写 `ui: 'legacy'`、或设了 `DSC_UI_SHELL=0` 的老配置仍然照常启动，只打一条
 * 说明——老配置不该让应用起不来，也不该让人以为还有另一份界面可以切。
 */
function uiProfile(): 'shell' {
  if (process.env['DSC_UI_SHELL'] === '0' || readState().ui === 'legacy') {
    process.stderr.write('[dsc-desktop] 旧渲染层已移除，"legacy" 设置不再有效，改用插件壳\n')
  }
  return 'shell'
}

// ── 启动画面与失败页 ──────────────────────────────────────────────────────────

/**
 * 启动过渡页：窗口显示的第一帧。
 *
 * 为什么需要它：宿主要两秒上下才报出界面地址，这段时间原来挂的是那张「界面还没构建出来」
 * 的兜底页——提示成了每次启动的必经画面（2026-10-28 报障）。过渡页只管一件事：让用户
 * 看见「在启动」，底色跟着主题走。
 *
 * 版式与壳页面里的占位（`ui-shell/index.html` 的 `#boot-splash`）**逐像素同款**：
 * 换文档那一刻占位还在原处，界面渲染出来才把占位顶掉——所以这一跳看不见。
 * 改这里记得同步那一份。
 *
 * @param theme - 当前窗口主题（决定底色与强调色）
 */
function splashHtml(theme: UiTheme): string {
  const paint = THEME_PAINT[theme]
  const ink = theme === 'dark' ? '255,255,255' : '0,0,0'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Pneuma</title><style>
:root{color-scheme:${theme === 'dark' ? 'dark' : 'light'}}
html,body{height:100%}
body{margin:0;display:flex;align-items:center;justify-content:center;background:${paint.page};
  font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.splash{display:flex;flex-direction:column;align-items:center;gap:18px}
.name{font-size:15px;letter-spacing:.18em;text-transform:uppercase;color:rgba(${ink},.72)}
.track{width:132px;height:2px;border-radius:2px;overflow:hidden;background:rgba(${ink},.12)}
.track span{display:block;width:38%;height:100%;border-radius:2px;background:${paint.accent};
  animation:slide 1.15s cubic-bezier(.45,0,.55,1) infinite}
.hint{font-size:12px;letter-spacing:.04em;color:rgba(${ink},.45)}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(360%)}}
@media (prefers-reduced-motion: reduce){.track span{animation:none;width:100%;opacity:.5}}
</style></head><body><div class="splash"><div class="name">Pneuma</div><div class="track"><span></span></div><div class="hint">正在启动…</div></div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** 启动失败的三条真实原因——只有它们会出提示页。 */
type FailureKind = 'no-assets' | 'host-timeout' | 'host-exit'

/**
 * 真失败时的提示页（data URL，不依赖任何构建产物）。
 *
 * 这一页原来叫 `missingUiHtml`，并且被当成了窗口首屏：宿主还没报地址就先加载它，
 * 于是每次启动都要看一秒「界面还没构建出来」。现在只有三条路走到这里——
 * 产物目录真不存在、宿主超时没起来、宿主启动途中退出。
 *
 * 为什么不像以前那样把原因拼成一句话：这三种失败用户要做的事不一样（重建 / 看日志 /
 * 还原配置），标题与步骤分开写才不至于让人拿着一句「没连上」去猜。
 *
 * @param kind - 失败原因（决定标题与步骤）
 * @param detail - 补充说明（例如退出码）
 */
function failureHtml(kind: FailureKind, detail = ''): string {
  const tail = detail === '' ? '' : `（${detail}）`
  const head =
    kind === 'no-assets'
      ? { title: '界面还没构建出来', reason: `没找到界面产物（${shellDir()}）。` }
      : kind === 'host-exit'
        ? { title: '宿主进程退出了', reason: `后台的内核进程启动途中退出了${tail}，界面没能连上。` }
        : { title: '宿主没在 15 秒内起来', reason: `内核进程没有报出界面地址${tail}。` }
  const steps =
    kind === 'no-assets'
      ? ['在仓库根跑 <code>pnpm build</code>', '再跑 <code>pnpm -C ui-shell build</code>（界面壳产物落到 <code>lib/ui/assets</code>）', '然后重开这个窗口']
      : ['先看 <code>~/.dsc/logs</code> 里的宿主日志', '重开这个窗口再试一次', '改过 <code>config.yaml</code> 就先还原再启动']
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Pneuma · 启动失败</title><style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  background:#17181a;color:#e6e6e6;font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.card{max-width:560px;padding:32px 36px;border:1px solid #2c2e33;border-radius:12px;background:#1e2024}
h1{margin:0 0 12px;font-size:17px;font-weight:600}
p{margin:0 0 10px;color:#a8adb6}
code{background:#2a2d33;padding:2px 6px;border-radius:4px;color:#d9dde4;font-size:13px}
ol{margin:12px 0 0;padding-left:20px;color:#a8adb6}
li{margin:4px 0}
</style></head><body><div class="card">
<h1>${head.title}</h1>
<p>${head.reason}</p>
<ol>${steps.map((step) => `<li>${step}</li>`).join('')}</ol>
<p style="margin-top:14px">宿主日志在 <code>~/.dsc/logs</code>；装出来打不开时先看那里。</p>
</div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/**
 * 宿主该伺服的界面产物目录（经 `DSC_UI_ASSETS` 交给宿主进程）。
 *
 * 产物缺失时**照样**把这个路径给宿主（伺服到的是 404），而不是退回别的目录：
 * 窗口那边会落到 {@link failureHtml}（no-assets）那张提示页，说清缺什么、怎么补。
 */
function uiAssetsDir(): string {
  const dir = shellDir()
  if (!existsSync(dir)) {
    process.stderr.write(`[dsc-desktop] 插件壳产物不存在（${dir}），窗口会显示"界面没构建"提示页\n`)
  }
  return dir
}

/** 传给宿主进程的环境：Electron 的 env 只收字符串值，undefined 的键直接丢掉。 */
function hostEnv(assetsDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value
  }
  out['DSC_UI_ASSETS'] = assetsDir
  return out
}

/**
 * 宿主界面服务的地址：`origin` 这一份已经认证过（会话 Cookie 落在 Electron 的 session 上），
 * 可以拿来加载窗口。宿主每次启动都是新端口 + 新令牌，所以这里存的是「最近一次」。
 */
let uiServerOrigin: string | null = null
/** 窗口是否已经切到宿主伺服的那份文档（切过一次就不再重载，免得刷掉界面状态）。 */
let servedPageLoaded = false

/**
 * 启动已经判失败（提示页已上屏）。
 *
 * 为什么要记下来：产物缺失时宿主照样能起来、照样报界面地址，但伺服的是 404——
 * 放它进来会把提示页顶成一张白底 404（2026-10-28 实测）。判失败之后这一辈子不再接
 * 宿主的界面地址；用户重建产物后重开窗口会走「已有地址」那条路，不用重启应用。
 */
let bootFailed = false

/** 启动耗时基准：自检日志里启动期那几行带一个 `+NNNms`，排查「启动慢」时不用再猜。 */
const bootStart = Date.now()

/** 启动期读数（带耗时前缀）。平时的读数仍走 {@link selfcheckNote}，格式不变。 */
function bootNote(line: string): void {
  selfcheckNote(`[+${String(Date.now() - bootStart)}ms] ${line}\n`)
}

/** 等宿主报界面地址的上限。超了就认定启动失败——这是真失败，不是「还没好」。 */
const UI_WAIT_MS = 15_000

/** 看门狗：只盯「宿主一直没报地址」这一种情况，地址到了就拆掉。 */
let uiWaitTimer: ReturnType<typeof setTimeout> | null = null

function cancelUiWait(): void {
  if (uiWaitTimer === null) return
  clearTimeout(uiWaitTimer)
  uiWaitTimer = null
}

function armUiWait(): void {
  cancelUiWait()
  uiWaitTimer = setTimeout(() => {
    uiWaitTimer = null
    if (servedPageLoaded || quitting) return
    showFailurePage('host-timeout')
  }, UI_WAIT_MS)
}

/**
 * 换失败页，并确保窗口可见（窗口在首帧画出来之前一直是隐着的）。
 *
 * 只管「真失败」：调用点只有三处——产物目录不存在、等宿主超时、宿主启动途中退出。
 */
function showFailurePage(kind: FailureKind, detail = ''): void {
  cancelUiWait()
  bootFailed = true
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  bootNote(`启动失败（${kind}${detail === '' ? '' : `：${detail}`}），改为显示提示页`)
  // 不在这里 show()：窗口在首帧画出来之前是隐着的，提前显示等于给用户看一块空白——
  // 交给 createWindow 里那个 ready-to-show。它只在「这一页是窗口的第一份文档」时起作用，
  // 而失败发生在启动中途时窗口早已显示，不用再管。
  void window.loadURL(failureHtml(kind, detail))
}

/**
 * 用一次性令牌换会话 Cookie：宿主那条带 `?token=` 的地址只能换一次，换到的是
 * HttpOnly 会话 Cookie——令牌因此不必留在窗口地址里（历史记录、Referer 都带不走它）。
 * @param url - 宿主给的入口地址（带令牌）
 * @returns 拿到 Cookie 就是 true；令牌过期/已用/服务不可达都是 false
 */
async function authenticateUiServer(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual' })
    const cookie = response.headers.get('set-cookie')
    await response.body?.cancel()
    // 状态码别钉死：换票成功是 303（303 与 302 都认）。这里原来写 `!== 302`，
    // 服务端按 HTTP 语义把 302 改成 303 之后，桌面就静默回落到本机文件加载了。
    const redirected = response.status === 303 || response.status === 302
    if (!redirected || cookie === null) return false
    const pair = cookie.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) return false
    const origin = new URL(url).origin
    await session.defaultSession.cookies.set({
      url: origin,
      name: pair.slice(0, index),
      value: pair.slice(index + 1),
      httpOnly: true,
      sameSite: 'strict',
    })
    return true
  } catch (error) {
    process.stderr.write(`[dsc-desktop] 界面服务认证失败：${String(error)}\n`)
    return false
  }
}

/**
 * 接收宿主报来的界面地址：认证一次、记下根地址，然后把窗口切到那份文档。
 *
 * 首次启动之外还有一种必须重载的情形：**宿主重启换了一个源**（切工作目录 / 重启宿主
 * 都会重启宿主进程，端口随之变）。壳页面的数据全走这个源的 HTTP（SSE 推帧 +
 * `/api/invoke` 调方法），不重载就钉死在旧端口上——界面看着还在、点什么都不动。
 * 旧渲染层不同：它的数据走 IPC（主进程换个协议对象即可），重载反而会把打开的会话与
 * 草稿刷掉，所以那一档保持「只换 Cookie 不重载」（与下面这段老注释同一条理由）。
 */
async function adoptUiServer(info: { url: string; origin: string }): Promise<void> {
  const ok = await authenticateUiServer(info.url)
  if (!ok) {
    process.stderr.write('[dsc-desktop] 界面地址认证失败，窗口继续用本机文件加载\n')
    return
  }
  const previous = uiServerOrigin
  uiServerOrigin = info.origin
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  // 开发模式下页面来自 vite，别把窗口抢过去。
  if ((process.env.ELECTRON_RENDERER_URL ?? '') !== '') return
  // 已经判过失败：这一窗就是提示页，别让 404 顶掉它（见 bootFailed 的说明）。
  if (bootFailed) return
  const restarted = servedPageLoaded && previous !== info.origin
  if (servedPageLoaded && !restarted) return
  servedPageLoaded = true
  cancelUiWait()
  bootNote(
    `[dsc-desktop] 窗口来自宿主界面服务 ${info.origin}${restarted ? '（宿主重启，窗口重新加载）' : ''}`,
  )
  void window.loadURL(desktopPageUrl())
}

/**
 * 拼给页面的 query：自检参数 + 主题。
 *
 * `theme` 是给壳的**首帧底色**用的（`ui-shell/index.html` 里那段引导脚本读它）：
 * 页面 CSS 到位之前画布得先是对的颜色，否则从过渡页换过来会闪一帧白。dev server 与
 * 宿主伺服两条路共用同一份，省得只给一条路带参数。
 */
function pageQuery(): string {
  return [
    process.env.DSC_DESKTOP_DEMO === '1' ? 'demo=1' : '',
    process.env.DSC_DESKTOP_SEARCH ?? '',
    // 自检要看的壳侧参数（例如 diag=1 让诊断区常显——它的 DOM 是自检的读数面）。
    process.env.DSC_UI_QUERY ?? '',
    `theme=${readUiTheme()}`,
    // 面板宽度也这么带：宿主冷启动时壳那次 getUiPrefs 可能还没回来，首帧先按这份画。
    readPanelQuery(),
  ]
    .filter((part) => part !== '')
    .join('&')
}

/** 窗口该加载的地址：宿主伺服的那一份（带 query）。 */
function desktopPageUrl(): string {
  return `${uiServerOrigin ?? ''}/?${pageQuery()}`
}

/** 启动 headless 宿主（utilityProcess；入口为应用自有编译产物，无用户输入）。 */
function startHost(cwd: string): void {
  hostCwd = cwd
  const entry = resolveHeadlessEntry()
  const assetsDir = uiAssetsDir()
  // 这一行是「界面形态」的唯一可观测信号：切换期验收看读数（stderr，打包态看
  // DSC_DESKTOP_SELFCHECK_LOG 那份文件），不看绿不绿
  // （阶段 93 的教训——认证回落会把「没切过去」藏在一路绿灯里）。
  selfcheckNote(
    `[dsc-desktop] 界面形态=${uiProfile()}，宿主伺服 ${assetsDir}（产物存在=${existsSync(assetsDir)}）\n`,
  )
  protocol = new HostProtocol(entry, cwd, hostEnv(assetsDir))

  protocol.onSnapshot((snapshot) => {
    mainWindow?.webContents.send('dsc:snapshot', snapshot)
  })
  protocol.onUi((action) => {
    mainWindow?.webContents.send('dsc:ui', action)
  })
  protocol.onDockData((data) => {
    mainWindow?.webContents.send('dsc:dock-data', data)
  })
  // 宿主那四条浏览器请求（反方向：它请桌面办事）。应答由 answerBrowserRequest 按
  // 请求里的 id 回带，桌面这一侧不记表（记账在宿主那侧，见 protocol.ts 的注释）。
  protocol.onBrowserRequest((request) => {
    answerBrowserRequest(request)
  })
  protocol.onUiUrl((info) => {
    process.stderr.write(`[dsc-desktop] 宿主报来界面地址 ${info.origin}（窗口${mainWindow === null ? '未就绪' : '在'}）\n`)
    void adoptUiServer(info)
  })
  protocol.onClose(({ code }) => {
    const silent = suppressHostExit
    suppressHostExit = false
    protocol = null
    if (quitting || silent) return
    // 界面还没切到宿主伺服的那份文档就退出去了：这是启动失败，不是运行中崩溃。
    // 两条路要做的事不同（这条给提示页，那条让壳显示「连接断开」），不能混。
    if (!servedPageLoaded) {
      showFailurePage('host-exit', `退出码 ${String(code)}`)
      return
    }
    mainWindow?.webContents.send('dsc:host-exit', { code })
  })
}

function stopHost(onDone?: () => void, { silent = false } = {}): void {
  const current = protocol
  if (current === null) {
    onDone?.()
    return
  }
  suppressHostExit = silent
  const timeout = setTimeout(() => current.kill(), 2000)
  current.exitGracefully(() => {
    clearTimeout(timeout)
    protocol = null
    onDone?.()
  })
}

// ── 宿主请桌面办的浏览器请求 ──────────────────────────────────────────────────
// 四条：call（在某台上跑一条 CDP 命令）、open（开一张页签并聚焦）、close（关一台）、
// views（列现在活着的视图）。应答一律回 `browser-result`，id 照抄宿主发来的那个。

/** 开页签之后轮询台账的间隔：壳那边是渲染层量完矩形才建视图，几十毫秒起步。 */
const VIEW_POLL_MS = 50

/** 本进程给 agent 页签发号的序号（宿主不给 id 时用它，形如 `agent-1`）。 */
let agentViewSeq = 0

/**
 * 页签事件在渲染层里的**频道名**。
 *
 * 为什么要拼这个前缀：壳的订阅口是原生桥的 `dscNative.on`，而 preload 那边按
 * `dsc:${事件名}` 组频道名（见 `desktop/electron/preload/index.ts`）。白名单名与频道名
 * 差着这个前缀，省掉它壳就一条事件都收不到。
 */
function tabEventChannel(eventName: string): string {
  return `dsc:${eventName}`
}

/** 发一个新号；跳过台账里已经占着的（撞上了会把别人那张页签的视图顶掉）。 */
function nextAgentViewId(): string {
  let candidate = ''
  do {
    agentViewSeq += 1
    candidate = `${DOCK_AGENT_VIEW_PREFIX}${String(agentViewSeq)}`
  } while (hasDockView(candidate))
  return candidate
}

/**
 * 答一条宿主请求。
 *
 * 为什么要 catch 兜底：请求的处理里有一条 promise 链（等页签挂上来），任何一处没接住的
 * 异常都该翻成一句人话回过去——宿主那侧有超时，别让它为我们的 bug 干等一场。
 */
function answerBrowserRequest(request: DockBrowserRequest): void {
  handleBrowserRequest(request)
    .then((result) => {
      protocol?.browserResult(request.id, result)
    })
    .catch((error: unknown) => {
      protocol?.browserResult(request.id, { ok: false, error: `桌面侧处理出错：${String(error)}` })
    })
}

/** 把一条请求派到具体实现上（四条各一个分支）。 */
async function handleBrowserRequest(request: DockBrowserRequest): Promise<DockCommandResult> {
  if (request.type === 'browser-call') {
    return await sendDockCommand(request.viewId, request.method, request.params)
  }
  if (request.type === 'browser-views') {
    return { ok: true, value: dockViewList() }
  }
  if (request.type === 'browser-close') {
    return closeBrowserTab(request.viewId)
  }
  return await openBrowserTab(request)
}

/**
 * 关一台：**优先让壳去关**（它那张页签也要跟着消失，否则侧栏会留一个点不开的空页签）。
 *
 * 发出事件之后**这里不再销毁视图**：销毁是壳里那张页签卸载时发 `browserClose`（原生桥）
 * 的事。两边都动手会重复销毁——同一台会在日志里出现两条 `browser view disposed`，
 * 而第二次拿到的是已经关掉的 webContents。
 *
 * 壳不在（窗口已关）才直接销毁：那时没有人会替我们发 `browserClose`，
 * 视图留着只会吊到进程退出。
 */
function closeBrowserTab(viewId: string): DockCommandResult {
  const window = mainWindow
  if (window === null || window.isDestroyed()) {
    closeDockBrowser(viewId)
  } else {
    window.webContents.send(tabEventChannel(DOCK_TAB_CLOSE_EVENT), { id: viewId })
  }
  return { ok: true, value: { closed: true } }
}

/**
 * 开一张页签并**等它真的挂上**。
 *
 * 为什么必须等（不是「通知发出去就算开好了」）：调用方紧接着就要点击或截图，而摘下来的
 * 视图被 Chromium 节流、截图会挂到超时（实测），所以回执要带「这一刻露出来了」这个事实。
 * 页签只能由壳建（原生视图的矩形只有渲染层量得出来），所以这里发号 + 等台账变真。
 *
 * 桌面窗口不在就报错：没有壳，页签没人建，等下去只会等到超时。超时这条**不只一种原因**，
 * 文案里两种都说清楚——桌面侧分不清「旧渲染层不认这条通路」与「界面收着没量出矩形」，
 * 从台账看它们一模一样（见 {@link waitForDockView} 的超时分支）。
 */
async function openBrowserTab(request: { url: string; viewId?: string }): Promise<DockCommandResult> {
  const window = mainWindow
  if (window === null || window.isDestroyed()) return { ok: false, error: '桌面窗口不在，开不了页签' }
  const viewId = request.viewId ?? nextAgentViewId()
  window.webContents.send(tabEventChannel(DOCK_TAB_OPEN_EVENT), { id: viewId, url: request.url })
  const view = await waitForDockView(viewId, DOCK_OPEN_TIMEOUT_MS)
  if (view === null) {
    return {
      ok: false,
      // 只有插件壳会订阅这条事件：旧渲染层（档案 `ui: 'legacy'` / `DSC_UI_SHELL=0`）根本不认，
      // 所以超时最常见的原因是界面形态而不是「壳卡了」；第二种是壳收到了但视图没量出矩形
      // （侧栏收着或窗口隐藏着，渲染层报零矩形）。两种情况在台账上分不出来，只能一起说。
      error:
        `壳没接住开页签的请求（${String(DOCK_OPEN_TIMEOUT_MS)}ms 内没等到视图 ${viewId}）：` +
        '当前界面是旧渲染层时不支持这条通路（插件壳才有）；也可能界面被隐藏了',
    }
  }
  return {
    ok: true,
    // attached 取这一刻的视图状态：台帐里的 `visible` 就是 dock.ts 的 `guest.attached`，
    // 两边是同一个事实。url 取视图上的真实地址，页面还没开始加载时回落到请求里那个。
    value: { viewId, attached: view.visible, url: view.url === '' ? request.url : view.url },
  }
}

/**
 * 等一台视图进台账（壳收到事件之后才会建它）。
 *
 * 为什么用轮询而不是等一条回执：壳那条路是渲染层的状态 + 重排（量完矩形才调
 * `setDockBrowser`），桌面主进程没有它那边的 promise 可等；台账变真这件事本身就是
 * 「原生视图真的挂上了」的信号。
 */
async function waitForDockView(viewId: string, timeoutMs: number): Promise<DockViewInfo | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (hasDockView(viewId)) {
      const found = dockViewList().find((view) => view.id === viewId)
      if (found !== undefined) return found
    }
    if (Date.now() >= deadline) return null
    await new Promise<void>((resolve) => {
      setTimeout(resolve, VIEW_POLL_MS)
    })
  }
}

// ── 系统托盘与退出 ────────────────────────────────────────────────────────────

let tray: Tray | null = null

/**
 * 关窗是缩托盘还是直接退出：现读 `~/.dsc/settings.json` 的 closeToTray（与宿主
 * 的 core/prefs.ts 同一个文件），所以设置里改完开关不用重启就生效。
 */
function closeToTrayEnabled(): boolean {
  try {
    const doc = JSON.parse(
      readFileSync(join(app.getPath('home'), '.dsc', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>
    return doc.closeToTray !== false
  } catch {
    return true
  }
}

/**
 * 托盘图标：打包后从 resources 取，dev 从 desktop/build 取。
 *
 * 托盘会把它缩到 16px，主图标（512px 水墨人像）缩到这个尺寸只剩一团灰，
 * 所以单独准备 build/icon-tray.png（只裁头部、压成实墨剪影的 32px 版）。
 * 该文件缺失时回退到主图标，保证托盘永远不会没图标。
 */
function trayIcon(): NativeImage {
  const dir = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'build')
  const file = [join(dir, 'icon-tray.png'), join(dir, 'icon.png')].find((p) => existsSync(p))
  const image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty()
  if (image.isEmpty()) {
    const why = file ? (existsSync(file) ? '解码失败' : '文件不存在') : `目录下没有图标文件（${dir}）`
    process.stderr.write(`[dsc] 托盘图标加载失败（${file ?? dir} ${why}），托盘将没有图标\n`)
    return image
  }
  return image.getSize().width > 32 ? image.resize({ width: 16, height: 16 }) : image
}

/** 托盘图标懒创建：只有真要缩到托盘时才需要它。 */
function ensureTray(): Tray {
  if (tray !== null) return tray
  const created = new Tray(trayIcon())
  created.setToolTip('Pneuma — 点我回到窗口')
  created.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '完全退出', click: () => quitApp() },
    ]),
  )
  created.on('click', () => showMainWindow())
  created.on('double-click', () => showMainWindow())
  tray = created
  return created
}

function showMainWindow(): void {
  if (mainWindow === null) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 退出：先让宿主收尾（超时 2 秒强杀），再 app.quit。关窗与托盘菜单共用这条路径。 */
function quitApp(): void {
  quitting = true
  stopUpdateChecks()
  stopHost(() => {
    tray?.destroy()
    tray = null
    app.quit()
  })
}

/** 切换工作目录：停旧宿主 → 以新 cwd 重启（快照清空由宿主侧初始会话保证）。 */
function restartHost(cwd: string): Promise<void> {
  return new Promise((resolveDone) => {
    stopHost(
      () => {
        startHost(cwd)
        // 顺手记一份「最近用过」清单（侧栏切换工作区菜单的数据源），最新的排最前
        const recent = [cwd, ...(readState().recentCwds ?? []).filter((entry) => entry !== cwd)].slice(0, 12)
        writeState({ lastCwd: cwd, recentCwds: recent })
        resolveDone()
      },
      { silent: true },
    )
  })
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** 一次「打开工作区」的结果：失败时带一句能直接看的原因。 */
type WorkspaceOpenResult = { ok: boolean; error?: string }

/**
 * 用多种方式打开一个工作区。terminal：优先 Windows Terminal，没装退回经
 * PowerShell 指定工作目录的 cmd；vscode：借 cmd.exe 调 code 垫片（Node 直接
 * spawn .cmd 会被拦）；explorer：shell.openPath。
 *
 * **打开哪个目录**：`requested` 给了就用它（插件壳传的是它显示的那个当前工作区 =
 * 当前会话的 cwd），没给才回到 `hostCwd`（宿主进程的启动目录）——旧渲染层不传，
 * 行为不变。常驻多会话模型下会话各有各的 cwd，启动目录往往不是用户眼里的当前工作区。
 */
function openWorkspace(kind: string, requested?: string): WorkspaceOpenResult | Promise<WorkspaceOpenResult> {
  const dir = requested === undefined || requested === '' ? hostCwd : requested
  if (dir === '' || !existsSync(dir)) {
    return { ok: false, error: `工作目录不存在：${dir}` }
  }
  if (kind === 'explorer') {
    return shell.openPath(dir).then((problem) => (problem === '' ? { ok: true } : { ok: false, error: problem }))
  }
  if (kind === 'terminal') {
    return new Promise((resolveOpen) => {
      // 没装 Windows Terminal（wt.exe）时退回经典 cmd：
      // 经 PowerShell 的 Start-Process 指定工作目录，避免 cmd start 的转义泥潭。
      const viaCmd = (): void => {
        const psQuote = dir.replace(/'/g, "''")
        const fallback = spawn(
          'powershell.exe',
          ['-NoProfile', '-Command', `Start-Process cmd -WorkingDirectory '${psQuote}'`],
          { stdio: 'ignore' },
        )
        fallback.on('error', (error) => resolveOpen({ ok: false, error: String(error) }))
        fallback.on('close', () => resolveOpen({ ok: true }))
      }
      const child = spawn('wt.exe', ['-d', dir], { stdio: 'ignore' })
      child.on('error', viaCmd)
      child.on('close', () => resolveOpen({ ok: true }))
    })
  }
  if (kind === 'vscode') {
    return new Promise((resolveOpen) => {
      const child = spawn('cmd.exe', ['/d', '/c', 'code', dir], { stdio: 'ignore' })
      child.on('error', () => resolveOpen({ ok: false, error: '启动 cmd 失败' }))
      child.on('close', (codeNum) => {
        if (codeNum === 0) {
          resolveOpen({ ok: true })
        } else {
          resolveOpen({ ok: false, error: `没找到 code 命令（退出码 ${String(codeNum)}）：VS Code 可能没装，或没把 CLI 加进 PATH` })
        }
      })
    })
  }
  return { ok: false, error: `未知的打开方式：${kind}` }
}

// 选择 .js 插件文件并复制到 ~/.dsc/plugins/；返回复制的文件名（取消返回 []）。
// 抽成具名函数：旧渲染层的 IPC 与插件壳的原生桥走同一条路（改一处两处都跟着变）。
async function installPluginsByDialog(): Promise<string[]> {
  if (mainWindow === null) return []
  const outcome = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Pneuma 插件文件',
    filters: [{ name: 'Pneuma 插件', extensions: ['js'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (outcome.canceled || outcome.filePaths.length === 0) return []
  const dir = join(app.getPath('home'), '.dsc', 'plugins')
  mkdirSync(dir, { recursive: true })
  const installed: string[] = []
  for (const src of outcome.filePaths) {
    const dest = join(dir, basename(src))
    copyFileSync(src, dest)
    installed.push(basename(dest))
  }
  return installed
}

// 选择技能（SKILL.md 所在目录，或扁平 .md 文件）并复制到 ~/.dsc/skills/。
// 具名函数的理由与 installPluginsByDialog 相同。
async function installSkillsByDialog(): Promise<string[]> {
  if (mainWindow === null) return []
  const outcome = await dialog.showOpenDialog(mainWindow, {
    title: '选择技能：含 SKILL.md 的目录，或 .md 文件',
    filters: [{ name: '技能文件', extensions: ['md'] }],
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  })
  if (outcome.canceled || outcome.filePaths.length === 0) return []
  const dir = join(app.getPath('home'), '.dsc', 'skills')
  mkdirSync(dir, { recursive: true })
  const installed: string[] = []
  for (const src of outcome.filePaths) {
    const name = basename(src)
    if (statSync(src).isDirectory()) {
      if (existsSync(join(src, 'SKILL.md'))) {
        // 一个技能包：整目录（含 references/、scripts/）复制过去
        cpSync(src, join(dir, name), { recursive: true })
        installed.push(name)
        continue
      }
      // 用户选的是一捆：把里面每个含 SKILL.md 的子目录当作一个技能
      for (const child of readdirSync(src)) {
        const childPath = join(src, child)
        if (existsSync(join(childPath, 'SKILL.md'))) {
          cpSync(childPath, join(dir, child), { recursive: true })
          installed.push(child)
        }
      }
      continue
    }
    if (!name.toLowerCase().endsWith('.md')) continue
    copyFileSync(src, join(dir, name))
    installed.push(name.replace(/\.md$/i, ''))
  }
  return installed
}

function registerIpc(): void {
  ipcMain.handle('dsc:invoke', (_event, method: string, args: unknown[]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke(method, args ?? [])
  })

  ipcMain.handle('dsc:get-cwd', () => hostCwd)

  // ── 旧渲染层那批 IPC 通道 ─────────────────────────────────────────────────
  // 旧渲染层已经整体删除（2026-10-28），这些 handler 现在**没有消费方**：插件壳走的是
  // 原生桥（`src/core/native-bridge.ts` + preload 的白名单）。留着是因为实现体与原生桥
  // 共用同一批具名函数，删掉它们只是少一层包装、不减少任何能力；真要删，等下一次清理
  // `electron/preload/index.ts` 里那批通道时一起删。
  ipcMain.handle('dsc:choose-directory', () => chooseDirectory())

  ipcMain.handle('dsc:restart-host', async () => {
    await restartHost(hostCwd)
    return true
  })

  // 切到指定工作目录（侧栏点工作区名走这条，不弹对话框）
  ipcMain.handle('dsc:switch-cwd', (_event, path: unknown) => switchCwdTo(String(path ?? '')))

  // 最近用过的工作目录（侧栏切换菜单与「有会话的目录」合并成候选清单）
  ipcMain.handle('dsc:recent-cwds', (): string[] => readState().recentCwds ?? [])

  // 从最近工作目录里移除一条（侧栏「删除工作区」：会话归档后把空组从侧栏撤下）。
  // 只动 recentCwds 不碰会话数据；目录切回来时由 dsc:switch-cwd 重新前插。
  ipcMain.handle('dsc:remove-recent-cwd', (_event, path: unknown): void => {
    removeRecentCwdEntry(String(path ?? ''))
  })

  // 当前会话的累计用量（底部状态栏第二段与上下文悬浮卡的数据源）。
  // 只读宿主写的用量日志，按会话 id 汇总；没有记录时返回 null，由渲染层省略那两段。
  ipcMain.handle('dsc:session-usage', (_event, sessionId: unknown) => readSessionUsage(String(sessionId ?? '')))

  // 选择 .js 插件文件并复制到 ~/.dsc/plugins/；返回复制的文件名（取消返回 []）
  ipcMain.handle('dsc:plugins-install', () => installPluginsByDialog())

  // 选择技能（SKILL.md 所在目录，或扁平 .md 文件）并复制到 ~/.dsc/skills/
  ipcMain.handle('dsc:skills-install', () => installSkillsByDialog())

  // 在系统文件管理器里打开路径（设置「关于」里的路径行）；只接受绝对路径
  ipcMain.handle('dsc:open-path', (_event, path: unknown) => openPathBySystem(path))

  // 用系统浏览器打开链接（检查更新的「打开发布页」）；只放行 http/https，
  // 免得 file:/自定义协议被渲染层来的字符串拿着 shell 去开。
  ipcMain.handle('dsc:open-external', (_event, url: unknown) => {
    openExternalUrl(url)
  })

  // 系统通知（任务完成提醒）：渲染层在一轮干完且窗口离开前台时打过来。
  // 声音不归这里——渲染层的完成提示音负责发声（开关独立），通知一律 silent，
  // 免得 Windows 的 toast 提示音和我们的音效同一时刻叠两声。
  ipcMain.handle('dsc:notify', (event, payload: unknown) =>
    event.sender === mainWindow?.webContents ? notifyUser(payload) : false,
  )

  // 原生弹出层（select 的下拉选项列表、右键菜单）的深浅只认 nativeTheme，
  // 页面 CSS 够不着：renderer 在主题生效时把模式报上来。跟随系统就原样透传，
  // 让 OS 自己翻面；值不对就拒收，保持上一次的主题。
  ipcMain.on('dsc:theme-source', (event, mode: unknown) => {
    if (event.sender !== mainWindow?.webContents) return
    applyThemeSource(mode)
  })

  // 用多种方式打开当前工作区（顶栏文件夹按钮的下拉；对照 dsh）。
  // 只对宿主记忆里的 hostCwd 生效——它不是用户随手输入的字符串，spawn 参数固定。
  ipcMain.handle('dsc:workspace-open', (_event, kind: string) => openWorkspace(String(kind)))

  ipcMain.on('dsc:quit', () => {
    mainWindow?.close()
  })

  // 原生窗口控件区（最小化/最大化/关闭）由系统画，样式表够不着，只能在主题
  // 切换时由 renderer 把两个颜色报上来。只收 #rrggbb：带 alpha 的颜色到了系统
  // 那侧会被丢掉，宁可拒收也不要在浅色主题下留一块错色的条。
  ipcMain.on('dsc:set-window-chrome', (event, bar: unknown, symbol: unknown) => {
    if (event.sender !== mainWindow?.webContents) return
    applyWindowChrome(bar, symbol)
  })

  registerNativeBridge()
}

// ── 那条窄接口的两侧共用实现 ──────────────────────────────────────────────────
// 抽出来是为了让「旧渲染层的 IPC 通道」与「插件壳的原生桥」走同一段代码：
// 两边各写一份的下场是行为分叉，而这两条路今天同时活着（档案开关切界面，不改桥）。

/** 弹系统目录选择框并切过去；取消给 null。 */
async function chooseDirectory(): Promise<string | null> {
  if (mainWindow === null) return null
  const outcome = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Pneuma 工作目录',
    properties: ['openDirectory'],
    defaultPath: hostCwd || undefined,
  })
  if (outcome.canceled || outcome.filePaths.length === 0) return null
  const next = resolve(outcome.filePaths[0] ?? '')
  if (next !== hostCwd) await restartHost(next)
  return next
}

/**
 * 只弹目录框、**不动宿主**（取消给空串）：壳用它挑「在哪个目录里开一条新会话」。
 *
 * 与 {@link chooseDirectory} 的分工：那个的语义是「切工作目录」（宿主重启 + 整页重载），
 * 旧渲染层还在用它；而目录是会话自己的数据，壳那条路不该付重启的代价。
 */
async function pickDirectory(): Promise<string> {
  if (mainWindow === null) return ''
  const outcome = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作目录',
    properties: ['openDirectory'],
    defaultPath: hostCwd || undefined,
  })
  if (outcome.canceled || outcome.filePaths.length === 0) return ''
  return resolve(outcome.filePaths[0] ?? '')
}

/**
 * 弹系统文件选择框挑一份配置文件（模型端点那一份 YAML）。取消给空串。
 *
 * 过滤后缀写死在这里：页面递不进来任何过滤条件，所以它只能挑「像配置文件的文件」，
 * 挑完是不是合法配置仍由宿主的 settings 插件校验（那边才是规矩的真源）。
 */
async function pickConfigFile(): Promise<string> {
  if (mainWindow === null) return ''
  const outcome = await dialog.showOpenDialog(mainWindow, {
    title: '选择配置文件',
    properties: ['openFile'],
    filters: [
      { name: '配置文件', extensions: ['yaml', 'yml', 'json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
    // 落点给用户主目录：配置文件默认就在 ~/.dsc 下，多数人从这里挑
    defaultPath: app.getPath('home'),
  })
  if (outcome.canceled || outcome.filePaths.length === 0) return ''
  return resolve(outcome.filePaths[0] ?? '')
}

/**
 * 记一笔「最近用过的工作区」：`recentCwds`（侧栏的空工作区占位）与 `lastCwd`
 * （下次冷启动落点）。与 `restartHost` 里那段同一份写法，但**不重启宿主**。
 */
function rememberCwdEntry(path: string): void {
  if (path === '') return
  const next = resolve(path)
  const recent = [next, ...(readState().recentCwds ?? []).filter((entry) => entry !== next)].slice(0, 12)
  writeState({ lastCwd: next, recentCwds: recent })
}

/** 切到指定工作目录（无对话框）；失败给一句能直接看的原因。 */
async function switchCwdTo(path: string): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const next = resolve(path)
  if (!existsSync(next) || !statSync(next).isDirectory()) {
    return { ok: false, error: `目录不存在：${next}` }
  }
  if (next !== hostCwd) await restartHost(next)
  return { ok: true, cwd: hostCwd }
}

/** 从「最近用过」里撤下一条；空串是空操作。 */
function removeRecentCwdEntry(path: string): void {
  if (path === '') return
  writeState({ recentCwds: (readState().recentCwds ?? []).filter((entry) => entry !== path) })
}

/** 用系统文件管理器打开一个绝对路径；返回空串表示成功。 */
function openPathBySystem(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) return Promise.resolve('只允许打开绝对路径')
  return shell.openPath(path)
}

/** 用系统浏览器打开 http/https 链接；别的协议一律丢掉。 */
function openExternalUrl(url: unknown): void {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
  // 自检：只记账、不真开浏览器。验「点击链接不会把主窗口导航走」时不该给用户弹一堆网页。
  if (process.env.DSC_NO_EXTERNAL_OPEN === '1') {
    selfcheckNote(`[selfcheck] 跳过打开外部链接：${url}\n`)
    return
  }
  void shell.openExternal(url)
}

/** 原生窗口控件区上色：只收 #rrggbb（带 alpha 的颜色到了系统那侧会被丢掉）。 */
function applyWindowChrome(bar: unknown, symbol: unknown): void {
  if (isSelfCheck()) {
    selfcheckNote(`[selfcheck] 控件条颜色 ${String(bar)} ${String(symbol)}\n`)
  }
  if (!isChromeColor(bar) || !isChromeColor(symbol) || !mainWindow) return
  mainWindow.setTitleBarOverlay({ color: bar, symbolColor: symbol, height: CAPTION_HEIGHT })
  mainWindow.setBackgroundColor(bar)
}

/** 原生弹层（下拉、右键菜单）的深浅。 */
function applyThemeSource(mode: unknown): void {
  // claude 是浅色的暖米白主题：系统画的那层（原生下拉、右键菜单）只有深浅两种，
  // 报 light 才是对的——直接透传 'claude' 会被 nativeTheme 拒掉，弹层会留在上一档。
  const resolved = mode === 'claude' ? 'light' : mode
  if (resolved !== 'dark' && resolved !== 'light' && resolved !== 'system') return
  if (isSelfCheck()) selfcheckNote(`[selfcheck] 原生主题源 ${String(resolved)}\n`)
  nativeTheme.themeSource = resolved
}

/** 系统通知：点通知 = 回到主窗口（缩托盘/最小化时尤其实用）。返回是否真的弹了。 */
function notifyUser(payload: unknown): boolean {
  if (mainWindow === null) return false
  const title = typeof (payload as { title?: unknown } | null)?.title === 'string' ? (payload as { title: string }).title.trim() : ''
  if (title === '') return false
  const rawBody = typeof (payload as { body?: unknown } | null)?.body === 'string' ? (payload as { body: string }).body.trim() : ''
  const iconDir = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'build')
  const iconFile = [join(iconDir, 'icon.png'), join(iconDir, 'icon-tray.png')].find((p) => existsSync(p))
  const notification = new Notification({
    title,
    ...(rawBody !== '' ? { body: rawBody } : {}),
    ...(iconFile !== undefined ? { icon: iconFile } : {}),
    silent: true,
  })
  if (isSelfCheck()) {
    process.stderr.write(`[selfcheck] 系统通知：${title}${rawBody === '' ? '' : ` / ${rawBody}`}\n`)
  }
  notification.on('click', () => showMainWindow())
  notification.show()
  return true
}

/**
 * 自检读数：同时写 stderr 与一个可选的文件。
 *
 * 为什么要有文件这条路：打包成 GUI 子系统之后（Windows），spawn 出来的进程**拿不到**
 * 它的 stderr——实测 installer-walkthrough 里 stderr 是空串，于是「界面形态=shell」
 * 「窗口来自宿主界面服务」「预跑脚本完成」三行读数全部丢失，红得像功能坏了。
 * 截图那条路不受影响（图是文件），所以读数也走文件：DSC_DESKTOP_SELFCHECK_LOG=<path>。
 * @param line - 要写的一行（自带换行）
 */
function selfcheckNote(line: string): void {
  process.stderr.write(line)
  const file = process.env['DSC_DESKTOP_SELFCHECK_LOG']
  if (file === undefined || file === '') return
  try {
    appendFileSync(file, line)
  } catch {
    // 落不下不影响自检本身：stderr 那条还在（开发态能看见）。
  }
}

/** 是不是自检跑（`DSC_DESKTOP_SHOT` 有值）；自检时把原生动作写进 stderr 当证据。 */
function isSelfCheck(): boolean {
  return (process.env.DSC_SELFTEST ?? process.env.DSC_DESKTOP_SHOT ?? '') !== ''
}

// ── 原生桥（插件壳走这条） ────────────────────────────────────────────────────

/**
 * 桥的分派表。
 *
 * 类型写成 `Readonly<Record<NativeOp, …>>`：规格里加了操作而这里忘了实现，**编不过**——
 * "白名单"与"真有实现"被绑在一起（与 `core/ui-methods.ts` 的 `UI_ARG_SPECS` 同一个套路）。
 * 实参在进这里之前已经过 `validateNativeCall`，所以下面按已校验收窄的用法取值。
 */
const NATIVE_HANDLERS: Readonly<Record<NativeOp, (args: readonly unknown[]) => unknown>> = {
  setWindowChrome: ([bar, symbol]) => {
    applyWindowChrome(bar, symbol)
  },
  setThemeSource: ([mode]) => {
    applyThemeSource(mode)
  },
  chooseDirectory: () => chooseDirectory(),
  pickDirectory: () => pickDirectory(),
  rememberCwd: ([path]) => {
    rememberCwdEntry(String(path))
  },
  switchCwd: ([path]) => switchCwdTo(String(path)),
  recentCwds: (): string[] => readState().recentCwds ?? [],
  removeRecentCwd: ([path]) => {
    removeRecentCwdEntry(String(path))
  },
  openPath: ([path]) => openPathBySystem(path),
  openExternal: ([url]) => {
    openExternalUrl(url)
  },
  openWorkspace: ([kind, dir]) => openWorkspace(String(kind), typeof dir === 'string' ? dir : undefined),
  installSkill: () => installSkillsByDialog(),
  installPlugin: () => installPluginsByDialog(),
  /**
   * 市场安装与改源：转给宿主（技能市场与 settings.json 都归宿主管）。
   * 界面通道里这两个方法持续排除（浏览器与远程页够得着的那条面），桥只对主窗口开放。
   */
  installMarketSkill: ([source, name]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('installMarketSkill', [String(source), String(name)])
  },
  setMarketSources: ([sources]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setMarketSources', [sources])
  },
  /** 落一条第三方界面插件的信任记录（信任卡确认动作；写口只开在这条桌面上）。 */
  setUiTrust: ([name]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setUiTrust', [String(name)])
  },
  /**
   * 切权限模式：转给宿主的 approval 插件（与旧渲染层 `proxy.setPolicy` 同一个方法）。
   * 界面通道里这个方法持续排除（审批策略是安全闸门本身，见 `UI_EXCLUDED`），
   * 但旧桌面版的输入框本来就有这根能切的旋钮，所以写口按同一先例开在桥上。
   * 三档枚举已过桥校验（`NATIVE_ARG_SPECS.setPolicy`）。
   */
  setPolicy: ([policy]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setPolicy', [String(policy)])
  },
  /**
   * 审阅者与打包权限预设：与 setPolicy 同一条理由开在桥上——改的都是安全闸门本身
   * （谁来裁 / 一次写沙箱 + 权限模式 + 审阅者三个旋钮），界面通道持续排除。
   * 三条都只是转发给宿主对应的写口，语义与校验在宿主那侧。
   */
  setReviewer: ([reviewer]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setReviewer', [String(reviewer)])
  },
  usePermissionPreset: ([name]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('usePermissionPreset', [String(name)])
  },
  setDefaultPermissionPreset: ([name]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setDefaultPermissionPreset', [String(name)])
  },
  /**
   * 模型端点三件套：转给宿主的 settings 插件（与旧渲染层的直接 IPC 同一批方法）。
   * 界面通道里这三个方法持续排除（写 config.yaml / 凭据库），桥只对主窗口开放。
   * setProviderKey 的第二个实参允许 null = 清除（已过桥的 stringOrNull 校验）。
   */
  saveProvider: ([draft]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('saveProvider', [draft])
  },
  removeProvider: ([name]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('removeProvider', [String(name)])
  },
  setProviderKey: ([name, apiKey]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setProviderKey', [String(name), apiKey === null ? null : String(apiKey)])
  },
  /**
   * 换一份配置文件用：转给宿主的 settings 插件（校验与落偏好都在那边）。空串 = 回出厂那份。
   * 与上面三件同一先例：写类入口只对主窗口那份文档开放。
   */
  setConfigFile: ([path]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('setConfigFile', [String(path ?? '')])
  },
  /** 弹系统文件选择框挑配置文件：只回路径，改配置是上一条的事。 */
  pickConfigFile: () => pickConfigFile(),
  sessionUsage: ([id]) => readSessionUsage(String(id ?? '')),
  notify: ([payload]) => notifyUser(payload),
  restartHost: async () => {
    await restartHost(hostCwd)
    return true
  },
  quit: () => {
    mainWindow?.close()
  },
  /**
   * 终端：把 `[op, payload]` 转给宿主的 dock 服务。这是**唯一**一条从界面调 dock 终端的路
   * （界面 HTTP 面的 op 枚举里没有 term-*），而这条通道只对主窗口的文档开放。
   */
  terminal: ([op, payload]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke('dock', [String(op), (payload ?? {}) as Record<string, unknown>])
  },
  /**
   * 内嵌浏览器：显示/隐藏某一台原生覆盖层并摆位置（实参已过桥的规格校验：
   * id + visible + 可选 rect）。视图的建立与销毁都在 dock.ts，这里只传话。
   */
  dockBrowser: ([id, visible, rect]) => {
    return setDockBrowser(
      String(id),
      visible === true,
      rect as { x: number; y: number; width: number; height: number } | undefined,
    )
  },
  /** 内嵌浏览器导航（实参已过桥的规格校验：动作枚举 + url 长度 + 可选 id）。 */
  browserNav: ([url, action, id]) => {
    return navigateDockBrowser(
      String(url),
      action as 'load' | 'back' | 'forward' | 'reload',
      id === undefined ? undefined : String(id),
    )
  },
  /** 关掉一台内嵌浏览器视图（页签关了 / 切会话时壳会调）。 */
  browserClose: ([id]) => {
    closeDockBrowser(String(id))
  },
  /** 问一次更新状态（本次运行还没问过就顺手补一次，见 update.ts 的 ensureChecked）。 */
  checkUpdate: () => ensureChecked(),
  /** 就地更新：下载安装器 → 起安装程序 → 退出应用。返回 { ok } 或 { ok:false, error }。 */
  installUpdate: () => installNow(),
}

/**
 * 注册桥通道（`dsc:native`）。
 *
 * 只有一种调用方合法：主窗口里那份文档（旧渲染层或插件壳，同一扇窗、两份界面）；
 * 内嵌浏览器那个 `WebContentsView` 与别的任何窗口都不给。校验与分派的顺序是
 * **先校验再分派**——规格在 `core/native-bridge.ts`，宿主与壳读同一份源码。
 */
function registerNativeBridge(): void {
  ipcMain.handle('dsc:native', (event, op: unknown, args: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('原生桥：只接受主窗口的调用')
    const call = validateNativeCall(op, args)
    if (!call.ok) throw new Error(call.error)
    return NATIVE_HANDLERS[call.op](call.args)
  })
}

// ── 窗口与应用 ────────────────────────────────────────────────────────────────

/** 记住的「还原态」窗口框：最大化期间不采集（那时 getBounds 是铺满工作区的假尺寸）。 */
let normalBounds: { width: number; height: number; x: number; y: number } | null = null

/**
 * 读记忆的窗口框。宽高不合法（手改坏/旧版本数据）退回默认；位置必须和某台
 * 显示器有交集——拔掉外接屏后残留的旧坐标会让窗口开在看不见的地方，
 * 这时只保留大小、位置交给系统居中。
 */
function loadWindowMemory(): { width: number; height: number; x?: number; y?: number; maximized: boolean } {
  const saved = readState().windowBounds
  const width = typeof saved?.width === 'number' && saved.width >= 960 ? Math.round(saved.width) : 1440
  const height = typeof saved?.height === 'number' && saved.height >= 640 ? Math.round(saved.height) : 940
  const x = typeof saved?.x === 'number' ? Math.round(saved.x) : Number.NaN
  const y = typeof saved?.y === 'number' ? Math.round(saved.y) : Number.NaN
  const onScreen = screen.getAllDisplays().some(
    (display) =>
      x < display.bounds.x + display.bounds.width &&
      x + width > display.bounds.x &&
      y < display.bounds.y + display.bounds.height &&
      y + height > display.bounds.y,
  )
  return {
    width,
    height,
    ...(onScreen ? { x, y } : {}),
    maximized: saved?.maximized === true,
  }
}

/**
 * 挂上 resize/move 采集与 close 落盘。落盘走 desktop.json 的合并写，只动
 * windowBounds 自己的字段；app.exit()（自检截图退出）不触发 close，所以
 * 自检运行不会把窗口记忆覆盖成自检窗口的尺寸。
 */
function rememberWindowBounds(win: BrowserWindow): void {
  normalBounds = win.getBounds()
  const track = (): void => {
    // 最小化时 Windows 会把窗口挪到 -32000,-32000，这份坐标绝不能记
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
      normalBounds = win.getBounds()
    }
  }
  win.on('resize', track)
  win.on('move', track)
  win.on('close', () => {
    writeState({ windowBounds: { ...(normalBounds ?? win.getBounds()), maximized: win.isMaximized() } })
  })
}

function createWindow(): void {
  const memory = loadWindowMemory()
  const theme = readUiTheme()
  const paint = THEME_PAINT[theme]
  mainWindow = new BrowserWindow({
    width: memory.width,
    height: memory.height,
    ...(memory.x !== undefined ? { x: memory.x, y: memory.y } : {}),
    minWidth: 960,
    minHeight: 640,
    // 无边框：Windows 用原生 overlay 窗口控件，renderer 内留出拖拽区。
    // 底色先按 settings.json 里的主题给（深 / 浅 / 米白三套），renderer 在外观生效那一刻
    // 还会把算出来的两个颜色再报一次（IPC 频道 dsc:set-window-chrome）。
    //
    // show: false 是关键的一手：窗口等**页面画出第一帧**才上屏，用户看不到从点击快捷方式
    // 到首帧之间那块白（原来的开窗顺序是先上屏、再加载，头一帧是白的）。
    show: false,
    backgroundColor: paint.page,
    title: 'Pneuma',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: paint.page,
      symbolColor: paint.symbol,
      height: CAPTION_HEIGHT,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // dock.ts 通过全局引用向 renderer 推送事件（pty 数据 / 浏览器状态）
  ;(globalThis as { __dscMainWindow?: BrowserWindow }).__dscMainWindow = mainWindow

  // 主窗口只跑界面，绝不许自己换页。
  //
  // 为什么要有这两道闸：正文里的链接（markdown 里的 `<a href>`）以前就是裸链接，点一下
  // 主窗口直接导航过去——整个界面被换成那个网页，加载不出来就是一片白，而且没有后退路，
  // 只能重启（2026-11-02 报障「点会话里的网址直接白屏」）。内嵌浏览器那台视图一直有这两道
  // （`dock.ts` 的 setWindowOpenHandler / will-navigate），主窗口漏了。
  //
  // 规矩：同源（附件预览 `/api/attachments/<sha>` 这类）保持原样；http/https 外链交给
  // 系统浏览器；别的协议一律丢掉。
  const sameOriginAsApp = (target: string): boolean => {
    const win = mainWindow
    if (win === null) return false
    try {
      const current = new URL(win.webContents.getURL())
      const next = new URL(target, current)
      // `file:` 与 `data:` 的 origin 都是字符串 "null"，光比 origin 会把它们放进来
      if (next.origin !== current.origin) return false
      return current.protocol === 'http:' || current.protocol === 'https:'
    } catch {
      return false
    }
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 同源开窗是旧行为（附件卡片 `<a target="_blank">` 靠它看原文件），保留；
    // 外链不再新开 Electron 窗口，交系统浏览器。
    if (sameOriginAsApp(url)) return { action: 'allow' }
    openExternalUrl(url)
    return { action: 'deny' }
  })
  const blockNavigation = (event: { preventDefault: () => void }, url: string): void => {
    // 主窗口是单页应用，任何整页导航都是错的：一律拦下，外链转系统浏览器。
    event.preventDefault()
    openExternalUrl(url)
  }
  mainWindow.webContents.on('will-navigate', blockNavigation)
  mainWindow.webContents.on('will-redirect', blockNavigation)

  // 首帧：页面画出第一帧再显示窗口（配合上面的 show: false）。
  mainWindow.once('ready-to-show', () => {
    bootNote('首帧已画出，窗口显示')
    mainWindow?.show()
  })

  // 窗口记忆：先挂采集（种子 = 刚开好的还原态），再按记忆恢复最大化——
  // 顺序反了会把最大化尺寸当成还原态记下来
  rememberWindowBounds(mainWindow)
  if (memory.maximized) mainWindow.maximize()

  // 自检截图：DSC_DESKTOP_SHOT=<png 路径> 时，加载完成后截图并退出（自动化验证用）。
  // 必须在 loadFile/loadURL 之前注册，否则会错过 did-finish-load。
  const shotPath = process.env.DSC_DESKTOP_SHOT
  if (shotPath !== undefined && shotPath !== '') {
    // 原生窗口控件区不进 capturePage，只能整屏抓；抓屏时窗口要盖在别的窗口之上，
    // 所以 DSC_DESKTOP_SHOT_TOPMOST=1 时把它钉在最上层。show() 是被动的：自检常由
    // 脚本启动 exe，脚本给的 STARTUPINFO 里带 SW_HIDE 时窗口会开成隐藏的。
    if (process.env.DSC_DESKTOP_SHOT_TOPMOST === '1') {
      mainWindow.setAlwaysOnTop(true, 'screen-saver')
      mainWindow.show()
      mainWindow.focus()
    }
    const wait = Number.parseInt(process.env.DSC_DESKTOP_SHOT_DELAY ?? '4000', 10)
    const delay = Number.isNaN(wait) ? 4000 : wait
    // capturePage 在 GPU 合成不正常时可能永远不返回，因此挂个看门狗：自动化不能挂在这里
    mainWindow.webContents.once('did-finish-load', () => {
      selfcheckNote(`[selfcheck] 页面加载完成，${delay}ms 后截图 ${shotPath}\n`)
      const watchdog = setTimeout(() => {
        selfcheckNote('[selfcheck] 截图超时，强制退出\n')
        app.exit(1)
      }, delay + 25000)
      // 截图前先在渲染层跑一段脚本（DSC_DESKTOP_SHOT_EVAL）：用来点开一个有内容的
      // 旧会话，否则自检只拍得到启动时的空状态，聊天流和工具行的样式没法验证。
      const preScript = process.env.DSC_DESKTOP_SHOT_EVAL
      if (preScript !== undefined && preScript !== '') {
        // 脚本要赶在截图前跑完，所以默认提前 2 秒；要多会话来回切换的脚本
        // 用 DSC_DESKTOP_SHOT_EVAL_LEAD 把提前量放大。
        const lead = Number.parseInt(process.env.DSC_DESKTOP_SHOT_EVAL_LEAD ?? '2000', 10)
        setTimeout(() => {
          void mainWindow?.webContents
            .executeJavaScript(preScript)
            .then((value: unknown) =>
              selfcheckNote(`[selfcheck] 预跑脚本完成：${JSON.stringify(value) ?? '无返回值'}\n`)
            )
            .catch((error: unknown) => selfcheckNote(`[selfcheck] 预跑脚本失败：${String(error)}\n`))
        }, Math.max(0, delay - (Number.isNaN(lead) ? 2000 : lead)))
      }
      // 原生窗口控件条（最小化/最大化/关闭）由系统画，capturePage 拍不到，只能整屏抓
      // 再裁。坐标换算放在这里做：getBounds 给的是 DIP，乘所在显示器的 scaleFactor 才是
      // 屏幕像素，外部抓屏脚本容易被 DPI 虚拟化绕晕。
      const stripPath = process.env.DSC_DESKTOP_SHOT_STRIP
      if (stripPath !== undefined && stripPath !== '') {
        setTimeout(() => {
          void captureCaptionStrip(stripPath)
        }, Math.max(0, delay - 3000))
      }
      setTimeout(() => {
        void mainWindow?.webContents
          .capturePage()
          .then((image) => {
            mkdirSync(resolve(shotPath, '..'), { recursive: true })
            writeFileSync(shotPath, image.toPNG())
            selfcheckNote(`[selfcheck] 已写出 ${shotPath}\n`)
          })
          .catch((error: unknown) => selfcheckNote(`[selfcheck] 截图失败：${String(error)}\n`))
          .finally(() => {
            clearTimeout(watchdog)
            app.exit(0)
          })
      }, delay)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      selfcheckNote(`[selfcheck] 页面加载失败：${code} ${description}\n`)
    })
  }

  // 自检参数：DSC_DESKTOP_DEMO=1 自动跑一轮真实对话；DSC_DESKTOP_SEARCH 直接打开某个界面；
  // DSC_UI_QUERY 透传给壳（例如 diag=1）；theme 给首帧底色（见 pageQuery）。
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl !== undefined && devServerUrl !== '') {
    // 开发态：页面来自 vite，直接加载它，不留过渡页（同一个源，改了立刻能看到）。
    servedPageLoaded = true
    void mainWindow.loadURL(`${devServerUrl}/?${pageQuery()}`)
  } else if (uiServerOrigin !== null) {
    // 宿主比窗口先起来（内核快时走这条）：直接加载伺服的那份文档，不必先落文件再切。
    servedPageLoaded = true
    bootNote(`[dsc-desktop] 窗口来自宿主界面服务 ${uiServerOrigin}`)
    void mainWindow.loadURL(desktopPageUrl())
  } else if (!existsSync(shellDir())) {
    // 界面产物真的不存在：等下去也不会有界面，这是真失败，直接给提示页。
    showFailurePage('no-assets')
  } else if (isSelfCheck()) {
    // 自检要一份**可预测**的首个文档（截图钩子挂在 did-finish-load 上），所以不插过渡页：
    // 留空白窗口等宿主报地址，真等不到由看门狗换成提示页。
    bootNote('自检运行：不加载过渡页，等宿主报地址')
    armUiWait()
  } else {
    // 宿主还在起（约两秒）：先上过渡页（带动画），地址一到就换成真界面。
    // 提示页只在真失败时出现——它不再是启动的必经画面。
    void mainWindow.loadURL(splashHtml(theme))
    armUiWait()
  }

  // 点 X：开关开着就缩到托盘（宿主继续跑），否则正常关窗走退出流程
  mainWindow.on('close', (event) => {
    if (quitting || !closeToTrayEnabled()) return
    event.preventDefault()
    mainWindow?.hide()
    ensureTray()
    const state = readState()
    if (state.trayHintShown !== true && process.platform === 'win32') {
      writeState({ ...state, trayHintShown: true })
      tray?.displayBalloon({
        title: 'Pneuma 还在后台运行',
        content: '点击托盘图标回到窗口，右键图标可完全退出；此提示仅出现一次，关窗行为可在设置 → 通用中修改',
      })
    }
  })

  mainWindow.on('closed', () => {
    // 窗口没了，内嵌浏览器的原生视图跟着收掉：它们挂在窗口的 contentView 上，
    // 不显式销毁会一直吊到进程退出（每台都带一个渲染进程）。
    disposeDockBrowsers()
    mainWindow = null
  })
}

/**
 * 自检用：整屏抓图后裁出窗口右上角的原生控件条，写出 PNG，并把取样到的颜色打进日志。
 *
 * 三个窗口按钮由系统画，capturePage 只拍网页，拍不到它们；控件条有没有跟着主题换色，
 * 只能靠整屏抓图来看。裁剪坐标用 getBounds()（DIP）乘所在显示器的 scaleFactor 换算，
 * 交给外部脚本换算会被 DPI 虚拟化绕晕。
 *
 * @param stripPath 要写出的 PNG 路径
 */
async function captureCaptionStrip(stripPath: string): Promise<void> {
  const win = mainWindow
  if (!win) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const scale = display.scaleFactor
  const [source] = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  })
  if (!source) {
    process.stderr.write('[selfcheck] 整屏抓图没拿到源\n')
    return
  }
  // 控件条贴着窗口右上角：取右端 260 DIP 宽、70 DIP 高，够装下三个按钮还留点余量
  const image = source.thumbnail.crop({
    x: Math.round((display.bounds.x + bounds.x + bounds.width - 260) * scale),
    y: Math.round((display.bounds.y + bounds.y) * scale),
    width: Math.round(260 * scale),
    height: Math.round(70 * scale),
  })
  mkdirSync(resolve(stripPath, '..'), { recursive: true })
  writeFileSync(stripPath, image.toPNG())
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  // toBitmap() 在 Windows 上的字节序是 BGRA
  const hexAt = (px: number, py: number): string => {
    const i = (py * width + px) * 4
    const part = (offset: number): string => bitmap[i + offset].toString(16).padStart(2, '0')
    return `#${part(2)}${part(1)}${part(0)}`
  }
  const row = new Map<string, number>()
  for (let px = 0; px < width; px += 2) {
    const hex = hexAt(px, 4)
    row.set(hex, (row.get(hex) ?? 0) + 1)
  }
  const bar = [...row.entries()].sort((a, b) => b[1] - a[1])[0]
  let darkest = hexAt(0, 0)
  let darkestLum = Number.POSITIVE_INFINITY
  for (let py = 0; py < height; py += 2) {
    for (let px = 0; px < width; px += 2) {
      const i = (py * width + px) * 4
      const lum = 0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i]
      if (lum < darkestLum) {
        darkestLum = lum
        darkest = hexAt(px, py)
      }
    }
  }
  process.stderr.write(
    `[selfcheck] 控件条 ${width}x${height} 像素已写出 ${stripPath}；窗口可见=${win.isVisible()} 最小化=${win.isMinimized()} 位置=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} 缩放=${scale}；顶行主色 ${bar[0]}（${bar[1]}/${width / 2} 点），最暗像素 ${darkest}\n`,
  )
}

// 自检/并行实例：换一个 userData 目录，单实例锁与已开着的打包版互不影响
const userDataOverride = process.env.DSC_DESKTOP_USER_DATA
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Windows 的 toast 通知按 AppUserModelID 归属应用：不设的话通知挂在 Electron
  // 名下（打包版上会被丢进「Windows 通知」杂项，图标也不对）。与 electron-builder.yml 的 appId 一致。
  app.setAppUserModelId('io.dsc.desktop')

  app.on('second-instance', () => {
    // 缩到托盘时再点快捷方式：把隐藏的主窗口叫回来
    showMainWindow()
  })

  app.whenReady().then(() => {
    const state = readState()
    startHost(state.lastCwd ?? app.getPath('home'))
    registerIpc()
    registerDockIpc()
    // dock 视图上的 CDP 事件 → 宿主（只有被 agent 碰过、挂了 debugger 的视图会推）。
    // 订阅登记在这里而不是 startHost 里：宿主重启会重跑 startHost，写在那边就会叠出
    // N 份推送。这里只登记一次，推的时候现读 `protocol`（它是当前那一个宿主会话）。
    onDockEvent((event) => {
      protocol?.browserEvent(event)
    })
    createWindow()
    // 检查更新排期：时机现读 settings.json，所以改设置不用重启就生效（见 update.ts）。
    // 退出动作复用托盘那条「完全退出」——装完要真的把应用关掉，安装器才换得动文件。
    startUpdateChecks({ window: () => mainWindow, quit: quitApp })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    quitApp()
  })
}
