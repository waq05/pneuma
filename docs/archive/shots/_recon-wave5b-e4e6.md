# 第 5 波后半机制规格：E4 `@dsc/ui-slots` + `@dsc/ui-renderer` 拆包 / E6 平台种子扩容

> 只读侦察产物（2026-10-13）。基准：**主干 `D:\dsc`**（干净基态），参考实现 `D:\deepseek-harness\deepseek-harness`。
> 并行线不读、不改：w2（D1/A1/D2/D3）、w3（A2/A3/B）、w5（E2/E3/E5）、w6。
> 已落地前提（实际读到，非传闻）：`ui-shell/packages.json`（两包）＋ `ui-shell/packages.md` 的「新增包改四处」配方；
> `scripts/ui-plugin-test.mjs` 的 `[5b]` 钉 `packages.json ↔ tsconfig paths`；`src/ui/package.json` = `@dsc/ui-core`；
> 16 个内置插件目录各带 `package.json`（`build-plugins.mjs:69-100` 读 peer 区间写清单 `api`）。

---

## 0. 结论速览（施工者先看这十条）

1. **E4 拆两包**：`@dsc/ui-slots` = `ui-shell/src/slots.ts`(103) + `slots-react.tsx`(163)；`@dsc/ui-renderer` = `ui-shell/src/boot.ts`(296) + `main.tsx`(125)。
   （计划 §3-E4 写的 74/160/288/122 是旧行数，已漂移。）
2. **必须剪掉一条反向边**：`app.tsx`（E5 的 `@dsc/ui-layout`）`import { ALLOWED_MODULES } from './boot'`（`ui-shell/src/app.tsx:28`、用法 `:532`）。
   否则 `ui-renderer → ui-layout → ui-renderer` 成环。修法：`App` 加 `allowedModules` prop，由 `main.tsx` 传（`main.tsx:119` 就在构造 `<App/>`）。
3. **E4 不需要老路径转发壳**：`./boot` / `./slots` / `./slots-react` / `main.tsx` 的引用者只有 3 处（`app.tsx:28,30,31`、`main.tsx:17,20`、`plugin-api.ts:321`），**插件源码一处都不引用它们**（实测 grep 为空）。转发壳留给 w5 的 `platform/*`、`icons`、`dock-*`、`host-channel` 那些**插件按相对路径 import 的**文件。
4. **入口链只改一行**：`ui-shell/index.html:11` 的 `src="/src/main.tsx"` → 新落点；产物路径 `lib/ui/assets/{index.html,app-<hash>.js}` 由 `vite.config.ts:17,64` 钉死，不随源码搬家变。
5. **E6 = 三处一表**：`ui-shell/src/platform-modules.json` 加三个名字 → 构建期 external 自动生效（`build-plugins.mjs:53,60` 同读它）；
   但**运行期必须同时**在 `ui-shell/src/boot.ts:60-68` 的 `MODULES` 挂上实现，否则 `MODULE_DRIFT`（`boot.ts:75-82`）只在 console 里报一句、真 require 时抛「白名单外的模块」（`boot.ts:288-292`）。
6. **`@dsc/ui-core` 继续不给**：`build-plugins.mjs:56-60` 的 `EXTERNAL = [...PLATFORM_MODULES, '@dsc/ui-core']` 与探针 `ui-plugin-test.mjs:946-947` 两条都要保持原样。
7. **计划对 E6 验收的描述不准**：`settings` 的图标今天就来自 `@dsc/ui`（external，`plugin-api.ts:412-414`），**没有内联**；
   真正内联的是 `../../platform/select`（216 行源码 → 产物 5,665 B）与它拖进来的 2 枚图标（761 B）。验收判据要改成「`function Select(` / `function base(path` 在 settings 产物里消失」（见 §5.1）。
8. **内联基线（改前必记）**：16 个 bundle 共 593,085 B；5 个含内联平台代码：`settings 122,226`（+5,665+761）、`plugins 37,389`（+5,665+761）、
   `terminal 14,456`（+5,665+761）、`trace 61,179`（+6,399）、`transcript 111,101`（+12,021+2,506）。
9. **两份实例的正确性判定**：纯函数/常量（icons、select、time、tokens、tool-summary、paths、file-icons）重复只是体积问题；**带模块级状态的一律不许重复**
   —— `platform/toast.ts:28`、`platform/confirm.ts:30`、`platform/completion-sound.ts:171,384`、`platform/highlight.ts:99-100`、
   `dock-state.ts:53-57,175,243`、`dock-model.ts:111`（详见 §6.1）。`@dsc/ui-dockkit` 进种子首先是**正确性**要求，其次才是体积。
10. **版本纪律**：纯增量 → `ui-shell/package.json` 1.1.0 → **1.2.0**，且 `src/ui/package.json` 必须同步（探针 `ui-plugin-test.mjs:936-940` 钉「@dsc/ui-core 版本与壳 apiVersion 同源」）。
    `@dsc/ui` 的导出面**不变**（三个新包仍经它转出转出），所以第三方插件已有的 `api: ^1.1.0` 区间继续命中。

---

## 1. 参考实现：分工、依赖方向、原文

### 1.1 平台种子：9 项、名字与来源

`packages/client/web/src/seed.ts:1-8`（文件头注释）：
> "Platform-singleton module-table. These are the ONLY entities the shell shares into the frozen module table — fetch bundles
> resolve their externals against exactly this set through the loader's require. Keys come from the platform constant module
> ({@link ./platform.ts}, the single source of truth with the tsdown client externals); values stay shell-static imports so every bundle sees the same instance."

