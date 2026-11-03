/**
 * 排队消息条：折叠语义、四类动作（改 / 撤 / 插话 / 重发），以及摘要压行。
 *
 * 从 `composer/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/composer/queue-dock
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconArrowUp, IconCheck, IconChevronDown, IconClose, IconEdit, IconQueue, IconTrash } from '@dsc/ui'
import { useHostChannel, useHostSelector } from '@dsc/ui'
import { readTurnState } from '@dsc/ui-primitives'
import { readQueued, sameQueued } from './surfaces'

/** 排队消息摘要的字数上限（旧界面的 PREVIEW_CHARS）。 */
const PREVIEW_CHARS = 200

/** 排队消息摘要：压成一行、截到 200 字（全文挂在悬浮说明上）。 */
function previewOf(text: string): string {  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : flat
}

/** 排队条一次动作的结果：`rejected` = 宿主回话说没做到，`failed` = 这次调用本身出错。 */
type ActOutcome = 'ok' | 'rejected' | 'failed'

/**
 * 排队消息条（对照旧界面 `queue-dock.tsx`）。
 *
 * 折叠语义照抄：1 条时没有头行、那一行自带队列图标；多条默认折叠、点头行展开；
 * 队列空了整块不渲染。三类动作都按**行下标**定位（下标就是这条消息在队列里的身份），
 * 宿主说没做到（那条已经出账）就给一句人话，不静默。
 */
