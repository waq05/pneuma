/**
 * llm 插件：provide `llm` 服务（端点路由 + 模型热切换的唯一状态持有者）。
 * 逻辑迁自 v2 adapter/core-runtime 的 route/setModel 段；提示文本改由
 * runtime 插件经 transcript 呈现，本插件只做校验与状态。
 *
 * 思考档位怎么发、这个模型收不收图，都由 config.yaml 里那一行的能力声明决定
 * （见 core/model-caps.ts）；界面上选了模型不支持的档位会在这里被拦住。
 *
 * @module dsc/plugins/llm
 */
import type { Plugin, Context } from '@deepseek-ai/cordis'
import type { ModelInfo, DscCoreConfig } from '../core/config.js'
import { DEFAULT_CAPS, clampEffort, effortToWire, hasEffortLevel, THINKING_LEVEL_LABELS, type ModelCaps } from '../core/model-caps.js'
import { OPENAI_COMPLETIONS_API, streamChat, type LlmAdapter, type ToolOrphanReport } from '../core/llm.js'
import type { EffortLevel, ModelChoiceView, Modality } from '../contract.js'
import type { LlmRoute, LlmService } from '../services/types.js'
import type { Session } from '../core/session.js'

/** 请求侧清洗提醒的账：会话 id → 上次报过的报告形状（同形状不重复报，形状变了再报一次）。 */
const sanitizeNotices = new Map<string, string>()

/**
 * 当前会话 id；读不到（没有会话、最小假 ctx）就当没有。
 * 请求归因头靠它兜底：拿不到会话 id 时省略那个头，比编一个稳。
 */
function currentSessionId(ctx: Context): string | undefined {
  try {
    return ctx.session.current().meta.id
  } catch {
    return undefined
  }
}

/** 历史有协议残留、请求侧兜底清洗过：给用户说一声（同一个会话同一种残留只报一次）。 */
function noticeSanitize(ctx: Context, report: ToolOrphanReport): void {
  const sid = ctx.session.current().meta.id
  const shape = `${String(report.droppedResults)}/${String(report.droppedCalls)}/${String(report.droppedMessages)}/${String(report.reordered)}`
  if (sanitizeNotices.get(sid) === shape) return
  sanitizeNotices.set(sid, shape)
  const parts: string[] = []
  if (report.droppedResults > 0) parts.push(`丢弃重复/孤儿的工具结果 ${String(report.droppedResults)} 条`)
  if (report.droppedCalls > 0) parts.push(`剔掉没有回应的工具调用 ${String(report.droppedCalls)} 个`)
  if (report.droppedMessages > 0) parts.push(`整条删除已无内容的回复 ${String(report.droppedMessages)} 条`)
  if (report.reordered > 0) parts.push(`把 ${String(report.reordered)} 条插队的消息移回工具结果之后`)
  ctx.emit(
    'dsc/notice',
    `会话日志里有协议残留（多半来自上一次中断），这次请求已自动清洗：${parts.join('、')}。只影响发给模型的这一份，日志文件不动。`,
  )
}

