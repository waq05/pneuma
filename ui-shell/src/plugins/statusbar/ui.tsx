/**
 * 内置插件：底部状态栏（三段式，口径对齐 dsh 的 composer dock：`ActivityPill` +
 * `UsagePill` + `contextPressure`）。
 *
 * 为什么 class 名逐字照搬旧版：旧样式表（`legacy/views.css`，旧渲染层 styles.css 的逐字节
 * 副本）整份搬进壳里，`.segments` / `.segment` / `.ctx-card` / `.ctx-bar` / `.ctx-legend`
 * 这一套选择器就是「状态栏长什么样」的唯一原件。三段的间距、留白与分隔交给
 * `ui-shell/src/styles.css` 的一组覆盖（对齐 dsh：`gap:12px`、段间没有分隔符）。
 *
 * 三段与三张悬浮卡（与 dsh 一一对应）：
 *
 *   1. `seg-turn`：`N 轮 M 步 · X tok/s`。轮/步取宿主下发 `status.progress` 的真值
 *      （轮 = 用户消息数、步 = 助手消息数，口径见 contract.ts）；`步 = 0` 时整段不画
 *      （空会话里「0 轮 0 步」不是读数，dsh 的 ActivityPill 同款）。卡片「会话统计」列
 *      模型用时、工具调用用时、首 token 平均与输出速度。
 *   2. `seg-tokens`：`12.3K tok · 缓存命中 87%`（累计为 0 时整段不画）。卡片「Token 用量」
 *      列缓存命中、未缓存输入、缓存读取与输出。
 *   3. `seg-context`：`min(100, round(used/window*100))%` 的圆环 + 百分比（分母
 *      `contextWindow` 为 0 时整段不画）。卡片「上下文已用」画系统提示词 / 工具定义 /
 *      对话消息三段进度条与数值。
 *
 * 数据来源分三层，拿不到的那一项整行省略，绝不编数：
 *
 *   - 轮/步与上下文分段：宿主快照（`status.progress` / `status.contextSegments`）；
 *   - 输出速度、首 token 平均与两项耗时：桌面原生桥 `sessionUsage`（壳进程读
 *     `~/.dsc/usage/usage.jsonl` 的汇总，口径见 core/throughput.ts）——浏览器里没有这条桥，
 *     那几行整行省略，其余照常；
 *   - 本会话累计 token：日志口径优先，日志里没有这条会话时退回快照累计。
 *
 * @module dsc-ui-shell/plugins/statusbar
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  averageTtftMs,
  formatTokensPerSecond,
  formatTraceDuration,
  tokensPerSecond,
  trimZero,
} from '@dsc/ui-primitives'
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

/** 装配三段（对照 dsh 的 composer dock：轮/步 → tok · 缓存命中 → 上下文 %）。 */
function StatusSegments(): ReactNode {
  // 一个字段一个订阅，值没变就不重渲染——为什么这么切见 useStatusField。
  const turnState = useStatusField(readTurnState)
  const model = useStatusField(readModel)
  const sessionId = useStatusField(readSessionId)
  // 轮数/步数取宿主的会话进度真值（口径见 contract.ts 的 StatusView.progress），"轮/步"字符串稳定。
  const tally = useHostSelector(readProgress)
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
  // 用量日志的重读键：快照条目数 / 回合状态 / 累计 token 任一变了就重读一次。
  const activity = useHostSelector(readActivityKey)

  // 快照口径的本会话累计 token；它一变就说明有一次请求刚落进日志（useSessionUsage 的重读键）。
  const settledTokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  const logged = useSessionUsage(sessionId, turnState, settledTokens)
  // 输出速度 = 已定稿请求的输出 token ÷ 纯解码时间（整会话累计，口径见 core/throughput.ts）；
  // 日志里没有这条会话、或老行没记解码期 → null，整截省略（不拿快照增量估一个顶上去）。
  const speed = logged === null ? null : tokensPerSecond(logged)
  // 累计用量优先读用量日志（含切到本进程之前的历史请求）；日志里还没有这条会话时，
  // 退回快照里的会话累计（只算本进程开着的这段时间）。两个都是真值，只是口径不同。
  const total = logged === null ? settledTokens : logged.inputTokens + logged.outputTokens

  const parts: ReactNode[] = []
  // 步数为 0 时整段不画（dsh 的 ActivityPill 同款）：空会话里「0 轮 0 步」不是读数。
  if (turnState !== null && Number(steps) > 0) {
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
  /** 会话进度：轮数（用户消息数）与步数（助手消息数），口径见 StatusView.progress。 */
  rounds: number
  steps: number
  speed: number | null
  logged: SessionUsageView | null
}): ReactNode {
  const stateText = TURN_TEXT[props.turnState]
  const logged = props.logged
  // 首字延迟报平均（累计 ÷ 样本数）：单看累计毫秒没有可比性，请求一多就只见涨。
  const ttft = logged === null ? null : averageTtftMs(logged)
  const ttftText = ttft === null ? null : formatTraceDuration(ttft)
  const toolText = logged === null || logged.toolCalls === 0 ? null : formatTraceDuration(logged.toolMs)
  const llmText = logged === null || !(logged.llmMs > 0) ? null : formatTraceDuration(logged.llmMs)
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
          <span className="ctx-title">会话统计</span>
          <span className="ctx-numbers">
            {props.rounds} 轮 · {props.steps} 步
          </span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          {llmText !== null && <CardRow label="模型用时" value={llmText} />}
          {toolText !== null && <CardRow label="工具调用用时" value={toolText} />}
          {ttftText !== null && <CardRow label="首 token 平均（TTFT）" value={ttftText} />}
          {props.speed !== null && <CardRow label="输出速度（TPS）" value={`${formatTokensPerSecond(props.speed)} tok/s`} />}
        </div>
      </div>
    </span>
  )
}

