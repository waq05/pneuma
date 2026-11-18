/**
 * core 事件流 → 中性 transcript 的折叠器（无 React、零宿主依赖）。
 *
 * 数据来源分工：
 * - `delta` 事件维护直播尾 `segments`（流式渲染）；
 * - `message` 事件是定稿：清直播尾、折叠 text/reasoning 条目；
 * - `tool/call` ↔ `tool/result` 按 callId 配对成工具卡（发起时刻与耗时分别记在
 *   `call.startedAt` / `call.durationMs` 上，条目上的 `ts` 只表示最后写入时刻）；
 * - `usage` 累计；`error` 折成 system 条目；压缩落点标 `compaction`（实时走
 *   `system()`，重放靠摘要正文的 {@link SUMMARY_BANNER} 前缀认）。
 *
 * 条目对象一旦发布视为不可变，更新靠替换（tool 卡 running→done）。
 *
 * @module dsc/adapter/transcript
 */
import type { CoreEvent } from '../core/events.js'
import type { SessionNotice, SessionTranscriptMark } from '../core/session.js'
import { contentImages, contentText, type ChatMessage } from '../core/llm.js'
import type { FileChangeSummary } from '../core/tools.js'
import type { ToolPresentationView } from '../contract.js'
import { sameContextInjections, type ContextInjectionView } from '../contract.js'
import { SUMMARY_BANNER } from '../core/compact-anchors.js'
import { REVIEW_FINDINGS_OPEN, TEAMMATE_REPORT_OPEN } from '../core/team-board.js'
import { addUsageToBuckets, emptyCostBuckets, isPeakHour, type CostBuckets } from '../core/pricing.js'
import { emptySegments, type RequestSegments } from '../core/token-estimate.js'
import type { CompactionMark, SubagentCardView, TokenUsageView, ToolCallView, ToolStatus, TranscriptEntry, TurnUsageView } from '../contract.js'
import type { UserFileAttachment } from '../core/attachments.js'

/** 工具卡条目（替换对象实现不可变更新）。 */
type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** 直播尾段：按到达顺序的 thinking/text 交替片段。 */
interface LiveSegment {
  kind: 'thinking' | 'text'
  text: string
  /** 这一段最后一次追加内容的时刻（界面按它算时间；重放老日志时没有）。 */
  ts?: number
  /** 这段思考第一口 delta 的时刻（定稿时算耗时用；text 段没有）。 */
  startedAt?: number
  /**
   * 这段正文已经确定是「这一步调工具之前的前言」（见 contract 的 text 分支）。
   *
   * 由 tool/prepare 当场标上：模型开始吐工具名，就说明它刚写的这段话是在交代接下来要
   * 干什么。标上之后直播尾当场换成小字灰行，定稿时不会出现「大字正文忽然缩水」的换挡。
   */
  process?: boolean
}

const RESULT_TEXT_LIMIT = 1500

/**
 * notice 记录 → 转录事件：重试折回 model-retry 条目，失败原因折回 error。
 *
 * 为什么重放要借道 reduce 而不是直接 push 条目：同一条记录在现场是事件、恢复时也必须是
 * 事件，两条路才会得到同一个形状（id 发号、ts、二级分组边界全一致）。
 *
 * @param notice - 日志里读回来的回合提示
 */
export function noticeEvent(notice: SessionNotice): CoreEvent {
  if (notice.kind === 'model-retry') {
    return {
      type: 'model/retry',
      attempt: notice.attempt,
      maxRetries: notice.maxRetries,
      delayMs: notice.delayMs,
      reason: notice.text,
    }
  }
  return { type: 'error', message: notice.text }
}

/**
 * 落位记录 → 转录事件：系统提示卡 / 上下文注入卡。
 *
 * 与 {@link noticeEvent} 同一个理由：同一条记录在现场是事件、恢复时也必须是事件，
 * 两条路才会得到同一个形状（id 发号、去重判据、ts 全一致）。重放靠日志里记的
 * `after` 插回原位（见 replayHistory）。
 *
 * @param mark - 会话日志里读回来的落位记录
 */
export function markEvent(mark: SessionTranscriptMark): CoreEvent {
  return mark.kind === 'system-prompt'
    ? { type: 'prompt/used', prompt: mark.prompt }
    : { type: 'context/injected', parts: mark.parts }
}

/** 把会话事件流折叠成有序 transcript。 */
export class Transcript {
  /** 定稿条目（append-only；`clear()` 重置）。 */
  private list: TranscriptEntry[] = []
  /** callId → 工具条目在 `list` 中的下标（append-only 保证下标稳定）。 */
  private toolIndex = new Map<string, number>()
  /**
   * 子调用 callId → 它挂在哪张卡的第几个位置（PTC 的 sdk.xxx()）。
   *
   * 为什么不用 toolIndex 一把梭：子调用**没有自己的顶层条目**（它活在父卡的 subCalls 里），
   * 结果回来时得先找到父条目、再改数组里的那一格。父条目下标稳定（append-only），
   * 子条目只追加，所以这对下标一次记下就够。
   */
  private subCallIndex = new Map<string, { parent: number; child: number }>()
  /** 队友名 → 子代理卡条目在 `list` 中的下标（同名原位更新）。 */
  private subagentIndex = new Map<string, number>()
  /**
   * 流式期间已经报出工具名、还在等参数的条目（对照 dsh 的 `preparing` 阶段）。
   *
   * 为什么**不直接进 list**：list 里的条目永远排在直播尾之前，而准备中的工具在语义上
   * 恰恰是「最新发生的一件事」——push 进去会让工具卡插到正在流式的思考前面（自检实测过，
   * 顺序会变成「工具 → 思考 → 正文」，而且升级是就地替换，这个位置会一直错下去）。
   * 交给 {@link liveEntries} 合成在最后，等 `tool/call` 到达时再正式落进 list——
   * 那时直播尾已经被清掉了，顺序自然对。
   *
   * 这里**不给它发正 id**（0.6.70 修）：正 id 是「定稿条目」的身份证——宿主组帧时按 id
   * 正负把条目分成 `entries` / `liveEntries` 两份（`plugins/webserver.ts`），而壳把
   * `entries` **按 id 升序**归并（`ui/frames.ts` 的 applyHostFrame，前提是「id 序 = 时间序」）。
   * 准备中的工具若在此时就领一个正 id，它必然比同一步稍后才定稿的思考行（`message`
   * 那一刻才发号）小，壳那边就一路把它排到思考行前面——正是用户报的「思考内容行在工具
   * 调用行下面」。**发号只许在条目真正进 list 的那一刻做**（见 `tool/call`），这条不变量
   * 由 `scripts/transcript-order-test.mjs` 逐条钉住。
   */
  private prepared: { name: string; ts: number | null }[] = []
  private seq = 1
  /** 直播尾段（`message`/`turn/end`/清空时重置）。 */
  private segments: LiveSegment[] = []
  /** 本会话累计 token 用量。 */
  usage: TokenUsageView = { inputTokens: 0, outputTokens: 0 }
  /**
   * 最近一次请求的 prompt_tokens（context 条的权威占用读数）。
   * 为什么不用 usage 累计：那是整会话计费和，多轮会把滚出窗口的内容也算进去，
   * 条只会虚胖；真实占用就该用服务端对最近一次请求报的数。
   */
  contextUsed = 0
  /** 最近一次请求的内容类型分段（`context` 事件随每笔请求重算）。 */
  contextSegments: RequestSegments = emptySegments()
  /** 费用估算的峰谷分桶（按模型分账；`usage` 事件带 model 后逐笔累加）。 */
  costBuckets = new Map<string, CostBuckets>()
  /**
   * 本轮（最近一条用户消息起）累计 token 用量。
   *
   * 口径：这一轮里每一次模型请求的 prompt_tokens（含系统提示词与全部上下文）
   * 与 completion_tokens 全部累加。多步工具轮每次请求都重发整份上下文，
   * 所以这个和就是本轮真实计费量，界面每轮页脚要显示的就是它。
   * 收 'user' 事件时清零（新一轮的起点），'usage' 事件累加。
   */
  private turnUsage: TokenUsageView = { inputTokens: 0, outputTokens: 0 }
  /** 当前 turn 是否已进入工具执行阶段（驱动 working/thinking 状态区分）。 */
  working = false
  /** 事件驱动的 turn 状态（turn/start→true，turn/end→false；避免依赖 agent 瞬时值）。 */
  inTurn = false

