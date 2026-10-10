/**
 * 内置插件：设置面板（外观 / 技能 / 插件三组）。
 *
 * 形态照旧桌面端的设置弹窗（`.settings-mask` → `.settings` → `.settings-nav` +
 * `.settings-main`，那一整套样式在 `legacy/views.css` 里现成），所以这一版**几乎不用新写样式**。
 * 入口是顶栏一颗齿轮钮；面板自己用 `position: fixed` 的遮罩浮在应用上（插件从哪个槽渲染
 * 都不影响 fixed 定位，所以不必给壳加一个"浮层槽"）。
 *
 * ## 只做了三组（写在 development-log 的诚实边界里）
 *
 * 旧设置的八个分区里，这一版做**外观**（主题 / 字号 / 密度）、**技能**（列表 + 开关）、
 * **插件**（列表 + 启停）。**模型与服务**（改端点要写 API key——`setProviderKey` 与
 * `saveProvider` 在界面通道的排除清单里，正是为这件事）、**预设详情**、**关于**、
 * **记忆 / 钩子 / 队友**这些分区还没搬。
 *
 * 「装技能 / 装插件」也**故意没有按钮**：那两个动作是系统文件选择器 + 复制进 `~/.dsc/`，
 * 属于供应链写入口（界面通道与原生桥都排除它们），所以这里只**说明去哪做**，不假装有按钮。
 *
 * @module dsc-ui-shell/plugins/settings
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  IconGear,
  IconPuzzle,
  IconSpark,
  IconClose,
} from '@dsc/ui'
import {
  defineUiPlugin,
  requestAppearance,
  useHostChannel,
  type AppearancePatch,
  type UiPrefsView,
} from '@dsc/ui'

/** 面板里那三项的本地形态（归一化的权威在壳的 appearance.ts，这里只为自己画控件）。 */
interface Appearance {
  themeMode: 'dark' | 'light' | 'system'
  fontSize: number
  density: 'compact' | 'standard' | 'roomy'
}

/**
 * 把宿主回读的偏好归一成这一份。
 *
 * 为什么在这里再归一一次、而不 import 壳的 `appearance.ts`：那个模块被插件 bundle 内联
 * 一份就会多出一组模块级状态（见 plugin-api 里 `requestAppearance` 的注释）。
 * 归一规则很短（三档枚举 + 字号夹取），重复这一小段比多一个 applier 划算。
 */
function normalizePrefs(prefs: Partial<UiPrefsView> | null | undefined): Appearance {
  const raw = prefs?.fontSize
  const size = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1
  const legacy: Record<string, number> = { sm: 0.92, md: 1, lg: 1.12 }
  const fromLegacy = typeof raw === 'string' ? legacy[raw] : undefined
  const second = fromLegacy ?? size
  return {
    themeMode: prefs?.themeMode === 'light' || prefs?.themeMode === 'system' ? prefs.themeMode : 'dark',
    fontSize: Math.min(1.35, Math.max(0.85, Math.round(second * 100) / 100)),
    density: prefs?.density === 'compact' || prefs?.density === 'roomy' ? prefs.density : 'standard',
  }
}

/** 技能条目（宿主 `listSkills` 的形状，只取这一版用得上的字段）。 */
interface SkillRow {
  name: string
  description: string
  source: string
  enabled: boolean
  /** false = 由插件注册、不可启停。 */
  toggleable?: boolean
}

/** 插件条目（宿主 `listPlugins` 的形状）。 */
interface PluginRow {
  file: string
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'external'
  toggleable: boolean
}

/** 面板的开合（模块级：入口钮与面板是两个槽条目，得共享同一份状态）。 */
let settingsOpen = false
const listeners = new Set<() => void>()
function setSettingsOpen(next: boolean): void {
  if (next === settingsOpen) return
  settingsOpen = next
  for (const listener of listeners) listener()
}

export default defineUiPlugin({
  name: '设置',
  apply(ui) {
    ui.slots.register('shell.header', { id: 'settings.open', order: 30 }, SettingsButton)
    ui.slots.register('shell.header', { id: 'settings.panel', order: 31 }, SettingsPanel)
  },
})

/** 顶栏那颗齿轮。 */
function SettingsButton(): ReactNode {
  const open = useSettingsOpen()
  return (
    <button
      type="button"
      className={`icon-btn${open ? ' on' : ''}`}
      title="设置"
      aria-label="设置"
      aria-pressed={open}
      onClick={() => {
        setSettingsOpen(!open)
      }}
    >
      <IconGear size={16} />
    </button>
  )
}

