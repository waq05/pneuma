/**
 * 检查更新与「就地更新」的桌面主进程那一半。
 *
 * ## 为什么整套住在主进程
 *
 * 宿主那侧（`src/core/update-check.ts`）只够得着「问版本号 + 挑安装器」——下载要落文件、
 * 装要起安装程序、装完要退出应用，三件都是 Electron 主进程的事。把「检查」放一边、
 * 「安装」放另一边，两边各存一份状态迟早对不上，所以整套收在这里：自己排期、自己下载、
 * 自己起安装程序。宿主那侧只剩设置页那颗按钮与 `/update` 命令在问版本号。
 *
 * ## 排期
 *
 * 时机现读 `~/.dsc/settings.json` 的 `updateCheck`（与 `closeToTrayEnabled()` 同一读法），
 * 所以设置里改完**不用重启**就生效：定时器每半小时醒一次重新判一遍该不该查。
 *   - `launch`：本次运行查一次就够（「每次启动」就是这个语义），启动后隔 8 秒问，
 *     别跟开窗那几秒抢网络；
 *   - `daily`：距上次满 24 小时才问；
 *   - `off`：不问，状态回到 `idle`。
 *
 * ## 边界
 *
 * 下载地址只从**我们自己拉到的发布资产**里挑（`pickInstaller`），页面递不进任何 URL；
 * 安装器落在 `userData/updates/`（**不自动清理**：安装程序可能正在跑，删了会打断它。
 * 同一个版本号的文件名固定，下次下载直接覆盖，不会越攒越多）。
 *
 * @module desktop/main/update
 */
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { app, shell, type BrowserWindow } from 'electron'
import { compareVersions, fetchLatestRelease, pickInstaller, type ReleaseAsset } from '@dsc/runtime/core/update-check.js'
import { UPDATE_CHECK_MODES, type UpdateCheckMode } from '@dsc/runtime/core/prefs.js'
import { readState, writeState } from './dsc-core.js'

/** 更新状态：`idle` 不查 / `checking` 正在问 / `latest` 已最新 / `available` 有新版 / `error` 问不到。 */
export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'error'

/** 推给界面的更新状态（形状与 `NATIVE_EVENTS` 的 `update-status` 一字不差）。 */
export interface UpdateState {
  status: UpdateStatus
  /** 有新版时的版本号（`latest` 档也给，等于当前版本）。 */
  version?: string
  /** 有新版时的发布页地址（挑不出安装器时界面靠它给一条出路）。 */
  pageUrl?: string
  /** 挑得出的安装器名字与大小；挑不出时没有这两项。 */
  assetName?: string
  size?: number
  /** 问不到时给用户看的一句话。 */
  error?: string
}

/** 启动后隔多久问第一次（别跟开窗那几秒抢网络）。 */
const FIRST_DELAY_MS = 8_000
/** `daily` 档的间隔。 */
const DAILY_MS = 24 * 60 * 60 * 1000
/** 定时器周期：够密到「改了档位不用重启就生效」，又远不到打搅更新源的程度。 */
const TICK_MS = 30 * 60 * 1000

/**
 * 本地版本号。
 *
 * 为什么不用 `app.getVersion()`：**开发态它会回落到 Electron 自己的版本**（44.x）——直接跑
 * `electron out/main/index.js` 时没有「app 包清单」这个概念，而这个数比任何真版本都大，
 * 检查更新会永远报「已最新」（2026-10-14 真机验收就是这么撞上的）。打包态 `app.getVersion()`
 * 是对的（electron-builder 把 desktop/package.json 写进 asar），但两态用一个来源更省心：
 * 这个文件在两态下都躺在 `__dirname/../../package.json`（打包后是 asar 内的那份）。
 */
function localVersion(): string {
  try {
    const doc = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    if (typeof doc.version === 'string' && doc.version !== '') return doc.version
  } catch {
    // 读不出来再问 Electron：至少是个数，不会把比较整段跳过
  }
  return app.getVersion()
}

