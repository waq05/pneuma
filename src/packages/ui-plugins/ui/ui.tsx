/**
 * 内置插件：插件中心（主区**独立整页**，对照旧桌面界面 `PluginsView.tsx`）。
 *
 * 形态对齐旧界面：侧栏「插件」入口把主区整页切成这一页（顶栏与正文一起让位，
 * 再点一次侧栏入口回对话页）。三组列表与旧界面同款——自定义（external）、
 * 官方可开关（builtin + toggleable）、运行内核（builtin 不可停）；组标签带数量与
 * 说明；运行内核默认只露 3 行，其余折叠在最底部。
 *
 * **整卡可点**：点开是这个插件自己的详情页（面包屑返回 + 头部 + 配置），配置表单
 * 就地画在详情页里——对照旧界面「插件注册的配置页在插件中心里编辑，设置面板不收录
 * 插件配置」。可配置的插件（`settingsSection` 有值）在行尾另给一颗齿轮图标当路标。
 * 配置字段与设置面板同一张声明表（`getSettingsSections` / `getSectionValues` /
 * `setSettingValue` / `runSettingAction`），控件渲染是设置面板 `GenericFields` 的同构
 * 移植（插件 bundle 之间不能互相 import，这点重复是刻意的）。
 *
 * 数据走 `listPlugins` / `setPluginEnabled`（都在界面通道放行面上）。页头三颗钮
 * 与旧界面同构：刷新（重取清单）、重启宿主（原生桥 `restartHost`；浏览器里禁用并
 * 说明）、+ 添加插件（原生桥 `installPlugin`：系统文件选择器把 .js 复制进
 * `~/.dsc/plugins/`——供应链写入口走桥不走界面通道，浏览器里给一句诚实的说明）。
 *
 * 第四组「第三方界面插件」是**信任卡**（计划 §7 的桌面入口）：`~/.dsc/plugins/<目录名>/
 * {plugin.json, ui/client.js}` 这一类首次发现不装载，卡片把能力面（契约区间 / 载体 /
 * 界面通道白名单方法 + 原生桥）摊开让用户答一次；「确认信任」写 plugins.json 的
 * uiTrust 段，写口同样只在桌面窗口的原生桥（`setUiTrust`）；列状态走界面通道
 * `listUiTrust`（读），启停走 `setPluginEnabled`（键 `<目录名>/ui/client.js`）。
 *
 * @module dsc-ui-shell/plugins/plugins
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  IconChevronRight,
  IconGear,
  IconPuzzle,
  IconRefresh,
  IconRestart,
  createT,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useShellPage,
  type SettingsField,
  type SettingsMutation,
  type SettingsSectionView,
  type SettingsValue,
  type SettingsValues,
} from '@dsc/ui'
// 基元从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，不再内联（E6）。
import { Select, Skeleton, SkeletonText, errText as text, humanErrorLine, humanErrorText } from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 这一页在 page-state 里的 id（侧栏入口与页条目约定同一个值）。 */
const PAGE = 'plugins'

/** 运行内核默认露几行（其余折叠，这一档本来就少有人翻，旧界面同款）。 */
const KERNEL_PREVIEW = 3

/** `listPlugins` 回来的形状（宿主契约 `PluginInfoView`）。 */
interface PluginRow {
  file: string
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'external'
  toggleable: boolean
  /** 这个插件贡献的设置分区 id；undefined = 没有可配置项，详情页不画配置表单。 */
  settingsSection?: string
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 来自哪个组合包（dsh 的 bundle）；单文件插件没有。 */
  bundle?: string
  /** 插件声明的 dsh 客户端（界面）能力名，只列不加载。 */
  clientCapabilities?: string[]
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
}

/** `listUiTrust` 回来的形状（宿主契约 `UiTrustView`；界面插件的两张卡）。 */
interface TrustRow {
  name: string
  /** 启停键（宿主给）：第三方 `<目录名>/ui/client.js`，组合包 `<包名>/client`。 */
  key?: string
  /** 来源：手工放进 `~/.dsc/plugins` 的界面插件，还是 profile 里装的组合包。 */
  origin?: 'third-party' | 'package'
  /** 包的版本号（只有组合包行有；第三方目录没有版本这个概念）。 */
  version?: string
  /** 装在哪个 profile（只有组合包行有）。 */
  profile?: string
  api?: string
  platforms: string[]
  trusted: boolean
  trustedAt?: number
  enabled: boolean
  problem?: string
  /** `problem` 属于哪一档（宿主 `problemKind`）：界面按档说「没加载的原因 + 下一步」。 */
  problemKind?: 'manifest' | 'clash' | 'version' | 'artifact' | 'stale'
}