/**
 * 第二段：本会话累计 token（日志口径优先，见上面 total 的口径注释）。
 *
 * 主文案照 dsh 的 UsagePill：`12.3K tok · 缓存命中 87%`——命中率是这一行的一等信息，
 * 不再藏进悬浮卡。卡里给精确值与 DSH 同款明细：缓存命中 / 未缓存输入 / 缓存读取 / 输出。
 * 命中率的分母只吃上报过缓存明细的请求，老日志少一行也不编数。
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
  // 命中率的分母只算上报过缓存明细的请求（老日志没有 ch/cm）：日志在就用日志，否则用快照。
  const cacheHit = logged !== null ? logged.cacheHitTokens : props.speedContext.cacheHit
  const cacheMiss = logged !== null ? logged.cacheMissTokens : props.speedContext.cacheMiss
  const cachePrompt = cacheHit === null || cacheMiss === null ? 0 : cacheHit + cacheMiss
  const hitPercent = formatCacheHitPercent(cacheHit ?? 0, cachePrompt)
  const hint = hitPercent === null
    ? `这个会话累计 ${formatExactTokens(props.total)} tok；点开看输入/输出明细`
    : `这个会话累计 ${formatExactTokens(props.total)} tok，前缀缓存命中 ${hitPercent}%；点开看输入/输出明细`
  return (
    <span className="segment seg-tokens seg-hover">
      <button type="button" className="ctx-trigger" title={hint}>
        <span className="seg-icon">
          <IconDatabase size={12} />
        </span>
        {formatTokens(props.total)} tok
        {hitPercent !== null && <span className="seg-dim"> · 缓存命中 {hitPercent}%</span>}
      </button>
      <div className="ctx-card" role="note">
        <div className="ctx-head">
          <span className="ctx-title">Token 用量</span>
          <span className="ctx-numbers">{formatExactTokens(props.total)} tok</span>
        </div>
        <div className="ctx-rule" />
        <div className="ctx-rows">
          {hitPercent !== null && <CardRow label="缓存命中" value={`${hitPercent}%`} />}
          {cacheMiss !== null ? (
            <CardRow label="未缓存输入" value={formatExactTokens(cacheMiss)} />
          ) : (
            <CardRow label="输入" value={formatExactTokens(input)} />
          )}
          {cacheHit !== null && <CardRow label="缓存读取" value={formatExactTokens(cacheHit)} />}
          <CardRow label="输出" value={formatExactTokens(output)} />
        </div>
      </div>
    </span>
  )
}

/**
 * 第三段：圆环 + 百分比，悬浮出「上下文已用」卡。
 *
 * 百分比公式与 dsh 的 `contextOccupancy` 一字不差：`min(100, round(used / window * 100))`。
 * 分母是当前模型的上下文窗口，分子是最近一次请求的 prompt_tokens（服务端真值）。
 *
 * 卡片分段也照 dsh：系统提示词 / 工具定义 / 对话消息（用户输入 + 助手回复 + 思考）。
 * 三段来自宿主按请求内容估的分段；三者都为 0（还没发过请求）时只画空条，不摆一排 0。
 */
