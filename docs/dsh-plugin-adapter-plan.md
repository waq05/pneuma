# dsh 插件适配计划

> 2026-10-24 起草。基准：dsh 上游 master `22ddee3`（发布标签 `dsh-v0.2.1-rc.3`，2026-10-23）。
> 本地 `D:\deepseek-harness\deepseek-harness` 已于当日 21:30 更新到该提交（浅克隆，历史在后台补齐）。
> 本文回答"Pneuma（numa）还要补哪几块，才接得住 dsh 生态里的插件"。
> 用户视角的操作步骤看 [dsh-plugin-porting.md](dsh-plugin-porting.md)；本文是施工计划。

## 0. 结论先行

现在的兼容层已经能把**只注册工具、只打日志、带一份 Config** 的单文件插件挂起来跑。剩下三块缺口，按性价比排序：

| 缺口 | 用户会看到什么 | 建议 |
| --- | --- | --- |
| **① 工具的返回值契约** | dsh 插件声明的结构化结果、UI 卡片（diff / 终端 / 搜索结果）到 Pneuma 里全变成一段纯文本 | 先做，改动集中在一个 facade 与一张工具卡 |
| **② 安装与组合** | `dsh plugin add` 装的组合包（bundle）Pneuma 认不出来，`cordis.patch.yml` 的覆盖层也不生效 | 后做，是生态入口，但要新写一个 patch 引擎 |
| **③ 服务面对不上** | 插件 `inject: ['session']` 这类能挂上，但一调用 dsh 的方法就炸 | 按需做一张映射表，其余响亮拒绝 |

客户端（浏览器）插件是另一套契约，两边不通，建议明确不做，理由见 §4 阶段 D。

## 1. 基准：dsh 的插件契约（最新源码）

### 1.1 插件的三种形态

一个插件就是一个导出 `apply` 的模块，可以是函数、对象或类（`docs/user/develop/basic/index.zh.md:15`、`:107`）。框架在依赖就绪后调用 `apply(ctx, config)`，通过 `ctx` 注册一切能力，注册物在卸载时自动撤销（`docs/user/develop/framework/index.zh.md:40`）。

- 依赖用 `export const inject = ['tools', 'llm']` 声明；缺服务就不加载，不报错（同上 `:28`）。
- 可选依赖不写进 `inject`，用 `ctx.get('名字')` 取（`docs/user/develop/framework/service.zh.md:93`）。
- 手动资源用 `ctx.effect(() => 清理函数)` 挂进同一条生命周期（`framework/index.zh.md:50`）。

### 1.2 工具的完整定义

`ToolDefinition` 的字段（`packages/core/tools/src/contracts.ts:26`；本轮更新把原先挤在 `index.ts` 里的契约拆到了 `contracts.ts`）：

| 字段 | 作用 | Pneuma 现在 |
| --- | --- | --- |
| `name` / `description` / `parameters` | 模型可见的 schema；`parameters` 是 defineTool 编译后的标准 JSON Schema | 有，原样透传 |
| `output.schema` | 规范返回值的 JSON Schema，注册表在执行后校验 | **丢** |
| `output.render(args, value)` | 规范值 → 模型可见内容块 | 有，折成文本 |
| `output.presentationMeta(args, value)` | 从规范值派生的可回放卡片数据 | **丢** |
| `execute(args, exec)` | 执行体，返回规范值 | 有 |
| `timeoutMs` | 协作式超时预算 | 有（Promise.race 近似） |
| `isConcurrencySafe(args)` | 能否与相邻调用并行 | **丢** |
| `presentCall` / `presentResult` | UI 卡片：`generic` / `terminal` / `diff` / `read` / `search` / `web` | **丢** |

执行上下文 `ToolRunContext` 除了 `signal`，还带 `callId`、`args`、`agent`、不透明 `token`，以及 `deferContext()`、`concludeTurn()` 两个方法（`packages/core/tools/src/contracts.ts:244`）。

