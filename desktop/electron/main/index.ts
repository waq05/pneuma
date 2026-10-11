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
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell, utilityProcess, type UtilityProcess } from 'electron'
import type { NativeImage } from 'electron'
import { validateNativeCall, type NativeOp } from '@dsc/runtime/core/native-bridge.js'
import { HostProtocol } from './protocol.js'
import { registerDockIpc } from './dock.js'
import { readState, resolveHeadlessEntry, writeState } from './dsc-core.js'
import { readSessionUsage } from './session-usage.js'

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
 * 深色主题的窗口底色与控件区配色，取自深色主题下这两个令牌算出来的实际值，
 * 这样选深色时开窗到首帧之间不会看见颜色跳一下。浅色主题由 renderer 在外观
 * 生效时推过来覆盖。
 */
const DARK_CHROME = { bar: '#111421', symbol: '#b7babf' }

/** 能否交给系统给窗口控件着色：只收 #rrggbb，半透明颜色到了那侧会被丢掉。 */
function isChromeColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

// ── 宿主生命周期 ──────────────────────────────────────────────────────────────

/**
 * 旧渲染层产物目录：回落用的 `loadFile` 加载的就是这里。
 *
 * 迁移期它是「默认伺服的那份界面」，但**不再**是「宿主该伺服哪份界面」这个问题的
 * 唯一答案——那份答案现在由 {@link uiAssetsDir} 按档案给出，插件壳开了就伺服壳产物。
 * 这条回落路径必须一直留着：认证失败、拿不到地址、壳产物缺失，窗口都退回这里。
 */
function rendererDir(): string {
  return join(__dirname, '../renderer')
}

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
 * 默认伺服的界面形态（阶段 5.6 翻转）：**插件壳**。旧渲染层从此是回落——
 * 档案里写 `ui: 'legacy'`、`DSC_UI_SHELL=0`、或壳产物缺失，都会退回它。
 * 「回退」永远是改一个字段（或删掉那份壳产物）的事。
 */
const DEFAULT_UI_PROFILE = 'shell' as const

/**
 * 当前该伺服哪份界面：档案（`~/.dsc/desktop.json` 的 `ui`）说了算。
 *
 * 显式写的 `shell` / `legacy` 都被尊重（用户把默认掰回去是合法操作）；
 * 缺失 / 读坏 / 值不认识落到 {@link DEFAULT_UI_PROFILE}。
 * `DSC_UI_SHELL` 是自检与开发期的直通开关（`1` 强制壳、`0` 强制旧界面），
 * 压过档案——自动化脚本不该去改用户的档案，也不该依赖它。
 */
function uiProfile(): 'legacy' | 'shell' {
  if (process.env['DSC_UI_SHELL'] === '1') return 'shell'
  if (process.env['DSC_UI_SHELL'] === '0') return 'legacy'
  const fromState = readState().ui
  if (fromState === 'shell') return 'shell'
  if (fromState === 'legacy') return 'legacy'
  return DEFAULT_UI_PROFILE
}

