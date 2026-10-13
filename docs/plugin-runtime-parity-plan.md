# 插件运行时对齐 dsh：第二轮计划（2026-10-13）

> 承接 `docs/ui-plugin-parity-plan.md`（2026-10-10，阶段 5–8）。那份计划的**结构面**已经落地：
> 桌面默认 `uiProfile = 'shell'`（`desktop/electron/main/index.ts:75`）、原生桥、
> 终端/文件/预览/设置/技能搬进壳（现 **16 个**内置界面插件）、槽位四形态齐含 `chain` 选举
> （`src/ui/slots.ts:31,50,126`）、第三方界面插件通路 + `apiVersion` semver 门禁
> （`ui-shell/package.json` 1.1.0、`src/core/ui-bundles.ts:125`）、打包态验过。
>
> 这一轮处理**还没对齐的运行时能力与框架厚度**。参考实现 `D:\deepseek-harness\deepseek-harness`
> （客户端侧 `packages/client/`：55 个 `ui-*` 包 + `modules`/`hmr`/`store`/`ui-slots` 等内核包）。
>
> **2026-10-13 修订**：D（槽位框架加厚）与 E（壳拆包 + 平台种子扩容）**纳入范围**。
> 并更正上一版对 E 的判断——它不是"纯结构、用户不可见"：E 的收益是**把基元库变成可下发给插件的平台种子**，
> 这正是 dsh 的 `ui-primitives`/`ui-slots`/`ui-dockkit` 被插件复用的方式，也是本文 §1「平台种子 9 vs 7」那条差距的解法。
> 仅剩 F（浏览器求值用户代码）不做，理由见 §5，是否要做由安全口径决定。

## 0. 一句话回答

结构面已同构，差的是**六样**：① 客户端插件没有"服务面"（dsh 的客户端插件是 cordis 插件，dsc 的只能 `require` react + `@dsc/ui`）；② 没有启动分批与懒物化；③ 没有请求批处理（combo）；④ 没有开发态热更（HMR）；⑤ **槽位框架只有运行期字符串槽表，没有 dsh 的类型化契约 / Component Factory / store seats**；⑥ **壳是一个单体 app，基元库不能作为平台种子下发给插件**。

## 0.5 落地状态（2026-10-13 当天完成）

| 波次 | 提交 | 状态 |
| --- | --- | --- |
| 第 1 波 C1 + E0/E1 | `9fe70e6` | 落地（16 个插件带包身份与契约区间；`packages.json` 单一事实源；`@dsc/ui-core` 正式化） |
| 第 2 波 D1 + A1 + D3 + D2 | `ecec448` | 落地（类型化槽位契约 + 负例探针；客户端服务面 + `inject` 双关；store 席位；Component Factory，两个真实消费者） |
| 第 3+4 波 A2 + A3 + B | `f0d6e74` | 落地（分批与懒物化 + `phase`；combo（16 插件 2 条请求）；宿主轮询 + SSE 热更，壳侧只换受影响插件） |
| 第 5 波 E2/E3/E5 | `14582b4` | 落地（primitives / dockkit / layout 三个逻辑包） |
| 第 5 波 E4 + E6 | `d09a9a6` | 落地（slots / renderer 两个包；转发壳全删；平台种子扩到 10 项，插件产物 −44KB） |
| 第 6 波 C2 | 既往 | 已在旧轮次落地（第三方 rev = 内容摘要，`ui-third-party-test` 钉住） |
| 第 6 波 C3 | `2578935` | 落地（没加载的原因分四档：manifest / clash / version / artifact，界面按档给「下一步」） |
| 第 7 波 G | — | **只做了冻结那半**：`desktop/src/renderer/FROZEN.md` 与 `scripts/legacy-frozen-check.mjs` 早在 2026-10-11 就在位并全绿。删回落档 / 加「经典待弃」标注要用户拍板（FROZEN.md 自己挂着「一份还是两份 UI」这个决定） |
| 阶段 F | — | 不做（浏览器求值用户代码与 dsc 的信任模型冲突） |

施工方式：五条只读侦察/施工线在 git worktree 里并行（`.worktrees/w2|w3|w5|w6|w7`），主代理逐条审 diff、解 rebase 冲突、并统一跑电池与桌面端到端。

## 1. 逐条对位

