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
 *   3. **附件改走字节通道**：贴图 / 拖文件不再给「不支持」那句话——图片先在浏览器里缩到
 *      2048、压到 4MiB 以内，再 POST 到宿主的 `/api/attachments` 拿同源引用；视频与通用
 *      文件同样上传，`submit` 时分别走 `images` 与 `files` 两列。视频另外在本机抽 6 帧当
 *      图片带给模型（不支持视频输入的模型也能看见关键画面）。上限与压缩规则见
 *      `./attachments.ts`。
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
 * 里（`styles.css` 打的是 `.composer-model-chip` / `.model-picker` / `.model-providers` /
 * `.model-flyout` … 那几个新类名；**别复用已经退役的 `.model-chip`**——那是模型设置页上一版
 * 端点卡里的东西，`scripts/ui-models-page-test.mjs` 有一条闸不许它回来）。
 *
 * @module dsc-ui-shell/plugins/composer
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
/** DOM 原生键盘事件（`window.addEventListener` 用；React 的 KeyboardEvent 是另一个类型）。 */
type WindowKeyboardEvent = globalThis.KeyboardEvent
import { IconArrowUp, IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconLayers, IconPackage, IconShield, IconStop } from '@dsc/ui'
import {
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type EffortLevel,
  type ModelChoiceView,
} from '@dsc/ui'
import { readTurnState, sameGitSurface as sameGit } from '@dsc/ui-primitives'
import { useMention } from './mention'
import { useCommandMenu } from './command-menu'
import { blockedNow, commandQuery } from './commands'
import { carryDraft, draftScopeOf, type ComposerDraft } from './draft'
import {
  composeSubmit,
  displayNameOf,
  extractVideoFrames,
  formatBytes,
  kindOf,
  MAX_IMAGES,
  newAttachmentId,
  normalizeImage,
  uploadFile,
  type AttachmentKind,
  type DraftAttachment,
} from './attachments'
import { EffortSlider } from './effort-slider'
import {
  chooseFlyoutSide,
  clampShift,
  contextLabel,
  effortChoices,
  effortLabel,
  findCurrent,
  FLYOUT_WIDTH,
  groupModels,
  modelBadges,
  modelChipText,
  placeFlyout,
  providerHint,
  shouldShowProviderLevel,
  type FlyoutSide,
} from './model-picker'
import { BranchMenu } from './branch-menu'
import { NoticeStrip } from './notice-strip'
import { QueueDock } from './queue-dock'
import { readDraftCwd, readEffort, readGit, readHasApproval, readInboxCount, readModel, readPermissionPresets, readPresetSurface, readProvider, readSessionId, readSessionPath, readSessionUnsaved, samePermissionPresets, samePresetSurface } from './surfaces'

/** 输入框自动增高的上限（旧界面同一个值：200px）。 */
const MAX_INPUT_HEIGHT = 200
/** 本机历史输入留多少条（旧界面用会话历史；壳这边先本地记一份）。 */
const HISTORY_LIMIT = 50



/**
 * 「往输入框写一段话」的对外口子：首屏四张能力卡（transcript 插件）经服务表调它。
 *
 * 为什么用模块级变量转一道：服务必须在 apply 阶段 `provide`，而 `setText` 住在
 * `ComposerBox` 里。组件挂载时把真正会写字的函数挂上来，卸载时摘掉——服务在、函数
 * 可能在（首屏渲染时组件已在），服务缺席时能力卡自己置灰。
 */
let insertDraft: ((text: string) => void) | null = null

