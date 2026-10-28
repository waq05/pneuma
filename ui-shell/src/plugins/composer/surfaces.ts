/**
 * 输入区读的七片宿主快照面：模型 / 端点 / 档位 / 待批 / 会话路径与草稿归属 / 权限预设 / 模式预设 / git。
 * 每片都是「取值 + 相等判断」一对——快照每帧换引用，没有相等判断就每帧重画。
 *
 * 从 `composer/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/composer/surfaces
 */
import type { GitSurface, HostSnapshot, NoticeMessageView, PermissionPresetSurface, PresetSurface, PresetView, QueuedMessageView } from '@dsc/ui'

/** 权限预设投影缺席时的兜底（空清单：菜单里会说「清单没取到」，不假装有几个预设）。 */
export const EMPTY_PERMISSION_PRESETS: PermissionPresetSurface = { current: '', defaultName: '', options: [] }
/** 模式（预设）投影缺席时的兜底。 */
export const EMPTY_PRESET: PresetSurface = { current: '', defaultName: '', options: [], droppable: [] }
/** git 读数缺席（宿主那片没登记 / 不是仓库）时的兜底：`repo: false` = 整行不画。 */
export const EMPTY_GIT: GitSurface = { repo: false, branch: '', detached: false, dirtyFileCount: 0 }

/** 排队消息的相等判断：内容没变就不重渲染（宿主每帧都可能给新数组）。 */
export function sameQueued(left: readonly QueuedMessageView[], right: readonly QueuedMessageView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    if (other === undefined) return false
    return (
      item.index === other.index &&
      item.text === other.text &&
      (item.images?.join('|') ?? '') === (other.images?.join('|') ?? '')
    )
  })
}

export function readModel(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['model']
  return typeof value === 'string' ? value : ''
}

/**
 * 当前模型所属端点：`status.model` 是**裸名**，光有它分不清同名模型挂在哪个端点下
 * （清单里 `value` 才是 `端点/模型`）。老快照没有这一项时给空串，界面按「端点未知」处理。
 */
export function readProvider(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['provider']
  return typeof value === 'string' ? value : ''
}

export function readEffort(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'default'
  const value = (status as Record<string, unknown>)['effort']
  return typeof value === 'string' ? value : 'default'
}

/** 有挂起的审批时输入区整体禁用（旧界面把 `pendingApproval !== null` 传成 disabled）。 */
export function readHasApproval(snapshot: HostSnapshot | null): boolean {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return false
  const pending = (surfaces as Record<string, unknown>)['pendingApproval']
  return pending !== null && pending !== undefined
}

/** 会话身份（草稿按它分槽）。用 `sessionPath` 而不是 `sessionId`：路径是壳里其它地方
 *  统一的会话标识，同一条会话重开还是同一把钥匙，草稿不会因为换了进程就丢。
 *  **还没落盘的会话**（`sessionUnsaved`）路径会变，那种会话的草稿改按工作区分槽——
 *  见 plugins/composer/draft.ts 的 `draftScopeOf`。 */
export function readSessionPath(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const path = (status as Record<string, unknown>)['sessionPath']
  return typeof path === 'string' ? path : ''
}

/** 会话 uuid（分槽时用来分辨「换了会话」与「同一条会话刚落盘」）。 */
export function readSessionId(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['sessionId']
  return typeof value === 'string' ? value : ''
}

/** 会话工作目录（未落盘的新会话按它分槽）。 */
export function readDraftCwd(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' ? value : ''
}

/** 这条会话一条消息都还没发过吗（草稿分槽的第二个依据）。 */
export function readSessionUnsaved(snapshot: HostSnapshot | null): boolean {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return false
  return (status as Record<string, unknown>)['sessionUnsaved'] === true
}

/**
 * 权限预设投影（当前生效的 + 新会话默认的 + 全部可选）。清单**从快照读**，不在壳里抄一份：
 * 出厂那几个预设（只读 / 工作区可写 / 完全访问 / AI 复核）由 permission-presets 插件给定，
 * 抄一份就会漂。`current` 是预设名，三项旋钮拼不出预设时宿主给 `'custom'`（这里不特判它，
 * 菜单找不到这一项自然显示「自定义」）。
 */
export function readPermissionPresets(snapshot: HostSnapshot | null): PermissionPresetSurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_PERMISSION_PRESETS
  const presets = (surfaces as Record<string, unknown>)['permissionPresets']
  if (typeof presets !== 'object' || presets === null) return EMPTY_PERMISSION_PRESETS
  const record = presets as Record<string, unknown>
  const current = record['current']
  const options = record['options']
  if (typeof current !== 'string' || !Array.isArray(options)) return EMPTY_PERMISSION_PRESETS
  return {
    current,
    defaultName: typeof record['defaultName'] === 'string' ? record['defaultName'] : '',
    options: options as PermissionPresetSurface['options'],
  }
}

