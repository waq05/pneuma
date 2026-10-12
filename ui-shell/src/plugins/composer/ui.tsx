/**
 * 内置插件：输入区（对照旧桌面界面 `Composer.tsx` + `queue-dock.tsx`）。
 *
 * 一个插件注册两个条目，因为旧界面里它们本来就是兄弟节点、只是上下相邻：
 *   - `composer.box`（order 50）：输入框 + 底栏旋钮 + 发送/打断；
 *   - `composer.queue`（order 60）：排队消息条，排在输入框**下面**。
 * 壳把槽条目渲染成 `display:contents`，所以这两块在布局上就是 `.composer-zone` 的直接子节点。
 * 但那一层对**选择器**不透明：`.composer-zone > *` 那条「与正文同宽」（`legacy/views.css:2165`）
 * 打在槽条目上，`max-width` 与 `margin: auto` 都不生效——同一条规则由壳在 `styles.css` 里
 * 按「槽条目里面的元素」补了一遍。改输入区宽度要改那里。
 *
 * 三处与旧界面不同的地方，都是「宿主侧没有这条路」而不是「样式没对上」：
 *
 *   1. **权限模式旋钮的写路径走原生桥**：宿主刻意没把 `setPolicy` 放进界面通道白名单
 *      （见 `src/core/ui-methods.ts` 的 `UI_EXCLUDED`：审批策略是安全闸门本身），但旧界面
 *      的输入框里本来就有这根能切的旋钮，壳不能比旧界面少一样东西——所以写口开在原生桥
 *      （`NATIVE_OPS.setPolicy`，与 `saveProvider` 那三件同一先例：只对装了 preload 的
 *      桌面窗口开放）。桥不在（浏览器页签 / 远程页面）时点选项给一句明确的话，不静默。
 *   2. **`/` 指令当场拦下**：`runCommand` 同样不在白名单里。旧界面把 `/` 开头的文本
 *      交给命令注册表，壳这边交不了——照旧发出去会变成一条「以斜杠开头」的用户消息
 *      喂给模型，那比明确拒绝更糟。
 *   3. **贴图这一版还不支持**：界面的 POST 请求体上限之下，单张图只能有 32KB
 *      （`UI_ARG_SPECS` 的 `MAX_IMAGE`），普通截图压到那个档位已经看不清了；所以贴图与
 *      拖文件都给一句明确的话，而不是静默吞掉。
 *
 * 三根旋钮的清单**一律从快照的 `surfaces` 读**（`surfaces.policy` / `surfaces.preset` /
 * `listModels`），不在壳里抄一份档位表——旧界面 `Composer.tsx` 也是这么接 `props.policy`
 * 与 `props.preset` 的（:74-76）。
 *
 * 样式与 class 名照抄旧版（`ui-shell/src/legacy/views.css`，行号同旧 `styles.css`）：
 * `.composer` 2225、`.composer-bar` 2259、`.bar-left/.bar-right` 2266/2301、`.model-anchor`
 * 2309、`.model-btn` 2314、`.model-pop` 2347、`.effort-row/.effort-btn` 2376-2408、
 * `.model-list/.pop-group/.pop-item` 2410-2464、`.send-btn` 2468、`.queue-dock` 2519 起。
 *
 * @module dsc-ui-shell/plugins/composer
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
/** DOM 原生键盘事件（`window.addEventListener` 用；React 的 KeyboardEvent 是另一个类型）。 */
type WindowKeyboardEvent = globalThis.KeyboardEvent
import { IconArrowUp, IconCheck, IconChevronDown, IconClose, IconEdit, IconLayers, IconQueue, IconShield, IconStop, IconTrash } from '@dsc/ui'
import {
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type ApprovalPolicy,
  type EffortLevel,
  type HostSnapshot,
  type ModelChoiceView,
  type PolicySurface,
  type PresetSurface,
  type PresetView,
  type QueuedMessageView,
  type TierOption,
} from '@dsc/ui'
import { useMention } from './mention'

/** 输入框自动增高的上限（旧界面同一个值：200px）。 */
const MAX_INPUT_HEIGHT = 200
/** 排队消息摘要的字数上限（旧界面的 PREVIEW_CHARS）。 */
const PREVIEW_CHARS = 200
/** 本机历史输入留多少条（旧界面用会话历史；壳这边先本地记一份）。 */
const HISTORY_LIMIT = 50