| 机制 | dsh 的做法（证据） | dsc 现状（证据） | 差在哪 |
| --- | --- | --- | --- |
| 客户端插件的运行时身份 | 平台种子含 **cordis**，客户端插件是 cordis 插件；`inject` 声明别的包的 **ctx 服务**（`packages/client/web/src/seed.ts:24-39`、`packages/client/ui-chat/package.json:28`） | 模块表 7 项（react×4 / `@dsc/ui` / xterm×2），**没有 cordis**，插件之间没有服务面（`ui-shell/src/boot.ts:58`） | 缺"插件互相提供/消费服务" |
| 启动分批与物化 | `batches[{phase,url,rev,entries}]`，bootstrap/application 两批；bundle 跑起来**只注册工厂**，模块体到首次使用才执行 | 一次性按序 `install`，只有 `immediately` 预取（`ui-shell/src/boot.ts:109-190`） | 缺分批与懒物化 |
| 请求批处理 | combo URL `/plugins/??a,b,rev=`，单组合失败按"批 → 单资源"回退，最多三次请求（`packages/client/modules/src/index.ts:225-235`） | 一个插件一个 `<script src>`，16 个插件 = 16 次请求（`ui-shell/src/boot.ts:246-262`） | 缺 combo |
| 开发态热更 | `hmr` 包：开着页面启用/停用、按 revision 换 combo URL、剔除未用模块与样式、设置里看"页内同步失败"并可重试 | 无（改插件要 `pnpm -C ui-shell build` + 刷新） | 缺 HMR |
| 槽位契约的类型 | 声明合并 `SlotMap` / `SlotFactoryMap` / `LocaleNamespaceMap`；组件 props 由声明推导（`packages/client/ui-slots/src/index.ts`） | `SlotRegistry<C>` 的 `C` 落在 `UiComponent = ComponentType<any>`（`ui-shell/src/plugin-api.ts:65`），props 是 `any` | 缺类型化契约（D1） |
| Component Factory | 一个包定义可复用装配，**无关的父**各自渲染，调用方按 occurrence 选局部组件；`registerFactory` / `renderFactorySlot` / `useFactorySlot`（`ui-slots/README.md`） | 无。跨位置复用只能各注册一份 | 缺 Factory（D2） |
| store seats | 登记处声明 Store 席位（selector hook + draft-stripped actions），occurrence 首次物化时创建、key 冲突拒绝（`ui-slots/README.md`） | 无。插件本地状态自管，跨插件/跨位置只能经宿主快照（`useHostSelector`） | 缺席位（D3） |
| locale 命名空间 | `LocaleNamespaceMap` + 组件 props 上的 `t` 座位；`ctx.locale` 供字典（`packages/client/locale/`） | 无 i18n 系统（界面单语言中文，串直接写在组件里） | 缺（D4，见下"最小化"） |
| 平台种子清单 | 9 项：react×4 + cordis + store + ui-slots + ui-primitives + ui-dockkit | 7 项：react×4 + `@dsc/ui` + xterm×2；**图标/基础控件/槽位库/dock 工具都在壳内部，插件拿不到**（`ui-shell/src/icons.tsx:559`、`dock-model.ts:446`） | 缺"可下发的基元库"（E） |
| 插件单位 | npm 工作区包（55 个 `ui-*`），声明在各自 `package.json` 的 `dsh.client` | 壳内目录（16 个）+ 可选 `plugin.json`；第三方走 `~/.dsc/plugins/<名>/ui/client.js`（`src/core/ui-bundles.ts:83`） | 形态不同，但**第三方已同构**（C1 补齐最后一格） |
| 壳的结构 | 壳由包拼（`web`/`connection`/`store`/`ui-layout`/`ui-dockkit`/`ui-renderer`/`ui-primitives`） | 壳是一个单体 app：17 个文件 4348 行（`app.tsx` 637 + `icons.tsx` 559 + `plugin-api.ts` 464 + `dock-model.ts` 446 + `dock.tsx` 442 + …） | 结构差（E0–E5），且挡住平台种子扩容（E6） |
| 扩展运行器 | `cordis-client-runner`（**浏览器里求值**一段插件源码）/ `cordis-host-runner`（沙箱化宿主半）/ `ui-cordis`（`packages/extensions/`） | 只有信任记录（`uiTrust`）+ `apiVersion` 门禁，**没有**运行器 | **不做**（F，见 §5） |
| 安全闸 | 无 CSP、无方法白名单、无实参校验 | 三道信任闸 + 方法白名单 + 实参校验 + CSP + 凭据禁读清单 | **dsc 强得多——不拆** |
| 打包 | 客户端 bundle 进 asar | `lib/ui/**` 跟 `lib/` 走 `extraResources`（`desktop/scripts/prepare-runtime.mjs:31-33`） | **dsc 更灵活——不动** |
| 旧界面 | 无 | `desktop/src/renderer/` 90 个文件仍在，作回落档（`uiProfile()` 可切 `legacy`） | dsc 多一份维护（G） |

