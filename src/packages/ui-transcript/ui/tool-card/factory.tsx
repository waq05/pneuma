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
 *   - 没选的位置由定义自己的 fallback 顶上（SummaryPreview / ChatStatus / IntendedBody / NoTrailing）；
 *   - **渲染体**是纯展示组件 {@link ToolCardView}：对话页与轨迹页经 Factory occurrence 进来，
 *     队友运行记录那条拿不到槽上下文的路（`rows/tool-row`）直接渲染它——三份实现收成一份。
 *
 * `children` 仍是**普通槽**（`transcript.toolcard.footer`）：任何插件都能往里加一行，
 * 与工具卡是谁渲染的无关（`examples/ui-plugin-demo` 就是这么用的）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  diffLines,
  DiffRows,
  createT,
  IconChevronDown,
  IconChevronUp,
  openTrace,
  setDockPreview,
  type ChangedFileView,
  type FactoryComponentProps,
  type FactoryLocalInputProps,
  type FactoryLocalName,
  type ToolCallView,
  type UiPluginApi,
} from '@dsc/ui'
// 路径/时刻/工具摘要口径从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，不再内联（E6）。
import { TOOL_STATUS_TEXT, formatDuration, matchTool, prettyJson, toolArgFields, toolSummary, toolVerb, type ToolMatch } from '@dsc/ui-primitives'
import { useFoldState } from '../fold-hook'
import { BashBody, bashCommandOf } from './bash-view'
import { absPathOf } from './file-path'
import { PathButton } from './path-button'
import { ReadBody, ReadRange } from './read-view'
import { readCallOf, readPreviewOf } from './read-model'
import { ReadImageBadge, ReadImageBody } from './read-image-view'
import { readImageCallOf, readImageFactsOf } from './read-image-model'
import { SearchBody, SearchCount } from './search-view'
import { searchCallOf, searchResultOf } from './search-model'
import { TodoBody, TodoProgress } from './todo-view'
import { todoCallOf, todoListOf } from './todo-model'
import { WebBody, WebCount } from './web-view'
import { webCallOf, webResultOf } from './web-model'
import { resultHead, resultRest, resultTail } from './result-tail'
import { firstLineOf, flatValueOf, toolDetailArgs } from './tool-detail'
import { useIntendedDiff, type IntendedDiff } from '../intended-diff'
// 展开阈值与量高函数与思考栏共用一份，落在 rows/fold-body（那边是叶子模块，不形成环）。
import { BAR_MIN_CONTENT_H, expandedContentHeight } from '../rows/fold-body'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })
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
        /** 展开态持久化的键：给了就按它存档，缺省时退回 `storeKey`（两个都不给 = 不持久化）。 */
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

/**
 * dsh 插件给的 diff 卡片（`presentation.result.card === 'diff'`）→ 卡片用的变更视图。
 *
 * 为什么能这么接：dsh 的 `FileDiff` 是「改前全文 + 改后全文」，与 Pneuma 自己 write/edit
 * 工具落在会话日志里的 `changes`（path / added / removed / hunks）只差一步逐行 diff——
 * 而逐行 diff 正是壳里已有的一份实现（`diffLines`）。于是 dsh 插件的 diff 卡能直接落进
 * 现有的「将做的改动 / 这次改动」那一块，不必再养第二种画法。
 *
 * 只取第一份：Pneuma 的工具卡一张卡对一份 `change`（多文件时轮尾另有聚合卡）。dsh 的
 * diff 卡可以带多份，这里取第一份并在文档里标明这一处损失——比把多份压成一份假 diff 好。
 * @param presentation - 工具卡上的卡片数据
 * @returns 可渲染的变更视图；不是 diff 卡、或缺字段时给 null（回落通用卡）
 */
