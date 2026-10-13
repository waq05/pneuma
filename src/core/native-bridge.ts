/**
 * 原生桥的规格：桌面外壳能替界面做的事，逐条白名单 + 实参校验。
 *
 * ## 为什么需要这一层
 *
 * 旧渲染层的 26 个 IPC 能力里，有一类**宿主做不了**——它们要 Electron 主进程：
 * 原生窗口控件区的颜色、原生弹层的深浅、系统文件选择框、用系统程序打开路径/链接、
 * 托盘通知、退出与重启宿主。插件壳跑在宿主伺服的 web 文档里，它要摸这些能力，
 * 只能走一条主进程给的窄通道——就是这份规格描述的那条。
 *
 * ## 为什么规格单独放这里（而不再写一份在桌面那侧）
 *
 * 这一份**零依赖**（不 import 任何 node 内置模块、不 import electron），所以两侧共用：
 * 桌面主进程用它校验并分派，界面壳用它拿操作名与实参类型。宿主与壳读同一份源码，
 * 漂移在编译期就暴露——与 `src/ui/index.ts`（`@dsc/ui-core`）和
 * `ui-shell/src/platform-modules.json` 是同一个套路。
 *
 * ## 边界（比"能少给就少给"更具体的三条）
 *
 * 1. **不出现"执行任意命令 / 读写任意文件"的操作**。这里全是"既定动作 + 实参枚举"：
 *    打开一个目录、报一次窗口控件色、弹一条通知。没有 op 能把一段字符串变成一次执行。
 * 2. **每条操作的实参都过一遍形状校验**（长度上限、枚举取值、#rrggbb、通知的字段白名单），
 *    规格写成 `Record<NativeOp, …>`，所以**加一个操作就必须写规格**，漏了编不过。
 * 3. **主进程那一侧按 `NativeOp` 建分派表**（`Record<NativeOp, 处理函数>`），
 *    漏实现一个操作同样编不过——"白名单"与"真有实现"被绑在一起。
 *
 * 装东西的四个操作（`installSkill` / `installPlugin` / `installMarketSkill` /
 * `setMarketSources`）**走桥，不在界面通道**：它们是供应链写入口，界面通道
 * （浏览器与远程页都够得着）持续排除；桥只对主窗口那份文档开放，与旧渲染层的
 * 直接 IPC 是同一扇门。前两个弹系统文件选择器（人选了文件才算数），后两个转给
 * 宿主（按市场源下载安装到 `~/.dsc/skills`、把源清单写回 settings.json）。
 * 同一理由的还有 `setUiTrust`（落第三方界面插件的信任记录——放它进启动图这声
 * 「我信任」必须是人在桌面窗口里答的），模型端点三件套
 * （`saveProvider` / `removeProvider` / `setProviderKey`——写 config.yaml 与凭据库，
 * 是设置 → 模型页可编辑形态的写入口；旧渲染层这三件事走的就是直接 IPC），
 * 以及 `setPolicy`（审批策略是安全闸门本身，界面通道同样持续排除；旧渲染层的输入框
 * 里本来就有这根能切的旋钮，桥替它把写口留住）。
 *
 * 内嵌浏览器三件套（`dockBrowser` / `browserNav` + `browser-state` 事件）2026-10
 * 搬进壳：它们操作的是原生 `WebContentsView` 覆盖层（旧渲染层直连 IPC 的那个），
 * 桥只转发「显示/隐藏 + 摆到哪 + 导航到哪」，页面管不到那个视图的内容。终端
 * （`terminal`）同款——能力留在主进程，界面只说意图。
 *
 * 除了 `call` 之外，桥还有**一个订阅口**：`on(event, listener)`，事件名由 {@link NATIVE_EVENTS}
 * 白名单（现在只有终端输出流）。事件不做实参校验——它是主进程往外推的，不是页面往里送的。
 *
 * @module dsc/core/native-bridge
 */

import { DOCK_TERM_OPS } from './dock-ops.js'
import type { ApprovalPolicy, ApprovalReviewer } from '../contract.js'

/**
 * 桥的协议版本：**加操作不涨**，改某个操作的实参或语义才涨。
 * 桌面主进程与壳握手时对一下，不一致就在诊断区说明白（不静默降级）。
 */
