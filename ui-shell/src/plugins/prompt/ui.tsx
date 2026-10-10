/**
 * 等待用户决定的三种卡：审批卡、计划审阅卡、提问卡。
 *
 * 这三张卡在旧界面里是输入区这个纵向容器里输入框**上方**的兄弟节点，谁在上谁在下由一个
 * 次序决定。搬进界面壳后它们仍是同一个位置——`shell.composer` 槽，次序改由注册时的 `order`
 * 表达（本插件 10，输入框 50，排队条 60），于是「卡在上、输入框在中、排队条在后」这条旧
 * 布局关系不必由壳硬编码。
 *
 * 样式一行都不新写：class 名逐字照抄旧实现（`desktop/src/renderer/ApprovalCard.tsx` 与
 * `TaskDock.tsx` 的 PlanReview / AskCard 两段），规则体在 `ui-shell/src/legacy/views.css`
 * 里现成（行号同旧 `desktop/src/renderer/styles.css`）：审批卡 1955 起、内嵌差异 2028 起、
 * 四颗按钮与 `.btn-ghost`/`.btn-primary` 2098 起、计划卡 6632 起、提问卡 6698 起
 * （底栏与翻页器在 7997 起的补充段）、拒绝反馈框 9985、差异行 9762 起。
 * 本文件用到的 class 只有两个不在那份旧样式表里，而且都**不是我新造的**：
 * 交回宿主的失败提示用 `.shell-composer-fault`（`ui-shell/src/styles.css:179`），
 * 卡片渲染崩溃用 `.slot-crash`（`ui-shell/src/styles.css:25`）。
 *
 * 数据一律从宿主快照的 `surfaces` 里取（`pendingApproval` / `pendingPlan` /
 * `pendingQuestion`），销掉它们只走界面通道的三个方法（`answerApproval` / `answerPlan` /
 * `answerQuestion`）。**权限模式不给改**：`setPolicy` 不在界面通道的白名单里
 * （`src/core/ui-methods.ts` 那张表里没有它），所以卡片只把「现在是哪一档」写出来，不画控件。
 *
 * @module dsc-ui-shell/plugins/prompt
 */
// React 的合成键盘事件改名引入：本文件同时要用 DOM 的 `KeyboardEvent`（window 级监听，
// 那是原生事件），两个同名类型撞在一起时，别名比在每处写 `globalThis.KeyboardEvent` 清楚。
import {
  Component,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  defineUiPlugin,
  useHostChannel,
  useHostSelector,
  type ApprovalAnswer,
  type ApprovalPolicy,
  type ApprovalRequestView,
  type AskOptionView,
  type AskUserView,
  type CollaborationMode,
  type DiffHunkView,
  type HostSnapshot,
  type ModeSurface,
  type PlanDecision,
  type PlanView,
  type PolicySurface,
  type SessionSummary,
  type TierOption,
} from '@dsc/ui'

export default defineUiPlugin({
  name: '等待用户决定的卡',
  apply(ui) {
    // order 10：三张卡都排在输入框上方（composer.box 是 50、composer.queue 是 60）。
    ui.slots.register('shell.composer', { id: 'prompt.cards', order: 10 }, PromptCards)
  },
})

/**
 * 槽条目本体：三张卡按「审批 → 计划 → 提问」的固定次序排。
 *
 * 三张卡都没挂起时返回 `null` 而不是一个空外壳：`.composer-zone` 是 flex 列、子节点带内距，
 * 挂一个空 div 会在输入框上方白顶出一条间距，让用户以为输入框跳了一下。
 */
function PromptCards(): ReactNode {
  const approval = useHostSelector(readApproval, sameContent)
  const plan = useHostSelector(readPlan, sameContent)
  const question = useHostSelector(readQuestion, sameContent)
  if (approval === null && plan === null && question === null) return null
  return (
    <>
      {approval === null ? null : (
        // key 跟着请求 id 走：挂起的请求换了（上一张答完、下一张顶上来）就整块重挂，
        // 「差异展开没展开」「上一次交失败的原因」这些本地状态自然归零，不会串到新卡上。
        <CardBoundary key={`approval:${approval.id}`} label="审批卡">
          <ApprovalCard request={approval} />
        </CardBoundary>
      )}
      {plan === null ? null : (
        // 同旧界面：计划换了文件就重挂，拒绝框里没提交的反馈不留给下一份计划。
        <CardBoundary key={`plan:${plan.file}`} label="计划审阅卡">
          <PlanReview plan={plan} />
        </CardBoundary>
      )}
      {question === null ? null : (
        <CardBoundary key={`ask:${question.id}`} label="提问卡">
          <AskCard question={question} />
        </CardBoundary>
      )}
    </>
  )
}

/* ────────────────────────────── 快照读取 ────────────────────────────── */