export const llmPlugin: Plugin.Object<DscCoreConfig> = {
  name: 'llm',
  inject: ['session'],
  provide: 'llm',
  apply(ctx, config) {
    /**
     * 模型与思考档位**按会话**存（2026-10-28，与权限同一批）：值在会话 `model` 状态条目里，
     * 不再有进程级 currentProvider/currentModel。后台 agent 用自己的会话取路由，
     * 不会因为用户看着别的会话就换模型。
     *
     * `lastSelected` 只服务一件事：新建会话没记过模型时沿用「上一次选的那一组」，
     * 保持 /model 热切换的老手感；恢复老会话没有记录时按配置默认走。
     */
    let lastSelected = {
      provider: config.defaultProvider,
      model: config.defaultModel,
      // 'default' = 不发思考字段（跟随端点默认行为）
      effort: 'default' as EffortLevel,
    }
    // T39：启动会话记过模型就先恢复它；没记过才用配置默认。
    const startupSaved = ctx.session.current().state('model')
    if (startupSaved !== undefined && findModel(startupSaved.provider, startupSaved.model) !== undefined) {
      lastSelected = {
        provider: startupSaved.provider,
        model: startupSaved.model,
        effort: clampEffort(capsFor(startupSaved.provider, startupSaved.model), startupSaved.effort ?? 'default'),
      }
    }
    // 新建会话（没有 filePath）没记过模型时，把上一次选的写进去；恢复老会话只在有记录时用记录。
    ctx.on('dsc/session-open', ({ session, filePath }) => {
      if (session.state('model') !== undefined) {
        ctx.emit('dsc/changed')
        return
      }
      if (filePath !== undefined) return
      // 没选过档位时用偏好的新会话默认（设置里改「思考强度」会同时记成默认）
      const effort = lastSelected.effort === 'default'
        ? ((ctx.get('settings')?.prefs().defaultEffort ?? 'default') as EffortLevel)
        : lastSelected.effort
      session.appendState('model', { provider: lastSelected.provider, model: lastSelected.model, effort })
      ctx.emit('dsc/changed')
    })
    /** 协议适配器表：id → 适配器。内置 openai-completions 预注册，插件可补新的协议。 */
    const adapters = new Map<string, LlmAdapter>([
      [OPENAI_COMPLETIONS_API, { id: OPENAI_COMPLETIONS_API, stream: streamChat }],
    ])

    function findModel(providerName: string, modelName: string): ModelInfo | undefined {
      // provider 表可能缺（最小假 ctx 的测试/插件环境），空表按查不到算
      return (config.providers ?? {})[providerName]?.models.find((model) => model.id === modelName)
    }

    /** 这个模型声明了什么能力；查不到（老配置、临时路由）按旧行为算。 */
    function capsFor(providerName: string, modelName: string): ModelCaps {
      return findModel(providerName, modelName) ?? DEFAULT_CAPS
    }

    /**
     * 按给定的端点/模型/档位组一份请求路由，不动当前选择。
     * 子智能体拿它跑角色自己指定的模型，父会话不受影响。
     * 档位在这个模型上不存在时退回「默认」（不发字段），而不是把端点不认识的值发出去。
     */
    function routeFor(providerName: string, modelName: string, effort: EffortLevel): LlmRoute {
      const provider = (config.providers ?? {})[providerName]
      if (provider === undefined) {
        throw new Error(
          `没有名为 ${providerName} 的模型端点（检查 ~/.dsc/config.yaml 的 providers 段与对应 API key 环境变量）`,
        )
      }
      const model = findModel(providerName, modelName)
      const wire = effortToWire(capsFor(providerName, modelName), clampEffort(capsFor(providerName, modelName), effort))
      return {
        api: provider.api ?? OPENAI_COMPLETIONS_API,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: modelName,
        maxTokens: model?.maxTokens,
        temperature: config.temperature,
        thinking: wire.thinking,
        reasoningEffort: wire.reasoningEffort,
        // 显式缓存断点：只有端点自己声明了才带（缺省不带 = DeepSeek 请求体逐字节不变）
        ...(provider.cacheControl === true ? { cacheControl: true } : {}),
      }
    }

    /** 某个会话生效的三项：会话记过且模型还在配置里就用它，否则回落配置默认。 */
    interface EffectiveModel {
      provider: string
      model: string
      effort: EffortLevel
    }
    const effectiveOf = (session: Session): EffectiveModel => {
      // 最小假会话（探针）没有 state：按配置默认算，别把一次判定炸掉。
      const saved = typeof session.state === 'function' ? session.state('model') : undefined
      const provider = saved !== undefined && findModel(saved.provider, saved.model) !== undefined ? saved.provider : config.defaultProvider
      const model = saved !== undefined && findModel(saved.provider, saved.model) !== undefined ? saved.model : config.defaultModel
      const fallbackEffort = (ctx.get('settings')?.prefs().defaultEffort ?? 'default') as EffortLevel
      const effort = clampEffort(capsFor(provider, model), saved?.effort ?? fallbackEffort)
      return { provider, model, effort }
    }
    const windowOf = (effective: EffectiveModel): number => findModel(effective.provider, effective.model)?.contextWindow ?? 128_000

    const service: LlmService = {
      get provider() {
        return effectiveOf(ctx.session.current()).provider
      },
      get model() {
        return effectiveOf(ctx.session.current()).model
      },
      get effort() {
        return effectiveOf(ctx.session.current()).effort
      },
      get contextWindow() {
        return windowOf(effectiveOf(ctx.session.current()))
      },
      get inputModalities(): Modality[] {
        const effective = effectiveOf(ctx.session.current())
        return capsFor(effective.provider, effective.model).modalities
      },
      route(): LlmRoute {
        const effective = effectiveOf(ctx.session.current())
        return routeFor(effective.provider, effective.model, effective.effort)
      },
      routeForSession(session): LlmRoute {
        const effective = effectiveOf(session)
        return routeFor(effective.provider, effective.model, effective.effort)
      },
      providerOf(session) {
        return effectiveOf(session).provider
      },
      modelOf(session) {
        return effectiveOf(session).model
      },
      contextWindowOf(session) {
        return windowOf(effectiveOf(session))
      },
      routeTo(provider, model, effort): LlmRoute {
        return routeFor(provider, model, effort)
      },
      registerAdapter(adapter) {
        if (adapters.has(adapter.id)) {
          throw new Error(`协议适配器 ${adapter.id} 已经注册过（内置与插件不允许重名，换个 id）`)
        }
        adapters.set(adapter.id, adapter)
        return () => {
          if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id)
        }
      },
      stream(api, request, handlers) {
        const adapter = adapters.get(api)
        if (adapter === undefined) {
          const known = [...adapters.keys()].map((id) => (id === api ? `「${id}」` : id)).join('、')
          throw new Error(
            `端点声明的协议 ${api} 没有对应的适配器（已注册：${known}）。\n` +
              '检查 config.yaml 里这个端点的 api 字段，或启用提供该协议的插件。',
          )
        }
        // 会话归因（opencode Go 要求每条会话带一个稳定 id）：这里是所有模型请求的
        // **唯一汇聚点**——回合轮次、压缩、标题、审批、子智能体都从这条缝过，
        // 默认值在这里补一次全体受益。调用方手里有更准的会话（后台 agent 跑的
        // 不是「当前查看的会话」，见 core/loop）会自己填，填了就听它的。
        return adapter.stream(
          { ...request, sessionId: request.sessionId ?? currentSessionId(ctx) },
          { ...handlers, onSanitize: (report) => noticeSanitize(ctx, report) },
        )
      },
      setEffort(effort) {
        const session = ctx.session.current()
        const current = effectiveOf(session)
        const caps = capsFor(current.provider, current.model)
        if (!hasEffortLevel(caps, effort)) {
          const declared =
            caps.thinkingLevels.length === 0
              ? '这个模型没声明思考能力，只有「默认」可选'
              : `这个模型只支持：${caps.thinkingLevels.map((level) => THINKING_LEVEL_LABELS[level]).join('、')}`
          const wanted = effort === 'default' ? '默认' : THINKING_LEVEL_LABELS[effort]
          throw new Error(`思考档位「${wanted}」用不了 —— ${declared}（在设置 → 模型里给它勾上）`)
        }
        session.appendState('model', { provider: current.provider, model: current.model, effort })
        lastSelected = { provider: current.provider, model: current.model, effort }
        ctx.emit('dsc/changed')
      },
      setModel(provider, model) {
        const target = (config.providers ?? {})[provider]
        if (target === undefined) {
          throw new Error(
            `没有名为 ${provider} 的端点；可用：${Object.keys(config.providers ?? {}).join('、') || '（无）'}`,
          )
        }
        if (!target.models.some((entry) => entry.id === model)) {
          throw new Error(
            `端点 ${provider} 没有模型 ${model}；可用：${target.models.map((entry) => entry.id).join('、')}`,
          )
        }
        // 原来选的档位在新模型上未必存在，退回「默认」比留着发不出去的值强
        const effort = clampEffort(capsFor(provider, model), effectiveOf(ctx.session.current()).effort)
        // 记进当前会话——恢复会话时优先用它，后台 agent 也按自己的记录取路由
        ctx.session.current().appendState('model', { provider, model, effort })
        lastSelected = { provider, model, effort }
        ctx.emit('dsc/changed')
      },
      parseModelRef(ref) {
        // 长端点名优先：「command/deepseek/deepseek-v4.1-flash」必须命中 command，
        // 而不是被前缀更短的「deepseek/」抢走（那会把模型名连斜杠一起切碎）。
        const names = Object.keys(config.providers ?? {}).sort((a, b) => b.length - a.length)
        for (const name of names) {
          if (ref.startsWith(`${name}/`)) return { provider: name, model: ref.slice(name.length + 1) }
        }
        return { provider: effectiveOf(ctx.session.current()).provider, model: ref }
      },
      listModels(): ModelChoiceView[] {
        const choices: ModelChoiceView[] = []
        for (const provider of Object.values(config.providers)) {
          for (const model of provider.models) {
            const extra = model.modalities.filter((modality: Modality) => modality !== 'text')
            choices.push({
              value: `${provider.name}/${model.id}`,
              provider: provider.name,
              // 一级菜单按显示名画（用户填了 `displayName` 就用它，没填等于端点名）；
              // 二级列表里仍按模型「自己的」id 画，不替它加前缀。
              providerDisplayName: provider.displayName === '' ? provider.name : provider.displayName,
              model: model.id,
              description: [
                provider.displayName,
                `${Math.round(model.contextWindow / 1000)}k 上下文`,
                extra.length > 0 ? extra.map((modality) => (modality === 'image' ? '照片' : '视频')).join('·') : '',
                model.thinkingLevels.length > 0 ? `思考 ${model.thinkingLevels.length} 档` : '无思考档位',
              ]
                .filter((part: string) => part !== '')
                .join(' · '),
              contextWindow: model.contextWindow,
              thinkingLevels: model.thinkingLevels,
              modalities: model.modalities,
            })
          }
        }
        return choices
      },
    }

    ctx.provide('llm', service)
  },
}
