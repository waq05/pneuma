/**
 * 界面壳的应用骨架：侧栏 + 主区（顶栏 / 消息流 / 输入区 / 状态栏）+ 诊断区。
 *
 * **这一层的 class 名与嵌套是照旧桌面界面 `App.tsx` 写的**，所以壳自己一行样式都不用写：
 * `.app`（flex 行）→ `.sidebar` + `.main`（flex 列）→ `.topbar` / `.thread-zone` /
 * `.statusbar` 全部吃 `legacy/views.css` 里现成的规则。壳新增的东西（诊断面板、宿主
 * 异常条、数据通道状态）写在 `styles.css` 里，与旧界面那套一眼能分开。
 *
 * 为什么槽条目要做成 `display:contents`（见 `styles.css`）：旧界面的布局规则全是按
 * **直接子节点**写的——侧栏是 flex 列、聊天区是 flex 列、输入区靠 `.composer-zone > *`
 * 定宽。壳为了给每个条目套错误边界必须多包一层 div，那一层会把上面这些规则全部挡掉。
 * `display:contents` 让这一层不生成盒子，插件放进去的东西就等于直接挂在外壳里。
 *
 * @module dsc-ui-shell/app
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { UiBootGraph, UiPluginLoadReport } from '@dsc/ui-core'
import { NATIVE_BRIDGE_VERSION, NATIVE_OPS } from '@dsc/ui-core'
import { ALLOWED_MODULES } from './boot'
import { useChannelStatus, useHostError, useHostHello, useHostSelector } from './runtime-context'
import { SlotOutlet, useSlotFaults } from './slots-react'
import { SLOT } from './slots'
import { getHostNative, type UiSlots } from './plugin-api'

/** 应用参数。 */
export interface AppProps {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
}

export function App({ slots, boot, reports }: AppProps): ReactNode {
  const failed = reports.filter((report) => !report.ok)
  return (
    <>
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-header">
            <span className="brand">{boot.host.name}</span>
            <ChannelState />
          </div>
          <SlotOutlet slots={slots} slot={SLOT.sidebar} />
        </aside>

        <div className="main">
          <div className="topbar">
            <div className="topbar-title-row">
              <span className="title">
                <SessionTitle />
              </span>
              <div className="drag-fill" />
              <SlotOutlet slots={slots} slot={SLOT.header} />
              <span className="shell-build" data-boot-rev={boot.rev}>
                {boot.host.version}
              </span>
            </div>
          </div>

          <HostErrorStrip />

          <div className="thread-zone">
            <div className="thread-main">
              <div className="chat-wrap">
                <div className="chat">
                  <div className="chat-inner">
                    <SlotOutlet slots={slots} slot={SLOT.main} />
                  </div>
                </div>
              </div>
              <div className="composer-zone">
                <SlotOutlet slots={slots} slot={SLOT.composer} />
              </div>
            </div>
          </div>

          <div className="statusbar">
            <SlotOutlet slots={slots} slot={SLOT.statusbar} />
          </div>
        </div>

        {/* 播报区用旧界面的浮层容器（`.dsc-toasts`），空着时它自己不可见。 */}
        <div className="dsc-toasts">
          <SlotOutlet slots={slots} slot={SLOT.notice} />
        </div>
      </div>

      <Diagnostics slots={slots} boot={boot} reports={reports} failed={failed.length} />
    </>
  )
}

