/**
 * 远程控制的服务端契约：协议常量、宿主能力（deps）、快照与句柄类型。
 *
 * 为什么要单独一个模块：`remote.ts`（插件装配）、`server.ts`（HTTP+WS 传输）、
 * `routes.ts`（HTTP 路由）三方都要认这些形状——放任何一方都会让另外两方反向依赖
 * 插件文件。协议常量也在这里：白名单与方法表是「契约」而不是实现细节。
 *
 * @module dsc/plugins/remote/types
 */
import { INVOKABLE_METHODS } from '../../core/host-methods.js'
import type { UiMethod } from '../../core/ui-methods.js'
import type { UiComboTable } from '../../core/ui-combo.js'
import type { UiEventsHandle } from '../../core/ui-events.js'
import type { UiBootGraph } from '../../ui/manifest.js'
import type { IncomingMessage } from 'node:http'
import type { RuntimeSnapshot } from '../../contract.js'
import type { PushSubscribeOutcome } from '../../core/remote/push.js'
import type { RemotePairing } from '../../core/remote/pairing.js'
import type { TicketStore } from '../../core/remote/tickets.js'
import type { RemoteUploads } from '../../core/remote/uploads.js'

/** WS 协议版本：批 B 的界面按它认版本，破坏性变更时递增（v3 = 全局 seq + 增量帧 + 补帧）。 */
export const REMOTE_PROTOCOL_VERSION = 3

/**
 * 设备 token 的 Cookie 名（壳档的浏览器凭据）。
 *
 * 为什么要 Cookie 而不是像经典档那样把 token 放在 JS 里：壳的数据通道是 EventSource——
 * **它没有任何办法带自定义头**（浏览器 API 如此），Bearer 走不通；同源的 Cookie 会自动
 * 带上，于是 SSE 与 POST 两个入口共用一份凭据。包成 HttpOnly：页面脚本读不到它，
 * 少了 XSS 顺手牵羊的那条路（经典档的 localStorage 没有这层）。
 */
export const REMOTE_COOKIE = 'dsc_remote'

/** Cookie 存活期：30 天（与本地界面 Cookie 同口径；每次重新配对会刷新）。 */
export const REMOTE_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 远程开放的 `DscRuntime` 方法：只是共享白名单（core/host-methods.ts）里的一个子集。
 *
 * 没开的那几类，以及为什么：
 *   - saveProvider / removeProvider / setProviderKey / setDefaultModel / getModelConfig：
 *     凭据与端点写入不开放给浏览器（token 泄了就是泄了，别再让它能改端点）；
 *   - setSettingValue / runSettingAction：能改设置就等于能改权限模式与沙箱档位，
 *     浏览端要改设置请到电脑上改；
 *   - installMarketSkill / setSkillEnabled / setMarketSources / readSkill：往本机装东西的动作；
 *   - dock / runCommand / goalAction / forkSession / purgeSessions / restoreSessions：
 *     宿主生命周期与不可逆的会话操作；
 *   - setPluginEnabled / setPolicy / setUiPrefs / setModel / runCommand 之外的管理动作同理。
 *
 * 上传（POST /api/upload）与推送订阅（POST /api/push-subscribe）不在这一份里：
 * 它们是 HTTP 路由，不是 RPC 方法。
 */
export const REMOTE_METHODS = [
  'submit',
  'interrupt',
  'openSession',
  'compact',
  'setModel',
  'setEffort',
  'refreshSessions',
  'listModels',
  'listSkills',
  'listPlugins',
  'getUiPrefs',
  'getSettingsSections',
  'getSectionValues',
  'usageStats',
  'listArchivedSessions',
  'archiveSessions',
  'renameSession',
  'setSessionPinned',
  'answerApproval',
  'answerPlan',
  'answerQuestion',
  'setMode',
  'clearTodos',
  'peekTranscript',
  'listUserMessages',
] as const satisfies readonly (typeof INVOKABLE_METHODS)[number][]

/** 远程白名单里有没有协议根本不认识的方法：有就报下面那个元组类型，编不过。 */
type NotInvokableRemotely = Exclude<(typeof REMOTE_METHODS)[number], (typeof INVOKABLE_METHODS)[number]>
const REMOTE_COVERAGE: NotInvokableRemotely extends never
  ? true
  : ['远程白名单里有协议不认识的方法：', NotInvokableRemotely] = true
void REMOTE_COVERAGE

/**
 * 壳（remote-web 切壳后手机加载的那份界面）在这条链路上能调的方法。
 *
 * 底子是 {@link REMOTE_METHODS}（移动端的既有口径：凭据写入、设置写入、装东西、
 * 宿主生命周期一律不开）；这里只多两条**壳的基本交互**绕不开的：
 *   - `setUiPrefs`：侧栏的排序/展开/别名这些界面偏好，壳每次交互都会写；只读不写
 *     会让手机上每点一下就弹一条失败；
 *   - `restoreSessions`：归档区里的「恢复」，可逆动作（归档的反面，打开归档视图就点得到）。
 *
 * 每条都必须是界面通道白名单（`core/ui-methods.ts`）的成员：实参校验直接复用
 * `validateUiArgs`，不另立一份规格——多出来的口子也必须过同一道形校验。
 */
