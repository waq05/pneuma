# 批次 03：界面壳与界面运行时

> 状态：已归档（2026-11-17）：2026-11-09 一次性审查报告；14 条 P0 已全部修复（见同目录 FIXES.md）。

> 审查口径见 `docs/code-review/2026-11-09/00-审查口径.md`。只读审查，未改任何源码，未跑 build / install / 测试。
> 分支 `feat/pluginization`。标注「在途」的文件是 `git status` 里已列出的未提交改动。

## 范围

实际读过的文件（按包）：

- **协议面**：`ui-shell/src/plugin-api.ts`（在途）、`src/core/ui-manifest.ts`、`src/core/ui-bundles.ts`（抽读 240–460、930–970、1230–1280、1500–1560、1740–1779）
- **宿主 UI 内核**：`src/core/ui-server.ts`、`ui-methods.ts`、`ui-events.ts`、`ui-route.ts`、`ui-hmr.ts`、`ui-graph-frames.ts`、`ui-boot-source.ts`、`ui-combo.ts`（仅看 `replace/lookup` 形状）、`ui-trust.ts`（未逐行，见待核实）、`native-bridge.ts`（未逐行）、`web-http.ts`（未逐行）、`web-static.ts`（未逐行）
- **ui-boot**：`ui/boot.ts`（1–260、390–720）、`ui/main.tsx`、`ui/hmr.ts`（未逐行）
- **ui-renderer**：`ui/ui.tsx`、`ui/styles/styles.css`（抽读约 20 段）、`ui/styles/legacy/views.css`（抽读约 15 段）、`legacy/tokens.css`、`legacy-color-fallback.css`、`legacy/PROVENANCE.md`、`legacy/base.css` 与 `legacy/primitives.css`（只做选择器比对）
- **ui-runtime**：`ui/host-channel.ts`、`ui/appearance.ts`
- **ui-core**：`index.ts`、`plugin.ts`、`frames.ts`、`slots.ts`（只读导出面与声明段，849 行未逐行）
- **ui-layout**：`ui/app.tsx`（1–380、结构扫描全文件）
- **ui-dockkit**：`ui/dock-state.ts`；`ui/dock-model.ts` 只看导出面
- **ui-slots**：`ui/slots.ts`
- **ui-primitives**：`ui/panels.ts`、`ui/review-findings.ts`（头部）、跨包 import 清单
- **ui-palette**：`ui/ui.tsx`（1–120）；**ui-plugins**：目录与 `ui.tsx` 的过滤逻辑（grep）
- **对照**：`src/core/prefs.ts`（130–310）、`desktop/electron/main/index.ts`（56–106）、`src/packages/host-stdio/index.ts`、`src/packages/remote/routes.ts`

## 结论摘要

- **P0 × 1 / P1 × 7 / P2 × 5**
- 最重要的一条：插件声明的 `services`（服务依赖）在**组启动图时被丢掉**，装载器两条装配路径都读不到它——写了 `services` 等于没写，「等提供者就绪再装」从来没有生效过。
- 第二条：界面壳的样式现在是「legacy 四份 → xterm → styles.css → 颜色兜底」四层靠顺序互相压，同一批选择器（`.btn-primary` / `.icon-btn` / `.model-btn` …共 73 个）在两个文件里各写一份，`styles.css` 用硬值盖掉 `views.css` 的令牌——改 `--dsc-ctl` 只动一半按钮。
- 第三条：`ui-layout/app.tsx` 一个文件 1295 行、十种职责（骨架布局、面板几何、快捷键、连接横幅、宿主异常条、诊断区、原生桥探针、快照读取器…），而插件之间还靠 8 个字符串字面量的 `window` 事件互相喊话，没有登记处。

## 七个问题的直接回答