function ContextSegment(props: {
  used: number
  windowTokens: number
  segments: ContextSegmentsView
}): ReactNode {
  const percent = Math.min(100, Math.round((props.used / props.windowTokens) * 100))
  const shown = Math.min(Math.max(percent, 0), 100)
  const system = props.segments.system
  const tools = props.segments.tools
  const messages = props.segments.prompt + props.segments.assistant + props.segments.thinking
  const breakdown = system + tools + messages
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
          {breakdown > 0 ? (
            <>
              <span className="ctx-bar-seg ctx-bar-system" style={{ width: widthOf(system) }} />
              <span className="ctx-bar-seg ctx-bar-tools" style={{ width: widthOf(tools) }} />
              <span className="ctx-bar-seg ctx-bar-messages" style={{ width: widthOf(messages) }} />
            </>
          ) : (
            <span className="ctx-bar-fill" style={{ width: widthOf(props.used) }} />
          )}
        </div>
        {breakdown > 0 && (
          <div className="ctx-legend">
            <div className="ctx-legend-row">
              <i className="ctx-dot ctx-dot-system" />
              <span className="ctx-legend-label">系统提示词</span>
              <span className="ctx-legend-value">~{formatTokens(system)}</span>
            </div>
            <div className="ctx-legend-row">
              <i className="ctx-dot ctx-dot-tools" />
              <span className="ctx-legend-label">工具定义</span>
              <span className="ctx-legend-value">~{formatTokens(tools)}</span>
            </div>
            <div className="ctx-legend-row">
              <i className="ctx-dot ctx-dot-messages" />
              <span className="ctx-legend-label">对话消息</span>
              <span className="ctx-legend-value">~{formatTokens(messages)}</span>
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
 * 会话进度（口径见 contract.ts 的 StatusView.progress）：宿主直接给「轮/步」两个数。
 *
 * 返回 "轮/步" 字符串——useHostSelector 的取值要引用稳定，数组/对象会每帧换引用。
 * 老宿主没有这个字段时回 "0/0"（第一段整段不画，与 dsh 的 ActivityPill 同款）。
 */
function readProgress(snapshot: HostSnapshot | null): string {
  const status = statusOf(snapshot)
  const progress = status === null ? null : asRecord(status['progress'])
  const turns = progress === null ? 0 : (readNumber(progress, 'turns') ?? 0)
  const steps = progress === null ? 0 : (readNumber(progress, 'steps') ?? 0)
  return `${String(turns)}/${String(steps)}`
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

// ─────────── 数量与耗时格式化：口径都在 @dsc/ui-primitives，这里只做组合 ───────────
// 2026-10-28：trimZero 与吞吐三条（TPS / TTFT / 速度读数）此前在这份文件里各抄了一遍，
// 连带那句「插件只能 require react 与 @dsc/ui」的旧理由。E6 起基元包是平台种子，直接取即可。

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
