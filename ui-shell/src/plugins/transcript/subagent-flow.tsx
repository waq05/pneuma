/**
 * 只读「子智能体条目流」：右栏页签拿到的组件，用主会话同一套行渲染铺条目。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/subagent-flow
 */
import { useMemo, type ReactNode } from 'react'
import type { TranscriptEntry } from '@dsc/ui'
import { NO_ENTRIES } from '@dsc/ui-primitives'
import { FOLD_PREFS, FoldPrefsContext, FlowActionsContext, NO_ACTIONS, ShellCwdContext, ShellSessionContext, type Row, type ToolViewRender } from './shared'
import { RowBody, RowBoundary } from './render'
import { ToolRow } from './rows/tool-row'
import { ReadonlyUserRow } from './rows/user-row'

// ── 只读「子智能体条目流」（右栏页签用）────────────────────────────────────────
/**
 * 槽位名：只读条目流的落点（团队右栏页签经 `transcriptFlow` 服务拿到的组件）。
 *
 * 团队插件是把**组件当值**直接渲染的（没有槽渲染上下文），所以这条登记在运行时由壳渲染
 * 只是「将来宿主愿意的话」的出口；声明它的意义在于让那条条目具备 toolview 选举链——
 * 见 apply 里的注册与 {@link SubagentFlow} 的 `renderSlot` 说明。
 */
export const SUBAGENT_FLOW_SLOT = 'shell.subagent.flow'

/** 只读条目流的输入（团队页签把 `peekTranscript` 回的条目原样喂进来）。 */
export interface TranscriptFlowProps {
  entries: readonly TranscriptEntry[]
  /** 会话工作目录：相对路径展示与「将做的改动」推演的基准；拿不到给空串。 */
  cwd?: string
  /**
   * 折叠存档键的会话那一半（思考/工具卡的展开态）：拿不到时给队友会话文件路径，
   * 免得不同队友的条目 id（都从 1 起）撞在同一把键上。
   */
  sessionKey?: string
}

/** `transcriptFlow` 服务的形状：组件本身 + 它的槽位名（槽名给诊断与将来的宿主渲染用）。 */
export interface TranscriptFlowService {
  Component: (props: TranscriptFlowProps) => ReactNode
  slot: string
}

/**
 * 只读条目流：把一份 `TranscriptEntry[]` 用**主会话同一套行渲染**铺出来
 * （markdown 正文 / 思考折叠 / 工具卡 / 子代理卡 / 计划卡 / system 行）。
 *
 * 与主会话 {@link TranscriptFlow} 的差别只有三处，都是「只读」这件事本身要求的：
 *  - 动作 context 给 {@link NO_ACTIONS}（没有「编辑重发」这条出口）；
 *  - 用户消息走 {@link ReadonlyUserRow}（气泡照画，不画 hover 浮出的编辑钮）；
 *  - 不画轮尾 / 改动卡 / 刻度条 / 分页 / 整轮折叠——右栏是伴读面，不是操作面。
 *
 * 工具行走 `renderSlot(TOOLVIEW_SLOT, …)`：本条目在 SlotMap 里声明了这条 chain 子槽，
 * 被壳当槽条目渲染时由选举链决定谁画。团队插件是直接把组件当值渲染（没有槽渲染上下文），
 * 那时 `renderSlot` 缺席，落到内置工具卡 {@link ToolRow}——与 `RowBody` 自己的兜底
 * （`renderSlot?.(…) ?? <ToolRow …/>`）是同一条路，工具卡照常出得来。
 */
export function SubagentFlow(props: {
  entries?: readonly TranscriptEntry[]
  cwd?: string
  sessionKey?: string
  /** 槽渲染上下文（壳把本条目当槽条目渲染时才有）；缺席时用内置工具卡兜底。 */
  renderSlot?: ToolViewRender
  childSlots?: readonly string[]
}): ReactNode {
  const entries = props.entries ?? NO_ENTRIES
  const cwd = props.cwd ?? ''
  const toolRender: ToolViewRender =
    props.renderSlot ?? ((_name, owner) => <ToolRow entry={owner.entry} storeKey={owner.storeKey} />)
  const rows = useMemo<Row[]>(() => entries.map((entry, at) => ({ entry, live: false, at })), [entries])
  return (
    <ShellSessionContext.Provider value={props.sessionKey ?? null}>
    <ShellCwdContext.Provider value={cwd}>
    <FoldPrefsContext.Provider value={FOLD_PREFS}>
    <FlowActionsContext.Provider value={NO_ACTIONS}>
      <div className="chat-inner subagent-flow">
        {rows.map((row) => (
          <div className="entry-row" key={`sub|${row.entry.kind}|${String(row.entry.id)}`}>
            <RowBoundary entry={row.entry}>
              {row.entry.kind === 'user' ? <ReadonlyUserRow entry={row.entry} /> : <RowBody row={row} renderSlot={toolRender} />}
            </RowBoundary>
          </div>
        ))}
      </div>
    </FlowActionsContext.Provider>
    </FoldPrefsContext.Provider>
    </ShellCwdContext.Provider>
    </ShellSessionContext.Provider>
  )
}
