/**
 * 内置插件：底部状态条的真实读数。
 *
 * 为什么用 `useHostSelector` 而不是 `useHostSnapshot`：宿主每个回合都在推帧，快照整体
 * 换引用；状态条上这些都是**标量**（模型名、档位、回合、用量、上下文占用），
 * 按值订阅之后，只有真的变了的那一项才让状态条重画。
 *
 * 每项都可能有缺失（老会话没有用量、没有请求记录时上下文占用是 0），所以读的时候
 * 一律给「不知道」留位置，绝不拿 0 冒充真值。
 *
 * @module dsc-ui-shell/plugins/statusbar
 */
import type { ReactNode } from 'react'
import { defineUiPlugin, useHostSelector, type HostSnapshot, type TokenUsageView } from '@dsc/ui'

export default defineUiPlugin({
  name: '状态条读数',
  apply(ui) {
    ui.slots.register('statusbar.right', { id: 'statusbar.readout', order: 1 }, StatusReadout)
  },
})

function StatusReadout(): ReactNode {
  const model = useHostSelector(readModel)
  const effort = useHostSelector(readEffort)
  const turn = useHostSelector(readTurn)
  const usage = useHostSelector(readUsage)
  const context = useHostSelector(readContext)
  const cost = useHostSelector(readCost)
  const cwd = useHostSelector(readCwd)

  return (
    <span className="readout" data-model={model} data-turn={turn}>
      {cwd === null ? null : (
        <span className="readout-item" title={cwd}>
          {lastSegment(cwd)}
        </span>
      )}
      <span className="readout-item" data-field="model" title="当前模型">
        {model === '' || model === 'unknown' ? '未选模型' : model}
      </span>
      {effort === null ? null : <span className="readout-item">档位 {effort}</span>}
      <span className="readout-item" data-field="turn" data-turn={turn}>
        回合 {turnLabel(turn)}
      </span>
      {usage === null ? null : (
        <span className="readout-item" data-field="usage">
          入 {formatTokens(usage.inputTokens)} / 出 {formatTokens(usage.outputTokens)}
        </span>
      )}
      {context === null ? null : (
        <span className="readout-item" data-field="context" title="最近一次请求的上下文占用 / 窗口">
          上下文 {formatTokens(context.used)}
          {context.window > 0 ? ` / ${formatTokens(context.window)}` : ''}
        </span>
      )}
      {cost === null ? null : (
        <span className="readout-item" data-field="cost" title="按官方价目表估算">
          {cost.total.toFixed(2)} 元{cost.peakNow ? '（峰时）' : ''}
        </span>
      )}
    </span>
  )
}

/** 快照里的 `status` 那一片；取不到给 null。 */
function statusOf(snapshot: HostSnapshot | null): Record<string, unknown> | null {
  const status = snapshot?.['status']
  return typeof status === 'object' && status !== null ? (status as Record<string, unknown>) : null
}

function readModel(snapshot: HostSnapshot | null): string {
  const model = statusOf(snapshot)?.['model']
  return typeof model === 'string' ? model : ''
}

function readEffort(snapshot: HostSnapshot | null): string | null {
  const effort = statusOf(snapshot)?.['effort']
  return typeof effort === 'string' ? effort : null
}

function readTurn(snapshot: HostSnapshot | null): string {
  const turn = statusOf(snapshot)?.['turnState']
  return typeof turn === 'string' ? turn : 'unknown'
}

function readUsage(snapshot: HostSnapshot | null): TokenUsageView | null {
  const usage = statusOf(snapshot)?.['usage']
  return typeof usage === 'object' && usage !== null ? (usage as TokenUsageView) : null
}

function readContext(snapshot: HostSnapshot | null): { used: number; window: number } | null {
  const status = statusOf(snapshot)
  if (status === null) return null
  const used = status['contextUsed']
  const window_ = status['contextWindow']
  if (typeof used !== 'number' && typeof window_ !== 'number') return null
  return { used: typeof used === 'number' ? used : 0, window: typeof window_ === 'number' ? window_ : 0 }
}

function readCost(snapshot: HostSnapshot | null): { total: number; peakNow: boolean } | null {
  const cost = statusOf(snapshot)?.['cost']
  if (typeof cost !== 'object' || cost === null) return null
  const record = cost as Record<string, unknown>
  const total = record['total']
  if (typeof total !== 'number') return null
  return { total, peakNow: record['peakNow'] === true }
}

function readCwd(snapshot: HostSnapshot | null): string | null {
  const cwd = statusOf(snapshot)?.['cwd']
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/** 回合状态 → 中文。 */
function turnLabel(turn: string): string {
  if (turn === 'idle') return '空闲'
  if (turn === 'thinking') return '思考中'
  if (turn === 'working') return '干活中'
  if (turn === 'awaiting-approval') return '等审批'
  return turn
}

/** token 数：上千用 k，省得状态条被数字撑开。 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 路径最后一段（工作目录显示）。 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}