interface Deps {
  /** 取主窗口（可能还没建好或已销毁）。 */
  window: () => BrowserWindow | null
  /** 退出应用（与托盘「完全退出」同一条路：停宿主 → app.quit）。 */
  quit: () => void
}

let deps: Deps | null = null
let state: UpdateState = { status: 'idle' }
/** 本次运行是否还欠一次 `launch` 档的检查（查过就不再查；切到 off 会重新上膛）。 */
let launchArmed = true
/** 有没有一次检查 / 下载正在跑（防重入）。 */
let busy = false
let timer: NodeJS.Timeout | null = null

/** 推一条状态给界面。窗口不在（还没建 / 已销毁）就丢掉——壳挂载时会自己 `checkUpdate` 取一次。 */
function push(): void {
  deps?.window()?.webContents.send('dsc:update-status', state)
}

/** 推一条下载进度。 */
function pushProgress(received: number, total: number): void {
  deps
    ?.window()
    ?.webContents.send('dsc:update-progress', {
      received,
      total,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
    })
}

/** 现读检查更新时机（与 `closeToTrayEnabled()` 同一读法：设置里改完不用重启）。 */
function checkMode(): UpdateCheckMode {
  try {
    const doc = JSON.parse(
      readFileSync(join(app.getPath('home'), '.dsc', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>
    const value = doc['updateCheck']
    return UPDATE_CHECK_MODES.includes(value as UpdateCheckMode) ? (value as UpdateCheckMode) : 'launch'
  } catch {
    return 'launch'
  }
}

/**
 * 本次运行该不该查。
 *
 * 拆出来是因为它有两个调用方：启动时那一次，以及每半小时醒一次的定时器——
 * 后者是「设置里改了档位立刻生效」的实现方式（主进程收不到设置写入的通知，
 * 靠现读文件 + 定期重新判）。
 */
function dueNow(): boolean {
  const mode = checkMode()
  if (mode === 'off') {
    // 切到 off 就把 launch 档重新上膛：用户之后改回「每次启动」时该查还得查。
    launchArmed = true
    return false
  }
  if (mode === 'launch') return launchArmed
  return Date.now() - (readState().lastUpdateCheckAt ?? 0) >= DAILY_MS
}

/** 问一次更新源，把结果记进内存与 desktop.json，并推给界面。 */
export async function checkNow(): Promise<UpdateState> {
  if (busy) return state
  busy = true
  state = { status: 'checking' }
  push()
  // 本地版本走 localVersion()（见它的注释：开发态 app.getVersion() 会读成 Electron 的版本）。
  // 也不用 core/version 那套上溯查找——打包后 app.asar 往上找不到根 package.json，会读成 0.0.0。
  const result = await fetchLatestRelease(localVersion())
  if (!result.ok) {
    state = { status: 'error', error: result.error }
  } else if (!result.update) {
    state = { status: 'latest', version: result.info.version }
  } else {
    const asset = pickInstaller(result.info.assets, result.info.version)
    state = {
      status: 'available',
      version: result.info.version,
      pageUrl: result.info.pageUrl,
      ...(asset === null ? {} : { assetName: asset.name, size: asset.size }),
    }
  }
  // 只有真问到才记账：网络抖一下不该让 daily 档整整一天不再试。
  if (result.ok) writeState({ lastUpdateCheckAt: Date.now(), lastUpdateVersion: state.version ?? '' })
  busy = false
  push()
  return state
}

/**
 * 就地更新：现问一次拿资产地址（缓存的只有版本号）→ 下载（进度推 `update-progress`）
 * → 启动安装程序 → 退出本应用。
 *
 * 为什么必须退出：安装器要替换正在运行的那几个文件，不关掉装不进去。NSIS 向导照旧
 * （可改安装目录），退出只是让向导别卡在「请先关闭 Pneuma」上。
 */
export async function installNow(): Promise<{ ok: true; assetName: string } | { ok: false; error: string }> {
  if (busy) return { ok: false, error: '上一次检查或下载还没结束' }
  busy = true
  try {
    const result = await fetchLatestRelease(localVersion())
    if (!result.ok) return { ok: false, error: result.error }
    if (!result.update) return { ok: false, error: `已是最新（${localVersion()}）` }
    const asset: ReleaseAsset | null = pickInstaller(result.info.assets, result.info.version)
    if (asset === null) return { ok: false, error: '这一版没有可下载的安装器，请打开发布页手动下载' }

    const dir = join(app.getPath('userData'), 'updates')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, asset.name)

    let response: Response
    try {
      response = await fetch(asset.url)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `下载失败：连不上（${reason}）` }
    }
    if (!response.ok || response.body === null) {
      return { ok: false, error: `下载失败：更新源返回 ${response.status}` }
    }
    const headerLength = Number(response.headers.get('content-length') ?? '')
    const total = asset.size > 0 ? asset.size : Number.isFinite(headerLength) ? headerLength : 0

    const out = createWriteStream(file)
    let received = 0
    try {
      for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
        const buffer = chunk as Buffer
        received += buffer.length
        out.write(buffer)
        pushProgress(received, total)
      }
      await new Promise<void>((done, fail) => {
        out.on('error', fail)
        out.end(() => {
          done()
        })
      })
    } catch (error) {
      out.destroy()
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `下载失败：写文件出错（${reason}）` }
    }
    pushProgress(received, total)

    // 起安装程序。失败就如实报，别把应用关了让用户面对「什么都没发生」。
    const problem = await shell.openPath(file)
    if (problem !== '') return { ok: false, error: `启动安装程序失败：${problem}` }
    // 给安装器窗口一点时间起来再退：用户看得见「在装了」才看着应用关掉，不然像崩了。
    setTimeout(() => deps?.quit(), 1200)
    return { ok: true, assetName: asset.name }
  } finally {
    busy = false
  }
}

