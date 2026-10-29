# dsh 插件适配指南

面向**想把 dsh（DeepSeek Harness）的插件跑到 dsc（Pneuma）上的人**。讲清楚：哪些能直接挂、
哪些要改代码、改的时候 API 怎么对应、实测踩过哪些坑、交付前怎么验证。

前置阅读：[plugin-development.md](plugin-development.md)（dsc 插件的基本形态与服务 API）。
本文只讲"dsh 插件 → dsc"这一件事。

| 想知道 | 去看 |
| --- | --- |
| 我手里的插件能不能直接用 | **§1 判定流程** |
| 直接挂载的步骤 | **§2 挂载路径** |
| 要改代码，API 怎么对应 | **§3 映射表** |
| 为什么我的插件挂不上/行为不对 | **§4 实测坑** |
| 交付前跑什么 | **§5 验证清单** |
| 明确不支持哪些、别绕 | **§6 边界** |
| 这套兼容层是怎么一步步长出来的 | **§7 历史存根** |
| dsh 的请求组装/上下文管理内部机制（源码级） | [dsh-request-assembly.md](dsh-request-assembly.md) |

## 1. 判定流程：先看结局，再决定要不要改代码

兼容层（官方可开关插件 `dsh-compat`）解决的是"运行形态"差异；**业务语义**的差异没人能替你
适配。拿到一个 dsh 插件，先按这张表判定：

| dsh 插件的特征 | 结局 | 依据 |
| --- | --- | --- |
| `inject ⊆ ['tools', 'logger']`，工具用 `defineTool(...)` 定义，可选 `export const Config`（schemastery） | **直接挂**，零改动 | 兼容层的三件事正好覆盖：工具形状、logger 服务、配置校验（§2） |
| 同上，但 import 了 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 等包 | **直接挂**，零改动 | 解析钩子把这类导入重定向到 dsc 自带副本（§2.3） |
| `inject` 里有 **两边同名但 API 不同**的服务：`session` / `settings` / `commands` / `approval` / `agent` / `compact` | **能挂，但要改代码**：这些名字在 dsc 里解析到的是 dsc 自己的服务，dsh 的调用方式会运行时炸。按 §3 映射表改写，改完再挂 | 兼容层不垫同名异 API 的服务——垫了等于猜 |
| `inject` 里有 `sessionProjections` / `agents` / `goals` / `systemPrompt` 等 dsh 会话侧服务 | **不支持**：挂载即被拒，宿主会列出缺的服务名 | 这些要整个 dsh 会话语义（事件溯源、agent 注册表），个人版不背；部分场景可按 §3 映射表重写后去掉这些 inject |
| 插件**不 inject**，而是在 apply 里 `ctx.get('sessionPersistence')` / `ctx.get('sessions')` 读历史，用 `ctx.on('llm/stream')` 收实时用量、`ctx.on('session/event')` 收回合过程 | **能挂，能用**（2026-10-26 起） | 兼容层把会话历史按 dsh 的事件类型交出去（只读），并把回合过程与用量按 dsh 的事件/流形状播出来；范围见 §2.7 |
| 工具声明了 `projectContent` / `finalizeContent`（自己改写模型可见内容） | **直接挂**：两个钩子都生效，顺序是 `execute` → schema 校验 → `render` → `projectContent` → `finalizeContent`；失败结果也过一道 `finalizeContent`（`projectContent` 不跑） | 只认「返回内容块数组」这一种替换信号，返回 `undefined` 或抛错都保留原内容（抛错留一行 stderr） |
| 工具 `execute` 里用了 `exec.agent` / `exec.callId` / `exec.deferContext` / `exec.concludeTurn` 等 dsh 执行上下文字段 | **能挂，但语义是降级过的**：`signal` / `cwd` / `arguments` 是真值；`agent` 与 `token` 是合成身份；`deferContext` 收下但不投递、`concludeTurn` 是空操作（各留一行 stderr 告警）；`requestContext` 没有 | 只依赖 `signal` 的插件最稳；要用延迟上下文或收尾语义的插件，行为会不完整但不会崩 |
| 工具 `output.render` 返回结构化值（对象、数组，不是一段字符串） | **卡片能显示**：返回值按 dsc 工具卡的通用渲染落到对话里，与原生插件同一套 | 卡片是 dsc 自己的渲染器画的，不执行插件的界面代码；dsh 塞进 `render` 的 ConversationNode 之类会被忽略 |
| 工具 `output.render` 返回图像块 | 能挂，图像块降级为占位说明文字 | dsc 工具图像走 data URL，dsh 的 attachment 引用没有直接映射 |
| 整个 npm 包带 `dsh.bundle.patch`（就是 `dsh plugin add` 装的那种组合包） | **bundle 能装**：`numa plugin add <包名 / tarball / 本地路径>` 装进 profile，patch 里的插件条目被逐条读出来挂载，插件中心在名字后挂一枚「组合包 <包名>」 | 安装单位照 dsh 同一套（profile + pnpm + patch 层算法），不是把包塞进 `~/.dsc/plugins/` 里手写入口（§2.6） |
| 包同时带 `dsh.client` 声明（客户端半） | **界面半能进来**，但只有当 `platform` 是 `pneuma` 时；`platform: 'web'` 这类 dsh 客户端插件**只列出、不加载** | 两半是两份不同的东西：宿主半是 cordis 插件，客户端半是给 dsh 自己的 Web 壳写的界面代码，我们没有那份运行时（§2.6） |

