/**
 * 工具卡的 Component Factory（D2）：一份装配定义，两个无关的父位置各自渲染。
 *
 * 为什么值得抽：对话页（transcript）与轨迹页（trace）此前各有一份工具卡骨架
 * （`ToolRow` / `TraceToolRow`），head/body 的 class 名与结构完全一样，改一处要改两处。
 * 抽成 Factory 之后：
 *   - **共享部分**（判定可展开、head 容器与交互、状态点/图标/动词、chevron、参数与结果、
 *     吸附快捷栏）留在本文件；
 *   - **按位置不同的部分**做成**局部槽**，父按 occurrence 选（对话页选 intended 预览 /
 *     中文耗时 / 「将做的改动」/ 「在轨迹中查看」按钮；轨迹页只选轨迹口径的耗时）；
 *   - 没选的位置由定义自己的 fallback 顶上（SummaryPreview / NoBodyExtra / NoTrailing）。
 *
 * `children` 仍是**普通槽**（`transcript.toolcard.footer`）：任何插件都能往里加一行，
 * 与工具卡是谁渲染的无关（`examples/ui-plugin-demo` 就是这么用的）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DiffRows,
  IconChevronDown,
  IconChevronUp,
  openTrace,
  type FactoryComponentProps,
  type FactoryLocalProps,
  type ToolCallView,
  type UiPluginApi,
} from '@dsc/ui'
import { displayPathOf } from '../../../platform/paths'
import { formatDuration } from '../../../platform/time'
import { matchTool, prettyJson, TOOL_STATUS_TEXT, toolSummary, toolVerb, type ToolMatch } from '../../../platform/tool-summary'
import { readFold, writeFold } from '../fold-state'
import { useIntendedDiff, type IntendedDiff } from '../intended-diff'
/**
 * 类型只从 ui.tsx 借（`import type` 编译期擦掉，不形成运行期循环：ui.tsx 会 import 本文件）。
 */
import type { FoldPrefs, ToolEntry } from '../ui'

/** Factory 名与它开的子槽名（父位置写它们当常量，不手打字符串）。 */
export const TOOLCARD_FACTORY = 'transcript.tool-card'
export const TOOLCARD_FOOTER_SLOT = 'transcript.toolcard.footer'

/**
 * 契约表声明（D1 手法）：Factory 的输入 props、四个局部位置的输入 props、
 * children 槽（普通槽，进 SlotMap）。父位置与定义里两边的类型都从这张表推。
 */
declare module '@dsc/ui' {
  interface SlotMap {
    /** 工具卡尾巴的扩展行（Factory 的 children；仍是普通槽，任何插件可注册）。 */
    [TOOLCARD_FOOTER_SLOT]: { kind: 'list' }
  }
  interface SlotFactoryMap {
    [TOOLCARD_FACTORY]: {
      props: {
        /** 这一条工具调用（对话页与轨迹页的条目形状同源）。 */
        entry: ToolEntry
        /** 展开态存档键（对话页给，轨迹页不给：那边展开态是临时的）。 */
        storeKey?: string
        /** 展开态持久化的键（缺省不持久化）。 */
        persistKey?: string
        /** 哪个父在渲染（缺省 chat）：轨迹页不挂吸附快捷栏、不推演 intended。 */
        variant?: 'chat' | 'trace'
        /** chain 选举算好的匹配（不传就自己 matchTool）。 */
        match?: ToolMatch
        /** 对话页的折叠偏好（轨迹页不传：那边的展开态是临时 useState 语义）。 */
        foldPrefs?: FoldPrefs
        /** 会话工作目录（intended 推演与相对路径展示的基准）。 */
        cwd?: string
      }
      slots: {
        /** 头行摘要区：对话页给「将做的改动」预览，轨迹页沿用 summary。 */
        preview: { props: { intended: IntendedDiff | null; summary: string; cwd: string } }
        /** 状态列：父决定耗时口径（中文口径 / 轨迹的 4.2s 口径）。 */
        statusDetail: { props: { call: ToolCallView } }
        /** 展开体里的额外块：对话页给「将做的改动」diff。 */
        bodyExtra: { props: { intended: IntendedDiff | null } }
        /** 头行尾部：对话页给「在轨迹中查看」。 */
        trailing: { props: { entry: ToolEntry } }
      }
      children: { [TOOLCARD_FOOTER_SLOT]: 'list' }
    }
  }
}

/** 「展开内容超过这个高度才给吸附快捷栏」——小卡不背这条累赘（旧界面同款阈值）。 */
const BAR_MIN_CONTENT_H = 400

