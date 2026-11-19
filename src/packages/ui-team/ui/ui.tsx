/**
 * 内置插件：智能体团队（界面半，2026-11-08 与状态面板合并后的形态）。
 *
 * | 在哪 | 是什么 |
 * | --- | --- |
 * | 状态面板的「子智能体」区（`ui-status`） | **成员清单**：一行一个（名字 / 角色 / 状态），点一行打开它的会话 |
 * | 状态面板的「智能体团队」区（`ui-status`） | **共享任务板**（只读）：一行一条任务，谁负责、做到哪一步 |
 * | 正文区 | 队友那条真会话（2026-11-19 起全部走这条）：顶栏、页签、消息流、输入框、状态栏与主会话同一套 |
 * | 右侧栏 | 子智能体页签（工具卡里的子代理卡走它，只读重放） |
 *
 * **标题旁那个「智能体团队」按钮与名册模态已经撤掉**（2026-11-08）：它是同一份名册的
 * 第二处显示，和状态面板重复。现在成员只在状态面板列一次，「智能体团队」这个名字留给
 * 任务板那一区（成员 = 谁在跑，团队 = 有哪些事、谁负责，两件事）。
 *
 * **正文区不再有「只读运行记录」那一层**（2026-11-19）。旧实现点开收工的队友会盖一层
 * 自带头部的视图（名字 / 角色 / 状态 / 只读说明 / 停止 / 发话 / 移除 / 返回），它
 * `inset: 0` 盖在正文区上，输入区与状态栏一并被盖掉——于是「队友会话」看起来就不是
 * 主会话了，与 dsh 那种「子智能体开着就是一条普通会话」对不上。
 *
 * 现在点谁都走 `openTeammate`（`ui-status` 那一行调它）：正文区打开的是队友那条真会话，
 * 顶栏只剩一枚「父会话 / 队友名」的面包屑。收工的**可续接**队友由宿主先按名册里冻结的
 * 工牌复活一份循环（`packages/subagent/index.ts` 的 `reviveTeammate`），打开后输入框能
 * 直接接着说话；一次性的、或复活不了的（角色定义没了、文件被别的窗口占着）由输入区
 * 自己显示成一行只读说明（`ui-composer` 读快照的 `status.acceptsInput`）。
 *
 * 所以这个插件现在只剩两件事：3 秒轮询把名册写进共享席位（状态面板与右栏页签读同一份），
 * 以及给顶栏递那两段面包屑（跨包只走 `window` 事件）。
 *
 * 名册过滤一律按本会话（`mate.sessionId === 当前会话`）；别的会话派出的不列、不给入口。
 *
 * @module dsc-ui-shell/plugins/team
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  SkeletonText,
  formatDuration,
  oneLine,
  readSessionPath,
  readSessions,
} from '@dsc/ui-primitives'
import {
  IconTree,
  createT,
  defineStore,
  defineUiPlugin,
  registerDockTab,
  useHostChannel,
  useHostSelector,
  useSeat,
  useService,
  type BakedActions,
  type DockTabBodyProps,
  type SessionSummary,
  type SlotComponentProps,
  type StoreHandle,
  type TranscriptEntry,
  type TeammateView,
  type UiPluginApi,
} from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 队友状态词（旧界面 TEAMMATE_STATE_LABEL 同款）。 */
const STATE_LABEL: Readonly<Record<string, string>> = {
  working: t('team.state.working'),
  idle: t('team.state.idle'),
  stopped: t('team.state.stopped'),
  failed: t('team.state.failed'),
}

// ── 顶栏面包屑 ─────────────────────────────────────────────────────────────
/** 顶栏面包屑要的那一点东西（跨包只走 window 事件，与 `shell.palette.open` 同一条路）。 */
interface ReaderHint {
  /** 队友名（面包屑右段）。 */
  name: string
  /** 派它的会话标题（面包屑左段，可点回原会话）。 */
  parentTitle: string
  /** 派它的会话 jsonl 绝对路径；查不到给当前会话路径，给不了就 null（点了哪儿也不去）。 */
  parentPath: string | null
}

/** 面包屑出现 / 消失（`ui-layout` 的顶栏听它）。 */
const READER_HINT_EVENT = 'shell.teammate.view'