/** 面板本体：遮罩 + 左导航 + 右分区。 */
function SettingsPanel(): ReactNode {
  const open = useSettingsOpen()
  const [tab, setTab] = useState<'appearance' | 'skills' | 'plugins'>('appearance')
  if (!open) return null
  const groups: { id: typeof tab; label: string; icon: ReactNode }[] = [
    { id: 'appearance', label: '外观', icon: <IconSpark size={15} /> },
    { id: 'skills', label: '技能', icon: <IconSpark size={15} /> },
    { id: 'plugins', label: '插件', icon: <IconPuzzle size={15} /> },
  ]
  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        // 只有点在遮罩本身上才关（点面板里面不关）。
        if (event.target === event.currentTarget) setSettingsOpen(false)
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-label="Muse Code 设置">
        <nav className="settings-nav">
          <div className="settings-nav-head">设置</div>
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`settings-nav-item${group.id === tab ? ' on' : ''}`}
              onClick={() => {
                setTab(group.id)
              }}
            >
              {group.icon}
              {group.label}
            </button>
          ))}
          <div className="settings-nav-foot">Muse Code 设置 · 改动即时写入 ~/.dsc</div>
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <h2>{groups.find((group) => group.id === tab)?.label ?? ''}</h2>
            <button
              type="button"
              className="icon-btn"
              title="关闭设置"
              aria-label="关闭设置"
              onClick={() => {
                setSettingsOpen(false)
              }}
            >
              <IconClose size={16} />
            </button>
          </div>
          <div className="settings-body">
            {tab === 'appearance' ? <AppearanceGroup /> : null}
            {tab === 'skills' ? <SkillsGroup /> : null}
            {tab === 'plugins' ? <PluginsGroup /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 外观：主题 / 字号 / 密度三行（改完即时落到 `<html>` 上，与旧界面同一套）。 */
function AppearanceGroup(): ReactNode {
  const channel = useHostChannel()
  const [appearance, setAppearance] = useState<Appearance | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    void channel
      .invoke<UiPrefsView>('getUiPrefs')
      .then((prefs) => {
        if (alive) setAppearance(normalizePrefs(prefs))
      })
      .catch((error: unknown) => {
        if (alive) setNote(`读外观失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      alive = false
    }
  }, [channel])

  /**
   * 改一项：**先落到界面上再写宿主**——外观是"跟手"的设置，等写入回来才变会有一顿。
   * 写失败就回滚显示并说明原因（不能显示成一个没生效的值）。
   */
  const change = (patch: AppearancePatch): void => {
    if (appearance === null) return
    const next = { ...appearance, ...patch }
    setAppearance(next)
    // 先让界面跟手（壳里的 applier 立刻落到 <html> 上），再写宿主；失败就回滚显示。
    requestAppearance(patch)
    void channel.invoke('setUiPrefs', [patch]).catch((error: unknown) => {
      setAppearance(appearance)
      requestAppearance(appearance)
      setNote(`没写进去：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (appearance === null) return <div className="settings-empty">{note === '' ? '正在读外观…' : note}</div>
  const fontPercent = Math.round(appearance.fontSize * 100)
  return (
    <div className="settings-appearance">
      <div className="settings-group-title">外观</div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">主题</div>
          <div className="setting-help">「跟随系统」随系统的深浅自动切换。</div>
        </div>
        <div className="setting-control">
          <select
            className="shell-select"
            aria-label="主题"
            value={appearance.themeMode}
            onChange={(event) => {
              change({ themeMode: event.target.value as Appearance['themeMode'] })
            }}
          >
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="system">跟随系统</option>
          </select>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">字号</div>
          <div className="setting-help">正文 13px 为基准，可放大或缩小。</div>
        </div>
        <div className="setting-control">
          <input
            className="font-scale-range"
            type="range"
            aria-label="字号"
            min={85}
            max={135}
            step={1}
            value={fontPercent}
            onChange={(event) => {
              change({ fontSize: Number(event.target.value) / 100 })
            }}
          />
          <span className="font-scale-value">{fontPercent}%</span>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">密度</div>
          <div className="setting-help">行高与纵向间距的整体松紧。</div>
        </div>
        <div className="setting-control">
          <select
            className="shell-select"
            aria-label="密度"
            value={appearance.density}
            onChange={(event) => {
              change({ density: event.target.value as Appearance['density'] })
            }}
          >
            <option value="compact">紧凑</option>
            <option value="standard">标准</option>
            <option value="roomy">宽松</option>
          </select>
        </div>
      </div>
      {note === '' ? null : <div className="settings-note error">{note}</div>}
      <div className="settings-note">
        「按钮大小」这条轴已经取消：按钮尺寸改为对齐参考实现的固定档位（见 docs/ui-plugin-parity-plan.md §6）。
      </div>
    </div>
  )
}

/** 技能：列出来 + 拨开关（`setSkillEnabled` 真的生效，重启宿主后仍是那个状态）。 */
function SkillsGroup(): ReactNode {
  const channel = useHostChannel()
  const [rows, setRows] = useState<SkillRow[] | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    void channel
      .invoke<SkillRow[]>('listSkills')
      .then((list) => {
        if (alive) setRows(list)
      })
      .catch((error: unknown) => {
        if (alive) setNote(`读技能失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      alive = false
    }
  }, [channel])

  const toggle = (row: SkillRow): void => {
    setRows((current) => current?.map((item) => (item.name === row.name ? { ...item, enabled: !item.enabled } : item)) ?? null)
    void channel.invoke('setSkillEnabled', [row.name, !row.enabled]).catch((error: unknown) => {
      setRows((current) => current?.map((item) => (item.name === row.name ? { ...item, enabled: row.enabled } : item)) ?? null)
      setNote(`没改成功：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (rows === null) return <div className="settings-empty">{note === '' ? '正在读技能…' : note}</div>
  return (
    <div>
      <div className="settings-group-title">技能</div>
      {rows.length === 0 ? <div className="settings-empty">还没有技能。</div> : null}
      {rows.map((row) => (
        <div className="setting-row" key={row.name}>
          <div className="setting-text">
            <div className="setting-label">{row.name}</div>
            <div className="setting-help">{row.description === '' ? row.source : row.description}</div>
          </div>
          <div className="setting-control">
            {row.toggleable === false ? (
              <span className="settings-note">由插件提供，不可单独启停</span>
            ) : (
              <button
                type="button"
                className={`switch${row.enabled ? ' on' : ''}`}
                aria-label={`${row.name} 开关`}
                aria-pressed={row.enabled}
                onClick={() => {
                  toggle(row)
                }}
              />
            )}
          </div>
        </div>
      ))}
      <div className="settings-note">
        装技能不在界面里做：它是系统文件选择器 + 复制进 <code>~/.dsc/skills/</code> 的写入口，
        界面通道与原生桥都（有意地）没有放行。要在桌面端装，请用旧界面或设置里的那条入口；
        命令行可以用 <code>msc</code> 的相关指令。
      </div>
      {note === '' ? null : <div className="settings-note error">{note}</div>}
    </div>
  )
}

/** 插件：列出来 + 启停（内置不可停用的那几档画成说明，不给假开关）。 */
function PluginsGroup(): ReactNode {
  const channel = useHostChannel()
  const [rows, setRows] = useState<PluginRow[] | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    void channel
      .invoke<PluginRow[]>('listPlugins')
      .then((list) => {
        if (alive) setRows(list)
      })
      .catch((error: unknown) => {
        if (alive) setNote(`读插件失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      alive = false
    }
  }, [channel])

  const toggle = (row: PluginRow): void => {
    setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: !item.enabled } : item)) ?? null)
    void channel.invoke('setPluginEnabled', [row.file, !row.enabled]).catch((error: unknown) => {
      setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: row.enabled } : item)) ?? null)
      setNote(`没改成功：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (rows === null) return <div className="settings-empty">{note === '' ? '正在读插件…' : note}</div>
  return (
    <div>
      <div className="settings-group-title">插件</div>
      {rows.map((row) => (
        <div className="setting-row" key={row.file}>
          <div className="setting-text">
            <div className="setting-label">{row.name}</div>
            <div className="setting-help">{row.description === '' ? row.file : row.description}</div>
          </div>
          <div className="setting-control">
            {row.toggleable ? (
              <button
                type="button"
                className={`switch${row.enabled ? ' on' : ''}`}
                aria-label={`${row.name} 开关`}
                aria-pressed={row.enabled}
                onClick={() => {
                  toggle(row)
                }}
              />
            ) : (
              <span className="settings-note">内核插件，不可停用</span>
            )}
          </div>
        </div>
      ))}
      <div className="settings-note">
        装插件同样不在界面里做（与装技能同一个理由）。停用插件立刻生效，重启宿主后仍是那个状态。
      </div>
      {note === '' ? null : <div className="settings-note error">{note}</div>}
    </div>
  )
}

/** 面板开合的订阅（两个槽条目共用这一份）。 */
function useSettingsOpen(): boolean {
  const [open, setOpen] = useState(settingsOpen)
  useEffect(() => {
    const listener = (): void => {
      setOpen(settingsOpen)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return open
}