export const NATIVE_BRIDGE_VERSION = 2

/** 桥放行的操作，一字不差就是分派表的键。 */
export const NATIVE_OPS = [
  'setWindowChrome',
  'setThemeSource',
  'chooseDirectory',
  'switchCwd',
  'recentCwds',
  'removeRecentCwd',
  'openPath',
  'openExternal',
  'openWorkspace',
  'installSkill',
  'installPlugin',
  'installMarketSkill',
  'setMarketSources',
  'setUiTrust',
  /**
   * 模型端点三件套（设置 → 模型的可编辑形态，2026-10）：`saveProvider` /
   * `removeProvider` / `setProviderKey` 都写 config.yaml 或凭据库，与上面那几个
   * 供应链写入口同一性质，界面通道持续排除（`UI_EXCLUDED` 里有逐条理由），
   * 桥只对主窗口那份文档开放。宿主那侧还是老方法（`protocol.invoke` 原样转发），
   * 校验（名字形状、模型 id 去重、正整数）仍在 settings 插件里。
   */
  'saveProvider',
  'removeProvider',
  'setProviderKey',
  /**
   * 权限模式（只读 / 自动编辑 / 完全访问）。
   *
   * 为什么在这里而不在界面通道：`UI_EXCLUDED` 里写明了理由——审批策略是安全闸门本身，
   * 「能让页面改它，前面所有闸门就都成了摆设」。但旧桌面版的输入框里本来就有这根能切的
   * 旋钮（`desktop/src/renderer/Composer.tsx` 的 `policyOpen` → `proxy.setPolicy`），
   * 壳不能比旧版少一样东西，所以按同一先例挪到桥上：**只有装了 preload 的桌面窗口
   * 那份文档**够得着，浏览器页签 / 远程页面够不着。实参是三档枚举（下面 POLICIES），
   * 到了宿主那侧仍走 `approval.setPolicy`（它自己会发一条 system 条目并记审计）。
   */
  'setPolicy',
  /**
   * 审批审阅者（本人 / AI 复核）。与 setPolicy 同一条理由住在桥上：切换审阅者 =
   * 决定「谁来裁」，同样是安全闸门本身。宿主那侧走 `approval.setReviewer`。
   */
  'setReviewer',
  /**
   * 打包权限预设（沙箱 + 权限模式 + 审阅者三合一）。一次写三个旋钮，改的是闸门组合，
   * 理由同上；宿主的写入口是 `permissionPermits.use()`（它自己记审计与系统条目）。
   */
  'usePermissionPreset',
  /** 设新会话默认的打包预设（只影响之后新建的会话）。 */
  'setDefaultPermissionPreset',
  'sessionUsage',
  'notify',
  'restartHost',
  'quit',
  /**
   * 终端（dock 通道的第三档）。**这是终端唯一的入口**：界面 HTTP 面里没有 term-*
   * （放行面的 op 枚举是 `DOCK_UI_OPS`，只有读 + 写），所以"起一个 shell 进程"
   * 这件事只在装了 preload 的桌面窗口里做得到。实参是 `[op, payload]`，
   * payload 由宿主插件自己净化（路径限 cwd、shell 白名单）。
   */
  'terminal',
  /**
   * 内嵌浏览器（dock 的浏览器页签）：`[visible, rect?]`——显示/隐藏那个原生
   * `WebContentsView` 覆盖层，并把它摆到页面报上来的矩形处（页面坐标 = 窗口内容坐标）。
   */
  'dockBrowser',
  /** 内嵌浏览器导航：`[url, action]`（load / back / forward / reload；协议在主进程再校验一次）。 */
  'browserNav',
] as const

/** 桥能推给页面的事件（订阅入口按它白名单，别的名字直接拒）。 */
export const NATIVE_EVENTS = [
  /** dock 终端输出流：`{ id, data }`（id 是 term-spawn 给的会话 id）。 */
  'dock-data',
  /** 内嵌浏览器的地址变化：`{ url }`（前进/后退/页面内跳转都推）。 */
  'browser-state',
] as const

