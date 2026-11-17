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

// ── 市场结果的进程内缓存 ─────────────────────────────────────────────────────
// 为什么挂在模块作用域：`SkillsPage` 在离开这一页时整个卸载（页条目不渲染就没了），
// 组件 state 全部丢掉。缓存放模块上才能跨卸载保留：回来直接命中，不用再等一次 2~20 秒的抓取。

/** 一条市场缓存：结果 + 写入时间（`at` 既判新鲜期，也当淘汰顺序）。 */
interface MarketCacheEntry {
  result: MarketBrowseResult
  at: number
}

/** 缓存键 = 源名 + 搜索词；非搜索型源的搜索词恒为空串，`source === ''`（首个源）也走同一规则。 */
function marketCacheKey(source: string, needle: string): string {
  return `${source}\u0000${needle}`
}

/** 缓存与在途请求按同一个键索引，因此放在一起。 */
const marketCache = new Map<string, MarketCacheEntry>()
const marketInflight = new Map<string, Promise<MarketBrowseResult>>()

/** 缓存条数上限：默认源清单 + 常用搜索词够用，超出按最旧淘汰。 */
const MARKET_CACHE_LIMIT = 24

/**
 * 新鲜期：1 小时内的自动路径不联网。
 *
 * 与宿主 `browseMarketSource` 的磁盘缓存 TTL 同口径——界面这层管「离开页面再回来不重抓」，
 * 宿主那层管「进程重启后不重抓」，两层都过期才真的等网络。
 */
const MARKET_FRESH_MS = 60 * 60 * 1000

/** 搜索型源的最小关键词长度：宿主 `browseMarketSource` 对 skills.sh 同样要求 2 个字符。 */
const MIN_SEARCH_CHARS = 2

/** 上次看过的市场视图（真源名 + 搜索词）：卸载后靠它把列表、当前源、搜索框一起还原。 */
let lastMarketView: { source: string; needle: string } | null = null

/** 上次停在哪个页签：卸载后回来还停在这一页（`?skillstab=` 自检钩子优先）。 */
let lastTab: 'installed' | 'market' = 'installed'

/** 上次拿到的源清单：卸载后再进来，源 chip 不用等一次网络就能画出来。 */
let lastMarketSources: MarketSourceView[] = []

/** 这个界面会话是否已经预取过市场源（每会话一次，失败后不反复重试）。 */
let marketPrefetched = false

/**
 * 源清单版本：用户改过一次市场源就 +1。
 *
 * 用来作废「改源之前发出去、改完之后才回来」的请求——那些结果属于旧清单，
 * 写进缓存会把新源名下的条目换成旧地址抓到的内容。
 */
let marketEpoch = 0

/**
 * 纯读一条缓存：不动 Map 顺序。
 *
 * 给渲染期的还原路径用——渲染函数必须是纯的，挪队尾这种副作用只能发生在事件 / effect 里
 * （React 严格模式下渲染会跑两遍，渲染期改模块级 Map 等于两遍顺序不一样）。
 */
function peekMarketCache(key: string): MarketCacheEntry | undefined {
  return marketCache.get(key)
}

/**
 * 读一条缓存（事件 / effect 路径用）；命中与否由调用方判新鲜期。
 *
 * 命中就把这条挪到 Map 队尾：24 条上限按「最近使用」淘汰，而不是按写入先后——
 * 只按写入顺序的话，一直回来的那个源反而会被反复点开时的旧条目挤掉。
 */
function readMarketCache(key: string): MarketCacheEntry | undefined {
  const entry = marketCache.get(key)
  if (entry === undefined) return undefined
  marketCache.delete(key)
  marketCache.set(key, entry)
  return entry
}

/**
 * 写一条缓存。
 *
 * 「失败且一条可用结果都没有」的结果不写：否则接下来一小时里每次进市场都只回放这张红条，
 * 用户连重试都没得点。
 */
