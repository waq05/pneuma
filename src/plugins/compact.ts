/**
 * compact 插件：provide `compact` 服务（自动压缩检查 + /compact 手动压缩 + 原样带过去的文本登记）。
 * 逻辑迁自 v2 adapter/core-runtime 的 autoCompact 段与 /compact 命令分支；
 * 结果提示统一经 dsc/notice 事件，注册 /compact 命令进 commands 注册表。
 * 真正压出结果的那条提示带 `'compaction'` 类别：transcript 据此给条目打压缩标记，
 * 轨迹页才能把「压缩历史」画成独立区段；失败与「无需压缩」的提示不带这个类别。
 *
 * 「哪些内容不许被摘要模型改写」由功能点自己登记（`registerCarry`）：任务清单与会话目标
 * 各登记一段文本，这个插件因此不认识任何具体功能。
 *
 * 摘要调用复用主对话前缀（2026-10-03）：系统提示词取自 prompt 服务、工具目录取自 tools 服务，
 * 摘要请求因此是上一次真实请求的前缀扩展，命中服务端 KV 缓存（见 core/compact.ts 的 context 参数）。
 *
 * 九个可调值（保留条数、保留尾部的窗口占比、自动压缩触发线、安全余量、压一次不够时最多再压几次、
 * 锚点索引字符预算、用户原话字符预算、read-state 文件数、read-state 字符预算）读自己的插件配置，
 * 并以设置分区的面目交给界面；保存后本插件立刻重读，下一次压缩就用新值。
 *
 * @module dsc/plugins/compact
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { compactSession, DEFAULT_KEEP_RECENT, DEFAULT_PRUNE_OPTIONS, estimateTokens } from '../core/compact.js'
import { estimateTextTokens } from '../core/token-estimate.js'
import type { CompactLimits, PruneOptions } from '../core/compact.js'
import type { ToolSchema } from '../core/llm.js'
import { readSpillConfig } from '../core/spill.js'
import { DEFAULT_ANCHOR_BUDGET_CHARS, DEFAULT_READ_STATE_BUDGET_CHARS, DEFAULT_READ_STATE_FILES, DEFAULT_USER_QUOTE_BUDGET_CHARS } from '../core/compact-anchors.js'
import { errText } from '../adapter/transcript.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { Session } from '../core/session.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { CompactService, SettingsSectionSpec } from '../services/types.js'
import { clampInt as clamp } from '../core/clamp.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'compact'

/** 压缩的可调值。 */
interface CompactConfig {
  /** 折进摘要之后原样保留的最近消息条数。 */
  keepRecent: number
  /** 估算用量超过模型上下文窗口的这个百分比就自动压缩。 */
  autoCompactPercent: number
  /**
   * 上下文窗口里给「输出预留之外」再留多少 token 的安全余量（绝对值）。
   * 0 = 自动：按窗口的 6.4% 算，封顶 65536；正数则直接用这个值。
   */
  headroomTokens: number
  /** 一次自动压缩没压到阈值以下时，最多再补压几次（0 = 只压一次）。 */
  compactionRetries: number
  /**
   * 摘要之外原样保留的最近消息，按模型上下文窗口的这个百分比折算成 token 预算。
   *
   * 为什么不能只看条数：一条工具结果就可能几十万字符，固定 20 条在那种会话里
   * 等于没压——压完还在阈值之上，白丢一次摘要调用。
   */
  retainPercent: number
  /** 摘要里机械抽取的锚点索引占多少字符。 */
  anchorBudgetChars: number
  /** 摘要里逐字引用的用户原话占多少字符。 */
  userQuoteBudgetChars: number
  /** 摘要里 read-state（压前读过的文件与行范围）最多列几个文件。 */
  readStateFiles: number
  /** read-state 段的字符预算。 */
  readStateChars: number
}

