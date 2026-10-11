/**
 * React 绑定：把槽位注册表接到 React 的订阅模型上。
 *
 * 订阅逻辑（useSlot / useSlotFaults）已下沉到共享层（`@dsc/ui-core` 的
 * `slots-react.ts`——终端壳要用同一份语义）；这里留的是**浏览器壳自己的渲染出口**：
 * 条目外层套 `<div class="slot-entry">`（自检脚本靠它认块），崩溃视图也是 DOM。
 *
 * 装配错误（壳与插件的契约没对上，例如渲染一个没声明过的子槽）不在此列：那种必须炸出来。
 *
 * @module dsc-ui-shell/slots-react
 */
import { Component, useCallback, useMemo, type ReactNode } from 'react'
import { SlotAssemblyError, useSlot, type SlotEntry } from '@dsc/ui-core'
import type { SlotRenderApi, UiComponent, UiSlots } from './plugin-api'

/** 渲染位置不关心 owner 值时共用这一个空对象。 */
const NO_OWNER: Readonly<Record<string, never>> = Object.freeze({})

export { useSlot, useSlotFaults } from '@dsc/ui-core'

/**
 * 渲染一个槽里的全部条目。
 * @param slots - 注册表
 * @param slot - 槽名
 * @param owner - 交给每个条目的位置参数（例如「我在渲染哪条消息」），展开在组件 props 顶层
 */
export function SlotOutlet({
  slots,
  slot,
  owner,
}: {
  slots: UiSlots
  slot: string
  owner?: Record<string, unknown>
}): ReactNode {
  const entries = useSlot(slots, slot)
  return (
    <>
      {entries.map((entry) => (
        // key 里带上格子的三名候选信息：条目被遮蔽或退位后顶上来的那一份必须换一个
        // 边界实例，否则上一份留在错误状态里的边界会把新的健康实现也黑着。
        <SlotEntryHost
          key={`${entry.cell}|${entry.id}|${String(entry.priority)}|${String(entry.seq)}`}
          slots={slots}
          entry={entry}
          owner={owner ?? NO_OWNER}
        />
      ))}
    </>
  )
}

/**
 * 渲染一个 chain 槽：为这份 owner 值选出渲染者并挂载它。
 *
 * 与 SlotOutlet 的差别：chain 槽每一份 owner 只该由**一个**当选者渲染（选举语义），
 * 全体弃权返回 null——兜底由调用方画（`renderSlot(...) ?? <兜底>`）。
 * 订阅照走 useSlot：登记增减、退位都会换快照引用，选举在下一帧重跑。
 */
export function ChainOutlet({
  slots,
  slot,
  owner,
}: {
  slots: UiSlots
  slot: string
  owner: Record<string, unknown>
}): ReactNode {
  useSlot(slots, slot)
  const hit = slots.elect(slot, owner)
  if (hit === null) return null
  return (
    <SlotEntryHost
      key={`${hit.entry.cell}|${hit.entry.id}|${String(hit.entry.priority)}|${String(hit.entry.seq)}`}
      slots={slots}
      entry={hit.entry}
      owner={{ ...owner, matched: hit.matched }}
    />
  )
}

/** 单条登记：套错误边界、注入渲染能力、带上 data 属性（自检脚本靠它认块）。 */
function SlotEntryHost({
  slots,
  entry,
  owner,
}: {
  slots: UiSlots
  entry: SlotEntry<UiComponent>
  owner: Record<string, unknown>
}): ReactNode {
  const Component_ = entry.component
  const renderSlot = useCallback(
    (name: string, props?: Record<string, unknown>): ReactNode => {
      if (!entry.children.includes(name)) {
        throw new SlotAssemblyError(
          `条目 ${entry.slot}/${entry.id} 没有声明子槽「${name}」` +
            `（声明过的：${entry.children.length === 0 ? '无' : entry.children.join('、')}）`,
        )
      }
      // chain 子槽走选举（一个 owner 只有一个当选者），其余形态全量渲染。
      return slots.spec(name) === 'chain' ? (
        <ChainOutlet slots={slots} slot={name} owner={props ?? NO_OWNER} />
      ) : (
        <SlotOutlet slots={slots} slot={name} owner={props ?? NO_OWNER} />
      )
    },
    [slots, entry],
  )
  const api = useMemo<SlotRenderApi>(
    () => ({ renderSlot, childSlots: entry.children }),
    [renderSlot, entry.children],
  )
  return (
    <SlotErrorBoundary
      slot={entry.slot}
      id={entry.id}
      onFault={(error) => {
        slots.reportFault(entry, error)
      }}
    >
      <div className="slot-entry" data-slot={entry.slot} data-entry={entry.id} data-cell={entry.cell}>
        <Component_ {...owner} {...api} />
      </div>
    </SlotErrorBoundary>
  )
}

/** 一个槽条目的错误边界：拦下渲染期异常，上报并让这个条目退位。 */
class SlotErrorBoundary extends Component<
  { slot: string; id: string; onFault: (error: unknown) => void; children: ReactNode },
  { error: string | null }
> {
  constructor(props: { slot: string; id: string; onFault: (error: unknown) => void; children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    // 装配错误不是「某个插件坏了」，是壳和插件的契约没对上：必须往上炸，
    // 否则会被画成一句看起来像插件 bug 的文案，排查方向从一开始就是歪的。
    if (error instanceof SlotAssemblyError) throw error
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onFault(error)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="slot-crash" data-slot={this.props.slot} data-entry={this.props.id}>
          界面块 {this.props.id} 渲染失败：{this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}
