/**
 * 内置插件：状态面板（对照 ZCode 的「状态」浮层：一个可收成胶囊的进程/智能体总览）。
 *
 * ## 为什么要有它
 *
 * 长会话里「现在到底有几件事在跑」原本散在三处：输入框上方的任务条（`plugins/tasks`）、
 * 标题旁的「N 个子智能体」下拉（`plugins/team`）、状态栏的读数。三处都要先把视线移开正在读的
 * 正文；而且它们各答一半——任务条不报队友，队友下拉不报任务进度。这个面板把这两条**合成
 * 一块钉在正文右上角**的浮层：一眼看到「进程 3/5」「2 个智能体在跑」，点开看逐条。
 *
 * ## 形状（照 ZCode 的状态面板）
 *
 * - **胶囊态**（`data-display-mode="mini"`）：一颗高约 34px 的药丸，只报当前最该知道的那一条
 *   （有队友在跑就报队友，否则报任务进度）。点它展开成面板。
 * - **面板态**：左上角标题栏（右侧两颗钮：展开策略、收起为胶囊）+ 分节列表。每行是一颗
 *   **胶囊行**：状态点 + 标题 + 时长（子智能体行还有「停止」）。
 * - **自动**（默认）：窗口宽 ≥ {@link AUTO_PANEL_MIN_WIDTH} 才展开，窄了收成胶囊——
 *   窄窗口里一块 320px 的浮层会盖掉半个正文。
 *
 * ## 为什么挂在 `shell.main` 槽里却画在正文右上角
 *
 * `shell.main` 的条目渲染在滚动容器里（`.chat-inner`），静态排布会随正文滚走。所以这里
 * 用的是右缘刻度条（`plugins/transcript/jump-rail.tsx`）那一套：**一个 hidden 哨兵**在文档流里
 * 占位，组件从它往上找 `.chat-wrap`（`position: relative` 的定位父级），再把浮层 portal 进去。
 * 这样它自动避开左侧栏与右侧 dock 的宽度变化，不必知道任何像素。
 *
 * ## 数据
 *
 * - 任务：**快照的 `surfaces.todos`**（与任务条同源，逐帧推）。
 * - 智能体：`listTeammates`（界面通道，放行面上）。快照里没有这份名册（它是跨重启的
 *   台账，按需拉），所以这里 5 秒轮询一次——比队友面板的 3 秒松一档：这一步是**总览**，
 *   差一两秒不影响判断，而两个插件各拉一份已经是两份请求了。
 *
 * @module dsc-ui-shell/plugins/status
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheck,
  IconChevronDown,
  IconMore,
  IconStop,
  IconTree,
  SLOT,
  defineUiPlugin,
  setDockSubagent,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  useThreadView,
  type HostSnapshot,
  type TeammateView,
  type TodoView,
} from '@dsc/ui'

/** 轮询间隔（毫秒）：队友名册在快照里没有，只能问通道。 */
const POLL_MS = 5000
/** 自动档展开面板的最小窗口宽度（照 ZCode：1280px 以下收成胶囊）。 */
const AUTO_PANEL_MIN_WIDTH = 1280
/** 任务节最多列几条（再多就折成「还有 N 项」——这是总览，不是清单）。 */
const MAX_TODO_ROWS = 6
/** 展示档位的存档键（本机，跟人走而不跟会话走）。 */
const MODE_KEY = 'dsc.statusPanel.mode'

/** 三种展示档（与 ZCode 的 displayModeAuto / Expanded / Collapsed 同义）。 */
type DisplayMode = 'auto' | 'panel' | 'mini'

const MODE_LABEL: Readonly<Record<DisplayMode, string>> = {
  auto: '自动展开',
  panel: '始终展开',
  mini: '始终收起',
}

const MODE_ORDER: readonly DisplayMode[] = ['auto', 'panel', 'mini']