/** 桥认得的一个事件名。 */
export type NativeEvent = (typeof NATIVE_EVENTS)[number]

/** 事件名查表。 */
export const NATIVE_EVENT_SET: ReadonlySet<string> = new Set<string>(NATIVE_EVENTS)

/** 桥认得的一个操作名。 */
export type NativeOp = (typeof NATIVE_OPS)[number]

/** 查表用的集合。 */
export const NATIVE_OP_SET: ReadonlySet<string> = new Set<string>(NATIVE_OPS)

/** 一个实参的形状。取值集合刻意很小：这一层要的正是"最小且能读懂"。 */
type ArgShape =
  | { kind: 'string'; max: number }
  /** 字符串或 `null`：`null` 是**有意义的取值**（如 setProviderKey 的「清除」，别当省略）。 */
  | { kind: 'stringOrNull'; max: number }
  | { kind: 'bool' }
  | { kind: 'hex' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'notify' }
  | { kind: 'marketSources' }
  | { kind: 'rect' }
  | { kind: 'json'; maxBytes: number }

/** 一个实参的规格。 */
interface ArgSpec {
  shape: ArgShape
  /** 可不传：省略表示"没这个实参"（尾部省略规则与界面通道一致）。 */
  optional?: boolean
}

/** 路径 / 链接的长度上限。 */
const MAX_PATH = 4096
/** 会话 id 的长度上限。 */
const MAX_ID = 200
/** 通知标题 / 正文的长度上限（正文比标题长一档）。 */
const MAX_NOTIFY_TITLE = 200
const MAX_NOTIFY_BODY = 1000
/** 终端 payload 的上限：里面是一行命令或一段按键，8KB 富余得多。 */
const MAX_TERM_PAYLOAD = 8192
/** 市场源清单的上限：源数、每项名字与地址的长度（几何级地够用，手填撑不破）。 */
const MAX_MARKET_SOURCES = 50
const MAX_SOURCE_NAME = 100
const MAX_SOURCE_URL = 2048
/** 端点草稿的上限：名字、地址、模型清单加起来；几百个模型也撑不破 64KB。 */
const MAX_PROVIDER_NAME = 200
const MAX_PROVIDER_URL = 4096
const MAX_PROVIDER_DRAFT = 65536
/** API key 的长度上限（真实 key 几十字符，4KB 富余得多）。 */
const MAX_PROVIDER_KEY = 4096

const THEME_SOURCES = ['dark', 'light', 'system'] as const
const WORKSPACE_KINDS = ['terminal', 'explorer', 'vscode'] as const
/**
 * 权限模式的三档（与 `contract.ts` 的 `ApprovalPolicy` 一字不差）。
 *
 * 写成字面量数组而不是 import 那个类型：桥的校验住不了类型那侧（实参从网络来），
 * 枚举必须落成运行时的值。宿主那侧`satisfies ApprovalPolicy[]` 会让漏一档编不过。
 */
const POLICIES = ['readonly', 'auto-edit', 'full-access'] as const satisfies readonly ApprovalPolicy[]
/** 审阅者两档（同样与 `contract.ts` 的 `ApprovalReviewer` 一字不差）。 */
const REVIEWERS = ['user', 'auto-review'] as const satisfies readonly ApprovalReviewer[]
/** 内嵌浏览器的导航动作（与主进程 `navigateDockBrowser` 认的那几个一字不差）。 */
const NAV_ACTIONS = ['load', 'back', 'forward', 'reload'] as const
/** 页面报上来的矩形上限（窗口再大也到不了；只是挡住存坏的脏值）。 */
const RECT_MAX = 100_000

/**
 * 每个操作的实参规格：数组长度就是参数个数上限，下标就是参数位置。
 *
 * 类型写成 `Readonly<Record<NativeOp, …>>`：少写一个、多写一个不存在的操作都编不过。
 */
