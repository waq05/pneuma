/**
 * 槽位契约的类型探针（D1 验收项 3：插件把 props 用错，`tsc` 报错）。
 *
 * 这个文件**不进任何 bundle**：build-plugins 的入口写死为 `src/plugins/<id>/ui.tsx`，
 * 这里的 `ui` 是 `declare const`（没有运行期），组件也没有任何注册动作真的发生；
 * 它只被 `ui-shell/tsconfig.json` 的 include 吸入 `pnpm -C ui-shell typecheck`。
 *
 * 负例用 `@ts-expect-error` 钉住：一旦契约松掉（负例不再报错），TS 会抛出
 * 「Unused '@ts-expect-error' directive」——负例因此是双向的（既防漏报，也防误删）。
 *
 * @module dsc-ui-shell/slot-contract.typecheck
 */
import type { ReactNode } from 'react'
import type { SlotComponentProps, SlotMatchedOf, SlotOwnerOf, UiPluginApi } from './plugin-api'

declare const ui: UiPluginApi
/** transcript 插件声明的 chain 槽：owner / matched 都是从 SlotMap 推出来的。 */
declare const toolOwner: SlotOwnerOf<'transcript.toolview'>
declare const toolMatched: SlotMatchedOf<'transcript.toolview'>

// ── 负例：每一条都必须报错 ───────────────────────────────────────────────────────

// @ts-expect-error 槽名不在 SlotMap
ui.slots.register('shell.nope', { id: 'x' }, () => null)
// @ts-expect-error owner props 形状不对（shell.main 没有 owner 键）
ui.slots.register('shell.main', { id: 'x' }, (props: { nope: number }) => { void props; return null })
// @ts-expect-error chain 登记必须给 select
ui.slots.register('transcript.toolview', { id: 'x' }, () => null)
// @ts-expect-error chain 的 select 返回类型与 matched 不一致（ToolMatch 之外）
ui.slots.register('transcript.toolview', { id: 'x', select: () => 1 }, () => null)
// @ts-expect-error children 声明了未在 SlotMap 的槽
ui.slots.register('shell.main', { id: 'x', children: { 'no.such': 'list' } }, () => null)
// @ts-expect-error 非 chain 槽不接受 select
ui.slots.register('shell.main', { id: 'x', select: () => null }, () => null)
// @ts-expect-error chain 槽的组件 props（matched: number）与表里的 matched 不符
ui.slots.register('transcript.toolview', { id: 'x', select: () => toolMatched }, (props: { matched: number }) => { void props; return null })

/** 故意写错的子槽消费：renderSlot 的 props 与子槽 owner 不符。 */
function BadChild(props: SlotComponentProps<Record<never, never>, 'transcript.toolview'>): ReactNode {
  // @ts-expect-error renderSlot 的 props 与子槽 owner 不符
  props.renderSlot('transcript.toolview', { nope: 1 })
  return null
}
void BadChild

/** 没有声明子槽的组件：renderSlot 的键集为空，写任何名字都错。 */
function PlainChild(props: SlotComponentProps): ReactNode {
  // @ts-expect-error 没声明子槽就不能 renderSlot 具体槽名
  props.renderSlot('transcript.toolview', toolOwner)
  return null
}
void PlainChild

// ── 正例：真实内置登记的写法，保持常绿 ───────────────────────────────────────────

/** 15 条零参组件（composer/statusbar/sessions 那批）的写法。 */
ui.slots.register('shell.main', { id: 'probe.ok', order: 10 }, () => null)

/** #16 transcript 的形状：声明 chain 子槽、对子槽按 owner 份额 renderSlot。 */
function ToolFlowLike(props: SlotComponentProps<Record<never, never>, 'transcript.toolview'>): ReactNode {
  return props.renderSlot('transcript.toolview', toolOwner)
}
ui.slots.register(
  'shell.main',
  { id: 'probe.flow', order: 1, children: { 'transcript.toolview': 'chain' } },
  ToolFlowLike,
)

/** #17 transcript chain 的形状：typed select + 当选组件收 matched。 */
function ToolPicker(props: SlotComponentProps<SlotOwnerOf<'transcript.toolview'>, never, SlotMatchedOf<'transcript.toolview'>>): ReactNode {
  void props.entry
  void props.matched
  void props.storeKey
  return null
}
ui.slots.register(
  'transcript.toolview',
  { id: 'probe.toolview', priority: 100, select: (owner) => (owner.storeKey === 'skip' ? null : toolMatched) },
  ToolPicker,
)

/** 组件收到 owner 份额是允许直接解构的（props 是类型化对象，不是 unknown）。 */
function OwnerReader(props: SlotComponentProps<SlotOwnerOf<'transcript.toolview'>>): ReactNode {
  void props.entry
  void props.childSlots
  return null
}
void OwnerReader
