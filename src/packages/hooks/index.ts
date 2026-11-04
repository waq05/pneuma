/**
 * hooks 插件：把用户自己登记的规则与脚本挂到工具守卫链上，作为「防手滑」的那一道闸。
 *
 * 挂在 order 20：协作模式（10）先决定这一轮允许把手伸多远，这里按用户的规矩拦或提醒，
 * 审批（30）最后决定「问出来之后怎么裁」。三道闸互不认识。
 *
 * 三种后果各走各的路：
 *   拦下来 —— 守卫返回 deny，原因原样回给模型，模型看得见为什么被拦；
 *   问一人 —— 带着原因去叫审批卡（`ctx.approval.decide` 的 forceAskReason），
 *             当前权限模式本来会自动放行也照样弹；人批了就返回 pass（这一次不再追问），
 *             人否了返回 deny；
 *   只留话 —— 不拦，把脚本给的那句话写进会话。
 *
 * 每条结论（包括脚本没跑成按拦处理的）都落一行 `~/.dsc/audit.jsonl`，种类是 `hook`。
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
import type { ToolGuard, ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
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
  inject: ['session', 'approval', 'guards', 'settings', 'transcript', 'commands'],
  provide: 'hooks',
  apply(ctx) {
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
    ctx.provide('hooks', service)

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

    const section: SettingsSectionSpec = {
      id: 'hooks',
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 34,
      fields,
      values(): SettingsValues {
        const doc = readHooks()
        const rule = currentRule()
        const script = currentScript()
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

    return () => {
      offSection()
      offObserver()
      offGuard()
    }
  },
}
