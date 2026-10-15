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
 * **模型与思考强度是两颗 chip、两张浮层**（0.6.71 起，对照 ZCode composer 的
 * `V4ComposerToolbar`：模型一颗、档位一颗）。旧版是一颗 + 一张浮层，上半排档位按钮、
 * 下半是模型平铺清单——用户报「看不出来当前选的是哪个模型、哪一档」，底下压着三处真错
 * （档位漏了「默认」那档、打勾拿 `value === 裸模型名` 判、清单只在挂载时取一次），逐条
 * 记在 `./model-picker.ts` 的模块注释里。**所有判定都在那个纯模块里**，这里只画：
 * 探针读不了 `.tsx`，读得了那份零依赖的 `.ts`。
 *
 * 样式与 class 名照抄旧版（`ui-shell/src/legacy/views.css`，行号同旧 `styles.css`）：
 * `.composer` 2225、`.composer-bar` 2259、`.bar-left/.bar-right` 2266/2301、`.model-anchor`
 * 2309、`.model-btn` 2314、`.model-pop` 2347、`.model-list/.pop-item` 2410-2464、
 * `.send-btn` 2468、`.queue-dock` 2519 起。两颗 chip 与两级菜单的新样式在壳的 `styles.css`
 * 里（`styles.css` 打的是 `.composer-model-chip` / `.model-picker` / `.pop-rail` … 那几个
 * 新类名；**别复用已经退役的 `.model-chip`**——那是模型设置页上一版端点卡里的东西，
 * `scripts/ui-models-page-test.mjs` 有一条闸不许它回来）。
 *
 * @module dsc-ui-shell/plugins/composer
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
/** DOM 原生键盘事件（`window.addEventListener` 用；React 的 KeyboardEvent 是另一个类型）。 */
type WindowKeyboardEvent = globalThis.KeyboardEvent
import { IconArrowUp, IconBrain, IconBranch, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconEdit, IconLayers, IconPackage, IconPlus, IconQueue, IconSearch, IconShield, IconSpark, IconStop, IconTrash } from '@dsc/ui'
import {
  HUMAN_WAIT_TIMEOUT_MS,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type GitSurface,
  type HostSnapshot,
  type ModelChoiceView,
  type PermissionPresetSurface,
  type PresetSurface,
  type PresetView,
  type NoticeMessageView,
  type QueuedMessageView,
} from '@dsc/ui'
import { useMention } from './mention'
import { carryDraft, draftScopeOf, type ComposerDraft } from './draft'
import { summarizeNotice } from './notice-summary'
import {
  contextLabel,
  effortChoices,
  effortLabel,
  effortSwitchable,
  findCurrent,
  groupModels,
  modelBadges,
  modelChipText,
  providerHint,
  shouldShowProviderLevel,
} from './model-picker'
import { filteredBranches, wouldOverwrite, type GitBranchRow } from './git-branch'

/** 输入框自动增高的上限（旧界面同一个值：200px）。 */
const MAX_INPUT_HEIGHT = 200
/** 排队消息摘要的字数上限（旧界面的 PREVIEW_CHARS）。 */
const PREVIEW_CHARS = 200
/** 本机历史输入留多少条（旧界面用会话历史；壳这边先本地记一份）。 */
const HISTORY_LIMIT = 50

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
    // order 40 = 待投递通知条，与三张卡同一条带（输入框上方）；order 60 = 用户排队条，
    // 在输入框**下面**。
    ui.slots.register('shell.composer', { id: 'composer.notices', order: 40 }, NoticeStrip)
    ui.slots.register('shell.composer', { id: 'composer.box', order: 50 }, ComposerBox)
    ui.slots.register('shell.composer', { id: 'composer.queue', order: 60 }, QueueDock)
  },
})

