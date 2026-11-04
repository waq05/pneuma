/**
 * 会话分页的纯逻辑：从尾部往前攒一页「至少 50 条、至少 2 轮、最多 500 条」的窗口，
 * 边界永远落在轮起点上。
 *
 * 为什么口径是**条目数**而不是轮数：dsc 的会话数据本来就是一次全量读进内存的
 * （宿主 `Session.load` 读整个 jsonl，那份数据同时是模型上下文），分页分的只是
 * **渲染量**——长会话拖慢首屏的是 DOM 数量，而 DOM 的大头不是轮数，是一轮里压着的
 * 几十上百个过程条目（工具调用 + 思考 + 正文）。按轮分页挡不住「单轮极长」，
 * 所以这里跟 dsh 对齐成条目数口径。
 *
 * 对照 dsh：`packages/api/session-controller/src/history.ts:392` 的 `paginate`
 * （从尾往前累计，跨过 2 个 turn/start 且够 50 条消息后切；或到 500 条硬上限切，
 * `hasMore: cut > 0`）配 `session.ts:52` 的 `PAGE_MESSAGES = 50` 与
 * `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`。
 * 那边在服务端切数据（切点允许落在消息组边界），我们这边数据不动，只切**画不画**，
 * 所以边界改成概念上更严格的「轮起点」：一轮的条目绝不会被拆到两页里。
 *
 * 零 React、零 DOM：`scripts/ui-paging-test.mjs` 按 Node 的类型擦除直接 import 这个
 * .ts 逐条钉（同 `status/status-model.ts` 的探针口径），所以这里没有运行期依赖。
 *
 * @module dsc-ui-shell/plugins/transcript/paging
 */

/** 一页最少条目数（dsh `HISTORY_PAGE_OPTIONS.turnWindow.minMessages`）。 */
export const PAGE_MIN_ENTRIES = 50

/** 一页最少轮数（dsh 同款 `minTurns`）：与条目数地板是「都满足才算攒够」。 */
export const PAGE_MIN_ROUNDS = 2

/** 一页硬上限条目数（dsh 的 `maxMessages: 500`）。 */
export const PAGE_MAX_ENTRIES = 500

/**
 * 从 `beforeRound` 起**往前**攒一页，返回新的起始轮号（0 基）。
 *
 * 返回的轮号 r 表示「r 及以后的轮都画出来」——`visible = rounds.slice(r)`。
 *
 * 三条收口规矩（对照 dsh `paginate` 的 break 条件）：
 *
 *   1. **地板**：`≥ {@link PAGE_MIN_ENTRIES} 条` **且** `≥ {@link PAGE_MIN_ROUNDS} 轮`
 *      才算攒够，只够一项就继续往前收（dsh 的判定同样是 `count >= minMessages &&
 *      turns >= minTurns` 两个条件都到才切）。为什么两项都要：条目数保证「一页有
 *      足够可读的内容」，轮数保证「一页有完整的对话往复」——只有 51 条但全是同一轮
 *      的过程条目，翻过去看到的是一堆没有上下文的碎片。
 *   2. **天花板**：再收一轮会顶破 {@link PAGE_MAX_ENTRIES} 就先收口——宁可这一页
 *      比地板小（甚至连 2 轮都不到），也绝不把一轮拆成两页（拆开的那半轮没有自己的
 *      题面，翻上去会像「内容从半截开始」）。**唯一的例外**是单轮自身就超过上限：
 *      那时不收就没得收了，只能整轮放进来（这一页会超 500 条；该轮的 DOM 量由轮内的
 *      阶段组限高顶着，见 ui.tsx 里 StepGroupSeat 的组体）。这条例外在 dsh 那边的
 *      等价物是 `groupStart` 收口——它宁可把一次工具调用的整组消息放进来，也不从
 *      组中间切开。
 *   3. **到顶**：`beforeRound` 已到 0（或本来就没有可收的轮）时原样返回 0——
 *      界面据此不画「加载更早」（`firstVisible > 0` 才画）。
 *
 * @param roundSizes  每一轮的条目数（下标 = 轮号，0 基）
 * @param beforeRound 当前窗口的起点（不含）：只收它**前面**的轮
 * @returns 新的起始轮号（`0 ≤ r ≤ beforeRound`；没得收就返回 `beforeRound`）
 */
export function pageStartRound(roundSizes: readonly number[], beforeRound: number): number {
  let start = beforeRound
  let entries = 0
  let rounds = 0
  for (let index = beforeRound - 1; index >= 0; index -= 1) {
    const size = roundSizes[index] ?? 0
    // 天花板先于地板收口：再收一轮会超上限就不收（见规矩 2 的「宁可提前收口」）。
    // `entries > 0` 这一半是单轮超上限的例外——一次都没收过就必须收，否则会返回一个空页。
    if (entries > 0 && entries + size > PAGE_MAX_ENTRIES) break
    start = index
    entries += size
    rounds += 1
    // 顶到硬上限就切（单轮超上限、或正好收满 500 条这两条路会走到这里）。
    if (entries >= PAGE_MAX_ENTRIES) break
    // 两项地板都到才切。
    if (entries >= PAGE_MIN_ENTRIES && rounds >= PAGE_MIN_ROUNDS) break
  }
  return start
}
