/**
 * React 绑定：把槽位注册表接到 React 的订阅模型上。
 *
 * 要点只有一条：`useSyncExternalStore` 的快照必须**引用稳定**，否则每次渲染都被判成
 * 「变了」，界面掉进无限重渲染。快照的稳定性由注册表保证（`winners()` 带缓存，
 * 没变化时返回同一个数组），这里只负责把 subscribe / getSnapshot 交上去。
 *
 * 每个槽条目都套一层错误边界：一个插件的组件抛异常，只该让那一块显示错误，
 * 不该把整页打白（dsh 那边同样是「按条目隔离崩溃」）。
 *
 * @module dsc-ui-shell/slots-react
 */
import { Component, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { SlotEntry } from '@dsc/ui-core'
import type { UiComponent, UiSlots } from './plugin-api'

/** 订阅一个槽里的登记。 */
export function useSlot(slots: UiSlots, slot: string): readonly SlotEntry<UiComponent>[] {
  const subscribe = useCallback((onChange: () => void) => slots.subscribe(onChange), [slots])
  const snapshot = useCallback(() => slots.winners(slot), [slots, slot])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 渲染一个槽里的全部条目。 */
export function SlotOutlet({ slots, slot }: { slots: UiSlots; slot: string }): ReactNode {
  const entries = useSlot(slots, slot)
  return (
    <>
      {entries.map((entry) => (
        <SlotEntryHost key={entry.id} entry={entry} />
      ))}
    </>
  )
}

/** 单条登记：套错误边界 + 带上 data 属性（自检脚本靠它认块）。 */
function SlotEntryHost({ entry }: { entry: SlotEntry<UiComponent> }): ReactNode {
  const Component_ = entry.component
  return (
    <SlotErrorBoundary slot={entry.slot} id={entry.id}>
      <div className="slot-entry" data-slot={entry.slot} data-entry={entry.id}>
        <Component_ />
      </div>
    </SlotErrorBoundary>
  )
}

/** 一个槽条目的错误边界：拦下渲染期异常，显示哪一块坏了。 */
class SlotErrorBoundary extends Component<
  { slot: string; id: string; children: ReactNode },
  { error: string | null }
> {
  constructor(props: { slot: string; id: string; children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
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
