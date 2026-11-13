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
| B1 | D26 / `session-picker-mouse` | ink 整屏 39 行帧、滚轮与 PgUp 回看、DECSET 鼠标模式、选择器两级导航、审批卡与提问卡点击 | 靠假 stdin/stdout 逐帧断言，integration 禁止真桌面 | `tui` project（node 环境 + 假终端），或 e2e |
| B2 | D26 / `session-title-live` | 示例插件起标题；「只有用户消息时不请求」「消息没变不重复请求」 | 必须观察**回合进行中**，`fakeLLM` 没有慢响应接缝；且与内置 `session-title` 抢 `meta.autoTitle` | 插件层（`tests/plugins/`），要先给 fakeLLM 加「按内容延迟应答」 |
| B3 | D29 / `plugin-model` | 界面按 `row.experimental === true` 渲出「实验」档与分组标题 | ui-plugins 的包级 spec 只查清单、不渲染 | ui project，给插件列表行加渲染断言 |
| B4 | P2-G / `teammate-notice` | 壳的收件箱角标 = `queued + notices` 相加 | 源码文本；等价行为要在真渲染里数角标 | ui project（输入框下方队列条） |
| B5 | P2-G / `teammate-notice` | 终端状态栏条数表达式同上 | 源码文本 | `tui` project 帧断言 |
| B6 | P2-C / `injection-card-tip` | `ui-transcript` 的 tsx 源码 + 中英字典断言 | 主体是界面呈现；真机 DOM 那一半本来就在 `desktop/shots/_verify-prompt-cards.mjs` | ui project，或并入那条 shots |
| B7 | P2-D / `settings-embed-slot` | ui-settings 与 tools-default 的 11 条源码文本（槽位接线、组件挂载） | 源码文本 | ui project（嵌槽渲染断言） |

## 二、转给 P7（收尾期决定）
| # | 来源 | 原来钉什么 | 为什么迁不动 | 备注 |
| --- | --- | --- | --- | --- |
| B8 | P1a / `terminal-env` | 探测与缓存族 8 个导出（`detectShells`、`shellsCached`、`readShellChoice`、`resolveShellExecutable` 等） | 要么 spawn 子进程、要么读写模块级单例 | 已在 integration 层部分覆盖；剩余靠 `tempHome` + 注入 |
| B9 | P1a / `shellOf` | POSIX 分支 | 开发机是 Windows | CI 的 ubuntu job 天然覆盖 |
| B10 | P2-B / `open-in` | 21 条源码文本：模型终端起进程目录、MCP `fallbackCwd`、审批 `baseCwd`、LSP `baseCwd`、壳的 `newSessionIn` 调用点 | 每条都要真起 shell / MCP / LSP 才观察得到 | 默认「留在 `check-core`」，除非 P7 判定值得另开行为电池 |
| B11 | P2-E / `sandbox-parity` | 24 条源码文本：ASKABLE_RULES 内容、审批里沙箱 check 的先后、替换式骨架过滤器、持久 shell 的 presets | 需要真审批 + 真沙箱才观察得到 | 同上 |
| B12 | P2-F / 待回收 | 见 P2-F 报告 | — | 本表在 P2 全部收尾时补齐 |
| B13 | P2-I / `update-check` | 19 条桌面侧断言：主进程登记两个原生操作、上电排期、退出停定时器、下载地址只挑自己资产、装完启动安装程序 | 全在 `desktop/electron/main/`，进程内没有接缝，只能读源码文本。迁进 unit 时按「源码文本一律不搬」删了 | 要补得先有桌面主进程的测试通道（`desktop/` 目前只有 typecheck + shots）。P7 决定要不要做 |
| B14 | P2-I / `skills-roots` | 界面：两类全局技能各有标签、三个作用域筛选项、按发现根分组、行内不再打来源徽章 | 要渲染技能页，not in-process | ui project（技能页渲染断言） |
| B15 | P2-I / `readme` `release-notes` | README 的块形态/相对路径/锚点/数字口径；发版脚本的纯函数 | 被测对象是文档与 `scripts/*.mjs`，不是 `src/**` 产品代码 | 留 `scripts/`，P7 决定是否并进文档闸门（`check:style` 那类） |
| B16 | P2-F / `permission-presets` | 6 条界面渲染断言：settings 与 ui-plugins 的 `derived` 出口、未识别值的兜底展示 | 要渲染设置页与插件页，集成层没有接缝 | ui project |
| B17 | P2-F / `runtime-api` | 2 条代码形状断言：「纯函数零运行时依赖」「不在闭包里各写一份」 | 属实现写法，没有可观察行为；行为面已由真调 `runtime_api` 覆盖 | 不补（记录在案即可） |
| B18 | P2-H / `boot-notices` | 「首次有『沙箱已就绪』提示、第二次抑制」 | 当时 harness 默认关沙箱，这趟根本不产生沙箱提示。**已复测：开沙箱能正常跑（6.7s，服务在位）**，所以这条可补 | 补进 `src/core/boot-notices.int.spec.ts`，预置 `plugins.json` 打开沙箱 |
| B19 | P2-H / `empty-session` | 「选 read-only 后 `permissions.sandbox === 'read-only'`」 | 同上，沙箱停用时预设的沙箱半部落不了地 | 同上 |
| B20 | P2-H / `compacting-status` | 壳按 `compactingSince` 画状态行（`ui.tsx` 源码正则） | 要渲组件 | ui project |

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
