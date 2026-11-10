/**
 * 对话流的壳内公共件：三条 context（折叠偏好 / 流内动作 / 会话工作目录）、
 * toolview 子槽的名字与渲染形状、座位切分与行 key。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/shared
 */
import { createContext } from 'react'
import type { SlotRenderApi, TranscriptEntry } from '@dsc/ui'
import type { ToolMatch } from '@dsc/ui-primitives'
import { processFoldPolicy, type CollapseTiming, type FoldedReplies } from './round-fold'
import { splitRounds } from './rounds'
import type { StepGrouping } from './process-groups'
import type { RoundInfo } from './timing'

export interface FoldPrefs {
  policy: ReturnType<typeof processFoldPolicy>
  /**
   * 折叠时机（uiPrefs.collapseTiming）：跑完立刻收起，还是最后一轮摊到下一句话进来。
   * 界面侧只把它转成「最新一轮的默认展开态」（见 round-fold.tsx 的 turnDefaultOpen）。
   */
  collapseTiming: CollapseTiming
  /** 收起后显示哪些回复（uiPrefs.foldedReplies）：正文留在屏幕上，还是跟着过程一起藏。 */
  foldedReplies: FoldedReplies
  /** 定稿的思考行默认展开吗（uiPrefs.reasoningDefaultOpen）。 */
  reasoningOpen: boolean
  /** 工具卡默认展开吗（uiPrefs.toolDefaultOpen）。 */
  toolOpen: boolean
}
/** 出厂口径：跑完立刻收起、正文留在屏幕上（与契约里的默认值一致）。 */
export const FOLD_PREFS: FoldPrefs = {
  policy: processFoldPolicy('standard'),
  collapseTiming: 'completion',
  foldedReplies: 'final',
  reasoningOpen: false,
  toolOpen: false,
}
export const FoldPrefsContext = createContext<FoldPrefs>(FOLD_PREFS)

/**
 * 流内动作（TranscriptFlow 提供，深处的行消费）：编辑重发。
 *
 * 2026-11-03 起「编辑并重发」不再分叉新会话：它把这条消息及其之后的回答在当前会话里
 * 作废，再把改过的文字重新发出去（等于回到那一刻重来）。原会话就是你现在看的这条，
 * 所以不再有「原会话保留、另开一条」这回事——动作名也相应从 `editRefork` 改成
 * `editAndResend`，免得后来的人照着旧名以为还在分叉。
 */
export interface FlowActions {
  /**
   * 编辑一条用户消息并重发：**当前会话**里截断到这条之前再重发（见
   * `plugins/transcript/ui.tsx` 的 `editAndResend`）。
   */
  editAndResend(entry: Extract<TranscriptEntry, { kind: 'user' }>, text: string): void
  /** 回合跑动中置灰编辑（旧界面同款：跑动中不让编辑）。 */
  busy: boolean
}
export const NO_ACTIONS: FlowActions = { editAndResend: () => undefined, busy: false }
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

/** 会话区一行（节点级）：谁画这条条目。dsh 的 conversation.chat.node 的等价物。 */
export const TRANSCRIPT_NODE_SLOT = 'transcript.node'
/** 思考行的正文区：只换正文排版、不重写折叠交互。 */
export const TRANSCRIPT_REASONING_BODY_SLOT = 'transcript.reasoning.body'

/** 本插件开出来的三个子槽：行渲染时依次问的三条选举链。 */
export type TranscriptChildSlot =
  | typeof TOOLVIEW_SLOT
  | typeof TRANSCRIPT_NODE_SLOT
  | typeof TRANSCRIPT_REASONING_BODY_SLOT

/**
 * 三个子槽的渲染函数（类型从 SlotMap 推：名字、owner、返回都对齐契约）。
 *
 * 第三个参数是 chain **全体弃权**时的兜底：ChainOutlet 直接画它、不套 `.slot-entry`，
 * 所以内置行仍然直属于 `.entry-row`（`views.css` 的 `:has(> .entry-text)` 那类补差
 * 选择器照旧命中）。为什么不能只写 `renderSlot(...) ?? 兜底`：`renderSlot` 返回的是一个
 * outlet 元素、不是 null，只在调用点判空判不出「链上没人」——见 ui-slots 的 ChainOutlet。
 */
export type TranscriptRender = SlotRenderApi<TranscriptChildSlot>['renderSlot']
/** 兼容名：只要 toolview 那一份额度的地方继续用它。 */
export type ToolViewRender = TranscriptRender

