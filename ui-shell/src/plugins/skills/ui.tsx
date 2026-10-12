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
  IconFolder,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStore,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useShellPage,
} from '@dsc/ui'

/** 这一页在 page-state 里的 id（侧栏入口与页条目约定同一个值）。 */
const PAGE = 'skills'

/** 来源徽章（用户主目录最常见，不显示；其余说明技能从哪来，旧界面同款）。 */
const SOURCE_LABELS: Record<string, string> = {
  'project-dsc': '本项目 .dsc/skills',
  'project-agents': '本项目 .agents/skills',
  custom: '自定义目录',
  'user-dsc': '',
}

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
}

/** 市场浏览结果（契约 `MarketBrowseResult`）。 */
interface MarketBrowseResult {
  sources: MarketSourceView[]
  source: string
  items: MarketSkillView[]
  error?: string
}

export default defineUiPlugin({
  name: '技能中心',
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
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [market, setMarket] = useState<MarketBrowseResult | null>(null)
  const [marketSource, setMarketSource] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  /** 市场源的编辑草稿（展开编辑时从当前清单填「名字, 地址」一行一条）。 */
  const [sourcesText, setSourcesText] = useState('')
  const [savingSources, setSavingSources] = useState(false)
  /** 正在装的条目（`源/名字`；空串 = 没有在装）。装中按钮禁用，防连点。 */
  const [installing, setInstalling] = useState('')

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

  const browse = (source: string, refresh: boolean): void => {
    setMarketLoading(true)
    void channel
      .invoke<MarketBrowseResult>('browseMarket', [source])
      .then((result) => {
        setMarket(result)
        setMarketSource(result.source)
        // 抓取失败的原因挂在面板里（带重试按钮）；手动刷新额外补一条 Toast 回执。
        if (result.error !== undefined && refresh) toastErr(`获取失败：${result.error}`)
        else if (refresh) toastOk(`已从 ${result.source} 获取 ${String(result.items.length)} 个技能`)
        maybeAutoInstall()
      })
      .catch((error: unknown) => {
        toastErr(`获取失败：${text(error)}`)
      })
      .finally(() => {
        setMarketLoading(false)
      })
  }

  useEffect(() => {
    reloadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel])

  useEffect(() => {
    if (tab === 'market' && market === null && !marketLoading) browse('', false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = skills ?? []
    if (needle === '') return list
    return list.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        (skill.whenToUse ?? '').toLowerCase().includes(needle),
    )
  }, [skills, query])

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
        if (!result.ok) toastErr(`操作失败：${result.error ?? '未知原因'}`)
        else if (result.notice !== undefined) toastOk(result.notice)
        reloadSkills()
      })
      .catch((error: unknown) => {
        toastErr(`操作失败：${text(error)}`)
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
        if (!result.ok || result.skill === undefined) toastErr(`读取正文失败：${result.error ?? '未知原因'}`)
        else setDetail(result.skill)
      })
      .catch((error: unknown) => {
        toastErr(`读取正文失败：${text(error)}`)
      })
  }

  /** 打开所在目录走系统文件管理器（原生桥 `openPath`；浏览器里没有桥）。 */
  const openFolder = (path: string): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr('用系统程序打开只在桌面版里有（浏览器里没有这条桥）')
      return
    }
    void native.invoke<string>('openPath', [path]).then((problem) => {
      if (problem !== '') toastErr(`打开失败：${problem}`)
    })
  }

  /**
   * 导入技能（旧界面同款）：系统文件选择器选「含 SKILL.md 的目录」或 .md 文件，
   * 主进程复制进 ~/.dsc/skills/（原生桥 `installSkill`；人没选文件就不算数）。
   */
  const importSkill = (): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr('导入技能来自桌面外壳的文件选择器，浏览器里没有它')
      return
    }
    void native
      .invoke<string[]>('installSkill')
      .then((names) => {
        if (!Array.isArray(names) || names.length === 0) return
        toastOk(`已导入 ${names.join('、')}`)
        reloadSkills()
      })
      .catch((error: unknown) => {
        toastErr(`导入失败：${text(error)}`)
      })
  }

  /** 装一条市场技能（原生桥 `installMarketSkill`：宿主按源下载并写 ~/.dsc/skills）。 */
  const install = (item: MarketSkillView): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr('安装技能要往 ~/.dsc/skills 写文件，只桌面版能做（浏览器里没有这条桥）')
      return
    }
    setInstalling(`${item.source}/${item.name}`)
    void native
      .invoke<{ ok: boolean; notice?: string; error?: string }>('installMarketSkill', [item.source, item.name])
      .then((result) => {
        if (!result.ok) {
          toastErr(`安装失败：${result.error ?? '未知原因'}`)
          return
        }
        toastOk(result.notice ?? `已安装 ${item.name}`)
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
        toastErr(`安装失败：${text(error)}`)
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
      toastErr('请按格式填写，一行一个源：名字, 仓库地址')
      return
    }
    const native = getHostNative()
    if (!native.available) {
      toastErr('改市场源要写 ~/.dsc 里的设置，只桌面版能做（浏览器里没有这条桥）')
      return
    }
    setSavingSources(true)
    void native
      .invoke<{ ok: boolean; notice?: string; error?: string }>('setMarketSources', [sources])
      .then((result) => {
        if (!result.ok) {
          toastErr(`保存失败：${result.error ?? '未知原因'}`)
          return
        }
        toastOk(result.notice ?? '市场源已保存')
        setSourcesOpen(false)
        setMarket(null)
        browse(sources[0]?.name ?? '', false)
      })
      .catch((error: unknown) => {
        toastErr(`保存失败：${text(error)}`)
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
          <h1>技能</h1>
          <p>可复用的操作手册：模型按需读取，用户用 /技能名 直接调用</p>
        </div>
        <div className="skills-actions">
          <button type="button" className="icon-btn" data-tip="重新扫描技能目录" aria-label="重新扫描技能目录" onClick={reloadSkills}>
            <IconRefresh size={16} />
          </button>
          <button
            type="button"
            className="btn-primary"
            data-tip="从磁盘导入：选含 SKILL.md 的目录或 .md 文件"
            onClick={importSkill}
          >
            <IconPlus size={14} /> 导入技能
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
          <IconBolt size={14} /> 已安装 <span className="count">{skills?.length ?? 0}</span>
        </button>
        <button
          type="button"
          className={tab === 'market' ? 'on' : ''}
          onClick={() => {
            setTab('market')
          }}
        >
          <IconStore size={14} /> 市场 <span className="count">{market?.items.length ?? 0}</span>
        </button>
        <div className="skills-search">
          <IconSearch size={14} />
          <input
            placeholder={tab === 'installed' ? '搜索本机技能' : '搜索市场技能'}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </div>
      </div>

      {tab === 'installed' ? (
        <div className="skills-list">
          {skillsError !== '' && <div className="settings-note error">扫描失败：{skillsError}</div>}
          {skills === null && skillsError === '' && <div className="settings-empty">正在扫描技能目录…</div>}
          {skills !== null && skills.length === 0 && skillsError === '' && (
            <div className="plugins-empty">
              还没有技能。将 <code>&lt;名字&gt;/SKILL.md</code> 放入 <code>~/.dsc/skills/</code> 或项目的{' '}
              <code>.dsc/skills</code>，或点击右上角「导入技能」，也可在「市场」页安装。
            </div>
          )}
          {filtered.map((skill) => (
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
                  {skill.source !== 'user-dsc' && SOURCE_LABELS[skill.source] !== undefined && (
                    <span className="tag">{SOURCE_LABELS[skill.source]}</span>
                  )}
                  {!skill.modelInvocable && <span className="tag">仅手动</span>}
                </div>
                <div className={`skill-desc${skill.problem !== undefined ? ' problem' : ''}`}>
                  {skill.problem !== undefined ? `⚠ ${skill.problem}` : skill.description}
                </div>
                {skill.whenToUse !== undefined && <div className="skill-when">何时用：{skill.whenToUse}</div>}
                <div className="skill-links">
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => {
                      openDetail(skill)
                    }}
                  >
                    {detail?.name === skill.name ? '收起正文' : '查看正文'}
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
                        <IconFolder size={13} /> 打开所在目录
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
                aria-label={`${skill.name} 开关`}
                data-tip={
                  skill.toggleable
                    ? skill.enabled
                      ? '停用，不再进入模型目录并移除命令'
                      : '启用'
                    : '由插件提供，不能在技能中心启停'
                }
                onClick={() => {
                  if (skill.toggleable) toggle(skill)
                }}
              />
            </div>
          ))}
          {skills !== null && skills.length > 0 && filtered.length === 0 && (
            <div className="plugins-empty">没有匹配「{query}」的技能。</div>
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
              {sourcesOpen ? '收起' : '编辑源'}
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                browse(marketSource, true)
              }}
              disabled={marketLoading}
            >
              <IconRefresh size={13} /> {marketLoading ? '抓取中…' : '刷新'}
            </button>
          </div>

          {sourcesOpen && (
            <div className="market-edit">
              <div className="market-edit-hint">一行一个源：名字, 仓库地址（GitHub 仓库或 index.json）。保存即覆盖整份清单。</div>
              <textarea
                className="setting-input mono tall"
                value={sourcesText}
                placeholder={'名字, https://github.com/…'}
                aria-label="市场源清单"
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
                {savingSources ? '保存中…' : '保存市场源'}
              </button>
            </div>
          )}

          {marketLoading && market === null && <div className="settings-empty">正在获取市场清单…</div>}
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
                重试
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
              </div>
              <button
                type="button"
                className={`btn-primary market-install${item.installed ? ' done' : ''}`}
                data-tip={item.installed ? '本地已有同名技能' : '安装到 ~/.dsc/skills（桌面版）'}
                disabled={installing === `${item.source}/${item.name}`}
                onClick={() => {
                  if (!item.installed) install(item)
                }}
              >
                {installing === `${item.source}/${item.name}` ? '安装中…' : item.installed ? '已安装' : '安装'}
              </button>
            </div>
          ))}
          {(market?.items.length ?? 0) > 0 && marketFiltered.length === 0 && (
            <div className="plugins-empty">这个源里没有匹配「{query}」的技能。</div>
          )}
          {(market?.items.length ?? 0) === 0 && market?.error === undefined && !marketLoading && market !== null && (
            <div className="plugins-empty">这个源没有解析出技能。检查地址是否指向一个 GitHub 仓库或 index.json。</div>
          )}
        </div>
      )}

      <div className="skills-foot">模型仅能看到技能名称与一句话说明；正文按需读取，不常驻上下文。</div>
    </div>
  )
}

/** 拿异常的文字形态（宿主与桥都可能抛 Error，也可能是别的值）。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
