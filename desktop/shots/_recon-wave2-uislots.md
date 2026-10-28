# 第 2 波机制规格：A1 服务注入 / D1 类型化槽位契约 / D2 Component Factory / D3 store seats

> 只读侦察产出（2026-10-13）。参考实现：`D:\deepseek-harness\deepseek-harness`（下称 dsh）。
> 本文件写给施工者：每条机制都带 dsh 源码原文 + dsc 落点 file:line；不改 dsh/dsc 任何文件。
> 术语：**槽**（slot，父声明的位置）、**条目**（entry，一次 register）、**格子**（cell，同名冲突域）、
> **席位**（seat，登记时声明的一份共享状态）、**Factory**（可复用装配定义）、**occurrence**（Factory 的一次渲染实例）。

---

## 0. 结论速览（先看这段）

| 机制 | dsh 的精确形状 | dsc 落点 | 关键裁定 |
| --- | --- | --- | --- |
| D1 类型化契约 | `declare module` 合并 `SlotMap`/`SlotFactoryMap`；register 的 component 约束是 `ComposedProps`（五份额交叉） | `SlotMap` 声明在载体面（`ui-shell/src/plugin-api.ts` / `src/ui/tui-plugin-api.ts`），`src/ui/slots.ts` 的 `SlotRegistry` 改成对表泛型并加派生类型；`plugin-api.ts:65` 的 `ComponentType<any>` 换掉 | **不会逼出 `any`**。需要 3 处显式泛型 + 3 处内部 `as`（见 §5.2）。`SlotMap` 的合并目标必须是**插件 import 的那个模块**（dsh 教训：re-export 不参与合并，见 §1.1 引文 A、§3.1.1） |
| A1 服务注入 | 客户端插件是 cordis 插件：插件模块导出 `inject` 服务名表 → fiber 未就绪就不 apply；`dsh.client.inject` 另作模块图边 | `src/ui/services.ts`（新，React-free 服务表）+ `plugin-api.ts` 的 `provide/consume` + 两个装载器（`boot.ts` / `tui-plugins.ts`）共用 | **注入名单沿用 `inject` 字段，但解析顺序是「先插件 id、再服务名」**；不引 cordis（计划的判断正确） |
| D2 Factory | `registerFactory(def, component)` / `renderFactorySlot(name, props, {slots, fallback})` / `useFactorySlot(name, fallback)`；`children` 是普通槽、`slots` 是本次 occurrence 由父选的局部组件 | `src/ui/slots.ts` + `ui-shell/src/slots-react.tsx`（+ `slots-ink.tsx` 的 TUI 出口）；`@dsc/ui` 转出 | 真实消费者=对话页/轨迹页工具卡（§3.4 有逐行差异表）；Factory 定义由 transcript 插件注册，trace 插件渲染——trace 需要 A1 的软依赖 |
| D3 seats | 席位 = handle 对象；组件拿 `useStore(selector) + actions`（draft 已剥掉）；共享靠**同一个 handle 对象**；instance 懒建于首次渲染读 | 新 `src/ui/store.ts`（自研 ~80 行，不引 zustand/immer）+ 登记 options 加 `store?: handle` + React 绑定进 `slots-react` | **计划里「`store?: { key, spec }` 带 key」是对 dsh 的误读**：dsh 席位没有 key，身份就是 handle 对象；冲突文案对应的是另外两处（§3.3.2）。真实消费者=`listTeammates` 现在有 3 份独立轮询（team 插件 2 份 + status 1 份，§3.3.3） |

计划 §2 验收项与机制对应：**项 1（插件协作）→A1**、**项 3（编译期拦住）→D1**、**项 4（装配可复用）→D2**；D3 对应计划 §3 D3 自己的验收。

---

## 1. dsh 四个机制的精确语义（源码原文）

包位置：`D:\deepseek-harness\deepseek-harness\packages\client\`
- `ui-slots/`：纯核心（SlotCore）+ 契约类型 + 渲染器安装契约（零 cordis）
- `ui-renderer/`：React 出口 + `slots` cordis 服务（SlotRegistry）
- `store/`：zustand vanilla + immer 引擎 + `defineStore`

### 1.1 类型化契约：声明合并 + 五份额

**引文 A：合并必须落在「被 augment 的那个模块」里（这是 dsh 明确踩过的坑）**
`packages/client/ui-slots/src/index.ts:1-10`：
```ts
/**
 * Slot registry pure core. Owners declare slot
 * contracts by merging into {@link SlotMap}; one `register` call contributes a
 * component AND (optionally) declares child slots, a store seat, and the
 * registrant's business face. Zero runtime dependencies (React types only).
 *
 * SlotMap and the standard-kit interfaces live directly in this entry module:
 * consumer `declare module` augmentation merges with declarations lexically in
 * the augmented module, not with re-exports.
 */
```

**引文 B：三张合并表 + 空表起点**
`ui-slots/src/index.ts:25-47`：
```ts
/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}

/** Reusable Component Factory contract table, extended through declaration merging. */
export interface SlotFactoryMap {}

/** Locale namespace table. … */
export interface LocaleNamespaceMap {}

/** Resource protocol (URL scheme) → the value its provider streams. … */
export interface ResourceProtocolMap {}
```

**SlotMap 一条的形状（kind/scope 两轴 + 三个可选份额）**，`ui-slots/src/index.ts:100-138`：
```ts
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
export type SlotScope = 'root' | 'session-maybe' | 'session'

export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
  keyProps?: Record<string, object>
  hookContext?: unknown
  inject?: object
}
```
- `owner` = 父在 renderSlot 调用点传的 props（dsh 的渲染期 owner 份额）。
- `inject` = **槽级**公共注入面（父声明 children 时给的 `inject:`），每个子条目都拿到；
  与登记自己的 `inject`（业务面）是两件事。
- dsc 注意：dsh 的 `scope`（root/session-maybe/session）dsc **完全没有**——D1 的 map 条目
  只需要 `{ kind, owner? , matched? }` 三项，别把 scope 机器搬进来。

**五份额组装的最终 props**，`ui-slots/src/index.ts:601-610`：
```ts
export type ComposedProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  S extends keyof SlotMap & string,
  H,
  I extends object,
  M = never,
  N = undefined,
> = PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsRenderFactories
  & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>
```
五份额展开（组件实际收到的「座位」全集）：
1. **runtime**（`ui-slots/src/index.ts:251-258`）：`OwnerOf<K> & KeyPropsOf & SlotInjectFace & ScopeStandardProps`
   —— owner 父份额 + 会话/全局标准件（`use<Name>` 选择器 hook 们）。
2. **child-render**（`ui-slots/src/index.ts:373-397`）：`renderSlot`（按声明子槽集合收窄）+
   chain 子槽走 `renderSlotChain`；含 scope 子槽时还多一个 `SessionProvider` 座位。
   另有一个**幻影锚** `__renders?: ((key: S) => void)`（`:373-383` 注释）：指望泛型方法签名
   互相校验不可靠，这个逆变标记才是「组件渲染的 key 集 ⊆ children 声明」的强制器。
3. **factory-render**（`:493-496`）：`renderFactorySlot`，**每个** renderer 创建的组件都有。
4. **store**（`store/src/contract.ts:134-136`）：
   ```ts
   export type PropsStore<H> = H extends StoreHandle<infer T, infer A>
     ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
     : object
   ```
5. **business**（登记 `inject` 工厂返回值，hooks 隔间绑定成 `use<Name>`）+ locale `t` +
   chain 的 `matched`（`:341-342`：`MatchedShare`，仅 chain 形态加 `{ matched: M }`）。

**注册位组件形状刻意不用 FC**，`ui-slots/src/index.ts:399-404`：
```ts
/**
 * Registration-position component shape: the bare call signature, so composed
 * constraints check through clean parameter contravariance (FC statics add
 * covariant noise rejecting legitimate narrowings).
 */
export type SlotComponent<P> = (props: P) => ReactNode
```
register 的 component 参数约束（`ui-slots/src/index.ts:1157-1201`，两个 overload 只为 inject 的
推断分开）：
```ts
register<K extends keyof SlotMap & string, …, C extends SlotComponent<never> = SlotComponent<never>>(
  options: BaseOptions<K, EntryKey, D, H, M, N> & { inject?: undefined },
  component: C
    & SlotComponent<ComposedProps<K, NoInfer<EntryKey>, keyof NoInfer<D> & keyof SlotMap & string,
        HandleOf<NoInfer<H>>, object, NoInfer<M>, NoInfer<N>>>
    & RendersCheck<C, D>,
): () => void
```
要点：`C extends SlotComponent<never>` —— **参数逆变让「props 具体」的组件天然满足「props=never」**，
所以擦除位不需要 `any`。`RendersCheck`（`:802-808`）强制「声明了 children 就必须消费 renderSlot」。

chain 的 owner/select/matched 推导，`ui-slots/src/index.ts:781-793`：
```ts
: SlotMap[K]['kind'] extends 'chain' ? {
    select: ChainSelect<SlotMap[K] extends { owner: infer O extends object } ? O : object, M>
    priority?: number
  }
