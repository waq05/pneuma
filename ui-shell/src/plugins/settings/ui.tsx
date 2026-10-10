/**
 * 内置插件：设置面板（分区与字段都由宿主声明，壳照着画）。
 *
 * 形态照旧桌面端的设置弹窗（`.settings-mask` → `.settings` → `.settings-nav` + `.settings-main`，
 * 那一整套样式在 `legacy/views.css` 里现成），所以这一版**几乎不用新写样式**。入口是顶栏一颗
 * 齿轮钮；面板自己用 `position: fixed` 的遮罩浮在应用上（插件从哪个槽渲染都不影响 fixed 定位，
 * 所以不必给壳加一个"浮层槽"）。
 *
 * ## 分区从哪来（这一版的核心）
 *
 * 导航与字段渲染表**都来自宿主 `getSettingsSections()`**（只取 `builtin`），壳不硬编分区清单：
 * 宿主加一个内置分区、或某个插件声明 `inSettings`，导航里自动多一项。渲染分三类：
 *
 * - **声明式**（`fields` 非空）：走 {@link GenericFields}，text / number / select / switch /
 *   info / button 六种控件 + `group` 组头，逐条对位旧桌面端的同名组件；
 * - **结构化**（`custom: true`）：模型 / 模式 / 技能 / 归档 / 用量这五个由桌面端手画。这一版
 *   搬了**技能**、**模式（预设）**与**模型**（模型只做只读端点 + 选默认模型，增删端点与写 key 被
 *   有意排除），其余给一条**诚实的说明**（说清去哪做、为什么壳里没有），不假装有界面；
 * - **外观**：宿主没有这个分区（那几项只有渲染层消费），照旧桌面端的做法**追加在「通用」分区末尾**。
 *
 * ## 壳自己加的一项：插件
 *
 * 旧桌面端把插件启停放在**独立的插件中心**（不在设置模态里）。壳里还没有插件中心，这一版
 * 把它并进设置导航（`plugins` 是个壳造的合成分区，宿主没有这个分区）——见 development-log 的诚实边界。
 *
 * 写入口的两条硬边界（与旧界面口径一致，不假装有按钮）：**装技能 / 装插件**要系统文件选择器 +
 * 往 `~/.dsc/` 写文件，属于供应链写入口（`installMarketSkill` / `setMarketSources` 与
 * `saveProvider` / `setProviderKey` 都在界面通道的排除清单里），壳里只说明去哪做。
 *
 * @module dsc-ui-shell/plugins/settings
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  IconArchive,
  IconBolt,
  IconChart,
  IconClose,
  IconGear,
  IconInfo,
  IconLayers,
  IconPhone,
  IconPuzzle,
  IconSpark,
} from '@dsc/ui'
import {
  defineUiPlugin,
  getHostNative,
  requestAppearance,
  useHostChannel,
  type AppearancePatch,
  type SettingsField,
  type SettingsMutation,
  type SettingsSectionView,
  type SettingsValue,
  type SettingsValues,
  type UiPrefsView,
} from '@dsc/ui'
import { PresetsGroup } from './presets'
import { ModelsGroup } from './models'

/** 拿异常的文字形态（宿主与桥都可能抛 Error，也可能是别的值）。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 面板导航里的一项（宿主分区 + 壳自己那项插件，统一成同一个形状）。 */
interface NavItem {
  id: string
  title: string
  subtitle?: string
}

/**
 * 导航图标：照旧桌面端 `SettingsModal.sectionIcon` 的映射，没列的落回齿轮。
 *
 * 只按分区 id 认，不按标题——标题可改，改标题不该换图标。
 */