/** 当前状态（壳挂载时先取一次：事件是「之后的变化」，错过开机那一次就再也没有了）。 */
export function updateState(): UpdateState {
  return state
}

/**
 * 界面问「现在是什么状态」，顺手补一次检查。
 *
 * 为什么带这个副作用：壳挂载时会调 `checkUpdate`，而排期那一次（启动后 8 秒）可能还没到
 * ——开窗几秒内就该有结论，不该让用户盯着一个「暂时没有按钮」的空位。已经在跑或已有结论
 * 时什么都不做，所以它不会变成「每开一次窗多问一次」。
 */
export function ensureChecked(): UpdateState {
  if (state.status === 'idle' && checkMode() !== 'off') {
    launchArmed = false
    void checkNow()
  }
  return state
}

/**
 * 上电：把上次查到的那一版先画出来，然后排期。
 *
 * @param injected 主窗口取用与退出动作（主进程那侧提供）
 */
export function startUpdateChecks(injected: Deps): void {
  deps = injected
  // 缓存先上屏：上次查到有新版、这次还没问完时，按钮不该消失一下再出现。
  const cached = readState().lastUpdateVersion ?? ''
  if (cached !== '' && (compareVersions(cached, localVersion()) ?? 0) > 0) {
    state = { status: 'available', version: cached }
  } else if (checkMode() === 'off') {
    state = { status: 'idle' }
  }
  const first = setTimeout(() => {
    if (dueNow()) {
      launchArmed = false
      void checkNow()
    }
  }, FIRST_DELAY_MS)
  first.unref?.()
  timer = setInterval(() => {
    if (!dueNow()) return
    launchArmed = false
    void checkNow()
  }, TICK_MS)
  timer.unref?.()
}

/** 停掉定时器（退出流程用；现在没别的调用方，留着免得测试环境里挂着）。 */
export function stopUpdateChecks(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}
