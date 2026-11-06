/**
 * hooks 插件：把用户自己登记的规则与脚本挂到工具守卫链上，作为「防手滑」的那一道闸；
 * 同一页设置里还收着 codex 那十四个事件名的外部命令钩子（0.9.0 合并，原 lifecycle-hooks 包）。
 *
 * 安全钩子挂在 order 20：协作模式（10）先决定这一轮允许把手伸多远，这里按用户的规矩拦或提醒，
 * 审批（30）最后决定「问出来之后怎么裁」。三道闸互不认识。
 * 外部命令钩子挂在 order 25（PreToolUse，可 deny）与观察者 order 45（PostToolUse，只留话），
 * 两条 id 都还是 `lifecycle-hooks`、order 一个没动，所以链上的先后与判定逐字不变。
 *
 * 三种后果各走各的路：
 *   拦下来 —— 守卫返回 deny，原因原样回给模型，模型看得见为什么被拦；
 *   问一人 —— 带着原因去叫审批卡（`ctx.approval.decide` 的 forceAskReason），
 *             当前权限模式本来会自动放行也照样弹；人批了就返回 pass（这一次不再追问），
 *             人否了返回 deny；
 *   只留话 —— 不拦，把脚本给的那句话写进会话。
 *
 * 每条结论（包括脚本没跑成按拦处理的）都落一行 `~/.dsc/audit.jsonl`，种类是 `hook`。
 * 配置仍是两份各读各的：规则与脚本在 `~/.dsc/hooks.json`，codex 事件钩子在
 * `~/.dsc/lifecycle-hooks.json`；插件自己的可调项（含外部命令那一组）在
 * `~/.dsc/plugins.json` 的 `hooks` 条目里，合并前 `lifecycle-hooks` 条目的同名项只读回落
 * （见 `lifecycle-hooks.ts` 的 `resolveLifecycleConfig`）。
 *
 * @module dsc/plugins/hooks
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { audit, readAudit } from '@pneuma/runtime/core/audit.js'
import { POLICY_RULES_FILE } from '@pneuma/runtime/core/command-policy.js'
import {
  addRule,
  addScript,
  hookFacts,
  hookReasonForModel,
  HOOKS_FILE,
  HOOK_PATTERN_MAX,
  HOOK_REASON_MAX,
  HOOK_TIMEOUT_MAX,
  HOOK_TIMEOUT_MIN,
  HOOK_TRUST_FILE,
  judgeScriptRun,
  matcherHits,
  patchHookSettings,
  readHooks,
  removeRule,
  removeScript,
  ruleHits,
  ruleJudgement,
  runHookScript,
  setRuleEnabled,
  setScriptEnabled,
  strongestJudgement,
  trustOf,
  trustScript,
  untrustScript,
} from '@pneuma/session-core/hooks.js'
import type { HookEvent, HookJudgement, HookRuleAction, HookRuleField, HookScript } from '@pneuma/session-core/hooks.js'
import {
  commandAllowed,
  denyReasonFor,
  judgeBlockedByAllowlist,
  judgeLifecycleRun,
  lifecycleReport,
  readLifecycleDoc,
  resolveLifecycleConfig,
  runLifecycleCommand,
  subjectHits,
  wrapHookOutput,
} from './lifecycle-hooks.js'
import type { LifecycleEvent, LifecycleHooksConfig, LifecyclePayload } from './lifecycle-hooks.js'
import { errText } from '@pneuma/runtime/core/err-text.js'
import { contentText } from '@pneuma/runtime/core/llm.js'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import type { ToolGuard, ToolGuardInput, ToolObserver } from '@pneuma/runtime/core/tool-guards.js'
import { argsSummary } from '@pneuma/runtime/core/tools.js'
import type { SettingsField, SettingsOption, SettingsValues } from '@pneuma/runtime/contract.js'
import type { HookService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 事件名 → 界面上的说法（下拉与详情行都用它，两处不会写岔）。 */
const eventLabels = (): Record<HookEvent, string> => ({
  'pre-tool': t('field.scriptEvent.option.pre-tool'),
  'post-tool': t('field.scriptEvent.option.post-tool'),
  'session-start': t('field.scriptEvent.option.session-start'),
  'turn-end': t('field.scriptEvent.option.turn-end'),
})

/** 规则要比对的字段 → 界面说法。 */
const fieldLabels = (): Record<HookRuleField, string> => ({
  command: t('field.ruleField.option.command'),
  target: t('field.ruleField.option.target'),
  args: t('field.ruleField.option.args'),
  any: t('field.ruleField.option.any'),
})

/** 规则动作 → 界面说法。 */
const actionLabels = (): Record<HookRuleAction, string> => ({
  deny: t('field.ruleAction.option.deny'),
  ask: t('field.ruleAction.option.ask'),
})

const fieldOptions = (): SettingsOption[] => optionsOf(['command', 'target', 'args', 'any'] as const, (field) => fieldLabels()[field])

const actionOptions = (): SettingsOption[] => optionsOf(['deny', 'ask'] as const, (action) => actionLabels()[action])

const eventOptions = (): SettingsOption[] => optionsOf(
  ['pre-tool', 'post-tool', 'session-start', 'turn-end'] as const,
  (event) => eventLabels()[event],
)

/** 插件在条目树里的键，也是设置分区 id（外部命令那一组与规则、脚本同一页）。 */
const CONFIG_KEY = 'hooks'

/** 外部命令钩子的那一组：字段只做展示收拢，key 与 values/save 链路不受影响。 */
const EXTERNAL_GROUP = 'external'

// i18n-keep 这份只给 /lifecycle-hooks 命令的输出用，命令面按批次约定不翻译。
/** 事件档位在命令输出里的说法。 */
const TIER_LABELS = { wired: '已接通', partial: '部分接通', unwired: '未接通' } as const

