/**
 * 分轮口径的**唯一真值**：把一份条目切成「轮」与「座位」两半，且保证两半的下标永远一一对应。
 *
 * 为什么要有这个模块：过去壳里有**两套**分轮实现，它们对「插话（steering）」的看法不同——
 *   - `timing.ts` 的 `roundInfos`：`steering === true` 的条目留在原轮、不开新轮；
 *   - `ui.tsx` 的 `buildSeats`：只看 `kind === 'user'` 就开新座位，**没看 steering**。
 * 于是用户中途 Ctrl+Enter 插一句、或队友汇报在步骤边界并进本轮时，座位数比轮数多一份，
 * 拿座位序号去索引 `roundInfos`（`rounds[seat.round]`）就整体错开——每轮的用时 / 折叠 /
 * 「进行中」判定全偏移，右侧刻度条也多出一枚刻度。现在两边都改为调本模块，一份口径只有一处。
 *
 * 规则（1、2 与 dsh 对齐；3 是 2026-11 用户拍板的口径，比 dsh 少一枚刻度）：
 *   1. **只有人发的 `kind === 'user'` 才可能开新轮**（这条决定刻度数）；
 *   2. `steering === true` 且已有当前轮 → 归入当前轮，**不开新座位**；
 *   3. `internal === true`（非人发起的唤醒，如队友 `<teammate-report>` 汇报、后台作业完成
 *      通知）**从不开新轮**——它是机器代投的一段话，不是人起的一轮，单独成轮会在刻度条上
 *      多一枚、还挂一行「用时」：
 *      - 前面已有轮 → 并进当前轮（与规则 2 同一套处理：推进 `endIndex` / `endTs`）；
 *      - 前面没有任何轮（会话第一条就是通知）→ 归 leading 开场段，不造空轮，
 *        否则座位切片会整体错位（座位是从轮起点到下一条轮起点之前的连续区间）。
 *      题面预览仍不给原文（见 {@link teammateReportLabel}）。
 *
 * 时间戳的读法就地内联一份（等价于 `@dsc/ui-primitives` 的 `entryTs`：有限正数才认），
 * 但**文案走本包字典**（`locale/ui.zh.json` + `createT`）——于是本文件有了运行期 import，
 * 不再能被 Node 的类型擦除直读（`scripts/ui-transcript-render-test.mjs` 那一段要改走产物）。
 *
 * @module dsc-ui-shell/plugins/transcript/rounds
 */
import { createT, type TranscriptEntry } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 一轮对话：一条用户消息 → 模型回复结束（中间的工具调用也算这一轮）。
 * 形状与旧 `timing.ts` 的 `RoundInfo` 逐字一致（那份现在从这里 re-export，调用点不变）。
 */
export interface RoundInfo {
  /** 轮次编号（0 基，与右缘刻度一一对应）。 */
  index: number
  /** 用户消息在 entries 里的下标（跳转锚点就是它）。 */
  startIndex: number
  /** 这一轮最后一条条目在 entries 里的下标（还没回复时等于 startIndex）。 */
  endIndex: number
  /** 用户消息那一刻；缺 ts → null。 */
  startTs: number | null
  /**
   * 这一轮的结束时刻：从末条目往前走，取最后一条带 ts 的条目（中间缺 ts 的跳过）。
   * 一条都没带 ts → null，界面降级成「只显示开始时间」。
   */
  endTs: number | null
  /** 这一轮有没有助手侧的内容（回复、思考、工具卡都算）。 */
  answered: boolean
}

/** 一个座位：与一轮一一对应（`round` 恒等于 `RoundInfo.index`）。 */
export interface RoundSeat {
  /** 座位序号（0 基）——与 {@link RoundInfo.index} 同一份数字。 */
  round: number
  /** 这个座位收的条目下标（升序，`entries` 里的绝对下标）。 */
  indices: number[]
}

/** `splitRounds` 的产物：轮的元信息 + 座位切分 + 还没进任何一轮的前导下标。 */
export interface RoundSplit {
  /** 轮次元信息，下标 = 轮号（0 基）。 */
  rounds: RoundInfo[]
  /** 座位切分，与 `rounds` 一一对应（同长、同序）。 */
  seats: RoundSeat[]
  /** 前导条目下标（开场 system 提示这类，任何一轮之前）。 */
  leading: number[]
}

/**
 * 取条目上可信的时间戳；没有或不是有限正数就是 null。
 *
 * 就地内联一份 `@dsc/ui-primitives` 的 `entryTs`（见模块头：本模块不许有运行期 import）。
 * 两处口径必须一致——那边改这里也要改。
 */
