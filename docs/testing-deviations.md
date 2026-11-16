# 测试体系：与设计文档不同的决定（台账）

> 这份台账只记**与 `testing-design.md` / `testing-detailed-design.md` 不一致的地方**。
> 一致的部分不重复。每条写清：设计原文说什么、实做是什么、为什么、影响面、当前状态。
>
> 状态含义：**已定** = 我认为理由充分、无需再议；**待定** = 需要你拍板。
>
> 同步回设计文档的条目不再重复记账——文档已经改成实做形态的，这里只留一行索引。

## 一、P0 地基与三条 POC

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | `vitest ^4.1` + `vite ^7` + `plugin-react ^5`（详设 §2） | 同左，但锁到具体解析版本 4.1.12 / 7.3.8 / 5.2.0；不跟 registry 上最新的 vitest 5.1 + vite 8 | plugin-react 6 对 vite 8 额外要求 `oxc-transform-react` 与 `@rolldown/plugin-babel` 两个原生依赖；vitest 4 与 DSH、codex 的配置写法可直接对照 | 已定 |
| D2 | 依赖清单里没有 `react-dom` | 根 `devDependencies` 补 `react-dom ^19.2.0` | 界面半 spec 一 import `@dsc/ui` 就经 `plugin-api.ts` → `ui-primitives` 桶 → `image-lightbox.tsx` 的 `createPortal`；根 `node_modules` 只有 `@types/react-dom`（pnpm 提升的），没有本体。版本由既有 `pnpm.overrides` 钉在 19.3.1 | 已定 |
| D3 | `tsconfig.spec.json` 的 `types: ["node", "vitest/globals"]`（详设 §5.2） | `types: ["node"]`，不用 globals，测试里显式 `import { test, expect } from 'vitest'` | 隐式全局让「这个文件用到了哪些测试 API」不可见；显式导入也能让 `tsc` 在缺导入时直接报错 | 已定 |
| D4 | 只有一份 `tsconfig.spec.json`（详设 §5.2） | 新增 `ui-shell/tsconfig.spec.json`，`typecheck:spec` 串两条 `tsc` | 界面半 spec 需要 DOM 库、`bundler` 解析、`@dsc/*` paths 与 `resolveJsonModule`，根那份是 node 环境（ES2023、NodeNext）。把 DOM 库塞进根配置更糟：内核测试跑在 node 环境，配上 DOM 等于允许它们写 `document`，写了真跑就是 `undefined`，类型检查反而给出假绿 | 已定 |
| D5 | `tsconfigPaths({ projects: ['./tsconfig.json'] })`（详设 §3.1） | 传两份：`['./tsconfig.json', './tsconfig.spec.json']` | 该插件按 `include`/`exclude` 过滤的是 **importer**。根 tsconfig 只 include `src`，于是 `tests/**` 里写裸 `@pneuma/<id>` 报 `Cannot find package`。设计里把这归因于「数组候选不支持」，是判断错了 | 已定 |
| D6 | unit 的 `exclude: ['src/packages/*/ui/**', '**/node_modules/**']`（详设 §3.2） | 补 `src/**/*.int.spec.ts` | `*.spec.ts` 的星号不跨目录但跨点，`session.int.spec.ts` 同样以 `.spec.ts` 结尾，会被 unit 层再跑一遍（5s 超时 + 线程池） | 已定 |
| D7 | snapshot 的 `exclude: []`（详设 §3.2） | 不写该字段 | Vitest 的 `exclude` 一旦写值就整体替换默认列表，写 `[]` 会把 `**/node_modules/**` 一起丢掉 | 已定 |
| D8 | POC-3 目标 `src/packages/ui-status-panel/ui/model.spec.ts`（概要 §11.2） | `src/packages/ui-status/ui/status-model.spec.ts` | 库里没有 `ui-status-panel` 这个包，实际包名是 `ui-status`，纯模型文件是 `ui/status-model.ts` | 已定（文档已订正） |
| D9 | 三条 POC 的顺序是插件 → 配置 → tsconfig → POC-1/2/3（详设 §16） | 中间插了一步「建 `tests/setup/temp-home.ts` 与 `dom.ts`」 | `vitest.config.ts` 的 `setupFiles` 指向这两个文件，缺了报 `Cannot find module` 而不是「测试失败」，且 integration/ui 层第一条用例就会撞上 | 已定（文档已订正） |