function ComposerBox(): ReactNode {
  const channel = useHostChannel()
  const turnState = useHostSelector(readTurnState)
  const blocked = useHostSelector(readHasApproval)
  const queuedCount = useHostSelector(readInboxCount)
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
  /** 模型菜单（两级：端点 → 模型）开没开。 */
  const [modelOpen, setModelOpen] = useState(false)
  /** 思考档位菜单开没开（与模型菜单是**两颗** chip、两张浮层，见 bar-right 的注释）。 */
  const [effortOpen, setEffortOpen] = useState(false)
  /** 模型菜单左栏选中的端点（hover / 点一下切右栏；展开时先落在当前模型所属那个）。 */
  const [pickedProvider, setPickedProvider] = useState('')
  /** 模型 chip 上的端点前缀收没收掉（放不下就收，见下面那段量法）。 */
  const [dropPrefix, setDropPrefix] = useState(false)
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
  /** 模型菜单展开时把当前项滚进视野用的两个锚点（端点行 / 模型行）。 */
  const providerRows = useRef<HTMLDivElement | null>(null)
  const modelRows = useRef<HTMLDivElement | null>(null)
  /** 输入行（量栏宽用：栏宽一变就要重新掂一次端点前缀放不放得下）。 */
  const barRef = useRef<HTMLDivElement | null>(null)
  const [barWidth, setBarWidth] = useState(0)
  useEffect(() => {
    const node = barRef.current
    if (node === null || typeof ResizeObserver === 'undefined') return undefined
    setBarWidth(node.clientWidth)
    const observer = new ResizeObserver(() => {
      setBarWidth(node.clientWidth)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])
  /** 模型 chip 本体（量端点前缀放不放得下用）。 */
  const modelChipRef = useRef<HTMLButtonElement | null>(null)
  // Esc 关这两张浮层（与遮罩点击同效；设置面板、确认框各自也拦 Esc，谁开着归谁）。
  useEffect(() => {
    if (!modelOpen && !effortOpen) return undefined
    const onKey = (event: WindowKeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setModelOpen(false)
      setEffortOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modelOpen, effortOpen])

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
  /** 每会话一份草稿（正文 + 本机历史），切会话时整份换入换出；归属规则见 draft.ts。 */
  const drafts = useRef(new Map<string, ComposerDraft>())
  const draftSessionId = useHostSelector(readSessionId)
  const draftCwd = useHostSelector(readDraftCwd)
  const draftUnsaved = useHostSelector(readSessionUnsaved)
  const draftScope = draftScopeOf({
    sessionPath: draftKey,
    sessionId: draftSessionId,
    cwd: draftCwd,
    unsaved: draftUnsaved,
  })
  const draftScopeRef = useRef(draftScope)

  const working = turnState !== 'idle'

  /**
   * 换会话时换草稿（对照旧界面 `Composer.tsx` 的 `draftsRef`）。
   *
   * 为什么必须有：组件不随会话重挂，`text` 是单个 state。不换的话，在会话 A 里打了一半的
   * 话会跟着你进会话 B，回车就发错了会话——这是会真丢事的错，不只是显示问题。
   *
   * 归属按 {@link draftScopeOf} 算：**还没发过消息的会话草稿记在工作区名下**，所以
   * 「新会话里写了半截话 → 切走 → 再点新会话」能把话捡回来（0.6.70 报障）。搬运规则
   * （含「同一条会话刚落盘就把工作区那一格清掉」）在 `carryDraft` 里，由探针逐条钉住。
   *
   * 游标一律归零：换了一份历史，上下键从头开始。
   */
  useEffect(() => {
    if (draftScopeRef.current.key === draftScope.key) return
    const next = carryDraft(drafts.current, draftScopeRef.current, draftScope, {
      value: text,
      history: history.current,
    })
    draftScopeRef.current = draftScope
    setText(next.value)
    history.current = [...next.history]
    setHistoryAt(null)
  }, [draftScope.key, draftScope.sessionId, draftScope.unsaved, text])

  // 输入框跟着内容长高，封顶 200px（超出在框内滚）。
  useEffect(() => {
    const node = area.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${String(Math.min(node.scrollHeight, MAX_INPUT_HEIGHT))}px`
  }, [text])

  /**
   * 模型清单：挂载时取一次，**每次展开菜单再取一次**。
   *
   * 为什么不能只在挂载时取（旧版就是这么写的，注释还写着「静态数据」）：设置里加过端点、
   * 改过模型之后，这张清单就是旧的了——点开菜单看到的还是上一轮配置，当前模型甚至可能
   * 根本不在里面（0.6.71 报障）。这条读一次就回来的路上没有成本，重取的收益是「菜单里
   * 看到的永远是当下这份配置」。
   */
  useEffect(() => {
    let alive = true
    void channel
      .invoke<ModelChoiceView[]>('listModels')
      .then((list) => {
        if (alive) setModels(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        // 取不到就沿用上一次那一份（首次即空）：菜单会如实说「清单没取到」，不影响发消息。
      })
    return () => {
      alive = false
    }
  }, [channel, modelOpen])

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
        setFault(wouldOverwrite(text) ? `${text}（先提交或暂存这些改动再切：右侧边栏「变更」页签可以提交）` : text)
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

  // ── 模型 / 思考档位（两颗 chip + 两张浮层）───────────────────────────────────
  // 一切判定都走 `./model-picker` 那份纯逻辑：端点分组、当前模型的精确定位、档位清单
  // （恒含「默认」）都在那里，探针逐条钉着；这里只把结果画出来。
  const groups = groupModels(models)
  const provider = useHostSelector(readProvider)
  const current = findCurrent(groups, provider, model)
  const chip = modelChipText(groups, provider, model)
  const twoLevel = shouldShowProviderLevel(groups)
  /** 左栏选中的端点：没手选过（或它没在了）就落在当前模型所属那个，再退回第一个。 */
  const activeProvider =
    groups.find((item) => item.provider === pickedProvider)?.provider ??
    current.group?.provider ??
    groups[0]?.provider ??
    ''
  const visibleModels = twoLevel
    ? (groups.find((item) => item.provider === activeProvider)?.models ?? [])
    : (groups[0]?.models ?? [])
  // 档位清单：模型查得到就用它声明的（含「默认」），查不到给兜底五档——不锁死用户。
  const levelOptions = effortChoices(current.entry)
  const switchEffort = effortSwitchable(levelOptions)
  const effortText = effortLabel(effort)
  /**
   * 展开模型菜单时把当前项滚进视野（照分支菜单同款）。
   *
   * 为什么必须有：模型一多，当前那一条可能落在滚动区外面——「打开菜单看得见自己选的是谁」
   * 正是这次要修的东西，光打勾不够（勾在屏幕外等于没打）。
   */
  useEffect(() => {
    if (!modelOpen) return
    providerRows.current?.querySelector<HTMLElement>('[data-provider-current="true"]')?.scrollIntoView({ block: 'nearest' })
    modelRows.current?.querySelector<HTMLElement>('[data-model-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [modelOpen, activeProvider, models.length])

  /** 完整形态的签名：换模型 / 清单变了 / 栏宽变了，都要重新掂一次端点前缀放不放得下。 */
  const chipMeasureKey = `${chip.full}|${String(models.length)}|${String(barWidth)}`

  /**
   * 端点前缀放不下就**整段收掉**（对照 ZCode 的 `composer-provider-compact`）。
   *
   * 为什么必须有：`.composer-zone` 封顶 `--dsc-thread-max`（76ch ≈ 531px），左组三颗 +
   * 档位 chip + 发送键之后，留给模型 chip 的只有一百多像素；而 `端点/模型` 两段字按这个
   * 种子要 224px。硬塞的结果是**两段都被截**——实机走查截出来是 `Dee… deepseek…`，
   * 等于什么都没说（这恰恰是用户报的那件事）。
   *
   * 口径：**模型名是身份，端点是出处**。放不下就只留名字（端点在菜单里带勾、在悬浮说明
   * 与 `aria-label` 里也有全称）。量的是**完整形态**（前缀还在场时量一次），收掉之后不再
   * 重量，所以不会来回抖；换模型、清单变了、栏宽变了再给完整形态一次机会。
   *
   * 为什么用 `useLayoutEffect` 而不是 `useEffect`：这两条要在**同一帧内**跑完（先归位成
   * 完整形态、再量一次决定收不收），否则会先画出一帧「两段都截半」的丑样子。
   * 顺序也重要：**归位那条必须排在测量那条前面**——反过来的话两者会在同一拍里互相覆盖
   * （先设 true 再被设回 false），实机走查第一版就是这么失效的。
   */
  useLayoutEffect(() => {
    setDropPrefix(false)
  }, [chipMeasureKey])

  useLayoutEffect(() => {
    if (dropPrefix) return
    const node = modelChipRef.current
    const bar = barRef.current
    if (node === null || bar === null) return
    const cut = (selector: string): boolean => {
      const el = node.querySelector<HTMLElement>(selector)
      return el !== null && el.scrollWidth > el.clientWidth + 1
    }
    // 栏本身溢出了也算「这一行装不下」：那时收掉前缀能实打实腾出几十像素。
    const tight = cut('.model-name') || cut('.composer-model-provider') || bar.scrollWidth > bar.clientWidth + 1
    if (tight) setDropPrefix(true)
  }, [dropPrefix, chipMeasureKey])

  /** 打开设置面板的「模型」分区（菜单底部那一行的落点）。 */
  const openModelsSettings = (): void => {
    window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'models' } }))
  }
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
                setModelOpen(false)
                setEffortOpen(false)
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

        <div className="composer-bar" ref={barRef}>
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
                  setModelOpen(false)
                  setEffortOpen(false)
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
                  setModelOpen(false)
                  setEffortOpen(false)
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
            {/* 模型 chip（对照 ZCode 的模型选择器）：只回答「用哪个模型」，点开是**两级**菜单
                （一级端点、二级该端点的模型，两级各自给当前项打勾）。思考强度是它右边
                **另一颗** chip——旧版把两件事塞进同一张浮层，于是「当前选的是哪个模型、
                哪一档」都得点开才知道（0.6.71 报障）。两颗各带自己的浮层，与另三根旋钮
                同一套互斥口径（开一根把其余全收掉）。 */}
            <div className="model-anchor">
              <button
                type="button"
                ref={modelChipRef}
                className={`model-btn composer-model-chip${modelOpen ? ' open' : ''}`}
                title={`模型：${chip.full}（点开换）`}
                aria-haspopup="menu"
                aria-expanded={modelOpen}
                aria-label={`当前模型 ${chip.full}`}
                data-composer-model={current.entry?.value ?? chip.full}
                onClick={() => {
                  setModelOpen((open) => !open)
                  setEffortOpen(false)
                  setPermOpen(false)
                  setPresetOpen(false)
                  setBranchOpen(false)
                }}
              >
                <IconPackage size={13} />
                {chip.prefix === '' || dropPrefix ? null : (
                  <span className="composer-model-provider">{chip.prefix}</span>
                )}
                <span className="model-name">{chip.name}</span>
                <IconChevronDown size={12} />
              </button>
              {modelOpen ? (
                <>
                  <div
                    className="pop-mask"
                    onClick={() => {
                      setModelOpen(false)
                    }}
                  />
                  <div className="model-pop model-picker" role="menu" aria-label="选择模型">
                    <div className="pop-label">
                      模型
                      <span className="pop-note">
                        {models.length === 0 ? '清单没取到' : twoLevel ? `${String(groups.length)} 个端点` : chip.full}
                      </span>
                    </div>
                    {/* 当前模型不在清单里时先说清楚（端点配置改过、或这条会话记住的模型下线了）：
                        否则用户只看到一片「一条都不打勾」的清单，不知道是谁不对。 */}
                    {current.entry === undefined && model !== '' ? (
                      <div className="pop-item model-unknown" data-model-unknown="true">
                        <span className="name">当前：{model} —— 清单里没有这个模型</span>
                      </div>
                    ) : null}
                    <div className={`model-picker-body${twoLevel ? ' two-level' : ''}`}>
                      {twoLevel ? (
                        <div className="pop-rail" data-model-rail="" ref={providerRows}>
                          {groups.map((group) => {
                            const owns = current.group?.provider === group.provider
                            const hint = providerHint(group, current)
                            return (
                              <button
                                type="button"
                                role="menuitem"
                                aria-current={owns}
                                key={group.provider}
                                className={`pop-item rail-item${group.provider === activeProvider ? ' on' : ''}`}
                                data-model-provider={group.provider}
                                data-provider-current={owns ? 'true' : undefined}
                                title={
                                  hint === ''
                                    ? `${group.displayName} · ${String(group.models.length)} 个模型`
                                    : `${group.displayName} · 当前 ${hint}`
                                }
                                onMouseEnter={() => {
                                  setPickedProvider(group.provider)
                                }}
                                onFocus={() => {
                                  setPickedProvider(group.provider)
                                }}
                                onClick={() => {
                                  setPickedProvider(group.provider)
                                }}
                              >
                                <span className="name">{group.displayName}</span>
                                {owns ? <IconCheck size={13} className="check" /> : null}
                                <IconChevronRight size={12} className="rail-arrow" />
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                      <div className="pop-models" data-model-models="" ref={modelRows}>
                        {visibleModels.length === 0 ? (
                          <div className="pop-item">
                            <span className="name">{models.length === 0 ? '清单没取到' : '这个端点还没有模型'}</span>
                          </div>
                        ) : (
                          visibleModels.map((choice) => {
                            const on = current.entry?.value === choice.value
                            return (
                              <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={on}
                                key={choice.value}
                                className={`pop-item${on ? ' on' : ''}`}
                                title={choice.description}
                                data-model-current={on ? 'true' : undefined}
                                onClick={() => {
                                  setModelOpen(false)
                                  setFault(null)
                                  void channel.invoke('setModel', [choice.value]).catch((reason: unknown) => {
                                    setFault(reason instanceof Error ? reason.message : String(reason))
                                  })
                                }}
                              >
                                <span className="name">{choice.model}</span>
                                {modelBadges(choice).map((badge) => (
                                  <span className="pop-badge" key={badge}>
                                    {badge}
                                  </span>
                                ))}
                                <span className="ctx">{contextLabel(choice.contextWindow)}</span>
                                {on ? <IconCheck size={14} className="check" /> : null}
                              </button>
                            )
                          })
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="pop-item model-manage"
                      data-model-manage=""
                      onClick={() => {
                        setModelOpen(false)
                        openModelsSettings()
                      }}
                    >
                      <span className="name">管理模型</span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            {/* 思考档位 chip：读数直接取 `status.effort`（**不依赖模型清单**），所以清单过期
                也不会显示错。档位清单里恒有「默认」——宿主把它当恒可选的档位，旧版漏了它，
                于是默认档时四个按钮一个都不亮。单档模型不给浮层、也不给箭头。 */}
            {switchEffort ? (
              <div className="model-anchor">
                <button
                  type="button"
                  className={`model-btn composer-effort-chip${effortOpen ? ' open' : ''}`}
                  title={`思考强度：${effortText}（点开换档）`}
                  aria-haspopup="menu"
                  aria-expanded={effortOpen}
                  aria-label={`当前思考强度 ${effortText}`}
                  data-composer-effort={effort}
                  onClick={() => {
                    setEffortOpen((open) => !open)
                    setModelOpen(false)
                    setPermOpen(false)
                    setPresetOpen(false)
                    setBranchOpen(false)
                  }}
                >
                  <IconBrain size={13} />
                  <span className="model-name">{effortText}</span>
                  <IconChevronDown size={12} />
                </button>
                {effortOpen ? (
                  <>
                    <div
                      className="pop-mask"
                      onClick={() => {
                        setEffortOpen(false)
                      }}
                    />
                    <div className="model-pop effort-pop" role="menu" aria-label="思考强度">
                      <div className="pop-label">
                        思考强度
                        {current.entry === undefined && model !== '' ? (
                          <span className="pop-note">模型不在清单里，列的是全部档位</span>
                        ) : null}
                      </div>
                      {levelOptions.map((level) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={level === effort}
                          key={level}
                          className={`pop-item${level === effort ? ' on' : ''}`}
                          data-effort-option={level}
                          onClick={() => {
                            setEffortOpen(false)
                            setFault(null)
                            void channel.invoke('setEffort', [level]).catch((reason: unknown) => {
                              setFault(reason instanceof Error ? reason.message : String(reason))
                            })
                          }}
                        >
                          <span className="name">{effortLabel(level)}</span>
                          {level === effort ? <IconCheck size={14} className="check" /> : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <span
                className="model-btn composer-effort-chip fixed"
                title={`思考强度：${effortText}（这个模型没有可切换的档位）`}
                data-composer-effort={effort}
              >
                <IconBrain size={13} />
                <span className="model-name">{effortText}</span>
              </span>
            )}

            {working ? (
              <button
                type="button"
                className={`send-btn stop${queueing ? ' dim' : ''}`}
                aria-label="停止生成"
                data-tip="停止生成"
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

/** 排队消息摘要：压成一行、截到 200 字（全文挂在悬浮说明上）。 */
function previewOf(text: string): string {  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : flat
}

/** 排队条一次动作的结果：`rejected` = 宿主回话说没做到，`failed` = 这次调用本身出错。 */
type ActOutcome = 'ok' | 'rejected' | 'failed'

/**
 * 待投递通知条（对照 dsh 的 turn-trigger 行）：回合跑动中到达的**机器**唤醒
 * （队友汇报、审查 findings、传话、后台作业完成、定时补投……）还没交给模型时，
 * 在输入框**上方**露一行。与下面的排队条（用户输入）分开：这一条**只读**——
 * 没有编辑 / 撤掉 / 插话三颗钮（机器消息不代表人的意图），也不把 `<teammate-report …>`
 * 这类原始标记上屏，由 {@link summarizeNotice} 压成一句含来源的人话。
 *
 * 队列空了整块不渲染（与排队条一致，不留空壳把输入框顶出一条间距）。
 */
function NoticeStrip(): ReactNode {
  const notices = useHostSelector(readNotices, sameNotices)
  if (notices.length === 0) return null
  return (
    <div className="notice-strip" data-notice-strip="">
      {notices.map((item) => {
        const summary = summarizeNotice(item.text)
        return (
          <div className="notice-row" key={item.index}>
            <span className="notice-lead" aria-hidden="true">
              <IconSpark size={13} />
            </span>
            <span className="notice-label" data-tip={summary.detail === '' ? summary.label : summary.detail}>
              {summary.label}
            </span>
            {summary.detail === '' ? null : <span className="notice-detail">{summary.detail}</span>}
          </div>
        )
      })}
    </div>
  )
}

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

/**
 * 当前模型所属端点：`status.model` 是**裸名**，光有它分不清同名模型挂在哪个端点下
 * （清单里 `value` 才是 `端点/模型`）。老快照没有这一项时给空串，界面按「端点未知」处理。
 */
function readProvider(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['provider']
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
 *  统一的会话标识，同一条会话重开还是同一把钥匙，草稿不会因为换了进程就丢。
 *  **还没落盘的会话**（`sessionUnsaved`）路径会变，那种会话的草稿改按工作区分槽——
 *  见 plugins/composer/draft.ts 的 `draftScopeOf`。 */
function readSessionPath(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const path = (status as Record<string, unknown>)['sessionPath']
  return typeof path === 'string' ? path : ''
}

/** 会话 uuid（分槽时用来分辨「换了会话」与「同一条会话刚落盘」）。 */
function readSessionId(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['sessionId']
  return typeof value === 'string' ? value : ''
}

/** 会话工作目录（未落盘的新会话按它分槽）。 */
function readDraftCwd(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' ? value : ''
}

/** 这条会话一条消息都还没发过吗（草稿分槽的第二个依据）。 */
function readSessionUnsaved(snapshot: HostSnapshot | null): boolean {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return false
  return (status as Record<string, unknown>)['sessionUnsaved'] === true
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

/**
 * 收件箱里还排着几条（用户队列 + 机器通知，**两个面之和**）。
 *
 * 用途只有一个：提交时按它算「这条新消息会排到收件箱第几位」，好让紧随的
 * `steerQueued(index)` 提到队首。必须数**整条收件箱**而不是只数 `queued`——
 * 队列条的面拆开后，用户消息在收件箱里的下标仍要跨过排在前面的机器通知，
 * 只数用户队列会把插话打到别的条目上。
 */
function readInboxCount(snapshot: HostSnapshot | null): number {
  const queued = snapshot?.['queued']
  const notices = snapshot?.['notices']
  return (Array.isArray(queued) ? queued.length : 0) + (Array.isArray(notices) ? notices.length : 0)
}

function readQueued(snapshot: HostSnapshot | null): readonly QueuedMessageView[] {
  const value = snapshot?.['queued']
  return Array.isArray(value) ? (value as QueuedMessageView[]) : EMPTY_QUEUE
}

/** 空队列常量：引用稳定，选择器（默认比较）才拦得住重渲染。 */
const EMPTY_QUEUE: readonly QueuedMessageView[] = Object.freeze([])

/** 待投递通知的相等判断：内容没变就不重渲染（宿主每帧都可能给新数组）。 */
function sameNotices(left: readonly NoticeMessageView[], right: readonly NoticeMessageView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return other !== undefined && item.index === other.index && item.text === other.text
  })
}

function readNotices(snapshot: HostSnapshot | null): readonly NoticeMessageView[] {
  const value = snapshot?.['notices']
  return Array.isArray(value) ? (value as NoticeMessageView[]) : EMPTY_NOTICES
}

/** 空通知常量：同 EMPTY_QUEUE 的理由。 */
const EMPTY_NOTICES: readonly NoticeMessageView[] = Object.freeze([])

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
