/**
 * 对话流的壳内公共件：三条 context（折叠偏好 / 流内动作 / 会话工作目录）、
 * toolview 子槽的名字与渲染形状、座位切分与行 key。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/shared
 */
import { createContext, type ReactNode } from 'react'
import type { TranscriptEntry } from '@dsc/ui'
import type { ToolMatch } from '@dsc/ui-primitives'
import { processFoldPolicy } from './round-fold'
import { splitRounds } from './rounds'
import type { StepGrouping } from './process-groups'
import type { RoundInfo } from './timing'

export interface FoldPrefs {
  policy: ReturnType<typeof processFoldPolicy>
  /** 定稿的思考行默认展开吗（uiPrefs.reasoningDefaultOpen）。 */
  reasoningOpen: boolean
  /** 工具卡默认展开吗（uiPrefs.toolDefaultOpen）。 */
  toolOpen: boolean
}
export const FOLD_PREFS: FoldPrefs = { policy: processFoldPolicy('standard'), reasoningOpen: false, toolOpen: false }
export const FoldPrefsContext = createContext<FoldPrefs>(FOLD_PREFS)

/** 流内动作（TranscriptFlow 提供，深处的行消费）：编辑重发。 */
export interface FlowActions {
  /** 编辑一条用户消息并重发：分叉新会话（第 1 条前无内容则开全新会话），原会话保留。 */
  editRefork(entry: Extract<TranscriptEntry, { kind: 'user' }>, text: string): void
  /** 回合跑动中置灰编辑（旧界面同款：跑动中不让编辑）。 */
  busy: boolean
}
export const NO_ACTIONS: FlowActions = { editRefork: () => undefined, busy: false }
export const FlowActionsContext = createContext<FlowActions>(NO_ACTIONS)

/**
 * 会话工作目录（相对路径展示与「将做的改动」推演的基准）。
 *
 * 为什么要 context 而不是 props：工具行可能经 toolview 链交给别的插件渲染，
 * 槽渲染不穿 props 链，但仍在同一棵 React 树里——context 是那条「不打扰插件
 * 作者、又能让深处的行拿到壳数据」的路。
 */
export const ShellCwdContext = createContext('')

/** 当前会话 uuid 的传递面（工具卡的展开态存档键、评价键都用它做前缀）。 */
export const ShellSessionContext = createContext<string | null>(null)

/** 空的条目表：没拿到快照时共用一份，省得每帧新建数组。 */
/** 工具条目（ToolRow 与 toolview 选举的 owner 形状；工具卡的 Factory 输入也用它）。 */
export type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** 工具调用视图的 chain 槽：每一条工具调用由选举出的渲染者负责（见下）。 */
export const TOOLVIEW_SLOT = 'transcript.toolview'

/**
 * 内部几层之间传的 renderSlot 形状（= toolview 槽的 owner 份额）。
 * 公开契约在 {@link SlotMap} 的声明里，这里只是把它拧成一个具名函数类型，免得每层重抄。
 */
export type ToolViewRender = (name: typeof TOOLVIEW_SLOT, props: { entry: ToolEntry; storeKey?: string }) => ReactNode

/**
 * 把本插件开出来的子槽并进 `@dsc/ui` 的槽位契约表（D1）——插件就近声明自己认识的位置。
 *
 * owner 的形状就是渲染方（RowBody）在 `renderSlot` 调用点真正传的东西：`{ entry, storeKey }`；
 * matched 是内置选择器的返回值（`matchTool` 的命中结果）。表一旦钉住，`select` 的参数、
 * 当选组件的 props、他人 `renderSlot` 的实参在编译期互相校验。
 */
declare module '@dsc/ui' {
  interface SlotMap {
    [TOOLVIEW_SLOT]: {
      kind: 'chain'
      owner: { entry: ToolEntry; storeKey?: string }
      matched: ToolMatch
    }
    // 只读「子智能体条目流」的落点：团队插件把队友会话条目交给它渲染（与主会话同一套行）。
    // 组件经 `ui.provide('transcriptFlow', …)` 交出去，团队页签直接渲染它；这一条声明是为了
    // 让那条条目具备 toolview 选举链（工具卡不只是内置兜底）。
    'shell.subagent.flow': { kind: 'list' }
  }
}