## 二、CI 接线

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D10 | 「把 `check:plugin` 接进 verify.yml 的 **PR 门禁**」（概要 §11 P1a 第 3 项） | PR 门只跑 `node scripts/package-tests.mjs`（119 条，72.7s，只需 `pnpm build`）；整串 `check:plugin` 挂到夜跑 `probe` job 末尾 | 整串里的 `plugin-inventory-check` 要读 `lib/ui/plugins/`（界面单元），那批产物得先 `pnpm -C ui-shell build`——把界面壳整个编一遍。为 119 条测试让每个 PR 等这个不划算。夜跑那边本来就为界面探针构建了界面壳，加这条不多花构建时间 | 待定（是否接受「PR 跑不全量插件门禁」） |
| D11 | `pnpm test:int` 排在夜跑 `probe` job（详设 §12.1） | 提前到 PR 门 `core` job | 15 条守的是线上事故（同一 callId 两条工具结果 → 网关 400），隔夜才发现太慢；它只解析 `src/**`、不依赖 `lib/`，本地 905ms。设计的排法是按「集成层会长到分钟级」预留的，等 P2 迁完存量探针再移回夜跑 | 待定（提前是否有必要） |
| D12 | 排版闸门扫描目录不含 `tests`（`scripts/style-check.mjs:40`） | 加上 `tests` | 不扫就是「测试体系新写的代码不受排版闸门管」，而闸门正是靠这份清单才看得见东西 | 已定 |

## 三、P1a harness（详设 §6 的七个 API，实装后加了 tempRepo 共八个）

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D14 | hash 不符时「抛错」（§6.3） | 409 响应 + `close()` 抛 `AggregateError`，两个出口都硬失败 | HTTP handler 里没地方把异常抛回 `await` 方；只在一个出口失败会让另一条路径静默绿 | 已定 |
| D15 | `dispose()` 卸载（§6.4） | `dsc/exit` 事件 + `registry.delete` 逐插件卸载 | cordis 4.1 的根 `Context` **没有** `dispose()`——现有探针里的 `ctx.dispose?.()` 实际是空操作。实测只发 `dsc/exit` 不卸载，进程 5 秒仍不退出 | 已定 |
| D16 | 未规定（§6.4） | `bootKernel` 默认关 memory 与 sandbox | memory 会在回合结束多发一次模型请求，吃掉假模型的下一轮剧本（`scripts/todo-reminder-test.mjs:32-37` 的先例），这条仍然成立。**sandbox 那条已失效**：2026-11-14 复测，预置 `plugins.json` 打开沙箱后起内核 6.7 秒、`sandbox` 服务在位、进程正常退出，没有挂住 worker。当初「挂住」多半与机器状态或旧版本有关。默认仍关（省时间），但**需要沙箱的用例可以放心打开** | 已定（口径已订正） |
| D17 | `RunCliResult` 只有 code/stdout/stderr（§6.6） | 加 `timedOut` | Windows 上被 kill 后是 `code=1, signal=null`，与正常退出 1 分不开 | 已定 |
| D18 | golden 归一化（§6.7 只说要归一） | 临时目录整段路径（含随机后缀）→ `<TMP>`；HOME 只换前缀；unified diff 自实现、40 行截断 | 随机后缀不整段换掉，golden 每次都不同 | 已定 |
| D19 | unit 层「禁止网络」（§7.1） | `fakeLLM` / `replayLLM` 的 unit 用例起 `127.0.0.1` 本地端点 | 假模型的协议（SSE 四段、标题请求判据）只能这么验；连的是 loopback，不出网。代价是 unit 层不再是「零网络」 | 待定（是否移到 integration 层） |
| D20 | `tsconfig.spec.json` 只收 spec 文件（§5.2） | include 加整棵 `src/**/*.ts` | cordis 的 `Context` 增强是声明合并，只列 spec 时程序里没有增强那一份，静态 import 内核会满屏「Context 上没有 agent / session」，而主构建全绿。实测 7.2s → 9.2s | 已定 |

