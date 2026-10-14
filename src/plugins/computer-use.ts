/**
 * 电脑操作（Computer Use，官方插件，默认关闭）。
 *
 * 打开后模型能看这台 Windows 桌面并动手操作：`computer` 工具做点击、拖拽、输入、按键、
 * 滚动、元素定向动作（set_value / select_text / perform_action）（风险等级 exec，每一次
 * 都要你在审批卡上点头）；勾选「看屏幕免审批」后另外注册一个 `computer_look` 工具
 * （风险等级 read）专管只读观察：截屏、查鼠标、列窗口/应用/显示器、无障碍观察
 * （get_app_state），看一眼不必点确认。
 *
 * 护栏（这些是 dsc 自己兜的，dsh 把桌面操作外包给外部 Rust 驱动，所以它没有）：
 * - 坐标先按缩放系数换算回物理像素，落在屏幕外直接报错，不靠系统静默夹紧；
 * - 无障碍元素索引作用域 = 该窗口最近一次观察；元素消失 **fail-closed**（报错，不退回坐标乱点）；
 * - 自上次截屏以来的动作数上限：超限就要求「先看一眼屏幕再动手」；
 * - 动作之间插一段间隔，别让目标程序被事件洪灌懵；
 * - 应用白名单：前台窗口的进程名或标题不在名单里，这一步直接被拦；
 * - 禁用动作清单可以一键摘掉点鼠标或敲键盘；
 * - Win 键永远拒绝（它会把桌面整个切走）；
 * - 危险分级：只读观察免审批、输入与点击需审批、系统级动作（急停/系统工具形状）最严；
 * - 独立审计：每次动作写一行 `~/.dsc/audit/computer-use.jsonl`；
 * - 急停 stop：杀掉在跑的界面子进程并关掉动作面，等你在设置里恢复；
 * - 截屏可缩放 + JPEG 质量，少占上下文；可裁切区域省 token。
 *
 * @module dsc/plugins/computer-use
 */
import {
  DESKTOP_ACTIONS,
  READ_ACTIONS,
  appendComputerAudit,
  canonicalAction,
  foregroundWindow,
  gradeDesktopAction,
  killAllPowerShell,
  runDesktopAction,
  settleObserve,
  takeScreenshot,
  type DesktopArgs,
  type DesktopAction,
} from '../core/desktop-control.js'
import type { DesktopRiskTier, DesktopTarget } from '../contract.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { classifyCommand } from '../core/command-policy.js'
import { redact } from '../core/secrets.js'
import { wrapUntrusted } from '../core/untrusted.js'
import type { ChatContentPart, ChatMessage } from '../core/llm.js'
import type { Plugin } from '@deepseek-ai/cordis'
import type { SettingsField, SettingsValue } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 插件配置（存 `~/.dsc/plugins.json` 条目树的 config 里）。 */
interface ComputerUseConfig {
  /** 截图最长边（像素），超出就等比缩小。 */
  maxEdge: number
  /** 截图编码：jpeg 省 token，png 无损但大。 */
  format: 'jpeg' | 'png'
  /** JPEG 质量。 */
  quality: number
  /** 每个动作之间的等待毫秒（给目标程序喘口气）。 */
  actionDelayMs: number
  /** 自上次截屏以来允许几个动手动作，超限要求重新截屏。0 = 不限制。 */
  actionsPerScreenshot: number
  /** 应用白名单：逗号分隔的进程名或窗口标题片段；空 = 不限。 */
  allowedApps: string
  /** 禁用动作：逗号分隔，例如 click,type。 */
  disabledActions: string
  /** 看屏幕（只读观察）免审批：另开一个 read 风险的工具。 */
  lookWithoutApproval: boolean
  /** 独立审计日志开关（`~/.dsc/audit/computer-use.jsonl`）。 */
  auditEnabled: boolean
}

const CONFIG_KEY = 'computer-use'