// ── 名册席位（D3）──────────────────────────────────────────────────────────
/**
 * 名册的共享状态形状：**席位放在这里而不是每个组件各自的 useState**——子智能体菜单、
 * 团队面板与 status 面板读的是同一份，轮询只有 TeamButton 一处（此前同一份名单有 3 份
 * 独立轮询：team 的菜单与面板各一份、status 面板再一份）。
 *
 * handle 在 `apply` 里现建（不许模块级：模块缓存会让它跨插件重载变成伪单例），
 * 经 `ui.provide('teammates', …)` 传给别的插件（status 面板读它，见 status/ui.tsx）。
 */
interface MateState {
  list: readonly TeammateView[]
}
type MateActions = {
  setList: (draft: MateState, list: readonly TeammateView[]) => void
}
/** 席位的 handle 类型（定义函数放在 apply 之外只为拿类型；不许模块级调用它）。 */
const makeMateSeat = (): StoreHandle<MateState, MateActions> =>
  defineStore<MateState, MateActions>({
    init: () => ({ list: [] }),
    actions: {
      setList: (draft: MateState, list: readonly TeammateView[]): void => {
        // 顶层替换（引擎只做浅拷贝；嵌套对象按约定整体换新）。
        draft.list = list
      },
    },
  })
type MateSeatHandle = ReturnType<typeof makeMateSeat>

export default defineUiPlugin({
  name: t('team.plugin.name'),
  apply(ui) {
    // 席位：本插件两处登记共享同一个 handle；跨插件共享经服务表传 handle（不认字符串键）。
    const mates = makeMateSeat()
    ui.provide('teammates', mates)
    // 这条目录仍常挂载，但**不再画「智能体团队」按钮**（2026-11-08 与状态面板合并：
    // 成员只在状态面板的「子智能体」区列一次，标题旁不再重复同一份名册）。
    // 留着它为两件事：3 秒轮询写共享席位（状态面板与右栏页签读同一份），
    // 以及给顶栏递「父会话 / 队友名」那两段面包屑。
    ui.slots.register('shell.header.lead', { id: 'team.entry', order: 20, store: mates }, TeamEntry)
    // 子智能体的运行记录仍可落**右侧栏**（一种 dock 页签，给工具卡里的子代理卡用）：
    // 正文区那条只读视图是「点状态面板一行」的主路，右栏这条是伴读面的旁路，两条共用
    // 同一份 `peekTranscript` 读法与同一套行渲染。名册与运行记录同属「队友」这件事。
    const offSubagentTab = registerDockTab({
      kind: 'subagent',
      label: t('team.tab.subagent'),
      icon: <IconTree size={13} />,
      // 会话文件名是 uuid：标题回落时取路径尾段（有 label 时优先 label，见 Chip 的三档）。
      titleFromPath: true,
      // 页签体额外拿到「本插件的名册席位面」：头部要按 `tab.path` 匹配出队友元信息（角色 /
      // 状态 / 轮数 / 时长），并且要据此判断「还在 working → 轮询刷新运行记录」。席位的读法
      // 与 status 面板同一条（`ui.slots.seat(handle)`——`ui` 只在 apply 里拿得到，用闭包交进去）。
      component: (props) => <SubagentTabBody {...props} slots={ui.slots} handle={mates} />,
    })
    // 子智能体页签也报名在 apply 里：停用团队插件时一道退掉（已开的运行记录页签由壳清）。
    return offSubagentTab
  },
})

/**
 * 常挂载的名册轮询 + 正文区只读层宿主。
 *
 * 标题旁**不再有「智能体团队」按钮**：成员统一在状态面板的「子智能体」区列（一处，
 * 不重复）。这条目录留着只为两件事——3 秒轮询把名册写进共享席位（状态面板与右栏
 * 页签读同一份），以及转交给 {@link TeammateCrumb} 算顶栏那两段。
 * 组件本身没有可见产物，所以队列里没队友时它也不占顶栏位置。
 */
