/**
 * 内置插件：输入区（对照旧桌面界面 `Composer.tsx` + `queue-dock.tsx`）。
 *
 * 一个插件注册两个条目，因为旧界面里它们本来就是兄弟节点、只是上下相邻：
 *   - `composer.queue`（order 45）：排队消息条，排在输入框**上面**（用户 2026-11-06 指定：
 *     排队是「还没发出去的草稿」，要贴着输入框、在它上沿，不能压到下面去）；
 *   - `composer.box`（order 50）：输入框 + 底栏旋钮 + 发送/打断。
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
 * **模型与思考强度是同一颗 chip + 一张两行卡**（2026-11-06 用户指定，照 dsh 的 composer）。
 * 0.6.71 那一版是两颗各自弹浮层（对照 ZCode 的 `V4ComposerToolbar`）；再往前是一颗带合并浮层，
 * 上半排档位按钮、下半模型平铺清单——用户报「看不出来当前选的是哪个模型、哪一档」，底下压着
 * 三处真错（档位漏了「默认」那档、打勾拿 `value === 裸模型名` 判、清单只在挂载时取一次），
 * 逐条记在 `./model-picker.ts` 的模块注释里。合并之后 chip 读两个读数（`模型名  档位 ⌄`），
 * 点开是两行卡：点「模型」进两级菜单、点「推理等级」进档位滑杆——二级一个没少，底栏只占一格。
 * **所有判定都在那个纯模块里**，这里只画：探针读不了 `.tsx`，读得了那份零依赖的 `.ts`。
 *
 * 样式与 class 名照抄旧版（`src/packages/ui-renderer/ui/styles/legacy/views.css`，行号同旧 `styles.css`）：
 * `.composer` 2225、`.composer-bar` 2259、`.bar-left/.bar-right` 2266/2301、`.model-anchor`
 * 2309、`.model-btn` 2314、`.model-pop` 2347、`.model-list/.pop-item` 2410-2464、
 * `.send-btn` 2468、`.queue-dock` 2519 起。合并 chip、两行卡与两级菜单的新样式在壳的 `styles.css`
 * 里（`styles.css` 打的是 `.composer-model-chip` / `.model-sheet` / `.model-picker` /
 * `.model-providers` / `.model-flyout` … 那几个新类名；**别复用已经退役的 `.model-chip`**——那是
 * 模型设置页上一版端点卡里的东西，`scripts/ui-models-page-test.mjs` 有一条闸不许它回来）。
 *
 * @module dsc-ui-shell/plugins/composer
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconArrowUp, IconCheck, IconChevronDown, IconClose, IconLayers, IconPackage, IconShield, IconStop } from '@dsc/ui'
import {
  createT,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
} from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import { formatBytes, ImageLightbox, readTurnState, sameGitSurface as sameGit } from '@dsc/ui-primitives'
import { useMention } from './mention'
import { useCommandMenu } from './command-menu'
import { blockedNow, commandQuery } from './commands'
import { commandGlyph } from './command-face'
import { carryDraft, draftScopeOf, type ComposerDraft } from './draft'
import {
  composeSubmit,
  displayNameOf,
  extractVideoFrames,
  kindOf,
  MAX_IMAGES,
  newAttachmentId,
  normalizeImage,
  uploadFile,
  type AttachmentKind,
  type DraftAttachment,
} from './attachments'
import { BranchMenu } from './branch-menu'
import { useModelControls } from './model-controls'
import { NoticeStrip } from './notice-strip'
import { QueueDock } from './queue-dock'
import { readAcceptsInput, readDraftCwd, readGit, readHasApproval, readInboxCount, readPermissionPresets, readPresetSurface, readSessionId, readSessionPath, readSessionUnsaved, samePermissionPresets, samePresetSurface } from './surfaces'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 宿主说「这个界面方法不在放行表里」时用的原话。
 *
 * 这是**数据比对**，不是界面文案：宿主发的是中文原文，与界面语言无关，所以两种写法都认
 * （英文界面下 `t()` 给的是译文，对不上宿主那一句）。
 */
const PROTOCOL_DENIED_MARKS: readonly string[] = [t('error.protocolDenied'), zh['error.protocolDenied']]

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

