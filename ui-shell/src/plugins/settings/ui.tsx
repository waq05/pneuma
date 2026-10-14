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
 *   搬了**模式（预设）**与**模型**（模型只做只读端点 + 选默认模型，增删端点与写 key 被
 *   有意排除），其余给一条**诚实的说明**（说清去哪做、为什么壳里没有），不假装有界面；
 * - **外观**：宿主没有这个分区（那几项只有渲染层消费），照旧桌面端的做法**追加在「通用」分区末尾**。
 *
 * ## 不列的分区（{@link HIDDEN_SECTIONS}）
 *
 * 宿主照旧发着**技能**分区，壳这里不列：技能中心已经是侧栏的独立整页（`plugins/skills`，
 * 与旧桌面端的 `SkillsView` 同构），设置里再摆一份开关是同一个功能的第二个入口（用户要求去掉）。
 * 宿主那份分区留着有据——TUI 的设置浮层与冻结的旧桌面版还在消费同一张分区表。
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
  IconChart,
  IconClose,
  IconGear,
  IconInfo,
  IconLayers,
  IconPhone,
  IconSpark,
} from '@dsc/ui'
import {
  defineUiPlugin,
  getHostNative,
  requestAppearance,
  useHostChannel,
  type AppearancePatch,
  type PairShareData,
  type SettingsField,
  type SettingsMutation,
  type SettingsSectionView,
  type SettingsValue,
  type SettingsValues,
  type UiPrefsView,
} from '@dsc/ui'
import { PresetsGroup } from './presets'
import { ModelsGroup } from './models'
import { UsageGroup } from './usage'
import { ArchiveGroup } from './archive'
import { PairModal, type PairRegenerateResult } from './pair-modal'
// 基元从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，不再内联（E6）。
import { Select } from '@dsc/ui-primitives'

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
 * 壳不列的分区（宿主发着、这里按 id 滤掉）。技能中心已经是侧栏的独立整页
 * （`plugins/skills`），设置里再来一份开关是同一个功能的第二个入口。
 *
 * 只滤这一处（导航与选中项查找都过它），**不动宿主的分区表**：TUI 的设置浮层与冻结的
 * 旧桌面版消费的是同一张表，宿主少一个分区等于悄悄改了另外两个界面。
 */
const HIDDEN_SECTIONS: ReadonlySet<string> = new Set(['skills'])

/**
 * 导航图标：照旧桌面端 `SettingsModal.sectionIcon` 的映射，没列的落回齿轮。
 *
 * 只按分区 id 认，不按标题——标题可改，改标题不该换图标。
 */
function sectionIcon(id: string): ReactNode {
  const size = 15
  if (id === 'models') return <IconSpark size={size} />
  if (id === 'presets') return <IconLayers size={size} />
  if (id === 'archive') return <IconArchive size={size} />
  if (id === 'usage') return <IconChart size={size} />
  if (id === 'remote') return <IconPhone size={size} />
  if (id === 'about') return <IconInfo size={size} />
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
    // 只有面板：齿轮钮在旧界面顶栏并不存在（设置入口在侧栏底部），壳里对齐旧界面——
    // 展开侧栏时走底部「设置」行，收起后 Ctrl+B 展开即可。
    ui.slots.register('shell.header', { id: 'settings.panel', order: 31 }, SettingsPanel)
  },
})