1. **加载链只有一条，但「首帧之前」被切成两半、各写一遍兜底。** 入口是 `ui-boot/ui/main.tsx`（`bootstrap()`）：读启动图 `readBootGraph()` → 建槽位表 → 建 cordis 根 → 在 `boot.entries` 里找 `renderer` 那一条 → 物化并 `start(api)`。`ui-renderer/ui/ui.tsx` 的 `start()` 接着做：找 `layout` 那一条 → 建宿主通道并 `bindRuntime` → 读 `getUiPrefs` 上色 → 装 early 批 → 画 `<App/>` → 打首帧 → 装 application 批。**插件安装只在 `ui-boot/boot.ts` 的 `createBootSession`/`install` 里做一次**，`ui-layout/app.tsx` 只画骨架、不装插件（它靠 `AppBootSession` 结构份额读报告）。**首帧**归 `ui-renderer/ui/ui.tsx:341`（`createRoot(...).render`）；**主题**归 `ui-runtime/ui/appearance.ts` 的 `applyAppearance`，但「读偏好 → 归一化 → 上色 → 存镜像」这条链在 `ui-renderer`（`syncAppearance`）与 `onAppearanceRequest` 回调里各走一次（`ui.tsx:90-97`、`139-144`）。重复的「读清单/找条目/失败画诊断页/退掉启动占位」在引导与渲染器各一整套（见 F8）。
2. **协议类型基本单源，但有三处已经漂移。** `UiPluginEntry` / `UiBootGraph` / `UiPluginRow` 只定义在 `src/core/ui-manifest.ts`，`ui-core` 用 `export *` 转出（`ui-core/index.ts:8`），`ui-boot/boot.ts:62-70` 直接 import——这条是干净的。真正多份的是：①`HostPluginsFrame`（`ui-runtime/ui/host-channel.ts:79-84`）与 `UiHmrFrame`（`src/core/ui-hmr.ts:37-42`）字段逐个相同却各写一遍；②宿主身份有三种形状（`ui-manifest.ts:121` 的匿名 `{name;version;language?}`、`ui-core/plugin.ts:31-49` 的 `UiHostInfo`、`boot.ts:224` 的 `{name;version}`）；③`SlotMap`/`SlotKindOf` 这套在 `plugin-api.ts:59-85` 全部是指向 `@dsc/ui-core` 的类型别名（正确做法），但 `ui-shell/src/slot-contract.typecheck.tsx` 又对这些别名做了一次形状断言，等于第三份手抄（未逐行读，见待核实）。
3. **职责边界是三条链并存，不是一条。** ①桌面窗口：`host-stdio` 走 stdio/parentPort，`invoke` 用**全量** `INVOKABLE_METHODS` + `Reflect.apply`，快照自己实现「leading-edge 节流」；②本机浏览器：`core/ui-server` + `core/ui-events`，`invoke` 走 `UI_METHODS` 子集 + `validateUiArgs`，快照走 `RemoteFrameHub` + 拖尾节流；③手机：`packages/remote/routes.ts` **复用** ui-events/ui-route/ui-server 的导出（`injectBootScriptTag`、`UI_CONTENT_SECURITY_POLICY`、`resolveUiResourceRequest`），只换凭据闸与方法子集。第 ③ 条是好的复用；第 ① 与 ② 是两套独立实现（见 F2）。
4. **`app.tsx` 与 `ui-dockkit` 都超载，但性质不同。** `app.tsx` 是 god file（1295 行、10 类职责，F3）；`ui-dockkit` 的 `dock-state.ts`（394 行）与 `dock-model.ts`（728 行）职责清楚（布局算法 vs React 接线），只是把四种状态（布局 / 页签报名表 / 审查目标 / 补丁源）塞进一条通知通道，属于可接受但可拆。`app.tsx` 里 `Diagnostics`（1020–1225，约 205 行）与面板几何（262–351）是最明显的两块可拆边界。
5. **样式层确实在大段互相覆盖。** 六份 CSS 里跨文件重复的选择器共 **73 个**（脚本比对结果），其中 `.btn-primary`、`.icon-btn`、`.model-btn` 三组是「后加载用硬值改掉前者的令牌」，见 F5；`:root[data-theme='claude']` 在三个文件里各定义一遍，见 F5 第三组。`legacy/PROVENANCE.md` 自己承认这份文件「有九成规则现在没有对应界面」但仍整份保留（第 26 行），且它记录的上游 `desktop/src/renderer/` 在当前 checkout 里**已经不存在**（`Test-Path desktop/src` = False）——「谁是家」的那套说法现在只剩单向，见 F13。
6. **主题默认值确实是三处各存一份，而且桌面那一份把 `system` 档弄丢了。** `prefs.ts:150`、`ui-runtime/ui/appearance.ts:96`、`desktop/electron/main/index.ts:99` 各写一遍四档联合；`claude` 这个出厂默认在 `prefs.ts:382`、`appearance.ts:65-66`、`main/index.ts:105` 各写一遍；字号三档表 `sm/md/lg → 0.92/1/1.12` 在 `prefs.ts:188` 与 `appearance.ts:37` 各写一遍，注释还写着「改这里要两边一起改」。桌面那份 `readUiTheme()` 的判定只认 `dark|light|claude`，用户选「跟随系统」（`system`）时直接掉到兜底的 `claude`，与它上面第 73 行注释「`system` 按系统深浅解析」相反（见 F6）。
7. **`ui-primitives` 里混着一批业务解析；命令面板只有一套。** 48 个文件里，`review-findings.ts`（186 行，解析 `/review` 队友汇报的 `<review-findings>` 标记，格式由 `src/core/agent-roles.ts` 的 reviewer 提示词钉死）、`tool-summary.ts`（347 行，工具卡摘要）、`file-type-classify.ts`（404 行，按扩展名分类）属于业务域，却被放进「基元库」并整包 `export *` 给所有插件（`plugin-api.ts:421`）。`ui-palette` 与 `ui-plugins` **没有**各写一套命令面板/搜索：`ui-palette` 是唯一的 Ctrl+K 面板，`ui-plugins` 是 1255 行的插件管理整页、只有分组过滤没有模糊搜索（`ui-plugins/ui/ui.tsx:323-338`）。这一项核对结论是「不是问题」，真正的耦合在 F4 的 window 事件总线。

---

## 按插件分节

### core/ui-manifest.ts（组启动图）

#### [P0] `services` 服务依赖在组图时被整项丢弃，装载器「等提供者就绪」从未生效
- 位置：`src/core/ui-manifest.ts:295-302`（丢弃点）、`src/core/ui-bundles.ts:1769-1778`（上游有值）、`src/packages/ui-boot/ui/boot.ts:498`、`src/packages/ui-boot/ui/boot.ts:582-588`
- 现象：`UiPluginRow` 有 `services` 字段，`toUiPluginRows()` 也把它带进来了；但 `composeUiBootGraph()` 把 row 转成 `UiPluginEntry` 时只搬了 `inject` / `external` / `immediately`，**没搬 `services`**。于是启动图（`window.__DSC_BOOT__`、`/api/boot`、`/boot.js` 三处都是这一份 JSON）里永远没有 `services`；`boot.ts` 的 `serviceDepsOf(entry)` 与 `unmetDependencies({...services})` 都从 entry 读，读到的永远是 `[]`。
- 证据：
  - `ui-manifest.ts:295-302`
    ```ts
    const entries: UiPluginEntry[] = ordered.map((artifact) => ({
      id: artifact.id,
      url: pluginBundleUrl(artifact.id, artifact.rev),
      rev: artifact.rev,
      ...(artifact.inject === undefined ? {} : { inject: artifact.inject }),
      ...(artifact.external === undefined ? {} : { external: artifact.external }),
      ...(artifact.immediately === true ? { immediately: true } : {}),
    }))
    ```
  - `ui-bundles.ts:1774`：`...(entry.services === undefined ? {} : { services: entry.services }),`
  - `boot.ts:498`：`const serviceDepsOf = (item: UiPluginEntry): string[] => [...(item.services ?? [])]`
  - `boot.ts:583`：`{ ...(entry.inject === undefined ? {} : { plugins: entry.inject }), ...(entry.services === undefined ? {} : { services: entry.services }) },`
- 影响：manifest 里写 `"services": ["actions"]` 的插件不会等 provider 装上就先 apply；`useService('actions')` 在首帧读到 `undefined`，要等 provider 后补才自己重渲染。cordis 那条路径本来能靠 `inject` 等依赖，现在 `inject` 也是空数组，等于灰度开关对「服务依赖」这一维完全失效。第三方插件的 README 会照抄「写 services 就会等」的说法，实际不成立——这是「改 A 忘了 B」的典型：manifest 文档、bundles 解析、组图、装载器四处，只有组图那一步漏了。
- 建议：在 `composeUiBootGraph()` 的 map 里补一行 `...(artifact.services === undefined ? {} : { services: artifact.services }),`，并把 `rev` 的摘要输入（第 315 行已经序列化整条 entry）顺手覆盖到它；补一条探针断言「声明了 services 的条目，图里必须带 services」。
- 置信度：高（三跳全部读过：bundles 写入 → manifest 丢弃 → boot 读取；`composeUiBootGraph` 是唯一组图函数，`ui-boot-source.ts:95/113` 两处都调它）

