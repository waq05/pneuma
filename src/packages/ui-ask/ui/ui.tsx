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
 *   4. 右侧栏「开始」页的「旁问」卡（**本插件报名页签时一并交上去的**，
 *      见下面的 `guide` 字段；插件停用后壳里不会留下这张卡）。
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
  createT,
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
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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
  name: t('ask.plugin.name'),
  apply(ui) {
    // 页签元数据与「开始」页入口卡一起报：卡归插件说，壳只负责画。旁问在壳里
    // 硬编码过一张卡与一档 chip 元数据，停用插件后那两处还留着（2026-11-06 报障）。
    const offTab = registerDockTab({
      kind: 'ask',
      label: t('ask.tab.label'),
      icon: <IconSpark size={13} />,
      component: AskTab,
      // 切页签只藏不卸：正在回答的那条不该被切走打断（答案回来时还要写进气泡）。
      keepMounted: true,
      guide: {
        title: t('ask.tab.label'),
        description: t('ask.guide.desc'),
        tone: 'tone-ask',
        shortcut: 'Ctrl + Shift + K',
        icon: <IconSpark size={17} />,
      },
    })
    // 浮钮 / 快捷键 / 动作表都挂在 header 槽：它常驻（设置面板与命令面板也住这儿）。
    // 槽位登记的回收归装载器的账本（cordis 的 effect），这里只把页签报名交回去：
    // 停用后 kind 元数据、开始页入口卡、已经开着的旁问页签一起消失。
    ui.slots.register('shell.header', { id: 'ask.triggers', order: 80 }, AskTriggers)
    return offTab
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
        label: t('ask.action.open'),
        hint: t('ask.action.openHint'),
        group: t('ask.action.group'),
        keywords: ['btw', 'side', 'ask', '问', '旁问'], // i18n-keep 搜索关键词：用户按中文输入匹配这条动作，翻译后中文就搜不到了
        shortcut: 'Ctrl+Shift+K',
        run: () => {
          openAsk()
        },
      },
      {
        id: 'ask.selection',
        label: t('ask.action.selection'),
        hint: t('ask.action.selectionHint'),
        group: t('ask.action.group'),
        keywords: ['选中', 'selection', 'explain', '解释'], // i18n-keep 搜索关键词：用户按中文输入匹配这条动作，翻译后中文就搜不到了
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
      {t('ask.selectionBubble')}
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
            <p className="ask-empty-title">{t('ask.empty.title')}</p>
            <p className="ask-empty-desc">{t('ask.empty.desc')}</p>
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
          <span className="ask-model-label">{t('ask.model.label')}</span>
          <Select
            value={picked}
            ariaLabel={t('ask.model.aria')}
            className="ask-model-select"
            options={[
              { value: '', label: t('ask.model.follow') },
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
              aria-label={t('ask.quote.removeAria')}
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
          placeholder={t('ask.input.placeholder')}
          aria-label={t('ask.input.aria')}
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
          aria-label={t('ask.send.aria')}
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
        <div className="ask-typing" role="status" aria-label={t('ask.typing.aria')}>
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
            ? t('ask.meta.running')
            : bubble.status === 'stopped'
              ? t('ask.meta.stopped')
              : bubble.model === undefined
                ? ''
                : bubble.model + (bubble.ms === undefined ? '' : ' · ' + (bubble.ms / 1000).toFixed(1) + 's')}
        </span>
        {bubble.status === 'running' ? (
          <button type="button" className="ask-stop" onClick={props.onStop}>
            {t('ask.stop')}
          </button>
        ) : null}
        <button
          type="button"
          className="ask-icon-btn"
          aria-label={t('ask.copy.aria')}
          disabled={bubble.answer === ''}
          onClick={() => {
            void navigator.clipboard.writeText(bubble.answer).then(
              () => {
                toastOk(t('ask.copy.ok'))
              },
              () => {
                toastOk(t('ask.copy.failed'))
              },
            )
          }}
        >
          <IconCopy size={13} />
        </button>
        <button type="button" className="ask-icon-btn" aria-label={t('ask.remove.aria')} onClick={props.onRemove}>
          <IconClose size={13} />
        </button>
      </div>
    </article>
  )
}