/** 一行是不是组合包带来的界面半边（宿主老版本没有 `origin` 字段，一律当第三方）。 */
function isPackageRow(row: TrustRow): boolean {
  return row.origin === 'package'
}

/** 启停键：宿主给了就用，没给按第三方的形状拼（老宿主只发这一类）。 */
function keyOf(row: TrustRow): string {
  return row.key ?? `${row.name}/ui/client.js`
}

export default defineUiPlugin({
  name: t('plugins.plugin.name'),
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
  const [kernelOpen, setKernelOpen] = useState(false)
  // 详情页选中的插件：存 file 键，渲染时回 rows 里取最新值——开关一翻列表就换成
  // 新数组，存对象会让详情页看到过期的 enabled（旧界面同款的处理）。
  const [detailFile, setDetailFile] = useState<string | null>(null)
  /** 第三方界面插件的信任状态（信任卡那一组；宿主 `listUiTrust`）。 */
  const [trusts, setTrusts] = useState<TrustRow[]>([])
  /** 正在展开能力披露的那个目录名（null = 都收着）。 */
  const [trustOpen, setTrustOpen] = useState<string | null>(null)
  const [trustNote, setTrustNote] = useState('')
  const [trustBusy, setTrustBusy] = useState(false)

  const refresh = (): void => {
    void channel
      .invoke<PluginRow[]>('listPlugins')
      .then((list) => {
        setRows(Array.isArray(list) ? list : [])
        setNote('')
      })
      .catch((error: unknown) => {
        // 说人话 + 给下一步（P0-3）：原文里是 ECONNREFUSED 还是 ENOENT，用户不关心。
        setNote(t('plugins.err.readPlugins', { message: humanErrorText(error).text }))
      })
  }

  useEffect(() => {
    refresh()
    loadTrusts()
    // 只认通道：refresh 与 loadTrusts 每次渲染都是新函数。
  }, [channel])

  /** 读第三方界面插件的信任状态（读类；失败摊在那一组下面，不静默）。 */
  const loadTrusts = (): void => {
    void channel
      .invoke<TrustRow[]>('listUiTrust')
      .then((list) => {
        setTrusts(Array.isArray(list) ? list : [])
        setTrustNote('')
      })
      .catch((error: unknown) => {
        setTrustNote(t('plugins.err.readTrust', { message: humanErrorText(error).text }))
      })
  }

  /**
   * 确认信任一个第三方界面插件：写 plugins.json 的 uiTrust 段。
   * 写口在桌面窗口的原生桥（`setUiTrust`）——「我信任」这声必须人在桌面上答。
   */
  const confirmTrust = (row: TrustRow): void => {
    if (!native.available) {
      toastErr(t('plugins.err.trustDesktopOnly'))
      return
    }
    setTrustBusy(true)
    void native
      .invoke<{ ok: boolean; notice?: string; error?: string }>('setUiTrust', [row.name])
      .then((result) => {
        if (!result.ok) {
          toastErr(t('plugins.err.confirm', { message: humanErrorLine(result.error ?? t('plugins.common.unknown')) }))
          return
        }
        toastOk(result.notice ?? t('plugins.trust.done', { name: row.name }))
        setTrustOpen(null)
        loadTrusts()
      })
      .catch((error: unknown) => {
        toastErr(t('plugins.err.confirm', { message: humanErrorLine(error) }))
      })
      .finally(() => {
        setTrustBusy(false)
      })
  }

  /**
   * 启停一个界面插件（第三方或组合包）：键由宿主给（`keyOf`），写盘后刷新页面生效。
   * 两种来源的键形状不同，界面不自己拼——拼错会写进一条没人读的开关。
   */
  const toggleTrust = (row: TrustRow, next: boolean): void => {
    setTrusts((current) => current.map((item) => (item.name === row.name ? { ...item, enabled: next } : item)))
    void channel
      .invoke('setPluginEnabled', [keyOf(row), next])
      .then(() => {
        toastOk(
          next ? t('plugins.trust.enabledToast', { name: row.name }) : t('plugins.trust.disabledToast', { name: row.name }),
        )
        setTimeout(loadTrusts, 600)
      })
      .catch((error: unknown) => {
        setTrusts((current) => current.map((item) => (item.name === row.name ? { ...item, enabled: !next } : item)))
        toastErr(t('plugins.err.toggleFailed', { message: text(error) }))
      })
  }

  const toggle = (row: PluginRow, next: boolean): void => {
    setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: next } : item)) ?? null)
    void channel
      .invoke('setPluginEnabled', [row.file, next])
      .then(() => {
        toastOk(
          next ? t('plugins.toggle.enabledToast', { name: row.name }) : t('plugins.toggle.disabledToast', { name: row.name }),
        )
        // 热挂载的结果（成功/回滚）随 system 条目与下一次清单刷新回来。
        setTimeout(refresh, 600)
      })
      .catch((error: unknown) => {
        setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: !next } : item)) ?? null)
        setNote(t('plugins.err.toggleFailed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const restartHost = (): void => {
    if (!native.available) {
      toastErr(t('plugins.err.restartDesktopOnly'))
      return
    }
    void native.invoke('restartHost').catch((reason: unknown) => {
      toastErr(t('plugins.err.restart', { message: humanErrorLine(reason) }))
    })
  }

  /**
   * 添加插件（旧界面同款）：系统文件选择器选 .js 文件，主进程复制进 ~/.dsc/plugins/
   * （原生桥 `installPlugin`；人没选文件就不算数），装完刷新清单。
   */
  const installPlugin = (): void => {
    if (!native.available) {
      toastErr(t('plugins.err.installDesktopOnly'))
      return
    }
    void native
      .invoke<string[]>('installPlugin')
      .then((installed) => {
        if (!Array.isArray(installed) || installed.length === 0) return
        toastOk(t('plugins.install.done', { list: installed.join(t('plugins.common.listSep')) }))
        setTimeout(refresh, 600)
      })
      .catch((reason: unknown) => {
        toastErr(t('plugins.err.install', { message: humanErrorLine(reason) }))
      })
  }

  const detail = detailFile === null ? null : ((rows ?? []).find((row) => row.file === detailFile) ?? null)
  const custom = (rows ?? []).filter((row) => row.source === 'external')
  // 界面插件两张卡分开画：第三方的要点一次信任，组合包的不用（装进 profile 就是同意）。
  const thirdParty = trusts.filter((row) => !isPackageRow(row))
  const packages = trusts.filter(isPackageRow)
  // 组合包装在哪个 profile：一行里已经有徽标，但组的标题上先说一句更有用——
  // 装了多个 profile 时，用户第一眼要确认的是「这一组属于哪一层」。
  const packageProfiles = [...new Set(packages.map((row) => row.profile).filter((v): v is string => v !== undefined))]
  const official = (rows ?? []).filter((row) => row.source === 'builtin' && row.toggleable)
  const kernel = (rows ?? []).filter((row) => row.source === 'builtin' && !row.toggleable)
  const kernelShown = kernelOpen ? kernel : kernel.slice(0, KERNEL_PREVIEW)

  // 插件被卸载/改名后 detail 找不到了，落回列表——详情态不用单独清理（旧界面同款）。
  if (detail !== null) {
    return (
      <div className="plugins">
        <div className="plugins-inner">
          <PluginDetail plugin={detail} onToggle={toggle} onBack={() => setDetailFile(null)} />
        </div>
      </div>
    )
  }

  return (
    <div className="plugins">
      <div className="plugins-inner">
        <div className="plugins-head">
          <div>
            <h1>{t('plugins.page.title')}</h1>
            <p>{t('plugins.page.lead')}</p>
          </div>
          <div className="plugins-actions">
            <button
              type="button"
              className="icon-btn"
              data-tip={t('plugins.action.refresh')}
              aria-label={t('plugins.action.refresh')}
              onClick={refresh}
            >
              <IconRefresh size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              data-tip={native.available ? t('plugins.action.restartTip') : t('plugins.action.restartTipBrowser')}
              aria-label={t('plugins.action.restart')}
              disabled={!native.available}
              onClick={restartHost}
            >
              <IconRestart size={16} />
            </button>
            <button
              type="button"
              className="btn-primary plugins-add"
              data-tip={t('plugins.action.installTip')}
              onClick={installPlugin}
            >
              {t('plugins.action.add')}
            </button>
          </div>
        </div>

        {rows === null ? <div className="plugins-empty">{note === '' ? t('plugins.page.loading') : note}</div> : null}

        {rows !== null ? (
          <>
            <div className="plugin-group-label">
              <IconPuzzle size={13} /> {t('plugins.group.custom')} <span className="count">{custom.length}</span>
              <span className="group-hint">~/.dsc/plugins/*.js</span>
            </div>
            {custom.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} onOpen={setDetailFile} />
            ))}
            {custom.length === 0 && (
              <div className="empty-card compact">
                <span className="empty-card-icon">
                  <IconPuzzle size={18} />
                </span>
                <div className="empty-card-title">{t('plugins.empty.customTitle')}</div>
                <p className="empty-card-desc">
                  {t('plugins.empty.lead')} <code>~/.dsc/plugins/</code> {t('plugins.empty.tail')}
                </p>
              </div>
            )}

            {thirdParty.length > 0 ? (
              <>
                <div className="plugin-group-label">
                  <IconPuzzle size={13} /> {t('plugins.group.thirdParty')}{' '}
                  <span className="count">{thirdParty.length}</span>
                  <span className="group-hint">{t('plugins.group.thirdPartyHint')}</span>
                </div>
                {thirdParty.map((row) => (
                  <TrustCard
                    key={row.name}
                    row={row}
                    open={trustOpen === row.name}
                    busy={trustBusy && trustOpen === row.name}
                    onOpen={() => {
                      setTrustOpen(trustOpen === row.name ? null : row.name)
                    }}
                    onConfirm={() => {
                      confirmTrust(row)
                    }}
                    onToggle={(next) => {
                      toggleTrust(row, next)
                    }}
                  />
                ))}
              </>
            ) : null}

            {packages.length > 0 ? (
              <>
                <div className="plugin-group-label">
                  <IconPuzzle size={13} /> {t('plugins.group.packages')} <span className="count">{packages.length}</span>
                  <span className="group-hint">
                    {packageProfiles.length === 0
                      ? ''
                      : t('plugins.group.profiles', { list: packageProfiles.join(t('plugins.common.listSep')) })}
                    {t('plugins.group.packagesHint')}
                  </span>
                </div>
                {packages.map((row) => (
                  <TrustCard
                    key={row.name}
                    row={row}
                    open={false}
                    busy={false}
                    onOpen={() => undefined}
                    onConfirm={() => undefined}
                    onToggle={(next) => {
                      toggleTrust(row, next)
                    }}
                  />
                ))}
              </>
            ) : null}
            {/* 读失败要说出来：没有这一行，invoke 出错时这一组会「静默消失」。 */}
            {trustNote === '' ? null : <div className="plugins-empty">{trustNote}</div>}

            <div className="plugin-group-label">
              {t('plugins.group.official')} <span className="count">{official.length}</span>
              <span className="group-hint">{t('plugins.group.officialHint')}</span>
            </div>
            {official.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} onOpen={setDetailFile} />
            ))}

            <div className="plugin-group-label">
              {t('plugins.group.kernel')} <span className="count">{kernel.length}</span>
              <span className="group-hint">{t('plugins.group.kernelHint')}</span>
            </div>
            {kernelShown.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} onOpen={setDetailFile} />
            ))}
            {kernel.length > KERNEL_PREVIEW && (
              <button type="button" className="plugin-more" onClick={() => setKernelOpen((open) => !open)}>
                {kernelOpen
                  ? t('plugins.action.collapse')
                  : t('plugins.action.expandMore', { count: kernel.length - KERNEL_PREVIEW })}
              </button>
            )}
          </>
        ) : null}

        {note === '' ? null : <div className="plugins-empty">{note}</div>}
      </div>
    </div>
  )
}

