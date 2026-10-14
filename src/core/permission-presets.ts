/**
 * 打包权限预设：把**沙箱档位**、**权限模式**、**审阅者**三根旋钮捆成一个具名预设。
 *
 * 为什么要有这一层：三根旋钮各自独立是对的（它们管三件不同的事），但用户要从
 * 「我现在打算让模型干多大的活」直接落到一组取值上——分开选就会出现
 * 「完全访问 + 沙箱仍 workspace-write」这种自相矛盾的组合。参考实现里预设就是
 * 「沙箱 + 审批」一对（`dsh-permission-presets` 的 `PresetSpec`、codex 的
 * `builtin_approval_presets()`），dsc 在这一对之上再加审阅者这一轴。
 *
 * 两条硬约束（改这个文件时别破）：
 *   1. **预设只做组合，不放宽安全**：表里任何一项都写不出违反守卫链的值；写口只调
 *      沙箱与审批各自的 setter，它们自己仍会过校验、记审计。灾难地板看一眼命令就拦，
 *      不认得预设这回事。
 *   2. **不匹配任何预设的组合读作 `custom`**——它是推导出来的状态：可以停留在它上面
 *      （在设置页一格一格地改就会落到这里），但不能通过 `use()` 选到它。
 *
 * @module dsc/core/permission-presets
 */
import type { ApprovalPolicy, ApprovalReviewer, SandboxMode } from '../contract.js'

/** 一个打包权限预设。 */
export interface PermissionPreset {
  /** 预设标识（小写字母数字连字符）。 */
  name: string
  /** 界面上的显示名。 */
  label: string
  /** 一句话说明这档意味着什么（界面悬浮与通知用）。 */
  description: string
  /** 捆进来的沙箱档位。 */
  sandbox: SandboxMode
  /** 捆进来的权限模式。 */
  policy: ApprovalPolicy
  /** 捆进来的审阅者。 */
  reviewer: ApprovalReviewer
  /** 出厂自带（四个都删不掉；用户要微调就去设置页逐格改，会落到 custom）。 */
  builtin: boolean
}

/** 不匹配任何预设时读到的名字。它不是可选项：能停在上面，但 `use('custom')` 会被拒。 */
export const CUSTOM_PERMISSION_PRESET = 'custom'

/**
 * 出厂四个。取值刻意与参考实现对齐：
 *   read-only    —— codex 的 Read Only（read-only 沙箱 + 本人审）；
 *   workspace    —— codex 的 Default / 参考实现的 workspace-write（工作区可写 + 本人审），默认档；
 *   full-access  —— codex 的 Full Access / 参考实现的 danger-full-access（不设围栏 + 不再问）；
 *   auto-review  —— 参考实现的 Auto（沙箱钉死在不设围栏 + 每个调用先过模型判官）。
 */
export const BUILTIN_PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    name: 'read-only',
    label: '只读',
    description: '读文件、查状态可以；写盘与执行命令一律拒（不弹卡，直接拒）',
    sandbox: 'read-only',
    policy: 'readonly',
    reviewer: 'user',
    builtin: true,
  },
  {
    name: 'workspace',
    label: '工作区可写',
    description: '工作区内的文件改动自动放行；区外写入与命令走审批卡（默认档）',
    sandbox: 'workspace-write',
    policy: 'auto-edit',
    reviewer: 'user',
    builtin: true,
  },
  {
    name: 'full-access',
    label: '完全访问',
    description: '什么都不问，工作区内外都能改、命令直接跑（灾难性命令仍然拒）',
    sandbox: 'danger-full-access',
    policy: 'full-access',
    reviewer: 'user',
    builtin: true,
  },
  {
    name: 'auto-review',
    label: 'AI 复核',
    description: '每一次调用先给模型判官看：判放行就直接过，判高风险或判不出来才落到你的审批卡',
    sandbox: 'danger-full-access',
    policy: 'full-access',
    reviewer: 'auto-review',
    builtin: true,
  },
]

/** 新会话默认落在哪一档（出厂 = 工作区可写；与内核的两根默认值一致）。 */
export const DEFAULT_PERMISSION_PRESET = 'workspace'

/** 按名字取预设；认不出返回 null（调用方决定是报错还是回落）。 */
export function findPermissionPreset(name: string): PermissionPreset | null {
  return BUILTIN_PERMISSION_PRESETS.find((preset) => preset.name === name) ?? null
}

/**
 * 派生状态（三项拼不成任何预设）在界面上读作什么。
 *
 * 为什么不是一句通用的「自定义」：审阅者是 AI 复核时，这个组合的实际含义就是
 * 「先过 AI 审查」——那是用户此刻真正关心的那件事，说「自定义」等于什么都没说。
 * 其余组合（只改了沙箱档位或权限模式）没有这样一个更具体的名字，才回落「自定义」。
 *
 * 名字只用于**显示**：`custom` 仍然不是可选项，写口 `use('custom')` 照旧拒。
 */
export function derivedPresetLabel(reviewer: ApprovalReviewer): string {
  return reviewer === 'auto-review' ? 'AI 审查' : '自定义'
}

/**
 * 把一组实际取值映射回预设名；没有任何预设匹配就返回 {@link CUSTOM_PERMISSION_PRESET}。
 *
 * 判据是三项全等：用户可以在设置页把三根旋钮拼成任意组合，只有恰好落在某个预设上
 * 才读作那个预设——这与参考实现「不匹配的组合显示为 custom」是同一条规则。
 */
export function matchPermissionPreset(
  sandbox: SandboxMode,
  policy: ApprovalPolicy,
  reviewer: ApprovalReviewer,
): string {
  const hit = BUILTIN_PERMISSION_PRESETS.find(
    (preset) => preset.sandbox === sandbox && preset.policy === policy && preset.reviewer === reviewer,
  )
  return hit?.name ?? CUSTOM_PERMISSION_PRESET
}
