/**
 * dock-browser 插件：让 agent 驱动**侧栏那台浏览器**（桌面主进程里的原生 WebContentsView）。
 *
 * 这条链路长什么样（与 `browser.ts` 那台自管 Chrome 是两回事）：
 *
 * ```
 * 工具 browser_dock / browser_dock_look（本文件）
 *    │  ctx.get('hostBrowser')  ← 每次调用现取，取不到就报一句人话
 * 宿主链路门面 HostBrowserLink（实现在 host-stdio 里）
 *    │  parentPort 消息：browser-call / browser-open / browser-close / browser-views
 * 桌面主进程（desktop/electron/main/dock.ts）
 *    │  webContents.debugger.attach('1.3') + sendCommand
 * dock 视图（WebContentsView，持久分区 persist:dsc-browser，带用户登录态）
 * ```
 *
 * 为什么和 `browser.ts` 分成两个插件、不合并：
 *   - 那台是**一次性 Chrome**——自己拉起进程、自建临时 profile、退出整树杀；生命周期全在本进程里；
 *   - 这台是**用户自己的侧栏浏览器**——视图的创建/聚焦/尺寸归桌面壳与渲染层管（`browser-open`
 *     要先让壳把页签开出来并聚焦，否则被节流的页面上截图会卡死），分区是持久的、带着登录态。
 *   两者的启动、生命周期、信任口径都不一样，合在一起会把既有那台的逻辑搅进来。
 *   而「快照 + ref 定位 + CDP 动作」那套算法是共用的：直接复用 `src/core/cdp/`，
 *   这里只做「薄薄一层」——动作映射、ref 代际、事件缓冲与给人看的输出。
 *
 * 信任模型的两条硬约束（详见 `docs/dock-browser-control.md`）：
 *   - `browser_dock_look` **默认不注册**，只有设置里 `lookWithoutApproval` 打开才以 `read` 注册：
 *     这台浏览器跑在用户自己的持久分区里（`persist:dsc-browser`、带登录态），
 *     看一眼现状（快照/截图/控制台）不该无条件免审批——与 `computer-use.ts` 那条先例同口径；
 *   - `evaluate` 必须过与 `browser.ts` **同一道敏感原语黑名单**（`actions.scanExpression`）：
 *     换了后端也不许少一道闸。
 *
 * @module dsc/plugins/dock-browser
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { ToolEntry, ToolContext, ToolOutput } from '../core/tools.js'
import type { SettingsField, SettingsValue } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { neutralizeInline, wrapUntrusted } from '../core/untrusted.js'
import { redact } from '../core/secrets.js'
import { DOCK_ACTIONS, DOCK_LOOK_ACTIONS, isAgentView } from '../core/dock-browser.js'
import { HOST_BROWSER_SERVICE, type HostBrowserLink } from '../core/host-browser-link.js'
import { CLOUD_METADATA_HOSTS } from './browser.js'
import type { CdpCommandTarget, CdpSessionView } from '../core/cdp/transport.js'
import * as actions from '../core/cdp/actions.js'
import {
  lookupSnapshotRef,
  serializeAxTree,
  truncateByLines,
  type AxTree,
  type SnapshotRef,
} from '../core/cdp/snapshot.js'

const CONFIG_KEY = 'dock-browser'
/** 设置分区 id：与配置键同名，元数据 `settingsSection` 指向它。 */
const SECTION_ID = 'dock-browser'
const TOOL_ACT = 'browser_dock'
const TOOL_LOOK = 'browser_dock_look'

/** 等页面加载完的上限（与 browser.ts 同量级）。 */
const NAVIGATE_TIMEOUT_MS = 20_000
/** 控制台一条最长多少字符（整段堆栈会很长）。 */
const CONSOLE_LINE_MAX = 400

/** 插件配置（存 `~/.dsc/plugins.json` 的 `dock-browser` 条目 config 里）。 */
interface DockBrowserConfig {
  /** 看侧栏浏览器免审批：开着才另外注册 `browser_dock_look`（read 档）。 */
  lookWithoutApproval: boolean
  /** 一份快照最多多少字符（按行截断，绝不切碎元素）。 */
  maxSnapshotChars: number
  /** 控制台环形缓冲条数。 */
  consoleBuffer: number
  /** 网络环形缓冲条数。 */
  networkBuffer: number
  /** 等元素/文本出现的上限毫秒。 */
  waitTimeoutMs: number
}

const DEFAULTS: DockBrowserConfig = {
  lookWithoutApproval: false,
  maxSnapshotChars: 15_000,
  consoleBuffer: 200,
  networkBuffer: 50,
  waitTimeoutMs: 5000,
}

/** 没有桌面壳时给模型看的那句话（不抛栈，也不静默什么都不做）。 */
const NO_SHELL_MESSAGE =
  '宿主里没有桌面壳，这条能力要在桌面端窗口里用：侧栏浏览器由桌面主进程提供（TUI / 无头 / 远程壳里拿不到它）。'

// ── 小工具（与 browser.ts 同风格，便于两处输出读起来一致）─────────────────────

/** 定长环形缓冲：满了丢最旧的（照 browser.ts 的 RingBuffer 思路）。 */
class RingBuffer<T> {
  private items: T[] = []

  constructor(private capacity: number) {}