function dshPatchOf(presentation: ToolCallView['presentation']): ChangedFileView | null {
  const card = presentation?.result
  if (card === undefined || card['card'] !== 'diff') return null
  const diffs = card['diffs']
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const first = diffs[0] as { path?: unknown; oldText?: unknown; newText?: unknown }
  if (typeof first.path !== 'string' || typeof first.newText !== 'string') return null
  const before = typeof first.oldText === 'string' ? first.oldText : ''
  const diff = diffLines(before, first.newText, 3)
  if (!diff.ok || diff.identical) return null
  return {
    path: first.path,
    added: diff.added,
    removed: diff.removed,
    hunks: diff.hunks,
    status: first.oldText === null ? 'added' : 'modified',
  }
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
 * 共享骨架里一个局部组件的形状：它只需要**输入 props** 那半边（`intended` / `call` / `entry`…），
 * 另一半注册面（`renderSlot` / 席位）由 Factory 出口在渲染时注入，与视图无关。
 *
 * 与 `FactoryLocalComponent` 的区别只在这一层：那个类型要求组件收下整份
 * `FactoryLocalProps`（输入 + 注册面），而本文件这几个组件一个都不用注册面，
 * 声明得越窄，没有槽上下文的调用方（`rows/tool-row`）才递得进来。
 */
type LocalView<K extends FactoryLocalName<typeof TOOLCARD_FACTORY>> = (
  props: FactoryLocalInputProps<typeof TOOLCARD_FACTORY, K>,
) => ReactNode

/**
 * 共享骨架的输入：一条工具调用 + 四个局部组件（缺省就是对话页那三件 + 空尾巴）+ 尾巴。
 *
 * `footer` 是 Factory 的 children 槽内容（`transcript.toolcard.footer`）。没有槽上下文的
 * 调用方（队友运行记录）不传它，所以这一格**必须可选**——缺省就是没有那一行。
 */
export interface ToolCardViewProps {
  /** 这一条工具调用（对话页与轨迹页的条目形状同源）。 */
  entry: ToolEntry
  /** 展开态存档键（不给 = 这次挂载里临时展开，重挂即忘）。 */
  storeKey?: string
  /** 哪个父在渲染（缺省 chat）：轨迹页不挂吸附快捷栏、不推演 intended。 */
  variant?: 'chat' | 'trace'
  /** chain 选举算好的匹配（不传就自己 matchTool）。 */
  match?: ToolMatch
  /** 折叠偏好（缺省收起）。 */
  foldPrefs?: FoldPrefs
  /** 会话工作目录（intended 推演与相对路径展示的基准）。 */
  cwd?: string
  /** 头行摘要区（缺省一句 summary）。 */
  Preview?: LocalView<'preview'>
  /** 状态列（缺省对话页的中文口径）。 */
  StatusDetail?: LocalView<'statusDetail'>
  /** 展开体里的额外块（缺省「将做的改动 / 这次改动」diff）。 */
  BodyExtra?: LocalView<'bodyExtra'>
  /** 头行尾部（缺省不画）。 */
  Trailing?: LocalView<'trailing'>
  /** Factory 的尾巴子槽内容（第三方加的那一行）；没有槽上下文时不传。 */
  footer?: ReactNode
}

/**
 * 工具卡定义（Factory）：**只负责选件**——四个局部组件 + 尾巴子槽，然后交给共享视图
 * {@link ToolCardView}。卡长什么样、展开态怎么存、吸附栏怎么量，全在那一个视图里；
 * 对话页 / 轨迹页 / 队友运行记录三条路共用它，不再各养一份骨架。
 */
function ToolCard(props: FactoryComponentProps<typeof TOOLCARD_FACTORY>): ReactNode {
  // 局部位置（按 occurrence）：父没选就用定义自己的 fallback。
  const Preview = props.useFactorySlot('preview', SummaryPreview)
  const StatusDetail = props.useFactorySlot('statusDetail', ChatStatus)
  // bodyExtra 的 fallback 就是「这次改动」那一块本身：轨迹页不选它，但落地后的 diff
  // 两边都该看得见（见 IntendedBody 的注释）。
  const BodyExtra = props.useFactorySlot('bodyExtra', IntendedBody)
  const Trailing = props.useFactorySlot('trailing', NoTrailing)
  return (
    <ToolCardView
      entry={props.entry}
      // 存档键：轨迹页两个都不给（展开态只活在这次挂载里）；对话页两个同值。
      storeKey={props.persistKey ?? props.storeKey}
      variant={props.variant}
      match={props.match}
      foldPrefs={props.foldPrefs}
      cwd={props.cwd}
      Preview={Preview}
      StatusDetail={StatusDetail}
      BodyExtra={BodyExtra}
      Trailing={Trailing}
      // 尾巴是**普通子槽**：任何插件都能给所有工具卡加一行（见文件头）。
      footer={props.renderSlot(TOOLCARD_FOOTER_SLOT, { entry: props.entry })}
    />
  )
}

/**
 * 会走「终端块」的工具名。
 *
 * 为什么是三个：`ui-primitives/tool-summary.ts` 里 bash / shell / pwsh 映射的是同一个动词
 * 与同一个图标，它们都是「跑一条命令」这一件事。本机只注册了 `bash`
 * （`tools-default/bash.ts` 的 `name: 'bash'`），但兼容层与桌面侧还可能出现另外两个名字；
 * 界面若只认 `bash`，那台机器上这张卡就永远出不来。
 *
 * 名字对得上**之外**还要求参数里有 `command`（见 {@link ToolCardView}）：只有名字符合、
 * 参数键却是别的，就落回通用卡——宁可少一张终端块，也不画一个没有命令的空壳。
 */
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'pwsh'])

