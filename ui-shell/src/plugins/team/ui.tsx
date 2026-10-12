/**
 * 内置插件：智能体团队（对照旧桌面界面 TeamPanel.tsx 的两颗入口：标题旁的
 * 「N 个子智能体」下拉 + 「智能体团队」面板，共用一份名册行）。
 *
 * 数据走界面通道的 `listTeammates`（面板开着时每 3 秒轮询一次；收起不问），
 * 动作走 `stopTeammate` / `messageTeammate` / `removeTeammate`——四个方法
 * 都在放行面上（白名单见 `src/core/ui-methods.ts`）。点一行看运行记录走
 * `peekTranscript`（队友会话的只读条目流，简版渲染）。
 *
 * 本会话的队伍按 `mate.sessionId === 当前会话` 过滤（老名册行没有 sessionId，
 * 不归任何会话）；其它会话的收进底部折叠组，只读列出（对照旧界面 matesOf）。
 *
 * 与桌面端的差异（精简边界）：没有运行记录里的完整座位/折叠体系——只读流按行直排。
 *
 * @module dsc-ui-shell/plugins/team
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconChevronDown,
  IconClose,
  confirmAction,
  defineUiPlugin,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type HostSnapshot,
  type TranscriptEntry,
  type TeammateView,
} from '@dsc/ui'

/** 毫秒 → 「2分41秒」/「8秒」；拿不到（负数 / NaN）给 null（与消息流的时间口径同款，
 *  插件 bundle 各自独立，不跨插件 import——这一段很短，就地留一份）。 */
function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const total = Math.max(1, Math.round(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}时${pad(minutes)}分${pad(seconds)}秒`
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`
  return `${String(seconds)}秒`
}

/** 队友状态词（旧界面 TEAMMATE_STATE_LABEL 同款）。 */
const STATE_LABEL: Readonly<Record<string, string>> = {
  working: '运行中',
  idle: '已完成',
  stopped: '已停止',
  failed: '已失败',
}

/** 本会话派出的队友（旧界面 matesOf 同款：没 sessionId 的老名册行不归任何会话）。 */
function matesOf(mates: readonly TeammateView[], sessionId: string | null): TeammateView[] {
  if (sessionId === null || sessionId === '') return []
  return mates.filter((mate) => mate.sessionId === sessionId)
}

/** 当前会话 id（快照 status.sessionPath 的短名；旧界面面包屑同款读数）。 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string' || path === '') return null
  // 会话文件名（去扩展名）就是 id——宿主 listTeammates 的 sessionId 是同一个口径。
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base
}

// ── 面板开合（模块级：子智能体菜单与团队钮是两个槽条目，共享同一份）────────────
let panelOpen = false
let peekWanted: string | null = null
const openListeners = new Set<() => void>()
function setPanelOpen(next: boolean, peek: string | null = null): void {
  if (next === panelOpen && peek === peekWanted) return
  panelOpen = next
  peekWanted = peek
  for (const listener of openListeners) listener()
}
/** 订阅函数提到模块级：`useSyncExternalStore` 要求它的引用稳定（内联箭头会反复重订阅）。 */
function subscribePanelOpen(listener: () => void): () => void {
  openListeners.add(listener)
  return () => {
    openListeners.delete(listener)
  }
}
function usePanelOpen(): boolean {
  return useSyncExternalStore(subscribePanelOpen, () => panelOpen, () => false)
}

export default defineUiPlugin({
  name: '智能体团队',
  apply(ui) {
    // 标题旁的两簇（旧界面同构）：子智能体下拉在前，团队钮在后。
    ui.slots.register('shell.header.lead', { id: 'team.subagents', order: 10 }, SubagentMenu)
    ui.slots.register('shell.header.lead', { id: 'team.toggle', order: 20 }, TeamButton)
  },
})

/** 名册的拉取（子智能体菜单与团队面板共用一份实现：挂载拉一次 + 每 3 秒轮询）。 */
function useTeammates(): TeammateView[] | null {
  const channel = useHostChannel()
  const [mates, setMates] = useState<TeammateView[] | null>(null)
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void channel
        .invoke<TeammateView[]>('listTeammates', [])
        .then((list) => {
          if (alive) setMates(Array.isArray(list) ? list : [])
        })
        .catch(() => {
          // 子智能体插件没开（team 服务缺席）时名单就是空的：给空态而不是报错条。
          if (alive) setMates((current) => current ?? [])
        })
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [channel])
  return mates
}