/** 顶栏标题：当前会话的显示名；找不到就说「新会话」（旧界面同一口径）。 */
function SessionTitle(): ReactNode {
  const title = useHostSelector(readSessionTitle)
  return <>{title}</>
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

/** 侧栏头上的数据通道状态：通不通、协议版本、放行了多少方法。 */
function ChannelState(): ReactNode {
  const status = useChannelStatus()
  const hello = useHostHello()
  const text =
    status === 'open'
      ? '已连接'
      : status === 'connecting'
        ? '连接中…'
        : '已断开（请用宿主新打印的地址重开）'
  return (
    <span
      className="channel-state"
      data-channel={status}
      data-protocol={hello?.protocolVersion ?? ''}
      data-tip={
        hello === null
          ? '还没拿到宿主握手'
          : `协议 v${String(hello.protocolVersion)}，放行 ${String(hello.methods.length)} 个方法`
      }
    >
      {text}
    </span>
  )
}

/** 诊断区：清单里有什么、谁装上了、谁没起来、哪一块崩了、壳放行的模块有哪些。 */
function Diagnostics({
  slots,
  boot,
  reports,
  failed,
}: {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
  failed: number
}): ReactNode {
  const faults = useSlotFaults(slots)
  const native = getHostNative()
  const probe = useNativeProbe()
  return (
    <details className="diagnostics" open={failed > 0 || faults.length > 0}>
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
      {/* 原生桥在不在：桌面窗口里有（走 preload 的 window.dscNative），浏览器里没有。
          写在诊断区是因为它决定了插件能不能做"打开路径/系统通知"这类事，而这件事
          只看代码看不出来（同一个壳两种载体）。 */}
      <p className="diag-line" data-native={native.available ? 'on' : 'off'} data-native-probe={probe.state}>
        原生桥：
        {native.available
          ? `v${String(native.version ?? '?')} 已就绪（${String(NATIVE_OPS.length)} 个操作：${NATIVE_OPS.join('、')}）`
          : '浏览器里没有（桌面窗口才有）'}
        {native.available && native.version !== null && native.version !== NATIVE_BRIDGE_VERSION
          ? ` ⚠ 版本对不上：这一版壳按 v${String(NATIVE_BRIDGE_VERSION)} 写，外壳的桥是 v${String(native.version)}（多半是壳产物没跟着外壳一起重建）`
          : ''}
        {probe.detail === '' ? '' : ` · ${probe.detail}`}
      </p>
    </details>
  )
}

/**
 * 原生桥的自检读数：**真的调一次**只读操作（`recentCwds`）看回不回得来。
 *
 * 为什么值得摆在诊断区：桥"在"与桥"通"是两件事——白名单装错了、主进程那一侧没注册、
 * preload 没挂上，都会表现成"界面上那个按钮点了没反应"。这里把结论直接写出来：
 * 桌面上应是「n 个最近工作区」，浏览器里应是桥那句"没有"的人话（也就是**降级路径真的走过**）。
 */
function useNativeProbe(): { state: 'pending' | 'ok' | 'off' | 'error'; detail: string } {
  const [probe, setProbe] = useState<{ state: 'pending' | 'ok' | 'off' | 'error'; detail: string }>({
    state: 'pending',
    detail: '',
  })
  useEffect(() => {
    const native = getHostNative()
    let alive = true
    void native
      .invoke<unknown>('recentCwds')
      .then((list) => {
        if (!alive) return
        setProbe({
          state: 'ok',
          detail: `试点 recentCwds 回了 ${String(Array.isArray(list) ? list.length : 0)} 个最近工作区`,
        })
      })
      .catch((error: unknown) => {
        if (!alive) return
        const message = error instanceof Error ? error.message : String(error)
        // 桥本来就不在（浏览器 / 远程壳）——那是**预期**，不是故障：降级路径就该长这样。
        setProbe(
          native.available
            ? { state: 'error', detail: `试点未通过：${message}` }
            : { state: 'off', detail: `降级正常：${message}` },
        )
      })
    return () => {
      alive = false
    }
  }, [])
  return probe
}

/** 当前会话的显示名：从会话列表里按 `status.sessionPath` 找。 */
function readSessionTitle(snapshot: Record<string, unknown> | null): string {
  const status = snapshot?.['status']
  const sessions = snapshot?.['sessions']
  if (typeof status !== 'object' || status === null || !Array.isArray(sessions)) return '新会话'
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string') return '新会话'
  for (const item of sessions) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (record['id'] !== path) continue
    const title = record['title']
    return typeof title === 'string' && title !== '' ? title : '新会话'
  }
  return '新会话'
}