const DEFAULTS: ComputerUseConfig = {
  maxEdge: 1568,
  format: 'jpeg',
  quality: 80,
  actionDelayMs: 120,
  actionsPerScreenshot: 12,
  allowedApps: '',
  disabledActions: '',
  lookWithoutApproval: false,
  auditEnabled: true,
}

/** 只读性质的动作（看，不动手）；免审批那一档就是它们。 */
export const LOOK_ACTIONS: readonly DesktopAction[] = READ_ACTIONS

/** 拆逗号分隔清单（中英文逗号都认）。 */
function splitList(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** 截图那条工具结果的文字开头，靠它认出「这是我们自己截的图」，不误伤别的插件带的图。 */
const SHOT_MARK = '屏幕物理分辨率'

/** 这条消息是不是我们放进去的截图（工具结果 + 带图 + 文字里有那个开头）。 */
function isOurShot(message: ChatMessage): boolean {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return false
  return (
    message.content.some((part) => part.type === 'image_url') &&
    message.content.some((part) => part.type === 'text' && part.text.includes(SHOT_MARK))
  )
}

/**
 * 只把最新那张截图留给模型，旧的换成一句说明。
 *
 * 一张 JPEG 截图的 base64 有 100~300KB，留在历史里等于每一轮请求都重发一遍；
 * 走到第十步，光旧图就要吃掉几十万 token，而旧图上的界面早就被后面的点击改掉了。
 *
 * @param messages - 组装好的请求消息。原数组不动，只把过旧的几条换成新对象。
 */
export function dropStaleScreenshots(messages: ChatMessage[]): ChatMessage[] {
  let newest = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isOurShot(messages[index]!)) {
      newest = index
      break
    }
  }
  if (newest < 0) return messages
  return messages.map((message, index) => {
    if (index >= newest || !isOurShot(message)) return message
    const text = ((message.content ?? []) as ChatContentPart[])
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    return {
      ...message,
      content: [{ type: 'text', text: `${text}\n（这张截图的画面已被更新的截图取代，图像本身不再随请求发送）` }],
    }
  })
}

/** 目标参数的 JSON Schema（`{type:'element', index}` 或 `{type:'coordinate', x, y}` 二选一）。 */
export function targetSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description:
      '动作目标。两种二选一（看 type 字段）：element = 用 get_app_state 返回的元素下标（界面一变索引即失效，元素没了会直接报错）；' +
      'coordinate = 图上/窗口内的像素坐标。',
    properties: {
      type: { type: 'string', enum: ['coordinate', 'element'], description: '目标类型' },
      x: { type: 'integer', description: 'coordinate：横坐标（像素）' },
      y: { type: 'integer', description: 'coordinate：纵坐标（像素）' },
      index: { type: 'integer', description: 'element：get_app_state 返回的元素下标' },
      frame_id: { type: 'string', description: 'coordinate：对账用截图编号（可选）' },
      state_id: { type: 'string', description: 'element：对账用观察编号（可选；给了就要求是最新一次观察）' },
    },
    required: ['type'],
  }
}