结局一共五种，按上表从上往下取第一条命中的：**直接挂** / **改码后挂** / **不支持** /
**bundle 能装**（整个 npm 包，走 profile + pnpm）/ **只列出不加载**（dsh 客户端半）。

一句话：**纯工具插件（配 logger 与配置校验）是兼容层的主战场；会话侧语义是禁区**。

## 2. 直接挂载路径

### 2.1 前置：启用兼容层

插件中心（桌面端「插件」页）里打开**「dsh 兼容层」（dsh-compat）**。它默认关，因为开着会
改变外部插件的模块解析与工具注册行为——按"拉起外部机制的默认关"的规矩走。没开它时，
dsh 风格插件挂载会被拦下，宿主写出的 system 条目会明确提示先开兼容层。

### 2.2 自包含单文件（推荐起点）

dsh 插件若是单文件（或你能把它改写成单文件），放进 `~/.dsc/plugins/` 即可，其余流程与
dsc 原生插件完全一致。最小骨架（完整可跑的参照：`examples/plugins/dsh-style-clock.js`）：

```js
// ~/.dsc/plugins/dsh-my-tool.js
export const name = 'dsh-my-tool'
export const inject = ['tools', 'logger']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_my_tool',
    description: '让模型望文生义的一句话。',
    // dsh 的参数方言：纯对象，required 用布尔位（defineTool 会编译成 JSON Schema）
    parameters: { text: { type: 'string', required: true } },
    timeoutMs: 5_000,
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args, exec) => {
      // exec 只有 { signal, cwd }；取消要协作式地看 exec.signal
      return doWork(args.text, exec.signal)
    },
  })
  return () => off()
}
```

### 2.3 npm 包形态

dsh 插件是 npm 包时，把依赖连同本体装进插件目录（npm ≥7 会自动装 peer 依赖，其中就包括
`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`）：

```sh
cd ~/.dsc/plugins && npm install <dsh 插件包>
```

然后在 `~/.dsc/config.yaml` 的 `plugins` 段声明包的入口：

```yaml
plugins:
  - "~/.dsc/plugins/node_modules/@<scope>/<dsh-plugin>/lib/index.js"
```

**要点**：`@deepseek-ai/*` 的解析重定向按路径前缀匹配，只对 `~/.dsc/plugins/` 目录**之下**
的导入方生效——装在它下面的 `node_modules` 命中，放到别的盘符路径不命中（那种情况插件
import dsh 库会 `ERR_MODULE_NOT_FOUND`，响亮失败，不会静默装错）。

### 2.4 兼容层自动做了什么（挂载路径上，无需你写）

| 环节 | 行为 |
| --- | --- |
| 模块解析 | 插件文件里 import `@deepseek-ai/*` → 重定向到 dsc 自带 node_modules 与 `@deepseek-ai/dsh-tools` 的传递依赖（schemastery 等）；cordis 保证单实例；双构建包按 ESM 条件命中与 dsh-tools 内部相同的文件 |
| 工具注册 | `ctx.tools.register` 收 dsh `ToolDefinition`：`parameters`（defineTool 已编译的 JSON Schema）透传、`execute(args, exec)` 的 `exec` 为 `{ signal, cwd }`、返回值经 `output.render` 折成文本、图像块降级占位、`timeoutMs` 到点放弃（协作式） |
| risk 映射 | dsh 没有 risk 概念；缺省 `exec`（每次过审批卡）。放宽见 §2.5 |
| logger | `inject: ['logger']` 有服务；`warn`/`error` 镜像进对话流（`[dsh 插件·名字]` 前缀，printf 占位符还原），`info`/`debug` 静默 |
| 配置校验 | `export const Config`（schemastery schema）在挂载时调用一次；抛错 = 挂载失败并自动停用，提示检查 plugins.json 的 config |

