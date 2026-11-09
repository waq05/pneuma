/**
 * 工具卡：一行头 + 展开后的参数/结果/快捷栏，外加子智能体卡（`.shell-subagent`）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 * 2026-11-09：工具卡的渲染体收进共享骨架 {@link ToolCardView}（`tool-card/factory`）。
 * 本文件只剩两条入口的**接线**——对话页的 Factory 当选者，以及拿不到槽上下文的
 * 队友运行记录——不再自画一份卡片骨架。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/tool-row
 */
import { useContext, type ReactNode } from 'react'
import { createT, formatTokens, oneLine, type SlotComponentProps, type SlotMatchedOf, type SlotOwnerOf, type TranscriptEntry } from '@dsc/ui'
import type { ToolMatch } from '@dsc/ui-primitives'
import { FoldPrefsContext, ShellCwdContext, TOOLVIEW_SLOT, type ToolEntry } from '../shared'
import { ChatStatus, IntendedBody, IntendedPreview, NoTrailing, TOOLCARD_FACTORY, ToolCardView, TraceJumpButton } from '../tool-card/factory'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 内置当选者：选举把 matched（图标 + 动词）算好交过来；渲染的是一个 **Factory occurrence**
 * （D2）——对话页给四个局部组件（intended 预览 / 中文耗时 / 「将做的改动」/ 「在轨迹中查看」），
 * 轨迹页渲染同一个定义、只换耗时口径。Factory 没注册时落到旧工具卡（fallback，保险丝）。
 */
export function BuiltinToolView(
  props: SlotComponentProps<SlotOwnerOf<typeof TOOLVIEW_SLOT>, never, SlotMatchedOf<typeof TOOLVIEW_SLOT>>,
): ReactNode {
  // 折叠偏好与会话工作目录从 context 拿（槽渲染不穿 props 链，见 ShellCwdContext 的注释）；
  // 以输入 props 交给 Factory，定义组件本身不认识对话页的 context。
  const prefs = useContext(FoldPrefsContext)
  const cwd = useContext(ShellCwdContext)
  return props.renderFactorySlot(
    TOOLCARD_FACTORY,
    {
      entry: props.entry,
      storeKey: props.storeKey,
      persistKey: props.storeKey,
      variant: 'chat',
      match: props.matched,
      foldPrefs: prefs,
      cwd,
    },
    {
      slots: {
        preview: IntendedPreview,
        statusDetail: ChatStatus,
        bodyExtra: IntendedBody,
        trailing: TraceJumpButton,
      },
      fallback: <ToolRow entry={props.entry} matched={props.matched} storeKey={props.storeKey} />,
    },
  )
}

/**
 * 拿不到槽上下文的工具卡（队友运行记录：`ui-team` 把组件当值渲染，没有 `renderSlot`）。
 *
 * 它渲染的就是对话页那张卡的**同一个视图**，只是局部组件这一层：
 *  - 摘要 / 状态 / 展开体沿用对话页那三件（`IntendedPreview` / `ChatStatus` / `IntendedBody`），
 *    同一个壳下看去就是同一张卡；
 *  - 尾部给**空**（{@link NoTrailing}）：队友条目的 `id` 属于另一份日志，按它
 *    `openTrace(entry.id)` 会跳到主会话里错的步骤，这一格不能沿用「在轨迹中查看」；
 *  - `footer` 不传：那是 Factory 的子槽内容，这条路没有槽上下文，缺省就是没有那一行。
 *
 * `storeKey` 原样交给视图（`subagent-flow` 给的是 `${sessionKey}:${at}`）：队友的条目 id
 * 都从 1 起，键里少会话那一半，两个队友的同号条目就会共用一份展开态。
 */
export function ToolRow({ entry, matched, storeKey }: { entry: ToolEntry; matched?: ToolMatch; storeKey?: string }): ReactNode {
  const prefs = useContext(FoldPrefsContext)
  const cwd = useContext(ShellCwdContext)
  return (
    <ToolCardView
      entry={entry}
      storeKey={storeKey}
      variant="chat"
      match={matched}
      foldPrefs={prefs}
      cwd={cwd}
      Preview={IntendedPreview}
      StatusDetail={ChatStatus}
      BodyExtra={IntendedBody}
      Trailing={NoTrailing}
    />
  )
}

/** 队友卡的状态词。 */
const SUB_STATE_TEXT: Readonly<Record<string, string>> = {
  working: t('transcript.sub.working'),
  idle: t('transcript.sub.idle'),
  stopped: t('transcript.sub.stopped'),
  failed: t('transcript.sub.failed'),
}

/** 队友卡：旧消息流里没有对应物，这一块是壳自己补的（属于已知的样式增量）。 */
export function SubagentRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'subagent' }> }): ReactNode {
  const sub = entry.sub
  return (
    <div className="shell-subagent" data-state={sub.state}>
      <div className="shell-subagent-head">
        <span className="shell-subagent-name">{sub.name}</span>
        <span className="shell-subagent-role">{sub.role}</span>
        {/* 一次性的在卡上也标出来：点开只能看记录、传不进话，别等点开才发现。 */}
        {sub.mode === 'one-shot' ? <span className="shell-subagent-mode">{t('transcript.sub.oneShot')}</span> : null}
        <span className="shell-subagent-state">{SUB_STATE_TEXT[sub.state] ?? sub.state}</span>
      </div>
      <p className="shell-subagent-task">{oneLine(sub.task, 160)}</p>
      <p className="shell-subagent-meta">
        {t('transcript.sub.meta', { rounds: sub.rounds, tools: sub.toolCalls })}
        {sub.tokens === undefined ? '' : ` · ${formatTokens(sub.tokens)} tok`}
        {sub.lastTool === undefined ? '' : t('transcript.sub.currentTool', { name: sub.lastTool.name })}
      </p>
      {sub.error === undefined ? null : <p className="shell-subagent-error">{sub.error}</p>}
    </div>
  )
}