export const NATIVE_ARG_SPECS: Readonly<Record<NativeOp, readonly ArgSpec[]>> = {
  /** 原生窗口控件区的底色与图标色，两个都必须压平过的 `#rrggbb`（系统那侧不收 alpha）。 */
  setWindowChrome: [{ shape: { kind: 'hex' } }, { shape: { kind: 'hex' } }],
  /** 原生弹层（下拉、右键菜单）的深浅；跟随系统时原样透传，让 OS 自己翻面。 */
  setThemeSource: [{ shape: { kind: 'enum', values: THEME_SOURCES } }],
  /** 弹系统目录选择框，选中就切工作目录并重启宿主；取消给 null。 */
  chooseDirectory: [],
  /** 切到指定工作目录（不弹框）；失败给一句原因。 */
  switchCwd: [{ shape: { kind: 'string', max: MAX_PATH } }],
  /** 最近用过的工作目录，最新的排最前。 */
  recentCwds: [],
  /** 把一条从最近工作目录里撤下（删工作区时把空组从侧栏撤下）。 */
  removeRecentCwd: [{ shape: { kind: 'string', max: MAX_PATH } }],
  /** 用系统文件管理器打开一个**绝对**路径；返回空串表示成功。 */
  openPath: [{ shape: { kind: 'string', max: MAX_PATH } }],
  /** 用系统浏览器打开一个 http/https 链接（协议在主机侧再判一次）。 */
  openExternal: [{ shape: { kind: 'string', max: MAX_PATH } }],
  /** 用终端 / 资源管理器 / VS Code 打开当前工作区。 */
  openWorkspace: [{ shape: { kind: 'enum', values: WORKSPACE_KINDS } }],
  /** 弹系统文件选择器，把选中的技能（含 SKILL.md 的目录或 .md 文件）复制进 ~/.dsc/skills/；返回装好的名字（取消给空表）。 */
  installSkill: [],
  /** 弹系统文件选择器，把选中的 .js 插件复制进 ~/.dsc/plugins/；返回装好的文件名（取消给空表）。 */
  installPlugin: [],
  /** 从市场源安装一个技能到 ~/.dsc/skills/（转给宿主，与旧界面同一个方法）。 */
  installMarketSkill: [{ shape: { kind: 'string', max: MAX_ID } }, { shape: { kind: 'string', max: MAX_ID } }],
  /** 覆盖市场源清单（写 ~/.dsc/settings.json；形状是 [{name, url}]，逐项校验）。 */
  setMarketSources: [{ shape: { kind: 'marketSources' } }],
  /** 落一条第三方界面插件的信任记录（插件中心信任卡「确认信任」的终点）。 */
  setUiTrust: [{ shape: { kind: 'string', max: MAX_ID } }],
  /** 切权限模式：三档枚举之一（宿主那侧仍是 `approval.setPolicy`，它自己记审计与系统条目）。 */
  setPolicy: [{ shape: { kind: 'enum', values: POLICIES } }],
  /** 切审阅者：两档枚举之一（宿主那侧是 `approval.setReviewer`）。 */
  setReviewer: [{ shape: { kind: 'enum', values: REVIEWERS } }],
  /** 切打包权限预设：预设名（宿主那侧查表，认不出的名字当场报错，不做静默回落）。 */
  usePermissionPreset: [{ shape: { kind: 'string', max: 64 } }],
  /** 设新会话默认的打包预设（空串 = 清掉，回到按两个旋钮各自的默认）。 */
  setDefaultPermissionPreset: [{ shape: { kind: 'string', max: 64 } }],
  /**
   * 新增或编辑一个端点（写 config.yaml）：一整份 `ProviderDraft`。
   * 形状只查「是可序列化的 JSON 且不超过 64KB」——字段级校验（名字形状、模型 id 去重、
   * 正整数）在宿主 settings 插件里，那里才是这些规矩的真源。
   */
  saveProvider: [{ shape: { kind: 'json', maxBytes: MAX_PROVIDER_DRAFT } }],
  /** 删一个端点（写 config.yaml；默认端点被删时宿主自动改指）。 */
  removeProvider: [{ shape: { kind: 'string', max: MAX_PROVIDER_NAME } }],
  /**
   * 写入或清除端点的 API key（写 ~/.dsc/credentials.yaml）：第二个实参 `null` 是
   * **清除**而不是省略——所以它的形状是 stringOrNull 而不是可选的 string。
   */
  setProviderKey: [
    { shape: { kind: 'string', max: MAX_PROVIDER_NAME } },
    { shape: { kind: 'stringOrNull', max: MAX_PROVIDER_KEY } },
  ],
  /** 当前会话在宿主用量日志里的累计（只读；没有记录时 null）。 */
  sessionUsage: [{ shape: { kind: 'string', max: MAX_ID } }],
  /** 弹一条系统通知；字段只有标题与正文两项。 */
  notify: [{ shape: { kind: 'notify' } }],
  /** 以当前工作目录重启宿主。 */
  restartHost: [],
  /** 退出应用（关主窗口 → 优雅停宿主 → quit）。 */
  quit: [],
  /**
   * 终端：`[op, payload]`。op 钉死在 `DOCK_TERM_OPS` 那三个上（spawn / input / kill），
   * payload 是给宿主插件的小对象——它自己再净化一遍（路径限 cwd、shell 走白名单）。
   */
  terminal: [
    { shape: { kind: 'enum', values: DOCK_TERM_OPS } },
    { shape: { kind: 'json', maxBytes: MAX_TERM_PAYLOAD }, optional: true },
  ],
  /** 内嵌浏览器：`[visible, rect?]`。visible 为假（隐藏）时 rect 可省。 */
  dockBrowser: [{ shape: { kind: 'bool' } }, { shape: { kind: 'rect' }, optional: true }],
  /** 内嵌浏览器导航：`[url, action]`（url 只在 load 时用，协议在主进程校验）。 */
  browserNav: [
    { shape: { kind: 'string', max: MAX_PATH } },
    { shape: { kind: 'enum', values: NAV_ACTIONS } },
  ],
}

