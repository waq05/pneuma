import { useEffect, useState, type ReactNode } from 'react'
import { PendingCard } from '../components/ApprovalCard.js'
import { ChatStream } from '../components/ChatStream.js'
import { Composer } from '../components/Composer.js'
import { TopBar } from '../components/TopBar.js'
import type { ClientState, RemoteClient } from '../lib/client.js'
import { pathName, pathTail, usageLine } from '../lib/format.js'
import { commandToRun, type PhoneCommandView } from '../lib/commands.js'
import { allEntries, currentTurnUsage } from '../lib/protocol.js'
import type { ApprovalAnswer, RemoteSnapshot } from '../lib/types.js'

/**
 * 聊天页：一屏里同时管四件事——看直播、发消息/打断、答卡片、看本轮用量。
 *
 * 布局是「不滚动的列 + 一个会滚的区域」：
 *   TopBar / 连接细条 / 对话流（唯一可滚）/ 用量小字 / 待办卡 / 发送框。
 * 这样软键盘弹起时只有对话流被压缩，发送框与卡片始终在手指够得到的地方。
 */
export interface ChatPageProps {
  client: RemoteClient
  state: ClientState
  onOpenSessions: () => void
}

export function ChatPage({ client, state, onOpenSessions }: ChatPageProps): ReactNode {
  const snapshot: RemoteSnapshot | null = state.snapshot
  const entries = allEntries(snapshot)
  const usage = currentTurnUsage(snapshot)

  // 卡片身份：宿主换一张卡（或卡片消失）就自动把「已提交」状态清掉，
  // 所以这里既不用本地隐藏卡片，也不会把上一张卡的状态带到下一张。
  const cardKey = [
    snapshot?.surfaces.pendingApproval?.id ?? '-',
    snapshot?.surfaces.pendingPlan?.file ?? '-',
    snapshot?.surfaces.pendingQuestion?.id ?? '-',
  ].join('|')
  const [decidedKey, setDecidedKey] = useState<string | null>(null)
  const [cardError, setCardError] = useState<string | null>(null)
  const decided = decidedKey === cardKey

  /**
   * 输入框 `/` 菜单的命令清单：连上之后取一次。
   *
   * 取不到就当空表——菜单不弹，但发消息照旧可用；手机上任何一条「取不到就白屏」都
   * 比没有菜单更糟。清单本身是宿主按 `shell: true` 挑过的那批（桌面壳同一份）。
   */
  const [commands, setCommands] = useState<PhoneCommandView[]>([])
  useEffect(() => {
    if (state.conn !== 'open') return
    void client
      .invoke<PhoneCommandView[]>('listUiCommands')
      .then((list) => {
        setCommands(Array.isArray(list) ? list : [])
      })
      .catch(() => undefined)
  }, [client, state.conn])

  const cwd = snapshot?.cwd ?? null
  const title = cwd === null || cwd === '' ? '当前会话' : pathName(cwd)

  function answer(method: string, args: readonly unknown[]): void {
    setDecidedKey(cardKey)
    setCardError(null)
    void client.invoke(method, args).catch((cause: unknown) => {
      // 失败就把按钮放回来：用户可以再点一次，而不是干等一张永远不会消失的卡。
      setDecidedKey(null)
      setCardError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const hasPending =
    snapshot !== null &&
    (snapshot.surfaces.pendingApproval !== null ||
      snapshot.surfaces.pendingPlan !== null ||
      snapshot.surfaces.pendingQuestion !== null)

  return (
    <div className="page page-chat">
      <TopBar
        title={title}
        subtitle={cwd === null ? undefined : pathTail(cwd, 2)}
        right={
          <button type="button" className="ghost" onClick={onOpenSessions}>
            会话
          </button>
        }
      />
      <ChatStream entries={entries} />
      {usage !== null ? (
        <div className="usageline">
          本轮 <span className="mono">{usageLine(usage)}</span>
        </div>
      ) : null}
      {hasPending && snapshot !== null ? (
        <div className="pending-dock">
          <PendingCard
            approval={snapshot.surfaces.pendingApproval}
            plan={snapshot.surfaces.pendingPlan}
            question={snapshot.surfaces.pendingQuestion}
            decided={decided}
            // 第二个实参是审计来源（contract.ts 的 answerApproval(answer, source?)）：
            // 这里点的是手机上的卡，所以报 'web'，宿主的审计记录里能分清是谁批的。
            onAnswerApproval={(value: ApprovalAnswer) => answer('answerApproval', [value, 'web'])}
            onAnswerPlan={(value: ApprovalAnswer) => answer('answerPlan', [value])}
            onAnswerQuestion={(value: string) => answer('answerQuestion', [value])}
          />
          {cardError !== null ? <p className="pendingcard-error">{cardError}</p> : null}
        </div>
      ) : null}
      <Composer
        busy={state.busy}
        stopping={state.stopping}
        connected={state.conn === 'open'}
        error={state.lastError !== null && state.conn !== 'open' ? state.lastError : null}
        commands={commands}
        onSend={(text, images) => {
          // 以 `/` 开头的按命令派发（宿主那道闸会再判一次）；其余照旧当消息发。
          // 以前手机上打 `/compact` 会被当成普通消息喂给模型，模型只好回一句「不认识」。
          const command = commandToRun(text, commands)
          if (command !== null) {
            // 命令不收附件（宿主那条路只接一行文本）：与其把图悄悄吞掉，不如当场说清楚。
            if (images.length > 0) {
              setCardError('这条命令不接受附件，请先移除图片再发')
              return
            }
            void client.invoke<boolean>('runUiCommand', [command]).catch((cause: unknown) => {
              setCardError(cause instanceof Error ? cause.message : String(cause))
            })
            return
          }
          void client.submit(text, images.length > 0 ? images : undefined).catch((cause: unknown) => {
            setCardError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onUploadFile={(file) => client.upload(file).then((result) => result.path)}
        onInterrupt={() => {
          void client.interrupt().catch((cause: unknown) => {
            setCardError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
      />
    </div>
  )
}
