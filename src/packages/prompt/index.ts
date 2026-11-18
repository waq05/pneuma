/**
 * prompt 插件：provide `prompt` 服务——系统提示词的段落注册表与「模型可见投影」链。
 *
 * 这个插件是内核扩展点，也是「这一轮到底发什么提示词」这件事的唯一归属：
 *   - 各功能点往这里登记自己那一段话（模式条款、外部插件的附加说明……），
 *     段落顺序由各段自己声明，稳定内容往前放、易变内容往后放（服务端提示缓存只认前缀）；
 *   - 要改写发给模型那份消息的功能点登记**命名纯投影**（registerProjection），
 *     内核的 fold-system / env-facts / image-diet / drop-images 四条护栏与插件投影走同一条按次序的管道；
 *   - 环境事实（env-facts 投影，order 600）：日期/分支/脏标不再进系统提示词，作为
 *     请求末尾的 user 快照附上。平台（Windows→PowerShell）只有这一个载体，所以缺省
 *     每轮都发；想要「同一份环境不重复烧 token」的人把 `envRefreshMs` 设成非 0 即可
 *     ——缓存只认字节前缀，易变内容不能放头部（2026-10-03 / 2026-10-15）；
 *   - 本插件自己兜底一件事：指令文件的字符预算（`prompt.instructionBudget`）。
 *
 * 「模型看见什么」可以从会话日志完整重建：日志存原文，投影链是命名且可复算的
 * （dsh 的 Model-visible ⟺ logged，个人版达成方式见 registerProjection 的注释）。
 *
 * 注册都返回退订函数，插件卸载后系统提示里不会留下半句话。
 *
 * @module dsc/plugins/prompt
 */