function TeamEntry(props: SlotComponentProps<Record<never, never>, never, never, MateSeatHandle>): ReactNode {
  const channel = useHostChannel()
  const { actions } = props
  // 名册从共享席位读（这条目录登记时就带 `store: mates`）：面包屑要跟着轮询更新
  // （父会话标题、队友改名都在这一份里）。
  const list = props.useStore((state) => state.list)
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void channel
        .invoke<TeammateView[]>('listTeammates', [])
        .then((rows) => {
          if (alive) actions.setList(Array.isArray(rows) ? rows : [])
        })
        .catch(() => {
          // 子智能体能力不在（宿主没开 team 服务）时名册就是空的：保留空态而不是报错条。
          // 首次拉取失败时 seat 里就是 init 的空表，什么都不用做。
        })
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    // 宿主一推帧就补一拍（写名册 / 队友收工都会触发）：名册在面板上要「当场」变，
    // 3 秒轮询只当兜底。订阅回调只催 poll，可见性规则仍由各自的面判定。
    const off = channel.subscribe(poll)
    return () => {
      alive = false
      window.clearInterval(timer)
      off()
    }
  }, [channel, actions])
  return <TeammateCrumb mates={list} />
}

/**
 * 面包屑的左段：派它的那个会话。
 *
 * `SessionSummary.id` 就是 jsonl 的绝对路径，出生会话 id 是那条会话的 `meta.id`
 * （= 文件名去 `.jsonl`），所以按文件名对一遍即可。
 * 查不到（老名册行没有 `sessionId`、或那条会话已经归档/删除进了别的地方）退回
 * 「原会话」+ 当前会话路径——点了是 no-op，不静默无反应也不跳错地方。
 */
function parentOf(
  sessions: readonly SessionSummary[],
  mate: TeammateView,
  currentPath: string | null,
): { title: string; path: string | null } {
  const birth = mate.sessionId
  if (birth !== undefined && birth !== '') {
    const match = sessions.find((session) => basename(session.id) === birth)
    if (match !== undefined && match.title !== undefined && match.title !== '') {
      return { title: match.title, path: match.id }
    }
  }
  return { title: t('team.reader.parentFallback'), path: currentPath }
}

/**
 * 顶栏那枚面包屑（`父会话 / 队友名`）：正文区正在看的是某位队友的会话时把它递上去。
 *
 * 为什么还要它：dsh 的顶栏也是这么显示的（`nav.crumbs` 的「父会话 / 子智能体」），
 * 它解决的是「这条会话从哪来的」——队友会话不进侧栏，没有面包屑就只剩一个 uuid 文件名。
 * 只是显示，不再承载任何动作：开合、只读标记、停止 / 发话 / 移除都已经搬走了
 * （开合 = 点会话本身；输入框能不能说话由 `status.acceptsInput` 决定，见 ui-composer）。
 */
function TeammateCrumb({ mates }: { mates: readonly TeammateView[] }): ReactNode {
  const sessions = useHostSelector(readSessions)
  const currentPath = useHostSelector(readSessionPath)
  /**
   * 正文区此刻是不是某位队友的会话。
   *
   * 按**会话路径**认，不另加快照字段：名册里每行都带 `file`，当前会话路径也在手上，
   * 对一遍就知道——少一处会漂的状态，也不用改契约。
   */
  const viewed = useMemo(
    () => (currentPath === null || currentPath === '' ? null : (mates.find((row) => sameFile(row.file, currentPath)) ?? null)),
    [mates, currentPath],
  )
  const parent = viewed === null ? null : parentOf(sessions, viewed, currentPath)
  const parentTitle = parent === null ? '' : parent.title
  const parentPath = parent === null ? null : parent.path
  const readerName = viewed === null ? '' : viewed.name
  useEffect(() => {
    if (readerName === '') return undefined
    const detail: ReaderHint = { name: readerName, parentTitle, parentPath }
    window.dispatchEvent(new CustomEvent<ReaderHint | null>(READER_HINT_EVENT, { detail }))
    return () => {
      window.dispatchEvent(new CustomEvent<ReaderHint | null>(READER_HINT_EVENT, { detail: null }))
    }
  }, [readerName, parentTitle, parentPath])
  return null
}