function tsOf(entry: TranscriptEntry): number | null {
  const ts = entry.ts
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null
}

/**
 * 把 entries 切成一轮一轮，**同时**给出座位切分。
 *
 * 分轮规则与旧 `timing.ts:roundInfos` 完全一致（那套是对的），座位切分按同一套规则推出，
 * 于是座位序号与 `RoundInfo` 下标**结构上不可能错开**。
 *
 * 两类条目不参与「这一轮有几条、到哪结束」：开场那条 system 提示、轮次之后冒出来的
 * system 条目（错误、宿主通知），以及两张请求侧的账单卡（`system-prompt` /
 * `context-injection`，2026-11-10 起）。**轮中途插话**（steering）与**机器投递的条目**（internal）
 * 都不另起一轮，留在原轮里。
 */
export function splitRounds(entries: readonly TranscriptEntry[]): RoundSplit {
  const rounds: RoundInfo[] = []
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') {
      const current = rounds[rounds.length - 1]
      // 插话、以及机器投递的条目（internal）并进当前轮，不新开座位（规则 2 / 3）。
      if ((entry.steering === true || entry.internal === true) && current !== undefined) {
        current.endIndex = index
        const mergedTs = tsOf(entry)
        if (mergedTs !== null) current.endTs = mergedTs
        return
      }
      // 机器投递的条目前面还没有任何一轮（会话第一条就是通知）：留给 leading 开场段，
      // 不造空轮——座位是连续切片，凭空插一轮会让后面每个座位的下标整体错位。
      if (entry.internal === true) return
      // 其余人发的 user 条目都开新轮（规则 1）。
      rounds.push({
        index: rounds.length,
        startIndex: index,
        endIndex: index,
        startTs: tsOf(entry),
        endTs: null,
        answered: false,
      })
      return
    }
    const current = rounds[rounds.length - 1]
    // 开场 / 轮首冒出来的「请求账单」不推进轮尾，也不改「这一轮答没答」：
    // - system：错误、宿主通知、「已恢复会话」；
    // - system-prompt / context-injection（2026-11-10 加）：请求侧的两张卡。它们写在
    //   请求组装那一刻，**开场第一件事**就可能是发一次请求（一条注入卡），而它们不是回答。
    //   原来这里只放过 system，于是开场那条注入会把 answered 直接置真、endIndex 也推到它——
    //   界面据此认为「这一轮已经答完了」，整轮折叠、轮尾用时、跑动状态全都判错。
    if (current === undefined || entry.kind === 'system' || entry.kind === 'system-prompt'
      || entry.kind === 'context-injection') return
    current.endIndex = index
    current.answered = true
    const ts = tsOf(entry)
    if (ts !== null) current.endTs = ts
  })
  for (const round of rounds) {
    // 结束时刻早于开始时刻说明日志时间乱序：按「拿不到」处理，界面只显示开始时间。
    if (round.endTs !== null && round.startTs !== null && round.endTs < round.startTs) round.endTs = null
  }

  // 座位 = 从这一轮的开轮条目起，到下一条开轮条目之前（连续区间）。system 条目夹在中间也
  // 归前一个座位（旧 buildSeats 就是把它推给当前座位），所以座位是 `entries` 的连续切片。
  const seats: RoundSeat[] = rounds.map((round, i) => {
    const next = rounds[i + 1]
    const stop = next === undefined ? entries.length - 1 : next.startIndex - 1
    const indices: number[] = []
    for (let at = round.startIndex; at <= stop; at += 1) indices.push(at)
    return { round: round.index, indices }
  })
  const firstStart = rounds[0]?.startIndex ?? entries.length
  const leading: number[] = []
  for (let at = 0; at < firstStart; at += 1) leading.push(at)
  return { rounds, seats, leading }
}

/**
 * `timing.ts` 的同名导出转出的实现（保持调用点与签名不变）：只关心轮元信息的调用方
 * （折叠、分页、轨迹页）继续用这个；要座位切分的用 {@link splitRounds}。
 */
export function roundInfos(entries: readonly TranscriptEntry[]): RoundInfo[] {
  return splitRounds(entries).rounds
}

/** 队友汇报正文的固定开头（与宿主 `src/core/team-board.ts` 的 `TEAMMATE_REPORT_OPEN` 同字面量）。 */
const TEAMMATE_REPORT_OPEN = '<teammate-report '