### 2.5 risk 映射（安全语义的差异点）

dsc 对工具分级：`read` 自动放行、`write`/`exec` 走权限模式与审批卡。dsh 工具转进来缺省
`exec`——**宁多问不漏问**。想放宽，写进该插件在 `~/.dsc/plugins.json` 条目的 `config`：

```json
{ "file": "dsh-my-tool.js", "disabled": false,
  "config": { "risk": "read", "risks": { "dsh_echo": "read", "dsh_deploy": "write" } } }
```

`risk` 是这份插件全部工具的缺省，`risks` 按工具名覆盖；非法值回落 `exec`。每次注册现读，
改完停用→启用（或重启挂载）即生效。**判定标准与 dsc 原生插件一致**：只读数据 `read`；
写文件 `write`；执行命令 `exec`。

### 2.6 整个 npm 包（组合包）：一条命令装，别手抄入口

dsh 的安装单位是「bundle + profile + pnpm」：包在 `package.json` 里用 `dsh.bundle.patch`
指向一份 patch，patch 按行 id 改配置、按 group 插行。这条路径我们是**照原样实现**的，
所以装法就是 dsh 那条命令，不必把包解压进 `~/.dsc/plugins/` 再手写入口：

```sh
numa plugin add <包名 / tarball / 本地路径> [--profile 名字]
numa plugin remove <包名> [--profile 名字]
numa plugin list [--profile 名字]
```

装之前有一道版本闸：比的是**dsh 的插件契约版本**（不是 Pneuma 的 0.7.x）。包的
`engines.dsh` 或 `@deepseek-ai/dsh*` 的 peer 范围不满足就拒绝安装，除非在 profile 的
`compatibility.json` 里登记豁免。机制细节见 [development.md](development.md) 的
「dsh 组合包怎么装」。

**两半要分开看**。同一个包可以同时带宿主半与客户端半：

- 宿主半（code 插件，走 `dsh.bundle.patch` 那一层）**照常挂载**，与 §2.2 / §2.3 的单文件、
  npm 包没有区别；
- 客户端半（`package.json` 的 `dsh.client`，入口 `exports["./client"]`）只有在
  `platform` 写成 `pneuma` 时才会被当成界面插件加载；写成 `web` 这类 dsh 自己的壳时
  **只列出、不加载**——那要一份 dsh 的客户端运行时，与我们更严的信任模型冲突；
- 界面半默认只服务浏览器壳，要它同时进终端壳，在 `dsh.client.platforms` 里显式写
  `["web", "tui"]`；未知取值整条声明被拒（不是忽略）。
- 信任：`numa plugin add` 装进 profile 的那一步就算用户同意，界面半直接可用，没有第二张
  「确认信任」卡。这与手动丢进 `~/.dsc/plugins/` 的第三方界面插件不同，那种需要点一次。


### 2.7 会话过程与历史：订阅事件、读历史（2026-10-26 起可用）

dsh 的计费、统计、审计类插件普遍**不听磁盘、听广播**：实时用量走 `llm/stream`（waterfall，
管道里流的是 chunk），回合过程走 `session/event`（一条一条广播），历史与补账走
`sessionPersistence` / `sessions`（只读服务）。这三条面我们都能给：

| 面 | 给什么 | 怎么用 |
| --- | --- | --- |
| `llm/stream` | 每次模型调用一个 `{ type: 'usage', usage }` chunk（真实 token 数），插件包住下游流读它即可 | `ctx.on('llm/stream', (options, next) => { … })` |
| `session/event` | `turn/start`、`step/start`、`assistant/message`（带 `usage` 与正文/推理/工具调用的内容块）、`tool/call`、`tool/result`、`step/end`、`turn/end`、`user/message` | `ctx.on('session/event', (session, event) => { … })`，会话 id 在 `session.header.id` |
| `sessionPersistence`（只读） | `list()`、`stat(id)`、`open(id, 'read')`；句柄上 `read(seq数字)` 或 `read({ maxMessages })`；事件已是 dsh 类型（`user/message` / `assistant/message` / `tool/result`，用量挂在助手消息的 `usage` 上） | `const p = ctx.get('sessionPersistence')`（**别写进 inject**，它不是 cordis 服务） |
| `sessions`（只读） | `list()` / `get(id)` / `has(id)`：会话 id、cwd、createdAt、title | 同上，`ctx.get('sessions')` |