/**
 * 权限预设投影的相等判断：快照**每帧都换引用**，不给判断就会每帧重画输入区。
 *
 * 逐字段比而不是比引用：清单是几个预设，比一遍比让 React 重画便宜得多
 * （与 `sameQueued` 同一套写法）。
 */
export function samePermissionPresets(left: PermissionPresetSurface, right: PermissionPresetSurface): boolean {
  if (left === right) return true
  if (left.current !== right.current || left.defaultName !== right.defaultName) return false
  if (left.options.length !== right.options.length) return false
  return left.options.every((item, index) => {
    const other = right.options[index]
    return (
      other !== undefined &&
      item.name === other.name &&
      item.label === other.label &&
      item.description === other.description &&
      item.builtin === other.builtin
    )
  })
}

/** 模式（预设）投影（当前档 + 新会话默认 + 全部可选），同样从快照读。 */
export function readPresetSurface(snapshot: HostSnapshot | null): PresetSurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_PRESET
  const preset = (surfaces as Record<string, unknown>)['preset']
  if (typeof preset !== 'object' || preset === null) return EMPTY_PRESET
  const record = preset as Record<string, unknown>
  const current = record['current']
  const options = record['options']
  if (typeof current !== 'string' || !Array.isArray(options)) return EMPTY_PRESET
  return {
    current,
    defaultName: typeof record['defaultName'] === 'string' ? record['defaultName'] : '',
    options: options as PresetView[],
    droppable: Array.isArray(record['droppable']) ? record['droppable'] : [],
  }
}

/** 模式投影的相等判断（比的是菜单真正用到的四个字段）。 */
export function samePresetSurface(left: PresetSurface, right: PresetSurface): boolean {
  if (left === right) return true
  if (left.current !== right.current || left.defaultName !== right.defaultName) return false
  if (left.options.length !== right.options.length) return false
  return left.options.every((item, index) => {
    const other = right.options[index]
    return (
      other !== undefined &&
      item.name === other.name &&
      item.label === other.label &&
      item.description === other.description &&
      item.problem === other.problem
    )
  })
}

/**
 * 收件箱里还排着几条（用户队列 + 机器通知，**两个面之和**）。
 *
 * 用途只有一个：提交时按它算「这条新消息会排到收件箱第几位」，好让紧随的
 * `steerQueued(index)` 提到队首。必须数**整条收件箱**而不是只数 `queued`——
 * 队列条的面拆开后，用户消息在收件箱里的下标仍要跨过排在前面的机器通知，
 * 只数用户队列会把插话打到别的条目上。
 */
export function readInboxCount(snapshot: HostSnapshot | null): number {
  const queued = snapshot?.['queued']
  const notices = snapshot?.['notices']
  return (Array.isArray(queued) ? queued.length : 0) + (Array.isArray(notices) ? notices.length : 0)
}

export function readQueued(snapshot: HostSnapshot | null): readonly QueuedMessageView[] {
  const value = snapshot?.['queued']
  return Array.isArray(value) ? (value as QueuedMessageView[]) : EMPTY_QUEUE
}

/** 空队列常量：引用稳定，选择器（默认比较）才拦得住重渲染。 */
export const EMPTY_QUEUE: readonly QueuedMessageView[] = Object.freeze([])

/** 待投递通知的相等判断：内容没变就不重渲染（宿主每帧都可能给新数组）。 */
export function sameNotices(left: readonly NoticeMessageView[], right: readonly NoticeMessageView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return other !== undefined && item.index === other.index && item.text === other.text
  })
}

export function readNotices(snapshot: HostSnapshot | null): readonly NoticeMessageView[] {
  const value = snapshot?.['notices']
  return Array.isArray(value) ? (value as NoticeMessageView[]) : EMPTY_NOTICES
}

/** 空通知常量：同 EMPTY_QUEUE 的理由。 */
export const EMPTY_NOTICES: readonly NoticeMessageView[] = Object.freeze([])

/**
 * git 读数投影（当前分支 + 改动计数）。宿主那片是**轻读**（一条分支名 + 数一数
 * `git status` 的条数），壳只渲染，不自己拍——两处各拍一遍在大仓里就是拿 CPU 换同一行字。
 */
export function readGit(snapshot: HostSnapshot | null): GitSurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_GIT
  const raw = (surfaces as Record<string, unknown>)['git']
  if (typeof raw !== 'object' || raw === null) return EMPTY_GIT
  const record = raw as Record<string, unknown>
  return {
    repo: record['repo'] === true,
    branch: typeof record['branch'] === 'string' ? record['branch'] : '',
    detached: record['detached'] === true,
    dirtyFileCount: typeof record['dirtyFileCount'] === 'number' ? record['dirtyFileCount'] : 0,
  }
}