function sectionIcon(id: string): ReactNode {
  const size = 15
  if (id === 'models') return <IconSpark size={size} />
  if (id === 'presets') return <IconLayers size={size} />
  if (id === 'skills') return <IconBolt size={size} />
  if (id === 'archive') return <IconArchive size={size} />
  if (id === 'usage') return <IconChart size={size} />
  if (id === 'remote') return <IconPhone size={size} />
  if (id === 'about') return <IconInfo size={size} />
  if (id === 'plugins') return <IconPuzzle size={size} />
  return <IconGear size={size} />
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

/** 面板本体：遮罩 + 左导航 + 右分区。导航项与字段表都来自宿主。 */
function SettingsPanel(): ReactNode {
  const open = useSettingsOpen()
  const channel = useHostChannel()
  const [sections, setSections] = useState<SettingsSectionView[] | null>(null)
  const [active, setActive] = useState('')
  const [loadError, setLoadError] = useState('')

  // 每次打开重取分区清单（读者会改插件启停，分区会变）。
  // 插件贡献的分区不进设置：它们的配置就地画在插件中心的详情页里（对照 dsh），
  // 所以这里只取 builtin——与旧桌面端同一条过滤。
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoadError('')
    void channel
      .invoke<SettingsSectionView[]>('getSettingsSections')
      .then((all) => {
        if (!alive) return
        const list = all.filter((section) => section.builtin)
        setSections(list)
        setActive((current) => (list.some((item) => item.id === current) ? current : (list[0]?.id ?? 'plugins')))
      })
      .catch((error: unknown) => {
        if (!alive) return
        setSections([])
        setLoadError(text(error))
      })
    return () => {
      alive = false
    }
  }, [open, channel])

  if (!open) return null

  // 导航 = 宿主内置分区（按 order 排好序，宿主已排）+ 壳自己那项「插件」。
  const nav: NavItem[] = [
    ...(sections ?? []).map((section) => ({ id: section.id, title: section.title, subtitle: section.subtitle })),
    { id: 'plugins', title: '插件', subtitle: '插件的来源与启停（壳把旧界的插件中心并进了设置）' },
  ]
  const section = (sections ?? []).find((item) => item.id === active)
  const head = nav.find((item) => item.id === active)

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
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item${item.id === active ? ' on' : ''}`}
              data-tip={item.subtitle ?? item.title}
              onClick={() => {
                setActive(item.id)
              }}
            >
              {sectionIcon(item.id)}
              <span className="label">{item.title}</span>
            </button>
          ))}
          {sections !== null && sections.length === 0 ? (
            <div className="settings-nav-empty">{loadError === '' ? '宿主没有给出设置分区' : `读分区失败：${loadError}`}</div>
          ) : null}
          <div className="settings-nav-foot">Muse Code 设置 · 改动即时写入 ~/.dsc</div>
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>{head?.title ?? '设置'}</h2>
              {head?.subtitle === undefined ? null : <p>{head.subtitle}</p>}
            </div>
            <button
              type="button"
              className="icon-btn"
              title="关闭设置，快捷键 Esc"
              aria-label="关闭设置"
              onClick={() => {
                setSettingsOpen(false)
              }}
            >
              <IconClose size={16} />
            </button>
          </div>
          <div className="settings-body">
            {active === '' ? (
              <div className="settings-empty">{loadError === '' ? '正在读取分区…' : `分区加载失败：${loadError}`}</div>
            ) : active === 'plugins' ? (
              <PluginsGroup />
            ) : section === undefined ? (
              <div className="settings-empty">分区加载失败：{loadError === '' ? '未知分区' : loadError}</div>
            ) : section.custom ? (
              section.id === 'skills' ? (
                <SkillsGroup />
              ) : section.id === 'presets' ? (
                <PresetsGroup />
              ) : section.id === 'models' ? (
                <ModelsGroup />
              ) : (
                <NotYetPanel section={section} />
              )
            ) : (
              <GenericFields
                key={section.id}
                section={section}
                // 外观只有渲染层消费，宿主没有这个分区——照旧桌面端追加在「通用」分区末尾。
                extra={section.id === 'general' ? <AppearanceRows /> : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 声明式分区：把 `section.fields` 画出来，改动即时写回宿主。
 *
 * 逐条对位旧桌面端 `SettingsModal.GenericFields`（同一套 class、同一条提交时机：
 * 下拉/开关**选了就写**，文本框**失焦或回车才写**——避免边打字边写盘）。差异只有两处，
 * 都记在 development-log：控件的成功/失败回执走分区底部的行内说明（旧界面走全局 Toast），
 * 下拉用原生 `<select>`（旧界面是自绘的 `Select` 组件）。
 */
function GenericFields({ section, extra }: { section: SettingsSectionView; extra?: ReactNode }): ReactNode {
  const channel = useHostChannel()
  const [values, setValues] = useState<SettingsValues>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setDraft({})
    setNote(null)
    let alive = true
    void channel
      .invoke<SettingsValues>('getSectionValues', [section.id])
      .then((next) => {
        if (alive) setValues(next)
      })
      .catch((error: unknown) => {
        if (alive) setNote({ tone: 'error', text: `读取设置失败：${text(error)}` })
      })
    return () => {
      alive = false
    }
  }, [channel, section.id])

  /** 值可能被宿主改写（非法值被夹取），写完回读一次。 */
  const reload = (): void => {
    void channel
      .invoke<SettingsValues>('getSectionValues', [section.id])
      .then(setValues)
      .catch(() => undefined)
  }

  const commit = (key: string, value: SettingsValue): void => {
    setNote(null)
    void channel
      .invoke<SettingsMutation>('setSettingValue', [section.id, key, value])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: `保存失败：${result.error}` })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        reload()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: `保存失败：${text(error)}` })
      })
  }

  const act = (action: string): void => {
    setNote(null)
    void channel
      .invoke<SettingsMutation>('runSettingAction', [section.id, action])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: `操作失败：${result.error}` })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        reload()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: `操作失败：${text(error)}` })
      })
  }

  const render = (field: SettingsField, index: number): ReactNode => {
    if (field.type === 'info') {
      return (
        <div className="setting-row info" key={`info-${String(index)}`}>
          <div className="setting-text">
            {field.label === undefined ? null : <div className="setting-label">{field.label}</div>}
            {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
          </div>
          <div className="setting-info">
            <span className={field.mono === true ? 'mono' : ''}>{field.text}</span>
            {field.copyable === true ? (
              <span className="setting-info-actions">
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(field.text).then(
                      () => {
                        setNote({ tone: 'ok', text: '已复制' })
                      },
                      () => {
                        setNote({ tone: 'error', text: '复制失败，请手动选中' })
                      },
                    )
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="text-btn"
                  data-tip="在文件管理器里打开"
                  onClick={() => {
                    const native = getHostNative()
                    if (!native.available) {
                      setNote({ tone: 'error', text: '用系统程序打开只在桌面版里有（浏览器里没有这条桥）' })
                      return
                    }
                    void native
                      .invoke<string>('openPath', [field.text])
                      .then((problem) => {
                        if (problem !== '') setNote({ tone: 'error', text: `打开失败：${problem}` })
                      })
                      .catch((error: unknown) => {
                        setNote({ tone: 'error', text: `打开失败：${text(error)}` })
                      })
                  }}
                >
                  打开
                </button>
              </span>
            ) : null}
          </div>
        </div>
      )
    }
    if (field.type === 'button') {
      return (
        <div className="setting-row action" key={`btn-${field.action}`}>
          <div className="setting-text">
            {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
          </div>
          <button
            type="button"
            className={field.style === 'ghost' ? 'btn-ghost' : 'btn-primary'}
            onClick={() => {
              act(field.action)
            }}
          >
            {field.label}
          </button>
        </div>
      )
    }
    if (field.type === 'select') {
      const current = String(values[field.key] ?? '')
      // 宿主返回了选项外的值也要看得见，不能悄悄显示成第一项。
      const options =
        current === '' || field.options.some((option) => option.value === current)
          ? field.options
          : [...field.options, { value: current, label: `${current} · 未识别` }]
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-text">
            <div className="setting-label">{field.label}</div>
            {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
          </div>
          <div className="setting-control">
            <select
              className="setting-select"
              aria-label={field.label}
              value={current}
              onChange={(event) => {
                commit(field.key, event.target.value)
              }}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )
    }
    if (field.type === 'switch') {
      const on = values[field.key] === true
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-text">
            <div className="setting-label">{field.label}</div>
            {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
          </div>
          <div className="setting-control">
            <button
              type="button"
              className={`switch${on ? ' on' : ''}`}
              role="switch"
              aria-checked={on}
              aria-label={field.label}
              onClick={() => {
                commit(field.key, !on)
              }}
            />
          </div>
        </div>
      )
    }
    // text / number：失焦或回车才提交，避免边打字边写盘。
    const stored = values[field.key]
    const shown = draft[field.key] ?? (stored === undefined ? '' : String(stored))
    return (
      <div className="setting-row" key={field.key}>
        <div className="setting-text">
          <div className="setting-label">{field.label}</div>
          {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
        </div>
        <div className="setting-control">
          <input
            className={`setting-input${field.type === 'text' && field.mono === true ? ' mono' : ''}`}
            type={field.type === 'number' ? 'number' : 'text'}
            aria-label={field.label}
            value={shown}
            placeholder={field.type === 'text' ? field.placeholder : undefined}
            min={field.type === 'number' ? field.min : undefined}
            max={field.type === 'number' ? field.max : undefined}
            step={field.type === 'number' ? field.step : undefined}
            onChange={(event) => {
              const next = event.target.value
              setDraft((current) => ({ ...current, [field.key]: next }))
            }}
            onBlur={() => {
              const before = stored === undefined ? '' : String(stored)
              if (shown === before) return
              commit(field.key, field.type === 'number' ? Number(shown) : shown)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="settings-fields">
      {section.fields.length === 0 ? <div className="settings-empty">该分区没有可配置项。</div> : null}
      {section.fields.map((field, index) => {
        const group = field.group
        return (
          <Fragment key={field.type === 'info' ? `info-${String(index)}` : field.type === 'button' ? `btn-${field.action}` : field.key}>
            {/* 组头：字段声明了 group 且与上一个不同组时插一行（桌面端不做子页导航，组头收拢就够）。 */}
            {group !== undefined && group !== section.fields[index - 1]?.group ? (
              <div className="settings-group-title">
                {section.groups?.find((entry) => entry.id === group)?.title ?? group}
              </div>
            ) : null}
            {render(field, index)}
          </Fragment>
        )
      })}
      {note === null ? null : <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>}
      {extra}
    </div>
  )
}

/**
 * 外观：主题 / 字号 / 密度三行（改完即时落到 `<html>` 上，与旧界面同一套）。
 *
 * 「按钮大小」那条轴在阶段 5.5 取消了：按钮尺寸改成对齐参考实现的固定档位，
 * 所以这一版没有那一行（旧界面还有）。
 */
function AppearanceRows(): ReactNode {
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
        if (alive) setNote(`读外观失败：${text(error)}`)
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
    requestAppearance(patch)
    void channel.invoke('setUiPrefs', [patch]).catch((error: unknown) => {
      setAppearance(appearance)
      requestAppearance(appearance)
      setNote(`没写进去：${text(error)}`)
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
        if (alive) setNote(`读技能失败：${text(error)}`)
      })
    return () => {
      alive = false
    }
  }, [channel])

  const toggle = (row: SkillRow): void => {
    setRows((current) => current?.map((item) => (item.name === row.name ? { ...item, enabled: !item.enabled } : item)) ?? null)
    void channel.invoke('setSkillEnabled', [row.name, !row.enabled]).catch((error: unknown) => {
      setRows((current) => current?.map((item) => (item.name === row.name ? { ...item, enabled: row.enabled } : item)) ?? null)
      setNote(`没改成功：${text(error)}`)
    })
  }

  if (rows === null) return <div className="settings-empty">{note === '' ? '正在读技能…' : note}</div>
  return (
    <div>
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
                role="switch"
                aria-checked={row.enabled}
                aria-label={`${row.name} 开关`}
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
        if (alive) setNote(`读插件失败：${text(error)}`)
      })
    return () => {
      alive = false
    }
  }, [channel])

  const toggle = (row: PluginRow): void => {
    setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: !item.enabled } : item)) ?? null)
    void channel.invoke('setPluginEnabled', [row.file, !row.enabled]).catch((error: unknown) => {
      setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: row.enabled } : item)) ?? null)
      setNote(`没改成功：${text(error)}`)
    })
  }

  if (rows === null) return <div className="settings-empty">{note === '' ? '正在读插件…' : note}</div>
  return (
    <div>
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
                role="switch"
                aria-checked={row.enabled}
                aria-label={`${row.name} 开关`}
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

/**
 * 结构化分区（`custom`）里，壳这一版还没手画的那几个：说清**为什么没有**、**去哪做**，
 * 不画一个空壳假装有界面。
 *
 * 这五个分区（模型 / 模式 / 技能 / 归档 / 用量）的界面都由桌面端自己画；这一版搬了技能、模式与模型。
 */
const NOT_YET: Readonly<Record<string, string>> = {
  archive:
    '归档会话的恢复在左侧会话栏的「归档」页里已经可用。永久删除（purgeSessions）被有意排除，这里不做。',
  usage: '用量统计的面板还没搬（Token 活动热力图、趋势与模型占比）。',
  remote: '远程与手机连接的面板还没搬。',
}

/** 还没搬的结构化分区：标题 + 一条诚实的说明。 */
function NotYetPanel({ section }: { section: SettingsSectionView }): ReactNode {
  const reason = NOT_YET[section.id] ?? `「${section.title}」这个结构化分区还没在插件壳里搬过来。`
  return (
    <div>
      <div className="settings-group-title">{section.title}</div>
      <div className="settings-note">{reason}</div>
      <div className="settings-note">
        这是切换前还差的能力之一，记在 docs/ui-plugin-parity-plan.md 与 development-log 的诚实边界里。
      </div>
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
