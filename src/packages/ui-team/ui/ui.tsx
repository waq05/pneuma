/**
 * 内置插件：智能体团队（界面半，2026-11-08 与状态面板合并后的形态）。
 *
 * | 在哪 | 是什么 |
 * | --- | --- |
 * | 状态面板的「子智能体」区（`ui-status`） | **成员清单**：一行一个（名字 / 角色 / 状态），点一行在正文区只读打开它的完整运行记录 |
 * | 状态面板的「智能体团队」区（`ui-status`） | **共享任务板**（只读）：一行一条任务，谁负责、做到哪一步 |
 * | 正文区 | {@link TeammateReader} 的只读视图：`peekTranscript` + 消息流插件的同款行渲染，头部带停止 / 发话 / 移除 |
 * | 右侧栏 | 子智能体页签（工具卡里的子代理卡走它） |
 *
 * **标题旁那个「智能体团队」按钮与名册模态已经撤掉**（2026-11-08）：它是同一份名册的
 * 第二处显示，和状态面板重复。现在成员只在状态面板列一次，「智能体团队」这个名字留给
 * 任务板那一区（成员 = 谁在跑，团队 = 有哪些事、谁负责，两件事）。
 *
 * 数据走界面通道的 `listTeammates`（常挂载的那条轮询每 3 秒写进共享席位；
 * 页面不可见时轮询停了不发），动作走 `stopTeammate` / `messageTeammate` /
 * `removeTeammate`——四个方法都在放行面上（白名单见 `src/core/ui-methods.ts`）。
 *
 * **为什么点开队友不是 `openSession(队友日志)`**（2026-11-06 核实）：
 * `Session.load` 用日志里的 `meta.id` 重算落盘路径（`src/core/session.ts:670` 的
 * `keepPath=false` 分支），而队友日志的 meta.id 与文件名是两个 uuid（`src/packages/
 * subagent/index.ts:469,471`）。那一步会把「当前会话」换成一个磁盘上不存在的路径：
 * 输入框仍在（`ui-composer` 这一侧没有只读档），一提交就往假路径里写一份没有 meta
 * 首行的半截会话，`saveLastSession` 还会把假路径记成「上次会话」。所以这里走
 * 宿主的**只读入口** `peekTranscript`（没有租约、不动文件），正文区整层由只读视图接管。
 *
 * 名册过滤一律按本会话（`mate.sessionId === 当前会话`）；别的会话派出的不列、不给入口。
 *
 * @module dsc-ui-shell/plugins/team
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  SkeletonText,
  formatDuration,
  oneLine,
  readSessionId,
  readSessionPath,
  readSessions,
} from '@dsc/ui-primitives'
import {
  IconTree,
  confirmAction,
  createSignal,
  createT,
  defineStore,
  defineUiPlugin,
  registerDockTab,
  toastErr,
  toastOk,
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

// ── 正文区的只读运行记录（任务 3）──────────────────────────────────────────
/**
 * 正文区正在看的那位队友的运行记录。`null` = 正文区还是普通会话。
 *
 * **不切会话**：只读层盖在正文区上（`[data-thread-area]` 自带 `position: relative`），
 * 底下的会话原样开着——所以「回到原会话」只是关掉这一层（顶栏那一段仍走
 * `openSession(父会话路径)`，当前本来就是它时宿主会短路）。
 */
interface ReaderState {
  mate: TeammateView
}

const reader = createSignal<ReaderState | null>(null)

/** 打开 / 关闭只读运行记录（两条都是幂等的：同一份状态重复写不发通知）。 */
function openReader(mate: TeammateView): void {
  const current = reader.get()
  if (current !== null && current.mate.file === mate.file) return
  reader.set({ mate })
}

function closeReader(): void {
  if (reader.get() === null) return
  reader.set(null)
}

/** 顶栏面包屑要的那一点东西（跨包只走 window 事件，与 `shell.palette.open` 同一条路）。 */
interface ReaderHint {
  /** 队友名（面包屑右段）。 */
  name: string
  /** 派它的会话标题（面包屑左段，可点回原会话）。 */
  parentTitle: string
  /** 派它的会话 jsonl 绝对路径；查不到给当前会话路径，给不了就 null（只关层不切会话）。 */
  parentPath: string | null
}