### core/ui-events.ts + core/ui-methods.ts + host-stdio + remote

#### [P1] 三条「宿主调用 + 快照推送」链并存，节流语义与权限面各不相同
- 位置：`src/packages/host-stdio/index.ts:226-239`、`211-222`；`src/core/ui-events.ts:269-289`、`438-441`；`src/core/ui-methods.ts:435-473`；`src/packages/remote/routes.ts:361-368`
- 现象：同一件事（把宿主快照推给界面、把界面的一次调用落到宿主方法）有两套独立实现：
  - **调用面**：`host-stdio` 只查 `isInvokableMethod(method)`，然后 `Reflect.apply(runtime[method], runtime, args)` 把线上实参原样铺开，**没有实参校验**；本机 `/api/invoke` 走 `UI_METHODS` 子集 + `validateUiArgs`（个数、类型、长度、枚举）。两条链对「什么能调、实参能多长」的回答不同。
  - **推送面**：`host-stdio` 自己写 leading-edge 节流（距上一帧超窗口就立刻发）；`ui-events` 用另一份「dirty + setTimeout」拖尾节流，且带 `seq` / 补帧 / 背压断开。两处都写着「与 remote 同一个口径」，但代码是两份。
- 证据：
  - `host-stdio/index.ts:227-235`
    ```ts
    if (!isInvokableMethod(method)) {
      transport.send({ type: 'result', id, ok: false, error: `协议不允许调用的方法：${method}` })
      return
    }
    ...
    const value = Reflect.apply(runtime[method], runtime, args)
    ```
  - `ui-events.ts:438-441`
    ```ts
    if (!options.methods.includes(method)) {
      sendJson(res, 403, { ok: false, error: `协议不允许调用的方法：${method}` })
      return
    }
    ```
  - `host-stdio/index.ts:214`：`const wait = Math.max(0, throttleMs - (Date.now() - lastSentAt))`
  - `ui-events.ts:278-288`：`timer = setTimeout(() => { ... emitFrame(false) }, throttleMs)`
- 影响：加一个宿主方法要同时想两遍「桌面通道要不要放行、网页通道要不要放行、实参规格写不写」；两边节流语义不同，同一个动作在桌面窗口与浏览器里的延迟表现会不一样（桌面是 leading-edge，网页是 trailing）。将来给 `host-stdio` 补实参校验就得把 `UI_ARG_SPECS` 那套再实现一遍或强行拽耦合。
- 建议：把「一次调用的合法性判定」收敛成一个函数（现有 `isUiMethod` + `validateUiArgs` 已经够用），`host-stdio` 改成按自己的白名单调同一个 `validate`；快照节流抽成 `core/snapshot-throttle.ts` 里的一个 `createSnapshotPump({ send, throttleMs, mode })`，两边各传 `mode: 'leading' | 'trailing'`，不要再各写一份 setTimeout。
- 置信度：高（两处实现都逐行读过）

#### [P2] `ui-methods.ts` 头部的方法清单已经落后于代码
- 位置：`src/core/ui-methods.ts:14-35`（头注释清单）对照 `91-179`（`UI_METHODS` 实际值）
- 现象：头注释列「放行」时没有 `newSessionIn`、`rewindSession`、`sideAsk`、`sideAskCancel`、`listUiTrust`、`listPermissionPresets`、`listTeamBoard`、`stopBackground`、`readBackground`；实际数组里都有。这份注释是「界面通道到底开放了什么」的唯一人话说明，审计和新人都会读它。
- 证据：`ui-methods.ts:16-18` 只写到 `peekTranscript`；`ui-methods.ts:101` 有 `'newSessionIn',`，`ui-methods.ts:109` 有 `'rewindSession',`，`ui-methods.ts:168-169` 有 `'stopBackground', 'readBackground',`。
- 影响：安全审计按注释核对会漏掉 9 个可调用方法（其中 `sideAsk` 会消耗模型额度、`readBackground` 会读后台输出）。
- 建议：把这段清单删掉，改成一句「以本文件的 `UI_METHODS` 为准，分组注释就地写在数组里」（数组内已经按组写了注释），避免第二份清单。
- 置信度：高

### ui-boot

#### [P1] 引导与渲染器各写一整套「失败诊断页 + 退启动占位」
- 位置：`src/packages/ui-boot/ui/main.tsx:98-109`、`120-168`、`171-178`；`src/packages/ui-renderer/ui/ui.tsx:153-164`、`175-223`、`226-233`
- 现象：`dismissBootSplash()` 在两个文件里逐字相同（12 行）；`RendererUnavailable` 与 `LayoutUnavailable` 是同一块诊断页，只有标题文案的 i18n key 与「去打开哪个开关」（`ui-renderer` / `ui-layout`）不同，内联样式 40 余行完全重复。
- 证据：
  - `main.tsx:98-107` 与 `ui.tsx:153-162`：`requestAnimationFrame(() => { requestAnimationFrame(() => { const splash = document.getElementById('boot-splash') ...`
  - `main.tsx:130`：`background: '#1b1b1b',` 与 `ui.tsx:185`：`background: '#1b1b1b',`（同一套硬编码色）
- 影响：改一次诊断页（配色、加一个「打开设置」按钮、换措辞）要改两处；两处已经各带一份硬编码主题色（`#1b1b1c` / `#232324`），换主题时这两页不跟随。三个界面单元（renderer / layout / 未来别的骨架）每多一个「可停用」，这套模板还要再抄一遍。
- 建议：抽到 `@dsc/ui-primitives`（或 `ui-slots` 旁边的 `boot-diagnostics.tsx`）：`<BootDiagnostics reason detail target="ui-layout" />` + `dismissBootSplash()`，两处改成传 `target` 与 i18n key。
- 置信度：高（两份都完整读过）