function saveMarketCache(key: string, result: MarketBrowseResult): void {
  if (result.error !== undefined && result.items.length === 0) return
  // 先删再写：Map 的插入顺序当淘汰队列，重写同一条也要挪到队尾
  marketCache.delete(key)
  marketCache.set(key, { result, at: Date.now() })
  while (marketCache.size > MARKET_CACHE_LIMIT) {
    const oldest = marketCache.keys().next()
    if (oldest.done === true) break
    marketCache.delete(oldest.value)
  }
}

/** 源地址是不是 skills.sh：它只有搜索能出条目，没有榜单接口。 */
function isSkillsShUrl(url: string): boolean {
  return /^https?:\/\/skills\.sh/i.test(url)
}

/** 宿主通道里本页用到的那一小面（`@dsc/ui` 转出了 hook，没转出通道类型，就从 hook 反推）。 */
type MarketChannel = ReturnType<typeof useHostChannel>

/**
 * 发一次市场请求：同一个键的在途请求只发一次，并发调用复用同一个 Promise。
 *
 * 不碰组件 state——预取、后台刷新、当前视图三条路径都经这一层，所以这里只管缓存与去重。
 * 缓存写在这里而不是调用方：离开页面后请求仍会落地，下一次进来就能直接命中。
 *
 * `force = true` 是手动刷新：它不和在途请求合并（就是要作废手里那份、重新问宿主），
 * 并且把布尔量作为第三个参数交给宿主——只有宿主收到它才会跳过自己的内存/磁盘缓存。
 */
function requestMarket(
  channel: MarketChannel,
  source: string,
  needle: string,
  force = false,
): Promise<MarketBrowseResult> {
  const key = marketCacheKey(source, needle)
  const running = force ? undefined : marketInflight.get(key)
  if (running !== undefined) return running
  const epoch = marketEpoch
  // 第三参只在手动刷新时传：老宿主的方法规格只收 2 个实参，多传会被当成非法调用拒掉
  const args: unknown[] = force ? [source, needle, true] : [source, needle]
  const task = channel
    .invoke<MarketBrowseResult>('browseMarket', args)
    .then((result) => {
      // 改源之后才回来的旧结果：不写缓存，交给调用方当次用完就算
      if (epoch !== marketEpoch) return result
      saveMarketCache(key, result)
      // `source === ''` 是「首个源」：结果里带着真源名，顺手写一条别名缓存，
      // 否则用户点同名 chip 会把刚抓到的同一份清单再联网抓一遍。
      if (source === '' && result.source !== '') saveMarketCache(marketCacheKey(result.source, needle), result)
      if (result.sources.length > 0) lastMarketSources = result.sources
      return result
    })
    .finally(() => {
      if (!force) marketInflight.delete(key)
    })
  if (!force) marketInflight.set(key, task)
  return task
}

/**
 * 预取市场源（每个界面会话一次）：先拉「首个源」拿到源清单，再按清单串行拉其余非搜索型源。
 *
 * 为什么串行：GitHub 抓一个源要 2~20 秒，同时甩出去只会把网络和宿主一起打满；串行还保证
 * 用户点开市场那一刻首个源已经回来了。失败一律静默——预取只是加速，用户点开时 `browse`
 * 会重试并把错误显示出来，所以这里不弹 Toast、不写错误状态。
 */
