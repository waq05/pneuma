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
 * ## 并进别的页的分区（{@link EmbeddedSection} 与分区的 `parent`）
 *
 * 分区声明了 `parent` 就**不单独占导航**：父页末尾按 order 把它整块画出来，自带标题与
 * 说明，与父页原本的内容用一条发丝线隔开（「终端环境」并进「通用」就是这么来的）。
 * 判定只认宿主给的声明和父分区是否存在，壳里不出现「终端环境」「tools-default」这类
 * 具体名字；读、写、按钮动作仍按子分区自己的 id 走，所以与它单独成页逐项等价。
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
import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconArchive,
  IconChart,
  IconClose,
  IconGear,
  IconInfo,
  IconLayers,
  IconPhone,
  IconSpark,
  createT,
} from '@dsc/ui'
import {
  ACTIONS_SERVICE,
  createSignal,
  defineUiPlugin,
  getHostNative,
  requestAppearance,
  useHostChannel,
  useService,
  type ActionsHandle,
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
import {
  COMPLETION_SOUND_VARIANTS,
  Select,
  Skeleton,
  SkeletonText,
  errText as text,
  humanErrorText,
  playCompletionSound,
  useDialogFocus,
} from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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
 * 被并进父页的分区（父页 id → 子分区，按宿主给的 order 先后）。
 *
 * 只认两件事：分区声明了 `parent`、且那个父分区确实在清单里。父分区不存在（被停用或删掉）
 * 就退回独立分区——不能因为一条悬空的 parent 把内容藏进一个不存在的页。成环（A→B→A）
 * 同样退回独立分区：宁可多一格导航，也不让内容消失。
 */
function embeddedByPage(all: SettingsSectionView[]): Map<string, SettingsSectionView[]> {
  const byId = new Map(all.map((section) => [section.id, section]))
  const pages = new Map<string, SettingsSectionView[]>()
  for (const section of all) {
    if (section.parent === undefined) continue
    const page = pageOf(byId, section.id)
    if (page === section.id) continue
    const list = pages.get(page)
    if (list === undefined) pages.set(page, [section])
    else list.push(section)
  }
  return pages
}

/** 沿 parent 链走到最上面那一页；链断了或成环就停住（停在谁身上就由谁显示）。 */
function pageOf(byId: ReadonlyMap<string, SettingsSectionView>, id: string): string {
  let current = byId.get(id)
  const seen = new Set<string>()
  while (current !== undefined && current.parent !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parent)
    if (parent === undefined) break
    current = parent
  }
  return current?.id ?? id
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
  if (id === 'archive') return <IconArchive size={size} />
  if (id === 'usage') return <IconChart size={size} />
  if (id === 'remote') return <IconPhone size={size} />
  if (id === 'about') return <IconInfo size={size} />
  return <IconGear size={size} />
}

/** 面板的开合（模块级：入口钮与面板是两个槽条目，得共享同一份状态）。 */
const settingsOpen = createSignal(false)
function setSettingsOpen(next: boolean): void {
  settingsOpen.set(next)
}