export const REMOTE_SHELL_METHODS = [
  ...REMOTE_METHODS,
  'setUiPrefs',
  'restoreSessions',
] as const satisfies readonly (typeof INVOKABLE_METHODS)[number][]

/** 壳方法表里有没有界面白名单不认识的方法（拼错/被删）：有就编不过。 */
type NotUiMethodRemotely = Exclude<(typeof REMOTE_SHELL_METHODS)[number], UiMethod>
const REMOTE_SHELL_COVERAGE: NotUiMethodRemotely extends never
  ? true
  : ['壳方法表里有界面通道不认识的方法：', NotUiMethodRemotely] = true
void REMOTE_SHELL_COVERAGE

/** 查表用的集合。 */
export const REMOTE_SET: ReadonlySet<string> = new Set<string>(REMOTE_METHODS)

/** 壳方法表的查表集合。 */
export const REMOTE_SHELL_SET: ReadonlySet<string> = new Set<string>(REMOTE_SHELL_METHODS)

/**
 * 手机端在同一份壳上要的三样东西（remote 插件造好，路由层用）。
 *
 * 为什么由插件而不是路由层自己造：启动图与数据通道都要宿主能力（产物收集、运行时
 * 反射、会话流订阅），路由层刻意只碰 req/res 与 deps。
 */
export interface RemoteShellUi {
  /** 壳产物的目录（`lib/ui/assets`；静态伺服与 index 注入从这里出）。 */
  assetsDir: string
  /** 现在这一刻的启动图（当前代快照，与本地界面服务同一份 compose）。 */
  boot(): UiBootGraph
  /** 批 combo 的精确表（与启动图同一代；路由按 URL 命中，见 core/ui-route.ts）。 */
  combos(): UiComboTable
  /** 数据通道（SSE + POST invoke；方法面是 {@link REMOTE_SHELL_METHODS}）。 */
  events: UiEventsHandle
  /** 这个请求算不算已配对的设备（设备 token 走 Cookie 或 Bearer 都认）。 */
  authenticated(req: IncomingMessage): boolean
}

/** 一个 WebSocket 会话要的宿主能力（由插件闭包提供，这里不认识 cordis）。 */
export interface RemoteServerDeps {
  port: number
  lan: boolean
  throttleMs: number
  /** 静态资源目录（默认 `lib/remote/assets`，配置可改）。 */
  assetsDir: string
  pairing: RemotePairing
  tickets: TicketStore
  /** 上传落盘（POST /api/upload）。 */
  uploads: RemoteUploads
  /** 派发一个白名单方法（调用方已做过白名单与来源标注）。 */
  invoke(method: string, args: unknown[]): Promise<unknown>
  /** 当前全量快照（批 B 契约的形状：entries 已定稿 + liveEntries 直播尾分开给）。 */
  snapshot(): RemoteSnapshot
  /** 订阅会话流变化（返回退订函数）。 */
  subscribe(listener: () => void): () => void
  /** 往桌面端的对话流写一句话（配对、吊销、上传这类事件）。 */
  notice(text: string): void
  /** Web Push 总开关（关着时订阅端点回 403、hello 里的公钥报 null）。 */
  pushEnabled(): boolean
  /** VAPID 公钥（Web Push 关着或不可用时 null）。 */
  pushPublicKey(): string | null
  /** 浏览器订阅入库（按 endpoint 去重）。 */
  pushSubscribe(payload: unknown, deviceId: string): PushSubscribeOutcome
  /** 按 endpoint 删订阅。 */
  pushUnsubscribe(endpoint: string): boolean
  /**
   * 壳档的伺服面（remote-web 切壳）：`null` = 按经典档伺服 `assetsDir`。
   * 造法见 `remote.ts`（启动图 / 数据通道 / 凭据判定都在插件里装配）。
   */
  shellUi: RemoteShellUi | null
}

/** 批 B 契约里的快照：宿主 RuntimeSnapshot 加上会话身份，并把直播尾拆出来。 */
export interface RemoteSnapshot extends RuntimeSnapshot {
  sessionId: string
  cwd: string
  /** 已定稿条目。 */
  entries: RuntimeSnapshot['entries']
  /** 还在长的直播尾（core 里用负 id 标记）。 */
  liveEntries: RuntimeSnapshot['entries']
}

export interface RemoteServerHandle {
  readonly port: number
  readonly lan: boolean
  /** listen 成功与否；失败时 reject（调用方据此回收主控位）。 */
  readonly ready: Promise<void>
  close(): void
  /** 给全部连接推一条消息（例如 dsc/open-picker 转成 {type:'ui'}）。 */
  broadcast(message: Record<string, unknown>): void
  /**
   * 断开连接。
   * @param deviceId - 只断这台设备的；省略 = 全部断开（吊销全部设备时用）
   * @returns 断开了几条
   */
  closeDevices(deviceId?: string): number
}