/** 面包屑出现 / 消失（`ui-layout` 的顶栏听它）。 */
const READER_HINT_EVENT = 'shell.teammate.view'
/** 顶栏请这层关掉（父会话那一节点一下就是它）。 */
const READER_EXIT_EVENT = 'shell.teammate.exit'

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
    // 正文区只读运行记录的口子：状态面板点一行走它。**在跑的队友也直接打开**——
    // 2026-11-05 那道「还在跑就回绝」的门 2026-11-09 拆了，因为它防的事从来不会发生：
    // 这里的读法是 `peekTranscript`，宿主侧走 `Session.load(..., { lease: false })`
    // （`src/packages/subagent/index.ts:862-872`）——队友正写着也读得；解析不了的行
    // 直接跳过（`src/core/session.ts:596-602`，半截行最多丢一条，下一拍补上），没有租约
    // 也就不做修复落盘（`src/core/session.ts:734-741`）。所以打开那一刻看到的就是当前
    // 进度，名册翻成已完成之后跟读自己停（判在 {@link TeammateReader} 的 `working`）。
    ui.provide('teammateReader', {
      open: (mate: TeammateView): void => {
        openReader(mate)
      },
      close: (): void => {
        closeReader()
      },
    })
    // 这条目录仍常挂载，但**不再画「智能体团队」按钮**（2026-11-08 与状态面板合并：
    // 成员只在状态面板的「子智能体」区列一次，标题旁不再重复同一份名册）。
    // 留着它为两件事：3 秒轮询写共享席位（状态面板与右栏页签读同一份），
    // 以及承载正文区那层只读运行记录（它要 portal 到正文区）。
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
 * 页签读同一份），以及承载 {@link TeammateReader} 那层只读视图（它要 portal 到正文区）。
 * 组件本身没有可见产物，所以队列里没队友时它也不占顶栏位置。
 */
function TeamEntry(props: SlotComponentProps<Record<never, never>, never, never, MateSeatHandle>): ReactNode {
  const channel = useHostChannel()
  const { actions } = props
  // 名册从共享席位读（这条目录登记时就带 `store: mates`）：正文区那层只读视图要按名册
  // 跟住当前这一位的状态，不能只看点下去那一刻的快照（见 {@link TeammateReader}）。
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
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [channel, actions])
  return <TeammateReader mates={list} />
}

/** 订阅函数提到模块级（`useSyncExternalStore` 要求引用稳定）。 */
function subscribeReader(listener: () => void): () => void {
  return reader.subscribe(listener)
}

function useReader(): ReaderState | null {
  return useSyncExternalStore(subscribeReader, () => reader.get(), () => null)
}

/**
 * 正文区那一格的定位锚：壳打在 `.thread-main` / `.thread-main-empty` 上，`styles.css` 给它
 * `position: relative`（绝对定位浮层要的定位父级，与状态面板同一个锚）。
 */
const THREAD_AREA_SELECTOR = '[data-thread-area]'

/**
 * 面包屑的左段：派它的那个会话。
 *
 * `SessionSummary.id` 就是 jsonl 的绝对路径，出生会话 id 是那条会话的 `meta.id`
 * （= 文件名去 `.jsonl`，与 `readSessionId` 同一口径），所以按文件名对一遍即可。
 * 查不到（老名册行没有 `sessionId`、或那条会话已经归档/删除进了别的地方）退回
 * 「原会话」+ 当前会话路径——点了就是「关掉这层、哪儿也不去」，不静默无反应。
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
 * 正文区的只读运行记录（任务 3）：盖在 `[data-thread-area]` 上的一层，里面铺**完整消息流**。
 *
 * 三条边界：
 *  - **只读**：动作 context 由消息流插件那条只读出口（`transcriptFlow`）给 `NO_ACTIONS`，
 *    用户消息走只读气泡；整层还盖掉了输入区——这里根本没有可写的地方；
 *  - **不切会话**：只读视图是 `peekTranscript`（无租约、不动文件）读出来的，底下的会话
 *    原样开着，所以关掉这层就回到原会话；
 *  - **换会话自动关**：别让别人的正文上面顶着一层「上一个会话的队友」。
 */
