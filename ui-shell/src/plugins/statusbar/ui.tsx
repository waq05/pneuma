/**
 * 内置插件：底部状态栏（照旧桌面界面的三段式状态栏重写）。
 *
 * 为什么 class 名逐字照搬旧版：旧样式表（`legacy/views.css`，旧
 * `desktop/src/renderer/styles.css` 的逐字节副本）已经整份搬进壳里，`.segments`、
 * `.segment`、`.ctx-card` 这一套选择器就是「状态栏长什么样」的唯一原件。壳早期自己
 * 发明的那套 `.readout` / `.readout-item` 在新样式表里一条规则都没有，画出来是一行
 * 裸文字，所以整份删掉重写。
 *
 * 这一版只渲染 `.segments`：外面那层 `<div className="statusbar">`（居中、左右内距、
 * tabular-nums）由壳摆；段与段之间的 `·` 分隔符由 `.segment:not(:first-child)::before`
 * 伪元素画（views.css:3935-3939），这里不手写分隔符，也不写 `<style>`。
 *
 * 四段各自的数据来源与「没有就不画」（宁可整段缺席，也不把「不知道」画成 0）：
 *
 *   1. `seg-turn`：`turnState` 出状态字，`model` / `effort` 出尾部读数；卡里列会话短
 *      id、工作目录、模型、档位。旧版那一段报的是「N 轮 N 步 / tok/s」，那要数消息流
 *      条目、再读宿主的用量日志；壳这边两样都没有，所以这一段改成「状态 + 模型身份」，
 *      读数不编。
 *   2. `seg-tokens`：`usage.inputTokens` / `outputTokens`。整个 usage 缺席、或两个数
 *      加起来是 0（这个会话还没发生过一次请求）时，整段不画——0 不是读数，是「还没发生」。
 *   3. `seg-context`：`contextUsed / contextWindow` 的百分比与圆环。分母认不到
 *      （`contextWindow` 为 0）时整段不画：没有分母，百分比、圆环、进度条都无从谈起。
 *   4. `seg-cost`：只在宿主给了 `cost` 时画（只有 DeepSeek 官方端点、且模型在价目表里
 *      才有这个字段，见 contract.ts:518-522）。
 *
 * 悬浮卡常驻 DOM，显隐交给 CSS（`.ctx-card` 默认 `opacity:0; visibility:hidden`，
 * `:hover` / `:focus-within` 才显形，见 views.css:3987-4012、6802-6808），所以这里既没有
 * 「点开/收起」状态，也不用 JS 管显隐。
 *
 * @module dsc-ui-shell/plugins/statusbar
 */
import type { ReactNode } from 'react'
import {
  defineUiPlugin,
  IconActivity,
  IconCoins,
  IconDatabase,
  useHostSelector,
  type ContextSegmentsView,
  type HostSnapshot,
  type StatusView,
} from '@dsc/ui'

export default defineUiPlugin({
  name: '状态栏',
  apply(ui) {
    ui.slots.register('shell.statusbar', { id: 'statusbar.readout', order: 1 }, StatusSegments)
  },
})

/** 回合状态：契约里的四种取值（contract.ts:506）。 */
type TurnState = StatusView['turnState']

/** 认状态字用的白名单：快照是 `unknown` 来的，没在这张表里的字一律当「没有状态」。 */
const TURN_STATES: readonly TurnState[] = ['idle', 'thinking', 'working', 'awaiting-approval']

/** 状态文案：与旧 StatusBar.tsx:34-39 一字不差（executing 那段旧版叫「执行中」）。 */
const TURN_TEXT: Record<TurnState, string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  'awaiting-approval': '等待审批',
}

/**
 * 上下文构成卡的图例行：契约里的五个分段各占一行，名字用仓库里已有的说法
 * （系统提示词、工具定义、思考过程，见 contract.ts 与 transcript 插件）。
 *
 * 圆点色只有两种可选：样式表只给了 `.ctx-dot-messages`（强调色）与 `.ctx-dot-base`
 * （紫色）两个色块（views.css:4071-4077）。所以按旧卡片的分类上色——对话那三段（用户
 * 输入 / 助手回复 / 思考过程）用强调色，系统提示词与工具定义用紫色；颜色相同的两行
 * 靠行首文字区分，不为它们发明样式表里没有的圆点 class。
 */