const DEFAULTS: CompactConfig = {
  keepRecent: DEFAULT_KEEP_RECENT,
  autoCompactPercent: 80,
  headroomTokens: 0,
  compactionRetries: 1,
  retainPercent: 16,
  anchorBudgetChars: DEFAULT_ANCHOR_BUDGET_CHARS,
  userQuoteBudgetChars: DEFAULT_USER_QUOTE_BUDGET_CHARS,
  readStateFiles: DEFAULT_READ_STATE_FILES,
  readStateChars: DEFAULT_READ_STATE_BUDGET_CHARS,
}

/** 两个字符预算的取值区间：低于下限抽不出几条，高于上限摘要本身就没地方放了。 */
const ANCHOR_BUDGET_RANGE = { min: 1000, max: 20000 }
const USER_QUOTE_BUDGET_RANGE = { min: 1000, max: 40000 }
/** read-state 文件数上限的区间：0 = 不产出 read-state（想纯省 token 的用户可以关掉）。 */
const READ_STATE_FILES_RANGE = { min: 0, max: 20 }
/** read-state 字符预算的区间（默认 1500，压得很紧）。 */
const READ_STATE_BUDGET_RANGE = { min: 200, max: 10000 }
/**
 * 安全余量的区间：0 = 自动（窗口的 6.4%，封顶 65536）。
 * 上限给到 131072：再大的窗口配再大的余量也够用了，填得比窗口还大等于永远触发压缩。
 */
const HEADROOM_RANGE = { min: 0, max: 131072 }
/** 补压次数的区间：0 = 只压一次（手动 `/compact` 就是这条口径），最多补 3 次。 */
const COMPACTION_RETRIES_RANGE = { min: 0, max: 3 }
/**
 * 尾部保留占比的区间（百分比）。
 * 低于 5% 等于几乎不留给下一个自己；高于 40% 时压完留下的比折掉的还多，压缩没意义。
 * 缺省 16%：dsh 的 retainRatio 就是这个数（按它那边 1M 窗口留约 16 万 token）。
 */
const RETAIN_PERCENT_RANGE = { min: 5, max: 40 }

/**
 * 从插件配置取这些可调值，并把区间外的值夹回来。
 * @param passed - 装配时传进来的配置（内核挂载时的第二参数）；没给就读磁盘。
 */
function readConfig(passed?: unknown): CompactConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    // 少于 5 条等于没给下一个自己留上下文，多于 200 条基本压不出空间。
    keepRecent: clamp(raw.keepRecent, 5, 200, DEFAULTS.keepRecent),
    // 低于 50% 会在干活时频繁打断，高于 95% 等于等模型报错才压。
    autoCompactPercent: clamp(raw.autoCompactPercent, 50, 95, DEFAULTS.autoCompactPercent),
    headroomTokens: clamp(raw.headroomTokens, HEADROOM_RANGE.min, HEADROOM_RANGE.max, DEFAULTS.headroomTokens),
    compactionRetries: clamp(
      raw.compactionRetries,
      COMPACTION_RETRIES_RANGE.min,
      COMPACTION_RETRIES_RANGE.max,
      DEFAULTS.compactionRetries,
    ),
    retainPercent: clamp(raw.retainPercent, RETAIN_PERCENT_RANGE.min, RETAIN_PERCENT_RANGE.max, DEFAULTS.retainPercent),
    anchorBudgetChars: clamp(
      raw.anchorBudgetChars,
      ANCHOR_BUDGET_RANGE.min,
      ANCHOR_BUDGET_RANGE.max,
      DEFAULTS.anchorBudgetChars,
    ),
    userQuoteBudgetChars: clamp(
      raw.userQuoteBudgetChars,
      USER_QUOTE_BUDGET_RANGE.min,
      USER_QUOTE_BUDGET_RANGE.max,
      DEFAULTS.userQuoteBudgetChars,
    ),
    readStateFiles: clamp(
      raw.readStateFiles,
      READ_STATE_FILES_RANGE.min,
      READ_STATE_FILES_RANGE.max,
      DEFAULTS.readStateFiles,
    ),
    readStateChars: clamp(
      raw.readStateChars,
      READ_STATE_BUDGET_RANGE.min,
      READ_STATE_BUDGET_RANGE.max,
      DEFAULTS.readStateChars,
    ),
  }
}