/** 共用的参数表（两个工具都从这里取）。 */
export function argProps(): Record<string, unknown> {
  return {
    x: { type: 'integer', description: 'click/scroll：横坐标，用截图上的像素值（缩放由 dsc 换算）' },
    y: { type: 'integer', description: 'click/scroll：纵坐标，同上' },
    target: targetSchema(),
    from: targetSchema(),
    to: targetSchema(),
    window: { type: ['integer', 'string'], description: '绑定窗口：窗口 id（list_windows 的 window_id）或标题/进程名片段。绑定后坐标按该窗口左上角解析，并把该窗口带到前台' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click：哪个鼠标键，默认 left' },
    double: { type: 'boolean', description: 'click：true = 双击' },
    text: { type: 'string', description: 'type/paste：要输入/粘贴的文本（走剪贴板，中文与特殊字符都没问题）；paste 省略则直接粘贴当前剪贴板' },
    key: { type: 'string', description: 'key：键名或组合键，例如 enter / tab / ctrl+c / alt+tab（不支持 Win 键）' },
    repeat: { type: 'integer', description: 'key：重复次数，默认 1（上限 50）' },
    hold_seconds: { type: 'number', description: 'key：按下后保持秒数，默认 0（上限 10）' },
    amount: { type: 'integer', description: 'scroll：滚几档（默认 3）；drag：插值步数（默认 24）' },
    clip: {
      type: 'object',
      description: 'screenshot：只截一块区域（相对虚拟屏左上角的像素），省上下文',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    value: { type: 'string', description: 'set_value：要写进元素的值（元素不支持直接设值时回退成点击后输入）' },
    pattern: {
      type: 'string',
      enum: ['invoke', 'toggle', 'expand', 'collapse', 'select', 'scrollintoview'],
      description: 'perform_action：要派发的 UIA 动作',
    },
    return_state: { type: 'boolean', description: '动手后自动再观察一次并附上结论，默认 false' },
    disable_diffing: { type: 'boolean', description: 'get_app_state：取全树（默认只返回相对上次观察的增量）' },
  }
}

/** 动手工具的参数表（只读观察在某些配置下不在这里）。 */
export function computerToolParameters(actions: readonly string[], lookWithoutApproval: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...actions],
        description: lookWithoutApproval
          ? '要执行的动作（只读观察在 computer_look 里）'
          : '要执行的动作（含截屏、列窗口/应用/显示器、无障碍观察这些只读动作）',
      },
      ...argProps(),
    },
    required: ['action'],
  }
}

/** 看屏幕工具的参数表。 */
export function computerLookParameters(actions: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...actions], description: '要看什么（都是只读、不动手）' },
      ...argProps(),
    },
    required: ['action'],
  }
}