export default defineUiPlugin({
  name: t('settings.app.title'),
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
  // 弹层焦点：打开移进来、Tab 在面板内循环、Esc 关、关掉还回来源（原来只有 Esc）。
  const dialog = useDialogFocus(open, () => {
    setSettingsOpen(false)
  })

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

  /**
   * 取一次分区清单（含各分区的字段）。
   *
   * 什么时候取：打开设置面板时（读者会改插件启停，分区会变），以及**换过配置文件之后**
   * ——那一行的路径与「恢复默认」按钮都随活动配置变，不重取的话用户会看到换完还是老路径。
   */
  const loadSections = useCallback((): void => {
    setLoadError('')
    void channel
      .invoke<SettingsSectionView[]>('getSettingsSections')
      .then((all) => {
        const list = all.filter((section) => section.builtin)
        setSections(list)
        setActive((current) => (list.some((item) => item.id === current) ? current : (list[0]?.id ?? '')))
      })
      .catch((error: unknown) => {
        setSections([])
        setLoadError(humanErrorText(error).text)
      })
  }, [channel])

  // 每次打开重取分区清单（读者会改插件启停，分区会变）。
  // 插件贡献的分区不进设置：它们的配置就地画在插件中心的详情页里（对照 dsh），
  // 所以这里只取 builtin——与旧桌面端同一条过滤。
  useEffect(() => {
    if (!open) return
    loadSections()
  }, [open, loadSections])

  // 分区清单常驻取一次：命令面板要列「设置 · 通用」这些跳转，用户还没开过设置也得有。
  // 只补第一次（sections === null），之后的刷新仍归上面那条「每次打开重取」。
  useEffect(() => {
    if (sections === null) loadSections()
  }, [sections, loadSections])

  const byId = useMemo(() => new Map((sections ?? []).map((section) => [section.id, section])), [sections])
  // 并进父页的分区不再单独占导航：它们的内容由父页那一段整块画出来。
  const pages = useMemo(() => embeddedByPage(sections ?? []), [sections])
  // 导航 = 宿主内置分区（按 order 排好序，宿主已排）**减去 HIDDEN_SECTIONS**，
  // 再减去「并进父页」的分区（parent 指的页不存在时它仍算独立分区，不会被藏掉）。
  // 插件启停不在这里：它是主区的独立整页（侧栏「插件」入口），旧界面同款——设置里不再有合成的插件分区。
  // 提到提前 return 之前：命令面板的动作登记也用这份清单，两处共用一个口径。
  const nav = useMemo<NavItem[]>(
    () =>
      (sections ?? [])
        .filter((section) => !HIDDEN_SECTIONS.has(section.id))
        .filter((section) => pageOf(byId, section.id) === section.id)
        .map((section) => ({ id: section.id, title: section.title, subtitle: section.subtitle })),
    [byId, sections],
  )

  // 每个分区登记一条动作（动作表见 @dsc/ui 的 UiAction）：设置页的跳转目标由设置自己
  // 声明，命令面板不再手抄一份分区表——宿主多一个分区，面板自动多一行。
  const actions = useService<ActionsHandle>(ACTIONS_SERVICE)
  useEffect(() => {
    if (actions === undefined || sections === null) return undefined
    return actions.register(
      'settings',
      nav.map((item) => ({
        id: `settings.${item.id}`,
        label: t('settings.ui.jumpLabel', { title: item.title }),
        ...(item.subtitle === undefined ? {} : { hint: item.subtitle }),
        group: t('settings.ui.group'),
        keywords: [t('settings.app.title'), 'settings', item.id],
        run: () => {
          setActive(item.id)
          setSettingsOpen(true)
        },
      })),
    )
  }, [actions, nav, sections])

  if (!open) return null

  // active 可能指到一个「并进父页」的分区（命令面板或侧栏事件带过来的历史 id）：
  // 先按清单找到它，再沿 parent 链落到真正要画的那一页。
  const picked = (sections ?? []).find((item) => item.id === active && !HIDDEN_SECTIONS.has(item.id))
  const pageId = picked === undefined ? '' : pageOf(byId, picked.id)
  const section = picked === undefined ? undefined : byId.get(pageId)
  const head = nav.find((item) => item.id === pageId)

  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        // 只有点在遮罩本身上才关（点面板里面不关）。
        if (event.target === event.currentTarget) setSettingsOpen(false)
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-label={t('settings.ui.dialogAria')} ref={dialog.ref}>
        <nav className="settings-nav">
          <div className="settings-nav-head">{t('settings.app.title')}</div>
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item${item.id === pageId ? ' on' : ''}`}
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
            <div className="settings-nav-empty">{loadError === '' ? t('settings.ui.noSections') : t('settings.ui.sectionsFailed', { message: loadError })}</div>
          ) : null}
          <div className="settings-nav-foot">{t('settings.app.title')}</div>
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>{head?.title ?? t('settings.app.title')}</h2>
              {head?.subtitle === undefined ? null : <p>{head.subtitle}</p>}
            </div>
            <button
              type="button"
              className="icon-btn"
              title={t('settings.ui.closeTip')}
              aria-label={t('settings.ui.close')}
              onClick={() => {
                setSettingsOpen(false)
              }}
            >
              <IconClose size={16} />
            </button>
          </div>
          {/* 模型分区要的是「两栏各自滚」（左端点列表 + 右详情，见 legacy/views.css 的
              模型分区那一段）：给正文加一个 fill 类，取消整页滚动、让子元素吃满高度。
              其余分区照旧从上往下堆、整页滚。 */}
          <div className={`settings-body${pageId === 'models' ? ' settings-body-fill' : ''}`}>
            {active === '' ? (
              loadError === '' ? (
                // 数据还没回来：画骨架而不是一行灰字（P0-2）。高度按真实分区估：
                // 标题 + 一句副标题 + 两组字段，读完不会"先缩后弹"。
                <div className="settings-loading" role="status" aria-label={t('settings.ui.loadingAria')}>
                  <div className="settings-loading-head">
                    <Skeleton width={168} height={17} radius={5} />
                    <Skeleton width={300} height={11} />
                  </div>
                  <SkeletonText lines={4} />
                  <SkeletonText lines={2} widths={['100%', '48%']} />
                </div>
              ) : (
                <div className="settings-empty">{t('settings.ui.sectionsFailed', { message: loadError })}</div>
              )
            ) : section === undefined ? (
              <div className="settings-empty">{t('settings.ui.sectionsFailed', { message: loadError === '' ? t('settings.ui.unknownSection') : loadError })}</div>
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
                onConfigFileChanged={loadSections}
                extra={
                  <>
                    {/* 外观只有渲染层消费，宿主没有这个分区——照旧桌面端追加在「通用」分区末尾。 */}
                    {section.id === 'general' ? <AppearanceRows /> : null}
                    {/* 并进这一页的分区：壳只认宿主声明，不认得具体是哪个插件。
                        写回之后重取一次分区清单——检测结果这类由 fields() 现算的内容要跟着刷新。 */}
                    {(pages.get(section.id) ?? []).map((child) => (
                      <EmbeddedSection key={child.id} section={child} onChanged={loadSections} />
                    ))}
                  </>
                }
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
function GenericFields({
  section,
  extra,
  onChanged,
  onConfigFileChanged,
}: {
  section: SettingsSectionView
  extra?: ReactNode
  /**
   * 保存或按钮动作成功后调一次。并进父页的分区用它重取分区清单：
   * 「检测结果」这类内容住在 fields() 里（每次投影现算），不重取就还是旧的那一行。
   */
  onChanged?(): void
  /** 换过配置文件之后调一次：那一行的路径与「恢复默认」按钮都随活动配置变，得重取分区清单。 */
  onConfigFileChanged?(): void
}): ReactNode {
  const channel = useHostChannel()
  const [values, setValues] = useState<SettingsValues>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  /**
   * 刚查到的那一版（非空 = 能就地装）：在说明旁边给一颗「立即更新」。
   * 只在这一屏有效——关掉设置面板再打开，那颗按钮就没了（那时看品牌行那颗）。
   */
  const [updateReady, setUpdateReady] = useState('')
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
        if (alive) setNote({ tone: 'error', text: t('settings.ui.loadFailed', { message: text(error) }) })
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
          setNote({ tone: 'error', text: t('settings.ui.saveFailed', { message: result.error }) })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        reload()
        onChanged?.()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('settings.ui.saveFailed', { message: text(error) }) })
      })
  }

  /**
   * 把一条链接交给系统浏览器。壳里没有原生桥（浏览器页签 / 远程页）时如实说明去哪做，
   * 不要静默什么都不发生。
   */
  const openExternal = (url: string): void => {
    const native = getHostNative()
    if (!native.available) {
      setNote({ tone: 'error', text: t('settings.ui.openLinkNoBridge') })
      return
    }
    void native.invoke('openExternal', [url]).catch((error: unknown) => {
      setNote({ tone: 'error', text: t('settings.ui.openLinkFailed', { message: text(error) }) })
    })
  }

  const act = (action: string): void => {
    setNote(null)
    setUpdateReady('')
    void channel
      .invoke<SettingsMutation>('runSettingAction', [section.id, action])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('settings.ui.opFailed', { message: result.error }) })
          return
        }
        // 回执除了 `notice` 还可能带一份结构化载荷，三种各走各的出口：
        //   - 配对码：它是「要一直看得见」的东西，开弹窗画码（一行说明一闪就没了，
        //     用户错过就得重新生成，而重新生成又会作废上一张）；
        //   - 新版可装：说明走行内提示，旁边就地给一颗「立即更新」（下载与安装由桌面
        //     主进程做，见 ui-layout/update-button.tsx 与 desktop/electron/main/update.ts）；
        //   - 只有发布页（挑不出安装器）：说明照走，页面交给系统浏览器。
        const data = result.data
        if (data?.kind === 'pair-code') {
          setPair({ action, data })
        } else {
          if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
          if (data?.kind === 'url') openExternal(data.url)
          if (data?.kind === 'update') setUpdateReady(data.version)
        }
        reload()
        onChanged?.()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('settings.ui.opFailed', { message: text(error) }) })
      })
  }

  /**
   * 换一份配置文件用（设置 → 通用「配置文件」那一行的「更换」/「恢复默认」）。
   *
   * 两步都是原生桥上的活：先弹系统文件对话框拿路径（用户取消就什么都不做），再让宿主
   * 把这条路径设为活动配置（宿主会校验：绝对路径 / 读得了 / 是能解析的 YAML / 有 providers，
   * 不过就拒绝并给出原因）。成功之后**重取分区清单**——那一行显示的路径与「恢复默认」
   * 按钮都随活动配置变，不重取的话用户会看到换完还是老路径。
   *
   * @param reset true = 回出厂那份（不弹对话框，直接送空串）
   */
  const switchConfigFile = async (reset: boolean): Promise<void> => {
    const native = getHostNative()
    if (!native.available) {
      setNote({ tone: 'error', text: t('settings.ui.configNoBridge') })
      return
    }
    setNote(null)
    try {
      let path = ''
      if (!reset) {
        path = await native.invoke<string>('pickConfigFile', [])
        if (path === '') return
      }
      const result = await native.invoke<SettingsMutation>('setConfigFile', [path])
      if (!result.ok) {
        setNote({ tone: 'error', text: t('settings.ui.configFailed', { message: result.error ?? t('settings.ui.unknownReason') }) })
        return
      }
      setNote({ tone: 'ok', text: result.notice ?? t('settings.ui.configSwitched') })
      onConfigFileChanged?.()
    } catch (error: unknown) {
      setNote({ tone: 'error', text: t('settings.ui.configFailed', { message: text(error) }) })
    }
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
        return { ok: false, error: t('settings.ui.pairUnavailable') }
      }
      reload()
      return { ok: true, data }
    } catch (error: unknown) {
      return { ok: false, error: t('settings.ui.opFailed', { message: text(error) }) }
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
                        setNote({ tone: 'ok', text: t('settings.ui.copied') })
                      },
                      () => {
                        setNote({ tone: 'error', text: t('settings.ui.copyFailed') })
                      },
                    )
                  }}
                >
                  {t('settings.ui.copy')}
                </button>
                <button
                  type="button"
                  className="text-btn"
                  data-tip={t('settings.ui.openInManager')}
                  onClick={() => {
                    const native = getHostNative()
                    if (!native.available) {
                      setNote({ tone: 'error', text: t('settings.ui.openPathNoBridge') })
                      return
                    }
                    void native
                      .invoke<string>('openPath', [field.text])
                      .then((problem) => {
                        if (problem !== '') setNote({ tone: 'error', text: t('settings.ui.openFailed', { message: problem }) })
                      })
                      .catch((error: unknown) => {
                        setNote({ tone: 'error', text: t('settings.ui.openFailed', { message: text(error) }) })
                      })
                  }}
                >
                  {t('settings.ui.open')}
                </button>
                {/*
                  宿主在信息行上声明的行内动作（现在只有「更换配置文件」与它的「恢复默认」）。
                  只画壳认得的 id：认不出的整条跳过——旧壳遇到新宿主多声明的动作时不会画出
                  一颗点不动的按钮。动作要开系统文件对话框，所以就地处理，不走宿主动作表。
                */}
                {field.actions?.map((action) => {
                  if (action.id !== 'switch-config-file' && action.id !== 'reset-config-file') return null
                  return (
                    <button
                      key={action.id}
                      type="button"
                      className="text-btn"
                      data-tip={action.tip}
                      onClick={() => {
                        void switchConfigFile(action.id === 'reset-config-file')
                      }}
                    >
                      {action.label}
                    </button>
                  )
                })}
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
      const options = listed ? field.options : [...field.options, { value: current, label: t('settings.ui.unknownOption', { value: current }) }]
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
      {section.fields.length === 0 ? <div className="settings-empty">{t('settings.ui.emptySection')}</div> : null}
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
      {/* 查到能就地装的新版：说明旁边就地给一颗「立即更新」。点下去是桌面主进程去下载、
          起安装程序、退出应用——壳这边只报「装」这个意图（见 update-button.tsx 的说明）。 */}
      {updateReady === '' ? null : (
        <div className="settings-note">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setUpdateReady('')
              const native = getHostNative()
              if (!native.available) {
                setNote({ tone: 'error', text: t('settings.ui.updateNoBridge') })
                return
              }
              setNote({ tone: 'ok', text: t('settings.ui.updateDownloading', { version: updateReady }) })
              void native.invoke<{ ok: boolean; error?: string }>('installUpdate').then((result) => {
                if (!result.ok) setNote({ tone: 'error', text: t('settings.ui.updateFailed', { message: result.error ?? t('settings.ui.unknownReason') }) })
              })
            }}
          >
            {t('settings.ui.updateNow')}
          </button>
        </div>
      )}
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
 * 并进父页的一个分区（分区的 `parent` 指名）：小标题 + 一句说明 + 它自己的全部控件。
 *
 * 为什么要它：「终端环境」这类只有三两个控件的分区没必要单占一格左导航，但内容不能缩水。
 * 这一块与它单独成页时逐项等价——读、写、按钮动作都按**子分区自己的 id** 走
 * （getSectionValues / setSettingValue / runSettingAction），父页不必知道是哪个插件贡献的，
 * 壳里也没有「终端环境」「tools-default」这类硬编分支。
 */
function EmbeddedSection({ section, onChanged }: { section: SettingsSectionView; onChanged(): void }): ReactNode {
  return (
    <div
      className="settings-embedded"
      data-section={section.id}
      /* 一条发丝线把这一节与父页原本的内容分开。样式表归渲染层，这里就地用同一套主题变量。 */
      style={{ borderTop: '1px solid var(--dsc-stroke-4)', marginTop: 12, paddingTop: 2 }}
    >
      <div className="settings-group-title">{section.title}</div>
      {section.subtitle === undefined ? null : (
        <p
          style={{
            color: 'var(--dsc-text-tertiary)',
            fontSize: 'var(--dsc-fs-caption)',
            margin: '0 2px 6px',
          }}
        >
          {section.subtitle}
        </p>
      )}
      <GenericFields section={section} onChanged={onChanged} />
    </div>
  )
}

/**
 * 主题四档（顺序按「由浅到深再跟随」）：浅色、Claude（暖米白，见 tokens.css 那一块）、
 * 深色、跟随系统。
 */
const THEME_TILES = [
  { value: 'light', label: t('settings.ui.theme.light') },
  { value: 'claude', label: 'Claude' },
  { value: 'dark', label: t('settings.ui.theme.dark') },
  { value: 'system', label: t('settings.ui.theme.system') },
] as const

/**
 * 提醒音的音色下拉：名字直接取发声参数表那一份（`COMPLETION_SOUND_VARIANTS` 的 `name`），
 * 不另抄一张表——加一个音色只改发声模块，设置页跟着多一项。
 */
const SOUND_VARIANT_OPTIONS = COMPLETION_SOUND_VARIANTS.map((variant) => ({
  value: String(variant.id),
  label: variant.name,
}))

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
        if (alive) setNote(t('settings.ui.appearanceFailed', { message: text(error) }))
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
        setNote(t('settings.ui.writeFailed', { message: text(error) }))
      })
  }

  if (appearance === null) return <div className="settings-empty">{note === '' ? t('settings.ui.appearanceLoading') : note}</div>
  const fontPercent = Math.round(appearance.fontSize * 100)
  return (
    <div className="settings-appearance">
      <div className="settings-group-title">{t('settings.ui.appearance')}</div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.theme')}</div>
          <div className="setting-help">{t('settings.ui.themeHelp')}</div>
        </div>
        <div className="setting-control theme-tiles" role="radiogroup" aria-label={t('settings.ui.theme')}>
          {THEME_TILES.map((tile) => (
            <button
              key={tile.value}
              type="button"
              role="radio"
              aria-checked={appearance.themeMode === tile.value}
              className="theme-tile"
              onClick={() => {
                change({ themeMode: tile.value })
              }}
            >
              {tile.label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.fontSize')}</div>
          <div className="setting-help">{t('settings.ui.fontSizeHelp')}</div>
        </div>
        <div className="setting-control">
          <input
            className="font-scale-range"
            type="range"
            aria-label={t('settings.ui.fontSize')}
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
          <div className="setting-label">{t('settings.ui.density')}</div>
          <div className="setting-help">{t('settings.ui.densityHelp')}</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.density')}
            value={appearance.density}
            options={[
              { value: 'compact', label: t('settings.ui.option.compact') },
              { value: 'standard', label: t('settings.ui.option.standard') },
              { value: 'roomy', label: t('settings.ui.option.roomy') },
            ]}
            onPick={(next) => {
              change({ density: next })
            }}
          />
        </div>
      </div>
      <div className="settings-group-title">{t('settings.ui.foldTitle')}</div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.fold.label')}</div>
          <div className="setting-help">
            {t('settings.ui.fold.help')}
          </div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.fold.label')}
            value={appearance.processFold}
            options={[
              { value: 'compact', label: t('settings.ui.option.compact') },
              { value: 'standard', label: t('settings.ui.option.standard') },
              { value: 'detailed', label: t('settings.ui.option.detailed') },
              { value: 'verbose', label: t('settings.ui.option.verbose') },
            ]}
            onPick={(next) => {
              change({ processFold: next })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.collapseTiming.label')}</div>
          <div className="setting-help">{t('settings.ui.collapseTiming.help')}</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.collapseTiming.label')}
            value={appearance.collapseTiming}
            options={[
              { value: 'completion', label: t('settings.ui.collapseTiming.option.completion') },
              { value: 'next-input', label: t('settings.ui.collapseTiming.option.nextInput') },
            ]}
            onPick={(next) => {
              change({ collapseTiming: next })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.foldedReplies.label')}</div>
          <div className="setting-help">{t('settings.ui.foldedReplies.help')}</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.foldedReplies.label')}
            value={appearance.foldedReplies}
            options={[
              { value: 'all', label: t('settings.ui.foldedReplies.option.all') },
              { value: 'final', label: t('settings.ui.foldedReplies.option.final') },
            ]}
            onPick={(next) => {
              change({ foldedReplies: next })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.reasoning.label')}</div>
          <div className="setting-help">{t('settings.ui.reasoning.help')}</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.reasoning.aria')}
            value={appearance.reasoningOpen ? 'open' : 'folded'}
            options={[
              { value: 'folded', label: t('settings.ui.option.folded') },
              { value: 'open', label: t('settings.ui.option.open') },
            ]}
            onPick={(next) => {
              change({ reasoningDefaultOpen: next === 'open' })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.tools.label')}</div>
          <div className="setting-help">{t('settings.ui.tools.help')}</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.tools.aria')}
            value={appearance.toolOpen ? 'open' : 'folded'}
            options={[
              { value: 'folded', label: t('settings.ui.option.folded') },
              { value: 'open', label: t('settings.ui.option.open') },
            ]}
            onPick={(next) => {
              change({ toolDefaultOpen: next === 'open' })
            }}
          />
        </div>
      </div>
      <div className="settings-note">
        {t('settings.ui.buttonSizeRetired')}
      </div>
      <div className="settings-group-title">{t('settings.ui.notifyTitle')}</div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.notifySound.label')}</div>
          <div className="setting-help">{t('settings.ui.notifySound.help')}</div>
        </div>
        <div className="setting-control">
          <button
            type="button"
            className={`switch${appearance.turnCompleteSound ? ' on' : ''}`}
            role="switch"
            aria-checked={appearance.turnCompleteSound}
            aria-label={t('settings.ui.notifySound.label')}
            onClick={() => {
              change({ turnCompleteSound: !appearance.turnCompleteSound })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.notifyVariant.label')}</div>
          <div className="setting-help">{t('settings.ui.notifyVariant.help')}</div>
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={t('settings.ui.notifyVariant.aria')}
            value={String(appearance.turnCompleteSoundVariant)}
            options={SOUND_VARIANT_OPTIONS}
            onPick={(next) => {
              const id = Number(next)
              // 选中即试听：先响一声，再写偏好。不受上面那个开关管——关掉提醒音时也要能
              // 挑音色（发声模块照响，开关判断在播放方，见 playCompletionSound 的注释）。
              playCompletionSound(id)
              change({ turnCompleteSoundVariant: id })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('settings.ui.notifyBackground.label')}</div>
          <div className="setting-help">{t('settings.ui.notifyBackground.help')}</div>
        </div>
        <div className="setting-control">
          <button
            type="button"
            className={`switch${appearance.turnCompleteNotify ? ' on' : ''}`}
            role="switch"
            aria-checked={appearance.turnCompleteNotify}
            aria-label={t('settings.ui.notifyBackground.label')}
            onClick={() => {
              change({ turnCompleteNotify: !appearance.turnCompleteNotify })
            }}
          />
        </div>
      </div>
      {note === '' ? null : <div className="settings-note error">{note}</div>}
    </div>
  )
}

/** 面板里那几项的本地形态（归一化的权威在壳的 appearance.ts，这里只为自己画控件）。 */
interface Appearance {
  themeMode: 'dark' | 'light' | 'claude' | 'system'
  fontSize: number
  density: 'compact' | 'standard' | 'roomy'
  /** 过程折叠程度（紧凑/标准/详细/完全展开）——消息流整轮折叠的能力表。 */
  processFold: 'compact' | 'standard' | 'detailed' | 'verbose'
  /** 折叠时机：跑完立刻收起，还是等下次发言、它不再是最后一轮时才收起。 */
  collapseTiming: UiPrefsView['collapseTiming']
  /** 收起后还显示哪些助手回复：全部，还是只留这一轮的最终回答。 */
  foldedReplies: UiPrefsView['foldedReplies']
  /** 定稿的思考行默认展开吗。 */
  reasoningOpen: boolean
  /** 工具卡默认展开吗。 */
  toolOpen: boolean
  /** 一轮结束（完成 / 失败 / 停下来等人）响一声提示音吗。 */
  turnCompleteSound: boolean
  /** 提示音的音色编号（下拉选项来自发声表的 `COMPLETION_SOUND_VARIANTS`）。 */
  turnCompleteSoundVariant: number
  /** 窗口不在前台时，一轮结束弹一条系统通知吗。 */
  turnCompleteNotify: boolean
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
    themeMode:
      prefs?.themeMode === 'light' || prefs?.themeMode === 'dark' || prefs?.themeMode === 'system'
        ? prefs.themeMode
        : 'claude',
    fontSize: Math.min(1.35, Math.max(0.85, Math.round(second * 100) / 100)),
    density: prefs?.density === 'compact' || prefs?.density === 'roomy' ? prefs.density : 'standard',
    processFold:
      prefs?.processFold === 'compact' || prefs?.processFold === 'detailed' || prefs?.processFold === 'verbose'
        ? prefs.processFold
        : 'standard',
    // 兜底口径与宿主一致：时机回落 completion，收起后回落 all（不是 final）。
    collapseTiming: prefs?.collapseTiming === 'next-input' ? 'next-input' : 'completion',
    foldedReplies: prefs?.foldedReplies === 'final' ? 'final' : 'all',
    reasoningOpen: prefs?.reasoningDefaultOpen === true,
    toolOpen: prefs?.toolDefaultOpen === true,
    // 任务提醒三项：兜底口径与宿主（core/prefs.ts）一致——两个开关默认开、音色回落 1；
    // 音色只认有限的数字，坏值（NaN / Infinity / 字符串）一律回落 1。
    turnCompleteSound: prefs?.turnCompleteSound !== false,
    turnCompleteSoundVariant:
      typeof prefs?.turnCompleteSoundVariant === 'number' && Number.isFinite(prefs.turnCompleteSoundVariant)
        ? prefs.turnCompleteSoundVariant
        : 1,
    turnCompleteNotify: prefs?.turnCompleteNotify !== false,
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
  remote: t('settings.ui.notYet.remote'),
}

/** 还没搬的结构化分区：标题 + 一条诚实的说明。 */
function NotYetPanel({ section }: { section: SettingsSectionView }): ReactNode {
  const reason = NOT_YET[section.id] ?? t('settings.ui.notYet.generic', { title: section.title })
  return (
    <div>
      <div className="settings-group-title">{section.title}</div>
      <div className="settings-note">{reason}</div>
      <div className="settings-note">
        {t('settings.ui.notYet.footer')}
      </div>
    </div>
  )
}

/** 面板开合的订阅（两个槽条目共用这一份；`useSyncExternalStore` 是外部状态的正确读法）。 */
function useSettingsOpen(): boolean {
  return useSyncExternalStore(settingsOpen.subscribe, () => settingsOpen.get(), () => false)
}