## 四、P1b 包级测试迁移（119 条）

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D21 | 119 条全部迁完，用例只许多不许少 | 四个包各删了 1–2 条：`ui-layout` / `ui-runtime` / `ui-superagent` / `tui`，共删 5 条，其余全部保留或补强 | 删的都是「读 `.ts`/`.tsx` 源码找某个字符串」的写法断言（组件里用了哪个 hook、文件里有没有某行 import），它们已在 `scripts/ui-plugin-test.mjs` / `ui-locale-test.mjs` 里被逐文件 import 走查覆盖。留着等于同一件事测两遍，且第一遍测的是写法不是行为 | 已定 |
| D22 | 未规定 | `ui-superagent/ui/state.ts` 的四个纯函数（`stageGroupOf`、`formatAt`、`readSuperagent`、`sameSuperagent`）仍无测试 | 该文件顶层 `import '@dsc/ui'`，unit 层（node，无 `@dsc/*` 别名）装载不了；要测必须把纯逻辑从 `@dsc/ui` 依赖里拆出来，属于 `ui/**` 源码重构，不在迁移范围 | **待定**（要不要单开一次重构） |

## 五、P2 内核探针迁移（122 条）
| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D25 | 「测试 import 的一律是 `src/**`，不许 import `lib/`」（详设 §1、`vitest.config.ts` 文件头） | integration 层是**混合平面**：宿主来自 `src`，插件来自 `lib`。已加两道处置：`bootKernel` 启动前判 `lib` 是否比 `src` 旧（旧就抛错），`pnpm run test:int` 先 `pnpm run build` | `core/plugin-loader.ts:84` 的 `APP_INSTALL_DIR` 从 `src/core` 往上两级是仓库根，插件从 `<根>/lib/node_modules/@pneuma/*` 装配，由 Node 直接 import，绕开 Vite 的 `@pneuma/runtime → src` 别名。改了 src 不 build，内核跑旧 lib，用例照样绿。<br>**两处实证**：① `activeConfigFile` 有两份模块级缓存（src 一份、编进 lib 的一份），设置插件换完文件只清自己那份，测试从 src 读会一直拿到陈旧值；② `allSpecs()` 同样两份，lib 侧 `addExtraSpec` 写进去的 `/preset`、`/skills` 在 src 那份看不到。<br>**正确口径**：只读服务交出来的事实（`ctx.settings.prefs()`、`ctx.commands.specs()`、`ctx.llm.provider`），不要直接调 src 那个函数读全局缓存 | **待定**（要不要改成「integration 只跑 lib 平面」或「loader 在测试期解析到 src」） |
| D23 | integration 层「位置：与源码同目录 `<module>.int.spec.ts`」（§7.2） | 主体明确属于某个模块的，仍然同目录；**跨领域**或「整套内核装配之后才成立」的探针放 `tests/integration/<topic>.int.spec.ts` | 122 条内核探针里有相当一部分没有「被测模块」：它们起整套内核、跑几轮对话、看会话文件与请求体。硬塞进某个模块目录会让「这个目录的测试全归这个模块」这条约定失效 | 已定 |
| D30 | 未规定 | **工作树里禁止 `git commit --amend` 与 `git reset`**，补一点东西就新开提交 | 实测出过一次事故：一个代理 `--amend --only` 补自己的断言，把前一个代理刚提交的 docs 一起改写成了含它 spec 的提交（事后靠 `reset --soft` + 重建还原，内容逐字节一致，但那是运气）。多人共用一棵树时 `--amend` 改的是「HEAD 那个」，你无法确定是谁的 | 已定 |
| D24 | 探针迁完「从 `scripts/` 删掉对应 `.mjs`」（§11 P2） | 同左，但删除前提是「新 spec 覆盖了原探针的全部断言」；覆盖不齐时先补再删 | 删早了等于静默丢断言。已有先例：`session-dedupe-test.mjs` 在 POC-2 就已迁成 spec，探针却还在跑，属重复劳动 | 已定 |
| D26 | P2 把 122 条内核探针都归 integration（§11 P2） | 有两条判定**不该归 integration**：`session-picker-mouse-test.mjs` 主体是 ink 整屏渲染与鼠标序列（假 stdin/stdout 逐帧断言），归 ui/e2e；`session-title-live-test.mjs` 主体是 `examples/plugins/` 的示例插件，且两条断言必须观察回合进行中（integration 的 fakeLLM 没有慢响应接缝），归插件层。两条探针原样保留 | 硬迁只能靠 ANSI 帧与坐标，那不是这一层该干的事；标题插件与内置 `session-title` 抢同一个 `meta.autoTitle`，断言「哪个标题落地」会变成竞态 | **待定**（这两条何时迁、迁到哪层） |
| D28 | P2 迁完所有内核探针（§11 P2） | `plugin-hot-update-test.mjs` 与 `plugin-library-test.mjs` **永远留在 `scripts/`**，由裸 Node 跑 | 它们验的正是 Node 的 ESM 模块缓存语义：`remountExternalPlugin` 靠 `?t=mtime` 拿新实例。Vitest 的动态 import 走 Vite 模块管线，不吃这个缓存戳——实测写 v2 后仍读 v1，延迟 120ms 也无效。硬迁出来的测试要么恒绿要么恒红，那是假证据 | **已定**（P7 收尾时必须写明：这两层长期并存） |
| D29 | D24「覆盖不齐就不删探针」 | 删掉了 `plugin-model-test.mjs`：118 条里 117 条已迁（`row.experimental` 数据透传、`groupOf` 判档规则），剩 1 条「界面真的按它渲出实验档」没有行为接缝（ui-plugins 的包级 spec 只查清单、不渲染） | 为一条字符串让 117 条断言重复跑不值。缺口不消失，**转派给 P3**：在 ui project 里给 `ui-plugins` 的插件行加一条渲染断言，那时才算闭环 | 待定（P3 落地后才算闭环） |