```
`ChainSelect`（`:296`）：`(owner: O) => M | null`，M 从 select 返回值推断 → 组件 props 的
`matched: M`。**select 的 owner 是类型化的，不是 unknown**；`unknown` 只出现在运行期擦除面。

**register 的 load-time 校验（错误文案原样抄进 dsc）**，`ui-slots/src/index.ts:1204-1247`（原文，`occupantHint` 为
`at priority ${priority}${registrant ? ` (registered by ${registrant})` : ''} — register at a different priority to shadow it (lowest renders)`）：
```
slot "${options.name}" is not declared (a parent entry's children table must declare it)
single slot "${options.name}" already has a registration at priority 0 (registered by X) — register at a different priority to shadow it (lowest renders)
keyed slot "${options.name}" already has an entry for key "${options.key}" at priority 0 (registered by X) — register at a different priority to shadow it (lowest renders)
list slot "${options.name}" already has an entry with id "${options.id}" at priority 0 (registered by X) — register at a different priority to shadow it (lowest renders)
keyed slot "${options.name}" requires options.key
list slot "${options.name}" requires options.id
chain slot "${options.name}" requires options.select
slot "${childKey}" is already declared (by ${childRec.declaredBy})
```
遮蔽/退位/生命周期（dsh 版）：varying priority = 合法遮蔽；同格同 priority = 抛错；
`reportEntryError(..., {abdicate:true})` 把崩溃条目从格子剔掉（一次性，登记仍在账本上）；
disposer 删条目并**递归collapse它声明的全部子槽**（`ui-slots/src/index.ts:1586-1610`）。

### 1.2 Component Factory

**三条 API 签名**（全部在 `ui-slots/src/index.ts`）：

```ts
// :484-491 父（任何渲染位置）渲染一次 occurrence
export type RenderFactorySlot = <F extends keyof SlotFactoryMap & string>(
  name: F,
  props: FactoryInputPropsOf<F>,
  options?: {
    slots?: Partial<{ [N in FactoryLocalNameOf<F>]: FactoryLocalComponent<F, N> }>
    fallback?: ReactNode
  },
) => ReactNode

// :471-475 定义内部选局部组件（含 fallback 组件；**fallback 是组件不是节点**）
export type UseFactorySlot<F extends keyof SlotFactoryMap & string> =
  <N extends FactoryLocalNameOf<F>>(
    name: N,
    fallback: FactoryLocalComponent<F, N>,
  ) => SlotComponent<FactoryLocalInputPropsOf<F, N>>

// :732-737 登记（幂等 disposer；一个名字只许一个定义）
export interface RegisterFactory {
  <F extends keyof SlotFactoryMap & string>(
    options: RegisterFactoryOptions<F>,
    component: SlotComponent<FactoryComponentPropsOf<F>>,
  ): () => void
}
```

**Factory 定义的类型表**，`ui-slots/src/index.ts:141-155`：
```ts
export interface FactoryLocalSlotDef { scope: SlotScope; props?: object }

export interface SlotFactoryDef {
  scope: SlotScope
  props?: object
  children?: ChildrenDecl      // 普通全局槽：定义声明、定义渲染、任何插件可注册
  store?: StoreDecl
  inject?: object
  locale?: keyof LocaleNamespaceMap & string
  slots?: Record<string, FactoryLocalSlotDef>  // 局部位置：类型上只声明 props/scope
}
```
**Factory 组件收到的 props**，`ui-slots/src/index.ts:445-449`：
```ts
export type FactoryComponentPropsOf<F extends keyof SlotFactoryMap & string> =
  FactoryInputPropsOf<F>                                  // 父传的 occurrence 输入
  & FactoryRegistrationPropsOf<F>                          // renderSlot/renderFactorySlot/store/inject/locale
  & ScopeStandardProps<FactoryDefOf<F>['scope']>
  & { useFactorySlot: UseFactorySlot<F> }
```
**局部组件收到的 props**（`:452-457`）：局部输入 props + 同一份 registration 份额 + 自己声明的
scope 标准件 —— 即**局部组件与 Factory 共享 children/store/inject 能力，但只多自己那份局部输入**。

**运行期「按 occurrence 选局部组件」的精确过程**（`ui-renderer/src/client/scoped-slots.tsx`）：
- 父调用 `boundRenderFactorySlot(caller)` → `<FactoryOutlet name inputProps slots fallback caller/>`
  （`:40-59`）；`caller` 身份 = `StoredEntry | StoredFactory`（谁在渲染这次 occurrence）。
- `FactoryOutlet`（`:989-1030`）：订阅定义版本（`subscribeFactory` + `getFactoryVersion`）；
  定义缺席 → 渲染 `fallback ?? null`；校验 `slots` 里每个名字都在 `definition.slots` 里，
  否则 `SlotOwnershipError('local slot "…" is not declared by factory "…"')`；递归渲染检测
   （ancestry set）；然后 `<FactoryOccurrence …/>`。
- `FactoryOccurrenceBody`（`:938-975`）：`occurrence = useRef<object>({}).current`
  ——**occurrence 身份 = 这个挂载位置的对象引用**；`useEffect(() => host.retainFactoryOccurrence(definition, occurrence), …)`
  提交后保留（`:946-949`）；`factoryKit` 组装 registrationKit（`:862-896`：renderFactorySlot、
  `t`、`useStore/actions`、`renderSlot/renderSlotChain/SessionProvider`）；
  最后 `<Comp {...provided} {...inputProps}/>`。
- `useFactorySlotRuntime`（`:794-845`）：
  ```ts
  const occurrence = useContext(FactoryOccurrenceContext)
  if (occurrence === null) throw new SlotAssemblyError('useFactorySlot() called outside a Factory occurrence')
  if (!occurrence.host.isFactoryLive(occurrence.definition)) throw new StaleAuthorizationError(...)
  const declared = occurrence.definition.slots?.[name]
  if (declared === undefined) throw new SlotOwnershipError(`local slot '${name}' is not declared …`)
  const selected = occurrence.selected[name]
  const Selected = selected ?? fallback
  ```
  返回一个 `BoundFactoryLocalComponent`：渲染时再查 `current.definition !== definition`（防跨
  occurrence 复用）、strict session 局部槽必须绑着 scope、然后 `<Selected {...provided} {...localProps}/>`，
  外面套 `FactoryErrorBoundary`（崩溃走 `reportFactoryError`，**不摘除共享定义**）。

**Factory children 与普通槽的关系**：`registerFactory` 对 `options.children` 走和 register 一样的
`this.record(childKey)` 声明（`ui-slots/src/index.ts:1032-1070`）：冲突抛
`slot "${childKey}" is already declared (by …)`；disposer 里 `releaseChildren`。运行时定义组件通过
`renderSlot`（`boundFactoryRenderSlot`，`scoped-slots.tsx:120-146`）渲染，授权身份是 definition；
条目的渲染期用同样规则（live 检查、declared 检查、chain 必须 renderSlotChain）。所以
**「Factory 的 children 仍是普通槽」在类型上由 `FactoryChildrenCheck` 钉住**（`ui-slots/src/index.ts:703-712`：
children 的每个 key 必须在 SlotMap 里、且 spec 必须匹配 SlotMap 条目）。

**Factory 注册的运行期校验**，`ui-slots/src/index.ts:1028-1046`：
```
slot factory "${options.name}" already has a definition
slot "${childKey}" is already declared (by …)
store handle mounted under factory "…" (scope "…") is already mounted under scope "…" — one handle, one scope
```
取消注册时：清 definition、handleScope 计数减一、collapse children（`:1071-1080`）。

### 1.3 store seats：形状、创建时机、冲突、回收

**类型面**（`packages/client/store/src/contract.ts`）：
```ts
// :40  action 表 = 纯 immer draft 变换（审计面：组件只能经它写）
export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

// :47-49 「draft-stripped」= 框架把 draft 参数烘掉，组件只拿业务实参
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
}

// :56-60  声明：init 是 lambda（每实例一份新 state）、persist 可选、actions 是全部写集
export interface StoreSpec<T, A extends ActionsDecl<T>> { init: () => T; persist?: string; actions: A }