/** 档位按钮的兜底清单：模型的思考档位拿不到时用它。 */
const EFFORT_FALLBACK: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']

/** 档位按钮文案（与宿主 `EffortLevel` 一一对应）。 */
const EFFORT_LABEL: Readonly<Record<EffortLevel, string>> = {
  default: '默认',
  off: '关闭',
  low: '低',
  high: '高',
  max: '最高',
}

/** 权限模式的四档中文名：只在快照里那份清单缺席时兜底（正常一律用 `options[].label`）。 */
const POLICY_LABEL: Readonly<Record<string, string>> = {
  readonly: '只读',
  'auto-edit': '自动编辑',
  'full-access': '完全放行',
  'ai-review': 'AI 复核',
}

/** 四档的机器值（与 `ApprovalPolicy` 同一张表；用来收窄线上来的值）。 */
const POLICY_IDS: ReadonlySet<string> = new Set(Object.keys(POLICY_LABEL))

/** 权限模式投影缺席时的兜底（空清单：菜单里会说「清单没取到」，不假装有四档）。 */
const EMPTY_POLICY: PolicySurface = { current: 'readonly', options: [] }
/** 模式（预设）投影缺席时的兜底。 */
const EMPTY_PRESET: PresetSurface = { current: '', defaultName: '', options: [], droppable: [] }

export default defineUiPlugin({
  name: '输入区',
  apply(ui) {
    // order 50 = 排在各种卡（审批/提问/计划，order 10-40）下面、排队条（60）上面。
    ui.slots.register('shell.composer', { id: 'composer.box', order: 50 }, ComposerBox)
    ui.slots.register('shell.composer', { id: 'composer.queue', order: 60 }, QueueDock)
  },
})

