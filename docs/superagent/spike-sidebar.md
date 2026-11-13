# 侧栏入口探针（第 1 步）

## 结论

推荐甲（`ui-plugins` 那套）：面板本体挂 `shell.page` 整页，四个页做成页内导航，「工单列表 → 工单详情」沿用同一个页内的状态替换（`src/packages/ui-plugins/ui/ui.tsx:170`、`:358-367`）。
理由是它零壳体改动、整页宽度够摊 diff、关闭就是再点一次侧栏行；乙要自己查 DOM 找挂载点，还会盖掉输入区；丙的 dock 定位是只读伴读面且有 820px 上限。
代价也要认：整页会顶掉对话，且插件被停用后没有任何人把 `page` 复位（只有 `plugins` 有特判，`src/packages/ui-sessions/ui/ui.tsx:210-213`）。

## 三种范式的对照表

| 能力 | 甲 ui-plugins 详情面板 | 乙 ui-team 浮层 | 丙 dock 页签 / 模态浮层 |
| --- | --- | --- | --- |
| 能否承载多页 | 能。载体是 `shell.page` 整页（`src/packages/ui-plugins/ui/ui.tsx:147`），页内用本地 state 切「列表/详情」（`:170`、`:358-367`）；同一页再加一层页签纯属 React 选择，现成样子见 `src/packages/ui-skills/ui/ui.tsx:476-505` 的 `.skills-tabs` | 能，但要自己画。它自带的只有「头部一行 + 消息流」两段（`src/packages/ui-team/ui/ui.tsx:364-402`），没有页签概念 | dock：一种 kind 一张页签（`src/packages/ui-dockkit/ui/dock-model.ts:153-170`），四个页得在一个页签体内再做一层页签；模态：左导航多页是现成的（`src/packages/ui-settings/ui/ui.tsx:292-312`） |
| 能否放操作按钮 | 能。返回（`ui-plugins/ui/ui.tsx:952-955`）、开关（`:974-986`）、页头三颗（`:378-404`） | 能。头部就摆着停止 / 发话 / 移除 / 返回（`ui-team/ui/ui.tsx:381`、`:412-513`） | 都能：页签体收 `DockTabBodyProps` 就是普通组件（`dock-model.ts:122-129`），模态里是普通 JSX |
| 宽度/高度限制 | 占满主区：`.plugins` 是 `flex:1` 自己滚、内边距 26/40（`src/packages/ui-renderer/ui/styles/legacy/views.css:3934-3938`），内层 `.plugins-inner` 最大 1080（`:3940-3944`） | `inset:0` 绝对定位盖满 `[data-thread-area]`（`views.css:8141-8149`），含输入区与状态栏（`src/packages/ui-layout/ui/app.tsx:637-645`），宽度=正文列宽，没有自己的上下限 | dock：宽度用户拖，上限 `min(820px, …)`（`views.css:4253-4255`），全屏态盖到标题栏以下（`:4264-4274`）；模态：`min(1080px,…) × min(680px,…)`（`:6104-6105`），左导航固定 200px（`:6115-6124`） |
| 关闭方式 | 再点侧栏那一行（同款 toggle：`ui-sessions/ui/ui.tsx:856`、`:870`），或页内返回（`ui-plugins/ui/ui.tsx:952`）；没有 Esc；换会话会自动回对话页（`ui-sessions/ui/ui.tsx:336`） | 返回钮（`ui-team/ui/ui.tsx:382-391`）、Esc（`:338-347`）、换会话（`:313-324`）、顶栏面包屑发 `shell.teammate.exit`（`:328-336`） | dock：页签上的 ✕（`views.css:4382-4397`）+ 收起（`:4258-4261`）；模态：点遮罩 / ✕ / Esc（`ui-settings/ui/ui.tsx:286-289`、`:319-329`、`:187-189`） |
| 改动量 | 两个 `register`（侧栏一行 + 整页一页），零壳体改动；页和行同属一个插件，停用即双双消失 | 侧栏注册 + 一个 portal 组件 + 开合信号 + 挂载点查询 + Esc，比甲多约 60–100 行壳外代码 | dock：`registerDockTab` + 打开动作，零壳改；模态：自绘遮罩 + 面板，Esc/焦点圈引 `useDialogFocus`（`src/packages/ui-primitives/ui/dialog-focus.ts:34`、`:63`） |
| 风险 | 整页顶掉对话；停用插件后 page 不复位；页条目随整页模式卸载，页内状态会丢（`app.tsx:477`、`:655-692`）；手机上页头标题写死成「技能/插件」（`app.tsx:676`） | 挂载点是 DOM 查询（`ui-team/ui/ui.tsx:244`、`:303-310`），整页模式 / 轨迹切换 / 换会话都会换掉那个元素；层级要压住状态胶囊又不盖浮层菜单（`views.css:8139-8148`）；它盖住输入区，等于也不能边看边聊（`ui-team/ui/ui.tsx:274`） | dock：定位是「只读伴读面，不是模态框」（`dock-model.ts:49-55`），塞发布表单与设置进去与定位冲突；布局按会话存（`:104-114`），没有会话时整块不挂（`app.tsx:706`）。模态：全屏遮罩挡住整个界面，样式要借 `.settings-*`（`views.css:6086-6113`），壳换肤会连带 |