/** 快照里的一块 surfaces；不是对象就当没有（帧是宿主拼的，这里只做形状检查）。 */
function surfacesOf(snapshot: HostSnapshot | null): Record<string, unknown> | null {
  const value = snapshot?.['surfaces']
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 快照里的 status 那一片；取不到给 null。 */
function statusOf(snapshot: HostSnapshot | null): Record<string, unknown> | null {
  const value = snapshot?.['status']
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * 挂起的审批请求。
 *
 * 为什么只挡「不是对象」这一种：壳与宿主永远同一次构建一起发（壳就是从宿主的 `/` 里取回来
 * 的），字段形状对不上的帧在通道层就被判成错误了（`src/ui/frames.ts` 是严格版）。
 * 再抄一遍字段校验只会多一份要维护的口径。
 */
function readApproval(snapshot: HostSnapshot | null): ApprovalRequestView | null {
  const value = surfacesOf(snapshot)?.['pendingApproval']
  return typeof value === 'object' && value !== null ? (value as ApprovalRequestView) : null
}

/** 挂着等用户批的计划。 */
function readPlan(snapshot: HostSnapshot | null): PlanView | null {
  const value = surfacesOf(snapshot)?.['pendingPlan']
  return typeof value === 'object' && value !== null ? (value as PlanView) : null
}

/** 模型发起的提问（可能一次带一批题目，见 `AskUserView.questions`）。 */
function readQuestion(snapshot: HostSnapshot | null): AskUserView | null {
  const value = surfacesOf(snapshot)?.['pendingQuestion']
  return typeof value === 'object' && value !== null ? (value as AskUserView) : null
}

/** 当前会话的工作目录（审批卡的差异行把目标路径显示成相对路径用）。 */
function readCwd(snapshot: HostSnapshot | null): string {
  const cwd = statusOf(snapshot)?.['cwd']
  return typeof cwd === 'string' ? cwd : ''
}

/**
 * 「内容没变」的比较：**不**按引用比。
 *
 * 为什么必须自己写：宿主每推一帧都是一次 JSON 解析，`surfaces.pendingApproval` 这类字段
 * 每帧都是一个新对象，默认的 `Object.is` 会把三张卡判成「每帧都变了」——长回合一秒几十帧，
 * 卡上的差异行与计划正文会跟着白重画。按内容比之后只有内容真变了才换引用，卡才重画。
 *
 * 为什么用 `JSON.stringify` 而不是逐个字段比：这三份数据全是可序列化的纯数据（没有函数、
 * 没有循环引用），而且本来就是刚从 JSON 解出来的——再序列化一次的开销与帧里那次解析同量级，
 * 换来的是「不用维护一张随时会漏字段的字段表」。
 */
function sameContent(previous: unknown, next: unknown): boolean {
  if (previous === next) return true
  if (previous === null || next === null) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

/* ────────────────────────────── 分卡错误边界 ────────────────────────────── */

/**
 * 每张卡各自一层小错误边界。
 *
 * 壳已经给槽条目套了一层（崩了会把这个条目整个退位，见 `slots-react.tsx`），但三张卡是
 * **同一个条目**：提问卡的数据长歪了不该把已经挂着、等用户点「这次允许」的审批卡一起带走。
 * 所以这里再各包一层——崩哪张只顶掉哪张，另外两张照常能答；壳那一层因此不会被惊动，
 * `prompt.cards` 这个条目也不会退位。
 *
 * 为什么不用 `slot-crash` 之外的样式：这一行就是「一块界面坏了」的同位物，壳的补充样式里
 * 已经有现成的红框。渲染期的异常栈 React 自己会打到控制台，这里不再重复上报。
 */
class CardBoundary extends Component<{ label: string; children: ReactNode }, { error: string | null }> {
  constructor(props: { label: string; children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="slot-crash" data-card-crash={this.props.label}>
          {this.props.label}渲染失败：{this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}

/* ────────────────────────────── 通用小工具 ────────────────────────────── */

/**
 * 路径的展示形态（工作目录内 → 相对路径，home 内 → `~/…`，其余原样）。
 *
 * 逐字搬自旧实现 `desktop/src/renderer/file-util.ts:89-107`，**不能 import**：
 * 插件 bundle 只能 require 白名单里的模块（`ui-shell/src/platform-modules.json`），
 * desktop 目录不在里面，构建期就会被挡下来。
 */
function displayPathOf(path: string, cwd: string): string {
  if (path === '') return ''
  const posix = path.replace(/\\/g, '/')
  if (cwd !== '') {
    const base = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    const low = posix.toLowerCase()
    const baseLow = base.toLowerCase()
    if (low === baseLow.slice(0, -1)) return '.'
    if (low.startsWith(baseLow)) return posix.slice(base.length)
  }
  return posix
}

/**
 * 焦点是不是落在「用户正在打字」的地方（输入框 / 文本域 / 可编辑区）。
 *
 * 审批卡的快捷键要问这一句：用户在提问卡的输入框里敲 `s`、在别处的文本框里敲 `n`，
 * 那是打字，不是「本会话允许 / 拒绝」。
 */
function isTypingTarget(): boolean {
  const node = document.activeElement
  if (node === null) return false
  const tag = node.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return node instanceof HTMLElement && node.isContentEditable
}

/** 一次界面通道调用的失败原因（宿主给的是人话，直接显示）。 */
function reasonOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/* ────────────────────────────── 审批卡 ────────────────────────────── */

/** 风险档位对应的中文与配色档位（critical 借 high 那套红样式，旧实现就是这么映射的）。 */
const RISK: Readonly<Record<ApprovalRequestView['risk'], { label: string; tone: string }>> = {
  low: { label: '低风险', tone: 'low' },
  medium: { label: '中风险', tone: 'medium' },
  high: { label: '高风险', tone: 'high' },
  critical: { label: '极高风险', tone: 'high' },
}

/** 档位兜底名：旧界面写死的那一份（宿主档位表查不到时用它）。 */
const POLICY_TEXT: Readonly<Record<ApprovalPolicy, string>> = {
  readonly: '仅查看',
  'auto-edit': '工作区自动',
  'full-access': '完全访问',
  'ai-review': 'AI 审查',
}
const MODE_TEXT: Readonly<Record<CollaborationMode, string>> = {
  build: '执行',
  plan: '计划',
  explore: '探索',
  quiet: '免打扰',
}

/**
 * 从写死的档位名表里取一个词。
 *
 * 泛型 `T extends string` 这一手是为了两头都要：映射用 `Record<ApprovalPolicy, string>` 声明，
 * 契约加了档位而这里忘了补就会**编译期**报错；而线上真拿到一个契约之外的字符串时
 * （宿主比壳新，或者帧被人改过），查不到就给兜底词，绝不把 `undefined` 画到界面上。
 */
function fixedText<T extends string>(map: Readonly<Record<T, string>>, id: T, fallback: string): string {
  return map[id] ?? fallback
}

function policySurface(snapshot: HostSnapshot | null): PolicySurface | null {
  const value = surfacesOf(snapshot)?.['policy']
  return typeof value === 'object' && value !== null ? (value as PolicySurface) : null
}

function modeSurface(snapshot: HostSnapshot | null): ModeSurface | null {
  const value = surfacesOf(snapshot)?.['mode']
  return typeof value === 'object' && value !== null ? (value as ModeSurface) : null
}

/** 档位表里那一档的显示名；表里没有（宿主换了档位清单）返回 null。 */
function optionLabel<T extends string>(options: readonly TierOption<T>[], id: T): string | null {
  for (const option of options) if (option.id === id) return option.label
  return null
}

/**
 * 卡片头上那行「权限 X · 模式 Y」。
 *
 * 两件事分开定，是刻意的：
 *   - **档位取请求里的那一份**（`request.policy` / `request.mode`）：这张卡是照「当时那一档」
 *     问的，用户看到的与批准的就该是同一档；界面别处的当前档位随时可能被改，不能拿它冒充。
 *   - **名字优先用宿主档位表里的 label**：输入区底栏的档位菜单显示的也是这一份名字，
 *     同一个档位在两处写成两个词，用户会以为它们不是一回事。查不到再退回旧界面的写死映射，
 *     这样宿主还没贡献 surfaces 时卡片仍画得出人话。
 */
function readModeLine(snapshot: HostSnapshot | null): string {
  const request = readApproval(snapshot)
  if (request === null) return ''
  const policy = policySurface(snapshot)
  const mode = modeSurface(snapshot)
  const policyName =
    (policy === null ? null : optionLabel(policy.options, request.policy)) ??
    fixedText(POLICY_TEXT, request.policy, 'AI 审查')
  const modeName =
    (mode === null ? null : optionLabel(mode.options, request.mode)) ?? fixedText(MODE_TEXT, request.mode, '执行')
  return `权限 ${policyName} · 模式 ${modeName}`
}

/**
 * 审批卡的会话归属标注：这张卡是不是别的会话弹过来的。
 *
 * 口径照旧实现（`desktop/src/renderer/App.tsx:71-78`）：就是当前查看的这条会话、或者请求
 * 里没带会话路径，都不标（重复信息）；查不到标题（刚归档之类）笼统标「后台会话」。
 *
 * 为什么把整件事做成一个选择器、返回字符串：它依赖 `request` + `status` + `sessions` 三处，
 * 其中 `sessions` 每帧都是新数组。返回字符串按值比，帧里别的东西怎么变都不会惊动这张卡。
 */
function readOwnerLabel(snapshot: HostSnapshot | null): string | null {
  const request = readApproval(snapshot)
  if (request === null || request.sessionPath === undefined) return null
  const current = statusOf(snapshot)?.['sessionPath']
  if (typeof current === 'string' && request.sessionPath === current) return null
  const sessions = snapshot?.['sessions']
  if (!Array.isArray(sessions)) return '后台会话'
  return (sessions as SessionSummary[]).find((item) => item.id === request.sessionPath)?.title ?? '后台会话'
}

/** 审批卡：挂起的工具审批，四个决定照后端授权的三档语义。 */
const ApprovalCard = memo(function ApprovalCard({ request }: { request: ApprovalRequestView }): ReactNode {
  const channel = useHostChannel()
  // 授权档位按 `scopes` 过滤；空数组回退成「只给这一次」——宁可多问一次，也不要凭空给出
  // 本会话/永久放行。`hardline` 时一个放行按钮都不给（下面整个 actions 换成一句硬地板说明）。
  const scopes: Array<'once' | 'session' | 'always'> = request.scopes.length > 0 ? request.scopes : ['once']
  /** 内嵌差异默认收起：折叠行已经给了路径与增删计数，摊开会把决定按钮顶出视野。 */
  const [diffOpen, setDiffOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<string | null>(null)
  const cwd = useHostSelector(readCwd)
  const owner = useHostSelector(readOwnerLabel)
  const modeLine = useHostSelector(readModeLine)

  /**
   * 交回宿主一个决定。
   *
   * `answerApproval` 只收一个实参（第二个「来源标记」由宿主那一侧自己认，界面**不要**传：
   * `src/core/ui-methods.ts` 那张放行表里它是可选的，传了反而多一处要跟着改的地方）。
   *
   * 提交后按钮保持 disabled 防重复点；失败了要放开按钮并把原因写进卡里——卡还挂着，
   * 用户得能重来，而且不能「点了没反应还不说为什么」。
   */
  const answer = (choice: ApprovalAnswer): void => {
    if (busy) return
    setBusy(true)
    setFault(null)
    void channel.invoke('answerApproval', [choice]).catch((reason: unknown) => {
      setBusy(false)
      setFault(reasonOf(reason))
    })
  }

  /**
   * 快捷键：window 级监听（与旧实现同一个层面），但看清焦点、并且拦下默认行为。
   *
   * 相对旧实现（`ApprovalCard.tsx:36-46`）改了三点，前两点是刻意的改进：
   *   ① 焦点在输入框 / 文本域 / 可编辑区里时不抢键。用户在提问卡的自由输入框里敲 `s`、
   *      在别处的文本框里敲 `n`，那是打字；旧实现一律抢走，会当场替他点掉审批。
   *   ② 命中之后 `preventDefault`。这些字母在浏览器里还有别的含义（`s` 可能触发保存、
   *      `a` 触发全选），处理了我们自己的决定就得把它拦下来，否则页面别处的默认行为
   *      会跟这一下抢。
   *   ③ 旧实现写的是 `event.key.toLowerCase() === 'Escape'`——小写化后的 `'escape'` 永远
   *      不等于 `'Escape'`，于是 Esc **从来没生效过**。这里按语义让 Esc 真能拒。
   *
   * 监听只注册一次（下面依赖数组是空的），每次渲染把最新的处理函数换进 ref：`busy`、
   * `scopes` 这些一变就是新闭包，而监听本身不必跟着重挂——`answer` 里那句 `if (busy) return`
   * 因此拦得住连按，档位变了也不用等一次重挂。这也是壳里既有的写法
   * （`ui-shell/src/runtime-context.tsx:54-56` 同样在渲染期刷新 ref）。
   */
  const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  onKeyRef.current = (event: KeyboardEvent): void => {
    if (isTypingTarget()) return
    const key = event.key.toLowerCase()
    const choice: ApprovalAnswer | null =
      key === 'y' && scopes.includes('once')
        ? 'allow-once'
        : key === 's' && scopes.includes('session')
          ? 'allow-session'
          : key === 'a' && scopes.includes('always')
            ? 'allow-always'
            : key === 'n' || key === 'escape'
              ? 'reject'
              : null
    if (choice === null) return
    event.preventDefault()
    answer(choice)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      onKeyRef.current(event)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const risk = RISK[request.risk]
  const keys: Array<{
    scope: 'once' | 'session' | 'always'
    answer: ApprovalAnswer
    label: string
    key: string
    title: string
  }> = [
    { scope: 'once', answer: 'allow-once', label: '这次允许', key: 'y', title: '只放过这一次，下次同类操作还会问' },
    {
      scope: 'session',
      answer: 'allow-session',
      label: '本会话允许',
      key: 's',
      title: '这个会话里同类操作不再问；换会话就失效',
    },
    {
      scope: 'always',
      answer: 'allow-always',
      label: '永久允许',
      key: 'a',
      title:
        request.suggestedRule === null
          ? '这类动作不给持久化'
          : `往规则文件写一条：${request.suggestedRule.join(' ')}… 以后照它自动放行`,
    },
  ]

  return (
    <div className={`approval risk-${risk.tone}`}>
      <div className="approval-head">
        <span className="tool-name">{request.toolName}</span>
        <span className={`risk-badge tone-${risk.tone}`}>{risk.label}</span>
        <span className="approval-mode">{modeLine}</span>
      </div>
      <div className="approval-args">{request.argsSummary}</div>
      {owner === null || owner === '' ? null : <div className="approval-owner">来自会话「{owner}」</div>}
      {request.diff === undefined ? null : (
        <div className="approval-diff">
          <div className="approval-diff-head">
            <span className="approval-diff-path" title={request.diff.path}>
              {`${request.diff.status === 'added' ? '将写入' : '将修改'} ${displayPathOf(request.diff.path, cwd)}`}
            </span>
            <span className="changes-counts">
              {request.diff.status === 'added' ? <span className="diff-badge">新增</span> : null}
              <span className="changes-added">{`+${String(request.diff.added)}`}</span>
              <span className="changes-removed">{`-${String(request.diff.removed)}`}</span>
            </span>
            <button
              type="button"
              className="approval-diff-toggle"
              aria-expanded={diffOpen}
              onClick={() => {
                setDiffOpen((value) => !value)
              }}
            >
              {diffOpen ? '收起改动' : '查看改动'}
            </button>
          </div>
          {/* 这两条是「照参数执行会失败」的预告：宿主读盘比对不出来才给，看到就别点允许。 */}
          {request.diff.mismatch === 'missing' ? <div className="tc-warn">old 在文件中不存在，执行会失败</div> : null}
          {request.diff.mismatch === 'ambiguous' ? <div className="tc-warn">old 匹配多处，执行会失败</div> : null}
          {request.diff.fellBack === true ? (
            <div className="approval-diff-note">读不到文件当前内容，以下按参数推算</div>
          ) : null}
          {diffOpen ? (
            <div className="approval-diff-body">
              {request.diff.hunks.length === 0 ? (
                <p className="tc-intended-note">不会有实际改动。</p>
              ) : (
                <DiffRows hunks={request.diff.hunks} />
              )}
            </div>
          ) : null}
        </div>
      )}
      <div className="approval-reason">{request.reason}</div>
      {request.hardline ? (
        <div className="approval-hardline">这一步被安全策略判为不可放行，只能拒绝。</div>
      ) : (
        <div className="approval-actions">
          {keys
            .filter((entry) => scopes.includes(entry.scope))
            .map((entry) => (
              <button
                key={entry.scope}
                type="button"
                className="btn"
                title={entry.title}
                disabled={busy}
                onClick={() => {
                  answer(entry.answer)
                }}
              >
                {entry.label}
                <kbd>{entry.key}</kbd>
              </button>
            ))}
          <button
            type="button"
            className="btn danger"
            title="不执行这一步，并把拒绝原因回给模型"
            disabled={busy}
            onClick={() => {
              answer('reject')
            }}
          >
            拒绝
            <kbd>n</kbd>
          </button>
          <span className="hint">5 分钟没人答按拒绝处理</span>
        </div>
      )}
      {fault === null ? null : <div className="shell-composer-fault">没交上去：{fault}</div>}
    </div>
  )
})

/* ────────────────────────────── 差异行 ────────────────────────────── */

/**
 * 差异正文：一段 hunk 一块，逐行「旧行号 / 新行号 / 记号 / 内容」。
 *
 * DOM 与 class 照旧实现 `desktop/src/renderer/DiffPane.tsx:37-47` 的 unified 视图
 * （`.diff-body` / `.diff-hunk` / `.diff-line.diff-add|diff-del|diff-ctx` / `.diff-no` /
 * `.diff-sign` / `.diff-text`，规则体在 `legacy/views.css:9762-9835`）。
 * 旧实现还给每行套了一层 shiki 语法高亮，这里不做：壳里没有那个模块，插件也不许自带依赖；
 * 少了高亮只是没那么好看，差异本身一个字不少。
 */
function DiffRows({ hunks }: { hunks: readonly DiffHunkView[] }): ReactNode {
  return (
    <div className="diff-body">
      {hunks.map((hunk, index) => (
        <div className="diff-hunk" key={`${String(hunk.oldStart)}-${String(hunk.newStart)}-${String(index)}`}>
          <div className="diff-hunk-head">{`@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(
            hunk.newStart,
          )},${String(hunk.newCount)} @@`}</div>
          {hunk.lines.map((line, at) => (
            <div
              className={`diff-line diff-${line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'del' : 'ctx'}`}
              key={String(at)}
            >
              <span className="diff-no">{line.oldLine === null ? '' : String(line.oldLine)}</span>
              <span className="diff-no">{line.newLine === null ? '' : String(line.newLine)}</span>
              <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/* ────────────────────────────── 计划审阅卡 ────────────────────────────── */

/** 计划评审卡：计划正文就地可读，批准 / 拒绝决定切不切回执行档；拒绝可附反馈原话。 */
const PlanReview = memo(function PlanReview({ plan }: { plan: PlanView }): ReactNode {
  const channel = useHostChannel()
  const pending = plan.decision === 'pending'
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<string | null>(null)

  /**
   * 交回决定。反馈为空就只传一个实参（`['rejected']`）：空串对宿主是「用户没写」，
   * 传与不传造成的区别是结果文案里多一句空话，所以这里统一按「没写」处理。
   */
  const answer = (decision: PlanDecision, text?: string): void => {
    if (busy) return
    setBusy(true)
    setFault(null)
    const args: unknown[] = text === undefined || text === '' ? [decision] : [decision, text]
    void channel.invoke('answerPlan', args).catch((reason: unknown) => {
      setBusy(false)
      setFault(reasonOf(reason))
    })
  }

  const sendReject = (): void => {
    const text = feedback.trim()
    answer('rejected', text === '' ? undefined : text)
  }

  return (
    <div className={`plan-card${pending ? ' pending' : ' settled'}`}>
      <div className="plan-head">
        <span className="plan-title">{plan.title}</span>
        <span className="plan-verdict">
          {pending ? '等你批' : plan.decision === 'approved' ? '已批准' : '未批准'}
        </span>
      </div>
      <pre className="plan-body">{plan.text}</pre>
      {pending && rejecting ? (
        <textarea
          className="plan-feedback"
          value={feedback}
          onChange={(event) => {
            setFeedback(event.target.value)
          }}
          placeholder="想让模型改什么？写在这里（可留空），会原样带给模型"
          rows={3}
          autoFocus
        />
      ) : null}
      <div className="plan-foot">
        <span className="plan-file" title={plan.file}>
          {plan.file}
        </span>
        {pending ? (
          rejecting ? (
            <>
              <button
                type="button"
                className="btn-primary plan-btn"
                disabled={busy}
                onClick={sendReject}
                title="把反馈带给模型，留在计划模式改方案"
              >
                带反馈退回
              </button>
              <button
                type="button"
                className="btn plan-btn"
                disabled={busy}
                onClick={() => {
                  setRejecting(false)
                }}
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn-primary plan-btn"
                disabled={busy}
                onClick={() => {
                  answer('approved')
                }}
                title="批准并切回执行模式开始实现"
              >
                批准开工
              </button>
              <button
                type="button"
                className="btn plan-btn"
                disabled={busy}
                onClick={() => {
                  setRejecting(true)
                }}
                title="留在计划模式；可附一句反馈让模型照着改"
              >
                还要改
              </button>
            </>
          )
        ) : null}
      </div>
      {fault === null ? null : <div className="shell-composer-fault">没交上去：{fault}</div>}
    </div>
  )
})

/* ────────────────────────────── 提问卡 ────────────────────────────── */

/** 提问卡里的一题（字段与契约的单题视图同源；一批里的位置就是它的标识）。 */
interface AskItem {
  /** 这题在本次提问里的稳定标识：换一批问题就换一串 key（草稿与焦点都按它存）。 */
  key: string
  header?: string
  question: string
  options: AskOptionView[]
  multiSelect: boolean
  /** 「其他」自由输入是否允许。 */
  freeText: boolean
}

/** 一题的作答草稿（对照旧实现 `TaskDock.tsx:160-167`）。 */
interface AskDraft {
  picked: string[]
  free: string
  skipped: boolean
}

const EMPTY_DRAFT: AskDraft = { picked: [], free: '', skipped: false }

/**
 * 把一批里的一条原始数据收成一题；`question` 不是非空字符串就丢掉——宿主喂进来的脏数据
 * 不该把整张卡打空（逐字照旧实现 `TaskDock.tsx:175-199`）。
 */
function toAskItem(raw: unknown, key: string): AskItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as Record<string, unknown>
  const question = typeof doc['question'] === 'string' ? doc['question'].trim() : ''
  if (question === '') return null
  const options: AskOptionView[] = []
  if (Array.isArray(doc['options'])) {
    for (const option of doc['options']) {
      if (typeof option !== 'object' || option === null) continue
      const entry = option as Record<string, unknown>
      const label = typeof entry['label'] === 'string' ? entry['label'] : ''
      if (label === '') continue
      options.push({
        label,
        ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
      })
    }
  }
  const header = typeof doc['header'] === 'string' ? doc['header'].trim() : ''
  return {
    key,
    ...(header === '' ? {} : { header }),
    question,
    options,
    multiSelect: doc['multiSelect'] === true,
    freeText: doc['allowFreeText'] !== false,
  }
}

/**
 * 把宿主给的视图归一成题目清单：优先看 `questions`（一次挂一批），否则退回单题字段。
 *
 * 两边的字段是同一份（契约保证 `questions[0]` 与单题字段同源），所以下面这套渲染
 * 两种形态共用，不必写两份 UI。
 */
function askItems(view: AskUserView): AskItem[] {
  const many = view.questions
  const items = (Array.isArray(many) ? many : [])
    .map((raw, index) => toAskItem(raw, `${view.id}#${String(index)}`))
    .filter((item): item is AskItem => item !== null)
  if (items.length > 0) return items
  const single = toAskItem(view, `${view.id}#0`)
  return single === null ? [] : [single]
}

/**
 * 一题交回宿主的答案文本：跳过写一句实话，写了自由文本就优先用它（与旧实现同一口径）。
 */
function answerOf(draft: AskDraft): string {
  if (draft.skipped) return '（用户跳过了这一题）'
  const free = draft.free.trim()
  return free === '' ? draft.picked.join('、') : free
}

/** 模型提问卡：向导式作答——一卡只露当前这一题，全答完一次提交。 */
const AskCard = memo(function AskCard({ question }: { question: AskUserView }): ReactNode {
  const items = useMemo(() => askItems(question), [question])
  if (items.length === 0) return null
  // key 跟着题目清单走：换一批问题就整块重挂，草稿与焦点跟着归零，
  // 上一批的输入框不会把字留在下一批里（旧实现 `TaskDock.tsx:238` 同款）。
  return <AskComposer key={items.map((item) => item.key).join('|')} items={items} />
})

/** 提问卡的作答面：草稿按题存，切题回来还在，提交后连题一起清掉。 */
function AskComposer({ items }: { items: AskItem[] }): ReactNode {
  const channel = useHostChannel()
  const [drafts, setDrafts] = useState<Record<string, AskDraft>>({})
  const [focus, setFocus] = useState(0)
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<string | null>(null)
  /**
   * 已经交回去的题数。
   *
   * 为什么要有它：宿主的 `answerQuestion` 是**一次收一题**，一卡一批要连着调好几次。
   * 中途有一次失败（通道断了、宿主拒了），前面那几题宿主已经收下了；这时如果让用户
   * 直接重按「提交」，前面那几题会被当成后面题目的答案再交一遍，整批答案就错位了。
   * 记着交到哪一题，重试就从那一题接着交。
   */
  const sent = useRef(0)
  const index = Math.min(focus, items.length - 1)
  const item = items[index]
  const draft = drafts[item.key] ?? EMPTY_DRAFT
  const isLast = index === items.length - 1

  /** 这题有答案（选了选项或写了字）。 */
  const answered = (value: AskDraft): boolean => value.picked.length > 0 || value.free.trim() !== ''
  /** 这题做完了：答了，或者明确跳过。 */
  const completed = (value: AskDraft): boolean => answered(value) || value.skipped
  const draftOf = (target: AskItem, source: Record<string, AskDraft> = drafts): AskDraft =>
    source[target.key] ?? EMPTY_DRAFT

  /** 改草稿：顺手把焦点挪到 `thenIndex`，并把上一次的提示擦掉。 */
  const write = (target: AskItem, next: (current: AskDraft) => AskDraft, thenIndex = index): void => {
    setDrafts({ ...drafts, [target.key]: next(draftOf(target)) })
    setFocus(thenIndex)
    setHint('')
  }

  /** 点选项：多选勾/取消，单选换掉已选并清掉自由文本；单选还顺手推进到下一题。 */
  const choose = (label: string): void => {
    write(
      item,
      (current) => {
        if (!item.multiSelect) return { picked: [label], free: '', skipped: false }
        const picked = current.picked.includes(label)
          ? current.picked.filter((entry) => entry !== label)
          : [...current.picked, label]
        return { ...current, picked, skipped: false }
      },
      item.multiSelect || isLast ? index : index + 1,
    )
  }

  /** 写自由文本：单选下写字就顶掉已选（两处说的是同一件事，不能同时成立）。 */
  const writeFree = (value: string): void => {
    write(item, (current) => ({ picked: item.multiSelect ? current.picked : [], free: value, skipped: false }))
  }

  /**
   * 统一提交：先把缺的题补齐（缺哪题就把焦点跳过去），再按题目顺序逐题交回宿主。
   *
   * 为什么是逐题交：宿主的 `answerQuestion(answer: string)` 一次只解决一题，契约就是
   * 一次收一个字符串；模型那一侧看到的仍是同一个 `ask_user` 调用拿回全部答案——
   * 「一次交回」落在渲染层。
   *
   * 与旧实现的一处不同：旧实现是 fire-and-forget（`void proxy.answerQuestion(...)`），
   * 交失败了界面不知道也不会说。这里 await 到底并把原因显示出来，顺便记得交到第几题。
   */
  const submitAll = (values: Record<string, AskDraft>): void => {
    const missing = items.findIndex((target) => !completed(draftOf(target, values)))
    if (missing >= 0) {
      setFocus(missing)
      setHint('还有题目没答')
      return
    }
    void (async () => {
      setBusy(true)
      setFault(null)
      try {
        for (let at = sent.current; at < items.length; at += 1) {
          await channel.invoke('answerQuestion', [answerOf(draftOf(items[at], values))])
          sent.current = at + 1
        }
        // 提交即清草稿：这一批若还有下一次渲染，输入框里不许留着刚才那句。
        setDrafts({})
        setHint('')
      } catch (reason) {
        // 已经收下的那几题不重交（见 `sent` 的说明），按钮放开让用户能接着交。
        setBusy(false)
        setFault(reasonOf(reason))
      }
    })()
  }

  /** 主按钮：前面还有题就走下一题，最后一题才提交。 */
  const continueFlow = (): void => {
    if (isLast) {
      submitAll(drafts)
      return
    }
    setFocus(index + 1)
    setHint('')
  }

  /** 跳过这题：记一笔空答案往前走，最后一题跳过就直接提交。 */
  const skipCurrent = (): void => {
    const updated = { ...drafts, [item.key]: { picked: [], free: '', skipped: true } }
    if (isLast) {
      submitAll(updated)
      return
    }
    setDrafts(updated)
    setFocus(index + 1)
    setHint('')
  }

  /** 输入框回车＝走主按钮那一步；输入法选字时的回车不算（老引擎用 keyCode 229 报组合中）。 */
  const onFreeKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || Reflect.get(event.nativeEvent, 'keyCode') === 229) {
      return
    }
    event.preventDefault()
    if (answered(draft)) continueFlow()
  }

  return (
    <div className="ask-card" data-ask-count={items.length}>
      {/* 一卡只露当前这一题：其余题目连 DOM 都不进，草稿与已答状态只存在 drafts 里。
          key 跟着题走，换题时整块重挂——题目没选项时输入框才能重新拿到焦点。 */}
      <div className="ask-panel" key={item.key} data-ask-index={index} data-ask-key={item.key}>
        <div className="ask-question">
          {item.header === undefined ? null : <span className="ask-header">{item.header}</span>}
          <span className="ask-text">{item.question}</span>
        </div>
        {item.options.length > 0 ? (
          <div className="ask-options" role={item.multiSelect ? 'group' : 'radiogroup'}>
            {item.options.map((option) => {
              const picked = draft.picked.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`ask-option${picked ? ' picked' : ''}`}
                  role={item.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={picked}
                  title={option.description ?? ''}
                  disabled={busy}
                  onClick={() => {
                    choose(option.label)
                  }}
                >
                  <span className="ask-option-label">{option.label}</span>
                  {option.description === undefined ? null : (
                    <span className="ask-option-desc">{option.description}</span>
                  )}
                </button>
              )
            })}
          </div>
        ) : null}
        {item.freeText ? (
          <div className="ask-free">
            <input
              className="ask-input"
              data-ask-input={index}
              autoFocus={item.options.length === 0}
              placeholder={item.multiSelect ? '可以多选，或在这里直接写答案' : '也可以直接写答案'}
              value={draft.free}
              disabled={busy}
              onChange={(event) => {
                writeFree(event.target.value)
              }}
              onKeyDown={onFreeKeyDown}
            />
          </div>
        ) : null}
      </div>
      <div className="ask-foot">
        {items.length > 1 ? (
          <div className="ask-pager">
            <button
              type="button"
              className="ask-page"
              data-ask-page="prev"
              disabled={index === 0 || busy}
              title="上一题"
              onClick={() => {
                setFocus(index - 1)
                setHint('')
              }}
            >
              ‹
            </button>
            <span className="ask-progress">
              {index + 1}/{items.length}
            </span>
            <button
              type="button"
              className="ask-page"
              data-ask-page="next"
              disabled={isLast || busy}
              title="下一题"
              onClick={() => {
                setFocus(index + 1)
                setHint('')
              }}
            >
              ›
            </button>
          </div>
        ) : null}
        <span className="ask-hint" role="status">
          {hint}
        </span>
        <button
          type="button"
          className="btn-ghost ask-skip"
          disabled={busy}
          onClick={skipCurrent}
          title="这题不答，问下一题"
        >
          跳过
        </button>
        <button
          type="button"
          className="btn-primary ask-submit"
          data-ask-submit={isLast ? 'submit' : 'next'}
          disabled={!answered(draft) || busy}
          onClick={continueFlow}
        >
          {isLast ? '提交' : '下一题'}
        </button>
      </div>
      {fault === null ? null : <div className="shell-composer-fault">没交上去：{fault}</div>}
    </div>
  )
}
