# 测试体系：迁移留下的缺口清单

> 迁移时判定「这条断言在这层没有行为接缝」的，全部记在这里，一条不漏。
> 每条写清：原来钉什么、为什么迁不动、该补在哪一层。
>
> **这张表是 P3/P7 的工作清单**。它存在的原因很具体：判「不该归这一层」很容易，
> 判完之后缺口就散落进各个代理的报告里，再也没人捡。写进台账（deviations）的是「决定」，
> 写进这里的是「欠账」——两件事。

## 一、转给 P3（ui / tui 层）

| # | 来源 | 原来钉什么 | 为什么迁不动 | 该补在哪 |
| --- | --- | --- | --- | --- |
| B1 | D26 / `session-picker-mouse` | ink 整屏 39 行帧、滚轮与 PgUp 回看、DECSET 鼠标模式、选择器两级导航、审批卡与提问卡点击 | 靠假 stdin/stdout 逐帧断言，integration 禁止真桌面 | **已迁（2026-11-16）**：`tui/app/session-picker-mouse.spec.ts` 14 条（假终端 + SGR 鼠标序列 + 整屏帧），反向验证 1 条；探针已删 |
| B2 | D26 / `session-title-live` | 示例插件起标题；「只有用户消息时不请求」「消息没变不重复请求」 | 必须观察**回合进行中**，`fakeLLM` 没有慢响应接缝；且与内置 `session-title` 抢 `meta.autoTitle` | **已迁（2026-11-16）**：`session-title/session-title-live.int.spec.ts` 1 条（覆盖原 6 段检查点，`fakeLLM` 按请求序号应答），反向验证 1 条；探针已删 |
| B3 | D29 / `plugin-model` | 界面按 `row.experimental === true` 渲出「实验」档与分组标题 | ui-plugins 的包级 spec 只查清单、不渲染 | ui project，给插件列表行加渲染断言 |
| B4 | P2-G / `teammate-notice` | 壳的收件箱角标 = `queued + notices` 相加 | 源码文本；等价行为要在真渲染里数角标 | ui project（输入框下方队列条） |
| B5 | P2-G / `teammate-notice` | 终端状态栏条数表达式同上 | 源码文本 | `tui` project 帧断言 |
| B6 | P2-C / `injection-card-tip` | `ui-transcript` 的 tsx 源码 + 中英字典断言 | 主体是界面呈现；真机 DOM 那一半本来就在 `desktop/shots/_verify-prompt-cards.mjs` | **部分迁（2026-11-16）**：`ui-transcript/ui/injection-card-tip.spec.tsx` 3 条（收起/展开 title 行为）；残留＝字典资源审计（中英键与英文文案）、源码身份钉（title 长在 `.entry-injection-head` 上且真的走 `t()`）、真机 DOM 半仍在 shots。探针保留 |
| B7 | P2-D / `settings-embed-slot` | ui-settings 与 tools-default 的 11 条源码文本（槽位接线、组件挂载） | 源码文本 | **部分迁（2026-11-16）**：`ui-settings/ui/embed-slot.spec.tsx` 5 条（嵌槽渲染 + 子分区写回）；残留＝宿主侧声明（terminal-env 注册/字段序）、真终端探测的「当前：…」、字典一一对应审计。探针保留 |

