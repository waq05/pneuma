/**
 * 折叠条的展开状态存档（进程内，刷新即清；桌面渲染层 `fold-state.ts` 的同构移植）。
 *
 * 为什么要从组件里搬出来：会话切换时宿主会重放历史、条目 id 重新发号，React 按 `key`
 * 对账时会把用不上的组件卸载重挂。而工具卡 / 思考块的展开态本来只活在各自的 `useState`
 * 里，一重挂就回默认——用户展开两条工具卡、切到别的会话看一眼再切回来，展开状态就没了。
 *
 * 存档键里带会话 id 与条目序号：同一会话的历史条目重挂时能读回原状态，不同会话天然
 * 不串味（两条会话的条目 id 都是从 1 开始的，只按 id 存会把别人的展开态借过来）。
 *
 * @module dsc-ui-shell/plugins/transcript/fold-state
 */

const folds = new Map<string, boolean>()

/** 读一条存档；没有记录 / 键缺席时给调用方的兜底默认态。 */
export function readFold(key: string | undefined, fallback: boolean): boolean {
  if (key === undefined) return fallback
  return folds.get(key) ?? fallback
}

/** 写一条存档（undefined 键 = 这个视图不存档，空操作）。 */
export function writeFold(key: string | undefined, open: boolean): void {
  if (key === undefined) return
  folds.set(key, open)
}
