/**
 * 内置插件：技能中心（主区**独立整页**，对照旧桌面界面 `SkillsView.tsx`）。
 *
 * 形态对齐旧界面：侧栏「技能」入口把主区整页切成这一页（顶栏与正文一起让位，
 * 再点一次侧栏入口回对话页）。两个 tab 与旧界面同款：
 *
 * - **已安装**：本机扫出来的技能（含插件贡献的虚拟技能），可启停、看正文、开出目录、
 *   从磁盘导入；
 * - **市场**：从配置的市场源（默认 anthropics/skills 与本仓库 .agents/skills）浏览条目，
 *   可安装、可编辑源清单。
 *
 * 数据走 `listSkills` / `readSkill` / `setSkillEnabled` / `browseMarket`（都在界面通道
 * 放行面上）；「导入技能」「安装市场技能」「保存市场源」是**供应链写入口**——它们走
 * 桌面窗口的原生桥（`installSkill` / `installMarketSkill` / `setMarketSources`），
 * 界面通道（浏览器与远程页够得着的那条面）持续排除这几个方法。浏览器的说法是
 * 一句诚实的「只桌面版能做」，不是假装有按钮。
 *
 * @module dsc-ui-shell/plugins/skills
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStore,
  createT,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useShellPage,
} from '@dsc/ui'
import { SkeletonText, errText as text, humanErrorText } from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 这一页在 page-state 里的 id（侧栏入口与页条目约定同一个值）。 */
const PAGE = 'skills'

/**
 * 来源标签：技能页按发现根分组，组头写「这批技能来自哪」（与 dsh 设置页的技能分组同口径）。
 * `user-dsh` 是 dsh 自己的全局技能目录，`user-agents` 是公共 Agent 目录（`~/.agents/skills`）。
 */
const SOURCE_LABELS: Record<string, string> = {
  'project-dsc': t('source.projectDsc'),
  'project-agents': t('source.projectAgents'),
  custom: t('source.custom'),
  'user-agents': t('source.userAgents'),
  'user-dsc': t('source.userDsc'),
  'user-dsh': t('source.userDsh'),
}

/** 分组的先后：项目在前（它们压过同名的全局技能），再按全局目录的优先级。 */
const SOURCE_ORDER = ['project-dsc', 'project-agents', 'custom', 'user-agents', 'user-dsc', 'user-dsh']

/** 宿主 `listSkills` 回来的形状（契约 `SkillInfoView`）。 */
interface SkillRow {
  name: string
  description: string
  whenToUse?: string
  source: string
  path?: string
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  toggleable: boolean
  problem?: string
  /** 项目 / 全局作用域（宿主算的，见 core/skills.ts 的发现根）。 */
  scope?: 'project' | 'global'
  /** 发现根目录（分组头显示）。 */
  root?: string
}

/** `readSkill` 回来的形状（契约 `SkillDetail`）。 */
interface SkillDetail {
  name: string
  content: string
}

/** 市场源的展示形状（契约 `MarketSourceView`）。 */
interface MarketSourceView {
  name: string
  url: string
  ok: boolean
  error?: string
}

/** 市场条目（契约 `MarketSkillView`）。 */
interface MarketSkillView {
  name: string
  description: string
  source: string
  version?: string
  installed: boolean
  /** 市场侧统计（ClawHub 给下载/安装/星标；其它源没有）。 */
  stats?: { downloads?: number; installs?: number; stars?: number }
}

/** 市场浏览结果（契约 `MarketBrowseResult`）。 */
interface MarketBrowseResult {
  sources: MarketSourceView[]
  source: string
  items: MarketSkillView[]
  error?: string
}

export default defineUiPlugin({
  name: t('plugin.name'),
  apply(ui) {
    ui.slots.register('shell.page', { id: 'skills.page', order: 20 }, SkillsPage)
  },
})

/** 技能页条目：不是自己在前台就整个不渲染（页条目都由壳的 `shell.page` 槽统一挂着）。 */
function SkillsPage(): ReactNode {
  const page = useShellPage()
  if (page !== PAGE) return null
  return <SkillsView />
}