/**
 * 进程内的草稿存档：切换会话时换入换出（规则见 `./draft`），组件卸载时也留得住。
 *
 * 为什么放模块级而不是组件的 `useRef`：输入区会随页面切换被卸载重挂（点侧栏的「技能」
 * 「插件」再回来就是一次），而正文、历史、待发附件都只活在组件 state 里——一卸载就没了。
 * 用户报障「新会话里打了一半的话，去别的页面看一眼回来就空了」就是这条路。
 *
 * 只活在进程里：刷新页面（重新加载 webview）不恢复，用户 2026-10-29 明确说先不做跨重启。
 */
const DRAFT_STORE = new Map<string, ComposerDraft>()

export default defineUiPlugin({
  name: t('plugin.name'),
  apply(ui) {
    // 首屏能力卡的落点：只做「写字 + 聚焦」，不发送——发不发送仍由用户按回车决定。
    ui.provide('composerDraft', {
      insert: (text: string): void => {
        insertDraft?.(text)
      },
    })
    // 一条带从下往上排：输入框（50）在最底，排队条（45）紧贴它上沿，待投递通知条（40）再往上；
    // 审批/提问/计划三张卡（10-40）在最上面。排队条必须在输入框上面（用户 2026-11-06 指定），
    // 否则「还没发出去的草稿」被压到输入框下方，看着像已经发出去了。
    ui.slots.register('shell.composer', { id: 'composer.notices', order: 40 }, NoticeStrip)
    ui.slots.register('shell.composer', { id: 'composer.queue', order: 45 }, QueueDock)
    ui.slots.register('shell.composer', { id: 'composer.box', order: 50 }, ComposerBox)
    // 模式（预设）那颗 2026-11-06 从输入区底栏搬到**会话标题旁**（用户指定）：底栏让给「输入」
    // 这件事本身。order 10——排在「智能体团队」钮（同槽 order 20）前面：标题旁从左到右读作
    // 「新会话 · 标准模式 · 智能体团队」，模式贴着会话名，团队靠着右缘（用户 2026-11-06 指定）。
    ui.slots.register('shell.header.lead', { id: 'composer.preset', order: 10 }, PresetChip)
  },
})