#### [P2] cordis 与旧退订账本的灰度双路径仍在，同一个插件两种生命周期语义
- 位置：`src/packages/ui-boot/ui/boot.ts:394-403`（选择器）、`619-688`（两条装配分支）、`204-208`（`via` 字段）、`src/packages/ui-layout/ui/app.tsx:114-118`
- 现象：`CORDIS_DEFAULT_ALL = true`，默认全走 cordis，但 `cordisSelector()` 仍保留 `__DSC_CORDIS_PROBE__ = 'none' | Array` 的运行时开关；两条路径的「装载成功」判定不同（cordis 分支在 `fiber.state !== 2` 时也 `installed.set(...)` 并返回 `null`，见 `651-663`；账本分支只有 apply 不抛才算成功）。
- 证据：`boot.ts:651-659`
  ```ts
  if (fiber.state !== 2) {
    ...
    disposers.set(entry.id, rollback)
    installed.set(entry.id, entry.rev)
  ```
- 影响：任何依赖「报告 ok」判断插件可用性的代码（诊断区 `app.tsx:234`、HMR 对账）在两条路径下看到的 ok 语义不一样；保留这个开关意味着每次改装配逻辑都要双份验证。
- 建议：把 `ledger` 分支标成 `@deprecated` 并加一条「只剩探针使用」的注释；确认 `scripts/*` 里没有 `__DSC_CORDIS_PROBE__ = 'none'` 之后删除该分支（见待核实）。
- 置信度：中（`scripts/` 未逐个检索）

### ui-layout（app.tsx）