## 二、转给 P7（收尾期决定）
| # | 来源 | 原来钉什么 | 为什么迁不动 | 备注 |
| --- | --- | --- | --- | --- |
| B8 | P1a / `terminal-env` | 探测与缓存族 8 个导出（`detectShells`、`shellsCached`、`readShellChoice`、`resolveShellExecutable` 等） | 要么 spawn 子进程、要么读写模块级单例 | 已在 integration 层部分覆盖；剩余靠 `tempHome` + 注入 |
| B9 | P1a / `shellOf` | POSIX 分支 | 开发机是 Windows | CI 的 ubuntu job 天然覆盖 |
| B10 | P2-B / `open-in` | 21 条源码文本：模型终端起进程目录、MCP `fallbackCwd`、审批 `baseCwd`、LSP `baseCwd`、壳的 `newSessionIn` 调用点 | 每条都要真起 shell / MCP / LSP 才观察得到 | 默认「留在 `check-core`」，除非 P7 判定值得另开行为电池 |
| B11 | P2-E / `sandbox-parity` | 24 条源码文本：ASKABLE_RULES 内容、审批里沙箱 check 的先后、替换式骨架过滤器、持久 shell 的 presets | 需要真审批 + 真沙箱才观察得到 | 同上 |
| B12 | P2-F / 待回收 | 见 P2-F 报告 | — | **已补齐（2026-11-14，P2 收尾判定）**：`tui-compacting`、`tui-features`、`tui-subagent-live`、`tui-transcript-scroll`、`tui-transcript-style` 五条是整屏帧 / 真 App 链路，归 P3 批 8（tui project）；`injection-card-tip` 归 P3（ui，B6 已记）；`settings`（42 条帧）、`session-picker-mouse`、`session-title-live` 同前（B1/B2/B13）；P2 收口时 check-core 应剩 17 条：readme、release-notes（P7）+ plugin-hot-update、plugin-library、session-permissions（永远留 Node）+ 上述 12 条（P3） |
| B13 | P2-I / `update-check` | 19 条桌面侧断言：主进程登记两个原生操作、上电排期、退出停定时器、下载地址只挑自己资产、装完启动安装程序 | 全在 `desktop/electron/main/`，进程内没有接缝，只能读源码文本。迁进 unit 时按「源码文本一律不搬」删了 | **未做（P7 判定不做）**：桌面主进程测试通道需要真 Electron 主进程 harness（shutdown/排期/安装器都不可 mock），收益低于维护成本；同批的 `settings-test` 42 帧已迁（`tui/app/settings.spec.ts` 15 条覆盖约 61 check 点），更新检查的行为面由 `ui-layout/ui/update-button.spec.tsx` 承接 |
| B14 | P2-I / `skills-roots` | 界面：两类全局技能各有标签、三个作用域筛选项、按发现根分组、行内不再打来源徽章 | 要渲染技能页，not in-process | ui project（技能页渲染断言） |
| B15 | P2-I / `readme` `release-notes` | README 的块形态/相对路径/锚点/数字口径；发版脚本的纯函数 | 被测对象是文档与 `scripts/*.mjs`，不是 `src/**` 产品代码 | 留 `scripts/`，P7 决定是否并进文档闸门（`check:style` 那类） |
| B16 | P2-F / `permission-presets` | 6 条界面渲染断言：settings 与 ui-plugins 的 `derived` 出口、未识别值的兜底展示 | 要渲染设置页与插件页，集成层没有接缝 | ui project |
| B17 | P2-F / `runtime-api` | 2 条代码形状断言：「纯函数零运行时依赖」「不在闭包里各写一份」 | 属实现写法，没有可观察行为；行为面已由真调 `runtime_api` 覆盖 | 不补（记录在案即可） |
| B18 | P2-H / `boot-notices` | 「首次有『沙箱已就绪』提示、第二次抑制」 | 当时 harness 默认关沙箱，这趟根本不产生沙箱提示。**已复测：开沙箱能正常跑（6.7s，服务在位）**，所以这条可补 | ✅ 已补（2026-11-14，`7207c164`）：`src/core/boot-notices.int.spec.ts` describe③，预置 plugins.json 开沙箱起两次内核；反向验证过 |
| B19 | P2-H / `empty-session` | 「选 read-only 后 `permissions.sandbox === 'read-only'`」 | 同上，沙箱停用时预设的沙箱半部落不了地 | ✅ 已补（同 commit）：`empty-session.int.spec.ts` describe④ 末条，重放也钉了；反向验证过 |
| B20 | P2-H / `compacting-status` | 壳按 `compactingSince` 画状态行（`ui.tsx` 源码正则） | 要渲组件 | ui project |
| B21 | P2-Q / `dock-browser` 第 1、3 节 | 桌面主进程：五道闸门齐/有序/fail-closed、`guests.set` 唯一入账口、`sendWithTimeout` 超时文案、hello 版本比对、诊断行 | 全在 `desktop/electron/main/`，宿主侧的测试只能读源码文本 | 桌面主进程测试通道。与 B13 是**同一条欠账**，P7 一起收 |
| B22 | P2-Q / `dock-browser` 第 7、8、9 节 | 壳侧：`ui.tsx` 事件名与锚点、`dock-state.ts` 形参顺序、settle 帧数与 `cancelAnimationFrame` | 要渲染壳组件 | ui project |
| B23 | P2-Q / `dock-browser` 第 9③ 与 `OPEN_SETTLE_MS` | 常量数值本身 | 上限已有**行为**断言（open 在 250ms~5s 内落地），常量没有独立行为 | 不补（与 B17 同类） |
| B24 | P2 尾批 / `ops` | CI 机器上没有 dsh-ops worker 时，`ops-worker.int.spec.ts` 整段 skip——**这一层在无 worker 的 CI 上不设防** | 假 worker 等于测自己的实现（修订锚、diff、表格解析全要仿），比明确 skip 更假；探针语义本来就是「没装就跳过」 | P6 接 CI 时拍板：要么 CI 装 dsh-ops（需要凭据与平台二进制），要么接受这层只在开发机设防。skip 已写明原因（`9d60dc11`），不静默绿 |
| B25 | P2 尾批 / F13 | `win-token.int.spec.ts` 的 ConPTY Ctrl+C 段（0x03 经 conin 中断子进程） | 当前环境 3/3 稳定红且单跑也红，老探针同红，产品代码未动——环境漂移还是真实回归未判定 | 已 test.skip（`f6042d7e`）。换机或重启后复跑 `-t ConPTY`：绿则撤 skip，红则按 F13 走产品排查 |
| B26 | P3-B / `ui-process-grid` [1]–[6][7b][8] | 栅格对齐的 CSS 像素级断言（三类行左缘同线、缩进档位） | 纯 CSS 文本钉没有运行期接缝；像素级版面该用截图探针 | 转 `desktop/shots` 截图探针（渲染批后或 P7）。探针已删（行为半在 `tool-summary.spec.ts`） |
| B27 | P3-B / `ui-think-markdown` [3]–[5] | 思考展开区 markdown 排版的 CSS 文本钉 | 同上 | 渲染批（`@testing-library/react`）落地后改真渲染断言，或销账 |
| B28 | P3-B / fs-tools 漂移钉 | `ui-transcript-render [4]`：fs-tools 的 import 链与 `MUTATION_CONTENT_FIELDS` 表的漂移 | fs-tools import 链重（node:fs、path-policy、sandbox-args）在 ui 层拉不动；表本体已迁（`tool-args.spec.ts`） | 待拍板：要不要在内核层补 `fs-tools.spec.ts`（P3-B 白名单不含 src/core，未做） |
| B29 | P3-D / `ui-locale` 整条 | 无硬编码中文 + 字典键集对账 + `t()` 键存在 | 被测对象就是源码文本，AST 扫描闸没有行为等价物（手册 §2 的 A–E 全不适用） | 建议**留 check-ui 长期跑**；若要进 P7，标成「文档闸/发布闸」而非测试。探针保留 |
| B30 | P3-D / `ui-legacy-compat` [1][3][4] | 全仓禁用新 API 扫描、inset 兜底与产物门、窄屏 CSS | 源码闸与样式钉，同 B29 | 同上，留 check-ui。探针保留 |
| B31 | P3-D / `ui-plugin-disable` [3][6] | 审计 `lib/ui/plugins/*/client.js` 构建产物（停用后不留残骸） | vitest 主配置明令测试只解析 src；产物语义 vitest 管不了（D28 同类） | 待拍板：比照 D28 长期留 scripts/，或给 ui-shell 产物单开「构建产物层」project。探针保留 |

