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
 * 桥里**故意没有**的两类（各有理由，别顺手加）：
 *   - `installPlugin` / `installSkill`：系统选择器把文件复制进 `~/.dsc/`，是供应链写入口，
 *     与界面通道排除 `installMarketSkill` / `setMarketSources` 同一个理由。
 *   - 内嵌浏览器那几个（`dockBrowser` / `browserNav` / `onBrowserState`）：它们是原生
 *     `WebContentsView` 覆盖层，跟终端一起在阶段 5.2 落地，那时一并进桥。
 *
 * @module dsc/core/native-bridge
 */

/**
 * 桥的协议版本：**加操作不涨**，改某个操作的实参或语义才涨。
 * 桌面主进程与壳握手时对一下，不一致就在诊断区说明白（不静默降级）。
 */
export const NATIVE_BRIDGE_VERSION = 1

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
  'sessionUsage',
  'notify',
  'restartHost',
  'quit',
] as const

/** 桥认得的一个操作名。 */
export type NativeOp = (typeof NATIVE_OPS)[number]

/** 查表用的集合。 */
export const NATIVE_OP_SET: ReadonlySet<string> = new Set<string>(NATIVE_OPS)

/** 一个实参的形状。取值集合刻意很小：这一层要的正是"最小且能读懂"。 */
type ArgShape =
  | { kind: 'string'; max: number }
  | { kind: 'hex' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'notify' }

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

const THEME_SOURCES = ['dark', 'light', 'system'] as const
const WORKSPACE_KINDS = ['terminal', 'explorer', 'vscode'] as const

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
  /** 当前会话在宿主用量日志里的累计（只读；没有记录时 null）。 */
  sessionUsage: [{ shape: { kind: 'string', max: MAX_ID } }],
  /** 弹一条系统通知；字段只有标题与正文两项。 */
  notify: [{ shape: { kind: 'notify' } }],
  /** 以当前工作目录重启宿主。 */
  restartHost: [],
  /** 退出应用（关主窗口 → 优雅停宿主 → quit）。 */
  quit: [],
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
function checkShape(shape: ArgShape, value: unknown): string | null {  switch (shape.kind) {
    case 'string':
      if (typeof value !== 'string') return '必须是字符串'
      if (value.length > shape.max) return `是字符串但太长（${String(value.length)} > ${String(shape.max)} 字符）`
      return null
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
  }
}