  push(item: T): void {
    this.items.push(item)
    if (this.capacity > 0 && this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity)
    }
  }

  find(predicate: (item: T) => boolean): T | undefined {
    return this.items.find(predicate)
  }

  toArray(): T[] {
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }
}

/** 一行人类可读摘要 + 一行结构化 JSON（照 browser.ts 的 report）。 */
function report(summary: string, data: Record<string, unknown>): string {
  return `${summary}\n${JSON.stringify(data)}`
}

/** 时间戳 → HH:MM:SS。 */
function clock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19)
}

/** 变量值的兜底字符串化（控制台参数可能是对象或循环引用）。 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** ref 的人类可读描述（输出与错误信息里用）。 */
function describeRef(ref: SnapshotRef): string {
  return `${ref.role}${ref.name === '' ? '' : ` "${ref.name}"`}`
}

/** 数字参数收敛到区间内；不是数字就取默认值。 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
}

/**
 * 云元数据地址无条件拒。
 *
 * 理由与 `evaluate` 那条敏感原语黑名单完全相同——换了后端也不许少一道：
 * 这些地址给虚拟机发临时凭据，被网页内容牵着走的模型绝不该 GET 它们。
 * 只复用 `browser.ts` 导出的 `CLOUD_METADATA_HOSTS`（那是现成的判定数据），
 * **不搬**它整套域名 allow/deny 与私网判定：那是给自管那台一次性 Chrome 定的口径，
 * 这台是用户自己的浏览器（localhost 之类可能是他正常的开发目标）。
 */
function assertNotCloudMetadata(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (CLOUD_METADATA_HOSTS.includes(host)) {
    throw new Error(`云元数据地址（${host}）无条件拒绝：它给虚拟机发临时凭据，浏览器自动化绝不该碰`)
  }
}

/**
 * 拒明显非 http(s) 的地址、以及云元数据地址。
 *
 * 桌面侧收到 `Page.navigate` 会再用 `dockNavigateTarget` + `isHttpUrl` 复检一遍——
 * 这里这道是**第一道**：把 `file://` / `javascript:` / `data:` 这类在进审批之前就挡掉，
 * 两道都在，谁也不替谁省。
 */