## 三、永远留在 Node 侧（不是欠账，是设计）

| 探针 | 为什么不能进 Vitest | 谁跑它 |
| --- | --- | --- |
| `plugin-hot-update-test.mjs` | 验的是 Node 的 ESM 模块缓存语义：`?t=mtime` 换新实例。Vitest 走 Vite 管线，不吃这个缓存戳（实测写 v2 仍读 v1） | `check-core`（裸 Node） |
| `plugin-library-test.mjs` 1–4/6 段 | 同上 | 同上 |
| `settings-test.mjs` | ink 整屏帧 + 假 stdin/stdout，42 条 | 归 `tui` project（B13，P3） |
| `session-permissions-test.mjs` | 剩下 11 条无接缝的源码文本 | `check-core` |

> **P7 收尾时必须写明这条**：`check-core` 不再等于「遗留债务」，它是**专门跑那些
> Vitest 表达不了的探针**的通道。把这句话写进脚本头部注释，否则下一个人会以为
> 这些探针是没迁完的活。

## 四、怎么用这张表

- 补上一条，就把那一行划掉并注明 commit。
- 新发现的缺口追加到对应小节，不要只写在对话里。
- 每次 P 阶段收尾，先看这张表还剩几行——它比任何进度百分比都准。
| B32 | P3-A / `ui-sdk-types` 整条 | 界面 SDK 类型产物契约：`lib/ui/sdk/@dsc/<包>/` 的 .d.ts 树 + 真 tsc 编译 examples demo | 钉的全是构建产物契约，src 平面没有行为接缝；vitest 只解析 src | 待拍板：留 `check:ui`（探针自带壳未构建 SKIP 兜底，探针保留）或给 ui-shell 产物单开独立 project。与 B31 是同一条欠账 |
| B33 | P3-B / `ui-transcript-render` [3]–[6][8b]–[13] 等渲染接线钉 | seatPlan 消费点、直播折叠初值、diff/参数表分流、逐行动画、hover 常量、轮尾卡时机、流式光标、贴图浮层 | 要真渲染 React 组件 | 组件渲染批（`@testing-library/react` 装好后）；hover 的 500/1000ms 常量可按手册 §2 E 提成具名导出（须单独提交） |
| B34 | P3-B / `ui-row-isolation`[4]、`ui-row-memo`[1]、`ui-step-group-live`[5][7]、`ui-fold-combo`[3]、`ui-paging`[7]、`ui-fold-prefs`[5][6]、`ui-compaction-row`[1]–[3][5]、`ui-tool-row-flat`[1]–[6]、`ui-think-markdown`[1][2] | 渲染体/props 稳定性/JSX 结构/CSS 文本钉 | 同上 | 组件渲染批 |
| B35 | P3-C / `ui-tool-views`[4][5]、`ui-tool-web`[4]、`ui-model-picker`[8]–[10]、`ui-models-page` 整条、`ui-model-caps`[2]–[5]、`ui-git-branch`[2][4]、`ui-composer-draft`[5]、`ui-attach-preview`[1][3]–[5]、`ui-tool-read-image`[3] | 版式/接线/样式/渲染体文本钉 | 同上 | 组件渲染批；models.tsx 的 validateDraft、bash-view 的 exitViewOf 是方案 E 候选（动产品代码须单独提交） |
| B36 | P3-E1 / `ui-anchored`[3]、`ui-browser-address`[3]、`ui-bytes`[1][3]、`ui-color-fallback`[6][7 部分]、`ui-edit-generation`[1]–[4]、`ui-edit-in-place`[3][5]、`ui-file-icon`[3 部分][4]、`ui-jump-rail`[4]、`ui-ask-selection-slot`[1]–[5]、`ui-phone-command`[5]、`ui-pin-icon` 整条、`ui-node-slot` 主体 | 渲染接线/CSS/SVG 几何/产物层 | 同上；ui-pin-icon 与 node-slot 主体是纯渲染/编译期钉 | 组件渲染批；产物层归 B31/B32 |
| B37 | P3-E2 / `ui-prompt-cards`[1]–[5][7]、`ui-review-findings` 样式段、`ui-review-notice`[5]–[7]、`ui-sessions-unsaved-row`[3]–[5]、`ui-sidebar-footer`[2][4]、`ui-subagent-page`[1]–[4][5]、`ui-turn-spacer` 整条、`ui-turn-status`[2]–[5]、`ui-update-button` 整条、`ui-usage-layout`[1][2][4]、`ui-welcome-greeting`[1][3]、`ui-round-foot-hover` 整条、`ui-settings-nav` 整条 | 组件接线/样式/滚动几何/产物审计 | 同上；turn-spacer 滚动几何与 usage-layout CSS 算术建议转 shots 截图探针 | **已迁（2026-11-16，R3b）**：15 个文件 97 条（新增 87），行为段全部落地并逐条反向验证。**零探针可整删**——13 条各自还剩 CSS 文本 / 宿主源码字面量 / 产物审计段，jsdom 与渲染层够不到；最接近的两条是 `ui-review-findings`（仅剩 4 条徽标色选择器）与 `ui-welcome-greeting`（仅剩 `text-wrap: balance`），CSS 转 shots 后即可删 |
| B38 | P3-tui / 三条前提注记 | `chat-style.spec.ts` 依赖 forks 池每文件独立进程 + isolate（FORCE_COLOR 与假 ctx 不泄漏的前提）；`subagent-live` 单文件 20-30s 偏重、落 tui 层是否挪 integration 归 P6 分片时定 | 设计使然，不是缺口 | P6 改 pool/isolate 前必读 chat-style 文件头；P6 分片时复核 subagent-live 落层 |
| B39 | P3-R1 / 六条探针的残留 CSS 与扫描钉 | paging 的 viewport 几何两条、fold-combo 的 ui.tsx effect 钉、fold-prefs 的 toolDefaultOpen 字段映射、compaction-row [3][5] 与 tool-row-flat [1][2][5][6]、think-markdown [3]–[5] 的 CSS | jsdom 不做布局不吃样式表；扫描钉无行为等价物 | 删探针时记录于此；处置同 B26（转 shots）或 B29（check-ui 长期跑）。六条探针已删（2026-11-14，行为段全闭环） |
| B40 | P3-e2e / `ui-anchor-e2e`×5、`ui-plugin-disable-e2e`×1 | 六条真机断言与产品现状脱节（DRIVER 找不到 `.select-trigger`；「Super Agent」页签内容对不上） | 产品 UI 改版后探针断言没跟；e2e 迁移版与原探针同环境逐条同红（同红对照已核） | **已修（2026-11-16，`779498b7`）**：驱动先等 `.settings-nav-item` 出现再逐页点（最多 10s），诊断值从 `executeJavaScript` 返回值带出（页面里没有主进程的 `out`）；`ui-plugin-disable` 的最终侧栏断言补上本用例未停用的 ui-superagent 入口。两文件合跑 **53/53**；全量 e2e **8 文件 / 161 通过 + 1 skip / exit 0** |
| B41 | P4 / TUI 帧快照 | ① `DiffBlock` 行数 bug（F14，改产品后重生成 golden）；② 建议清单里四个面 TUI 不存在（组头/read 卡/web 卡/编辑中提示属 ui-renderer/桌面层），已换真实存在面；③ 30 场景收在一个 frames.snapshot.ts（共享 tempHome/模块）而非一场景一文件 | 产品/组织取舍 | B41-①：修 F14 时同批 `UPDATE_GOLDEN=1 npx vitest run --project snapshot tests/snapshots/tui`；B41-②：产品补面后再加 4 条；B41-③：要拆文件则重跑生成 |
| B42 | P6 / CLI C3「无参数 + 一句输入」 | 需要往 TUI 里敲字并回车：管道 stdin 不是 PTY，ink 的 useInput 拿不到按键；`node-pty` 未进依赖 | 缺件 | 加 `node-pty`（要编原生模块，Windows/CI 都要验）后补 C3；或给 CLI 加 `-p/--print` 非交互模式（产品改动，须单独拍板） |
| B37-R | R3b 迁移后 13 条探针的残留段 | ① CSS 文本/几何：review-findings 四档徽标色、review-notice [6] 块、turn-spacer [4]、turn-status [3][5]、round-foot-hover [1][2][4] 的 opacity/选择器/减少动效、usage-layout [2] 环形图与媒体查询、welcome `text-wrap: balance`、update-button [7] `no-drag`；② 宿主源码字面量漂移：review-notice [5]；③ 产物审计：update-button [6]、subagent-page [5]；④ 宿主侧契约/白名单：sessions-unsaved-row [1][2]、sidebar-footer [3][4] | jsdom 不应用样式表、不布局；产物与宿主文本不在渲染层 | ①按 B26 转 shots（`desktop/shots/*.mjs`）或在 check-ui 长期保留；②提成宿主具名导出后转契约测试（方案 E，须单独提交）；③归 B31/B32 产物层；④已由宿主/集成层覆盖，随残留①处置后整条删除 |
| B43 | P4 / 浏览器 DOM 快照 | 10 个高频面已落为 golden：欢迎页、会话列表、消息流（思考+工具卡）、设置-模型、设置-用量、插件中心、命令面板、子代理只读页、dock 开始页、窄屏布局；驱动为 `tests/snapshots/browser/drivers/dom-shot.cjs`（真 Electron + `--remote-debugging-port`），产物只写临时目录，两遍逐字节一致、反向验证 3 条（种子/插件产物/设置产物各一）。残留：① 设置-模型只覆盖浏览器只读态（增删端点、填 key 走原生桥，属桌面 e2e）；② 子代理页用种子名册 + 已完成队友日志，未覆盖「在跑」的轮询/流式时序；③ dock 只钉 guide 页，文件/终端/浏览器页签依赖真实原生视图；④ 10 场景收在一个 `dom.snapshot.ts`（共享驱动与种子工具），与 B41-③ 同口径。 | 真机渲染面 / 产品入口与原生视图限制 | 需要时按场景追加：模型写操作走桌面 e2e，运行中队友需 fake LLM + 轮询时序（参考 `desktop/shots/_batch8-fake-llm.mjs`），原生页签走 `tests/e2e/support/host.ts` 的 Electron 通道 |

