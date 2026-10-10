/**
 * 内置插件：运行时状态。
 *
 * 它是「界面壳真的接上了宿主」的活证据：卡片上的每个数字都来自宿主推来的帧，
 * 按钮点下去真的会调宿主的一个方法（`listTools`）并把结果画出来。
 * 与第三方插件用的是同一套 API（`useHostSnapshot` / `useHostChannel` / `hostStatus`），
 * 没有任何"内置特权"。
 *
 * @module dsc-ui-shell/plugins/runtime
 */
import { useState, type ReactElement } from 'react'
import { defineUiPlugin, hostStatus, useChannelStatus, useHostChannel, useHostSnapshot } from '@dsc/ui'

export default defineUiPlugin({
  name: '运行时状态',
  apply(ui) {
    // order 1：排在示例卡片之前（它是这一版最该被看见的一块）。
    ui.slots.register('shell.main', { id: 'runtime.status', order: 1 }, RuntimeCard)
    ui.slots.register('statusbar.right', { id: 'runtime.badge', order: 1 }, RuntimeBadge)
  },
})

/** 状态条上的小徽标：连接状态 + 回合状态 + 条目数。 */
function RuntimeBadge() {
  const snapshot = useHostSnapshot()
  const status = useChannelStatus()
  const state = hostStatus(snapshot)
  const label = status !== 'open' ? (status === 'connecting' ? '连接中' : '已断开') : (state?.turnState ?? '已连接')
  return (
    <span className="runtime-badge" data-channel={status} data-turn={state?.turnState ?? ''}>
      {label} · 条目 {snapshot?.entries.length ?? 0}
    </span>
  )
}

/** 主卡片：宿主推来的实时状态 + 一次真实的宿主方法调用。 */
function RuntimeCard() {
  const snapshot = useHostSnapshot()
  const channel = useHostChannel()
  const status = useChannelStatus()
  const state = hostStatus(snapshot)
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const usage = state?.usage ?? null

  const probeHost = async (): Promise<void> => {
    setBusy(true)
    try {
      const tools = await channel.invoke<{ name: string }[]>('listTools')
      const names = tools.slice(0, 6).map((tool) => tool.name).join('、')
      setProbe({ ok: true, text: `listTools 返回 ${String(tools.length)} 个工具：${names}${tools.length > 6 ? ' …' : ''}` })
    } catch (error) {
      setProbe({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="runtime-card">
      <h2>运行时状态</h2>
      <p className="runtime-hint">
        这些数字来自宿主推来的帧（SSE），不是写死的；按钮真的会调宿主的方法。
      </p>
      <dl className="runtime-grid">
        <Row label="连接" value={status === 'open' ? '已连接' : status === 'connecting' ? '连接中…' : '已断开'} />
        <Row label="帧号" value={snapshot === null ? '等第一帧' : String(snapshot.seq)} />
        <Row label="已定稿条目" value={String(snapshot?.entries.length ?? 0)} />
        <Row label="直播尾" value={String(snapshot?.liveEntries.length ?? 0)} />
        <Row label="会话" value={state?.sessionId === null || state === null ? '未开始' : state.sessionId.slice(0, 8)} />
        <Row label="模型" value={state?.model === '' || state === null ? '（未选）' : state.model} />
        <Row label="档位" value={state?.effort ?? '—'} />
        <Row label="回合" value={state?.turnState ?? '—'} />
        <Row
          label="用量"
          value={usage === null ? '—' : `入 ${String(usage.inputTokens)} / 出 ${String(usage.outputTokens)}`}
        />
      </dl>
      <button type="button" onClick={() => void probeHost()} disabled={busy}>
        {busy ? '调用中…' : '调宿主方法 listTools'}
      </button>
      {probe === null ? null : (
        <p className={probe.ok ? 'runtime-probe ok' : 'runtime-probe bad'} data-probe={probe.ok ? 'ok' : 'bad'}>
          {probe.text}
        </p>
      )}
    </div>
  )
}

/** 一行「标签 + 值」。 */
function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd data-field={label}>{value}</dd>
    </>
  )
}