/** 队友汇报头里解出来的字段；头行之外（正文）不解析。 */
export interface TeammateReport {
  /** `from="…"` 里的队友名；头里没有就是 null。 */
  from: string | null
  /** `state="…"`（已完成 / 已停止 / 已失败）；头里没有就是 null。 */
  state: string | null
}

/**
 * 认出队友汇报并解出队友名 / 状态（纯函数，探针直读）。
 *
 * 正文形状（`src/packages/subagent/index.ts:517` 造）：
 * ```
 * <teammate-report from="mate-1" role="…" state="已完成">
 * 派给它的任务：…
 * 它的汇报：
 * …
 * </teammate-report>
 * ```
 * 只在**开标签**里取（截到第一个 `>` 为止），避免正文里恰好有 `from="…"`（比如
 * `<message from="…">`）被误取。认不出（不以固定开头起头）返回 null。
 */
export function teammateReport(text: string): TeammateReport | null {
  if (!text.startsWith(TEAMMATE_REPORT_OPEN)) return null
  const close = text.indexOf('>')
  const head = close === -1 ? text : text.slice(0, close)
  const from = /\bfrom="([^"]*)"/.exec(head)?.[1] ?? null
  const state = /\bstate="([^"]*)"/.exec(head)?.[1] ?? null
  return { from, state }
}

/**
 * 队友汇报的人话标签：刻度条悬停卡与对话里的触发行共用同一句（一份口径只此一处）。
 *
 * 为什么不让调用方各自拼：题面预览、aria-label、触发行文案必须说同一件事——队友名或状态
 * 任一处改了读法，三处一起变，不会出现「刻度说 mate-1、行里说 mate-2」。
 * 认不出的返回一句通用话，**绝不把原文（`<teammate-report …>`）当题面**。
 */
export function teammateReportLabel(text: string): string {
  const report = teammateReport(text)
  if (report === null) return t('transcript.internal.subtaskReport')
  const who =
    report.from === null || report.from === ''
      ? t('transcript.internal.teammate')
      : t('transcript.internal.teammateNamed', { name: report.from })
  // i18n-keep：这两个值是**宿主写进汇报头的协议值**（src/packages/subagent/index.ts 的
  // '已完成' / '已停止' / '已失败'），不是界面文案——翻成英文就和宿主对不上，动词会永远落到
  // 「汇报了运行结果」。要它们跟着语言走，得先让宿主发机器可读的 state。
  const verb =
    report.state === '已失败' // i18n-keep
      ? t('transcript.internal.failed')
      : report.state === '已停止' // i18n-keep
        ? t('transcript.internal.stopped')
        : t('transcript.internal.reported')
  return `${who} ${verb}`
}

/**
 * 内部触发行的一句话标签：机器投递进来的消息（`internal`）在对话页不画成气泡，只画一行。
 *
 * 为什么要按类型分：这条行里**只有**这一句话，用户扫过去就得知道「刚刚发生了什么」——
 * 全都写「子任务汇报」会把后台作业完成、定时任务投递这类通知说成队友汇报，读错人。
 *
 * 认法只能靠正文：界面拿到的条目只有 `internal` 这一个标记，没有「谁发的」这个字段；
 * 宿主投递作业通知时也没写前缀（与队友汇报不同）。所以这里按正文形状分三档：
 *   1. `<teammate-report …>`：沿用队友汇报的标签（findings 更早一步就解析成卡片了，
 *      根本走不到这里）；
 *   2. `后台作业 job-N（命令）成功完成 / 失败（退出码 N）/ 启动失败：…`：宿主
 *      `core/tools/bash.ts` 的完成通知，取出作业号与成败；
 *   3. 其余（定时补投 / 目标续跑 / 记忆复盘……）：一句通用话。
 * 认不出的绝不把原文当标签（原文整段挂在 title 上，要看悬停）。
 */
export function internalLabel(text: string): string {
  // findings（`<review-findings …>`）在 user-row 里更早一步被解析成卡片，走不到这里，
  // 所以这里只认队友汇报这一种前缀。
  if (text.startsWith(TEAMMATE_REPORT_OPEN)) return teammateReportLabel(text)
  const job = /^后台作业\s+(\S+?)\s*(（|\(|启动失败|成功|失败)/.exec(text)
  if (job !== null) {
    const id = job[1] ?? ''
    // i18n-keep：判的是宿主后台作业通知的中文正文（core/tools/bash.ts 拼的原文），同上。
    const failed = text.includes('失败') // i18n-keep
    return failed
      ? t('transcript.internal.jobFailed', { id })
      : t('transcript.internal.jobDone', { id })
  }
  return t('transcript.internal.runtimeNotice')
}
