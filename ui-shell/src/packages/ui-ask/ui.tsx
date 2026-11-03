/**
 * 内置插件：侧栏旁问（2026-10-25）。
 *
 * 对标 dsh-btw 的语义：**只读的一次性问答**——基于当前上下文回答，不执行工具、不写主会话、
 * 不进会话列表。宿主侧是 `sideAsk`（core/side-ask.ts），这里只管界面。
 *
 * 四个入口，同一份状态：
 *   1. 会话区选中文字 → 浮出「问 AI」→ 开页签并带上引用；
 *   2. `Ctrl+Shift+K` → 开页签（有选区就一起带上）；
 *   3. 命令面板两条动作（打开旁问 / 就选中内容旁问）；
 *   4. 右侧栏「开始」页的「旁问」卡（壳的 `GUIDE_ENTRIES` 里那一条，开的是同一张页签）。
 *
 * 为什么不再留 `shell.ask.open` 事件：左侧栏那颗钮 2026-10-26 搬进右侧栏开始页之后，
 * 没人再发这个事件了；留着监听器就是死代码。
 *
 * 为什么挂在右侧栏而不是聊天气泡：旁问是「伴读」——正文是主语，旁问是按需展开的旁注。
 * 这也与 dsh-btw 的独立气泡一致（只是我们从输入框上方搬到了右侧栏，正文一根头发都不动）。
 *
 * @module dsc-ui-shell/plugins/ask
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ACTIONS_SERVICE,
  defineUiPlugin,
  IconClose,
  IconCopy,
  IconArrowUp,
  IconSpark,
  MarkdownView,
  openDockTab,
  registerDockTab,
  toastOk,
  useAskStream,
  useHostChannel,
  useHostSelector,
  useService,
  type ActionsHandle,
  type DockTabBodyProps,
  type HostSnapshot,
} from '@dsc/ui'
import { Select, humanErrorText } from '@dsc/ui-primitives'
import { anchorOf, normalizeSelection } from './select'
import {
  addBubble,
  appendAnswer,
  askSnapshot,
  patchBubble,
  removeBubble,
  requestAskOpen,
  pendingVersion,
  subscribeAsk,
  takePendingQuote,
  type AskBubble,
} from './store'

/** 宿主 `sideAsk` 的回包形状（与 contract.ts 的 SideAskView 一致）。 */
/** listModels 回来的一项（与 contract.ts 的 ModelChoiceView 同形，只取用得到的列）。 */
interface ModelChoice {
  value: string
  provider: string
  providerDisplayName: string
  model: string
}

/** 选中模型存哪：localStorage（跟窗口走，不进 ~/.dsc——它不是会话数据）。 */
const ASK_MODEL_KEY = 'dsc.ask.model'

interface SideAskView {
  text: string
  model: string
  ms: number
  stopped: boolean
}

/** 从快照读会话 id（还没连上时是 null → 用空串当桶名）。 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const id = (status as Record<string, unknown>)['sessionId']
  return typeof id === 'string' && id !== '' ? id : null
}

/** 读当前选区（快捷键与命令面板共用）：不在正文里或太短都返回 null。 */
function currentSelection(): string | null {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed) return null
  const node = selection.anchorNode
  const host = node === null ? null : node instanceof Element ? node : node.parentElement
  if (host === null || host.closest('.chat') === null) return null
  return normalizeSelection(selection.toString())
}

/** 打开页签；给了引用就一起带过去。 */
function openAsk(quote?: string): void {
  requestAskOpen(quote)
  openDockTab('ask')
}

export default defineUiPlugin({
  name: '旁问',
  apply(ui) {
    registerDockTab({
      kind: 'ask',
      label: '旁问',
      icon: <IconSpark size={13} />,
      component: AskTab,
      // 切页签只藏不卸：正在回答的那条不该被切走打断（答案回来时还要写进气泡）。
      keepMounted: true,
    })
    // 浮钮 / 快捷键 / 动作表都挂在 header 槽：它常驻（设置面板与命令面板也住这儿）。
    ui.slots.register('shell.header', { id: 'ask.triggers', order: 80 }, AskTriggers)
  },
})

/** 三个入口的常驻组件：浮钮画在这里，快捷键与动作表也在这里挂。 */
function AskTriggers(): ReactNode {
  const actions = useService<ActionsHandle>(ACTIONS_SERVICE)

  useEffect(() => {
    if (actions === undefined) return undefined
    return actions.register('ask', [
      {
        id: 'ask.open',
        label: '打开旁问',
        hint: '在右侧栏问一句，不动主会话',
        group: '旁问',
        keywords: ['btw', 'side', 'ask', '问', '旁问'],
        shortcut: 'Ctrl+Shift+K',
        run: () => {
          openAsk()
        },
      },
      {
        id: 'ask.selection',
        label: '就选中内容旁问',
        hint: '把正文里选中的文字带进旁问',
        group: '旁问',
        keywords: ['选中', 'selection', 'explain', '解释'],
        run: () => {
          const quote = currentSelection()
          if (quote === null) {
            openAsk()
            return
          }
          openAsk(quote)
        },
      },
    ])
  }, [actions])


  // Ctrl+Shift+K：避开 Ctrl+K（命令面板）与 Ctrl+P（文件）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      openAsk(currentSelection() ?? undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return <SelectionBubble />
}