export const computerUsePlugin: Plugin.Object = {
  name: 'computer-use',
  inject: ['tools', 'prompt', 'settings'],
  apply(ctx, passed) {
    const readConfig = (): ComputerUseConfig => {
      const raw = resolvePluginConfig(CONFIG_KEY, passed)
      const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
        const num = Number(value)
        return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
      }
      return {
        maxEdge: clamp(raw.maxEdge, 640, 3840, DEFAULTS.maxEdge),
        format: raw.format === 'png' ? 'png' : 'jpeg',
        quality: clamp(raw.quality, 30, 100, DEFAULTS.quality),
        actionDelayMs: clamp(raw.actionDelayMs, 0, 2000, DEFAULTS.actionDelayMs),
        actionsPerScreenshot: clamp(raw.actionsPerScreenshot, 0, 200, DEFAULTS.actionsPerScreenshot),
        allowedApps: typeof raw.allowedApps === 'string' ? raw.allowedApps : DEFAULTS.allowedApps,
        disabledActions: typeof raw.disabledActions === 'string' ? raw.disabledActions : DEFAULTS.disabledActions,
        lookWithoutApproval: raw.lookWithoutApproval === true || raw.lookWithoutApproval === 'true',
        auditEnabled: raw.auditEnabled === undefined ? DEFAULTS.auditEnabled : raw.auditEnabled === true || raw.auditEnabled === 'true',
      }
    }
    let config = readConfig()

    /** 上一次截屏的缩放系数：点坐标按它换算回物理像素（1 = 一比一）。 */
    let lastScale = 1
    /** 自上次截屏以来已放行的动手动作数。 */
    let sinceScreenshot = 0
    /** 急停后动作面暂停；设置里点「恢复」清掉。 */
    let stopped = false

    const allowedApps = (): string[] => splitList(config.allowedApps)
    const disabled = (): Set<string> => {
      const out = new Set<string>()
      for (const entry of splitList(config.disabledActions)) {
        out.add(canonicalAction(entry) ?? entry) // 旧名（window_list）归一成规范名
      }
      return out
    }

    /** 写一行独立审计（路径来自 ctx.settings.about().home，不硬编码）。 */
    const audit = (action: string, risk: DesktopRiskTier, target: string, result: 'ok' | 'error', approved: boolean, detail?: string): void => {
      if (!config.auditEnabled) return
      appendComputerAudit(ctx.settings.about().home, {
        ts: Date.now(),
        action,
        risk,
        target,
        result,
        approved,
        ...(detail === undefined ? {} : { detail }),
      })
    }

    /** 把模型参数（snake_case）映射成内核 DesktopArgs（camelCase）。 */
    const toDesktopArgs = (args: Record<string, unknown>): DesktopArgs => ({
      x: args.x === undefined ? undefined : Number(args.x),
      y: args.y === undefined ? undefined : Number(args.y),
      target: args.target as DesktopTarget | undefined,
      from: args.from as DesktopTarget | undefined,
      to: args.to as DesktopTarget | undefined,
      window: args.window as number | string | undefined,
      button: args.button === undefined ? undefined : String(args.button),
      double: args.double === true,
      text: args.text === undefined ? undefined : String(args.text),
      key: args.key === undefined ? undefined : String(args.key),
      repeat: args.repeat === undefined ? undefined : Number(args.repeat),
      holdSeconds: args.hold_seconds === undefined ? undefined : Number(args.hold_seconds),
      amount: args.amount === undefined ? undefined : Number(args.amount),
      clip: args.clip as DesktopArgs['clip'],
      value: args.value === undefined ? undefined : String(args.value),
      pattern: args.pattern === undefined ? undefined : String(args.pattern),
      disableDiffing: args.disable_diffing === true,
    })

    /**
     * 一次动作的守卫与执行。
     * @param viaLook - 这次调用是否来自只读工具（computer_look）。决定审计里的 approved 与免审批档。
     */
    async function act(
      actionName: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      viaLook: boolean,
    ): Promise<string | { text: string; images?: string[] }> {
      const action = canonicalAction(actionName)
      if (action === null) throw new Error(`不认识的动作「${actionName}」。可选：${DESKTOP_ACTIONS.join(' / ')}`)

      // 急停永远可调（否则卡住后没法恢复）；它杀子进程 + 关动作面。
      if (action === 'stop') {
        const killed = killAllPowerShell()
        stopped = true
        audit('stop', 'system', '急停', 'ok', true)
        return `已急停电脑操作：杀掉 ${killed} 个在跑的界面子进程，并暂停了电脑操作动作面。请在「设置 → 电脑操作」点「恢复电脑操作」再继续。`
      }
      if (stopped) {
        throw new Error('电脑操作已急停（stop）。请在「设置 → 电脑操作」点「恢复电脑操作」再继续。')
      }
      const risk = gradeDesktopAction(action, args)
      if (disabled().has(action)) {
        throw new Error(`动作「${action}」被你在设置「电脑操作」的「禁用动作」里关掉了`)
      }

      try {
        if (action === 'screenshot') {
          const clip = args.clip as DesktopArgs['clip']
          const shot = await takeScreenshot(
            { maxEdge: config.maxEdge, format: config.format, quality: config.quality, ...(clip === undefined ? {} : { clip }) },
            signal,
          )
          lastScale = shot.scale ?? 1
          sinceScreenshot = 0
          audit('screenshot', 'read', args.clip === undefined ? '整个桌面' : `裁切 ${JSON.stringify(args.clip)}`, 'ok', !viaLook)
          // 截图里可能有别人的聊天、邮件、弹窗文案：包一层围栏，只当资料读。
          return { text: wrapUntrusted('screenshot', shot.text), images: shot.images }
        }

        if (READ_ACTIONS.includes(action)) {
          const result = await runDesktopAction(action, toDesktopArgs(args), { scale: lastScale, allowedApps: allowedApps(), actionDelayMs: config.actionDelayMs }, signal)
          if (action === 'get_app_state') sinceScreenshot = 0
          audit(action, 'read', action === 'get_app_state' ? describeTarget(args) : '只读观察', 'ok', !viaLook)
          // 别人应用的窗口标题/控件文案都是外部内容。
          return wrapUntrusted(action === 'get_app_state' ? 'app-state' : action, result.text)
        }

        // ── 动手类 ──
        const limit = config.actionsPerScreenshot
        if (limit > 0 && sinceScreenshot >= limit) {
          throw new Error(
            `距离上次截屏已经动手 ${sinceScreenshot} 次了，设置的上限是 ${limit} 次。界面早就可能变了，先 computer_look action=screenshot 看一眼现状再继续`,
          )
        }
        // 输入文本前的体检（type / paste 带文本 / set_value 的值）。
        const payload = action === 'set_value' ? String(args.value ?? '') : action === 'type' || action === 'paste' ? String(args.text ?? '') : ''
        if (payload !== '') {
          const blocked = typedTextBlockReason(payload)
          if (blocked !== null) throw new Error(blocked)
        }
        sinceScreenshot += 1
        const result = await runDesktopAction(action, toDesktopArgs(args), { scale: lastScale, allowedApps: allowedApps(), actionDelayMs: config.actionDelayMs }, signal)
        audit(action, risk, describeTarget(args), 'ok', !viaLook && risk !== 'read')

        let text = result.text
        if (args.return_state === true) {
          const after = await runDesktopAction('get_app_state', { window: args.window as DesktopArgs['window'], disableDiffing: false }, { scale: lastScale, allowedApps: allowedApps(), actionDelayMs: 0 }, signal)
          const settle = await settleObserve(
            async () => (await runDesktopAction('get_app_state', { window: args.window as DesktopArgs['window'] }, { scale: lastScale, allowedApps: allowedApps(), actionDelayMs: 0 }, signal)).text,
            (snapshot) => snapshot,
            { intervalMs: 150, timeoutMs: 2500 },
          )
          const frame = after.frame
          const unchanged =
            frame?.snapshot_mode === 'diff' && frame.diff !== undefined &&
            frame.diff.added.length === 0 && frame.diff.removed.length === 0 && frame.diff.changed.length === 0
          const evidence = settle.stable ? (unchanged ? 'effect_evidence: unchanged' : 'effect_evidence: changed') : 'effect_evidence: unknown（界面在超时内仍未稳定）'
          text = `${text}\n\n[动作后观察] ${evidence}；界面${settle.stable ? '已稳定' : '仍在变化'}（观察 ${frame?.state_id ?? '?'}，等了约 ${settle.waitedMs}ms）。\n${wrapUntrusted('app-state', after.text)}`
        }
        return text
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        audit(action, risk, describeTarget(args), 'error', !viaLook && risk !== 'read', message)
        throw error
      }
    }

    /** 目标摘要（审计行用）。 */
    function describeTarget(args: Record<string, unknown>): string {
      if (args.target !== undefined) {
        const t = args.target as DesktopTarget
        return t.type === 'element' ? `element#${t.index}` : `coord(${t.x},${t.y})`
      }
      if (args.from !== undefined || args.to !== undefined) return `drag ${JSON.stringify(args.from)}→${JSON.stringify(args.to)}`
      if (args.window !== undefined) return `window=${String(args.window)}`
      if (args.key !== undefined) return `key ${String(args.key)}`
      if (args.clip !== undefined) return `clip ${JSON.stringify(args.clip)}`
      return '—'
    }

    /**
     * 往桌面应用的输入框里打字/设值前的一次内容体检。
     * 两条硬规则：不代用户往外部应用填凭据；不把危险命令当成普通文本敲进去。
     */
    function typedTextBlockReason(text: string): string | null {
      if (text === '') return null
      if (redact(text) !== text) {
        return '要输入的文本里有密钥形状的字符串（API key、token、私钥、密码这类）。dsc 不代你把凭据打进桌面应用，请用户自己输这一段。'
      }
      const verdict = classifyCommand(text)
      if (verdict.decision === 'deny') {
        return `要输入的文本被策略当成灾难性命令（${verdict.reason}），拒绝替你敲进别人的输入框。`
      }
      return null
    }

    /** 动手的工具（每次都要审批）；没开免审批时，只读的看屏动作也留在里面一起过审批。 */
    function buildActTool(): import('../core/tools.js').ToolEntry {
      // 免审批开着：看屏动作归 computer_look，这个工具就不该再留（否则同一个动作两个入口）
      // 免审批没开：看屏动作只能走这个工具，否则模型连屏幕都看不到
      // stop 是急停，永远留在动手工具里（且不因禁用清单以外的东西消失）。
      const actions = DESKTOP_ACTIONS.filter(
        (action) => !disabled().has(action) && (!config.lookWithoutApproval || !LOOK_ACTIONS.includes(action)),
      )
      return {
        name: 'computer',
        description:
          '动手操作这台 Windows 电脑：点击（click）、拖拽（drag）、输入文本（type）、粘贴（paste）、按键（key）、滚动（scroll），' +
          '以及基于无障碍元素动作（set_value / select_text / perform_action）、急停（stop）' +
          (config.lookWithoutApproval ? '' : '，以及只读观察（screenshot / get_app_state / list_windows / list_apps / screens / cursor）') +
          '。每一次动手都会弹一张审批卡给用户确认。动手前务必先看一眼屏幕或先 get_app_state。',
        parameters: computerToolParameters(actions, config.lookWithoutApproval),
        risk: 'exec',
        run: (args, runCtx) => act(String(args.action ?? ''), args, runCtx.signal, false),
      }
    }

    /** 看屏幕的工具（免审批那一档）。 */
    function buildLookTool(): import('../core/tools.js').ToolEntry {
      const actions = LOOK_ACTIONS.filter((action) => !disabled().has(action))
      return {
        name: 'computer_look',
        description:
          '看这台 Windows 电脑，不动手：截屏（screenshot，返回图像，坐标就是图上的像素，可用 clip 裁切区域）、' +
          '无障碍观察（get_app_state，返回控件树 + 元素索引，可作 element 目标的依据）、列窗口（list_windows）、' +
          '列应用（list_apps）、列显示器（screens）、查鼠标（cursor）。',
        parameters: computerLookParameters(actions),
        risk: 'read',
        run: (args, runCtx) => act(String(args.action ?? ''), args, runCtx.signal, true),
      }
    }

    /** 提示词里那段闭环操作规矩（抄的是「看→定位→动手→再确认」这套，别凭记忆连点）。 */
    const promptText = (): string => {
      const apps = allowedApps()
      const toolLine = config.lookWithoutApproval
        ? 'computer（点击/拖拽/输入/粘贴/按键/滚动/元素动作/急停）+ computer_look（截屏/无障碍观察/列窗口/列应用/列显示器/查鼠标）'
        : 'computer 一个工具（截屏、无障碍观察、列窗口/应用/显示器、点击、拖拽、输入、按键、滚动都走它）'
      const lines = [
        '# 电脑操作（Windows 桌面）',
        `你现在能看并操作这台电脑：动手用 ${toolLine}。`,
        '必须按这个闭环干活：',
        '1. 先想清楚要操作哪个窗口/哪个应用（不确定就 computer_look 的 list_windows / list_apps 先列一遍）。',
        '2. 定位优先用无障碍元素：computer_look action=get_app_state 拿到控件树与元素索引；动作带 {type:"element", index} 目标即可。',
        `   图标/画布这类没有无障碍信息的地方才退回坐标：截图上的像素坐标可直接用作 x/y，当前缩放系数是 ${lastScale.toFixed(2)}（换算 dsc 来做）。`,
        '3. 动一次手之后再观察/截图确认结果。上一次观察的元素索引与上一次截图上的位置，在界面变化后即作废，别凭记忆连点。',
        '4. 「点击成功」不等于「目标达成」：以新观察/新截图看到的状态为准；需要时动作带 return_state:true 让 dsc 自动再观察一次。',
        '5. 用户取消这一轮之后，已经点出去的点击和已经输入的文本不会回滚；先截屏看清现状再决定下一步。',
        '6. 每次动手都会弹审批卡给用户。别连续铺一堆动作让用户一直点确认，也别在同一个位置反复重试。',
        '7. 截屏是整张桌面（或你裁切的一块），里面可能有无关的隐私内容，别把上面的内容念给用户听，只描述跟任务相关的部分。',
        '8. 紧急情况随时可以调 computer action=stop 急停（杀子进程 + 关动作面）。',
      ]
      if (apps.length > 0) lines.push(`9. 你被限定只能操作这些应用：${apps.join('、')}。切到别的应用上操作会被拦下来；需要换应用就告诉用户。`)
      if (config.actionsPerScreenshot > 0) lines.push(`${apps.length === 0 ? '9' : '10'}. 自上次截屏起最多连做 ${config.actionsPerScreenshot} 个动作，超了会被要求重新截屏。`)
      return lines.join('\n')
    }

    let disposers: Array<() => void> = []
    const syncTools = (): void => {
      for (const off of disposers) off()
      disposers = []
      disposers.push(ctx.tools.register(buildActTool()))
      if (config.lookWithoutApproval) disposers.push(ctx.tools.register(buildLookTool()))
      disposers.push(ctx.prompt.register('computer-use', promptText))
    }
    syncTools()
    // 旧截图只留文字，图像丢掉（否则每一轮请求都在重发过期画面）——命名纯投影，
    // 日志原文 + 这条定义就能重建模型看见的内容
    const offPrune = ctx.prompt.registerProjection('prune-stale-screenshots', dropStaleScreenshots)

    const fields = (): SettingsField[] => [
      { type: 'number', key: 'maxEdge', label: '截图最长边', min: 640, max: 3840, step: 64, help: '以像素为单位；超长屏幕会等比缩小，数值越小越省 token，但文字可能不清晰。' },
      {
        type: 'select',
        key: 'format',
        label: '截图编码',
        options: [
          { value: 'jpeg', label: 'JPEG，省 token，默认' },
          { value: 'png', label: 'PNG，无损，文件更大' },
        ],
      },
      { type: 'number', key: 'quality', label: 'JPEG 质量', min: 30, max: 100, step: 5, help: '仅在编码选择 JPEG 时生效。' },
      { type: 'number', key: 'actionDelayMs', label: '动作间隔', min: 0, max: 2000, step: 20, help: '以毫秒为单位；给目标程序留出反应时间，减少其输入合并。' },
      { type: 'number', key: 'actionsPerScreenshot', label: '自上次截屏以来的动作上限', min: 0, max: 200, step: 1, help: '0 为不限制；超限后会要求重新截屏，因为界面可能已经变化。' },
      { type: 'text', key: 'allowedApps', label: '应用白名单', placeholder: '留空 = 不限；例如 chrome,Code,腾讯会议', help: '按前台窗口的进程名或标题包含匹配，多个用逗号分隔；对名单之外应用的操作会被直接拦下。' },
      { type: 'text', key: 'disabledActions', label: '禁用动作', placeholder: '例如 click,type', help: `可选值：${DESKTOP_ACTIONS.join(' / ')}。` },
      { type: 'switch', key: 'lookWithoutApproval', label: '看屏幕免审批', help: '开启后截屏、无障碍观察、查鼠标、列窗口/应用/显示器走只读工具，不弹出审批卡；点击、输入、按键、滚动等动手动作仍每次需要确认。' },
      { type: 'switch', key: 'auditEnabled', label: '独立审计日志', help: '每次动作写一行到 ~/.dsc/audit/computer-use.jsonl（时刻/动作/目标/结果/是否审批过）。' },
      { type: 'button', action: 'who-is-front', label: '查看当前前台窗口', style: 'ghost', help: '用于验证白名单应填写的内容。' },
      { type: 'button', action: 'stop-computer', label: '急停电脑操作', style: 'ghost', help: `杀掉所有在跑的界面子进程并暂停动作面，等同于模型的 stop 动作。` },
      { type: 'button', action: 'resume-computer', label: '恢复电脑操作', style: 'ghost', help: '急停之后用它恢复；下一次动手照常要审批。' },
    ]

    const section: SettingsSectionSpec = {
      id: 'computer-use',
      title: '电脑操作',
      subtitle: '让模型查看屏幕并代为点击、拖拽、输入，Windows 平台',
      order: 45,
      fields,
      values: (): Record<string, SettingsValue> => ({
        maxEdge: config.maxEdge,
        format: config.format,
        quality: config.quality,
        actionDelayMs: config.actionDelayMs,
        actionsPerScreenshot: config.actionsPerScreenshot,
        allowedApps: config.allowedApps,
        disabledActions: config.disabledActions,
        lookWithoutApproval: config.lookWithoutApproval,
        auditEnabled: config.auditEnabled,
      }),
      // 契约：返回字符串 = 失败原因
      save: (key, value): string | void => {
        const clamp = (num: number, min: number, max: number): number => Math.min(Math.max(Math.round(num), min), max)
        switch (key) {
          case 'maxEdge':
            if (!Number.isFinite(Number(value))) return '截图最长边要填数字'
            writePluginConfig(CONFIG_KEY, { maxEdge: clamp(Number(value), 640, 3840) })
            break
          case 'format':
            writePluginConfig(CONFIG_KEY, { format: value === 'png' ? 'png' : 'jpeg' })
            break
          case 'quality':
            if (!Number.isFinite(Number(value))) return 'JPEG 质量要填数字'
            writePluginConfig(CONFIG_KEY, { quality: clamp(Number(value), 30, 100) })
            break
          case 'actionDelayMs':
            if (!Number.isFinite(Number(value))) return '动作间隔要填数字'
            writePluginConfig(CONFIG_KEY, { actionDelayMs: clamp(Number(value), 0, 2000) })
            break
          case 'actionsPerScreenshot':
            if (!Number.isFinite(Number(value))) return '动作上限要填数字'
            writePluginConfig(CONFIG_KEY, { actionsPerScreenshot: clamp(Number(value), 0, 200) })
            break
          case 'allowedApps':
            writePluginConfig(CONFIG_KEY, { allowedApps: String(value).trim() })
            break
          case 'disabledActions': {
            const list = splitList(String(value))
            const bad = list.filter((entry) => canonicalAction(entry) === null)
            if (bad.length > 0) return `不认识的动作：${bad.join('、')}。可选：${DESKTOP_ACTIONS.join(' / ')}`
            writePluginConfig(CONFIG_KEY, { disabledActions: list.map((entry) => canonicalAction(entry) ?? entry).join(',') })
            break
          }
          case 'lookWithoutApproval':
            writePluginConfig(CONFIG_KEY, { lookWithoutApproval: value === true || value === 'true' })
            break
          case 'auditEnabled':
            writePluginConfig(CONFIG_KEY, { auditEnabled: value === true || value === 'true' })
            break
          default:
            return `这个分区没有这项：${key}`
        }
        config = readConfig()
        sinceScreenshot = 0
        stopped = false // 用户改任何设置 = 重新握一次方向，急停状态清掉
        syncTools()
      },
      action: async (name): Promise<string> => {
        if (name === 'who-is-front') {
          const front = await foregroundWindow()
          const [processName = '', ...titleParts] = front.split('|')
          return `前台窗口：进程 ${processName}，标题「${titleParts.join('|') || '（无标题）'}」。白名单填进程名或标题片段都能命中。`
        }
        if (name === 'stop-computer') {
          const killed = killAllPowerShell()
          stopped = true
          audit('stop', 'system', '设置页急停', 'ok', true)
          return `已急停：杀掉 ${killed} 个在跑的界面子进程，并暂停电脑操作动作面。`
        }
        if (name === 'resume-computer') {
          stopped = false
          return '已恢复电脑操作；下一次动手照常会弹审批卡。'
        }
        throw new Error(`这个分区没有这个按钮：${name}`)
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => {
      offPrune()
      offSection()
      for (const off of disposers) off()
      disposers = []
    }
  },
}