const CONTEXT_LEGEND: readonly { key: keyof ContextSegmentsView; label: string; dot: string }[] = [
  { key: 'prompt', label: '用户输入', dot: 'ctx-dot-messages' },
  { key: 'assistant', label: '助手回复', dot: 'ctx-dot-messages' },
  { key: 'thinking', label: '思考过程', dot: 'ctx-dot-messages' },
  { key: 'system', label: '系统提示词', dot: 'ctx-dot-base' },
  { key: 'tools', label: '工具定义', dot: 'ctx-dot-base' },
]

/** status 缺席时读字段用的空壳：下面每个 reader 对空壳都回「没有」。 */
const EMPTY_STATUS: Readonly<Record<string, unknown>> = Object.freeze({})

/** 装配三段（+ 可选的费用段）。 */
function StatusSegments(): ReactNode {
  // 一个字段一个订阅，值没变就不重渲染——为什么这么切见 useStatusField。
  const turnState = useStatusField(readTurnState)
  const model = useStatusField(readModel)
  const effort = useStatusField(readEffort)
  const sessionId = useStatusField(readSessionId)
  const cwd = useStatusField(readCwd)
  // 轮数/步数从消息流条目统计（旧界面第一段「N 轮 N 步」的同一口径），"轮/步" 字符串稳定。
  const tally = useHostSelector(readRoundStep)
  const [rounds, steps] = tally.split('/')
  const inputTokens = useStatusField(readUsageInput)
  const outputTokens = useStatusField(readUsageOutput)
  const cacheHit = useStatusField(readCacheHit)
  const cacheMiss = useStatusField(readCacheMiss)
  const contextWindow = useStatusField(readContextWindow)
  const contextUsed = useStatusField(readContextUsed)
  const segSystem = useStatusField(readSegment('system'))
  const segPrompt = useStatusField(readSegment('prompt'))
  const segAssistant = useStatusField(readSegment('assistant'))
  const segThinking = useStatusField(readSegment('thinking'))
  const segTools = useStatusField(readSegment('tools'))
  const costTotal = useStatusField(readCostTotal)
  const costPeak = useStatusField(readCostPeak)

  // 累计用量：输入或输出任一缺席就说不清「累计是多少」，这一整段就缺席（不当 0 补）。
  const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens

  const parts: ReactNode[] = []
  if (turnState !== null) {
    parts.push(
      <TurnSegment
        key="turn"
        turnState={turnState}
        model={model}
        effort={effort}
        sessionId={sessionId}
        cwd={cwd}
        rounds={Number(rounds)}
        steps={Number(steps)}
      />,
    )
  }
  if (totalTokens !== null && totalTokens > 0) {
    parts.push(
      <TokenSegment
        key="tokens"
        inputTokens={inputTokens ?? 0}
        outputTokens={outputTokens ?? 0}
        cacheHit={cacheHit}
        cacheMiss={cacheMiss}
      />,
    )
  }
  if (contextWindow > 0) {
    parts.push(
      <ContextSegment
        key="context"
        used={contextUsed}
        windowTokens={contextWindow}
        segments={{
          system: segSystem,
          prompt: segPrompt,
          assistant: segAssistant,
          thinking: segThinking,
          tools: segTools,
        }}
      />,
    )
  }
  if (costTotal !== null) {
    parts.push(<CostSegment key="cost" total={costTotal} peakNow={costPeak} />)
  }

  // 一段都画不出来（宿主一帧没推、或这一版快照没有 status）就整条不占位置。
  if (parts.length === 0) return null
  return <div className="segments">{parts}</div>
}

/**
 * 第一段：回合状态 + 模型身份，悬浮出会话明细卡。
 *
 * `.seg-icon` 上的 `state-*` 只染图标（views.css:3942-3954），所以状态色不会把整段
 * 文字染蓝；模型与档位压在 `.seg-dim` 里当次级读数——这一段的主信息是「现在在干什么」。
 */