export const compactPlugin: Plugin.Object = {
  name: 'compact',
  inject: ['llm', 'session', 'commands', 'settings', 'prompt', 'tools'],
  provide: 'compact',
  apply(ctx) {
    let config = readConfig()
    /** 经 llm 服务适配器表派发的流式请求（压缩摘要用的模型调用从这条缝走）。 */
    const stream = ctx.llm.stream.bind(ctx.llm)
    /** 写盘并立刻重读：下一次压缩就用新值，不必重启宿主。 */
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig()
    }
    /**
     * 当前配置里的压缩上限，现读 config，保存后下一压就用新值。
     *
     * 需要目标会话：尾部 token 预算按**这条会话**的模型窗口折算（后台会话按它自己的路由，
     * 不看用户正在看的那条）。窗口拿不到时退回纯条数口径，不猜一个数。
     *
     * @param target - 要压的会话
     * @param retain - 是否按窗口占比留尾巴。自动阈值压缩留（省下的空间还得放得下这一轮），
     *   手动 `/compact` 与爆窗强压**不留**：这两条路的目的是尽快腾出空间，只保留条数下限。
     *   不留这一档不是省事：100 万窗口的模型上，16% 的尾巴就是 16 万 token，短历史手动压
     *   会因为「尾巴装得下整段」直接判成没得压——用户看到的是一句「历史不长，无需压缩」。
     */
    const limits = (target: Session, retain = true): CompactLimits => {
      const window = ctx.llm.contextWindowOf(target)
      const retainTokens = retain ? Math.floor(window * (config.retainPercent / 100)) : 0
      return {
        keepRecent: config.keepRecent,
        ...(retainTokens > 0 ? { retainTokens } : {}),
        anchorChars: config.anchorBudgetChars,
        userQuoteChars: config.userQuoteBudgetChars,
        readStateFiles: config.readStateFiles,
        readStateChars: config.readStateChars,
      }
    }
    /** T19 前置裁剪口径：spill 配置复用 spill 插件的那份（目录与上限一致，模型可照常 read）。 */
    const prune = (): PruneOptions => ({
      ...DEFAULT_PRUNE_OPTIONS,
      // 模型不收图时区域里的图全部卸载：摘要调用复用主对话前缀、发的是真实消息，
      // 留下 image_url 会被端点直接 400（以前转写成纯文本，没这个问题）。
      imageBudget: ctx.llm.inputModalities.includes('image') ? DEFAULT_PRUNE_OPTIONS.imageBudget : 0,
      spill: readSpillConfig(resolvePluginConfig('spill')),
    })

    /**
     * 复用主对话前缀的两样东西（对齐 dsh summarizer 的 warm-prefix 设计）：
     * 与主对话一字不差的系统提示词 + 主对话那份工具目录，让摘要调用成为
     * 上一次真实请求的严格前缀扩展，服务端缓存能一直命中到压缩指令前一个字。
     * 0.6.48：按目标会话的 cwd 拼（后台常驻 agent 的压缩不能再看「当前查看的会话」）。
     */
    const requestContext = (target: Session): { system: string; tools: readonly ToolSchema[] } => ({
      system: ctx.prompt.systemPrompt(target.meta.cwd, { sessionId: target.meta.id, cwd: target.meta.cwd }),
      tools: ctx.tools.visible({ sessionId: target.meta.id }).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    })

    /** 摘要之外必须原样带过去的文本：由各功能点登记，按登记顺序拼接。 */
    const carries: Array<() => string> = []
    /** 拼出压缩时要原样附在摘要后面的文本。 */
    const carry = (): string =>
      carries
        .map((contribute) => contribute())
        .filter((part) => part !== '')
        .join('\n\n')

    /**
     * 包住一次压缩：开始与结束各广播一次状态，界面据此画 / 收起活动行。
     *
     * 为什么用 finally：摘要调用会失败（端点 500、用户打断），漏掉结束信号的话
     * 界面那条「正在压缩」会一直转下去，比不显示更糟。
     *
     * @param target - 这次压缩的目标会话（后台会话的压缩不该画到当前视图里）。
     * @param run - 真正干活的那段。
     */
    const whileCompacting = async <T>(target: Session, run: () => Promise<T>): Promise<T> => {
      ctx.emit('dsc/compacting', true, target.filePath)
      try {
        return await run()
      } finally {
        ctx.emit('dsc/compacting', false, target.filePath)
      }
    }

    /**
     * 压完之后按新历史重算一次上下文占用（估算）。
     *
     * 为什么必须给一个数：`contextUsed` 的权威读数来自模型回来的用量，而压缩本身
     * 不发对话请求——不补这一下，底部的百分比会一直停在压缩前（用户以为没压）。
     * 口径与请求组装一致：对话消息 + 系统提示词 + 工具目录，下一次真实请求再校正。
     */
    const reportContextUsed = (target: Session): void => {
      const { system, tools } = requestContext(target)
      const used =
        estimateTokens(target.messages) + estimateTextTokens(system) + estimateTextTokens(JSON.stringify(tools))
      ctx.emit('dsc/context-used', Math.round(used), target.filePath)
    }

    // T41 /compact 运行守卫：回合跑着的时候手动压缩，摘要落库会和进行中的工具
    // 落库交错（jsonl 里 summary 插在 tool 记录中间，重放口径会乱）。数着回合。
    // 0.6.48 起按会话计数：后台常驻 agent 的回合不该挡住当前会话的 /compact
    //（不同文件的落库互不交错），只有同一会话的回合才互斥。
    const runningTurnsBySid = new Map<string, number>()
    ctx.on('dsc/turn-start', (signal) => {
      const sid = signal?.sessionId ?? ctx.session.current().meta.id
      runningTurnsBySid.set(sid, (runningTurnsBySid.get(sid) ?? 0) + 1)
    })
    ctx.on('dsc/turn-end', (reason, signal) => {
      void reason
      const sid = signal?.sessionId ?? ctx.session.current().meta.id
      const count = runningTurnsBySid.get(sid) ?? 0
      if (count <= 1) runningTurnsBySid.delete(sid)
      else runningTurnsBySid.set(sid, count - 1)
    })

    /**
     * 自动压缩的触发阈值（token）。
     *
     * 口径对齐 dsh：阈值 = min(窗口 × 触发比例, 窗口 − 输出预留 − 安全余量)。
     * 为什么要减输出预留与安全余量：一次请求最多吐 maxTokens，这部分窗口不能拿去装历史；
     * 余量留给「系统提示词 + 工具目录 + 本轮新增消息」的浮动空间，压到贴边的话
     * 下一轮请求立刻又超。
     * 余量为什么按窗口 6.4% 算并封顶 65536：dsh 那里是写死的 65536（按 1M 窗口设计），
     * 照搬到 128k 窗口的模型上，阈值会掉到窗口的一半以下（131072 − 8192 输出 − 65536
     * 只剩 57344，约 44%），活干到一半就被压一次。按窗口缩放才跟着窗口走。
     *
     * @param target - 要判定的会话（阈值跟这个会话的模型路由走，不看「当前查看的会话」）。
     */
    const thresholdOf = (target: Session): number => {
      const window = ctx.llm.contextWindowOf(target)
      const reserve = ctx.llm.routeForSession(target).maxTokens ?? 0
      const headroom =
        config.headroomTokens > 0 ? config.headroomTokens : Math.min(65_536, Math.floor(window * 0.064))
      const byRatio = Math.floor(window * (config.autoCompactPercent / 100))
      // 下限 1024：窗口配得很小、或 maxTokens 接近窗口时，阈值不能变成 0 甚至负数，
      // 否则每次请求都判成「超了」，压缩会连着空转（每次都是 noop）。
      return Math.max(1024, Math.min(byRatio, window - reserve - headroom))
    }

    const service: CompactService = {
      registerCarry(contribute) {
        carries.push(contribute)
        return () => {
          const at = carries.indexOf(contribute)
          if (at >= 0) carries.splice(at, 1)
        }
      },
      /** 当前模型路由 + 配置里的自动压缩触发线（缺省 min(窗口的 80%, 窗口 − 输出预留 − 余量)）。 */
      async check(signal, target) {
        const session = target ?? ctx.session.current()
        const threshold = thresholdOf(session)
        let used = estimateTokens(session.messages)
        if (used <= threshold) return
        // 压完复量、还超就再压（对齐 dsh 的 compactionRetries）：一次压缩的收缩率
        // 跟摘要模型当时的输出质量有关，偶尔一次压不到线以下；补压一两次比直接放弃好。
        // 手动 /compact 与 forceCompact 不循环——手动只压一次，爆窗重试也只看这一次的成败。
        //
        // 补压这一刀必须绕开「历史太短」守卫（force）：第一次压完只剩摘要 + 条数下限那几条，
        // 正常判定会认为没得压、直接 noop，可恰恰是「尾巴本身就超预算」才需要再压。
        // 带 force 之后能折进上一份摘要本身，尾部按 token 预算重新收紧——这才是补压的意义。
        let attempts = 0
        for (let attempt = 0; attempt <= config.compactionRetries; attempt += 1) {
          const result = await whileCompacting(session, () =>
            compactSession(
              session,
              ctx.llm.routeForSession(session),
              stream,
              signal ?? new AbortController().signal,
              carry(),
              limits(session),
              attempt > 0 ? true : undefined,
              prune(),
              requestContext(session),
            ),
          )
          // 一轮都没压成（历史太短 / 整段都是工具结果）就别再试：再压还是同一个结果
          if (result.outcome !== 'compacted') break
          attempts += 1
          // 复量按新历史算：摘要 + 尾巴的实际估算（dsh 在同一处也用 token 计量器重量）
          used = estimateTokens(session.messages)
          if (used <= threshold) break
        }
        const compacted = attempts > 0
        // 只有真压出结果才打压缩标记：noop 时这条提示照旧发（文案不动），
        // 但轨迹页不该凭空多出一段「压缩历史」
        // 带会话归属（0.6.68）：后台会话自动压缩时，这句提示不该冒到用户正在看的视图里。
        if (!compacted) {
          ctx.emit('dsc/notice', '上下文接近模型上限，已自动压缩历史', undefined, session.filePath)
          return
        }
        if (used <= threshold) {
          ctx.emit('dsc/notice', '上下文接近模型上限，已自动压缩历史', 'compaction', session.filePath)
        } else {
          // 补压用完仍在阈值之上：说清「还超多少、压了几次」，用户才知道该不该手动收紧口径
          ctx.emit(
            'dsc/notice',
            `上下文仍接近模型上限（估算 ${used} tokens ≥ 阈值 ${threshold}），已连续压缩 ${attempts} 次`,
            'compaction',
            session.filePath,
          )
        }
        ctx.emit('dsc/compacted')
        reportContextUsed(session)
      },

      /** 请求已经因爆窗失败，强制压一次（2026-09-29）：压出空间返回 true，循环方重试请求。 */
      async forceCompact(signal, target) {
        const session = target ?? ctx.session.current()
        // 先看微压缩（2026-11-02）：旧工具结果换成占位符是**投影**，不落历史，
        // 此时真正发出去的请求本来就是清理过的。若清理后已经装进窗口，就没必要
        // 牺牲历史去压摘要——白白丢掉原文，还可能把工具配对切坏。直接让调用方重试。
        const micro = ctx.get('microcompact')
        if (micro !== undefined && micro.projectedTokens(session.messages) < ctx.llm.contextWindowOf(session)) {
          ctx.emit('dsc/notice', '上下文超出模型窗口，但旧工具结果清理后已在窗口内，直接重试', undefined, session.filePath)
          return false
        }
        const result = await whileCompacting(session, () =>
          compactSession(
            session,
            ctx.llm.routeForSession(session),
            stream,
            signal ?? new AbortController().signal,
            carry(),
            limits(session, false),
            true,
            prune(),
            requestContext(session),
          ),
        )
        if (result.outcome === 'compacted') {
          // 打上 'compaction' 类别：transcript 据此把这条通知标成压缩落点（轨迹页切区段）
          ctx.emit('dsc/notice', '上下文超出模型窗口：已自动压缩历史并重试', 'compaction', session.filePath)
          ctx.emit('dsc/compacted')
          reportContextUsed(session)
          return true
        }
        return false
      },

      /** 当前压缩口径（/status 的数字与 check() 同源）。 */
      describe() {
        return { autoCompactPercent: config.autoCompactPercent, keepRecent: config.keepRecent }
      },

      async run() {
        // T41：回合运行中不许手动压——等这轮结束，或者先打断再压。
        // 0.6.48 起只看当前会话自己的回合数（后台 agent 的回合互不交错）。
        const sid = ctx.session.current().meta.id
        if ((runningTurnsBySid.get(sid) ?? 0) > 0) {
          ctx.emit('dsc/notice', '回合还在跑，等这轮结束（或先打断）再压缩：中途压会让摘要与工具结果的落库交错')
          ctx.emit('dsc/changed')
          return
        }
        try {
          const target = ctx.session.current()
          const result = await whileCompacting(target, () =>
            compactSession(
              target,
              ctx.llm.routeForSession(target),
              stream,
              new AbortController().signal,
              carry(),
              limits(target, false),
              undefined,
              prune(),
              requestContext(target),
            ),
          )
          const compacted = result.outcome === 'compacted'
          ctx.emit(
            'dsc/notice',
            compacted ? '上下文已压缩（任务清单与目标原样保留）' : '历史不长，无需压缩',
            compacted ? 'compaction' : undefined,
          )
          // 压完等于换了半本历史：加载时冻结的东西该重算了（记忆栏就是这么挂上去的）
          if (compacted) {
            ctx.emit('dsc/compacted')
            reportContextUsed(target)
          }
        } catch (error) {
          ctx.emit('dsc/notice', `压缩失败：${errText(error)}`)
        }
        ctx.emit('dsc/changed')
      },
    }

    ctx.commands.register(
      { name: 'compact', args: '', description: '压缩上下文' },
      ({ args, runtime, ui }) => {
        // 与 dsh 同一条口径：这条命令不吃参数，多打的字是被截断的误操作，直说用法
        if (args.length > 0) {
          ui.notice('用法：/compact（不带参数）')
          return
        }
        void runtime.compact()
      },
    )
    ctx.provide('compact', service)

    const fields: SettingsField[] = [
      {
        type: 'number',
        key: 'keepRecent',
        label: '压缩后保留最近多少条',
        min: 5,
        max: 200,
        step: 5,
        help: '更早的历史折进摘要，这些条原样留着：数值越大，压缩后模型能看到的原文越多，省出来的上下文越少。',
      },
      {
        type: 'number',
        key: 'autoCompactPercent',
        label: '自动压缩触发线（占模型上下文窗口的百分比）',
        min: 50,
        max: 95,
        step: 5,
        help: '估算用量超过这个比例就自动压缩；/compact 手动压缩不受这条线限制。阈值还会被「窗口减去输出预留与安全余量」压低，取两者中较小的那个。',
      },
      {
        type: 'number',
        key: 'headroomTokens',
        label: '安全余量（token，0 = 按窗口自动）',
        min: HEADROOM_RANGE.min,
        max: HEADROOM_RANGE.max,
        step: 1024,
        help: '压到多早才开始动手：阈值会给输出预留（模型的 maxTokens 上限）再加这么多 token 的安全余量。0 = 自动（窗口的 6.4%，最多 65536）。调大 = 更早压缩、留给这一轮的空间更多；调小 = 压得更晚、更省历史。',
      },
      {
        type: 'number',
        key: 'compactionRetries',
        label: '压一次还不够时最多再压几次',
        min: COMPACTION_RETRIES_RANGE.min,
        max: COMPACTION_RETRIES_RANGE.max,
        step: 1,
        help: '自动压缩后若估算用量仍在阈值之上，会再压一次，最多补这么多次。代价：每多压一次就多一次摘要模型调用（要等它写完才发真实请求），并且每次都把更早的原文折成摘要，细节会再丢一层。0 = 只压一次。',
      },
      {
        type: 'number',
        key: 'retainPercent',
        label: '保留尾部（占模型窗口的百分比）',
        min: RETAIN_PERCENT_RANGE.min,
        max: RETAIN_PERCENT_RANGE.max,
        step: 1,
        help: '压缩后原样保留最近这些对话，按模型窗口折算成 token 预算，再退到「工具调用与结果不拆开」的安全边界；「压缩后保留最近多少条」仍是条数下限。为什么按 token 算：一条工具结果就可能几十万字符，只按条数留会在这种会话里压不动。调大 = 原文留得更多、省出的空间更少。',
      },
      {
        type: 'number',
        key: 'anchorBudgetChars',
        label: '锚点索引字符预算',
        min: ANCHOR_BUDGET_RANGE.min,
        max: ANCHOR_BUDGET_RANGE.max,
        step: 500,
        help: '摘要里附一份正则抽出来的 PR 号 / SHA / 文件路径 / 报错原文清单，这些标识符不经模型改写。数值越大列得越全，摘要占的上下文越多。',
      },
      {
        type: 'number',
        key: 'userQuoteBudgetChars',
        label: '用户原话引用字符预算',
        min: USER_QUOTE_BUDGET_RANGE.min,
        max: USER_QUOTE_BUDGET_RANGE.max,
        step: 500,
        help: '压缩会把最近若干条真实用户消息逐字抄进摘要，模型改写过的转述可能与原话走样。数值越大抄得越多，摘要占的上下文越多。',
      },
      {
        type: 'number',
        key: 'readStateFiles',
        label: 'read-state 文件数',
        min: READ_STATE_FILES_RANGE.min,
        max: READ_STATE_FILES_RANGE.max,
        step: 1,
        help: '摘要里附一份「压缩前最后读过哪些文件、读到哪一段」的清单，接手时不用重读。这里是最多列几个文件（0 = 不产出这段）。',
      },
      {
        type: 'number',
        key: 'readStateChars',
        label: 'read-state 字符预算',
        min: READ_STATE_BUDGET_RANGE.min,
        max: READ_STATE_BUDGET_RANGE.max,
        step: 100,
        help: 'read-state 清单整段的字符上限；装不下的文件丢掉并补省略标记。清单只带路径与行范围，不带文件内容。',
      },
    ]

    const section: SettingsSectionSpec = {
      id: 'compact',
      title: '上下文压缩',
      subtitle: '历史太长时把更早的部分折成一条摘要',
      order: 35,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig()
        return {
          keepRecent: config.keepRecent,
          autoCompactPercent: config.autoCompactPercent,
          headroomTokens: config.headroomTokens,
          compactionRetries: config.compactionRetries,
          retainPercent: config.retainPercent,
          anchorBudgetChars: config.anchorBudgetChars,
          userQuoteBudgetChars: config.userQuoteBudgetChars,
          readStateFiles: config.readStateFiles,
          readStateChars: config.readStateChars,
        }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        const num = Number(value)
        if (!Number.isFinite(num)) return '这里要填一个数字'
        if (key === 'keepRecent') applyConfig({ keepRecent: num })
        else if (key === 'autoCompactPercent') applyConfig({ autoCompactPercent: num })
        else if (key === 'headroomTokens') applyConfig({ headroomTokens: num })
        else if (key === 'compactionRetries') applyConfig({ compactionRetries: num })
        else if (key === 'retainPercent') applyConfig({ retainPercent: num })
        else if (key === 'anchorBudgetChars') applyConfig({ anchorBudgetChars: num })
        else if (key === 'userQuoteBudgetChars') applyConfig({ userQuoteBudgetChars: num })
        else if (key === 'readStateFiles') applyConfig({ readStateFiles: num })
        else if (key === 'readStateChars') applyConfig({ readStateChars: num })
        else return `这个分区没有这项：${key}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => offSection()
  },
}