export function QueueDock(): ReactNode {
  const channel = useHostChannel()
  const items = useHostSelector(readQueued, sameQueued)
  const turnState = useHostSelector(readTurnState)
  const [collapsed, setCollapsed] = useState(true)
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<string | null>(null)
  const count = items.length

  // 队列空了就收回头行；正在编辑的那条出账了（下标没了）就退出编辑态，
  // 否则回车保存会打到别人头上。
  useEffect(() => {
    if (count === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && !items.some((item) => item.index === editing.index)) setEditing(null)
  }, [collapsed, editing, items, count])

  if (count === 0) return null
  const expanded = count === 1 || !collapsed || editing !== null
  const running = turnState !== 'idle'

  /**
   * 跑一个动作。失败要分两种：`rejected` 是宿主**正常回话说没做到**（那条已经出账 /
   * 这一轮刚结束），调用方据此补一句具体解释；`failed` 是这次调用本身出错（通道断了、
   * 方法不在放行面里、实参不合规），原因已经由这里写进 fault，调用方**不要再覆盖**——
   * 覆盖了就等于对用户说一句与事实相反的话，把人往错的方向带。
   */
  const act = async (work: () => Promise<boolean>, failure: string): Promise<ActOutcome> => {
    setBusy(true)
    setFault(null)
    try {
      return (await work()) ? 'ok' : 'rejected'
    } catch (error) {
      setFault(`${failure}：${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    } finally {
      setBusy(false)
    }
  }

  const save = async (index: number): Promise<void> => {
    const value = editing?.text.trim() ?? ''
    if (value === '') return
    const outcome = await act(() => channel.invoke<boolean>('editQueued', [index, value]), '编辑失败')
    if (outcome === 'ok') {
      setEditing(null)
      return
    }
    if (outcome === 'rejected') setFault('编辑失败：这条已经开始发送了')
  }

  const remove = async (index: number): Promise<void> => {
    const outcome = await act(() => channel.invoke<boolean>('removeQueued', [index]), '撤掉失败')
    if (outcome === 'rejected') setFault('撤掉失败：这条已经开始发送了')
  }

  /**
   * 插话：打断当前输出，让这条立刻作为新一轮发出去。
   *
   * 先问一次——代价是把模型正在说的话砍断（半截会保留），点错了才发现太晚。
   * 旧界面用的是自家样式的确认弹层（`.dsc-confirm`），壳里还没有这套弹层，
   * 所以先用浏览器自带的确认框顶上：它有同样的「必须显式回答」语义。
   */
  const steer = async (index: number): Promise<void> => {
    const ahead = index
    const detail =
      ahead > 0
        ? `会打断模型当前的输出，让这条以及排在它前面的 ${String(ahead)} 条立刻作为新一轮发出去（模型已经说出的半截会保留）。`
        : '会打断模型当前的输出，让这条立刻作为新一轮发出去（模型已经说出的半截会保留）。'
    if (!window.confirm(`打断并插话？\n\n${detail}`)) return
    const outcome = await act(() => channel.invoke<boolean>('steerQueued', [index]), '插话失败')
    if (outcome === 'rejected') setFault('插话没赶上：这一轮刚结束，排队消息会自己发出去')
  }

  return (
    <div className="queue-dock" data-queue-dock="">
      <div className="queue-panel">
        {count > 1 ? (
          <button
            type="button"
            className="queue-head"
            aria-expanded={expanded}
            disabled={busy || editing !== null}
            data-tip={expanded ? '收起排队消息' : '展开排队消息'}
            onClick={() => {
              setCollapsed((current) => !current)
            }}
          >
            <span className="queue-lead" aria-hidden="true">
              <IconQueue size={13} />
            </span>
            <span className="queue-count">{count} 条排队消息</span>
            <span className="queue-note">这一轮跑完自动发出</span>
            <span className="queue-caret" aria-hidden="true">
              <IconChevronDown size={13} />
            </span>
          </button>
        ) : null}

        {expanded ? (
          <ul className="queue-list">
            {/* key 用下标：这条列表的位置就是它的身份（编辑/撤掉/插话都按位置找）。 */}
            {items.map((item) => (
              <li className="queue-row" key={item.index}>
                {editing?.index === item.index ? (
                  <>
                    <textarea
                      className="queue-edit-box"
                      value={editing.text}
                      autoFocus
                      rows={Math.min(8, Math.max(1, editing.text.split('\n').length))}
                      aria-label="编辑排队消息"
                      onChange={(event) => {
                        setEditing({ index: item.index, text: event.target.value })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void save(item.index)
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setEditing(null)
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="queue-act"
                      aria-label="保存排队消息"
                      data-tip="保存（回车）"
                      disabled={busy || editing.text.trim() === ''}
                      onClick={() => void save(item.index)}
                    >
                      <IconCheck size={13} />
                    </button>
                    <button
                      type="button"
                      className="queue-act"
                      aria-label="取消编辑"
                      data-tip="取消（Esc）"
                      disabled={busy}
                      onClick={() => {
                        setEditing(null)
                      }}
                    >
                      <IconClose size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    {count === 1 ? (
                      <span className="queue-lead" aria-hidden="true">
                        <IconQueue size={13} />
                      </span>
                    ) : null}
                    <span className="queue-text" data-tip={item.text}>
                      {previewOf(item.text)}
                    </span>
                    {item.images === undefined || item.images.length === 0 ? null : (
                      <span className="queue-badge" data-tip={`随这条一起排队的 ${String(item.images.length)} 张图`}>
                        +{item.images.length} 图
                      </span>
                    )}
                    <div className="queue-acts">
                      <button
                        type="button"
                        className="queue-act"
                        aria-label="编辑排队消息"
                        data-tip="改这条排队消息"
                        disabled={busy}
                        onClick={() => {
                          setEditing({ index: item.index, text: item.text })
                        }}
                      >
                        <IconEdit size={13} />
                      </button>
                      <button
                        type="button"
                        className="queue-act"
                        aria-label="撤回排队消息"
                        data-tip="撤掉这条（还没发出去）"
                        disabled={busy}
                        onClick={() => void remove(item.index)}
                      >
                        <IconTrash size={13} />
                      </button>
                      <button
                        type="button"
                        className="queue-act"
                        aria-label="插话发送"
                        data-tip={
                          running
                            ? '打断当前输出，让这条立刻发出去（模型已说出的半截保留）'
                            : '这一轮已经跑完，排队消息会自己发出去'
                        }
                        disabled={busy || !running}
                        onClick={() => void steer(item.index)}
                      >
                        {/* 旧界面这一颗是闪电图标；图标集里没有，用同一族的「前进」语义代替。 */}
                        <IconArrowUp size={13} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {fault === null ? null : <div className="shell-composer-fault">{fault}</div>}
    </div>
  )
}