/** 一次桥调用的校验结果：过了就带收窄后的操作名与实参，没过给一句能读的错。 */
export type NativeCall = { ok: true; op: NativeOp; args: unknown[] } | { ok: false; error: string }

/**
 * 校验一次桥调用。
 *
 * 与界面通道的 `validateUiArgs` 同口径：参数个数上限、逐个的 JSON 类型、长度上限、
 * 枚举取值、`#rrggbb`；尾部省略只能从尾部开始，中间空一个会让后面的参数错位（正是要拒的形状）。
 *
 * @param op 调用方给的操作名（来自页面，任何形状都可能）
 * @param args 调用方给的实参（同上）
 */
export function validateNativeCall(op: unknown, args: unknown): NativeCall {
  if (typeof op !== 'string' || !NATIVE_OP_SET.has(op)) {
    return { ok: false, error: `原生桥不认识这个操作：${describeOp(op)}` }
  }
  const name = op as NativeOp
  const list = args === undefined || args === null ? [] : args
  if (!Array.isArray(list)) return { ok: false, error: `原生桥：${name} 的实参必须是数组` }
  const spec = NATIVE_ARG_SPECS[name]
  if (list.length > spec.length) {
    return { ok: false, error: `原生桥：${name} 最多收 ${String(spec.length)} 个实参，收到 ${String(list.length)} 个` }
  }
  const checked: unknown[] = []
  for (let index = 0; index < list.length; index += 1) {
    const value: unknown = list[index]
    const arg = spec[index]
    // stringOrNull：null 是**取值**不是省略（setProviderKey 的「清除」走这条）。
    if (value === null && arg.shape.kind === 'stringOrNull') {
      checked.push(null)
      continue
    }
    if (value === null || value === undefined) {
      if (arg.optional !== true) {
        return { ok: false, error: `原生桥：${name} 的第 ${String(index + 1)} 个实参不能为空` }
      }
      for (let later = index + 1; later < list.length; later += 1) {
        const rest: unknown = list[later]
        if (rest !== null && rest !== undefined) {
          return { ok: false, error: `原生桥：${name} 的第 ${String(index + 1)} 个实参省略了，但第 ${String(later + 1)} 个还在（省略只能从尾部开始）` }
        }
      }
      break
    }
    const problem = checkShape(arg.shape, value)
    if (problem !== null) {
      return { ok: false, error: `原生桥：${name} 的第 ${String(index + 1)} 个实参${problem}` }
    }
    checked.push(value)
  }
  for (let index = checked.length; index < spec.length; index += 1) {
    if (spec[index].optional !== true) {
      return { ok: false, error: `原生桥：${name} 的第 ${String(index + 1)} 个实参是必传的` }
    }
  }
  return { ok: true, op: name, args: checked }
}