/** 耗时格：跑动中每秒跳（已进行时长），收工的显示总耗时；拿不到起止时刻就不画。 */
function UsedTime({ mate }: { mate: TeammateView }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  const running = mate.state === 'working'
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [running])
  const used =
    mate.startedAt > 0
      ? formatDuration((running ? now : (mate.finishedAt ?? mate.startedAt)) - mate.startedAt)
      : null
  return (
    <span className="tm-time" data-tip={running ? t('team.time.runningTip') : t('team.time.totalTip')}>
      {used ?? ''}
    </span>
  )
}

/** 队友运行记录的轮询间隔：只在队友还在 working 时按这个节奏重读（收工即停）。 */
const PEEK_POLL_MS = 2500

/** 消息流插件经服务表交出来的只读条目流（组件 + 槽位名）。插件之间不 import 实现，
 *  只认这个形状——provider 是 transcript 插件（`ui.provide('transcriptFlow', …)`）。 */
const TRANSCRIPT_FLOW_SERVICE = 'transcriptFlow'

/**
 * 读一份队友运行记录（`peekTranscript`）；队友还在 working 时按 {@link PEEK_POLL_MS}
 * 轮询刷新，收工就只留最后一次快照、不起定时器。
 *
 * 三条纪律照壳里名册那条轮询（status 面板同款）：`document.hidden` 时不发请求；
 * 卸载 / 依赖变化时清定时器（`alive` 闸门挡掉迟到的响应）；空态与错误态交给调用方。
 */
function usePeekTranscript(file: string, working: boolean): { entries: TranscriptEntry[] | null; error: string } {
  const channel = useHostChannel()
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (file === '') return undefined
    let alive = true
    const read = (): void => {
      void channel
        .invoke<TranscriptEntry[]>('peekTranscript', [file])
        .then((list) => {
          if (!alive) return
          setEntries(Array.isArray(list) ? list : [])
          setError('')
        })
        .catch((reason: unknown) => {
          if (alive) setError(reason instanceof Error ? reason.message : String(reason))
        })
    }
    // 先拉一次快照：收工的队友也看得到最后那份内容。
    read()
    // 只有队友还在干活才轮询；收工/失败/被打断都停（页面停在最后一份上）。
    if (!working) {
      return () => {
        alive = false
      }
    }
    const timer = window.setInterval(() => {
      // 页面不可见时不发请求（壳里的惯例：后台省心跳）。
      if (document.hidden) return
      read()
    }, PEEK_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [channel, file, working])
  return { entries, error }
}

/** 队友运行记录的只读流（peekTranscript 回的条目数组，简版渲染：正文/工具/思考/系统直排）。
 *  这是 `transcriptFlow` 服务缺席时的兜底出口，别整块删。 */
function PeekView({ file, working = false }: { file: string; working?: boolean }): ReactNode {
  const { entries, error } = usePeekTranscript(file, working)

  if (error !== '') return <div className="settings-empty">{t('team.peek.error', { message: error })}</div>
  if (entries === null) {
    return (
      <div className="settings-loading" role="status" aria-label={t('team.peek.loading')}>
        <SkeletonText lines={5} />
      </div>
    )
  }
  if (entries.length === 0) return <div className="settings-empty">{t('team.peek.empty')}</div>
  return (
    <div className="peek-flow">
      {entries.map((entry) => {
        if (entry.kind === 'text') {
          return (
            <p className="peek-text" key={entry.id}>
              {entry.text}
            </p>
          )
        }
        if (entry.kind === 'tool') {
          return (
            <p className="peek-tool" key={entry.id}>
              <code>{entry.call.name}</code> {oneLine(entry.call.argsText, 60)}
              {entry.call.status === 'failed' ? t('team.peek.failed') : ''}
            </p>
          )
        }
        if (entry.kind === 'thinking') {
          return (
            <p className="peek-think" key={entry.id}>
              ✦ {entry.text.split('\n', 1)[0] ?? ''}
            </p>
          )
        }
        if (entry.kind === 'system') {
          return (
            <p className="peek-system" key={entry.id}>
              {entry.text}
            </p>
          )
        }
        return null
      })}
    </div>
  )
}