/**
 * 内置渲染器在链里的位置：priority 大（后问）——任何想接管某种工具的插件注册一个
 * 更小的 priority、选择器认领自己的工具就赢；内置选择器全认领（catch-all），
 * 所以链空着的时候工具卡照常画，链上有人接就归别人。
 */

/** 座位里的一行：条目 + 它是不是「正在直播的那一条」（直播行多一个光标与展开态）+ 全量下标（折叠区间判据）。 */
export interface Row {
  entry: TranscriptEntry
  live: boolean
  /** 这一条在全量条目序列里的下标（定稿在前、直播尾按序接在后面）；buildSeats 填。 */
  at: number
}

/** 一轮的座位。`round` 是序号（0 基），写进 `.entry-row` 的 `data-round`。 */
export interface Seat {
  round: number
  rows: Row[]
}

/** 独立条目（不进过程区）：收起整轮不能把「等你点批准」「结束标记」也一起藏掉。 */
export const TURN_INDEPENDENT: ReadonlySet<string> = new Set(['user', 'plan', 'system', 'turn-end', 'turn-max-tokens'])

/** 空的分组结果（verbose 档共用一份，引用稳定，不给每帧新建空 Map）。 */
export const EMPTY_STEP_GROUPING: StepGrouping = { groups: [], headAt: new Map(), at: new Map() }

/**
 * 一行的 React key：**会话标识 + 条目 id**。
 *
 * 为什么刻意**不含 ts**（0.6.67 的抽搐就是这么来的）：直播尾的 `ts` 会在**每一口 delta**
 * 上被刷新（`src/adapter/transcript.ts:600` 的 `last.ts = ts`），拿它拼键等于每来一个字
 * 就把这一行重挂一次。重挂的后果有两个，正好是用户报的两条：
 *   - `@starting-style` 那段高度过渡每次重挂都从 0fr 重播一遍 → 思考块一抽一抽的；
 *   - 组件的 `useState` 初值重新算（跑动中的思考行算出来是「展开」）→ 点收起立刻被打回
 *     展开态，看上去「思考内容关不掉」。
 *
 * 为什么还要带会话标识：`id` 只在**一段内容里**稳定（定稿合进同一条时 id 不变），两条会话
 * 的条目 id 都从 1 开始——只按 id 拼，切会话时 React 会把上一条会话的实例借给这一条，
 * 用户点开的折叠态就串味了。
 */
export function keyOf(row: Row, sessionKey: string): string {
  return `${sessionKey}|${String(row.entry.id)}`
}

/**
 * 把条目切成座位与轮（口径见 rounds.ts 的 `splitRounds`）：直播条目按序接在定稿之后，
 * 分轮规则与轮元信息共用同一份，于是 `rounds[i].round === infos[i].index` 恒成立——
 * 座位序号与 `RoundInfo` 下标**结构上不可能错开**（旧版这里只看 `kind === 'user'`，
 * 插话（steering）会多切一个座位，把 `rounds[seat.round]` 整体顶偏，就是右侧刻度条
 * 错位、多刻度的根因）。每行记下它在**全量条目**（定稿 + 直播）里的下标（折叠区间用）。
 *
 * @returns leading 前导行；rounds 座位；infos 对应的轮元信息（TranscriptFlow 直接拿去用，
 *   不再单独调一次 `roundInfos`——那正是「两处分轮互相打架」的来源）。
 */
export function buildSeats(
  entries: readonly TranscriptEntry[],
  live: readonly TranscriptEntry[],
): { leading: Row[]; rounds: Seat[]; infos: RoundInfo[] } {
  const all: readonly TranscriptEntry[] = [...entries, ...live]
  const split = splitRounds(all)
  const rowOf = (at: number): Row => ({ entry: all[at], live: at >= entries.length, at })
  return {
    leading: split.leading.map(rowOf),
    rounds: split.seats.map((seat) => ({ round: seat.round, rows: seat.indices.map(rowOf) })),
    infos: split.rounds,
  }
}