  /**
   * 重放期间被暂定成中止态的工具条目下标：宿主说「这一轮还在跑」时要放回执行中
   * （见 seedTurnState；重放只看得见「没有结果」，看不见「还在跑」）。
   */
  private replayedSettled: number[] = []

  /**
   * 切回到一个回合还在跑的会话时补「回合中」状态（0.6.48 常驻多 agent）。
   * 那一轮的 turn/start 发生在你切走的期间，转录层没收到，重放日志也补不出
   * 这个纯内存状态——只能由转录插件按 agent 注册表的实时状态种回来。
   * working 取不了真值（不知道回合此刻在流式还是在跑工具），先按「思考中」处理，
   * 下一帧事件到达自然修正。
   */
  seedTurnState(running: boolean): void {
    this.inTurn = running
    if (running) {
      // 重放时只能按「没有结果就是没跑完」暂定为中止态；宿主说这一轮还在跑，说明那几条
      // 只是结果还没回来（切回一个正在跑工具的会话就是这种情形）——放回执行中。
      for (const index of this.replayedSettled) {
        const entry = this.list[index]
        if (entry === undefined || entry.kind !== 'tool') continue
        this.list[index] = { ...entry, call: { ...entry.call, status: 'running' } }
      }
    } else {
      this.working = false
      // 宿主说这一轮不在跑 ⇒ 还挂着「没有结果」的工具行永远不会再等到结果，落成中止态。
      // 与 replayHistory 结尾那次判定是同一份（settleUnfinishedTools），这里只是把
      // 「重放之后才拿到」的宿主真值再对一次：session-open 必然走到这里（transcript 插件）。
      this.settleUnfinishedTools()
    }
  }
  /**
   * 会话重新打开时把「最近一次请求的上下文占用」种回来。
   *
   * 为什么需要：contextUsed 只在收到 usage 事件时赋值，而重放历史明确不重放 usage；
   * 宿主重启后第一帧于是显示 0%，用户看到的是「上下文被清空了」，实际只是读数没恢复。
   * usage 日志里按会话存着每条请求的输入 token（最后一条就是此刻的占用），
   * 由调用方读出后交给这里补上。
   *
   * 为什么只补总数、不补分段：分段（系统提示词 / 工具定义 / 对话消息）是宿主按
   * 请求内容估出来的，日志里没有；它仍然要等下一次请求的 context 事件。这里若把
   * 总数塞进 contextSegments，卡片就会拿一份假的分段画进度条。
   *
   * 没有样本的会话不要调用（调用方传 0 会把「还没数」伪装成一个 0% 读数）。
   */
  seedContextUsage(used: number): void {
    this.contextUsed = used
  }
  /**
   * 会话重新打开时把磁盘账的「按模型 × 峰谷」费用桶种回来（P0-5）。
   *
   * 为什么需要：`costBuckets` 是纯内存累计，`clear()` 每次开会话都换成空 Map，而重放
   * 历史明确不重放 usage——切到别的会话再切回来，状态栏那一格就整段消失。磁盘的
   * usage.jsonl 按会话记着每笔请求的模型与 token，足够把桶原样还原（见
   * `core/usage-log.ts` 的 readSessionCostBuckets）。
   *
   * 为什么整表替换而不是累加：重复打开同一条会话是「clear → 回填 → 再 clear → 再回填」，
   * 必须得到同一个数，累加会让费用翻倍。桶是新拷的一份，之后到达的实时增量只改这份拷贝，
   * 不会回头改调用方手里那张表（读取方常常是共享的缓存或常量）。
   */
  seedCostBuckets(buckets: ReadonlyMap<string, CostBuckets>): void {
    const next = new Map<string, CostBuckets>()
    for (const [model, bucket] of buckets) {
      next.set(model, { peak: { ...bucket.peak }, idle: { ...bucket.idle } })
    }
    this.costBuckets = next
  }
  /**
   * 本会话已经落过几条压缩标记（`clear()` 归零）。新标记的 `count` 就是它加一，
   * 因此这个数就是「第几次压缩」。标记只在真正压过的地方产生，所以不必认识压缩服务。
   */
  private compactionCount = 0
  /**
   * 当前这次折叠的事件时刻，加入条目时统一盖上去（见 {@link stamp}）。
   * null = 正在重放老会话，日志里没记时间：条目就不带 ts，
   * 界面据此降级（不显示时间与用时），而不是拿现在的钟点冒充历史时刻。
   */
  private eventTs: number | null = Date.now()

  /** 定稿条目的只读视图。 */
  get entries(): readonly TranscriptEntry[] {
    return this.list
  }

  /** 还没定稿的条目：直播尾 + 「准备中」的工具（见 `prepared` 的注释）。 */
  liveEntries(): TranscriptEntry[] {
    const live = this.segments.map(
      (segment, position): TranscriptEntry => ({
        kind: segment.kind,
        id: -(position + 1),
        text: segment.text,
        ...(segment.ts === undefined ? {} : { ts: segment.ts }),
        // 直播中的思考卡实时显示已思考时长（快照每次重建，数值随渲染刷新）
        ...(segment.kind === 'thinking' && segment.startedAt !== undefined
          ? { durationMs: Math.max(0, Date.now() - segment.startedAt) }
          : {}),
        // 过程正文的标记跟着段走：直播时就按小字灰行画，定稿后条目原样继承（见 tool/call）。
        ...(segment.kind === 'text' && segment.process === true ? { process: true as const } : {}),
      }),
    )
    // 准备中的工具接在直播尾后面，同样发**负 id**：它也是一段「还没定稿、还在长」的内容
    // （参数还在流里），宿主组帧时因此落进 `liveEntries`（按出现顺序原样传给壳，不参与
    // 按 id 归并）。0.6.70 之前这里用正 id，壳按 id 升序归并时就把工具卡排到了思考行前面。
    // 编号从直播尾之后接着排，免得与上面那几段的负 id 撞上（负 id 也是壳的行 key）。
    const prepared = this.prepared.map((item, offset): TranscriptEntry => ({
      kind: 'tool',
      id: -(live.length + offset + 1),
      call: {
        callId: '',
        name: item.name,
        // 参数这会儿还没到齐，一条都不解析（对照 dsh 的「不解析参数」）
        argsText: '',
        status: 'preparing',
      },
      ...(item.ts === null ? {} : { ts: item.ts }),
    }))
    return [...live, ...prepared]
  }