### 1.3 配置

插件导出 `Config`（schemastery schema），由框架在加载时校验并填默认值（`docs/user/develop/basic/config.zh.md:16`）。配置写在配置树对应那一行的 `config` 里。

### 1.4 服务与事件

服务是挂在 `ctx` 上的命名能力（`framework/service.zh.md:9`）。dsh 自带的服务名共 104 个（`packages/*/src` 里 `super(ctx, '...')` 去重，不含测试），常见的有 `tools`、`llm`、`agents`、`session*` 一族、`settings*` 一族、`commands`、`approval`、`jobs`、`shell`、`sandbox`、`skills`、`planMode`、`systemPrompt`、`subagents`、`workspace*` 一族。事件走同一条 cordis 总线（`ctx.on`）。

### 1.5 安装与组合（当前缺得最狠的一块）

dsh 的插件分发单位是**组合包（bundle）**，安装单位是 **profile**（`docs/user/develop/basic/publish.zh.md:9`）：

- 组合包的 `package.json` 声明 `dsh.bundle.patch`，指向一份 `cordis.patch.yml`；这个 patch 就是"这个包贡献哪些插件行"（`:18`）。
- profile 是 `$DSH_HOME/profiles/<名字>` 下的目录，`package.json` 里 `dsh.profile.bundles` 按顺序列出组合包（`:68`）。
- `dsh plugin --profile <名> add <包>` 直接转发给 pnpm 安装，并把包追加进 `bundles` 列表（`:79`）。
- 生效配置按四层组合：各组合包的 patch（按列表顺序）→ profile 自己的 `cordis.patch.yml` → home 级 patch → 每个 `--patch` 叠加层（`:120`）。**后应用的层按行 id 胜出，patch 替换目标行的整个 `config`，不做深合并**（`:131`）。patch 里允许 `!!js` 表达式（解析在 `packages/boot/app-boot/src/index.ts:570`）。
- 组合包要声明自己支持的 dsh 版本：`engines.dsh` 是个 SemVer 范围（例如 `>=0.2.0 <0.3.0`），没写就退回检查 `@deepseek-ai/dsh*` 的 peer 范围；不满足的包在安装与启动两处都会被拒（`docs/user/develop/basic/publish.zh.md:66`）。profile 还有一份 `compatibility.json` 记录逐版本的豁免（`packages/boot/app-boot/src/profile-compatibility.ts:9`）。
- 桌面端有插件管理器：列出已装组合包、装/删、启停单个行、换注册源（`packages/boot/plugin-manager/README.zh.md`）。

### 1.6 客户端（界面）插件

界面插件仍是 cordis 插件，但在浏览器里跑，靠 `package.json` 的 `dsh.client` 声明依赖与平台（例如 `packages/client/ui-chat/package.json` 的 `dsh.client.inject` 列了 11 个客户端包，`platform: "web"`）。

## 2. 现状盘点（Pneuma 侧，带行号）

### 2.1 加载路径

- 只扫 `~/.dsc/plugins/*.js`（按文件名排序）+ `config.yaml` 的 `plugins` 段（`src/core/plugin-loader.ts:296`）。
- 条目树是 `~/.dsc/plugins.json`：`{file, disabled, config}`（`src/core/plugin-registry.ts:89`）。
- 挂载失败一律记 `meta.problem`、自动停用并写盘（`plugin-loader.ts:148` 起）。

### 2.2 兼容层（`src/plugins/dsh-compat.ts`，默认关）

三件事：
1. `logger` 门面：`provide('logger')`，warn/error 镜像进对话流（`dsh-compat.ts:37`）。
2. 模块解析钩子：`@deepseek-ai/*` 重定向到 Pneuma 自带依赖，只对插件目录下的导入方生效（`src/core/dsh-compat/resolve-hook.ts:43`）。
3. 工具 facade：把 dsh `ToolDefinition` 转成 `ToolEntry`，`exec` 只给 `{signal, cwd}`，`timeoutMs` 用 `Promise.race` 兜（`src/core/dsh-compat/tools-facade.ts:90`）。

