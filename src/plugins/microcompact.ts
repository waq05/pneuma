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
import { DEFAULT_KEEP_RECENT_TOOL_RESULTS, DEFAULT_MIN_SAVE_TOKENS, microcompact } from '../core/microcompact.js'
import type { ChatMessage } from '../core/llm.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

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
}

const DEFAULTS: MicrocompactConfig = {
  keepRecent: DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  minSaveTokens: DEFAULT_MIN_SAVE_TOKENS,
  enabled: true,
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
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
  }
  return {
    // 少于 1 条等于把最近那一轮的现场证据也清掉（模型刚要接着用就没了）。
    keepRecent: clamp(raw.keepRecent, KEEP_RECENT_RANGE.min, KEEP_RECENT_RANGE.max, DEFAULTS.keepRecent),
    minSaveTokens: clamp(raw.minSaveTokens, MIN_SAVE_RANGE.min, MIN_SAVE_RANGE.max, DEFAULTS.minSaveTokens),
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : raw.enabled === true || raw.enabled === 'true',
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

    const offProjection = ctx.prompt.registerProjection(
      'microcompact',
      (messages: ChatMessage[]): ChatMessage[] => {
        if (!config.enabled) return messages
        // 失败/被拒的 tool_call_id 记在会话旁路（Session.toolErrors）、不在协议消息里。
        // ⚠ 已知限制：投影函数拿不到「本次请求所属会话」，只能用当前查看的会话——常驻多
        // agent 下后台会话在跑、用户正看着另一个会话时会取错，那条失败结果就拿不到保护、
        // 可能被当普通旧结果清掉（是「会误清」，只是限于失败结果这一条证据）。同一模式在
        // hooks / lsp 的投影里也有。根治要把会话线程进投影签名 `fn(messages, session)`，
        // 属内核 API 变更，留给后续单独做，本批不动。
        return microcompact(messages, {
          keepRecent: config.keepRecent,
          minSaveTokens: config.minSaveTokens,
          errorCallIds: new Set(ctx.session.current().toolErrors.keys()),
        })
      },
      { order: PROJECTION_ORDER },
    )

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    const fields: SettingsField[] = [
      {
        type: 'switch',
        key: 'enabled',
        label: '每轮清理旧工具结果',
        help: '开着时，每次请求把较旧的工具结果正文换成一句占位符（会话日志里的原文不动）。关掉则原样发送。',
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
      subtitle: '每轮请求把较旧的工具结果换成占位符，只动请求体、不改会话日志',
      // 紧挨压缩（35）之后：两者都是省上下文的手段，用户找起来是同一类东西。
      order: 36,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig(passed)
        return { enabled: config.enabled, keepRecent: config.keepRecent, minSaveTokens: config.minSaveTokens }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        if (key === 'enabled') {
          applyConfig({ enabled: value === true || value === 'true' })
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
