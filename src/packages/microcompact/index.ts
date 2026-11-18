/**
 * microcompact 插件：一个纯投影贡献者，把每轮请求里**较旧的**工具结果正文换成占位符
 * （算法与跳过规则见 microcompact.ts 的模块注释）。
 *
 * 为什么单列一条内置插件、而不塞进 prompt 插件：它是可配、可关的一层**策略**
 * （keepRecent / minSaveTokens / minFreePercent / enabled），跟内核那三条协议护栏（fold-system /
 * env-facts / drop-images）不是一回事——护栏不许外部顶掉、也不可关。
 *
 * 注册进投影链时 order 取 650：在 env-facts（600）之后、drop-images（900）之前。
 * 环境快照先补完、别的易变投影先做完，图像最后由 drop-images 兜底剥掉；本投影只碰
 * 文本工具结果，夹在中间既不会拿到被剥过的图，也不会把图投影要认的部件删掉。
 *
 * 不改会话日志：日志原文不动，模型看见的是「原文 + 投影链」的结果，可复算。
 *
 * 另外对外提供 `microcompact` 服务（2026-11-02）：压缩插件在爆窗重试前先用它算一眼
 * 「清理之后还装不装得下」，装得下就不必牺牲历史去压摘要。
 *
 * 清理时机三档（2026-11-18 起默认 `budget`），差别只在「清理点什么时候往前挪」：
 * - `budget`（默认）：每次进入新一轮只**累计**可省的字符，新增条目合计省够
 *   {@link DEFAULT_ADVANCE_CHARS}（8192 字符）才把清理点推进一次；两次推进之间一直应用
 *   同一份 activePlan，前缀不动、缓存连中。代价是旧工具结果多留几轮。
 * - `round`：每轮重算一次（旧默认）。工具密集会话几乎每轮都要挪清理点，实测命中率
 *   被拖到 60% 上下（会话 bb13f0b5）。
 * - `request`：每次请求都重算（最省上下文、前缀最碎，只在窗口极紧时用）。
 * 三档的取舍是同一笔账：命中的 token 只按约 1/10 价收，断一次却把清理点之后整段按全价
 * 重读，所以 `budget` 宁可攒。
 *
 * @module dsc/plugins/microcompact
 */
import type { Plugin } from '@deepseek-ai/cordis'
import {
  advanceMicrocompactPlan,
  applyMicrocompactPlan,
  DEFAULT_ADVANCE_CHARS,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_MIN_SAVE_TOKENS,
  planMicrocompact,
  planWorthApplying,
  roundKeyOf,
  type MicrocompactPlan,
} from './microcompact.js'
import { estimateTokens } from '@pneuma/session-core/compact.js'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { Session } from '@pneuma/runtime/core/session.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { MicrocompactService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { clampInt as clamp } from '@pneuma/runtime/core/clamp.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'microcompact'

/** 投影在链上的位置：env-facts(600) 之后、drop-images(900) 之前。 */
const PROJECTION_ORDER = 650

/** 空计划：门槛没达到时用它占住 frozen，同一轮的后续请求就不再重算。 */
const EMPTY_PLAN: MicrocompactPlan = new Map()

/** 冻结表最多记多少个会话（budget 的 activePlan 与 round 的冻结计划共用这张表）。 */
const SESSION_LIMIT = 64

/** 三档清理时机（顺序即设置面下拉框的顺序，默认第一档）。 */
const REFRESH_MODES = ['budget', 'round', 'request'] as const

/** 一个会话冻结的计划（round/request 档的当前计划，与 budget 档的已生效计划共用一条记录）。 */
interface FrozenPlan {
  /** 这条记录属于第几轮（真人发言轮号）；同一轮且消息没变短就复用。 */
  round: number
  /** 这次请求要应用的计划：round/request 是当前算的，budget 是 activePlan。 */
  applied: MicrocompactPlan
  /** budget 档的已生效清理计划，只增不减；其余两档不用（空计划）。 */
  active: MicrocompactPlan
  /** 登记时的消息条数：变短（被压缩）就重算。 */
  length: number
}

/** 微压缩的可调值。 */
interface MicrocompactConfig {
  /** 最近多少条工具结果以内一律不碰。 */
  keepRecent: number
  /** 单条估算省下的 token 少于这个数就不清。 */
  minSaveTokens: number
  /** 一次清理能清掉的字符占整段提示词的百分比低于这个数，就一条都不清（0–80）。 */
  minFreePercent: number
  /** 总开关。默认开：长会话里这块浪费最大，保守值下副作用很小。 */
  enabled: boolean
  /**
   * 清理点什么时候推进（三档语义与代价见模块注释）：
   * - `budget`（默认）：新增条目合计省够 {@link DEFAULT_ADVANCE_CHARS} 才推进一次，其余时间复用
   *   同一份已生效计划；
   * - `round`：每轮开始重算一次（旧默认）；
   * - `request`：每次请求都重算（最省上下文，前缀最碎）。
   */
  refresh: (typeof REFRESH_MODES)[number]
}