### 2.3 工具契约

`ToolEntry` 只有 `name` / `description` / `parameters`（JSON Schema）/ `risk` / `run`（`src/core/tools.ts:69`），输出是 `string | {text, images, changes}`（`:59`）。没有 `output.schema`、`presentationMeta`、`isConcurrencySafe`。

### 2.4 服务面

`DSC_SERVICE_NAMES` 登记 30 个名字（`src/core/plugin-loader.ts:42`），表外的 inject 一律当成 dsh 插件处理（`:163`）。

### 2.5 界面插件

Pneuma 有自己的界面插件契约（`plugin.json` + `@dsc/ui` + 槽位 + 平台种子），与 dsh 的 `dsh.client` 不是同一套（见 `docs/plugin-runtime-parity-plan.md`）。

## 3. 差距清单

| # | 能力 | dsh 做法 | Pneuma 现状 | 用户可见后果 | 落在哪阶段 |
| --- | --- | --- | --- | --- | --- |
| 1 | 返回值契约 | 声明 `output.schema` 后注册表校验规范值 | facade 直接调 `render`，不校验（`tools-facade.ts:104`） | 插件返回错值也"成功"，错误推到模型后面才炸 | A |
| 2 | 卡片数据 | `presentationMeta` 持久化进 `result.meta`，回放可重建卡片 | 丢弃 | 刷新会话后 diff 卡看不出来 | A |
| 3 | 卡片形态 | `presentCall`/`presentResult` 区分六种卡 | 全部走通用工具卡（`src/app/ToolCard.tsx`） | dsh 插件的 diff/终端/搜索卡降级成一段文字 | A |
| 4 | 执行上下文 | `agent`、`token`、`deferContext` | 只有 `{signal, cwd}`（`tools-facade.ts:102`） | 用到 `exec.agent` 的插件运行时炸 | C（部分拒绝） |
| 5 | 并发标记 | `isConcurrencySafe` | 无 | 工具串行执行，慢一点，不报错 | A（可选） |
| 6 | 安装单位 | bundle + profile + pnpm | 只有单文件与 `plugins.json` | `dsh plugin add` 的包装不进来 | B |
| 7 | 组合语义 | patch 层按 id 覆盖整行、insert、`!!js` | 无 patch 概念 | 组合包里"插几行插件"的意图丢失 | B |
| 8 | 服务面 | 一百多个服务名 | 30 个（`plugin-loader.ts:42`） | 缺服务的插件挂不上（现在是响亮拒绝，可接受） | C |
| 9 | 同名异义 | `session`/`settings`/`commands`/`approval`/`agent`/`compact` 语义不同 | 解析到 Pneuma 自己的同名服务 | 能挂上，一调用就炸（已文档化，但体验差） | C |
| 10 | 模块解析 | 插件通常 import `@deepseek-ai/dsh-llm`、`dsh-client-*` 等 | 只重定向 `@deepseek-ai/*` 且只对插件目录 | 报 `ERR_MODULE_NOT_FOUND` | C |
| 11 | 客户端插件 | `dsh.client` + cordis 客户端服务 | 不认 | 装不上 | D（不做） |
| 12 | 版本闸 | `engines.dsh`（缺省退回 peer 范围）+ `compatibility.json` 豁免 | 无 | 装一个跟当前版本不兼容的包，会在运行深处炸 | B |
| 13 | 权限模型 | `tools/pre-execute` 策略钩子 + 沙箱 | `risk` 分级 + 审批卡 | 语义不同，但 Pneuma 更严，不拆 | — |

## 4. 分阶段计划