function ComposerBox(): ReactNode {
  const channel = useHostChannel()
  const turnState = useHostSelector(readTurnState)
  const blocked = useHostSelector(readHasApproval)
  const queuedCount = useHostSelector(readQueuedCount)
  const policy = useHostSelector(readPolicySurface, samePolicySurface)
  const preset = useHostSelector(readPresetSurface, samePresetSurface)
  const model = useHostSelector(readModel)
  const effort = useHostSelector(readEffort)
  const draftKey = useHostSelector(readSessionPath)

  const [text, setText] = useState('')
  const [fault, setFault] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<readonly ModelChoiceView[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  // 权限模式与模式（预设）两根旋钮各自的浮层：三者互斥（开一根把另两根收掉，旧界面同款）。
  const [policyOpen, setPolicyOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  // Esc 关模型浮层（与遮罩点击同效；设置面板、确认框各自也拦 Esc，谁开着归谁）。
  useEffect(() => {
    if (!panelOpen) return undefined
    const onKey = (event: WindowKeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen])
  const area = useRef<HTMLTextAreaElement | null>(null)
  const history = useRef<string[]>([])
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  /** 每会话一份草稿（正文 + 本机历史），切会话时整份换入换出。 */
  const drafts = useRef(new Map<string, { value: string; history: string[] }>())
  const draftKeyRef = useRef(draftKey)

  const working = turnState !== 'idle'

  /**
   * 换会话时换草稿（对照旧界面 `Composer.tsx` 的 `draftsRef`）。
   *
   * 为什么必须有：组件不随会话重挂，`text` 是单个 state。不换的话，在会话 A 里打了一半的
   * 话会跟着你进会话 B，回车就发错了会话——这是会真丢事的错，不只是显示问题。
   *
   * 游标一律归零：换了一份历史，上下键从头开始。
   */
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return
    drafts.current.set(draftKeyRef.current, { value: text, history: history.current })
    draftKeyRef.current = draftKey
    const next = drafts.current.get(draftKey) ?? { value: '', history: [] }
    setText(next.value)
    history.current = next.history
    setHistoryAt(null)
  }, [draftKey, text])

  // 输入框跟着内容长高，封顶 200px（超出在框内滚）。
  useEffect(() => {
    const node = area.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${String(Math.min(node.scrollHeight, MAX_INPUT_HEIGHT))}px`
  }, [text])

  // 模型清单是进程内静态数据，挂载时取一次就够。
  useEffect(() => {
    let alive = true
    void channel
      .invoke<ModelChoiceView[]>('listModels')
      .then((list) => {
        if (alive) setModels(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        // 取不到就不画模型菜单（旋钮退化成只显示当前模型名），不影响发消息。
      })
    return () => {
      alive = false
    }
  }, [channel])

  /**
   * 提交一条消息。
   *
   * 插话（Ctrl+Enter）分两步，照旧界面 `App.tsx:553` 的口径：先把消息按普通路径提交，
   * 再让宿主把「队尾那一条」提到队首并打断当前回合。下标按提交那一刻队列的长度算——
   * 新的一条必然排在队尾，而队伍只会从尾巴长出来，所以这个下标在两步之间不会漂。
   */
  const send = (steer: boolean): void => {
    const value = text.trim()
    if (value === '' || blocked || sending) return
    if (value.startsWith('/')) {
      // 斜杠指令里只有 /compact 有专门的通道方法（compress 整个会话历史），就地执行；
      // 其余指令（runCommand 不在白名单）保持拦截说明——那是安全设计不是缺口。
      if (value === '/compact') {
        setSending(true)
        setFault(null)
        setText('')
        void channel
          .invoke('compact', [])
          .then(() => toastOk('已开始压缩会话历史'))
          .catch((reason: unknown) => {
            setFault(`压缩失败：${reason instanceof Error ? reason.message : String(reason)}`)
            setText(value)
          })
          .finally(() => setSending(false))
        return
      }
      setFault('“/” 开头的指令这条路还没接到界面通道，请用桌面端或终端执行（/compact 除外）')
      return
    }
    const steerIndex = steer && working ? queuedCount : null
    setSending(true)
    setFault(null)
    void (async () => {
      try {
        await channel.invoke('submit', [value])
        history.current = [...history.current.filter((item) => item !== value), value].slice(-HISTORY_LIMIT)
        setHistoryAt(null)
        // 新会话要等首条消息落盘才会出现在侧栏里：提交回来自会已经写盘，这时刷一次才有效。
        void channel.invoke('refreshSessions').catch(() => undefined)
        if (steerIndex !== null) {
          const done = await channel.invoke<boolean>('steerQueued', [steerIndex])
          if (done !== true) setFault('插话没赶上：这一轮刚结束，这条消息会自己发出去')
        }
        setText('')
      } catch (reason) {
        setFault(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setSending(false)
      }
    })()
  }

  const interrupt = (): void => {
    setFault(null)
    void channel.invoke('interrupt').catch((reason: unknown) => {
      setFault(reason instanceof Error ? reason.message : String(reason))
    })
  }

  /**
   * 切权限模式：写口在原生桥（界面通道刻意排除 `setPolicy`，见 `UI_EXCLUDED`），
   * 与 `saveProvider` 那三件同一先例。桥不在时（浏览器页签 / 远程壳）给一句明确的话——
   * 那颗旋钮照旧画出来，只是点下去会说清为什么这一档改不了。
   */
  const choosePolicy = (next: ApprovalPolicy, label: string): void => {
    setPolicyOpen(false)
    setFault(null)
    const native = getHostNative()
    if (!native.available) {
      setFault('切权限模式这条口子只在桌面窗口里开（浏览器页签与远程页面够不着），请用桌面端或终端改')
      return
    }
    void native
      .invoke('setPolicy', [next])
      .then(() => {
        toastOk(`权限模式已切到「${label}」`)
      })
      .catch((reason: unknown) => {
        setFault(`切权限模式失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  /**
   * 切模式（预设）：走界面通道的 `usePreset`（它在放行面里——切模式不碰安全闸门，
   * 只换提示词与工具白名单）。宿主回执后立刻刷一次会话性子面跟着变。
   */
  const choosePreset = (name: string, label: string): void => {
    setPresetOpen(false)
    setFault(null)
    void channel
      .invoke('usePreset', [name])
      .then(() => {
        toastOk(`已切到「${label}」模式`)
      })
      .catch((reason: unknown) => {
        toastErr(`切换失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  /** 上下键翻本机历史；翻到底回到草稿。 */
  /** @ 文件提及补全：track 跟输入走，pick 把候选替换进文本并落光标。 */
  const mention = useMention({
    channel,
    area,
    apply: (next, caret) => {
      setText(next)
      // 光标落位要等 React 把新值刷进 DOM：requestAnimationFrame 一拍后设。
      window.requestAnimationFrame(() => {
        area.current?.setSelectionRange(caret, caret)
      })
    },
  })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // @ 文件补全面板开着时，↑↓/Tab/Enter/Esc 先归它（不进历史、不发送）。
    if (mention.open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        mention.move(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        mention.pick()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        mention.close()
        return
      }
    }
    if (event.key === 'Enter') {
      if (event.shiftKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      send(event.ctrlKey || event.metaKey)
      return
    }
    if (event.key === 'ArrowUp' && (text === '' || historyAt !== null) && history.current.length > 0) {
      event.preventDefault()
      const next = historyAt === null ? history.current.length - 1 : Math.max(0, historyAt - 1)
      setHistoryAt(next)
      setText(history.current[next] ?? '')
      return
    }
    if (event.key === 'ArrowDown' && historyAt !== null) {
      event.preventDefault()
      const next = historyAt + 1
      if (next >= history.current.length) {
        setHistoryAt(null)
        setText('')
      } else {
        setHistoryAt(next)
        setText(history.current[next] ?? '')
      }
    }
  }

  /** 输入框每次变化都问一句：光标前面是不是一个 @ 文件提及（是就把面板亮出来）。 */
  const onTextChange = (value: string, caret: number): void => {
    setText(value)
    setHistoryAt(null)
    mention.track(value, caret)
  }

  const sendable = text.trim() !== ''
  const queueing = working && sendable
  /** 当前档位在清单里的那一项（拿它的 label / hint；清单缺了退回下面那两张兜底表）。 */
  const policyOption = policy.options.find((item) => item.id === policy.current)
  const presetOption = preset.options.find((item) => item.name === preset.current)
  const current = models.find((choice) => choice.model === model || choice.value === model)
  const effortLevels = current === undefined ? EFFORT_FALLBACK : current.thinkingLevels
  const placeholder = blocked
    ? '等待审批…'
    : working
      ? '回合进行中：回车把消息排进队里，Ctrl+Enter 插话（打断当前输出）'
      : '发消息，@ 引用文件，回车发送，Ctrl+Enter 插话'

  return (
    <div
      className="composer"
      style={{ marginTop: 10 }}
      onPaste={(event) => {
        if (event.clipboardData.files.length === 0) return
        setFault('贴图这一版还不支持：界面通道的单图上限只有 32KB，普通截图压到那个档位已经看不清了')
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return
        event.preventDefault()
        setFault('拖文件进来这一版还不支持：界面通道目前只能发文本')
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
    >
      <textarea
        ref={area}
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={blocked}
        aria-label="消息输入框"
        onChange={(event) => {
          onTextChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
        }}
        onKeyDown={onKeyDown}
      />

      {/* @ 文件提及的候选面板：贴在输入框上方（textarea 是 relative 容器的兄弟）。 */}
      {mention.open ? (
        <div className="mention-pop" role="listbox" aria-label="文件提及候选">
          {mention.loading ? (
            <div className="mention-item" data-loading="1">
              正在读取工作区文件…
            </div>
          ) : mention.items.length === 0 ? (
            <div className="mention-item" data-empty="1">
              没有匹配的文件
            </div>
          ) : (
            mention.items.map((path, index) => (
              <button
                type="button"
                key={path}
                role="option"
                aria-selected={index === mention.at}
                className={`mention-item${index === mention.at ? ' on' : ''}`}
                title={path}
                onMouseDown={(event) => {
                  // mousedown 而不是 click：抢在 textarea 失焦之前把候选插进去。
                  event.preventDefault()
                  mention.pick()
                }}
              >
                {path}
              </button>
            ))
          )}
          <div className="mention-hint">↑↓ 选 · Tab/Enter 补全 · Esc 关闭</div>
        </div>
      ) : null}

      <div className="composer-bar">
        <div className="bar-left">
          {/* 「+」钮（旧界面同款）：正文为空时点击插入 "/"，把用户带到指令清单的门口。 */}
          <button
            type="button"
            className="icon-btn"
            data-tip="插入指令（/）"
            aria-label="插入指令"
            onClick={() => {
              if (text.trim() !== '') return
              setText('/')
              window.requestAnimationFrame(() => {
                area.current?.focus()
                area.current?.setSelectionRange(1, 1)
              })
            }}
          >
            +
          </button>
          {/* 权限模式（旧界面同款：一颗能切的旋钮 + 四档菜单）。清单来自快照 surfaces.policy，
              写口走原生桥（见 choosePolicy 的注释）。 */}
          <div className="model-anchor">
            <button
              type="button"
              className={`model-btn${policyOpen ? ' open' : ''}`}
              data-tip={policyOption?.hint ?? '权限模式：决定写与执行类操作要不要问你'}
              aria-haspopup="menu"
              aria-expanded={policyOpen}
              onClick={() => {
                setPolicyOpen((open) => !open)
                setPresetOpen(false)
                setPanelOpen(false)
              }}
            >
              <IconShield size={13} />
              {policyOption?.label ?? POLICY_LABEL[policy.current] ?? policy.current}
              <IconChevronDown size={12} />
            </button>
            {policyOpen ? (
              <>
                <div
                  className="pop-mask"
                  onClick={() => {
                    setPolicyOpen(false)
                  }}
                />
                <div className="model-pop policy-pop" role="menu" aria-label="权限模式">
                  <div className="pop-label">权限模式</div>
                  {policy.options.length === 0 ? (
                    <div className="pop-item">
                      <span className="name">清单没取到</span>
                    </div>
                  ) : (
                    policy.options.map((item) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === policy.current}
                        key={item.id}
                        className={`pop-item${item.id === policy.current ? ' on' : ''}`}
                        title={item.hint}
                        disabled={item.id === policy.current}
                        onClick={() => {
                          choosePolicy(item.id, item.label)
                        }}
                      >
                        <span className="name">{item.label}</span>
                        {item.id === policy.current ? <IconCheck size={14} className="check" /> : null}
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </div>
          {/* 模式（预设）旋钮：与权限旋钮并排。清单同样来自快照（surfaces.preset.options），
              点选即 usePreset；「默认」标跟随 preset.defaultName（新会话用的那一档）。 */}
          <div className="model-anchor">
            <button
              type="button"
              className={`model-btn${presetOpen ? ' open' : ''}`}
              data-tip={presetOption?.problem ?? presetOption?.description ?? '模式：模型是谁、手上有什么、被叮嘱了什么'}
              aria-haspopup="menu"
              aria-expanded={presetOpen}
              onClick={() => {
                setPresetOpen((open) => !open)
                setPolicyOpen(false)
                setPanelOpen(false)
              }}
            >
              <IconLayers size={13} />
              {presetOption?.label ?? preset.current}
              <IconChevronDown size={12} />
            </button>
            {presetOpen ? (
              <>
                <div
                  className="pop-mask"
                  onClick={() => {
                    setPresetOpen(false)
                  }}
                />
                <div className="model-pop preset-pop" role="menu" aria-label="模式">
                  <div className="pop-label">
                    模式
                    <span className="pop-note">新建/编辑：设置 → 模式</span>
                  </div>
                  {preset.options.length === 0 ? (
                    <div className="pop-item">
                      <span className="name">清单没取到</span>
                    </div>
                  ) : (
                    preset.options.map((item) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.name === preset.current}
                        key={item.name}
                        className={`pop-item${item.name === preset.current ? ' on' : ''}`}
                        title={item.problem ?? item.description}
                        disabled={item.name === preset.current}
                        onClick={() => {
                          choosePreset(item.name, item.label)
                        }}
                      >
                        <span className="name">
                          {item.label}
                          {item.name === preset.defaultName && <span className="pop-badge">默认</span>}
                          {item.problem !== undefined && <span className="pop-badge warn">有问题</span>}
                        </span>
                        {item.name === preset.current ? <IconCheck size={14} className="check" /> : null}
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="bar-right">
          <div className="model-anchor">
            <button
              type="button"
              className={`model-btn${panelOpen ? ' open' : ''}`}
              data-tip="模型与思考强度"
              aria-haspopup="menu"
              aria-expanded={panelOpen}
              onClick={() => {
                setPanelOpen((open) => !open)
                setPolicyOpen(false)
                setPresetOpen(false)
              }}
            >
              <span className="model-name">{model === '' ? '未知模型' : model}</span>
              <IconChevronDown size={13} />
            </button>
            {panelOpen ? (
              <>
                <div
                  className="pop-mask"
                  onClick={() => {
                    setPanelOpen(false)
                  }}
                />
                <div className="model-pop">
                  <div className="pop-label">
                    思考强度
                    {current === undefined || current.thinkingLevels.length === 0 ? (
                      <span className="pop-note">这个模型只声明了这些档位</span>
                    ) : null}
                  </div>
                  <div className="effort-row">
                    {effortLevels.map((level) => (
                      <button
                        type="button"
                        className={`effort-btn${level === effort ? ' on' : ''}`}
                        key={level}
                        onClick={() => {
                          setFault(null)
                          void channel.invoke('setEffort', [level]).catch((reason: unknown) => {
                            setFault(reason instanceof Error ? reason.message : String(reason))
                          })
                        }}
                      >
                        {EFFORT_LABEL[level] ?? level}
                      </button>
                    ))}
                  </div>
                  <div className="pop-label">模型</div>
                  <div className="model-list">
                    {models.length === 0 ? (
                      <div className="pop-item">
                        <span className="name">{model === '' ? '清单没取到' : model}</span>
                      </div>
                    ) : (
                      groupByProvider(models).map(([provider, list]) => (
                        <div key={provider}>
                          <div className="pop-group">{provider}</div>
                          {list.map((choice) => (
                            <button
                              type="button"
                              className={`pop-item${choice.value === model ? ' on' : ''}`}
                              key={choice.value}
                              data-tip={choice.description}
                              onClick={() => {
                                setFault(null)
                                void channel.invoke('setModel', [choice.value]).catch((reason: unknown) => {
                                  setFault(reason instanceof Error ? reason.message : String(reason))
                                })
                              }}
                            >
                              <span className="name">{choice.model}</span>
                              {choice.modalities.includes('image') ? <span className="pop-badge">图</span> : null}
                              {choice.modalities.includes('video') ? <span className="pop-badge">视频</span> : null}
                              <span className="ctx">{Math.round(choice.contextWindow / 1000)}k</span>
                              {choice.value === model ? <IconCheck size={14} className="check" /> : null}
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>

          {working ? (
            <button
              type="button"
              className={`send-btn stop${queueing ? ' dim' : ''}`}
              aria-label="打断当前回合"
              data-tip="打断当前回合"
              onClick={interrupt}
            >
              <IconStop size={16} />
            </button>
          ) : null}
          {!working || queueing ? (
            <button
              type="button"
              className="send-btn"
              aria-label={working ? '排队发送' : '发送'}
              disabled={!sendable || blocked || sending}
              data-tip={
                working
                  ? '排队发送：这一轮跑完立刻发出（Ctrl+Enter 插话：打断当前输出先发这条）'
                  : '发送，快捷键 Enter'
              }
              onClick={() => {
                send(false)
              }}
            >
              <IconArrowUp size={16} />
            </button>
          ) : null}
        </div>
      </div>

      {fault === null ? null : <div className="shell-composer-fault">{fault}</div>}
    </div>
  )
}

/** 模型清单按端点分组（面板里同厂商排在一起，与旧界面一致）。 */
function groupByProvider(models: readonly ModelChoiceView[]): Array<[string, ModelChoiceView[]]> {
  const groups = new Map<string, ModelChoiceView[]>()
  for (const choice of models) {
    const list = groups.get(choice.provider)
    if (list === undefined) groups.set(choice.provider, [choice])
    else list.push(choice)
  }
  return [...groups.entries()]
}

/** 排队消息摘要：压成一行、截到 200 字（全文挂在悬浮说明上）。 */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
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
function QueueDock(): ReactNode {
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

/** 排队消息的相等判断：内容没变就不重渲染（宿主每帧都可能给新数组）。 */
function sameQueued(left: readonly QueuedMessageView[], right: readonly QueuedMessageView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    if (other === undefined) return false
    return (
      item.index === other.index &&
      item.text === other.text &&
      (item.images?.join('|') ?? '') === (other.images?.join('|') ?? '')
    )
  })
}

function readTurnState(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'idle'
  const value = (status as Record<string, unknown>)['turnState']
  return typeof value === 'string' ? value : 'idle'
}

function readModel(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['model']
  return typeof value === 'string' ? value : ''
}

function readEffort(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'default'
  const value = (status as Record<string, unknown>)['effort']
  return typeof value === 'string' ? value : 'default'
}

/** 有挂起的审批时输入区整体禁用（旧界面把 `pendingApproval !== null` 传成 disabled）。 */
function readHasApproval(snapshot: HostSnapshot | null): boolean {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return false
  const pending = (surfaces as Record<string, unknown>)['pendingApproval']
  return pending !== null && pending !== undefined
}

/** 会话身份（草稿按它分槽）。用 `sessionPath` 而不是 `sessionId`：路径是壳里其它地方
 *  统一的会话标识，同一条会话重开还是同一把钥匙，草稿不会因为换了进程就丢。 */
function readSessionPath(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const path = (status as Record<string, unknown>)['sessionPath']
  return typeof path === 'string' ? path : ''
}

/**
 * 权限模式投影（当前档 + 四档清单）。清单**从快照读**，不在壳里抄一份：档位表在
 * approval 插件里，抄一份就会漂。
 */
function readPolicySurface(snapshot: HostSnapshot | null): PolicySurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_POLICY
  const policy = (surfaces as Record<string, unknown>)['policy']
  if (typeof policy !== 'object' || policy === null) return EMPTY_POLICY
  const record = policy as Record<string, unknown>
  const current = record['current']
  const options = record['options']
  if (typeof current !== 'string' || !Array.isArray(options)) return EMPTY_POLICY
  // 线上的值收窄成四档：宿主那侧的真源是 `ApprovalPolicy`，这里只需要「是那四档之一」
  // 才认；认不出就当清单缺席（旋钮退回兜底表），不把脏值原样透给写口。
  if (!POLICY_IDS.has(current)) return EMPTY_POLICY
  return { current: current as ApprovalPolicy, options: options as TierOption<ApprovalPolicy>[] }
}

/**
 * 两份投影的相等判断：快照**每帧都换引用**，不给判断就会每帧重画输入区。
 *
 * 逐字段比而不是比引用：清单是四档或几个模式，比一遍比让 React 重画便宜得多
 * （与 `sameQueued` 同一套写法）。
 */
function samePolicySurface(left: PolicySurface, right: PolicySurface): boolean {
  if (left === right) return true
  if (left.current !== right.current || left.options.length !== right.options.length) return false
  return left.options.every((item, index) => {
    const other = right.options[index]
    return other !== undefined && item.id === other.id && item.label === other.label && item.hint === other.hint
  })
}

/** 模式（预设）投影（当前档 + 新会话默认 + 全部可选），同样从快照读。 */
function readPresetSurface(snapshot: HostSnapshot | null): PresetSurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_PRESET
  const preset = (surfaces as Record<string, unknown>)['preset']
  if (typeof preset !== 'object' || preset === null) return EMPTY_PRESET
  const record = preset as Record<string, unknown>
  const current = record['current']
  const options = record['options']
  if (typeof current !== 'string' || !Array.isArray(options)) return EMPTY_PRESET
  return {
    current,
    defaultName: typeof record['defaultName'] === 'string' ? record['defaultName'] : '',
    options: options as PresetView[],
    droppable: Array.isArray(record['droppable']) ? record['droppable'] : [],
  }
}

/** 模式投影的相等判断（比的是菜单真正用到的四个字段）。 */
function samePresetSurface(left: PresetSurface, right: PresetSurface): boolean {
  if (left === right) return true
  if (left.current !== right.current || left.defaultName !== right.defaultName) return false
  if (left.options.length !== right.options.length) return false
  return left.options.every((item, index) => {
    const other = right.options[index]
    return (
      other !== undefined &&
      item.name === other.name &&
      item.label === other.label &&
      item.description === other.description &&
      item.problem === other.problem
    )
  })
}

function readQueuedCount(snapshot: HostSnapshot | null): number {
  const value = snapshot?.['queued']
  return Array.isArray(value) ? value.length : 0
}

function readQueued(snapshot: HostSnapshot | null): readonly QueuedMessageView[] {
  const value = snapshot?.['queued']
  return Array.isArray(value) ? (value as QueuedMessageView[]) : EMPTY_QUEUE
}

/** 空队列常量：引用稳定，选择器（默认比较）才拦得住重渲染。 */
const EMPTY_QUEUE: readonly QueuedMessageView[] = Object.freeze([])