`packages/client/web/src/seed.ts:24-39`（种子表本体，逐字）：
```ts
export function getStaticModules(): Record<string, unknown> {
  // The satisfies pin is the projection contract: a word added to
  // PLATFORM_MODULES without a static import here (or vice versa) fails to
  // compile instead of drifting into a runtime require miss.
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
`packages/client/web/src/platform.ts:8-14`（名单，与 seed.ts 的 `satisfies` 对钉）：
```ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const
```
`platform.ts:16-18` 还有一份 `PRELOADED_CLIENT_EXTERNALS = []`（dsh 的「应用批预载」名单，目前为空）——dsc 不需要它。

### 1.2 种子怎么变成客户端的 require 面

- 种子表交给模块系统：`packages/client/web/src/boot.ts:71-76` `moduleLoader.create({ boot: win.__DSH_BOOT__, staticModules: getStaticModules(), ... })`。
- 模块系统收下：`packages/client/modules/src/client/system.ts:135` `this.seed = new Map(Object.entries(options.staticModules))`。
- 工厂拿到的 require 按「seed → 已物化记录 → 已注册工厂」三档查：`system.ts:324-337`
  ```ts
  const require = (spec: string): unknown => {
    edges.add(spec)
    if (this.seed.has(spec)) return this.seed.get(spec)
    const id = stripClientSuffix(spec)
    const record = this.loadCache.get(id)
    if (record !== undefined) return record.exports
    if (this.factories.has(id)) return this.materialize(id).exports
    throw new Error(`client-modules: require("${spec}") missed the module table — ...`)
  }
  ```
  `system.ts:338-347` 的 `require.async`（chunk/动态包）；`system.ts:385-392` 的 `import()` 只认 seed 词 / 已物化 / 图谱行。
- 构建期侧：`packages/client/tsdown.client.ts` 直接 `import { PLATFORM_MODULES } from './web/src/platform.ts'`（文件头注释第 4-8 行），即**同一份名单同时喂「运行期种子」与「构建期 external」**——与 dsc 的 `platform-modules.json` 是同一个套路（且 dsh 有编译期对钉，dsc 选择运行期 `MODULE_DRIFT` + 探针）。
- 模块表是**冻结基线**，插件额外的依赖走 `dsh.client.external`（`modules/README.md:46`）：
  > "The shell seeds a frozen module table (`PLATFORM_MODULES`: React, Cordis, and static UI libraries); every dynamic bundle resolves its externals against exactly that baseline. `dsh.client.external` adds only exact non-baseline requests, each answered by the dynamic package row it names or an exact static-table key. Type-only imports are erased and create no request. Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles."
  （`ui-tool/package.json:32-34` 就是这样声明 connection/locale/conversation 三个**由别的插件行提供**的 external。dsc 还没有「别的行提供 external」这层——E6 只扩基线，不碰 provider 语义。）

### 1.3 四个被下发的库：包形状（ESM/CJS、main/exports）

| 包 | `type` | `main` | `types` | `exports` | 被页面怎么消费 |
| --- | --- | --- | --- | --- | --- |
| `ui-slots` (`ui-slots/package.json:14-22`) | `module` | `lib/index.js` | `lib/types/index.d.ts` | `"."`（types+default）、`"./src/*"`、`"./package.json"` | 不作为 `client.js` 下发；是**壳的静态 import**（种子值），ESM，由 Vite/tsdown 打进壳 |
| `ui-primitives` (`ui-primitives/package.json:14-22`) | `module` | 同上 | 同上 | 同上 | 同上（`files: lib/index.js + lib/**/*.css + lib/types/**`） |
| `ui-dockkit` (`ui-dockkit/package.json:14-22`) | `module` | 同上 | 同上 | 同上 | 同上 |
| `store` (`store/package.json:14-22`) | `module` | 同上 | 同上 | 同上 | 同上 |

要点，逐条落到 dsc 的选择上：
- 四个库**都是纯 ESM 的库产物**（`"type": "module"` + `main: lib/index.js`），没有 CJS 面；
  插件 bundle 是 CJS 工厂，但它们在 **factory 执行时 require 到的是已经物化的 ESM 导出对象**（种子里塞的是 `import * as X` 的命名空间对象），所以不需要 CJS 互操作。
- `exports` 里带 `"./src/*"`：是给**同仓库源码级消费**留的后门（dsc 的逻辑分包正是这个思路，但走 alias 不走 exports）。
- 每个包 `peerDependencies: { cordis }`——dsh 的库都声明「cordis 由宿主提供」；dsc 的对应物是「`@dsc/ui` 不声明 peer，React 由种子提供」。
- **没有任何一个包是「单文件 bundle」**：`files` 里都是 `lib/index.js` + 类型 + css，说明「物化即整包一个模块」——种子表按包名给**整个命名空间**，不是按函数裁的。

### 1.4 `modules` 与 `ui-renderer` 的分工；`ui-slots` 为什么独立

- `modules`（`packages/client/modules`）：**取数与装载内核**。Node 半边 `src/index.ts`（1159 行）＝ 扫 `dsh.client` → 组启动图 → combo 路由（`index.ts:228-235` `comboSearch/comboUrl`，`??a,b&rev=`）→ 结构化 index 注入；
  浏览器半边 `src/client/system.ts`（486 行）＝ load/materialize/invalidate；`src/client/entries.ts` ＝ 页面条目对账。README 权威表述（`modules/README.md:12`）：
  > "the host half scans enabled Loader entries and composes the boot graph, an available Web carrier serves each bundle over `/plugins`, and a shell-owned carrier dispatches the same exact bundle responses through `fetchBundle()`. The browser half loads those bundles lazily on demand."
- `ui-renderer`（`ui-renderer`）：**渲染出口 + 应用装配根**。README（`ui-renderer/README.md:12,28,32`）：
  > "after the complete client plugin roster settles, the boot kernel calls `ctx.uiRenderer.mount(container)`, which hydrates the framework-free boot page and switches to the full React application before the next paint."
  > "This package is infrastructure: the web shell and the boot kernel are its only direct consumers."
  > "`mount(container)` installs the slot renderer, hydrates the existing boot DOM when present, renders the assembled application into the container before the next paint ... The renderer performs the sole context-level `renderSlot('root')` call."
  实现面：`src/client/index.ts`(98) 挂 `ctx.uiRenderer` + `SlotRegistry`；`src/client/registry.ts`(764) 是 `Service`（install slot renderer）；`src/client/scoped-slots.tsx`/`bindings.tsx`/`bind.ts` 是 React 绑定。
- `ui-slots`（`ui-slots`）：**React-free 的纯契约 + 账本内核**。README（`ui-slots/README.md:12`）：
  > "Both APIs derive scoped state, injection, locale, and child-render props from declaration-merged types and report conflicting definitions during plugin loading. **Pair this React-free package with `ui-renderer` when the client needs rendering.**"
  > "The ordinary Slot design is one table: **declaration = render authorization = runtime spec.** `SlotMap` is declared empty here and merged by consumers via `declare module` augmentation"（`README.md:56`）
- **为什么渲染出口不在 slots 里**：`ui-slots/src/renderer.ts:1` 首行注释就是边界定义——
  > "**React-free contracts between the slot host and an installed renderer.**"
  该文件只有类型（`import type { ReactNode }`、`import type { Context } from cordis`、`import type { ObservableSnapshot } from store`），值面全在 `ui-slots/src/index.ts`（`SlotCore` 等，1699 行）。
  `ui-slots/src/store.ts`(17) 更是只做「store 契约的类型再导出」（`export type { ... } from store`）。
- **依赖方向（实测）**：`ui-renderer → ui-slots`（`ui-renderer/src/client/registry.ts:19` `import { SlotCore, ... } from ui-slots`，`scoped-slots.tsx:9-15`、`bind.ts:11`、`bindings.tsx:3`）；
  `ui-dockkit → ui-primitives`（`ui-dockkit/src/components/TabPanel.tsx:26`、`FloatLayer.tsx:19`、`TabMenu.tsx:17,21`）；
  `ui-primitives → store`（仅 `ui-primitives/src/settings-form/form-model.ts:16` 一处 `createSnapshotStore`）。
  **slots / primitives / dockkit 都不 import cordis 值面**（只有 `ui-slots/src/renderer.ts:2`、`store` 的 peer 声明是类型/契约面）。
- **种子为什么含 ui-slots**（给 dsc 的启示）：dsh 的插件对 `ui-slots` 几乎全是 **type-only**（实测 `ui-*/src` 里 214 处 import，抽检 `ui-chat/src/client/contract/slots.ts:8-12`、`ui-tool/src/client/contract/slots.ts:4` 全是 `import type {...}`）；
  对 `store` 才是**值面真用**（`ui-chat/src/client/stores.ts:2` `import { defineStore }`、`transcript-view.ts:3` `createSnapshotStore`）。
  即：**种子词的价值 = 「插件作者能按这个包名写类型 / 拿运行时值」，而不是「每个插件都真调它」**。

### 1.5 dsc 的等价形状（结论）

| dsh 种子词 | dsc 现状 | E6 后 |
| --- | --- | --- |
| react / react/jsx-runtime / react-dom / react-dom/client | ✅ 4 项 | 不变 |
| `@deepseek-ai/cordis` | ❌（A1 决定不引 cordis，自写极简服务面） | 不加 |
| `@deepseek-ai/dsh-client-store` | ❌（dsc 的对应物是 `useHostSnapshot`/宿主快照，无客户端 store 库） | 不加（w2 的 D3 store seats 落在 `src/ui/store.ts`，属于 `@dsc/ui-core`，**故意不下发**） |
| `ui-slots` | ❌（壳内 `ui-shell/src/slots.ts`） | ✅ `@dsc/ui-slots` |
| `ui-primitives` | ❌（壳内 `icons.tsx` + `platform/*`） | ✅ `@dsc/ui-primitives` |
| `ui-dockkit` | ❌（壳内 `dock.tsx`/`dock-model.ts`/`dock-state.ts`） | ✅ `@dsc/ui-dockkit` |
| — | ✅ `@dsc/ui`（dsh 没有；dsc 的插件契约聚合面） | 不变 |
| — | ✅ `@xterm/xterm`、`@xterm/addon-fit`（2026-10-10 加，`boot.ts:56-58`） | 不变 |

**所以 E6 后是 10 项，不是 9 项**——「对齐 9」不是目标，别为了凑数删 xterm 或 `@dsc/ui`。

---

## 2. dsc 现状（主干，逐条证据）

### 2.1 四个文件：职责、行数、依赖边

| 文件 | 行数 | 职责 | 出边（实测） |
| --- | --- | --- | --- |
| `ui-shell/src/slots.ts` | 103 | 壳认的 9 个槽：`SLOT` 常量表 + `SHELL_SLOTS` 声明表 + `declare module './plugin-api'` 并 `SlotMap` + `ShellSlot` 类型 + 编译期钉 `_ShellSlotsPinned`(`:100-102`) | 类型：`./plugin-api`（`SlotKindOf`/`SlotMap`，`:16`）。运行时零出边 |
| `ui-shell/src/slots-react.tsx` | 163 | 浏览器壳**渲染出口**：`SlotOutlet`(`:27`)、`ChainOutlet`(`:60`)、`SlotEntryHost`（套 `div.slot-entry` + `data-slot/entry/cell`，`:124`）、`SlotErrorBoundary`(`:132`，装配错误重抛 `:144`)；`useSlot/useSlotFaults` 从 `@dsc/ui-core` 再转 (`:19`) | `react`、`@dsc/ui-core`（`SlotAssemblyError/useSlot/SlotEntry`）、类型 `./plugin-api` |
| `ui-shell/src/boot.ts` | 296 | 取启动图 `readBootGraph`(`:91`) → 按 `immediately` 预取(`:121-131`) → 顺序 install + 失败重试一轮(`:134-191`) → `scopedSlots` 记账外壳(`:220-237`) → `fetchFactory/appendScript/factoryTable`(`:240-282`) → `instantiate` + **白名单 require**(`:285-295`)；`ALLOWED_MODULES`(`:71`) | `react`×4、`@xterm/*`×2、`@dsc/ui-core`（**type-only**）、`./plugin-api`（**值**，`:35`）、`./platform-modules.json`（`:36`） |
| `ui-shell/src/main.tsx` | 125 | 应用入口：建注册表 + 声明壳槽(`:89-93`) → 建通道 + 外观(`:98-99,78-82`) → 取清单装插件(`:104-112`) → `createRoot(...).render(<StrictMode><RuntimeProvider><App/></RuntimeProvider></StrictMode>)`(`:116-122`)；CSS 次序 `legacy/*` → xterm → styles(`:31-40`) | `react`/`react-dom/client`、`@dsc/ui-core`（`SlotRegistry` + 类型）、`./plugin-api`(`onAppearanceRequest`)、`./boot`、`./host-channel`、`./runtime-context`、`./slots`、`./app`、`./appearance`、5 份 CSS |

外部引用者（全量，实测）：
- `ui-shell/src/app.tsx:28` `import { ALLOWED_MODULES } from './boot'`（用法 `:532` 诊断行「放行的模块：」）、`:30` `SlotOutlet, useSlotFaults from './slots-react'`、`:31` `SLOT from './slots'`
- `ui-shell/src/main.tsx:17` `readBootGraph, loadUiPlugins from './boot'`、`:20` `SHELL_SLOTS, ShellSlot from './slots'`
- `ui-shell/src/plugin-api.ts:321` `export { SLOT, type ShellSlot } from './slots'`
- **插件源码零引用**（`grep -rn "\.\./\.\./slots\|\.\./\.\./boot\|\.\./\.\./main" ui-shell/src/plugins` 为空）
- 仓库其他位置只引产物/文档，不引源码：`desktop/electron/main/index.ts:58` 提的是 `pnpm -C ui-shell build` 的产物目录；`scripts/boot-notices-test.mjs:65` 是注释。

### 2.2 模块白名单：三处一致性机制（谁与谁必须逐字一致）

```
ui-shell/src/platform-modules.json  ←── 唯一事实源（7 项，数组，顺序 = MODULES 键顺序）
   │
   ├─[运行期]→ ui-shell/src/boot.ts:36,75  PLATFORM_MODULES ←→ :60-68 MODULES 键集
   │            drift → console.error（:76-82，非致命）
   │            :71 ALLOWED_MODULES（诊断读数 app.tsx:532 用）
   │            :288-292 表外 require 抛错（运行期唯一的拒绝点）
   │
   ├─[构建期]→ ui-shell/build-plugins.mjs:53 PLATFORM_MODULES → :60 EXTERNAL = [...PLATFORM_MODULES, '@dsc/ui-core']
   │            → :194 rollupOptions.external（内置插件；**web 与 tui 两种 platform 的产物同用这一份**）
   │            → :120-126 plugin.json 的 external 必须 ⊆ PLATFORM_MODULES（内置插件构建期校验）
   │
   └─[探针]→ scripts/ui-plugin-test.mjs:946-947（只断言 `@dsc/ui-core` 不在表里）
```

要点：
- **「在哪一处加名字会同时生效」**：只有 `platform-modules.json` 一处是事实源——加进它，**构建期 external 立刻生效**（`build-plugins.mjs` 与 `vite.config.ts` 都从 `packages.json`/该 JSON 派生，不各写 alias）。
  但**运行期不会**：`boot.ts` 的 `MODULES` 是**手写值表**，必须同时挂实现（`import * as X from '@dsc/ui-primitives'` + 键），否则插件加载时抛「白名单外的模块」。
- **MODULE_DRIFT 只是 console 报告**，不是闸门 → E6 必须补一条探针断言（§5.2）。
- **`entry.external`（清单字段）在当前 dsc 是惰性的**：宿主只把它转发进启动图（`src/core/ui-server.ts:245`、`src/plugins/remote.ts:566`、`src/ui/manifest.ts:178`），**壳的 `boot.ts` 从不读它**。
  → E6 **不需要**改宿主侧任何代码；白名单是编译进壳 bundle 的 `MODULES`，不是运行时从图谱读的。
- TUI 是**另一张表**：`src/ui/tui-plugins.ts:44-49` `MODULES = { react, react/jsx-runtime, '@dsc/ui' }`（3 项），与 `platform-modules.json` 无关 —— 但**构建期 external 是共享的**（见 §6.2）。

### 2.3 插件今天拿得到什么、拿不到什么

**拿得到（值面）**：`@dsc/ui` 的转出面（`ui-shell/src/plugin-api.ts`）：
- 图标集：`:412-414` `export * from './icons'`（注释原文：「插件 bundle 里 `import { IconPin } from '@dsc/ui'` 即可，不必各自内联一份 SVG」）——**所以「图标拿不到」是错的**；
- `FileIcon/fileIconName`(`:418`)、`estimateTextTokens`(`:419`)、`diffLines`(`:421`)、模型能力枚举(`:427-436`)、
  `highlightLines/langForPath`(`:440`)、`DiffRows`(`:441`)、`CodeView`(`:442`)、`MarkdownView`(`:443`)、`PdfView`(`:444`)、`CsvView/XlsxView`(`:445`)、
  `toastOk/toastErr`(`:448`)、`confirmAction`(`:449`)；
- 平台状态面：`dock-state` 的订阅值(`:303-305`)、`page-state`(`:313,322`)、`thread-view`(`:330-332`)、运行时 hooks(`:409`)、`SLOT/ShellSlot`(`:321`)、`Text`(`:35`)、`TUI_SLOTS`(`:36`)。
- 17 个插件文件真的在用（`grep -rn "from '@dsc/ui'"` 命中 settings/ui.tsx:43、status/ui.tsx:55、composer/ui.tsx:40,57 …）。

**拿不到（今天只能相对路径 import → 内联一份）**，实测清单（`ui-shell/src/plugins/**` → `../../platform/*`）：
| 模块 | 引用者 | 形态 |
| --- | --- | --- |
| `platform/select.tsx`(216) | `plugins/ui.tsx:48`、`settings/ui.tsx:61`、`settings/models.tsx:52`、`terminal/ui.tsx:41` | 自绘下拉（门户浮层）——**不是** `@dsc/ui` 的导出 |
| `platform/time.ts`(75) | `trace/ui.tsx:38`、`trace/inspector.tsx:18`、`trace/trace-format.ts:19/22`、`transcript/ui.tsx:15`(timing) 等 7 处 | 纯函数 |
| `platform/tokens.ts`(26) | trace×2、transcript | 纯函数 |
| `platform/tool-summary.ts`(150) | `trace/ui.tsx:40`、`transcript/ui.tsx:70` | 纯函数，但 `:15` import 6 枚图标 → 把图标**拖进**产物 |
| `platform/paths.ts`(34) | `transcript/ui.tsx:67` | 纯函数 |
| `platform/hover-delay.ts`(77) | `transcript/ui.tsx:68` | 纯函数 |
| `platform/completion-sound.ts`(503) | `transcript/ui.tsx:69` | **模块级状态**（AudioContext/混响缓存） |
| `platform/panels.ts`(208)、`platform/thread-resizer.tsx`(117) | 0 个插件（壳自用） | — |
| `host-channel` 类型 | `files/ui.tsx:44` 是 `import type` → 擦除 | — |

**`slots` 面**：插件拿得到 `SLOT` 常量与 `ShellSlot`，但**拿不到渲染出口**（`SlotOutlet/ChainOutlet` 只在 `ui-shell/src/slots-react.tsx`，未进 `@dsc/ui`）；插件渲染子槽今天走条目 props 上的 `renderSlot`（`plugin-api.ts:48-53` 的 `SlotRenderApi`）。

### 2.4 产物体积基线（`lib/ui/plugins/*/client.js`，主干 2026-10-13 09:31 构建）

16 个 bundle，合计 **593,085 B**：

| bundle | 总字节 | 内联平台块（字节） | 内联块标记（行号） |
| --- | --- | --- | --- |
| settings | 122,226 | 图标 761 + Select 5,665 | `function sized(`=444、`function base(path`=447、`function Select(`=473 |
| transcript | 111,101 | completion-sound 12,021 + 图标 2,506 | completion-sound 982-1333、图标 1334-1417 |
| sessions | 66,709 | 0 | — |
| trace | 61,179 | 平台块（time+tokens+tool-summary+图标）6,399 | `function entryTs(`=7 … 205 |
| composer | 41,080 | 0 | — |
| plugins | 37,389 | 图标 761 + Select | `function sized(`=8、`function Select(`=37 |
| prompt | 26,907 | 0 | — |
| statusbar | 22,049 | 0 | — |
| files | 21,080 | 0 | — |
| skills | 21,044 | 0 | — |
| team | 18,742 | 0 | — |
| terminal | 14,456 | 图标 761 + Select | `function sized(`=10、`function Select(`=39 |
| status | 13,067 | 0 | — |
| preview | 6,043 | 0 | — |
| tasks | 5,934 | 0 | — |
| browser | 4,079 | 0 | — |

每个 bundle 的 require 面（实测 settings/status/sessions/trace/files）：`react`、`react/jsx-runtime`、`react-dom`、`@dsc/ui` —— 断言基座（`ui-plugin-test.mjs:877-881`）。

**测量命令（照抄）**：
```bash
cd D:/dsc/lib/ui/plugins
wc -c */client.js | sort -rn                                  # 总量
grep -c "function base(path" settings/client.js               # 1 → E6 后须为 0
grep -c "^function Select(" settings/client.js                # 1 → E6 后须为 0
grep -n "^function sized(\|^function Select(" settings/client.js | head -3
sed -n '444,472p' settings/client.js | wc -c                  # 761（图标块）
sed -n '473,634p' settings/client.js | wc -c                  # 5,665（Select 块）
```
（`minify: false`，`build-plugins.mjs:192`，所以标记串与行边界稳定、可直接断言。）

### 2.5 探针现状

`scripts/ui-plugin-test.mjs`：
- `[5]`（`:847-886`）：产物存在性、每 bundle 起手是 `(globalThis.__DSC_UI_FACTORIES__`、工厂签名、用 React 的 bundle 含 `require("react")`、无 `__SECRET_INTERNALS`、**每 bundle 含 `require("@dsc/ui")`**(`:880`)、含 `apply`、静态页 `index.html` 含 `app-`。
- `[5b]`（`:892-947`）：`packages.json` 必须有 `@dsc/ui`+`@dsc/ui-core`(`:905`)、每个落点在盘上(`:906-911`)、**按键集与 tsconfig paths 全等**(`:912-921`)、同键落点解析到同一文件(`:922-927`)、`src/ui/package.json` 是 `@dsc/ui-core` 且落点=其 `types`(`:929-935`)、版本同源(`:936-940`)、vite 与 build-plugins 都从 `packages.json` 生成 alias(`:941-942`)、**`@dsc/ui-core` 不在平台表**(`:946-947`)。
- 负例/门禁面：`:437-442`、`:513`（清单坏形状）、`:764-789`（界面通道白名单）；[5b] 之前还有 15 个内置插件 package.json 的 peer/api 断言（`[5]` 内 `:856-861`）。

`scripts/ui-third-party-test.mjs`（189 行）**不含任何平台模块表断言**：它只钉发现/启停/信任/内容 rev/伺服/TUI 装载（`:88-181`）。→ E6 的新断言全部落 `ui-plugin-test.mjs`，第三方探针**不需要跟改**（`external` 字段它也没断言）。

---

## 3. E4 落点设计（`@dsc/ui-slots` + `@dsc/ui-renderer`）

### 3.1 包边界怎么划

**`@dsc/ui-slots`**（槽位包）
- 收：`ui-shell/src/slots.ts` → `ui-shell/src/ui-slots/slots.ts`；`ui-shell/src/slots-react.tsx` → `ui-shell/src/ui-slots/slots-react.tsx`；新增 `ui-shell/src/ui-slots/index.ts` 两行再导出；新增 `ui-shell/src/ui-slots/package.json`。
- 建议导出面（值）：`SLOT`、`SHELL_SLOTS`、`ShellSlot`(type)、`SlotOutlet`、`ChainOutlet`、`SlotErrorBoundary`?（建议**不导出**边界类，只导出两个 Outlet + `useSlot/useSlotFaults` 再导出）。
- 依赖：`@dsc/ui-core`（`SlotRegistry` 类型、`useSlot/useSlotFaults/SlotAssemblyError/SlotEntry`）、`react`（种子提供）、**type-only** 依赖 `@dsc/ui` 的 `SlotMap/SlotKindOf/UiComponent/UiSlots/SlotRenderApi`。
- **`SlotMap` 表不住在本包**（w2 规格 §3.1.1 已拍：表声明在 `ui-shell/src/plugin-api.ts`，插件 aug­ment `@dsc/ui`）。本包只**并壳的 9 个键**，且 `declare module` 必须用能解析到 `plugin-api.ts` **同一个文件**的路径（现为 `'./plugin-api'`；搬家后写 `'../plugin-api'`）。文件身份规则见 `slots.ts:18-25` 的注释原文与 w2 §3.1.1。
- 依赖方向：运行时 `ui-slots → ui-core`；`@dsc/ui`(plugin-api) `→ ui-slots`（值再导出）。**没有运行期环**（type-only 反向边被擦除）。

**`@dsc/ui-renderer`**（渲染器/装载器包）
- 收：`ui-shell/src/boot.ts` → `ui-shell/src/ui-renderer/boot.ts`；`ui-shell/src/main.tsx` → `ui-shell/src/ui-renderer/main.tsx`；新增 `ui-shell/src/ui-renderer/index.ts`（导出 `readBootGraph/loadUiPlugins/ALLOWED_MODULES`）；新增 `package.json`。
- 依赖：`@dsc/ui`（值：MODULES 里的 `pluginApi` 种子）、`@dsc/ui-core`(type)、`@dsc/ui-slots`、`@dsc/ui-layout`(E5：`App`)、`host-channel/runtime-context/appearance`(E5 归 layout，main.tsx 直接 import 或由 layout 转出)。
- 目标形态对齐 dsh 的 `modules` 与 `ui-renderer`「两个包」的划分——但注意 dsc 的 boot.ts 同时是**装载器**（≈dsh `modules` 的浏览器半边）与**平台种子表持有者**（dsh 是 `web/src/seed.ts` 持有）。**别把 `boot.ts` 再切一刀**：切了就要动 w3 刚改完的取数路径，收益为零。

### 3.2 必须剪掉的反向边（否则成环）

`ui-shell/src/app.tsx:28` `import { ALLOWED_MODULES } from './boot'`，唯一用法 `:532`：
```tsx
<p className="diag-line">放行的模块：{ALLOWED_MODULES.join('、')}</p>
```
E4 后 app.tsx 属 `@dsc/ui-layout`，boot.ts 属 `@dsc/ui-renderer` → `ui-layout → ui-renderer → ui-layout` 环。

**修法（推荐）**：`App` 的 props 加 `allowedModules: readonly string[]`；`main.tsx:119` 传 `allowedModules={ALLOWED_MODULES}`。
理由：① runtime 无环；② 诊断区读数的语义不变（仍是「壳当前放行的模块」）；③ 不新增包名/子路径 alias。
**不推荐**：给 `@dsc/ui-renderer` 开 `"./diagnostics"` 子路径 alias（`packages.json` 的键是包名，子路径要靠 `'@dsc/ui-renderer/diagnostics'` 另立一条，反而多一处漂移面）。

### 3.3 老路径转发壳：**E4 不需要**

判据（实测）：转发壳只为「**不受本仓库 tsc/vite 管辖的引用者**」而留——即插件源码里的相对 import（w5 的 `platform/*`、`icons`、`dock-*`、`host-channel`、`page-state`、`thread-view`、`runtime-context`、`appearance`，插件共 20+ 处）。
E4 的四个文件**一个插件都不引用**（§2.1 末条），引用者只有 `app.tsx` / `main.tsx` / `plugin-api.ts` 三处，同一次提交里改完即可，**留壳等于留死代码**。
唯一外部字符串是 `ui-shell/index.html:11` 的入口（§3.5）。

### 3.4 跟改清单（漏一个就炸）

| 处 | 改什么 | 证据 |
| --- | --- | --- |
| `ui-shell/packages.json` | +`"@dsc/ui-slots": "./src/ui-slots/index.ts"`、+`"@dsc/ui-renderer": "./src/ui-renderer/index.ts"` | `vite.config.ts:24-29`、`build-plugins.mjs:36-39` 都读它 |
| `ui-shell/tsconfig.json` | `paths` 手抄同两条 | `tsconfig.json:17-20`；漂移由 `ui-plugin-test.mjs:912-921` 钉 |
| `ui-shell/src/ui-slots/package.json`、`src/ui-renderer/package.json` | `name`（=包名）、`version`（跟壳）、`types: "index.ts"` | `packages.md:11` 第 3 条、探针 `:906-911` |
| `ui-shell/index.html` | `src="/src/ui-renderer/main.tsx"` | `index.html:11` |
| `ui-shell/src/plugin-api.ts:321` | `from './slots'` → `from '@dsc/ui-slots'` | 值再导出 |
| `ui-shell/src/app.tsx:28,30,31,532` | `./boot`→prop；`./slots-react`→`@dsc/ui-slots`；`./slots`→`@dsc/ui-slots` | 唯一引用者 |
| `ui-shell/src/main.tsx`（搬到新落点后） | `./boot`→`./boot`（同包，不变）；`./plugin-api`→`'@dsc/ui'`（或 `'../plugin-api'`）；`./slots`→`@dsc/ui-slots`；`./app`→`@dsc/ui-layout`（E5）；`legacy/*.css` 相对路径 +1 层 | `main.tsx:16-40` |
| `ui-shell/src/boot.ts`（搬到新落点后） | `./plugin-api`→`'@dsc/ui'`（**值**，MODULES 的 `@dsc/ui` 种子要用它）；`./platform-modules.json` 相对路径随目录 +1 层（或一并挪进包目录） | `boot.ts:35-36,65` |
| `ui-shell/vite.config.ts` / `build-plugins.mjs` | **不用改**（从 packages.json 生成 alias） | `:24-29` / `:36-39` |
| `scripts/ui-plugin-test.mjs` `[5b]` | **不用改即绿**（键集全等是按两边算的）；建议加「每个注册包有 package.json 且 name/types 对钉」（§5.2） | `:912-935` |
| `ui-shell/packages.md:17-18` | 删「将来那五个包刻意不预注册」那段、改成分包路线已落地 | 会误导后来者 |

### 3.5 入口链搬家后不变

```
宿主伺服 lib/ui/assets/index.html （ui-server.ts:205 插 <script src="/boot.js">；CSP script-src 'self'）
  └─ index.html 内 <script type="module" src="/src/ui-renderer/main.tsx">   ← 只此一行随源码落点变
       └─ vite build（root=ui-shell/，vite.config.ts:35）→ lib/ui/assets/app-<hash>.js
```
- `outDir`（`vite.config.ts:17`）、`entryFileNames: 'app-[hash].js'`（`:64`）、`emptyOutDir` 清的都是**产物路径**，与源码落点无关 → `lib/ui/assets`、`lib/ui/plugins` 一字不变；`prepare-runtime.mjs:32` 整块拷 `lib/`，不受影响。
- 探针 `ui-plugin-test.mjs:884-885` 的「壳页面挂了入口脚本（含 `app-`）」继续绿。

### 3.6 rebase / 收尾顺序（w2/w3/w5 并行下的唯一安全路径）

冲突面：
- **w2** 改 `src/ui/slots.ts`（登记签名收窄）、`plugin-api.ts`（SlotMap + Factory/seats/provide/consume）、`ui-shell/src/slots-react.tsx`（Outlet 加 Factory 出口）、`boot.ts`（服务面拓扑/账本）。→ **命中 E4 两个包的全部文件**。
- **w3** 改 `boot.ts`（分批/combo 取数）、新增 `hmr.ts`、可能改 `main.tsx` 接线。→ **命中 E4 的渲染器包**。
- **w5** 把 `icons/platform`→`ui-primitives`、`dock-*`→`dockkit`、`app/review-pane/thread-view/page-state/host-channel/runtime-context/appearance`→`ui-layout`（带转发壳）。→ 命中 `main.tsx` 的 import 面与 `app.tsx`（E4 的反向边就在那儿）。

**结论（照做）**：
1. **E4 必须在 w2 与 w3 之后**（与计划 §3-E4「与 A3/B 同片代码，放它们之后」一致，且这里给出更细的理由：w2 定 `SlotMap` 的归属与 Outlet 的形状，w3 定 boot.ts 的取数形状；先搬后改 = 搬两次）。
2. **E4 内部次序**：先 `@dsc/ui-slots`（纯搬迁 + 改 `declare module` 路径 + 三条引用改动），跑 `tsc + ui-plugin-test`；再 `@dsc/ui-renderer`（含剪反向边 + index.html 一行），再跑一遍电池。
3. **E5 必须在 E4 之前**（`main.tsx` 的 `./app`、`./host-channel`、`./runtime-context`、`./appearance` 四组 import 由 w5 决定最终落点；E4 最后只做「改包名」）。
4. **E6 最后**（依赖 E2/E3/E4 的三个包名都能被 alias 解析；`platform-modules.json` 里加名字而 alias 不存在 = 把编译错误变成运行期怪事，`packages.md:17-18` 已立此规）。
5. **w6** 与本片无文件交叠。

### 3.7 E4 施工步骤（可照抄）

1. `mkdir ui-shell/src/ui-slots`，`git mv` 两个文件进去，加 `index.ts` + `package.json`。
2. `slots.ts` 里 `declare module './plugin-api'` → `'../plugin-api'`（并在注释里保一句「同一文件身份」的理由，别改成 `@dsc/ui`——re-export 不参与合并，`@dsc/ui` 只在 **plugin-api.ts 自己**的文件身份上成立）。
3. `slots-react.tsx` 的 `./plugin-api` → `'../plugin-api'`。
4. `plugin-api.ts:321` 改成从 `'@dsc/ui-slots'` 转出。
5. `app.tsx` 三处 import + `App` 加 `allowedModules` prop。
6. `packages.json` + `tsconfig.json` 各加一条；`index.html` 暂不动。
7. `mkdir ui-shell/src/ui-renderer`，`git mv boot.ts main.tsx index.ts`，`main.tsx` 加 `allowedModules={ALLOWED_MODULES}`、改 `./slots`→`@dsc/ui-slots`、CSS 相对路径 +1 层、`./app` 等按 E5 落点写包名；
   `boot.ts`/`main.tsx` 的 `./plugin-api` → `'../plugin-api'` 或 `'@dsc/ui'`（二选一；两者解析到**同一模块实例**，MODULES 的 `@dsc/ui` 种子值必须与壳内部用的是同一份）；`boot.ts` 的 `./platform-modules.json` 路径随目录 +1 层（或把 JSON 挪进包目录）。
8. `index.html:11` 改入口。
9. `npx tsc -p tsconfig.json && pnpm -C ui-shell build`；`node scripts/ui-plugin-test.mjs`；`node scripts/ui-third-party-test.mjs`；桌面自检（`DSC_CHECK_EXE` 一条）。

---

## 4. E6 落点设计（平台种子扩容）

### 4.1 精确改法（三处的关系与顺序）

**改（同一提交内）**：

1. `ui-shell/src/platform-modules.json` —— 追加三个名字，**顺序与 `MODULES` 键顺序一致**（现状两边都是 react/react-dom/react-dom/client/react/jsx-runtime/@dsc/ui/xterm×2）：
```json
[
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "@dsc/ui",
  "@dsc/ui-slots",
  "@dsc/ui-primitives",
  "@dsc/ui-dockkit",
  "@xterm/xterm",
  "@xterm/addon-fit"
]
```
（位置建议：紧跟 `@dsc/ui` 之后——`MODULES` 与诊断区读数都按这个顺序显示，人读时「壳的契约面」聚在一起。）

2. `ui-shell/src/boot.ts` —— 文件顶部加三个静态 import，`MODULES`(`:60-68`) 加三个键：
```ts
import * as uiSlots from '@dsc/ui-slots'
import * as uiPrimitives from '@dsc/ui-primitives'
import * as uiDockkit from '@dsc/ui-dockkit'
// ...
const MODULES: Readonly<Record<string, unknown>> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': jsxRuntime,
  '@dsc/ui': pluginApi,
  '@dsc/ui-slots': uiSlots,
  '@dsc/ui-primitives': uiPrimitives,
  '@dsc/ui-dockkit': uiDockkit,
  '@xterm/xterm': xterm,
  '@xterm/addon-fit': xtermFit,
}
```
并在 `:45-59` 的表头注释里补一句：这三个由壳的**同一个 vite 图**提供，插件的 require 拿到的是与壳内部**同一份实例**（否则会踩 §6.1 的状态类）。

3. `ui-shell/build-plugins.mjs` —— **不用改**：`:53` 读 JSON、`:60` 组 `EXTERNAL`、`:120-126` 校验插件 `plugin.json` 的 `external` ⊆ 该表，全部自动跟上。
   **注意顺序**：先改 1、2，再跑 `build-plugins`；若先构建再改表，产物里那些模块会被内联成另一份（正是探针 §5.1 要抓的形态）。

**不要改**：`src/core/*`（宿主完全不读平台表，§2.2）、`src/ui/tui-plugins.ts`（TUI 表是另一份，见 §6.2）、`build-plugins.mjs:56-60` 的 `EXTERNAL` 里 `@dsc/ui-core` 一格。

**连带**：
4. `docs/plugin-development.md` §10.4（`:656-666`）在那张「壳内置平台层（仅 web 值面）」表后补一节：新增三个**平台包**（web 值面），并写死「TUI 壳的 `@dsc/ui` 与 require 表都不含它们，双载体插件先判 `ui.host.platform`」。
5. `ui-shell/package.json` `version` 1.1.0 → **1.2.0**；`src/ui/package.json` `version` 同步 1.2.0（探针 `:936-940` 钉同源）。`@dsc/ui` 的导出面零变化 → 升级纪律里「纯增量 → 次版本 +1」。
6. `ui-shell/packages.md:12-15` 的「新增一个包要同时改四处」第 4 条已写明这条流程，无需改（可作为施工者对照）。

### 4.2 运行期 require 面怎么给值（值面 / 纯类型面判定）

| 种子词 | 值面？ | 给值的方式 | 依据 |
| --- | --- | --- | --- |
| `@dsc/ui-slots` | **值面**（`SLOT`/`SHELL_SLOTS` 常量 + `SlotOutlet`/`ChainOutlet` 组件 + `useSlot/useSlotFaults` 钩子） | `import * as uiSlots from '@dsc/ui-slots'`（alias → `src/ui-slots/index.ts`） | `slots.ts:41-93`、`slots-react.tsx:27,60,19` |
| `@dsc/ui-primitives` | **值面**（图标组件、`Select`、`DiffRows`、`CodeView`、`MarkdownView`、`FileIcon`、`toastOk` 等） | `import * as uiPrimitives from '@dsc/ui-primitives'` | `plugin-api.ts:412-449` 今天就从这些文件转出 |
| `@dsc/ui-dockkit` | **值面**（`dock-*` 模型/状态/组件） | `import * as uiDockkit from '@dsc/ui-dockkit'` | `plugin-api.ts:303-305` 今天转出 dock-state |
| `@dsc/ui-core` | 值面但**故意不给** | 不 import、不进表 | `build-plugins.mjs:56-60`、`boot.ts:53-54`、探针 `:946-947` |

- 三个 `import * as` 进 `boot.ts` 后，vite 会把它们留在壳 bundle 里（今天经 `plugin-api.ts` 的再导出**已经在**壳 bundle 里了，所以**壳体积几乎不变**；变的是**插件产物体积**）。
- 「值面」不要求插件一定用；type-only import 被 erase（dsh 同款规则，`modules/README.md:46`），所以插件写 `import type { SlotOutlet } ...` 不会产生 require。

### 4.3 `@dsc/ui-core` 边界（别踩）

三条同时保持：(a) `platform-modules.json` 不含它（探针 `:946-947`）；(b) `build-plugins.mjs:60` 的 `EXTERNAL` 含它 → 插件当值用会在运行期得到「白名单外的模块」而不是静默内联一份私有实现；(c) `boot.ts:53-54` 的注释保留。
风险动作：有人为了「让插件也能用 SlotRegistry」把它加进 JSON —— **不行**（那是壳的内部实现 + 宿主契约面），插件要用槽位能力就走 `@dsc/ui` / `@dsc/ui-slots`。

### 4.4 三个新包的 `package.json` 帧 / `exports`：需不需要

- **需要帧**：`packages.md:11` 第 3 条 + `ui-plugin-test.mjs:929-935` 拿它当锚（现在只对 `@dsc/ui-core` 做了这条检查，建议扩成全包循环，§5.2）。内容最小集：`{ name, version, private: true, type: "module", types: "index.ts" }`（照 `src/ui/package.json`）。
- **不需要 `main`/`exports`**：消费路径只有两条——`tsconfig.json` 的 `paths`（编译期）与 vite/build-plugins 的 alias（构建期）。没有任何 node/浏览器裸导入走包解析。dsh 需要 `exports` 是因为它把包真发给 npm（`ui-primitives/package.json:14-22`）；dsc 的第三方走 `~/.dsc/plugins/`，不经过 npm。
- **不需要 `files`**。

### 4.5 诊断区读数与跟改

- `app.tsx:532` `放行的模块：{ALLOWED_MODULES.join('、')}` 自动多出三个名字（`ALLOWED_MODULES = Object.keys(MODULES)`，`boot.ts:71`）→ **零改**；确保 E4 的 `allowedModules` prop 传的是同一份值。
- 探针应把这一条钉死（§5.2），因为 `MODULE_DRIFT` 只是 console.error。

### 4.6 E6 施工步骤

1. 确认 E2/E3/E4 已落：`packages.json`/`tsconfig` 里三个包名可解析、三个包目录都有 `package.json`。
2. 改 `platform-modules.json`（§4.1-1）与 `boot.ts` MODULES（§4.1-2），同一提交。
3. `npx tsc -p tsconfig.json && pnpm -C ui-shell build`（顺序：先 tsc 再 vite 再 build-plugins；`build` 脚本 `package.json:10` 已经是这个次序）。
4. 改一个内置插件的取数源做验收（建议 `settings/ui.tsx:61` + `settings/models.tsx:52` 的 `Select`，或整套 `plugins/ui.tsx:48`/`terminal/ui.tsx:41`；更大的量是 `transcript/ui.tsx:69` 的 `playCompletionSound`）→ **改成从 `@dsc/ui-primitives` 取**，重跑 `build-plugins`，按 §5.1 量。
5. 版本 1.2.0 两处同步；docs 两处（§4.1-4）；探针新增断言。

---

## 5. 验收探针设计

### 5.1 ① 不再内联（判法 + 阈值）

**基线（实测，`minify:false`）**：

| 判据 | settings | plugins | terminal | trace | transcript |
| --- | --- | --- | --- | --- | --- |
| `grep -c "function base(path"` | 1 | 1 | 1 | 1 | 1 |
| `grep -c "^function Select("` | 1 | 1 | 1 | 0 | 0 |
| 图标块字节 | 761 | 761 | 761 | 2,506 | 2,506 |
| 另一内联块 | — | — | — | 6,399（time+tokens+tool-summary+图标） | 12,021（completion-sound） |
| bundle 总字节 | 122,226 | 37,389 | 14,456 | 61,179 | 111,101 |

**硬判据（marker 缺席，推荐主闸）**——在 `ui-plugin-test.mjs` `[5]` 里加：
```js
// E6：插件改用平台种子后，产物里不许再有内联的基元实现。
const settingsBuf = bundles.find((b) => b.id === 'settings')
check('settings 不再内联 Select 实现', !settingsBuf.text.includes('function Select(props)'))
check('settings 不再内联图标实现', !settingsBuf.text.includes('function base(path')
  && !settingsBuf.text.includes('function sized(size)'))
check('settings 通过平台种子取基元', settingsBuf.text.includes('require("@dsc/ui-primitives")'))
```
（`function Select(props)` / `function base(path` 是 rollup 未 minify 时的**逐字**标记，上面表格就是 grep 实测；若改判据为「不许任何内联图标」，可对全部 bundle 断言 `!text.includes('function base(path')`——但那要求 transcript 的 `platform/completion-sound` 也换源，见下。）

**体积判据（软闸，避免与体积漂移绑死）**：阈值 = 基线 − 预期内联块 × 0.9。
- settings 换 `Select`：内联块 5,665+761=6,426 → 断言 `bytes ≤ 116,000`（现 122,226）。
- transcript 换 `playCompletionSound`：12,021 → 断言 `bytes ≤ 99,500`（现 111,101）。
- `plugins`/`terminal` 同 settings：≤ 31,700 / ≤ 8,800（各自留 ~1KB 余量）。

**给施工者的两个更狠的可选探针**（若想一步到位）：
- 全库断言：`bundles.every(b => !b.text.includes('function base(path'))` —— 需要把 trace/transcript 的 `platform/tool-summary`（`:15` 拉 6 枚图标）也换成 `@dsc/ui-primitives`。
- 反向断言：`bundles.filter(b => b.text.includes('function sized(size)')).map(b => b.id)` 必须为空数组，失败时把 id 打出来（现在会打 `settings,plugins,terminal,trace,transcript`）。

**注意**：探针读 `lib/`（构建产物）——`ui-plugin-test.mjs:849` 就是读 `lib/ui/plugins/manifest.json`；改完源码**必须先 `npx tsc -p tsconfig.json && pnpm -C ui-shell build`**（计划 §6 的既有告诫）。

### 5.2 ② 白名单新名字断言

在 `[5b]` 尾部（`:946-947` 那条后面）加三组：

```js
// E6：三个平台种子词必须三处一致（JSON ↔ boot.ts MODULES ↔ 诊断读数）。
const bootTs = readFileSync(join(uiShell, 'src', 'boot.ts'), 'utf8')
for (const name of ['@dsc/ui-slots', '@dsc/ui-primitives', '@dsc/ui-dockkit']) {
  check(`平台模块表含 ${name}`, platformModules.includes(name))
  check(`${name} 在 boot.ts MODULES 里挂了实现`,
    new RegExp(`['"]${name}['"]\\s*:`).test(bootTs) && bootTs.includes(`from '${name}'`))
}
// JSON 与 MODULES 键集全等（MODULE_DRIFT 只是 console.error，探针才是闸门）
const modKeys = [...bootTs.matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1])
check('platform-modules.json 与 boot.ts MODULES 键集全等',
  modKeys.length === platformModules.length && platformModules.every((n) => modKeys.includes(n)),
  `MODULES=${modKeys.join(',')} | json=${platformModules.join(',')}`)
check('@dsc/ui-core 不在平台模块表里（故意不给插件）', !platformModules.includes('@dsc/ui-core'))
```

**每个注册包都有 package.json 且 name/types 对钉**（把 `:929-935` 的单包锚扩成循环）：
```js
for (const [name, rel] of Object.entries(packages)) {
  const pkgDir = dirname(resolve(uiShell, rel))
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  check(`${name} 的包帧 name 与包名一致`, pkg.name === name, String(pkg.name))
  check(`${name} 的 types 指向注册入口`, resolve(pkgDir, String(pkg.types)) === resolve(uiShell, rel))
}
```
（`@dsc/ui` 现在没有包帧——它 alias 到 `ui-shell/src/plugin-api.ts`；这条循环要么给 `@dsc/ui` 也补一个帧，要么把它排除。见 §6.4-(g)。）

### 5.3 ③ 类型面：插件 TS 作者能不能拿到三包的 `.d.ts`

结论（分三类作者，**依据实测**）：
- **内置插件（`ui-shell/src/plugins/**`，本仓库 tsc）**：能，**零额外声明**。`ui-shell/tsconfig.json:17-22`（`paths` + `include: ["src", "../src/ui"]`）→ 三包加进 paths 后，`import { Select } from '@dsc/ui-primitives'` 直接解析到 `src/ui-primitives/index.ts`（源码即类型）。E2/E3/E4 各加一条 paths 即可，这就是「`.d.ts`」在本仓的等价物。
- **`@dsc/ui` 的类型面够不够第三方**：`@dsc/ui` 今天**没有独立的 `.d.ts` 产物**（无 build、无 types 字段，只有 tsconfig paths 的源码解析）。所以**结论是：第三方 TS 作者今天也拿不到 `@dsc/ui` 的类型**（不是 E6 造成的退化）。E6 **不需要**为此做任何事；若要让第三方拿到类型，那是另一个交付（把三包 + `@dsc/ui` 编出 d.ts 随插件 SDK 发布 / 在 `docs/plugin-development.md` 写清「第三方按 JS 写、类型自备」），**不要**把这条悄悄塞进 E6。
- **第三方作者经 `@dsc/ui` 的转出面拿三包的能力**：TypeScript 侧不成立（同上）；**运行期**成立且已经成立（`@dsc/ui` 转出图标/`DiffRows`/… 是 external）。E6 的新增之处仅是「插件也可以**按包名**取，且取到的是壳的那一份实例」。

### 5.4 现有断言逐条复核（E4/E6 后哪些会红）

| 断言 | 位置 | E4/E6 后 |
| --- | --- | --- |
| 每个 bundle `startsWith('(globalThis.__DSC_UI_FACTORIES__')` | `:867-871` | 绿（工厂包装在 `build-plugins.mjs:207-211`，与包名无关） |
| 每 bundle 含 `require("@dsc/ui")` | `:880` | 绿（**注意**：若某插件把所有 `@dsc/ui` 用法都换成了 primitives，且不再用 `@dsc/ui` 任何值，这条会红——`transcript`/`trace` 换源后仍用 `defineUiPlugin`，应不会红；但仍建议把这条改成「含 `require("@dsc/ui")` 或 `require("@dsc/ui-primitives")`」以外的宽松形态之前先确认） |
| `require("react")` 存在于用 React 的 bundle | `:878-879` | 绿 |
| 无 `__SECRET_INTERNALS` | `:877` | 绿（三个新包都声明 `peerDependencies`/由种子给 React，不会内联 React） |
| `[5b]` 键集全等 | `:912-921` | 两处同改 → 绿 |
| `[5b]` `@dsc/ui-core` 不在表 | `:946-947` | 绿（E6 保持） |
| `[5b]` 版本同源 | `:936-940` | 两处同升 1.2.0 → 绿 |
| 第三方探针全部 | `ui-third-party-test.mjs:88-181` | **不受影响**（它不读平台表；`SAMPLE_BUNDLE` 只 require `react`/`@dsc/ui`） |
| 打包态 | `desktop` 自检 / `DSC_CHECK_EXE` | 产物路径不变 → 绿；但**必须实跑一次**（`lib/ui/**` 在 `extraResources`，`prepare-runtime.mjs:32`） |

**新增（E4 专属）建议**：`ui-plugin-test.mjs` `[5b]` 加一条「`ui-shell/src/ui-slots`、`ui-shell/src/ui-renderer` 两包目录存在且各有 package.json」以及一条「`app.tsx` 不再 import `./boot`」（防环回归）：
```js
check('ui-layout 不反向依赖 ui-renderer（无环）',
  !/from '\.\/boot'/.test(readFileSync(join(uiShell, 'src', 'app.tsx'), 'utf8')))
```

---

## 6. 风险与修正

### 6.1 两份实例会不会冲突（E6 核心判定）

E6 后，插件对种子词的 require 与「插件自带一份」的差别，按模块**有没有模块级状态**分三类：

**(a) 纯函数 / 常量 / 纯组件 —— 重复只是体积，不会出错。**
`icons.tsx`（全纯函数组件）、`platform/select.tsx`、`platform/time.ts`、`platform/tokens.ts`、`platform/tool-summary.ts`、`platform/paths.ts`、`platform/file-icons.tsx`（`vscode-icons-js` 静态映射）、`platform/lang-table.ts`。
判据：无 `let`/`Map`/`Set`/`createContext` 的模块级可变状态（实测 grep）；React 组件在两棵独立子树里各有一份实现不影响渲染（元素类型身份只在同一棵树内参与 reconcile）。

**(b) 带模块级状态 —— **不允许重复**，重复即行为出错（这才是 `@dsc/ui-dockkit` 进种子的第一理由）：**

| 模块 | 状态 | 重复后的症状 |
| --- | --- | --- |
| `platform/toast.ts:28` `let container` | 单例容器 | 两份 toaster 各自插一个容器 → 同屏两摞 toast |
| `platform/confirm.ts:30` `let active` | 单例当前确认框 | 两份 active → 同屏两个确认框、互不阻塞 |
| `platform/completion-sound.ts:171,384` `reverbImpulse` / `sharedContext` | AudioContext 单例 | 两份 → 两个 AudioContext（浏览器有上限）、混响各建一次 |
| `platform/highlight.ts:99-100` `highlighterPromise` / `loadedLangs` | shiki 单例 | 两份 → shiki 双份加载（体积+内存），语法包按各自 Set 重复注册 |
| `platform/markdown.tsx:33` `mdImageCache` | 缓存 | 只影响命中率（可接受） |
| `dock-state.ts:53-57`（surfaces/sessionId/listeners）、`:175`（kindMetas）、`:243`（review） | **布局单例 + 监听集合** | 两份 → 两个互不相干的 dock；A 处改布局 B 处不更新（最严重） |
| `dock-model.ts:111` `let tabSeq` | id 计数器 | 两份 → tab id 撞号（低危但会脏） |

**(c) React Context —— 只有「提供者与消费者分属不同包」时才是致命的。**
实测：`runtime-context.tsx:15` `createContext`（**E5 归 ui-layout，不进种子**）、`plugins/transcript/ui.tsx:82,92,101,104` 四个 context（插件私有）。
结论：**种子里的三个包今天都不 export Context**；若将来 w5 把 `runtime-context` 塞进 `@dsc/ui-primitives` 并进种子，必须同时保证壳与插件用的是**同一个 provider**（同一模块实例），否则消费端拿到 null。**判定口径写进注释：一个包要被种子化，它 export 的 Context 的 Provider 必须也由同一次种子给值。**

**(d) 冲突的工程保障**：E6 的值来自 `boot.ts` 的静态 import，vite 只建一个模块实例 → 壳内部与插件 require 到的**天然同一份**。真正会造出第二份的只有一种动作：**漏把包名加进 `EXTERNAL`**（alias 把它解析成源码 → 内联）。所以 §5.1 的 marker 断言就是这条的闸门。

### 6.2 TUI 平台表（计划没说，必须写）

`platform-modules.json` 被 `build-plugins.mjs:53,60` 用于**两个载体**的插件构建（`platforms: ['web','tui']` 的插件只构建一次，`build-plugins.mjs:133-140,217-219`），而 TUI 运行期表是另一份（`src/ui/tui-plugins.ts:44-49`：只有 react / react/jsx-runtime / `@dsc/ui`）。
→ E6 后，**双载体插件若在值面上 `require('@dsc/ui-primitives')`，在终端壳里会抛「白名单外的模块」**。
处理（照 1.1.0 平台层的既有纪律，`docs/plugin-development.md:656-666`）：
- 文档写明三个新包是 **web 值面**，TUI 不给；
- 双载体插件先判 `ui.host.platform`（`src/ui/plugin.ts` 的 host 字段）再引用；
- （可选）探针加一条：TUI 的 `MODULES` 键集必须 ⊆ `platform-modules.json`（防有人直接改 TUI 表）。
**不建议**为 TUI 也加这三个包（`icons.tsx` 是 DOM SVG、dock 是 DOM 布局；TUI 的对应物是 ink 组件，另一回事）。

### 6.3 CSP / 打包态 / 产物路径

- **CSP**：无新增来源、无 eval/动态 import。插件 bundle 仍走 `<script src>`（`script-src 'self'`，`core/ui-server.ts:189`）；种子模块来自壳自己的 bundle，同源。**零改动**。
- **打包态**：`desktop/scripts/prepare-runtime.mjs:32` 整拷 `lib/`；`lib/ui/assets`/`lib/ui/plugins` 路径不变（§3.5）→ 唯一要求是**实跑一次** `dist:dir` + `DSC_CHECK_EXE`。
- **产物字节**：壳 `app-<hash>.js` 的哈希会变（新增三个 import），这是预期；宿主只按文件名伺服（`ui-server.ts` 遍历 assets 目录），无清单钉哈希。
- **`desktop/scripts/build-icon-map.mjs:117`**：它把生成的图标映射写进 `ui-shell/src/platform/file-icon-map.generated.ts`——**w5 搬 `platform/` 时必须同时改这个生成器的输出路径**，否则下次生成会原地造出一个没人 import 的旧路径文件。（E6 无关，但会与 E4/E6 同一批产物一起验，先提醒。）

### 6.4 计划里判断错了的地方（逐条给证据）

| # | 计划原文 | 事实 | 影响 |
| --- | --- | --- | --- |
| a | §3-E4「`slots.ts`(74) + `slots-react.tsx`(160)；`boot.ts`(288) + `main.tsx`(122)」 | 实测 103 / 163 / 296 / 125 | 只是行数陈旧，不影响设计 |
| b | §3-E6 验收「settings 改成 `require('@dsc/ui-primitives')` 取图标 → 产物里不再内联那份图标代码」 | settings 的图标**本来就**从 `@dsc/ui`（external）来；被内联的是 `../../platform/select` 及其 2 枚图标（761 B）+ Select 实现 5,665 B | 验收判据必须改成「`function Select(` / `function base(path` 消失」（§5.1） |
| c | §1「图标/基础控件/槽位库/dock 工具都在壳内部，插件拿不到」（`icons.tsx:559`、`dock-model.ts:446` 为证据） | **图标拿得到**（`plugin-api.ts:412-414` `export * from './icons'`，17 个插件文件在用）；dock **状态**部分拿得到（`:303-305`）；拿不到的是**包身份**与非转出的控件（Select/panels/thread-resizer/hover-delay/completion-sound/paths） | 「缺可下发的基元库」成立，但差距比表述小；E6 的收益一半是体积（Select/图标/tool-summary/completion-sound），一半是**实例一致性**（toast/confirm/highlight/dock-state） |
| d | §3-E6「构建期 `build-plugins.mjs:37` 的 `EXTERNAL`」 | 实际 `:53`（读 JSON）、`:60`（`EXTERNAL` 常量）、`:194`（交给 rollup） | 定位用 |
| e | §1「平台种子 9 项」的等价形状 | dsc 有 `@dsc/ui` 与 xterm×2，dsh 没有；**E6 后是 10 项** | 别为了「对齐 9」删东西 |
| f | §3-E4 未提 | `app.tsx` 反向依赖 `boot.ts`（`ALLOWED_MODULES`）会让两包成环 | 见 §3.2（必须同批剪掉） |
| g | 全文未提 | `@dsc/ui` 没有包帧（`ui-shell/src/plugin-api.ts` 直接做 alias 落点），而 `[5b]` 的「包帧 name/types」锚只对 `@dsc/ui-core` 做了 | 若照 §5.2 扩成循环，要么给 `@dsc/ui` 补一个 `package.json`（`name: "@dsc/ui"`, `types: "plugin-api.ts"`），要么把循环排除它——**推荐补帧**（三处一致性的可读性反而更好） |
| h | §7.5「E 逻辑分包 5 个包名并存没实测过」 | 已落地证据：vite/build-plugins 都从 `packages.json` 派生，别名机制与包数无关；`[5b]` 的键集比对已保证两处同改 | 风险降为「机械工作量」，但仍**没在 5 包并存下实跑过构建**（我未跑构建，见文末不确定项） |

---

## 7. 附：一页速查（施工者贴在手边）

**E4**
```
mkdir ui-shell/src/ui-slots   : slots.ts + slots-react.tsx + index.ts + package.json
mkdir ui-shell/src/ui-renderer: boot.ts + main.tsx + index.ts + package.json
改 declare module '../plugin-api'（slots.ts）
plugin-api.ts:321 → from '@dsc/ui-slots'
app.tsx:28 → allowedModules prop（main.tsx 传 ALLOWED_MODULES）；:30/:31 → '@dsc/ui-slots'
index.html:11 → /src/ui-renderer/main.tsx
packages.json + tsconfig paths 各加两条（键集必须全等）
不改：vite.config.ts / build-plugins.mjs（从 packages.json 派生）
不留转发壳（插件不引用这四个文件）
```

**E6**
```
platform-modules.json: + "@dsc/ui-slots" + "@dsc/ui-primitives" + "@dsc/ui-dockkit"
boot.ts: + 3 个 import * as / + 3 个 MODULES 键（与 JSON 同序）
build-plugins.mjs: 不改（自动 external）
版本: ui-shell/package.json + src/ui/package.json → 1.2.0（同源）
docs/plugin-development.md §10.4: 三包 = web 值面；TUI 先判 platform
探针: marker 缺席 + require 新包名 + JSON↔MODULES 键集全等 + package.json 帧循环
不动: src/core/**（宿主不读平台表）、src/ui/tui-plugins.ts、@dsc/ui-core 的排除
```

**验收命令**
```
npx tsc -p ui-shell/tsconfig.json && pnpm -C ui-shell build
node scripts/ui-plugin-test.mjs
node scripts/ui-third-party-test.mjs
cd lib/ui/plugins && grep -c "function Select(" settings/client.js   # 期望 0
```