function SkillsView(): ReactNode {
  const channel = useHostChannel()
  // 自检钩子：?skillstab=market 直接进市场 tab（打断点/截图脚本不用模拟点击）。
  const [tab, setTab] = useState<'installed' | 'market'>(() =>
    new URLSearchParams(location.search).get('skillstab') === 'market' ? 'market' : 'installed',
  )
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [skillsError, setSkillsError] = useState('')
  const [query, setQuery] = useState('')
  /** 作用域筛选：与 dsh 设置页「全局技能 / 项目技能」两个页签同一个口径，这里多一个「全部」。 */
  const [scopeTab, setScopeTab] = useState<'all' | 'global' | 'project'>('all')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [market, setMarket] = useState<MarketBrowseResult | null>(null)
  const [marketSource, setMarketSource] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)
  /**
   * 市场获取失败的原文（宿主超时、网络错、源地址坏都记这里）。
   *
   * 为什么要单独一个 state：失败时 `market` 仍是 `null`，只看它分不清「还没开始」和
   * 「已经失败了」——上一版就是这样，30 秒超时后主区一片空白，用户只能看见右下角一闪
   * 而过的 Toast。有了这条，面板里能常驻显示原因和重试按钮。
   */
  const [marketError, setMarketError] = useState('')
  const [sourcesOpen, setSourcesOpen] = useState(false)
  /** 市场源的编辑草稿（展开编辑时从当前清单填「名字, 地址」一行一条）。 */
  const [sourcesText, setSourcesText] = useState('')
  const [savingSources, setSavingSources] = useState(false)
  /** 正在装的条目（`源/名字`；空串 = 没有在装）。装中按钮禁用，防连点。 */
  const [installing, setInstalling] = useState('')
  /**
   * 收起的分组（键是发现根目录或 `provider:<源名>`）。
   *
   * 为什么要能收：全局技能来自四个目录，平铺一屏几十行，找某一组要一路滚；
   * 组头点一下收起来，剩下的组就挤在一屏里（dsh 技能面板同款）。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const reloadSkills = (): void => {
    void channel
      .invoke<SkillRow[]>('listSkills')
      .then((list) => {
        setSkills(list)
        setSkillsError('')
      })
      .catch((error: unknown) => {
        setSkillsError(text(error))
      })
  }

  /** 当前源是不是搜索型（skills.sh）：它的条目取决于搜索词。 */
  const isSearchSource = (name: string): boolean => {
    const source = (market?.sources ?? []).find((item) => item.name === name)
    return source !== undefined && /^https?:\/\/skills\.sh/i.test(source.url)
  }

  const browse = (source: string, refresh: boolean, search?: string): void => {
    // 搜索型源必须带关键词：调用方没给就用搜索框里当前的词
    const needle = search ?? (source !== '' && isSearchSource(source) ? query : undefined)
    setMarketLoading(true)
    void channel
      .invoke<MarketBrowseResult>('browseMarket', [source, needle])
      .then((result) => {
        setMarket(result)
        setMarketSource(result.source)
        setMarketError('')
        // 抓取失败的原因挂在面板里（带重试按钮）；手动刷新额外补一条 Toast 回执。
        if (result.error !== undefined && refresh) toastErr(t('toast.fetchFailed', { error: result.error }))
        else if (refresh) toastOk(t('toast.fetched', { source: result.source, count: result.items.length }))
        maybeAutoInstall()
      })
      .catch((error: unknown) => {
        setMarketError(text(error))
        toastErr(t('toast.fetchFailed', { error: text(error) }))
      })
      .finally(() => {
        setMarketLoading(false)
      })
  }

  useEffect(() => {
    reloadSkills()
    // 只认通道：reloadSkills 每次渲染都是新函数。
  }, [channel])

  useEffect(() => {
    if (tab === 'market' && market === null && !marketLoading) browse('', false)
    // 只在切到「市场」页签时拉一次：browse 每次渲染都是新函数。
  }, [tab])

  /**
   * 搜索型源（skills.sh）跟着搜索框走：停手 350ms 再查。
   *
   * 为什么不 onChange 就查：那是一个按键一次网络请求，敲十个字就是十次搜索。
   * 依赖只放搜索词与页签——market / marketSource 的变化不该再触发一轮查询。
   */
  useEffect(() => {
    if (tab !== 'market' || marketSource === '') return
    const needle = query.trim()
    if (needle.length < 2 || !isSearchSource(marketSource)) return
    const timer = setTimeout(() => {
      browse(marketSource, false, needle)
    }, 350)
    return () => {
      clearTimeout(timer)
    }
  }, [query, tab, marketSource])

  /** 作用域计数（「全部 / 全局 / 项目」三个页签上的读数）。 */
  const scopeCounts = useMemo(() => {
    const list = skills ?? []
    const global = list.filter((skill) => (skill.scope ?? 'global') === 'global').length
    return { all: list.length, global, project: list.length - global }
  }, [skills])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const inScope = (skills ?? []).filter(
      (skill) => scopeTab === 'all' || (skill.scope ?? 'global') === scopeTab,
    )
    if (needle === '') return inScope
    return inScope.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        (skill.whenToUse ?? '').toLowerCase().includes(needle),
    )
  }, [skills, query, scopeTab])

  /**
   * 按发现根分组（组头写标签、条数与目录）。
   *
   * 为什么要分组：全局技能来自四个地方（公共 Agent、~/.dsc、DSH、自定义目录），
   * 平铺成一列之后「这条是哪来的、同名时谁赢」看不出来；dsh 设置页也是按目录分组的。
   */
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; root?: string; order: number; items: SkillRow[] }>()
    for (const skill of filtered) {
      const key = skill.root ?? `provider:${skill.source}`
      let group = map.get(key)
      if (group === undefined) {
        group = {
          key,
          label: SOURCE_LABELS[skill.source] ?? t('group.provider'),
          root: skill.root,
          order: SOURCE_ORDER.indexOf(skill.source) === -1 ? SOURCE_ORDER.length : SOURCE_ORDER.indexOf(skill.source),
          items: [],
        }
        map.set(key, group)
      }
      group.items.push(skill)
    }
    return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }, [filtered])

  const marketFiltered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const items = market?.items ?? []
    if (needle === '') return items
    return items.filter(
      (item) => item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle),
    )
  }, [market, query])

  const toggle = (skill: SkillRow): void => {
    const next = !skill.enabled
    setSkills((current) => current?.map((item) => (item.name === skill.name ? { ...item, enabled: next } : item)) ?? null)
    void channel
      .invoke<{ ok: boolean; error?: string; notice?: string }>('setSkillEnabled', [skill.name, next])
      .then((result) => {
        if (!result.ok) toastErr(t('toast.actionFailed', { error: result.error ?? t('common.unknownReason') }))
        else if (result.notice !== undefined) toastOk(result.notice)
        reloadSkills()
      })
      .catch((error: unknown) => {
        toastErr(t('toast.actionFailed', { error: text(error) }))
        reloadSkills()
      })
  }

  const openDetail = (skill: SkillRow): void => {
    if (detail?.name === skill.name) {
      setDetail(null)
      return
    }
    void channel
      .invoke<{ ok: boolean; skill?: SkillDetail; error?: string }>('readSkill', [skill.name])
      .then((result) => {
        if (!result.ok || result.skill === undefined) toastErr(t('toast.readFailed', { error: result.error ?? t('common.unknownReason') }))
        else setDetail(result.skill)
      })
      .catch((error: unknown) => {
        toastErr(t('toast.readFailed', { error: text(error) }))
      })
  }

  /** 打开所在目录走系统文件管理器（原生桥 `openPath`；浏览器里没有桥）。 */
  const openFolder = (path: string): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr(t('toast.openFolderDesktopOnly'))
      return
    }
    void native.invoke<string>('openPath', [path]).then((problem) => {
      if (problem !== '') toastErr(t('toast.openFailed', { error: problem }))
    })
  }

  /**
   * 导入技能（旧界面同款）：系统文件选择器选「含 SKILL.md 的目录」或 .md 文件，
   * 主进程复制进 ~/.dsc/skills/（原生桥 `installSkill`；人没选文件就不算数）。
   */
  const importSkill = (): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr(t('toast.importDesktopOnly'))
      return
    }
    void native
      .invoke<string[]>('installSkill')
      .then((names) => {
        if (!Array.isArray(names) || names.length === 0) return
        toastOk(t('toast.imported', { names: names.join(t('common.listSep')) }))
        reloadSkills()
      })
      .catch((error: unknown) => {
        toastErr(t('toast.importFailed', { error: text(error) }))
      })
  }

  /** 装一条市场技能（原生桥 `installMarketSkill`：宿主按源下载并写 ~/.dsc/skills）。 */
  const install = (item: MarketSkillView): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr(t('toast.installDesktopOnly'))
      return
    }
    setInstalling(`${item.source}/${item.name}`)
    void native
      .invoke<{ ok: boolean; notice?: string; error?: string }>('installMarketSkill', [item.source, item.name])
      .then((result) => {
        if (!result.ok) {
          toastErr(t('toast.installFailed', { error: result.error ?? t('common.unknownReason') }))
          return
        }
        toastOk(result.notice ?? t('toast.installed', { name: item.name }))
        reloadSkills()
        setMarket((current) =>
          current === null
            ? current
            : {
                ...current,
                items: current.items.map((entry) =>
                  entry.name === item.name && entry.source === item.source ? { ...entry, installed: true } : entry,
                ),
              },
        )
      })
      .catch((error: unknown) => {
        toastErr(t('toast.installFailed', { error: text(error) }))
      })
      .finally(() => {
        setInstalling('')
      })
  }

  /**
   * 保存市场源（原生桥 `setMarketSources`）：一行一个「名字, 地址」，覆盖整份清单，
   * 写回 ~/.dsc/settings.json；存完清空缓存并从第一个源重新抓一次（旧界面同款）。
   */
  const saveSources = (): void => {
    const sources = sourcesText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const [name, url] = line.split(/[,，\t ]+/)
        return { name: (name ?? '').trim(), url: (url ?? '').trim() }
      })
      .filter((source) => source.name !== '' && source.url !== '')
    if (sources.length === 0) {
      toastErr(t('toast.sourceFormat'))
      return
    }
    const native = getHostNative()
    if (!native.available) {
      toastErr(t('toast.sourcesDesktopOnly'))
      return
    }
    setSavingSources(true)
    void native
      .invoke<{ ok: boolean; notice?: string; error?: string }>('setMarketSources', [sources])
      .then((result) => {
        if (!result.ok) {
          toastErr(t('toast.saveFailed', { error: result.error ?? t('common.unknownReason') }))
          return
        }
        toastOk(result.notice ?? t('toast.sourcesSaved'))
        setSourcesOpen(false)
        setMarket(null)
        browse(sources[0]?.name ?? '', false)
      })
      .catch((error: unknown) => {
        toastErr(t('toast.saveFailed', { error: text(error) }))
      })
      .finally(() => {
        setSavingSources(false)
      })
  }

  // 自检钩子：?skillinstall=<源>/<名字> 时，市场清单到手后自动装一次
  //（验证抓取与落盘的真链路，旧界面同款钩子——只是改走原生桥）。
  const autoInstall = useRef(new URLSearchParams(location.search).get('skillinstall'))
  const maybeAutoInstall = (): void => {
    const raw = autoInstall.current
    if (raw === null || !getHostNative().available) return
    autoInstall.current = null
    const slash = raw.indexOf('/')
    if (slash <= 0) return
    const source = raw.slice(0, slash)
    const name = raw.slice(slash + 1)
    install({ name, description: '', source, installed: false })
  }

  return (
    <div className="skills">
      <div className="skills-head">
        <div>
          <h1>{t('page.title')}</h1>
          <p>{t('page.desc')}</p>
        </div>
        <div className="skills-actions">
          <button type="button" className="icon-btn" data-tip={t('action.rescan')} aria-label={t('action.rescan')} onClick={reloadSkills}>
            <IconRefresh size={16} />
          </button>
          <button
            type="button"
            className="btn-primary"
            data-tip={t('action.importTip')}
            onClick={importSkill}
          >
            <IconPlus size={14} /> {t('action.import')}
          </button>
        </div>
      </div>

      <div className="skills-tabs">
        <button
          type="button"
          className={tab === 'installed' ? 'on' : ''}
          onClick={() => {
            setTab('installed')
          }}
        >
          <IconBolt size={14} /> {t('tab.installed')} <span className="count">{skills?.length ?? 0}</span>
        </button>
        <button
          type="button"
          className={tab === 'market' ? 'on' : ''}
          onClick={() => {
            setTab('market')
          }}
        >
          <IconStore size={14} /> {t('tab.market')} <span className="count">{market?.items.length ?? 0}</span>
        </button>
        <div className="skills-search">
          <IconSearch size={14} />
          <input
            placeholder={tab === 'installed' ? t('search.installed') : t('search.market')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </div>
      </div>

      {/* 作用域：全局（公共 Agent / ~/.dsc / DSH / 自定义目录）与项目分开看，与 dsh 同口径。 */}
      {tab === 'installed' ? (
        <div className="skills-scope" role="group" aria-label={t('scope.aria')}>
          {([
            { value: 'all', label: t('scope.all'), count: scopeCounts.all },
            { value: 'global', label: t('scope.global'), count: scopeCounts.global },
            { value: 'project', label: t('scope.project'), count: scopeCounts.project },
          ] as const).map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={scopeTab === chip.value ? 'on' : ''}
              aria-pressed={scopeTab === chip.value}
              onClick={() => {
                setScopeTab(chip.value)
              }}
            >
              {chip.label} <span className="count">{chip.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'installed' ? (
        <div className="skills-list">
          {skillsError !== '' && (
            <div className="settings-note error">{t('list.scanFailed', { message: humanErrorText(skillsError).text })}</div>
          )}
          {skills === null && skillsError === '' && (
            <div className="settings-loading" role="status" aria-label={t('list.scanning')}>
              <SkeletonText lines={4} />
              <SkeletonText lines={3} widths={['100%', '100%', '54%']} />
            </div>
          )}
          {skills !== null && skills.length === 0 && skillsError === '' && (
            <div className="empty-card">
              <span className="empty-card-icon">
                <IconBolt size={18} />
              </span>
              <div className="empty-card-title">{t('empty.title')}</div>
              <p className="empty-card-desc">
                {t('empty.lead')}
                <code>{t('empty.pattern')}</code>
                {t('empty.into')}
                <code>~/.dsc/skills/</code>
                {t('empty.sep')}
                <code>~/.agents/skills/</code>
                {t('empty.sharedAgent')}
                <code>~/.dsh/skills/</code>
                {t('empty.dshGlobal')}
                <code>.dsc/skills</code>
                {t('empty.tail')}
              </p>
              <div className="empty-card-actions">
                <button type="button" className="btn-primary" onClick={importSkill}>
                  {t('action.import')}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setTab('market')
                  }}
                >
                  {t('empty.toMarket')}
                </button>
              </div>
            </div>
          )}
          {groups.map((group) => (
            <div className="skills-group" key={group.key}>
              <div
                className="skills-group-head"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed.has(group.key)}
                data-tip={collapsed.has(group.key) ? t('group.expand') : t('group.collapse')}
                onClick={() => {
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })
                }}
              >
                {collapsed.has(group.key) ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                <span className="skills-group-title">{group.label}</span>
                <span className="skills-group-count">{t('group.count', { count: group.items.length })}</span>
                {group.root === undefined ? null : (
                  <span className="mono skills-group-path" data-tip={group.root}>{group.root}</span>
                )}
              </div>
              {collapsed.has(group.key) ? null : group.items.map((skill) => (
            <div className={`skill-row${skill.enabled ? '' : ' off'}`} key={`${skill.source}/${skill.name}`}>
              <div className="skill-icon">
                <IconBolt size={15} />
              </div>
              <div className="skill-info">
                <div className="skill-name">
                  <span className="skill-title">
                    <span className="slash">/</span>
                    {skill.name}
                  </span>
                  {/* 来源不再逐行打标：组头已经写了「来自哪个目录」，一行两个徽章反而更吵。 */}
                  {!skill.modelInvocable && <span className="tag">{t('row.manualOnly')}</span>}
                </div>
                <div className={`skill-desc${skill.problem !== undefined ? ' problem' : ''}`}>
                  {skill.problem !== undefined ? `⚠ ${skill.problem}` : skill.description}
                </div>
                {skill.whenToUse !== undefined && (
                  <div className="skill-when">{t('row.whenToUse', { text: skill.whenToUse })}</div>
                )}
                <div className="skill-links">
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => {
                      openDetail(skill)
                    }}
                  >
                    {detail?.name === skill.name ? t('row.hideBody') : t('row.showBody')}
                  </button>
                  {skill.path !== undefined && (
                    <>
                      <button
                        type="button"
                        className="text-btn"
                        data-tip={skill.path}
                        onClick={() => {
                          openFolder(skill.path ?? '')
                        }}
                      >
                        <IconFolder size={13} /> {t('row.openFolder')}
                      </button>
                      <span className="mono skill-path">{skill.path}</span>
                    </>
                  )}
                </div>
                {detail !== null && detail.name === skill.name && <pre className="skill-body">{detail.content}</pre>}
              </div>
              <button
                type="button"
                className={`switch${skill.enabled ? ' on' : ''}${skill.toggleable ? '' : ' locked'}`}
                role="switch"
                aria-checked={skill.enabled}
                aria-label={t('row.toggleAria', { name: skill.name })}
                data-tip={
                  skill.toggleable
                    ? skill.enabled
                      ? t('row.toggleOff')
                      : t('row.toggleOn')
                    : t('row.toggleLocked')
                }
                onClick={() => {
                  if (skill.toggleable) toggle(skill)
                }}
              />
            </div>
              ))}
            </div>
          ))}
          {skills !== null && skills.length > 0 && filtered.length === 0 && (
            <div className="plugins-empty">{t('list.noMatch', { query })}</div>
          )}
        </div>
      ) : (
        <div className="skills-list">
          <div className="market-sources">
            {(market?.sources ?? []).map((source) => (
              <button
                key={source.name}
                type="button"
                className={`source-chip${source.name === marketSource ? ' on' : ''}${source.ok ? '' : ' bad'}`}
                data-tip={source.ok ? source.url : `${source.url}\n${source.error ?? ''}`}
                onClick={() => {
                  browse(source.name, false)
                }}
              >
                {source.name}
              </button>
            ))}
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                if (sourcesOpen) {
                  setSourcesOpen(false)
                  return
                }
                // 展开时把当前清单填成「名字, 地址」一行一条（旧界面同款）。
                setSourcesText((market?.sources ?? []).map((source) => `${source.name}, ${source.url}`).join('\n'))
                setSourcesOpen(true)
              }}
            >
              {sourcesOpen ? t('market.collapse') : t('market.editSources')}
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                browse(marketSource, true)
              }}
              disabled={marketLoading}
            >
              <IconRefresh size={13} /> {marketLoading ? t('market.fetching') : t('market.refresh')}
            </button>
          </div>

          {sourcesOpen && (
            <div className="market-edit">
              <div className="market-edit-hint">{t('market.hint')}</div>
              <textarea
                className="setting-input mono tall"
                value={sourcesText}
                placeholder={t('market.placeholder')}
                aria-label={t('market.sourcesAria')}
                onChange={(event) => {
                  setSourcesText(event.target.value)
                }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={savingSources}
                onClick={saveSources}
              >
                {savingSources ? t('market.saving') : t('market.save')}
              </button>
            </div>
          )}

          {marketLoading && market === null && <div className="settings-empty">{t('market.loading')}</div>}
          {!marketLoading && market === null && marketError !== '' && (
            <div className="settings-note error">
              {marketError}
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  browse(marketSource, true)
                }}
              >
                {t('market.retry')}
              </button>
            </div>
          )}
          {market?.error !== undefined && market.items.length === 0 && (
            <div className="settings-note error">
              {market.error}
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  browse(marketSource, true)
                }}
              >
                {t('market.retry')}
              </button>
            </div>
          )}
          {marketFiltered.map((item) => (
            <div className="market-row" key={`${item.source}/${item.name}`}>
              <div className="skill-icon store">
                <IconStore size={15} />
              </div>
              <div className="skill-info">
                <div className="skill-name">
                  {item.name}
                  <span className="tag">{item.source}</span>
                  {item.version !== undefined && <span className="tag">v{item.version}</span>}
                </div>
                <div className="skill-desc">{item.description}</div>
                {item.stats !== undefined && (
                  <div className="skill-stats">
                    {[
                      item.stats.downloads === undefined
                        ? ''
                        : t('market.downloads', { count: item.stats.downloads.toLocaleString('en-US') }),
                      item.stats.installs === undefined
                        ? ''
                        : t('market.installs', { count: item.stats.installs.toLocaleString('en-US') }),
                      item.stats.stars === undefined
                        ? ''
                        : t('market.stars', { count: item.stats.stars.toLocaleString('en-US') }),
                    ]
                      .filter((part) => part !== '')
                      .join(' · ')}
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`btn-primary market-install${item.installed ? ' done' : ''}`}
                data-tip={item.installed ? t('market.installedTip') : t('market.installTip')}
                disabled={installing === `${item.source}/${item.name}`}
                onClick={() => {
                  if (!item.installed) install(item)
                }}
              >
                {installing === `${item.source}/${item.name}`
                  ? t('market.installing')
                  : item.installed
                    ? t('market.installed')
                    : t('market.install')}
              </button>
            </div>
          ))}
          {(market?.items.length ?? 0) > 0 && marketFiltered.length === 0 && (
            <div className="plugins-empty">{t('market.noMatch', { query })}</div>
          )}
          {(market?.items.length ?? 0) === 0 && market?.error === undefined && !marketLoading && market !== null && (
            <div className="plugins-empty">{t('market.empty')}</div>
          )}
        </div>
      )}

      <div className="skills-foot">{t('page.foot')}</div>
    </div>
  )
}