/**
 * 工具卡视图（纯展示）：一行头（状态点 + 图标 + 动词 + 摘要 + 状态）+ 展开后的额外块 /
 * 参数 / 结果。局部组件由调用方传入；**没有槽上下文的那条路直接渲染它**。
 *
 * 三件与旧实现一致、改的时候别破坏的事（都从 ToolRow 原样搬来）：
 * 1. **展开态存档**（`fold-state`）：会话切换会把条目整表重建，重挂时从存档键读回；
 * 2. **「将做的改动」只在 running 期出**（write / edit，含审批等待）：落地后轮尾的
 *    「文件已更改」卡接手，卡上再挂一份就是重复；
 * 3. **吸附快捷栏**：展开内容够长（>400px）才出现，只挂在对话页（variant === 'chat'）。
 */
export function ToolCardView(props: ToolCardViewProps): ReactNode {
  const { entry, storeKey, variant = 'chat', match: electedMatch, foldPrefs, cwd = '', footer = null } = props
  const call = entry.call
  /**
   * 这一条要不要走「终端块」：三条同时成立——名字是 bash / shell / pwsh、参数里真有
   * `command`、**而且这一页是对话页**。
   *
   * 为什么必须带第三条：轨迹页（`variant === 'trace'`）的用途是事后取证，要看到**原样**的
   * 参数 JSON 与结果原文；换成终端块之后，被格式化掉的那份原文就再也看不到。两个页面是
   * 两种需求，不该合并。`variant` 的取值只有 `'chat' | 'trace'`，缺省是 `'chat'`
   * （见 {@link ToolCardViewProps}），所以这里判 `=== 'chat'` 就够，不必同时排掉 trace。
   *
   * 别的工具碰巧也有个 `command` 字段不会被误伤，第一道名字判断先把它挡在外面；反过来，
   * 某个 shell 系工具若换了参数键，这里取不到命令，它就照旧走通用卡，不会画出一个空终端。
   */
  const bashCommand = bashCommandOf(call.argsText)
  const isTerminalCall = SHELL_TOOL_NAMES.has(call.name.toLowerCase()) && bashCommand !== null && variant === 'chat'
  /**
   * 另外三张专用卡（2026-11-11，差距清单 S4 第二批）：`read` / `glob`+`grep` / `todo_write`。
   *
   * 判据与终端块**逐字同一套**，一条都不能少：
   *   1. **名字对得上**——`readCallOf` / `searchCallOf` / `todoCallOf` 里第一句就是名字判断；
   *   2. **参数里真有那张卡要的字段**——read 要 `path`、检索要非空 `pattern`、待办要 `todos` 数组。
   *      只有名字相符、参数键却是别的，就落回通用卡：宁可少一张专用卡，也不画一个没有内容的空壳；
   *   3. **而且这一页是对话页**（`variant === 'chat'`）——轨迹页的职责是取证，要看到原样的参数
   *      JSON 与结果原文，换成格式化过的卡就再也看不到那份原文了（见上面 isTerminalCall）。
   *
   * 三份参数解析各自 `useMemo` 一次：它们的输入只有「名字 + 参数原文」，会话重渲染时不必重算；
   * 派生（结果解析）再各自 memo 一层，输入是「这份参数 + 结果原文」。
   */
  const readCall = useMemo(() => readCallOf(call.name, call.argsText), [call.name, call.argsText])
  const searchCall = useMemo(() => searchCallOf(call.name, call.argsText), [call.name, call.argsText])
  const todoCall = useMemo(() => todoCallOf(call.name, call.argsText), [call.name, call.argsText])
  /**
   * 后两张卡（2026-11-12，差距清单 S4 第三批）：`web`（web_search / webfetch）与 `read_image`。
   *
   * 判据与前面四张**逐字同一套**，但两张卡各有一处必须说清的地方：
   *
   * - `web` 的判据**不只靠名字**：dsh 的插件也能交来一张 `card: 'web'` 的卡片数据
   *   （`presentation.result`，见 `web-model.ts`），那种调用名字通常不叫 `web_search`。
   *   所以「名字 + 参数」与「卡片数据」任一条成立就算这张卡——两条都走同一个模型，
   *   渲染体不关心数据是解析出来的还是插件给的；
   * - `read_image` 的头行路径靠 `fileTargetOf` 的白名单（下面加了这个名字），卡片自己
   *   只画「格式 + 体积」那枚读数与展开体里那张图。
   *
   * 与前面四张一样，两条判据都带 `variant === 'chat'`：轨迹页要看原样参数与结果原文。
   */
  const readImageCall = useMemo(() => readImageCallOf(call.name, call.argsText), [call.name, call.argsText])
  const webCall = useMemo(() => webCallOf(call.name, call.argsText), [call.name, call.argsText])
  const readCard = readCall !== null && variant === 'chat'
  const searchCard = searchCall !== null && variant === 'chat'
  const todoCard = todoCall !== null && variant === 'chat'
  const readImageCard = readImageCall !== null && variant === 'chat'
  // web 卡：结果一律按「结构化优先、文本兜底」解析一次（模型是纯函数，代价可忽略）。
  // 轨迹页一次都不解析——那一页的判据与数据面无关。
  const webResult = useMemo(
    () => (variant === 'chat' ? webResultOf(webCall, call.presentation, call.resultText) : null),
    [variant, webCall, call.presentation, call.resultText],
  )
  const webCard = variant === 'chat' && (webCall !== null || webResult !== null)
  /** 这张 web 卡说的是哪一档（fetch 与 search 的展开体不同；卡片数据可能自带 kind）。 */
  const webKind: 'search' | 'fetch' = webCall?.kind ?? webResult?.kind ?? 'search'
  // 结果解析也按卡分流：不是这张卡就一次都不解析（一张普通卡不该为别的卡付解析成本）。
  const readPreview = useMemo(
    () => (readCard ? readPreviewOf(call.resultText) : null),
    [readCard, call.resultText],
  )
  const readImageFacts = useMemo(
    () => (readImageCard ? readImageFactsOf(call.resultText) : null),
    [readImageCard, call.resultText],
  )
  const searchResult = useMemo(
    () => (searchCard && searchCall !== null ? searchResultOf(searchCall.kind, call.resultText) : null),
    [searchCard, searchCall, call.resultText],
  )
  const todoList = useMemo(
    () => (todoCard && todoCall !== null ? todoListOf(todoCall, call.resultText) : null),
    [todoCard, todoCall, call.resultText],
  )
  // 默认档取设置里的「工具卡默认展开」；钩子让设置变化即时传到已画出的卡上，
  // 手动调过（有存档）的卡不受影响。没给存档键（轨迹页）时只活在本地。
  const [open, setOpenPersisted] = useFoldState(storeKey, foldPrefs?.toolOpen ?? false)
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
  // 局部组件：调用方没传就用定义内建的那一件（缺省正是对话页那三件 + 空尾巴）。
  const Preview = props.Preview ?? SummaryPreview
  const StatusDetail = props.StatusDetail ?? ChatStatus
  const BodyExtra = props.BodyExtra ?? IntendedBody
  const Trailing = props.Trailing ?? NoTrailing
  /**
   * 展开体里要不要画 diff：进行中按参数推演（intended），落地后由工具结果带来的实际改动
   * （call.change，adapter 按 callId 缝回）接手。有 diff 时**不再摊原始参数 JSON**——
   * 参数里那一大坨正文换成 diff，其余字段走参数表（见 {@link toolArgFields}）。
   */
  // 三种来源依次接手：进行中按参数推演 → 落地后的真实改动 → dsh 插件给的 diff 卡片
  // （最后一项是 2026-10-26 加的：dsh 的 presentResult 带 card: 'diff' 时落到同一块渲染）。
  const dshPatch = dshPatchOf(call.presentation)
  const patch = intended?.file ?? call.change ?? dshPatch
  const argView = toolArgFields(call.name, call.argsText)
  const paramsAsFields = patch !== null && argView.mutating
  /**
   * 对话页展开体的输入视图（见 tool-detail.ts）：一行一字段，没有可展示的字段就是空表。
   * 会改文件的工具还要剔除正文字段——正文已经在上面那块 diff 里，再摆一遍是同一段文字。
   */
  const detail = toolDetailArgs(call.argsText, argView.omitted)
  /** 这次调用有没有可展示的输入字段：没有就整段不画（连「输入」标题也不留）。 */
  const hasInput = (paramsAsFields && argView.fields.length > 0) || detail.fields.length > 0
  /** 展开体的「展开更多」是否已经摊开（只影响对话页；轨迹页没有这一层）。 */
  const [resultOpen, setResultOpen] = useState(false)
  /**
   * 输出区的首行摘要：resultHead 与收起态的 resultTail 共用同一套压平/截断口径，
   * 只是取头不取尾。轨迹页不画它——那边整段原文就是它的呈现。
   */
  const output = useMemo(
    () => (variant === 'chat' ? resultHead(call.resultText, 1) : null),
    [variant, call.resultText],
  )
  /** 首行之外的原文（「展开更多」摊开的正是这一段）。 */
  const outputRest = useMemo(
    () => (variant === 'chat' ? resultRest(call.resultText) : ''),
    [variant, call.resultText],
  )
  /**
   * 收起态的结果尾巴（见 result-tail.ts）：只给对话页、只给没展开的卡。
   *
   * 为什么展开态不给：那一份结果本来就在展开体里，再摊一遍是同一段文字出现两次。
   * 跑动中的卡也不给——结果还没定，摊出来的半截输出会一跳一跳。
   * trace 页不给：那一页的卡是「一行一条」的紧凑清单，多三行会把整页的密度打散。
   */
  const tail = useMemo(
    () => (bodyOpen || variant !== 'chat' || running ? null : resultTail(call.resultText)),
    [bodyOpen, variant, running, call.resultText],
  )

  // 卡合上就把「展开更多」收回：再点开时应该从首行摘要重新读起，而不是接着上次的滚动位置。
  useEffect(() => {
    if (!bodyOpen) setResultOpen(false)
  }, [bodyOpen])

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
      : t('transcript.tool.statusWithTime', { status: TOOL_STATUS_TEXT[call.status] ?? call.status, duration })

  return (
    <div className={`entry tool-card status-${call.status}${bodyOpen ? ' open' : ''}`}>
      <div
        className="tool-head"
        data-tip={expandable ? (bodyOpen ? t('transcript.tool.tipCollapse') : t('transcript.tool.tipExpand')) : t('transcript.tool.tipPreparing')}
      >
        {/* 只有这一段文字可点：状态点 + 图标 + 动词 + 未知名 + 摘要。
            行尾的「+N 行」、状态词、「在轨迹中查看」药丸与箭头都留在外面，
            它们各自是读数或独立按钮，不该跟着展开体一起开合。
            键盘 Enter/Space 也挂在这一段上（焦点圈见 views.css 的 .tool-click:focus-visible）。 */}
        <span
          className={`tool-click${expandable ? '' : ' inert'}`}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : -1}
          {...(expandable ? { 'aria-expanded': bodyOpen } : {})}
          onClick={expandable ? toggle : undefined}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggle()
          }}
        >
          {/* 行首一格：状态点（成功绿 / 失败红 / 被拒黄 / 进行中强调色，codex 的 bullet）+ 工具图标。
              整格宽度固定 --proc-gutter，与思考行的星标、组头的类别图标落在同一条竖线上（§15）。 */}
          <span className="tool-leading" aria-hidden="true">
            <span className="tool-dot" />
            <Icon size={12} className="tool-icon" />
          </span>
          <span className="verb">{toolVerb(match.base, call.status)}</span>
          {/* 认不出的工具保留原名：没有它就看不出这是哪家的工具（MCP 那些名字不直观）。
              分隔点照 dsh 的「工具调用 · <工具名>」：名字是补充说明，不跟标题糊成一串。 */}
          {match.known || call.name === '' ? null : <span className="name">{`· ${call.name}`}</span>}
          <Preview intended={intended} summary={summary} cwd={cwd} targetPath={targetPath} change={call.change ?? null} />
          {/* 各张专用卡自己的读数，紧跟在摘要后面（都还在 `.tool-click` 里：它们描述这次调用，
              不是独立按钮，点一下整行照旧展开）：
                - read：这次读了哪一段（`第 40–79 行`，路径本身已经由上面的 Preview 画成可点的）；
                - 检索：命中了多少（`3 处 · 2 个文件`，或者「没有匹配」）；
                - 待办：完成了几条 + 正在做的那一条；
                - web：搜到几条 / 抓取的 HTTP 状态码（卡片数据没回来时是空的，跑完才出现）；
                - 图片：什么格式、多大（`PNG · 128 KB`，从结果第一句读，不必先把图读进来）。 */}
          {readCard && readCall !== null ? <ReadRange call={readCall} preview={readPreview} /> : null}
          {searchCard && searchResult !== null ? <SearchCount result={searchResult} /> : null}
          {todoCard && todoList !== null ? <TodoProgress list={todoList} /> : null}
          {webCard ? <WebCount result={webResult} /> : null}
          {readImageCard ? <ReadImageBadge facts={readImageFacts} /> : null}
        </span>
        {/* 还有几行没摊出来：把「点开能看到更多」写在明面上（codex 的「+ N lines」）。
            只在收起态、且确实有截断时出现；不占焦点，点整行照旧是展开。
            专用卡不再画它：它们的头行已经有读数（区间 / 命中数 / 进度 / 结果条数 / 图片体积），
            再叠一个「+N 行」就是把同一件事说两遍。 */}
        {tail !== null && tail.hidden > 0 && !readCard && !searchCard && !todoCard && !webCard && !readImageCard ? (
          <span className="tc-more" title={t('transcript.tool.moreTip', { count: tail.hidden })}>
            {t('transcript.tool.moreLines', { count: tail.hidden })}
          </span>
        ) : null}
        {/* PTC 的卡里压着几次子调用：行头先说一声，展开或不展开都读得到「里面还有活」。 */}
        <SubCallCount call={call} />
        <StatusDetail call={call} />
        <Trailing entry={entry} />
        {expandable ? <IconChevronDown size={11} className="tc-chevron" /> : null}
      </div>
      {/* 收起态不再摊结果行（2026-10-27 用户：卡太高，折叠只占一行）。需要看结果就点开；
          头行右侧的「+N 行」仍然说明「点开还能看到多少」，只是不再预铺内容。 */}
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
                  title={t('transcript.tool.collapseCardTip')}
                  onClick={() => {
                    setOpenPersisted(false)
                  }}
                >
                  {t('transcript.common.collapse')}
                  <IconChevronUp size={11} />
                </button>
              )}
            </div>
          ) : null}
          {/* dsh 的 diff 卡片也走这一块：展开体原来只认 `call.change`（宿主按 callId 缝回的
              真实改动），于是一张只有 `presentation` 的卡在展开后是空的——数据到了卡上，
              却没接到渲染位置。这里把它并进同一个入口，两种来源同形（都是 ChangedFileView）。 */}
          <BodyExtra intended={intended} change={call.change ?? dshPatch} />
          {/* 卡内调用排在输入/输出之前：这几行是「这张卡到底干了什么」，先读它再读参数。 */}
          <SubCallList call={call} />
          {isTerminalCall ? (
            /* bash 系工具（bash / shell / pwsh）在**对话页**换一张终端块：命令、输出、退出码
               三块。参数表与结果尾巴都不画——命令已经在 `$` 那行、输出在 pre 里、退出码在
               徽章里，照通用卡再摊一遍同一段文字就是重复。轨迹页不走这一支（取证要看原样
               的参数 JSON 与结果原文，见上面 isTerminalCall 的注释）。头部与页脚不动，
               别的工具一个字节都没变。 */
            <BashBody call={call} />
          ) : readCard && readCall !== null ? (
            /* read（对话页）：头行已经说了「读了哪个文件的哪一段」（可点路径 + 区间），展开体
               只画内容预览——行号一列、原文一列，限高自滚。参数表不再摊：`path` / `offset` /
               `limit` 三个字段的全部信息都在头行那句话里，再列一遍就是同一句话说两次。
               轨迹页不走这一支（见上面 isTerminalCall 的注释与三张卡的判据）。 */
            <ReadBody call={call} preview={readPreview} />
          ) : searchCard && searchCall !== null ? (
            /* 检索（对话页）：头行说命中了多少，展开体按文件列命中，路径可点直接开预览。
               没有命中时画一句「没有匹配」+ 宿主的尾注，不是一张空卡。 */
            <SearchBody call={call} search={searchCall} result={searchResult} cwd={cwd} />
          ) : todoCard && todoList !== null ? (
            /* 待办（对话页）：头行说完成了几条，展开体是带四态符号的清单（只读的勾选框）。
               数据只读参数与结果两样现成的，数据面一处都没改。 */
            <TodoBody list={todoList} />
          ) : webCard ? (
            /* web（对话页）：头行说搜到几条 / HTTP 状态码，展开体是来源清单（可点标题 + 摘要）。
               来源优先取插件交来的卡片数据（`presentation.result`，结构化、刷新会话还在），
               没有卡片数据的旧会话才回头解析结果文本（见 `web-model.ts`）。 */
            <WebBody call={call} kind={webKind} result={webResult} />
          ) : readImageCard && readImageCall !== null ? (
            /* 图片（对话页）：头行说格式与体积，展开体按路径**现读**这一次的图。
               字节不进会话快照的理由写在 `read-image-view.tsx` 的文件头（一张图 8MB 的
               base64 会随每次快照重发一遍），所以这里只可能读到「现在盘上那张」。 */
            <ReadImageBody call={call} image={readImageCall} cwd={cwd} />
          ) : variant === 'trace' ? (
            /* 轨迹页看的是**原始参数与原始结果**（它的职责是取证，不是速读）：这一支
               与改造前逐字一致——标签 + prettyJson + 结果原文。别把对话页那张
               「动作 / 输入 / 输出」的脸搬过来，那会把轨迹页的判读口径改掉。 */
            <>
              <div className="label">{t('transcript.tool.args')}</div>
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
                  <div className="label">{t('transcript.tool.result')}</div>
                  <div className="result">{call.resultText}</div>
                </>
              )}
            </>
          ) : (
            /* 对话页：头行已经说了「动词 · 摘要」，展开体不再重复一遍动作，直接从输入开始。
               输入一行一字段；没有字段就整段不画，也不留「输入」空标题。输出只露首行，
               其余收进「展开更多」；只有输出没有参数时连「输出」标题也不画。 */
            <>
              {paramsAsFields && argView.fields.length > 0 ? (
                <>
                  <div className="label">{t('transcript.tool.input')}</div>
                  <div className="args arg-fields" data-tc-argfields="">
                    {argView.fields.map((field) => (
                      <div className="arg-field" key={field.key}>
                        <span className="arg-key">{field.key}</span>
                        <span className="arg-value tc-clip" title={field.value}>
                          {field.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : detail.fields.length > 0 ? (
                <>
                  <div className="label">{t('transcript.tool.input')}</div>
                  <div className="args arg-fields" data-tc-detail-fields="">
                    {detail.fields.map((field) => (
                      <div className="arg-field" key={field.key} data-multiline={field.multiline ? '1' : undefined}>
                        <span className="arg-key">{field.key}</span>
                        {/* 单行值走 CSS 截断（悬停看全文）；多行值只留首行，并标一个省略号。 */}
                        <span className="arg-value tc-clip" title={field.value}>
                          {flatValueOf(field)}
                          {field.multiline ? (
                            <span className="tc-fold-mark" aria-hidden="true">
                              {' …'}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {output === null ? null : (
                <>
                  {hasInput ? <div className="label">{t('transcript.tool.output')}</div> : null}
                  <div className="result tc-result">
                    <div className="tc-result-first" title={firstLineOf(call.resultText ?? '')}>
                      {output.lines[0] ?? ''}
                    </div>
                    {outputRest.trim() === '' ? null : (
                      <>
                        {resultOpen ? <div className="tc-result-rest">{outputRest}</div> : null}
                        <button
                          type="button"
                          className="tc-result-more"
                          aria-expanded={resultOpen}
                          onClick={() => {
                            setResultOpen(!resultOpen)
                          }}
                        >
                          {resultOpen
                            ? t('transcript.tool.showLess')
                            : t('transcript.tool.showMore', { count: output.hidden })}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
          {/* Factory 的 children 仍是普通槽：第三方在这里给所有工具卡加行。
              没有槽上下文的那条路（队友运行记录）传不进 footer，这一格就是空的。 */}
          {footer}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 卡内调用（PTC）：脚本里每调一次 `sdk.xxx()` 就是这里的一行。
 *
 * 为什么抽成两个组件而不是各画一遍：这两个挂在共享骨架 {@link ToolCardView} 上，
 * 对话页、轨迹页、队友运行记录三条路渲染的都是同一份，所以用户在界面上看到什么不再取决于
 * 「这次是谁画的卡」。别再在别的文件里摆一遍同样的标记与清单（那条断言在
 * `scripts/ui-step-group-live-test.mjs` 里钉着）。
 */
export function SubCallCount({ call }: { call: ToolCallView }): ReactNode {
  const count = call.subCalls?.length ?? 0
  if (count === 0) return null
  return <span className="sub-call-count">{t('transcript.tool.subCallCount', { count })}</span>
}

/** 卡内调用清单（展开体里）：图标 + 名字 + 参数摘要 + 成败，与头行的动词口径同源。 */
export function SubCallList({ call }: { call: ToolCallView }): ReactNode {
  const subs = call.subCalls ?? []
  if (subs.length === 0) return null
  return (
    <>
      <div className="label">{t('transcript.tool.subCalls')}</div>
      <ul className="sub-calls">
        {subs.map((sub, at) => {
          // 子调用视图是宿主交来的数据：字段缺了就当空串，别让一张卡把整页渲染带崩。
          const name = typeof sub.name === 'string' ? sub.name : ''
          const argsText = typeof sub.argsText === 'string' ? sub.argsText : ''
          const subMatch = matchTool(name)
          const SubIcon = subMatch.Icon
          return (
            <li key={`${sub.callId}:${String(at)}`} className={`sub-call status-${sub.status}`}>
              <span className="sub-call-leading" aria-hidden="true">
                <SubIcon size={11} />
              </span>
              <span className="sub-call-verb">{subMatch.known ? subMatch.base : name}</span>
              <span className="sub-call-summary">{toolSummary(name, argsText)}</span>
              <span className="sub-call-status">
                {sub.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
                {sub.status === 'running' || sub.status === 'done'
                  ? ''
                  : (TOOL_STATUS_TEXT[sub.status] ?? sub.status)}
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

// ── 定义自带的 fallback 局部组件 ───────────────────────────────────────────────

/** 头行摘要（fallback）：一句 `toolSummary`；认不出的工具补原名。 */
function SummaryPreview(props: FactoryLocalInputProps<typeof TOOLCARD_FACTORY, 'preview'>): ReactNode {
  return <span className="preview">{props.summary}</span>
}

/** 状态列（fallback 也是对话页选用的那份）：对话页的中文口径（done 只留状态点，running 转圈 + 「用时 X」）。 */
export function ChatStatus(props: FactoryLocalInputProps<typeof TOOLCARD_FACTORY, 'statusDetail'>): ReactNode {
  const call = props.call
  const duration = formatDuration(call.durationMs ?? null)
  return (
    <span className="status">
      {call.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
      {call.status === 'done' ? '' : (TOOL_STATUS_TEXT[call.status] ?? call.status)}
      {duration === null || call.status === 'done' ? '' : t('transcript.tool.timeSuffix', { duration })}
    </span>
  )
}

/**
 * 没有尾部动作的父（轨迹页）用这个顶 trailing。
 *
 * 队友运行记录那条路也用它：队友条目的 id 属于**另一份日志**，按它 `openTrace(entry.id)`
 * 会跳到主会话里错的步骤，所以那一格必须是空的，不能沿用对话页的「在轨迹中查看」。
 */
export function NoTrailing(): ReactNode {
  return null
}

// ── 对话页按 occurrence 选的局部组件 ──────────────────────────────────────────

/**
 * 文件类工具（read / read_image / write / edit）这次调用指向的文件：摘要区那条可点路径的依据。
 *
 * 参数名两式都认（dsc 的工具用 `path`；`file_path` 是 MCP 系工具的常见写法）。
 * 相对路径按会话工作目录拼成绝对路径——预览页签要绝对的（`fs-read` 以工作目录
 * 为基准做包含校验，本会话的卡都在里面）。认不出（参数没吐全、没有路径字段、
 * 不是文件类工具）就是 null，摘要照旧纯文本。
 *
 * 名字白名单里为什么有 `read_image`：它与 read 是同一族（读了哪个文件），头行的那条
 * 可点路径必须是同一个按钮（`read-family-row` 在参考实现里就是这么共用的）；预览页签
 * 本来就画得了图（`ui-preview` 的 `kind: 'image'` 分支），点开就是原图。
 */
export function fileTargetOf(name: string, argsText: string, cwd: string): string | null {
  if (name !== 'read' && name !== 'read_image' && name !== 'write' && name !== 'edit') return null
  try {
    const args = JSON.parse(argsText) as Record<string, unknown>
    const raw = [args.file_path, args.path].find(
      (value): value is string => typeof value === 'string' && value !== '',
    )
    if (raw === undefined) return null
    // 拼绝对路径的口径收在 `file-path.ts`：检索卡的结果路径用的是同一处（那边相对检索根）。
    return absPathOf(raw, cwd)
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
 *
 * 外形（类名、`data-tc-*`、悬停提示）在 `path-button.tsx` 里只写一份，检索卡的命中文件列表
 * 用的是同一个外壳；这里只负责「挡冒泡 + 开预览」这套头行专用的行为。
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
    <PathButton
      absPath={absPath}
      cwd={cwd}
      patch={patch}
      onClick={(event) => {
        event.stopPropagation()
        setDockPreview(opensPatch ? { path: absPath, cwd, patch } : { path: absPath, cwd })
      }}
      onKeyDown={(event) => {
        // 只在按键冒泡上挡一层：button 自己的 Enter/Space 激活不受影响。
        event.stopPropagation()
      }}
    />
  )
}

/**
 * 摘要区：有补丁就优先摊「将做的改动」预览（路径 + 增删行数 + 参数不匹配提示），
 * 否则回落 summary。这是对话页独有的那张脸（轨迹页不选它，用 fallback 的 summary）。
 * 路径渲染成可点按钮：edit / write 开补丁视图，read 开文件当前内容。
 */
export function IntendedPreview(props: FactoryLocalInputProps<typeof TOOLCARD_FACTORY, 'preview'>): ReactNode {
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
              {patch.status === 'added' && <span className="diff-badge">{t('transcript.common.added')}</span>}
              <span className="changes-added">{`+${String(patch.added)}`}</span>
              <span className="changes-removed">{`-${String(patch.removed)}`}</span>
            </span>
          )}
          {intended?.mismatch === 'missing' && <span className="tc-warn">{t('transcript.tool.mismatchMissing')}</span>}
          {intended?.mismatch === 'ambiguous' && <span className="tc-warn">{t('transcript.tool.mismatchAmbiguous')}</span>}
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
export function IntendedBody(props: FactoryLocalInputProps<typeof TOOLCARD_FACTORY, 'bodyExtra'>): ReactNode {
  const intended = props.intended
  const change = props.change
  if (intended !== null) {
    return (
      <div className="tc-intended">
        <div className="tc-intended-head">
          <span className="tc-intended-title">{t('transcript.tool.intendedTitle')}</span>
          {intended.fellBack && <span className="tc-warn">{t('transcript.tool.intendedFallback')}</span>}
          {intended.mismatch === 'missing' && <span className="tc-warn">{t('transcript.tool.intendedMissing')}</span>}
          {intended.mismatch === 'ambiguous' && <span className="tc-warn">{t('transcript.tool.intendedAmbiguous')}</span>}
        </div>
        {intended.file === null ? (
          <p className="tc-intended-note">{t('transcript.tool.intendedIdentical')}</p>
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
        <span className="tc-intended-title">{t('transcript.tool.changeTitle')}</span>
        {change.truncated === true && <span className="tc-warn">{t('transcript.tool.truncated')}</span>}
      </div>
      <div className="tc-intended-diff">
        <DiffRows hunks={change.hunks} path={change.path} />
      </div>
    </div>
  )
}

/** 「在轨迹中查看」药丸（对话页独有）：切到轨迹页并聚焦这一条。 */
export function TraceJumpButton(props: FactoryLocalInputProps<typeof TOOLCARD_FACTORY, 'trailing'>): ReactNode {
  return (
    <button
      type="button"
      className="tc-trace"
      data-trace-jump={String(props.entry.id)}
      data-tip={t('transcript.tool.traceTip')}
      aria-label={t('transcript.tool.trace')}
      onClick={(event) => {
        event.stopPropagation()
        openTrace(props.entry.id)
      }}
      onKeyDown={(event) => {
        // 同 OpenPathButton：Enter / Space 的按键冒泡别把卡折了。
        event.stopPropagation()
      }}
    >
      {t('transcript.tool.trace')}
    </button>
  )
}