## 侧栏那一行怎么加

- **扩展点**：槽名 `shell.sidebar`（`src/packages/ui-slots/ui/slots.ts:30` 声明为 `list`，`:52` 的 `SLOT.sidebar`），壳在 `src/packages/ui-layout/ui/app.tsx:450-452` 用 `SlotOutlet` 画。
- **注册方法**：`ui.slots.register(槽名, { id, order }, 组件)`；list 槽按 `order` 升序画（`src/packages/ui-core/slots.ts:920-923`）。
- **现成例子**：全仓库只有 `ui-sessions` 往这个槽注册过一条（`ui-sessions/ui/ui.tsx:102`，order 1）。**别的包往侧栏加行的例子查不到**。同一套注册面在别的槽上的例子：`ui-team/ui/ui.tsx:174`（`shell.header.lead`）、`ui-plugins/ui/ui.tsx:147`（`shell.page`）、`ui-settings/ui/ui.tsx:175`（`shell.header`）。
- **位置上必须先说清**：`shell.sidebar` 只能加在「会话列表整块」的前面或后面，进不到某个工作区分组里面——分组行是 `SessionList` 自己的 JSX（`ui-sessions/ui/ui.tsx:1005`），那个包的 `apply` 是空的、不 `provide` 任何服务（`ui-sessions/index.ts:29`），它那条注册也没传 `children`（`ui-sessions/ui/ui.tsx:102`；`children` 是条目拿到渲染子槽能力的唯一来源，`ui-core/slots.ts:526`）。`order > 1` 的条目落在 `.sidebar-footer`（`ui-sessions/ui/ui.tsx:1513`）之后、`.sidebar` 这个 flex 列的最底部（`views.css:48-50`、`:293-295`）。设计文档第 458 行要的「工作区目录下一行」在现有壳里做不到，见待确认 2。

```tsx
// 界面半入口：一行入口 + 一个整页，都归这个插件，停用即双双消失。
export default defineUiPlugin({
  name: t('superagent.name'),
  apply(ui) {
    // order 2 = 排在 sessions.list（order 1）之后；order 0 则跑到「新会话」按钮上面。
    ui.slots.register('shell.sidebar', { id: 'superagent.entry', order: 2 }, EntryRow)
    ui.slots.register('shell.page', { id: 'superagent.page', order: 30 }, Page)
  },
})
```

**徽标数据从哪来**：`snapshot.surfaces.superagent.counts.needsYou`。快照里的 `surfaces` 由 transcript 插件装进去（`src/packages/transcript/index.ts:311` 建、`:383` 挂），契约面 `RuntimeSurfaces` 在 `src/contract/runtime.ts:245-279`；界面侧用 `useHostSelector` 只订阅这一小块（`src/packages/ui-runtime/ui/runtime-context.tsx:49-72`），投影的写法照 `src/packages/ui-composer/ui/surfaces.ts:223-235` 的 `readGit`（形状检查 + 常量兜底；这一格只要一个数字，`useHostSelector` 的默认 `Object.is` 就拦得住重渲染）。渲染这一格没有通用徽标原语（`docs/ui-design.md:153`），侧栏原来那个数量徽标还被删掉了（`views.css:9403-9404`，理由是「数量在 data-tip 里」，可 data-tip 的气泡层本身也已下线，`src/packages/ui-renderer/ui/styles/legacy/primitives.css:335-338`），能复用的只有 `.nav-item` 的行几何（`views.css:216-245`），计数格自己写内联样式。

## 推荐方案的最小代码骨架

宿主侧五处（顺序照 `docs/development.md:381-399`，行号给的是现有同类的位置）：

```ts
// 1) src/contract/snapshot.ts:115 的 DscRuntime 加签名（照 :261 peekTranscript 的形状）
superagentPublish(input: { title: string; body: string; base?: string }): Promise<string>
superagentPeekSession(ticketId: string): Promise<TranscriptEntry[]>
// 2) src/packages/runtime/index.ts 实现（同域方法摆一起）
// 3) src/core/host-methods.ts:25 的 INVOKABLE_METHODS 加名字
//    注意：设计文档 docs/superagent-design.md:504 写的是 host-stdio/index.ts，清单已搬到这里
// 4) src/core/ui-methods.ts:91 放行；:289 的 UI_ARG_SPECS 加规格（照 :334 那条一参 string 的写法）
// 5) 快照面：ctx.effect(() => ctx.surfaces.register('superagent', () => svc.surface()), '…')
//    照 src/packages/surfaces/index.ts:21 的注册面；只有读类才进 src/packages/remote/types.ts:105
```

界面侧（注册 + 读徽标 + 整页切换；hooks 与「不是我就返回 null」分开放，照 `ui-plugins/ui/ui.tsx:152-158`）：