function TurnSegment(props: {
  turnState: TurnState
  model: string
  effort: string | null
  sessionId: string | null
  cwd: string | null
  /** 消息流里统计的轮数（用户消息数）与步数（工具调用数）。 */
  rounds: number
  steps: number
}): ReactNode {
  const stateText = TURN_TEXT[props.turnState]
  // 主文案对齐旧界面：空闲报「N 轮 N 步」，跑动中报状态字。
  const lead = props.turnState === 'idle' ? `${String(props.rounds)} 轮 ${String(props.steps)} 步` : stateText
  // 尾部读数：模型与档位各是一截，缺哪截少哪截，都不缺才用一个 `·` 连起来（分隔符规则
  // 与段之间一致：同一段里也只用中点）。
  const readout = [props.model, props.effort].filter((part) => part !== null && part !== '').join(' · ')
  const hint = [
    `当前状态：${stateText}`,
    `${String(props.rounds)} 轮 ${String(props.steps)} 步`,
    props.sessionId === null ? null : `会话 ${props.sessionId.slice(0, 8)}`,
    props.model === '' ? null : `模型 ${props.model}`,
    props.effort === null ? null : `档位 ${props.effort}`,
    props.cwd === null ? null : `目录 ${props.cwd}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')

  return (
    <span className="segment seg-turn seg-hover">
      <button type="button" className="ctx-trigger" title={`${hint}；点开看会话明细`}>
        <span className={`seg-icon state-${props.turnState}`}>
          <IconActivity size={12} />
        </span>
        {lead}
        {readout === '' ? null : <span className="seg-dim"> · {readout}</span>}
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">会话状态</span>
          <span className="ctx-numbers">{stateText}</span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          {props.sessionId === null ? null : (
            <CardRow label="会话" value={props.sessionId.slice(0, 8)} />
          )}
          {props.cwd === null ? null : <CardRow label="工作目录" value={shortCwd(props.cwd)} />}
          {props.model === '' ? null : <CardRow label="模型" value={props.model} />}
          {props.effort === null ? null : <CardRow label="档位" value={props.effort} />}
        </div>
      </div>
    </span>
  )
}

/**
 * 第二段：会话累计用量。
 *
 * 段上给的是紧凑读数（`↑12.3K ↓4.5K`，K/M 缩写口径照搬旧渲染层 token-estimate.ts 的
 * `formatTokens`），卡里给精确值（千分位，同旧文件 `formatExactTokens`）。缓存三行只在
 * 端点真上报过缓存明细时出现，否则退回一行「输入 token」——分母只吃上报过的请求，
 * 命中率才不会被老数据稀释（口径与旧 TokenCard 一致；本仓库没有「模型请求次数」这一项，
 * 所以旧卡那行没搬）。
 */
function TokenSegment(props: {
  inputTokens: number
  outputTokens: number
  cacheHit: number | null
  cacheMiss: number | null
}): ReactNode {
  const total = props.inputTokens + props.outputTokens
  // 两个缓存字段成对上报；只要有一项缺席，就说明这条会话还没有可用的缓存口径。
  const cachePrompt =
    props.cacheHit === null || props.cacheMiss === null ? 0 : props.cacheHit + props.cacheMiss
  // 分母为 0（没有上报过明细，或明细恰好全是 0）时这个函数自己回 null，调用方整块退回。
  const hitPercent = formatCacheHitPercent(props.cacheHit ?? 0, cachePrompt)

  return (
    <span className="segment seg-tokens seg-hover">
      <button
        type="button"
        className="ctx-trigger"
        title="这个会话的累计 token（↑ 输入 / ↓ 输出）；点开看输入输出明细"
      >
        <span className="seg-icon">
          <IconDatabase size={12} />
        </span>
        ↑{formatTokens(props.inputTokens)} ↓{formatTokens(props.outputTokens)}
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">会话用量</span>
          <span className="ctx-numbers">{formatExactTokens(total)} tok</span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          {hitPercent === null ? (
            <CardRow label="输入 token" value={formatExactTokens(props.inputTokens)} />
          ) : (
            <>
              <CardRow label="缓存命中" value={`${hitPercent}%`} />
              <CardRow label="未缓存输入" value={formatExactTokens(props.cacheMiss ?? 0)} />
              <CardRow label="缓存读取" value={formatExactTokens(props.cacheHit ?? 0)} />
            </>
          )}
          <CardRow label="输出" value={formatExactTokens(props.outputTokens)} />
        </div>
      </div>
    </span>
  )
}

/**
 * 第三段：圆环 + 百分比，悬浮出上下文构成卡。
 *
 * 占用读数用 `contextUsed`（最近一次请求的 prompt_tokens，服务端真值），不是 `usage`
 * 累计——累计会把早已滚出窗口的内容也算进去，条会虚胖（口径见 contract.ts:510-515）。
 * 真的超过窗口时不假装还在 100% 以内：数字照实报，圆环与进度条按 100% 画满。
 */
function ContextSegment(props: {
  used: number
  windowTokens: number
  segments: ContextSegmentsView
}): ReactNode {
  const percent = Math.round((props.used / props.windowTokens) * 100)
  const shown = Math.min(Math.max(percent, 0), 100)
  const barRatio =
    Math.min(Math.max(props.used, 0), props.windowTokens) / props.windowTokens
  // 空闲段的分母也是窗口，而分子用**权威占用**倒推（窗口 − 已用），不是分段估算之和：
  // 分段只描述「已用里各占多少颜色」，估算与真值本来就有差（口径同 src/app/StatusBar.tsx）。
  const free = Math.max(0, props.windowTokens - props.used)
  const share = (value: number): string => `${((value / props.windowTokens) * 100).toFixed(1)}%`
  const rows = CONTEXT_LEGEND.filter((row) => props.segments[row.key] > 0)

  return (
    <span className="segment seg-context seg-hover">
      <button type="button" className="ctx-trigger" aria-label={`上下文已用 ${String(percent)}%`}>
        <ContextRing percent={shown} />
        {percent}%
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">上下文已用 {percent}%</span>
          <span className="ctx-numbers">
            {formatTokens(props.used)} / {formatTokens(props.windowTokens)}
          </span>
        </div>
        {/* 轨道（`.ctx-bar` 的底色）就是空闲段：填充只有一块 = 占用比例，
            所以没有再画 `.ctx-bar-base`——它在这套单填充的画法里是 0 宽的死标记。
            分段估算另在图例里逐行列出。 */}
        <div className="ctx-bar">
          <span className="ctx-bar-fill" style={{ width: `${(barRatio * 100).toFixed(2)}%` }} />
        </div>
        <div className="ctx-legend">
          {rows.map((row) => (
            <div key={row.key} className="ctx-legend-row">
              <i className={`ctx-dot ${row.dot}`} />
              <span className="ctx-legend-label">{row.label}</span>
              <span className="ctx-legend-value">
                {formatTokens(props.segments[row.key])} · {share(props.segments[row.key])}
              </span>
            </div>
          ))}
          {free > 0 ? (
            <div className="ctx-legend-row">
              {/* 空闲没有专属圆点色（样式表只给对话色与紫色两块），这里用轨道底色画，
                  不给它发明一个 `.ctx-dot-idle`（那会是没有背景色的隐形圆点）。 */}
              <i className="ctx-dot" style={{ background: 'var(--dsc-fill-quaternary)' }} />
              <span className="ctx-legend-label">空闲</span>
              <span className="ctx-legend-value">
                {formatTokens(free)} · {share(free)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </span>
  )
}

/**
 * 可选第四段：会话费用估算（只在 DeepSeek 官方端点有价目时才有数据）。
 *
 * 卡里只有一条真数据（计价时段），不为了把卡片填满而编行；峰谷的判定依据
 * （按北京时段分桶）收在按钮的悬浮说明里。
 */
function CostSegment(props: { total: number; peakNow: boolean }): ReactNode {
  const amount = `${props.total.toFixed(2)} 元`
  return (
    <span className="segment seg-cost seg-hover">
      <button
        type="button"
        className="ctx-trigger"
        title="这个会话的费用估算（DeepSeek 官方价目表，峰谷按北京时段分桶）"
      >
        <span className="seg-icon">
          <IconCoins size={12} />
        </span>
        {amount}
        <span className="seg-dim"> · {props.peakNow ? '峰时' : '谷时'}</span>
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">会话费用</span>
          <span className="ctx-numbers">{amount}</span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          <CardRow label="计价时段" value={props.peakNow ? '峰时' : '谷时'} />
        </div>
      </div>
    </span>
  )
}

/** 悬浮卡里的一行「标签 …… 值」：标签靠左，值右对齐成一列（旧 StatusBar 的 CardRow 同款）。 */
function CardRow(props: { label: string; value: string }): ReactNode {
  return (
    <div className="ctx-row">
      <span className="ctx-label">{props.label}</span>
      <span className="ctx-value">{props.value}</span>
    </div>
  )
}

/** 段的圆环图标：按占用百分比填充的一圈（尺寸与画法照搬旧 StatusBar.tsx:299-318）。 */
function ContextRing({ percent }: { percent: number }): ReactNode {
  const radius = 5.2
  const circumference = 2 * Math.PI * radius
  const filled = (circumference * percent) / 100
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r={radius} stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.8" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * 订阅 status 里的一个字段。
 *
 * 为什么一个字段一个选择器，而不是把整个 status 订出来：宿主每个回合都推一份新快照，
 * `status` 也是新对象，整对象订阅会让默认比较（`Object.is`）永远为假——状态栏跟着每帧
 * 重画一次。这里选出来的全是字符串/数字/布尔，比较就是比字面值，只有真的变了才重画；
 * 也因此在选择器里不拼字符串、不造对象，只把字段本身交出去。
 *
 * @param read - 从一个 `status` 记录里取一个字段；记录缺席时收到空壳，回「没有」即可
 */
function useStatusField<T>(read: (status: Record<string, unknown>) => T): T {
  return useHostSelector((snapshot) => read(statusOf(snapshot) ?? EMPTY_STATUS))
}

/** 快照里的 `status` 那一片；第一帧还没到、或这一版宿主没推 status 时给 null。 */
function statusOf(snapshot: HostSnapshot | null): Record<string, unknown> | null {
  return asRecord(snapshot?.['status'])
}

/** 认成「键值记录」才算数：数组与 null 都不算（快照字段全是 `unknown`）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 字符串字段：不是字符串就给空串（「没有」）。 */
function readText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 数字字段：只有有限数才算数，其余一律 null。
 *
 * 为什么不回落到 0：0 是合法读数（输出 0 个 token），把「字段没有」也读成 0 就分不出
 * 「真的是 0」与「不知道」，调用方也没法判断该不该藏掉整段。
 */
function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 回合状态：不在这四种里（老 mock、将来加了新状态）就当没有状态，这一段不画。 */
function readTurnState(status: Record<string, unknown>): TurnState | null {
  const raw = status['turnState']
  return typeof raw === 'string' && (TURN_STATES as readonly string[]).includes(raw)
    ? (raw as TurnState)
    : null
}

/** 模型名：宿主没选模型时给 `'unknown'`（contract.ts:503），那不是名字，别当名字画出来。 */
function readModel(status: Record<string, unknown>): string {
  const model = readText(status, 'model')
  return model === 'unknown' ? '' : model
}

/** 档位（effort）：空串当没有。 */
function readEffort(status: Record<string, unknown>): string | null {
  const effort = readText(status, 'effort')
  return effort === '' ? null : effort
}

/** 会话 id：没有会话（还没开）时是 null。 */
function readSessionId(status: Record<string, unknown>): string | null {
  const sessionId = readText(status, 'sessionId')
  return sessionId === '' ? null : sessionId
}

/** 工作目录：快照组装自会话元数据，缺了就是空串。 */
function readCwd(status: Record<string, unknown>): string | null {
  const cwd = readText(status, 'cwd')
  return cwd === '' ? null : cwd
}

/** `usage` 那一片：这个会话还没请求过模型时是 null。 */
function usageOf(status: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(status['usage'])
}

function readUsageInput(status: Record<string, unknown>): number | null {
  const usage = usageOf(status)
  return usage === null ? null : readNumber(usage, 'inputTokens')
}

function readUsageOutput(status: Record<string, unknown>): number | null {
  const usage = usageOf(status)
  return usage === null ? null : readNumber(usage, 'outputTokens')
}

/** 前缀缓存命中 tokens：端点没上报过明细时这个字段根本不存在（contract.ts:392）。 */
function readCacheHit(status: Record<string, unknown>): number | null {
  const usage = usageOf(status)
  return usage === null ? null : readNumber(usage, 'cacheHitTokens')
}

/** 前缀缓存未命中 tokens：与命中项成对出现。 */
function readCacheMiss(status: Record<string, unknown>): number | null {
  const usage = usageOf(status)
  return usage === null ? null : readNumber(usage, 'cacheMissTokens')
}

/** 上下文窗口：0 是契约里写明的「未知」（contract.ts:508），调用方据此整段不画。 */
function readContextWindow(status: Record<string, unknown>): number {
  return readNumber(status, 'contextWindow') ?? 0
}

/** 最近一次请求的 prompt_tokens；还没有任何请求回过用量时是 0。 */
function readContextUsed(status: Record<string, unknown>): number {
  return readNumber(status, 'contextUsed') ?? 0
}

/** `contextSegments` 那一片：没有请求记录时宿主给全 0（contract.ts:516-517）。 */
function segmentsOf(status: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(status['contextSegments'])
}

/** 取一个分段估算值的 reader（喂给 `useStatusField`；缺字段按 0 理解，故不画那一行）。 */
function readSegment(key: keyof ContextSegmentsView): (status: Record<string, unknown>) => number {
  return (status) => {
    const segments = segmentsOf(status)
    return segments === null ? 0 : (readNumber(segments, key) ?? 0)
  }
}

/** `cost` 那一片：只在 DeepSeek 官方端点 + 模型在价目表里 + 至少回过一笔用量时才有。 */
function costOf(status: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(status['cost'])
}

function readCostTotal(status: Record<string, unknown>): number | null {
  const cost = costOf(status)
  return cost === null ? null : readNumber(cost, 'total')
}

function readCostPeak(status: Record<string, unknown>): boolean {
  return costOf(status)?.['peakNow'] === true
}

/**
 * 工作目录在卡里只给最后两段：卡片固定 272px 宽，整条路径会把「值」那一列撑爆。
 * 口径与终端状态栏的 `shortCwd` 一致（src/app/StatusBar.tsx），完整路径留在段按钮的
 * 悬浮说明里。
 */
function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
  return parts.length <= 2 ? cwd : `…${parts.slice(-2).join('/')}`
}

// ─────────── 数量格式化：下面这一段逐字照搬旧渲染层 desktop/src/renderer/token-estimate.ts ───────────
// 为什么原样抄一份而不是 import：插件能 require 的只有 react 与 @dsc/ui（boot.ts:53-59），
// 拉不到旧渲染层的模块；而「状态栏上的数字怎么缩写」本来就只有这一个口径，改写它就是换口径。

/** 去掉小数末尾多余的 0：46.0K → 46K，1.00M → 1M。 */
function trimZero(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** 数量按 K / M 压短（对照 dsh 的 123M tok / ~46.1K）：1000 以下给原值，128000 读成 128K。 */
function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${trimZero(count / 1_000)}K`
  return `${trimZero(count / 1_000_000)}M`
}

/** 精确数量：千分位逗号（对照 dsh 的 6,912,345 tok）：单行读数用紧凑那份，卡片里给精确值。 */
function formatExactTokens(count: number): string {
  return Math.round(count).toLocaleString('en-US')
}

/** 把命中率换算成「百分比整数单位」（0 位小数 = 1 单位 1%，1 位小数 = 1 单位 0.1%）。 */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil((factor * denominatorRemainder) / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/** 百分比单位 → 显示文本（1 位小数档末尾的 0 省掉）。 */
function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${String(tenths)}`
}

/**
 * 前缀缓存命中率（对照 dsh 的 formatCacheHitPercent）：部分命中绝不四舍五入成 100%——
 * 差几个 token 时加位数把它和满命中区分开（99.9 / 99.996…）。分母（prompt 侧总量）为 0
 * 时返回 null，调用方整行省略。
 */
function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${String(10 - roundedLoss)}`
}

/** 轮数/步数统计（旧界面第一段「N 轮 N 步」同口径）：用户消息（非插话）计轮，工具调用计步。
    返回 "轮/步" 字符串——useSyncExternalStore 的取值要引用稳定，数组对象会每帧换引用。 */
function readRoundStep(snapshot: HostSnapshot | null): string {
  const entries = snapshot?.['entries']
  if (!Array.isArray(entries)) return '0/0'
  let rounds = 0
  let steps = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record['kind'] === 'user' && record['steering'] !== true) rounds += 1
    else if (record['kind'] === 'tool') steps += 1
  }
  return `${String(rounds)}/${String(steps)}`
}
