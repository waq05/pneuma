/**
 * Super Agent 界面的读面：把 `snapshot.surfaces.superagent` 收成一份形状稳定的视图，
 * 外加页内导航（页签 / 选中工单 / 高亮）的模块级信号。
 *
 * 为什么这里另抄一份类型而不用 `@dsc/ui` 的转出：`SuperagentSurface` /
 * `SuperagentTicketView` / `SuperagentStage` 是宿主契约（`src/contract/runtime.ts`），
 * 界面核 `@dsc/ui-core` 的转出清单里还没有这三个名字，插件又只能从平台种子取类型。
 * 契约写的是「非可选」，但宿主插件默认关着——关着时这一格**整个缺席**，所以这里按
 * `readGit` 的路子（`ui-composer/ui/surfaces.ts:223-235`）做形状检查 + 常量兜底：
 * 认不出的字段按缺省处理，整格不在就返回 `null`（界面据此画「未启动」，不画假数字 0）。
 *
 * 页内状态为什么放模块级：整页模式退出时页条目会被卸载（`ui-layout/ui/app.tsx:477`），
 * `useState` 会丢。页签、选中工单、高亮都是「这一页自己的位置」，放这里比放组件里稳。
 *
 * @module dsc-ui-shell/superagent/state
 */
import { useSyncExternalStore } from 'react'
import { createSignal, createT, useHostSelector, type HostSnapshot } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：阶段名要在这里翻（组件层再用同一个 `t` 取别的键）。 */
const t = createT({ zh, en })