/**
 * `transcriptFlow` 服务的托管：拉数据（与 {@link PeekView} 同一份 peek + 同一档轮询），
 * 条目就绪后交给消息流插件那套**主会话同款行渲染**。加载 / 空 / 错误三种人话与 PeekView
 * 一致（两条出口看到的空态一样），服务缺席时由调用方退回 PeekView。
 */
function FlowHost({ flow, file, working }: { flow: TranscriptFlowService; file: string; working: boolean }): ReactNode {
  const { entries, error } = usePeekTranscript(file, working)
  if (error !== '') return <div className="settings-empty">{t('team.peek.error', { message: error })}</div>
  if (entries === null) {
    return (
      <div className="settings-loading" role="status" aria-label={t('team.peek.loading')}>
        <SkeletonText lines={5} />
      </div>
    )
  }
  if (entries.length === 0) return <div className="settings-empty">{t('team.peek.empty')}</div>
  return <flow.Component entries={entries} sessionKey={file} />
}

/** `transcriptFlow` 服务在团队这一侧的读面（结构同 transcript 的 `TranscriptFlowService`）。 */
interface TranscriptFlowService {
  Component: (props: { entries: readonly TranscriptEntry[]; cwd?: string; sessionKey?: string }) => ReactNode
}

/**
 * 右侧栏里的子智能体页签体：头部一行（名字 / 角色 / 状态 / 轮数 / 时长）+ 只读运行记录。
 *
 * 运行记录有两条出口：优先用消息流插件经 `transcriptFlow` 服务交出来的**主会话同款行渲染**
 * （markdown / 思考 / 工具卡 / 子代理卡 / 计划卡）；服务缺席（消息流插件没开）时退回
 * {@link PeekView} 那套简版直排——不许白屏（兜底不删）。
 *
 * 队友元信息从本插件的名册席位（`listTeammates` 那条 3 秒轮询写进去的共享实例）按
 * `tab.path` 匹配；匹配不到就只显示文件名，不编造角色与状态。
 */
function SubagentTabBody({
  tab,
  slots,
  handle,
}: DockTabBodyProps & { slots: UiPluginApi['slots']; handle: MateSeatHandle }): ReactNode {
  const file = tab.path ?? ''
  // 名册席位（D3）：与子智能体菜单 / 团队面板 / status 面板读的是同一份，不另起一条读取。
  const instance = useMemo(() => slots.seat(handle), [slots, handle])
  const list = useSeat(instance, (state) => state.list)
  const mate = useMemo(
    () =>
      (Array.isArray(list) ? list : []).find(
        (row) => sameFile(row.file, file) || (tab.label !== undefined && row.name === tab.label),
      ),
    [list, file, tab.label],
  )
  const flow = useService<TranscriptFlowService>(TRANSCRIPT_FLOW_SERVICE)
  const working = mate?.state === 'working'
  // 名字优先取页签上的队友名（打开时带过来的），其次名册里的 name，最后才回落文件名。
  const title = tab.label ?? mate?.name ?? basename(file)
  return (
    <div className="sub-tab">
      <div className="sub-tab-head" data-subagent-file={file} data-subagent-state={mate?.state ?? ''}>
        <IconTree size={13} />
        <span className="sub-tab-name">{title}</span>
        {mate === undefined ? null : (
          <>
            <span className="sub-tab-role">{mate.role}</span>
            <span className={`sub-tab-state ${mate.state}`}>{STATE_LABEL[mate.state] ?? mate.state}</span>
            <span className="sub-tab-round" data-tip={t('team.tab.roundsTip')}>
              {t('team.row.rounds', { count: mate.rounds })}
            </span>
            <UsedTime mate={mate} />
          </>
        )}
        <span className="sub-tab-note">{t('team.tab.readonly')}</span>
      </div>
      <div className="sub-tab-body">
        {flow === undefined ? <PeekView file={file} working={working} /> : <FlowHost flow={flow} file={file} working={working} />}
      </div>
    </div>
  )
}

/** 两条路径是不是同一个文件（名册与页签传的可能分隔符不同）。 */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  if (a === '' || b === '') return false
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/')
}

/** 路径尾段（子智能体页签的标题回落用——会话文件名是 uuid，只当兜底）。 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1).replace(/\.jsonl$/, '')
}