// :93-103 handle = spec + 类型 + 共享身份 + create()；注释：
// "Never export a handle at module level — module-cache identity is a disguised singleton across plugin reloads."
export interface StoreHandle<T, A extends ActionsDecl<T>> {
  readonly spec: StoreSpec<T, A>
  create(scopeKey?: string): StoreInstance<T, A>
}
// :113-117 登记 store 位置：共享 handle 或独占工厂
export type StoreFactory = () => StoreHandle<any, any>
export type StoreDecl = StoreHandle<any, any> | StoreFactory
```
**draft 为什么剥掉**：`store/src/index.ts:228-232`（defineStore 实现）：
```ts
const actions = {} as Record<string, (...params: unknown[]) => void>
for (const key of Object.keys(decl.actions)) {
  const mutate = decl.actions[key] as (draft: T, ...params: unknown[]) => void
  actions[key] = (...params: unknown[]) => { store.update((draft) => { mutate(draft, ...params) }) }
}
```
即 `actions[key](...)` 内部 `store.update(draft => mutate(draft, ...))`；组件端拿到的是
`(...params:P) => void`，看不到 draft、也没有 set/update —— **组件唯一写路径**。
引擎本身：`createSnapshotStore(init, {flush:'raf'|'sync', persist})` = zustand vanilla +
`subscribeWithSelector` + immer `produce` + 可选 localStorage（`store/src/index.ts:103-136`；
persist 是手写整值 JSON，注释 :138-145 说明为何不用 zustand persist）。

**seat 在渲染侧怎么长出来**（`ui-renderer/src/client/renderer.ts:53-62` 契约）：
```ts
export interface StoreInstanceLike {
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
  readonly actions: Record<string, (...params: never[]) => void>
}
```
renderer 侧 `factoryKit`（`scoped-slots.tsx:876-883`）：
```ts
const store = host.factoryStoreOf(definition, scoped, occurrence)
if (store !== undefined) {
  registrationKit['useStore'] = observableHook(store)
  registrationKit['actions'] = store.actions
}
```
`observableHook` 就是那个唯一的 uSES 桥（每个 source 缓存一份 hook）。

**何时创建**（`ui-renderer/src/client/registry.ts`）：
- 普通席位：`resolveStore(handle, scopeBinding)`（`:598-624`）在**渲染读**时懒建：
  按 `handle × scope key` 查 `record.instances`，没有就 `handle.create()`（root）/
  `handle.create(scopeBinding.key)`；`_stores` 记录是**按 handle 引用计数**的
  （`_acquire/_release`，`:704-720`；「handle → mounted scope, refcount, resolved instances」）。
- Factory 独占席位（`store: () => handle` 工厂形式）：`resolveFactoryStore`（`:632-665`）
  在 occurrence 首次物化时建 handle：
  ```ts
  let record = axis.occurrences.get(occurrence)
  if (record === undefined) {
    const handle = declaration()
    if (handle.spec.persist !== undefined) {
      throw new SlotAssemblyError(
        `exclusive store for factory "${definition.name}" cannot declare persistence`,
      )
    }
    record = { handle, instances: new Map(), retainers: 0 }
    axis.occurrences.set(occurrence, record)
  }
  ```
  —— **这就是「key 冲突拒绝」在 dsh 的真实对应物**：独占席位的 persist key 会在 occurrence 间
  撞车，所以直接禁 persit（文案原样可抄）。`occurrences` 是 WeakMap（GC 兜底），
  `mounted`（提交后 `retainFactoryOccurrence` 记进来，`:667-684`）只用于会话代际清理
  （`releaseStoreScope`，`:686-693`：删实例、**不清持久化**）。

**回收**：条目 disposer → `releaseEntry`：handle 计数减一、递归 collapse 子槽；
registerFactory disposer → `_factoryStores.delete(definition)` + handle `_release`；
最后一个持有者卸载时 `_stores.delete(handle)`，实例随之消失（引擎无需显式 dispose）。

### 1.4 客户端服务注入（dsh）：cordis 服务模型 + 两名录

dsh 的客户端插件就是 cordis 插件；服务面**不是自研的**，全部走 cordis `Context`/`Service`。

**引文 C：平台种子表只共享这些（服务可见性的物理边界）**
`packages/client/web/src/seed.ts:24-39`：
```ts
export function getStaticModules(): Record<string, unknown> {
  return {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
    '@deepseek-ai/dsh-client-ui-dockkit': UiDockkit,
  } satisfies Record<PlatformModule, unknown>
}
```
（dsc 对应 `ui-shell/src/boot.ts:58-66` 的 7 项 `MODULES`。）

**引文 D：插件声明的服务依赖表（模块级导出）+ 消费写法**
`packages/client/ui-chat/src/client/apply.ts:57-60`：
```ts
/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'slots', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'locale',
  'configForms', 'remote', 'remote.session', 'sidebarRight',
]
```
消费有两种：① 直接 `ctx.someService`（前提是 fiber 已等齐 inject —— cordis 的服务代理对没声明
inject 的属性**直接抛错**）；② 可选依赖 `ctx.inject(['sidebarRightTabs'], (scope) => { … })`
（`apply.ts:127`），回调在服务出现时跑、消失时撤。dsh 的客户端**没有**「provide 一个动态值」的
轻量 API——提供者都是 `class X extends Service` + `ctx.reflect.provide(name, value)` / 构造时
`super(ctx, 'name')` 自动挂上（`ui-renderer/src/client/registry.ts:120` `class SlotRegistry extends Service`，
`index.ts:88-95` `ctx.reflect.provide('uiRenderer', { mount })`；`Context` 的声明合并见
`ui-renderer/src/client/index.ts:41-53`）。

**注入语义（cordis fiber）**：
- `dsh.client.inject`（package.json）是**模块图边**：决定工厂到达顺序与组合（`packages/client/modules/src/client/manifest.ts:44-52` 注释：“`inject` names package rows whose
  factories must arrive before this row materializes, while Cordis separately uses the same package edges to compose entries”）。
- 真正「等服务」的是插件模块自己的 `inject` 导出：cordis fiber 依赖未满足时停在 pending，
  `packages/client/web/src/boot-client.ts:79-81` 的诊断文案可抄：
  ```ts
  if (state === 'pending') {
    const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
    failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
  }
  ```
  即：**缺席就不 apply（fiber pending），并报「等哪个服务」**——这就是计划 §2 验收项 1 的 dsh 口径。

**别混淆：`ctx.slots.inject(key, cb)` 是「等一个槽声明」**（`ui-renderer/src/client/registry.ts:246-...`），
不是服务注入。它的语义 = dsc 已有的 `injectSlot`：回调在声明已存在时同步跑，否则在声明提交后跑；
声明 collapse 撤掉 effect、再声明再跑一次；**callback 的 disposer 属于调用者 fiber，插件卸载会取消等待并撤掉贡献**。
dsc 已有同语义实现（`src/ui/slots.ts:235-246`），A1 不需要重复造。

---

## 2. dsc 现状（证据）

### 2.1 文件与职责

| 文件 | 行数 | 职责 | 本波是否动 |
| --- | --- | --- | --- |
| `src/ui/slots.ts` | 558 | SlotRegistry：declare/register/injectSlot/elect/winners/故障记账 | **D1/D2/D3 主战场** |
| `src/ui/slots-react.ts` | 32 | `useSlot`/`useSlotFaults`（uSES 订阅，两壳共用） | 保持不变（Factory 出口不放这） |
| `src/ui/slots-ink.tsx` | 119 | TUI SlotOutlet（ink Box + 错误边界） | D1/D2 同步（见 §3.4.5） |
| `ui-shell/src/slots-react.tsx` | 160 | Web SlotOutlet/ChainOutlet + `slot-entry` 包装 + 崩溃视图 | D1/D2 出口 |
| `ui-shell/src/plugin-api.ts` | 464 | `@dsc/ui` 值面（web）；`UiComponent = ComponentType<any>`（:65） | D1/A1/D2/D3 全动 |
| `src/ui/plugin.ts` | 132 | `UiPluginApi/UiSlotApi/UiPluginModule` 契约（两壳共用） | A1/D1/D3 动 |
| `ui-shell/src/boot.ts` | 288 | web 装载器：预取/装/回滚/重试一轮/账本 | A1 动 |
| `src/ui/tui-plugins.ts` | 257 | TUI 装载器（node，`new Function`） | A1 动（共享服务表） |
| `src/ui/manifest.ts` | 183 | 启动图 + 拓扑排序（inject 边）+ rev | A1 复核（不改） |
| `ui-shell/src/main.tsx` | 122 | 声明 SHELL_SLOTS → 建通道 → 装插件 → 渲染 | D1 声明改形状 |
| `ui-shell/src/slots.ts` | ~80 | `SLOT` 常量 + `SHELL_SLOTS` 9 个声明 | D1 改类型 |
| `src/ui/index.ts` | 115 | `@dsc/ui-core` 入口（slots/manifest/plugin/slots-react/…） | D1/D2/D3 转出 |
| `src/ui/tui-plugin-api.ts` | 25 | TUI 的 `@dsc/ui` 值面（`TUI_SLOTS` + `Text`） | D1 合并 TUI key |

现状关键缺口：
- `UiSlotApi<C>.register(slot: string, options: SlotRegisterOptions, component: C)`（`src/ui/plugin.ts:47`）
  —— 槽名是 `string`，组件是 `ComponentType<any>`，**没有任何按槽推导**。
- 条目记录里 `select: ((owner: unknown) => unknown) | null`（`src/ui/slots.ts:50`）。
- `SlotRepository` 无 Factory、无 store 席位、无服务表。
- `SlotRegisterOptions`（`src/ui/slots.ts:58-81`）只有 `id/order/priority/key/select/children`。

### 2.2 登记点全表（17 条 register；逐条实测）

搜法：`rg -n "slots\.(register|declare|injectSlot)" ui-shell/src src/ui src/plugins`（25 命中 − 装载器包装 6 条 − 纯注释 1 条 = 17 条真实登记 + 2 条 declare 包装）。

| # | 登记 file:line | 槽（kind） | options | 组件（定义位置） | 组件用到 props |
| --- | --- | --- | --- | --- | --- |
| 1 | `ui-shell/src/plugins/composer/ui.tsx:99` | `shell.composer`(list) | `{id:'composer.box', order:50}` | `ComposerBox`(:104) | 无（`function ComposerBox(): ReactNode`） |
| 2 | `composer/ui.tsx:100` | 同上 | `{id:'composer.queue', order:60}` | `QueueDock`(:722) | 无 |
| 3 | `plugins/plugins/ui.tsx:86` | `shell.page`(list) | `{id:'plugins.page', order:10}` | `PluginsPage`(:91) | 无 |
| 4 | `plugins/prompt/ui.tsx:61` | `shell.composer` | `{id:'prompt.cards', order:10}` | `PromptCards`(:71) | 无 |
| 5 | `plugins/skills/ui.tsx:95` | `shell.page` | `{id:'skills.page', order:20}` | `SkillsPage`(:100) | 无 |
| 6 | `plugins/statusbar/ui.tsx:43` | `shell.statusbar` | `{id:'statusbar.readout', order:1}` | `StatusSegments`(:86) | 无 |
| 7 | `plugins/sessions/ui.tsx:90` | `shell.header` | `{id:'sessions.workspace-open', order:10}` | `WorkspaceOpenGroup`(:1758) | 无 |
| 8 | `plugins/sessions/ui.tsx:92` | `shell.sidebar` | `{id:'sessions.list', order:1}` | `SessionList`(:150) | 无 |
| 9 | `plugins/status/ui.tsx:131` | `SLOT.main`=`shell.main`(list) | `{id:'status.panel', order:5}` | `StatusPanel`(:173) | 无 |
| 10 | `plugins/tasks/ui.tsx:25` | `shell.composer` | `{id:'tasks.dock', order:20}` | `TaskDock`(:50) | 无 |
| 11 | `plugins/tasks/ui.tsx:26` | `shell.composer` | `{id:'tasks.goal', order:22}` | `GoalBarSlot`(:103) | 无 |
| 12 | `plugins/settings/ui.tsx:106` | `shell.header` | `{id:'settings.panel', order:31}` | `SettingsPanel`(:111) | 无 |
| 13 | `plugins/team/ui.tsx:100` | `shell.header.lead` | `{id:'team.subagents', order:10}` | `SubagentMenu`(:164) | 无 |
| 14 | `plugins/team/ui.tsx:101` | `shell.header.lead` | `{id:'team.toggle', order:20}` | `TeamButton`(:143) | 无 |
| 15 | `plugins/trace/ui.tsx:69` | `SLOT.thread`=`shell.thread`(list) | `{id:'trace.view', order:1}` | `TraceView`(:73) | 无 |
| 16 | `plugins/transcript/ui.tsx:124` | `'shell.main'`(list) | `{id:'transcript.flow', order:1, children:{'transcript.toolview':'chain'}}` | `TranscriptFlow`(:212) | **`renderSlot?: (name, props?) => ReactNode`**（`RowBody` 传给工具行，:757） |
| 17 | `plugins/transcript/ui.tsx:129` | `'transcript.toolview'`(chain) | `{id:'transcript.toolview.builtin', priority:100, select:(owner)=>matchTool(toolOwnerCall(owner).name)}` | `BuiltinToolView`(:1086) | `{ entry:{call:ToolCallView}, matched:ToolMatch, storeKey? }`（:1086-1088；`ChainOutlet` 把 `matched` 并进 owner，`ui-shell/src/slots-react.tsx:77`） |

另：16 个插件里 6 个注册 dock 页签而不是槽（`registerDockTab`：browser:33 / preview:59 / files:68,69 / team:106 / terminal:63），
`browser/files/preview/terminal/plugins/skills/settings/trace/…` 的其余面走 `dock-state`。**这 16 个 register 调用的
options 里没有任何 owner-props 语义**——槽的 owner 份额在 dsc 至今是空集（`SlotOutlet` 调用点全不带 owner：
`ui-shell/src/app.tsx:220,250,254,301,306,312,323,327,337`）。**唯一有两个真实 props 的注册是 #17（chain）**。
这张表就是 D1 类型表的原料：D1 之后 15 条字面上不用改（槽名加进 SlotMap 即可编译过），#16/#17 是真改动点。

### 2.3 `inject` 字段现状与装载器实况（A1 的接入点）

- **字段定义**：`src/ui/manifest.ts:23-25`：
  ```ts
  /** 必须先把工厂注册好的其它插件 id。 */
  inject?: string[]
  ```
- **谁在填**：内置插件**一个都没填**——`ui-shell/src/plugins/*` 下没有 `plugin.json`
  （`find` 为空），而内置清单的 `inject` 唯一来源是 `plugin.json`（`ui-shell/build-plugins.mjs:100-130`：
  `readMeta` 只从 `plugin.json` 读 inject/external/immediately/platforms；package.json 只读
  `peerDependencies['@dsc/ui']` → 清单 `api`）。第三方插件由 `src/core/ui-bundles.ts:224` 从
  plugin.json 读；`examples/ui-plugin-demo` 的 plugin.json 也没有 inject。
- **顺序现在怎么定**：`src/ui/manifest.ts:126-158` `orderUiPlugins` = DFS 拓扑（byId → visit(inject 里的 id)），
  `inject` 里**不认识的名字被静默忽略**（:149-150 `const dependency = byId.get(name); if (dependency !== undefined) visit(dependency)`），
  成环报 `界面插件依赖成环：a -> b`。顺序只是优化（:119-121），正确性靠 `injectSlot`。
- **装载循环**：`ui-shell/src/boot.ts:109-206`。要点：
  - `factories` 缓存（:118）：`immediately` 先并发预取（:119-129），失败不记账；
  - `install(entry, attempt)`（:132-176）：`ledger` 记账 → factory（缓存或 fetch）→ instantiate
    → `apply(ui)` → 返回的 dispose 进 ledger → 成功报告 `attempts`;
  - 失败：`rollback()` 逆序退订，报告 `{ok:false, error, attempts}`；
  - **失败重试一轮**（:178-189），理由写在注释里：最常见的失败是顺序（`UndeclaredSlotError`），
    等声明者装完再试一次；只重试一轮；
  - `scopedSlots`（:214-230）把 `declare/register/injectSlot` 包进账本；
  - `disposeAll`（:195-204）逆序跑每个插件的 rollback。
  - **注意**：`factories.set(entry.id, factory)` 在 instantiate **之前**（:147-148），所以重试复用同一个工厂闭包
    —— **模块级状态跨重试存活**。D3 的 handle 必须在 `apply` 里创建，不能放模块级（dsh 同款警告，见 §1.3）。
- **TUI 侧**：`src/ui/tui-plugins.ts:66-177` 同名同形（无预取、无 `<script>`，`new Function` 求值；报告走
  `onReport`）。两壳语义「一致是契约的一部分」（:190-192 注释）——A1/D1 若要双壳，改动要成对。

### 2.4 `boot.ts:213` 账本与故障记账/退位（本波要接的另外两条轨）

- **账本**：`ui-shell/src/boot.ts:214-230`。凡插件在 apply 期间做的登记都进 `ledger`，重试/卸载逆序回滚。
  A1 的 `provide`、D2 的 `registerFactory`、D3 的席位声明都必须走它（逐条 `record(...)`）。
- **故障记账**：`src/ui/slots.ts:83-91` `SlotFault{slot,id,phase,error}`；`record` 保留最近 50 条（:503-512）；
  `reportFault`（:338-343）= 条目退位（`broken` 集合，不复活）；`elect` 里选择器抛错也退位（:322-328）。
  诊断区在 `ui-shell/src/app.tsx:481-558`（`useSlotFaults` → 列表；`data-fault` 属性供自检）。
- **遮蔽**：`deriveWinners`（`src/ui/slots.ts:524-537`）每格取 priority 最小；同格同 priority 在 register
  就抛 `DuplicateSlotError`（:107-116，文案已带「把 X 的 priority 调小」建议）。

---

## 3. 落点设计（可直接施工）

### 3.1 D1 类型化槽位契约

#### 3.1.1 合并表放哪（必须先拍这个）

**结论：`SlotMap` 声明在**插件 import 的那个模块**里，即 web 侧 `ui-shell/src/plugin-api.ts`（`@dsc/ui` 的
值面），TUI 侧 `src/ui/tui-plugin-api.ts`；`src/ui/slots.ts` 的 `SlotRegistry` 改成**对表泛型**
（`SlotRegistry<C, M extends SlotMapLike>`），只在方法签名里用 M。理由：
- dsh 的教训（引文 A）：`declare module` 的合并是**词法相邻**的，re-export 不参与合并。
- dsc 三种写码者：内置插件（tsconfig 与插件同 program，import `@dsc/ui`）、第三方 TS 作者
  （import `@dsc/ui` 的类型声明）、TUI（同一份插件源码 import `@dsc/ui`，解析到 TUI 面）。
  把表声明在 `@dsc/ui` 面上，三类人**都只需 augment 自己 import 的那个模块名**。
- 反例（别选）：声明在 `src/ui/slots.ts`（`@dsc/ui-core`）——内置插件能 augment（tsconfig paths 有），
  但第三方 TS 作者只能以为 `@dsc/ui` 可 augment 而被坑；而第三方在当前生态基本手写 JS（无构建），
  这条收益只在「将来有人用 TS 写第三方」时兑现，写在 `@dsc/ui` 面零成本且直白。

代价：web 与 TUI 两张表（键集天然不同：`tui.notice.extensions` 只在 TUI）。可接受，插件本来就用
`ui.host.platform` 分支（`plugin.ts:24-28`）。

#### 3.1.2 具体声明（照抄即可）

`ui-shell/src/plugin-api.ts`（`@dsc/ui`，web 面）：
```ts
/** 槽位契约表：槽名 → { kind; owner?; matched? }。壳与插件都用 declare module 往上并键。 */
export interface SlotMap {}
export type SlotName = keyof SlotMap & string
export type SlotKindOf<K extends SlotName> = SlotMap[K]['kind']
export type SlotOwnerOf<K extends SlotName> =
  SlotMap[K] extends { owner: infer O } ? O : Record<never, never>
