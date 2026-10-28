/**
 * approval 插件：provide `approval` 服务——工具执行的裁决引擎 + 审批卡。
 *
 * 一次判定按这个顺序走，前面的层一旦说话，后面的层不再有机会放宽：
 *   1. 硬地板   —— 灾难性命令与关键系统路径，任何权限模式都拒（含完全访问）；
 *   2. 路径护栏 —— 说明书类文件（AGENTS.md、dsc 配置）必须当面确认一次，不许任何自动档代劳；
 *   3. 命令策略 —— 用户前缀规则 + 内置危险模式（`~/.dsc/policy.rules`）；
 *   4. 已给授权 —— 本会话内的同类授权（按会话 id 键控，切会话即失效）；
 *   5. 权限模式 —— readonly / auto-edit / full-access 的自动放行集；
 *   5.5 审阅者   —— user / auto-review：要问的事先给谁看（复核跑在自动放行**之前**）；
 *   6. 人工审批卡 —— 四档决定（这次允许 / 本会话允许 / 永久允许 / 拒绝），超时按拒处理。
 *
 * 两个前置判断插在中间：命中灾难地板白名单的命令免卡放行（地板自己不 return pass，
 * 那样会跳掉 order 20 / 25 的安全钩子，所以免卡这一步落在这里）；没有人能回答审批卡时
 * 直接按拒处理，不白等一次超时——脚本与 CI 场景没人会来点那张卡。
 *
 * 顺序照两家成熟做法：Hermes 的 hardline 与用户 deny 表在 yolo 之前求值
 * （`tools/approval_floors.py:5`），Codex 的命令分段与 `PermissionGrantScope{Turn,Session}`
 * 决定授权档位（`protocol/src/request_permissions.rs:12`）。DSH 的
 * `approval/asked` + `approval/decided` 成对审计也照搬（`user-approval/src/index.ts:215-234`）。
 *
 * 这一整套裁决挂在守卫链的 order 30 上（协作模式那道闸门排在 order 10，先问模式再问审批），
 * 所以循环不必认识「审批」这件事。等卡期间这张卡登记在「正在等人」的表里。
 * 等多久没人答算超时是插件配置（`approval.approvalTimeoutMs`）。
 *
 * @module dsc/plugins/approval
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ApprovalDecision, ApprovalRequest } from '../core/approval.js'
import { argsSummary, callFacts, stripBaseline } from '../core/tools.js'
import { summarizeChange } from '../core/tools/fs-tools.js'
import { SANDBOX_PERMISSION_EFFECT, readSandboxRequest } from '../core/tools/sandbox-args.js'
import { REJECTED_TOOL_TEXT } from '../core/session.js'
import type { Session } from '../core/session.js'
import { permissionOf, writePermissions } from '../core/permission-scope.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { toolApprovalGuard, type ToolObserver } from '../core/tool-guards.js'
import type { ApprovalPolicy, ApprovalRequestView, ApprovalService } from '../services/types.js'
import type { ApprovalAnswer, ApprovalDiffView, ApprovalEscalationView, ApprovalReviewer, CollaborationMode, PolicySurface, TierOption } from '../contract.js'
import { activeRules, appendRule, classifyCommand, reloadActiveRules } from '../core/command-policy.js'
import { isInsideCwd, isProtectedInstruction, writeHardBlockReason } from '../core/path-policy.js'
import { audit } from '../core/audit.js'
import { redact } from '../core/secrets.js'
import { callMeaning } from '../core/call-meaning.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'approval'

/** 审批卡等多久没人答就按拒处理（抄 Hermes 的 approvals.timeout 默认 300s）；配置没给时用这个。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

/**
 * 取审批卡的等待时限：夹在 10 秒到 1 小时之间（再短一点就来不及答，再长等于不超时）。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readTimeout(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.approvalTimeoutMs)
  if (!Number.isFinite(num)) return DEFAULT_APPROVAL_TIMEOUT_MS
  return Math.min(Math.max(Math.round(num), 10_000), 3_600_000)
}

/** 权限模式三档的界面文案（界面画档位按钮时读这份，不再自己抄一份）。 */
const POLICY_OPTIONS: ReadonlyArray<TierOption<ApprovalPolicy>> = [
  { id: 'readonly', label: '仅查看', hint: '只读模式：读类操作放行，写/执行类一律拒绝' },
  { id: 'auto-edit', label: '自动编辑', hint: '工作区内写操作自动放行，其余需审批' },
  { id: 'full-access', label: '完全访问', hint: '全部工具自动放行，谨慎使用' },
]

/**
 * 审阅者两档的界面文案。这一轴与权限模式正交（参考实现的 `approvals_reviewer`）：
 * 档位决定「哪些事要问」，审阅者决定「要问的事先给谁看」。
 */
const REVIEWER_OPTIONS: ReadonlyArray<TierOption<ApprovalReviewer>> = [
  { id: 'user', label: '本人审阅', hint: '要问的事弹审批卡，等你点' },
  {
    id: 'auto-review',
    label: 'AI 复核',
    hint: '要问的事先给模型判官看：判放行就直接过，判高风险或判不出来再落回你的审批卡',
  },
]