function prefetchMarket(channel: MarketChannel): void {
  if (marketPrefetched) return
  marketPrefetched = true
  const epoch = marketEpoch
  void (async () => {
    let list = lastMarketSources.filter((item) => item.ok !== false)
    if (list.length === 0) {
      let first: MarketBrowseResult
      try {
        first = await requestMarket(channel, '', '')
      } catch {
        // 吞掉：预取失败不打扰用户，点开市场时 browse 会再试一次
        return
      }
      list = first.sources.filter((item) => item.ok !== false)
    }
    for (const source of list) {
      if (epoch !== marketEpoch) return
      if (isSkillsShUrl(source.url)) continue
      if (readMarketCache(marketCacheKey(source.name, '')) !== undefined) continue
      try {
        await requestMarket(channel, source.name, '')
      } catch {
        // 吞掉：单个源失败不影响后面几个；用户点它时 browse 会重试
      }
    }
  })()
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
  /**
   * 初始页签：`?skillstab=` 自检钩子最优先；没有就回到上次停的那一页。
   * 卸载后回来还停在市场、再配合缓存还原，就不用「跳回已安装 → 再手点市场」这一下。
   */
  const initialTab: 'installed' | 'market' = (() => {
    const fromUrl = new URLSearchParams(location.search).get('skillstab')
    if (fromUrl === 'market' || fromUrl === 'installed') return fromUrl
    return lastTab
  })()
  const [tab, setTab] = useState<'installed' | 'market'>(initialTab)
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [skillsError, setSkillsError] = useState('')
  /**
   * 上次市场视图的快照（只在首次渲染算一次）。
   *
   * 页面卸载后 state 全丢，所以初始值直接从模块级缓存还原：离开技能页再回来，
   * 点开市场就是上次那批条目，不联网、不闪加载骨架。
   */
  const restored = useRef<{ result: MarketBrowseResult; source: string; needle: string } | null | undefined>(undefined)
  if (restored.current === undefined) {
    restored.current = null
    const view = lastMarketView
    if (view !== null) {
      const entry = peekMarketCache(marketCacheKey(view.source, view.needle))
      if (entry !== undefined) {
        restored.current = {
          result: entry.result,
          source: entry.result.source !== '' ? entry.result.source : view.source,
          needle: view.needle,
        }
      }
    }
  }
  const restoredView = restored.current
  /** 还原出来的视图是不是搜索型源：只有它是，搜索框才跟着还原上次的关键词。 */
  const restoredIsSearch =
    restoredView !== null &&
    lastMarketSources.some((item) => item.name === restoredView.source && isSkillsShUrl(item.url))

  /**
   * 搜索框内容：已安装 tab 用来过滤本机技能；市场 tab 里对搜索型源（skills.sh）就是查询词。
   *
   * 只有「一进来就停市场 tab」且还原出来的是搜索型源时才回填上次关键词——否则那串
   * skills.sh 的搜索词会漏进「已安装」tab，把本机技能列表过滤掉。
   */
  const [query, setQuery] = useState(() =>
    restoredIsSearch && initialTab === 'market' ? restoredView?.needle ?? '' : '',
  )
  /** 作用域筛选：与 dsh 设置页「全局技能 / 项目技能」两个页签同一个口径，这里多一个「全部」。 */
  const [scopeTab, setScopeTab] = useState<'all' | 'global' | 'project'>('all')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [market, setMarket] = useState<MarketBrowseResult | null>(() => restoredView?.result ?? null)
  /**
   * 最近一次渲染的 `market`：异步回调（安装回包）里要拿「回包那一刻的列表」。
   *
   * 不能用回调闭包里那份——用户可能已经换了源，旧闭包会把旧源的列表写回去。
   */
  const marketRef = useRef<MarketBrowseResult | null>(market)
  marketRef.current = market
  const [marketSource, setMarketSource] = useState(() => restoredView?.source ?? '')
  /** 源清单单独存：点 skills.sh 时不发请求、列表是空的，但源 chip 仍要画得出来。 */
  const [sources, setSources] = useState<MarketSourceView[]>(() => lastMarketSources)
  /** 当前 `market` 对应哪个缓存键（'' = 手上没有结果）。 */
  const marketKeyRef = useRef(restoredView === null ? '' : marketCacheKey(restoredView.source, restoredView.needle))
  const [marketLoading, setMarketLoading] = useState(false)
  /**
   * 市场获取失败的原文（宿主超时、网络错、源地址坏都记这里）。
   *
   * 为什么要单独一个 state：失败时 `market` 仍是 `null`，只看它分不清「还没开始」和
   * 「已经失败了」——上一版就是这样，30 秒超时后主区一片空白，用户只能看见右下角一闪
   * 而过的 Toast。有了这条，面板里能常驻显示原因和重试按钮。
   */
  const [marketError, setMarketError] = useState('')
  /**
   * 软提示：后台刷新 / 搜索失败但手上还有旧列表时，只在列表上方加一行小字。
   *
   * 和 `marketError` 分开：那条是「一条可用结果都没有」才盖的红条，后台刷新失手不该
   * 把用户正在看的列表整个盖掉。
   */
  const [marketNotice, setMarketNotice] = useState('')
  const [sourcesOpen, setSourcesOpen] = useState(false)
  /** 顶部搜索框：搜索型源切过来时把光标放进去。 */
  const searchRef = useRef<HTMLInputElement>(null)
  /**
   * 关键词是不是「在市场 tab 里亲手输入/改过」的。
   *
   * 防抖自动搜索只看它：从「已安装」tab 带过来的词只是本机技能过滤器，
   * 不该因为切到市场、点了 skills.sh 就自动拿去查一次网络。
   */
  const searchEditedInMarket = useRef(false)
  /** 组件卸载守卫：异步回调落地时如果已经离开技能页，就不再 setState。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  /** 当前视图的请求序号：换源快于上次回包时，旧结果不许盖掉新视图。 */
  const browseToken = useRef(0)

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
    const source = sources.find((item) => item.name === name)
    return source !== undefined && isSkillsShUrl(source.url)
  }

  /** 源清单落地：非空才换（宿主每次浏览都带回完整清单，含各源 ok / error 标记）。 */
  const applySources = (next: MarketSourceView[]): void => {
    if (next.length === 0) return
    lastMarketSources = next
    setSources(next)
  }

  /** 把一份结果落到视图上：列表、当前源、源清单一起换，并记下它对应哪个缓存键。 */
  const applyMarket = (result: MarketBrowseResult, key: string, needle: string): void => {
    setMarket(result)
    if (result.source !== '') {
      setMarketSource(result.source)
      lastMarketView = { source: result.source, needle }
    }
    applySources(result.sources)
    marketKeyRef.current = key
  }

  /**
   * `browse('')` 要抓的那个源是不是搜索型。
   *
   * 宿主对 `source === ''` 固定抓清单里的**第一个源**（`sources[0]`，哪怕它上一轮被标了 bad）。
   * 首个源就是 skills.sh 时，空查询请求只会换来一张「只提供搜索」红条——那不是在报错，
   * 而是这个源本来就要关键词。这种情形界面必须切过去等输入，而不是发请求再报错。
   */
  const firstSourceIsSearch = (list: MarketSourceView[]): boolean => {
    const first = list[0]
    return first !== undefined && isSkillsShUrl(first.url)
  }

  /** 切页签：顺手记住，离开技能页再回来还停在原页签。 */
  const switchTab = (next: 'installed' | 'market'): void => {
    lastTab = next
    setTab(next)
  }

  /**
   * 浏览市场源（本页唯一的市场联网入口）。
   *
   * - 先看模块级缓存：1 小时内新鲜就直接显示、不联网；过期的先把旧结果摆上，再后台刷新。
   * - `force = true` 是手动刷新：丢掉这个键的客户端缓存，并把 `true` 交给宿主跳过它自己的缓存。
   * - 刷新期间不清空列表、不整页 loading；失败时手上还有旧结果就只留一行软提示，
   *   只有一条可用结果都没有才盖红条 + 重试。
   * - 宿主联网失败但回退到旧缓存时，结果里会带 `error` 且 `items` 非空：列表照显示，只一句话提示。
   * - 搜索型源（skills.sh）关键词不到 2 个字符不请求；首个源本身就是搜索型时更不请求。
   */
  const browse = (requested: string, options: { force?: boolean; search?: string } = {}): void => {
    const searchable = requested !== '' && isSearchSource(requested)
    const needle = (options.search ?? (searchable ? query.trim() : '')).trim()
    // 每次调用都推进序号：之前那次请求晚回来也不许盖掉这次选中的视图
    const token = browseToken.current + 1
    browseToken.current = token
    if (searchable && needle.length < MIN_SEARCH_CHARS) {
      // 关键词不够长：不发请求，把市场区让给中性提示（不是错误）
      setMarketSource(requested)
      setMarket(null)
      marketKeyRef.current = ''
      setMarketError('')
      setMarketNotice('')
      setMarketLoading(false)
      return
    }
    // 「首个源」就是搜索型源：切过去等用户输入（宿主对空查询必报错），一个请求都不发
    if (requested === '' && firstSourceIsSearch(sources)) {
      setMarketSource(sources[0]?.name ?? '')
      setMarket(null)
      marketKeyRef.current = ''
      setMarketError('')
      setMarketNotice('')
      setMarketLoading(false)
      return
    }
    const force = options.force === true
    const key = marketCacheKey(requested, needle)
    const cached = force ? undefined : readMarketCache(key)
    if (cached !== undefined && Date.now() - cached.at < MARKET_FRESH_MS) {
      // 新鲜命中：不联网、不闪加载骨架。`source === ''` 的结果里带着真源名，键要归到它名下。
      applyMarket(cached.result, marketCacheKey(cached.result.source !== '' ? cached.result.source : requested, needle), needle)
      setMarketError('')
      // 缓存里如果躺着一份「宿主回退旧缓存」的结果（error + 非空列表），命中时也把软提示补回来，
      // 否则重进市场看起来像是刚刚抓成功。
      const staleReason = cached.result.error
      if (staleReason !== undefined && cached.result.items.length > 0) {
        setMarketNotice(t('market.softFailed', { error: staleReason }))
      } else setMarketNotice('')
      setMarketLoading(false)
      maybeAutoInstall()
      return
    }
    if (force) marketCache.delete(key)
    // 手上还有能显示的旧结果：先摆上（后台刷新期间列表不消失）
    const fallback = cached?.result ?? (marketKeyRef.current === key && market !== null ? market : undefined)
    // 搜索型源换关键词：上一次的结果先留着（搜索中同样不清空），等新结果回来再整体替换
    const keepSearchResults = fallback === undefined && searchable && market !== null && market.items.length > 0
    const hasOld = fallback !== undefined || keepSearchResults
    if (fallback !== undefined) applyMarket(fallback, key, needle)
    else if (keepSearchResults) setMarketSource(requested)
    else {
      setMarketSource(requested)
      setMarket(null)
      marketKeyRef.current = ''
    }
    setMarketError('')
    setMarketNotice('')
    setMarketLoading(true)
    void requestMarket(channel, requested, needle, force)
      .then((result) => {
        if (!alive.current || browseToken.current !== token) return
        const shownKey = marketCacheKey(result.source !== '' ? result.source : requested, needle)
        if (result.error !== undefined) {
          applySources(result.sources)
          // 本次失败的目标就是搜索型源、且关键词还不够长：这不是失败，是「这个源要关键词」，
          // 切过去等输入。放宽到「目标源」而不是「首个源」，保存源后按新首源名 browse 也走这里；
          // 关键词够长却真失败时仍走下面的红条。
          // 认的是宿主这次真正抓的那个源（`result.source`）——它失败时会被标成 ok:false，
          // 不能用「第一个 ok 的源」代替。
          const failedTarget = result.sources.find((item) => item.name === result.source)
          if (
            failedTarget !== undefined &&
            isSkillsShUrl(failedTarget.url) &&
            needle.length < MIN_SEARCH_CHARS
          ) {
            // 空查询被拒是这个源的正常要求，别让它长得像坏源（chip 不标红）
            applySources(
              result.sources.map((item) =>
                item.name === failedTarget.name ? { ...item, ok: true, error: undefined } : item,
              ),
            )
            setMarketSource(failedTarget.name)
            setMarket(null)
            marketKeyRef.current = ''
            setMarketError('')
            setMarketNotice('')
            return
          }
          if (result.items.length > 0) {
            // 宿主联网失败、回退到了旧缓存：列表还能看能装，只提示一句原因，不盖红条
            applyMarket(result, shownKey, needle)
            setMarketNotice(t('market.softFailed', { error: result.error }))
            maybeAutoInstall()
            if (force) toastErr(t('toast.fetchFailed', { error: result.error }))
            return
          }
          // 一条可用结果都没有：有旧列表就只软提示，否则才红条 + 重试
          if (hasOld) setMarketNotice(t('market.softFailed', { error: result.error }))
          else {
            setMarket(null)
            marketKeyRef.current = ''
            setMarketError(result.error)
          }
          if (force) toastErr(t('toast.fetchFailed', { error: result.error }))
          return
        }
        applyMarket(result, shownKey, needle)
        maybeAutoInstall()
        // 手动刷新只在「真的刷新成功」时报成功；宿主回退旧缓存那条走上面的 error 分支
        if (force) toastOk(t('toast.fetched', { source: result.source, count: result.items.length }))
      })
      .catch((error: unknown) => {
        if (!alive.current || browseToken.current !== token) return
        const message = text(error)
        if (hasOld) setMarketNotice(t('market.softFailed', { error: message }))
        else {
          setMarket(null)
          marketKeyRef.current = ''
          setMarketError(message)
        }
        if (force) toastErr(t('toast.fetchFailed', { error: message }))
      })
      .finally(() => {
        if (alive.current && browseToken.current === token) setMarketLoading(false)
      })
  }

  /**
   * 点源 chip：普通源直接浏览（缓存新鲜就秒开）；skills.sh 不自动请求，只等用户输入。
   *
   * 搜索型分支先推进请求序号：否则旧源还在加载时点 skills.sh，旧源回包会通过序号校验、
   * 把视图改回旧源，刚显示的「等输入」提示被无声撤销。
   */
  const selectSource = (name: string): void => {
    if (isSearchSource(name)) {
      browseToken.current += 1
      setMarketSource(name)
      setMarket(null)
      marketKeyRef.current = ''
      setMarketError('')
      setMarketNotice('')
      setMarketLoading(false)
      searchRef.current?.focus()
      return
    }
    browse(name)
  }

  useEffect(() => {
    reloadSkills()
    // 市场源后台预取：不挡已安装列表，也不碰任何市场 state（只温缓存）。
    prefetchMarket(channel)
    // 只认通道：这两个函数每次渲染都是新函数。
  }, [channel])

  /**
   * 切到市场页签：有可还原的结果就直接显示，新鲜就不联网；一条都没有才抓首个源。
   *
   * restore 时 market / marketSource 已经从模块缓存填好，所以离开页面再回来这一条
   * 既不发请求、也不会先闪一次加载骨架。
   */
  useEffect(() => {
    if (tab !== 'market') return
    if (marketSource !== '' && isSearchSource(marketSource)) {
      // 搜索型源：进来不自动请求，只把光标放进搜索框。
      // 同时作废在途的旧源请求——否则它的回包会把视图改回旧源、把提示无声撤销。
      // 还要把 loading 落下来：被作废的那次请求不会再走自己的 finally，否则按钮永远「抓取中…」。
      browseToken.current += 1
      setMarketLoading(false)
      searchRef.current?.focus()
      return
    }
    if (market === null) {
      browse('')
      return
    }
    const cached = marketKeyRef.current === '' ? undefined : readMarketCache(marketKeyRef.current)
    if (cached === undefined || Date.now() - cached.at >= MARKET_FRESH_MS) browse(marketSource)
    // 只在切到「市场」页签时跑一次：browse / isSearchSource 每次渲染都是新函数。
  }, [tab])

  /**
   * 搜索型源（skills.sh）跟着搜索框走：停手 350ms 再查。
   *
   * 为什么不 onChange 就查：那是一个按键一次网络请求，敲十个字就是十次搜索。
   * 关键词不到 2 个字符时既不请求，也不把上一次的结果顶在提示下面——宿主对短查询
   * 只会回一句错误。从「已安装」tab 带过来的词也不自动查：那只是本机技能的过滤器。
   */
  useEffect(() => {
    if (tab !== 'market' || marketSource === '' || !isSearchSource(marketSource)) return
    const needle = query.trim()
    if (needle.length < MIN_SEARCH_CHARS) {
      setMarket(null)
      marketKeyRef.current = ''
      setMarketError('')
      setMarketNotice('')
      setMarketLoading(false)
      return
    }
    if (!searchEditedInMarket.current) return
    const timer = setTimeout(() => {
      browse(marketSource, { search: needle })
    }, 350)
    return () => {
      clearTimeout(timer)
    }
    // 依赖只放搜索词、页签与当前源：market 的变化不该再触发一轮查询。
  }, [query, tab, marketSource])

  /** 搜索型源切过来就把光标放进搜索框（它没有榜单，取词只能靠这里）。 */
  useEffect(() => {
    if (tab !== 'market' || marketSource === '' || !isSearchSource(marketSource)) return
    searchRef.current?.focus()
    // 只在页签 / 当前源变化时聚焦。
  }, [tab, marketSource])

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
    const items = market?.items ?? []
    // 搜索型源的结果已经按关键词搜过一轮了，本地再过一道会把「名字里恰好没这个词」的
    // 命中项错杀——探出来的结果照原样显示。
    if (marketSource !== '' && sources.some((item) => item.name === marketSource && isSkillsShUrl(item.url))) {
      return items
    }
    const needle = query.trim().toLowerCase()
    if (needle === '') return items
    return items.filter(
      (item) => item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle),
    )
  }, [market, query, marketSource, sources])

  /** 市场 tab 的派生读数：当前源是不是搜索型、关键词够不够长（不够就只显示中性提示）。 */
  const searchSource = marketSource !== '' && isSearchSource(marketSource)
  const searchNeedle = query.trim()
  const searchTooShort = searchSource && searchNeedle.length < MIN_SEARCH_CHARS
  /**
   * 搜索型源「在等用户输入」：关键词够长但这次还没在市场里改过（从已安装 tab 带过来的词
   * 不自动查），或刚切过来还没有结果。此时给一行中性提示，不报错。
   */
  const searchWaiting =
    searchSource && !searchTooShort && !marketLoading && market === null && marketError === ''

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
    // 点击这一刻的缓存键：回包时拿它确认「列表还是这一份」，中途换过源就不许写缓存
    const clickedKey = marketKeyRef.current
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
        // 回包时用「最新一帧」的 market（marketRef），不是点击那一刻的闭包：安装要下载几秒，
        // 用户可能已经换源了，旧闭包会把旧源的列表写回视图。
        const current = marketRef.current
        if (current !== null) {
          const next: MarketBrowseResult = {
            ...current,
            items: current.items.map((entry) =>
              entry.name === item.name && entry.source === item.source ? { ...entry, installed: true } : entry,
            ),
          }
          setMarket(next)
          // 只有列表还是点击时那一份，才把「已安装」写回缓存；否则旧源的数据会写进新源的
          // 缓存键，接下来一小时都串源。
          if (clickedKey !== '' && marketKeyRef.current === clickedKey) saveMarketCache(clickedKey, next)
        }
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
        // 源清单变了：本地市场缓存全部作废（同名源的地址可能已经换了，旧条目不能当数）
        marketEpoch += 1
        marketCache.clear()
        lastMarketView = null
        lastMarketSources = []
        marketKeyRef.current = ''
        setMarket(null)
        setSources([])
        setMarketSource('')
        setMarketError('')
        setMarketNotice('')
        browse(sources[0]?.name ?? '')
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
            switchTab('installed')
          }}
        >
          <IconBolt size={14} /> {t('tab.installed')} <span className="count">{skills?.length ?? 0}</span>
        </button>
        <button
          type="button"
          className={tab === 'market' ? 'on' : ''}
          onClick={() => {
            switchTab('market')
          }}
        >
          <IconStore size={14} /> {t('tab.market')}
        </button>
        <div className="skills-search">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            placeholder={
              tab === 'installed'
                ? t('search.installed')
                : searchSource
                  ? t('search.skillsSh')
                  : t('search.market')
            }
            value={query}
            onChange={(event) => {
              // 只有「在市场 tab 里亲手改过」的搜索词才允许自动联网查询；
              // 在已安装 tab 里改词要把它复位，否则带着旧词切到市场会误触发一次搜索。
              searchEditedInMarket.current = tab === 'market'
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
                    switchTab('market')
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
            {sources.map((source) => (
              <button
                key={source.name}
                type="button"
                className={`source-chip${source.name === marketSource ? ' on' : ''}${source.ok ? '' : ' bad'}`}
                data-tip={source.ok ? source.url : `${source.url}\n${source.error ?? ''}`}
                onClick={() => {
                  selectSource(source.name)
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
                setSourcesText(sources.map((source) => `${source.name}, ${source.url}`).join('\n'))
                setSourcesOpen(true)
              }}
            >
              {sourcesOpen ? t('market.collapse') : t('market.editSources')}
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                browse(marketSource, { force: true })
              }}
              // 搜索型源没到 2 个字符时刷新是空转（宿主只会回一句「只提供搜索」），直接禁用
              disabled={marketLoading || searchTooShort}
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

          {/* 软提示：后台刷新 / 搜索失手，但手上还有旧列表 —— 只加一行小字，不打断阅读 */}
          {marketNotice !== '' && <div className="market-notice">{marketNotice}</div>}

          {/*
            skills.sh 还没开始查：关键词不够长，或够长但这次还没在市场里改过（从已安装带过来的
            词不自动查）。两种情况都给中性提示，不是错误。
          */}
          {(searchTooShort || searchWaiting) && (
            <div className="market-hint">
              {searchTooShort ? t('market.searchHint') : t('market.searchReady')}
            </div>
          )}

          {/* 搜索中：轻量一行；上一次的结果仍留在下面，不清空 */}
          {marketLoading && searchSource && !searchTooShort && (
            <div className="market-searching" role="status">
              {t('market.searching')}
            </div>
          )}

          {/* 首次抓取（一条可用结果都没有）：只有这时候才整块 loading */}
          {marketLoading && market === null && !searchSource && marketError === '' && (
            <div className="settings-loading" role="status" aria-label={t('market.loading')}>
              <SkeletonText lines={4} />
            </div>
          )}

          {/* 硬错误：一条可用结果都没有时才有，带重试 */}
          {marketError !== '' && (
            <div className="settings-note error">
              {marketError}
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  browse(marketSource, { force: true })
                }}
              >
                {t('market.retry')}
              </button>
            </div>
          )}
          {!searchTooShort && marketFiltered.map((item) => (
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
          {!searchTooShort && (market?.items.length ?? 0) > 0 && marketFiltered.length === 0 && (
            <div className="plugins-empty">{t('market.noMatch', { query })}</div>
          )}
          {!searchTooShort &&
            (market?.items.length ?? 0) === 0 &&
            marketError === '' &&
            !marketLoading &&
            market !== null &&
            (searchSource ? (
              <div className="plugins-empty">{t('market.searchEmpty', { query: searchNeedle })}</div>
            ) : (
              <div className="plugins-empty">{t('market.empty')}</div>
            ))}
        </div>
      )}

      <div className="skills-foot">{t('page.foot')}</div>
    </div>
  )
}