/**
 * 事件档位在设置分区里的说法。
 * 模块导入时取词会把语言钉死，所以是函数；斜杠命令那份仍是 {@link TIER_LABELS}。
 */
const tierLabels = (): Record<keyof typeof TIER_LABELS, string> => ({
  wired: t('tier.wired'),
  partial: t('tier.partial'),
  unwired: t('tier.unwired'),
})

/** 载荷里除公共字段之外、由各事件自己补的那部分。 */
type PayloadExtra = Omit<
  Partial<LifecyclePayload>,
  'session_id' | 'transcript_path' | 'cwd' | 'hook_event_name' | 'model' | 'permission_mode'
>

/** 设置页表单里那些「还没提交」的输入框的内容（存内存，不落盘）。 */
interface HookForm {
  ruleId: string
  scriptId: string
  ruleTool: string
  ruleField: HookRuleField
  ruleAction: HookRuleAction
  rulePattern: string
  ruleReason: string
  scriptEvent: HookEvent
  scriptMatcher: string
  scriptCommand: string
}

const EMPTY_FORM: HookForm = {
  ruleId: '',
  scriptId: '',
  ruleTool: '*',
  ruleField: 'any',
  ruleAction: 'ask',
  rulePattern: '',
  ruleReason: '',
  scriptEvent: 'pre-tool',
  scriptMatcher: '*',
  scriptCommand: '',
}

/** 把事件、字段这类常量拼成下拉要的选项清单。 */
function optionsOf<T extends string>(values: readonly T[], label: (value: T) => string): SettingsOption[] {
  return values.map((value) => ({ value, label: label(value) }))
}