export type SlotMatchedOf<K extends SlotName> =
  SlotMap[K] extends { kind: 'chain'; matched: infer M } ? M : never
/** 组件 props = owner 份额（含 chain 的 matched）+ 框架渲染能力份额。 */
export type SlotComponentProps<
  Owner = Record<never, never>,
  ChildKeys extends string = never,
  Matched = never,
> = Owner
  & ([Matched] extends [never] ? object : { matched: Matched })
  & {
    renderSlot: <K extends ChildKeys>(name: K, props?: SlotOwnerOf<K>) => ReactNode
    childSlots: readonly string[]
    renderFactorySlot: RenderFactorySlot
  }
```
（Factory 的 `RenderFactorySlot` 见 §3.4。）

`ui-shell/src/slots.ts` 的 9 个壳槽 + 插件自开的键，用 declare module 并进 `@dsc/ui`：
```ts
declare module './plugin-api' {
  interface SlotMap {
    'shell.header': { kind: 'list' }
    'shell.header.lead': { kind: 'list' }
    'shell.sidebar': { kind: 'list' }
    'shell.page': { kind: 'list' }
    'shell.main': { kind: 'list' }
    'shell.thread': { kind: 'list' }
    'shell.composer': { kind: 'list' }
    'shell.statusbar': { kind: 'list' }
    'shell.notice': { kind: 'single' }
  }
}
```
插件自开的子槽就地并键（例：transcript）：
```ts
// ui-shell/src/plugins/transcript/ui.tsx
declare module '@dsc/ui' {
  interface SlotMap {
    'transcript.toolview': {
      kind: 'chain'
      owner: { entry: { call: ToolCallView }; storeKey?: string }
      matched: ToolMatch
    }
  }
}
```
TUI 面 `src/ui/tui-plugin-api.ts`：`declare module './…'` 需要 TUI 面自己也 reintroduce
`SlotMap`——最省事的是 TUI 面 `export interface SlotMap { 'tui.notice.extensions': { kind: 'list' } }`
（TUI 的键就在 TUI 面声明；TUI 是 `src/plugins/tui.ts:48` 那个宿主插件先 declare 的）。

#### 3.1.3 SlotRegistry 的签名收窄（`src/ui/slots.ts`）

```ts
export interface SlotMapLike {
  [key: string]: { kind: SlotKind; owner?: object; matched?: unknown }
}