/** 「智能体团队」钮（标题旁，文字钮）：打开本会话的队伍模态面板。 */
function TeamButton(): ReactNode {
  const open = usePanelOpen()
  return (
    <>
      <button
        type="button"
        className={`team-btn${open ? ' on' : ''}`}
        aria-expanded={open}
        data-tip="智能体团队：本会话派出的队伍；其它会话的队友在面板底部列出"
        onClick={() => {
          setPanelOpen(!open)
        }}
      >
        智能体团队
      </button>
      {open ? <TeamPanel /> : null}
    </>
  )
}

/** 「N 个子智能体」下拉：本会话派出的队友，一行一个；数量为 0 时整颗不渲染。 */
function SubagentMenu(): ReactNode {
  const mates = useTeammates()
  const sessionId = useHostSelector(readSessionId)
  const [open, setOpen] = useState(false)
  const mine = matesOf(mates ?? [], sessionId)
  if (mine.length === 0) return null
  return (
    <div className="sub-open">
      <button
        type="button"
        className={`sub-btn${open ? ' on' : ''}`}
        aria-expanded={open}
        data-tip="本会话派出的子智能体：状态、耗时，点一行看运行记录"
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        {mine.length} 个子智能体
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <>
          <div
            className="menu-backdrop"
            onClick={() => {
              setOpen(false)
            }}
          />
          <div className="row-menu sub-menu" role="menu" aria-label="本会话的子智能体">
            {mine.map((mate) => (
              <TeamRow
                key={mate.file}
                mate={mate}
                compact
                onOpen={() => {
                  setOpen(false)
                  setPanelOpen(true, mate.name)
                }}
              />
            ))}
            <p className="team-hint">
              点一行看它的运行记录（只读）；「停止」是尽力而为，「发话」由宿主转交，收工的可以移除。
            </p>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 「智能体团队」面板：本会话的队伍为主；其它会话派出的收进底部折叠组，只读。
 *  层级照设置面板那一档（.settings-mask + .settings），Esc 与点遮罩都关。 */
function TeamPanel(): ReactNode {
  const mates = useTeammates()
  const sessionId = useHostSelector(readSessionId)
  const [othersOpen, setOthersOpen] = useState(false)
  /** 正在看运行记录的队友（file 路径）；null = 名单形态。 */
  const [peeking, setPeeking] = useState<{ name: string; file: string } | null>(null)

  // 子智能体菜单点一行要直接看记录：一次性交接（读完即清）。
  useEffect(() => {
    if (peekWanted === null || mates === null) return
    const wanted = mates.find((mate) => mate.name === peekWanted)
    peekWanted = null
    if (wanted !== undefined) setPeeking({ name: wanted.name, file: wanted.file })
  }, [mates])

  // Esc 关面板（与设置面板同款；确认框开着时它先拦）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (peeking !== null) setPeeking(null)
      else setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peeking])

  const mine = matesOf(mates ?? [], sessionId)
  const others = (mates ?? []).filter((mate) => !mine.includes(mate))

  return (
    <div
      className="settings-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPanelOpen(false)
      }}
    >
      <div className="settings team-panel" role="dialog" aria-modal="true" aria-label="智能体团队">
        <div className="settings-main">
          <div className="settings-head">
            <div className="settings-head-text">
              <h2>{peeking === null ? '智能体团队' : `队友 ${peeking.name} 的运行记录`}</h2>
              <p>
                {peeking === null
                  ? '这里是本会话派出的队伍，切到别的会话就是另一支；其它会话的队友在底部列出，可点开记录或移除。'
                  : '运行记录只读；「回到名单」可以回到队伍列表。'}
              </p>
            </div>
            <button
              type="button"
              className="icon-btn"
              autoFocus
              data-tip={peeking === null ? '关闭，快捷键 Esc' : '回到名单'}
              onClick={() => {
                if (peeking !== null) setPeeking(null)
                else setPanelOpen(false)
              }}
            >
              <IconClose size={16} />
            </button>
          </div>

          <div className="settings-body">
            {peeking !== null ? (
              <PeekView file={peeking.file} />
            ) : mates === null ? (
              <div className="settings-empty">正在读名单…</div>
            ) : (
              <>
                {mine.length === 0 ? (
                  <div className="settings-empty">
                    本会话还没有队友：「子智能体」插件开着时，模型用 subagent 工具派活，会在这里出现。
                  </div>
                ) : (
                  <div className="team-list">
                    {mine.map((mate) => (
                      <TeamRow
                        key={mate.file}
                        mate={mate}
                        onOpen={() => {
                          setPeeking({ name: mate.name, file: mate.file })
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
                      其它会话的队友（{others.length}）
                    </button>
                    {othersOpen ? (
                      <div className="team-list team-others">
                        {others.map((mate) => (
                          <TeamRow
                            key={mate.file}
                            mate={mate}
                            onOpen={() => {
                              setPeeking({ name: mate.name, file: mate.file })
                            }}
                          />
                        ))}
                        <p className="team-hint">
                          这些队友是别的会话（或更早的版本）派出的：点一行看运行记录，收工的可以移除；
                          正在干活的请切回派出它的会话再管。
                        </p>
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
      toastErr(`${tip}失败：${reason instanceof Error ? reason.message : String(reason)}`)
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
      <span className="team-round">第 {mate.rounds} 轮</span>
      {compact ? null : <UsedTime mate={mate} />}
      <span className="tm-state">{STATE_LABEL[mate.state] ?? mate.state}</span>
      <span className="team-acts" onClick={(event) => event.stopPropagation()}>
        {busy ? (
          <button
            type="button"
            className="text-btn danger"
            data-tip="停掉这个队友（尽力而为，已跑完的改不了结果）"
            onClick={() => {
              void act('stopTeammate', [mate.name], `已叫停 ${mate.name}`)
            }}
          >
            停止
          </button>
        ) : null}
        <button
          type="button"
          className="text-btn"
          aria-pressed={writing}
          data-tip="给这个队友发一句话（走宿主转发）"
          onClick={() => {
            setWriting((current) => !current)
          }}
        >
          发话
        </button>
        {busy ? null : (
          <button
            type="button"
            className="text-btn danger"
            data-tip="从名册移除，运行记录一并删除（不进回收站）"
            onClick={() => {
              void (async () => {
                const ok = await confirmAction({
                  title: `移除队友「${mate.name}」？`,
                  detail: '会删掉它的名册记录与运行记录文件；正在干活的先叫停再移除。',
                  confirmLabel: '移除',
                  danger: true,
                })
                if (!ok) return
                void act('removeTeammate', [mate.name], `已移除 ${mate.name}`)
              })()
            }}
          >
            移除
          </button>
        )}
      </span>
      {writing ? (
        <span className="team-side" onClick={(event) => event.stopPropagation()}>
          <span className="team-write">
            <input
              autoFocus
              value={draft}
              placeholder={`给 ${mate.name} 带句话…`}
              aria-label={`给 ${mate.name} 发消息`}
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                const text = draft.trim()
                if (text === '') return
                void act('messageTeammate', [mate.name, text], `话已带给 ${mate.name}`)
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
                void act('messageTeammate', [mate.name, text], `话已带给 ${mate.name}`)
                setDraft('')
                setWriting(false)
              }}
            >
              发送
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
    <span className="tm-time" data-tip={running ? '已经跑了多久（每秒刷新）' : '从派活到收工的总耗时'}>
      {used ?? ''}
    </span>
  )
}

/** 队友运行记录的只读流（peekTranscript 回的条目数组，简版渲染：正文/工具/思考/系统直排）。 */
function PeekView({ file }: { file: string }): ReactNode {
  const channel = useHostChannel()
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void channel
      .invoke<TranscriptEntry[]>('peekTranscript', [file])
      .then((list) => {
        if (alive) setEntries(Array.isArray(list) ? list : [])
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [channel, file])

  if (error !== '') return <div className="settings-empty">读不了运行记录：{error}</div>
  if (entries === null) return <div className="settings-empty">正在读运行记录…</div>
  if (entries.length === 0) return <div className="settings-empty">它还没开始干活。</div>
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
              {entry.call.status === 'failed' ? ' · 失败' : ''}
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

/** 换行压空格、超长截断（运行记录行的参数摘要用）。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}