const DEFAULTS: MicrocompactConfig = {
  keepRecent: DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  minSaveTokens: DEFAULT_MIN_SAVE_TOKENS,
  minFreePercent: 25,
  enabled: true,
  refresh: 'budget',
}

/** 三个可调值的区间：低于下限把最近的证据也清掉，高于上限基本清不出空间。 */
const KEEP_RECENT_RANGE = { min: 1, max: 50 }
const MIN_SAVE_RANGE = { min: 0, max: 4000 }
/** 上限 80：再高就等于要求几乎把整段提示词清空，正常会话不可能达到，等于关掉清理。 */
const MIN_FREE_RANGE = { min: 0, max: 80 }

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
    minFreePercent: clamp(raw.minFreePercent, MIN_FREE_RANGE.min, MIN_FREE_RANGE.max, DEFAULTS.minFreePercent),
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : raw.enabled === true || raw.enabled === 'true',
    // 只认这三档；手改 plugins.json 写歪了回落默认，别让一个拼错的词改变清理节奏。
    refresh: REFRESH_MODES.find((mode) => mode === raw.refresh) ?? DEFAULTS.refresh,
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
     * 每个会话冻结的计划（2026-10-28；2026-11-18 起 budget 档另存一份只增不减的 activePlan）。
     *
     * - `applied`：这次请求要应用的计划。`round`/`request` 档是当前算出来的那份；
     *   budget 档是累计生效的 activePlan（推进过就换新的，没推进仍是旧的）。
     * - `active`：budget 档的「已生效清理计划」，callId → 占位符，只增不减。压缩把历史变短后，
     *   里面不在消息里的 callId 自然失效（apply 跳过），不必专门清理。
     * - `round`/`length`：轮号与消息条数，同一轮且没变短就复用，保证一轮多步请求逐字节相同。
     *
     * 投影签名现在带会话（内核 API 加了第二参），后台会话因此拿自己的计划与自己的失败结果集合。
     */
    const frozen = new Map<string, FrozenPlan>()

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
        /**
         * 门槛：清 1 token 只按 1/10 价省，断一次前缀要按全价重读整段。
         * 所以先算出计划能清多少字符，占整段提示词不够 minFreePercent 就换空计划——
         * 这一轮一条都不清，等下一轮攒多了再动。
         */
        const worthApplying = (plan: MicrocompactPlan): boolean => planWorthApplying(messages, plan, config.minFreePercent)

        if (config.refresh === 'request') {
          const planned = planMicrocompact(messages, options)
          return applyMicrocompactPlan(messages, worthApplying(planned) ? planned : EMPTY_PLAN)
        }

        const round = roundKeyOf(messages)
        const sid = owner.meta.id
        const held = frozen.get(sid)
        // 同一轮、消息没变短：复用上一次的计划（前缀因此逐步稳定，缓存能一直命中）。
        if (held !== undefined && held.round === round && messages.length >= held.length) {
          return applyMicrocompactPlan(messages, held.applied)
        }
        const planned = planMicrocompact(messages, options)
        let applied: MicrocompactPlan
        if (config.refresh === 'budget') {
          // budget：已生效的 activePlan 只增不减；新增条目省够预算才推进一次，
          // 否则继续应用旧计划——清理点不动，前缀缓存就能一直命中。
          applied = advanceMicrocompactPlan(messages, held?.active ?? EMPTY_PLAN, planned, {
            minFreePercent: config.minFreePercent,
          }).plan
        } else {
          // round：每轮重算一次（旧默认），门槛不够就整轮用空计划。
          applied = worthApplying(planned) ? planned : EMPTY_PLAN
        }
        // 判定放在「算出计划之后、写进 frozen 之前」：跳过时也冻结空计划与本轮条数，
        // 同一轮内不再反复算（否则每一步都要重扫一遍消息，还显得计划一直在变）。
        frozen.set(sid, {
          round,
          applied,
          active: config.refresh === 'budget' ? applied : EMPTY_PLAN,
          length: messages.length,
        })
        if (frozen.size > SESSION_LIMIT) {
          // 会话多了别让这张表无界长：删最早登记的那一条（Map 插入序）。
          // 当前会话恰好是最早那条时删次早的，别把刚写进去的记录删掉。
          for (const key of frozen.keys()) {
            if (key !== sid) {
              frozen.delete(key)
              break
            }
          }
        }
        return applyMicrocompactPlan(messages, applied)
      },
      { order: PROJECTION_ORDER },
    )
    ctx.effect(() => offProjection, 'microcompact: prompt.registerProjection')

    /**
     * 投影估算服务（2026-11-02）：把旧工具结果换成占位符之后，整段消息的估算 token 数。
     * 只算不落盘，用的是本插件现读的 config 与同一套 plan / apply，跟真正发请求时一致。
     *
     * 两处会让估算**比真正发出的更小**（方向是估小/乐观，不是偏保守）：
     * - 失败/被拒的 tool_call_id 记在会话旁路（`Session.toolErrors`），这个接口只收消息、
     *   拿不到会话，只能按空集算——那类结果本来该保留，却按「会清掉」算了；
     * - budget 档看不到会话里冻结的 activePlan（同一轮内可能还没推进到这么多），
     *   这里却按「当前消息重算出来的计划」估。
     *
     * 极端情况下「清理后装得下」的短路会误判成装得下，最后仍抛原来的爆窗错，
     * 而不是去压摘要。与旧 `round` 档同一口径（旧档在同一轮内同样用「重算的计划」估算），
     * 不是本次引入的偏差。
     */
    const service: MicrocompactService = {
      projectedTokens(messages: readonly ChatMessage[]): number {
        // 关掉时没有投影，发出去的就是原文
        if (!config.enabled) return estimateTokens(messages)
        const plan = planMicrocompact(messages, {
          keepRecent: config.keepRecent,
          minSaveTokens: config.minSaveTokens,
        })
        // 门槛没达到时投影也不生效（见 planWorthApplying 的注释），估算按原文算
        if (!planWorthApplying(messages, plan, config.minFreePercent)) return estimateTokens(messages)
        return estimateTokens(applyMicrocompactPlan(messages, plan))
      },
    }
    const offService = ctx.provide('microcompact', service)

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    const fields: SettingsField[] = [
      {
        type: 'switch',
        key: 'enabled',
        label: t('field.enabled.label'),
        help: t('field.enabled.help'),
      },
      {
        type: 'select',
        key: 'refresh',
        label: t('field.refresh.label'),
        options: [
          { value: 'budget', label: t('field.refresh.option.budget') },
          { value: 'round', label: t('field.refresh.option.round') },
          { value: 'request', label: t('field.refresh.option.request') },
        ],
        help: t('field.refresh.help'),
      },
      {
        type: 'number',
        key: 'keepRecent',
        label: t('field.keepRecent.label'),
        min: KEEP_RECENT_RANGE.min,
        max: KEEP_RECENT_RANGE.max,
        step: 1,
        help: t('field.keepRecent.help'),
      },
      {
        type: 'number',
        key: 'minSaveTokens',
        label: t('field.minSaveTokens.label'),
        min: MIN_SAVE_RANGE.min,
        max: MIN_SAVE_RANGE.max,
        step: 64,
        help: t('field.minSaveTokens.help'),
      },
      {
        type: 'number',
        key: 'minFreePercent',
        label: t('field.minFreePercent.label'),
        min: MIN_FREE_RANGE.min,
        max: MIN_FREE_RANGE.max,
        step: 5,
        help: t('field.minFreePercent.help'),
      },
    ]

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      // 紧挨压缩（35）之后：两者都是省上下文的手段，用户找起来是同一类东西。
      order: 36,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig(passed)
        return {
          enabled: config.enabled,
          refresh: config.refresh,
          keepRecent: config.keepRecent,
          minSaveTokens: config.minSaveTokens,
          minFreePercent: config.minFreePercent,
        }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        if (key === 'enabled') {
          applyConfig({ enabled: value === true || value === 'true' })
          return
        }
        if (key === 'refresh') {
          const next = String(value)
          if (!(REFRESH_MODES as readonly string[]).includes(next)) return t('save.badRefresh')
          applyConfig({ refresh: next })
          return
        }
        const num = Number(value)
        if (!Number.isFinite(num)) return t('save.notNumber')
        if (key === 'keepRecent') applyConfig({ keepRecent: num })
        else if (key === 'minSaveTokens') applyConfig({ minSaveTokens: num })
        else if (key === 'minFreePercent') applyConfig({ minFreePercent: num })
        else return t('save.unknownKey', { key })
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'microcompact: settings.registerSection')

    return () => {
      offService()
      offProjection()
      offSection()
    }
  },
}