export default defineUiPlugin({
  name: '输入区',
  apply(ui) {
    // 首屏能力卡的落点：只做「写字 + 聚焦」，不发送——发不发送仍由用户按回车决定。
    ui.provide('composerDraft', {
      insert: (text: string): void => {
        insertDraft?.(text)
      },
    })
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
  /**
   * 刚点下去、宿主还没确认的档位（乐观值）。
   *
   * 为什么要它：档位 chip 的读数取宿主快照，一次 setEffort 要走「界面 → 宿主 → 快照 → 回推」，
   * 几十到几百毫秒。这期间不垫一个乐观值，滑钮和文字会先弹回旧档、再跳到新档——用户说的
   * 「调档卡顿、不丝滑」多半就是这一下。快照回来对上就自动撤掉；没对上（掉线 / 宿主不认
   * 这一档）由下面的超时兜底，不让界面一直骗人。
   */
  const [pendingEffort, setPendingEffort] = useState<string | null>(null)
  // 乐观值对上宿主读数就撤（正常路径：一次往返，几十毫秒）。
  useEffect(() => {
    if (pendingEffort !== null && effort === pendingEffort) setPendingEffort(null)
  }, [effort, pendingEffort])
  // 兜底：宿主 1.5 秒没确认（掉线、旧宿主不认这个档位）就退回宿主读数，别让界面停在假状态。
  useEffect(() => {
    if (pendingEffort === null) return undefined
    const timer = setTimeout(() => setPendingEffort(null), 1500)
    return () => clearTimeout(timer)
  }, [pendingEffort])

  const [text, setText] = useState('')
  const [fault, setFault] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  /** 待发附件（上传中带进度，上传完带宿主引用；会话切换时随草稿一起搬运）。 */
  const [attachments, setAttachments] = useState<readonly DraftAttachment[]>([])
  /** 有文件悬在 `.composer` 上方（拖拽高亮走 `data-drag`，样式由壳统一写）。 */
  const [dragOver, setDragOver] = useState(false)
  const [models, setModels] = useState<readonly ModelChoiceView[]>([])
  /** 模型菜单（两级：端点 → 悬浮飞出的模型列表）开没开。 */
  const [modelOpen, setModelOpen] = useState(false)
  /** 思考档位菜单开没开（与模型菜单是**两颗** chip、两张浮层，见 bar-right 的注释）。 */
  const [effortOpen, setEffortOpen] = useState(false)
  /**
   * 一级列表上**鼠标停着（或键盘焦点落着、或手指点过）的那个端点**：它决定飞出卡画谁家的
   * 模型。`null` = 没有飞出卡（刚展开时就是这样，对照 ZCode：不悬浮就只有一级那一列）。
   */
  const [hoverProvider, setHoverProvider] = useState<string | null>(null)
  /** 飞出卡相对面板的顶边与高度上限（量出来的，见 `placeFlyout`；写进 CSS 变量）。 */
  const [flyout, setFlyout] = useState<{ top: number; maxHeight: number } | null>(null)
  /** 飞出卡摆面板左边还是右边（量出来的，见 `chooseFlyoutSide`；两边都放不下就盖住面板）。 */
  const [flyoutSide, setFlyoutSide] = useState<FlyoutSide>('right')
  /** 模型 chip 上的端点前缀收没收掉（放不下就收，见下面那段量法）。 */
  const [dropPrefix, setDropPrefix] = useState(false)
  /** 面板整体横移多少（窄屏上 chip 落得太靠左时把面板推回正文列里，见 `clampShift`）。 */
  const [panelShift, setPanelShift] = useState(0)
  /**
   * 「该重量一次了」的计数器：窗口缩放、面板自身尺寸变化（`.flat` 264 与两级 320 两套宽度）
   * 都会撞它，那两个 `useLayoutEffect` 把它列进依赖，于是位置与挑边跟着重算。
   *
   * 为什么必须有：原来只在 `[modelOpen, models.length, twoLevel]` 变时量一次，量完就
   * 不再管——2026-10-27 实测 360px 视口下面板 left=-67（整块探到屏幕左侧外），而 320/430
   * 两个宽度都正常，说明就是「量过一次之后再也没重量」这一类时序问题。
   */
  const [measureTick, setMeasureTick] = useState(0)
  // 权限预设与模式（预设）两根旋钮各自的浮层：三者互斥（开一根把另两根收掉，旧界面同款）。
  const [permOpen, setPermOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  // 分支菜单（输入框上方那一行那颗钮）：与上面三根旋钮的浮层互斥，同一时刻只开一个。
  const [branchOpen, setBranchOpen] = useState(false)
  /** 模型面板本体（量飞出卡的挑边与夹高度都拿它当参照）。 */
  const modelPanelRef = useRef<HTMLDivElement | null>(null)
  /** 已经施加在面板上的横移量（量位置时要先把它减掉，见下面那个 `useLayoutEffect`）。 */
  const shiftRef = useRef(0)
  /** 飞出卡里当前模型那一行的滚动锚点（模型一多，勾可能落在滚动区外面）。 */
  const modelRows = useRef<HTMLDivElement | null>(null)
  /** 飞出卡本体（量它内容的自然高，定了才夹得准）。 */
  const flyoutCardRef = useRef<HTMLDivElement | null>(null)
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

  const area = useRef<HTMLTextAreaElement | null>(null)
  // 把「写字 + 聚焦」挂到模块级口子上（服务表在 apply 阶段已经提供出去，见文件头）。
  useEffect(() => {
    insertDraft = (value: string): void => {
      setText(value)
      const node = area.current
      if (node === null) return
      node.focus()
      node.setSelectionRange(value.length, value.length)
    }
    return () => {
      insertDraft = null
    }
  }, [])
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

  /**
   * 把一条附件的变化写回**所有**草稿存档。
   *
   * 为什么不是只改当前 state：上传是异步的，用户完全可能在上传途中切到别的会话；那时
   * 当前 state 已经是另一份草稿，只有存档里那一份需要被补上「传完了 / 抽到几帧」。
   * 切回来才能看到正确结果。
   *
   * @param id 附件 id
   * @param patch 要合并的字段；`null` = 从存档里摘掉（手动移除 / 上传失败）
   */
  const patchDraftsAttachment = (id: string, patch: Partial<DraftAttachment> | null): void => {
    for (const [key, draft] of drafts.current) {
      const list = draft.attachments
      if (list === undefined || !list.some((item) => item.id === id)) continue
      const next =
        patch === null
          ? list.filter((item) => item.id !== id)
          : list.map((item) => (item.id === id ? { ...item, ...patch } : item))
      drafts.current.set(key, { ...draft, attachments: next })
    }
  }

  /** 当前 state 与所有草稿存档一起改（上传进度、元数据回填都走它）。 */
  const updateAttachment = (id: string, patch: Partial<DraftAttachment>): void => {
    setAttachments((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    patchDraftsAttachment(id, patch)
  }

  /** 手动移除一条附件：先释放还在上传时创建的本机预览地址，再从界面与存档里摘掉。 */
  const removeAttachment = (id: string): void => {
    const target = attachments.find((item) => item.id === id)
    if (target?.localUrl !== undefined) URL.revokeObjectURL(target.localUrl)
    setAttachments((list) => list.filter((item) => item.id !== id))
    patchDraftsAttachment(id, null)
  }

  /** 提交成功后把当前会话草稿里的附件清空（正文由 `setText('')` 负责）。 */
  const clearDraftAttachments = (): void => {
    for (const item of attachments) {
      if (item.localUrl !== undefined) URL.revokeObjectURL(item.localUrl)
    }
    setAttachments([])
    const key = draftScopeRef.current.key
    const saved = drafts.current.get(key)
    if (saved !== undefined) drafts.current.set(key, { ...saved, attachments: [] })
  }

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
      attachments,
    })
    draftScopeRef.current = draftScope
    setText(next.value)
    history.current = [...next.history]
    setAttachments([...(next.attachments ?? [])])
    setHistoryAt(null)
  }, [draftScope.key, draftScope.sessionId, draftScope.unsaved, text, attachments])

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
    // 菜单开着、而且已经在打名字：Enter 采纳高亮项再执行（与 TUI 的 panelOpen 分支同口径，
    // `↑↓` 换一条再回车就是跑那条）。只打了一个 `/` 时不采纳——那会把「看一眼清单」
    // 变成「跑第一条」（第一条是 /new，凭空多一个会话），原文交给宿主落到 /help，
    // 与 TUI 的裸 `/` 行为也一致。
    const typed = text.trim()
    const picked = command.open && typed !== '/' ? (command.insertText()?.trim() ?? null) : null
    const value = picked ?? typed
    // 正文为空但有附件也算能发（只发一张图不写字是常见用法）。
    if ((value === '' && attachments.length === 0) || blocked || sending) return
    // 带附件时不走命令：命令没有图可带，用户贴了图就是在发内容（与旧界面 App.tsx 同一条规矩）。
    if (value.startsWith('/') && attachments.length === 0) {
      // 回车就是「我要跑这一条」：候选面板当场收起。以前只清文本、不收面板，于是
      // 命令已经执行了、面板还挂在输入框上方等下一句（2026-10-27 报障第一条）。
      command.hide()
      // 命令走界面通道的受限派发 `runUiCommand`：能跑的名字钉在宿主那份 `shell: true`
      // 清单上（见宿主 core/commands-completion.ts），清单外的名字由宿主明确报错。
      // 输出（/status、/diff、/usage…）是宿主写进会话的系统条目，与 TUI 同一份。
      const target = value
      setFault(null)
      void channel
        .invoke<boolean>('runUiCommand', [target])
        .then(() => {
          history.current = [...history.current.filter((item) => item !== target), target].slice(-HISTORY_LIMIT)
          setHistoryAt(null)
          setText('')
        })
        .catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          setFault(
            message.includes('协议不允许调用的方法')
              ? '“/” 命令要宿主支持：当前宿主没把这条路接到界面通道，请在桌面端或终端里执行'
              : message,
          )
        })
      return
    }
    // 还有附件在传：这一刻发出去只能发个半成品，明确拦下。
    if (attachments.some((item) => item.uploading !== null)) {
      setFault('附件还在上传，请等上传完成后再发送')
      return
    }
    const payload = composeSubmit(attachments)
    const steerIndex = steer && working ? queuedCount : null
    setSending(true)
    setFault(null)
    void (async () => {
      try {
        // 没有附件时保持老调用形状（只传正文）；有图没文件就省掉第三参。
        if (payload.files.length > 0) {
          await channel.invoke('submit', [value, payload.images, payload.files])
        } else if (payload.images.length > 0) {
          await channel.invoke('submit', [value, payload.images])
        } else {
          await channel.invoke('submit', [value])
        }
        // 只发图不写字时不往输入历史里塞一个空串（上下键翻到空行很怪）。
        if (value !== '') {
          history.current = [...history.current.filter((item) => item !== value), value].slice(-HISTORY_LIMIT)
        }
        setHistoryAt(null)
        // 新会话要等首条消息落盘才会出现在侧栏里：提交回来自会已经写盘，这时刷一次才有效。
        void channel.invoke('refreshSessions').catch(() => undefined)
        if (steerIndex !== null) {
          const done = await channel.invoke<boolean>('steerQueued', [steerIndex])
          if (done !== true) setFault('插话没赶上：这一轮刚结束，这条消息会自己发出去')
        }
        setText('')
        clearDraftAttachments()
        if (payload.dropped > 0) {
          setFault(`图片最多 ${String(MAX_IMAGES)} 张，已发送前 ${String(MAX_IMAGES)} 张（${String(payload.dropped)} 张未发送）`)
        }
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

  /** `/` 命令菜单：候选表来自宿主的 `listUiCommands`（标了 `shell: true` 那批命令）。 */
  const command = useCommandMenu({
    channel,
    apply: (next, caret) => {
      setText(next)
      window.requestAnimationFrame(() => {
        area.current?.setSelectionRange(caret, caret)
      })
    },
    onUnavailable: () => {
      // 宿主没接这条路（老版本 / 远程档没放行）：说一句，别让「打了 / 什么都没发生」。
      setFault('当前宿主没接“/”命令通道：菜单不可用，请用桌面端或终端执行（升级宿主后自动可用）')
    },
  })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // `/` 命令菜单开着时，↑↓/Tab/Esc 先归它（Enter 不截：那是「执行」，见 send）。
    // 命令位（行首一个 /）里 @ 提及不会亮，两者同时开的情况只有 `/review @x` 这种
    // 参数阶段的提及——那时菜单自己已经关了。
    if (command.open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        command.move(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        command.pick()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        command.close()
        return
      }
    }
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
    if (event.key === 'Backspace' && text === '' && attachments.length > 0) {
      // 输入框空着时退格 = 摘掉最后一条附件（与聊天软件的常用手感一致）。
      event.preventDefault()
      const last = attachments[attachments.length - 1]
      if (last !== undefined) removeAttachment(last.id)
      return
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

  /**
   * 输入框每次变化都问两句：光标处是 `/` 命令名（菜单亮出来）还是 `@` 文件提及。
   * 命令位里不提文件：`/review 关注点` 的参数阶段才有 @，那时菜单自己已经关了。
   */
  const onTextChange = (value: string, caret: number): void => {
    setText(value)
    setHistoryAt(null)
    command.track(value, caret)
    if (commandQuery(value, caret) === null) mention.track(value, caret)
    else mention.close()
  }

  const sendable = text.trim() !== '' || attachments.length > 0
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

  /**
   * 当前模型能不能吃图片。模型清单里查不到（`entry` 为 undefined）时**不拦**：
   * 清单没取到（老宿主 / 刚启动）时误伤，比放过去由宿主校验更糟。
   * 视频也要这道门：视频会抽成图片一起带给模型。
   */
  const imageInputAllowed = current.entry === undefined || current.entry.modalities.includes('image')

  /**
   * 加一个文件：先插上传占位（带进度），再异步规范化 / 上传；视频传完再抽帧并上传。
   *
   * 失败路径统一收口：摘掉占位、释放本机预览地址、把原因写进 fault——不留一个永远转圈的
   * 条目。抽帧失败不算失败（`extractVideoFrames` 自己吞错、返回已拿到的帧）。
   */
  const addOneFile = async (file: File, kind: AttachmentKind): Promise<void> => {
    const id = newAttachmentId()
    const name = displayNameOf(file, kind)
    const localUrl = URL.createObjectURL(file)
    const placeholder: DraftAttachment = {
      id,
      kind,
      name,
      mime: file.type,
      bytes: file.size,
      meta: null,
      previewUrl: localUrl,
      localUrl,
      frames: [],
      uploading: 0,
      error: null,
    }
    setAttachments((list) => [...list, placeholder])
    try {
      const payload = kind === 'image' ? await normalizeImage(file) : file
      const meta = await uploadFile(payload, name, (ratio) => {
        updateAttachment(id, { uploading: ratio })
      })
      updateAttachment(id, { meta, previewUrl: meta.url, uploading: null, localUrl: undefined })
      URL.revokeObjectURL(localUrl)
      if (kind !== 'video') return
      const frames = await extractVideoFrames(meta.url, 6)
      const base = name.replace(/\.[^.]+$/, '')
      const urls: string[] = []
      for (const [index, frame] of frames.entries()) {
        try {
          const frameMeta = await uploadFile(frame, `${base}-帧${String(index + 1)}.jpg`)
          urls.push(frameMeta.url)
          updateAttachment(id, { frames: [...urls] })
        } catch {
          // 单帧失败不挡消息：视频本体与已经抽到的帧照常带出去。
        }
      }
    } catch (reason) {
      URL.revokeObjectURL(localUrl)
      setAttachments((list) => list.filter((item) => item.id !== id))
      patchDraftsAttachment(id, null)
      setFault(`上传失败：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  /**
   * 接一批文件（粘贴的截图、拖进来的文件都走这里）：图片 / 视频 / 其余各归各的，
   * 按当前模型的能力门先挡一道，再逐个进 {@link addOneFile}。
   */
  const addFiles = (files: readonly File[]): void => {
    if (files.length === 0) return
    setFault(null)
    let rejected = false
    for (const file of files) {
      const kind = kindOf(file)
      if (kind !== 'file' && !imageInputAllowed) {
        rejected = true
        continue
      }
      void addOneFile(file, kind)
    }
    if (rejected) setFault('当前模型不支持图片，请切换支持图片的模型')
  }

  const chip = modelChipText(groups, provider, model)
  const twoLevel = shouldShowProviderLevel(groups)
  /** 飞出卡画谁家的模型：鼠标停着的那一家；没停（或它没在了）就只有一级那一列。 */
  const hoveredGroup = groups.find((item) => item.provider === hoverProvider)
  const visibleModels = twoLevel
    ? (hoveredGroup?.models ?? [])
    : (groups[0]?.models ?? [])
  /**
   * 飞出卡渲染不渲染（也是「面板现在展示的是哪一级」的唯一真值）。
   *
   * `side === 'overlay'` 时它**盖住一级**，所以样式要据此把端点那一列藏起来——不藏的话
   * 卡片（它是透明的，为的是看着就是面板本来的样子）会让底下的端点行透上来，两列字叠在一起。
   */
  const flyoutShown = twoLevel && flyout !== null && hoveredGroup !== undefined
  // 档位清单：模型查得到就用它声明的，查不到给兜底——不锁死用户。
  // 「默认」不画进滑杆（2026-10-26 用户定的：它不是刻度上的位置，摆进去会被当成真实档位），
  // 所以这里先把它滤掉；滤完一档都不剩（模型没有思考开关）就退回单档 chip，不给浮层。
  const levelOptions = effortChoices(current.entry)
  const sliderLevels = levelOptions.filter((level): level is EffortLevel => level !== 'default')
  const switchEffort = sliderLevels.length > 0
  /** 界面显示哪个档位：乐观值优先（见 pendingEffort 的注释），宿主确认后回到宿主读数。 */
  const shownEffort = pendingEffort ?? effort
  const effortText = effortLabel(shownEffort)
  /**
   * 选档：只有这一处发请求（拖动中不发）。先落乐观值再发，界面不用等一个来回；
   * 宿主拒绝时把乐观值撤掉并把原因写进 chip 下面那行 fault。
   */
  const commitEffort = (level: EffortLevel): void => {
    setPendingEffort(level)
    setFault(null)
    // 第二个实参 quiet=true：滑杆调档不往对话里写「思考强度设为…」，也就少推一帧。
    void channel.invoke('setEffort', [level, true]).catch((reason: unknown) => {
      setPendingEffort(null)
      setFault(reason instanceof Error ? reason.message : String(reason))
    })
  }

  /**
   * 会裁掉浮层的那个祖先盒子的横向区间：往上找第一个 `overflow-x` 不是 `visible` 的（实测是
   * `.thread-main`）。为什么不用视口当判据：飞出卡越出它就被裁成半张，模型名前缀直接看不见。
   */
  const clipBoxOf = (el: HTMLElement): { left: number; right: number } => {
    let node: HTMLElement | null = el.parentElement
    while (node !== null) {
      if (getComputedStyle(node).overflowX !== 'visible') {
        const box = node.getBoundingClientRect()
        return { left: Math.max(0, box.left), right: Math.min(window.innerWidth, box.right) }
      }
      node = node.parentElement
    }
    return { left: 0, right: window.innerWidth }
  }

  /**
   * 悬浮（或 Tab 到、或点）一级某一行时：量一次面板与那一行的位置，决定飞出卡摆哪、多高。
   *
   * 为什么是量而不是 CSS：面板右缘对齐模型 chip，chip 宽度随模型名长短变、窗口宽度可拖，
   * 「两边各还剩多少」只有拿到 rect 才知道（ZCode 那边同样是 Radix 拿实测 rect 挑边）。
   * 量到的两个数写进 CSS 变量（`--flyout-top` / `--flyout-max`），样式只做展示。
   */
  const openFlyout = (providerName: string, row: HTMLElement | null): void => {
    setHoverProvider(providerName)
    const panel = modelPanelRef.current
    if (panel === null || row === null) return
    const panelBox = panel.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    setFlyoutSide(
      chooseFlyoutSide(
        { left: panelBox.left, right: panelBox.right },
        clipBoxOf(panel),
        FLYOUT_WIDTH,
      ),
    )
    // 高度上限先按面板本身给（卡片内容的自然高下一步在同一帧里量出来再修正）。
    setFlyout(
      placeFlyout(
        rowBox.top - panelBox.top,
        rowBox.bottom - panelBox.top,
        panelBox.height,
        Number.POSITIVE_INFINITY,
      ),
    )
  }

  /**
   * 飞出卡渲染出来之后，拿它内容的**自然高**把位置与上限修正一遍。
   *
   * 为什么必须修：`openFlyout` 那一步卡片还没进 DOM，只能用「无穷高」先占位，于是夹取退化成
   * 「对齐那一行」；卡片真高出来之后，靠近面板底部的那几行会把卡片推出面板底边——面板底边
   * 只离输入行 10px，推出去就盖住输入框。`useLayoutEffect` 在绘制前跑完，所以这一修不带闪烁。
   */
  useLayoutEffect(() => {
    if (hoverProvider === null) return
    const panel = modelPanelRef.current
    const card = flyoutCardRef.current
    if (panel === null || card === null) return
    const row = panel.querySelector<HTMLElement>(`[data-model-provider="${CSS.escape(hoverProvider)}"]`)
    if (row === null) return
    const panelBox = panel.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const next = placeFlyout(
      rowBox.top - panelBox.top,
      rowBox.bottom - panelBox.top,
      panelBox.height,
      card.scrollHeight,
    )
    setFlyout((prev) =>
      prev !== null && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next,
    )
  }, [hoverProvider, models.length, flyoutSide, measureTick])

  /**
   * 面板开着时盯着「会改变它位置的东西」：窗口缩放、面板自身宽高变化（两套宽度就在这儿切）。
   *
   * `ResizeObserver` 而不是只听 `resize`：面板从 `flat`（264）换成两级（320）时窗口没动，
   * 只有盒子变了，只听窗口事件接不到这一拍。
   */
  useLayoutEffect(() => {
    if (!modelOpen) return undefined
    const panel = modelPanelRef.current
    if (panel === null) return undefined
    const bump = (): void => {
      setMeasureTick((tick) => tick + 1)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(bump)
    observer?.observe(panel)
    window.addEventListener('resize', bump)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', bump)
    }
  }, [modelOpen])

  /**
   * 面板开着的期间随时把它推回正文列里（窄屏输入行换行时 chip 可能贴在很左边）。
   *
   * `useLayoutEffect` 而不是 `useEffect`：推之前在绘制前算完，不然会先闪一帧「半张面板在视口外」。
   */
  useLayoutEffect(() => {
    if (!modelOpen) return
    const panel = modelPanelRef.current
    if (panel === null) return
    const box = panel.getBoundingClientRect()
    // 量到的是**已经平移过**的位置：先减掉已施加的量再夹，否则每一拍都会把上一拍的平移
    // 当成「现在放得下」，平移被自己抵消、面板在两帧之间来回跳（重量一开必现）。
    const raw = { left: box.left - shiftRef.current, right: box.right - shiftRef.current }
    const shift = clampShift(raw, clipBoxOf(panel))
    shiftRef.current = shift
    setPanelShift((prev) => (prev === shift ? prev : shift))
  }, [modelOpen, models.length, twoLevel, measureTick])

  /**
   * 展开模型菜单时把当前项滚进视野（照分支菜单同款）。
   *
   * 为什么必须有：模型一多，当前那一条可能落在滚动区外面——「打开菜单看得见自己选的是谁」
   * 正是这次要修的东西，光打勾不够（勾在屏幕外等于没打）。
   */
  useEffect(() => {
    if (!modelOpen) return
    if (hoverProvider === null) return
    modelRows.current?.querySelector<HTMLElement>('[data-model-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [modelOpen, hoverProvider, models.length])

  /**
   * 模型行（飞出卡与「只有一个端点」的扁铺面板**共用同一份渲染**，不写两遍）。
   *
   * 行里四样东西都有用：模型名（身份）、能力徽标（图/视频）、上下文（256k）、当前那条的勾。
   */
  const modelRowList = (choices: readonly ModelChoiceView[]): ReactNode => {
    if (choices.length === 0) {
      return (
        <div className="pop-item">
          <span className="name">{models.length === 0 ? '清单没取到' : '这个端点还没有模型'}</span>
        </div>
      )
    }
    return choices.map((choice) => {
      const on = current.entry?.value === choice.value
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={on}
          key={choice.value}
          className={`pop-item model-picker-row${on ? ' on' : ''}`}
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
          {/* 勾**始终占着那一格**（不是当前行才长出来）：读数这一列的右边界由它撑着，
              上下一对齐才不会因为「多了一个勾」整体错开一格。 */}
          <span className="model-picker-check">{on ? <IconCheck size={14} className="check" /> : null}</span>
        </button>
      )
    })
  }

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
      : '发消息，@ 引用文件，可贴图 / 拖图片、视频或文件进来，回车发送，Ctrl+Enter 插话'

  return (
    // 这一层是「输入框外面那一列」：分支行在上、输入框在下，各占一行、各带自己的边。
    // 为什么不让分支行长在 `.composer` 里（原来就是）：`.composer` 是带描边和圆角的
    // 输入框本体，住在里面的东西会被同一个外框一起圈住，分支钮看着就成了输入框的一部分
    // （用户报「git 管理按钮，需要与输入框作出区分」）。参考实现里这一行也在输入框上方的
    // 框外。`.composer-zone` 的「与正文列同宽」打在插件根节点上，所以这一层要接住它。
    <div className="composer-stack" style={{ marginTop: 10 }}>
      {/* 分支控制（输入框上方那一行）：读数 / 开关 / 写口都在 branch-menu.tsx。 */}
      <BranchMenu
        open={branchOpen}
        onOpenChange={(open) => {
          setBranchOpen(open)
          if (!open) return
          // 四张浮层互斥：开这一张就把别的收掉（旧界面同款）。
          setPermOpen(false)
          setPresetOpen(false)
          setModelOpen(false)
          setEffortOpen(false)
        }}
        git={git}
        channel={channel}
        onFault={setFault}
      />

      {/* 输入框本体：这一层的描边 + 圆角说的才是「这里可以打字」。贴图 / 拖文件那三个
          事件挂在它上面（不在外层那一列上）：命中面就是看得见的那个框。 */}
      <div
        className="composer"
        // 点框内那圈内边距、或输入区与底栏之间的缝，也算「点输入框」：文字区上面那条
        // 10px 内边距原来点了什么都不发生，手指会再往旁边那颗钮上摸一次——手机上这就是
        // 误触的来源（2026-10-15 报障）。命中按钮与浮层时不动：它们自己管自己，
        // 抢焦点会把刚点开的菜单收掉。文字区本身不用管（原生就聚焦）。
        onClick={(event) => {
          const target = event.target as HTMLElement | null
          if (target !== null && target.closest('button, textarea, input, .model-pop, .pop-mask') !== null) return
          area.current?.focus()
        }}
        onPaste={(event) => {
          // 截图粘贴就是 `clipboardData.files` 里的一个 PNG；有多张也一并接。
          const files = Array.from(event.clipboardData.files)
          if (files.length === 0) return
          // 有文件时不要再让浏览器把「文件名文本」插进输入框。
          event.preventDefault()
          addFiles(files)
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files)
          setDragOver(false)
          if (files.length === 0) return
          event.preventDefault()
          addFiles(files)
        }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragOver(true)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(event) => {
          // 从输入框移到它内部某个子节点不算离开（否则拖过文字区就会闪一下）。
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          setDragOver(false)
        }}
        data-drag={dragOver ? '1' : undefined}
      >
        {/* 待发附件：贴在 textarea 上方、`/` 与 `@` 浮层下方的一条横向滚动卡片。
            只写结构，尺寸 / 间距 / 圆角归壳的 `styles.css`（主控统一写）。 */}
        {attachments.length === 0 ? null : (
          <div className="composer-attachments" aria-label="待发送的附件">
            {attachments.map((item) => (
              <div
                className="attach-item"
                key={item.id}
                data-kind={item.kind}
                data-uploading={item.uploading !== null ? '1' : undefined}
              >
                {item.kind === 'file' ? (
                  <div className="attach-file">
                    <IconPackage size={14} />
                    <span className="attach-name" title={item.name}>
                      {item.name}
                    </span>
                    <span className="attach-bytes">{formatBytes(item.bytes)}</span>
                  </div>
                ) : (
                  <>
                    <div className="attach-thumb">
                      {item.kind === 'image' ? (
                        <img src={item.previewUrl} alt={item.name} />
                      ) : (
                        <video
                          muted
                          playsInline
                          preload="metadata"
                          src={item.previewUrl}
                          aria-label={item.name}
                        />
                      )}
                    </div>
                    <span className="attach-name" title={item.name}>
                      {item.name}
                    </span>
                    <span className="attach-bytes">{formatBytes(item.bytes)}</span>
                    {item.frames.length === 0 ? null : (
                      <span className="attach-hint">{item.frames.length} 帧</span>
                    )}
                  </>
                )}
                {item.uploading === null ? null : (
                  <span className="attach-progress" aria-hidden="true">
                    <span style={{ width: `${String(Math.round(item.uploading * 100))}%` }} />
                  </span>
                )}
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`移除 ${item.name}`}
                  title={`移除 ${item.name}`}
                  onClick={() => {
                    removeAttachment(item.id)
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

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

        {/* `/` 命令候选面板：与 @ 提及同一块位置（输入框上方），两者不会同时开。 */}
        {command.open ? (
          <div className="slash-pop" role="listbox" aria-label="命令候选">
            {command.loading ? (
              <div className="slash-item" data-loading="1">
                正在读取命令清单…
              </div>
            ) : command.rows.length === 0 ? (
              <div className="slash-item" data-empty="1">
                没有匹配的命令
              </div>
            ) : (
              command.rows.map((row, index) => {
                const off = blockedNow(row, working)
                return (
                  <button
                    type="button"
                    key={row.name}
                    role="option"
                    aria-selected={index === command.at}
                    className={`slash-item${index === command.at ? ' on' : ''}${off ? ' off' : ''}`}
                    title={row.description}
                    onMouseDown={(event) => {
                      // mousedown 而不是 click：抢在 textarea 失焦之前把候选插进去。
                      event.preventDefault()
                      command.pick()
                    }}
                  >
                    <span className="slash-name">/{row.name}</span>
                    {row.args === '' ? null : <span className="slash-args">{row.args}</span>}
                    <span className="slash-desc">{row.description}</span>
                    {off ? <span className="slash-flag">回合中不可用</span> : null}
                  </button>
                )
              })
            )}
            <div className="slash-hint">↑↓ 选 · Tab 补全 · Enter 执行 · Esc 关闭</div>
          </div>
        ) : null}

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
            {/* 权限 / 模式 / 档位三颗的浮层在手机上是一块**贴住输入卡片**的面板（`model-anchor-sheet`，
                见 styles.css 的窄屏段）：它们原来锚在自己那颗 chip 上（右缘对齐），手机上 chip 排在
                行中间，300/320px 的面板会探出屏幕左缘、行文字被裁成只剩尾字。模型那颗不挂这个类——
                它有自己一套窄面板 + 悬浮飞出。 */}
            <div className="model-anchor model-anchor-sheet">
              <button
                type="button"
                className={`model-btn${permOpen ? ' open' : ''}`}
                data-tip={
                  permOption?.description ?? '当前三项旋钮的组合不匹配任何预设；在设置里逐格改出来的状态'
                }
                aria-haspopup="menu"
                aria-expanded={permOpen}
                /* 手机档只画图标（styles.css ≤560 把文字藏掉），所以当前档位读什么要靠这条：
                   文字被 CSS 藏起来之后，读屏与 aria-label 是仅剩的两条解释。 */
                aria-label={`权限预设：${permOption?.label ?? '自定义'}`}
                onClick={() => {
                  setPermOpen((open) => !open)
                  setPresetOpen(false)
                  setModelOpen(false)
                  setEffortOpen(false)
                  setBranchOpen(false)
                }}
              >
                <IconShield size={13} />
                <span className="chip-label">{permOption?.label ?? '自定义'}</span>
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
            <div className="model-anchor model-anchor-sheet">
              <button
                type="button"
                className={`model-btn${presetOpen ? ' open' : ''}`}
                data-tip={presetOption?.problem ?? presetOption?.description ?? '模式：模型是谁、手上有什么、被叮嘱了什么'}
                aria-haspopup="menu"
                aria-expanded={presetOpen}
                aria-label={`模式：${presetOption?.label ?? preset.current}`}
                onClick={() => {
                  setPresetOpen((open) => !open)
                  setPermOpen(false)
                  setModelOpen(false)
                  setEffortOpen(false)
                  setBranchOpen(false)
                }}
              >
                <IconLayers size={13} />
                <span className="chip-label">{presetOption?.label ?? preset.current}</span>
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
                    {/* 这里原来挂着「新建/编辑：设置 → 模式」——一句话把菜单顶行撑满，又
                        让读者以为要跳去设置页才改得动。删掉：新建/编辑模式本来就是设置页的事，
                        菜单只回答「现在用哪一档」。 */}
                    <div className="pop-label">模式</div>
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
                  // 每次开都是「只有一级那一列」的干净态（上次悬浮停在哪家不该带过来）。
                  setHoverProvider(null)
                  setFlyout(null)
                  shiftRef.current = 0
                  setPanelShift(0)
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
                  <div
                    className={`model-pop model-picker${twoLevel ? '' : ' flat'}`}
                    role="menu"
                    aria-label="选择模型"
                    ref={modelPanelRef}
                    data-flyout-side={flyoutShown ? flyoutSide : undefined}
                    style={
                      panelShift === 0 ? undefined : ({ transform: `translateX(${String(panelShift)}px)` } as CSSProperties)
                    }
                    onMouseLeave={() => {
                      // 指针离开整张面板（飞出卡也是它的子节点，所以移进卡片不算离开）：
                      // 收起飞出卡，回到「只有一级那一列」——对照 ZCode 不悬浮就没二级。
                      setHoverProvider(null)
                      setFlyout(null)
                    }}
                  >
                    {/* 当前模型不在清单里时先说清楚（端点配置改过、或这条会话记住的模型下线了）：
                        否则用户只看到一片「一条都不打勾」的清单，不知道是谁不对。 */}
                    {current.entry === undefined && model !== '' ? (
                      <div className="pop-item model-unknown" data-model-unknown="true">
                        <span className="name">当前：{model} —— 清单里没有这个模型</span>
                      </div>
                    ) : null}
                    <div className="model-picker-body">
                      {twoLevel ? (
                        <div
                          className="model-providers"
                          data-model-providers=""
                          /* 滚过之后那一行的位置变了，重量一次卡片才还贴着它。 */
                          onScroll={() => {
                            if (hoverProvider === null) return
                            const row =
                              modelPanelRef.current?.querySelector<HTMLElement>(
                                `[data-model-provider="${CSS.escape(hoverProvider)}"]`,
                              ) ?? null
                            openFlyout(hoverProvider, row)
                          }}
                        >
                          {groups.length === 0 ? (
                            <div className="pop-item">
                              <span className="name">清单没取到</span>
                            </div>
                          ) : (
                            groups.map((group) => {
                              const owns = current.group?.provider === group.provider
                              const hint = providerHint(group, current)
                              return (
                                <button
                                  type="button"
                                  role="menuitem"
                                  aria-current={owns}
                                  key={group.provider}
                                  className={`pop-item provider-row${group.provider === hoverProvider ? ' on' : ''}`}
                                  data-model-provider={group.provider}
                                  data-provider-current={owns ? 'true' : undefined}
                                  title={
                                    hint === ''
                                      ? `${group.displayName} · ${String(group.models.length)} 个模型`
                                      : `${group.displayName} · 当前 ${hint}`
                                  }
                                  /* 悬浮即飞出（不延迟：一级就几个端点，抖动风险不值得一个计时器）；
                                     键盘 Tab 到与手指点一下都走同一条路——触摸屏没有悬浮，
                                     只认悬浮就等于手机上一级点不开二级。 */
                                  onMouseEnter={(event) => {
                                    openFlyout(group.provider, event.currentTarget)
                                  }}
                                  onFocus={(event) => {
                                    openFlyout(group.provider, event.currentTarget)
                                  }}
                                  onClick={(event) => {
                                    openFlyout(group.provider, event.currentTarget)
                                  }}
                                >
                                  <span className="name">{group.displayName}</span>
                                  <span className="model-picker-check">{owns ? <IconCheck size={13} className="check" /> : null}</span>
                                  <IconChevronRight size={12} className="provider-arrow" />
                                </button>
                              )
                            })
                          )}
                        </div>
                      ) : (
                        modelRowList(visibleModels)
                      )}
                    </div>
                    {/* 飞出卡：**面板的子节点**而不是另挂一份浮层——`mouseleave` 认 DOM 层级，
                        所以鼠标从厂商行横穿到卡片上不会把卡片关掉，不需要任何延迟计时器。
                        「盖住」那一档（`overlay`）不进绝对定位，而是**就地占位**：端点列已经藏了，
                        卡片就是面板此刻的内容——面板自己会按它长高，`管理模型` 仍留在下面，
                        也不需要任何量出来的位置。 */}
                    {flyoutShown ? (
                      <div
                        className={`model-flyout${flyoutSide === 'overlay' ? ' model-flyout-inline' : ''}`}
                        data-model-flyout=""
                        data-side={flyoutSide}
                        style={
                          flyoutSide === 'overlay'
                            ? undefined
                            : ({
                                '--flyout-top': `${String(flyout.top)}px`,
                                '--flyout-max': `${String(flyout.maxHeight)}px`,
                                '--flyout-w': `${String(FLYOUT_WIDTH)}px`,
                              } as CSSProperties)
                        }
                      >
                        <div
                          className="model-flyout-card"
                          role="menu"
                          aria-label={`${hoveredGroup.displayName} 的模型`}
                          ref={flyoutCardRef}
                        >
                          <div className="model-picker-rows" data-model-rows="" ref={modelRows}>
                            {modelRowList(visibleModels)}
                          </div>
                        </div>
                      </div>
                    ) : null}
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

            {/* 思考档位 chip：读数取 status.effort（**不依赖模型清单**），所以清单过期也不会
                显示错；刚点下去那一小段用乐观值顶（见 pendingEffort），免得数字先弹回去再跳过来。
                档位清单里不再摆「默认」（它不是刻度上的位置，见 ./effort-slider 的文件头）。
                单档模型不给浮层、也不给箭头。 */}
            {switchEffort ? (
              <div className="model-anchor model-anchor-sheet">
                <button
                  type="button"
                  className={`model-btn composer-effort-chip${effortOpen ? ' open' : ''}`}
                  title={`思考强度：${effortText}（点开换档）`}
                  aria-haspopup="menu"
                  aria-expanded={effortOpen}
                  aria-label={`当前思考强度 ${effortText}`}
                  data-composer-effort={shownEffort}
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
                    {/* 滑杆卡（2026-10-26 换掉原来那一列按钮）：档位有顺序，滑杆把顺序画出来。
                        选完不关卡片：拖着扫档时关掉，等于每试一档都要重开一次。 */}
                    <div className="model-pop effort-pop" role="group" aria-label="思考强度">
                      <EffortSlider
                        levels={sliderLevels}
                        value={shownEffort}
                        note={
                          current.entry === undefined && model !== ''
                            ? '模型不在清单里，列的是它声明的全部档位'
                            : null
                        }
                        onCommit={commitEffort}
                      />
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