## 2. 「同等程度」的验收口径

1. **插件之间能协作**：A 提供服务、B 声明依赖；A 缺席时 B **不 apply** 并在诊断区写清原因。
2. **插件能复用基元**：插件 `require('@dsc/ui-primitives')` 拿到图标与基础控件、`require('@dsc/ui-slots')` 拿到槽位工具、`require('@dsc/ui-dockkit')` 拿到 dock 模型，**不再各自打包一份**。
3. **槽位契约能在编译期拦住**：插件把 props 类型用错，`tsc` 报错（负例探针钉住）。
4. **装配可复用**：同一套 Component Factory 在两个无关的父位置渲染，各自选不同局部组件。
5. **首屏与插件数解耦**：插件 16 → 40 时首屏请求数不线性涨，第一批（骨架）先可见。
6. **开发态改一个插件不用重启宿主**。
7. **既有安全面一条不少**：方法白名单、实参校验、三道信任闸、CSP、`UI_EXCLUDED` 编译期覆盖检查全绿；第三方 `apiVersion` 门禁与首次信任确认不许退。
8. 每阶段跑既有电池：三侧 `tsc` + `pnpm -C ui-shell build` + 三个界面探针 + 桌面自检（含打包态一条）。

## 3. 分阶段计划

### 阶段 A：插件运行时（服务面 + 分批 + 批请求）

**A1 客户端服务注入**（推荐自写极简，不引 cordis）
- 落点：`ui-shell/src/plugin-api.ts` 增 `provide(name, value)` / `consume(name)`；`ui-shell/src/boot.ts` 的装载循环按 `entry.inject` **拓扑排序 + 等服务就绪**（`inject` 字段清单里已有，`src/ui/manifest.ts`）；服务释放并进 `boot.ts:213` 同一本账。
- 不引 cordis 的理由：界面插件是"UI 挂件"，不需要 cordis 的完整服务模型；引进来会把页面 bundle 撑大并混淆"宿主插件/界面插件"两套语义。**对齐能力，不照抄实现。**
- 验收：两个内置插件，一 provide 一 inject；provide 缺席时 inject 方不 apply 且诊断区有一行原因；清单乱序也靠拓扑排好。
- 成本：**中**。

**A2 启动分批与懒物化**
- 落点：`src/ui/manifest.ts` 的 `UiBootGraph` 加 `batches`；`plugin.json` 加可选 `phase`；`ui-shell/src/boot.ts` 按批执行。
- 验收：stderr 打出两批物化时刻；第二批未物化时第一批已可交互。
- 成本：**中**。

**A3 combo 批打包**
- 落点：宿主路由 `/plugins/??a,b,c&rev=`（`src/core/ui-route.ts`，现只有单资源）；壳 `fetchFactory`（`boot.ts:233-243`）改批取 + 单组合失败回退单资源。
- 验收：16 个插件物化请求数 **≤ 3**；组合里一个 id 404 → 其余照常、缺的单独重取一次。
- 成本：**中低**。**与 B 同一条取数路径，连着做。**

### 阶段 B：开发态热更（HMR）

- 落点：新 `ui-shell/src/hmr.ts`；宿主复用已有 `/api/events`（SSE）推送"哪一行变了 + 新 rev"；壳按 revision 重取 factory + 用 `boot.ts:195` 的账本卸载旧条目再装。
- 坑（dsh 的经验）：样式表要跟着剔除、共享模块不能重复注册、HMR 期间状态保留口径要写清。
- 验收：改一个插件的文案 → 等 SSE → DOM 文案变了且宿主进程 PID 未变。
- 成本：**中高**（本轮最重的一块之一）。

### 阶段 C：插件生态

**C1 内置插件也带 `package.json`**（最小，先做）
- 每个 `ui-shell/src/plugins/<id>/` 补 `package.json`（`name` / `version` / `peerDependencies['@dsc/ui']`）；`build-plugins.mjs` 的 `readMeta` 从它读 peer 区间写进清单 `api`（与可选 `plugin.json` 并一份）。
- 验收：清单每个内置条目都带 `api`；探针钉住"插件目录缺 package.json 时构建失败"。
- 成本：**低**。

