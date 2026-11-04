/**
 * 工具卡：一行头 + 展开后的参数/结果/快捷栏，外加子智能体卡（`.shell-subagent`）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/tool-row
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { DiffRows, IconChevronDown, IconChevronUp, openTrace, type SlotComponentProps, type SlotMatchedOf, type SlotOwnerOf, type TranscriptEntry } from '@dsc/ui'
import { TOOL_STATUS_TEXT, formatDuration, formatTokens, matchTool, oneLine, prettyJson, toolSummary, toolVerb, type ToolMatch } from '@dsc/ui-primitives'
import { useFoldState } from '../fold-hook'
import { BAR_MIN_CONTENT_H, expandedContentHeight } from './fold-body'
import { useIntendedDiff } from '../intended-diff'
import { FoldPrefsContext, ShellCwdContext, TOOLVIEW_SLOT, type ToolEntry } from '../shared'
import { ChatStatus, IntendedBody, IntendedPreview, OpenPathButton, TOOLCARD_FACTORY, TraceJumpButton, fileTargetOf } from '../tool-card/factory'

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
 * 工具卡：一行头（状态点 + 图标 + 动词 + 摘要 + 状态）+ 展开后的「将做的改动」/参数/结果
 * （桌面端 `ToolCard.tsx` 的同构移植；行头保留壳的动词风格）。
 *
 * 三件与旧界面一致、改的时候别破坏的事：
 * 1. **展开态存档**（`fold-state`）：会话切换会把条目整表重建，重挂时从存档键读回
 *    用户上次的展开选择——否则「展开两条卡、切走再切回」就全合上了。
 * 2. **「将做的改动」只在 running 期出**（write / edit，含审批等待）：从参数 + 盘上现值
 *    推演这次调用将产生的 diff；落地后轮尾的「文件已更改」卡接手，卡上再挂一份就是重复。
 * 3. **吸附快捷栏**：展开内容够长（>400px）才出现，滚动时吸在聊天区顶部，
 *    栏上是「状态 · 用时」与「收起」。
 */