四条要知道的边界：

1. **只读**。`create` / `append` / `open(id, 'write')` 一律抛中文错误：会话由内核独占写入，
   两套写者改同一份历史坏的是用户的数据。错误里写明「为什么不行、只读能做什么」，
   不做静默 no-op。
2. **不是 dsh 的每一次事件都发**。`request/header`、`compaction/summary`、
   `assistant/chunk`（逐帧）、`system/message` 这些我们给不出真的，就**不发**——不编。
   靠这些做功能的插件（上下文成本面板一类）会在第一步空转。
3. **用量口径按 dsh 换算过**：我们的 `inputTokens` 是 `prompt_tokens` 总量（缓存命中含在内），
   dsh 的分项互斥（命中单列在 `cacheReadTokens`）。直接抄会把命中算两遍钱，兼容层已经换算。
4. **图片不进事件**：dsh 的 `ImageBlock` 要附件引用，我们给不出真的，所以用户消息只带正文块。
   要看图片走 `sessionPersistence` 读历史（那边的 `content` 也是正文）。

验证：`pnpm run check:dsh` 里 `dsh-llm-event-check`（12 条）、`dsh-session-events-check`
（36 条）、`dsh-session-bridge-check`（42 条）、`dsh-compat-live-check`（19 条）四条钉着；
最后一条是真内核跑一个两步骤回合、一个探针插件同时吃三条面。

## 3. 映射表：要改代码时的 API 对照

dsh 与 dsc 是同名生态（都叫 cordis 插件），但服务面不同。改写的总原则：**会话侧语义找
dsc 的等价扩展点重挂，找不到就砍掉那个功能**——个人版没有的，装不出来。

| dsh 里的做法 | dsc 对应 | 差异要点 |
| --- | --- | --- |
| `ctx.tools.register(defineTool({...}))` | 原样（兼容面转换） | `exec` 缩水为 `{ signal, cwd }`；加 risk 配置（§2.5）；`presentCall`/`presentResult`/`isConcurrencySafe` 被忽略（dsc 工具卡通用渲染） |
| `ctx.logger.warn('… %s', x)` | 原样 | `info`/`debug` 不落地；warn/error 进对话流 |
| `export const Config = z.object({...})` | 原样 | 挂载期校验、失败回滚 |
| `ctx.systemPrompt` 的 provider / waterfall 贡献段 | `ctx.prompt.register(id, () => text, { order })` | dsc 是"每次组装取文本"的段注册表；order 刻度 0~890（身份 0 / 插件 60 / 指令文件 200 / 模型信息 890），易变内容往后放；环境事实不进提示词，由 env-facts 投影附在请求末尾（2026-10-03 起） |
| 改写发给模型的消息 | `ctx.prompt.registerProjection(id, fn, { order })` | dsc v6 的**命名纯投影**：必须是纯函数；往请求里加日志外内容必须配 `ctx.session.current().appendNote(id, text)` |
| `ctx.sessionProjections.register({ key, init, apply })` | `ctx.session.appendState(id, payload)` + `ctx.session.current().state(id)` | dsc 无投影 schema 与状态版本；语义是"最后一条生效"（latest-wins）；键要先在 `src/core/session.ts` 的 `SessionStateMap` 上声明合并（那是内核文件，随包插件才改得了） |
| `ctx.goals`（目标服务） | `ctx.goal.goalAction(action, …)` | dsc 的目标挂当前会话、跨轮自动续跑；无 dsh 的 agent 绑定语义 |
| `ctx.agents` / fork 会话 | 无直接对应 | 子智能体走 subagent 插件（`subagent` / `team_task` 工具，可选服务 `ctx.get('team')`） |
| `ctx.commands.register(...)` | `ctx.commands.register({ name, args, description }, handler)` | dsc 形状；handler 收 `({ ui })`，反馈用 `ui.notice()` |
| `ctx.settings`（dsh 的设置页） | `ctx.settings.registerSection({...})` | dsc 是声明式控件（六种），插件拿不到 DOM；字段定义见 plugin-development.md §4.7 |
| dsh 的审批桥（user-approval） | 无需适配 | dsc 的守卫链 + 审批插件按 risk 自动接管；`exec` 类工具天然过卡 |

