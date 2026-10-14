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
  setDockPreview,
  type ChangedFileView,
  type FactoryComponentProps,
  type FactoryLocalProps,
  type ToolCallView,
  type UiPluginApi,
} from '@dsc/ui'
// 路径/时刻/工具摘要口径从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，不再内联（E6）。
import { TOOL_STATUS_TEXT, displayPathOf, formatDuration, matchTool, prettyJson, toolArgFields, toolSummary, toolVerb, type ToolMatch } from '@dsc/ui-primitives'
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
        preview: { props: { intended: IntendedDiff | null; summary: string; cwd: string; targetPath: string | null; change: ChangedFileView | null } }
        /** 状态列：父决定耗时口径（中文口径 / 轨迹的 4.2s 口径）。 */
        statusDetail: { props: { call: ToolCallView } }
        /** 展开体里的额外块：对话页给「将做的改动」diff，落地后给「这次改动」diff。 */
        bodyExtra: { props: { intended: IntendedDiff | null; change: ChangedFileView | null } }
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
  // 文件类工具这次调用指向的文件（摘要区的可点路径靠它；认不出就是 null）。
  const targetPath = fileTargetOf(call.name, call.argsText, cwd)
  // 「将做的改动」：write / edit 进行中时从参数 + 盘上现值推演（轨迹页不做，见 hook 文档）。
  const intended = useIntendedDiff(call, cwd, variant === 'chat')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  // 局部位置（按 occurrence）：父没选就用定义自己的 fallback。
  const Preview = props.useFactorySlot('preview', SummaryPreview)
  const StatusDetail = props.useFactorySlot('statusDetail', ChatStatus)
  // bodyExtra 的 fallback 就是「这次改动」那一块本身：轨迹页不选它，但落地后的 diff
  // 两边都该看得见（见 IntendedBody 的注释）。
  const BodyExtra = props.useFactorySlot('bodyExtra', IntendedBody)
  const Trailing = props.useFactorySlot('trailing', NoTrailing)
  /**
   * 展开体里要不要画 diff：进行中按参数推演（intended），落地后由工具结果带来的实际改动
   * （call.change，adapter 按 callId 缝回）接手。有 diff 时**不再摊原始参数 JSON**——
   * 参数里那一大坨正文换成 diff，其余字段走参数表（见 {@link toolArgFields}）。
   */
  const patch = intended?.file ?? call.change ?? null
  const argView = toolArgFields(call.name, call.argsText)
  const paramsAsFields = patch !== null && argView.mutating

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
        data-tip={expandable ? (bodyOpen ? '收起参数与结果' : '展开参数与结果') : '正在准备参数'}
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
        <Preview intended={intended} summary={summary} cwd={cwd} targetPath={targetPath} change={call.change ?? null} />
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
          <BodyExtra intended={intended} change={call.change ?? null} />
          <div className="label">参数</div>
          {paramsAsFields ? (
            /* 会改文件的工具：正文已经在上面那块 diff 里，这里只列剩下的字段。
               dsh 对 write / edit 干脆一个参数字段都不印，壳多留一栏是因为
               dsc 的 write / edit 还带 justification / sandbox_permissions 这类
               「这次为什么这么写」的元信息，扔掉可惜；形状仍是一行一字段，不是 JSON。 */
            <div className="args arg-fields" data-tc-argfields="">
              {argView.fields.map((field) => (
                <div className="arg-field" key={field.key}>
                  <span className="arg-key">{field.key}</span>
                  <span className="arg-value">{field.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="args">{prettyJson(call.argsText)}</div>
          )}
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

/** 没有尾部动作的父（轨迹页）用这个顶 trailing。 */
function NoTrailing(): ReactNode {
  return null
}

// ── 对话页按 occurrence 选的局部组件 ──────────────────────────────────────────

/**
 * 文件类工具（read / write / edit）这次调用指向的文件：摘要区那条可点路径的依据。
 *
 * 参数名两式都认（dsc 的工具用 `path`；`file_path` 是 MCP 系工具的常见写法）。
 * 相对路径按会话工作目录拼成绝对路径——预览页签要绝对的（`fs-read` 以工作目录
 * 为基准做包含校验，本会话的卡都在里面）。认不出（参数没吐全、没有路径字段、
 * 不是文件类工具）就是 null，摘要照旧纯文本。
 */
export function fileTargetOf(name: string, argsText: string, cwd: string): string | null {
  if (name !== 'read' && name !== 'write' && name !== 'edit') return null
  try {
    const args = JSON.parse(argsText) as Record<string, unknown>
    const raw = [args.file_path, args.path].find(
      (value): value is string => typeof value === 'string' && value !== '',
    )
    if (raw === undefined) return null
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw
    if (cwd === '') return raw
    const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
    return `${cwd.replace(/[\\/]+$/, '')}${sep}${raw.replace(/^[\\/]+/, '')}`
  } catch {
    return null
  }
}

/**
 * 摘要区里的可点路径：点开右侧栏。
 *
 * read 传 path 开**文件当前内容**（预览页签）；edit / write 带上 `patch` 开**补丁视图**
 * （这次改动改了什么，独立一种页签）——参考实现的编辑卡文件名同款。点它不折卡：
 * 头行整条是展开/收起的开关，鼠标与键盘两条路都要挡住冒泡。
 */
export function OpenPathButton({
  absPath,
  cwd,
  patch = null,
}: {
  absPath: string
  cwd: string
  /** 带上它就开补丁视图（edit / write）；缺省开文件当前内容（read）。 */
  patch?: ChangedFileView | null
}): ReactNode {
  const opensPatch = patch !== null
  return (
    <button
      type="button"
      className="tc-path tc-path-btn"
      data-tc-open={absPath}
      data-tc-source={opensPatch ? 'patch' : 'file'}
      title={opensPatch ? `${absPath}（在右侧边栏看这次改动）` : `${absPath}（在右侧边栏预览）`}
      onClick={(event) => {
        event.stopPropagation()
        setDockPreview(opensPatch ? { path: absPath, cwd, patch } : { path: absPath, cwd })
      }}
      onKeyDown={(event) => {
        // 只在按键冒泡上挡一层：button 自己的 Enter/Space 激活不受影响。
        event.stopPropagation()
      }}
    >
      {displayPathOf(absPath, cwd)}
    </button>
  )
}

/**
 * 摘要区：有补丁就优先摊「将做的改动」预览（路径 + 增删行数 + 参数不匹配提示），
 * 否则回落 summary。这是对话页独有的那张脸（轨迹页不选它，用 fallback 的 summary）。
 * 路径渲染成可点按钮：edit / write 开补丁视图，read 开文件当前内容。
 */
export function IntendedPreview(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'preview'>): ReactNode {
  const { intended, summary, cwd, targetPath, change } = props
  // 补丁数据两档：还在跑时按参数 + 盘上现值推演（intended），落地后由工具结果带来实际改动
  // （change，adapter 按 callId 缝回的工具卡字段）。两者同形，取先有的一方。
  const patch = intended?.file ?? change ?? null
  const absPath = intended?.absPath ?? change?.path ?? targetPath
  return (
    <span className="preview">
      {absPath !== null ? (
        <>
          <OpenPathButton absPath={absPath} cwd={cwd} patch={patch} />
          {patch !== null && (
            <span className="changes-counts">
              {patch.status === 'added' && <span className="diff-badge">新增</span>}
              <span className="changes-added">{`+${String(patch.added)}`}</span>
              <span className="changes-removed">{`-${String(patch.removed)}`}</span>
            </span>
          )}
          {intended?.mismatch === 'missing' && <span className="tc-warn">old 不在当前文件里</span>}
          {intended?.mismatch === 'ambiguous' && <span className="tc-warn">old 匹配多处</span>}
        </>
      ) : (
        summary
      )}
    </span>
  )
}

/**
 * 展开体里的 diff 块：进行中给「将做的改动」（按参数 + 盘上现值推演），落地后给
 * 「这次改动」（工具结果带来的实际改动，adapter 按 callId 缝回工具卡）。
 *
 * 两档同形（都是 ChangedFileView / IntendedDiff），落地后 intended 为空就换后者接手——
 * 这块**同时是 bodyExtra 的 fallback**（轨迹页不选局部组件），所以它不能依赖
 * 「对话页才有的 intended」：轨迹页拿到的 intended 恒为 null，照样画出这次改动。
 *
 * 对话页在 running 期只有 intended、落地后 intended 归 null，于是同一位置从
 * 「将做的改动」平滑换成「这次改动」，不会两个 diff 叠在一起。
 */
export function IntendedBody(props: FactoryLocalProps<typeof TOOLCARD_FACTORY, 'bodyExtra'>): ReactNode {
  const intended = props.intended
  const change = props.change
  if (intended !== null) {
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
  if (change === null) return null
  return (
    <div className="tc-intended" data-tc-change="">
      <div className="tc-intended-head">
        <span className="tc-intended-title">这次改动</span>
        {change.truncated === true && <span className="tc-warn">改动较大，这里只显示了前一部分</span>}
      </div>
      <div className="tc-intended-diff">
        <DiffRows hunks={change.hunks} path={change.path} />
      </div>
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
      onKeyDown={(event) => {
        // 同 OpenPathButton：Enter / Space 的按键冒泡别把卡折了。
        event.stopPropagation()
      }}
    >
      在轨迹中查看
    </button>
  )
}
