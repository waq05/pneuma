/**
 * 内置插件：智能体团队（2026-11-06 对调后的三处入口）。
 *
 * | 在哪 | 是什么 |
 * | --- | --- |
 * | 会话标题旁（`shell.header.lead`，order 10） | **「智能体团队」入口**：点开 {@link TeamPanel}（名册：发话 / 停止 / 移除），有队友时带数量 |
 * | 状态面板的「智能体」区 | **子智能体列表**（一行一个：名字 / 角色 / 状态），点一行在正文区只读打开它的完整会话 |
 * | 正文区 | {@link TeammateReader} 的只读视图：`peekTranscript` + 消息流插件的同款行渲染 |
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
 * 本会话的队伍按 `mate.sessionId === 当前会话` 过滤（老名册行没有 sessionId，
 * 不归任何会话）；其它会话的收进底部折叠组，只读列出（对照旧界面 matesOf）。
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
  useDialogFocus,
} from '@dsc/ui-primitives'
import {
  IconChevronDown,
  IconClose,
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
  type SnapshotSelectorHook,
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

/** 本会话派出的队友（旧界面 matesOf 同款：没 sessionId 的老名册行不归任何会话）。 */
function matesOf(mates: readonly TeammateView[], sessionId: string | null): TeammateView[] {
  if (sessionId === null || sessionId === '') return []
  return mates.filter((mate) => mate.sessionId === sessionId)
}

// ── 面板开合（模块级：标题旁的入口与正文区的只读层共用同一份）────────────────

/** 团队面板开没开（Modal 本体挂在标题旁那个常挂载的条目里，见 {@link TeamEntry}）。 */
const panel = createSignal<boolean>(false)

function setPanelOpen(next: boolean): void {
  if (panel.get() === next) return
  panel.set(next)
}

/** 订阅函数提到模块级：`useSyncExternalStore` 要求它的引用稳定（内联箭头会反复重订阅）。 */
function subscribePanelOpen(listener: () => void): () => void {
  return panel.subscribe(listener)
}