改写时的两条硬规矩（与 dsc 原生插件相同，违者挂不上或运行时炸）：

1. **可选服务不进 `inject`**：`team` / `mcp` / `sandbox` / `sessionSearch` 这类"插件没开就
   不存在"的服务，读它用 `ctx.get('名字')`；写进 `inject` 会让挂载失败。
2. **注册一律返回清理函数**，在 `apply` 的 disposer 里全部调用——dsc 的停用是热卸载。

## 4. 实测坑（本批自检真踩出来的，每条都有产出物佐证）

| 坑 | 症状 | 原因 | 对策 |
| --- | --- | --- | --- |
| cordis 的 `logger` 不是可注入服务 | `inject: ['logger']` 的插件**挂载成功但 apply 永不执行**，无任何报错 | npm 发布的 cordis 4.0.4 里 logger 是原型属性（dsh 的 vendor 版才是服务），fiber 等一个永远不会来的服务 | 开 dsh-compat：它 `provide('logger')` 一个委托门面。**排查这类"挂上了但没跑"的插件，先怀疑 inject 缺服务** |
| logger 的 warn/error 看不见 | 插件打了 warn，对话流没有 | cordis exporter 缺省阈值是 info(1)，warn(2)/error(0 之外) 被滤 | 兼容桥已显式 `levels: { default: 3 }` 放开；自己注册 exporter 时记得照做 |
| parameters 用 schemastery 实例报 `must be a value schema object` | defineTool 当场抛 JsonSchemaError | dsh 的参数方言是**纯对象**（`{ type: 'string', required: true }`），schemastery 的 `z` 只用于 `Config` 导出 | 参数写纯对象方言，或干脆写标准 JSON Schema；z 留给 Config |
| schemastery 双实例 | 同上，且时而好时而坏 | CJS/ESM 双构建包被解析成两份模块副本，原型不等、instanceof 分裂 | 插件里**只** `import z from '@deepseek-ai/schemastery'`（解析钩子按 ESM 条件命中与 dsh-tools 内部相同的文件）；不要自己 `require` 它的 CJS 入口 |
| printf 占位符原样透传 | `warn('failed: %s', err)` 显示出字面 `%s` | 桥若直接 join 参数不会替换占位符 | 兼容桥已用 `Logger.format` 还原；自建桥时记得调它 |
| 解析钩子不生效 | 插件 import `@deepseek-ai/*` 报 `ERR_MODULE_NOT_FOUND` | 插件文件不在 `~/.dsc/plugins/` 之下（前缀匹配失败），或 dsh-compat 没开（钩子未注册） | 插件放对目录并开兼容层；npm 包装进 `~/.dsc/plugins/node_modules/` 即命中前缀 |
| `presentResult(args, result)` 里拿不到工具的规范值 | 卡片上 `path` / `diffs` 全是 `undefined`，界面画出来一片空白（或直接回落通用卡） | 兼容层传给第二个参数的是**渲染后的结果**（dsh 的 ToolResult：content 块 + 一段文本），不是 `execute` 返回的那个 JSON 值 | 画「改前 / 改后」这类对比，得在 `execute` 里自己把旧内容记下来（文件那时已被覆盖）；只依赖 `args` 的卡片直接把参数当下标用 |
| dsh 工具定义直接塞给 dsc 注册表 | 挂载失败：`是 dsh 风格的定义（有 execute 没有 run）` | 兼容层没开时 `ctx.tools.register` 只认 dsc 的 ToolEntry（`run` 函数） | 按提示开 dsh-compat 后重新挂载；这是形状关的预期行为，不是 bug |

## 5. 验证清单（交付前逐项执行）

1. **判定复核**：§1 表格走一遍，确认插件落在「直接挂」「改码后挂」「bundle 能装」三者之一，
   没有禁区特征。
2. **兼容层开着**：插件中心确认 `dsh-compat` 已启用。
3. **挂载**：启用插件；挂载失败时宿主会写 system 条目说明原因（缺服务 / 配置校验失败 /
   版本不兼容），修好再继续。
