/**
 * 唤醒通知那一行：一张能点开的小卡（对照 dsh 的 TurnTriggerNodeView）。
 *
 * 为什么不再是一行灰字：机器投递进来的消息（后台作业完工、队友汇报、目标续跑）是
 * **「模型为什么又动起来了」的凭据**，不是用户说的话。0.6.x 起它被画成一条带竖线的灰行
 * （`.entry-system[data-internal]`），只说得出一句话、没有时间、也点不开看原文。
 * dsh 的做法是把它画成一张独立的可展开卡片：头行是按钮（图标 + 一句标题 + 时间 + 箭头），
 * 展开后先一句解释「这条通知触发了本轮回复。」，再摊模型看到的原文。
 *
 * 三处口径照 dsh 落地（`TurnTriggerNodeView` + `TurnTriggerNodeView.module.css`）：
 * - **默认收起**：一轮里可能连着几条通知，全摊开就把过程区撑满；标题已经说得清"发生了什么"，
 *   原文（含命令、退出码、报告正文）点开再看。
 * - **头行整条可点**，箭头在右、展开时转 180°：与组头、工具卡、整轮开关同一套折叠语言。
 * - **原文用 `pre` 原样排**（`white-space: pre-wrap`，限高 240px 可滚）：它是给模型看的正文，
 *   按 markdown 渲染会改写换行与缩进，读者核对"模型到底收到了什么"时就对不上了。
 *
 * 图标按来源分档（作业 / 队友 / 目标 / 其余）：dsh 的 `turnTriggerDetails` 也是这么分的，
 * 一眼认出「是谁把模型叫醒的」。标题直接沿用 `internalLabel` 那句人话——
 * dsh 的标题是类别（「后台任务状态更新」），我们这句更具体（「后台作业 job-1 完成了」），
 * 信息量只多不少，就没必要再套一层类别词。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/trigger-row
 */
import { useId, useState, type JSX, type ReactNode } from 'react'
import {
  IconChevronDown, IconClock, IconInfo, IconQueue, IconSpark, IconTree, createT,
  type TranscriptEntry,
} from '@dsc/ui'
import { formatClock } from '../timing'
import { internalLabel } from '../rounds'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 队友汇报正文的固定开头（与宿主 `src/core/team-board.ts` 的 `TEAMMATE_REPORT_OPEN` 同字面量）。 */
const TEAMMATE_REPORT_OPEN = '<teammate-report '

/** 唤醒来源的四档（只用来挑图标；标题走 `internalLabel`）。 */
export type TriggerKind = 'job' | 'teammate' | 'goal' | 'other'

/**
 * 认这条通知是谁投递的。
 *
 * 认法只能靠正文：界面拿到的条目只有 `internal` 这一个标记，宿主投递时没写来源字段
 * （与 `rounds.ts` 的 `internalLabel` 同一套判据、同一份理由）。认不出就归 `other`，
 * 标题仍然说得清一句话，不会因为认不出来而少一块。
 *
 * @param text 通知正文（模型看到的那一份）
 */
export function triggerKind(text: string): TriggerKind {
  if (text.startsWith('后台作业 ')) return 'job' // i18n-keep：宿主 core/tools/bash.ts 拼的原文
  if (text.startsWith(TEAMMATE_REPORT_OPEN)) return 'teammate'
  if (text.startsWith('（目标自动续跑：')) return 'goal' // i18n-keep：宿主 goal 插件的投递开头
  return 'other'
}

/** 来源 → 图标（对照 dsh 的 TRIGGER_ICONS：作业用队列、队友用智能体、目标用火花）。 */
const KIND_ICON: Record<TriggerKind, ReactNode> = {
  job: <IconQueue size={14} />,
  teammate: <IconTree size={14} />,
  goal: <IconSpark size={14} />,
  other: <IconInfo size={14} />,
}

/**
 * 一条机器投递的唤醒通知。
 *
 * @param props.entry 用户消息条目（`internal === true` 的那一类）
 * @returns 一张可展开的小卡
 */
export function TriggerRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const kind = triggerKind(entry.text)
  const clock = formatClock(entry.ts ?? null)
  const label = internalLabel(entry.text)
  return (
    <section className="trigger-card" data-internal="1" data-trigger={kind}>
      <button
        type="button"
        className="trigger-head"
        // 展开态走 data-open（与 .step-fold / .turn-fold 同一套写法），样式里靠它转箭头
        data-open={open ? '1' : undefined}
        aria-expanded={open}
        aria-controls={bodyId}
        data-tip={open ? t('transcript.trigger.collapseTip') : t('transcript.trigger.expandTip')}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="trigger-icon" aria-hidden="true">
          {KIND_ICON[kind]}
        </span>
        <span className="trigger-title">{label}</span>
        {clock === null ? null : (
          <time className="trigger-time" dateTime={new Date(entry.ts ?? 0).toISOString()}>
            {clock}
          </time>
        )}
        <span className="trigger-chevron" aria-hidden="true">
          <IconChevronDown size={12} />
        </span>
      </button>
      {open ? (
        <div className="trigger-body" id={bodyId}>
          {/* 这一句是 dsh 的 message.trigger.explanation：读者要知道"这条通知不是我说的话"。 */}
          <p className="trigger-note">{t('transcript.trigger.explanation')}</p>
          <pre className="trigger-text">{entry.text}</pre>
        </div>
      ) : null}
    </section>
  )
}