/** 写类工具里「目标在工作区内就能自动放行」的那几个。 */
const PATH_WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * write / edit 审批卡的「将做的改动」（codex 审批弹窗内嵌 diff 的同位能力）：
 * 读盘上现值、按工具语义推演写后的全文、走 summarizeChange 同一套算法截断。
 * 与渲染层工具卡的推演（intended-diff.ts）同一套语义，两处分头实现——宿主这份
 * 在弹卡前算好随视图下发，渲染层那份等服务期里自己读盘，环境不同没有共享面。
 *
 * 三种降级：盘上读不到（工作区外 / 文件还不存在）→ write 从空串、edit 用 old→new
 * 的参数差异，标 `fellBack`；edit 的 old 对不上盘（missing / 多处）→ 执行必然失败，
 * 给参数差异并标 `mismatch`，卡片上要提示；完全算不出（非这两类工具、参数不齐、
 * 内容一致）→ null，卡片回到只有参数摘要的常态。
 */
export async function approvalDiffOf(request: ApprovalRequest): Promise<ApprovalDiffView | null> {
  if (request.toolName !== 'write' && request.toolName !== 'edit') return null
  const args = request.args ?? {}
  const rawPath = typeof args.path === 'string' ? args.path : ''
  if (rawPath === '') return null
  // 绝对路径不需要基准；相对路径必须有 cwd 才算得出在看哪一份文件。都没有就不给
  // 差异预览（卡片退回参数摘要那条常态），**不**拿 process.cwd() 猜——猜出来的
  // 差异是另一个目录里的同名文件，比没有更糟。
  if (!isAbsolute(rawPath) && (request.cwd === undefined || request.cwd === '')) return null
  const abs = isAbsolute(rawPath) ? rawPath : resolve(request.cwd ?? '', rawPath)
  const content = typeof args.content === 'string' ? args.content : null
  const oldText = typeof args.old === 'string' ? args.old : null
  const newText = typeof args.new === 'string' ? args.new : null
  if (request.toolName === 'write' ? content === null : oldText === null || newText === null) return null
  const read = await fsp.readFile(abs, 'utf8').catch(() => null)
  let effectiveBefore: string
  let after: string
  let mismatch: ApprovalDiffView['mismatch']
  if (request.toolName === 'write') {
    effectiveBefore = read ?? ''
    after = content!
  } else if (read === null) {
    effectiveBefore = oldText!
    after = newText!
  } else {
    const at = read.indexOf(oldText!)
    if (at < 0) {
      mismatch = 'missing'
      effectiveBefore = oldText!
      after = newText!
    } else if (read.indexOf(oldText!, at + 1) >= 0) {
      mismatch = 'ambiguous'
      effectiveBefore = oldText!
      after = newText!
    } else {
      effectiveBefore = read
      after = read.slice(0, at) + newText! + read.slice(at + oldText!.length)
    }
  }
  const changes = summarizeChange(abs, effectiveBefore, after)
  // 内容一致（覆盖写了个寂寞）也给一份空 diff：卡片上「不会有实际改动」比「没有信息」好。
  const clean =
    changes === undefined
      ? { path: abs, added: 0, removed: 0, hunks: [], status: 'modified' as const }
      : stripBaseline(changes)
  return {
    ...clean,
    // hunks 的行文本会摊到卡上：密钥形状的字符串过一遍遮红，别让审批动作本身泄密
    hunks: clean.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ ...line, text: redact(line.text) })),
    })),
    ...(read === null ? { fellBack: true } : {}),
    ...(mismatch !== undefined ? { mismatch } : {}),
  }
}

/** 一张卡允许出现的授权档位。 */
type GrantScope = 'once' | 'session' | 'always'