export const hooksPlugin: Plugin.Object = {
  name: 'hooks',
  inject: ['session', 'llm', 'approval', 'guards', 'prompt', 'settings', 'transcript', 'commands'],
  provide: 'hooks',
  apply(ctx, passed) {
    const form: HookForm = { ...EMPTY_FORM }
    /** 已经提醒过的「这条脚本不能跑」，同一个状态只提醒一次，免得每次工具调用都刷屏。 */
    const warned = new Set<string>()

    const sessionId = (): string => ctx.session.current().meta.id

    /** 落一条钩子审计：谁在什么工具上给了什么结论，一眼能查。 */
    const auditHook = (judgement: HookJudgement, input: ToolGuardInput, decision?: 'blocked' | 'reject' | 'allow-once'): void => {
      audit({
        ts: Date.now(),
        kind: 'hook',
        tool: input.toolName,
        summary: argsSummary(input.args ?? {}).slice(0, 200),
        reason: `${judgement.action}｜${judgement.problem === '' ? judgement.message : judgement.problem}`,
        rule: [judgement.source],
        policy: ctx.approval.policy,
        sessionId: sessionId(),
        cwd: input.cwd,
        decision,
      })
    }

    /** 拼递给脚本的 stdin 载荷。 */
    const payloadOf = (
      event: HookEvent,
      input: { toolName: string; args: Record<string, unknown>; cwd: string; command: string; target: string },
      extra: Record<string, unknown>,
    ): import('@pneuma/session-core/hooks.js').HookPayload => ({
      hook_event_name: event,
      tool_name: input.toolName,
      tool_input: input.args,
      args_summary: argsSummary(input.args).slice(0, 200),
      session_id: sessionId(),
      cwd: input.cwd,
      policy: ctx.approval.policy,
      mode: '',
      command: input.command,
      target: input.target,
      extra,
    })

    /**
     * 跑一批观察者事件上的脚本（工具干完之后、会话开始、一轮结束）。
     *
     * 这些事件改不了已经发生的事，所以脚本的结论只有两种用法：把话留在会话里，或者什么也不做。
     * 异步跑，不挡用户的手：观察用的钩子不该让工具调用多等一秒。
     */
    const fireObserve = (
      event: Exclude<HookEvent, 'pre-tool'>,
      input: { toolName: string; args: Record<string, unknown>; cwd: string; command?: string; target?: string },
      extra: Record<string, unknown>,
    ): void => {
      const doc = readHooks()
      if (!doc.settings.enabled) return
      const scripts = doc.scripts.filter(
        (script) => script.enabled && script.event === event && matcherHits(script.matcher, input.toolName),
      )
      for (const script of scripts) {
        const trust = trustOf(script, doc.settings.autoAccept)
        if (!trust.runnable) {
          warnUntrusted(script, trust)
          continue
        }
        void runHookScript(script, payloadOf(event, { ...input, command: input.command ?? '', target: input.target ?? '' }, extra), input.cwd, new AbortController().signal, doc.settings.scriptTimeoutMs)
          .then((run) => {
            const judgement = judgeScriptRun(run, script, doc.settings)
            audit({
              ts: Date.now(),
              kind: 'hook',
              tool: input.toolName,
              reason: `${judgement.action}｜${judgement.problem === '' ? judgement.message : judgement.problem}`,
              rule: [judgement.source],
              policy: ctx.approval.policy,
              sessionId: sessionId(),
              cwd: input.cwd,
            })
            if (judgement.action === 'note' && judgement.message !== '') {
              ctx.emit('dsc/notice', `钩子（${eventLabels()[event]}）：${judgement.message}`)
            } else if (judgement.problem !== '') {
              ctx.emit('dsc/notice', `钩子脚本没跑好：${judgement.problem}`)
            }
          })
          .catch((error: unknown) => {
            ctx.emit('dsc/notice', `钩子脚本执行出错：${error instanceof Error ? error.message : String(error)}`)
          })
      }
    }

    /** 「这条脚本没批准 / 脚本改过了」的提示，每个状态只说一次。 */
    const warnUntrusted = (script: HookScript, trust: ReturnType<typeof trustOf>): void => {
      const key = `${script.id}:${trust.state}`
      if (warned.has(key)) return
      warned.add(key)
      ctx.emit('dsc/notice', `安全钩子有一条没生效：${trust.detail}（命令：${script.command.slice(0, 60)}）`)
    }

    /** 一次工具调用命中了哪些启用中的规则（不跑脚本）。 */
    const hitRules = (input: ToolGuardInput): HookJudgement[] => {
      const doc = readHooks()
      const facts = hookFacts(input)
      return doc.rules.filter((rule) => rule.enabled && ruleHits(rule, facts)).map(ruleJudgement)
    }

    // ── 外部命令钩子（codex 事件名） ──────────────────────────────────────────
    // 这一半从 lifecycle-hooks 包并进来：事件表、配置解析、跑外部命令都在
    // `./lifecycle-hooks.js`，这里只负责把结论挂到跟安全钩子同一条守卫链上。

    /** 每次都现读：设置里改完不必重启宿主。 */
    const externalConfig = (): LifecycleHooksConfig => resolveLifecycleConfig(passed)
    const cwdOf = (): string => ctx.session.current().meta.cwd
    /** 后台跑的钩子统一挂这个信号：插件卸载时一起掐掉，不留悬挂的子进程。 */
    const lifetime = new AbortController()
    /** 攒着等下一次请求的围栏文本（只能「留话」的那几类事件都往这儿放）。 */
    let pending: string[] = []
    /** 上一次见过的用户消息原文：变了才算新提交，同一轮里问一次不重复触发。 */
    let lastPrompt = ''
    /** 同一句提示只说一次，不然每次工具调用都刷屏。 */
    const announced = new Set<string>()

    const notifyExternal = (key: string, text: string): void => {
      if (announced.has(key)) return
      announced.add(key)
      // 带上会话归属：后台会话的钩子提示不能画到你正在看的会话里。
      ctx.emit('dsc/notice', text, undefined, ctx.session.current().filePath)
    }

    /** 载荷的公共字段，字段名照 codex。 */
    const basePayload = (event: LifecycleEvent, cwd: string): LifecyclePayload => ({
      session_id: ctx.session.current().meta.id,
      // dsc 的 Session 上取不到自己的 jsonl 路径，这一项恒为 null（钩子脚本读它是 null，不是空串）
      transcript_path: null,
      cwd,
      hook_event_name: event,
      model: ctx.llm.model,
      permission_mode: ctx.approval.policy,
    })

    /**
     * 跑一条事件上全部命中的钩子，按配置里的顺序依次跑完（不并行：这些命令要读同一份现场）。
     * 只执行与裁决，不碰上下文——调用方决定结论怎么用。
     */
    const runExternalHooks = async (
      event: LifecycleEvent,
      subject: string,
      extra: PayloadExtra,
      cwd: string,
      signal: AbortSignal,
    ): Promise<HookJudgement[]> => {
      const cfg = externalConfig()
      if (!cfg.enabled) return []
      const judgements: HookJudgement[] = []
      for (const hook of readLifecycleDoc(cfg.configPath).hooks) {
        if (!hook.enabled || hook.event !== event) continue
        if (!subjectHits(event, hook.matcher, subject)) continue
        if (!commandAllowed(hook.command, cfg.commandAllowlist)) {
          const blocked = judgeBlockedByAllowlist(hook, cfg)
          notifyExternal(`allowlist:${hook.id}`, `生命周期钩子（${event}）有一条没生效：${blocked.problem}`)
          judgements.push(blocked)
          continue
        }
        const run = await runLifecycleCommand(
          hook.command,
          hook.timeoutMs > 0 ? hook.timeoutMs : cfg.timeoutMs,
          { ...basePayload(event, cwd), ...extra },
          cwd,
          signal,
        )
        judgements.push(judgeLifecycleRun(run, hook, cfg))
      }
      return judgements
    }

    /** 只能「留话」的事件：把裁决里的话与毛病收下（话等下一次请求带出去）。 */
    const absorbExternal = (event: LifecycleEvent, judgements: readonly HookJudgement[]): void => {
      for (const judgement of judgements) {
        if (judgement.problem !== '') notifyExternal(`${event}:${judgement.source}:${judgement.problem}`, `生命周期钩子（${event}）没跑好：${judgement.problem}`)
        if (judgement.message !== '') pending.push(wrapHookOutput(event, judgement.message))
      }
    }

    /** 后台跑一条观察型事件，不挡当前这一步。 */
    const fireExternal = (event: LifecycleEvent, subject: string, extra: PayloadExtra, cwd = cwdOf()): void => {
      void runExternalHooks(event, subject, extra, cwd, lifetime.signal)
        .then((judgements) => absorbExternal(event, judgements))
        .catch((error: unknown) => {
          // runExternalHooks 自己把所有执行失败都摊在返回值里，走到这儿的是读配置之类的意外：说一句，别变成未处理的拒绝
          notifyExternal(`fire:${event}`, `生命周期钩子（${event}）执行出错：${errText(error)}`)
        })
    }

    /** 最后一条 assistant 消息的正文（Stop 事件要带上它，钩子才知道刚说完什么）。 */
    const lastAssistantText = (): string | null => {
      const messages = ctx.session.current().messages
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        if (message.role === 'assistant') return contentText(message.content)
      }
      return null
    }

    const guard: ToolGuard = {
      id: 'hooks',
      order: 20,
      async decide(input) {
        const doc = readHooks()
        if (!doc.settings.enabled) return { action: 'defer' }
        const judgements = hitRules(input)
        const scripts = doc.scripts.filter(
          (script) => script.enabled && script.event === 'pre-tool' && matcherHits(script.matcher, input.toolName),
        )
        for (const script of scripts) {
          const trust = trustOf(script, doc.settings.autoAccept)
          if (!trust.runnable) {
            warnUntrusted(script, trust)
            continue
          }
          const facts = hookFacts(input)
          const run = await runHookScript(
            script,
            payloadOf('pre-tool', { toolName: input.toolName, args: input.args, cwd: input.cwd, command: facts.command, target: facts.target }, {}),
            input.cwd,
            input.signal,
            doc.settings.scriptTimeoutMs,
          )
          const judgement = judgeScriptRun(run, script, doc.settings)
          judgements.push(judgement)
        }

        const best = strongestJudgement(judgements)
        if (best === null || best.action === 'pass') return { action: 'defer' }
        if (best.action === 'note') {
          auditHook(best, input)
          // 带会话归属：后台会话的工具调用触发的钩子留言，不该写进正在看的视图（0.6.68）
          if (best.message !== '') {
            ctx.emit('dsc/notice', `安全钩子留了一句：${best.message}`, undefined, input.sessionPath)
          }
          return { action: 'defer' }
        }
        if (best.action === 'block') {
          auditHook(best, input, 'blocked')
          return { action: 'deny', reason: hookReasonForModel(best, '这次操作被安全钩子拦下') }
        }
        // ask：叫一张必须有人答的卡。权限模式本来会自动放行也照样弹，
        // 因为这条规矩是用户自己加的，比模式档位更具体。
        const decision = await ctx.approval.decide(
          { toolName: input.toolName, argsSummary: argsSummary(input.args), args: input.args, cwd: input.cwd },
          input.signal,
          { forceAskReason: best.message },
        )
        if (decision === 'reject') {
          auditHook(best, input, 'reject')
          return { action: 'deny', reason: hookReasonForModel(best, '钩子要求确认，用户否掉了这次操作') }
        }
        auditHook(best, input, 'allow-once')
        // 人已经看过这一次了，别再让审批环节问第二遍。
        return { action: 'pass' }
      },
    }

    /** 工具结果加工位上的观察：只负责把结果交给 post-tool 脚本，文本原样返回。 */
    const observer = {
      id: 'hooks',
      order: 40,
      observe(toolName: string, text: string): string {
        fireObserve('post-tool', { toolName, args: {}, cwd: ctx.session.current().meta.cwd }, { result: text.slice(0, 4000) })
        return text
      },
    }

    // ── 外部命令钩子的两条挂点：PreToolUse → 守卫 25，PostToolUse → 观察者 45 ──
    // id 仍是 `lifecycle-hooks`、order 一个没动：守卫链按 order 再按 id 排，
    // 所以这次合并不改变任何一次工具调用的判定先后（core/tool-guards.ts:69-72）。

    const externalGuard: ToolGuard = {
      id: 'lifecycle-hooks',
      order: 25,
      async decide(input: ToolGuardInput) {
        if (!externalConfig().enabled) return { action: 'defer' }
        const judgements = await runExternalHooks(
          'PreToolUse',
          input.toolName,
          { tool_name: input.toolName, tool_input: input.args },
          input.cwd,
          input.signal,
        )
        for (const judgement of judgements) {
          if (judgement.problem !== '') notifyExternal(`PreToolUse:${judgement.source}:${judgement.problem}`, `生命周期钩子（PreToolUse）没跑好：${judgement.problem}`)
        }
        const blocker = judgements.find((judgement) => judgement.action === 'block')
        if (blocker !== undefined) return { action: 'deny', reason: denyReasonFor('PreToolUse', blocker) }
        const asker = judgements.find((judgement) => judgement.action === 'ask')
        if (asker !== undefined) {
          // 这个位置在审批环节之前，没有卡可弹；钩子要人确认就先按拒绝回话，让模型去问用户
          return {
            action: 'deny',
            reason: denyReasonFor('PreToolUse', {
              ...asker,
              message: `钩子要求有人确认，但工具动手之前这个位置没有审批卡可弹，先按拒绝处理。${asker.message}`,
            }),
          }
        }
        for (const judgement of judgements) {
          if (judgement.action === 'note' && judgement.message !== '') pending.push(wrapHookOutput('PreToolUse', judgement.message))
        }
        return { action: 'defer' }
      },
    }

    const externalObserver: ToolObserver = {
      id: 'lifecycle-hooks',
      order: 45,
      observe(toolName: string, text: string): string {
        fireExternal('PostToolUse', toolName, { tool_name: toolName, tool_response: text })
        return text
      },
    }

    const service: HookService = {
      doc: () => readHooks(),
      trustOf(id) {
        const script = readHooks().scripts.find((item) => item.id === id)
        return script === undefined ? null : trustOf(script, readHooks().settings.autoAccept)
      },
      previewRules(input) {
        return hitRules({
          toolName: input.toolName,
          risk: 'read',
          cwd: ctx.session.current().meta.cwd,
          args: input.args ?? {},
          command: input.command,
          target: input.target,
          signal: new AbortController().signal,
          sessionId: ctx.session.current().meta.id,
          sessionPath: ctx.session.current().filePath,
        })
      },
      recent(limit = 8) {
        return readAudit(400)
          .filter((record) => record.kind === 'hook')
          .slice(0, limit)
      },
    }

    const offGuard = ctx.guards.register(guard)
    ctx.effect(() => offGuard, 'hooks: guards.register')
    const offObserver = ctx.guards.registerObserver(observer)
    ctx.effect(() => offObserver, 'hooks: guards.registerObserver')
    const offExternalGuard = ctx.guards.register(externalGuard)
    ctx.effect(() => offExternalGuard, 'hooks: guards.register (external)')
    const offExternalObserver = ctx.guards.registerObserver(externalObserver)
    ctx.effect(() => offExternalObserver, 'hooks: guards.registerObserver (external)')
    ctx.provide('hooks', service)

    // ── 请求组装：UserPromptSubmit 认新消息 + 把攒下的外部钩子留言补在末尾 ───────

    // 钩子产出不在会话日志里，塞进请求的同时必须落一条 note（Model-visible ⟺ logged）：
    // 只投给主会话——队友的请求不走投影链，不会错拿主会话的 pending。
    const offProjection = ctx.prompt.registerProjection('user-prompt-submit', (messages: ChatMessage[]): ChatMessage[] => {
      submitIfNewPrompt(messages)
      if (pending.length === 0) return messages
      const blocks = pending
      pending = []
      // 补在末尾、user 角色（2026-10-03）：system 段会被 fold-system 并进头部、改写前缀缓存；
      // user 只往历史尾巴追加。内容自带 <external_content source="hook:…"> 围栏，出处已标明。
      ctx.session.current().appendNote('lifecycle-hooks', blocks.join('\n\n'))
      return [...messages, { role: 'user', content: blocks.join('\n\n') }]
    })
    ctx.effect(() => offProjection, 'hooks: prompt.registerProjection')

    /** 认出这次请求里新的那条用户消息，跑一遍 UserPromptSubmit（只能把话留到下一次请求）。 */
    function submitIfNewPrompt(messages: readonly ChatMessage[]): void {
      let prompt = ''
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        if (message.role === 'user') {
          prompt = contentText(message.content)
          break
        }
      }
      if (prompt === '' || prompt === lastPrompt) return
      lastPrompt = prompt
      fireExternal('UserPromptSubmit', '', { prompt })
    }

    ctx.effect(() => ctx.commands.register({ name: 'hooks', args: '', description: '看安全钩子的状态（规则、脚本、批准情况）' }, ({ ui }) => {
      const doc = readHooks()
      const lines: string[] = []
      lines.push(`安全钩子：${doc.settings.enabled ? '开着' : '关着'}｜规则 ${doc.rules.length} 条（启用 ${doc.rules.filter((rule) => rule.enabled).length}）｜脚本 ${doc.scripts.length} 条`)
      for (const script of doc.scripts) {
        const trust = trustOf(script, doc.settings.autoAccept)
        lines.push(`  脚本[${eventLabels()[script.event]}] ${script.command.slice(0, 60)} —— ${script.enabled ? trust.detail : '已停用'}`)
      }
      for (const problem of doc.problems) lines.push(`  ⚠ ${problem}`)
      ui.notice(lines.join('\n'))
    }), 'hooks: commands.register')

    ctx.effect(() => ctx.commands.register(
      { name: 'lifecycle-hooks', args: '', description: '看外部命令钩子（codex 事件名）的能力清单与已加载的钩子' },
      ({ ui }) => {
        const cfg = externalConfig()
        const report = lifecycleReport(cfg.configPath)
        const unwired = report.capabilities.filter((item) => item.tier === 'unwired').length
        const lines: string[] = [
          `外部命令钩子：${cfg.enabled ? '开着' : '关着'}｜配置文件 ${cfg.configPath}`,
          `十四个事件（${String(report.capabilities.length)} 个，其中 ${String(unwired)} 个在 Pneuma 未接通）：`,
        ]
        for (const item of report.capabilities) lines.push(`  ${item.event}｜${TIER_LABELS[item.tier]}｜${item.extension}`)
        lines.push(`已加载钩子 ${report.hooks.length} 条：`)
        for (const hook of report.hooks) {
          lines.push(`  [${hook.event}]${hook.enabled ? '' : '［已停用］'} ${hook.command.slice(0, 60)}`)
        }
        for (const problem of report.problems) lines.push(`  ⚠ ${problem}`)
        ui.notice(lines.join('\n'))
      },
    ), 'hooks: commands.register (external)')

    // ── 设置分区 ──────────────────────────────────────────────────────────────

    /** 选中项的定位：选中的被删了就自动落到清单第一条。 */
    const currentRule = () => {
      const rules = readHooks().rules
      const found = rules.find((rule) => rule.id === form.ruleId) ?? rules[0]
      form.ruleId = found?.id ?? ''
      return found ?? null
    }
    const currentScript = () => {
      const scripts = readHooks().scripts
      const found = scripts.find((script) => script.id === form.scriptId) ?? scripts[0]
      form.scriptId = found?.id ?? ''
      return found ?? null
    }

    function fields(): SettingsField[] {
      const doc = readHooks()
      const rule = currentRule()
      const script = currentScript()
      const list: SettingsField[] = [
        {
          type: 'switch',
          key: 'enabled',
          label: t('field.enabled.label'),
          help: t('field.enabled.help'),
        },
        {
          type: 'switch',
          key: 'scriptFailClosed',
          label: t('field.scriptFailClosed.label'),
          help: t('field.scriptFailClosed.help'),
        },
        {
          type: 'number',
          key: 'scriptTimeoutMs',
          label: t('field.scriptTimeoutMs.label'),
          min: HOOK_TIMEOUT_MIN,
          max: HOOK_TIMEOUT_MAX,
          step: 500,
          help: t('field.scriptTimeoutMs.help', { min: HOOK_TIMEOUT_MIN, max: HOOK_TIMEOUT_MAX }),
        },
        {
          type: 'switch',
          key: 'autoAccept',
          label: t('field.autoAccept.label'),
          help: t('field.autoAccept.help'),
        },
      ]
      if (doc.problems.length > 0) {
        list.push({
          type: 'info',
          label: t('field.problems.label'),
          text: doc.problems.join('；'),
          help: t('field.problems.help'),
        })
      }

      // 规则区：一张清单 + 一条添加表单。清单太长时下拉自己会滚动，这里不截断。
      list.push(
        {
          type: 'info',
          label: t('field.rules.label'),
          text: t('field.rules.text', { count: doc.rules.length }),
        },
        {
          type: 'select',
          key: 'ruleId',
          label: t('field.ruleId.label'),
          options:
            doc.rules.length === 0
              ? [{ value: '', label: t('field.ruleId.option.none') }]
              : doc.rules.map((item) => ({
                  value: item.id,
                  label: `${item.enabled ? '' : t('field.ruleId.option.disabled')}${actionLabels()[item.action]}｜${item.tool} /${item.pattern}/`,
                })),
        },
        { type: 'switch', key: 'ruleEnabled', label: t('field.ruleEnabled.label') },
        { type: 'button', action: 'ruleDelete', label: t('field.ruleDelete.label'), style: 'ghost' },
        {
          type: 'text',
          key: 'ruleTool',
          label: t('field.ruleTool.label'),
          placeholder: t('field.ruleTool.placeholder'),
          mono: true,
          help: t('field.ruleTool.help'),
        },
        { type: 'select', key: 'ruleField', label: t('field.ruleField.label'), options: fieldOptions() },
        {
          type: 'text',
          key: 'rulePattern',
          label: t('field.rulePattern.label'),
          placeholder: 'git\\s+push.*(-f|--force)|\\.env$',
          mono: true,
          help: t('field.rulePattern.help', { max: HOOK_PATTERN_MAX }),
        },
        { type: 'select', key: 'ruleAction', label: t('field.ruleAction.label'), options: actionOptions() },
        {
          type: 'text',
          key: 'ruleReason',
          label: t('field.ruleReason.label'),
          placeholder: t('field.ruleReason.placeholder'),
          help: t('field.ruleReason.help', { max: HOOK_REASON_MAX }),
        },
        { type: 'button', action: 'ruleAdd', label: t('field.ruleAdd.label'), style: 'primary' },
        {
          type: 'info',
          label: t('field.selectedRule.label'),
          text: `${rule === undefined || rule === null ? t('field.selectedRule.text.empty') : `${actionLabels()[rule.action]}｜${rule.tool}｜${fieldLabels()[rule.field]}｜/${rule.pattern}/｜${rule.reason === '' ? t('field.selectedRule.text.noReason') : rule.reason}`}`,
        },
      )

      // 脚本区
      const scriptTrust = script === undefined || script === null ? null : trustOf(script, doc.settings.autoAccept)
      list.push(
        {
          type: 'info',
          label: t('field.scripts.label'),
          text: t('field.scripts.text', { count: doc.scripts.length }),
        },
        {
          type: 'select',
          key: 'scriptId',
          label: t('field.scriptId.label'),
          options:
            doc.scripts.length === 0
              ? [{ value: '', label: t('field.scriptId.option.none') }]
              : doc.scripts.map((item) => ({
                  value: item.id,
                  label: `${item.enabled ? '' : t('field.scriptId.option.disabled')}[${eventLabels()[item.event]}] ${item.command.slice(0, 48)}`,
                })),
        },
        { type: 'switch', key: 'scriptEnabled', label: t('field.scriptEnabled.label') },
        {
          type: 'info',
          label: t('field.scriptState.label'),
          text: scriptTrust === null ? t('field.scriptState.text.none') : scriptTrust.detail,
        },
        {
          type: 'button',
          action: 'scriptTrust',
          label: scriptTrust !== null && scriptTrust.state === 'trusted' ? t('field.scriptTrust.renew.label') : t('field.scriptTrust.label'),
          style: scriptTrust !== null && scriptTrust.state === 'trusted' ? 'ghost' : 'primary',
          help: t('field.scriptTrust.help'),
        },
        { type: 'button', action: 'scriptUntrust', label: t('field.scriptUntrust.label'), style: 'ghost' },
        { type: 'button', action: 'scriptDelete', label: t('field.scriptDelete.label'), style: 'ghost' },
        { type: 'select', key: 'scriptEvent', label: t('field.scriptEvent.label'), options: eventOptions() },
        {
          type: 'text',
          key: 'scriptMatcher',
          label: t('field.scriptMatcher.label'),
          placeholder: t('field.scriptMatcher.placeholder'),
          mono: true,
          help: t('field.scriptMatcher.help'),
        },
        {
          type: 'text',
          key: 'scriptCommand',
          label: t('field.scriptCommand.label'),
          placeholder: 'node C:\\Users\\me\\.dsc\\hooks\\guard.js',
          mono: true,
          help: t('field.scriptCommand.help'),
        },
        { type: 'button', action: 'scriptAdd', label: t('field.scriptAdd.label'), style: 'primary' },
      )

      const recent = service.recent(5)
      list.push({
        type: 'info',
        label: t('field.recent.label'),
        text:
          recent.length === 0
            ? t('field.recent.text.none')
            : recent
                .map((record) => `${new Date(record.ts).toLocaleTimeString()} ${record.tool ?? ''} ${record.reason ?? ''}`)
                .join('\n'),
      })
      list.push(
        {
          type: 'info',
          label: t('field.configFile.label'),
          text: HOOKS_FILE,
          mono: true,
          copyable: true,
          help: t('field.configFile.help'),
        },
        { type: 'info', label: t('field.trustFile.label'), text: HOOK_TRUST_FILE, mono: true, copyable: true },
        {
          type: 'info',
          label: t('field.policyFile.label'),
          text: POLICY_RULES_FILE,
          mono: true,
          copyable: true,
          help: t('field.policyFile.help'),
        },
      )
      return list
    }

    /**
     * 外部命令钩子那一组的字段：全部打上 `group: 'external'`，桌面端聚在一张组头下，
     * TUI 收成子页。键名带 `external` 前缀只是为了跟上面那几个同名控件（`enabled`）区分，
     * 落到 `plugins.json` 上的仍是原键名（`enabled` / `configPath` / …），老配置才读得回来。
     */
    function externalFields(): SettingsField[] {
      const cfg = externalConfig()
      const report = lifecycleReport(cfg.configPath)
      // 未接通的条数现数，不写死：事件表一加，这里的标题跟着变，免得跟下面那张清单打架。
      const unwired = report.capabilities.filter((item) => item.tier === 'unwired').length
      const labels = tierLabels()
      const list: SettingsField[] = [
        {
          type: 'switch',
          key: 'externalEnabled',
          label: t('field.externalEnabled.label'),
          help: t('field.externalEnabled.help'),
          group: EXTERNAL_GROUP,
        },
        {
          type: 'text',
          key: 'externalConfigPath',
          label: t('field.externalConfigPath.label'),
          mono: true,
          placeholder: 'C:\\Users\\me\\.dsc\\lifecycle-hooks.json',
          help: t('field.externalConfigPath.help'),
          group: EXTERNAL_GROUP,
        },
        {
          type: 'number',
          key: 'externalTimeoutMs',
          label: t('field.externalTimeoutMs.label'),
          min: HOOK_TIMEOUT_MIN,
          max: HOOK_TIMEOUT_MAX,
          step: 500,
          help: t('field.externalTimeoutMs.help', { min: HOOK_TIMEOUT_MIN, max: HOOK_TIMEOUT_MAX }),
          group: EXTERNAL_GROUP,
        },
        {
          type: 'switch',
          key: 'externalFailClosed',
          label: t('field.externalFailClosed.label'),
          help: t('field.externalFailClosed.help'),
          group: EXTERNAL_GROUP,
        },
        {
          type: 'text',
          key: 'externalCommandAllowlist',
          label: t('field.externalCommandAllowlist.label'),
          mono: true,
          placeholder: t('field.externalCommandAllowlist.placeholder'),
          help: t('field.externalCommandAllowlist.help'),
          group: EXTERNAL_GROUP,
        },
        {
          type: 'info',
          label: t('field.externalCapabilities.label', { unwired }),
          mono: true,
          text: report.capabilities.map((item) => `${item.event}｜${labels[item.tier]}｜${item.extension}`).join('\n'),
          help: t('field.externalCapabilities.help'),
          group: EXTERNAL_GROUP,
        },
        {
          type: 'info',
          label: t('field.externalLoaded.label'),
          mono: true,
          text:
            report.hooks.length === 0
              ? t('field.externalLoaded.empty')
              : report.hooks
                  .map((hook) => `[${hook.event}]${hook.enabled ? '' : t('field.externalLoaded.disabled')} ${hook.command.slice(0, 60)}`)
                  .join('\n'),
          group: EXTERNAL_GROUP,
        },
      ]
      if (report.problems.length > 0) {
        list.push({
          type: 'info',
          label: t('field.externalProblems.label'),
          text: report.problems.join('\n'),
          help: t('field.externalProblems.help'),
          group: EXTERNAL_GROUP,
        })
      }
      list.push({
        type: 'info',
        label: t('field.externalFile.label'),
        text: cfg.configPath,
        mono: true,
        copyable: true,
        group: EXTERNAL_GROUP,
      })
      return list
    }

    const section: SettingsSectionSpec = {
      id: 'hooks',
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 34,
      groups: [
        {
          id: EXTERNAL_GROUP,
          title: t('group.external.title'),
          description: t('group.external.description'),
        },
      ],
      fields() {
        return [...fields(), ...externalFields()]
      },
      values(): SettingsValues {
        const doc = readHooks()
        const rule = currentRule()
        const script = currentScript()
        const cfg = externalConfig()
        return {
          enabled: doc.settings.enabled,
          scriptFailClosed: doc.settings.scriptFailClosed,
          scriptTimeoutMs: doc.settings.scriptTimeoutMs,
          autoAccept: doc.settings.autoAccept,
          ruleId: form.ruleId,
          ruleEnabled: rule?.enabled ?? false,
          ruleTool: form.ruleTool,
          ruleField: form.ruleField,
          ruleAction: form.ruleAction,
          rulePattern: form.rulePattern,
          ruleReason: form.ruleReason,
          scriptId: form.scriptId,
          scriptEnabled: script?.enabled ?? false,
          scriptEvent: form.scriptEvent,
          scriptMatcher: form.scriptMatcher,
          scriptCommand: form.scriptCommand,
          externalEnabled: cfg.enabled,
          externalConfigPath: cfg.configPath,
          externalTimeoutMs: cfg.timeoutMs,
          externalFailClosed: cfg.failClosed,
          externalCommandAllowlist: cfg.commandAllowlist,
        }
      },
      save(key, value): string | void {
        const text = typeof value === 'string' ? value : String(value)
        switch (key) {
          case 'enabled':
            patchHookSettings({ enabled: value === true })
            return
          case 'scriptFailClosed':
            patchHookSettings({ scriptFailClosed: value === true })
            return
          case 'autoAccept':
            patchHookSettings({ autoAccept: value === true })
            return
          case 'scriptTimeoutMs': {
            const num = Number(value)
            if (!Number.isFinite(num)) return t('save.notNumberMs')
            patchHookSettings({ scriptTimeoutMs: num })
            return
          }
          // 外部命令那一组：写到 `plugins.json` 的 `hooks` 条目（原 lifecycle-hooks 的键名）。
          // 合并前的 `lifecycle-hooks` 条目只当只读回落，这里一个字都不写它。
          case 'externalEnabled':
            writePluginConfig(CONFIG_KEY, { enabled: value === true })
            return
          case 'externalFailClosed':
            writePluginConfig(CONFIG_KEY, { failClosed: value === true })
            return
          case 'externalTimeoutMs': {
            const num = Number(value)
            if (!Number.isFinite(num)) return t('save.notNumberMs')
            writePluginConfig(CONFIG_KEY, { timeoutMs: Math.min(Math.max(Math.round(num), HOOK_TIMEOUT_MIN), HOOK_TIMEOUT_MAX) })
            return
          }
          case 'externalConfigPath': {
            const path = text.trim()
            if (path === '') return t('save.configPathEmpty')
            writePluginConfig(CONFIG_KEY, { configPath: path })
            return
          }
          case 'externalCommandAllowlist':
            writePluginConfig(CONFIG_KEY, { commandAllowlist: text.trim() })
            return
          case 'ruleId':
            form.ruleId = text
            return
          case 'scriptId':
            form.scriptId = text
            return
          case 'ruleEnabled': {
            const rule = currentRule()
            if (rule === null) return t('save.ruleEmpty')
            setRuleEnabled(rule.id, value === true)
            return
          }
          case 'scriptEnabled': {
            const script = currentScript()
            if (script === null) return t('save.scriptEmpty')
            setScriptEnabled(script.id, value === true)
            return
          }
          case 'ruleTool':
            form.ruleTool = text
            return
          case 'ruleField':
            form.ruleField = (['command', 'target', 'args', 'any'] as const).includes(text as HookRuleField)
              ? (text as HookRuleField)
              : 'any'
            return
          case 'ruleAction':
            form.ruleAction = text === 'deny' ? 'deny' : 'ask'
            return
          case 'rulePattern':
            form.rulePattern = text
            return
          case 'ruleReason':
            form.ruleReason = text
            return
          case 'scriptEvent':
            form.scriptEvent = (['pre-tool', 'post-tool', 'session-start', 'turn-end'] as const).includes(text as HookEvent)
              ? (text as HookEvent)
              : 'pre-tool'
            return
          case 'scriptMatcher':
            form.scriptMatcher = text
            return
          case 'scriptCommand':
            form.scriptCommand = text
            return
          default:
            return t('save.unknownKey', { key })
        }
      },
      action(name): string | void {
        switch (name) {
          case 'ruleAdd': {
            const result = addRule({
              tool: form.ruleTool,
              field: form.ruleField,
              pattern: form.rulePattern,
              action: form.ruleAction,
              reason: form.ruleReason,
            })
            if (!result.ok) return result.error
            form.ruleId = result.id
            form.rulePattern = ''
            form.ruleReason = ''
            ctx.emit('dsc/changed')
            return t('action.ruleAdded')
          }
          case 'ruleDelete': {
            const rule = currentRule()
            if (rule === null) return t('action.ruleEmpty')
            removeRule(rule.id)
            form.ruleId = ''
            ctx.emit('dsc/changed')
            return t('action.ruleDeleted')
          }
          case 'scriptAdd': {
            const result = addScript({
              event: form.scriptEvent,
              matcher: form.scriptMatcher,
              command: form.scriptCommand,
            })
            if (!result.ok) return result.error
            form.scriptId = result.id
            form.scriptCommand = ''
            ctx.emit('dsc/changed')
            return readHooks().settings.autoAccept ? t('action.scriptAddedAuto') : t('action.scriptAdded')
          }
          case 'scriptDelete': {
            const script = currentScript()
            if (script === null) return t('action.scriptEmpty')
            removeScript(script.id)
            untrustScript(script.id)
            form.scriptId = ''
            ctx.emit('dsc/changed')
            return t('action.scriptDeleted')
          }
          case 'scriptTrust': {
            const script = currentScript()
            if (script === null) return t('action.scriptEmpty')
            return trustScript(script.id) ?? t('action.scriptTrusted')
          }
          case 'scriptUntrust': {
            const script = currentScript()
            if (script === null) return t('action.scriptEmpty')
            untrustScript(script.id)
            return t('action.scriptUntrusted')
          }
          default:
            return t('action.unknownName', { name })
        }
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'hooks: settings.registerSection')

    ctx.on('dsc/session-open', ({ session }) => {
      warned.clear()
      fireObserve(
        'session-start',
        { toolName: '', args: {}, cwd: session.meta.cwd },
        { session_id: session.meta.id },
      )
    })
    ctx.on('dsc/turn-end', (reason, signal) => {
      // 0.6.48：只认当前查看会话的回合——钩子是用户配的自动化，后台 agent 收工
      // 不该在用户没开口时触发它（与 Stop/Interrupt 生命周期钩子同一口径）。
      // 载荷缺省（老式直接 emit）按当前会话算。
      if (signal !== undefined && signal.sessionId !== ctx.session.current().meta.id) return
      fireObserve('turn-end', { toolName: '', args: {}, cwd: ctx.session.current().meta.cwd }, { reason })
    })

    // ── 外部命令钩子的其余事件 ───────────────────────────────────────────────

    ctx.on('dsc/session-open', ({ session, filePath }) => {
      announced.clear()
      lastPrompt = ''
      // codex 的 SessionStart matcher 比的来源：新开是 startup，接着老的跑是 resume
      const source = filePath === undefined ? 'startup' : 'resume'
      fireExternal('SessionStart', source, { source }, session.meta.cwd)
    })
    ctx.on('dsc/compacted', () => fireExternal('PostCompact', '', {}))
    ctx.on('dsc/exit', () => fireExternal('SessionEnd', '', { reason: 'exit' }))
    ctx.on('dsc/turn-end', (reason, signal) => {
      // 0.6.48：只认当前查看会话的回合。Stop/Interrupt 钩子取的
      // lastAssistantText 来自当前会话，后台 agent 收工时触发会拿错文本。
      // 载荷缺省（老式直接 emit）按当前会话算。
      if (signal !== undefined && signal.sessionId !== ctx.session.current().meta.id) return
      if (reason === 'completed') {
        fireExternal('Stop', '', {
          reason,
          // dsc 没有 codex 的「这已经是钩子推起来的续跑」这个标记，恒为 false（不再二次刹车）
          stop_hook_active: false,
          last_assistant_message: lastAssistantText(),
        })
        return
      }
      if (reason === 'aborted') fireExternal('Interrupt', '', { reason })
    })

    return () => {
      // 外部命令钩子在后台跑，卸载时把挂在它上面的子进程一起掐掉
      lifetime.abort()
      offSection()
      offObserver()
      offGuard()
      offExternalObserver()
      offExternalGuard()
      offProjection()
    }
  },
}