4. **功能**：工具插件 → 在对话里诱导模型调用，确认结果返回、参数校验生效（喂非法参数应报
   ToolArgsError 类错误）；logger → 触发一次 warn，确认对话流出现 `[dsh 插件·名字]` 行。
5. **审批语义**：`exec` 缺省的工具确认每次弹卡；配置了 `risk: read` 的确认不弹；写类操作
   确认走审批而不是静默落盘。
6. **卸载干净**：停用插件后确认工具从注册表消失、logger 桥停止输出（disposer 返回的清理
   函数全部被调用）。
7. **组合包**：走 `numa plugin add` 装，`numa plugin list` 能看到包与它的插件；包装了界面半
   就再去插件中心确认「组合包界面」那一组有它、开关能停。
8. **回归自检**：`pnpm run check:dsh`（七条脚本，180 条断言）——覆盖解析钩子、工具兼容面、内容钩子、
   logger 桥、配置校验、不支持项拒绝、会话桥、流与事件旁路、以及一条真内核跑真回合的
   合成验收；给兼容层改代码时必须全绿再交付。界面半的回归
   另跑 `pnpm run check:ui`（36 条纯 Node 探针，组合包与「重开会话卡片还在」在里面）与 `pnpm run check:ui:e2e`
   （4 条要真 Chromium 的，含 diff 卡与手机尺寸远程壳）。

## 6. 边界（当前明确不支持的，别绕）

- **dsh 会话侧语义**：`sessionProjections`（事件溯源投影）、`agents`（agent 注册表与 fork）、
  `goals`（agent 绑定目标）、`systemPrompt`（waterfall 装配）——挂载被拒；等价功能按 §3
  映射表重写后去掉对应 inject。
- **dsh 客户端插件的界面代码本身**：`dsh.client` 声明成 `platform: 'web'`（或任何不是
  `pneuma` 的取值）时只列出、不加载。dsc 的界面走自己的 contract 体系（快照 + 白名单方法），
  dsh 的 ConversationNode 之类渲染扩展没有对应物，装进来也没有运行时去执行它。
  写成 `platform: 'pneuma'` 的那一半是我们自己的界面插件协议，不是 dsh 的——两套别混。
- **`ctx.tools` 兼容面只实现了 `register`**：调其余成员（`schemas` / dispatch 类）会响亮
  报错，不会静默 undefined——这是刻意的，别依赖。
- **`session/event` 是合成流，不是 dsh 的会话日志**：`seq` 是我们自己从 0 起的连续计数，
  不是磁盘上的事件号；只发已知的那八种（见 §2.7），`request/header`、`compaction/summary`、
  `assistant/chunk` 逐帧、`system/message` 不发。第一个参数是**只读会话视图**（`id` /
  `header` / `cwd` / 最近 64 条事件的尾巴），不是 dsh 的 `Session` 实例——插件去 `append`
  会在它自己的代码里炸，而不是我们假装支持。
- **`config.yaml plugins` 段的 extraPaths 不享受解析重定向**：重定向按 `~/.dsc/plugins/`
  前缀匹配；放外头的插件要么搬进来，要么自带依赖（把 `@deepseek-ai/*` 装在它自己的
  node_modules 里，Node 自然解析，但 cordis 双实例风险自担）。

## 7. 历史存根：这套兼容层是怎么长出来的

2026-10-24 起草过一份施工计划，把"还差什么"拆成五个阶段。到 2026-10-26 全部收口，
最终形态就是本文各节：

| 当时拆的阶段 | 最后落在哪 |
| --- | --- |
| A 工具值契约（`output.schema` / `presentationMeta` / 六种卡片 / 并发标记） | §1 判定表第 6–8 行、§2.4 |
| B 安装与组合（bundle + profile + pnpm + patch 层） | §2.6 |
| C 服务桥（`sessionPersistence` / `sessions` / `llm/stream` / `session/event`） | §2.7 |
| D 客户端插件（装配层 vs 契约层） | 装配层做了（壳里加了 cordis 根），契约层明确不做，见 §6 |
| E 验证与金丝雀 | §5 第 8 条 |

完整的缺口分析、逐阶段的改动落点、七条复审记录，留档在
[docs/archive/dsh-plugin-adapter-plan.md](archive/dsh-plugin-adapter-plan.md)。要查"当初为什么
这么定"再翻它；日常接线只看本文即可。