## 六、协作方式（不是设计里的内容，是执行时的取舍）

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D13 | 设计假设「一个阶段一口气做完」 | 同一棵工作树里并行跑多个子代理，**代理只跑自己文件的定向验收**，全仓验收由我在阶段末统一跑 | 实测过一次误判：三个代理并行时，一个代理跑全仓 `vitest run --project unit`，看见另外两个代理在途的红（14 failed），归因错误。全仓验收在并行阶段没有意义，因为工作树状态每几分钟就变一次 | 已定 |

## 七、已知问题（不是偏离设计，是现场状况）

| # | 现象 | 判据 | 影响 |
| --- | --- | --- | --- |
| K1 | `check-core.mjs` 全量跑两遍都是 121/122 | 失败的是 `scripts/panel-prefs-test.mjs`，退出码 `0xC0000409`（进程崩溃，非断言失败）；单独跑 41/41 全绿。runner 自己在结尾也抛 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)` | 旧体系回归证据只能算「121 条确认通过 + 1 条环境崩溃」。不是本次改动引起（本次没碰 src 逻辑），但没有第二台机器对照 |
| K2 | `src/packages/superagent/tests/executor.test.mjs` 在 `check:plugin` 跑批时红过一次 | 断言「会话文件应在 start 之后落盘」；单独连跑三次全绿 | 既有时序不稳。它已随 119 条进 PR 门，会表现为偶发红。设计 P6 的 flake 治理有了第一个具体对象 |
| K3 | 并行代理共用一个 git index，早期提交卷入了别人的暂存文件 | `b716504d`（agent）里带了别人的 `skeleton.test.mjs` 删除；`05e0bb42`（tools）里带了六个包的纯重命名（0 内容改动） | 终点状态正确（文件最终都在该在的位置），只是这两个 commit 的边界不干净。原因是 `git add` 与 `git commit` 之间别人也 `add` 了。后续统一改用 `git commit --only -- <路径>`，不再发生。要不要改写这两个 commit 的历史，等全部阶段结束后再定 |
| K4 | integration 全量并行跑会超时 | 79 个文件同时跑时，`todo-reminder-cadence.int.spec.ts` 的 hook 超 60s、`transcript-order.int.spec.ts` 的 `runTurn` 超 30s；这三个文件单独跑 31 条全绿 | 每个文件都要起一次真内核，默认并行度（=CPU 核数）时同时起十几个内核，机器扛不住。**已修（2026-11-14，`2ea634c4`）：integration 限 `maxWorkers: 4`**——注意旋钮不是当初建议的 `poolOptions.forks.maxForks`（Vitest 4.1.12 运行时没人读它，写了照样 14 倍并行），用户面字段是 `maxWorkers`。限 4 后墙钟 119s（≈3.6 倍并行），K4 的超时文件不再复现。P6 分片时再复评 |
| K5 | 仓库根出现过 `Microsoft/Windows/PowerShell/ModuleAnalysisCache` | 某次 `HOME` 被指向仓库根时 PowerShell 落的缓存；删掉即可，不是 spec 写的 | 只要有人把 HOME 指到仓库根就会重现。`tempHome` 的前缀检查挡住了带分隔符的路径，但挡不住 `cwd` 被当 HOME 的用例 |
| D32 | 未规定 | `uiPluginsDir()` 按模块自身位置解析：从 lib 导入得 `lib/ui/plugins`（对），从 src 导入得 `src/ui/plugins`（永远空）。要测构建产物的 spec 必须显式拼 `lib/ui/plugins`，不能用缺省值 | A 组迁 ui-plugin-contract 时实测：产物审计类断言从 src 侧拿缺省路径必空，等于测了个空目录还可能假绿 | 已定（写进对应 spec 文件头；B31/B32 的产物层待拍板时同批处理） |
| D33 | P3 渲染批的派活白名单按「13 条探针」点名，未含 spec 落点的包 | R3b 的写权扩到 `ui-layout` / `ui-team` / `ui-statusbar` / `ui-trace`（再加原名单里的 `ui-sessions` / `ui-settings` / `ui-transcript` / `ui-primitives`）：spec 与它测的组件同包，渲染批没法只在一个包里写完 | 一个探针的渲染面天然分属组件所属包（如 `ui-turn-spacer` 的占位在 `ui-layout` 的 App，反向钉在 `ui-transcript` 的消息流）。扩权先由代理停手报告，再由我逐包放行；约束不变：只新增/修改 `*.spec.tsx`，产品源码零改动（R3b 反向验证后 `git diff` 已核） | 已定（后续渲染批按同一口径：批内白名单含 spec 落点的包） |
| D34 | 设计 §9：`vitest.bench.config.ts` + 预热 3 次 + 采样 9 次；B4 退化线 1.3×；B4 量「帧数/1000」比值 | ① 不走 vitest，直接 plain node 跑 `tests/bench/*.mjs`，`run.mjs` 起子进程；② 预热 0 次、采样 7 次；③ 四条统一 1.5×；④ B4 量耗时（ms）并把「通知次数必须为 2」当结构判据 | ①设计 §§9.4 自己写的就是 `run.mjs` 读基线，vitest 那行是 §2 表格的早期设想；②每条基准各起一个进程（内核有模块级状态，同进程连起两次不是支持路径），跨进程的「预热」只暖 OS 文件缓存，前 3 次照样要跑又不该被丢掉——7 次中位数已能吃掉单次抖动（实测 B1 样本 1464–2556ms，中位数稳定在 1.5–1.7s）；③任务约定统一 1.5×，B4 的合并窗口由代码常量决定、抖得比其它三条小，严格线没额外信息量；④TUI 合并器只暴露「窗口内合并成几次通知」，帧数在 React 层才可数，通知次数 2→1000 的塌缩比耗时更早暴露合并失效（源码 `snapshot-subscribe.ts:51` 的实现口径） | 已定（口径写进 `run.mjs`/`b4-stream-render.mjs` 文件头；重录基线时按 7 次中位数） |
| D35 | 设计 §9.2「基线绑机器；CI 上跑用 CI 自己的基线」 | `baseline.json` 加 `runner`（平台/核数/CPU 型号）；runner 不符时跑完全部基准、打印中位数、**不判退化**（退 0），`--enforce` 可强制比。CI 的 `bench` job 是独立 job（不并进 integration 分片，避免三倍负载与三份基线） | 共享 GitHub runner 的 CPU 代次不固定，拿本机基线硬比会「每台 runner 都红」；但结构判据（B4 通知次数、B1 服务面、B3 压缩产出）跨机器成立，仍照常闸。想恢复 CI 数值闸：从 Actions 日志取本次中位数、人工审一次后按同格式提交 | 已定（verify.yml 的 bench job 注释写明恢复路径；本机基线 runner=`win32-x64/32c/AMD Ryzen 9 7945HX…`） |
| D36 | 设计 §11.2 的八条 CLI 用例：C4「未知子命令非 0」、C5「配置损坏非 0」、C6「管道不卡死」、C3「无参数 + 输入」按原文可实现 | ① C4/C6 先修产品再钉（F15/F16，`bin/dsc.js` 两处），测试钉修好后的行为；② C5 改为「不崩不挂 + 伤害可见」：坏配置下 TUI 正常收场（exit 0），`config show` 退出 1 并报「无——检查配置与 key 来源」；③ C3 明确 `test.skip` 并登记 B42（管道 stdin 模拟不了 TUI 按键，需 node-pty） | ① C4/C6 是设计要求的判据与产品现状直接冲突，且两处都是「报错报不出来」的小洞，补在启动器比在测试里绕开便宜；② 产品对 config.yaml 是**刻意宽容**（`parseTolerantYaml` + `toProvider` 跳过非法项，迁移/手改场景都靠它），把它改成报错会动到用户的既有配置路径；退出 1 只在「有端点但全不可用」时出现，所以 C5 钉「不静默吞掉」的实际可观测面；③ 无 PTY 就没有按键通道，条件跳过会制造「配了 key 就覆盖了」的错觉 | 已定（C4/C6 反向验证各一次：改回旧行为 → 红，还原 → 绿） |
| K6 | live 层从未对真模型执行过（开发机无 `DSC_LIVE_API_KEY`） | 只验证了两条：无 key 时 5 条整层跳过（exit 0）、`typecheck:spec` 覆盖新文件；`test-live.yml` 的 key 预检与非零用例断言未在 Actions 上跑过 | 首次夜间跑会暴露真实问题（模型名、端点路径、压缩服务的真实行为）。在 CI 绿过一轮之前，live 层只能算「已实装、未实证」 |
| K2+ | superagent 的 git 工作树族 spec 在全量并行下偶发红（2026-11-14 实测：executor/notify/worktree 三条单跑 18/18 绿） | 全量并行时 git 操作（tempRepo/worktree 生命周期）互相拖慢，超时即红 | **已治（2026-11-16）**：`superagent/tests/{worktree,executor,notify}` 三份改 `*.int.spec.ts`——它们本来就 spawn 真 git（建仓 / 工作树 / 提交），归 integration 层（forks + 60s + retry 1），断言零改动。unit 的 retry 保持 0（设计 §3.2）。后续再遇「真进程 + 短超时」的红，同一条处置：先看层次归属，再谈 retry |