function assertHttpUrl(raw: string): string {
  const text = raw.trim()
  if (text === '') throw new Error('要一个地址，例如 https://example.com/')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`地址解析不了：${text}（要带协议，例如 https://example.com/）`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只允许 http/https；${parsed.protocol} 这类协议（file:、javascript:、data:、chrome: 等）不通过`)
  }
  assertNotCloudMetadata(parsed.hostname)
  return text
}

// ── 每台视图的会话状态 ───────────────────────────────────────────────────────

interface ConsoleEntry {
  ts: number
  level: string
  text: string
}

interface NetworkEntry {
  ts: number
  requestId: string
  method: string
  url: string
  status: number
  mimeType: string
  failed: string
}

/** 一台 dock 视图的 CDP 会话与 ref 代际。 */
interface ViewState {
  /** 这条会话绑在哪条链路上（链路换了要重建，旧 sessionId 作废）。 */
  link: HostBrowserLink
  viewId: string
  target: CdpCommandTarget
  /** Page/DOM/Accessibility/Runtime 四个域开过没有。 */
  domainsReady: boolean
  /** Network 域开过没有（只在真的要看网络时才开，事件是跨进程推的）。 */
  networkReady: boolean
  /** ref 代际：每次快照 +1；导航/文档被换掉也 +1。 */
  generation: number
  refs: Map<string, SnapshotRef>
  /** ref 被作废的原因（错误信息里用）。 */
  refsInvalidReason: string
}

interface SnapshotOutcome {
  text: string
  url: string
  title: string
  interactiveCount: number
  refCount: number
  lineCount: number
  truncated: boolean
}

export const dockBrowserPlugin: Plugin.Object = {
  name: 'dock-browser',
  inject: ['tools', 'settings'],
  apply(ctx, passed: unknown) {
    const readConfig = (): DockBrowserConfig => {
      const raw = resolvePluginConfig(CONFIG_KEY, passed)
      return {
        lookWithoutApproval: raw.lookWithoutApproval === true || raw.lookWithoutApproval === 'true',
        maxSnapshotChars: clamp(raw.maxSnapshotChars, 500, 200_000, DEFAULTS.maxSnapshotChars),
        consoleBuffer: clamp(raw.consoleBuffer, 0, 2000, DEFAULTS.consoleBuffer),
        networkBuffer: clamp(raw.networkBuffer, 0, 2000, DEFAULTS.networkBuffer),
        waitTimeoutMs: clamp(raw.waitTimeoutMs, 100, 120_000, DEFAULTS.waitTimeoutMs),
      }
    }
    // lookWithoutApproval 决定「只读工具注册与否」，每次改设置都会 syncTools 重挂一次
    // （照 computer-use.ts 的先例）；其余字段每次用值时现读，不必重启宿主。
    let config = readConfig()

    /** 每台视图的状态（会话 + ref 代际）。 */
    const states = new Map<string, ViewState>()
    /** 每台视图的控制台/网络环形缓冲。 */
    const rings = new Map<string, { console: RingBuffer<ConsoleEntry>; network: RingBuffer<NetworkEntry> }>()
    /** 已经订上事件的那条链路（链路换了要重订）。 */
    let subscribed: HostBrowserLink | null = null
    let offEvents: (() => void) | null = null

    const ringsFor = (viewId: string): { console: RingBuffer<ConsoleEntry>; network: RingBuffer<NetworkEntry> } => {
      let bucket = rings.get(viewId)
      if (bucket === undefined) {
        bucket = { console: new RingBuffer<ConsoleEntry>(config.consoleBuffer), network: new RingBuffer<NetworkEntry>(config.networkBuffer) }
        rings.set(viewId, bucket)
      }
      return bucket
    }

    /** 作废一台视图的 ref（页面跳转、文档被换、关掉都算）。 */
    const invalidate = (viewId: string, reason: string): void => {
      const state = states.get(viewId)
      if (state === undefined) return
      state.generation += 1
      state.refs.clear()
      state.refsInvalidReason = reason
    }

    /** 控制台参数 → 一行文本。 */
    function consoleLineText(params: Record<string, unknown>): string {
      const list = Array.isArray(params.args) ? params.args : []
      return list
        .map((arg) => {
          const record = arg as { value?: unknown; description?: string; type?: string }
          if (record.value !== undefined) return safeStringify(record.value)
          return record.description ?? record.type ?? '?'
        })
        .join(' ')
        .slice(0, CONSOLE_LINE_MAX)
    }

    /** 订 CDP 事件推送：控制台 / 异常 / 网络进环形缓冲，跳转与文档被换作废 ref。 */
    function ensureEvents(link: HostBrowserLink): void {
      if (subscribed === link) return
      if (offEvents !== null) {
        try {
          offEvents()
        } catch {
          // 退订失败不影响重订
        }
      }
      subscribed = link
      offEvents = link.onEvent((event) => {
        const bucket = ringsFor(event.viewId)
        switch (event.method) {
          case 'Runtime.consoleAPICalled':
            bucket.console.push({ ts: Date.now(), level: String(event.params.type ?? 'log'), text: consoleLineText(event.params) })
            break
          case 'Runtime.exceptionThrown': {
            const details = event.params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
            bucket.console.push({
              ts: Date.now(),
              level: 'exception',
              text: (details?.exception?.description ?? details?.text ?? '未知异常').slice(0, CONSOLE_LINE_MAX),
            })
            break
          }
          case 'Network.requestWillBeSent': {
            const request = event.params.request as { url?: string; method?: string } | undefined
            bucket.network.push({
              ts: Date.now(),
              requestId: String(event.params.requestId ?? ''),
              method: String(request?.method ?? 'GET'),
              url: String(request?.url ?? ''),
              status: 0,
              mimeType: '',
              failed: '',
            })
            break
          }
          case 'Network.responseReceived': {
            const response = event.params.response as { status?: number; mimeType?: string } | undefined
            const entry = bucket.network.find((item) => item.requestId === String(event.params.requestId ?? ''))
            if (entry === undefined) break
            entry.status = typeof response?.status === 'number' ? response.status : 0
            entry.mimeType = String(response?.mimeType ?? '')
            break
          }
          case 'Network.loadingFailed': {
            const entry = bucket.network.find((item) => item.requestId === String(event.params.requestId ?? ''))
            if (entry === undefined) break
            entry.failed = String(event.params.errorText ?? '请求失败')
            break
          }
          case 'Page.frameNavigated': {
            // 主框架跳转 = 整页换文档：旧 ref 的 backendNodeId 全部失去意义
            const frame = event.params.frame as { parentId?: string } | undefined
            if (frame?.parentId === undefined) invalidate(event.viewId, '页面已经跳转到别的地址')
            break
          }
          case 'Runtime.executionContextsCleared':
            invalidate(event.viewId, '页面的文档被换掉了')
            break
          default:
            // 白名单之外的事件本就不该推过来，静默忽略
            break
        }
      })
    }

    /** 取链路；取不到或不可用就给一句人话（不抛栈、不静默）。 */
    const requireLink = (): HostBrowserLink => {
      // hostBrowser 由 host-stdio 插件提供；没有桌面壳时这个服务根本不存在。
      // 用类型注记接住 cordis 的 any 返回值，别让它漫进后面的代码。
      const link: HostBrowserLink | undefined = ctx.get(HOST_BROWSER_SERVICE)
      if (link === undefined || !link.available()) throw new Error(NO_SHELL_MESSAGE)
      ensureEvents(link)
      return link
    }

    /** 拿（或建）一台视图的会话状态。 */
    const session = (link: HostBrowserLink, viewId: string): { state: ViewState; page: CdpSessionView } => {
      let state = states.get(viewId)
      if (state === undefined || state.link !== link) {
        state = {
          link,
          viewId,
          target: link.session(viewId),
          domainsReady: false,
          networkReady: false,
          generation: 0,
          refs: new Map<string, SnapshotRef>(),
          refsInvalidReason: '',
        }
        states.set(viewId, state)
      }
      // 动作层（src/core/cdp/actions.ts）目前的形参类型仍收在 CdpSessionView 上，
      // 而 link.session() 按契约给的是结构类型 CdpCommandTarget。两者运行时形状一致
      // （动作层只用 send/on，从不碰 CdpSessionView 的 connection），所以这里做一次
      // 明确的下行断言。线 2 会把动作层的形参放宽成 CdpCommandTarget，届时可删掉它。
      const page = state.target as CdpSessionView
      return { state, page }
    }

    /** 开域：Page/DOM/Accessibility/Runtime 总是要，Network 只在要看网络时开。 */
    const ensureDomains = async (state: ViewState, page: CdpSessionView, needNetwork: boolean): Promise<void> => {
      if (!state.domainsReady) {
        await page.send('Page.enable')
        await page.send('Runtime.enable')
        await page.send('DOM.enable')
        await page.send('Accessibility.enable')
        state.domainsReady = true
      }
      if (needNetwork && !state.networkReady) {
        await page.send('Network.enable')
        state.networkReady = true
      }
    }

    /** 要一个 viewId 参数（动作层用它指名一台视图）。 */
    const requireViewId = (args: Record<string, unknown>): string => {
      const viewId = String(args.viewId ?? '').trim()
      if (viewId === '') {
        throw new Error('这一步要一个 viewId：先 browser_dock action=open 开一张，或 browser_dock_look action=views 看现在有哪几台')
      }
      return viewId
    }

    // ── 快照（复用 serializeAxTree，代际写进 ref）────────────────────────────

    async function takeSnapshot(state: ViewState, page: CdpSessionView, options: { full: boolean; maxChars: number }): Promise<SnapshotOutcome> {
      const tree = await page.send<AxTree>('Accessibility.getFullAXTree', { depth: -1 })
      state.generation += 1
      const serialized = serializeAxTree(tree, { full: options.full, generation: state.generation })
      state.refs = new Map(serialized.refs)
      state.refsInvalidReason = ''
      const doc = await actions.readDocumentState(page).catch(() => ({ url: '', title: '', readyState: 'unknown' }))
      const header =
        `视图 ${state.viewId} 当前地址 ${neutralizeInline(doc.url, 300)}` +
        `${doc.title === '' ? '' : `（标题「${neutralizeInline(doc.title, 120)}」）`}` +
        `，视图=${options.full ? 'full（完整树）' : 'compact（只列可交互元素）'}` +
        `，可交互元素 ${serialized.interactiveCount} 个，本次 ref ${serialized.refCount} 个（从 e1 起）`
      const body =
        serialized.lineCount === 0
          ? '（这份视图里一个元素都没有：页面可能是空白，或者内容全在同进程 iframe 里——iframe 不是独立 target 时 CDP 挂不进去，可以先用 browser_dock_look action=screenshot 看一眼是不是真有内容）'
          : serialized.text
      const note = (remaining: number): string =>
        `[... 还有 ${remaining} 行没显示：加 maxChars 可以放大上限，或先缩小范围再快照；更长的输出 spill 插件会自动落盘，用 read 工具翻]`
      const truncated = truncateByLines(`${header}\n${body}`, options.maxChars, note)
      return {
        text: `${wrapUntrusted('browser', truncated.text)}\n（本页共 ${serialized.lineCount} 行树，显示了前 ${truncated.shownLines} 行${truncated.truncated ? '，后面截断了' : ''}）`,
        url: doc.url,
        title: doc.title,
        interactiveCount: serialized.interactiveCount,
        refCount: serialized.refCount,
        lineCount: serialized.lineCount,
        truncated: truncated.truncated,
      }
    }

    /** 文本 ref → 记录；过期/不认识就抛（原因写清楚）。 */
    const lookupRef = (state: ViewState, raw: unknown): SnapshotRef => {
      const result = lookupSnapshotRef(state.refs, String(raw ?? ''), state.generation, state.refsInvalidReason)
      if (!result.ok) throw new Error(result.reason)
      return result.ref
    }

    // ── 工具：browser_dock_look（只读，默认不注册）──────────────────────────

    async function runLook(args: Record<string, unknown>): Promise<string | ToolOutput> {
      const action = String(args.action ?? '')
      if (!DOCK_LOOK_ACTIONS.includes(action)) {
        throw new Error(`未知 action：${action || '(空)'}。可用：${DOCK_LOOK_ACTIONS.join(' / ')}`)
      }
      const link = requireLink()

      if (action === 'views') {
        const list = await link.views()
        if (list.length === 0) return '现在一台 dock 视图都没有（侧栏里没有打开的浏览器页签）。用 browser_dock action=open 开一张。'
        const lines = list.map((view) => {
          const who = isAgentView(view.id) ? 'agent 开的' : '用户自己的'
          return `${view.visible ? '*' : ' '} ${view.id}（${who}）「${neutralizeInline(view.title, 60)}」 ${neutralizeInline(view.url, 200)}${view.loading ? '（加载中）' : ''}`
        })
        return report(`当前有 ${list.length} 台 dock 视图（* = 现在露在窗口上、能截图）：`, {
          action: 'views',
          count: list.length,
        }).concat(`\n${wrapUntrusted('browser', lines.join('\n'))}`)
      }

      const viewId = requireViewId(args)

      if (action === 'screenshot') {
        // 视图从窗口上摘下来后页面会被节流，Page.captureScreenshot 会**卡死到超时**。
        // 所以截图前必须确认这一台是露出来的；没露出来就报人话，绝不让它挂住。
        const list = await link.views()
        const info = list.find((view) => view.id === viewId)
        if (info === undefined) {
          throw new Error(`没有 id 为 ${viewId} 的 dock 视图（可能已经被关掉了）。先 browser_dock_look action=views 看现在有哪几台`)
        }
        if (!info.visible) {
          throw new Error(
            `视图 ${viewId} 现在没露出来（侧栏收着，或它不是当前激活的那张页签）：对藏起来的视图截图会卡到超时。` +
              '先用 browser_dock action=open 开一张（会自动聚焦），或在界面上把这张页签切到前面再截',
          )
        }
        const { state, page } = session(link, viewId)
        await ensureDomains(state, page, false)
        const shot = await actions.captureScreenshot(page, args.fullPage === true)
        const doc = await actions.readDocumentState(page).catch(() => null)
        return {
          text: report(
            `已截图（${shot.fullPage ? '整页' : '当前视口'}，PNG）。图上的像素坐标**不能**用来定位，定位一律用快照里的 ref。`,
            { action: 'screenshot', viewId, fullPage: shot.fullPage, url: neutralizeInline(doc?.url ?? '', 300) },
          ),
          images: [`data:image/png;base64,${shot.base64}`],
        }
      }

      const { state, page } = session(link, viewId)

      if (action === 'snapshot') {
        await ensureDomains(state, page, false)
        const maxChars =
          Number.isFinite(Number(args.maxChars)) && Number(args.maxChars) > 0
            ? clamp(args.maxChars, 500, 200_000, config.maxSnapshotChars)
            : config.maxSnapshotChars
        const outcome = await takeSnapshot(state, page, { full: args.full === true, maxChars })
        return report(
          `快照完成（${args.full === true ? '完整树' : '只列可交互元素'}）：可交互元素 ${outcome.interactiveCount} 个，ref ${outcome.refCount} 个。`,
          {
            action: 'snapshot',
            viewId,
            url: neutralizeInline(outcome.url, 300),
            interactive: outcome.interactiveCount,
            refs: outcome.refCount,
            lines: outcome.lineCount,
            truncated: outcome.truncated,
          },
        ).concat(`\n${outcome.text}`)
      }

      if (action === 'console') {
        // 控制台事件靠 Runtime 域；没开过就先开，否则缓冲永远是空的。
        await ensureDomains(state, page, false)
        const bucket = ringsFor(viewId)
        const entries = bucket.console.toArray()
        const clearing = args.clear === true
        if (clearing) bucket.console.clear()
        if (entries.length === 0) {
          return '这台视图的控制台还没有输出。（事件订阅是挂上之后才建立的，订阅之前的输出拿不到）'
        }
        const lines = entries.map((entry) => `[${clock(entry.ts)}] ${entry.level}: ${entry.text}`)
        return report(`视图 ${viewId} 控制台最近 ${entries.length} 条${clearing ? '（已清空缓冲）' : ''}：`, {
          action: 'console',
          viewId,
          count: entries.length,
          cleared: clearing,
        }).concat(`\n${wrapUntrusted('browser', lines.join('\n'))}`)
      }

      if (action === 'network') {
        await ensureDomains(state, page, true)
        const bucket = ringsFor(viewId)
        const entries = bucket.network.toArray()
        const clearing = args.clear === true
        if (clearing) bucket.network.clear()
        if (entries.length === 0) {
          return '这台视图还没有记录到网络请求。（事件订阅是挂上之后才建立的，之前的请求拿不到）'
        }
        const lines = entries.map((entry) => {
          const status = entry.failed === '' ? String(entry.status === 0 ? '进行中' : entry.status) : `失败：${entry.failed}`
          const mime = entry.mimeType === '' ? '' : ` ${entry.mimeType}`
          return `[${clock(entry.ts)}] ${entry.method} ${status}${mime} ${neutralizeInline(entry.url, 240)}`
        })
        return report(`视图 ${viewId} 网络最近 ${entries.length} 条${clearing ? '（已清空缓冲）' : ''}：`, {
          action: 'network',
          viewId,
          count: entries.length,
          cleared: clearing,
        }).concat(`\n${wrapUntrusted('browser', lines.join('\n'))}`)
      }

      // wait_for
      await ensureDomains(state, page, false)
      const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
      const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
      if (text === undefined && selector === undefined) {
        throw new Error('wait_for 需要 text 或 selector 之一（text 是页面可见文本，selector 是 CSS 选择器）')
      }
      const timeoutMs =
        Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
          ? clamp(args.timeoutMs, 100, 120_000, config.waitTimeoutMs)
          : config.waitTimeoutMs
      const label = text !== undefined ? `文本「${neutralizeInline(text, 60)}」` : `选择器 ${String(selector)}`
      const result = await actions.waitForCondition(page, { text, selector }, timeoutMs)
      if (!result.matched) {
        throw new Error(`等了 ${timeoutMs}ms 也没等到 ${label} 出现。页面可能还在加载，或它需要先有别的动作触发`)
      }
      return report(`等到了 ${label}（用了 ${result.waitedMs}ms）。`, { action: 'wait_for', viewId, waitedMs: result.waitedMs })
    }

    // ── 工具：browser_dock（动手，每次审批）──────────────────────────────────

    /** 打字前的内容体检：不代模型把凭据形状的字符串敲进别人的输入框。 */
    function typedTextBlockReason(value: string): string | null {
      if (value === '') return null
      if (redact(value) !== value) {
        return (
          '要输入的文本里有密钥形状的字符串（API key / token / 私钥这类）。' +
          'dsc 不代你把凭据打进网页输入框——请让用户自己输这一段，或者先用 evaluate 做别的办法。'
        )
      }
      return null
    }

    async function runAct(args: Record<string, unknown>, runCtx: ToolContext): Promise<string | ToolOutput> {
      const action = String(args.action ?? '')
      if (!DOCK_ACTIONS.includes(action)) {
        throw new Error(`未知 action：${action || '(空)'}。可用：${DOCK_ACTIONS.join(' / ')}`)
      }
      config = readConfig()
      const link = requireLink()

      if (action === 'open') {
        const url = assertHttpUrl(String(args.url ?? ''))
        const wanted = args.viewId === undefined ? '' : String(args.viewId).trim()
        if (wanted !== '') {
          // 指名一台已有视图（含用户自己开的那几张）：壳那边「同 id 重开只聚焦、不会换地址」，
          // 所以这一步是聚焦，不是导航——我们把地址原样报回去，免得模型以为页面被换过了。
          const opened = await link.open(url, wanted)
          session(link, opened.viewId)
          return report(
            `已聚焦指名的视图 ${opened.viewId}（它现在的地址是 ${neutralizeInline(opened.url, 300)}；` +
              `同 id 重开只聚焦、不改地址，所以不会被换到 ${neutralizeInline(url, 300)}）。`,
            { action: 'open', viewId: opened.viewId, url: neutralizeInline(opened.url, 300), attached: opened.attached, agentView: isAgentView(opened.viewId), reused: true },
          )
        }
        // 不带 viewId：先看有没有 agent 自己开的、地址**完全相同**的页签——有就复用它，
        // 否则连着两次 open 同一个地址会叠出两张一模一样的页签（对齐 ZCode 的「同站复用」）。
        // 只做严格相等，不判同站、也不追重定向后的落地地址。
        const existing = (await link.views()).find((view) => isAgentView(view.id) && view.url === url)
        if (existing !== undefined) {
          session(link, existing.id)
          return report(
            `复用了已有的 agent 页签 ${existing.id}（地址已经是 ${neutralizeInline(url, 300)}），没有再开新页签。`,
            { action: 'open', viewId: existing.id, url: neutralizeInline(url, 300), attached: existing.visible, agentView: true, reused: true },
          )
        }
        const opened = await link.open(url)
        // 用桌面侧发号的 viewId 建状态：后续动作都指名这一台。
        session(link, opened.viewId)
        return report(
          `已让桌面壳开出一张页签${opened.attached ? '并聚焦' : '（但还没挂到窗口上：侧栏可能收着）'}，` +
            `这是 agent 自己开的视图（id 前缀 agent-）。下面用 viewId=${opened.viewId} 指它。`,
          { action: 'open', viewId: opened.viewId, url: neutralizeInline(opened.url, 300), attached: opened.attached, agentView: isAgentView(opened.viewId), reused: false },
        )
      }

      if (action === 'close') {
        const viewId = requireViewId(args)
        await link.close(viewId)
        // 视图没了：会话状态与缓冲一起清掉，别留在内存里当幽灵。
        states.delete(viewId)
        rings.delete(viewId)
        return report(`已关掉视图 ${viewId}（连带壳里那张页签）。`, { action: 'close', viewId })
      }

      const viewId = requireViewId(args)
      const { state, page } = session(link, viewId)
      await ensureDomains(state, page, false)

      switch (action) {
        case 'navigate': {
          const url = assertHttpUrl(String(args.url ?? ''))
          const nav = await page.send<{ errorText?: string }>('Page.navigate', { url })
          if (typeof nav.errorText === 'string' && nav.errorText !== '') {
            throw new Error(`打开 ${url} 失败：${nav.errorText}`)
          }
          const doc = await actions.waitForPageLoad(page, NAVIGATE_TIMEOUT_MS, runCtx.signal)
          invalidate(viewId, '页面已经跳转到别的地址')
          const snapshot = await takeSnapshot(state, page, { full: false, maxChars: config.maxSnapshotChars })
          return report(
            `视图 ${viewId} 已打开 ${neutralizeInline(doc.url || url, 300)}` +
              `${doc.title === '' ? '' : `（标题「${neutralizeInline(doc.title, 120)}」）`}，加载状态 ${doc.readyState}。下面是这一页的简版快照：`,
            { action: 'navigate', viewId, url: neutralizeInline(doc.url || url, 300), readyState: doc.readyState, interactive: snapshot.interactiveCount },
          ).concat(`\n${snapshot.text}`)
        }

        case 'click': {
          const ref = lookupRef(state, args.ref)
          // 代际 + 元素复核：动作层内部也会再核一次，这里显式前置一道，页面变了就别点。
          await actions.verifyRef(page, ref)
          const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left'
          const outcome = await actions.clickRef(page, ref, { button, double: args.double === true, timeoutMs: config.waitTimeoutMs }, runCtx.signal)
          const doc = await actions.readDocumentState(page).catch(() => null)
          return report(
            `已${outcome.clicks > 1 ? '双击' : '点击'}视图 ${viewId} 的 ref「${ref.ref}」（${describeRef(ref)}）在 (${outcome.x}, ${outcome.y})。` +
              '「点到了」不等于「生效了」，要看结果就用 snapshot 或 wait_for 确认。',
            { action: 'click', viewId, ref: ref.ref, button: outcome.button, clicks: outcome.clicks, url: neutralizeInline(doc?.url ?? '', 300) },
          )
        }

        case 'hover': {
          const ref = lookupRef(state, args.ref)
          const point = await actions.hoverRef(page, ref, config.waitTimeoutMs, runCtx.signal)
          return report(`已把鼠标移到视图 ${viewId} 的 ref「${ref.ref}」（${describeRef(ref)}）的 (${point.x}, ${point.y})。`, {
            action: 'hover',
            viewId,
            ref: ref.ref,
          })
        }

        case 'type': {
          const ref = lookupRef(state, args.ref)
          const text = String(args.text ?? '')
          if (text === '') throw new Error('type 需要一个非空的 text（只想清空就加 clear=true）')
          const blocked = typedTextBlockReason(text)
          if (blocked !== null) throw new Error(blocked)
          const outcome = await actions.typeIntoRef(page, ref, text, { clear: args.clear === true, submit: args.submit === true })
          if (outcome.submitted) await actions.waitForPageLoad(page, 5000, runCtx.signal).catch(() => null)
          const doc = await actions.readDocumentState(page).catch(() => null)
          return report(
            `已往视图 ${viewId} 的 ref「${ref.ref}」（${describeRef(ref)}）输入 ${outcome.chars} 个字符` +
              `${outcome.cleared ? '（先清空了原内容）' : ''}${outcome.submitted ? '，并按了回车' : ''}。`,
            { action: 'type', viewId, ref: ref.ref, chars: outcome.chars, url: neutralizeInline(doc?.url ?? '', 300) },
          )
        }

        case 'press': {
          const key = String(args.key ?? '').trim()
          if (key === '') throw new Error('press 需要一个 key，例如 Enter / ctrl+a / ArrowDown')
          const ref = args.ref === undefined || String(args.ref).trim() === '' ? undefined : lookupRef(state, args.ref)
          const stroke = await actions.pressKey(page, key, ref)
          await actions.waitForPageLoad(page, 3000, runCtx.signal).catch(() => null)
          return report(`已按键 ${key}（虚拟键码 ${stroke.vk}，修饰键 ${stroke.modifiers}）。`, {
            action: 'press',
            viewId,
            key,
            vk: stroke.vk,
            modifiers: stroke.modifiers,
          })
        }

        case 'scroll': {
          const direction = typeof args.direction === 'string' ? args.direction : 'down'
          if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) {
            throw new Error(`scroll 的 direction 只能是 up/down/left/right/top/bottom，收到 ${direction}`)
          }
          const ref = args.ref === undefined || String(args.ref).trim() === '' ? undefined : lookupRef(state, args.ref)
          const outcome = await actions.scrollPage(
            page,
            {
              ref,
              direction: direction as 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom',
              deltaY: Number.isFinite(Number(args.deltaY)) ? Number(args.deltaY) : undefined,
              timeoutMs: config.waitTimeoutMs,
            },
            runCtx.signal,
          )
          return report(
            `视图 ${viewId} 已向 ${direction} 滚动${outcome.deltaY === 0 && outcome.deltaX === 0 ? '（直接滚到页面端点）' : `（Δx=${outcome.deltaX}, Δy=${outcome.deltaY}）`}。`,
            { action: 'scroll', viewId, direction, deltaX: outcome.deltaX, deltaY: outcome.deltaY },
          )
        }

        case 'evaluate': {
          const expression = String(args.expression ?? '')
          if (expression.trim() === '') throw new Error('evaluate 需要一个 expression')
          // 与 browser.ts 同一道敏感原语黑名单：换了后端也不许少一道闸。
          const scanned = actions.scanExpression(expression)
          if (scanned.sensitive.length > 0) {
            throw new Error(`表达式里用了敏感原语（${scanned.sensitive.join('、')}）。页面里这些本来也不该出现，换个写法`)
          }
          const outcome = await actions.evaluateInPage(page, expression)
          return `求值结果（视图 ${viewId}）：\n${wrapUntrusted('browser', outcome.text)}`
        }

        default:
          throw new Error(`未知 action：${action}`)
      }
    }

    // ── 工具注册 ────────────────────────────────────────────────────────────

    const sharedProps = {
      viewId: {
        type: 'string',
        description:
          '目标视图 id：首次用 open（不传 viewId，会自动复用 agent 已开的同址页签），之后用 browser_dock_look action=views 返回的 id——' +
          '可以是 agent 自己开的，也可以是用户自己开的页签；open 传 viewId 表示聚焦这台已有视图（同 id 重开只聚焦、不换地址）',
      },
      url: { type: 'string', description: 'open / navigate：目标地址，只接受 http/https' },
      ref: { type: 'string', description: '目标元素：快照里的 ref，形如 e5（只对最近一次快照有效）' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'], description: 'scroll：滚动方向，默认 down' },
      deltaY: { type: 'integer', description: 'scroll：一次滚多少像素，默认 500' },
    }

    const actTool: ToolEntry = {
      name: TOOL_ACT,
      description:
        '动手操作侧栏那台浏览器（用户自己的持久会话，DOM 级）：open 让桌面壳开一张页签并聚焦' +
        '（不带 viewId 时，若已有 agent 开的同址页签就直接复用它；带 viewId 时只聚焦那台已有视图）、navigate 打开地址' +
        '（返回时会附一份简版快照）、click / hover / type / press / scroll 都收 snapshot 里的 ref、' +
        'evaluate 跑页面 JS（敏感原语会被拒）、close 关掉这张页签。**每一步都要用户点头**（审批卡会带 viewId 与地址），' +
        '别一次铺一堆动作。动手前先 browser_dock_look action=snapshot 拿 ref。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...DOCK_ACTIONS],
            description: '要做什么：open / navigate / click / hover / type / press / scroll / evaluate / close',
          },
          viewId: sharedProps.viewId,
          url: sharedProps.url,
          ref: sharedProps.ref,
          text: { type: 'string', description: 'type：要输入的文本' },
          key: { type: 'string', description: 'press：键名或组合键，例如 Enter / Tab / ctrl+a / ArrowDown' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click：哪个鼠标键，默认 left' },
          double: { type: 'boolean', description: 'click：true = 双击' },
          clear: { type: 'boolean', description: 'type：true = 先清空输入框里原有内容再输入' },
          submit: { type: 'boolean', description: 'type：true = 输完按回车提交' },
          direction: sharedProps.direction,
          deltaY: sharedProps.deltaY,
          expression: { type: 'string', description: 'evaluate：在页面里执行的 JS 表达式（结果 JSON 化后截断 2000 字；敏感原语会被拒）' },
        },
        required: ['action'],
      },
      risk: 'exec',
      run: (args, runCtx) => runAct(args, runCtx),
    }

    const lookTool: ToolEntry = {
      name: TOOL_LOOK,
      description:
        '看侧栏那台浏览器（只读，免审批）：views 列出现在活着的视图（含用户自己开的页签）、snapshot 取无障碍树快照' +
        '（每个可交互元素带 [ref=eN]，动作就用它定位）、screenshot 截图（需要视觉模型；视图没露出来会直接报错而不是挂住）、' +
        'console 看控制台输出、network 看网络请求、wait_for 等文本或选择器出现。动手之前先 snapshot，别凭记忆操作。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...DOCK_LOOK_ACTIONS],
            description: '要看什么：views / snapshot / screenshot / console / network / wait_for',
          },
          viewId: sharedProps.viewId,
          full: { type: 'boolean', description: 'snapshot：true = 完整无障碍树（含标题段落这类上下文），默认只列可交互元素' },
          maxChars: { type: 'integer', description: 'snapshot：本次快照最多多少字符，默认取设置里的值（15000）' },
          fullPage: { type: 'boolean', description: 'screenshot：true = 截整页，默认只截当前视口' },
          clear: { type: 'boolean', description: 'console / network：读完是否清空缓冲' },
          text: { type: 'string', description: 'wait_for：页面里要等的文本' },
          selector: { type: 'string', description: 'wait_for：要等的 CSS 选择器（与 text 二选一）' },
          timeoutMs: { type: 'integer', description: 'wait_for：最多等多少毫秒，默认取设置里的值（5000）' },
        },
        required: ['action'],
      },
      risk: 'read',
      run: (args) => runLook(args),
    }

    // ── 工具注册（开关一翻就重挂一次）──────────────────────────────────────

    let toolOffs: Array<() => void> = []
    const syncTools = (): void => {
      for (const off of toolOffs) off()
      toolOffs = []
      toolOffs.push(ctx.tools.register(actTool))
      // 只读工具默认不注册：dock 视图跑在用户自己的持久分区里（带登录态），
      // 只有显式打开 lookWithoutApproval 才以 read 档放行（照 computer-use.ts 的先例）。
      if (config.lookWithoutApproval) toolOffs.push(ctx.tools.register(lookTool))
    }
    syncTools()

    // ── 设置分区 ────────────────────────────────────────────────────────────

    const section: SettingsSectionSpec = {
      id: SECTION_ID,
      title: '侧栏浏览器',
      subtitle: '让模型驱动桌面端侧栏那台浏览器（用户自己的持久会话，不是自管那台一次性 Chrome）',
      order: 35,
      fields: (): SettingsField[] => [
        {
          type: 'switch',
          key: 'lookWithoutApproval',
          label: '看侧栏浏览器免审批',
          help:
            '打开后 browser_dock_look（views / snapshot / screenshot / console / network / wait_for）以只读档注册、不再逐次弹审批卡。' +
            '注意它看的是**你自己登录着的那台浏览器**（持久分区 persist:dsc-browser），页面上可能有你的登录态与隐私内容，按需打开。' +
            '点击、输入、求值这些动手动作（browser_dock）仍每次要确认。',
        },
        {
          type: 'info',
          label: '说明',
          text: '这一档只决定「看」的工具是否注册（browser_dock_look）；动手工具 browser_dock 恒为每次审批。',
        },
      ],
      values: (): Record<string, SettingsValue> => ({ lookWithoutApproval: config.lookWithoutApproval }),
      // 契约：返回字符串 = 失败原因；void = 成功
      save: (key, value): string | void => {
        if (key !== 'lookWithoutApproval') return `这个分区没有这项：${key}`
        writePluginConfig(CONFIG_KEY, { lookWithoutApproval: value === true || value === 'true' })
        config = readConfig()
        syncTools()
      },
    }
    const offSection = ctx.settings.registerSection(section)

    // ── 收尾 ────────────────────────────────────────────────────────────────

    return () => {
      offSection()
      for (const off of toolOffs) off()
      toolOffs = []
      if (offEvents !== null) {
        try {
          offEvents()
        } catch {
          // 退订失败也要接着收尾
        }
        offEvents = null
      }
      subscribed = null
      states.clear()
      rings.clear()
    }
  },
}