**C2 第三方产物完整性**：`rev` 改**内容摘要**，或在 `docs/plugin-development.md` 写明"只换地址、不校验"——二选一。成本 **低**。

**C3 插件管理面补齐**：界面上启停第三方界面插件，并**分开**说清没加载的原因（版本 / 信任 / 读不到产物三档）。成本 **中**。

### 阶段 D：槽位框架加厚（**纳入**）

现状地基：注册表在 `src/ui/slots.ts`（558 行，4 形态 + `chain` 选举 + 故障记账 + 遮蔽/退位）；React 订阅面下沉在 `src/ui/slots-react.ts`（32 行，浏览器壳与 ink 壳共用）；浏览器壳的渲染出口在 `ui-shell/src/slots-react.tsx`（160 行，含 `slot-entry` 包装与崩溃视图）。**缺的是"类型化契约"与"可复用装配"。**

**D1 类型化槽位契约**
- 落点：`src/ui/slots.ts` 引入 `SlotPropsMap`（一张显式表，或声明合并）；`SlotRegistry<C>` 的 `register` 泛型收窄到"槽名 → props"；`ui-shell/src/plugin-api.ts:65` 的 `UiComponent = ComponentType<any>` 换成按槽推导（现在 `SlotComponentProps<Owner>` 已存在但被 `any` 盖住）。
- 落点还含 `src/ui/slots-ink.tsx`（TUI 侧同源）与 `ui-shell/src/slots-react.tsx` 的 `SlotOutlet`。
- 验收：**负例探针**——一个故意传错 props 的插件 `tsc` 不过；正例全绿。
- 成本：**中**（类型活，风险在"改完所有内置插件的注册点"；16 个插件的 register 调用都要复核）。

**D2 Component Factory**
- 落点：`src/ui/slots.ts` 加 `registerFactory(def)` / `renderFactorySlot(name, {slots})` / `useFactorySlot(name, fallback)`；类型 `SlotFactoryMap`；`ui-shell/src/slots-react.tsx` 加渲染出口；`@dsc/ui` 转出。
- **真实消费者（别做成只有探针在用的空 API）**：把工具卡装配抽成一个 Factory——对话页与轨迹页复用同一套工具卡，各自选不同局部组件（这正对应 dsh 的用法）。
- 验收：同一个 Factory 在两个无关父位置渲染、各自选不同局部组件；Factory 的 `children` 仍是普通槽（类型对齐）。
- 成本：**中高**。

**D3 store seats**
- 落点：新 `src/ui/store.ts`（React-free 的席位工厂）+ React 绑定；登记 options 加 `store?: { key, spec }`；**跨插件同 key 冲突拒绝并报人话**（dsh 口径）；卸载时释放（并入 `boot.ts` 账本）。
- 验收：两个插件共享一个席位、改动互相可见；卸载后席位释放；key 冲突报一句人话而不是静默覆盖。
- 成本：**中**。

**D4 locale 命名空间（最小化，可选）**
- 落点：`LocaleNamespaceMap` + 组件 props 上的 `t` 座位 + 一份 zh-CN 字典；**没有 i18n 系统的部分不做**（dsc 界面单语言，dsh 有 zh/en）。
- 验收：一个插件用 `t('ns.key')` 取到中文串；缺 key 回落 key 本身并记一条诊断。
- 成本：**低**。**价值低**（dsc 不打算多语言），放在 D 的最后、可随时砍。

### 阶段 E：壳拆包 + 平台种子扩容（**纳入**）

现状：壳是 17 个文件 4348 行的单体 app。内部依赖边已经比较干净（`plugin-api.ts` 是聚合面，`app.tsx` 依赖 boot/dock/dock-state/icons/runtime-context/slots*）。

**E0 分包形态（先定这一步，别一上来引 workspace）**
- 两条路：① 引 **pnpm workspace**（新增 `pnpm-workspace.yaml`，`packages: [ui-shell, desktop, packages/*]`）——与 dsh 同形，但 dsc 现在根/ui-shell/desktop 各一份 `node_modules`（`pnpm -C ui-shell`），转 workspace 会重排依赖解析，要跑全量电池 + 桌面自检；② **逻辑分包**——在 `ui-shell/` 内按 tsconfig `paths` + vite `alias` 造包名（`@dsc/ui-primitives` 等），产物与打包路径**完全不变**。
- **推荐 ②起步**：dsh 用 workspace 是为了把包发给 npm 给第三方；dsc 的第三方走 `~/.dsc/plugins/`，不需要 npm 发布面。将来真要独立发布，再把逻辑包升成 workspace（alias 换 workspace 协议即可）。
- 验收：`pnpm -C ui-shell build` 与 `desktop dist:dir` 产物逐字节路径不变；探针 import 路径按新包名改。
- 成本：**低**。

