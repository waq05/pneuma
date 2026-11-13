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

/**
 * 一个来源的轮询状态（契约 `SuperagentSourceView` 的形状检查版）。
 *
 * 契约里没有 `label`：快照面是宿主侧，不夹带人类语言。名称由界面按 `id` 取词
 * （`overview.tsx` 的 `SOURCE_LABELS`），中英文界面各说各的；认不出的 id 原样显示，
 * 将来加来源不必让宿主猜界面语言。
 */
export interface SuperagentSource {
  /** 来源 id：`github` / `feishu`。 */
  id: string
  /** 设置里开着没有（关着的来源也列出来，界面画「未启用」）。 */
  enabled: boolean
  /**
   * 上次轮询的时刻（ISO 8601）；还一轮都没跑过就没有这一项。
   *
   * 适配器在每轮开始时记这一笔，失败的那轮也会更新，所以界面文案写「上次轮询」而不是
   * 「上次成功」——后者在有错误时会自相矛盾。
   */
  lastPollAt?: string
  /** 上次失败的原文；成功之后清掉。 */
  lastError?: string
}

/**
 * 一条等人拍板的推断候选（契约 `SuperagentCandidateView` 的形状检查版）。
 *
 * 只有画卡片要的几项：判定结果本身在宿主库里，界面不转手那份 JSON——点「接单」时
 * 只回传 id（与可选的标题覆盖）。
 */
export interface SuperagentCandidate {
  /** 候选 id（接单 / 忽略时回传它）。 */
  id: string
  /** 卡片标题。 */
  title: string
  /** 模型给的理由。 */
  reason: string
  /** 工单范围。 */
  scope: string
  /** 来源（`github` / `feishu` / `manual`）。 */
  source: string
  /** 判定时刻（ISO 8601）；认不出时是空串。 */
  at: string
}

/** 面板要的一份视图（契约 `SuperagentSurface` 的形状检查版）。 */
export interface SuperagentView {  ready: boolean
  problem: { code: string; detail: string } | null
  counts: SuperagentCounts
  tickets: readonly SuperagentTicket[]
  /** 最近动态，最旧在前（上限 20 由宿主截）。 */
  recent: readonly { at: string; text: string }[]
  /**
   * 外部来源的轮询状态（GitHub / 飞书各一条）。
   *
   * **可选**：旧快照没有这一格，`undefined` 时概览页整块不画。与空数组区分开——
   * 「宿主没给这一格」和「给了但一条来源都没有」不是一回事，后者才该画一个空区块。
   */
  sources?: readonly SuperagentSource[]
  /**
   * 等人拍板的推断候选，新的在前。
   *
   * **可选**：「推断候选先等我确认」关着时这一格缺席（判定即接单，没有待确认的东西）。
   * `undefined` 与空数组是两件事：前者整块不画，后者画一句「暂时没有待确认」。
   */
  candidates?: readonly SuperagentCandidate[]
}

/** 空清单常量：字段缺席时共用一份，相等判断与重渲染判据都靠它（照 `readGit` 的常量兜底）。 */
const EMPTY_TICKETS: readonly SuperagentTicket[] = Object.freeze([])
const EMPTY_RECENT: readonly { at: string; text: string }[] = Object.freeze([])
const EMPTY_SOURCES: readonly SuperagentSource[] = Object.freeze([])
const EMPTY_CANDIDATES: readonly SuperagentCandidate[] = Object.freeze([])

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
 * 一条来源：`id` 读不到就不收（界面拿它当 key，也拿它取词）。
 *
 * `enabled` 只认 `true`：宿主的设置读取已经保证是布尔，这里再判一次是防旧快照 /
 * 手改的 JSON——`"true"` 这种字符串不该被当成打开。
 */