#### [P1] `app.tsx` 1295 行承担十种职责
- 位置：`src/packages/ui-layout/ui/app.tsx`（在途改动文件）
- 现象：单文件里同时有：①骨架 DOM 结构（`.app/.sidebar/.main/.topbar/.thread-zone/.statusbar`）；②面板几何状态机（侧栏宽 / 正文列宽 / dock 宽 + 三处 localStorage 写盘 + 窗口 resize 夹取）；③全局快捷键（Ctrl+B/P/`/T）；④窄屏断点判定；⑤装载报告与账本订阅（`useSessionReports` / `useBootLedger` / `usePluginFailures`）；⑥连接状态横幅与宿主异常条；⑦侧栏窄栏（`SidebarRail`）；⑧队友面包屑（含 window 事件订阅）；⑨诊断区（含原生桥探针）；⑩四个快照字段读取器。
- 证据（每条职责的起止行）：
  - `228`：`export function App({ slots, boot, serviceRegistry, session, hmr, bootError, allowedModules }: AppProps): ReactNode {`，此函数一直写到 `718`（约 490 行）
  - `262-351`：面板几何（`readStoredPx` / `writeStoredPx` / `setRootVar`）
  - `364-388`：快捷键
  - `816-848`：`DockToggle`；`850-887`：`ConnectionBanner`；`888-904`：`HostErrorStrip`；`905-985`：`SidebarRail`
  - `1020-1225`：`Diagnostics`（约 205 行，含 `FIBER_TEXT` 表与四段表格渲染）
  - `1225-1295`：`useNativeProbe` + 三个快照读取器
- 影响：任何一次需求（改状态栏、改诊断区、加一个快捷键、调窄屏断点）都要在这一个文件里动，diff 冲突概率高；`Diagnostics` 需要 `session` 的账本形状（`AppBootLedger`，`101-119`）却又不是布局的事，等于把装载器的内部结构抄进了布局层。
- 建议：按「布局 / 面板几何 / 诊断」三刀切：①`panels.ts` 已经在 `ui-primitives` 里，把 `app.tsx:262-351` 的四个 state 收成 `usePanelGeometry()` hook；②`Diagnostics` 整块（`1000-1295` 含原生探针与快照读取器）搬到 `ui-layout/ui/diagnostics.tsx`，`AppBootLedger` / `AppSyncHandle` 那两份结构份额一起搬；③`SidebarRail` + `ConnectionBanner` + `HostErrorStrip` + 队友面包屑搬到 `ui-layout/ui/shell-chrome.tsx`。
- 置信度：高（结构扫描 + 关键段逐行）

#### [P2] 面板几何在 app.tsx 与 ui-primitives 各有一套提交路径
- 位置：`src/packages/ui-layout/ui/app.tsx:336-351`（`commitSidebarWidth` / `commitThreadWidth` / `commitDockWidth`）、`264-280`（初值读取）；`src/packages/ui-primitives/ui/panels.ts:161-195`（`writeStoredPx` / `remember`）
- 现象：app.tsx 每个 commit 都是「setState + writeStoredPx」，而 `writeStoredPx` 内部已经会 `remember()` 并向宿主 `setUiPrefs` 写一份；`dockWidth` 也有两条落点（`PANEL_KEYS.dockWidth` 与 `ui.panelWidths.dock`）。
- 证据：`app.tsx:348-351`
  ```ts
  const commitDockWidth = (px: number): void => {
    setDockWidth(px)
    writeStoredPx(PANEL_KEYS.dockWidth, px)
  }
  ```
  与 `panels.ts:11-12` 的「localStorage 用 `dsc.sidebarWidth` 这批，settings.json 用短键」说明。
- 影响：三个 commit 函数是同构复制；一旦某处忘了调 `writeStoredPx`（例如以后加第四块面板），就会出现「拖了但不落盘」且不报错。这一份是**刻意**的镜像设计（`panels.ts` 头注释说明换端口会丢 localStorage），所以不宜判死，但调用点可以收。
- 建议：在 `panels.ts` 里加 `useStoredPx(key, min, max)` 返回 `[value, commit]`，app.tsx 三处各一行即可，落盘路径只剩一处。
- 置信度：高

### 跨包（ui-layout / ui-sessions / ui-settings / ui-composer / ui-transcript）

#### [P1] 插件之间靠 8 个未登记的 `window` CustomEvent 互相喊话
- 位置：`src/packages/ui-layout/ui/app.tsx:386`、`428`、`520`、`927`、`975`；`src/packages/ui-sessions/ui/ui.tsx:460`、`1475`；`src/packages/ui-settings/ui/ui.tsx:198`、`940`；`src/packages/ui-transcript/ui/ui.tsx:190`；`src/packages/ui-composer/ui/ui.tsx:207`、`1150`；`src/packages/ui-composer/ui/model-controls.tsx:508`
- 现象：跨插件调用不用契约、不用服务表，用 `window.dispatchEvent(new CustomEvent('shell.xxx'))`，事件名是散在各文件里的字符串字面量。已有 8 个：`shell.palette.open`、`shell.settings.open`、`shell.session.new`、`shell.sidebar.toggle`、`shell.uiprefs`、`shell.preset.open`、`shell.teammate.view`、`shell.teammate.exit`（另有两个只出现在 `SLOT` 同名常量附近的字符串不计）。同一事件名在发/收两侧各写一遍，没有常量、没有类型化的 `detail` 形状。
- 证据：
  - `ui-layout/ui/app.tsx:975`：`window.dispatchEvent(new CustomEvent('shell.settings.open'))`
  - `ui-settings/ui/ui.tsx:198`：`window.addEventListener('shell.settings.open', onOpen)`
  - `ui-composer/ui/model-controls.tsx:508`：`window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'models' } }))`（第三个发送方，带 detail）
- 影响：改一个事件名要全局搜索；`detail` 形状（`{section:'models'}`）只有发送方知道，接收方按 `unknown` 收，写错了是运行时静默什么都不发生。与槽名 `SLOT`（集中登记在 `ui-slots/ui/slots.ts:41-80`）形成鲜明对比——槽名有表，事件名没有。
- 建议：在 `@dsc/ui-core`（或 `ui-slots`）加一张 `SHELL_EVENTS` 常量表 + `type ShellEventDetail` 映射，全部 dispatch/listen 改成 `SHELL_EVENTS.settingsOpen`；更进一步，把「打开设置某页」「开新会话」这类改成动作表（`ui-actions` 已经有 `ActionsHandle`）里的动作，插件只调 `run()`，跨包就只剩一条服务依赖。
- 置信度：高（全仓 grep `CustomEvent('shell.` / `addEventListener('shell.` 已穷举）

### 样式层（ui-renderer/ui/styles）

#### [P1] 同一批组件样式在 legacy/views.css 与 styles.css 各写一份，靠加载顺序压过令牌
- 位置（三组行号对照）：
  1. `.btn-primary` — `legacy/views.css:2687-2696` vs `styles.css:402-408`
  2. `.icon-btn` — `legacy/views.css:274-283` vs `styles.css:362-366`
  3. `.model-btn` — `legacy/views.css:2921-2931` vs `styles.css:428-437`
- 现象：`main.tsx:46-57` 的加载顺序是 tokens → base → primitives → views → xterm → styles.css → 颜色兜底；同特异性下后者赢。`views.css` 里这批规则全部走 `var(--dsc-*)` 令牌，`styles.css` 用硬值再写一遍几何，于是令牌对这批组件失效。
- 证据：
  - `views.css:2687-2693`：`border-radius: var(--dsc-r-control); ... font-size: var(--dsc-fs-ui); min-height: var(--dsc-ctl); padding: 0 12px;`
  - `styles.css:403-407`：`.btn-primary { border-radius: 12px; font-size: var(--dsc-fs-ui-lg); min-height: 36px; padding: 0 14px; }`
  - `views.css:279-281`：`height: var(--dsc-ctl); width: var(--dsc-ctl);` → `styles.css:364-365`：`height: 28px; width: 28px;`
  - `views.css:2928`：`max-width: 280px;` → `styles.css:435`：`max-width: 224px;`（`.model-btn.composer-model-chip`）
- 影响：改主题尺寸（例如把 `--dsc-ctl` 从 26 调到 30）时，主按钮与图标按钮**不动**，而别处同令牌的控件会动，界面上出现两种控件高度；改 `.icon-btn` 的圆角要同时看两个文件。这是「同一组件样式在多处定义、靠加载顺序压过」的直接样本。
- 建议：二选一并写明：①把 `styles.css:362-437` 这批几何改回用令牌（`var(--dsc-ctl)` / `var(--dsc-r-control)`），需要的「本壳更大一档」通过 `styles.css:3789` 那节 `:root` 里改令牌值来实现（那节本来就是干这个的）；②或者把 `views.css` 里这些被覆盖的块删掉，并在 `PROVENANCE.md` 里登记「这批已迁到 styles.css」。不要两边都留。
- 置信度：高（三组的双方原文都读过）

#### [P2] `:root[data-theme='claude']` 在三个文件里各定义一遍
- 位置：`legacy/tokens.css:495-…`（整段令牌）、`legacy-color-fallback.css:114-…`（`@supports not (color: color-mix(...))` 里的降级值）、`styles.css:3766-3769`
- 现象：第三份只是一条 `--dsc-fti-violet`，但它与前两份用同一个选择器、同一特异性，落点取决于各文件的加载次序（tokens 在最前，styles.css 倒数第二）。`legacy-color-fallback.css` 是生成物（`ui-shell/scripts/build-color-fallback.mjs`），整个块包在 `@supports not` 里，认得 `color-mix()` 的内核不生效——这一份是**合理**的兼容层，不算重复；真正的问题是 `styles.css` 也往同名选择器里塞变量，让「主题令牌只有两处来源」这条不变量失真。
- 证据：`tokens.css:495`：`:root[data-theme='claude'] {`；`legacy-color-fallback.css:114`：`  :root[data-theme='claude'] {`（缩进在 `@supports` 内）；`styles.css:3766-3768`：`:root[data-theme='light'], :root[data-theme='claude'] { --dsc-fti-violet: #a78bfa; }`
- 影响：将来按主题拆样式文件（例如把 claude 档做成可换皮肤）时，会漏掉 styles.css 里这一条散落的变量。
- 建议：`styles.css` 里新增的主题相关变量一律挪进 `legacy/tokens.css` 对应主题块，`styles.css` 只留结构；或至少加一行注释「主题令牌只在 tokens.css / color-fallback.css 定义」。
- 置信度：高

#### [P2] `legacy/views.css` 330KB 的存在理由只剩「将来搬视图」，上游已不可对照
- 位置：`src/packages/ui-renderer/ui/styles/legacy/PROVENANCE.md:3`、`10`、`26`、`32`、`40-44`
- 现象：PROVENANCE 说四份文件是「从 `desktop/src/renderer/…` 原样复制」，但当前 checkout 里 `desktop/src` 不存在（只有 `desktop/electron`），冻结探针 `scripts/legacy-frozen-check.mjs` 比对的「冻结副本」在树内已找不到；同一份说明第 26 行自承「`views.css` 里有九成规则现在没有对应的界面」。也就是说：330KB 里绝大部分是死规则，剩下的是活规则（与 `styles.css` 互相覆盖的那批）。
- 证据：`PROVENANCE.md:26`：「`views.css` 里有九成规则（停靠栏、轨迹页、设置页、文件预览）现在没有对应的界面，属于「暂时不生效」。」；`PROVENANCE.md:7-10` 的四行来源表全部指向 `desktop/src/renderer/*`。
- 影响：任何人改样式都要先判断「这条规则现在生效吗、有没有被 styles.css 盖掉」，而判断依据是一份指向不存在路径的说明。样式体积本身不是问题（本地静态资产），问题是**改错文件不报错**。
- 建议：写一个一次性脚本：用 CDP 抓真实运行时 `document.styleSheets` 的 `cssRules`，把「选择器在 DOM 上匹配数为 0」的规则统计出来并落盘成清单；按清单分段删除死规则，把仍在生效的那批（估计就是本报告 F5 那三组 + `.settings*` / `.statusbar*` / `.welcome*`）在 `PROVENANCE.md` 里点名，其余整段删。删之前先把 `styles.css` 里覆盖它的那批改成用令牌（见 F5），避免删完视觉回退。
- 置信度：中（PROVENANCE 与目录状态已核对；「九成不生效」是它自己的说法，未逐条验证）

### ui-runtime

#### [P1] 主题默认值与归一化在宿主、壳、桌面主进程三处各一份，`system` 档在桌面侧丢失
- 位置：`src/core/prefs.ts:150`、`188`、`191-194`、`382`；`src/packages/ui-runtime/ui/appearance.ts:31-37`、`65-72`、`96`、`99-103`；`desktop/electron/main/index.ts:93-106`、`66-70`、`422`
- 现象：三处各写一遍「四档主题」与出厂默认 `claude`；字号区间与旧三档映射各写两遍（注释写着「改这里要两边一起改」）。桌面主进程 `readUiTheme()` 的判定是 `if (mode === 'dark' || mode === 'light' || mode === 'claude') return mode`，`system` 落空后走到 `return 'claude'`——但函数上方第 73 行注释写的是「`system` 按系统深浅解析」。这个值还会被拼进地址（`index.ts:422` 的 `theme=${readUiTheme()}`），被 `appearance.ts:256-259` 的 `bootTheme()` 读走当首帧主题。
- 证据：
  - `desktop/electron/main/index.ts:99`：`if (mode === 'dark' || mode === 'light' || mode === 'claude') return mode`
  - 同文件 `105`：`return 'claude'`
  - 同文件 `73`（注释）：`` * 当前窗口主题：读 `settings.json` 的 `ui.themeMode`，`system` 按系统深浅解析。 ``
  - `appearance.ts:96`：`const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'claude', 'system']`
  - `prefs.ts:150`：`const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'claude', 'system']`
  - `appearance.ts:37` 与 `prefs.ts:188`：两行完全相同的 `const LEGACY_FONT_SCALES: Record<string, number> = { sm: 0.92, md: 1, lg: 1.12 }`
- 影响：①选了「跟随系统」且系统是深色的用户，**每次开窗**第一帧都是米白（`claude`），随后界面脚本拿到 `getUiPrefs()` 才翻成深色——首帧闪一下；②改主题档位词表（例如加第五档）要改三个仓库内文件，漏一个的表现是「设置里能选、开窗不认」；③字号旧档迁移表有两份，一份四舍五入到两位小数（`appearance.ts:87`）一份没有（`prefs.ts:234`），同一份 `settings.json` 在宿主侧与壳侧可能算出 `1.1200000000000001` 与 `1.12`。
- 建议：把 `ThemeMode` 联合、四档词表、出厂默认、字号区间与旧档映射收进 `@dsc/ui-core`（已经转出 `ThemeMode` 类型，只差值），`prefs.ts` 与 `appearance.ts` 各自 import；桌面主进程那份 `readUiTheme()` 要么补上 `system → nativeTheme.shouldUseDarkColors ? 'dark' : 'light'`，要么把注释改成「`system` 不参与，首帧按 claude」并明说这是已知取舍。
- 置信度：高（三处原文都读过；`system` 档丢失是静态可判定的分支缺口，未实机验证）

#### [P2] 同一个文件里 `foldedReplies` 有两个不同的默认值
- 位置：`src/packages/ui-runtime/ui/appearance.ts:65-72`（`DEFAULT_APPEARANCE.foldedReplies: 'final'`）vs `119-121`（`normalizeFoldedReplies` 回落 `'all'`）
- 现象：无缓存首帧走 `loadCachedAppearance()` → `DEFAULT_APPEARANCE`（`final`）；只要经过 `appearanceFromPrefs(null)`（宿主 `getUiPrefs` 返回 null 或字段缺失）就得到 `all`。两处注释还互相矛盾：第 69 行说「与 core/prefs.ts 同口径……默认保留全部回复」，第 115 行说「回落 `'all'`（参考实现的默认值，不是 `'final'`）」，而 `prefs.ts:182` 的 `FOLDED_REPLIES_DEFAULT` 实际是 `'final'`。
- 证据：
  - `appearance.ts:71`：`foldedReplies: 'final',`
  - `appearance.ts:120`：`return value === 'final' ? 'final' : 'all'`
  - `prefs.ts:182`：`const FOLDED_REPLIES_DEFAULT: UiFoldedReplies = 'final'`
  - `prefs.ts:285`（注释）：「认不出的值一律回落 `all`（参考实现的默认值）」——与第 294 行 `return ... : FOLDED_REPLIES_DEFAULT` 相反
- 影响：宿主读不到偏好的那一帧，收起后的对话要么只剩最终回答、要么全部摊开，取决于走的是哪条路径；`prefs.ts` 那两行注释会让下一个改这块的人把 `final` 改回 `all`。
- 建议：`normalizeFoldedReplies` 的回落改成 `DEFAULT_APPEARANCE.foldedReplies`（唯一来源），并删掉 `prefs.ts:285` 与 `appearance.ts:115` 里关于「参考实现默认 all」的说法，只留「本项目默认 final，理由见 prefs.ts:176-181」。
- 置信度：高

#### [P1] `HostPluginsFrame` 与 `UiHmrFrame` 是同一帧的两份定义，宿主身份有三种形状
- 位置：`src/packages/ui-runtime/ui/host-channel.ts:79-84` vs `src/core/ui-hmr.ts:37-42`；`src/core/ui-manifest.ts:121` vs `src/packages/ui-core/plugin.ts:31-49` vs `src/packages/ui-boot/ui/boot.ts:224`
- 现象：帧的四个字段（`rev` / `changed` / `removed` / `graph`）在宿主侧与浏览器侧各声明一遍，谁都没引用谁；`graph` 的类型倒是都从 `@dsc/ui-core` 来（这一点是对的）。宿主身份则是三种形状：启动图里 `{ name; version; language? }`、插件 API 里 `UiHostInfo`（多了 `platform?`）、启动账本里 `{ name; version }`（丢了 `language`）。
- 证据：
  - `host-channel.ts:79-84`：`export interface HostPluginsFrame { rev: string; changed: string[]; removed: string[]; graph: UiBootGraph }`
  - `ui-hmr.ts:37-42`：`export interface UiHmrFrame { rev: string; changed: string[]; removed: string[]; graph: UiBootGraph }`
  - `boot.ts:224`：`host: { name: string; version: string }`
  - `ui-manifest.ts:121`：`host: { name: string; version: string; language?: string }`
- 影响：给这一帧加字段（例如 `reason`）时，宿主侧加了、壳侧没加，`JSON.parse(...) as HostPluginsFrame` 不会报错，只会在用到新字段时得到 `undefined`；启动账本丢了 `language` 意味着诊断区没法显示「当前界面语言」，而这条信息启动图里本来就有。
- 建议：`UiHmrFrame` 留在 `core/ui-hmr.ts` 并让 `ui-runtime` 从 `@dsc/ui-core` 取（`ui-core` 已经 `export *` 了 `ui-manifest`，把 `ui-hmr` 的类型也转出即可，注意别把 node 依赖带进浏览器——`ui-hmr.ts` 顶部 import 了 `node:fs`，只能转类型）；`UiHostInfo` 改成 `Pick<UiBootGraph['host'], ...> & { platform?: UiPlatform }`，账本里直接存 `graph.host`。
- 置信度：高

### ui-primitives

#### [P2] 「基元库」里混着三块业务域解析，并被整包转出给所有插件
- 位置：`src/packages/ui-primitives/ui/review-findings.ts:1-23`、`ui/tool-summary.ts`、`ui/file-type-classify.ts`；转出口在 `ui-shell/src/plugin-api.ts:421`
- 现象：`review-findings.ts` 解析的是 `/review` 队友汇报的标记格式，格式由 `src/core/agent-roles.ts` 的 reviewer 提示词钉死（该文件第 6 行自己写明「条目格式是 reviewer 角色提示词里约定死的」）；`tool-summary.ts`（347 行）是工具卡的摘要逻辑；`file-type-classify.ts`（404 行）是扩展名分类。这三块都不是「视觉基元」，而是某个功能域的知识。它们又因为 `plugin-api.ts:421` 的 `export * from '@dsc/ui-primitives'` 变成所有插件都能拿的公共面。
- 证据：`review-findings.ts:6-7`：「条目格式是 reviewer 角色提示词里约定死的（`src/core/agent-roles.ts` 的 BUILTIN_FILES.reviewer，任务书 `reviewTaskText` 里也再写了一遍）」；`plugin-api.ts:421`：`export * from '@dsc/ui-primitives'`
- 影响：改 reviewer 的汇报格式要动 `src/core/agent-roles.ts`，而解析器在另一个包的「基元库」里，两边没有编译期约束；`export *` 让任何一个改基元库的人都可能顺手改掉公共 API 面（现在导出 48 个模块的全部符号）。
- 建议：把 `review-findings*`（含两个 card 组件）搬到 `ui-transcript`（消费方），`tool-summary` / `tool-args` 搬到 `ui-transcript` 或新的 `ui-toolview`，`file-type-*` 留在基元库或独立 `ui-file-icons` 包；`plugin-api.ts:421` 的整包转出改成显式名单（现有 421-456 已经是显式名单 + 一行 `export *`，把 `export *` 换成名单即可）。
- 置信度：中（三块只读了头部与导出面，未逐行核对调用方）

---

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
| --- | --- | --- | --- | --- |
| 插件装配生命周期 | 退订账本（`boot.ts:671-688`，apply 返回 dispose） | cordis 纤维（`boot.ts:620-670`，`CORDIS_DEFAULT_ALL=true`） | 仍在代码里由 `__DSC_CORDIS_PROBE__` 切换；探针/单测可用 `'none'` 回退 | 冻结旧分支为 `@deprecated`，确认 `scripts/` 无引用后删 |
| 宿主调用通道 | `host-stdio` invoke（全量 `INVOKABLE_METHODS`，无实参校验） | `/api/invoke` + `UI_METHODS` 子集 + `validateUiArgs` | 桌面窗口走旧的那条；浏览器/手机走新的那条 | 合法性与实参校验收敛成一个函数，两条链共用 |
| 快照推送 | `host-stdio` 自写 leading-edge 节流（`211-222`） | `core/ui-events` 的 `RemoteFrameHub` + 拖尾节流 + 补帧（`269-289`） | 桌面窗口 | 抽 `createSnapshotPump`，节流模式作参数 |
| 启动图注入 | `ui-server.ts` 的 `bootJson()` + `/boot.js` + `injectBootScriptTag()` | `remote/routes.ts:387-396` 自己拼一份 `globalThis.__DSC_BOOT__=…` | 远程壳（手机） | 远程改成复用 `bootJson`/`injectBootScriptTag`（`injectBootScriptTag` 已经复用了，只差转义那一行） |
| 壳样式 | `legacy/views.css`（330KB，九成规则当前无对应界面） | `styles.css`（171KB，壳自写 + 覆盖层） | 两者同时加载，靠 import 顺序决定胜负 | 见 F5 / F13：先让 styles.css 改用令牌，再按「DOM 匹配数=0」清单删死规则 |
| 外观实现 | 桌面渲染层 `desktop/src/renderer/appearance.ts`（**该路径在当前 checkout 已不存在**） | `ui-runtime/ui/appearance.ts` | 只剩注释与 PROVENANCE 在引用旧路径 | 注释里的旧路径改成「历史来源」或删掉，别让读者以为还能对照 |
| 启动兜底 | `ui-boot/ui/main.tsx` 的 `RendererUnavailable` | `ui-renderer/ui/ui.tsx` 的 `LayoutUnavailable` | 两条都在用（分别对应两个可停用单元） | 合并成一个 `<BootDiagnostics target=…>` |
| 帧归并 | 遥控端容忍版（`remote-web/src/lib/reduce.ts`，本批未读） | `ui-core/frames.ts` 严格版（认 seq、跳号抛错） | 手机经典档 / 手机壳档各一份 | 刻意分叉且已写明理由（`frames.ts:8-11`），保留；只需在两处互相指路 |
| 模块白名单 | TUI 壳的 `ui-core/tui-plugins.ts` 一张表 | web 壳的 `boot.ts:146-163` `MODULES` + `platform-modules.json` | 各自服务自己的载体 | 刻意分叉（注释已说明），保留；建议两处都从同一份 json 派生 |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
| --- | --- | --- | --- | --- |
| 退启动占位 `dismissBootSplash` | `ui-boot/ui/main.tsx:98-109` | `ui-renderer/ui/ui.tsx:153-164` | 逐字相同 | 抽到 `ui-primitives`，两处 import |
| 启动失败诊断页 | `ui-boot/ui/main.tsx:120-168` | `ui-renderer/ui/ui.tsx:175-223` | 仅 i18n key 与 `target` 不同，内联样式重复 40 行 | 同上，做成 `target` 参数化组件 |
| 服务依赖读取 | `boot.ts:498`（`serviceDepsOf`） | `boot.ts:583`（`unmetDependencies` 入参） | 同一字段读两遍，且都因 F1 恒为空 | 修好 F1 后保留两处（一条给 cordis inject、一条给硬依赖判定），加注释说明分工 |
| 快照节流 | `host-stdio/index.ts:211-222`（leading） | `core/ui-events.ts:269-289`（trailing） | 语义不同（见 F2） | 抽 `createSnapshotPump` |
| 主题档位词表 | `core/prefs.ts:150` | `ui-runtime/ui/appearance.ts:96` | 完全相同 | 收进 `@dsc/ui-core` 常量 |
| 字号旧档映射 / 区间 | `core/prefs.ts:188`、`191-194` | `ui-runtime/ui/appearance.ts:37`、`31-34` | 夹取后是否 `Math.round(×100)` 不同 | 收进 `@dsc/ui-core` 的 `normalizeFontScale` 一份 |
| 出厂默认主题 | `core/prefs.ts:382` | `ui-runtime/appearance.ts:65`、`desktop/electron/main/index.ts:105` | 三处都是 `'claude'`，桌面侧把 `system` 也吞成 claude | 见 F6 |
| 帧类型 | `core/ui-hmr.ts:37-42` | `ui-runtime/ui/host-channel.ts:79-84` | 字段逐个相同 | 见 F7 |
| `boot.js` 体转义 | `core/ui-server.ts:323-324`（`bootJson`） | `remote/routes.ts:388` | 后者的 `cache-control` 是 `no-store`、前者 `no-cache` | 导出 `bootJson` 给 remote 用 |
| 插件 bundle 解析 | `core/ui-route.ts:60-120`（单资源） | `routes.ts:374-384` 调同一份 | 已收敛，仅错误分支自己写头 | 无需动（这条是**做对了**的复用，记为正面样本） |
| 面板几何提交 | `ui-layout/ui/app.tsx:336-351` | `ui-primitives/ui/panels.ts:161-195` | 前者每个 commit 复制一遍 `setState+writeStoredPx` | 抽 `useStoredPx` |
| 快照字段读取 | `ui-layout/ui/app.tsx:986/1260/1279/1290` | `ui-status`/`ui-settings`/`ui-primitives` 各自的 `read*`（例：`ui-settings/ui/ui.tsx:460-541` 有 12 个） | 都是 `Record<string, unknown>` 手写防御式解构，没有共享 | 把 `status` 段收成 `@dsc/ui-core` 的 `readStatus(snapshot)`（`plugin-api.ts:197-217` 的 `hostStatus` 已是雏形），各包改调它 |
| 命令面板 | `ui-palette/ui/ui.tsx`（唯一一套） | `ui-plugins/ui/ui.tsx`（无搜索，只有分组过滤 `323-338`） | 不是重复 | 无需动；核对结论 |

## 待核实

1. `ui-shell/src/slot-contract.typecheck.tsx`（78 行）未逐行读——它是第三份「槽位形状」断言，需要确认是不是与 `plugin-api.ts:59-85` 的类型别名重复表述。
2. `ui-core/slots.ts`（849 行）只读了声明段——它是否也含一份 `SlotMap`/`FactoryMap` 的兜底定义（与 `plugin-api.ts` 的 `interface SlotMap {}` 并存）需要确认；849 行本身也可能是 god file 候选。
3. `scripts/*.mjs` 是否直接依赖 `__DSC_CORDIS_PROBE__`、以及是否有探针按 `graph.entries[].services` 断言（这决定 F1 的修复会不会让某个探针从「隐式通过」变红）。
4. `ui-dockkit/ui/dock-model.ts`（728 行）只看了导出面：`DockSurface` 里是否也存了宽度/分栏比（若存，则 F3 附带的「dock 宽三处存」要升级为四处）。
5. 桌面主进程 `readUiTheme()` 的 `system` 缺口：需确认 `settings.json` 里真的会写入 `'system'`（`prefs.ts` 的 `setUiPrefs` 写入口未读），以及 `nativeTheme` 是否在别处兜底（`main/index.ts:1056-1058` 只把 `claude → light` 做了映射）。
6. `src/core/ui-trust.ts`、`native-bridge.ts`、`web-http.ts`、`web-static.ts` 四份未逐行读（本批时间不够），只通过调用方确认了职责：三道闸、原生操作规格、JSON 收发、静态伺服。
7. `remote-web/src/lib/reduce.ts`（容忍版帧归并）不在本批范围，仅按 `ui-core/frames.ts:4-11` 的注释核对，未读原文。
8. `styles.css` 与 `views.css` 的 73 个跨文件重复选择器只验证了 3 组原文，其余 70 组是按脚本比对得出（同选择器字符串出现在两个文件），未逐组判断「是否 @media 内的合理覆盖」——F5 与 F13 的删除清单需要按运行时匹配数复核。
9. `ui-plugins/ui/ui.tsx`（1255 行）只在「是否另有一套命令面板」这个角度做了 grep 核对，未做整体审查（属批次 04 的界面单元范围）。