export class SlotRegistry<C = unknown, M extends SlotMapLike = SlotMapLike> {
  declare<K extends keyof M & string>(slot: K, kind: M[K]['kind']): () => void
  spec<K extends keyof M & string>(slot: K): M[K]['kind'] | undefined
  register<
    K extends keyof M & string,
    const D extends { [P in keyof M & string]?: M[P]['kind'] } = Record<never, never>,
    Mx = never,
  >(
    slot: K,
    options: SlotRegisterOptions<K, M[K], keyof D & string, Mx>,
    component: C & SlotComponentAlias<SlotOwnerOf<K>, keyof D & string, Mx>,
  ): () => void
  elect<K extends Extract<keyof M & string, ...>>(slot: K, owner: SlotOwnerOf<K>): ...
  injectSlot<K extends keyof M & string>(slot: K, contribute: () => void | (() => void)): () => void
}
```
- `SlotRegisterOptions<K, E, ChildKeys, Mx>`：
  `id/order/priority` 照旧；`key` 仅当 `E['kind'] extends 'keyed'`；
  `select?: (owner: SlotOwnerOf<K>) => Mx | null` 仅当 chain（非 chain 用 `never` 让误传报错）；
  `children?: Readonly<Record<ChildKeys, SlotKind>>`（子槽 kind 仍从 M 的键取：
  `children?: { [P in keyof M & string]?: M[P]['kind'] }`，由 D 泛型收窄到实参集合）。
- 组件别名（import type from `./plugin`? 不行——`src/ui/slots.ts` 不能依赖 React？**它现在就不依赖**：
  `SlotRegistry<C>` 的 C 是裸泛型。契约面（`@dsc/ui`）的 `SlotComponentProps` 可以带 `ReactNode`；
  核心只需要「C 的形状约束」。做法：核心定义
  ```ts
  export type SlotComponentLike<P> = (props: P) => unknown
  ```
  契约面再把它别名成 `(props) => ReactNode`（React 组件天然满足）。实现里的 cast 归渲染出口管。
- **`UiComponent = ComponentType<any>`（`ui-shell/src/plugin-api.ts:65`）改为**
  `export type UiComponent = (props: never) => ReactNode`（或 `ComponentType<never>` 等价的裸签名）。
  理由即 dsh `SlotComponent<never>` 的逆变技巧（引文 §1.1）；`ui-shell/src/slots-react.tsx` 内部把
  `entry.component` cast 成 `ComponentType<Record<string, unknown>>`（slots-ink.tsx:60 已是这个写法）——
  这是**内部擦除边界**，不是公开 `any` 逃逸。
- `elect` 的 owner 参数从 `unknown` → `SlotOwnerOf<K>`；运行期不变（`src/ui/slots.ts:311-331` 内部照旧读 `unknown`）。
- `SlotEntry.select` 字段保留 `((owner: unknown) => unknown) | null`（运行期记录，类型在登记面收窄）。

#### 3.1.4 17 个登记点的复核清单（谁必须改形）

| 登记点 | 收窄后是否要改 | 怎么改 |
| --- | --- | --- |
| #1–#15（15 条无 owner 的 list/single） | **不用改字面** | 只要槽名进 SlotMap；`register(SLOT.main, {…}, X)` 里 `SLOT.main` 的 const 字面量类型要与键一致（`ui-shell/src/slots.ts` 的 `SLOT` 已是 `as const`） |
| #16 transcript `'shell.main'` + `children:{'transcript.toolview':'chain'}` | 组件签名微调 | `TranscriptFlow({renderSlot}: SlotComponentProps<{}, 'transcript.toolview'>)`；`children` 的 kind 字面量 'chain' 由 D 泛型校验；`renderSlot?.(TOOLVIEW_SLOT, {entry, storeKey})` 的 props 收窄成 `SlotOwnerOf<'transcript.toolview'>`——**当前 `{entry, storeKey}` 正好吻合** |
| #17 transcript chain | **必须改形** | `select: (owner) => matchTool(owner.entry.call.name)`（owner 已类型化，`toolOwnerCall(owner as unknown)` 那层 cast 删掉/退化成纯函数）；`BuiltinToolView` 的 props 改为 `SlotComponentProps<SlotOwnerOf<'transcript.toolview'>, never, SlotMatchedOf<'transcript.toolview'>>`——`matched` 由框架注入，不再是手写 optional |
| TUI `examples/ui-plugin-demo` | 不用改（JS） | 无类型检查 |
| `src/plugins/tui.ts:48` 的 `registry.declare(TUI_SLOTS.noticeExtensions,'list')` | 不用改 | TUI 面的 SlotMap 含该键 |

`SlotOutlet`（`ui-shell/src/slots-react.tsx:27-51`）/`ChainOutlet`（:60-80）的 `owner?: Record<string, unknown>`
**保持擦除型，不参与公开契约**；`ChainOutlet` 里 `owner={{...owner, matched: hit.matched}}` 仍是运行期并键。
唯一新增：`SlotEntryHost` 的 `api` 加 `renderFactorySlot`（D2），其类型从 `SlotRenderApi` 来。

#### 3.1.5 负例探针（验收项 3）

新建 `ui-shell/src/slot-contract.typecheck.tsx`（**不进 bundle**：build-plugins 的 rollup 入口写死为
`src/plugins/<id>/ui.tsx`，`ui-shell/build-plugins.mjs:192`；该文件只被 `ui-shell/tsconfig.json` 的
`include:["src",…]` 吸入 typecheck）：
```tsx
declare const ui: UiPluginApi
// @ts-expect-error 槽名不在 SlotMap
ui.slots.register('shell.nope', { id: 'x' }, () => null)
// @ts-expect-error owner props 形状不对（shell.main 无 owner 键）
const Bad = (p: { nope: number }) => null
ui.slots.register('shell.main', { id: 'x' }, Bad)
// @ts-expect-error chain 登记必须给 select
ui.slots.register('transcript.toolview', { id: 'x' }, () => null)
// @ts-expect-error chain 的 select 返回类型与 matched 不一致（ToolMatch 之外）
ui.slots.register('transcript.toolview', { id: 'x', select: () => 1 }, () => null)
// @ts-expect-error children 声明了未在 SlotMap 的槽
ui.slots.register('shell.main', { id: 'x', children: { 'no.such': 'list' } }, () => null)
// @ts-expect-error renderSlot 的 props 与子槽 owner 不符
const BadChild = (p: SlotComponentProps<{}, 'transcript.toolview'>) => { p.renderSlot('transcript.toolview', { nope: 1 }); return null }
```
跑法：`pnpm -C ui-shell typecheck`（既有脚本，`ui-shell/package.json:10`）。`@ts-expect-error` 的反向保护
（负例不再报错 → “Unused '@ts-expect-error' directive” 报错）天然把负例钉死；不需要新工具。
再加一条**正例**文件内容：把 #16/#17 的真实写法抄一份（保证正例常绿）。
探针侧（`scripts/ui-plugin-test.mjs`）加 3 行：断言 `SHELL_SLOTS` 的 9 个键与 `SlotMap` 声明的键集在
`lib/ui` 编译产物里都存在（防「表改了一半」）——纯字符串/结构断言即可，不需要 DOM。

### 3.2 A1 客户端服务注入

#### 3.2.1 服务表（新文件 `src/ui/services.ts`，React-free，两壳共用）

```ts
export interface ServiceRecord { name: string; value: unknown; provider: string /* 插件 id */ }
export class ServiceRegistry {
  constructor(private readonly owner?: (name: string) => string | undefined) {}
  provide(name: string, value: unknown, provider: string): () => void  // 重复 provide 抛 ServiceConflictError
  consume<T>(name: string): T | undefined
  has(name: string): boolean
  names(): string[]
  subscribe(listener: () => void): () => void   // 诊断区/等待逻辑用
}
export class ServiceConflictError extends Error {}   // 「服务 X 已经由插件 Y 提供，Z 不能重复提供」
export class UndeclaredServiceError extends Error {} // provide 空名/非字符串
```
与 dsh 对应的语义差（如实写进代码注释）：dsh 服务是 cordis `Service`（fiber 生命周期、`ctx.inject`
动态等待）；dsc 这份是**装载期的值表**，没有 fiber——等待语义由装载循环实现（下节）。

#### 3.2.2 `UiPluginApi` 增两个方法（`src/ui/plugin.ts`）

```ts
export interface UiPluginApi<C = unknown> {
  id: string
  slots: UiSlotApi<C>
  host: UiHostInfo
  runtime: UiRuntimeApi
  /** 提供一个服务（同一个名字第二次 provide 抛装配错误）。返回值随插件卸载释放。 */
  provide<T>(name: string, value: T): void
  /** 读一个服务；缺席给 undefined（想「缺席就不装」用 plugin.json 的 inject 声明硬依赖）。 */
  consume<T>(name: string): T | undefined
}
```
类型可选增强（D1 风格）：`ServiceMap` declare-merge 表 → `provide<K extends keyof ServiceMap & string>(name: K, value: ServiceMap[K])`
/ `consume<K>(name: K): ServiceMap[K] | undefined`。dsh 靠 cordis 的 `Context` 声明合并（引文 §1.4），
dsc 用同一套 declare-merge 手法，表声明在 `@dsc/ui` 面（与 SlotMap 同址）。

#### 3.2.3 装载循环（`ui-shell/src/boot.ts`）

在 `loadUiPlugins` 里：
1. 建 `const services = new ServiceRegistry()`（每调用一次装载一把；`disposeAll` 不清空已提供的值，
   但每个 provide 的 disposer 进该插件 ledger——重试 rollback 会把服务一起撤掉）。
2. `install` 前解析 `entry.inject`，**先插件 id、再服务名**：
   ```ts
   const unmet: string[] = []
   for (const name of entry.inject ?? []) {
     const dep = reportById.get(name)                 // 名字是清单里另一个插件 id
     if (dep !== undefined) { if (dep.ok !== true) unmet.push(`插件 ${name} 没装上：${dep.error}`); continue }
     if (!services.has(name)) unmet.push(`服务 ${name} 还没有提供者`)
   }
   if (unmet.length > 0) { reportById.set(entry.id, { id, ok:false, error: `等待：${unmet.join('；')}`, attempts }); return error }
   ```
   这样「缺席不 apply + 诊断一行原因」直接落在既有报告通道（诊断区 `ui-shell/src/app.tsx:506-515` 已渲染）。
3. 失败重试一轮（`boot.ts:186-189`）保持：第一轮里「服务还没提供者」的失败在提供者装好后第二轮成功，
   报告 `attempts: 2`；若第二轮仍失败 → `ok:false`，error 文案即验收要的「一行原因」。
4. `scopedSlots`（`boot.ts:214-230`）旁边加：
   ```ts
   provide: (name, value) => record(services.provide(name, value, entry.id)),
   consume: (name) => services.get(name) as T | undefined,
   ```
   实际实现可以把 `ui` 对象拼装从 `install` 内联（boot.ts:153-158）抽成一个小函数。
5. **清单乱序也靠拓扑排好**：`orderUiPlugins` 已按 inject 拓扑（`src/ui/manifest.ts:126-158`）；
   服务名不在 byId 时静默跳过（:149-150），不影响排序，由上面的等待逻辑兜底。**不改 manifest 排序**。
6. 诊断面补一行：`UiPluginLoadResult` 加 `readonly services: readonly string[]`（装载结束时的服务名快照），
   `App` 透传给 `Diagnostics`，新增 `<p className="diag-line" data-services>服务：{names.join('、') || '无'}</p>`；
   `UiPluginLoadReport` 加可选 `provides?: string[]`（插件装成功后填入它 provide 过的名字，诊断可读）。

#### 3.2.4 TUI 侧（`src/ui/tui-plugins.ts`）

同一份 `ServiceRegistry`；`TuiPluginLoadOptions` 加 `services?: ServiceRegistry`（缺省新建）；
`install` 前的 inject 解析与 web 版逐字相同。TUI 的清单行来自 `collectUiArtifactsForPlatform('tui')`，
现有 `plugin.json` 就能带 `inject`（`src/core/ui-bundles.ts:224` 已解析）——**TUI 不需要新字段**。

#### 3.2.5 谁真正用（拒绝空 API）

- 生产消费者 1：**trace 插件 inject transcript**（D2 的 Factory 定义在 transcript 注册；trace 软降级见 §3.4）。
  这是硬依赖用例：transcript 被用户停用 → trace 报告一行「等待：插件 transcript 没装上」。
- 生产消费者 2：**status 插件 consume `'teammates'`（软）**（D3），team 缺席时走本地回落轮询。
- 探针：`scripts/ui-plugin-test.mjs` 造两个临时插件（沿用 `makeTree`），A provide / B inject；
  断言 ① 乱序清单经 `orderUiPlugins` 后 B 在 A 后、② A 的 apply 里 provide 后 B 的 consume 拿到同一对象、
  ③ A 不 provide（或 A 的 apply 抛错）时 B 报告 `ok:false` 且 `error` 含「服务 X 还没有提供者」、
  ④ 重复 provide 抛 `ServiceConflictError`。web 装载器依赖 DOM（`document.createElement('script')`，boot.ts:246-263），
  探针走 **`src/ui/tui-plugins.ts` 的 node 路径**测共享语义（两壳同表），web 侧靠既有桌面自检加一条
  `?diag=1` 断言（`data-services` 行）。

#### 3.2.6 与账本/退位/故障的衔接

- `provide` 的 disposer 走 `record(...)` → 重试 rollback / `disposeAll` 逆序撤服务；**服务表本身不产生
  SlotFault**（它不是槽的内容）。要可见性用报告与 `data-services` 行。
- provider 卸载后 consumer 还活着：consumer 的 `consume` 下一次读变 undefined（订阅式消费由 consumer 自己
  处理）。第一版**不**做「provider 卸载级联卸载 consumer」——那是 HMR（第 4 波）要重新算的账。

### 3.3 D3 store seats

#### 3.3.1 引擎（新 `src/ui/store.ts`，React-free）

不引 zustand/immer（dsc 根 `package.json`/`ui-shell/package.json` 都没有，引进来只为一个 ~80 行功能不划算）。
形状对齐 dsh 的**外部契约**（handle/instance/actions 烘焙）：
```ts
export interface SeatSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }
export interface StoreSpec<T, A extends ActionsDecl<T>> { init: () => T; actions: A }
export type ActionsDecl<T> = Record<string, (state: T, ...params: any[]) => void>   // 参数表按 action 再推断
export type BakedActions<T, A> = { [K in keyof A]: A[K] extends (s: T, ...p: infer P) => void ? (...p: P) => void : never }
export interface StoreHandle<T, A> { readonly spec: StoreSpec<T, A>; create(): SeatInstance<T, A> }
export interface SeatInstance<T, A> extends SeatSnapshot<T> { readonly actions: BakedActions<T, A>; readonly set: (next: T) => void }
export function defineStore<T, A extends ActionsDecl<T>>(spec: StoreSpec<T, A>): StoreHandle<T, A>
```
实现（~40 行）：`create()` 里持 `state`、`listeners`；`set` 换引用并同步通知；
每个 action 烘焙成 `(...p) => { const next = structuredClone?… }` —— **简化点写清**：
dsh 的 draft 是 immer proxy（可局部改嵌套），dsc 第一版用「浅拷贝顶层 + action 内部自行不可变」：
```ts
actions[key] = (...p) => { const draft = { ...state }; mutate(draft as T, ...p); set(draft as T) }
```
action 作者约定：**嵌套对象要么整体替换、要么展开新建**（注释 + typecheck 示例钉住）。
React 绑定（`slots-react.ts` / 或 store.ts 出一个 `useSeat(instance, selector, isEqual?)`）：
与 `useHostSelector`（`ui-shell/src/runtime-context.tsx:49-72`）同一手法（uSES + selector ref），
这样壳与插件两侧的订阅语义完全一致。

#### 3.3.2 席位声明与实例生命周期

- 登记 options（`src/ui/slots.ts` 的 `SlotRegisterOptions`）加：
  `store?: StoreHandle<any, any>`；转向后类型：按 `PropsStore`/`HandleOf` 推导组件 props 多出
  `{ useStore: <S>(sel:(s:T)=>S, eq?)=>S; actions: BakedActions<T,A> }`。
  类型不用 dsh 的 `StoreDecl`（共享 handle | 独占工厂）全量——第一版只支持**共享 handle**，
  独占工厂（每次登记 create 一份）等有真实需求再加（YAGNI；dsh 的独占工厂主要为 Factory 局部席位服务，
  见 §3.4）。
- **席位何时创建**：与 dsh 相同——register 只记 handle；instance 在**该条目首次渲染读 `useStore` 时**
  lazily 创建；`SlotRegistry` 侧 `seats: Map<handle, {refs:number; instance:SeatInstance}>`，
  `register` 时 refs+1，disposer refs−1，归零删记录（instance 一起走）。
  共享路径：两个插件登记同一个 handle 对象 → refs=2、**同一个 instance**。
- key 冲突（计划里那句「跨插件同 key 冲突拒绝并报人话」）的**真实对应物**（dsh 原文）：
  1. 同一个 handle 挂到不同作用域 → dsh 句子 `store handle mounted under "slot" (scope "root") is already mounted under scope "session" — one handle, one scope`（dsc 无 scope 轴，这条**不适用**）；
  2. Factory 独占席位带 persist → `exclusive store for factory "X" cannot declare persistence`（dsc 第一版没有 Factory 独占席位，**不适用**）；
  3. 计划自造的 `{key, spec}` 命名空间 → dsh **没有这个东西**。建议**不要引入**：席位身份就用 handle 对象
     （跨插件共享的正路是 A1 `provide/consume` 传同一个 handle），需要人话文案的地方是
     **`provide` 重名**：`服务 "teammates" 已经由插件 team 提供，插件 status 不能重复提供`（`ServiceConflictError`）。
     若实现仍想要字符串键：把 `spec.name?: string` 当**诊断标签**（报错/诊断区显示用），不承担身份。
- 卸载回收：条目 disposer refs−1；最后一个持有者卸载 → 删 instance。若 handle 由 `provide` 传出去，
  provider 卸载会先撤服务（A1 ledger），consumer 的 useStore 在那个条目的下一次渲染应抛装配错误
  （「席位 X 的提供者已卸载」）——按 dsh 的 StaleAuthorizationError 精神，**不静默画旧数据**。

#### 3.3.3 真实消费者（验收要的「两插件共享一个席位」）

事实（只读实测）：
- `ui-shell/src/plugins/team/ui.tsx:116-140` `useTeammates()`：挂载拉一次 + `setInterval(poll, 3000)`，
  invoke `listTeammates`；失败给空态；
  **调用者两处**：`SubagentMenu`（:165）与 `TeamPanel`（:218）——同插件内**两份独立轮询**
  （两个 hook 实例各起一个 3s interval，SubagentMenu 渲染返回 null 时轮询照跑）。
- `ui-shell/src/plugins/status/ui.tsx:193-213`：StatusPanel 自己再写一遍同逻辑（`POLL_MS = 5000`，
  文件头注释 :28-31 已自认「两个插件各拉一份已经是两份请求了」）。
→ 现状最多 **3 份并发轮询同一方法**（team×2 + status×1）。

落点（提名）：
- `team` 插件在 `apply` 里建 handle 并 `ui.provide('teammates', handle)`，
  handle = `defineStore({ init: () => ({ list: [] as TeammateView[] }), actions: { setList(d, list){ d.list = list } } })`；
  轮询驱动放在 **TeamButton**（`team/ui.tsx:143-161`，常挂载）的一个 effect 里：invoke → `actions.setList(...)`；
  SubagentMenu/TeamPanel 改读席位（`useStore(s => s.list)`，本会话过滤逻辑 `matesOf` :59-62 不变）。
- `status` 插件**不能只在 apply 期 consume**（team 稍后装载就拿不到，apply 只跑一次）。设计定稿：
  在 `src/ui/services.ts` 上放一个最小 React 订阅 `useService(name)`（订阅 `ServiceRegistry.subscribe`），
  StatusPanel 里 `const seat = useService<StoreHandle<…>>('teammates')`：
  有席位 → 读它（不再自拉）；无席位 → 保留现有本地轮询（`status/ui.tsx:193-213` 原样留作 fallback），
  席位出现/消失（team 启停）时自动切源，无需刷新页面。
- `status` 的**写路径**（停止队友 `stopTeammate`，`status/ui.tsx:249-254`）不进席位：它是动作不是状态；
  席位只承载名册数据（`list` + `setList`），`team` 面板的停止/发话也照旧直调通道。
- 验收对应：team 组件调 `setList` → status 面板读数同帧可见（同一 instance）；team 停用 → status 仍出数据
  （fallback），诊断区服务行显示无 `teammates`；team 停用再启用 → status 自动恢复共享源（`useService` 重订阅）。

### 3.4 D2 Component Factory

#### 3.4.1 API（`src/ui/slots.ts` + 渲染出口）

核心（React-free）：
```ts
export interface SlotFactoryDef<M extends SlotMapLike = SlotMapLike> {
  children?: { [P in keyof M & string]?: M[P]['kind'] }   // 普通槽：定义声明并渲染
  slots?: Record<string, { props?: object }>              // 局部位置：父按 occurrence 选组件
  store?: StoreHandle<any, any>                           // 可选；第一版只支持共享 handle
}
registerFactory<F extends keyof FactoryMap & string>(
  def: { name: F } & SlotFactoryDef<M> & { children?: FactoryChildrenOf<F>; slots?: RuntimeFactorySlots<F> },
  component: SlotComponentLike<FactoryComponentProps<F>>,
): () => void
factory<F>(name: F): StoredFactory | undefined
factoryVersion(name: string): number
subscribeFactory(name: string, listener: () => void): () => void
```
运行期规则（照 dsh，逐条可测）：
- 同名第二次注册抛 `装配错误：Factory "x" 已经定义（先注册者 …）`；
- children 与普通槽共用声明表：已声明（被任何登记/Factory）→ 抛（消息带首个声明者）；
- disposer 清定义 + collapse children；
- 父渲染：`renderFactorySlot(name, inputProps, { slots, fallback })`——定义缺席渲染 fallback；
  `slots` 里出现未声明的局部名 → `SlotAssemblyError`（**装配错误，必须炸**，与 dsc 现有取向一致）；
- 定义内部：`useFactorySlot(name, FallbackComponent)` 返回组件（父没选 → 用 fallback；返回的是组件不是节点）；
- occurrence 身份 = 挂载位置的 ref 对象；定义版本或（未来）父位置变化 → 重挂；崩溃 → 错误边界包住
  **只报故障、不摘除共享定义**（dsh `reportFactoryError`，slot 级故障记账不掺和）。

web 出口（`ui-shell/src/slots-react.tsx`）：
```tsx
export function FactoryOutlet({ slots, name, inputProps, selections, fallback }: {...}): ReactNode
```
内部：`useFactoryVersion(slots,name)`（uSES，仿 `useSlot` 的缓存稳定法：给 Factory 建 `factoryVersions` 缓存，
同版本返回同数字）+ 未注册 → fallback；然后 per-occurrence `<FactoryEntryHost>`：错误边界（组件/局部组件崩溃
都调 `slots.reportFactoryFault(name, error, phase)`）+ `FactoryOccurrenceContext`（提供
`{ slots, definition, selections }`）+ 把 `useFactorySlot` 和 `renderFactorySlot` 交给定义组件。

TUI 出口（`src/ui/slots-ink.tsx`）：同语义，条目壳换成 ink `Box`；若本波不做 TUI Factory，
在文件头注释明确写「TUI 暂无 Factory 出口（无消费者）」——**但 API 不要只在 web 存在**，
`ui.slots.registerFactory` 在 `UiSlotApi` 上两壳一致，只是 TUI 的渲染出口后补。

`@dsc/ui` 转出：`renderFactorySlot` 由 SlotEntryHost 的 api 给（不是 import 拿），
`defineFactory` 不需要；类型 `SlotFactoryDef/SlotFactoryMap` 从 `@dsc/ui` 出。

#### 3.4.2 Factory 与 children 的「类型对齐」验收怎么钉

- `FactoryChildrenOf<F>` 在类型上强制 children 的 key ∈ SlotMap、kind 匹配（照 dsh `FactoryChildrenCheck`，`ui-slots/src/index.ts:703-712`）；
- 运行期钉：注册一个 children:`{'transcript.toolcard.footer':'list'}` 的 Factory，另一个插件
  `ui.slots.register('transcript.toolcard.footer', {id:'demo.footer'}, X)` 直接进普通槽；
  探针断言 `slots.spec('transcript.toolcard.footer')==='list'` 在 Factory 注册后、`undefined` 在 Factory 卸载后
  （child collapse 递归清条目）。**消费者**：`examples/ui-plugin-demo/ui/client.js`（现有 demo 就往
  `hello.card.footer` 注册过，:32-36）改指到工具卡 footer——真实第三方通路在用，不是探针空转。

#### 3.4.3 真实消费者：工具卡装配（现状逐行差异）

同一套装配现在有两份实现：
- 对话页：`ui-shell/src/plugins/transcript/ui.tsx:1124-1317`（`ToolRow`；chain 当选者
  `BuiltinToolView` :1086-1088 只是把 matched 传进去；行体分派在 `RowBody` :751-758 调
  `renderSlot?.(TOOLVIEW_SLOT, { entry, storeKey })`，弃权落回 `<ToolRow>`）
- 轨迹页：`ui-shell/src/plugins/trace/ui.tsx:700-756`（`TraceToolRow`；`StepRow` :614 调它）

**完全一致（要搬进 Factory 定义的部分）**：
| 部件 | 对话页 | 轨迹页 |
| --- | --- | --- |
| 可展开判定 `expandable = call.status !== 'preparing'` | :1131 | :703 |
| head 容器/交互（role=button, tabIndex, aria-expanded, data-tip 三态文案, Enter/Space 切换） | :1205-1217 | :713-727 |
| `span.tool-dot` + `<Icon size=14 className="tool-icon"/>` + `span.verb`（`toolVerb(match.base,status)`）+ 未知工具名 | :1218-1223 | :728-732 |
| `span.status`（running 转圈、done 不印状态词、` · 用时 X`） | :1244-1249 | :734-739 |
| chevron（`IconChevronDown size={11}`） | :1265 | :740 |
| body 的「参数」`prettyJson(call.argsText)` + 「结果」条件（`resultText === undefined \|\| === ''` 不画） | :1305-1312 | :744-752 |
| 类名骨架 `.entry.tool-card status-* open` / `.tool-head` / `.tool-body` | :1204/1206/1268 | :712/714/743 |
| 数据口径 `toolSummary/matchTool/TOOL_STATUS_TEXT/prettyJson` | :67 导入 | :40 导入（同一平台模块 `ui-shell/src/platform/tool-summary.ts`） |

**按位置不同（Factory 的输入 props / 局部槽）**：
| 差异 | 对话页 | 轨迹页 | Factory 设计 |
| --- | --- | --- | --- |
| match 来源 | chain 当选的 `matched ?? matchTool(name)`（:1135） | 自算 `matchTool(name)`（:705） | input prop `match?: ToolMatch`（不传工厂自算）——把 #17 的 matched 直接喂进来 |
| 头行 preview | `intended`（`useIntendedDiff(call, cwd)`，transcript/intended-diff）优先，否则 summary（:1224-1243） | summary（:733） | **局部槽 `preview`**：transcript 传 `IntendedPreview`，trace 不传（Fallback=SummaryPreview） |
| 状态列时长 | `formatDuration`（中文口径，`platform/time.ts:45`），done 时不显示时长（:1198-1201,1248） | `formatTraceDuration`（`4.2s/1m03s`，`platform/time.ts:63`），done 时只印裸时长（:708,737-738） | **局部槽 `statusDetail`**：transcript 传 `ChatDuration`，trace 传 `TraceDuration` |
| body 额外块 | 「将做的改动」diff 块（:1288-1304） | 无 | **局部槽 `bodyExtra`**：transcript 传 `IntendedBody`；trace 不传 |
| 尾部按钮 | 「在轨迹中查看」（`openTrace(entry.id)`，:1250-1264） | 无 | **局部槽 `trailing`**：transcript 传 `TraceJumpButton`（`entryId` 由 input props 给） |
| 展开态 | per(会话:条目) 持久（fold-state `readFold/writeFold(storeKey)`，:1128,1143-1149） | `useState(false)`（:702） | input prop `persistKey?: string`：有则持久、无则临时（把 fold 读写下沉进 Factory 定义） |
| 吸附快捷栏 | 展开内容 >400px 出现（:1090-1108,1152-1196,1269-1287） | 无 | input prop `variant: 'chat' \| 'trace'`（`variant==='chat'` 才挂 bar）；**不**做成局部槽（它是行为不是组件） |
| 局部上下文 | `FoldPrefsContext`/`ShellCwdContext`/`ShellSessionContext`（:79,98,101,1127） | 无（cwd 不需要） | `intended` 相关全部留在 transcript 的局部组件里（`useIntendedDiff` 已独立成 `transcript/intended-diff.ts`，**不搬平台层**）；`foldPrefs` 作为 input prop 从 `TranscriptFlow` 传入 |

**落点步骤（施工顺序）**：
1. `src/ui/slots.ts` 加 Factory 注册表与校验（§3.4.1）；`ui-shell/src/slots-react.tsx` 加 FactoryOutlet
   + api 里加 `renderFactorySlot`；`src/ui/plugin.ts` 的 `UiSlotApi` 加 `registerFactory`。
2. 新建 **transcript 侧** `ui-shell/src/plugins/transcript/tool-card/`：
   - `factory.tsx`：`ToolCardFactory`（`apply` 里 `ui.slots.registerFactory({name:'transcript.tool-card',
     slots:{preview:{}, statusDetail:{}, bodyExtra:{}, trailing:{}}, children:{'transcript.toolcard.footer':'list'}}, ToolCard)`）
     与本地组件 `SummaryPreview`/`ChatDuration`；
   - 从 `ui.tsx:1124-1317` 把 head/body 骨架搬进 `ToolCard`（含 `readFold/writeFold`、sticky bar）；
     把 `:1224-1243`、`:1288-1304`、`:1250-1264` 抽成 `IntendedPreview`/`IntendedBody`/`TraceJumpButton`（transcript 传入）。
3. `RowBody` 的 tool 分支（`transcript/ui.tsx:751-758`）改为
   `renderFactorySlot('transcript.tool-card', { entry, storeKey, persistKey: storeKey, variant:'chat', match: hit?.matched, foldPrefs: prefs, cwd }, { slots: { preview: IntendedPreview, statusDetail: ChatDuration, bodyExtra: IntendedBody, trailing: TraceJumpButton }, fallback: <ToolRow …/> })`
   —— chain 的 `<ToolRow>` 保留为 `fallback`（Factory 未注册时行为与今天一致）。
   注意：**这条渲染发生在 chain 当选组件内部**（BuiltinToolView）；builtin 当选者变为「渲染 Factory occurrence」的薄壳，
   或者（更干净）`RowBody` 直接 `renderSlot(...) ?? renderFactorySlot(...)`，把 BuiltinToolView 删掉待定——**推荐前者**
   （chain 选举语义不变，第三方接管 toolview 时完全不经过 Factory）。
4. `trace/ui.tsx:614` 改 `renderFactorySlot('transcript.tool-card', { entry: step, variant:'trace', match: undefined }, { slots:{ statusDetail: TraceDuration }, fallback: <TraceToolRow entry={step}/> })`；
   `TraceToolRow` 先留着当 fallback（transcript 停用时轨迹页照常），落定后再删。
5. TUI：不动（工具卡的 TUI 版本不存在）。
6. `examples/ui-plugin-demo`：加一段往 `'transcript.toolcard.footer'` 注册 footer 行（走 `injectSlot`
   等声明——正好同时演示 A1 之外的既有机制），探针 `scripts/ui-third-party-test.mjs` 的 SAMPLE_BUNDLE
   相应加一行断言。

#### 3.4.4 Factory 的收益（为什么值这个工）

- 消除两份实现里的 head/body 骨架漂移（现在改一个 class 要改两处）；
- 局部组件选择让「对话页独有的 intended diff / 轨迹跳转 / 吸附栏」「轨迹页独有的耗时口径」**各自留在自己的
  插件里**，共享装配真正中立；
- children 给第三方提供「给所有工具卡加一行」的扩展点（比现在各自 shadow `transcript.toolview` 更细粒度）。

### 3.5 与故障记账 / 账本 / 退位（遮蔽）的衔接（汇总）

| 新机制 | 记账 | 退位/遮蔽 | 账本 |
| --- | --- | --- | --- |
| D1 | 无新故障源；类型错在 `tsc` 拦 | 不变（`winners`/`broken` 语义不动） | 不变 |
| A1 | 服务缺席是**装载报告**（`ok:false, error:'等待：…'`），不是 SlotFault | 与遮蔽无关 | `provide` 的 disposer 进 ledger；重复 provide 抛装配错误 |
| D2 | Factory 里组件崩 → 新 `reportFactoryFault(name, error)` 走同一条 `faultLog`（`slot` 记为 `factory:<name>`，`id` 记局部/定义），**不摘除定义** | Factory children 的条目照旧参与遮蔽；Factory 定义本身与遮蔽无关 | `registerFactory` 的 disposer 进 ledger |
| D3 | 席位写失败/提供者卸载 → 装配错误（炸）或诊断行；不产生 SlotFault | 与遮蔽无关 | 席位 refs 随条目 disposer；handle 由 provide 共享时 provider ledger 先撤服务 |

---

## 4. 验收与探针（计划 §2 项 1/3/4 + D3 自验收）

| 验收 | 探针/测试 | 落在哪 |
| --- | --- | --- |
| **项 1**（A provide、B inject；A 缺席 B 不 apply 且诊断一行原因；乱序清单也能排好） | `scripts/ui-plugin-test.mjs` 新增一节：`makeTree` 造 A/B 两个临时插件 + 清单乱序，用 `orderUiPlugins` 断言序；用 node 侧 `loadTuiPlugins`（隔离 `builtinDir`）实测 B 报告文案与 `consume` 取值；再跑一次「A 的 apply 抛错 → B 拒绝 apply」 | 新服务表 + 两装载器共用逻辑 |
| **项 3**（错 props 编译不过） | `ui-shell/src/slot-contract.typecheck.tsx`（§3.1.5 的 `@ts-expect-error` 清单）+ `pnpm -C ui-shell typecheck` 进电池；反例：故意删一条负例 → typecheck 报 unused directive | 固定跑法写进 docs/development 的电池段 |
| **项 4**（同一 Factory 两个无关父、各自选不同局部组件） | `scripts/ui-plugin-test.mjs`：注册一个测试 Factory（`slots:{a:{},b:{}}`、`children:{'x.footer':'list'}`），两个模拟父各传不同 `slots` → 断言渲染树里两个局部组件不同、children 槽的登记对两个 occurrence 都渲染；真实界面侧：桌面自检新增 `data-toolcard-factory` 断言（对话/轨迹两页同一条工具调用各自渲染、轨迹页无吸附栏/无「在轨迹中查看」） | 需要 DOM 的断言放桌面自检（`shots/` 既有 PowerShell/Electron 套路） |
| **D3 自验收**（两插件共享、卸载释放、冲突人话） | 探针：`defineStore` + 两个 register 共用 handle → 同 instance；disposer 全部释放 → `seats` 空；`provide` 重名 → `ServiceConflictError` 文案含两个插件 id；真实界面：team 开/停时 status 面板数据源切换（隔离 HOME 起壳，读 `data-services` 与 status 面板读数） | store.ts + services.ts 单测（node 侧，无需 DOM） |

---

## 5. 风险清单与裁定

### 5.1 16 个登记点的收窄影响（结论：真改动只有 1-2 处）

见 §3.1.4 矩阵。要点复述：
- 15 条无 owner 的登记**字面不改**，但要求 `SlotMap` 先声明全部 9 个壳槽键（`ui-shell/src/slots.ts`
  的 `SLOT` 常量已是 `as const`，直接用键名合并即可）；
- **#16/#17（transcript）是唯一必须改形的**：组件 props 从「无类型/`renderSlot?`」变为
  `SlotComponentProps<SlotOwnerOf<'transcript.toolview'>, never, ToolMatch>`；`select` 的 owner 从
  `unknown` 变 `{ entry… }`，`toolOwnerCall` 的断言消失；
- 编译面回归最大的隐性风险：`SHELL_SLOTS: Readonly<Record<string, SlotKind>>`（`ui-shell/src/slots.ts:66-76`）
  与 `main.tsx:90` 的 `Object.entries(SHELL_SLOTS).map(([slot, kind]) => slots.declare(slot, kind))`
  —— 改成 `{ [K in ShellSlot]: SlotMap[K]['kind'] }` 后，`Object.entries` 的键会退化回 `string`，
  `declare` 的 K 泛型推断不到。**改法**：main.tsx 改为 `for (const slot of Object.keys(SHELL_SLOTS) as ShellSlot[]) slots.declare(slot, SHELL_SLOTS[slot])`，
  或给 `SlotRegistry.declare` 留一个 `declare(slot: string, kind: SlotKind)` 的擦除重载（推荐后者，
  少动启动路径）。

### 5.2 §7.4 悬案裁定：`SlotOutlet.owner` 与 chain `select(unknown)` 会不会逼出 `any`

**裁定：不会。需要的是 3 处显式泛型 + 3 处内部 `as`，公开面零 `any`。**
1. `register<K extends keyof SlotMap, D, M>` —— K 收槽名、D 收 children（并推导 `renderSlot` 的可渲染键集）、
   M 收 chain select 的返回（推导组件 `matched`）。
2. `renderSlot<K extends ChildKeys>(name, props?: SlotOwnerOf<K>)` —— 显式泛型是为了**按子槽名分别**取 owner；
   它不是零成本声明合并能做到的（dsh 也为此写了 `RenderSlotFn<S>` 两段 call signature + `__renders` 幻影锚，
   见 §1.1；dsc 第一版可以不做 `__renders`「声明了必须渲染」的检查，把这条列为 dsh 对齐的已知欠账）。
3. `renderFactorySlot<F>` / `useFactorySlot<F, N>` —— 照 dsh。
`SlotOutlet` 的 `owner?: Record<string, unknown>` 与 `ChainOutlet` 的 `owner: Record<string, unknown>`
**保持不动**：它们是渲染出口的内部擦除面（条目组件在宿主里本来就是 `C`，调用点 cast 成
`ComponentType<Record<string, unknown>>`，`slots-ink.tsx:60` 已是这个写法）；只要 `UiComponent` 从
`ComponentType<any>` 换成 `(props: never) => ReactNode`（§3.1.3），类型检查就发生在 register/renderSlot
两个**插件作者写的调用点**，而不是出口。唯一的 `as` 清单：
① `SlotEntryHost` 调组件；② `ChainOutlet` 展开 `matched`；③ `elect` 内部把 `select` 从 `(owner: SlotOwnerOf<K>)=>M|null`
擦成 `(owner: unknown)=>unknown` 存进 `SlotEntry`。三处都带注释说明是「类型擦除边界」。
另外：`UiComponent` 换形状后**检查一遍 16 个插件的组件是否都是显式零参函数**——实测**全是**
（§2.2 表），所以是 drop-in；将来有组件声明具体 props 也天然可赋给 `(props: never)`。

### 5.3 我认为计划判断错了/需要修的地方

1. **D3 的 `store?: { key, spec }`**：dsh 席位没有字符串 key（身份是 handle 对象）；引入 key 命名空间会
   多出一张全局类型表 + 冲突消解故事，且共享的真实机制（同一 handle 引用）被绕开。建议改成
   `store?: StoreHandle`，跨插件共享走 A1 `provide/consume` 传 handle；「key 冲突的人话」落在
   `provide` 重名上（§3.3.2）。若将来确实要「按名字取席位」，再加 `StoreKeyMap` 不迟。
2. **「`inject` 字段清单里已有，按 entry.inject 拓扑排序 + 等服务就绪」**：语义要拆两层——`inject`
   的**插件 id** 现在只用于拓扑排序（`src/ui/manifest.ts:126-158`），**没人填**（§2.3）；「等服务」在 dsh
   是插件模块自己的 `inject` 导出（服务名表），与 `dsh.client.inject`（模块图边）是两张表（§1.4 引文 D）。
   dsc 只有一张表，建议明确为「先按插件 id 解、再按服务名解」（§3.2.3），并在 manifest.ts 注释里写清
   这个双关，否则第三方作者看不懂 inject 该填包名还是服务名。
3. **「D1 成本中，风险在改完所有内置插件的注册点」**：实测风险高估了一档——15/17 条零改动，
   真改的是 transcript 两条；主要成本在**定义 SlotMap 与 3 处显式泛型**（类型体操），不是登记点数量。
   相应地把「16 个插件的 register 调用都要复核」降级为「按 §3.1.4 矩阵复核 + 负例探针」。
4. **D2 的「成本中高」**：真实消费者成立（§3.4.3 差异表），但「两个无关父」的第二个父（trace）需要
   处理 fallback 与依赖关系（trace 想用共享卡就必须等 transcript 或降级保留 TraceToolRow）——
   建议把「trace 删掉自家 TraceToolRow」列为**本波之后**的收尾，不在 D2 验收里强求，
   否则 D2 一旦回归，轨迹页整页工具行全无（fallback 是保险丝）。
5. **D4 locale（计划标注可选）**：dsh 的 `t` 座位的实现路径是 `LocaleFace`（`ui-slots/src/renderer.ts:22-32`）
   + 渲染期按 `(ns, revision)` 派生函数引用；dsc 单语言，若哪天真做，最省的是「字典 + 一个 `t` 函数座位」，
   别引进 dsh 的 revision 订阅机器——这条维持计划「砍」的判断即可。

### 5.4 施工顺序（第 2 波内部，与计划一致）

`D1（类型）→ A1（服务）→ D3（席位，消费 A1）→ D2（Factory，消费 D1/A1/D3 的 handle 传递）`。
每一步提交口径：`npx tsc -p tsconfig.json` + `pnpm -C ui-shell typecheck` + `pnpm -C ui-shell build`
+ `node scripts/ui-plugin-test.mjs` + `node scripts/ui-third-party-test.mjs` + 桌面自检（带 `?diag=1`）。

---

## 6. 附：dsh 关键源码摘录汇编（施工免回读）

1. **注册位组件形状与逆变技巧**：`packages/client/ui-slots/src/index.ts:399-404`（`SlotComponent<P>`），
   `:1157-1201`（`register` 两 overload，`C extends SlotComponent<never>`）。
2. **五份额组装**：`ui-slots/src/index.ts:601-610`（`ComposedProps`）、`:251-258`（`PropsRuntime`）、
   `:373-397`（`PropsRenderSlots` + `__renders` 幻影锚）。
3. **Factory 三 API**：`ui-slots/src/index.ts:471-475`（`UseFactorySlot`）、`:484-491`（`RenderFactorySlot`）、
   `:732-737`（`RegisterFactory`）；**occurrence 选择实现**：`ui-renderer/src/client/scoped-slots.tsx:794-845`
   （`useFactorySlotRuntime`：context 校验 → 定义存活 → declared 校验 → `selected ?? fallback`）、
   `:938-975`（`FactoryOccurrenceBody`：`useRef` 做 occurrence、`retainFactoryOccurrence` 提交后保留）。
4. **store 契约与烘焙**：`packages/client/store/src/contract.ts:40-49`（ActionsDecl/BakedActions）、
   `:93-117`（Handle/Factory/Decl）、`:127-136`（BoundActions/PropsStore）；
   `store/src/index.ts:217-232`（defineStore 烘焙 actions）；`ui-renderer/src/client/registry.ts:632-665`
   （Factory 独占席位 + `cannot declare persistence` 文案）、`:667-684`（`retainFactoryOccurrence`）。
5. **服务注入**：`packages/client/web/src/seed.ts:24-39`（平台种子 9 项）、
   `packages/client/ui-chat/src/client/apply.ts:60-64`（`export const inject = [...]`）、
   `packages/client/web/src/boot-client.ts:79-81`（pending 缺服务的诊断文案）。
6. **Factory 真实用法（两个无关父）**：定义 `packages/client/ui-conversation/src/client/apply.ts:309-322`
   （`registerFactory({name:'conversation.content', slots:{views,widthControls}, …})`）；
   父 1 `ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:48-54`
   （`renderFactorySlot('conversation.content', {variant:'main',…}, {slots:{widthControls: ConversationWidthControls}})`）；
   父 2 `ui-subagent/src/client/sidebar-chat/index.tsx:145-147`
   （`renderFactorySlot('conversation.content', {variant:'embedded',…}, {slots:{views: FixedChatConversationView}})`）；
   定义内选择 `ui-conversation/src/client/skeleton/ConversationContent.tsx:29-30`
   （`useFactorySlot('views', ConversationSessionView)` / `useFactorySlot('widthControls', NoConversationWidthControls)`）。

---

## 7. 本次侦察未能定论/不确定项（交回给决策）

1. `services.ts` 的 React 绑定（`useService(name)`）放在 `src/ui`（两壳共用）还是 `ui-shell/src/plugin-api.ts`
   ——取决于 A1 是否要求 TUI 同步支持消费式切换；本文按两壳共用写（`src/ui/services.ts` 自带订阅）。
2. Factory 的 `children` 类型对齐要不要做 dsh 的 `__renders`「声明了必须渲染」强制检查——本文建议第一版不做，
   欠账如实记录；若第三方插件质量要求高再补。
3. `transcript.toolview` chain 的 BuiltinToolView 与 Factory 的嵌套方式（chain 当选壳内再渲染 Factory occurrence）
   在「第三方接管 toolview」与「第三方只加 footer」两种扩展之间是否有更干净的分层——实现时可再定，
   本文给了推荐（chain 不动，当选者渲染 Factory）。