/**
 * 把一个不认识的操作名说成人能读的样子。
 *
 * 为什么不直接 `String(op)`：`String({})` 是 `[object Object]`、`String(Symbol())` 会抛。
 * 这里只给"看得出是什么"的那一档，其余按类型说。
 */
function describeOp(op: unknown): string {
  if (typeof op === 'string') return op
  if (op === null) return 'null'
  if (typeof op === 'number' || typeof op === 'boolean') return String(op)
  if (typeof op === 'undefined') return 'undefined'
  return Array.isArray(op) ? '数组' : typeof op
}

/** 校验一个值是不是这个形状；不是就回一句人话。 */
function checkShape(shape: ArgShape, value: unknown): string | null {
  switch (shape.kind) {
    case 'string':
      if (typeof value !== 'string') return '必须是字符串'
      if (value.length > shape.max) return `是字符串但太长（${String(value.length)} > ${String(shape.max)} 字符）`
      return null
    case 'stringOrNull':
      if (value === null) return null
      if (typeof value !== 'string') return '必须是字符串或 null'
      if (value.length > shape.max) return `是字符串但太长（${String(value.length)} > ${String(shape.max)} 字符）`
      return null
    case 'bool':
      return typeof value === 'boolean' ? null : '必须是布尔值'
    case 'hex':
      // 只收压平过的 #rrggbb：半透明颜色到了系统那侧会被丢掉，宁可当场拒。
      return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? null : '必须是 #rrggbb 形状的颜色'
    case 'enum':
      return typeof value === 'string' && shape.values.includes(value)
        ? null
        : `必须是这几个值之一：${shape.values.join(' / ')}`
    case 'notify': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return '必须是 { title, body? } 对象'
      const record = value as Record<string, unknown>
      if (typeof record['title'] !== 'string') return '的 title 必须是字符串'
      if (record['title'].trim() === '') return '的 title 不能是空串'
      if (record['title'].length > MAX_NOTIFY_TITLE) return `的 title 太长（> ${String(MAX_NOTIFY_TITLE)} 字符）`
      const body = record['body']
      if (body !== undefined && typeof body !== 'string') return '的 body 必须是字符串'
      if (typeof body === 'string' && body.length > MAX_NOTIFY_BODY) return `的 body 太长（> ${String(MAX_NOTIFY_BODY)} 字符）`
      return null
    }
    case 'marketSources': {
      if (!Array.isArray(value)) return '必须是市场源数组（[{name, url}]）'
      if (value.length === 0) return '至少要有一个市场源'
      if (value.length > MAX_MARKET_SOURCES) return `里最多 ${String(MAX_MARKET_SOURCES)} 个市场源（收到 ${String(value.length)} 个）`
      for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return '的每一项必须是 {name, url} 对象'
        const record = entry as Record<string, unknown>
        const name = record['name']
        const url = record['url']
        if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_SOURCE_NAME) {
          return `的每一项要带非空的 name（≤${String(MAX_SOURCE_NAME)} 字符）`
        }
        if (typeof url !== 'string' || url.trim() === '' || url.length > MAX_SOURCE_URL) {
          return `的每一项要带非空的 url（≤${String(MAX_SOURCE_URL)} 字符）`
        }
      }
      return null
    }
    case 'rect': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return '必须是 { x, y, width, height } 对象'
      const record = value as Record<string, unknown>
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const number = record[key]
        if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > RECT_MAX) {
          return `的 ${key} 必须是有界的有限数`
        }
      }
      return null
    }
    case 'json': {
      const text = jsonText(value)
      if (text === null) return '不是可序列化的 JSON 值'
      if (text.length > shape.maxBytes) return `是 JSON 但太长（${String(text.length)} > ${String(shape.maxBytes)} 字符）`
      return null
    }
  }
}

/** 一段 JSON 文本；序列化不了（循环引用、BigInt、函数）给 null。 */
function jsonText(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}