/** 宿主该伺服的界面产物目录（经 `DSC_UI_ASSETS` 交给宿主进程）。 */
function uiAssetsDir(): string {
  if (uiProfile() === 'shell') {
    const dir = shellDir()
    // 壳产物缺失（路径解析错、构建没跑）时退回旧渲染层并说清，别让用户对一张白屏。
    // 这道闸就是自检 ui-fallback 用例的落点：打包态的路径解析错了，窗口仍有完整旧界面。
    if (existsSync(dir)) return dir
    process.stderr.write(`[dsc-desktop] 插件壳产物不存在（${dir}），退回旧渲染层\n`)
  }
  return rendererDir()
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
 * 接收宿主报来的界面地址：认证一次、记下根地址，然后（仅第一次）把窗口切到那份文档。
 *
 * 为什么不在宿主重启后重新加载：重启后渲染层的 `window.dsc` 通道照旧（IPC 走主进程，
 * 主进程换的是协议对象），重载只会把界面状态（打开的会话、草稿）刷掉；这里只刷新
 * Cookie，让用户之后手动刷新页面时仍然进得去。
 */
async function adoptUiServer(info: { url: string; origin: string }): Promise<void> {
  const ok = await authenticateUiServer(info.url)
  if (!ok) {
    process.stderr.write('[dsc-desktop] 界面地址认证失败，窗口继续用本机文件加载\n')
    return
  }
  uiServerOrigin = info.origin
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  // 开发模式下页面来自 vite，别把窗口抢过去；已经切过的也不重载。
  if ((process.env.ELECTRON_RENDERER_URL ?? '') !== '' || servedPageLoaded) return
  servedPageLoaded = true
  process.stderr.write(`[dsc-desktop] 窗口来自宿主界面服务 ${info.origin}\n`)
  void window.loadURL(desktopPageUrl())
}

/** 窗口该加载的地址：带自检查询参数（demo / search）的那一份。 */
function desktopPageUrl(): string {
  const query = [
    process.env.DSC_DESKTOP_DEMO === '1' ? 'demo=1' : '',
    process.env.DSC_DESKTOP_SEARCH ?? '',
  ]
    .filter((part) => part !== '')
    .join('&')
  return query === '' ? (uiServerOrigin ?? '') : `${uiServerOrigin ?? ''}/?${query}`
}

/** 启动 headless 宿主（utilityProcess；入口为应用自有编译产物，无用户输入）。 */
function startHost(cwd: string): void {
  hostCwd = cwd
  const entry = resolveHeadlessEntry()
  const assetsDir = uiAssetsDir()
  // 这一行是「界面形态」的唯一可观测信号：切换期验收看 stderr，不看绿不绿
  // （阶段 93 的教训——认证回落会把「没切过去」藏在一路绿灯里）。
  process.stderr.write(
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
  protocol.onUiUrl((info) => {
    void adoptUiServer(info)
  })
  protocol.onClose(({ code }) => {
    const silent = suppressHostExit
    suppressHostExit = false
    protocol = null
    if (!quitting && !silent) {
      mainWindow?.webContents.send('dsc:host-exit', { code })
    }
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
  created.setToolTip('Muse Code — 点我回到窗口')
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
 * 用多种方式打开当前工作区。terminal：优先 Windows Terminal，没装退回经
 * PowerShell 指定工作目录的 cmd；vscode：借 cmd.exe 调 code 垫片（Node 直接
 * spawn .cmd 会被拦）；explorer：shell.openPath。
 */
function openWorkspace(kind: string): WorkspaceOpenResult | Promise<WorkspaceOpenResult> {
  const dir = hostCwd
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

function registerIpc(): void {
  ipcMain.handle('dsc:invoke', (_event, method: string, args: unknown[]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke(method, args ?? [])
  })

  ipcMain.handle('dsc:get-cwd', () => hostCwd)

  // ── 旧渲染层那批通道 ──────────────────────────────────────────────────────
  // 默认界面仍是旧渲染层（档案开关默认 legacy），这些一个都不能少。实现体统一抽成
  // 上面/下面的具名函数，好让原生桥与它们走同一条路（改一处两处都跟着变）。
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
  ipcMain.handle('dsc:plugins-install', async () => {
    if (mainWindow === null) return []
    const outcome = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Muse Code 插件文件',
      filters: [{ name: 'Muse Code 插件', extensions: ['js'] }],
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
  })

  // 选择技能（SKILL.md 所在目录，或扁平 .md 文件）并复制到 ~/.dsc/skills/
  ipcMain.handle('dsc:skills-install', async () => {
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
  })

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
    title: '选择 Muse Code 工作目录',
    properties: ['openDirectory'],
    defaultPath: hostCwd || undefined,
  })
  if (outcome.canceled || outcome.filePaths.length === 0) return null
  const next = resolve(outcome.filePaths[0] ?? '')
  if (next !== hostCwd) await restartHost(next)
  return next
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
  void shell.openExternal(url)
}

/** 原生窗口控件区上色：只收 #rrggbb（带 alpha 的颜色到了系统那侧会被丢掉）。 */
function applyWindowChrome(bar: unknown, symbol: unknown): void {
  if (isSelfCheck()) {
    process.stderr.write(`[selfcheck] 控件条颜色 ${String(bar)} ${String(symbol)}\n`)
  }
  if (!isChromeColor(bar) || !isChromeColor(symbol) || !mainWindow) return
  mainWindow.setTitleBarOverlay({ color: bar, symbolColor: symbol, height: CAPTION_HEIGHT })
  mainWindow.setBackgroundColor(bar)
}

/** 原生弹层（下拉、右键菜单）的深浅。 */
function applyThemeSource(mode: unknown): void {
  if (mode !== 'dark' && mode !== 'light' && mode !== 'system') return
  if (isSelfCheck()) process.stderr.write(`[selfcheck] 原生主题源 ${mode}\n`)
  nativeTheme.themeSource = mode
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
  switchCwd: ([path]) => switchCwdTo(String(path)),
  recentCwds: (): string[] => readState().recentCwds ?? [],
  removeRecentCwd: ([path]) => {
    removeRecentCwdEntry(String(path))
  },
  openPath: ([path]) => openPathBySystem(path),
  openExternal: ([url]) => {
    openExternalUrl(url)
  },
  openWorkspace: ([kind]) => openWorkspace(String(kind)),
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
  mainWindow = new BrowserWindow({
    width: memory.width,
    height: memory.height,
    ...(memory.x !== undefined ? { x: memory.x, y: memory.y } : {}),
    minWidth: 960,
    minHeight: 640,
    // 无边框：Windows 用原生 overlay 窗口控件，renderer 内留出拖拽区。
    // 窗口底色与控件区按深色主题起步；选浅色主题时 renderer 在外观生效那一刻
    // 把压平后的两个颜色报过来（IPC 频道 dsc:set-window-chrome）。
    backgroundColor: DARK_CHROME.bar,
    title: 'Muse Code',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: DARK_CHROME.bar,
      symbolColor: DARK_CHROME.symbol,
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
      process.stderr.write(`[selfcheck] 页面加载完成，${delay}ms 后截图 ${shotPath}\n`)
      const watchdog = setTimeout(() => {
        process.stderr.write('[selfcheck] 截图超时，强制退出\n')
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
              process.stderr.write(`[selfcheck] 预跑脚本完成：${JSON.stringify(value) ?? '无返回值'}\n`)
            )
            .catch((error: unknown) => process.stderr.write(`[selfcheck] 预跑脚本失败：${String(error)}\n`))
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
            process.stderr.write(`[selfcheck] 已写出 ${shotPath}\n`)
          })
          .catch((error: unknown) => process.stderr.write(`[selfcheck] 截图失败：${String(error)}\n`))
          .finally(() => {
            clearTimeout(watchdog)
            app.exit(0)
          })
      }, delay)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      process.stderr.write(`[selfcheck] 页面加载失败：${code} ${description}\n`)
    })
  }

  // 自检参数：DSC_DESKTOP_DEMO=1 自动跑一轮真实对话；DSC_DESKTOP_SEARCH 直接打开某个界面
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const query = [
    process.env.DSC_DESKTOP_DEMO === '1' ? 'demo=1' : '',
    process.env.DSC_DESKTOP_SEARCH ?? '',
  ]
    .filter((part) => part !== '')
    .join('&')
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void mainWindow.loadURL(`${devServerUrl}/${query === '' ? '' : `?${query}`}`)
  } else if (uiServerOrigin !== null) {
    // 宿主比窗口先起来（内核快时走这条）：直接加载伺服的那份文档，不必先落文件再切。
    servedPageLoaded = true
    process.stderr.write(`[dsc-desktop] 窗口来自宿主界面服务 ${uiServerOrigin}\n`)
    void mainWindow.loadURL(desktopPageUrl())
  } else {
    // 先用本机文件把窗口开起来（渲染层自己会显示「连接中」），宿主报来界面地址后再切过去。
    // 那份文件与宿主伺服的是同一份构建产物（都出自 desktop/out/renderer）。
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      search: query === '' ? undefined : query,
    })
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
        title: 'Muse Code 还在后台运行',
        content: '点击托盘图标回到窗口，右键图标可完全退出；此提示仅出现一次，关窗行为可在设置 → 通用中修改',
      })
    }
  })

  mainWindow.on('closed', () => {
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
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    quitApp()
  })
}