function TeammateReader({ mates }: { mates: readonly TeammateView[] }): ReactNode {
  const state = useReader()
  const sessions = useHostSelector(readSessions)
  const currentPath = useHostSelector(readSessionPath)
  const sessionId = useHostSelector(readSessionId)
  // 信号里存的是点下去那一刻的快照（{@link ReaderState}）：队友收工 / 被停 / 失败之后
  // 它自己不会变，头部的状态词就会一直停在「运行中」。所以按同一个文件（`sameFile`，
  // 名册与信号里的分隔符可能不同）从名册里找**当前这一位**——名册由 {@link TeamEntry}
  // 那条 3 秒轮询写进共享席位；找不到（被移除、那一拍还没回来）才回落快照。
  const snapshot = state === null ? null : state.mate
  const mate = useMemo(
    () => (snapshot === null ? null : (mates.find((row) => sameFile(row.file, snapshot.file)) ?? snapshot)),
    [mates, snapshot],
  )
  // 在跑的才跟读（`usePeekTranscript` 里按它决定起不起定时器）；收工后名册一翻，这里
  // 自己就停了，页面停在最后那份内容上。
  const working = mate !== null && mate.state === 'working'
  // 消息流插件经服务表交出来的同款行渲染（markdown / 思考 / 工具卡 / 计划卡）；缺席时
  // 退回下面那套简版直排（`PeekView` 不许删——它就是兜底出口）。
  const flow = useService<TranscriptFlowService>(TRANSCRIPT_FLOW_SERVICE)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const file = mate === null ? '' : mate.file

  // 落点每次打开现取：换会话 / 换视图会换掉正文区那个元素。
  useEffect(() => {
    if (file === '') {
      setHost(null)
      return
    }
    const el = document.querySelector(THREAD_AREA_SELECTOR)
    setHost(el instanceof HTMLElement ? el : null)
  }, [file])

  // 换会话就关（打开时的会话短 id 记在 ref 里，第一帧只记账）。
  const openedFor = useRef<string | null>(null)
  useEffect(() => {
    if (file === '') {
      openedFor.current = null
      return
    }
    if (openedFor.current === null) {
      openedFor.current = sessionId
      return
    }
    if (openedFor.current !== sessionId) closeReader()
  }, [file, sessionId])

  // 顶栏「父会话」那一节点的是「关掉这层」（父会话本来就是当前会话；顶栏那边仍会调
  // `openSession(父会话路径)`，宿主对「已经在看这条会话」直接短路）。
  useEffect(() => {
    const onExit = (): void => {
      closeReader()
    }
    window.addEventListener(READER_EXIT_EVENT, onExit)
    return () => {
      window.removeEventListener(READER_EXIT_EVENT, onExit)
    }
  }, [])

  useEffect(() => {
    if (file === '') return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeReader()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [file])

  // 面包屑的两段交给顶栏（跨包只走 window 事件）；关掉时发一条 null 让标题还原。
  const parent = mate === null ? null : parentOf(sessions, mate, currentPath)
  const parentTitle = parent === null ? '' : parent.title
  const parentPath = parent === null ? null : parent.path
  const readerName = mate === null ? '' : mate.name
  useEffect(() => {
    if (readerName === '') return undefined
    const detail: ReaderHint = { name: readerName, parentTitle, parentPath }
    window.dispatchEvent(new CustomEvent<ReaderHint | null>(READER_HINT_EVENT, { detail }))
    return () => {
      window.dispatchEvent(new CustomEvent<ReaderHint | null>(READER_HINT_EVENT, { detail: null }))
    }
  }, [readerName, parentTitle, parentPath])

  if (mate === null || host === null) return null
  return createPortal(
    <div className="team-reader" role="region" aria-label={t('team.reader.aria', { name: mate.name })}>
      <div className="team-reader-head">
        <IconTree size={13} />
        <span className="team-reader-name">{mate.name}</span>
        <span className="team-reader-role">{mate.role}</span>
        {mate.taskId === undefined ? null : (
          <span className="team-reader-role" data-sp-agent-task={mate.taskId} data-tip={t('team.reader.taskTip', { id: mate.taskId })}>
            {t('team.reader.task', { id: mate.taskId })}
          </span>
        )}
        <span className={`sub-tab-state ${mate.state}`}>{STATE_LABEL[mate.state] ?? mate.state}</span>
        {/* 耗时跟着名册走：在跑时每秒跳，收工换成总耗时（`UsedTime` 自己判 `working`）。
            同一个组件右栏的子智能体页签也在用，两处口径一致。 */}
        <UsedTime mate={mate} />
        {/* 头部这句只读说明按类型换：一次性的把「干完就不接后续消息」说在这里。
            不另起一个元素——头部是单行 flex，多一块就换行，把「返回原会话」挤下去。 */}
        <span className="team-reader-note">
          {mate.mode === 'one-shot' ? t('team.reader.oneShotBody') : t('team.reader.note')}
        </span>
        {/* 行动作跟着这一位走：停止（在跑）/ 发话 / 移除（收工的）。名册面板撤掉之后，
            这三个动作只剩这一处落点（见 {@link ReaderActions}）。 */}
        <ReaderActions mate={mate} />
        <button
          type="button"
          className="text-btn"
          data-tip={t('team.reader.backTip')}
          onClick={() => {
            closeReader()
          }}
        >
          {t('team.reader.back')}
        </button>
      </div>
      <div className="team-reader-body">
        {flow === undefined ? (
          <PeekView file={mate.file} working={working} />
        ) : (
          <FlowHost flow={flow} file={mate.file} working={working} />
        )}
      </div>
    </div>,
    host,
  )
}

/**
 * 只读运行记录头部的三个动作：停止（在跑的）/ 发话 / 移除（收工的）。
 *
 * 为什么搬到这里：标题旁那个名册面板 2026-11-08 撤掉了（成员统一在状态面板列一次，
 * 不重复），但这三个动作不能丢——详情层是唯一合适的落点：列表不重复，操作跟着那一位走。
 * 行内动作各自 stopPropagation 的旧约束在这里自然消失（这一层本身没有「整行可点」）。
 */
function ReaderActions({ mate }: { mate: TeammateView }): ReactNode {
  const channel = useHostChannel()
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const busy = mate.state === 'working'
  // 一次性的（spawn 时 keep=false）：干完就结束，不接后续消息。对照 dsh 的
  // SubagentReadOnlyComposer——那边也是把这个位置换成一句说明，不给输入框。
  const oneShot = mate.mode === 'one-shot'

  const act = async (method: string, args: unknown[], tip: string): Promise<void> => {
    try {
      await channel.invoke(method, args)
      toastOk(tip)
    } catch (reason) {
      toastErr(t('team.toast.failed', { tip, message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  return (
    <>
      {busy ? (
        <button
          type="button"
          className="text-btn danger"
          data-tip={t('team.row.stopTip')}
          onClick={() => {
            void act('stopTeammate', [mate.name], t('team.row.stopped', { name: mate.name }))
          }}
        >
          {t('team.row.stop')}
        </button>
      ) : (
        <button
          type="button"
          className="text-btn danger"
          data-tip={t('team.row.removeTip')}
          onClick={() => {
            void (async () => {
              const ok = await confirmAction({
                title: t('team.row.removeTitle', { name: mate.name }),
                detail: t('team.row.removeDetail'),
                confirmLabel: t('team.row.remove'),
                danger: true,
              })
              if (!ok) return
              void act('removeTeammate', [mate.name], t('team.row.removed', { name: mate.name }))
            })()
          }}
        >
          {t('team.row.remove')}
        </button>
      )}
      {oneShot ? null : (
        <button
          type="button"
          className="text-btn"
          aria-pressed={writing}
          data-tip={t('team.row.messageTip')}
          onClick={() => {
            setWriting((current) => !current)
          }}
        >
          {t('team.row.message')}
        </button>
      )}
      {!oneShot && writing ? (
        <span className="team-write team-reader-write">
          <input
            autoFocus
            value={draft}
            placeholder={t('team.row.writePlaceholder', { name: mate.name })}
            aria-label={t('team.row.writeLabel', { name: mate.name })}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              const text = draft.trim()
              if (text === '') return
              void act('messageTeammate', [mate.name, text], t('team.row.sent', { name: mate.name }))
              setDraft('')
              setWriting(false)
            }}
          />
          <button
            type="button"
            className="text-btn"
            disabled={draft.trim() === ''}
            onClick={() => {
              const text = draft.trim()
              if (text === '') return
              void act('messageTeammate', [mate.name, text], t('team.row.sent', { name: mate.name }))
              setDraft('')
              setWriting(false)
            }}
          >
            {t('team.row.send')}
          </button>
        </span>
      ) : null}
    </>
  )
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

/** 路径尾段（子智能体页签的标题用它——队友的会话文件名就是它的名字）。 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1).replace(/\.jsonl$/, '')
}