> **进程（2026-10-26）**：阶段 A（值契约）在 `63accf6`；阶段 B（安装与组合）在 `48fa86b`，
> 入口 `numa plugin add/remove/list`；阶段 C（服务桥）的判定表在 `3704a63`；插件中心的组合包
> 标记与 dsh 客户端能力在 `2c58a48`；**真第三方包验收**（`dsh-cost-meter` 1.9.41）在 `bdf93ca`，
> 顺带补了入口解析、两个宿主库垫片、`DSH_HOME` 归一与缺服务诊断。
>
> **当时还欠的四件，2026-10-26 已清三件**：
> 1. **服务适配器**——仍未做。判定表里 `adapted` 那些只有判定、没有实现，所以挂得上的 dsh
>    插件一调服务就露馅（`dsh-cost-meter` 的成本条就是这么没数的：缺 `sessionPersistence`
>    与会话历史）。**卡点与做法单独写了一份**：[dsh-service-bridge-plan.md](dsh-service-bridge-plan.md)
>    （为什么不是一批能做完、只读子集怎么切、拿真包怎么验收）。
> 2. **桌面端端到端**——已做：`examples/plugins/dsh-style-clock.js` 的 `dsh_write_note` 真的
>    画出 diff 卡，`scripts/ui-dsh-card-e2e.mjs` 真机跑一轮并留
>    `desktop/shots/dsh-diff-card.png`。
> 3. **组合包的独立一档**——已做：那一组行上有包版本、来源 profile、停用状态。
> 4. **三个自检脚本在 `shots/`（gitignore）**——已做：搬进 `scripts/`，加 `pnpm run check:dsh`。

### 阶段 A：工具值契约（建议先做，1 批）

**目标**：dsh 插件声明的规范值、卡片数据、超时与并发标记都能落在 Pneuma 上。

改动落点：
1. `src/core/tools.ts:69`：`ToolEntry` 增可选 `output?: { presentationMeta?(args, value): unknown }` 与 `timeoutMs?`、`isConcurrencySafe?`。
2. `src/core/dsh-compat/tools-facade.ts:90`：`dshToolToEntry` 透传上面三项；`run` 返回时把 `presentationMeta` 算好带出去（需要给 `ToolOutput` 加一个 `meta` 字段）。
3. `src/app/ToolCard.tsx`：工具结果若带 `meta.kind`（`diff`/`terminal`/`read`/`search`），按对应形态渲染，缺字段回落通用卡。
4. `scripts/dsh-compat-check.mjs`：断言从 15 条扩到 20 条，新增"presentationMeta 透传""timeoutMs 生效""并发标记透传"。

验收：`examples/plugins/dsh-style-clock.js` 扩成返回结构化值 + diff 卡；对话里跑一次，刷新会话后卡片仍在。

成本：**低**（半天）。风险：工具卡是界面层改动，要用桌面端截图自检。

### 阶段 B：安装与组合（2–3 批）

**目标**：`numa plugin add <包>` 能装一个 dsh 组合包，并让它的 patch 层生效。

改动落点：
1. 新 `src/core/plugin-patch.ts`：读 YAML 数组，支持 `insert` 与按 `id` 覆盖整行 `config`，层按顺序应用。遇到 `!!js` 直接拒绝并给出人话（求值等于让包在宿主里执行任意表达式）。
2. 新 `src/core/plugin-bundle.ts`：读 `package.json` 的 `dsh.bundle.patch`，把包目录映射成"层"；profile 目录 `~/.dsc/profiles/<名>/package.json` 的 `dsh.profile.bundles` 决定顺序。
3. `src/core/plugin-loader.ts`：加载顺序改成"内置 → 各 bundle 层 → profile 自身 patch → 用户插件目录"，与 dsh 的层序一致。
4. 版本闸：读组合包的 `engines.dsh`（没写就退回 `@deepseek-ai/dsh*` 的 peer 范围），不满足就跳过该层并在诊断区写清"要的是 X、当前是 Y"。Pneuma 的版本号需要定一个对外口径（现在是 0.7.x，跟 dsh 的 0.2.x 不是一条线）。
5. `bin/dsc.js` + 新 `src/commands/plugin.js`：`numa plugin add/remove/list`，内部转调 pnpm（评测过的失败场景要给人话：没装 pnpm、peer 缺、构建脚本未授权）。
6. 插件中心（桌面）加一档"组合包"，显示来源、版本、启用状态。