/** 选区浮钮：在 `.chat` 里选中至少 4 个字，贴着选区右下角浮一颗「问 AI」。 */
function SelectionBubble(): ReactNode {
  const [pick, setPick] = useState<{ text: string; left: number; top: number } | null>(null)

  useEffect(() => {
    let timer = 0
    const read = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setPick(null)
        return
      }
      const range = selection.getRangeAt(0)
      const node = range.commonAncestorContainer
      const host = node instanceof Element ? node : node.parentElement
      if (host === null || host.closest('.chat') === null) {
        setPick(null)
        return
      }
      const text = normalizeSelection(selection.toString())
      if (text === null) {
        setPick(null)
        return
      }
      const box = range.getBoundingClientRect()
      const anchor = anchorOf(
        { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        { width: window.innerWidth, height: window.innerHeight },
      )
      setPick({ text, ...anchor })
    }
    // 等一帧再读：mouseup 时选区往往还没定下来（浏览器要处理完这次点击）。
    const later = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(read, 0)
    }
    const onDown = (event: MouseEvent): void => {
      // 点浮钮自己不算「重新选」：浮钮在 portal 里，mousedown 会先把选区清掉。
      if (event.target instanceof Element && event.target.closest('.ask-sel-btn') !== null) return
      later()
    }
    const onScroll = (): void => {
      setPick(null)
    }
    document.addEventListener('mouseup', onDown)
    document.addEventListener('keyup', later)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseup', onDown)
      document.removeEventListener('keyup', later)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  if (pick === null) return null
  return createPortal(
    <button
      type="button"
      className="ask-sel-btn"
      style={{ left: pick.left, top: pick.top }}
      // 按下时不让浏览器撤选区：否则 click 里读到的已经是空的。
      onMouseDown={(event) => {
        event.preventDefault()
      }}
      onClick={() => {
        openAsk(pick.text)
        setPick(null)
      }}
    >
      <IconSpark size={13} />
      问 AI
    </button>,
    document.body,
  )
}