/**
 * 一张插件卡（旧界面 PluginRow 同构：彩底首字母图标 + 名称/描述 + 开关）。
 * 整卡可点进详情（旧界面 `data-tip="查看详情与配置"` 同款）；可配置的插件在开关
 * 左边多一颗齿轮图标当路标——点它也是进详情（旧界面没有这颗，按用户要求补的）。
 */
function PluginCard({
  row,
  onToggle,
  onOpen,
}: {
  row: PluginRow
  onToggle: (row: PluginRow, next: boolean) => void
  onOpen: (file: string) => void
}): ReactNode {
  const configurable = row.settingsSection !== undefined
  return (
    <div
      className={`plugin-row${row.enabled ? '' : ' off'}`}
      data-plugin={row.file}
      data-tip={t('plugins.card.tip')}
      onClick={() => {
        onOpen(row.file)
      }}
    >
      <div className="plugin-icon" style={{ background: iconColor(row.name) }}>
        {row.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="plugin-info">
        <div className="plugin-name">
          {row.name}
          {row.apiVersion !== undefined && <span className="plugin-apiver">API v{String(row.apiVersion)}</span>}
          {/* 组合包来源：让用户知道该去哪卸载（组合包不是单个文件，不能在这里停用）。 */}
          {row.bundle !== undefined && (
            <span className="plugin-apiver" data-bundle={row.bundle}>
              {t('plugins.card.bundle', { name: row.bundle })}
            </span>
          )}
        </div>
        <div className={`plugin-desc${row.problem !== undefined ? ' problem' : ''}`}>
          {row.problem !== undefined
            ? `⚠ ${row.problem}`
            : row.description === ''
              ? t('plugins.card.noDescription', { file: row.file })
              : row.description}
          {/* dsh 客户端能力：只列不加载（见 PluginInfoView.clientCapabilities 的说明）。 */}
          {row.clientCapabilities !== undefined && row.clientCapabilities.length > 0 ? (
            <div className="plugin-desc" data-client-capabilities={row.clientCapabilities.join(',')}>
              {t('plugins.card.capabilities', { list: row.clientCapabilities.join(t('plugins.common.listSep')) })}
            </div>
          ) : null}
        </div>
      </div>
      {configurable ? (
        <button
          type="button"
          className="icon-btn"
          data-tip={t('plugins.card.openConfig')}
          aria-label={t('plugins.card.configAria', { name: row.name })}
          onClick={(event) => {
            event.stopPropagation()
            onOpen(row.file)
          }}
        >
          <IconGear size={15} />
        </button>
      ) : null}
      <button
        type="button"
        className={`switch${row.enabled ? ' on' : ''}${row.toggleable ? '' : ' locked'}`}
        role="switch"
        aria-checked={row.enabled}
        aria-label={t('plugins.card.switchAria', { name: row.name })}
        data-tip={
          row.toggleable
            ? row.enabled
              ? t('plugins.card.disableNow')
              : t('plugins.card.enableNow')
            : t('plugins.card.locked')
        }
        disabled={!row.toggleable}
        onClick={(event) => {
          event.stopPropagation()
          if (row.toggleable) onToggle(row, !row.enabled)
        }}
      />
    </div>
  )
}

/**
 * 第三方界面插件「没加载」的档名与下一步：与宿主 `problemKind` 一一对齐。
 *
 * 为什么档位由宿主标、动作写在界面：判定（api 区间对不上 / client.js 读不到…）在宿主侧
 * 现场就知道档位，界面不该去猜那句人话里有没有某个词；而「下一步做什么」是界面文案，
 * 换宿主版本不该牵动它。各有出口：版本→升壳或改区间、产物→查产物路径、内容变了→在这张卡上重新确认、
 * 未信任→卡片上的「查看并信任」（另走 `trusted` 字段，不是 problem 的一种）。
 */
const TRUST_PROBLEM_TIERS = {
  version: {
    label: t('plugins.problem.version.label'),
    next: t('plugins.problem.version.next'),
  },
  artifact: {
    label: t('plugins.problem.artifact.label'),
    next: t('plugins.problem.artifact.next'),
  },
  manifest: {
    label: t('plugins.problem.manifest.label'),
    next: t('plugins.problem.manifest.next'),
  },
  clash: {
    label: t('plugins.problem.clash.label'),
    next: t('plugins.problem.clash.next'),
  },
  stale: {
    label: t('plugins.problem.stale.label'),
    next: t('plugins.problem.stale.next'),
  },
} as const satisfies Record<NonNullable<TrustRow['problemKind']>, { label: string; next: string }>

/**
 * 组合包同一批档位的「下一步」：位置不同——它不在 `~/.dsc/plugins/`，而在 profile 的
 * `node_modules/<包名>/`，声明也不是 plugin.json 而是 package.json 的 `pneuma.client`。
 */
const PACKAGE_PROBLEM_TIERS = {
  version: {
    label: t('plugins.problem.packageVersion.label'),
    next: t('plugins.problem.packageVersion.next'),
  },
  artifact: {
    label: t('plugins.problem.packageArtifact.label'),
    next: t('plugins.problem.packageArtifact.next'),
  },
  manifest: {
    label: t('plugins.problem.packageManifest.label'),
    next: t('plugins.problem.packageManifest.next'),
  },
  clash: {
    label: t('plugins.problem.packageClash.label'),
    next: t('plugins.problem.packageClash.next'),
  },
  // 组合包这一档实际走不到（装进 profile 就是同意；摘要判定只对第三方目录做），
  // 但表必须同构——`satisfies` 逼着每个档都有话说，漏一个就是编译错。
  stale: {
    label: t('plugins.problem.packageStale.label'),
    next: t('plugins.problem.packageStale.next'),
  },
} as const satisfies Record<NonNullable<TrustRow['problemKind']>, { label: string; next: string }>

/** 宿主没标档（更老的宿主）时的兜底：不猜，照原文让用户自己去看目录。 */
const UNKNOWN_TRUST_PROBLEM = {
  label: t('plugins.problem.unknownTrust.label'),
  next: t('plugins.problem.unknownTrust.next'),
} as const

const UNKNOWN_PACKAGE_PROBLEM = {
  label: t('plugins.problem.unknownPackage.label'),
  next: t('plugins.problem.unknownPackage.next'),
} as const

/** 一行问题的档：有标用标，没标给兜底；「下一步去哪儿看」按来源分。 */
function trustProblemTier(kind: TrustRow['problemKind'], origin: TrustRow['origin']): { label: string; next: string } {
  if (origin === 'package') return kind === undefined ? UNKNOWN_PACKAGE_PROBLEM : PACKAGE_PROBLEM_TIERS[kind]
  return kind === undefined ? UNKNOWN_TRUST_PROBLEM : TRUST_PROBLEM_TIERS[kind]
}

/**
 * 第三方界面插件的一张信任卡：卡体复用行样式，没答过信任的摊开能力披露让用户答一次，
 * 答过的给启停开关。披露文案对着 `/ui-trust` 的能力面口径写（契约区间 / 载体 /
 * 两条通用能力 / 生效时机）——卡片与命令说的是同一件事。
 *
 * 装不上的行按宿主标的档分开说：行里是「⚠ 档名：判定依据」，下面一行常驻
 * 「下一步」（升壳 / 查产物路径 / 补声明 / 改名）——原因与动作得同时看见。
 */
function TrustCard({
  row,
  open,
  busy,
  onOpen,
  onConfirm,
  onToggle,
}: {
  row: TrustRow
  open: boolean
  busy: boolean
  onOpen: () => void
  onConfirm: () => void
  onToggle: (next: boolean) => void
}): ReactNode {
  const hello = useHostChannel().getHello()
  const fromPackage = isPackageRow(row)
  const trustedAt =
    row.trustedAt === undefined ? '' : t('plugins.trust.trustedAt', { date: new Date(row.trustedAt).toLocaleDateString() })
  // 装不上的档（problem 才存在）：行里放档名 + 判定依据，行下常驻下一步。
  const tier = row.problem === undefined ? null : trustProblemTier(row.problemKind, row.origin)
  const desc =
    row.problem !== undefined && tier !== null
      ? t('plugins.trust.problem', { label: tier.label, detail: row.problem })
      : row.trusted
        ? fromPackage
          ? t('plugins.trust.packageDesc')
          : t('plugins.trust.trustedDesc')
        : t('plugins.trust.untrustedDesc')
  return (
    <div className="trust-card" data-trust={row.name}>
      <div className={`plugin-row${row.enabled ? '' : ' off'}`}>
        <div className="plugin-icon" style={{ background: iconColor(row.name) }}>
          {row.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="plugin-info">
          <div className="plugin-name">
            {row.name}
            {row.api !== undefined ? <span className="plugin-apiver">@dsc/ui {row.api}</span> : null}
            <span className="plugin-apiver">{row.platforms.join('/')}</span>
            {/* 组合包多两枚：版本与来源。第三方目录没有版本，也不该冒充 —— 见契约注释。 */}
            {row.version !== undefined ? (
              <span className="plugin-apiver" data-version={row.version}>
                v{row.version}
              </span>
            ) : null}
            {row.profile !== undefined ? (
              <span className="plugin-apiver" data-profile={row.profile}>
                profile {row.profile}
              </span>
            ) : null}
            {row.trusted ? <span className="plugin-apiver">{t('plugins.trust.badge', { date: trustedAt })}</span> : null}
            {row.trusted && !row.enabled ? (
              <span className="plugin-apiver">{t('plugins.trust.disabledBadge')}</span>
            ) : null}
          </div>
          <div className={`plugin-desc${row.problem !== undefined ? ' problem' : ''}`}>{desc}</div>
          {tier !== null ? (
            <div className="trust-next">{t('plugins.trust.next', { next: tier.next })}</div>
          ) : null}
        </div>
        {/* 「查看并信任」只对第三方：组合包没有要答的问题，装上就是同意。 */}
        {!fromPackage && row.problem === undefined && !row.trusted ? (
          <button type="button" className="btn-primary" onClick={onOpen}>
            {open ? t('plugins.action.collapse') : t('plugins.trust.review')}
          </button>
        ) : null}
        {row.trusted ? (
          <button
            type="button"
            className={`switch${row.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={row.enabled}
            aria-label={t('plugins.card.switchAria', { name: row.name })}
            data-tip={row.enabled ? t('plugins.card.disableReload') : t('plugins.card.enableReload')}
            onClick={() => {
              onToggle(!row.enabled)
            }}
          />
        ) : null}
      </div>
      {open ? (
        <div className="trust-disclosure">
          <div className="settings-group-title">{t('plugins.trust.disclosureTitle')}</div>
          <ul>
            <li>
              {t('plugins.trust.apiRange', { range: row.api ?? t('plugins.common.notSet') })}
              {hello === null ? '' : t('plugins.trust.currentHost', { version: hello.host.version })}
            </li>
            <li>{t('plugins.trust.platforms', { list: row.platforms.join('/') })}</li>
            <li>{t('plugins.trust.capabilities')}</li>
            <li>{t('plugins.trust.effect')}</li>
          </ul>
          <div className="trust-actions">
            <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>
              {busy ? t('plugins.trust.writing') : t('plugins.trust.confirm')}
            </button>
            <button type="button" className="btn-ghost" onClick={onOpen}>
              {t('plugins.common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 插件详情页：整卡点进来的那一层（对照旧界面的 detail——面包屑返回、图标加名称加
 * 开关的头部，下面是配置表单）。配置表单直接复用与设置面板同一张声明表的渲染器：
 * 插件贡献的分区本来就是同一张表，没理由画两遍。
 */
function PluginDetail({
  plugin,
  onToggle,
  onBack,
}: {
  plugin: PluginRow
  onToggle: (row: PluginRow, next: boolean) => void
  onBack: () => void
}): ReactNode {
  const channel = useHostChannel()
  // undefined = 还在读；null = 没有配置；其余 = 画表单
  const [section, setSection] = useState<SettingsSectionView | null | undefined>(undefined)

  // 分区只在插件挂着时才存在：停用的插件查不到分区，开关一翻就得重查（旧界面同款）。
  const loadSection = (): void => {
    if (plugin.settingsSection === undefined || !plugin.enabled) {
      setSection(null)
      return
    }
    let alive = true
    setSection(undefined)
    void channel
      .invoke<SettingsSectionView[]>('getSettingsSections')
      .then((list) => {
        if (alive) setSection(list.find((item) => item.id === plugin.settingsSection) ?? null)
      })
      .catch(() => {
        if (alive) setSection(null)
      })
  }

  useEffect(() => {
    loadSection()
    // 只认这三样：loadSection 每次渲染都是新函数。
  }, [channel, plugin.enabled, plugin.settingsSection])

  const sourceLabel =
    plugin.source === 'external'
      ? t('plugins.group.custom')
      : plugin.toggleable
        ? t('plugins.source.official')
        : t('plugins.group.kernel')
  return (
    <div className="plugin-detail">
      <div className="plugin-detail-top">
        <button type="button" className="plugin-back" data-tip={t('plugins.detail.backTip')} onClick={onBack}>
          <IconChevronRight size={14} />
          {t('plugins.page.title')}
        </button>
      </div>
      <div className={`plugin-detail-head${plugin.enabled ? '' : ' off'}`}>
        <div className="plugin-icon" style={{ background: iconColor(plugin.name) }}>
          {plugin.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="plugin-info">
          <div className="plugin-name">
            {plugin.name}
            {plugin.apiVersion !== undefined && <span className="plugin-apiver">API v{String(plugin.apiVersion)}</span>}
          </div>
          <div className={`plugin-detail-desc${plugin.problem !== undefined ? ' problem' : ''}`}>
            {plugin.problem !== undefined
              ? `⚠ ${plugin.problem}`
              : plugin.description === ''
                ? t('plugins.detail.noDescription')
                : plugin.description}
          </div>
        </div>
        {plugin.toggleable && (
          <button
            type="button"
            className={`switch${plugin.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={t('plugins.card.switchAria', { name: plugin.name })}
            data-tip={plugin.enabled ? t('plugins.card.disableNow') : t('plugins.card.enableNow')}
            onClick={() => {
              onToggle(plugin, !plugin.enabled)
            }}
          />
        )}
      </div>
      <div className="plugin-detail-meta">
        <span className="mono">{plugin.file}</span>
        <span className="plugin-detail-src">{sourceLabel}</span>
      </div>
      <div className="plugin-detail-config">
        <div className="settings-group-title">{t('plugins.detail.config')}</div>
        {section === undefined ? (
          <div className="settings-loading" role="status" aria-label={t('plugins.detail.loadingConfig')}>
            <SkeletonText lines={3} />
            <Skeleton width={132} height={30} radius={8} />
          </div>
        ) : section === null ? (
          plugin.enabled ? (
            <div className="settings-empty">{t('plugins.detail.noConfig')}</div>
          ) : (
            <div className="settings-empty">{t('plugins.detail.disabledConfig')}</div>
          )
        ) : (
          <ConfigFields section={section} onAction={loadSection} />
        )}
      </div>
    </div>
  )
}

/**
 * 声明式配置表单：设置面板 `GenericFields` 的同构移植（同一套 class 与提交时机：
 * 下拉/开关**选了就写**，文本框**失焦或回车才写**——避免边打字边写盘）。
 *
 * 为什么不共用一份：插件 bundle 之间不能互相 import（各自是独立产物），壳也没有为
 * 「跨插件组件」准备分发机制；两张表本来同源（宿主声明），控件就那几个，重复这一小段
 * 比新造一层分发便宜。回执走表单底部的行内说明（旧界面走全局 Toast，这里向设置面板
 * 的口径看齐）。
 */
function ConfigFields({ section, onAction }: { section: SettingsSectionView; onAction: () => void }): ReactNode {
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
        if (alive) setNote({ tone: 'error', text: t('plugins.err.readSettings', { message: humanErrorText(error).text }) })
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
          setNote({ tone: 'error', text: t('plugins.err.save', { message: humanErrorText(result.error).text }) })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        reload()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('plugins.err.save', { message: humanErrorText(error).text }) })
      })
  }

  const act = (action: string): void => {
    setNote(null)
    void channel
      .invoke<SettingsMutation>('runSettingAction', [section.id, action])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('plugins.err.action', { message: humanErrorText(result.error).text }) })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        reload()
        // 有的分区（安全钩子那种）控件清单跟着内容走：多加一条规则，下拉里就多一项。
        onAction()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('plugins.err.action', { message: humanErrorText(error).text }) })
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
                        setNote({ tone: 'ok', text: t('plugins.config.copied') })
                      },
                      () => {
                        setNote({ tone: 'error', text: t('plugins.config.copyFailed') })
                      },
                    )
                  }}
                >
                  {t('plugins.config.copy')}
                </button>
                <button
                  type="button"
                  className="text-btn"
                  data-tip={t('plugins.config.revealTip')}
                  onClick={() => {
                    const native = getHostNative()
                    if (!native.available) {
                      setNote({ tone: 'error', text: t('plugins.err.openDesktopOnly') })
                      return
                    }
                    void native
                      .invoke<string>('openPath', [field.text])
                      .then((problem) => {
                        if (problem !== '') setNote({ tone: 'error', text: t('plugins.err.open', { message: problem }) })
                      })
                      .catch((error: unknown) => {
                        setNote({ tone: 'error', text: t('plugins.err.open', { message: text(error) }) })
                      })
                  }}
                >
                  {t('plugins.config.open')}
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
      // 派生值（宿主给了显示名）选不了，这一行置灰只读——与设置面板那份同构渲染同款。
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
      const options = listed
        ? field.options
        : [...field.options, { value: current, label: t('plugins.config.unrecognized', { value: current }) }]
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
      {section.fields.length === 0 ? <div className="settings-empty">{t('plugins.detail.noSectionConfig')}</div> : null}
      {section.fields.map((field, index) => {
        const group = field.group
        return (
          <Fragment
            key={field.type === 'info' ? `info-${String(index)}` : field.type === 'button' ? `btn-${field.action}` : field.key}
          >
            {/* 组头：字段声明了 group 且与上一个不同组时插一行。 */}
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
    </div>
  )
}

/**
 * 图标底色：统一中性底。
 *
 * 旧界面按名称哈希从六种彩色里挑一个——同一个插件每次颜色稳定，但**颜色本身没有含义**：
 * 十八个插件铺开像一盒彩色积木，反而把「开关是开是关」这个唯一有信息量的色点压过去了。
 * 现在底色走填充三档、文字走二级色，开关保留唯一的饱和色。
 */
function iconColor(_name: string): string {
  return 'var(--dsc-fill-tertiary)'
}