  /**
   * 追加一条系统提示（错误/状态说明）。
   * @param compaction - 这条提示是「历史刚被压缩」的落点：带标记，轨迹页据此切区段。
   * @param level - `'error'` 表示要人处理的问题：界面会弹一次提示而不再铺在首屏；缺省只进日志。
   */
  system(text: string, compaction = false, level: 'info' | 'error' = 'info', command = false): void {
    // 这条不走 reduce，时间戳在这里自己取
    this.list.push({
      kind: 'system',
      id: this.seq++,
      text,
      ts: Date.now(),
      // 只有错误才写这个字段：信息类条目保持原来的形状，落盘体积不变。
      ...(level === 'error' ? { level } : {}),
      ...(compaction ? { compaction: this.compactionMark() } : {}),
      // 命令输出带标记：空会话欢迎态也要画出来（见 contract 里这条的注释）
      ...(command ? { command: true } : {}),
    })
  }

  /** 下一个压缩标记；只有真压过的地方才调用，所以序号不会跳。 */
  private compactionMark(): CompactionMark {
    this.compactionCount += 1
    return { count: this.compactionCount }
  }

  /**
   * 记一份计划（提交评审、批准、拒绝都走这里）。
   * 同一份计划（按文件路径认）只保留一张卡：批完之后原位更新结论，别叠两张。
   */
  plan(view: Extract<TranscriptEntry, { kind: 'plan' }>['plan']): void {
    const at = this.list.findIndex((entry) => entry.kind === 'plan' && entry.plan.file === view.file)
    if (at >= 0) {
      const previous = this.list[at]
      // 原位换成新结论时也刷新时间：这张卡的时刻是「最后一次更新」
      if (previous?.kind === 'plan') this.list[at] = { ...previous, plan: view, ts: Date.now() }
      return
    }
    this.list.push({ kind: 'plan', id: this.seq++, plan: view, ts: Date.now() })
  }

  /** 清空（开新会话/恢复会话时）。 */
  clear(): void {
    this.list = []
    this.toolIndex.clear()
    this.subCallIndex.clear()
    this.subagentIndex.clear()
    this.prepared = []
    this.seq = 1
    this.segments = []
    this.usage = { inputTokens: 0, outputTokens: 0 }
    this.turnUsage = { inputTokens: 0, outputTokens: 0 }
    this.contextUsed = 0
    this.contextSegments = emptySegments()
    this.costBuckets = new Map()
    this.working = false
    this.inTurn = false
    this.replayedSettled = []
    this.compactionCount = 0
  }

