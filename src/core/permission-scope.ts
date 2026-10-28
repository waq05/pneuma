/**
 * 权限三项的「按会话」读写（沙箱档位 / 权限模式 / 审阅者）。
 *
 * 为什么单开一层：这三项原来分别是 approval 与 sandbox 插件里的进程级变量
 * （2026-10-28 用户报障：在 A 会话切「只读」，B 会话和后台 agent 一起变）。
 * 会话日志本来就带 `state` 条目，把三项写进去即可跟着会话走——切换、恢复、
 * 分叉、归档都不用额外的登记表。
 *
 * 口径照 dsh 的 `permission-presets`：**会话值优先，缺项才用默认值**；默认值
 * 只对「还没钉过的会话」生效，钉住之后改默认值不影响它（老会话第一次打开时
 * 把当时生效的值写进去，而不是让它跟着偏好漂）。
 *
 * 这一层是纯的：不读磁盘、不认识插件，只认一个最小的会话形状，探针可以直读。
 *
 * @module dsc/core/permission-scope
 */
import type { ApprovalPolicy, ApprovalReviewer, SandboxMode } from '../contract.js'

/** 会话里存的权限三项；`null` = 这一项还没钉过（读的时候补默认值并钉住）。 */
export interface SessionPermissionState {
  sandbox: SandboxMode | null
  policy: ApprovalPolicy | null
  reviewer: ApprovalReviewer | null
}

/** 解析后的三项（都有值）。 */
export interface PermissionKnobs {
  sandbox: SandboxMode
  policy: ApprovalPolicy
  reviewer: ApprovalReviewer
}

/** 存权限需要的会话最小面（`Session` 结构上满足它；探针用假对象也能测）。 */
export interface PermissionSession {
  state(id: 'permissions'): SessionPermissionState | undefined
  appendState(id: 'permissions', payload: SessionPermissionState): void
}

/** 三项的中文名（诊断与报错用）。 */
export const PERMISSION_FIELD_LABEL: Record<keyof SessionPermissionState, string> = {
  sandbox: '沙箱档位',
  policy: '权限模式',
  reviewer: '审阅者',
}

/**
 * 最小假会话的兜底存储（探针与老调用方给的对象没有 state/appendState）。
 * 真实 Session 永远走日志条目；这里只保证「同一个假对象读得到自己刚写的值」。
 */
const fallbackStates = new WeakMap<object, SessionPermissionState>()
/** 有 id 的假会话按 id 记：探针的 current() 每次返回新对象，按对象记会丢。 */
const fallbackById = new Map<string, SessionPermissionState>()

/** 假会话的兜底槽：有 meta.id 按 id，没有才按对象。 */
function fallbackOf(session: PermissionSession): SessionPermissionState | undefined {
  const id = (session as unknown as { meta?: { id?: string } }).meta?.id
  if (typeof id === 'string' && id !== '') return fallbackById.get(id)
  return fallbackStates.get(session as unknown as object)
}

/** 写假会话的兜底槽（与 {@link fallbackOf} 同一个键口径）。 */
function setFallbackOf(session: PermissionSession, state: SessionPermissionState): void {
  const id = (session as unknown as { meta?: { id?: string } }).meta?.id
  if (typeof id === 'string' && id !== '') {
    fallbackById.set(id, state)
    return
  }
  fallbackStates.set(session as unknown as object, state)
}

/** 读会话里已经钉住的三项；没有就是全 `null`（老会话与刚建的会话都会走到这里）。 */
export function storedPermissions(session: PermissionSession): SessionPermissionState {
  const raw =
    typeof session.state === 'function'
      ? session.state('permissions')
      : fallbackOf(session)
  return {
    sandbox: raw?.sandbox ?? null,
    policy: raw?.policy ?? null,
    reviewer: raw?.reviewer ?? null,
  }
}

/**
 * 把一批值并进会话状态；只有真变了才写一条（避免每次读都往日志里塞重复行）。
 * @returns 这次有没有写。
 */
export function writePermissions(session: PermissionSession, patch: Partial<SessionPermissionState>): boolean {
  const before = storedPermissions(session)
  const after: SessionPermissionState = {
    sandbox: patch.sandbox ?? before.sandbox,
    policy: patch.policy ?? before.policy,
    reviewer: patch.reviewer ?? before.reviewer,
  }
  if (after.sandbox === before.sandbox && after.policy === before.policy && after.reviewer === before.reviewer) return false
  if (typeof session.appendState === 'function') session.appendState('permissions', after)
  else setFallbackOf(session, after)
  return true
}

/**
 * 取某一项：会话里钉过就用它，没钉过就落 `fallback` 并钉住。
 *
 * 为什么在读取时钉、而不是只在启动/切会话时钉：沙箱是官方可开关插件，挂载顺序
 * 晚于 permission-presets；谁先被问谁完成钉住，三条插件都不会读到「半份状态」。
 */
export function permissionOf<K extends keyof SessionPermissionState>(
  session: PermissionSession,
  key: K,
  fallback: NonNullable<SessionPermissionState[K]>,
): NonNullable<SessionPermissionState[K]> {
  const stored = storedPermissions(session)[key]
  if (stored !== undefined && stored !== null) return stored as NonNullable<SessionPermissionState[K]>
  writePermissions(session, { [key]: fallback } as Partial<SessionPermissionState>)
  return fallback
}

/** 一次解析三项：缺哪项补哪项（三项的默认值由调用方各给各的）。 */
export function resolvePermissions(session: PermissionSession, defaults: PermissionKnobs): PermissionKnobs {
  return {
    sandbox: permissionOf(session, 'sandbox', defaults.sandbox),
    policy: permissionOf(session, 'policy', defaults.policy),
    reviewer: permissionOf(session, 'reviewer', defaults.reviewer),
  }
}

/** 三项是否完全一致（预设 apply 用它算「这次到底要改几根」）。 */
export function samePermissionKnobs(left: PermissionKnobs, right: PermissionKnobs): boolean {
  return left.sandbox === right.sandbox && left.policy === right.policy && left.reviewer === right.reviewer
}