function ComposerBox(): ReactNode {
  const channel = useHostChannel()
  const turnState = useHostSelector(readTurnState)
  const blocked = useHostSelector(readHasApproval)
  const queuedCount = useHostSelector(readInboxCount)
  const permissionPresets = useHostSelector(readPermissionPresets, samePermissionPresets)
  const git = useHostSelector(readGit, sameGit)
  const draftKey = useHostSelector(readSessionPath)
  /**
   * 这条会话有没有能接住输入的一方（2026-11-19）：收工的队友、一次性的子智能体没有。
   * 读到 false 时整张输入卡片换成一行说明（下面 render 里那条早返回）——不给一个
   * 「敲完发现被吞」的输入框。
   */
  const acceptsInput = useHostSelector(readAcceptsInput)

  const [text, setText] = useState('')
  const [fault, setFault] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  /** 待发附件（上传中带进度，上传完带宿主引用；会话切换时随草稿一起搬运）。 */
  const [attachments, setAttachments] = useState<readonly DraftAttachment[]>([])
  /** 有文件悬在 `.composer` 上方（拖拽高亮走 `data-drag`，样式由壳统一写）。 */
  const [dragOver, setDragOver] = useState(false)
  /**
   * 正在放大查看的那张贴图。贴图是 dataURL，浏览器不许顶层跳 `data:`，
   * 所以只能自己开浮层——组件在 `ui-primitives/image-lightbox`。
   */
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  // 权限预设这根旋钮的浮层：与模型/档位合体的那一张、分支菜单互斥（开一根把其余的收掉，旧界面同款）。
  const [permOpen, setPermOpen] = useState(false)
  // 分支菜单（输入框上方那一行那颗钮）：与上面两根旋钮的浮层互斥，同一时刻只开一个。
  const [branchOpen, setBranchOpen] = useState(false)

  // 模型 / 思考档位（一颗合并 chip + 三层浮层）：状态仍住在这个组件里，代码在 model-controls.tsx。
  const controls = useModelControls({
    channel,
    onFault: setFault,
    onTakeOver: () => {
      setPermOpen(false)
      setBranchOpen(false)
    },
  })

  /**
   * 顶栏那颗模式（预设）钮不在这个组件里：它打开时要收掉输入区这几张浮层——「同一时刻只开
   * 一张」这条口径跨了组件，只能走窗口事件（与 `shell.settings.open` 同一条先例）。
   *
   * 监听只挂一次，回调经 ref 取最新一版（首帧的闭包会把当时的 state 钉死）。
   */
  const closePops = useRef<() => void>(() => undefined)
  useEffect(() => {
    closePops.current = (): void => {
      setPermOpen(false)
      setBranchOpen(false)
      controls.close()
    }
  })
  useEffect(() => {
    const onPresetOpen = (): void => {
      closePops.current()
    }
    window.addEventListener('shell.preset.open', onPresetOpen)
    return () => {
      window.removeEventListener('shell.preset.open', onPresetOpen)
    }
  }, [])

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
  const drafts = useRef(DRAFT_STORE)
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
   * 挂回来时先捡回进程存档里那一份（只捡一次）。
   *
   * 与下面那条「随打随存」配对：卸载时 state 没了，存档还在；重挂时用存档还原正文、
   * 历史与待发附件。之后一律以输入框为准，不再回读——否则用户删掉的字符会被存档拽回来。
   */
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const key = draftScopeRef.current.key
    if (key === '') return
    const saved = DRAFT_STORE.get(key)
    if (saved === undefined) return
    setText(saved.value)
    history.current = [...saved.history]
    setAttachments([...(saved.attachments ?? [])])
    // 只在这一个组件实例的第一次提交后跑：draftScope / setText 都是稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 随打随存：每次正文或附件变化都往进程存档写一份。
   *
   * 必须在「换会话」那段**之前**声明——effect 按声明顺序跑，换会话那一拍要先按**旧**归属
   * 存下旧草稿（`draftScopeRef.current` 还没更新），再让 carryDraft 搬运。顺序反过来，
   * 旧正文会先被写进新会话那一格。
   */
  useEffect(() => {
    const key = draftScopeRef.current.key
    if (key === '') return
    DRAFT_STORE.set(key, { value: text, history: history.current, attachments })
  }, [text, attachments])

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
    // 要收输入的命令（`/review`）：回车只把 `/<名字> ` 补进输入框并给一行提示，**不执行**。
    // 用户接着写要求，再按一次回车才带着要求跑。带附件时不走这条路：命令没有图可带，
    // 用户贴了图就是在发内容（与下面那条规矩一致）。
    const claim = attachments.length === 0 ? command.claim(value) : null
    if (claim !== null) {
      setFault(null)
      command.adopt(claim.insert)
      return
    }
    // 带附件时不走命令：命令没有图可带，用户贴了图就是在发内容（与旧界面 App.tsx 同一条规矩）。
    if (value.startsWith('/') && attachments.length === 0) {
      // 回车就是「我要跑这一条」：候选面板当场收起。以前只清文本、不收面板，于是
      // 命令已经执行了、面板还挂在输入框上方等下一句（2026-10-27 报障第一条）。
      command.hide()
      // 命令走界面通道的受限派发 `runUiCommand`：能跑的名字钉在宿主那份 `shell: true`
      // 清单上（见宿主 packages/commands-core/commands-completion.ts），清单外的名字由宿主明确报错。
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
            PROTOCOL_DENIED_MARKS.some((mark) => message.includes(mark))
              ? t('error.commandUnsupported')
              : message,
          )
        })
      return
    }
    // 还有附件在传：这一刻发出去只能发个半成品，明确拦下。
    if (attachments.some((item) => item.uploading !== null)) {
      setFault(t('error.uploading'))
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
          if (done !== true) setFault(t('error.steerMissed'))
        }
        setText('')
        clearDraftAttachments()
        if (payload.dropped > 0) {
          setFault(t('error.imageLimit', { max: MAX_IMAGES, dropped: payload.dropped }))
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
      setFault(t('error.presetNativeOnly'))
      return
    }
    void native
      .invoke('usePermissionPreset', [name])
      .then(() => {
        toastOk(t('toast.presetSwitched', { label }))
      })
      .catch((reason: unknown) => {
        setFault(t('error.presetFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
      })
  }

  /**
   * 切模式（预设）：走界面通道的 `usePreset`（它在放行面里——切模式不碰安全闸门，
   * 只换提示词与工具白名单）。**2026-11-06 起这段搬进顶栏那颗 `PresetChip`**：
   * 钮已经不在这个组件里，浮层与写口跟着它走（同一个写口、同一句回执）。
   */


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
      setFault(t('error.commandChannel'))
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
  /**
   * 输入框下方的「这条命令要收一段输入」提示：只有当前输入正好是这种命令、且还没写参数
   * 时才有（宿主给的 `hint`，壳不自己编文案）。
   */
  const inputHint = command.claim(text)?.hint ?? null
  const queueing = working && sendable
  /** 当前预设那一项（拿它的 label / description）；`custom`（旋钮拼不出任何预设）或清单缺了时为 undefined。 */
  const permOption = permissionPresets.options.find((item) => item.name === permissionPresets.current)


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
          const frameMeta = await uploadFile(frame, t('attach.frameName', { base, index: index + 1 }))
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
      setFault(t('error.uploadFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
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
      if (kind !== 'file' && !controls.allowImage) {
        rejected = true
        continue
      }
      void addOneFile(file, kind)
    }
    if (rejected) setFault(t('error.imageUnsupported'))
  }

  const placeholder = blocked
    ? t('placeholder.blocked')
    : working
      ? t('placeholder.working')
      : t('placeholder.idle')

  // 没有接话人的会话（收工的队友 / 一次性子智能体）：输入卡片整块换成一行说明。
  // 照 dsh 的 SubagentReadOnlyComposer——那边也是把输入位换成一句解释，不给输入框。
  // 放在所有 hook 之后：换会话时它随快照重算，不需要额外的卸载 / 重置逻辑。
  if (!acceptsInput) {
    return (
      <div className="composer-stack" style={{ marginTop: 10 }}>
        <div className="composer composer-readonly" role="note" data-composer-readonly="">
          <span className="composer-readonly-title">{t('readonly.title')}</span>
          <span className="composer-readonly-body">{t('readonly.body')}</span>
        </div>
      </div>
    )
  }

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
          // 浮层互斥：开这一张就把输入区里别的收掉（旧界面同款）。
          setPermOpen(false)
          controls.close()
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
          <div className="composer-attachments" aria-label={t('attach.pending.aria')}>
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
                      {/* 图片做成按钮：整块缩略图都是点击面，点开走自己的浮层
                          （贴图是 dataURL，`<a target="_blank">` 打不开）。视频这轮不预览。 */}
                      {item.kind === 'image' ? (
                        <button
                          type="button"
                          className="attach-zoom"
                          data-tip={t('attach.zoom.tip')}
                          aria-label={t('attach.preview.aria', { name: item.name })}
                          onClick={() => {
                            setZoom({ src: item.previewUrl, alt: item.name })
                          }}
                        >
                          <img src={item.previewUrl} alt={item.name} />
                        </button>
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
                      <span className="attach-hint">{t('attach.frames', { count: item.frames.length })}</span>
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
                  aria-label={t('attach.remove.aria', { name: item.name })}
                  title={t('attach.remove.aria', { name: item.name })}
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
          aria-label={t('input.aria')}
          onChange={(event) => {
            onTextChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }}
          onKeyDown={onKeyDown}
        />

        {/* `/` 命令候选面板：与 @ 提及同一块位置（输入框上方），两者不会同时开。 */}
        {command.open ? (
          <div className="slash-pop" role="listbox" aria-label={t('slash.aria')}>
            {command.loading ? (
              <div className="slash-item" data-loading="1">
                {t('slash.loading')}
              </div>
            ) : command.rows.length === 0 ? (
              <div className="slash-item" data-empty="1">
                {t('slash.empty')}
              </div>
            ) : (
              <>
                {/* 分组标题：壳的菜单只列命令这一类（dsh 那张菜单分「添加 / 指令 / 技能」，
                    我们这边没有另外两类，标题照它留一个，行才不会被当成无主的一串）。 */}
                <div className="slash-section" role="presentation">
                  {t('slash.section')}
                </div>
                {command.rows.map((row, index) => {
                  const off = blockedNow(row, working)
                  const Glyph = commandGlyph(row.name)
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
                      {/* 图标格固定 14px：没有图标的命令也占着，中文名才不会一行行错开。 */}
                      <span className="slash-icon" aria-hidden="true">
                        {Glyph === null ? null : <Glyph size={14} />}
                      </span>
                      <span className="slash-label">{row.label ?? `/${row.name}`}</span>
                      {row.label === undefined ? null : <span className="slash-name">{row.name}</span>}
                      {off ? <span className="slash-flag">{t('slash.blocked')}</span> : null}
                      <span className="slash-desc">{row.description}</span>
                    </button>
                  )
                })}
              </>
            )}
            <div className="slash-hint">{t('slash.hint')}</div>
          </div>
        ) : null}

        {/* @ 文件提及的候选面板：贴在输入框上方（textarea 是 relative 容器的兄弟）。 */}
        {mention.open ? (
          <div className="mention-pop" role="listbox" aria-label={t('mention.aria')}>
            {mention.loading ? (
              <div className="mention-item" data-loading="1">
                {t('mention.loading')}
              </div>
            ) : mention.items.length === 0 ? (
              <div className="mention-item" data-empty="1">
                {t('mention.empty')}
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
            <div className="mention-hint">{t('mention.hint')}</div>
          </div>
        ) : null}

        <div className="composer-bar" ref={controls.barRef}>
          <div className="bar-left">
            {/* 「+」钮（旧界面同款）：正文为空时点击插入 "/"，把用户带到指令清单的门口。 */}
            <button
              type="button"
              className="icon-btn"
              data-tip={t('insert.tip')}
              aria-label={t('insert.aria')}
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
            {/* 权限那颗的浮层在手机上是一块**贴住输入卡片**的面板（`model-anchor-sheet`，
                见 styles.css 的窄屏段）：它原来锚在自己那颗 chip 上（右缘对齐），手机上 chip 排在
                行中间，300/320px 的面板会探出屏幕左缘、行文字被裁成只剩尾字。合并后的模型 chip
                不挂这个类——它有自己一套窄面板 + 悬浮飞出。 */}
            <div className="model-anchor model-anchor-sheet">
              <button
                type="button"
                className={`model-btn${permOpen ? ' open' : ''}`}
                data-tip={permOption?.description ?? t('preset.unknown')}
                aria-haspopup="menu"
                aria-expanded={permOpen}
                /* 手机档只画图标（styles.css ≤560 把文字藏掉），所以当前档位读什么要靠这条：
                   文字被 CSS 藏起来之后，读屏与 aria-label 是仅剩的两条解释。 */
                aria-label={t('preset.aria', { label: permOption?.label ?? t('preset.custom') })}
                onClick={() => {
                  setPermOpen((open) => !open)
                  controls.close()
                  setBranchOpen(false)
                }}
              >
                <IconShield size={13} />
                <span className="chip-label">{permOption?.label ?? t('preset.custom')}</span>
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
                  <div className="model-pop policy-pop" role="menu" aria-label={t('preset.menu.aria')}>
                    <div className="pop-label">
                      {t('preset.label')}
                      <span className="pop-note">{t('preset.note')}</span>
                    </div>
                    {permissionPresets.options.length === 0 ? (
                      <div className="pop-item">
                        <span className="name">{t('list.empty')}</span>
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
            {/* 模式（预设）旋钮 2026-11-06 搬到顶栏标题旁（`PresetChip`，走 `shell.header.lead`
                槽 order 20）：底栏这一格留给输入本身。见文件头与那一段的注释。 */}
          </div>

          <div className="bar-right">
            {controls.node}

            {working ? (
              <button
                type="button"
                className={`send-btn stop${queueing ? ' dim' : ''}`}
                aria-label={t('stop.aria')}
                data-tip={t('stop.tip')}
                onClick={interrupt}
              >
                <IconStop size={16} />
              </button>
            ) : null}
            {!working || queueing ? (
              <button
                type="button"
                className="send-btn"
                aria-label={working ? t('send.queueAria') : t('send.aria')}
                disabled={!sendable || blocked || sending}
                data-tip={working ? t('send.queueTip') : t('send.tip')}
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

      {inputHint === null ? null : <div className="shell-composer-hint">{inputHint}</div>}
      {fault === null ? null : <div className="shell-composer-fault">{fault}</div>}

      {/* 贴图放大：自己 portal 到 body，点遮罩或 Esc 关。 */}
      {zoom === null ? null : (
        <ImageLightbox
          src={zoom.src}
          alt={zoom.alt}
          onClose={() => {
            setZoom(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * 模式（预设）那颗胶囊：2026-11-06 从输入区底栏搬到**顶栏标题旁**（槽 `shell.header.lead`，order 20）。
 *
 * 为什么抽成独立组件：它的状态（菜单开合）与写口（`usePreset`）原本住在 `ComposerBox` 里，
 * 钮搬走之后两边就隔了两个槽——再靠 props 穿线要跨整棵树。独立组件自己读快照、自己发写口，
 * 回执（toastOk / toastErr）与降级话术一字未改。
 *
 * 三条与顶栏有关的约束（样式在 `legacy/views.css` 的 `.preset-header` 一节）：
 *   - 顶栏整条是窗口拖拽区，钮自己声明 `no-drag`，否则点下去被当成拖窗口（`.topbar-search` 同款）；
 *   - 与标题旁其他钮同高（24px），`flex: none` 不换行，名字长了省略；
 *   - 面板**向下**开（`.model-pop` 的默认锚法是向上——那是输入区底栏的用法）。
 *
 * 打开时发一条 `shell.preset.open`：输入区那几张浮层收到就收掉（同一时刻只开一张，跨组件只能
 * 走窗口事件）。
 */
function PresetChip(): ReactNode {
  const channel = useHostChannel()
  const preset = useHostSelector(readPresetSurface, samePresetSurface)
  const [open, setOpen] = useState(false)
  /** 当前预设那一项（拿它的 label / description）；清单缺了这项时为 undefined。 */
  const option = preset.options.find((item) => item.name === preset.current)

  // Esc 关（与遮罩点击同效）：这张浮层挂在顶栏，别的浮层各管各的，谁开着归谁。
  useEffect(() => {
    if (!open) return undefined
    // 注意类型：`KeyboardEvent` 这个名字在本文件里指向 React 合成事件（见顶部 import），
    // 而这里是 `window` 上的原生事件，得显式写 DOM 那个类型。
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  /**
   * 切模式：走界面通道的 `usePreset`（它在放行面里——切模式不碰安全闸门，只换提示词与
   * 工具白名单）。宿主回执后立刻刷一次会话性子面跟着变；失败按原样报（浏览器页签里没有
   * 原生桥时也是这条路：宿主不受理就弹 `error.modeFailed`，不静默吞掉）。
   */
  const choose = (name: string, label: string): void => {
    setOpen(false)
    void channel
      .invoke('usePreset', [name])
      .then(() => {
        toastOk(t('toast.modeSwitched', { label }))
      })
      .catch((reason: unknown) => {
        toastErr(t('error.modeFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
      })
  }

  return (
    <div className="model-anchor preset-header">
      <button
        type="button"
        className={`preset-chip${open ? ' open' : ''}`}
        /* 壳里的 `data-tip` 气泡层 0.6.37 起就下线了（见 legacy/primitives.css 的注释），
           悬停说明一律走原生 `title`——搬过来时顺手把它换成真能看见的那一条。 */
        title={option?.problem ?? option?.description ?? t('mode.tip')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('mode.aria', { label: option?.label ?? preset.current })}
        onClick={() => {
          const opening = !open
          setOpen(opening)
          // 开这一刻先让输入区把它的浮层收掉（同一条互斥口径跨了两个槽）。
          if (opening) window.dispatchEvent(new CustomEvent('shell.preset.open'))
        }}
      >
        <IconLayers size={13} />
        <span className="chip-label">{option?.label ?? preset.current}</span>
        <IconChevronDown size={12} />
      </button>
      {open ? (
        <>
          <div
            className="pop-mask"
            onClick={() => {
              setOpen(false)
            }}
          />
          <div className="model-pop preset-pop" role="menu" aria-label={t('mode.menu.aria')}>
            {/* 这里原来挂着「新建/编辑：设置 → 模式」——一句话把菜单顶行撑满，又让读者以为
                要跳去设置页才改得动。删掉：新建/编辑模式本来就是设置页的事，菜单只回答
                「现在用哪一档」。 */}
            <div className="pop-label">{t('mode.label')}</div>
            {preset.options.length === 0 ? (
              <div className="pop-item">
                <span className="name">{t('list.empty')}</span>
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
                    choose(item.name, item.label)
                  }}
                >
                  <span className="name">
                    {item.label}
                    {item.name === preset.defaultName && (
                      <span className="pop-badge">{t('preset.defaultBadge')}</span>
                    )}
                    {item.problem !== undefined && <span className="pop-badge warn">{t('preset.problem')}</span>}
                  </span>
                  {item.name === preset.current ? <IconCheck size={14} className="check" /> : null}
                </button>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
