/**
 * 内置插件：底部状态栏（照旧桌面界面 `StatusBar.tsx` 的三段式重写）。
 *
 * 为什么 class 名逐字照搬旧版：旧样式表（`legacy/views.css`，旧渲染层 styles.css 的逐字节
 * 副本）整份搬进壳里，`.segments` / `.segment` / `.ctx-card` / `.ctx-bar` / `.ctx-legend`
 * 这一套选择器就是「状态栏长什么样」的唯一原件。段与段之间的 `·` 分隔符由
 * `.segment:not(:first-child)::before` 伪元素画（views.css:3935-3939），这里不手写分隔符。
 *
 * 三段与三张悬浮卡与旧版一一对应：
 *
 *   1. `seg-turn`：轮次/步数（从消息流条目数）+ 输出速度（拿得到时）。悬浮卡「会话进度」
 *      列轮数、步数、速度、首字延迟（平均）、LLM 耗时、工具耗时与会话时钟。
 *   2. `seg-tokens`：本会话累计 token（累计为 0 时整段不画——0 不是读数，是「还没发生」）。
 *      悬浮卡「会话用量」列请求数、前缀缓存命中/未命中、输入输出与最近请求时刻。
 *   3. `seg-context`：上下文占用的圆环 + 百分比（分母 `contextWindow` 为 0 时整段不画，
 *      没有分母就谈不上百分比）。悬浮卡「上下文已用」画进度条与构成分解。
 *
 * 数据来源分三层，拿不到的那一项整行省略，绝不编数：
 *
 *   - 轮次/步数与构成估算：宿主快照（`entries` / `status.contextSegments`，服务端真值）；
 *   - 输出速度、首字延迟与两项耗时：桌面原生桥 `sessionUsage`（壳进程读
 *     `~/.dsc/usage/usage.jsonl` 的汇总，口径见 core/throughput.ts）——浏览器里没有这条桥，
 *     那几行整行省略，其余照常；
 *   - 会话开始/最近活动：界面侧观察（快照变化的时刻——宿主快照里没有时间戳）。
 *
 * @module dsc-ui-shell/plugins/statusbar
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  defineUiPlugin,
  getHostNative,
  IconActivity,
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

/** 回合状态：契约里的四种取值（contract.ts）。 */
type TurnState = StatusView['turnState']

/** 认状态字用的白名单：快照是 `unknown` 来的，没在这张表里的字一律当「没有状态」。 */
const TURN_STATES: readonly TurnState[] = ['idle', 'thinking', 'working', 'awaiting-approval']

/** 状态文案：与旧 StatusBar.tsx 一字不差。 */
const TURN_TEXT: Record<TurnState, string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  'awaiting-approval': '等待审批',
}

/**
 * 用量日志的会话投影（桌面原生桥 `sessionUsage` 的返回；形状原件在
 * `src/contract.ts` 的 SessionUsageView——插件拉不到那个模块，结构逐字对上）。
 */
interface SessionUsageView {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  lastInputTokens: number
  lastAt: number
  llmMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  toolMs: number
  toolCalls: number
}

/** status 缺席时读字段用的空壳：下面每个 reader 对空壳都回「没有」。 */
const EMPTY_STATUS: Readonly<Record<string, unknown>> = Object.freeze({})

