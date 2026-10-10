/**
 * 界面壳的最小应用：顶栏 + 主区 + 状态条 + 诊断区。
 *
 * 这一版刻意什么都不"自带"——它只声明槽、把宿主身份显示出来、把插件加载报告摊开，
 * 界面上的每一块都由插件放进来。这样"清单 → 下发 → 槽位注册 → 渲染"这条链
 * 是不是真的通了，一眼就能看出来（有卡片 = 通了；诊断区有红字 = 哪个插件没起来）。
 *
 * @module dsc-ui-shell/app
 */
import type { ReactNode } from 'react'
import type { UiBootGraph, UiPluginLoadReport } from '@dsc/ui-core'
import { ALLOWED_MODULES } from './boot'
import { useChannelStatus, useHostError, useHostHello } from './runtime-context'
import { SlotOutlet, useSlotFaults } from './slots-react'
import { SLOT } from './slots'
import type { UiSlots } from './plugin-api'

/** 应用参数。 */
export interface AppProps {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
}

export function App({ slots, boot, reports }: AppProps): ReactNode {
  const failed = reports.filter((report) => !report.ok)
  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">{boot.host.name}</span>
        <span className="version">{boot.host.version}</span>
        <ChannelState />
        <span className="spacer" />
        <SlotOutlet slots={slots} slot={SLOT.header} />
      </header>

      <HostErrorStrip />

      <div className="shell-body">
        <aside className="shell-sidebar">
          <SlotOutlet slots={slots} slot={SLOT.sidebar} />
        </aside>
        <main className="shell-main">
          <SlotOutlet slots={slots} slot={SLOT.notice} />
          <SlotOutlet slots={slots} slot={SLOT.main} />
        </main>
      </div>

      <footer className="shell-statusbar">
        <span data-field="plugins">
          插件 {reports.length - failed.length}/{reports.length}
        </span>
        <span data-field="slots">槽 {slots.slots.length}</span>
        <span data-field="entries">登记 {slots.size}</span>
        <span data-field="boot-rev">清单 {boot.rev}</span>
        <span className="spacer" />
        <SlotOutlet slots={slots} slot={SLOT.statusbarRight} />
      </footer>

      <Diagnostics slots={slots} boot={boot} reports={reports} />
    </div>
  )
}

/**
 * 宿主那一侧的异常（帧造不出来、或凭据失效）。
 *
 * 为什么单独占一行：帧流一旦停住，界面会「静静地冻在最后一帧」，看不出是宿主的问题；
 * 把原因摊出来，用户才知道该刷新还是该重启宿主。正常时不占位置。
 */
function HostErrorStrip(): ReactNode {
  const error = useHostError()
  if (error === null) return null
  return (
    <p className="host-error" data-host-error="1">
      宿主状态异常：{error}
    </p>
  )
}

/** 顶栏上的连接状态：数据通道通不通、握手拿到的协议版本是多少。 */
function ChannelState(): ReactNode {
  const status = useChannelStatus()
  const hello = useHostHello()
  const text =
    status === 'open'
      ? '已连接宿主'
      : status === 'connecting'
        ? '连接宿主中…'
        : '宿主已断开（宿主重启后令牌会失效，请用新打印的地址重新打开）'
  return (
    <span className="channel-state" data-channel={status} data-protocol={hello?.protocolVersion ?? ''}>
      {text}
      {hello === null ? '' : ` · 协议 v${String(hello.protocolVersion)} · 放行 ${String(hello.methods.length)} 个方法`}
    </span>
  )
}

/** 诊断区：清单里有什么、谁装上了、谁没起来、哪一块崩了、壳放行的模块有哪些。 */
function Diagnostics({
  slots,
  boot,
  reports,
}: {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
}): ReactNode {
  const faults = useSlotFaults(slots)
  return (
    <details className="diagnostics" open={reports.some((report) => !report.ok) || faults.length > 0}>
      <summary>
        诊断（{reports.length} 个插件 / {slots.slots.length} 个槽
        {faults.length === 0 ? '' : ` / ${String(faults.length)} 处故障`}）
      </summary>
      <ul className="diag-plugins">
        {reports.map((report) => (
          <li key={report.id} className={report.ok ? 'ok' : 'bad'} data-plugin={report.id}>
            <code>{report.id}</code> {report.ok ? '已装上' : `失败：${report.error ?? '未知原因'}`}
            {report.name === undefined ? '' : `（${report.name}）`}
            {report.ok && (report.attempts ?? 1) > 1 ? `（重试 ${String(report.attempts)} 次才成功）` : ''}
          </li>
        ))}
        {reports.length === 0 ? <li className="empty">启动清单里没有插件</li> : null}
      </ul>
      {faults.length === 0 ? null : (
        <ul className="diag-plugins">
          {faults.map((fault, index) => (
            <li key={`${fault.slot}|${fault.id}|${String(index)}`} className="bad" data-fault={fault.slot}>
              <code>{fault.slot}</code>
              {fault.id === '' ? '' : ` / ${fault.id}`} 在
              {fault.phase === 'render' ? '渲染' : fault.phase === 'contribute' ? '贡献槽位' : '卸载'}时出错：
              {fault.error.message}
            </li>
          ))}
        </ul>
      )}
      <p className="diag-line">
        清单 {boot.rev}：{boot.entries.map((entry) => entry.id).join('、') || '空'}
      </p>
      <p className="diag-line">槽：{slots.slots.join('、') || '无'}</p>
      <p className="diag-line">放行的模块：{ALLOWED_MODULES.join('、')}</p>
    </details>
  )
}
