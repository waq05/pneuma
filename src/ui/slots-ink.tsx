/**
 * TUI 载体的槽位渲染出口（ink 版 `SlotOutlet`）。
 *
 * 与浏览器壳的 `ui-shell/src/slots-react.tsx` 同一语义，两处差异都是载体的：
 *   - 条目外层套 ink 的 `Box`（浏览器壳套 `<div class="slot-entry">` 供自检认块，
 *     终端壳的自检靠帧文本，不需要 data 属性）；
 *   - 崩溃视图是一行红字（ink 没有 className，颜色走 STATUS_COLOR 语义）。
 *
 * 订阅逻辑（useSlot）与浏览器壳共用 `src/ui/slots-react.ts` 那一份。
 * 错误边界同样只拦「插件坏了」：装配错误（SlotAssemblyError）照旧往上炸——
 * 壳与插件的契约没对上时，宁可整个 TUI 崩出来也不能装作没事。
 *
 * Factory（D2）：`ui.slots.registerFactory` 的**登记面两壳一致**（槽位契约与注册表是同一份），
 * 但 TUI **没有 Factory 渲染出口**（现在没有消费者：工具卡是浏览器壳独有的装配）。
 * 条目组件若真的调用 `renderFactorySlot`，会得到一句明确的装配错误，而不是 undefined 崩。
 *
 * @module dsc/ui/slots-ink
 */
import { Component, useCallback, useMemo, type ComponentType, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { SlotAssemblyError, type SlotEntry } from './slots.js'
import type { SlotRegistry } from './slots.js'
import { useSeatProps, useSlot } from './slots-react.js'

/** 终端里组件出错时的颜色（不引宿主的样式令牌——UI 契约要保持零宿主依赖）。 */
const CRASH_COLOR = 'red' as const

/** 渲染一个槽里的全部条目（每条独立错误边界，崩一条退一条，不拖垮整帧）。 */
export function SlotOutlet<C>({
  slots,
  slot,
  owner,
}: {
  slots: SlotRegistry<C>
  slot: string
  owner?: Record<string, unknown>
}): ReactNode {
  const entries = useSlot(slots, slot)
  if (entries.length === 0) return null
  return (
    <>
      {entries.map((entry) => (
        <SlotEntryHost
          key={`${entry.cell}|${entry.id}|${String(entry.priority)}|${String(entry.seq)}`}
          slots={slots}
          entry={entry}
          owner={owner}
        />
      ))}
    </>
  )
}

/** 单条登记：套错误边界、注入渲染能力。 */
function SlotEntryHost<C>({
  slots,
  entry,
  owner,
}: {
  slots: SlotRegistry<C>
  entry: SlotEntry<C>
  owner?: Record<string, unknown>
}): ReactNode {
  const Component_ = entry.component as ComponentType<Record<string, unknown>>
  const renderSlot = useCallback(
    (name: string, props?: Record<string, unknown>): ReactNode => {
      if (!entry.children.includes(name)) {
        throw new SlotAssemblyError(
          `条目 ${entry.slot}/${entry.id} 没有声明子槽「${name}」` +
            `（声明过的：${entry.children.length === 0 ? '无' : entry.children.join('、')}）`,
        )
      }
      return <SlotOutlet slots={slots} slot={name} owner={props} />
    },
    [slots, entry],
  )
  const api = useMemo(
    () => ({
      renderSlot,
      childSlots: entry.children,
      /** TUI 还没有 Factory 渲染出口（见文件头）：调用明确报错，不静默。 */
      renderFactorySlot: (): ReactNode => {
        throw new SlotAssemblyError('TUI 壳还没有 Factory 渲染出口（无消费者）；registerFactory 的登记两壳一致，渲染出口后补')
      },
    }),
    [renderSlot, entry.children],
  )
  // 席位（D3）：与浏览器壳同一语义——声明过 store 的条目多拿 useStore/actions。
  const seat = useSeatProps(slots, entry.store)
  return (
    <SlotErrorBoundary
      slot={entry.slot}
      id={entry.id}
      onFault={(error) => {
        slots.reportFault(entry, error)
      }}
    >
      <Box flexDirection="column">
        <Component_ {...(owner ?? {})} {...api} {...seat} />
      </Box>
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
    // 装配错误不是「某个插件坏了」，是壳和插件的契约没对上：必须往上炸。
    if (error instanceof SlotAssemblyError) throw error
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onFault(error)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <Text color={CRASH_COLOR}>
          界面块 {this.props.id} 渲染失败：{this.state.error}
        </Text>
      )
    }
    return this.props.children
  }
}
