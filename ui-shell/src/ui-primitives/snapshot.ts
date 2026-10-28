/**
 * 宿主快照的读数（整个界面壳唯一一份）。
 *
 * 快照是宿主推过来的一棵 `unknown` 树（见 `@dsc/ui-core` 的 `HostSnapshot`），每个插件都要从
 * 里面取同样的几样东西：工作目录、会话清单、会话 jsonl 路径、正在跑的回合状态、条目流。
 * 此前十个插件各写一遍 `readCwd` / `readSessions` / `readSessionPath` / `readTurnState` /
 * `readEntries` / `readLive` / `readSessionId`——**同一个字段的收窄写十遍**，而收窄口径一旦
 * 分叉，界面就会出现自相矛盾：侧栏底部有工作目录，文件树却说没有。
 *
 * 两条约定：
 *   - 每个读数只定义「字段缺失算什么」（`null` / 空串 / 'idle' / 共用空表），不在这里做业务；
 *   - 空表与空状态是**模块级常量**：引用稳定，`useHostSelector` 的相等判断才拦得住重渲染。
 *
 * @module dsc-ui-shell/ui-primitives/snapshot
 */
import type { HostSnapshot, SessionSummary, TranscriptEntry } from '@dsc/ui-core'

/** 空会话清单：没拿到快照时共用一份（引用稳定，选择器才拦得住重渲染）。 */
export const NO_SESSIONS: readonly SessionSummary[] = Object.freeze([])

/** 空条目表：同上。 */
export const NO_ENTRIES: readonly TranscriptEntry[] = Object.freeze([])

/** 当前会话的工作目录；没有（或空串）给 null。 */
export function readCwd(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' && value !== '' ? value : null
}

/** 会话清单；快照里没有时给共用空表。 */
export function readSessions(snapshot: HostSnapshot | null): readonly SessionSummary[] {
  const value = snapshot?.['sessions']
  return Array.isArray(value) ? (value as SessionSummary[]) : NO_SESSIONS
}

/** 当前会话的 jsonl 路径；没有给 null。 */
export function readSessionPath(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionPath']
  return typeof value === 'string' ? value : null
}

/** 正在跑的回合状态；没有给 'idle'。 */
export function readTurnState(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'idle'
  const value = (status as Record<string, unknown>)['turnState']
  return typeof value === 'string' ? value : 'idle'
}

/** 条目流；没有给共用空表。 */
export function readEntries(snapshot: HostSnapshot | null): readonly TranscriptEntry[] {
  const value = snapshot?.entries
  return Array.isArray(value) ? (value as unknown as TranscriptEntry[]) : NO_ENTRIES
}

/** 正在进流的条目（还没落进 `entries` 的那几条）；没有给共用空表。 */
export function readLive(snapshot: HostSnapshot | null): readonly TranscriptEntry[] {
  const value = snapshot?.liveEntries
  return Array.isArray(value) ? (value as unknown as TranscriptEntry[]) : NO_ENTRIES
}

/**
 * 当前会话的短名（`status.sessionPath` 的文件名去掉 `.jsonl`）。
 *
 * 为什么不用 `status.sessionId`：那份 id 与名册（`listTeammates` 的 `sessionId`）不是一个口径，
 * 拿它对名册会整节对不上——第一版自检里团队面板就是这么整块不出现的。
 */
export function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string' || path === '') return null
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base
}
