/**
 * 吞吐读数的口径（界面侧出口）。
 *
 * 原件是宿主的 `core/throughput.ts`：状态栏此前把这三个函数照抄了一份（注释里还写着
 * 「同 core/throughput.ts」），口径改一次要改两处。按平台种子规则，界面插件不直接引 core，
 * 这里从 `@dsc/ui-core` 转出——实现仍只有宿主那一份。
 *
 * 入参是结构类型（只要 `decodeMs` / `decodeTokens` 这类字段），宿主的 `ThroughputTotals`
 * 与界面拿到的 `SessionUsageView` 都能直接传。
 *
 * @module dsc-ui-shell/ui-primitives/throughput
 */

export { averageTtftMs, formatTokensPerSecond, tokensPerSecond } from '@dsc/ui-core'
