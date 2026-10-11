/**
 * 内置插件：智能体团队面板（对照旧桌面界面 TeamPanel.tsx 的精简版）。
 *
 * 数据走界面通道的 `listTeammates`（面板开着时每 3 秒轮询一次；收起不问），
 * 动作走 `stopTeammate` / `messageTeammate` / `removeTeammate`——四个方法
 * 都在放行面上（白名单见 `src/core/ui-methods.ts`），壳里此前一直没人接。
 * 点一行看运行记录走 `peekTranscript`（队友会话的只读条目流，简版渲染）。
 *
 * 与桌面端的差异（精简边界）：没有「其它会话的队友」折叠组与移除记录的细分文案、
 * 没有运行记录里的完整座位/折叠体系——只读流按行直排。
 *
 * @module dsc-ui-shell/plugins/team
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  confirmAction,
  defineUiPlugin,
  toastErr,
  toastOk,
  useHostChannel,
  type TranscriptEntry,
  type TeammateView,

} from '@dsc/ui'

/** 队友状态词（桌面端 TEAMMATE_STATE_LABEL 同款）。 */
const STATE_LABEL: Readonly<Record<string, string>> = {
  working: '正在干活',
  idle: '已收工',
  stopped: '被打断',
  failed: '出错',
}

export default defineUiPlugin({
  name: '智能体团队',
  apply(ui) {
    ui.slots.register('shell.header', { id: 'team.toggle', order: 40 }, TeamToggle)
  },
})

/** 顶栏的「团队」钮：浮层开着时常亮；有干活的队友时点上一个小点。 */
function TeamToggle(): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`icon-btn${open ? ' on' : ''}`}
        title="智能体团队"
        aria-label="智能体团队"
        aria-pressed={open}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        队友
      </button>
      {open ? <TeamPanel onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** 团队浮层：名单（轮询）+ 展开的运行记录。 */
function TeamPanel({ onClose }: { onClose: () => void }): ReactNode {
  const channel = useHostChannel()
  const [mates, setMates] = useState<TeammateView[] | null>(null)
  /** 正在看运行记录的队友（file 路径）；null = 名单形态。 */
  const [peeking, setPeeking] = useState<{ name: string; file: string } | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    const poll = (): void => {
      void channel
        .invoke<TeammateView[]>('listTeammates', [])
        .then((list) => {
          setMates(Array.isArray(list) ? list : [])
        })
        .catch(() => {
          // 子智能体插件没开（team 服务缺席）时名单就是空的：给空态而不是报错条。
          setMates((current) => current ?? [])
        })
    }
    poll()
    timer.current = window.setInterval(poll, 3000)
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [channel])

  // Esc 关浮层（与设置面板同款；确认框开着时它先拦）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (peeking !== null) setPeeking(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, peeking])

  const act = async (method: string, args: unknown[], tip: string): Promise<void> => {
    try {
      await channel.invoke(method, args)
      toastOk(tip)
    } catch (reason) {
      toastErr(`${tip}失败：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  return (
    <div className="team-pop">
      <div className="pop-mask" onClick={onClose} />
      <div className="team-pop-card" role="dialog" aria-label="智能体团队">
        <div className="team-pop-head">
          <span>{peeking === null ? '智能体团队' : `队友 ${peeking.name} 的运行记录`}</span>
          <button
            type="button"
            className="icon-btn"
            title={peeking === null ? '关闭' : '回到名单'}
            aria-label="关闭"
            onClick={() => {
              if (peeking !== null) setPeeking(null)
              else onClose()
            }}
          >
            ×
          </button>
        </div>
        {peeking !== null ? (
          <PeekView file={peeking.file} />
        ) : mates === null ? (
          <div className="team-empty">正在读名单…</div>
        ) : mates.length === 0 ? (
          <div className="team-empty">这一版宿主还没有派出队友。团队协作入口在会话里（让主智能体派活）。</div>
        ) : (
          <div className="team-list">
            {mates.map((mate) => (
              <TeamRow
                key={mate.name}
                mate={mate}
                onOpen={() => {
                  setPeeking({ name: mate.name, file: mate.file })
                }}
                onStop={() => {
                  void act('stopTeammate', [mate.name], `已叫停 ${mate.name}`)
                }}
                onRemove={() => {
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
                onMessage={(text) => {
                  void act('messageTeammate', [mate.name, text], `话已带给 ${mate.name}`)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 名单里的一行：状态点 + 名字 + 角色 + 任务 + 轮数 + 状态 + 停止/发话/移除。 */
function TeamRow({
  mate,
  onOpen,
  onStop,
  onRemove,
  onMessage,
}: {
  mate: TeammateView
  onOpen: () => void
  onStop: () => void
  onRemove: () => void
  onMessage: (text: string) => void
}): ReactNode {
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const busy = mate.state === 'working'
  return (
    <div className="team-row" role="button" tabIndex={0} onClick={onOpen}>
      <span className={`tm-dot ${mate.state}`} aria-hidden="true" />
      <span className="tm-name">{mate.name}</span>
      <span className="tm-role">{mate.role}</span>
      <span className="team-task" title={mate.task}>
        {mate.task}
      </span>
      <span className="team-round">第 {mate.rounds} 轮</span>
      <span className="tm-state">{STATE_LABEL[mate.state] ?? mate.state}</span>
      <span className="team-acts" onClick={(event) => event.stopPropagation()}>
        {busy ? (
          <button type="button" className="text-btn danger" onClick={onStop}>
            停止
          </button>
        ) : null}
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            setWriting((current) => !current)
          }}
        >
          发话
        </button>
        {busy ? null : (
          <button type="button" className="text-btn danger" onClick={onRemove}>
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
                onMessage(text)
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
                onMessage(text)
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

  if (error !== '') return <div className="team-empty">读不了运行记录：{error}</div>
  if (entries === null) return <div className="team-empty">正在读运行记录…</div>
  if (entries.length === 0) return <div className="team-empty">它还没开始干活。</div>
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