/** 读存档的展示档；认不出按自动。 */
function readMode(): DisplayMode {
  try {
    const raw = globalThis.localStorage?.getItem(MODE_KEY)
    return raw === 'panel' || raw === 'mini' || raw === 'auto' ? raw : 'auto'
  } catch {
    // 隐私模式 / 存储被禁：当自动，不影响面板本身能用。
    return 'auto'
  }
}

/** 写存档（写不进去不算失败——下次进来退回自动而已）。 */
function writeMode(mode: DisplayMode): void {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode)
  } catch {
    // 同上：存档是锦上添花。
  }
}

/** 毫秒 → 「14分30秒」/「8秒」；拿不到给空串（与队友行的口径一致）。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const total = Math.max(1, Math.round(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}小时${pad(minutes)}分`
  if (minutes > 0) return `${String(minutes)}分${pad(seconds)}秒`
  return `${String(seconds)}秒`
}

/** 队友状态 → 数据属性（样式里靠它上色，与团队面板同一套词）。 */
const MATE_TONE: Readonly<Record<TeammateView['state'], string>> = {
  working: 'working',
  idle: 'idle',
  stopped: 'stopped',
  failed: 'failed',
}

/** 队友状态的中文（总览里只给短词，完整解释在团队面板里）。 */
const MATE_TEXT: Readonly<Record<TeammateView['state'], string>> = {
  working: '干活中',
  idle: '已收工',
  stopped: '被打断',
  failed: '过程失败',
}

export default defineUiPlugin({
  name: '状态面板',
  apply(ui) {
    // order 5：排在消息流（order 1）之后。它是浮层，排在哪一位都不进文档流，
    // 但排后面一点可以让它在 DOM 里晚于正文出现（自检按选择器取它更省事）。
    ui.slots.register(SLOT.main, { id: 'status.panel', order: 5 }, StatusPanel)
  },
})

/** 一份任务投影（与任务条同一份读法：没有这个面或没有条目就是 null）。 */
function readTodos(snapshot: HostSnapshot | null): TodoView | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const todos = (surfaces as Record<string, unknown>)['todos']
  if (typeof todos !== 'object' || todos === null) return null
  const record = todos as Record<string, unknown>
  if (!Array.isArray(record['items']) || record['items'].length === 0) return null
  return todos as TodoView
}

/** 任务投影的相等判断：快照每帧换引用，不给判断会逐帧重画浮层。 */
function sameTodos(left: TodoView | null, right: TodoView | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (left.done !== right.done || left.total !== right.total || left.active !== right.active) return false
  if (left.items.length !== right.items.length) return false
  return left.items.every((item, index) => {
    const other = right.items[index]
    return other !== undefined && item.id === other.id && item.status === other.status && item.content === other.content
  })
}

