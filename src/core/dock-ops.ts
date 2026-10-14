/**
 * dock 通道的分档规格：读类 / 写类 / 终端。
 *
 * ## 为什么要分档
 *
 * `dock` 原来是**整条**被界面通道排除的，理由是它里面混着 `term-spawn`（起 pwsh/cmd/bash/node）——
 * 那与「在用户机器上执行任意命令」同级，不该交给页面。但这条通道里另外十一个 op 是界面真正要用的：
 * 工作区文件树、文件内容、git 状态与分支清单、差异（读），以及暂存 / 取消暂存 / 提交 /
 * 切分支 / 建分支（写）。
 * 一锅端掉等于「文件面板」永远搬不进壳；整条放行又等于把 spawn 交出去。所以按**动作落在谁手里**拆三档：
 *
 * | 档 | op | 走哪条路 | 为什么 |
 * | --- | --- | --- | --- |
 * | 读 | `fs-list` `fs-read` `git-status` `git-branches` `git-log` `git-diff` | 界面 HTTP 通道**直接放行** | 只读，且宿主侧已经限定在 cwd 内 |
 * | 写 | `git-stage` `git-unstage` `git-commit` `git-checkout` `git-branch-create` | 界面 HTTP 通道，但**过审批** | 会改仓库状态，交给权限模式那套裁决（与工具调用同一口径） |
 * | 终端 | `term-spawn` `term-input` `term-kill` | **只走桌面窗口的原生桥**，不进 HTTP 面 | 起进程 = 任意命令执行；浏览器里拿到 Cookie 的页面不该有这个能力 |
 *
 * 「只走原生桥」是**真的**只走那条路：`DOCK_UI_OPS` 里没有 term op，所以 HTTP 的
 * `/api/invoke { method: 'dock' }` 拿着 `term-spawn` 会被实参校验当场拒（枚举不在表里）。
 * 而原生桥只对主窗口的文档开放（`event.sender === mainWindow.webContents`），
 * 于是"桌面窗口有效"这件事由**传输**保证，而不是靠 payload 里一个可伪造的标记位。
 *
 * 这一份零依赖、浏览器安全，所以三处共用：宿主插件（分档与审批）、界面通道（放行面）、
 * 桌面主进程与壳（终端那条路）。
 *
 * @module dsc/core/dock-ops
 */

/** 读类：只读取工作区现状，宿主侧限定在 cwd 内。 */
export const DOCK_READ_OPS = ['fs-list', 'fs-read', 'git-status', 'git-branches', 'git-log', 'git-diff'] as const

/** 写类：会改 git 状态，走审批。 */
export const DOCK_WRITE_OPS = [
  'git-stage',
  'git-unstage',
  'git-commit',
  'git-checkout',
  'git-branch-create',
] as const

/** 终端：起进程，只走桌面窗口的原生桥。 */
export const DOCK_TERM_OPS = ['term-spawn', 'term-input', 'term-kill'] as const

/** 全部 op（宿主插件按它认人）。 */
export const DOCK_OPS = [...DOCK_READ_OPS, ...DOCK_WRITE_OPS, ...DOCK_TERM_OPS] as const

/** 界面 HTTP 通道放行的 op：读 + 写，**没有**终端。 */
export const DOCK_UI_OPS = [...DOCK_READ_OPS, ...DOCK_WRITE_OPS] as const

export type DockReadOp = (typeof DOCK_READ_OPS)[number]
export type DockWriteOp = (typeof DOCK_WRITE_OPS)[number]
export type DockTermOp = (typeof DOCK_TERM_OPS)[number]
export type DockOp = (typeof DOCK_OPS)[number]

/** 查表用的集合。 */
export const DOCK_TERM_OP_SET: ReadonlySet<string> = new Set<string>(DOCK_TERM_OPS)
export const DOCK_WRITE_OP_SET: ReadonlySet<string> = new Set<string>(DOCK_WRITE_OPS)

/** 是不是终端 op（决定它能不能进界面 HTTP 面）。 */
export function isDockTermOp(op: string): op is DockTermOp {
  return DOCK_TERM_OP_SET.has(op)
}

/** 是不是写类 op（决定要不要过审批）。 */
export function isDockWriteOp(op: string): op is DockWriteOp {
  return DOCK_WRITE_OP_SET.has(op)
}

/**
 * 写类 op 的审批卡文案。
 *
 * `toolName` 用 `git:` 前缀，一眼能跟工具调用区分开（审批卡上会显示这一栏）；
 * `summary` 只放**这次要动什么**（文件清单 / 提交信息首行），不放整段 payload——
 * 卡片是单行的，塞不下。
 */
export const DOCK_WRITE_LABEL: Readonly<Record<DockWriteOp, { toolName: string; summary: (payload: Record<string, unknown>) => string }>> = {
  'git-stage': {
    toolName: 'git: 暂存',
    summary: (payload) => `暂存 ${fileListText(payload)}`,
  },
  'git-unstage': {
    toolName: 'git: 取消暂存',
    summary: (payload) => `取消暂存 ${fileListText(payload)}`,
  },
  'git-commit': {
    toolName: 'git: 提交',
    summary: (payload) => `提交：${firstLine(String(payload['message'] ?? ''))}`,
  },
  // 切分支与建分支都动**工作树**（切过去会把当前分支上未提交、且两边不一致的改动带过去
  // 或被 git 拒掉），所以与提交同档：过审批，卡片上直接写清切到哪个分支。
  'git-checkout': {
    toolName: 'git: 切换分支',
    summary: (payload) => `切到 ${branchName(payload)}`,
  },
  'git-branch-create': {
    toolName: 'git: 新建并切换分支',
    summary: (payload) => `新建并切到 ${branchName(payload)}`,
  },
}

/** 分支名的短文案（两个新写类 op 共用；缺失时说清「没给名字」而不是留空）。 */
function branchName(payload: Record<string, unknown>): string {
  const name = String(payload['branch'] ?? payload['name'] ?? '').trim()
  return name === '' ? '（没有指定分支名）' : name
}

/** 文件清单的短文案：最多三个名字，其余收成「等 N 个」。 */
function fileListText(payload: Record<string, unknown>): string {
  const files = Array.isArray(payload['files']) ? payload['files'] : []
  const names = files.filter((file): file is string => typeof file === 'string').slice(0, 3)
  if (names.length === 0) return '（没有指定文件）'
  const rest = files.length - names.length
  return rest > 0 ? `${names.join('、')} 等 ${String(files.length)} 个文件` : names.join('、')
}

/** 取第一行并压到 80 字（提交信息可能是一整段）。 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}