function sourceOf(value: unknown): SuperagentSource | null {
  const record = recordOf(value)
  if (record === null) return null
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return null
  const lastPollAt = typeof record['lastPollAt'] === 'string' && record['lastPollAt'] !== '' ? record['lastPollAt'] : undefined
  const lastError = typeof record['lastError'] === 'string' && record['lastError'] !== '' ? record['lastError'] : undefined
  return {
    id,
    enabled: record['enabled'] === true,
    ...(lastPollAt === undefined ? {} : { lastPollAt }),
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/**
 * 来源清单。
 *
 * **整格缺席返回 `undefined`**（旧快照，概览页整块不画），有但一条也没解析出来返回空数组
 * （画一个空区块）——两种「空」在界面上是两件事，不要合并。
 */
function sourcesOf(value: unknown): readonly SuperagentSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: SuperagentSource[] = []
  for (const item of value) {
    const source = sourceOf(item)
    if (source !== null) out.push(source)
  }
  return out.length === 0 ? EMPTY_SOURCES : out
}

/**
 * 一条候选：`id` 读不到就不收（界面拿它当 key，也拿它调两个写方法）。
 *
 * 其余字段缺了给空串而不是丢掉整条：一条候选的标题可能没写，但人还是该看见
 * 「有这么一条、来自哪儿」，然后决定接不接。
 */
function candidateOf(value: unknown): SuperagentCandidate | null {
  const record = recordOf(value)
  if (record === null) return null
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return null
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '')
  return { id, title: text('title'), reason: text('reason'), scope: text('scope'), source: text('source'), at: text('at') }
}

/**
 * 候选清单。
 *
 * **整格缺席返回 `undefined`**（宿主没开「先等我确认」，概览页整块不画），有但一条也没
 * 解析出来返回空数组（画一句「暂时没有待确认」）——两种「空」在界面上是两件事。
 */
function candidatesOf(value: unknown): readonly SuperagentCandidate[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: SuperagentCandidate[] = []
  for (const item of value) {
    const candidate = candidateOf(item)
    if (candidate !== null) out.push(candidate)
  }
  return out.length === 0 ? EMPTY_CANDIDATES : out
}

/**
 * 从快照里取 Super Agent 那一格。 *
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
  const sources = sourcesOf(surface['sources'])
  const candidates = candidatesOf(surface['candidates'])
  return {
    ready: surface['ready'] === true,
    problem: code === '' && detail === '' ? null : { code, detail },
    counts,
    tickets,
    recent: recentOf(surface['recent']),
    // 只有读到了才带上这一项：`undefined` 是「旧快照没有这一格」，概览页据此整块不画。
    ...(sources === undefined ? {} : { sources }),
    ...(candidates === undefined ? {} : { candidates }),
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
 * 来源清单的指纹：一条 `id / enabled / lastPollAt / lastError` 拼起来。
 *
 * 用字符串比而不是逐项比：清单最长两行、字段还可能随契约增，拼串只有一处要改；
 * 也不会因为漏比某个字段而让界面停在旧的错误上——那正是 U5 要解决的「看不到」。
 * 缺席（`undefined`）与空数组给不同前缀：两者在界面上是两件事。
 */
function sourcesFingerprint(sources: readonly SuperagentSource[] | undefined): string {
  if (sources === undefined) return '\u0002absent'
  return sources
    .map((source) => `${source.id}\u0000${source.enabled ? '1' : '0'}\u0000${source.lastPollAt ?? ''}\u0000${source.lastError ?? ''}`)
    .join('\u0001')
}

/**
 * 候选清单的指纹：一条 `id / title / at` 拼起来。
 *
 * 只比这三项：`reason` 与 `scope` 是判定时定下的，同一条候选不会中途变；`id` 与 `at`
 * 变了就是换了候选。缺席与空数组给不同前缀（与来源清单同一条理由）。
 */
function candidatesFingerprint(candidates: readonly SuperagentCandidate[] | undefined): string {
  if (candidates === undefined) return '\u0002absent'
  return candidates.map((item) => `${item.id}\u0000${item.title}\u0000${item.at}`).join('\u0001')
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
  // 来源错误变了必须重画：工单一张没动时，这是页面上唯一会变的那一行。
  if (sourcesFingerprint(left.sources) !== sourcesFingerprint(right.sources)) return false
  // 候选进出一条，页面上多/少一行卡片，同样要重画。
  if (candidatesFingerprint(left.candidates) !== candidatesFingerprint(right.candidates)) return false
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