## 五、2026-11-16 审计新发现（对比详细设计 / DSH / codex）

> 判定口径：**「绿了但没跑」算缺陷，不算完成**。每条都带实跑证据。

| # | 位置 | 现象 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| B44 | `pnpm test` | 全量并行时 `src/packages/runtime/collapse-prefs.spec.ts` 的 `beforeAll` 超 5s 钩子线，1 个 Failed Suite + 12 条连带 skip；单跑 871ms | 2026-11-16 实跑：`1 failed / 294 passed`；修后 `295 文件 / 3251 条全过` | **已修（`b4339f1f`）**：该钩子给 20s 模块装载预算，断言未动 |
| B45 | `tests/snapshots/session/basic-turn/` | 目录里没有 `session.jsonl`，4 条用例**整段 skip**；「会话回放 1 场景」实际从未回放 | 实跑 `vitest run --project snapshot tests/snapshots/session`：`1 skipped / 4 skipped` | 录一份真会话入库（需 key、产物要人审）；CI 强制 `DSC_SNAPSHOT=replay`；再补 tool-call / compact 场景 |
| B46 | `.github/workflows/verify.yml` | CI **完全不跑** `test:e2e`、`test:snapshot`、`test:coverage`。e2e 162 条、浏览器快照 10 份、覆盖率门只在本机存在 | `grep` 全文件只有 `pnpm test` / `test:int` / `test:bench` / `test:cli` | **已修（2026-11-16）**：新增 `snapshot` / `e2e` / `coverage` 三个夜跑 job（build + 界面壳 + xvfb + JUnit），PR 门保持轻 |
| B47 | `coverage-baseline.json` ↔ 三面跑法 | 同一文件混了两套口径：全局 33.77 能由三面复现（33.82），但 `src/core` 记 41.18、三面只有 34.2，四项阈值全红 | 实跑：lines 34.2 < 40.68 / branches 28.43 < 34.56 / functions 33.81 < 42.42 / statements 32.59 < 39.02 | **已修（2026-11-16）**：`test:coverage` 显式全五 project（D40）；全五实测 lines 45.56 / branches 37.07 / functions 41.81 / statements 43.52、core lines 68.07，基线按实测重录 |
| B48 | `scripts/check-ui.mjs` 42 条 + B37-R 13 条残留 | CSS / 源码文本 / 产物审计仍靠字符串匹配；没有真 Chromium computed-style 层。DSH 用真 Chromium web snapshot，codex 用 insta | `check-ui` 清单：`ui-*-test.mjs` 50 个文件里 42 条在跑 | CSS 段转 `tests/snapshots/browser` 的 computed-style 断言；产物段归 B49；源码身份钉留 check-ui 并写长期理由 |
| B49 | 产物层（B31/B32） | 没有 DSH 式 `.built.e2e.ts`：插件 `lib/ui/plugins/*/client.js` 审计、界面 SDK `.d.ts` 树 + examples 真 `tsc` 仍只在 `check-ui` | `vitest` 主配置只解析 `src`；check-ui 探针自带「壳未构建则 SKIP」 | **已建（2026-11-16，`9cfa2339`）**：`tests/built/{plugin-client,ui-sdk}.built.e2e.ts` + `vitest.built.config.ts` + `test:built`；反向验证：删 `@dsc/ui/index.d.ts` 红 3 条、删 `ask/client.js` 红闭环，恢复后 7/7 |
| B50 | `tests/cli/entry.cli.e2e.ts` C3 | 无参数 + 一句输入仍是显式 `test.skip`（B42），8 条 CLI 实际只有 7 条在跑 | `grep test.skip` | **已实装（2026-11-16，`d85e7874`）**：`tests/cli/pty-driver.py`（`pty.fork` + 步骤脚本），C3 用 `fakeLLM` 跑；Windows 显式 skip。POSIX 侧首次实跑待 CI |
| B51 | `verify.yml` 聚合门 | `all-checks-passed.needs` 不含 `probe`（夜跑 8 分钟那道）；夜跑红了聚合门仍绿 | `verify.yml:182` | **已定（2026-11-16）**：夜跑四个 job（probe/snapshot/e2e/coverage）**不纳入** needs——PR 上它们是 skipped，纳入会把每个 PR 判红；理由写进 `all-checks-passed` 注释 |
| B52 | live / bench / Windows | live 从未对真模型执行（K6）；bench 数值闸在 runner 不符时只记录（D35）；Windows 车道只有 unit/ui/tui，无 integration/e2e | 交接 §5、`verify.yml` windows job | 首次 Actions 跑取证；评估 Windows integration 子集（对齐 DSH `ci-windows-blocking`） |
| B53 | 文档漂移 | 详细设计头部仍写「尚未实施」；§1.1 列 `vitest.bench.config.ts`（实际 plain node）；§3.2 写四个 project（实际五个）；§8 写 `support/scenario.ts` 与 4 个场景（实际 `recorder.ts` + 1 个且 skip）；§10.1 的 `test` 含 snapshot（实际 unit/ui/tui） | 文档对照 | 随 W1 开工同批订正，避免下一个人按旧图施工 |

## 六、下一阶段（非覆盖率优先）

1. **B44/B40 已闭环**；`pnpm test` 295/3251、全量 e2e 8 文件 / 161+1 skip / exit 0。
2. 先做 B46 CI 接线、B45 会话录制、B50 C3、B49 产物层、B48 CSS→Chromium、B53 文档订正。
3. 再启动 [testing-coverage-plan.md](testing-coverage-plan.md) 的 W1–W6，目标整体 lines ≥ 90%。