验收：装一个真实 dsh 组合包（先用 tarball 或本地路径），启动后它的插件行出现在注册表里；停用后行消失。

成本：**中高**（1–2 天）。风险：pnpm 是外部依赖；profile 里的宿主代码不受工作区沙箱限制（dsh 自己也这么讲），必须在安装确认里讲清楚。

### 阶段 C：服务桥（1 批，按需）

**目标**：常见服务有一张明确的对照表，其余响亮拒绝。

改动落点：
1. 新 `src/core/dsh-compat/service-map.ts`：三档——**同名同义直传**（`tools`、`llm`、`commands`、`settings`、`plan`）、**同名异义拒绝**（`session`、`agent`、`compact`、`approval`）、**无对应拒绝**（`agents`、`goals`、`sessionProjections`、`systemPrompt`）。
2. 拒绝时写清一句话原因与替代写法，进启动诊断（现在已有这类 system 条目的通道）。
3. `resolve-hook.ts:43` 的匹配范围从"只有 `@deepseek-ai/*`"扩到 dsh 常用包名前缀，命中不了的给 `ERR_MODULE_NOT_FOUND` 加一条提示。

验收：三个真实插件（一个能挂、一个同名异义、一个缺服务）分别拿到预期结果与可读诊断。

成本：**中**（半天到一天）。

### 阶段 D：客户端插件（装配层已对齐，契约层不桥）

2026-10-26 用户要求「对齐 dsh 的 cordis 插件实现方式」，据此拆成两件事，只做了第一件：

**做了（装配层）**：壳里加了一个 cordis 根（`ui-shell/src/ui-renderer/cordis-host.ts`），界面插件的
装、卸、回收、状态全部走 fiber；插件写法不变（`apply(ui)` 照旧），所以 19 个内置插件一行没改。
细节与三个坑见 [development.md §4](development.md) 的「界面壳那侧也走 cordis」。
真机验证：`node desktop/shots/_cordis-probe.mjs`（22 条断言）。

**不做（契约层）**：dsh 的界面插件与 Pneuma 的界面插件仍是两套扩展方式——前者是 cordis 客户端服务
互相注入，后者是「槽位 + 平台种子 + 三道信任闸」。硬桥等于在页面里跑一份 dsh 的客户端运行时，
与 Pneuma 更严的信任模型冲突。边界仍是：**宿主侧只读查看**——列出插件声明了哪些界面能力，不加载。

**已全切**：19 条内置插件现在都走 cordis，旧退订账本是回滚面（`__DSC_CORDIS_PROBE__ = 'none'`）。
诊断区逐行显示装配路径与纤维状态（`data-plugin-via` / `data-plugin-fiber`）。

**`inject` 拆开走**：界面清单的 `inject` 是双关（插件 id 或服务名）。插件 id 仍由 `unmetInjections`
在装之前检查（报中文原因、失败重试一轮）；服务名交给 cordis 的 `inject`，依赖后补上来时纤维自己
启动，不必重装。依赖没就绪时 `await fiber` 直接放行、纤维停在状态 0，装配器据此记「等待服务：X」
并在 `internal/status` 事件里把账本翻成「已生效」。

还没做：`inject` 双关本身没有退役（清单仍允许一个字段两种含义）。要退役得先改清单格式与构建脚本，
那是另一批。

### 阶段 E：验证与金丝雀（贯穿每阶段）

