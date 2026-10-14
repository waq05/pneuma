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
 *   1. **权限预设旋钮的写路径走原生桥**：宿主刻意没把 `usePermissionPreset`（连同
 *      `setReviewer` / `setDefaultPermissionPreset`）放进界面通道白名单
 *      （见 `src/core/ui-methods.ts` 的 `UI_EXCLUDED`：沙箱 + 权限模式 + 审阅者是安全闸门
 *      本身），但旧界面输入框里本来就有这根能切的旋钮，壳不能比旧界面少一样东西——所以写口
 *      开在原生桥（`NATIVE_OPS.usePermissionPreset`，与 `saveProvider` 那三件同一先例：
 *      只对装了 preload 的桌面窗口开放）。桥不在（浏览器页签 / 远程页面）时点选项给一句
 *      明确的话，不静默。
 *   2. **`/` 指令当场拦下**：`runCommand` 同样不在白名单里。旧界面把 `/` 开头的文本
 *      交给命令注册表，壳这边交不了——照旧发出去会变成一条「以斜杠开头」的用户消息
 *      喂给模型，那比明确拒绝更糟。
 *   3. **贴图这一版还不支持**：界面的 POST 请求体上限之下，单张图只能有 32KB
 *      （`UI_ARG_SPECS` 的 `MAX_IMAGE`），普通截图压到那个档位已经看不清了；所以贴图与
 *      拖文件都给一句明确的话，而不是静默吞掉。
 *
 * 三根旋钮的清单**一律从快照的 `surfaces` 读**（`surfaces.permissionPresets` /
 * `surfaces.preset` / `listModels`），不在壳里抄一份档位表——旧界面 `Composer.tsx` 也是这么
 * 接 `props.policy` 与 `props.preset` 的（:74-76）。
 *
 * 权限那一颗从「模式」改成了「预设」（`surfaces.permissionPresets`）：沙箱 + 权限模式 +
 * 审阅者捆成一颗，分开选会出现「完全访问 + 沙箱仍工作区可写」这种自相矛盾的组合。
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
import { IconArrowUp, IconBranch, IconCheck, IconChevronDown, IconClose, IconEdit, IconLayers, IconPlus, IconQueue, IconSearch, IconShield, IconStop, IconTrash } from '@dsc/ui'
import {
  HUMAN_WAIT_TIMEOUT_MS,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type EffortLevel,
  type GitSurface,
  type HostSnapshot,
  type ModelChoiceView,
  type PermissionPresetSurface,
  type PresetSurface,
  type PresetView,
  type QueuedMessageView,
} from '@dsc/ui'
import { useMention } from './mention'
import { filteredBranches, wouldOverwrite, type GitBranchRow } from './git-branch'

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

/** 权限预设投影缺席时的兜底（空清单：菜单里会说「清单没取到」，不假装有几个预设）。 */
const EMPTY_PERMISSION_PRESETS: PermissionPresetSurface = { current: '', defaultName: '', options: [] }
/** 模式（预设）投影缺席时的兜底。 */
const EMPTY_PRESET: PresetSurface = { current: '', defaultName: '', options: [], droppable: [] }
/** git 读数缺席（宿主那片没登记 / 不是仓库）时的兜底：`repo: false` = 整行不画。 */
const EMPTY_GIT: GitSurface = { repo: false, branch: '', detached: false, dirtyFileCount: 0 }

