/**
 * microcompact 插件：一个纯投影贡献者，把每轮请求里**较旧的**工具结果正文换成占位符
 * （算法与跳过规则见 core/microcompact.ts 的模块注释）。
 *
 * 为什么单列一条内置插件、而不塞进 prompt 插件：它是可配、可关的一层**策略**
 * （keepRecent / minSaveTokens / enabled），跟内核那三条协议护栏（fold-system /
 * env-facts / drop-images）不是一回事——护栏不许外部顶掉、也不可关。
 *
 * 注册进投影链时 order 取 650：在 env-facts（600）之后、drop-images（900）之前。
 * 环境快照先补完、别的易变投影先做完，图像最后由 drop-images 兜底剥掉；本投影只碰
 * 文本工具结果，夹在中间既不会拿到被剥过的图，也不会把图投影要认的部件删掉。
 *
 * 不改会话日志：日志原文不动，模型看见的是「原文 + 投影链」的结果，可复算。
 *
 * @module dsc/plugins/microcompact
 */
import type { Plugin } from '@deepseek-ai/cordis'
import {
  applyMicrocompactPlan,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_MIN_SAVE_TOKENS,
  microcompact,
  planMicrocompact,
  roundKeyOf,
  type MicrocompactPlan,
} from '../core/microcompact.js'
import type { ChatMessage } from '../core/llm.js'
import type { Session } from '../core/session.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'
import { clampInt as clamp } from '../core/clamp.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'microcompact'

/** 投影在链上的位置：env-facts(600) 之后、drop-images(900) 之前。 */
const PROJECTION_ORDER = 650

/** 微压缩的可调值。 */
interface MicrocompactConfig {
  /** 最近多少条工具结果以内一律不碰。 */
  keepRecent: number
  /** 单条估算省下的 token 少于这个数就不清。 */
  minSaveTokens: number
  /** 总开关。默认开：长会话里这块浪费最大，保守值下副作用很小。 */
  enabled: boolean
  /**
   * 什么时候重算清理集合：`round` = 每轮开始清一次（默认，缓存友好）；
   * `request` = 每次请求都重算（旧行为，省上下文但每步都可能改前缀）。
   */
  refresh: 'round' | 'request'
}

const DEFAULTS: MicrocompactConfig = {
  keepRecent: DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  minSaveTokens: DEFAULT_MIN_SAVE_TOKENS,
  enabled: true,
  refresh: 'round',
}

/** 两个可调值的区间：低于下限把最近的证据也清掉，高于上限基本清不出空间。 */
const KEEP_RECENT_RANGE = { min: 1, max: 50 }
const MIN_SAVE_RANGE = { min: 0, max: 4000 }

/**
 * 从插件配置取这些可调值，并把区间外的值夹回来。
 * @param passed - 装配时传进来的配置（内核挂载时的第二参数）；没给就读磁盘。
 */
function readConfig(passed?: unknown): MicrocompactConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    // 少于 1 条等于把最近那一轮的现场证据也清掉（模型刚要接着用就没了）。
    keepRecent: clamp(raw.keepRecent, KEEP_RECENT_RANGE.min, KEEP_RECENT_RANGE.max, DEFAULTS.keepRecent),
    minSaveTokens: clamp(raw.minSaveTokens, MIN_SAVE_RANGE.min, MIN_SAVE_RANGE.max, DEFAULTS.minSaveTokens),
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : raw.enabled === true || raw.enabled === 'true',
    refresh: raw.refresh === 'request' ? 'request' : DEFAULTS.refresh,
  }
}

