/**
 * 一次性升权参数：模型在动手类工具里显式请求「这一次放宽沙箱档位」。
 *
 * 形制照 codex 的 `sandbox_permissions` + `justification`：两个字段**必须成对出现**，
 * 且只对这一次调用生效（不留持久授权——dsc 的既定安全选择）。
 * 判定不在工具自己肚子里，而在沙箱插件挂在守卫链 order 8 的那位守卫上：
 * 工具层只负责把这两个参数写进 schema，让模型有地方说清楚「我要写到哪、为什么」。
 *
 * @module dsc/core/tools/sandbox-args
 */

/** 一次调用请求放宽到哪一档。 */
export const SANDBOX_PERMISSION_VALUES = ['workspace-write', 'danger-full-access'] as const

export type SandboxPermission = (typeof SANDBOX_PERMISSION_VALUES)[number]

/**
 * 放宽**持续多久**（形制照 codex 的 `PermissionGrantScope`；codex 的 `Turn` 在 dsc 里落成 `once`）：
 *   once     只这一次调用（默认）；
 *   session  本会话内同类放宽不再问——**仍要在审批卡上点「本会话允许」才生效**，
 *            模型在参数里写 session 只是表达意图，授权动作永远在用户那一侧。
 */
export const SANDBOX_SCOPE_VALUES = ['once', 'session'] as const

export type SandboxScope = (typeof SANDBOX_SCOPE_VALUES)[number]

/**
 * 两个目标档的语义差别（以前这里是**死的**：守卫 defer 之后没人再看这个值，两档行为一样）：
 *   workspace-write    留在沙箱里，只把这一次的写边界放宽（codex 的 `WithAdditionalPermissions`）；
 *   danger-full-access 这一次整个出沙箱，执行体不再受围栏（codex 的 `RequireEscalated`）。
 */
export const SANDBOX_PERMISSION_EFFECT: Readonly<Record<SandboxPermission, string>> = {
  'workspace-write': '留在沙箱内，只放宽这一次的写边界（网络开关与其他受保护路径照旧）',
  'danger-full-access': '这一次跳过沙箱判定（可写根与网络开关都不再看）',
}

/**
 * 展开进工具的 `parameters.properties`。
 *
 * 描述刻意写成「只在被沙箱拒了之后才填」：沙箱插件关着时这三个参数没有任何作用，
 * 但模型不该因为看见它们就主动要求放宽——没有任何档位能越过审批卡。
 */
export const sandboxPermissionProperties: Record<string, unknown> = {
  sandbox_permissions: {
    type: 'string',
    enum: [...SANDBOX_PERMISSION_VALUES],
    description:
      '仅当沙箱（sandbox 插件）以「超出可写范围」为由拒绝过这次操作、且这个操作确实必要时才填：' +
      '请求把这一次调用放宽到该档位（workspace-write = 留在沙箱内只放宽写边界；' +
      'danger-full-access = 这一次整个出沙箱）。必须与 justification 同时给出；' +
      '放宽请求会照常弹审批卡，用户不点同意就不会执行。',
  },
  justification: {
    type: 'string',
    description: '与 sandbox_permissions 成对出现：一句话说明为什么必须写到可写范围之外（用户据此决定批不批）。',
  },
  sandbox_scope: {
    type: 'string',
    enum: [...SANDBOX_SCOPE_VALUES],
    description:
      '可选，与 sandbox_permissions 一起给：这一档放宽要持续多久。once（默认）= 只这一次；' +
      'session = 本会话内同类放宽不再问（用户仍要在卡上点「本会话允许」才生效）。',
  },
}

/**
 * 读一次工具调用里的升权请求。
 *
 * 四种结果：`none` 没请求；`ok` 请求完整；`malformed` 参数不齐（守卫按拒处理——
 * 单独一个 `sandbox_permissions` 是典型的「想偷偷放宽」，不给理由就不该放过去）。
 */
export function readSandboxRequest(args: Record<string, unknown>):
  | { kind: 'none' }
  | { kind: 'ok'; permission: SandboxPermission; justification: string; scope: SandboxScope }
  | { kind: 'malformed'; reason: string } {
  const rawPermission = args.sandbox_permissions
  const rawJustification = args.justification
  const rawScope = args.sandbox_scope
  const hasPermission = rawPermission !== undefined && rawPermission !== null && rawPermission !== ''
  const justification = typeof rawJustification === 'string' ? rawJustification.trim() : ''
  const hasScope = rawScope !== undefined && rawScope !== null && rawScope !== ''
  if (!hasPermission && justification === '' && !hasScope) return { kind: 'none' }
  if (!hasPermission) {
    return {
      kind: 'malformed',
      reason: hasScope ? '只给了 sandbox_scope 没给 sandbox_permissions' : '只给了 justification 没给 sandbox_permissions',
    }
  }
  if (!SANDBOX_PERMISSION_VALUES.includes(String(rawPermission) as SandboxPermission)) {
    return { kind: 'malformed', reason: `sandbox_permissions 只能是 ${SANDBOX_PERMISSION_VALUES.join(' / ')}` }
  }
  if (justification === '') {
    return { kind: 'malformed', reason: '请求放宽沙箱必须同时给出 justification（为什么必须写到范围之外）' }
  }
  let scope: SandboxScope = 'once'
  if (hasScope) {
    if (!SANDBOX_SCOPE_VALUES.includes(String(rawScope) as SandboxScope)) {
      return { kind: 'malformed', reason: `sandbox_scope 只能是 ${SANDBOX_SCOPE_VALUES.join(' / ')}` }
    }
    scope = String(rawScope) as SandboxScope
  }
  return { kind: 'ok', permission: String(rawPermission) as SandboxPermission, justification, scope }
}
