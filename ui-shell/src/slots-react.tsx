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
import { Component, createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { SlotAssemblyError, useSeatProps, useSlot, type SlotEntry, type StoredFactory } from '@dsc/ui-core'
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
  // 类型擦除边界①：条目组件在注册面是 `UiComponent`（props=never），这里按「能渲染的东西」
  // 调用；真正的 props 检查发生在插件作者的 register 调用点。
  const Component_ = entry.component as ComponentType<Record<string, unknown>>
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
  // 类型擦除边界：出口按字符串渲染子槽 / Factory（entry.children 是运行期事实），
  // 公开的 SlotRenderApi 只在插件作者的调用点收窄。
  const renderFactorySlot = useCallback(
    (
      name: string,
      props?: Record<string, unknown>,
      options?: {
        slots?: Readonly<Record<string, ComponentType<Record<string, unknown>>>>
        fallback?: ReactNode
      },
    ): ReactNode => (
      <FactoryOutlet
        slots={slots}
        name={name}
        inputProps={props}
        selections={options?.slots}
        fallback={options?.fallback}
      />
    ),
    [slots],
  )
  const api = useMemo<SlotRenderApi>(
    () => ({
      renderSlot: renderSlot as SlotRenderApi['renderSlot'],
      childSlots: entry.children,
      renderFactorySlot: renderFactorySlot as SlotRenderApi['renderFactorySlot'],
    }),
    [renderSlot, renderFactorySlot, entry.children],
  )
  // 席位（D3）：登记时声明过 store 的条目，共享实例在这里懒建，组件多拿 useStore/actions；
  // 没声明的条目拿空份额。hook 必须无条件调用（entry.store 在该条目的生命周期里不变）。
  const seat = useSeatProps(slots, entry.store)
  return (
    <SlotErrorBoundary
      slot={entry.slot}
      id={entry.id}
      onFault={(error) => {
        slots.reportFault(entry, error)
      }}
    >
      <div className="slot-entry" data-slot={entry.slot} data-entry={entry.id} data-cell={entry.cell}>
        <Component_ {...owner} {...api} {...seat} />
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

/**
 * ── Component Factory 出口（D2）────────────────────────────────────────────────
 *
 * 一份定义、多个无关的父位置各渲染一次 occurrence；调用方按 occurrence 选局部组件。
 * 与条目出口一致的取向：装配错误（没声明的局部位置/子槽、递归渲染）往上炸；
 * 组件崩溃只记一条 Factory 故障（`reportFactoryFault`），**不摘除共享定义**——
 * 定义是多个父位置共用的，一个 occurrence 崩了不能把别人的装配也打掉。
 */
const NO_SELECTION: Readonly<Record<string, ComponentType<Record<string, unknown>>>> = Object.freeze({})

/** 递归渲染检测：名字沿渲染树往下传（同一个定义在自己的 occurrence 里再出现 = 死循环）。 */
const FactoryAncestryContext = createContext<ReadonlySet<string>>(new Set())

/** 订阅某个 Factory 定义的增删（版本号是标量快照，与槽版本号同一套理由）。 */
function useFactoryVersion(slots: UiSlots, name: string): number {
  const subscribe = useCallback((onChange: () => void) => slots.subscribeFactory(name, onChange), [slots, name])
  const snapshot = useCallback(() => slots.factoryVersion(name), [slots, name])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * 渲染一次 Factory occurrence（父位置的 `renderFactorySlot` 落到这里）。
 * 定义缺席渲染 `fallback`——D2 的保险丝：共享定义还没注册时父位置的行为与今天一致。
 */
export function FactoryOutlet({
  slots,
  name,
  inputProps,
  selections,
  fallback,
}: {
  slots: UiSlots
  name: string
  inputProps?: Record<string, unknown>
  selections?: Readonly<Record<string, ComponentType<Record<string, unknown>>>>
  fallback?: ReactNode
}): ReactNode {
  const version = useFactoryVersion(slots, name)
  const definition = slots.factory(name)
  const ancestors = useContext(FactoryAncestryContext)
  const nextAncestors = useMemo(() => new Set(ancestors).add(name), [ancestors, name])
  if (definition === undefined) return <>{fallback ?? null}</>
  if (ancestors.has(name)) {
    throw new SlotAssemblyError(`装配错误：Factory「${name}」递归渲染（定义在自己的 occurrence 里又出现）`)
  }
  for (const localName of Object.keys(selections ?? {})) {
    if (!definition.slots.includes(localName)) {
      throw new SlotAssemblyError(
        `装配错误：Factory「${name}」没有声明局部位置「${localName}」` +
          `（声明过的：${definition.slots.length === 0 ? '无' : definition.slots.join('、')}）`,
      )
    }
  }
  return (
    <FactoryErrorBoundary
      // 定义换了（同名重新注册）就重挂一次：occurrence 的输入/选择按新定义重算。
      key={`${name}:${String(version)}`}
      name={name}
      id={name}
      onFault={(error) => {
        slots.reportFactoryFault(name, name, error)
      }}
    >
      <FactoryAncestryContext.Provider value={nextAncestors}>
        <FactoryOccurrenceBody
          slots={slots}
          definition={definition}
          inputProps={inputProps ?? NO_OWNER}
          selections={selections ?? NO_SELECTION}
        />
      </FactoryAncestryContext.Provider>
    </FactoryErrorBoundary>
  )
}

/**
 * 一次 occurrence 的本体：组装注册面（子槽渲染 + Factory 渲染 + 席位）并挂定义组件。
 *
 * occurrence 身份（dsh 在 `useRef({}).current` 上落的那枚锚）在本版**没有消费者**：
 * 席位实例挂在 handle 上、不按 occurrence 分（第一版只支持共享 handle）；将来做
 * occurrence 独占席位时，锚就落在这里。
 */
function FactoryOccurrenceBody({
  slots,
  definition,
  inputProps,
  selections,
}: {
  slots: UiSlots
  definition: StoredFactory<UiComponent>
  inputProps: Record<string, unknown>
  selections: Readonly<Record<string, ComponentType<Record<string, unknown>>>>
}): ReactNode {
  const kit = useMemo(() => {
    const renderSlot = (name: string, props?: Record<string, unknown>): ReactNode => {
      if (!definition.children.includes(name)) {
        throw new SlotAssemblyError(
          `装配错误：Factory「${definition.name}」没有声明子槽「${name}」` +
            `（声明过的：${definition.children.length === 0 ? '无' : definition.children.join('、')}）`,
        )
      }
      return slots.spec(name) === 'chain' ? (
        <ChainOutlet slots={slots} slot={name} owner={props ?? NO_OWNER} />
      ) : (
        <SlotOutlet slots={slots} slot={name} owner={props ?? NO_OWNER} />
      )
    }
    const renderFactorySlot = (
      name: string,
      props?: Record<string, unknown>,
      options?: {
        slots?: Readonly<Record<string, ComponentType<Record<string, unknown>>>>
        fallback?: ReactNode
      },
    ): ReactNode => (
      <FactoryOutlet
        slots={slots}
        name={name}
        inputProps={props}
        selections={options?.slots}
        fallback={options?.fallback}
      />
    )
    return { renderSlot, childSlots: definition.children, renderFactorySlot }
  }, [slots, definition])
  const seat = useSeatProps(slots, definition.store)
  /**
   * 定义内部选题局部组件：返回**稳定**组件（父没选就用 fallback），并把它接上同一份
   * 注册面（局部组件与定义组件共享 children/席位能力）。
   *
   * 注意这是个「命名以 use 开头的 prop」：定义组件要像 hook 一样**无条件调用**它
   * （内部按名字缓存返回的组件身份，逐帧调用不会让局部组件重挂）。
   */
  const useFactorySlot = useCallback(
    (name: string, fallback: ComponentType<Record<string, unknown>>): ComponentType<Record<string, unknown>> => {
      if (!definition.slots.includes(name)) {
        throw new SlotAssemblyError(
          `装配错误：Factory「${definition.name}」没有声明局部位置「${name}」` +
            `（声明过的：${definition.slots.length === 0 ? '无' : definition.slots.join('、')}）`,
        )
      }
      const Selected = selections[name] ?? fallback
      // eslint-disable-next-line react-hooks/rules-of-hooks -- 见上方文档：作者按 hook 规则调用。
      return useMemo(() => {
        const Bound = (localProps: Record<string, unknown>): ReactNode => (
          <FactoryErrorBoundary
            name={definition.name}
            id={name}
            onFault={(error) => {
              slots.reportFactoryFault(definition.name, name, error)
            }}
          >
            <Selected {...kit} {...seat} {...localProps} />
          </FactoryErrorBoundary>
        )
        return Bound
      }, [Selected, kit, seat, definition, name, slots])
    },
    [definition, selections, kit, seat, slots],
  )
  const Component_ = definition.component as ComponentType<Record<string, unknown>>
  return <Component_ {...kit} {...seat} {...inputProps} useFactorySlot={useFactorySlot} />
}

/** Factory 里（定义组件或局部组件）出错的边界：记故障但不摘除共享定义。 */
class FactoryErrorBoundary extends Component<
  { name: string; id: string; onFault: (error: unknown) => void; children: ReactNode },
  { error: string | null }
> {
  constructor(props: { name: string; id: string; onFault: (error: unknown) => void; children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    // 装配错误照旧往上炸（壳与定义的契约没对上，不是「某个组件坏了」）。
    if (error instanceof SlotAssemblyError) throw error
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onFault(error)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="factory-crash" data-factory={this.props.name} data-factory-slot={this.props.id}>
          Factory {this.props.name} 的 {this.props.id} 渲染失败：{this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}