/** 页签本体：问题输入 + 气泡列表。 */
function AskTab({ active }: DockTabBodyProps): ReactNode {
  const channel = useHostChannel()
  const sessionId = useHostSelector(readSessionId) ?? ''
  const bubbles = useSyncExternalStore(
    subscribeAsk,
    () => askSnapshot(sessionId),
    () => askSnapshot(sessionId),
  )
  const openVersion = useSyncExternalStore(subscribeAsk, pendingVersion, pendingVersion)
  const [question, setQuestion] = useState('')
  const [quote, setQuote] = useState('')
  const input = useRef<HTMLTextAreaElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  /** 这一条旁问用哪个模型：空串 = 跟随主会话当前路由。 */
  const [picked, setPicked] = useState<string>(() => window.localStorage.getItem(ASK_MODEL_KEY) ?? '')
  const [models, setModels] = useState<readonly ModelChoice[]>([])

  // 模型清单：进程内静态，挂载取一次就够（换端点后重启宿主）。
  useEffect(() => {
    void channel
      .invoke<ModelChoice[]>('listModels')
      .then((rows) => {
        setModels(Array.isArray(rows) ? rows : [])
      })
      .catch(() => undefined)
  }, [channel])

  // 流式增量：按票据往对应气泡尾部追加（最终答案由 invoke 的返回值覆盖一次，补齐可能丢的尾部）。
  useAskStream((chunk) => {
    appendAnswer(sessionId, chunk.id, chunk.delta)
  })

  // 新内容进来就贴底：旁问的回答通常比面板高，不跟着滚等于看不见。
  useEffect(() => {
    const element = list.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [bubbles])

  // 页签一活就把焦点给输入框（键盘用户接着就能打字）。
  useEffect(() => {
    if (active) input.current?.focus()
  }, [active])

  // 每次「请求打开」都带一份可能的引用：读走即清（不重复消费）。
  useEffect(() => {
    const pending = takePendingQuote()
    if (pending === null) return
    setQuote(pending)
    window.setTimeout(() => input.current?.focus(), 0)
  }, [openVersion])

  const send = (): void => {
    const text = question.trim()
    if (text === '') return
    const id = 'ask-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    const cited = quote
    // 选中的模型：从清单里找回 provider/model（value 是展示用的合成串）。
    const choice = models.find((item) => item.value === picked)
    addBubble(sessionId, { id, question: text, quote: cited, answer: '', status: 'running' })
    setQuestion('')
    setQuote('')
    void channel
      // 引用永远传字符串（空串 = 没引用）：通道的实参校验只允许「从尾部省略」，
      // 中间塞 undefined 会被拒。
      .invoke<SideAskView>('sideAsk', [text, cited, id, choice?.provider ?? '', choice?.model ?? ''])
      .then((result) => {
        patchBubble(sessionId, id, {
          answer: result.text,
          status: result.stopped ? 'stopped' : 'done',
          model: result.model,
          ms: result.ms,
        })
      })
      .catch((error: unknown) => {
        // 停放靠「已停止」：异步回来的结果不算错误（用户自己按的）。
        patchBubble(sessionId, id, { status: 'error', error: humanErrorText(error).text })
      })
  }

  return (
    <div className="ask">
      <div className="ask-list" ref={list}>
        {bubbles.length === 0 ? (
          <div className="ask-empty">
            <span className="ask-empty-icon">
              <IconSpark size={18} />
            </span>
            <p className="ask-empty-title">只回答，不动手</p>
            <p className="ask-empty-desc">
              在左边正文里选中一段文字，点浮出的「问 AI」；也可以直接在下面提问。
              旁问不会执行工具、不会写进主会话，答案只留在这个面板里。
            </p>
          </div>
        ) : (
          bubbles.map((bubble) => (
            <AskCard
              key={bubble.id}
              bubble={bubble}
              onStop={() => {
                void channel.invoke('sideAskCancel', [bubble.id])
              }}
              onRemove={() => {
                removeBubble(sessionId, bubble.id)
              }}
            />
          ))
        )}
      </div>
      <div className="ask-composer">
        <div className="ask-model">
          <span className="ask-model-label">模型</span>
          <Select
            value={picked}
            ariaLabel="旁问使用的模型"
            className="ask-model-select"
            options={[
              { value: '', label: '跟随主会话' },
              ...models.map((item) => ({ value: item.value, label: item.providerDisplayName + ' · ' + item.model })),
            ]}
            onPick={(value) => {
              setPicked(value)
              window.localStorage.setItem(ASK_MODEL_KEY, value)
            }}
          />
        </div>
        {quote === '' ? null : (
          <div className="ask-quote-chip">
            <span className="ask-quote-text">{quote}</span>
            <button
              type="button"
              className="ask-quote-drop"
              aria-label="去掉这段引用"
              onClick={() => {
                setQuote('')
              }}
            >
              <IconClose size={12} />
            </button>
          </div>
        )}
        <textarea
          ref={input}
          className="ask-input"
          rows={2}
          value={question}
          placeholder="问点什么（Enter 发送，Shift+Enter 换行）"
          aria-label="旁问的问题"
          onChange={(event) => {
            setQuestion(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <button
          type="button"
          className="ask-send"
          disabled={question.trim() === ''}
          aria-label="发送旁问"
          onClick={send}
        >
          <IconArrowUp size={14} />
        </button>
      </div>
    </div>
  )
}

/** 一条旁问：引用（折叠）+ 问题 + 答案 + 页脚（模型 / 耗时 / 复制 / 删除）。 */
function AskCard(props: {
  bubble: AskBubble
  onStop: () => void
  onRemove: () => void
}): ReactNode {
  const { bubble } = props
  return (
    <article className="ask-bubble" data-status={bubble.status}>
      {bubble.quote === '' ? null : <blockquote className="ask-quote">{bubble.quote}</blockquote>}
      <p className="ask-q">{bubble.question}</p>
      {bubble.status === 'error' ? (
        <p className="ask-error">{bubble.error}</p>
      ) : bubble.status === 'running' && bubble.answer === '' ? (
        // 还没吐第一个字：三点呼吸占位。
        <div className="ask-typing" role="status" aria-label="正在回答">
          <span />
          <span />
          <span />
        </div>
      ) : (
        // 流式：已经到的正文先画出来，末尾给一个闪动的光标；收尾后光标自己消失。
        <div className="ask-a">
          <MarkdownView text={bubble.answer} path="" />
          {bubble.status === 'running' ? <span className="ask-caret" aria-hidden="true" /> : null}
        </div>
      )}
      <div className="ask-foot">
        <span className="ask-meta">
          {bubble.status === 'running'
            ? '正在回答…'
            : bubble.status === 'stopped'
              ? '已停止'
              : bubble.model === undefined
                ? ''
                : bubble.model + (bubble.ms === undefined ? '' : ' · ' + (bubble.ms / 1000).toFixed(1) + 's')}
        </span>
        {bubble.status === 'running' ? (
          <button type="button" className="ask-stop" onClick={props.onStop}>
            停止
          </button>
        ) : null}
        <button
          type="button"
          className="ask-icon-btn"
          aria-label="复制这条答案"
          disabled={bubble.answer === ''}
          onClick={() => {
            void navigator.clipboard.writeText(bubble.answer).then(
              () => {
                toastOk('答案已复制')
              },
              () => {
                toastOk('复制失败，请手动选中')
              },
            )
          }}
        >
          <IconCopy size={13} />
        </button>
        <button type="button" className="ask-icon-btn" aria-label="删掉这条" onClick={props.onRemove}>
          <IconClose size={13} />
        </button>
      </div>
    </article>
  )
}