export const microcompactPlugin: Plugin.Object = {
  name: 'microcompact',
  inject: ['prompt', 'settings', 'session'],
  apply(ctx, passed) {
    let config = readConfig(passed)
    /** 写盘并立刻重读：下一次请求就用新值，不必重启宿主。 */
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig(passed)
    }

    /**
     * 每个会话冻结的那份清理计划（2026-10-28）：一轮之内复用它，只有新一轮
     * 或消息列表被压缩变短时才重算。投影签名现在带会话（内核 API 加了第二参），
     * 后台会话因此拿自己的计划与自己的失败结果集合。
     */
    const frozen = new Map<string, { round: number; plan: MicrocompactPlan; length: number }>()

    const offProjection = ctx.prompt.registerProjection(
      'microcompact',
      (messages: ChatMessage[], session?: Session): ChatMessage[] => {
        if (!config.enabled) return messages
        const owner = session ?? ctx.session.current()
        // 失败/被拒的 tool_call_id 记在会话旁路（Session.toolErrors）、不在协议消息里。
        const options = {
          keepRecent: config.keepRecent,
          minSaveTokens: config.minSaveTokens,
          errorCallIds: new Set(owner.toolErrors.keys()),
        }
        if (config.refresh === 'request') return microcompact(messages, options)

        const round = roundKeyOf(messages)
        const sid = owner.meta.id
        const held = frozen.get(sid)
        // 同一轮、消息没变短：复用上一次的计划（前缀因此逐步稳定，缓存能一直命中）。
        if (held !== undefined && held.round === round && messages.length >= held.length) {
          return applyMicrocompactPlan(messages, held.plan)
        }
        const plan = planMicrocompact(messages, options)
        frozen.set(sid, { round, plan, length: messages.length })
        if (frozen.size > 64) {
          // 会话多了别让这张表无界长；删最早登记的那一条（Map 插入序）。
          const first = frozen.keys().next().value
          if (first !== undefined && first !== sid) frozen.delete(first)
        }
        return applyMicrocompactPlan(messages, plan)
      },
      { order: PROJECTION_ORDER },
    )

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    const fields: SettingsField[] = [
      {
        type: 'switch',
        key: 'enabled',
        label: '清理旧工具结果',
        help: '开着时把较旧的工具结果正文换成一句占位符（会话日志里的原文不动）。关掉则原样发送。',
      },
      {
        type: 'select',
        key: 'refresh',
        label: '清理时机',
        options: [
          { value: 'round', label: '每轮开始清一次（默认，缓存命中高）' },
          { value: 'request', label: '每次请求都清（省上下文，前缀常失效）' },
        ],
        help:
          '一轮 = 你发一句话之后模型连着跑的那几十步。每轮只清一次时，同一轮内的请求前缀不变，' +
          '服务端前缀缓存能一直命中；每次请求都清会让刚滑出窗口的那条被改写，从那里往后整段不命中。',
      },
      {
        type: 'number',
        key: 'keepRecent',
        label: '最近保留几条工具结果',
        min: KEEP_RECENT_RANGE.min,
        max: KEEP_RECENT_RANGE.max,
        step: 1,
        help: '这几条原样留着，更早的才清。数值越大，模型回头能查的原文越多，省出来的上下文越少。',
      },
      {
        type: 'number',
        key: 'minSaveTokens',
        label: '单条最少省多少 token 才清',
        min: MIN_SAVE_RANGE.min,
        max: MIN_SAVE_RANGE.max,
        step: 64,
        help: '清一条短的省不出多少，还白丢证据，所以不到这个门槛就不清。填 0 表示只要能省就清。',
      },
    ]

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: '旧工具结果清理',
      subtitle: '把较旧的工具结果换成占位符：只动请求体、不改会话日志，默认每轮只清一次',
      // 紧挨压缩（35）之后：两者都是省上下文的手段，用户找起来是同一类东西。
      order: 36,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig(passed)
        return { enabled: config.enabled, refresh: config.refresh, keepRecent: config.keepRecent, minSaveTokens: config.minSaveTokens }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        if (key === 'enabled') {
          applyConfig({ enabled: value === true || value === 'true' })
          return
        }
        if (key === 'refresh') {
          const next = String(value)
          if (next !== 'round' && next !== 'request') return '清理时机只能是 round（每轮一次）或 request（每次请求）'
          applyConfig({ refresh: next })
          return
        }
        const num = Number(value)
        if (!Number.isFinite(num)) return '这里要填一个数字'
        if (key === 'keepRecent') applyConfig({ keepRecent: num })
        else if (key === 'minSaveTokens') applyConfig({ minSaveTokens: num })
        else return `这个分区没有这项：${key}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => {
      offProjection()
      offSection()
    }
  },
}