/** `dock git-branches` 的回包（宿主 desktop-dock 的形状）。 */
interface GitBranchList {
  current: string
  detached: boolean
  branches: GitBranchRow[]
}

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
  const permissionPresets = useHostSelector(readPermissionPresets, samePermissionPresets)
  const preset = useHostSelector(readPresetSurface, samePresetSurface)
  const git = useHostSelector(readGit, sameGit)
  const model = useHostSelector(readModel)
  const effort = useHostSelector(readEffort)
  const draftKey = useHostSelector(readSessionPath)

  const [text, setText] = useState('')
  const [fault, setFault] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<readonly ModelChoiceView[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  // 权限预设与模式（预设）两根旋钮各自的浮层：三者互斥（开一根把另两根收掉，旧界面同款）。
  const [permOpen, setPermOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  // 分支菜单（输入框上方那一行那颗钮）：与上面三根旋钮的浮层互斥，同一时刻只开一个。
  const [branchOpen, setBranchOpen] = useState(false)
  /** 分支清单：null = 还没读到（菜单里显示「正在读取分支…」）。每次展开都重读一次。 */
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [branchQuery, setBranchQuery] = useState('')
  /** 有分支动作在跑（切换 / 新建）：期间整个菜单禁用，免得连点两下切两次。 */
  const [branchBusy, setBranchBusy] = useState(false)
  /** 「新建分支…」那一格展开没有（ZCode 用弹框，壳这边就地展开一格输入框）。 */
  const [branchCreateOpen, setBranchCreateOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const branchRows = useRef<HTMLDivElement | null>(null)
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

  /**
   * 分支菜单展开时读一次本地分支清单（`dock git-branches`，读类 op 直接放行）。
   *
   * 每次展开都重读（对照参考实现：切完再展开必须是新的那一份，不能复用上次的快照）。
   * 关掉菜单不清清单——下一次展开会立刻重读，清空只会闪一下「正在读取」。
   */
  useEffect(() => {
    if (!branchOpen) return undefined
    let alive = true
    setBranchQuery('')
    setBranchCreateOpen(false)
    setNewBranchName('')
    void channel
      .invoke<GitBranchList>('dock', ['git-branches', {}])
      .then((list) => {
        if (alive) setBranchList(list)
      })
      .catch((reason: unknown) => {
        if (!alive) return
        setBranchList(null)
        setFault(`读分支清单失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
    return () => {
      alive = false
    }
  }, [branchOpen, channel, git.branch])

  // 清单到手后把「当前分支」那一条滚进视野（参考实现同款）：分支多的仓库里，
  // 展开就看到自己在哪，不必自己找。`block: 'nearest'` 已在视野里就不动。
  useEffect(() => {
    if (!branchOpen || branchList === null) return
    const node = branchRows.current?.querySelector<HTMLElement>('[data-branch-current="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [branchOpen, branchList])
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
   * 切权限预设：写口在原生桥（界面通道刻意排除 `usePermissionPreset`，见 `UI_EXCLUDED`），
   * 与 `saveProvider` 那三件同一先例——一次换掉沙箱 + 权限模式 + 审阅者三件事，任一件都是
   * 安全闸门本身。桥不在时（浏览器页签 / 远程壳）给一句明确的话：那颗旋钮照旧画出来，
   * 只是点下去会说清为什么这一档改不了。
   */
  const choosePermissionPreset = (name: string, label: string): void => {
    setPermOpen(false)
    setFault(null)
    const native = getHostNative()
    if (!native.available) {
      setFault('切权限预设这条口子只在桌面窗口里开（浏览器页签与远程页面够不着），请用桌面端或终端改')
      return
    }
    void native
      .invoke('usePermissionPreset', [name])
      .then(() => {
        toastOk(`权限预设已切到「${label}」`)
      })
      .catch((reason: unknown) => {
        setFault(`切权限预设失败：${reason instanceof Error ? reason.message : String(reason)}`)
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

  /**
   * 切分支：`dock git-checkout`（**写类 op，过审批**——切分支会把改动带过去或让 git 拒掉，
   * 所以与暂存 / 提交同一档，卡片上写着切到哪个分支）。
   *
   * 失败分两种，都往输入的 fault 行上写（那颗钮就在输入框上方，用户的眼睛在那儿）：
   *   - 审批被拒 / git 自己拒（工作树里有会被覆盖的改动）：git 的原文已经说清了是哪些文件，
   *     原样给出去，再补一句「往哪儿走」（先提交或暂存）。
   *   - 通道 / 参数层面的错：原文照给。
   */
  const switchBranch = (name: string): void => {
    setBranchBusy(true)
    setFault(null)
    // 菜单先收起来：接下来可能弹审批卡，卡才是这一刻该看的东西（菜单盖在卡上面会让人点不到）。
    setBranchOpen(false)
    void channel
      .invoke('dock', ['git-checkout', { branch: name }], { timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
      .then(() => {
        toastOk(`已切到分支「${name}」`)
      })
      .catch((reason: unknown) => {
        const text = reason instanceof Error ? reason.message : String(reason)
        setFault(wouldOverwrite(text) ? `${text}（先提交或暂存这些改动再切：右侧栏「变更」页签可以提交）` : text)
      })
      .finally(() => {
        setBranchBusy(false)
      })
  }

  /** 新建分支并切过去：`dock git-branch-create`（同样是写类 op，过审批）。 */
  const createBranch = (): void => {
    const name = newBranchName.trim()
    if (name === '') return
    setBranchBusy(true)
    setFault(null)
    setBranchOpen(false)
    void channel
      .invoke('dock', ['git-branch-create', { branch: name }], { timeoutMs: HUMAN_WAIT_TIMEOUT_MS })
      .then(() => {
        setBranchCreateOpen(false)
        setNewBranchName('')
        toastOk(`已新建并切到分支「${name}」`)
      })
      .catch((reason: unknown) => {
        setFault(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBranchBusy(false)
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
  /** 当前预设那一项（拿它的 label / description）；`custom`（旋钮拼不出任何预设）或清单缺了时为 undefined。 */
  const permOption = permissionPresets.options.find((item) => item.name === permissionPresets.current)
  const presetOption = preset.options.find((item) => item.name === preset.current)
  const current = models.find((choice) => choice.model === model || choice.value === model)
  const effortLevels = current === undefined ? EFFORT_FALLBACK : current.thinkingLevels
  const placeholder = blocked
    ? '等待审批…'
    : working
      ? '回合进行中：回车把消息排进队里，Ctrl+Enter 插话（打断当前输出）'
      : '发消息，@ 引用文件，回车发送，Ctrl+Enter 插话'

  return (
    // 这一层是「输入框外面那一列」：分支行在上、输入框在下，各占一行、各带自己的边。
    // 为什么不让分支行长在 `.composer` 里（原来就是）：`.composer` 是带描边和圆角的
    // 输入框本体，住在里面的东西会被同一个外框一起圈住，分支钮看着就成了输入框的一部分
    // （用户报「git 管理按钮，需要与输入框作出区分」）。参考实现里这一行也在输入框上方的
    // 框外。`.composer-zone` 的「与正文列同宽」打在插件根节点上，所以这一层要接住它。
    <div className="composer-stack" style={{ marginTop: 10 }}>
      {/* 分支控制（对照参考实现输入框上方那一行）：一颗钮显示当前分支，点开是分支菜单
          （搜 / 切 / 新建）。读数来自宿主快照面 `surfaces.git`（宿主自己按节奏拍，
          壳只渲染），**不是仓库时整行不画**。写口（切 / 新建）走 `dock` 的写类 op，
          与暂存 / 提交同一档：过审批。 */}
      {git.repo ? (
        <div className="composer-git">
          <div className="model-anchor">
            <button
              type="button"
              className={`model-btn git-btn${branchOpen ? ' open' : ''}`}
              data-tip={git.detached ? 'HEAD 已分离（不在任何分支上）；点开可以切回一个分支' : `当前分支：${git.branch}`}
              aria-haspopup="menu"
              aria-expanded={branchOpen}
              onClick={() => {
                setBranchOpen((open) => !open)
                setPermOpen(false)
                setPresetOpen(false)
                setPanelOpen(false)
              }}
            >
              <IconBranch size={13} />
              <span className="git-branch-name">{git.branch}</span>
              <IconChevronDown size={12} />
            </button>
            {branchOpen ? (
              <>
                <div
                  className="pop-mask"
                  onClick={() => {
                    setBranchOpen(false)
                  }}
                />
                <div className="model-pop git-pop" role="menu" aria-label="切换分支">
                  <div className="pop-label">
                    切换分支
                    <span className="pop-note">
                      {branchList?.detached === true ? 'HEAD 已分离' : `当前 ${branchList?.current ?? git.branch}`}
                      {git.dirtyFileCount > 0 ? ` · ${String(git.dirtyFileCount)} 个文件已更改` : ''}
                    </span>
                  </div>
                  <div className="git-search">
                    <IconSearch size={13} />
                    <input
                      type="text"
                      value={branchQuery}
                      placeholder="搜索分支…"
                      aria-label="搜索分支"
                      autoFocus
                      onChange={(event) => {
                        setBranchQuery(event.target.value)
                      }}
                    />
                  </div>
                  <div className="model-list git-branch-list" ref={branchRows}>
                    {branchList === null ? (
                      <div className="pop-item">
                        <span className="name">正在读取分支…</span>
                      </div>
                    ) : filteredBranches(branchList.branches, branchQuery).length === 0 ? (
                      <div className="pop-item">
                        <span className="name">{branchQuery.trim() === '' ? '这个仓库还没有分支' : '没有匹配的分支'}</span>
                      </div>
                    ) : (
                      filteredBranches(branchList.branches, branchQuery).map((row) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={row.current}
                          key={row.name}
                          className={`pop-item${row.current ? ' on' : ''}`}
                          title={row.current ? `${row.name}（当前分支）` : `切到 ${row.name}`}
                          disabled={row.current || branchBusy}
                          {...(row.current ? { 'data-branch-current': 'true' } : {})}
                          onClick={() => {
                            switchBranch(row.name)
                          }}
                        >
                          <IconBranch size={13} className="git-item-icon" />
                          <span className="name">{row.name}</span>
                          {row.current ? <IconCheck size={14} className="check" /> : null}
                        </button>
                      ))
                    )}
                  </div>
                  <div className="git-foot">
                    {branchCreateOpen ? (
                      <form
                        className="git-create"
                        onSubmit={(event) => {
                          event.preventDefault()
                          createBranch()
                        }}
                      >
                        <input
                          type="text"
                          value={newBranchName}
                          placeholder="新分支名，如 feat/xxx"
                          aria-label="新分支名"
                          autoFocus
                          disabled={branchBusy}
                          onChange={(event) => {
                            setNewBranchName(event.target.value)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setBranchCreateOpen(false)
                            }
                          }}
                        />
                        <button type="submit" disabled={branchBusy || newBranchName.trim() === ''}>
                          创建并切换
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="git-foot-btn"
                        disabled={branchBusy}
                        onClick={() => {
                          setBranchCreateOpen(true)
                        }}
                      >
                        <IconPlus size={13} />
                        新建分支…
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 输入框本体：这一层的描边 + 圆角说的才是「这里可以打字」。贴图 / 拖文件那三个
          事件挂在它上面（不在外层那一列上）：命中面就是看得见的那个框。 */}
      <div
        className="composer"
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
            {/* 权限预设（旧界面同款：一颗能切的旋钮 + 菜单）。清单来自快照
                surfaces.permissionPresets，写口走原生桥（见 choosePermissionPreset 的注释）。
                一颗管三件事（沙箱 + 权限模式 + 审阅者）：分开选会出现「完全访问 + 沙箱仍工作区可写」
                这种自相矛盾的组合。 */}
            <div className="model-anchor">
              <button
                type="button"
                className={`model-btn${permOpen ? ' open' : ''}`}
                data-tip={
                  permOption?.description ?? '当前三项旋钮的组合不匹配任何预设；在设置里逐格改出来的状态'
                }
                aria-haspopup="menu"
                aria-expanded={permOpen}
                onClick={() => {
                  setPermOpen((open) => !open)
                  setPresetOpen(false)
                  setPanelOpen(false)
                  setBranchOpen(false)
                }}
              >
                <IconShield size={13} />
                {permOption?.label ?? '自定义'}
                <IconChevronDown size={12} />
              </button>
              {permOpen ? (
                <>
                  <div
                    className="pop-mask"
                    onClick={() => {
                      setPermOpen(false)
                    }}
                  />
                  <div className="model-pop policy-pop" role="menu" aria-label="权限预设">
                    <div className="pop-label">
                      权限预设
                      <span className="pop-note">沙箱 + 权限 + 审阅者 三合一</span>
                    </div>
                    {permissionPresets.options.length === 0 ? (
                      <div className="pop-item">
                        <span className="name">清单没取到</span>
                      </div>
                    ) : (
                      permissionPresets.options.map((item) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={item.name === permissionPresets.current}
                          key={item.name}
                          className={`pop-item${item.name === permissionPresets.current ? ' on' : ''}`}
                          title={item.description}
                          disabled={item.name === permissionPresets.current}
                          onClick={() => {
                            choosePermissionPreset(item.name, item.label)
                          }}
                        >
                          <span className="name">{item.label}</span>
                          {item.name === permissionPresets.current ? <IconCheck size={14} className="check" /> : null}
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
                  setPermOpen(false)
                  setPanelOpen(false)
                  setBranchOpen(false)
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
                  setPermOpen(false)
                  setPresetOpen(false)
                  setBranchOpen(false)
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
 * 权限预设投影（当前生效的 + 新会话默认的 + 全部可选）。清单**从快照读**，不在壳里抄一份：
 * 出厂那几个预设（只读 / 工作区可写 / 完全访问 / AI 复核）由 permission-presets 插件给定，
 * 抄一份就会漂。`current` 是预设名，三项旋钮拼不出预设时宿主给 `'custom'`（这里不特判它，
 * 菜单找不到这一项自然显示「自定义」）。
 */
function readPermissionPresets(snapshot: HostSnapshot | null): PermissionPresetSurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_PERMISSION_PRESETS
  const presets = (surfaces as Record<string, unknown>)['permissionPresets']
  if (typeof presets !== 'object' || presets === null) return EMPTY_PERMISSION_PRESETS
  const record = presets as Record<string, unknown>
  const current = record['current']
  const options = record['options']
  if (typeof current !== 'string' || !Array.isArray(options)) return EMPTY_PERMISSION_PRESETS
  return {
    current,
    defaultName: typeof record['defaultName'] === 'string' ? record['defaultName'] : '',
    options: options as PermissionPresetSurface['options'],
  }
}

/**
 * 权限预设投影的相等判断：快照**每帧都换引用**，不给判断就会每帧重画输入区。
 *
 * 逐字段比而不是比引用：清单是几个预设，比一遍比让 React 重画便宜得多
 * （与 `sameQueued` 同一套写法）。
 */
function samePermissionPresets(left: PermissionPresetSurface, right: PermissionPresetSurface): boolean {
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
      item.builtin === other.builtin
    )
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

/**
 * git 读数投影（当前分支 + 改动计数）。宿主那片是**轻读**（一条分支名 + 数一数
 * `git status` 的条数），壳只渲染，不自己拍——两处各拍一遍在大仓里就是拿 CPU 换同一行字。
 */
function readGit(snapshot: HostSnapshot | null): GitSurface {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return EMPTY_GIT
  const raw = (surfaces as Record<string, unknown>)['git']
  if (typeof raw !== 'object' || raw === null) return EMPTY_GIT
  const record = raw as Record<string, unknown>
  return {
    repo: record['repo'] === true,
    branch: typeof record['branch'] === 'string' ? record['branch'] : '',
    detached: record['detached'] === true,
    dirtyFileCount: typeof record['dirtyFileCount'] === 'number' ? record['dirtyFileCount'] : 0,
  }
}

/** git 读数的相等判断（四个字段比一遍，比让输入区每帧重画便宜）。 */
function sameGit(left: GitSurface, right: GitSurface): boolean {
  return (
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.detached === right.detached &&
    left.dirtyFileCount === right.dirtyFileCount
  )
}