1. 三个金丝雀：官方单文件工具插件、带 Config 的插件、带 bundle patch 的组合包。
2. `scripts/dsh-compat-check.mjs` 从 15 条扩到 30 条。
3. `docs/dsh-plugin-porting.md` 更新判定表：新增"bundle 能装""卡片能显示"两行。

## 5. 风险

1. **cordis 版本漂移**：Pneuma 用 npm 版 cordis 4.0.4，dsh 用 vendor 版。差别已经在 logger 上踩过一次，服务面继续对的时候还会踩。
2. **双实例**：dsh 插件 import 到第二份 cordis / schemastery 就会 `instanceof` 分裂。解析钩子必须覆盖所有入口。
3. **安全口径**：bundle 里的宿主代码直接跑在 Pneuma 进程里，不受工作区沙箱限制。安装时必须让用户明确知道这一点。
4. **不要拆掉现有的闸**：`risk` 分级、审批卡、方法白名单都是 Pneuma 故意比 dsh 严的地方，适配时一条不许退。

## 6. 基准数据怎么复核

本文所有 dsh 侧的结论都能在本地复现（源码目录 `D:\deepseek-harness\deepseek-harness`）：

```sh
# 服务名清单（104 个）
grep -rhoE "super\(ctx, '[A-Za-z]+'" packages --include=*.ts --exclude-dir=tests | sort -u
# 工具定义字段（2026-10-23 起在 contracts.ts）
sed -n '26,110p' packages/core/tools/src/contracts.ts
# patch 层解析与组合
sed -n '515,640p' packages/boot/app-boot/src/index.ts
# 安装与组合的说明书
sed -n '9,140p' docs/user/develop/basic/publish.zh.md
```

## 7. 已经拍板的三件事（2026-10-26 定案）

1. **阶段 B 的安装形态**：走「profile + pnpm」这套 dsh 原生布局，代价是引入 pnpm 依赖——
   换来的是 npm 生态能直接装（自造 tarball 方案已弃）。
2. **阶段 D 客户端插件**：dsh 自己的界面插件（`dsh.client.platform = "web"`）**只列不加载**；
   我们的 `pneuma` 界面半照常加载（2.0 起按 `dsh.client` 收进启动图）。
3. **`!!js` 配置表达式**：一律拒绝并给人话——等于让包在宿主进程里执行任意表达式。

后续若有新问题，写在 §8 的表里，别再单开「等你拍板」一节。

## 8. 2.0 这批的审查记录（2026-10-26）

四批提交（`0d6e22e` 契约 2.0、`4c519b4` 包两半、`99e8cb1` 示例包、`d8e057f`+`8f1dfa6` 十九个内置插件迁声明）
之后的逐条复查。**已修的写清怎么修的，没修的写清卡在哪。**