/**
 * 展开区有多长：把每个子块的自然高度加起来。
 *
 * 为什么读 scrollHeight 而不是 offsetHeight：参数与结果两块各被 max-height 夹在
 * --dsc-tool-detail-max-h 里，读 offsetHeight 会把任意长的内容都看成 180px。
 */
function expandedContentHeight(body: HTMLElement): number {
  let total = 0
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue
    // 快捷栏自己不算内容（算进去会自我维持：390 + 26 > 400 → 一直显示）。
    if (child.dataset.tcChrome !== undefined) continue
    total += Math.max(child.scrollHeight, child.offsetHeight)
  }
  return total
}

/** 在 apply 里登记定义（ui.tsx 调；disposer 由装载账本持有）。 */
export function registerToolCard(ui: UiPluginApi): void {
  ui.slots.registerFactory(
    {
      name: TOOLCARD_FACTORY,
      children: { [TOOLCARD_FOOTER_SLOT]: 'list' },
      slots: { preview: {}, statusDetail: {}, bodyExtra: {}, trailing: {} },
    },
    ToolCard,
  )
}

/**
 * 工具卡定义：一行头（状态点 + 图标 + 动词 + 摘要 + 状态）+ 展开后的额外块 / 参数 / 结果。
 *
 * 三件与旧实现一致、改的时候别破坏的事（都从 ToolRow 原样搬来）：
 * 1. **展开态存档**（`fold-state`）：会话切换会把条目整表重建，重挂时从存档键读回；
 * 2. **「将做的改动」只在 running 期出**（write / edit，含审批等待）：落地后轮尾的
 *    「文件已更改」卡接手，卡上再挂一份就是重复；
 * 3. **吸附快捷栏**：展开内容够长（>400px）才出现，只挂在对话页（variant === 'chat'）。
 */
