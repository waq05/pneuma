/**
 * 内置插件：插件中心（主区**独立整页**，对照旧桌面界面 `PluginsView.tsx`）。
 *
 * 形态对齐旧界面：侧栏「插件」入口把主区整页切成这一页（顶栏与正文一起让位，
 * 再点一次侧栏入口回对话页）。三组列表与旧界面同款——自定义（external）、
 * 官方可开关（builtin + toggleable）、运行内核（builtin 不可停）；组标签带数量。
 *
 * 数据走 `listPlugins` / `setPluginEnabled`（都在界面通道放行面上）。页头三颗钮
 * 与旧界面同构：刷新（重取清单）、重启宿主（原生桥 `restartHost`；浏览器里禁用并
 * 说明）、+ 添加插件（**写入口**：装插件要往 ~/.dsc 写文件 + 系统文件选择器，属于
 * 供应链写入口，与装技能同一个理由不在界面通道放行——点击给一句诚实的说明）。
 *
 * 与旧界面的差距（诚实边界）：插件**详情页**没搬——`listPlugins` 的回包不带
 * 配置分区数据（旧界面靠 `inspectPlugin` 之类的专用口，不在界面通道白名单里）。
 *
 * @module dsc-ui-shell/plugins/plugins
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  IconPuzzle,
  IconRefresh,
  IconRestart,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useShellPage,
} from '@dsc/ui'

/** 这一页在 page-state 里的 id（侧栏入口与页条目约定同一个值）。 */
const PAGE = 'plugins'

/** `listPlugins` 回来的形状（宿主契约；settings 插件搬家前的同款）。 */
interface PluginRow {
  file: string
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'external'
  toggleable: boolean
}

export default defineUiPlugin({
  name: '插件中心',
  apply(ui) {
    ui.slots.register('shell.page', { id: 'plugins.page', order: 10 }, PluginsPage)
  },
})

/** 插件页条目：不是自己在前台就整个不渲染（页条目都由壳的 `shell.page` 槽统一挂着）。 */
function PluginsPage(): ReactNode {
  const page = useShellPage()
  if (page !== PAGE) return null
  return <PluginsView />
}

function PluginsView(): ReactNode {
  const channel = useHostChannel()
  const native = getHostNative()
  const [rows, setRows] = useState<PluginRow[] | null>(null)
  const [note, setNote] = useState('')

  const refresh = (): void => {
    void channel
      .invoke<PluginRow[]>('listPlugins')
      .then((list) => {
        setRows(Array.isArray(list) ? list : [])
        setNote('')
      })
      .catch((error: unknown) => {
        setNote(`读插件失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel])

  const toggle = (row: PluginRow): void => {
    setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: !item.enabled } : item)) ?? null)
    void channel.invoke('setPluginEnabled', [row.file, !row.enabled]).catch((error: unknown) => {
      setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: row.enabled } : item)) ?? null)
      setNote(`没改成功：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const restartHost = (): void => {
    if (!native.available) {
      toastErr('重启宿主来自桌面外壳的原生桥，浏览器里没有它')
      return
    }
    void native.invoke('restartHost').catch((reason: unknown) => {
      toastErr(`重启失败：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }

  const custom = (rows ?? []).filter((row) => row.source === 'external')
  const official = (rows ?? []).filter((row) => row.source === 'builtin' && row.toggleable)
  const kernel = (rows ?? []).filter((row) => row.source === 'builtin' && !row.toggleable)

  return (
    <div className="plugins">
      <div className="plugins-inner">
        <div className="plugins-head">
          <div>
            <h1>插件</h1>
            <p>管理插件，开关即时生效（装插件是写入口，在这里只做启停）</p>
          </div>
          <div className="plugins-actions">
            <button type="button" className="icon-btn" data-tip="刷新列表" aria-label="刷新列表" onClick={refresh}>
              <IconRefresh size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              data-tip={native.available ? '重启宿主，重新加载插件目录' : '重启宿主只在桌面版里有'}
              aria-label="重启宿主"
              disabled={!native.available}
              onClick={restartHost}
            >
              <IconRestart size={16} />
            </button>
            <button
              type="button"
              className="btn-primary plugins-add"
              onClick={() => {
                toastOk('装插件要往 ~/.dsc 写文件（系统文件选择器 + 复制），属于供应链写入口，界面通道刻意不放行——命令行或旧界面里装，这里只做启停')
              }}
            >
              + 添加插件
            </button>
          </div>
        </div>

        {rows === null ? <div className="plugins-empty">正在读插件…</div> : null}

        {rows !== null && custom.length > 0 ? (
          <>
            <div className="plugin-group-label">
              <IconPuzzle size={13} /> 自定义 <span className="count">{custom.length}</span>
            </div>
            {custom.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} />
            ))}
          </>
        ) : null}

        {rows !== null && official.length > 0 ? (
          <>
            <div className="plugin-group-label">
              <IconPuzzle size={13} /> 官方可开关 <span className="count">{official.length}</span>
            </div>
            {official.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} />
            ))}
          </>
        ) : null}

        {rows !== null && kernel.length > 0 ? (
          <>
            <div className="plugin-group-label">
              <IconPuzzle size={13} /> 运行内核 <span className="count">{kernel.length}</span>
            </div>
            {kernel.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} />
            ))}
          </>
        ) : null}

        {note === '' ? null : <div className="plugins-empty">{note}</div>}
        <p className="plugins-empty">
          停用立刻生效，重启宿主后仍是那个状态。插件详情页没搬：`listPlugins` 的回包不带配置分区数据，
          要接得先扩界面通道白名单——这一步记在开发日志的诚实边界里。
        </p>
      </div>
    </div>
  )
}

/** 一张插件卡（旧界面 PluginRow 同构：彩底首字母图标 + 名称/描述 + 开关）。 */
function PluginCard({ row, onToggle }: { row: PluginRow; onToggle: (row: PluginRow) => void }): ReactNode {
  return (
    <div className={`plugin-row${row.enabled ? '' : ' off'}`}>
      <div className="plugin-icon" style={{ background: iconColor(row.name) }}>
        {row.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="plugin-info">
        <div className="plugin-name">{row.name}</div>
        <div className="plugin-desc">{row.description === '' ? `${row.file} · 无描述` : row.description}</div>
      </div>
      <button
        type="button"
        className={`switch${row.enabled ? ' on' : ''}${row.toggleable ? '' : ' locked'}`}
        role="switch"
        aria-checked={row.enabled}
        aria-label={`${row.name} 开关`}
        data-tip={row.toggleable ? (row.enabled ? '停用，即时生效' : '启用，即时生效') : '运行内核的一部分，不可停用'}
        disabled={!row.toggleable}
        onClick={() => {
          if (row.toggleable) onToggle(row)
        }}
      />
    </div>
  )
}

/** 名称 → 稳定的图标底色（旧界面同款小把戏：同一个插件每次都是同一个色）。 */
function iconColor(name: string): string {
  const palette = ['#4c8dff', '#a06bff', '#2fb27c', '#e0a13a', '#e05a5a', '#3ab6c9']
  let hash = 0
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 997
  return palette[hash % palette.length]
}