**E1 `@dsc/ui-core` 正式化**：`src/ui/`（1571 行，已有 `index.ts`）补 `package.json`，在壳内按包名 import（现在 `@dsc/ui-core` 已是 alias，确认它能作为"平台种子外的库"仍然**故意不给插件**，见 `build-plugins.mjs:44`）。成本 **低**。

**E2 `@dsc/ui-primitives`**：`ui-shell/src/icons.tsx`(559) + `plugin-text.tsx`(15) + `platform/*`（time/tokens/tool-summary/file-icons）。成本 **中**。

**E3 `@dsc/ui-dockkit`**：`dock-model.ts`(446) + `dock-state.ts`(284) + `dock.tsx`(442)。成本 **中**。

**E4 `@dsc/ui-slots` + `@dsc/ui-renderer`**：`slots.ts`(74) + `slots-react.tsx`(160) 归槽位包；`boot.ts`(288) + `main.tsx`(122) 归渲染器包（dsh 的 `modules` 与 `ui-renderer` 就是两个包）。**与 A3/B 同片代码，放它们之后。** 成本 **中**。

**E5 `@dsc/ui-layout`**：`app.tsx`(637) + `review-pane.tsx`(198) + `thread-view.ts`(74) + `page-state.ts`(36) + `host-channel.ts`(241) + `runtime-context.tsx`(107) + `appearance.ts`(201)。成本 **中高**。

**E6 平台种子扩容（E 的真正收益）**
- `ui-shell/src/platform-modules.json` + `ui-shell/src/boot.ts:58` 的 `MODULES`（构建期 `build-plugins.mjs:37` 的 `EXTERNAL` 同读前者）扩到含 `@dsc/ui-slots` / `@dsc/ui-primitives` / `@dsc/ui-dockkit`——即 dsh 那 9 项的等价形状。
- 验收：一个内置插件（如 `settings`）改成 `require('@dsc/ui-primitives')` 取图标，产物里**不再内联**那份图标代码（对比 bundle 体积）；诊断区的模块白名单列出新名字。
- 成本：**低**（但**依赖 E2/E3 完成**）。

**每步的跟改面（漏一个就炸）**：`build-plugins.mjs:118` 的 alias、`ui-shell/vite.config.ts` 的 alias、`ui-shell/tsconfig.json` 的 paths、探针的 import 路径、`lib/ui/assets` 与 `lib/ui/plugins` 的产物路径（**必须不变**，否则打包与 `prepare-runtime.mjs` 全要跟改）。

### 阶段 F：扩展运行器（**不做**）

- dsh 的 `cordis-client-runner` 会在**浏览器里求值一段用户代码**变成活的插件。
- 理由：与 dsc 故意更严的信任模型（三道闸 + 方法白名单 + 实参校验 + CSP）直接冲突——等于给页面开一个任意代码执行口。
- 若确有需求，只做**宿主侧的只读 inspect**（工具侧看清运行时 API，不碰页面求值）。**这条是否做由用户的安全口径决定，本轮不做。**

### 阶段 G：旧渲染层退役

- 现状：`desktop/src/renderer/` 90 个文件仍在，作回落档。
- 步骤：① 加冻结标记；② 壳能力搬齐后改 `uiProfile()` 去掉 `'legacy'` 档；③ 删 `out/renderer` 与 `desktop/src/renderer/`；④ 桌面自检与三个界面探针改跑壳（大多数已在跑壳，改动以删旧断言为主）。
- 验收：`DSC_UI_SHELL` 开关与 `ui: 'legacy'` 档移除后，桌面自检全绿 + 打包态实跑一遍。
- 成本：**中**。

## 4. 次序与依赖

```
第 1 波（地基）      C1 插件包化  →  E0 分包形态  →  E1 ui-core 正式化
第 2 波（API）       D1 类型化  →  A1 服务面  →  D3 store seats  →  D2 Factory  →（D4 可选）
第 3 波（取数）      A2 分批  →  A3 combo
第 4 波（体验）      B HMR            （接在 A3 之后：同一条取数路径）
第 5 波（拆包+种子） E2 primitives / E3 dockkit / E5 layout  →  E4 slots+renderer  →  E6 种子扩容
第 6 波（生态）      C2 完整性  →  C3 管理面
第 7 波（收尾）      G 旧 UI 退役
不做                 F 扩展运行器（是否做由安全口径决定）
```