function ToolCard(props: FactoryComponentProps<typeof TOOLCARD_FACTORY>): ReactNode {
  const { entry, storeKey, persistKey, match: electedMatch, foldPrefs, cwd = '' } = props
  const variant = props.variant ?? 'chat'
  const call = entry.call
  const [open, setOpen] = useState(() => readFold(persistKey, foldPrefs?.toolOpen ?? false))
  const [barVisible, setBarVisible] = useState(false)
  // 参数还没到齐的这一次调用不可展开——展开也看不到东西，还会让「点一下」白点。
  const expandable = call.status !== 'preparing'
  const bodyOpen = open && expandable
  const running = call.status === 'running'
  const summary = toolSummary(call.name, call.argsText)
  const match = electedMatch ?? matchTool(call.name)
  const Icon = match.Icon
  // 「将做的改动」：write / edit 进行中时从参数 + 盘上现值推演（轨迹页不做，见 hook 文档）。
  const intended = useIntendedDiff(call, cwd, variant === 'chat')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  // 局部位置（按 occurrence）：父没选就用定义自己的 fallback。
  const Preview = props.useFactorySlot('preview', SummaryPreview)
  const StatusDetail = props.useFactorySlot('statusDetail', ChatStatus)
  const BodyExtra = props.useFactorySlot('bodyExtra', NoBodyExtra)
  const Trailing = props.useFactorySlot('trailing', NoTrailing)

  /** 展开态一变就写回存档（不持久化的调用点 writeFold 自己空操作）。 */
  const setOpenPersisted = (next: boolean): void => {
    writeFold(persistKey, next)
    setOpen(next)
  }
  const toggle = (): void => {
    if (expandable) setOpenPersisted(!open)
  }

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || !bodyOpen || variant !== 'chat') {
      setBarVisible(false)
      return undefined
    }
    const measure = (): void => {
      setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => {
      observer.disconnect()
    }
  }, [bodyOpen, variant, call.argsText, call.resultText, call.status])

  /**
   * 吸附态要额外补一条与滚动容器顶部内距等高的底（sticky 只吸到内容盒顶端，
   * `.chat` 顶部还有 12px 内距，缝里会露出半行刚滚过去的参数）。
   */
  useEffect(() => {
    if (!bodyOpen || !barVisible || variant !== 'chat') return undefined
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
  }, [bodyOpen, barVisible, variant, call.argsText, call.resultText, call.status])

  // 吸附栏上的「状态 · 用时」（对话页口径；轨迹页不挂栏，这行只是兜底计算）。
  const duration = formatDuration(call.durationMs ?? null)
  const barStatus =
    running || duration === null
      ? (TOOL_STATUS_TEXT[call.status] ?? call.status)
      : `${TOOL_STATUS_TEXT[call.status] ?? call.status} · 用时 ${duration}`

  return (
    <div className={`entry tool-card status-${call.status}${bodyOpen ? ' open' : ''}`}>
      <div
        className="tool-head"
        role="button"
        tabIndex={expandable ? 0 : -1}
        {...(expandable ? { 'aria-expanded': bodyOpen } : {})}
        data-tip={expandable ? (bodyOpen ? '点击收起参数与结果' : '点击展开参数与结果') : '正在准备参数'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        {/* 行首状态点：成功绿 / 失败红 / 被拒黄 / 进行中强调色（codex 的 bullet）。 */}
        <span className="tool-dot" aria-hidden="true" />
        <Icon size={14} className="tool-icon" />
        <span className="verb">{toolVerb(match.base, call.status)}</span>
        {/* 认不出的工具保留原名：没有它就看不出这是哪家的工具（MCP 那些名字不直观）。 */}
        {match.known ? null : <span className="name">{call.name}</span>}
        <Preview intended={intended} summary={summary} cwd={cwd} />
        <StatusDetail call={call} />
        <Trailing entry={entry} />
        {expandable ? <IconChevronDown size={11} className="tc-chevron" /> : null}
      </div>
      {bodyOpen ? (
        <div className="tool-body" ref={bodyRef}>
          {barVisible && variant === 'chat' ? (
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
          <BodyExtra intended={intended} />
          <div className="label">参数</div>
          <div className="args">{prettyJson(call.argsText)}</div>
          {call.resultText === undefined || call.resultText === '' ? null : (
            <>
              <div className="label">结果</div>
              <div className="result">{call.resultText}</div>
            </>
          )}
          {/* Factory 的 children 仍是普通槽：第三方在这里给所有工具卡加行。 */}
          {props.renderSlot(TOOLCARD_FOOTER_SLOT, { entry })}
        </div>
      ) : null}
    </div>
  )
}

// ── 定义自带的 fallback 局部组件 ───────────────────────────────────────────────

/** 头行摘要（fallback）：一句 `toolSummary`；认不出的工具补原名。 */
function SummaryPreview(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'preview'>): ReactNode {
  return <span className="preview">{props.summary}</span>
}

/** 状态列（fallback 也是对话页选用的那份）：对话页的中文口径（done 只留状态点，running 转圈 + 「用时 X」）。 */
export function ChatStatus(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'statusDetail'>): ReactNode {
  const call = props.call
  const duration = formatDuration(call.durationMs ?? null)
  return (
    <span className="status">
      {call.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
      {call.status === 'done' ? '' : (TOOL_STATUS_TEXT[call.status] ?? call.status)}
      {duration === null || call.status === 'done' ? '' : ` · 用时 ${duration}`}
    </span>
  )
}

/** 没有额外块的父（轨迹页）用这个顶 bodyExtra。 */
function NoBodyExtra(): ReactNode {
  return null
}

/** 没有尾部动作的父（轨迹页）用这个顶 trailing。 */
function NoTrailing(): ReactNode {
  return null
}

// ── 对话页按 occurrence 选的局部组件 ──────────────────────────────────────────

/**
 * 摘要区：有 intended 就优先摊「将做的改动」预览（路径 + 增删行数 + 参数不匹配提示），
 * 否则回落 summary。这是对话页独有的那张脸（轨迹页不选它，用 fallback 的 summary）。
 */
export function IntendedPreview(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'preview'>): ReactNode {
  const { intended, summary, cwd } = props
  return (
    <span className="preview">
      {intended !== null ? (
        <>
          <span className="tc-path" title={intended.absPath}>
            {displayPathOf(intended.absPath, cwd)}
          </span>
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
      ) : (
        summary
      )}
    </span>
  )
}

/** 展开体里的「将做的改动」diff 块（对话页独有：轨迹页看的是已经发生了什么）。 */
export function IntendedBody(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'bodyExtra'>): ReactNode {
  const intended = props.intended
  if (intended === null) return null
  return (
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
  )
}

/** 「在轨迹中查看」药丸（对话页独有）：切到轨迹页并聚焦这一条。 */
export function TraceJumpButton(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'trailing'>): ReactNode {
  return (
    <button
      type="button"
      className="tc-trace"
      data-trace-jump={String(props.entry.id)}
      data-tip="在轨迹页查看这条调用的时刻与耗时"
      aria-label="在轨迹中查看"
      onClick={(event) => {
        event.stopPropagation()
        openTrace(props.entry.id)
      }}
    >
      在轨迹中查看
    </button>
  )
}