/** 面板本体：遮罩 + 左导航 + 右分区。导航项与字段表都来自宿主。 */
function SettingsPanel(): ReactNode {
  const open = useSettingsOpen()
  const channel = useHostChannel()
  const [sections, setSections] = useState<SettingsSectionView[] | null>(null)
  const [active, setActive] = useState('')
  const [loadError, setLoadError] = useState('')

  // 侧栏的「技能 / 插件 / 设置」入口经事件请它开门：打开面板并跳到指定分区（缺省留在原地）。
  useEffect(() => {
    const onOpen = (event: Event): void => {
      setSettingsOpen(true)
      const section = (event as CustomEvent<{ section?: string }>).detail?.section
      if (typeof section === 'string' && section !== '' && !HIDDEN_SECTIONS.has(section)) setActive(section)
    }
    window.addEventListener('shell.settings.open', onOpen)
    return () => window.removeEventListener('shell.settings.open', onOpen)
  }, [])

  // Esc 关面板（关闭钮的 title 一直这么承诺）。捕获阶段拦下会跟确认框抢键——
  // 确认框自己也在捕获段拦（components 那套移植在 platform/confirm.ts），它先挂先停，
  // 这里用冒泡段就正好排在它后面：确认框开着时 Esc 归它，面板不跟着关。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return
      event.preventDefault()
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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
        setActive((current) => (list.some((item) => item.id === current) ? current : (list[0]?.id ?? '')))
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

  // 导航 = 宿主内置分区（按 order 排好序，宿主已排）**减去 HIDDEN_SECTIONS**。
  // 插件启停不在这里：它是主区的独立整页（侧栏「插件」入口），旧界面同款——设置里不再有合成的插件分区。
  const nav: NavItem[] = (sections ?? [])
    .filter((section) => !HIDDEN_SECTIONS.has(section.id))
    .map((section) => ({
      id: section.id,
      title: section.title,
      subtitle: section.subtitle,
    }))
  const section = (sections ?? []).find((item) => item.id === active && !HIDDEN_SECTIONS.has(item.id))
  const head = nav.find((item) => item.id === active)

  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        // 只有点在遮罩本身上才关（点面板里面不关）。
        if (event.target === event.currentTarget) setSettingsOpen(false)
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-label="Pneuma 设置">
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
          <div className="settings-nav-foot">设置</div>
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
            ) : section === undefined ? (
              <div className="settings-empty">分区加载失败：{loadError === '' ? '未知分区' : loadError}</div>
            ) : section.custom ? (
              section.id === 'presets' ? (
                <PresetsGroup />
              ) : section.id === 'models' ? (
                <ModelsGroup />
              ) : section.id === 'usage' ? (
                <UsageGroup />
              ) : section.id === 'archive' ? (
                <ArchiveGroup />
              ) : (
                <NotYetPanel section={section} />
              )
            ) : (
              // 权限那几项（permissionPreset / policy / reviewer）在宿主侧就是普通 select 字段
              // （见 `src/plugins/settings.ts` 的 general 分区），走这套通用渲染即可，
              // 壳不为它们开特例——所以这一版设置页对新权限契约无改动。
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
  /**
   * 挂着的「手机连接」弹窗：宿主动作带回配对数据时打开，关掉置空。
   * 连触发它的动作名一起记下来——弹窗里的「重新生成」要再调一次同一个动作。
   */
  const [pair, setPair] = useState<{ action: string; data: PairShareData } | null>(null)

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

  /**
   * 把一条链接交给系统浏览器。壳里没有原生桥（浏览器页签 / 远程页）时如实说明去哪做，
   * 不要静默什么都不发生。
   */
  const openExternal = (url: string): void => {
    const native = getHostNative()
    if (!native.available) {
      setNote({ tone: 'error', text: '打开链接要用系统浏览器，只在桌面版里有（浏览器页签里没有这条桥）' })
      return
    }
    void native.invoke('openExternal', [url]).catch((error: unknown) => {
      setNote({ tone: 'error', text: `打开链接失败：${text(error)}` })
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
        // 回执除了 `notice` 还可能带一份结构化载荷，两种各走各的出口：
        //   - 配对码：它是「要一直看得见」的东西，开弹窗画码（一行说明一闪就没了，
        //     用户错过就得重新生成，而重新生成又会作废上一张）；
        //   - 链接（检查更新发现新版）：说明照走行内提示，发布页交给系统浏览器。
        const data = result.data
        if (data?.kind === 'pair-code') {
          setPair({ action, data })
        } else {
          if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
          if (data?.kind === 'url') openExternal(data.url)
        }
        reload()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: `操作失败：${text(error)}` })
      })
  }

  /**
   * 弹窗里再点一次「重新生成」：调同一个宿主动作，把新码交给弹窗原地换上去。
   *
   * 失败只有一种：宿主这一版不返回结构化配对数据（老回执只有一句 notice，或者宿主
   * 明确说不）。这时把原因**写在弹窗里**（弹窗留在原地不关，用户还能再试），不写行内
   * 说明——那份说明长在设置面板底部，此刻正被弹窗盖着，等关掉弹窗才冒出来的旧话只会
   * 让人以为刚刚成功过。
   */
  const regeneratePair = async (action: string): Promise<PairRegenerateResult> => {
    try {
      const result = await channel.invoke<SettingsMutation>('runSettingAction', [section.id, action])
      if (!result.ok) return { ok: false, error: result.error }
      const data = result.data
      if (data?.kind !== 'pair-code') {
        return { ok: false, error: '这一版宿主没有返回配对码内容，请升级后再试' }
      }
      reload()
      return { ok: true, data }
    } catch (error: unknown) {
      return { ok: false, error: `操作失败：${text(error)}` }
    }
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
                  data-tip="在文件管理器中打开"
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
      const listed = current === '' || field.options.some((option) => option.value === current)
      // 派生值（如权限预设的 `custom`）：宿主给了显示名，说明它是「拼出来的状态」而不是
      // 认不出的脏值——这种值选不了，所以这一行置灰只读，别画成能点开的下拉。
      const derivedLabel = field.derivedLabelKey === undefined ? '' : String(values[field.derivedLabelKey] ?? '')
      if (!listed && derivedLabel !== '') {
        return (
          <div className="setting-row" key={field.key}>
            <div className="setting-text">
              <div className="setting-label">{field.label}</div>
              {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
            </div>
            <div className="setting-control">
              <Select
                className="setting-select"
                ariaLabel={field.label}
                value={current}
                displayLabel={derivedLabel}
                disabled
                options={field.options}
                onPick={() => undefined}
              />
            </div>
          </div>
        )
      }
      // 宿主返回了选项外的值也要看得见，不能悄悄显示成第一项。
      const options = listed ? field.options : [...field.options, { value: current, label: `${current} · 未识别` }]
      return (
        <div className="setting-row" key={field.key}>
          <div className="setting-text">
            <div className="setting-label">{field.label}</div>
            {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
          </div>
          <div className="setting-control">
            <Select
              className="setting-select"
              ariaLabel={field.label}
              value={current}
              options={options}
              onPick={(next) => {
                // 选到当前值不提交：下拉里可能混着「派生值」那一条（选它会被宿主拒），
                // 重复选当前项本来也无事可做。
                if (next === current) return
                commit(field.key, next)
              }}
            />
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
      {/* 配对码弹窗：自己 createPortal 挂到 body（面板祖先有 overflow/backdrop-filter），
          所以摆在这儿只借用状态，位置不受这层容器影响。 */}
      {pair === null ? null : (
        <PairModal
          data={pair.data}
          onRegenerate={() => regeneratePair(pair.action)}
          onClose={() => {
            setPair(null)
          }}
        />
      )}
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
   * 写成功后广播 `shell.uiprefs`：消息流那边（折叠档、思考/工具默认态）自己读一次。
   */
  const change = (patch: Partial<Appearance> & Record<string, unknown>): void => {
    if (appearance === null) return
    const next = { ...appearance, ...patch }
    setAppearance(next)
    const appearanceKeys = ['themeMode', 'fontSize', 'density'] as const
    const appearanceOnly = Object.fromEntries(
      Object.entries(patch).filter(([key]) => (appearanceKeys as readonly string[]).includes(key)),
    )
    if (Object.keys(appearanceOnly).length > 0) requestAppearance(appearanceOnly as AppearancePatch)
    void channel
      .invoke('setUiPrefs', [patch])
      .then(() => {
        window.dispatchEvent(new CustomEvent('shell.uiprefs'))
      })
      .catch((error: unknown) => {
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
          <Select
            className="setting-select"
            ariaLabel="主题"
            value={appearance.themeMode}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' },
            ]}
            onPick={(next) => {
              change({ themeMode: next })
            }}
          />
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
          <Select
            className="setting-select"
            ariaLabel="密度"
            value={appearance.density}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'standard', label: '标准' },
              { value: 'roomy', label: '宽松' },
            ]}
            onPick={(next) => {
              change({ density: next })
            }}
          />
        </div>
      </div>
      <div className="settings-group-title">对话折叠</div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">过程折叠程度</div>
          <div className="setting-help">
            定稿的回合把思考与工具调用收得多紧：紧凑=全折；标准=折+实时详情；详细=只折历史回合；完全展开=不折。
          </div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel="过程折叠程度"
            value={appearance.processFold}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'standard', label: '标准' },
              { value: 'detailed', label: '详细' },
              { value: 'verbose', label: '完全展开' },
            ]}
            onPick={(next) => {
              change({ processFold: next })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">定稿的思考行</div>
          <div className="setting-help">跑动中的思考永远展开；这里管已经定稿的那些默认收起还是展开。</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel="定稿的思考行默认态"
            value={appearance.reasoningOpen ? 'open' : 'folded'}
            options={[
              { value: 'folded', label: '默认收起' },
              { value: 'open', label: '默认展开' },
            ]}
            onPick={(next) => {
              change({ reasoningDefaultOpen: next === 'open' })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">工具卡</div>
          <div className="setting-help">工具调用的默认态：只显示一行摘要，还是连参数与结果一起摊开。</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel="工具卡默认态"
            value={appearance.toolOpen ? 'open' : 'folded'}
            options={[
              { value: 'folded', label: '默认收起' },
              { value: 'open', label: '默认展开' },
            ]}
            onPick={(next) => {
              change({ toolDefaultOpen: next === 'open' })
            }}
          />
        </div>
      </div>
      {note === '' ? null : <div className="settings-note error">{note}</div>}
      <div className="settings-note">
        「按钮大小」这条轴已经取消：按钮尺寸改为对齐参考实现的固定档位（见 docs/ui-plugin-parity-plan.md §6）。
      </div>
    </div>
  )
}

/** 面板里那几项的本地形态（归一化的权威在壳的 appearance.ts，这里只为自己画控件）。 */
interface Appearance {
  themeMode: 'dark' | 'light' | 'system'
  fontSize: number
  density: 'compact' | 'standard' | 'roomy'
  /** 过程折叠程度（紧凑/标准/详细/完全展开）——消息流整轮折叠的能力表。 */
  processFold: 'compact' | 'standard' | 'detailed' | 'verbose'
  /** 定稿的思考行默认展开吗。 */
  reasoningOpen: boolean
  /** 工具卡默认展开吗。 */
  toolOpen: boolean
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
    processFold:
      prefs?.processFold === 'compact' || prefs?.processFold === 'detailed' || prefs?.processFold === 'verbose'
        ? prefs.processFold
        : 'standard',
    reasoningOpen: prefs?.reasoningDefaultOpen === true,
    toolOpen: prefs?.toolDefaultOpen === true,
  }
}

/** 插件启停不住设置里：主区有独立整页（`plugins` 插件复制旧界面 PluginsView）。 */

/**
 * 结构化分区（`custom`）里，壳这一版还没手画的那几个：说清**为什么没有**、**去哪做**，
 * 不画一个空壳假装有界面。
 *
 * 六个结构化分区里只有「远程控制」还占位：它需要的宿主方法（远程服务的启停与配对）
 * 一条都不在界面通道白名单里——远程是网络暴露面，这是有意收紧的结果，不是没做完。
 */
const NOT_YET: Readonly<Record<string, string>> = {
  remote: '远程与手机连接的面板还没搬（宿主方法不在界面通道白名单里，要接得先扩白名单）。',
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