import { createHash } from 'node:crypto'
import type { Plugin } from '@deepseek-ai/cordis'
import { errText } from '@pneuma/runtime/adapter/transcript.js'
import { dropImageParts, foldSystemMessages, type ChatMessage } from '@pneuma/runtime/core/llm.js'
import { IMAGE_DIET_BATCH_MIN_IMAGES, pruneImagesBatch, readImageDietConfig } from '@pneuma/runtime/core/image-diet.js'
import { buildSystemPromptParts, DEFAULT_INSTRUCTION_BUDGET, environmentText, type PromptContribution } from '@pneuma/session-core/prompt.js'
import { InjectionReportLedger } from '@pneuma/runtime/core/context-injection-report.js'
import { DEFAULT_TOOL_RESULT_PRUNE, pruneToolResultsBatch, TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS } from './tool-result-prune.js'
import { resolvePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { CONTEXT_INJECTION_KINDS, contextInjectionPreview, type PromptSectionView } from '@pneuma/runtime/contract.js'
import type { Session } from '@pneuma/runtime/core/session.js'
import type { AgentScope, ContextInjectionReporter, PromptService } from '@pneuma/runtime/services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'prompt'

/** 图片卸载投影的配置键：投影登记在本文件，配置界面在 plugins/image-diet（同一个键）。 */
const IMAGE_DIET_CONFIG_KEY = 'image-diet'

/** 图像没能随请求发送时留在正文里的那句话：模型看得见它，才知道自己手上没图。 */
const NO_IMAGE_NOTE = '（当前模型没有声明照片输入能力，图像没有随请求发送）'

/** 一条「模型可见投影」：对发给模型的消息做一次纯函数改写。 */
type Projection = {
  order: number
  fn: (messages: ChatMessage[], session?: Session, report?: ContextInjectionReporter) => ChatMessage[]
}

/** 内置投影占用的名字：协议护栏不许被外部插件顶掉，同名注册直接报错。 */
const RESERVED_PROJECTIONS = new Set(['fold-system', 'drop-images'])

/**
 * 取指令文件的预算：夹在 4k 到 200k 之间。单位是**字符**（不是字节；与 codex/dsh/ZCode
 * 的字节口径怎么换算，见 packages/session-core/prompt.ts 的 DEFAULT_INSTRUCTION_BUDGET 注释）。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readBudget(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.instructionBudget)
  if (!Number.isFinite(num)) return DEFAULT_INSTRUCTION_BUDGET
  return Math.min(Math.max(Math.round(num), 4_000), 200_000)
}

/**
 * 环境快照刷新下限的缺省值（毫秒）：**0 = 每轮都发**（缺省）。见 {@link readEnvRefreshMs}。
 */
const DEFAULT_ENV_FACTS_REFRESH_MS = 0

/**
 * 取环境快照的刷新下限（毫秒，可配 `prompt.envRefreshMs`，0 = 每轮都发）。
 *
 * **缺省是 0（每轮都发）**，不是 dsh 那个 10 分钟——理由比「省几十个 token」硬：
 * 「平台：Windows（bash 工具跑的是 PowerShell）」这条事实**只有 env 快照一个载体**
 * （packages/session-core/prompt.ts 的 IDENTITY/BEHAVIOR/TOOL_RULES 里没有它，dsh 那边也没有平台注入）。
 * 一旦按「没变就不发」跳过，被跳过的那几轮请求里模型既没有环境、又很可能写出 bash-ism
 * （dsc 主力平台就是 Windows）。省下的那点 token 明显不划算，所以缺省保持每轮都发；
 * 这条闸门留给想要「同一份环境不重复烧 token」的人自己打开（设一个非 0 的毫秒数）。
 * 语义：`now - last.at < refreshMs` 为真才跳过；refreshMs=0 时右边是 0，而 `now - last.at`
 * 单调不小于 0，所以恒不跳过 = 每轮都发。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readEnvRefreshMs(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.envRefreshMs)
  if (!Number.isFinite(num) || num < 0) return DEFAULT_ENV_FACTS_REFRESH_MS
  return Math.round(num)
}

/**
 * 批量落点状态：key 列表 + 做决定时的消息条数；hash 用于「没变就不写」（照 env-facts 的 noteEnvFacts）。
 *
 * 为什么还要存 `length`（2026-11-18 复核补）：只认「该 hash 本轮只出现一次」的兜底，
 * 无法区分「压缩把旧消息挪了位」与「压缩把旧消息整条删了、用户又贴回同一张图」。
 * 后者若还拿旧决定认，就会把本轮最新、本该按预算保留的那张图误卸。记下做决定时的
 * 消息条数后，投影一看到 `messages.length < length`（历史被压缩/回退变短）就把整个
 * 粘性集合作废、按空集合重新攒批——压缩本身已经断过一次前缀，这里只多一次恢复。
 */
type StickyBatchState = { hash: string; length: number; keys: string[] }

declare module '@pneuma/runtime/core/session.js' {
  interface SessionStateMap {
    /** 已经切过的工具结果 key（key 口径见 packages/prompt/tool-result-prune.ts 的文件头）。 */
    'tool-result-prune-batch': StickyBatchState
    /** 已经卸掉的图片位置 key（口径见 core/image-diet.ts 的文件头）。 */
    'image-diet-batch': StickyBatchState
  }
}

/**
 * 把「已经切/卸过的 key 集合」落成会话状态：集合变了才追加一条，重放会话时最后一条生效。
 *
 * 为什么落会话状态而不是放进程内存（P2a 返工，2026-11-18）：投影结果必须能由
 * 「日志原文 + 命名投影」复算——换个进程、拿同一份日志重放，输出要逐字节相同。
 * 存的是排序后的 key 列表（位置 key 只增不减），hash 去重避免每轮往日志里写一条。
 *
 * 「可复算」的精确含义：复算的是**当前请求的最新一份**。审计更早的历史请求时，
 * 拿到的状态是那之后各批的并集（只增不减），不是当时那一份；要逐帧复算得按日志
 * 重放一遍请求序列。
 *
 * @param length 做决定时的消息条数；历史之后变短（压缩/回退）就据此作废旧集合。
 */
function noteStickyBatch(
  owner: Session,
  id: 'tool-result-prune-batch' | 'image-diet-batch',
  keys: ReadonlySet<string>,
  length: number,
): void {
  const list = [...keys].sort()
  const hash = createHash('sha256').update(`${String(length)}\n${list.join('\n')}`).digest('hex').slice(0, 16)
  if (owner.state(id)?.hash === hash) return
  owner.appendState(id, { hash, length, keys: list })
}

export const promptPlugin: Plugin.Object = {
  name: 'prompt',
  inject: ['llm', 'skills', 'session'],
  provide: 'prompt',
  apply(ctx, passed) {
    let budget = readBudget(passed)
    /** 附加提示段：id → {顺序, 取文本, 归并目标}。同名后注册者顶掉先注册的，退订只撤自己那一份。 */
    const sections = new Map<
      string,
      { order: number; text: (scope?: AgentScope) => string; block?: 'agents-md' }
    >()
    /**
     * 骨架过滤器表：id → 取舍函数。按登记顺序串起来应用（前一个的输出是后一个的输入）。
     * 模式（presets 插件）登记的那一位把「做事方式」「工具规范」这类段摘掉，
     * 极简档因此只剩一段固定提示词；一个都不登记时提示词逐字节不变。
     */
    const skeletonFilters = new Map<
      string,
      (ids: readonly string[], scope?: AgentScope) => readonly string[]
    >()
    /**
     * 命名投影表：id → {次序, 改写函数}。内核两条内置投影也在表里，与插件投影
     * 走同一条按次序应用的管道——「日志原文 + 这条链」就是模型看见的内容
     * （dsh Model-visible ⟺ logged 的个人版）。
     */
    const projections = new Map<string, Projection>()

    /**
     * 环境事实片段表：id → 现算文本。它们拼进末尾那条 user 快照（日期 / 平台 / 工作目录同一格）。
     *
     * 为什么要有这一档（2026-10-30）：沙箱档位、当前模式这类**会随用户操作变化**的内容
     * 以前占着系统提示词的位置，切一次权限就把前缀缓存整段打掉。挪到快照之后，前缀稳定，
     * 变化只落在尾巴；模型每轮拿到的仍然是最新的那一份。
     */
    const envFacts = new Map<string, (session?: Session) => string>()

    /**
     * 本次改写所属的会话（0.6.48 常驻多 agent）：env-facts 这类按会话取 cwd/落
     * 状态条目的投影靠它取对归属。rewrite 是纯同步的，调用前后换值即可，
     * 不会串到别的请求；没带（老调用方）就回落当前查看的会话。
     */
    let requestSession: Session

    /** 按次序排好（同次序按 id，稳定），返回投影链。 */
    const projectionChain = (): Array<[string, Projection]> =>
      [...projections.entries()].sort(([aId, a], [bId, b]) =>
        a.order === b.order ? aId.localeCompare(bId) : a.order - b.order,
      )

    // 内置投影一：多条 system 并进头部一条。不少 OpenAI 兼容网关只认「第一条可以是
    // system」，历史中间再冒一条就 400。放在插件投影之后（500）：插件往末尾补的
    // system 话术在这里被并进头部。
    projections.set('fold-system', { order: 500, fn: foldSystemMessages })
    // 内置投影二：环境事实快照（2026-10-03）。日期/分支/脏标这类东西每天都变，
    // 放进系统提示词等于每次变化都重写前缀——服务端前缀缓存从改写点之后整段失效
    // （dsh 的 agent-loop README 把这条规律写得很直白）。改成追加在请求末尾的 user
    // 快照：前缀原样命中，变化只落在尾巴这一点；每次请求都带当前值，模型手里
    // 不会有过期环境。它补的是 user 消息，与 fold-system（只动 system）互不干扰。
    //
    // 「变了才发」的闸门默认是**关**的（`envRefreshMs` 缺省 0 = 每轮都发），原因是
    // 「平台：Windows（bash 工具跑的是 PowerShell）」只有 env 快照这一个载体——跳过一轮
    // 就等于那一轮模型没有平台事实，容易写出 bash-ism。开关留给愿意拿这点风险换 token 的人。
    // 打开后（设一个非 0 毫秒数）的语义（照 dsh time-context 的刷新下限）：
    // 上一次发过的快照文本与这次相同、又没到下限，就整条不发——它落在缓存前缀之外，
    // 但每轮重发就是每轮白烧几十个 token（长会话里是稳定开销）；**首次（含会话刚恢复）
    // 必发、文本变了必发**，到点也重注一次。
    //
    // 打开后的取舍写明（别被 dsh 的字面骗了）：dsh 的快照是 durable 的 user 消息，跳过的
    // 那些轮请求里仍带着上一条；dsc 的快照是**投影注入、不落会话历史**（落盘的只有 hash
    // 去重的 `env-facts` 状态条目），所以「不发」的那一轮请求里确实没有环境快照。要 dsh
    // 那种「模型一直持有最近一次快照」，得把快照落成 durable 消息（改会话日志形状，不在本线）。
    // 上次发过什么按会话记（常驻多 agent 各看各的 cwd），只留内存：进程重启后
    // 一律当「首次」，宁可多发一条，不可让模型拿着过期环境而不自知。
    const envSent = new Map<string, { text: string; at: number }>()
    /**
     * 上报台账：这个会话、这一类注入上一次上报过的正文。
     *
     * 与上面的 `envSent` **分开记**，因为两件事的判据不同（见 core/context-injection-report
     * 的文件头）：`envSent` 回答「这一跳还要不要注入」，本台账回答「这一跳还要不要长卡」。
     * 注入被跳过的那一跳不产生报告，也不该动台账；台账若跟着注入闸一起失效，下一跳就会
     * 把一份其实从没上报过的正文当成「报过了」，卡上从此少一段。
     */
    const envReported = new InjectionReportLedger()
    projections.set('env-facts', {
      order: 600,
      fn: (messages, _session, report) => {
        const session = requestSession
        // 逐片段带名字读：report 要把 mode / sandbox 单独报成一条注入卡，
        // 只剩拼好的整段快照就分不出「这段是谁写的」了。
        const fragments: { id: string; text: string }[] = []
        for (const [id, read] of envFacts) {
          try {
            fragments.push({ id, text: read(session) })
          } catch {
            // 一个片段崩了不该让整份快照消失：跳过它，其余照发
          }
        }
        const snapshot = environmentSnapshot(
          session.meta.cwd,
          fragments.map((fragment) => fragment.text),
        )
        const now = Date.now()
        const last = envSent.get(session.meta.id)
        if (last !== undefined && last.text === snapshot && now - last.at < readEnvRefreshMs(passed)) {
          return messages
        }
        if (envSent.size > 64) envSent.clear() // 会话多了别让这张表无界长
        envSent.set(session.meta.id, { text: snapshot, at: now })
        // 落一条状态（hash 去重，变了才写）：重放会话时最后一条就是模型当时看到的环境
        //（Model-visible ⟺ logged 的环境半边，与 agent 插件的 system-prompt 条目同套做法）。
        noteEnvFacts(session, snapshot)
        // 这一跳**新增**了哪些注入，报给转录层：整段快照报一条，每个片段（mode / sandbox …）
        // 各报一条——界面上一眼能看出「这一跳的上下文里多了哪几样」。只报摘要与字符数，
        // 正文就在下面这条 user 消息里，卡片不重复存。
        //
        // 上报有闸：与上一次上报过的正文逐字相同就不再报（注入照旧，理由见
        // core/context-injection-report 的文件头）。于是环境没变的那几跳界面上不新增卡；
        // 变了一样时只新增「变了的那几样」——不再有「同一份环境重复记 N 行 / 共 N 步」这种
        // 读数。没有录音机的调用方（服务 API 的纯问询）不判也不记账。
        //
        // 注意 loop 的 invariant 二次派生也会带录音机把这条链再跑一遍（内容与刚才那次相同，
        // 通常不会改动台账）。只有两次组装之间环境恰好变了（比如 git 状态在毫秒内翻转），
        // 台账才会先记下一份其实没上报出去的正文——那一份会在卡上缺席，下一份变化仍如实上报。
        if (report !== undefined) {
          const sessionId = session.meta.id
          if (envReported.take(sessionId, CONTEXT_INJECTION_KINDS.envFacts, snapshot)) {
            report({
              kind: CONTEXT_INJECTION_KINDS.envFacts,
              source: 'env-facts',
              where: 'user-tail',
              chars: snapshot.length,
              preview: contextInjectionPreview(snapshot),
            })
          }
          for (const fragment of fragments) {
            // 空片段由台账自己判掉（`shouldReport` 对空白返回 false），这里不另写一条：
            // 台账要把它记成「当前状态」，片段从空重新出现时才不会被误判成「没变」。
            if (!envReported.take(sessionId, fragment.id, fragment.text)) continue
            report({
              kind: fragment.id,
              source: fragment.id,
              where: 'user-tail',
              chars: fragment.text.length,
              preview: contextInjectionPreview(fragment.text),
            })
          }
        }
        return [...messages, { role: 'user', content: snapshot }]
      },
    })
    /**
     * 批量落点状态（P2a）：已切过的工具结果 key / 已卸掉的图片位置 key，都落成**会话状态**
     * 而不是进程内 Map——换进程重放同一份日志时先读回来，投影输出才能逐字节复算
     * （「日志原文 + 命名投影可复算」）。条目名见本文件顶部的 SessionStateMap 声明合并。
     *
     * 连 `length` 一起读回来交给批量函数：`messages.length` 比做决定时短 = 历史被压缩/
     * 回退过，旧集合作废（见 tool-result-prune / image-diet 的 `decidedAtLength` 参数），
     * 否则旧 hash 兜底会把压缩后重发的同一张图误卸。
     */
    const readSticky = (
      owner: Session,
      id: 'tool-result-prune-batch' | 'image-diet-batch',
    ): { keys: ReadonlySet<string>; length: number | undefined } => {
      const stored = owner.state(id)
      const keys = new Set<string>()
      if (Array.isArray(stored?.keys)) for (const key of stored.keys) if (typeof key === 'string' && key !== '') keys.add(key)
      return { keys, length: typeof stored?.length === 'number' ? stored.length : undefined }
    }

    // 内置投影：历史里超长的工具结果只留头尾（2026-10-30，对标 dsh 的
    // compaction-tool-result-pruner）。PTC 模式下 run_code 常把整份文件原文返回，
    // 那些字留在历史里每轮重发——实测一个会话里工具结果合计 43K token。
    //
    // 为什么是「确定性修剪」而不是每轮按当时情况重算：前缀缓存要求逐字节一致。
    // 同一条结果只要越过「最近 4 条」这道线，就永远切成同一段文本；前缀只在它第一次
    // 越线的那一轮失效一次，之后完全稳定。切掉的部分明说省了多少、原文去哪儿找。
    //
    // P2a（2026-11-18）批量化：逐条越线就切 = 每条一次前缀断点。改成按会话攒一批
    // （「粘性已切集合」，key 见 tool-result-prune.ts 的文件头），新增候选合计可省
    // 字符 ≥ TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS 才一起切；已切条目继续切。
    // 集合落会话状态，每次推进后 hash 去重写回；重放时先读回来再算增量。
    // loop.ts 的 invariant 会把这条链再跑一遍（checkRequestInvariant），同一份历史
    // 第二次进来时候选已在集合里，输出与第一次逐字节相同。
    projections.set('tool-result-prune', {
      order: 560,
      fn: (messages, session) => {
        const owner = session ?? requestSession
        const sticky = readSticky(owner, 'tool-result-prune-batch')
        const batch = pruneToolResultsBatch(
          messages,
          DEFAULT_TOOL_RESULT_PRUNE,
          sticky.keys,
          TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS,
          sticky.length,
        )
        // 推进了要写回；历史变短（集合作废）也要写回，否则下一轮历史又变长就查不回来了。
        if (batch.added.length > 0 || batch.reset) noteStickyBatch(owner, 'tool-result-prune-batch', batch.kept, messages.length)
        return batch.messages
      },
    })
    // 内置投影三：每轮按龄/按预算卸载图片（0.6.68 WS2，口径见 core/image-diet）。
    // 用户贴的图、工具结果里的图、电脑控制的历史截图在长会话里每轮重发，一张 JPEG 截图
    // 100~300KB——旧图既烧 token 又早已过期（界面被后面的操作改掉了）。这一层只留「最近的」：
    // 用户图与工具图各按预算保留，更早回合的图全卸载；卸载只把 image_url 部件换成一句占位，
    // **不删消息、不改 role 序列**（删一条工具结果就会留下孤儿调用，端点直接 400）。
    // 与 drop-images（900，能力门：模型根本不收图时全剥）职责分开，所以排在它前面。
    //
    // 排在 env-facts（600）**之前**：env-facts 会往末尾追加一条 user 环境快照，而本投影
    // 按「最近几个用户回合」决定哪些图还留着——若落在它之后，那条合成快照会白占一格，
    // keepRounds 的口径就比字面保守一格（更早的图被多卸一轮）。先卸图、再补快照，口径才对得上。
    //
    // P2a（2026-11-18）批量化：逐张越线就卸 = 每张一次前缀断点。改成按会话攒一批
    // （「粘性已卸位置集合」，位置 key 见 core/image-diet 的文件头）：新增候选凑到
    // IMAGE_DIET_BATCH_MIN_IMAGES 张才一次卸一批；已卸的位置继续卸。
    // 集合落会话状态，每次推进后 hash 去重写回；重放时先读回来再算增量。
    projections.set('image-diet', {
      order: 550,
      fn: (messages, session) => {
        // 现读配置：设置分区保存后下一轮就生效，不必重启宿主（照 readBudget 的做法）。
        const config = readImageDietConfig(resolvePluginConfig(IMAGE_DIET_CONFIG_KEY))
        if (!config.enabled) return messages
        const owner = session ?? requestSession
        const sticky = readSticky(owner, 'image-diet-batch')
        const batch = pruneImagesBatch(messages, config, sticky.keys, IMAGE_DIET_BATCH_MIN_IMAGES, sticky.length)
        // 推进了要写回；历史变短（集合作废）也要写回，否则下一轮历史又变长就查不回来了。
        if (batch.added.length > 0 || batch.reset) noteStickyBatch(owner, 'image-diet-batch', batch.kept, messages.length)
        return batch.messages
      },
    })
    // 内置投影四（永远最后）：模型没勾照片输入时把图像换成一句说明。留着图像会让
    // 端点整条请求报错，而电脑操作插件的截图、用户贴进来的图都可能落在这里。
    projections.set('drop-images', {
      order: 900,
      fn: (messages) => (ctx.llm.inputModalities.includes('image') ? messages : dropImageParts(messages, NO_IMAGE_NOTE)),
    })

    /** 已注册段的快照（顺序由各段自己声明，这里只按登记表原样取出）。 */
    const registeredSections = (scope?: AgentScope): PromptContribution[] => {
      const out: PromptContribution[] = []
      for (const [id, entry] of sections) {
        try {
          out.push({ id, order: entry.order, text: entry.text(scope), ...(entry.block === undefined ? {} : { block: entry.block }) })
        } catch {
          // 一个插件把提示词生成崩了，不该让这一轮请求整个失败：这段本轮跳过。
          void id
        }
      }
      return out
    }

    /**
     * 拼这一轮的系统提示（正文 + 段清单）。
     *
     * 为什么段清单与正文同一次拼出：卡片上的段清单要与正文逐段对得上，拼两次可能出现
     * 两次之间 AGENTS.md 被改过的中间态；而且重复拼装等于每轮多读一遍技能目录。
     */
    const buildParts = (cwd: string, scope?: AgentScope): { text: string; sections: PromptSectionView[] } => {
      budget = readBudget(passed)
      // 没有过滤器时走 keep=undefined 的那条路：段的清单与顺序与以前完全一样
      const filters = [...skeletonFilters.entries()]
      const keep =
        filters.length === 0
          ? undefined
          : (ids: readonly string[]): readonly string[] => {
              let out = ids
              for (const [id, fn] of filters) {
                try {
                  out = fn(out, scope)
                } catch (error) {
                  // 取舍崩了就当这一位不存在（提示词多一段总比整轮请求失败强）
                  ctx.emit('dsc/notice', `提示词段取舍 ${id} 这轮没跑成，已跳过：${errText(error)}`)
                }
              }
              return out
            }
      return buildSystemPromptParts(scope?.cwd ?? cwd, {
        skills: ctx.skills.catalogText(),
        instructionBudget: budget,
        contributions: [
          ...registeredSections(scope),
          { id: 'model', order: 890, text: `当前模型：${ctx.llm.model}（provider ${ctx.llm.provider}）` },
        ],
        ...(keep === undefined ? {} : { keep }),
      })
    }

    const service: PromptService = {
      register(id, text, options) {
        sections.set(id, { order: options?.order ?? 60, text, block: options?.block })
        return () => {
          if (sections.get(id)?.text === text) sections.delete(id)
        }
      },
      registerEnvFacts(id, fn) {
        envFacts.set(id, fn)
        return () => {
          if (envFacts.get(id) === fn) envFacts.delete(id)
        }
      },
      registerProjection(id, fn, options) {
        if (RESERVED_PROJECTIONS.has(id)) {
          throw new Error(`投影名 ${id} 是内核保留的（协议护栏），换个名字`)
        }
        projections.set(id, { order: options?.order ?? 60, fn })
        return () => {
          if (projections.get(id)?.fn === fn) projections.delete(id)
        }
      },
      sections(scope) {
        return registeredSections(scope)
      },
      registerSkeletonFilter(id, fn) {
        skeletonFilters.set(id, fn)
        return () => {
          if (skeletonFilters.get(id) === fn) skeletonFilters.delete(id)
        }
      },
      systemPrompt(cwd, scope) {
        return buildParts(cwd, scope).text
      },
      systemPromptParts(cwd, scope) {
        return buildParts(cwd, scope)
      },
      rewrite(messages, session, report) {
        requestSession = session ?? ctx.session.current()
        let out = messages
        for (const [id, projection] of projectionChain()) {
          try {
            // 把本次请求所属会话交给投影：按会话冻结/取状态的投影（微压缩）要靠它。
            // 第三个参数是注入录音机：投影往请求里加了什么，由它自己报一条摘要。
            out = projection.fn(out, requestSession, report)
          } catch (error) {
            // 一个投影崩了不该让这一轮请求整个失败：跳过它（模型本轮看到未投影的
            // 原文），但要把话说出来，别让用户对着莫名其妙的端点报错猜。
            ctx.emit('dsc/notice', `投影 ${id} 这轮没跑成，已跳过：${errText(error)}`)
          }
        }
        return out
      },
    }
    ctx.provide('prompt', service)
  },
}

/**
 * 环境快照消息的全文（发给模型与写进日志状态条目是同一份文本）。
 *
 * @param cwd - 会话工作目录（决定 git 那一行）
 * @param parts - 各插件登记的「环境事实」片段（沙箱档位、当前模式这些），按登记顺序拼在
 *   日期 / 平台 / 工作目录之后；空串片段跳过，不留下空行。
 */
function environmentSnapshot(cwd: string, parts: readonly string[]): string {
  const body = [environmentText(cwd), ...parts.filter((part) => part !== '')].join('\n\n')
  return `${body}\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）`
}

/** 环境快照落盘（hash 去重）：变了才写一条状态，恢复会话时最后一条就是当前环境。 */
function noteEnvFacts(session: Session, text: string): void {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  if (session.state('env-facts')?.hash === hash) return
  session.appendState('env-facts', { hash, text })
}