function usePanelOpen(): boolean {
  return useSyncExternalStore(subscribePanelOpen, () => panel.get(), () => false)
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
/** TeamPanel 从 TeamButton 手里接过的读面（同一份 useStore，不重起订阅）。 */
interface MateSeatRead {
  useStore: SnapshotSelectorHook<MateState>
}

export default defineUiPlugin({
  name: t('team.plugin.name'),
  apply(ui) {
    // 席位：本插件两处登记共享同一个 handle；跨插件共享经服务表传 handle（不认字符串键）。
    const mates = makeMateSeat()
    ui.provide('teammates', mates)
    // 团队面板的口子：状态面板的「智能体」区与别的插件都能经它开面板（模态的开合仍归
    // 本插件自己管；服务缺席时消费方整行不渲染——点了没反应的入口比没有更糟）。
    ui.provide('teamPanel', {
      open: (): void => {
        setPanelOpen(true)
      },
    })
    // 正文区只读运行记录的口子：状态面板 / 团队面板点一行都走它。`working` 的队友在这里
    // 直接回绝（不弹窗、不切会话）——它还在写自己那份日志，不能同时被当成一条会话打开。
    ui.provide('teammateReader', {
      open: (mate: TeammateView): void => {
        if (mate.state === 'working') {
          toastErr(t('team.reader.busy', { name: mate.name }))
          return
        }
        openReader(mate)
      },
      close: (): void => {
        closeReader()
      },
    })
    // 标题旁的一簇：**「智能体团队」入口**（2026-11-06 与状态面板对调：单个队友的行搬进
    // 状态面板的「智能体」区）。这条目录常挂载——名册轮询、团队面板本体、正文区只读层
    // 都住在这里；没有任何队友时它照样在（轮询与「派出第一个队友」的入口都靠它）。
    ui.slots.register('shell.header.lead', { id: 'team.entry', order: 10, store: mates }, TeamEntry)
    // 子智能体的运行记录仍可落**右侧栏**（一种 dock 页签，给工具卡里的子代理卡用）：
    // 正文区那条只读视图是「点状态面板一行」的主路，右栏这条是伴读面的旁路，两条共用
    // 同一份 `peekTranscript` 读法与同一套行渲染。名册与运行记录同属「队友」这件事。
    registerDockTab({
      kind: 'subagent',
      label: t('team.tab.subagent'),
      icon: <IconTree size={13} />,
      // 页签体额外拿到「本插件的名册席位面」：头部要按 `tab.path` 匹配出队友元信息（角色 /
      // 状态 / 轮数 / 时长），并且要据此判断「还在 working → 轮询刷新运行记录」。席位的读法
      // 与 status 面板同一条（`ui.slots.seat(handle)`——`ui` 只在 apply 里拿得到，用闭包交进去）。
      component: (props) => <SubagentTabBody {...props} slots={ui.slots} handle={mates} />,
    })
  },
})

/**
 * 标题旁的「智能体团队」入口：**一个按钮**（有队友时带数量），点开 {@link TeamPanel}。
 *
 * 组件本身常挂载：名册轮询（3 秒一次写进共享席位，全壳只有这一条 interval）、团队面板
 * 本体与正文区只读层都住在这里——所以它自己哪怕没有任何队友也照常渲染（只是数量不显示）。
 */
function TeamEntry(props: SlotComponentProps<Record<never, never>, never, never, MateSeatHandle>): ReactNode {
  const teamOpen = usePanelOpen()
  const channel = useHostChannel()
  const { actions } = props
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void channel
        .invoke<TeammateView[]>('listTeammates', [])
        .then((list) => {
          if (alive) actions.setList(Array.isArray(list) ? list : [])
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
  const mates = props.useStore((state) => state.list)
  const sessionId = useHostSelector(readSessionId)
  const mine = matesOf(mates, sessionId)
  return (
    <>
      <button
        type="button"
        className={`team-btn${teamOpen ? ' on' : ''}`}
        data-team-count={mine.length}
        aria-expanded={teamOpen}
        aria-label={t('team.panel.aria')}
        data-tip={t('team.entry.tip')}
        onClick={() => {
          setPanelOpen(!teamOpen)
        }}
      >
        <IconTree size={13} />
        {mine.length === 0 ? t('team.entry.label') : t('team.entry.count', { count: mine.length })}
      </button>
      {teamOpen ? <TeamPanel useStore={props.useStore} /> : null}
      <TeammateReader />
    </>
  )
}

/** 「智能体团队」面板：本会话的队伍为主；其它会话派出的收进底部折叠组，只读。
 *  层级照设置面板那一档（.settings-mask + .settings），Esc 与点遮罩都关。
 *  点一行 = 关掉面板、在正文区只读打开它的运行记录（任务 3；还在跑的当场回绝）。 */
function TeamPanel({ useStore }: MateSeatRead): ReactNode {
  const mates = useStore((state) => state.list)
  const sessionId = useHostSelector(readSessionId)
  const [othersOpen, setOthersOpen] = useState(false)

  /** 点一行：收工的开正文区只读视图，还在跑的给一句人话（不切会话、不动文件）。 */
  const openMate = (mate: TeammateView): void => {
    if (mate.state === 'working') {
      toastErr(t('team.reader.busy', { name: mate.name }))
      return
    }
    setPanelOpen(false)
    openReader(mate)
  }

  // Esc 与焦点走基元：关面板，焦点还给来源。
  const dialog = useDialogFocus(true, () => {
    setPanelOpen(false)
  })

  const mine = matesOf(mates, sessionId)
  const others = mates.filter((mate) => !mine.includes(mate))

  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPanelOpen(false)
      }}
    >
      <div className="settings team-panel" role="dialog" aria-modal="true" aria-label={t('team.panel.aria')} ref={dialog.ref}>
        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>{t('team.panel.title')}</h2>
              <p>{t('team.panel.desc')}</p>
            </div>
            <button
              type="button"
              className="icon-btn"
              autoFocus
              data-tip={t('team.panel.closeTip')}
              onClick={() => {
                setPanelOpen(false)
              }}
            >
              <IconClose size={16} />
            </button>
          </div>

          <div className="settings-body">
            {mates === null ? (
              <div className="settings-empty">{t('team.panel.loading')}</div>
            ) : (
              <>
                {mine.length === 0 ? (
                  <div className="settings-empty">{t('team.panel.empty')}</div>
                ) : (
                  <div className="team-list">
                    {mine.map((mate) => (
                      <TeamRow
                        key={mate.file}
                        mate={mate}
                        onOpen={() => {
                          openMate(mate)
                        }}
                      />
                    ))}
                  </div>
                )}
                {others.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="team-others-toggle"
                      aria-expanded={othersOpen}
                      onClick={() => {
                        setOthersOpen((current) => !current)
                      }}
                    >
                      <IconChevronDown size={13} />
                      {t('team.panel.others', { count: others.length })}
                    </button>
                    {othersOpen ? (
                      <div className="team-list team-others">
                        {others.map((mate) => (
                          <TeamRow
                            key={mate.file}
                            mate={mate}
                            onOpen={() => {
                              openMate(mate)
                            }}
                          />
                        ))}
                        <p className="team-hint">{t('team.panel.othersHint')}</p>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
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
function TeammateReader(): ReactNode {
  const state = useReader()
  const sessions = useHostSelector(readSessions)
  const currentPath = useHostSelector(readSessionPath)
  const sessionId = useHostSelector(readSessionId)
  // 消息流插件经服务表交出来的同款行渲染（markdown / 思考 / 工具卡 / 计划卡）；缺席时
  // 退回下面那套简版直排（`PeekView` 不许删——它就是兜底出口）。
  const flow = useService<TranscriptFlowService>(TRANSCRIPT_FLOW_SERVICE)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const mate = state === null ? null : state.mate
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
        <span className={`sub-tab-state ${mate.state}`}>{STATE_LABEL[mate.state] ?? mate.state}</span>
        <span className="team-reader-note">{t('team.reader.note')}</span>
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
          <PeekView file={mate.file} />
        ) : (
          <FlowHost flow={flow} file={mate.file} working={false} />
        )}
      </div>
    </div>,
    host,
  )
}

/** 名册的一行：状态点 + 名称 + 角色 + 任务 + 轮数 + 耗时 + 状态 + 停止/发话/移除。
 *  点击整行 = 打开运行记录（只读）；行尾动作各自 stopPropagation。 */
function TeamRow({
  mate,
  compact = false,
  onOpen,
}: {
  mate: TeammateView
  compact?: boolean
  onOpen: () => void
}): ReactNode {
  const channel = useHostChannel()
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const busy = mate.state === 'working'

  const act = async (method: string, args: unknown[], tip: string): Promise<void> => {
    try {
      await channel.invoke(method, args)
      toastOk(tip)
    } catch (reason) {
      toastErr(t('team.toast.failed', { tip, message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  return (
    <div className="team-row" role="button" tabIndex={0} onClick={onOpen}>
      <span className={`tm-dot ${mate.state}`} aria-hidden="true" />
      <span className="tm-name">{mate.name}</span>
      <span className="tm-role">{mate.role}</span>
      <span className="team-task" title={mate.task}>
        {mate.task}
      </span>
      <span className="team-round">{t('team.row.rounds', { count: mate.rounds })}</span>
      {compact ? null : <UsedTime mate={mate} />}
      <span className="tm-state">{STATE_LABEL[mate.state] ?? mate.state}</span>
      <span className="team-acts" onClick={(event) => event.stopPropagation()}>
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
        ) : null}
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
        {busy ? null : (
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
      </span>
      {writing ? (
        <span className="team-side" onClick={(event) => event.stopPropagation()}>
          <span className="team-write">
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
        </span>
      ) : null}
    </div>
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


