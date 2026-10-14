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
import { Select } from '@dsc/ui-primitives'

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
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
}

/** `listUiTrust` 回来的形状（宿主契约 `UiTrustView`；第三方界面插件的信任卡行）。 */
interface TrustRow {
  name: string
  api?: string
  platforms: string[]
  trusted: boolean
  trustedAt?: number
  enabled: boolean
  problem?: string
  /** `problem` 属于哪一档（宿主 `problemKind`）：界面按档说「没加载的原因 + 下一步」。 */
  problemKind?: 'manifest' | 'clash' | 'version' | 'artifact'
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
        setNote(`读插件失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  useEffect(() => {
    refresh()
    loadTrusts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setTrustNote(`读第三方界面插件状态失败：${text(error)}`)
      })
  }

  /**
   * 确认信任一个第三方界面插件：写 plugins.json 的 uiTrust 段。
   * 写口在桌面窗口的原生桥（`setUiTrust`）——「我信任」这声必须人在桌面上答。
   */
  const confirmTrust = (row: TrustRow): void => {
    if (!native.available) {
      toastErr('信任确认要写 ~/.dsc/plugins.json，只桌面版能做（浏览器里没有这条桥）')
      return
    }
    setTrustBusy(true)
    void native
      .invoke<{ ok: boolean; notice?: string; error?: string }>('setUiTrust', [row.name])
      .then((result) => {
        if (!result.ok) {
          toastErr(`确认失败：${result.error ?? '未知原因'}`)
          return
        }
        toastOk(result.notice ?? `已信任「${row.name}」`)
        setTrustOpen(null)
        loadTrusts()
      })
      .catch((error: unknown) => {
        toastErr(`确认失败：${text(error)}`)
      })
      .finally(() => {
        setTrustBusy(false)
      })
  }

  /** 启停一个第三方界面插件（键 `<目录名>/ui/client.js`；写盘后刷新页面生效）。 */
  const toggleTrust = (row: TrustRow, next: boolean): void => {
    setTrusts((current) => current.map((item) => (item.name === row.name ? { ...item, enabled: next } : item)))
    void channel
      .invoke('setPluginEnabled', [`${row.name}/ui/client.js`, next])
      .then(() => {
        toastOk(`已${next ? '启用' : '停用'}第三方界面插件「${row.name}」，刷新页面（或重启宿主）后生效`)
        setTimeout(loadTrusts, 600)
      })
      .catch((error: unknown) => {
        setTrusts((current) => current.map((item) => (item.name === row.name ? { ...item, enabled: !next } : item)))
        toastErr(`没改成功：${text(error)}`)
      })
  }

  const toggle = (row: PluginRow, next: boolean): void => {
    setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: next } : item)) ?? null)
    void channel
      .invoke('setPluginEnabled', [row.file, next])
      .then(() => {
        toastOk(`已${next ? '启用' : '停用'}插件 ${row.name}，即时生效`)
        // 热挂载的结果（成功/回滚）随 system 条目与下一次清单刷新回来。
        setTimeout(refresh, 600)
      })
      .catch((error: unknown) => {
        setRows((current) => current?.map((item) => (item.file === row.file ? { ...item, enabled: !next } : item)) ?? null)
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

  /**
   * 添加插件（旧界面同款）：系统文件选择器选 .js 文件，主进程复制进 ~/.dsc/plugins/
   * （原生桥 `installPlugin`；人没选文件就不算数），装完刷新清单。
   */
  const installPlugin = (): void => {
    if (!native.available) {
      toastErr('装插件来自桌面外壳的文件选择器，浏览器里没有它')
      return
    }
    void native
      .invoke<string[]>('installPlugin')
      .then((installed) => {
        if (!Array.isArray(installed) || installed.length === 0) return
        toastOk(`已安装 ${installed.join('、')}，即时生效`)
        setTimeout(refresh, 600)
      })
      .catch((reason: unknown) => {
        toastErr(`安装失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  const detail = detailFile === null ? null : ((rows ?? []).find((row) => row.file === detailFile) ?? null)
  const custom = (rows ?? []).filter((row) => row.source === 'external')
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
            <h1>插件</h1>
            <p>管理插件，点击卡片查看详情与配置</p>
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
              data-tip="选择 .js 插件文件装进 ~/.dsc/plugins（桌面版）"
              onClick={installPlugin}
            >
              + 添加插件
            </button>
          </div>
        </div>

        {rows === null ? <div className="plugins-empty">{note === '' ? '正在读插件…' : note}</div> : null}

        {rows !== null ? (
          <>
            <div className="plugin-group-label">
              <IconPuzzle size={13} /> 自定义 <span className="count">{custom.length}</span>
              <span className="group-hint">~/.dsc/plugins/*.js</span>
            </div>
            {custom.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} onOpen={setDetailFile} />
            ))}
            {custom.length === 0 && (
              <div className="plugins-empty">
                尚未安装外部插件。点击「+ 添加插件」选择 .js 文件，或将文件放入 <code>~/.dsc/plugins/</code>{' '}
                后重启宿主。
              </div>
            )}

            {trusts.length > 0 ? (
              <>
                <div className="plugin-group-label">
                  <IconPuzzle size={13} /> 第三方界面插件 <span className="count">{trusts.length}</span>
                  <span className="group-hint">~/.dsc/plugins/&lt;目录名&gt;/ui/client.js（信任一次后才装载）</span>
                </div>
                {trusts.map((row) => (
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
            {/* 读失败要说出来：没有这一行，invoke 出错时这一组会「静默消失」。 */}
            {trustNote === '' ? null : <div className="plugins-empty">{trustNote}</div>}

            <div className="plugin-group-label">
              官方可开关 <span className="count">{official.length}</span>
              <span className="group-hint">随包发布，按需开关，点击卡片进入详情配置</span>
            </div>
            {official.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} onOpen={setDetailFile} />
            ))}

            <div className="plugin-group-label">
              运行内核 <span className="count">{kernel.length}</span>
              <span className="group-hint">构成 Pneuma 本身，不可停用</span>
            </div>
            {kernelShown.map((row) => (
              <PluginCard key={row.file} row={row} onToggle={toggle} onOpen={setDetailFile} />
            ))}
            {kernel.length > KERNEL_PREVIEW && (
              <button type="button" className="plugin-more" onClick={() => setKernelOpen((open) => !open)}>
                {kernelOpen ? '收起' : `展开其余 ${String(kernel.length - KERNEL_PREVIEW)} 个`}
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
      data-tip="查看详情与配置"
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
        </div>
        <div className={`plugin-desc${row.problem !== undefined ? ' problem' : ''}`}>
          {row.problem !== undefined
            ? `⚠ ${row.problem}`
            : row.description === ''
              ? `${row.file} · 无描述`
              : row.description}
        </div>
      </div>
      {configurable ? (
        <button
          type="button"
          className="icon-btn"
          data-tip="这个插件有配置项：打开详情"
          aria-label={`配置 ${row.name}`}
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
        aria-label={`${row.name} 开关`}
        data-tip={row.toggleable ? (row.enabled ? '停用，即时生效' : '启用，即时生效') : '运行内核的一部分，不可停用'}
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
 * 换宿主版本不该牵动它。三档各有出口：版本→升壳或改区间、产物→查产物路径、
 * 未信任→卡片上的「查看并信任」（另走 `trusted` 字段，不是 problem 的一种）。
 */
const TRUST_PROBLEM_TIERS = {
  version: {
    label: '版本不满足',
    next: '升级宿主（壳）到满足插件声明的 @dsc/ui 区间，或请插件作者把 plugin.json 的 api 改成当前壳支持的区间。',
  },
  artifact: {
    label: '读不到产物',
    next: '检查 ~/.dsc/plugins/<目录名>/ui/client.js 是否在位、可读（目录名与文件名大小写要一字不差），缺了就重新安装这份插件。',
  },
  manifest: {
    label: '清单缺声明',
    next: '检查 ~/.dsc/plugins/<目录名>/plugin.json：文件要在，且写 api（如 "^1.0.0" 的 @dsc/ui 区间）。',
  },
  clash: {
    label: '与内置插件撞名',
    next: '把插件目录改名，不要与内置插件的 id 相同。',
  },
} as const satisfies Record<NonNullable<TrustRow['problemKind']>, { label: string; next: string }>

/** 宿主没标档（更老的宿主）时的兜底：不猜，照原文让用户自己去看目录。 */
const UNKNOWN_TRUST_PROBLEM = {
  label: '装不上',
  next: '照上面的原因检查 ~/.dsc/plugins/<目录名>/ 里的 plugin.json 与 ui/client.js。',
} as const

/** 一行问题的档：有标用标，没标给兜底。 */
function trustProblemTier(kind: TrustRow['problemKind']): { label: string; next: string } {
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
  const trustedAt = row.trustedAt === undefined ? '' : `（${new Date(row.trustedAt).toLocaleDateString()}）`
  // 装不上的档（problem 才存在）：行里放档名 + 判定依据，行下常驻下一步。
  const tier = row.problem === undefined ? null : trustProblemTier(row.problemKind)
  const desc =
    row.problem !== undefined && tier !== null
      ? `⚠ ${tier.label}：${row.problem}`
      : row.trusted
        ? '已确认信任，可以启停（停用或启用都在刷新页面后生效）'
        : '未信任：还没有信任记录——首次安装需要在插件中心确认一次（它将能调用宿主的界面方法）'
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
            {row.trusted ? <span className="plugin-apiver">已信任{trustedAt}</span> : null}
          </div>
          <div className={`plugin-desc${row.problem !== undefined ? ' problem' : ''}`}>{desc}</div>
          {tier !== null ? <div className="trust-next">下一步：{tier.next}</div> : null}
        </div>
        {row.problem === undefined && !row.trusted ? (
          <button type="button" className="btn-primary" onClick={onOpen}>
            {open ? '收起' : '查看并信任'}
          </button>
        ) : null}
        {row.trusted ? (
          <button
            type="button"
            className={`switch${row.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={row.enabled}
            aria-label={`${row.name} 开关`}
            data-tip={row.enabled ? '停用，刷新页面后生效' : '启用，刷新页面后生效'}
            onClick={() => {
              onToggle(!row.enabled)
            }}
          />
        ) : null}
      </div>
      {open ? (
        <div className="trust-disclosure">
          <div className="settings-group-title">信任后它能做什么</div>
          <ul>
            <li>
              @dsc/ui 区间：{row.api ?? '(没写)'}
              {hello === null ? '' : `（当前壳 v${hello.host.version}，不满足会被门禁拦下并说明）`}
            </li>
            <li>载体：{row.platforms.join('/')}</li>
            <li>能力：调用宿主界面通道的白名单方法；桌面窗口里可用原生桥（打开目录、终端等操作）</li>
            <li>生效：重启宿主（或刷新页面）后装载；停用与启用都走这张卡上的开关</li>
          </ul>
          <div className="trust-actions">
            <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>
              {busy ? '正在写…' : '确认信任'}
            </button>
            <button type="button" className="btn-ghost" onClick={onOpen}>
              取消
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, plugin.enabled, plugin.settingsSection])

  const sourceLabel = plugin.source === 'external' ? '自定义' : plugin.toggleable ? '官方' : '运行内核'
  return (
    <div className="plugin-detail">
      <div className="plugin-detail-top">
        <button type="button" className="plugin-back" data-tip="返回插件列表" onClick={onBack}>
          <IconChevronRight size={14} />
          插件
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
            {plugin.problem !== undefined ? `⚠ ${plugin.problem}` : plugin.description === '' ? '无描述' : plugin.description}
          </div>
        </div>
        {plugin.toggleable && (
          <button
            type="button"
            className={`switch${plugin.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${plugin.name} 开关`}
            data-tip={plugin.enabled ? '停用，即时生效' : '启用，即时生效'}
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
        <div className="settings-group-title">配置</div>
        {section === undefined ? (
          <div className="settings-empty">正在读取配置…</div>
        ) : section === null ? (
          plugin.enabled ? (
            <div className="settings-empty">该插件没有可配置项。</div>
          ) : (
            <div className="settings-empty">插件已停用，启用后才能配置。</div>
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
        // 有的分区（安全钩子那种）控件清单跟着内容走：多加一条规则，下拉里就多一项。
        onAction()
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

/** 名称 → 稳定的图标底色（旧界面同款小把戏：同一个插件每次都是同一个色）。 */
function iconColor(name: string): string {
  const palette = ['#4c8dff', '#a06bff', '#2fb27c', '#e0a13a', '#e05a5a', '#3ab6c9']
  let hash = 0
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 997
  return palette[hash % palette.length] ?? palette[0]!
}

/** 拿异常的文字形态（宿主与桥都可能抛 Error，也可能是别的值）。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