/** 风险档位：给审批卡上色，也决定 AI 审查能不能替用户做主。 */
type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export const approvalPlugin: Plugin.Object = {
  name: 'approval',
  inject: ['llm', 'session', 'guards', 'surfaces', 'waiting'],
  provide: 'approval',
  apply(ctx, passed) {
    /**
     * 三项权限**按会话**读（2026-10-28）：这里不再是进程级变量。
     * 会话没钉过时用偏好里的默认值，并在第一次读时钉进会话（见 core/permission-scope）。
     */
    const defaultPolicy = (): ApprovalPolicy => ctx.get('settings')?.prefs().defaultPolicy ?? 'auto-edit'
    /**
     * 「要问的事先给谁看」——与权限模式正交的一根轴。
     * `user` = 弹卡等用户点（出厂默认）；`auto-review` = 先给模型判官，判不出来再落人工卡。
     */
    const defaultReviewer = (): ApprovalReviewer => ctx.get('settings')?.prefs().defaultReviewer ?? 'user'
    /** 这次判定属于哪个会话：请求带了路径就找那个常驻会话，否则看当前查看的。 */
    const sessionOf = (sessionPath?: string): Session => {
      if (sessionPath !== undefined && sessionPath !== '') {
        const found = ctx.get('agent')?.sessionFor(sessionPath)
        if (found !== undefined) return found
      }
      return ctx.session.current()
    }
    /** 某个会话现在生效的权限模式。 */
    const policyOf = (session: Session): ApprovalPolicy => permissionOf(session, 'policy', defaultPolicy())
    /** 某个会话现在生效的审阅者。 */
    const reviewerOf = (session: Session): ApprovalReviewer => permissionOf(session, 'reviewer', defaultReviewer())
    // 每次弹卡现读：改了等待时限不必重启宿主，下一张卡就用新值。
    const timeoutMs = (): number => readTimeout(passed)
    /**
     * 当前协作模式，只进审批卡的说明文字与审计记录。
     * 听 `dsc/mode-changed` 而不是反过来依赖模式服务：mode 已经依赖 approval（审计要写当时的权限模式），
     * 两头互相依赖在依赖图上就是环。
     */
    let modeForCard: CollaborationMode = 'build'
    /** 本会话内的同类授权：sessionId → 授权键集合。 */
    const sessionGrants = new Map<string, Set<string>>()

    /** 一张挂着等人答的审批卡。0.6.48 起多卡并存（常驻多 agent：后台会话也会弹卡）。 */
    interface PendingCard {
      view: ApprovalRequestView
      grantKey: string
      suggestedRule: string[] | null
      done: (decision: ApprovalDecision, phase?: 'decided' | 'cancelled' | 'timeout') => void
      timer: NodeJS.Timeout
      /** 这个答案是从哪儿点下来的（'app' 宿主界面 / 'web' 手机浏览器）；没人答过时 undefined。 */
      source?: 'app' | 'web'
      /** 这张卡属于哪个会话：授权记账、审计与侧栏状态点都按它归属。 */
      sessionId: string
      /** 答「本会话允许」时要并进本会话可写根的路径；null = 这张卡不带沙箱放宽。 */
      sandboxSessionRoot: string | null
      sessionPath: string
    }
    /** 卡 id → 卡。插入序 = 弹卡序；界面取最老的一张展示。 */
    const pendings = new Map<string, PendingCard>()

    /** 规则文件重新读一遍（写在永久规则之后，让下一条判定立刻看到它）。 */
    const reloadRules = (): void => {
      for (const problem of reloadActiveRules().problems) ctx.emit('dsc/notice', `规则文件：${problem}`)
    }
    reloadRules()

    /** 当前会话 id（授权键与审计都挂在它下面）。 */
    const sessionId = (): string => ctx.session.current().meta.id

    /**
 * 只取一句话（到第一个句号或换行为止）。
 *
 * 沙箱守卫的越界说明里带着「可写根：D:\dsh、D:\dsc\…\tmp\<uuid>」这一长串——那是给
 * 排查用的，摆在卡片上换来的是用户根本读不完的一行字。卡片要的是「哪个路径不在范围内」，
 * 后面那一串留在工具结果里。
 */
function firstSentence(text: string): string {
  const cut = text.search(/[。\n]/)
  return cut < 0 ? text : text.slice(0, cut)
}

/** 这次判定属于哪个会话：请求带了发起方就按发起方（0.6.48 多 agent），否则看当前查看的。 */
    const sidOf = (request: ApprovalRequest): string => request.sessionId ?? sessionId()

    /** 这次判定的会话 jsonl 路径（侧栏状态点的键口径）。 */
    const pathOf = (request: ApprovalRequest): string => request.sessionPath ?? ctx.session.current().filePath

    /**
     * 这次判定的路径基准：请求自带 `cwd` 优先（工具那条路都带着会话目录），
     * 没带就退到**当前会话的目录**。
     *
     * 为什么不再用 `process.cwd()`：目录是会话自己的数据（多工作区并用之后，进程目录
     * 已经没有用户意义）——拿它当基准既会把别的会话的合法目标判成越界，也会让卡片上
     * 那句「工作目录」说谎。
     */
    const baseCwd = (request: ApprovalRequest): string => {
      if (request.cwd !== undefined && request.cwd !== '') return request.cwd
      try {
        return ctx.session.current().meta.cwd
      } catch {
        return ''
      }
    }

    /** 当前查看会话的最老一张挂起卡；没有就 undefined（pendingView/answer 同用它定口径）。 */
    const currentForHere = (): PendingCard | undefined => {
      const here = ctx.session.current().filePath
      for (const card of pendings.values()) {
        if (card.sessionPath === here) return card
      }
      return undefined
    }

    /** 这次调用属于哪个「同类」：同一会话里再出现就不再问的粒度。 */
    function grantKeyOf(toolName: string, suggested: string[] | null, insideCwd: boolean): string {
      if (suggested !== null) return `${toolName}:${suggested.join(' ')}`
      if (PATH_WRITE_TOOLS.has(toolName)) return `${toolName}:${insideCwd ? 'inside-cwd' : 'outside-cwd'}`
      return toolName
    }

    /**
     * 现在有没有人能回答审批卡。
     *
     * 有界面入口登记（tui / host-stdio）就以它为准；没有登记时看这一进程是不是终端直连。
     * 两者都没有就是脚本、CI、无头调用——没人能点那张卡，等满超时只是白等 5 分钟。
     */
    const someoneCanAnswer = (): boolean => {
      const ui = ctx.get('interactive')
      if (ui !== undefined) return ui.reachable()
      return process.stdin.isTTY === true
    }

    /** 挂起人工审批卡：等到答案、等到超时、或等到本轮被打断。 */
    const askHuman = (
      request: ApprovalRequest,
      signal: AbortSignal,
      input: {
        reason: string
        risk: RiskLevel
        /**
         * 卡片上那行参数摘要。命令类调用传命令原文——给命令套一层 `{"command":"…"}`
         * 只增加噪音，而这一行本来就是给人读的（审计记的也是同一份）。
         */
        summary: string
        /** 这次调用「要干什么」的中文一句话；null = 认不出来，卡上不画那一行。 */
        meaning: string | null
        suggestedRule: string[] | null
        scopes: GrantScope[]
        /** 这次判定所属会话的权限模式与审阅者（卡面与审计都按它，不再读全局变量）。 */
        policy: ApprovalPolicy
        reviewer: ApprovalReviewer
        /** 这次判定所属会话的协作模式（卡面与审计按它）。 */
        mode: CollaborationMode
        grantKey: string
        hardline: boolean
        /** write/edit 的「将做的改动」；算不出来时 null，卡上就不画。 */
        diff: ApprovalDiffView | null
        /** 模型这次在请求放宽沙箱（走填参数那条路）；没请求就是 null。 */
        escalation: ApprovalEscalationView | null
        /**
         * 「本会话允许」要并进这个会话可写根的绝对路径；null = 这张卡不给 session 档。
         * 为什么只有写类工具能给：命令类调用的写目标静态界定不出来，
         * 给它 session 档等于把一个无法界定的边界永久放宽——宁可不给。
         */
        sandboxSessionRoot: string | null
      },
    ): Promise<ApprovalDecision> =>
      new Promise<ApprovalDecision>((resolveDone) => {
        // 已经中止就是「这一轮已经取消」：这时再登记卡，abort 事件不会补发（EventTarget 语义），
        // 卡要挂满超时才自解，用户看到的是一张没人管的幽灵卡。所以先看信号再决定要不要登记。
        if (signal.aborted) {
          resolveDone('reject')
          return
        }
        // 没人能回答就不弹卡：超时按拒是同一条结论，只是早 300 秒给出，并且理由说清了为什么。
        if (!someoneCanAnswer()) {
          autoLog('auto-deny', request, '当前没有界面能回答审批卡（没有终端界面，也没有桌面客户端），按拒处理')
          resolveDone('reject')
          return
        }
        const id = randomUUID()
        const sid = sidOf(request)
        const view: ApprovalRequestView = {
          id,
          toolName: request.toolName,
          argsSummary: redact(input.summary),
          ...(input.meaning === null ? {} : { meaning: input.meaning }),
          reason: input.reason,
          risk: input.risk,
          suggestedRule: input.suggestedRule,
          hardline: input.hardline,
          scopes: input.scopes,
          ...(input.escalation === null ? {} : { escalation: input.escalation }),
          policy: input.policy,
          reviewer: input.reviewer,
          mode: input.mode,
          // 发起会话归属（0.6.49）：卡片是全局渲染的，后台会话的卡弹出来时界面要标得清是谁家的
          sessionPath: pathOf(request),
          ...(input.diff === null ? {} : { diff: input.diff }),
        }
        audit({
          ts: Date.now(),
          kind: 'approval',
          id,
          phase: 'asked',
          tool: request.toolName,
          summary: view.argsSummary,
          reason: input.reason,
          policy: input.policy,
          mode: input.mode,
          sessionId: sid,
          cwd: request.cwd,
        })
        const done = (decision: ApprovalDecision, phase: 'decided' | 'cancelled' | 'timeout' = 'decided'): void => {
          const card = pendings.get(id)
          if (card === undefined) return
          pendings.delete(id)
          // 来源要在清掉挂起之前取出来：下面这行之后这个对象就没人持有了。
          // 超时与被打断没人答过，card.source 还是 undefined，审计里就不写这一栏。
          const source = card.source
          clearTimeout(card.timer)
          ctx.emit('dsc/changed')
          // 卡收了，那个会话要是还在跑回合就回到 working（转录层的状态点跟着翻回来）
          ctx.emit('dsc/agent-status', { sessionId: sid, path: card.sessionPath, state: 'working' })
          audit({
            ts: Date.now(),
            kind: 'approval',
            id,
            phase,
            tool: request.toolName,
            summary: view.argsSummary,
            decision: decision === 'reject' ? (phase === 'decided' ? 'reject' : phase) : decision,
            reason: input.reason,
            policy: input.policy,
            mode: input.mode,
            sessionId: sid,
            ...(source === undefined ? {} : { source }),
          })
          resolveDone(decision)
        }
        const timer = setTimeout(() => done('reject', 'timeout'), timeoutMs())
        pendings.set(id, {
          view,
          grantKey: input.grantKey,
          suggestedRule: input.suggestedRule,
          done,
          timer,
          sessionId: sid,
          sessionPath: pathOf(request),
          sandboxSessionRoot: input.sandboxSessionRoot,
        })
        ctx.emit('dsc/changed')
        // 后台会话的卡也要让侧栏状态点亮起来（当前查看会话的状态走 turnState，转录层会忽略同路径）
        ctx.emit('dsc/agent-status', { sessionId: sid, path: pathOf(request), state: 'awaiting-approval' })
        signal.addEventListener('abort', () => done('reject', 'cancelled'), { once: true })
      })

    /** 自动裁决落一条审计（放行的原因必须写清是谁放的）。 */
    const autoLog = (
      kind: 'auto-allow' | 'auto-deny',
      request: ApprovalRequest,
      reason: string,
      extra: { rule?: string[]; scope?: 'session' | 'always' } = {},
    ): void => {
      audit({
        ts: Date.now(),
        kind,
        tool: request.toolName,
        summary: redact(request.argsSummary),
        reason,
        policy: policyOf(sessionOf(request.sessionPath)),
        mode: ctx.get('mode')?.modeFor(sidOf(request)) ?? modeForCard,
        sessionId: sidOf(request),
        cwd: request.cwd,
        ...extra,
      })
    }

    /**
     * 一次复核的结论：`decision` 非空 = 放行；null = 回落到人工卡，理由在 `note` 里。
     * `note` 同时进审计与审批卡，解决「卡弹出来了却查不出为什么没自动过」。
     */
    interface ReviewVerdict {
      decision: ApprovalDecision | null
      note: string
      /**
       * true = 判官**没给意见**（超时、网络断、返回的不是 JSON）。
       *
       * 与「判官说不放行」是两件事：后者是它看过了、不同意，必须弹卡；
       * 前者是它压根没看上，这时不该把它的缺席当成否决——
       * 否则对家网络抖一下，用户就得多点一张卡（0.7.1 实况）。
       */
      failed: boolean
    }

    /**
     * AI 自动审查：让模型出一份结构化裁决，而不是一个 ALLOW/DENY 词。
     * 风险分类照 Codex 的 guardian policy（数据外泄 / 凭据探测 / 持久性安全弱化 /
     * 破坏性动作 / 低风险白名单，`prompts/templates/guardian/policy.md`）。
     * 判到 high 或 critical 一律回落到人工卡——AI 不许替用户承担这个责任。
     *
     * 三种结局都要留痕：判官放行、判官否决、判官没跑完。少了任何一条，用户看到卡
     * 就查不出「凭什么没自动过」——0.7.1 的实况是 91a667f5 会话弹了 3 张卡、审计里
     * 0 条 auto-deny，连是不是判官挂了都答不上来。
     */
    const aiReview = async (request: ApprovalRequest, signal: AbortSignal): Promise<ReviewVerdict> => {
      try {
        // 判官跑在「发起这次调用的会话」的模型上（后台会话不拿当前视图的模型）
        const route = ctx.llm.routeForSession(sessionOf(request.sessionPath))
        const result = await ctx.llm.stream(
          route.api,
          {
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            // 这次审查是**发起调用的那条会话**的请求（审批卡按它归属，归因头跟着走）
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            maxTokens: 300,
            thinking: 'disabled',
            signal,
            messages: [
              {
                role: 'system',
                content:
                  '你是工具执行的自动安全审查器，不参与完成任务，只判断这一次操作该不该放行。\n' +
                  '风险分类：\n' +
                  '- 数据外泄：把本地文件、环境变量、仓库内容发到外部地址；\n' +
                  '- 凭据探测：读取或打印密钥、token、私钥、浏览器/SSH 凭据；\n' +
                  '- 持久性安全弱化：关杀毒/防火墙、改注册表启动项、建账号或计划任务、放开文件权限；\n' +
                  '- 破坏性动作：递归删除、强推、清库、销毁基础设施、覆盖未读过的文件；\n' +
                  '- 低风险：读文件、查状态、跑测试、工作目录内的常规改动。\n' +
                  '判断要点：用户这一轮有没有明确要求做这件事？范围有没有被扩大？\n' +
                  '只输出一个 JSON：{"risk":"low|medium|high|critical","authorized":true|false,"reason":"一句话中文理由"}',
              },
              {
                role: 'user',
                content: redact(
                  `工具：${request.toolName}\n参数：${JSON.stringify(request.args ?? request.argsSummary)}\n工作目录：${baseCwd(request)}`,
                ),
              },
            ],
          },
          { onDelta: () => {} },
        )
        const raw = result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1)
        const verdict = JSON.parse(raw) as { risk?: string; authorized?: boolean; reason?: string }
        // 只有 high / critical 必须落回人工卡；medium 与 low 走同一条路（放行），
        // 所以这里是个布尔而不是三档——别把它读成「medium 被降级」。
        const highRisk = verdict.risk === 'critical' || verdict.risk === 'high'
        if (highRisk) {
          const why = verdict.reason ?? '未说明'
          autoLog('auto-deny', request, `AI 审查判为高风险：${why}`)
          return { decision: null, note: `AI 复核判为高风险：${why}`, failed: false }
        }
        if (verdict.authorized === false) {
          const why = verdict.reason?.trim() ?? ''
          const said = why === '' ? '判官没给理由' : why
          autoLog('auto-deny', request, `AI 复核判不放行：${said}`)
          return { decision: null, note: `AI 复核判不放行：${said}`, failed: false }
        }
        autoLog('auto-allow', request, 'AI 复核放行')
        return { decision: 'allow-once', note: 'AI 复核放行', failed: false }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        // 这一轮被用户打断：不是判官的问题，也别写成「回落到人工卡」——卡不会弹。
        if (signal.aborted) {
          autoLog('auto-deny', request, `AI 复核被这一轮的中止打断：${why}`)
          return { decision: null, note: `AI 复核被中止（${why}），这次不执行`, failed: true }
        }
        // 判官超时、网络断、返回的不是 JSON：都算「没跑完」。这一类的去向由上面的调用方定
        // （判官缺席就按权限档自己的结论走），这里只负责把原因写清楚。
        autoLog('auto-deny', request, `AI 复核没跑完：${why}（这次不按复核否决处理）`)
        return { decision: null, note: `AI 复核没跑完（${why}），这次交给你决定`, failed: true }
      }
    }

    const service: ApprovalService = {
      get policy() {
        return policyOf(ctx.session.current())
      },

      setPolicy(next) {
        writePermissions(ctx.session.current(), { policy: next })
        // 不往对话里写「权限模式切换为…」（2026-10-28 用户报障）：启动时 settings 与
        // permission-presets 会各自按偏好复算一遍，同一组值能被写两三行；而这些值在输入框
        // 那颗旋钮上一直看得见。要留痕的是审计（下一行），不是对话流。用户主动切换的回执
        // 由调用方给：界面走 permission-presets 的那一句，斜杠命令由 commands 自己写。
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `权限模式 → ${next}`,
          policy: next,
          mode: ctx.get('mode')?.modeFor(sessionId()) ?? modeForCard,
          sessionId: sessionId(),
        })
      },

      get reviewer() {
        return reviewerOf(ctx.session.current())
      },

      setReviewer(next) {
        writePermissions(ctx.session.current(), { reviewer: next })
        // 与 setPolicy 同一条理由：这行曾是「新会话一进来就刷四五行」的一半噪声。
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `审批审阅者 → ${next}`,
          policy: policyOf(ctx.session.current()),
          mode: ctx.get('mode')?.modeFor(sessionId()) ?? modeForCard,
          sessionId: sessionId(),
        })
      },

      async decide(request: ApprovalRequest, signal, options): Promise<ApprovalDecision> {
        const cwd = baseCwd(request)
        // 这个请求所属会话的三项权限：卡面、自动放行与审计都按它，不再读进程级变量。
        const session = sessionOf(request.sessionPath)
        const policy = permissionOf(session, 'policy', defaultPolicy())
        const reviewer = permissionOf(session, 'reviewer', defaultReviewer())
        // 卡面写「这次属于哪个模式」：按请求会话取，后台会话的卡不会标成当前视图的模式。
        const cardMode = ctx.get('mode')?.modeFor(session.meta.id) ?? modeForCard
        // 安全钩子可以要求「这一次必须问人」：非空时下面所有自动放行档一律跳过。
        const forced = options?.forceAskReason?.trim() ?? ''
        const facts = callFacts(request.args ?? {}, cwd)
        const target = facts.target ?? null
        const command = facts.command ?? null
        const insideCwd = target !== null && isInsideCwd(cwd, target)
        // 卡片上给人看的两样东西：一行「这次要干什么」，一行命令原文。
        // 命令原文直接当参数摘要用（不再套 JSON 壳），认不出命令时退回原来的摘要。
        const meaning = callMeaning({ toolName: request.toolName, command, target })
        const summary = command ?? request.argsSummary
        const verdict = command === null ? null : classifyCommand(command, { rules: activeRules() })
        // 模型这次有没有在请求放宽沙箱（工具参数那条路）。有就摊到卡上，并据此收窄授权档位。
        const request0 = readSandboxRequest(request.args ?? {})
        const escalation: ApprovalEscalationView | null =
          request0.kind === 'ok'
            ? {
                permission: request0.permission,
                scope: request0.scope,
                justification: request0.justification,
                effect: SANDBOX_PERMISSION_EFFECT[request0.permission],
              }
            : null
        // 「本会话允许」要并进可写根的那个路径：只有「留在沙箱内放宽写边界 + 写类工具 + 认得出目标」
        // 三者同时成立才给——命令类没有能静态界定的目标，给它 session 档等于永久放宽一个说不清的边界。
        const sandboxSessionRoot =
          escalation !== null && escalation.permission === 'workspace-write' && target !== null && PATH_WRITE_TOOLS.has(request.toolName)
            ? target
            : null

        // 第 1 层：硬地板。灾难性命令与关键系统路径，任何模式都拒，连卡都不弹。
        if (target !== null) {
          const hard = writeHardBlockReason(target)
          if (hard !== null) {
            autoLog('auto-deny', request, hard)
            return 'reject'
          }
        }
        if (verdict !== null && verdict.hardline) {
          autoLog('auto-deny', request, `硬地板拒绝：${verdict.reason}`)
          return 'reject'
        }

        // 第 2 层：说明书类文件（AGENTS.md / CLAUDE.md / .cursorrules / dsc 配置）。
        // 模型改自己的规则是最省事的作弊路径，所以这一条压过所有自动档。
        const protectedWhy = target === null ? null : isProtectedInstruction(target, cwd)

        // 第 3 层：已给授权。同会话同类动作不再问第二次；永久规则命中 exec 时也在此放行。
        // 0.6.48：按发起调用的会话记账（后台 agent 的授权不看当前查看的会话）。
        const suggested = verdict?.prefixRule ?? null
        const grants = sessionGrants.get(sidOf(request))
        const key = grantKeyOf(request.toolName, suggested, insideCwd)
        const grantHit = protectedWhy === null && forced === '' && (grants?.has(key) ?? false)
        if (grantHit) {
          autoLog('auto-allow', request, '本会话已允许同类操作', { scope: 'session' })
          return 'allow-once'
        }
        if (
          forced === '' &&
          verdict !== null &&
          verdict.decision === 'allow' &&
          verdict.matchedRule !== null &&
          protectedWhy === null
        ) {
          autoLog('auto-allow', request, `规则允许：${verdict.reason}`, { rule: verdict.matchedRule.pattern })
          return 'allow-once'
        }

        // 灾难地板的白名单：地板判过「这条命令不需要有人回答」，但它自己不 return pass
        // （那样会把 order 20 的安全钩子与 order 25 的生命周期钩子一起跳掉），免卡这一步落在审批层。
        // 钩子要求当面看一次（forced）或目标是指明书类文件（protectedWhy）时白名单不生效。
        const floor = ctx.get('approvalFloor')
        if (forced === '' && protectedWhy === null && command !== null && floor !== undefined) {
          const prefix = floor.whitelist(command)
          if (prefix !== null) {
            autoLog('auto-allow', request, `命中审批灾难地板白名单「${prefix.join(' ')}」，免审批卡`)
            return 'allow-once'
          }
        }

        // 第 4 层：沙箱边界。沙箱守卫（order 8）对「能问的越界」只 defer，
        // 最后一道落在这里：越过沙箱的事一律跳过所有自动放行，直接弹卡（只给一次）。
        // 这一层必须排在权限模式与审阅者之前——否则「完全访问」会把沙箱的拒绝吃掉。
        const fence = ctx.get('sandbox')?.check(target ?? undefined, command ?? undefined, cwd, request.sessionPath)
        const fenced = fence !== undefined && !fence.allowed
        /** 复核给出的「为什么没自动过」；null = 没跑复核，或复核放行了。要进卡片的理由。 */
        let reviewNote: string | null = null

        // 第 5 层：权限模式自己的裁决（protected 文件不参与，强制走人工卡）。
        if (protectedWhy === null && forced === '' && !fenced) {
          if (policy === 'readonly') {
            // 「仅查看」的字面意思就是只读：策略引擎判成 allow 的命令（查看目录、看 git 状态、
            // 管道里只做筛选与格式化）原样放行，只有写与执行类才一律拒。
            // 少了这一条，`Get-ChildItem | Format-Table` 这种纯查看也会被这档拒掉，用户要读代码都没法读。
            if (verdict !== null && verdict.decision === 'allow') {
              autoLog('auto-allow', request, '仅查看模式：只读命令放行')
              return 'allow-once'
            }
            autoLog('auto-deny', request, '当前是「仅查看」权限模式，写与执行类工具一律拒绝')
            return 'reject'
          }
          // 权限档自己会不会放行这一次：返回放行理由，不放行给 null。
          // 单独抽出来是为了让「复核没跑完」能走同一份判断（见下），两处不必各写一遍。
          const policyAutoReason = (): string | null => {
            if (policy === 'full-access') return '当前是「完全访问」权限模式'
            if (policy !== 'auto-edit') return null
            // 工作区内免卡还要沙箱同意：沙箱档位是 read-only 时，同一个路径也不许写。
            // 少了这一半，只读档会先被审批放行、再被沙箱拒，模型拿到的是「自动放行失败」。
            const writable = PATH_WRITE_TOOLS.has(request.toolName) && insideCwd && (fence?.allowed ?? true)
            if (writable) return '工作区内的文件改动，按「工作区自动编辑」放行'
            if (verdict !== null && verdict.decision === 'allow') return `只读命令：${verdict.reason}`
            return null
          }
          // 第 5.5 层（顺序在自动放行之前，2026-10-28 修）：审阅者 auto-review 时
          // **每一次走到这里的事**都先给模型判官看一眼——包括「完全访问」本来会直接
          // 放行的那些。判 allow 直接过；判高风险或判不放行落回第 6 层人工卡。
          // 只读档在上面已经拒了，轮不到判官放宽。
          if (reviewer === 'auto-review') {
            const reviewed = await aiReview(request, signal)
            if (reviewed.decision !== null) return reviewed.decision
            reviewNote = reviewed.note
            // 判官**没给意见**（超时、网络断、返回的不是 JSON）不等于判官否决：
            // 这时结论回到用户自己选的那一档，不能因为对方网络抖一下就让用户来点卡。
            // 判官明确说不放行的（deny）不在此列，它照旧弹卡；这一轮被打断时也不放行。
            const fallback = reviewed.failed && !signal.aborted ? policyAutoReason() : null
            if (fallback !== null) {
              autoLog('auto-allow', request, `AI 复核没跑完，按权限档放行：${fallback}`)
              return 'allow-once'
            }
          } else {
            const allowed = policyAutoReason()
            if (allowed !== null) {
              autoLog('auto-allow', request, allowed)
              return 'allow-once'
            }
          }
        }

        // 第 6 层：人工审批卡。钩子要求确认时卡片上的原因就用它，用户才知道这张卡为什么非弹不可。
        const baseReason =
          fenced
            ? `沙箱边界：${firstSentence(fence?.reason ?? '这次调用越界')}（允许这一次就破例执行，沙箱对这一次不再拦）`
            : escalation !== null
              ? `模型请求放宽沙箱（${escalation.effect}）：${escalation.justification}`
              : forced !== ''
                ? forced
                : protectedWhy !== null
                  ? protectedWhy
                  : (verdict?.reason ?? (insideCwd ? '工作区内的改动需要确认' : '工作区外的改动需要确认'))
        // 卡上写「为什么现在才问你」：复核否决或没跑完时以它为准。命令层那句「需要授权」
        // 是兜底说法，用户对着它猜不出是判官不放行还是判官挂了（0.7.1 的实况）。
        const reason = reviewNote ?? baseReason
        const risk: RiskLevel =
          fenced || protectedWhy !== null ? 'high' : forced !== '' ? 'medium' : verdict?.decision === 'ask' ? 'medium' : insideCwd ? 'low' : 'medium'
        const scopes: GrantScope[] = ['once']
        // 沙箱越界只给「这一次」：放宽写边界是逐次决定，跨调用持久化没人能替用户担保。
        if (fenced) {
          // 只留 once
        } else if (escalation === null) {
          if (protectedWhy === null) scopes.push('session')
          if (suggested !== null && protectedWhy === null) scopes.push('always')
        } else if (sandboxSessionRoot !== null) {
          // 升权卡只给「这次允许 / 本会话允许」：这里没有可持久化的前缀规则（always 不适用），
          // 而「出沙箱」那一档连 session 都不给——跨调用的无围栏状态没人能替用户担保。
          scopes.push('session')
        }
        // 弹卡前把「将做的改动」算好随视图下发（write/edit 才有；一次读盘 + LCS，
        // 只有真要等人点卡的时刻才付这个成本）。
        const diff = await approvalDiffOf(request)
        return askHuman(request, signal, {
          reason,
          risk,
          summary,
          meaning,
          suggestedRule: suggested,
          scopes,
          policy,
          reviewer,
          mode: cardMode,
          grantKey: key,
          hardline: false,
          diff,
          escalation,
          sandboxSessionRoot,
        })
      },

      surface(): PolicySurface {
        const current = ctx.session.current()
        return {
          current: policyOf(current),
          options: [...POLICY_OPTIONS],
          reviewer: reviewerOf(current),
          reviewerOptions: [...REVIEWER_OPTIONS],
        }
      },

      pendingView() {
        // 只返回当前查看会话的卡（0.6.50 对齐 dsh 的「卡只在归属会话的视图里」）：
        // 后台会话的卡留在它自己的会话里，侧栏的橙点引导你切过去答。
        // 多卡并存时取最老的一张（插入序）：答完一张，下一张自动顶上来。
        const current = currentForHere()
        return current === undefined ? null : current.view
      },

      /** 这个会话现在有没有挂着审批卡（agent 切走时重发状态点用）。 */
      pendingFor(filePath: string) {
        for (const card of pendings.values()) {
          if (card.sessionPath === filePath) return true
        }
        return false
      },

      answer(answer: ApprovalAnswer, source: 'app' | 'web' = 'app') {
        // 与 pendingView 同口径：答的就是界面上显示的那张——当前查看会话的最老一张。
        // 以前取全局最老，答卡可能答到别的会话头上去。
        const current = currentForHere()
        if (current === undefined) return
        // 来源挂在挂起对象上，`done` 里落审计时取用；手机浏览器点的那一下因此查得到（source='web'）。
        current.source = source
        const finish = current.done
        if (answer === 'allow-always' && current.suggestedRule !== null) {
          appendRule({
            pattern: current.suggestedRule,
            decision: 'allow',
            justification: `用户在审批卡上选了永久允许（${current.view.toolName}）`,
          })
          reloadRules()
          audit({
            ts: Date.now(),
            kind: 'rule-added',
            tool: current.view.toolName,
            rule: current.suggestedRule,
            reason: '用户在审批卡上永久允许',
            policy: current.view.policy,
            sessionId: current.sessionId,
            source,
          })
          finish('allow-always')
          return
        }
        if (answer === 'allow-session') {
          // 授权记在卡片所属的那个会话名下（0.6.48：卡的归属不再跟着「当前查看」走）
          const grants = sessionGrants.get(current.sessionId) ?? new Set<string>()
          grants.add(current.grantKey)
          sessionGrants.set(current.sessionId, grants)
          // 这张卡带着沙箱放宽（模型走了 sandbox_permissions 那条路）时，把目标路径
          // 并进**这个会话**的可写根：不然「本会话允许」只免了问，写还是被沙箱当场拦。
          if (current.sandboxSessionRoot !== null) {
            ctx.get('sandbox')?.grantSession(current.sessionPath, [current.sandboxSessionRoot])
          }
          finish('allow-session')
          return
        }
        finish(answer === 'reject' ? 'reject' : 'allow-once')
      },
    }

    ctx.provide('approval', service)

    // 这套裁决挂在守卫链上（模式那道闸门在先，审批在後），循环因此不认识「审批」这个功能。
    ctx.guards.register(
      toolApprovalGuard({
        id: 'approval',
        approve: (input) =>
          service
            .decide(
              {
                toolName: input.toolName,
                argsSummary: argsSummary(input.args),
                args: input.args,
                cwd: input.cwd,
                // 发起调用的会话身份：授权记账、审计与卡片归属都按它（0.6.48 多 agent）
                sessionId: input.sessionId,
                sessionPath: input.sessionPath,
              },
              input.signal,
            )
            .then((decision) => decision !== 'reject'),
        // 用户点「拒绝」时回给模型的原话：老会话日志按这句话认「被拒」，不能改。
        deniedReason: REJECTED_TOOL_TEXT,
      }),
    )
    // 工具结果里的密钥形状字符串不落盘、不进上下文：遮红挂在结果观察者链上。
    const redactObserver: ToolObserver = { id: 'approval', order: 10, observe: (_toolName, text) => redact(text) }
    ctx.guards.registerObserver(redactObserver)

    ctx.surfaces.register('policy', () => service.surface())
    ctx.surfaces.register('pendingApproval', () => service.pendingView())
    ctx.waiting.register('approval', () => pendings.size > 0)

    ctx.on('dsc/mode-changed', (mode) => {
      modeForCard = mode
    })

    // 0.6.48 起切换会话不再清授权与读取台账：它们本来就按会话 id 键控，天然互不串台；
    // 后台常驻 agent 正跑着的时候清它的账，反而会把跑到一半的授权状态抹掉。

    ctx.on('dsc/exit', () => {
      for (const card of [...pendings.values()]) {
        clearTimeout(card.timer)
        card.done('reject', 'cancelled')
      }
    })
  },
}