/**
 * 当前会话 id——**口径必须和 `listTeammates` 一致**：队友名册里的 `sessionId` 是它的
 * 出生会话的**文件名**（去 `.jsonl`），所以这里从快照的 `status.sessionPath` 取尾段，
 * 而不是读 `status.sessionId`（那是另一个字段，和名册对不上，第一版自检里智能体节
 * 就是这么整节不出现的）。
 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string' || path === '') return null
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base
}

function StatusPanel(): ReactNode {
  const channel = useHostChannel()
  const view = useThreadView()
  const todos = useHostSelector(readTodos, sameTodos)
  const sessionId = useHostSelector(readSessionId)
  const [mates, setMates] = useState<readonly TeammateView[]>([])
  const [mode, setMode] = useState<DisplayMode>(readMode)
  const [menuOpen, setMenuOpen] = useState(false)
  const [wide, setWide] = useState(() => window.innerWidth >= AUTO_PANEL_MIN_WIDTH)
  const [now, setNow] = useState(() => Date.now())
  const sentinel = useRef<HTMLDivElement | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)

  // 定位父级：从哨兵往上找 `.chat-wrap`（与右缘刻度条同一套做法）。
  useEffect(() => {
    const node = sentinel.current
    const found = node?.closest('.chat-wrap')
    setHost(found instanceof HTMLElement ? found : null)
  }, [view])

  // 名册轮询：面板开着才值得问；收起成胶囊时也要问（胶囊上那行读数就是它算出来的）。
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void channel
        .invoke<TeammateView[]>('listTeammates', [])
        .then((list) => {
          if (alive) setMates(Array.isArray(list) ? list : [])
        })
        .catch(() => {
          // team 服务缺席（子智能体插件没开）时名册就是空的：给空态而不是报错条。
          if (alive) setMates((current) => (current.length === 0 ? current : []))
        })
    }
    poll()
    const timer = window.setInterval(poll, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [channel])

  // 窗口宽度决定自动档收不收。
  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= AUTO_PANEL_MIN_WIDTH)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const mine = useMemo(
    () => mates.filter((mate) => sessionId !== null && mate.sessionId === sessionId),
    [mates, sessionId],
  )
  const running = mine.filter((mate) => mate.state === 'working')
  const worked = mine.filter((mate) => mate.state !== 'working')
  /** 现在展开成面板没有：显式档直接定，自动档看窗口够不够宽（见 AUTO_PANEL_MIN_WIDTH）。 */
  const expanded = mode === 'panel' || (mode === 'auto' && wide)

  // 自己播一秒一次的时钟：只在**面板展开**时跑——收起成胶囊时没有任何秒级读数要刷新，
  // 一个常驻的 1s 定时器纯属白烧（胶囊上那句读数由名册轮询驱动就够了）。
  useEffect(() => {
    if (!expanded) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expanded])
  // 帧率与面板无关的那一半：胶囊上的读数
  const miniReadout =
    running.length > 0
      ? `${String(running.length)} 个智能体在跑`
      : todos !== null && todos.total > 0
        ? `进程 ${String(todos.done)}/${String(todos.total)}`
        : worked.length > 0
          ? `${String(worked.length)} 个已收工`
          : ''

  const stopMate = (mate: TeammateView): void => {
    void channel
      .invoke('stopTeammate', [mate.name])
      .then(() => toastOk(`已叫停 ${mate.name}`))
      .catch((reason: unknown) => toastErr(`叫停失败：${reason instanceof Error ? reason.message : String(reason)}`))
  }

  const chooseMode = (next: DisplayMode): void => {
    setMenuOpen(false)
    setMode(next)
    writeMode(next)
  }

  // 三处都空（没有任务、没有本会话队友）时整块不画：浮层不该在无事可报时占着右上角。
  // 但**哨兵一定要在**——它被卸载再挂载时 host 会重新解析一次，多一次查询而已。
  const hasData = todos !== null || mine.length > 0
  const panel =
    hasData && view === 'chat' ? (
      <div className="sp-host">
        {expanded ? (
          <aside className="sp" data-display-mode={mode} aria-label="状态">
            <div className="sp-toolbar">
              <button
                type="button"
                className="sp-icon-btn"
                aria-label="展开策略"
                data-tip={`状态面板展开策略：${MODE_LABEL[mode]}`}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconMore size={13} />
              </button>
              <button
                type="button"
                className="sp-icon-btn"
                aria-label="收起为胶囊"
                data-tip="收起为胶囊"
                onClick={() => {
                  chooseMode('mini')
                }}
              >
                <IconChevronDown size={13} />
              </button>
              {menuOpen ? (
                <>
                  <div
                    className="sp-mask"
                    onClick={() => {
                      setMenuOpen(false)
                    }}
                  />
                  <div className="sp-menu" role="menu" aria-label="展开策略">
                    {MODE_ORDER.map((item) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={item === mode}
                        key={item}
                        className={`sp-menu-item${item === mode ? ' on' : ''}`}
                        onClick={() => {
                          chooseMode(item)
                        }}
                      >
                        {MODE_LABEL[item]}
                        {item === mode ? <IconCheck size={12} /> : null}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <div className="sp-scroll">
              <TodoSection todos={todos} />
              <MateSection
                running={running}
                worked={worked}
                now={now}
                onStop={stopMate}
                onOpen={(mate) => {
                  setDockSubagent({ path: mate.file, label: mate.name })
                }}
              />
            </div>
          </aside>
        ) : (
          <button
            type="button"
            className="sp-mini"
            data-display-mode="mini"
            aria-label="展开状态面板"
            data-tip="展开状态面板（进程与智能体）"
            onClick={() => {
              chooseMode('panel')
            }}
          >
            <IconTree size={13} />
            <span className="sp-mini-text">{miniReadout}</span>
          </button>
        )}
      </div>
    ) : (
      <div className="sp-host" hidden />
    )

  return (
    <>
      {/* 哨兵：只负责给出定位父级（.chat-wrap），自己永远不可见也不占位。 */}
      <div ref={sentinel} hidden />
      {host === null ? null : createPortal(panel, host)}
    </>
  )
}

/** 任务节：进度读数 + 逐条胶囊行（最多 {@link MAX_TODO_ROWS} 条）。 */
function TodoSection({ todos }: { todos: TodoView | null }): ReactNode {
  if (todos === null) return null
  const shown = todos.items.slice(0, MAX_TODO_ROWS)
  const rest = todos.items.length - shown.length
  return (
    <section className="sp-section" data-sp-section="todo">
      <div className="sp-section-head">
        <span className="sp-section-title">进程</span>
        <span className="sp-section-trail" data-sp-progress={`${String(todos.done)}/${String(todos.total)}`}>
          {`${String(todos.done)}/${String(todos.total)}`}
        </span>
      </div>
      <ul className="sp-list">
        {shown.map((item) => (
          <li className="sp-row" data-status={item.status} key={item.id}>
            <span className="sp-dot" aria-hidden="true" />
            <span className="sp-row-text" title={item.content}>
              {item.content}
            </span>
            {item.parent === undefined ? null : <span className="sp-row-note">子任务</span>}
          </li>
        ))}
        {rest > 0 ? <li className="sp-row sp-row-more">还有 {rest} 项</li> : null}
      </ul>
    </section>
  )
}

/** 智能体节：在跑的在上、收工的在下一分组；点一行落右侧栏，跑着的给「停止」。 */
function MateSection({
  running,
  worked,
  now,
  onStop,
  onOpen,
}: {
  running: readonly TeammateView[]
  worked: readonly TeammateView[]
  now: number
  onStop(mate: TeammateView): void
  onOpen(mate: TeammateView): void
}): ReactNode {
  if (running.length === 0 && worked.length === 0) return null
  return (
    <section className="sp-section" data-sp-section="agents">
      <div className="sp-section-head">
        <span className="sp-section-title">智能体</span>
        <span className="sp-section-trail">{`${String(running.length)} 运行`}</span>
      </div>
      <ul className="sp-list">
        {[...running, ...worked].map((mate) => {
          const elapsed = formatDuration((mate.finishedAt ?? now) - mate.startedAt)
          return (
            <li className="sp-row sp-row-agent" data-state={MATE_TONE[mate.state]} key={mate.file}>
              {/* 整行可点：落到右侧栏看它的运行记录（行内按钮各自 stopPropagation）。 */}
              <button
                type="button"
                className="sp-row-open"
                aria-label={`打开 ${mate.name} 的运行记录`}
                data-sp-agent={mate.name}
                data-tip={`${mate.role} · ${mate.task}\n点开在右侧栏看它的运行记录（只读）`}
                onClick={() => {
                  onOpen(mate)
                }}
              >
                <span className="sp-dot" aria-hidden="true" />
                <span className="sp-row-text" title={mate.task}>
                  {mate.name}
                </span>
                <span className="sp-row-state">{MATE_TEXT[mate.state]}</span>
                {elapsed === '' ? null : <span className="sp-row-time">{elapsed}</span>}
              </button>
              {mate.state === 'working' ? (
                <button
                  type="button"
                  className="sp-row-stop"
                  aria-label={`停掉 ${mate.name}`}
                  data-tip="停掉这个队友（尽力而为）"
                  onClick={(event) => {
                    event.stopPropagation()
                    onStop(mate)
                  }}
                >
                  <IconStop size={12} />
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
