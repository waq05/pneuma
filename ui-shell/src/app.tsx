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
import { SlotOutlet } from './slots-react'
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
        <span className="spacer" />
        <SlotOutlet slots={slots} slot={SLOT.header} />
      </header>

      <main className="shell-main">
        <SlotOutlet slots={slots} slot={SLOT.notice} />
        <SlotOutlet slots={slots} slot={SLOT.main} />
      </main>

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

/** 诊断区：清单里有什么、谁装上了、谁没起来、壳放行的模块有哪些。 */
function Diagnostics({
  slots,
  boot,
  reports,
}: {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
}): ReactNode {
  return (
    <details className="diagnostics" open={reports.some((report) => !report.ok)}>
      <summary>诊断（{reports.length} 个插件 / {slots.slots.length} 个槽）</summary>
      <ul className="diag-plugins">
        {reports.map((report) => (
          <li key={report.id} className={report.ok ? 'ok' : 'bad'} data-plugin={report.id}>
            <code>{report.id}</code> {report.ok ? '已装上' : `失败：${report.error ?? '未知原因'}`}
          </li>
        ))}
        {reports.length === 0 ? <li className="empty">启动清单里没有插件</li> : null}
      </ul>
      <p className="diag-line">
        清单 {boot.rev}：{boot.entries.map((entry) => entry.id).join('、') || '空'}
      </p>
      <p className="diag-line">槽：{slots.slots.join('、') || '无'}</p>
      <p className="diag-line">放行的模块：{ALLOWED_MODULES.join('、')}</p>
    </details>
  )
}