/**
 * 把本插件开出来的子槽并进 `@dsc/ui` 的槽位契约表（D1）——插件就近声明自己认识的位置。
 *
 * owner 的形状就是渲染方（RowBody）在 `renderSlot` 调用点真正传的东西——toolview 是
 * `{ entry, storeKey }`，两个新槽是行本身 `{ entry, live, stable, … }`；matched 是当选
 * 选择器的返回值：toolview 交 `ToolMatch`（图标 + 动词），两个新槽只交 `true`（认领即可，
 * 数据都在 owner 里）。表一旦钉住，`select` 的参数、当选组件的 props、他人 `renderSlot`
 * 的实参在编译期互相校验。
 */
declare module '@dsc/ui' {
  interface SlotMap {
    [TOOLVIEW_SLOT]: {
      kind: 'chain'
      owner: { entry: ToolEntry; storeKey?: string }
      matched: ToolMatch
    }
    // 节点级：一条条目归谁画。`matched: true` 是刻意的——选择器只做「认不认领」的判断，
    // 不往组件里塞数据（组件要的东西都在 owner 里）；与 toolview 交 `ToolMatch` 不同。
    // 没人认领时内置 switch 照常画（兜底在 render.tsx 的 RowBody / ChainOutlet 的第三个参数）。
    [TRANSCRIPT_NODE_SLOT]: {
      kind: 'chain'
      owner: { entry: TranscriptEntry; live: boolean; stable: string; sessionId: string | null }
      matched: true
    }
    // 思考行的正文区：只换正文排版，行头 / 摘要 / 吸附栏 / 折叠态仍归内置 ThinkRow。
    // owner 里的 storeKey 与 ThinkRow 用的是同一个键，接管的正文因此也存得住展开态。
    [TRANSCRIPT_REASONING_BODY_SLOT]: {
      kind: 'chain'
      owner: { entry: Extract<TranscriptEntry, { kind: 'thinking' }>; live: boolean; storeKey: string }
      matched: true
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
  /**
   * 这一行的**稳定身份**（轮内「第几条同类型条目」）：React key 与展开态存档键都用它。
   *
   * 为什么不继续用 `entry.id`：直播条目的 id 是 `-(position + 1)`（`adapter/transcript.ts`
   * 的 liveEntries），position 是直播段数组下标——**段一增删就变**；定稿那一刻条目从直播表
   * 搬进正式表，id 又从负数换成正数（`pushThinking` 的 `this.seq++`）。
   *
   * 后果（2026-11-10 报障「点开正在跑的思考，新工具一来它就自己收起、下一段思考又自己展开」）：
   * 1. id 变 → React key 变 → 思考行整棵重挂，`useFoldState` 重新算初值；
   * 2. 新挂载的定稿条目查不到存档（键里是它从没见过的正 id），回落默认档 = 收起；
   * 3. 而下一段直播思考又拿到同一个 `-1`，查到了上一条留下的「展开」存档 → 自动展开。
   * 也就是说：**旧的收起、新的展开，是同一份存档被下一行借走了**。
   *
   * 参考实现（dsh）的推理行 key 是「消息内块索引」（AssistantMarkdown.tsx:99-109），
   * 块在流式里只在尾部追加、前面的索引不变，所以组件不重挂、展开态一直跟着实例走。
   * 这里用等价口径：同一轮里同类条目的出现序号——直播段追加不改变前面的序号，
   * 定稿时条目原位搬进正式表，序号照样不变。
   */
  stable: string
}

/** 一轮的座位。`round` 是序号（0 基），写进 `.entry-row` 的 `data-round`。 */
export interface Seat {
  round: number
  rows: Row[]
}

/**
 * 独立条目（不进过程区）：收起整轮不能把「等你点批准」「结束标记」也一起藏掉。
 *
 * 表本体住在 round-fold.tsx（折叠预算器自己要用它来算隐藏集合，两处各写一份会漂），
 * 这里只为渲染层保持原来的导入位置。
 */
export { TURN_INDEPENDENT } from './round-fold'

/** 空的分组结果（verbose 档共用一份，引用稳定，不给每帧新建空 Map）。 */
export const EMPTY_STEP_GROUPING: StepGrouping = { groups: [], headAt: new Map(), at: new Map() }

/**
 * 一行的 React key：**会话标识 + 行的稳定身份**（见 {@link Row.stable}）。
 *
 * 为什么刻意**不含 ts**（0.6.67 的抽搐就是这么来的）：直播尾的 `ts` 会在**每一口 delta**
 * 上被刷新（`src/adapter/transcript.ts:911` 的 `last.ts = ts`），拿它拼键等于每来一个字
 * 就把这一行重挂一次。重挂的后果有两个，正好是用户报的两条：
 *   - `@starting-style` 那段高度过渡每次重挂都从 0fr 重播一遍 → 思考块一抽一抽的；
 *   - 组件的 `useState` 初值重新算（跑动中的思考行算出来是「展开」）→ 点收起立刻被打回
 *     展开态，看上去「思考内容关不掉」。
 *
 * 为什么也不再用 `entry.id`（2026-11-10）：直播条目的 id 按段落下标发（负数），段一增删
 * 就变，定稿又换成正数——同一段思考在「流式中 → 定稿」之间会换两次身份，展开态于是被
 * 下一行借走（详见 {@link Row.stable} 的注释）。改成轮内序号之后，直播与定稿是同一个键。
 *
 * 为什么还要带会话标识：两条会话的条目序号都从 0 开始，只按序号拼，切会话时 React 会把
 * 上一条会话的实例借给这一条，用户点开的折叠态就串味了。
 */
export function keyOf(row: Row, sessionKey: string): string {
  return `${sessionKey}|${row.stable}`
}

/**
 * 把条目切成座位与轮（口径见 rounds.ts 的 `splitRounds`）：直播条目按序接在定稿之后，
 * 分轮规则与轮元信息共用同一份，于是 `rounds[i].round === infos[i].index` 恒成立——
 * 座位序号与 `RoundInfo` 下标**结构上不可能错开**（旧版这里只看 `kind === 'user'`，
 * 插话（steering）会多切一个座位，把 `rounds[seat.round]` 整体顶偏，就是右侧刻度条
 * 错位、多刻度的根因）。每行记下它在**全量条目**（定稿 + 直播）里的下标（折叠区间用）。
 *
 * 每行同时带一份 {@link Row.stable}：轮内「第几条同类型条目」。同一个轮里按顺序数，
 * 直播段追加只会在尾部多一条新的（前面的序号不动），定稿时条目原位搬进正式表——
 * 同一段思考在「流式中 → 定稿」之间的序号不变，展开态因此跨得过这一拍。
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
  /**
   * 一行在它那一轮里的稳定身份。
   *
   * 工具优先用 `callId`：同一次调用的 callId 从「准备中」到「跑完」一直是那一个，比序号
   * 更经得起直播期条目的进出（准备中的那条是从 `liveEntries()` 合成出来的，正式条目在
   * `tool/call` 到达时才落进 list，两者在轮内的位置可能差一格）。callId 缺席（老日志 /
   * 准备中）才退回序号。
   */
  const stableOf = (entry: TranscriptEntry, round: number | undefined, ordinal: number): string => {
    const where = round === undefined ? 'lead' : `r${String(round)}`
    if (entry.kind === 'tool' && entry.call.callId !== '') return `${where}:call:${entry.call.callId}`
    return `${where}:${entry.kind}:${String(ordinal)}`
  }
  /** 一条行（同类型序号由调用方按轮维护）。 */
  const rowOf = (at: number, round: number | undefined, ordinal: number): Row => {
    const entry = all[at] as TranscriptEntry
    return { entry, live: at >= entries.length, at, stable: stableOf(entry, round, ordinal) }
  }
  /** 一张「轮内类型 → 已出现条数」的计数表：每轮各一份，轮与轮之间不串号。 */
  const countersOf = (): Map<string, number> => new Map<string, number>()
  const nextOrdinal = (counters: Map<string, number>, entry: TranscriptEntry): number => {
    const seen = counters.get(entry.kind) ?? 0
    counters.set(entry.kind, seen + 1)
    return seen
  }
  // 前导行不在任何一轮里：同一类型按出现顺序编号，前缀 lead 与会话里的轮区分开。
  const leadCounters = countersOf()
  return {
    leading: split.leading.map((at) => rowOf(at, undefined, nextOrdinal(leadCounters, all[at] as TranscriptEntry))),
    rounds: split.seats.map((seat) => {
      const counters = countersOf()
      return { round: seat.round, rows: seat.indices.map((at) => rowOf(at, seat.round, nextOrdinal(counters, all[at] as TranscriptEntry))) }
    }),
    infos: split.rounds,
  }
}