| # | 问题 | 现状 | 下一步 |
| --- | --- | --- | --- |
| 1 | 插件中心把 `platform: "pneuma"` 的界面半列成「dsh 客户端插件 · 只列不加载」——假话，那是我们会加载的 | **已修**：`plugin-loader.ts` 里 pneuma 跳过能力清单；`ui-two-halves-test` 加了一条断言 | — |
| 2 | profile 包的界面半**没有启停入口**。发现时按 `<包名>/client` 读 `isPluginEnabled`，但插件中心没有这一行，用户只能改 `~/.dsc/plugins.json` | **已修**：`UiTrustView` 加 `key` 与 `origin`（启停键由宿主给），新增 `scanPackageUiTrusts` 与发现层共用同一套判定，插件中心多一组「组合包界面」带开关（装了就算同意，没有「确认信任」），`isPackageUiEntry` 让启停走「写盘 + 提示刷新」 | — |
| 3 | **TUI 壳不加载包界面半**：`collectUiArtifactsForPlatform` 按 `platform ?? 'web'` 过滤，包条目没有 platform 字段，于是 `tui` 视图收不到 | **已修**：加了 `dsh.client.platforms`（缺省 `["web"]`），与内置插件同一套校验；终端装载器改成按产物条目读字节（组合包入口由 `exports` 决定）；`ui-tui-plugin-test` 进 `check:ui` 并加了一条真装载用例 | — |
| 4 | **远程壳（手机）会一起加载本机 profile 的界面半**——它走同一张产物表 | **已验**：确实会，且是对的（手机跑同一份壳产物，伺服链本来就查 `lookupPackageUiBundle`）。`createUiBootSource` 加 `packageDir` 选项，本机与远程都显式传，不再靠缺省；加了 3 条断言 | — |
| 5 | **每次组图都重扫 `node_modules`**：`graph()` 每次（`/boot.js`、HMR 轮询）都调 `collectUiArtifactsForPlatform`，包发现没有指纹短路（内置清单有 mtime 缓存） | **已修**：目录列表按 `node_modules` 的 mtime+条目数缓存，单包声明按 `package.json` 的 mtime+size 缓存；客户端字节仍每次读（rev 要准） | — |
| 6 | 第三方 `plugin.json` 的 `services` 坏值被**静默丢弃**（`Array.isArray ? filter : undefined`），与内置清单 `readNameList` 记 problem 的口径不一致 | **已修**：坏值记一条 problem 并当没声明处理 | 其余字段也可以收进同一个读函数（下一步） |
| 7 | **门禁既有漏洞**：构建产物缺失时清单顶层 `apiVersion` 为 `undefined`，`evaluateUiApiGate` 直接放行——「无据可依就放行」，与失败关闭相反；包路径复用了它 | **已修**：两边都无依据改成拒（理由写进 problems）；五个测试夹具补上 `apiVersion` | — |
| 8 | `build-plugins.mjs` 还留着 legacy `plugin.json` 读取分支，19 个插件都迁完了，这条分支已死 | **已修**：改成「见到 plugin.json 就报错」，删掉分支 | — |
| 9 | UI 自检**没有汇总入口**，靠人记着跑 | **已修**：`scripts/check-ui.mjs` 按文件名自动发现——`pnpm run check:ui` 跑纯 Node 那 35 条（31 秒），`pnpm run check:ui:e2e` 跑要真 Chromium 的 4 条（61 秒）；新探针命名 `ui-<话题>-test.mjs` / `-e2e.mjs` 即自动入库 | — |
| 10 | 示例包的 `client.bundle.js` 是手写工厂，壳的工厂协议一变它会静默失效（只有 e2e 能发现） | **已修**：`ui-two-halves-test` 当场跑它一遍，钉住注册名、产出形状、require 白名单、注册进哪个槽、组件标记与文字（16/0） | — |
| 11 | `unmetDependencies` 对「依赖的插件被停用」也说「不在清单里」，文案不够准 | **已修**：产物表多一项 `disabled`（第三方与组合包），启动图带出去，两壳装载器都传进 `unmetDependencies`，文案改成「被停用了（在插件中心或 plugins.json 里打开）」 | — |
| 12 | 计划文档 §4 的进程注记没跟上 2.0 与两半 | **已修**：本节 + 上面的注记 | — |

| 13 | **中央 `manifest.json` 还在列插件**：加/删一个插件要改汇总文件，而且它能手写（手写就能绕过产物层检查） | **已修**：每个产物目录自带 `bundle.json`，宿主扫目录；根清单只写 `{version, apiVersion}`；旧产物（只有中央数组）仍能装但会被点名 | — |

**一句话**：这一批把 §8 的十三条全部收口——用户手里的开关（2、3）、性能与口径的一致（5、6、7）、
远程与 TUI 的边界（3、4）、示例与门禁（7、10、11），以及最后一刀中央清单（13）。机制这层现在
是「一个包两半、一处声明、目录即清单」：加一个插件不用改任何汇总文件，删一个就是目录没了。