/** 装配三段。 */
function StatusSegments(): ReactNode {
  // 一个字段一个订阅，值没变就不重渲染——为什么这么切见 useStatusField。
  const turnState = useStatusField(readTurnState)
  const model = useStatusField(readModel)
  const sessionId = useStatusField(readSessionId)
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
  // 会话时钟与用量日志的两个观察面（旧界面同款的两个 hook）。
  const activity = useHostSelector(readActivityKey)
  const hasContent = useHostSelector(readHasContent)

  // 快照口径的本会话累计 token；它一变就说明有一次请求刚落进日志（useSessionUsage 的重读键）。
  const settledTokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  const logged = useSessionUsage(sessionId, turnState, settledTokens)
  const clock = useSessionClock(sessionId, activity, hasContent)
  // 输出速度 = 已定稿请求的输出 token ÷ 纯解码时间（整会话累计，口径见 core/throughput.ts）；
  // 日志里没有这条会话、或老行没记解码期 → null，整截省略（不拿快照增量估一个顶上去）。
  const speed = logged === null ? null : tokensPerSecond(logged)
  // 累计用量优先读用量日志（含切到本进程之前的历史请求）；日志里还没有这条会话时，
  // 退回快照里的会话累计（只算本进程开着的这段时间）。两个都是真值，只是口径不同。
  const total = logged === null ? settledTokens : logged.inputTokens + logged.outputTokens

  const parts: ReactNode[] = []
  if (turnState !== null) {
    parts.push(
      <TurnSegment
        key="turn"
        turnState={turnState}
        model={model}
        sessionId={sessionId}
        rounds={Number(rounds)}
        steps={Number(steps)}
        speed={speed}
        logged={logged}
        clock={clock}
      />,
    )
  }
  if (total > 0) {
    parts.push(
      <TokenSegment
        key="tokens"
        total={total}
        snapshot={{ input: inputTokens ?? 0, output: outputTokens ?? 0 }}
        logged={logged}
        speedContext={{ cacheHit, cacheMiss }}
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

  // 一段都画不出来（宿主一帧没推、或这一版快照没有 status）就整条不占位置。
  if (parts.length === 0) return null
  return <div className="segments">{parts}</div>
}

/**
 * 第一段：轮次/步数（跑动时速度跟在后面），悬浮出「会话进度」卡。
 *
 * 与旧版同一条口径：主文案永远是「N 轮 N 步」——当前在干什么由图标颜色与悬浮说明表达，
 * 模型/会话这些身份读数收进悬浮说明（宿主开场写进消息流的那条「会话 x · 模型 y」已经
 * 不画了，信息在这一点上不丢）。
 */
function TurnSegment(props: {
  turnState: TurnState
  model: string
  sessionId: string | null
  /** 消息流里统计的轮数（用户消息数）与步数（工具调用数）。 */
  rounds: number
  steps: number
  speed: number | null
  logged: SessionUsageView | null
  clock: SessionClock | null
}): ReactNode {
  const stateText = TURN_TEXT[props.turnState]
  const startedAt = props.clock?.startedAt ?? null
  const lastActiveAt = props.clock?.lastActiveAt ?? null
  const logged = props.logged
  // 首字延迟报平均（累计 ÷ 样本数）：单看累计毫秒没有可比性，请求一多就只见涨。
  const ttft = logged === null ? null : averageTtftMs(logged)
  const ttftText = ttft === null ? null : formatDuration(ttft)
  const toolText = logged === null || logged.toolCalls === 0 ? null : formatDuration(logged.toolMs)
  const llmText = logged === null || !(logged.llmMs > 0) ? null : formatDuration(logged.llmMs)
  const hint = [
    `当前状态：${stateText}`,
    props.sessionId === null ? null : `会话 ${props.sessionId.slice(0, 8)}`,
    props.model === '' ? null : `模型 ${props.model}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
  return (
    <span className="segment seg-turn seg-hover">
      <button type="button" className="ctx-trigger" title={`${hint}；点开看轮次、步骤、速度与时间`}>
        <span className={`seg-icon state-${props.turnState}`}>
          <IconActivity size={12} />
        </span>
        {props.rounds} 轮 {props.steps} 步
        {props.speed !== null && <span className="seg-dim"> · {formatTokensPerSecond(props.speed)} tok/s</span>}
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">会话进度</span>
          <span className="ctx-numbers">
            {props.rounds} 轮 · {props.steps} 步
          </span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          <CardRow label="用户轮数" value={`${String(props.rounds)} 轮`} />
          <CardRow label="工具调用" value={`${String(props.steps)} 步`} />
          {props.speed !== null && <CardRow label="输出速度" value={`${formatTokensPerSecond(props.speed)} tok/s`} />}
          {ttftText !== null && logged !== null && (
            <CardRow label="首字延迟" value={`${ttftText}（平均 ${String(logged.ttftSteps)} 次）`} />
          )}
          {llmText !== null && <CardRow label="LLM 耗时" value={llmText} />}
          {toolText !== null && logged !== null && (
            <CardRow label="工具耗时" value={`${toolText} · ${String(logged.toolCalls)} 次`} />
          )}
          {startedAt !== null && <CardRow label="会话开始" value={clockText(startedAt)} />}
          {lastActiveAt !== null && (
            <CardRow label="最近活动" value={`${clockText(lastActiveAt)}（${agoText(lastActiveAt)}）`} />
          )}
        </div>
      </div>
    </span>
  )
}

/**
 * 第二段：本会话累计 token（日志口径优先，见上面 total 的口径注释）。
 *
 * 卡里给精确值（千分位）与明细：请求数、前缀缓存三行、输入/输出、最近请求时刻。
 * 缓存三行只在端点真上报过缓存明细时出现，否则退回一行「输入 token」——分母只吃
 * 上报过的请求，命中率才不会被老数据稀释（与旧 TokenCard 同口径）。
 */
function TokenSegment(props: {
  total: number
  snapshot: { input: number; output: number }
  logged: SessionUsageView | null
  /** 快照口径的缓存两栏（日志缺席时的兜底读数）。 */
  speedContext: { cacheHit: number | null; cacheMiss: number | null }
}): ReactNode {
  const logged = props.logged
  const input = logged?.inputTokens ?? props.snapshot.input
  const output = logged?.outputTokens ?? props.snapshot.output
  const requests = logged?.requests ?? null
  const lastAt = logged !== null && logged.lastAt > 0 ? logged.lastAt : null
  // 命中率的分母只算上报过缓存明细的请求（老日志没有 ch/cm）：日志在就用日志，否则用快照。
  const cacheHit = logged !== null ? logged.cacheHitTokens : props.speedContext.cacheHit
  const cacheMiss = logged !== null ? logged.cacheMissTokens : props.speedContext.cacheMiss
  const cachePrompt = cacheHit === null || cacheMiss === null ? 0 : cacheHit + cacheMiss
  const hitPercent = formatCacheHitPercent(cacheHit ?? 0, cachePrompt)
  return (
    <span className="segment seg-tokens seg-hover">
      <button type="button" className="ctx-trigger" title="这个会话的累计 token；点开看请求数与输入/输出明细">
        <span className="seg-icon">
          <IconDatabase size={12} />
        </span>
        {formatTokens(props.total)} tok
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">会话用量</span>
          <span className="ctx-numbers">{formatExactTokens(props.total)} tok</span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          {requests !== null && <CardRow label="模型请求" value={`${String(requests)} 次`} />}
          {hitPercent !== null && <CardRow label="缓存命中" value={`${hitPercent}%`} />}
          {hitPercent !== null && cacheMiss !== null && (
            <CardRow label="未缓存输入" value={formatExactTokens(cacheMiss)} />
          )}
          {hitPercent !== null && cacheHit !== null && <CardRow label="缓存读取" value={formatExactTokens(cacheHit)} />}
          {hitPercent === null && <CardRow label="输入 token" value={formatExactTokens(input)} />}
          <CardRow label="输出" value={formatExactTokens(output)} />
          {lastAt !== null && <CardRow label="最近请求" value={`${clockText(lastAt)}（${agoText(lastAt)}）`} />}
        </div>
      </div>
    </span>
  )
}

/**
 * 第三段：圆环 + 百分比，悬浮出「上下文已用」卡。
 *
 * 占用读数用 `contextUsed`（最近一次请求的 prompt_tokens，服务端真值），不是 `usage`
 * 累计——累计会把早已滚出窗口的内容也算进去，条会虚胖。分子与分解的关系照旧版：
 * 「对话消息」（用户输入/助手回复/思考过程三段之和）与「系统提示词 + 工具定义」
 * （系统提示词/工具定义两段之和）都来自宿主按请求内容估的分段；真值 `contextUsed`
 * 与分段之和的差（角色标记、工具 JSON 信封那些零头）画进对话消息那一块里。
 *
 * 分段讲不通时（估算跑偏：对话消息为 0、或大过真值）只画整条进度条，不摆一行
 * 自相矛盾的账（旧卡片同一条诚实规矩）。
 */
function ContextSegment(props: {
  used: number
  windowTokens: number
  segments: ContextSegmentsView
}): ReactNode {
  const percent = Math.round((props.used / props.windowTokens) * 100)
  const shown = Math.min(Math.max(percent, 0), 100)
  const messages = props.segments.prompt + props.segments.assistant + props.segments.thinking
  const base = props.segments.system + props.segments.tools
  const split = messages > 0 && messages < props.used
  const widthOf = (tokens: number): string =>
    `${((Math.min(tokens, props.windowTokens) / props.windowTokens) * 100).toFixed(2)}%`
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
            ~{formatTokens(props.used)} / {formatTokens(props.windowTokens)}
          </span>
        </div>
        <div className="ctx-bar">
          <span className="ctx-bar-fill" style={{ width: widthOf(split ? messages : props.used) }} />
          {split && <span className="ctx-bar-base" style={{ width: widthOf(props.used - messages) }} />}
        </div>
        {split && (
          <div className="ctx-legend">
            <div className="ctx-legend-row">
              <i className="ctx-dot ctx-dot-messages" />
              <span className="ctx-legend-label">对话消息</span>
              <span className="ctx-legend-value">~{formatTokens(messages)}</span>
            </div>
            <div className="ctx-legend-row">
              <i className="ctx-dot ctx-dot-base" />
              <span className="ctx-legend-label">系统提示词 + 工具定义</span>
              <span className="ctx-legend-value">~{formatTokens(props.used - messages)}</span>
            </div>
          </div>
        )}
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

/** 段的圆环图标：按占用百分比填充的一圈（尺寸与画法照搬旧 StatusBar.tsx）。 */
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

/** 模型名：宿主没选模型时给 `'unknown'`，那不是名字，别当名字画出来。 */
function readModel(status: Record<string, unknown>): string {
  const model = readText(status, 'model')
  return model === 'unknown' ? '' : model
}

/** 会话 id（uuid）：没有会话（还没开）时是 null。 */
function readSessionId(status: Record<string, unknown>): string | null {
  const sessionId = readText(status, 'sessionId')
  return sessionId === '' ? null : sessionId
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

/** 前缀缓存命中 tokens：端点没上报过明细时这个字段根本不存在。 */
function readCacheHit(status: Record<string, unknown>): number | null {
  const usage = usageOf(status)
  return usage === null ? null : readNumber(usage, 'cacheHitTokens')
}

/** 前缀缓存未命中 tokens：与命中项成对出现。 */
function readCacheMiss(status: Record<string, unknown>): number | null {
  const usage = usageOf(status)
  return usage === null ? null : readNumber(usage, 'cacheMissTokens')
}

/** 上下文窗口：0 是契约里写明的「未知」，调用方据此整段不画。 */
function readContextWindow(status: Record<string, unknown>): number {
  return readNumber(status, 'contextWindow') ?? 0
}

/** 最近一次请求的 prompt_tokens；还没有任何请求回过用量时是 0。 */
function readContextUsed(status: Record<string, unknown>): number {
  return readNumber(status, 'contextUsed') ?? 0
}

/** `contextSegments` 那一片：没有请求记录时宿主给全 0。 */
function segmentsOf(status: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(status['contextSegments'])
}

/** 取一个分段估算值的 reader（喂给 `useStatusField`；缺字段按 0 理解，故不画那一块）。 */
function readSegment(key: keyof ContextSegmentsView): (status: Record<string, unknown>) => number {
  return (status) => {
    const segments = segmentsOf(status)
    return segments === null ? 0 : (readNumber(segments, key) ?? 0)
  }
}

/**
 * 轮数/步数统计（旧界面第一段「N 轮 N 步」同口径）：用户消息计轮（插话不算—它是排队机制），
 * 工具调用计步。返回 "轮/步" 字符串——useHostSelector 的取值要引用稳定，数组对象会每帧换引用。
 */
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

/**
 * 快照变化的指纹：条目数、回合状态、累计 token 三者任一变了就算「有活动」。
 *
 * 为什么不用时间戳：快照里根本没有时间，能被观察到的只有「什么时候变了」。
 */
function readActivityKey(snapshot: HostSnapshot | null): string {
  const entries = snapshot?.['entries']
  const count = Array.isArray(entries) ? entries.length : 0
  const status = statusOf(snapshot) ?? EMPTY_STATUS
  const usage = usageOf(status)
  const input = usage === null ? 0 : (readNumber(usage, 'inputTokens') ?? 0)
  const output = usage === null ? 0 : (readNumber(usage, 'outputTokens') ?? 0)
  return `${String(count)}:${readText(status, 'turnState')}:${String(input)}:${String(output)}`
}

/**
 * 这条会话是不是已经有真实内容：system 灰条只是宿主发给界面的通知（新建的空会话
 * 也有），所以它不算内容；累计 token 动了也算有内容（旧 sessionHasContent 同款）。
 */
function readHasContent(snapshot: HostSnapshot | null): boolean {
  const status = statusOf(snapshot)
  if (status !== null) {
    const usage = usageOf(status)
    if (usage !== null && (readNumber(usage, 'inputTokens') ?? 0) + (readNumber(usage, 'outputTokens') ?? 0) > 0) {
      return true
    }
  }
  const entries = snapshot?.['entries']
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => (entry as { kind?: unknown })['kind'] !== 'system')
}

/**
 * 会话累计用量与各项耗时：切会话时取一次，之后每轮跑完（忙转闲）与每次请求定稿
 * （快照累计 token 一变）再取一次——日志里会变的就是这些时刻（旧 useSessionUsage 移植；
 * 桥不在的载体上直接记 null，「拿不到就不画」与读文件失败同一条路）。
 *
 * @param settledTokens - 快照口径的本会话累计 token；它一变就说明有一次请求刚落进日志。
 */
function useSessionUsage(
  sessionId: string | null,
  turnState: TurnState | null,
  settledTokens: number,
): SessionUsageView | null {
  // 连会话 id 一起存：切会话那一刻旧数字必须立刻作废，不能把上一条会话的账挂在新的底下。
  const [bag, setBag] = useState<{ id: string; view: SessionUsageView | null } | null>(null)
  const busy = turnState !== null && turnState !== 'idle'
  useEffect(() => {
    if (sessionId === null) {
      setBag(null)
      return
    }
    const native = getHostNative()
    if (!native.available) {
      // 浏览器 / 远程壳里没有这条桥：用量读数整块省略（降级路径，不是故障）。
      setBag({ id: sessionId, view: null })
      return
    }
    let alive = true
    void native.invoke<SessionUsageView | null>('sessionUsage', [sessionId]).then(
      (view) => {
        if (alive) setBag({ id: sessionId, view: view ?? null })
      },
      () => {
        // 用量日志读不了（还没生成 / 被占用）不是错误：这一段自然省略。
        if (alive) setBag({ id: sessionId, view: null })
      },
    )
    return () => {
      alive = false
    }
  }, [sessionId, busy, settledTokens])
  return bag !== null && bag.id === sessionId ? bag.view : null
}

/** 界面侧观察到的会话时钟（宿主快照不带时间戳，这两个时刻只能自己记）。 */
interface SessionClock {
  sessionId: string
  /** 本进程内第一次看到这条会话有内容的时刻；一直没内容就是 null。 */
  startedAt: number | null
  /** 最近一次看到快照变化的时刻。 */
  lastActiveAt: number
}

/**
 * 会话时钟：切会话时重置，之后每有一次快照变化就把「最近活动」推到当下，
 * 并在第一次看到内容时定下「会话开始」（旧 useSessionClock 移植）。
 *
 * 存 id 一起是必要的：切会话那一刻旧时钟必须立刻作废，不能把上一条会话的
 * 开始时间挂到新会话底下（与 useSessionUsage 同一个理由）。
 */
function useSessionClock(sessionId: string | null, activity: string, content: boolean): SessionClock | null {
  const [clock, setClock] = useState<SessionClock | null>(null)
  useEffect(() => {
    if (sessionId === null) {
      setClock(null)
      return
    }
    const now = Date.now()
    setClock((current) =>
      current === null || current.sessionId !== sessionId
        ? { sessionId, startedAt: content ? now : null, lastActiveAt: now }
        : { ...current, startedAt: current.startedAt ?? (content ? now : null), lastActiveAt: now },
    )
  }, [sessionId, activity, content])
  return clock !== null && clock.sessionId === sessionId ? clock : null
}

/** 时刻写成 24 小时制的 HH:MM（旧 clockText 同款）。 */
function clockText(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 相对时间：只到分钟与天，够读就行，不引第三方日期库（旧 agoText 同款）。 */
function agoText(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return `${String(Math.floor(hours / 24))} 天前`
}

// ─────────── 数量与耗时格式化：原件在旧渲染层 token-estimate.ts / trace-format.ts ───────────
// 为什么原样抄一份而不是 import：插件能 require 的只有 react 与 @dsc/ui（boot.ts 的白名单），
// 拉不到别的模块；这几段本来就是「数字怎么读」的唯一口径，改写它就是换口径。

/** 去掉小数末尾多余的 0：46.0K → 46K，1.00M → 1M。 */
function trimZero(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** 数量按 K / M 压短：1000 以下给原值，128000 读成 128K。 */
function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${trimZero(count / 1_000)}K`
  return `${trimZero(count / 1_000_000)}M`
}

/** 精确数量：千分位逗号：单行读数用紧凑那份，卡片里给精确值。 */
function formatExactTokens(count: number): string {
  return Math.round(count).toLocaleString('en-US')
}

/**
 * 输出速度（token/秒）：整个会话累计，除以纯解码时间。解码期为 0 时回 null，
 * 界面据此整段省略——绝不去除一个 0 印出天文数字（口径原件 core/throughput.ts）。
 */
function tokensPerSecond(totals: Pick<SessionUsageView, 'decodeMs' | 'decodeTokens'>): number | null {
  if (!(totals.decodeMs > 0)) return null
  return totals.decodeTokens / (totals.decodeMs / 1_000)
}

/** 首字延迟平均（毫秒）：没有样本时回 null，界面据此省略这一行（同 core/throughput.ts）。 */
function averageTtftMs(totals: Pick<SessionUsageView, 'ttftMs' | 'ttftSteps'>): number | null {
  if (!(totals.ttftSteps > 0)) return null
  return totals.ttftMs / totals.ttftSteps
}

/** 速度读数格式：10 以上给整数，10 以下给一位小数——8.4 / 12（同 core/throughput.ts）。 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 耗时读数：先四舍五入到 0.1 秒再决定用秒还是用分（同旧 trace-format.ts）。 */
function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const tenths = Math.round(ms / 100) / 10
  if (tenths < 60) return `${tenths.toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${String(hours)}h${pad(minutes)}m`
  return `${String(minutes)}m${pad(seconds)}s`
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
 * 前缀缓存命中率：部分命中绝不四舍五入成 100%——差几个 token 时加位数把它和满命中
 * 区分开（99.9 / 99.996…）。分母（prompt 侧总量）为 0 时返回 null，调用方整行省略。
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