/** 一张工单的阶段（与契约 `SuperagentStage` 同构；`action` 放宽成可选，缺字段时不编造）。 */
export type SuperagentStage =
  | { stage: 'person'; action?: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' }
  | { stage: 'idle' }
  | { stage: 'ended' }

/** 一张工单的界面投影（契约 `SuperagentTicketView` 的形状检查版）。 */
export interface SuperagentTicket {
  id: string
  title: string
  stage: SuperagentStage
  /** 建单时刻（ISO 8601）；认不出时是空串，界面不画时间。 */
  at: string
  /** P0 宿主还不填，留着是为了一接上就能显示。 */
  branch?: string
  changedFiles?: string[]
  summary?: string
}

/** 三组计数；字段缺失时由工单阶段现数，不拿 0 冒充。 */
export interface SuperagentCounts {
  needsYou: number
  running: number
  done: number
}

/** 面板要的一份视图（契约 `SuperagentSurface` 的形状检查版）。 */
export interface SuperagentView {
  ready: boolean
  problem: { code: string; detail: string } | null
  counts: SuperagentCounts
  tickets: readonly SuperagentTicket[]
  /** 最近动态，最旧在前（上限 20 由宿主截）。 */
  recent: readonly { at: string; text: string }[]
}

/** 空清单常量：字段缺席时共用一份，相等判断与重渲染判据都靠它（照 `readGit` 的常量兜底）。 */
const EMPTY_TICKETS: readonly SuperagentTicket[] = Object.freeze([])
const EMPTY_RECENT: readonly { at: string; text: string }[] = Object.freeze([])

/** 阶段能进哪一组：左侧栏徽标只认 `needsYou`，列表按这三组分。 */
export type SuperagentTicketGroup = 'person' | 'working' | 'ended'

/** 一张工单给界面看的阶段名（已翻译）。 */
export function stageLabelOf(stage: SuperagentStage): string {
  if (stage.stage === 'person') {
    switch (stage.action) {
      case 'delivery':
        return t('superagent.stage.person.delivery')
      case 'answer':
        return t('superagent.stage.person.answer')
      case 'review':
        return t('superagent.stage.person.review')
      case 'blocked':
        return t('superagent.stage.person.blocked')
      case 'failed':
        return t('superagent.stage.person.failed')
      default:
        // 契约里 person 一定带 action；宿主将来多一档时退到组名，不显示空白。
        return t('superagent.stage.person')
    }
  }
  if (stage.stage === 'working') {
    return stage.action === 'queued' ? t('superagent.stage.working.queued') : t('superagent.stage.working')
  }
  return stage.stage === 'ended' ? t('superagent.stage.ended') : t('superagent.stage.idle')
}

/** 一张工单进哪一组。 */
export function stageGroupOf(stage: SuperagentStage): SuperagentTicketGroup {
  if (stage.stage === 'person') return 'person'
  if (stage.stage === 'ended') return 'ended'
  return 'working'
}

/** ISO 时刻 → 本机 `YYYY-MM-DD HH:mm`；认不出给空串（界面据此不画）。 */
export function formatAt(iso: string): string {
  if (iso === '') return ''
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 任意值 → 普通对象；数组与 null 都不算。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 非负有限数才认，其余走兜底。 */
function countOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** `person` 档的五个动作；认不出的丢掉，别把脏值写进视图。 */
const PERSON_ACTIONS = ['delivery', 'answer', 'review', 'blocked', 'failed'] as const

function personActionOf(value: unknown): (typeof PERSON_ACTIONS)[number] | undefined {
  return PERSON_ACTIONS.find((item) => item === value)
}

/** 阶段投影：只认契约那四档，其余按「待命」处理（宿主将来加档时界面不会画空白）。 */
function stageOf(value: unknown): SuperagentStage {
  const record = recordOf(value)
  if (record === null) return { stage: 'idle' }
  const stage = record['stage']
  if (stage === 'person') {
    const action = personActionOf(record['action'])
    return action === undefined ? { stage: 'person' } : { stage: 'person', action }
  }
  if (stage === 'working') return record['action'] === 'queued' ? { stage: 'working', action: 'queued' } : { stage: 'working' }
  if (stage === 'ended') return { stage: 'ended' }
  return { stage: 'idle' }
}

/** 一张工单：id 都读不到就不收（界面拿 id 做 key，也拿它调四个写方法）。 */
function ticketOf(value: unknown): SuperagentTicket | null {
  const record = recordOf(value)
  if (record === null) return null
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return null
  const branch = typeof record['branch'] === 'string' && record['branch'] !== '' ? record['branch'] : undefined
  const summary = typeof record['summary'] === 'string' && record['summary'] !== '' ? record['summary'] : undefined
  const rawFiles = record['changedFiles']
  const changedFiles = Array.isArray(rawFiles)
    ? rawFiles.filter((item): item is string => typeof item === 'string')
    : undefined
  return {
    id,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    stage: stageOf(record['stage']),
    at: typeof record['at'] === 'string' ? record['at'] : '',
    ...(branch === undefined ? {} : { branch }),
    ...(summary === undefined ? {} : { summary }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
  }
}

function ticketsOf(value: unknown): readonly SuperagentTicket[] {
  if (!Array.isArray(value)) return EMPTY_TICKETS
  const out: SuperagentTicket[] = []
  for (const item of value) {
    const ticket = ticketOf(item)
    if (ticket !== null) out.push(ticket)
  }
  return out.length === 0 ? EMPTY_TICKETS : out
}

function recentOf(value: unknown): readonly { at: string; text: string }[] {
  if (!Array.isArray(value)) return EMPTY_RECENT
  const out: { at: string; text: string }[] = []
  for (const item of value) {
    const record = recordOf(item)
    if (record === null) continue
    const text = typeof record['text'] === 'string' ? record['text'] : ''
    if (text === '') continue
    out.push({ at: typeof record['at'] === 'string' ? record['at'] : '', text })
  }
  return out.length === 0 ? EMPTY_RECENT : out
}

/**
 * 从快照里取 Super Agent 那一格。
 *
 * @param snapshot - `useHostSnapshot()` 的快照（可能还没来第一帧）
 * @returns 面板视图；`null` = 这一格整个缺席（宿主插件没开），界面按「未启动」画
 */
export function readSuperagent(snapshot: HostSnapshot | null): SuperagentView | null {
  const surfaces = recordOf(snapshot?.['surfaces'])
  const surface = surfaces === null ? null : recordOf(surfaces['superagent'])
  if (surface === null) return null

  const tickets = ticketsOf(surface['tickets'])
  const counted: SuperagentCounts = { needsYou: 0, running: 0, done: 0 }
  for (const ticket of tickets) {
    // 组名与计数键不同名：person → needsYou、working/idle → running、ended → done。
    const group = stageGroupOf(ticket.stage)
    if (group === 'person') counted.needsYou += 1
    else if (group === 'ended') counted.done += 1
    else counted.running += 1
  }
  const rawCounts = recordOf(surface['counts'])
  const counts: SuperagentCounts = {
    needsYou: countOf(rawCounts?.['needsYou'], counted.needsYou),
    running: countOf(rawCounts?.['running'], counted.running),
    done: countOf(rawCounts?.['done'], counted.done),
  }

  const rawProblem = recordOf(surface['problem'])
  const code = typeof rawProblem?.['code'] === 'string' ? rawProblem['code'] : ''
  const detail = typeof rawProblem?.['detail'] === 'string' ? rawProblem['detail'] : ''
  return {
    ready: surface['ready'] === true,
    problem: code === '' && detail === '' ? null : { code, detail },
    counts,
    tickets,
    recent: recentOf(surface['recent']),
  }
}

/** 阶段指纹：只比会变的那两位，别拿对象引用比（快照每帧换引用）。 */
function stageFingerprint(stage: SuperagentStage): string {
  return `${stage.stage}:${'action' in stage && stage.action !== undefined ? stage.action : ''}`
}

function sameTicket(left: SuperagentTicket, right: SuperagentTicket): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.at === right.at &&
    left.summary === right.summary &&
    left.branch === right.branch &&
    stageFingerprint(left.stage) === stageFingerprint(right.stage) &&
    (left.changedFiles?.join('|') ?? '') === (right.changedFiles?.join('|') ?? '')
  )
}

/**
 * 面板视图的相等判断：内容没变就不重渲染。
 *
 * 快照每帧都会换引用，不给比较函数的话这一页会跟着整棵快照逐帧重画。
 * @param left - 上一次的视图
 * @param right - 这一次的视图
 * @returns 是否等价
 */
export function sameSuperagent(left: SuperagentView | null, right: SuperagentView | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (left.ready !== right.ready) return false
  if ((left.problem?.code ?? '') !== (right.problem?.code ?? '')) return false
  if ((left.problem?.detail ?? '') !== (right.problem?.detail ?? '')) return false
  if (
    left.counts.needsYou !== right.counts.needsYou ||
    left.counts.running !== right.counts.running ||
    left.counts.done !== right.counts.done
  ) {
    return false
  }
  if (left.tickets.length !== right.tickets.length) return false
  for (let index = 0; index < left.tickets.length; index += 1) {
    const a = left.tickets[index]
    const b = right.tickets[index]
    if (a === undefined || b === undefined || !sameTicket(a, b)) return false
  }
  if (left.recent.length !== right.recent.length) return false
  for (let index = 0; index < left.recent.length; index += 1) {
    const a = left.recent[index]
    const b = right.recent[index]
    if (a === undefined || b === undefined || a.at !== b.at || a.text !== b.text) return false
  }
  return true
}

/**
 * 订阅整块面板视图。
 * @returns 面板视图；`null` = 宿主插件没开
 */
export function useSuperagent(): SuperagentView | null {
  return useHostSelector(readSuperagent, sameSuperagent)
}

/** 只读徽标要的那一个数（侧栏行不需要整块视图）。 */
function readNeedsYou(snapshot: HostSnapshot | null): number {
  return readSuperagent(snapshot)?.counts.needsYou ?? 0
}

/**
 * 订阅「需要你处理」的计数。
 *
 * 只取一个数字：计数没变时 `Object.is` 就拦住了重渲染，侧栏不会跟着整块快照重画。
 * @returns 待处理数；宿主插件没开时是 0（徽标据此不画）
 */
export function useNeedsYou(): number {
  return useHostSelector(readNeedsYou)
}

/** 页内四页。 */
export type SuperagentTab = 'overview' | 'publish' | 'tickets' | 'settings'

/** 当前页签：模块级，整页卸载后不跳回第一页。 */
const tabSignal = createSignal<SuperagentTab>('publish')

/** 读当前页签（订阅变化）。 */
export function useSuperagentTab(): SuperagentTab {
  return useSyncExternalStore(tabSignal.subscribe, tabSignal.get, () => 'publish')
}

/** 切页签。 */
export function setSuperagentTab(next: SuperagentTab): void {
  tabSignal.set(next)
}

/** 详情页选中的工单 id；`null` = 停在工单列表。 */
const selectedSignal = createSignal<string | null>(null)

/** 读选中的工单 id。 */
export function useSelectedTicket(): string | null {
  return useSyncExternalStore(selectedSignal.subscribe, selectedSignal.get, () => null)
}

/** 进一张工单的详情。 */
export function openTicket(id: string): void {
  selectedSignal.set(id)
}

/** 回工单列表。 */
export function closeTicket(): void {
  selectedSignal.set(null)
}

/** 刚发布的那张工单（列表里高亮一下）。 */
const highlightSignal = createSignal<string | null>(null)

/** 读要高亮的工单 id。 */
export function useHighlightedTicket(): string | null {
  return useSyncExternalStore(highlightSignal.subscribe, highlightSignal.get, () => null)
}

/** 设 / 清高亮（`null` = 清掉）。 */
export function setHighlightedTicket(id: string | null): void {
  highlightSignal.set(id)
}