```tsx
const PAGE = 'superagent'
const tab = createSignal<Tab>('publish')   // 页内选择放模块级：整页卸载后不丢
const useTab = (): Tab =>
  useSyncExternalStore((onChange) => tab.subscribe(onChange), () => tab.get(), () => 'publish')

function EntryRow(): ReactNode {
  const page = useShellPage()
  const needsYou = useHostSelector(readNeedsYou)
  return (
    <div className="sidebar-nav">
      <button type="button" className={`nav-item${page === PAGE ? ' on' : ''}`} aria-pressed={page === PAGE}
        onClick={() => { setShellPage(page === PAGE ? null : PAGE) }}>
        <IconBolt size={15} /> {t('superagent.entry')}
        {needsYou === 0 ? null : <span style={{ marginLeft: 'auto' }}>{needsYou}</span>}
      </button>
    </div>
  )
}

function Page(): ReactNode {
  const page = useShellPage()
  return page === PAGE ? <PageBody /> : null
}

function PageBody(): ReactNode {
  const current = useTab()   // 四个页共用一条页签行，照 ui-skills/ui/ui.tsx:476-505
  return <div className="plugins"><div className="plugins-inner">…页签行 + 当前页…</div></div>
}

/** 只取一个计数：形状不对给 0，快照每帧换引用也不重渲染。 */
function readNeedsYou(snapshot: HostSnapshot | null): number {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return 0
  const block = (surfaces as Record<string, unknown>)['superagent']
  const counts = typeof block === 'object' && block !== null ? (block as Record<string, unknown>)['counts'] : null
  const value = typeof counts === 'object' && counts !== null ? (counts as Record<string, unknown>)['needsYou'] : 0
  return typeof value === 'number' ? value : 0
}
```

## 待确认

1. **`RuntimeSurfaces` 能不能从插件侧做模块增强**。卡在模块名：设计文档 `docs/superagent-design.md:469` 写 `declare module '@pneuma/runtime/contract.js'`，而 `@pneuma/runtime/*` 落到 `src/*`（根 `tsconfig.json:18`），也就是 `src/contract.ts`——那个文件只做转出（`src/contract.ts:2`、`:17-27`），接口本体在 `src/contract/runtime.ts:245`。而 `ui-shell/src/plugin-api.ts:53-58` 明确写过「`declare module` 的合并只认词法相邻的声明，re-export 不参与」。到底能不能并上，要一个 `tsc` 探针才知道，本轮不构建。
2. **「工作区目录下一行」这个位置在现有壳里没有扩展点**。卡在产品口径：是接受「会话列表整块下面一行」（`shell.sidebar` order 2），还是允许改壳内包给 `ui-sessions` 开一个子槽（那要动 `ui-sessions/ui/ui.tsx` 与它的 `shell.sidebar` 注册，属于改别人的包）。
3. **插件自带 `<style>` 会不会在热更里累积**。文档说在 `apply` / 首次渲染期间插、物化边界会打标（`docs/plugin-development.md:1351-1353`），代码里 `claimStyles` 只在模块实例化那一刻跑（`src/packages/ui-boot/ui/boot.ts:960`、`:977`），剔除只删带标的（`:932-937`）。在 `apply` 里插到底打不打标、换装会不会留脏样式，要跑 HMR 探针（`scripts/ui-hmr-test.mjs`）才知，本轮不跑。全仓库现有界面包没有一个自己插 `<style>`（查不到调用点）。
4. **停用 `ui-superagent` 时谁把 `page` 复位**。现有只有 `plugins` 一页有特判（`ui-sessions/ui/ui.tsx:167-183`、`:210-213`），`skills` 没有。如果用户在 Super Agent 页上停用它，主区会剩一片空白，只有点一条会话才能回来（`ui-sessions/ui/ui.tsx:336`）。要不要在自己的 `apply` 清理里补一条「停用即 `setShellPage(null)`」，要在真机上试一次停用才敢定（`scripts/ui-plugin-disable-e2e.mjs` 那一类探针），本轮不跑。
5. **徽标点下去跳到哪**。代码里没有「点计数进筛选」的约定，是跳到工单列表并预筛「需要你处理」，还是只当读数不响应点击，得产品拍板。
6. **手机与收起态还点得到吗**。手机档默认收起（`app.tsx:273` 的 `isNarrowViewport()`），要拉出抽屉才看得见这一行（`:486-496`、`views.css:2097-2118`）；56px 窄栏里的导航由壳硬编码、只有技能与插件两颗（`app.tsx:943-968`），插件的行在那里不出现。手机是否必须可达，决定要不要额外往 `shell.header` 报一颗钮。
7. **若最后改选模态浮层，桌面窗口里点得动吗**。现有豁免只给了从 header 槽渲染的浮层（`styles.css:2010-2028` 给 `.settings-mask` / `.palette-mask` 声明 `no-drag`），从侧栏槽渲染的 `position:fixed` 遮罩没有先例。Electron 的拖拽区命中判定在 CDP 合成事件里测不出来（同一段注释，`styles.css:2022-2025`），得真机点一次。