export function ToolRow({ entry, matched, storeKey }: { entry: ToolEntry; matched?: ToolMatch; storeKey?: string }): ReactNode {
  const call = entry.call
  const prefs = useContext(FoldPrefsContext)
  const cwd = useContext(ShellCwdContext)
  // 默认档取设置里的「工具卡默认展开」，走 useFoldState：设置一改，没手动调过的卡立刻跟，
  // 用户自己点开/收起过的那一张有存档，保持原样。preparing 态的不可展开判定仍在下面。
  const [open, setOpenPersisted] = useFoldState(storeKey, prefs.toolOpen)
  const [barVisible, setBarVisible] = useState(false)
  // 参数还没到齐的这一次调用不可展开——展开也看不到东西，还会让「点一下」白点。
  const expandable = call.status !== 'preparing'
  const bodyOpen = open && expandable
  const running = call.status === 'running'
  const summary = toolSummary(call.name, call.argsText)
  const match = matched ?? matchTool(call.name)
  const Icon = match.Icon
  // 文件类工具这次调用指向的文件（摘要区的可点路径靠它；认不出就是 null）。
  const targetPath = fileTargetOf(call.name, call.argsText, cwd)
  // 「将做的改动」：write / edit 进行中时从参数 + 盘上现值推演（落地后自动消失）。
  const intended = useIntendedDiff(call, cwd)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)

  const toggle = (): void => {
    if (expandable) setOpenPersisted(!open)
  }

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || !bodyOpen) {
      setBarVisible(false)
      return undefined
    }
    const measure = (): void => {
      setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    }
    measure()
    // 换字号、换密度、结果后到都会改展开区高度，所以跟着重量，而不是只量一次。
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => {
      observer.disconnect()
    }
  }, [bodyOpen, call.argsText, call.resultText, call.status])

  /**
   * 吸附态要额外补一条与滚动容器顶部内距等高的底。
   *
   * 为什么：sticky 只把栏吸到滚动容器的内容盒顶端，`.chat` 顶部还有 12px 内距，
   * 那条缝里会露出半行刚滚过去的参数——看着像渲染坏了。判断「栏顶是否已经贴住滚动
   * 容器顶端」（阈值取自 .chat 真实的内距，不写死像素），贴住了才加 .stuck 补缝；
   * 没贴住就不加，否则这条底会盖在紧凑行的下半截文字上。
   */
  useEffect(() => {
    if (!bodyOpen || !barVisible) return undefined
    const bar = barRef.current
    const body = bodyRef.current
    if (bar === null || body === null) return undefined
    const chat = body.closest('.chat')
    if (!(chat instanceof HTMLElement)) return undefined
    const padTop = Number.parseFloat(getComputedStyle(chat).paddingTop)
    const threshold = (Number.isFinite(padTop) ? padTop : 12) + 1.5
    const sync = (): void => {
      const gap = bar.getBoundingClientRect().top - chat.getBoundingClientRect().top
      bar.classList.toggle('stuck', gap <= threshold)
    }
    sync()
    chat.addEventListener('scroll', sync, { passive: true })
    return () => {
      chat.removeEventListener('scroll', sync)
    }
  }, [bodyOpen, barVisible, call.argsText, call.resultText, call.status])

  // 用时口径：优先宿主上报的本次调用耗时（ToolCallView.durationMs），没有就不印。
  const duration = formatDuration(call.durationMs ?? null)
  const barStatus =
    running || duration === null ? (TOOL_STATUS_TEXT[call.status] ?? call.status) : `${TOOL_STATUS_TEXT[call.status] ?? call.status} · 用时 ${duration}`

  return (
    <div className={`entry tool-card status-${call.status}${bodyOpen ? ' open' : ''}`}>
      <div
        className="tool-head"
        role="button"
        tabIndex={expandable ? 0 : -1}
        {...(expandable ? { 'aria-expanded': bodyOpen } : {})}
        data-tip={expandable ? (bodyOpen ? '收起参数与结果' : '展开参数与结果') : '正在准备参数'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        {/* 行首一格：状态点 + 工具图标，宽度固定 --proc-gutter（与思考行、组头同一竖线，§15）。 */}
        <span className="tool-leading" aria-hidden="true">
          <span className="tool-dot" />
          <Icon size={14} className="tool-icon" />
        </span>
        <span className="verb">{toolVerb(match.base, call.status)}</span>
        {/* 认不出的工具保留原名：没有它就看不出这是哪家的工具（MCP 那些名字不直观）。
            分隔点照 dsh 的「工具调用 · <工具名>」。 */}
        {match.known || call.name === '' ? null : <span className="name">{`· ${call.name}`}</span>}
        <span className="preview">
          {intended !== null ? (
            <>
              <OpenPathButton absPath={intended.absPath} cwd={cwd} patch={intended.file ?? call.change ?? null} />
              {intended.file !== null && (
                <span className="changes-counts">
                  {intended.file.status === 'added' && <span className="diff-badge">新增</span>}
                  <span className="changes-added">{`+${String(intended.file.added)}`}</span>
                  <span className="changes-removed">{`-${String(intended.file.removed)}`}</span>
                </span>
              )}
              {intended.mismatch === 'missing' && <span className="tc-warn">old 不在当前文件里</span>}
              {intended.mismatch === 'ambiguous' && <span className="tc-warn">old 匹配多处</span>}
            </>
          ) : targetPath !== null ? (
            <OpenPathButton absPath={targetPath} cwd={cwd} patch={call.change ?? null} />
          ) : (
            summary
          )}
        </span>
        <span className="status">
          {call.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
          {/* 定稿不说「完成」：状态点已经绿了，再印一遍是噪声（codex 也只留圆点）。 */}
          {call.status === 'done' ? '' : (TOOL_STATUS_TEXT[call.status] ?? call.status)}
          {duration === null || call.status === 'done' ? '' : ` · 用时 ${duration}`}
        </span>
        {/* 「在轨迹中查看」（对照 dsh 工具行 hover 的药丸）：切到轨迹页并聚焦这一条。
            默认透明（不抢行内的注意力），悬停/键盘聚焦才浮出来。 */}
        <button
          type="button"
          className="tc-trace"
          data-trace-jump={String(entry.id)}
          data-tip="在轨迹页查看这条调用的时刻与耗时"
          aria-label="在轨迹中查看"
          onClick={(event) => {
            event.stopPropagation()
            openTrace(entry.id)
          }}
        >
          在轨迹中查看
        </button>
        {expandable ? <IconChevronDown size={11} className="tc-chevron" /> : null}
      </div>
      {bodyOpen ? (
        <div className="tool-body" ref={bodyRef}>
          {barVisible ? (
            <div className="tc-bar" data-tc-chrome="1" ref={barRef}>
              <span className="tc-bar-status">{barStatus}</span>
              {/* 还在跑的时候不给「收起」：这一刻收起只会让人以为任务被取消了。 */}
              {running ? null : (
                <button
                  type="button"
                  className="tc-collapse"
                  title="收起这张工具卡"
                  onClick={() => {
                    setOpenPersisted(false)
                  }}
                >
                  收起
                  <IconChevronUp size={11} />
                </button>
              )}
            </div>
          ) : null}
          {intended !== null ? (
            <div className="tc-intended">
              <div className="tc-intended-head">
                <span className="tc-intended-title">将做的改动</span>
                {intended.fellBack && <span className="tc-warn">读不到文件当前内容，以下按参数推算</span>}
                {intended.mismatch === 'missing' && <span className="tc-warn">old 在文件中不存在，执行会失败</span>}
                {intended.mismatch === 'ambiguous' && <span className="tc-warn">old 匹配多处，执行会失败</span>}
              </div>
              {intended.file === null ? (
                <p className="tc-intended-note">两段内容一致，不会有实际改动。</p>
              ) : (
                <div className="tc-intended-diff">
                  <DiffRows hunks={intended.file.hunks} path={intended.absPath} />
                </div>
              )}
            </div>
          ) : null}
          <div className="label">参数</div>
          <div className="args">{prettyJson(call.argsText)}</div>
          {call.resultText === undefined || call.resultText === '' ? null : (
            <>
              <div className="label">结果</div>
              <div className="result">{call.resultText}</div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 队友卡的状态词。 */
const SUB_STATE_TEXT: Readonly<Record<string, string>> = {
  working: '干活中',
  idle: '已收工',
  stopped: '被打断',
  failed: '过程失败',
}

/** 队友卡：旧消息流里没有对应物，这一块是壳自己补的（属于已知的样式增量）。 */
export function SubagentRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'subagent' }> }): ReactNode {
  const sub = entry.sub
  return (
    <div className="shell-subagent" data-state={sub.state}>
      <div className="shell-subagent-head">
        <span className="shell-subagent-name">{sub.name}</span>
        <span className="shell-subagent-role">{sub.role}</span>
        <span className="shell-subagent-state">{SUB_STATE_TEXT[sub.state] ?? sub.state}</span>
      </div>
      <p className="shell-subagent-task">{oneLine(sub.task, 160)}</p>
      <p className="shell-subagent-meta">
        {sub.rounds} 轮 · {sub.toolCalls} 次工具
        {sub.tokens === undefined ? '' : ` · ${formatTokens(sub.tokens)} tok`}
        {sub.lastTool === undefined ? '' : ` · 当前 ${sub.lastTool.name}`}
      </p>
      {sub.error === undefined ? null : <p className="shell-subagent-error">{sub.error}</p>}
    </div>
  )
}