  /**
   * 恢复会话时把历史消息折叠为条目（合成为事件流走 reduce，复用配对逻辑）。
   * usage 不重放（历史 token 已计入模型侧缓存，快照从 0 起算当前会话增量）。
   * @param toolErrors 日志里记下的工具异常标记（callId → `rejected` / `tool-error`）。
   *                   OpenAI 协议消息不带这个信息，缺省时工具一律折成「完成」。
   *
   * 时间戳跟着消息走（`ChatMessage.ts`，由会话日志重放时填回）：有就盖在条目上，
   * 没有（2026-09 之前的老日志）就传 null，条目干脆不带 ts，界面降级不显示时间。
   */
  replayHistory(
    messages: readonly ChatMessage[],
    toolErrors?: ReadonlyMap<string, string>,
    fileChanges?: ReadonlyMap<string, readonly FileChangeSummary[]>,
    presentations?: ReadonlyMap<string, ToolPresentationView>,
    notices?: readonly SessionNotice[],
    marks?: readonly SessionTranscriptMark[],
  ): boolean {
    let changed = false
    // 系统提示卡与上下文注入卡同样不在消息流里（系统提示是请求头、注入是投影塞进请求的），
    // 只能靠日志记下的 `after`（写它时日志里有几条消息）插回原位。没有锚点的老记录
    // （2026-11 之前的 system-prompt 状态条目）落到轮首——它们当年没记位置，与其猜，
    // 不如放在最前面；`bodyMissing` 已由 Session.load 标好（段清单当年没记）。
    //
    // 顺序：同一锚点上，落位记录排在回合提示之前——实时路径里请求组装（记卡片）必然
    // 早于流式过程中的重试提示，重放照这个先后走，两边的条目顺序才一致。
    // 按锚点升序处理（同一锚点上保持日志里的写入顺序）：正常情况下日志顺序天然就是升序，
    // 只有「编辑并重发」把消息截短过之后才会出现回落，那时按号排一遍才不会漏掉后面的记录。
    const anchoredMarks = (marks ?? [])
      .filter((mark) => typeof mark.after === 'number')
      .sort((left, right) => (left.after ?? 0) - (right.after ?? 0))
    const headMarks = (marks ?? []).filter((mark) => typeof mark.after !== 'number')
    for (const mark of headMarks) {
      changed = this.reduce(markEvent(mark), mark.ts ?? null) || changed
    }
    let markAt = 0
    const flushMarks = (index: number | null): boolean => {
      let flushed = false
      while (markAt < anchoredMarks.length) {
        const mark = anchoredMarks[markAt]!
        if (index !== null && (mark.after ?? 0) > index) break
        flushed = this.reduce(markEvent(mark), mark.ts ?? null) || flushed
        markAt += 1
      }
      return flushed
    }
    // 回合提示（重试 / 失败原因）与消息在日志里是两个流，在界面上是一条线：按 notice 记录的
    // `after`（写它时日志里有几条消息）插回原位——重试一定排在它促成的回答之前。
    // 为什么不按时间戳：同一毫秒里写下的几条分不出先后（重试提示与紧接着写的答案就会撞上），
    // 「先持久、后等待」写下的顺序才是真相。没有锚点的老记录落到末尾，宁可位置粗一点也不丢。
    const anchored = (notices ?? []).filter((notice) => typeof notice.after === 'number')
    const trailing = (notices ?? []).filter((notice) => typeof notice.after !== 'number')
    let noticeAt = 0
    const flushNotices = (index: number | null): boolean => {
      let flushed = false
      while (noticeAt < anchored.length) {
        const notice = anchored[noticeAt]!
        if (index !== null && (notice.after ?? 0) > index) break
        flushed = this.reduce(noticeEvent(notice), notice.ts ?? null) || flushed
        noticeAt += 1
      }
      return flushed
    }
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!
      const ts = message.ts ?? null
      changed = flushMarks(index) || changed
      changed = flushNotices(index) || changed
      switch (message.role) {
        case 'user': {
          const images = contentImages(message.content)
          changed =
            this.reduce(
              {
                type: 'user',
                text: contentText(message.content),
                ...(images.length > 0 ? { images } : {}),
                ...(message.files === undefined || message.files.length === 0 ? {} : { files: message.files }),
                // 机器投递的通知带着 origin 落库（见 core/session 的 InboxOrigin）：重放时
                // 原样交给 reduce，靠它与前缀一起判 internal，否则「重开旧会话」会把它们
                // 又还原成用户气泡。
                ...(message.origin === 'notice' ? { origin: message.origin } : {}),
              },
              ts,
            ) || changed
          break
        }
        case 'assistant':
          changed =
            this.reduce(
              {
                type: 'message',
                text: contentText(message.content),
                reasoning: message.reasoning_content ?? '',
              },
              ts,
            ) || changed
          for (const call of message.tool_calls ?? []) {
            changed =
              this.reduce(
                {
                  type: 'tool/call',
                  // 老日志里可能存着 null（2026-10-30 那条 `未知工具：null`）：
                  // 读回来时统一修成字符串，界面才敢对名字调字符串方法。
                  callId: typeof call.id === 'string' ? call.id : '',
                  name: typeof call.function.name === 'string' ? call.function.name : '',
                  args: typeof call.function.arguments === 'string' ? call.function.arguments : '',
                },
                ts,
              ) || changed
          }
          break
        case 'tool': {
          const callId = message.tool_call_id ?? ''
          const error = toolErrors?.get(callId)
          changed =
            this.reduce(
              {
                type: 'tool/result',
                callId,
                text: contentText(message.content),
                ...(error !== undefined ? { error } : {}),
              },
              ts,
            ) || changed
          // 成功的 write / edit 把轮尾卡的变更事实一并重放（日志 tool 记录里存着）。
          // 一个 callId 可能对应多个文件（PTC 的一次脚本），逐个折成条目。
          for (const change of fileChanges?.get(callId) ?? []) {
            changed = this.reduce({ type: 'tool/changes', callId, change }, ts) || changed
          }
          // dsh 插件的卡片数据也一并重放（日志 tool 记录里存着）
          const presentation = presentations?.get(callId)
          if (presentation !== undefined) {
            changed = this.reduce({ type: 'tool/presentation', callId, presentation }, ts) || changed
          }
          break
        }
      }
    }
    // 剩下的落位记录与提示（还没有下文的那几条）落到末尾：宁可排在最后，也不能丢。
    // 同一锚点上仍是「记录在前、提示在后」（理由见上面 anchoredMarks 的注释）。
    changed = flushMarks(null) || changed
    changed = flushNotices(null) || changed
    for (const notice of trailing) {
      changed = this.reduce(noticeEvent(notice), notice.ts ?? null) || changed
    }
    // 工具卡配对完成后不留在执行态（reduce 的 tool/call 会置 working）
    this.working = false
    // 重放结束时还停在 running 的工具行，是「日志里有发起、没有结果」的那些：日志不记录
    // 「这一轮为什么结束」，同一份形状既可能是被中断的，也可能是还在跑的。这里先按
    // 「没结果 = 没跑完」落定（启动恢复只走重放，没人再送回合状态）；宿主随后调
    // seedTurnState 说这一轮还在跑时，会把这批放回执行中。
    this.replayedSettled = this.settleUnfinishedTools()
    return changed
  }

  /**
   * 把「已经不可能再有结果」的工具行落到中止态。
   *
   * 什么时候会有这种行：一轮以中断 / 失败收尾时（turn/end 的 reason 不是 completed），
   * 发出去却始终没收到 tool/result 的调用就此悬在半空——以前它们一直停在 status: 'running'，
   * 界面上的转圈与「进行中」常驻下去（2026-11-06 报障：被中断的 bash 重开多少次还是进行中）。
   *
   * 为什么落成 aborted 而不是 failed：用户按停止、或者这一轮被放弃，与「工具真的跑挂了」
   * 是两件事——后者要排查日志，前者不用管，混成同一个状态会让用户以为出了 bug。契约里
   * aborted 的语义就是「没跑完，但不是工具的错」（src/contract/transcript.ts:18），
   * 状态词与配色也随之走中性那一档（已中断，不是红字）。
   *
   * 扫全表而不是只扫本轮：轮一收尾，这个会话里就不可能有任何一个工具还在跑（loop 是等工具
   * 跑完才进下一跳），所以「此刻还挂着 running」的每一条都等不到结果了。
   *
   * @returns 被改动条目的下标（升序），给调用方留个对账口子。
   */
  private settleUnfinishedTools(): number[] {
    const settled: number[] = []
    for (let index = this.list.length - 1; index >= 0; index -= 1) {
      const entry = this.list[index]
      if (entry === undefined || entry.kind !== 'tool') continue
      // 父卡里还在跑的子调用（PTC 脚本被中断时）：它们等不到结果了，一并落成中止态。
      // 为什么要单独扫：子调用没有顶层条目，只看 entry.call.status 会漏掉它们，
      // 卡里就会留着几个永远转圈的嵌套行。
      const subCalls = entry.call.subCalls
      const moving = subCalls?.some((sub) => sub.status === 'running' || sub.status === 'preparing') === true
      // 一趟改完再落一次：先落子调用、再判父状态，别让两次替换互相覆盖。
      let next: ToolEntry = moving && subCalls !== undefined
        ? {
            ...entry,
            call: {
              ...entry.call,
              subCalls: subCalls.map((sub) =>
                sub.status === 'running' || sub.status === 'preparing' ? { ...sub, status: 'aborted' as const } : sub),
            },
          }
        : entry
      const status = next.call.status
      if (status === 'running' || status === 'preparing') {
        next = { ...next, call: { ...next.call, status: 'aborted' } }
      }
      if (next === entry) continue
      this.list[index] = next
      settled.push(index)
    }
    return settled.reverse()
  }

  /** 给新条目盖时间戳；重放老日志（eventTs 为 null）时不盖。 */
  private stamp(entry: TranscriptEntry): TranscriptEntry {
    return this.eventTs === null ? entry : { ...entry, ts: this.eventTs }
  }

  /**
   * 从尾部找最近一条这个 kind 的条目（没有返回 -1）。
   *
   * 为什么不是「只看最后一条」：系统提示卡的去重对象是「上一条同类的卡」，而两条同类卡
   * 之间一定隔着正文、工具行这些东西。只看紧邻的那条，等于每轮都新长一张卡。
   *
   * 上下文注入卡不走这里：它只在**这一轮**范围内找同类（见 {@link indexOfInjectionInTurn}）。
   * 原因是注入清单会在一轮里 A / B / A 地交替（B = A 多一条重复调用提醒），而这里返回的
   * 永远是最近那一张——拿 A 去跟 B 比必然不等，每跳都新长一张（一次 16 步的回合落 8 张）。
   */
  private lastIndexOfKind(kind: TranscriptEntry['kind']): number {
    for (let index = this.list.length - 1; index >= 0; index -= 1) {
      if (this.list[index]?.kind === kind) return index
    }
    return -1
  }

  /**
   * 本轮里与这份注入清单相同的卡片下标（没有返回 -1）。
   *
   * 扫描范围是**这一轮**：从尾部往前，撞上 `user`（新一轮的起点）或 `turn-end`（这一轮的
   * 终点）就停。为什么边界不是「遇到第一个非注入条目」：多步工具轮里两次请求之间必然夹着
   * 正文、工具卡与结果行，按它们切会把同一轮切成一跳一段——实测按那种写法改，16 步的回合
   * 反而落 16 张卡，比修之前还多。工具行属于这一轮的过程，不是轮与轮之间的边界。
   *
   * 为什么跨轮不合并：下一轮模型看到的是一段新的上下文，两张卡各自代表各自那一段；
   * 合起来会把两轮的时间线糊成一条，次数也失去「这一轮重发了几次」的意义。
   */
  private indexOfInjectionInTurn(parts: readonly ContextInjectionView[]): number {
    for (let index = this.list.length - 1; index >= 0; index -= 1) {
      const entry = this.list[index]
      if (entry === undefined) continue
      if (entry.kind === 'user' || entry.kind === 'turn-end') return -1
      if (entry.kind !== 'context-injection') continue
      if (sameContextInjections(entry.parts, parts)) return index
    }
    return -1
  }

  /**
   * 本轮累计的 `usage` 字段：非零才带。
   * 为什么零就不带：一次请求都还没回过用量时，硬写 `{0,0}` 会让界面把「还没数」
   * 当成「这一轮真的一分没花」，而带不带这个字段是能给界面区分的信号。
   * 缓存两栏跟着 turnUsage 走：端点没上报过就不带（同上，不写 0 冒充「全未命中」）。
   */
  private turnUsageField(): { usage?: TurnUsageView } {
    const { inputTokens, outputTokens } = this.turnUsage
    if (inputTokens === 0 && outputTokens === 0) return {}
    return { usage: { ...this.turnUsage } }
  }

  /**
   * 轮末兜底：把本轮最终累计写到「本轮最后一条能挂 usage 的条目」上。
   *
   * 为什么 message 那一刻盖过了还要再写一次：`usage` 事件是在 `message` 之后才发的
   * （loop.ts 先定稿消息、再报用量），所以 message 那时盖上的累计还差本次请求那一笔。
   * 收尾时补上，轮内最后一条才是整轮真值——界面取的就是它。
   *
   * 为什么往前找而不是只看最后一条：一轮以工具结果收尾时最后一条是 tool 卡（能挂），
   * 但末尾要是又插了 system 行（错误提示之类），仍该落回上一张能挂的条目，别把数字丢了。
   * 为什么只认 text/tool：contract.ts 里只有这两种条目有 `usage` 字段。
   */
  private stampTurnUsage(): void {
    if (this.turnUsage.inputTokens === 0 && this.turnUsage.outputTokens === 0) return
    for (let index = this.list.length - 1; index >= 0; index -= 1) {
      const entry = this.list[index]
      if (entry === undefined || entry.kind === 'user') return
      if (entry.kind === 'text' || entry.kind === 'tool') {
        this.list[index] = { ...entry, usage: { ...this.turnUsage } }
        return
      }
    }
  }

  /**
   * 从「准备中」队列里取一条同名的（先来后到）。
   *
   * 为什么按名字配对而不是纯按顺序：模型偶尔会重排 index，名字对上才算同一条。
   * 一个都没对上就返回 undefined，调用方用新 id 落一条——那条准备中的留给
   * {@link dropPrepared} 在轮末收掉。
   */
  private takePrepared(name: string): { ts: number | null } | undefined {
    const at = this.prepared.findIndex((item) => item.name === name)
    if (at < 0) return undefined
    return this.prepared.splice(at, 1)[0]
  }

  /**
   * 丢掉还挂着「准备中」、却等不到对应 `tool/call` 的那些。
   *
   * 什么时候会有：模型吐了工具名之后被打断，或者吐到一半改了主意。那些条目代表
   * 「本来想调、最后没调」，留着会让用户一直盯着一句「准备读取文件」等下去。
   *
   * 为什么放在轮末而不是 `message`：`loop.ts` 的顺序是「先发 message、再执行工具」，
   * message 那一刻这一批的 `tool/call` 还没发出来——在那儿清会把等着升级的一起误杀。
   *
   * 为什么只是一句赋值：这些条目从来没进过 `list`（见 `prepared` 的注释），
   * 所以没有下标要修、也没有 toolIndex 要重建。
   */
  private dropPrepared(): void {
    this.prepared = []
  }

  /**
   * 折叠一条 core 事件。
   * @param ts 这条事件的时刻；省略取当前时间（运行中的实时事件都这样）。
   *           重放老会话时显式传 null：条目不带 ts，界面据此降级。
   * @returns 是否产生了可见变化（调用方据此决定是否通知 UI）。
   */
  reduce(event: CoreEvent, ts: number | null = Date.now()): boolean {
    this.eventTs = ts
    switch (event.type) {
      case 'user': {
        // 一条用户消息就是新一轮的起点：上一轮的累计不能带进这一轮，
        // 否则界面会把上一轮花掉的量算到这一轮头上。
        // 例外是轮中途插话（steering）：它还属于同一轮，累计要接着算下去，
        // 否则这一轮前半段已经花掉的量会被当场抹掉。
        if (event.steering !== true) this.turnUsage = { inputTokens: 0, outputTokens: 0 }
        const last = this.list[this.list.length - 1]
        const imageCount = event.images?.length ?? 0
        const fileCount = event.files?.length ?? 0
        const sameAsLast =
          last !== undefined &&
          last.kind === 'user' &&
          last.text === event.text &&
          (last.images?.length ?? 0) === imageCount &&
          (last.files?.length ?? 0) === fileCount
        if (sameAsLast) return false
        // 压缩摘要本身在内存里就是一条 role:'user' 的消息（packages/session-core/compact.ts 造的），
        // 正文固定以 SUMMARY_BANNER 开头：这是它和真用户消息唯一的区别。
        // 老会话重放时系统提示不落进条目（日志里根本不存 system 行），全靠这个前缀
        // 才能认出「这里压过一次」，所以标记就打在摘要这条 user 条目上（kind 不动）。
        const compacted = event.text.startsWith(SUMMARY_BANNER)
        // 队友干完活投回来的 <teammate-report>、审查队友的 <review-findings> 也是一条
        // role:'user' 的消息（subagent 插件投的）：它必须留在上下文里（模型要看汇报），
        // 但不该在对话页装成人打的字。跟压缩摘要同一个套路——靠正文前缀认出来，认出后
        // 打 internal 标记，界面按「非人发起的唤醒」渲染（对照 dsh 的 turn-trigger 节点）。
        // 重放历史走的是同一条 reduce，所以老会话里的汇报也照样被认出来。
        //
        // 另一种认法：`origin: 'notice'`。机器投递的唤醒（后台作业完成、定时补投、目标续跑、
        // 记忆复盘……）正文没有固定前缀可言，靠事件/日志里的 origin 认（2026-11-02 报障：
        // 后台作业通知没有前缀，于是当成人打的字渲染成了可编辑气泡）。两条判据是并集：
        // 队友汇报与 findings 走前缀（老日志也认得出），其余机器消息走 origin。
        const internal =
          event.text.startsWith(TEAMMATE_REPORT_OPEN) ||
          event.text.startsWith(REVIEW_FINDINGS_OPEN) ||
          event.origin === 'notice'
        this.list.push(
          this.stamp({
            kind: 'user',
            id: this.seq++,
            text: event.text,
            ...(imageCount > 0 ? { images: event.images } : {}),
            ...(fileCount > 0 ? { files: event.files } : {}),
            ...(compacted ? { compaction: this.compactionMark() } : {}),
            ...(event.steering === true ? { steering: true } : {}),
            ...(internal ? { internal: true } : {}),
          }),
        )
        return true
      }
      case 'message': {
        const hadLive = this.segments.length > 0
        // 这轮思考的耗时 = 最后一段连续 thinking 的第一口 delta 到定稿的时长。
        // 从尾部往回扫，把紧挨着的 thinking 段的最早 startedAt 拿出来；正文夹在
        // 中间就只算最后那截（界面上一行思考标签对应的是「刚才这段思考」）。
        let thinkingMs: number | undefined
        for (let index = this.segments.length - 1; index >= 0; index -= 1) {
          const segment = this.segments[index]
          if (segment === undefined || segment.kind !== 'thinking') break
          if (segment.startedAt !== undefined && this.eventTs !== null && this.eventTs >= segment.startedAt) {
            thinkingMs = this.eventTs - segment.startedAt
          }
        }
        this.segments = []
        this.working = false
        let changed = hadLive
        if (event.reasoning !== '') {
          this.pushThinking(event.reasoning, thinkingMs)
          changed = true
        }
        if (event.text !== '') {
          this.pushAssistantText(event.text)
          changed = true
        }
        // 这次输出撞上了长度上限：单独记一条（对照 dsh 的 turn-max-tokens 节点）。
        // 它是独立节点——不进任何阶段组，也不被整轮折叠藏掉：用户得看见「话被截断了」，
        // 否则只会以为模型答到一半就不说了。重放老会话时拿不到 finish_reason，所以没有这条。
        if (event.finishReason === 'length') {
          this.list.push(this.stamp({ kind: 'turn-max-tokens', id: this.seq++ }))
          changed = true
        }
        return changed
      }
      case 'delta':
        this.appendSegment(event.kind === 'reasoning' ? 'thinking' : 'text', event.text)
        return true
      case 'tool/prepare': {
        // 模型开始吐这个工具的名字、参数还没到齐：记一笔，好让用户看得见「接下来要干这件事」
        // （对照 dsh 的 preparing 节点）。这条不往 list 里 push、也不在这里发号，理由见
        // `prepared` 的注释——它由 liveEntries() 合成在最后（负 id），`tool/call` 到达时
        // 才正式落进 list 并领一个当刻的正 id。
        this.prepared.push({ name: event.name, ts: this.eventTs })
        // 模型已经在吐工具名了：刚才那段还在流式的正文，就是这一步的前言——当场降成
        // 过程行，读者不会看到「大字正文忽然缩成小字」的换挡。只标最后一段：前面若还有
        // 一段思考，那是思考行的事。
        const tail = this.segments[this.segments.length - 1]
        if (tail !== undefined && tail.kind === 'text') tail.process = true
        return true
      }
      case 'model/retry': {
        // 重试发生在 llm 层内部，不报出来的话用户只会觉得界面卡了几秒。
        // 它同时是二级分组的边界（前后两段过程被切开），但整轮折叠仍包含它。
        //
        // 同一次请求连着重试时**原地更新同一条行**，不再每条发一行（2026-11-08 报障：
        // 一次 429 连锁重试，会话里出现四行「已重试模型请求（1/5）…（4/5）」）。
        // 判据只看「上一条是不是重试行」：重试之间不会有任何别的事件插进来；真有
        // （比如流中断后先落了半截回复），那本来就是新的一段，另起一行才是对的。
        // 原地更新顺手保住了 id 与 ts 之外的展开态——用户点开的那条不会因为下一次
        // 重试被重挂成收起。
        const fields = {
          attempt: event.attempt,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          text: event.reason,
        }
        const previous = this.list[this.list.length - 1]
        if (previous !== undefined && previous.kind === 'model-retry') {
          this.list[this.list.length - 1] = this.stamp({ ...previous, ...fields })
          return true
        }
        this.list.push(this.stamp({ kind: 'model-retry', id: this.seq++, ...fields }))
        return true
      }
      case 'tool/call': {
        this.working = true
        // 工具调用意味着模型输出已定稿，直播尾让位
        const hadLive = this.segments.length > 0
        this.segments = []
        // 同一步里既有正文又有工具调用：那句正文是「接下来要干什么」的前言，不是阶段收尾。
        // 补上过程标记（判据见 contract 的 text 分支），界面据此把它留在阶段组里、按小字灰行画。
        // 只认紧挨着的上一条：一步里第一个 tool/call 才紧跟在正文后面，后面的上一个已经是工具了。
        // 没真的发出工具调用的那一步不会被标——那种正文仍然是正文。
        const wrote = this.list[this.list.length - 1]
        if (wrote !== undefined && wrote.kind === 'text' && wrote.process !== true) {
          this.list[this.list.length - 1] = { ...wrote, process: true as const }
        }
        // 发起时刻就是这条条目第一次写入的时刻，只在这里取一次；结果回来时不许覆盖
        // （条目的 ts 是「最后写入时刻」，只留给界面算轮次计时）
        const startedAt = this.eventTs
        const call: ToolCallView = {
          callId: typeof event.callId === 'string' ? event.callId : '',
          name: typeof event.name === 'string' ? event.name : '',
          argsText: typeof event.args === 'string' ? event.args : '',
          status: 'running',
          // 重放老会话（eventTs 为 null）时拿不到发起时刻，干脆不写，界面据此降级
          ...(startedAt === null ? {} : { startedAt }),
        }
        // 子调用（PTC 的 sdk.xxx()）：收进父卡，不再各自成为一行顶层工具。
        // 父卡找不到（父还没落进 list、老日志、父条目已被换掉）就退回普通工具行——
        // 宁可平铺一行，也不能把这次调用整个吞掉。
        if (event.parentCallId !== undefined) {
          const parentIndex = this.toolIndex.get(event.parentCallId)
          const parent = parentIndex === undefined ? undefined : this.list[parentIndex]
          if (parentIndex !== undefined && parent !== undefined && parent.kind === 'tool') {
            const subCalls = [...(parent.call.subCalls ?? []), call]
            this.list[parentIndex] = this.stamp({
              ...parent,
              call: { ...parent.call, subCalls },
            })
            this.subCallIndex.set(event.callId, { parent: parentIndex, child: subCalls.length - 1 })
            return true
          }
        }
        // 流式期间为它报过「准备中」就接着用那一条的**时刻**：用户看到的是同一张卡从
        // 「准备读取文件」变成「正在读取文件」。dsh 的口径是「准备中的调用使用首个具名
        // delta 的时间」，所以 ts 用准备那一刻的。**id 不接**——准备中那条是直播尾（负 id），
        // 这里的正 id 必须当刻发，才能保证「id 序 = list 序 = 时间序」（见 `prepared` 的注释）。
        const prepared = this.takePrepared(event.name)
        this.list.push(
          prepared === undefined
            ? this.stamp({ kind: 'tool', id: this.seq++, call })
            : {
                kind: 'tool',
                id: this.seq++,
                call,
                ...(prepared.ts === null ? {} : { ts: prepared.ts }),
              },
        )
        this.toolIndex.set(event.callId, this.list.length - 1)
        return true
      }
      case 'tool/result': {
        // 子调用的结果：改父卡里那一格（它没有自己的顶层条目）。
        const child = this.subCallIndex.get(event.callId)
        if (child !== undefined) {
          const parent = this.list[child.parent]
          const current = parent?.kind === 'tool' ? parent.call.subCalls?.[child.child] : undefined
          if (parent !== undefined && parent.kind === 'tool' && current !== undefined) {
            const subCalls = [...(parent.call.subCalls ?? [])]
            subCalls[child.child] = {
              ...current,
              status: event.error === 'rejected' ? 'rejected' : event.error !== undefined ? 'failed' : 'done',
              resultText: truncate(event.text),
              ...(current.startedAt === undefined || this.eventTs === null || this.eventTs < current.startedAt
                ? {}
                : { durationMs: this.eventTs - current.startedAt }),
            }
            this.list[child.parent] = this.stamp({ ...parent, call: { ...parent.call, subCalls } })
            return true
          }
        }
        const index = this.toolIndex.get(event.callId)
        if (index === undefined) return false
        const previous = this.list[index] as ToolEntry
        const failed = event.error !== undefined && event.error !== 'rejected'
        // 时间戳跟着结果刷新：这张卡「最后一次写入」是拿到结果那一刻，
        // 界面按最后一条条目的 ts 算这一轮的结束时刻，刷新了才准
        const startedAt = previous.call.startedAt
        const arrivedAt = this.eventTs
        // 耗时 = 结果到达时刻 − 发起时刻。done / failed / rejected 一视同仁：跑挂了、
        // 被审批拒掉、用户打断的工具调用同样占用了这段时间（见 contract.ts 的口径）。
        // 两头缺一个就写不出来；结果时刻早于发起时刻（日志乱序）也不写，不编 0 秒。
        const durationMs =
          startedAt === undefined || arrivedAt === null || arrivedAt < startedAt
            ? undefined
            : arrivedAt - startedAt
        this.list[index] = this.stamp({
          ...previous,
          call: {
            ...previous.call,
            status: event.error === 'rejected' ? 'rejected' : failed ? 'failed' : 'done',
            resultText: truncate(event.text),
            ...(durationMs === undefined ? {} : { durationMs }),
          },
        })
        return true
      }
      case 'tool/changes': {
        // 一次成功 write / edit 的实际改动：独立条目（渲染层把同一轮的聚合成轮尾一张卡）。
        // 时间戳口径与工具卡一致：条目创建那一刻就是落盘完成那一刻。
        this.list.push(this.stamp({ kind: 'changes', id: this.seq++, file: event.change }))
        // 同一份改动按 callId 缝回对应的工具卡（`call.change`）：卡上的文件名要点开
        // 「这一刀改了什么」的补丁视图，工具卡只拿得到自己的 entry，靠这里把数据挂上去。
        const index = this.toolIndex.get(event.callId)
        const owner = index === undefined ? undefined : this.list[index]
        if (index !== undefined && owner !== undefined && owner.kind === 'tool') {
          this.list[index] = { ...owner, call: { ...owner.call, change: event.change } }
        }
        return true
      }
      case 'tool/presentation': {
        // dsh 插件的卡片数据：按 callId 缝回工具卡（界面按 card 标签挑形态）。
        // 不产生独立条目——它是这张卡的一种画法，不是又一条消息。
        const index = this.toolIndex.get(event.callId)
        const owner = index === undefined ? undefined : this.list[index]
        if (index !== undefined && owner !== undefined && owner.kind === 'tool') {
          this.list[index] = {
            ...owner,
            call: { ...owner.call, presentation: event.presentation as ToolPresentationView },
          }
        }
        return true
      }
      case 'turn/diff': {
        // 回合收尾的聚合改动（同文件多刀合一）：也是独立条目，渲染层优先拿它画轮尾卡。
        // 恢复会话的重放不重建它（纯内存条目不落盘），轮尾卡回退逐刀合并显示。
        this.list.push(this.stamp({ kind: 'turnDiff', id: this.seq++, files: event.files }))
        return true
      }
      case 'usage':
        this.usage = {
          inputTokens: this.usage.inputTokens + event.inputTokens,
          outputTokens: this.usage.outputTokens + event.outputTokens,
          // 缓存命中明细只在端点上报了的请求上累计：没上报的请求既不加命中也不加
          // 未命中，命中率才不会被稀释（口径与 core/usage-log 的 ch/cm 一致）。
          // 判据要看「这一笔没上报**且**之前也没累计过」才省略；只看这一笔就省略的话，
          // 同一会话里只要有一笔没上报，前面已累计的命中数会被这块新对象整个丢掉。
          ...(this.usage.cacheHitTokens === undefined &&
          event.cacheHitTokens === undefined &&
          event.cacheMissTokens === undefined
            ? {}
            : {
                cacheHitTokens: (this.usage.cacheHitTokens ?? 0) + (event.cacheHitTokens ?? 0),
                cacheMissTokens: (this.usage.cacheMissTokens ?? 0) + (event.cacheMissTokens ?? 0),
              }),
        }
        // 会话总量与本轮累计各记一份：前者给状态栏的会话累计，后者随条目送到界面
        this.turnUsage = {
          inputTokens: this.turnUsage.inputTokens + event.inputTokens,
          outputTokens: this.turnUsage.outputTokens + event.outputTokens,
          // 缓存两栏的口径与上面会话累计一致（同上：没上报的请求不清零已累计的数）。
          ...(this.turnUsage.cacheHitTokens === undefined &&
          event.cacheHitTokens === undefined &&
          event.cacheMissTokens === undefined
            ? {}
            : {
                cacheHitTokens: (this.turnUsage.cacheHitTokens ?? 0) + (event.cacheHitTokens ?? 0),
                cacheMissTokens: (this.turnUsage.cacheMissTokens ?? 0) + (event.cacheMissTokens ?? 0),
              }),
        }
        // context 条的权威占用读数 = 最近一次请求的 prompt_tokens（含缓存命中，
        // 服务端口径）；费用分桶按笔归属到请求当时的模型，峰谷看用量发生的时刻。
        this.contextUsed = event.inputTokens
        {
          const buckets = this.costBuckets.get(event.model ?? '') ?? emptyCostBuckets()
          addUsageToBuckets(buckets, event, isPeakHour(this.eventTs === null ? undefined : new Date(this.eventTs)))
          this.costBuckets.set(event.model ?? '', buckets)
        }
        return true
      case 'context':
        this.contextSegments = { ...event.segments }
        return true
      case 'subagent': {
        // 同名原位更新（dsh SubagentRow 的 upsert 语义）：React key 不换，卡片就地刷新
        const index = this.subagentIndex.get(event.row.name)
        const previous = index === undefined ? undefined : this.list[index]
        if (previous !== undefined && previous.kind === 'subagent') {
          this.list[index!] = { ...previous, sub: event.row, ...(this.eventTs === null ? {} : { ts: this.eventTs }) }
          return true
        }
        this.list.push(this.stamp({ kind: 'subagent', id: this.seq++, sub: event.row }))
        this.subagentIndex.set(event.row.name, this.list.length - 1)
        return true
      }
      case 'prompt/used': {
        // 同一版提示连发几轮（一次请求一条事件）不各占一张卡：hash 一样就原地刷时刻。
        // 比较的是**上一条同 kind 的条目**、不是紧邻的那一条——同一轮里中间会插进正文与
        // 工具行，只看紧邻的会让每一步都新长一张卡。内容一样就不换视图对象（同一版提示的
        // 段清单必然一样），只把「最后一次写入」的时刻往前挪，折叠态因此不会重置。
        const at = this.lastIndexOfKind('system-prompt')
        const previous = at >= 0 ? this.list[at] : undefined
        if (previous !== undefined && previous.kind === 'system-prompt' && previous.prompt.hash === event.prompt.hash) {
          this.list[at] = this.stamp({ ...previous })
          return true
        }
        this.list.push(this.stamp({ kind: 'system-prompt', id: this.seq++, prompt: event.prompt }))
        return true
      }
      case 'context/injected': {
        // 注入清单在一轮里会随每一步请求重复上报：同一种组合只留一张卡，重复出现时刷新
        // 时刻、把次数 +1。空清单不建条目——那只是因为这一轮什么都没注入。
        //
        // 为什么合并放在这一层、不去改那些投影（packages/prompt）：投影每跳照旧上报，
        // 它记的是「这一跳真的往请求里塞了什么」这一条独立事实；「同一份清单在一轮里重复
        // 了几次」是账本口径，只有看得到整条条目流的地方才算得出来。把两者混进投影，
        // 事实层就再也回答不了「第 7 跳到底注入了什么」。
        if (event.parts.length === 0) return false
        const at = this.indexOfInjectionInTurn(event.parts)
        const previous = at >= 0 ? this.list[at] : undefined
        if (previous !== undefined && previous.kind === 'context-injection') {
          // 次数不算「内容」（见 packages/transcript 的 sameEntries），所以这里必须换一个
          // **新对象**：同一个引用会被快照缓存与 React 判成「这一条没变」，界面上的次数
          // 就不会刷新。id / parts 原样保留，React 的 key 不换、展开态也不重置。
          this.list[at] = this.stamp({ ...previous, count: (previous.count ?? 1) + 1 })
          return true
        }
        this.list.push(this.stamp({ kind: 'context-injection', id: this.seq++, parts: event.parts }))
        return true
      }
      case 'error':
        this.system(`错误：${event.message}`, false, 'error')
        return true
      case 'turn/start':
        // 快照的 turnState 完全由事件驱动（inTurn），事件发出即通知重算。
        this.working = false
        this.inTurn = true
        return true
      case 'turn/end': {
        const hadLive = this.segments.length > 0
        this.segments = []
        this.working = false
        this.inTurn = false
        this.stampTurnUsage()
        // 轮尾标记：把「这一轮为什么结束」记成一条独立条目（对照 dsh 的 turn.end.reason
        // 与 turn-error 节点）。为什么要落成条目：整轮折叠有两条规矩要读它——中断或失败的轮
        // 不折整轮，开关行还要显示「已停止 / 过程失败」。这两件事都发生在轮**结束之后**，
        // 「当前回合状态」那份快照表达不出来（它那时已经是 idle 了）。
        // 正常结束（completed）不落条目：那时渲染层没什么可判的，多一条只会让订阅者白重算。
        if (event.reason !== 'completed') {
          this.list.push(this.stamp({ kind: 'turn-end', id: this.seq++, reason: event.reason }))
          // 这一轮以中断 / 失败收尾：还没拿到结果的工具行不会再等到结果了，落成中止态
          // （界面不再一直显示「进行中」）。正常结束（completed）一个都不动——那时每一条
          // 都已经配上了结果，本来就没有可落的行。
          this.settleUnfinishedTools()
        }
        // 到这里这一轮所有 tool/call 都已经发过了（loop 是等工具跑完才进下一跳），
        // 还挂在「准备中」的就是「吐了名字、最后没调」的那些，清掉。
        this.dropPrepared()
        return true
      }
      // 收件箱变了（入箱 / 编辑 / 删除 / 提前）：不产生条目，但要让快照失效——
      // 排队的输入画在输入框下方的队列条里，数据来自快照的 `queued`。
      case 'inbox':
        return true
      default:
        return false
    }
  }

  /** 追加到同类型尾段，否则开新段。 */
  private appendSegment(kind: LiveSegment['kind'], text: string): void {
    const ts = this.eventTs ?? Date.now()
    const last = this.segments[this.segments.length - 1]
    if (last !== undefined && last.kind === kind) {
      last.text += text
      last.ts = ts
    } else {
      // 思考段记下第一口 delta 的时刻：定稿时算耗时，直播时算「已思考 Ns」
      this.segments.push({ kind, text, ts, ...(kind === 'thinking' ? { startedAt: ts } : {}) })
    }
  }

  /**
   * 定稿文本：合并进相邻的最后一个 text 条目。
   * 顺带盖本轮累计 usage：同一轮里后一条 message 覆盖前一条的累计值（累计在涨），
   * 界面取轮内最后一条 text 就是整轮消耗。
   */
  private pushAssistantText(text: string): void {
    const last = this.list[this.list.length - 1]
    if (last !== undefined && last.kind === 'text') {
      // 合并时刷新时间：这条条目最后一次写入就是现在，界面按它算这一轮何时结束
      this.list[this.list.length - 1] = this.stamp({
        ...last,
        text: `${last.text}\n${text}`,
        ...this.turnUsageField(),
      })
      return
    }
    this.list.push(this.stamp({ kind: 'text', id: this.seq++, text, ...this.turnUsageField() }))
  }

  /** 定稿思考：合并进相邻的最后一个 thinking 条目（折叠展示）。 */
  private pushThinking(text: string, durationMs?: number): void {
    const last = this.list[this.list.length - 1]
    if (last !== undefined && last.kind === 'thinking') {
      this.list[this.list.length - 1] = this.stamp({
        ...last,
        text: `${last.text}\n${text}`,
        ...(durationMs === undefined ? {} : { durationMs }),
      })
      return
    }
    this.list.push(this.stamp({ kind: 'thinking', id: this.seq++, text, ...(durationMs === undefined ? {} : { durationMs }) }))
  }
}

const truncate = (text: string): string =>
  text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text

// errText 的正主在 core/err-text（渲染层只能 import 纯 core 模块，内核不能反向 import
// adapter）；这里保留同名 re-export，既有 import 不断。
export { errText } from '../core/err-text.js'