理由：C1 与 E0/E1 是地基且互不冲突；D1–D3 与 A1 落在同一片代码（`src/ui/slots.ts` + `plugin-api.ts` + `boot.ts`），一起改省一轮回归；A2/A3/B 都改取数路径，连着做省一次返工；E2–E5 是纯搬迁，放后面（前面几波改完，搬迁的目标形态才稳定）；E6 必须在 E2/E3 之后；G 必须在能力搬齐之后。

每阶段提交口径照既有约定：`npx tsc -p tsconfig.json` + `pnpm -C ui-shell build` + 电池 + 三个界面探针 + 桌面自检。

## 5. 拍板建议

| 项 | 建议 | 理由 |
| --- | --- | --- |
| A1 服务面 | **做**（自写极简，不引 cordis） | "挂件"与"插件"的分界；引 cordis 会撑大页面 bundle 并混淆两套语义 |
| A2 分批 / A3 combo | **做** | 首屏与插件数解耦是插件化迟早要还的债 |
| B HMR | **做** | "插件化能不能当日用工具"的关键体验 |
| C1 / C2 / C3 | **做** | 生态可用性的最低配 |
| **D 槽位加厚** | **做**（D1→D3→D2，D4 可选可砍） | 类型化契约能在编译期拦住第三方插件的错；Factory 让跨位置复用它一套装配；store seats 是插件间共享状态的唯一干净做法 |
| **E 壳拆包 + 种子扩容** | **做**（逻辑分包起步，不急着 workspace） | 收益不是"壳长得像 dsh"，而是**基元库能作为平台种子下发给插件**（§1「平台种子 9 vs 7」那条差距的解法）。逻辑分包可用最低成本拿到这个收益 |
| F 扩展运行器 | **不做**（本轮） | 与 dsc 更严的信任模型冲突；要做只做宿主侧只读 inspect |
| G 旧 UI 退役 | **做**（最后） | 双份界面是长期维护成本 |

## 6. 风险

- **别把 dsc 的闸门拆掉**：dsh 没有界面通道方法白名单、没有实参校验、没有三道信任闸、也没有 CSP。这几样是 dsc 专门加的——对齐时一条不许退（`docs/ui-plugin-parity-plan.md` §7 已立过这条规矩）。
- **D1 的回归面大**：类型收窄会碰 16 个内置插件的每个 `register` 调用；先写负例探针，再逐个插件过 `tsc`。
- **E 的产物路径不许变**：`lib/ui/assets` 与 `lib/ui/plugins` 是宿主伺服与 `prepare-runtime.mjs` 的契约；分包只改**源码组织**，不改产物路径。
- **测试读 `lib/`，不是 `src/`**：不先 `npx tsc -p tsconfig.json` 就跑测试等于在测旧代码。
- **打包态要单独验**：`lib/ui/**` 在 `extraResources` 里（不在 asar），任何新产物路径都要在 `dist:dir` 产物上实跑（本轮已加 `DSC_CHECK_EXE` 开关，可直接把自检打在 `win-unpacked` 上）。
- **HMR / 拆包这类"静默半截"分支的验收必须看 stderr 与界面实际来源**，不看绿不绿（阶段 93 的真事）。

## 7. 没验过的（别当已知事实）

1. **引 cordis 到客户端的可行性**：没试过打包体积与 CJS/ESM 形态；A1 选的是"不引"，只备查。
2. **dsh combo 失败回退的精确请求数**："最多三次"来自其 README，未在本机跑计数核对。
3. **HMR 的样式剔除在 dsc 的 CSP（`script-src 'self'`）下是否受限**：样式走 `<link>`/`<style>`，理论上不受 `script-src` 管，但要在 B 阶段实测。
4. **D1 的类型收窄会不会逼出 `any` 逃逸**：`SlotOutlet` 的 `owner` 是 `Record<string, unknown>`，`chain` 槽的 `select` 参数是 `unknown`——这两处很可能需要显式泛型参数而不是零成本的声明合并，实际形状要在动手时定。
5. **E 逻辑分包在 vite 下的 alias 与 lib 模式是否够用**：`build-plugins.mjs:118` 已经用 alias 把 `@dsc/ui` / `@dsc/ui-core` 换掉，扩到多个包名理论上同构，但没实测过 5 个包名并存。
6. **55 个 dsh `ui-*` 包里哪些真有 `dsh.client` 声明**：只抽查 5 个，未逐个核。
