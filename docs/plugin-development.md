# dsc 插件开发说明书

> **本文档的读者是 AI 编程助手**。当用户要求「给 dsc 写一个插件」时，先通读本文，
> 再按文末模板产出代码，并执行「交付前验证清单」。人类读者可直接跳到示例部分。

---

## 1. 插件是什么

dsc 采用「万物皆插件」架构：内核（cordis Context）只提供一组**服务**，所有能力
——内置工具、斜杠命令、模型路由、会话存储——都是向服务容器注册的插件。外部插件
与内核**零源码耦合**：一个独立 `.js` 文件，放进约定目录即被加载，不改动 dsc 任何源码。

**能做的扩展**：注册工具、注册 `/` 命令、监听并发布事件、消费全部内核服务、
维护插件自身状态与清理逻辑、声明 API 版本与元数据；往桌面端设置面板注册一个**设置分区**，
或往技能中心注册一个**技能来源 / 市场源**。
**做不到的**（当前版本边界，不要向用户承诺）：
- 不能注入自定义 React 组件、HTML 或 CSS。界面扩展只接受可 JSON 序列化的控件声明
  （`SettingsField`，见 §4.7），渲染由桌面端唯一的渲染器完成；TUI 不渲染插件分区；
- 不要尝试覆盖内置服务（cordis 允许 provide 同名服务，但该路径未经验证）。

## 2. 硬性规则（MUST / NEVER）

1. **MUST** 是单个 ESM `.js` 文件，使用命名导出（`export const inject` / `export function apply`）。
2. **MUST** 放在 `~/.dsc/plugins/`（或由 config.yaml `plugins: [...]` 显式声明路径）。
   加载顺序 = 目录内文件名排序；文件名即条目树的 key。
3. **MUST** 在 `inject` 数组里声明用到的全部服务名，且只使用 `ctx.<已声明服务名>`。
4. **NEVER** import dsc 内核源码或任何 dsc 依赖包（运行时零依赖；插件只拿到 `ctx`）。
5. **NEVER** 在模块顶层执行有副作用的代码（加载时顶层代码一定会运行；初始化写在 `apply` 里）。
6. **NEVER** 假设 UI 形态（终端 ink 或桌面端 Web）。任何用户反馈走 `transcript.system()`
   或命令的 `ui.notice()`；不要尝试 console.log 作为输出通道（桌面端不可见）。
7. **NEVER** 在 `apply` 里抛出未捕获异常；失败调用 `ctx.transcript.system('...')` 报告。
8. **MUST** 注册时保存退订函数，并在 `apply` 返回的 disposer 中全部调用（见示例 C）——
   **停用是热卸载**（disposer 会被立即调用，未清理的资源会泄漏）。
9. **MUST** 给工具声明正确的 `risk`：只读数据用 `'read'`（自动放行）；
   任何写文件 / 执行命令的行为用 `'write'` / `'exec'`（受权限模式与审批卡约束）。
10. **MUST** 工具 `run` 返回 `Promise<string>`——这段文本会被原样交给模型，请返回
    简洁、信息密度高的纯文本；失败直接 `throw new Error(...)`。

## 3. 插件解剖

```js
// ~/.dsc/plugins/my-plugin.js
export const name = '我的插件'            // 可选：管理页显示名（缺省 = 文件名去后缀）
export const description = '一句话描述'   // 可选：管理页描述
export const apiVersion = 2              // 可选：声明兼容的内核 API 版本（版本管理见 §3.1）
export const inject = ['tools', 'commands', 'transcript']  // 声明依赖的服务

export function apply(ctx, config) {     // config = 条目树里该条目的 config 对象（可为空）
  // ctx.<服务名> 在此可用（仅限 inject 声明的）
  // 返回值（可选）= disposer：插件停用/宿主退出时执行（热卸载会立即调用）
  return () => { /* 清理 */ }
}
```

### 3.1 条目树与配置（~/.dsc/plugins.json）

参照 dsh 的声明式装配。文件形状：

```json
{
  "version": 1,
  "entries": [
    { "file": "ping.js", "disabled": false, "config": { "greeting": "hi" } }
  ]
}
```

- `disabled`：停用开关（桌面端「插件」页切换的就是它）；不在 entries 里的文件默认启用。
- `config`：**透传给 `apply(ctx, config)` 第二参**——插件用它读自己的配置，不必再自建
  配置文件。取值统一走 `resolvePluginConfig('<file>', passed)`（`src/core/plugin-registry.ts:168`）：
  装配时那份作底，磁盘上这份覆盖它，所以设置分区保存后正在跑的插件下一次用值就是新值，不用重启宿主。
  读它的内置插件有 `compact`、`approval`、`ask`、`goal`、`prompt`、`host-stdio`，取值范围都带上下限夹取；十六个官方可开关插件（`subagent`、`computer-use`、`web-search`、`approval-floor`、`spill`、`session-search`、`lifecycle-hooks`、`mcp`、`tool-search`、`sandbox`、`file-review`、`schedule`、`lsp`、`browser`、`self-improve`、`dsh-compat`）也各读这一份，并把可调值挂进自己的设置分区。
- **启停热生效**：切换开关 → 内核卸载（调用 disposer）或重新挂载插件，无需重启宿主；
  文件内容变更后重新启用也会加载新代码（按 mtime 破坏模块缓存）。

### 3.2 版本管理（自动回滚）

内核有 API 版本号（当前 `KERNEL_API_VERSION = 6`）。插件声明 `export const apiVersion = 2`：
- 等于内核版本 → 正常挂载；
- **高于**内核（插件要求更新的内核）→ 拒绝挂载、**自动写入停用**（回滚到可用状态），
  管理页显示原因；升级 dsc 后重新启用即可；
- 未声明 → 视为兼容（向后兼容旧插件）。

| 内核 API | 内容 |
|---|---|
| 1 | 初始版本：工具、命令、事件、全部内核服务 |
| 2 | 新增 `settings` 与 `skills` 服务：设置分区、技能来源、市场源三个扩展点；桌面端设置面板与技能中心 |
| 3 | 新增请求组装扩展点：`ctx.prompt.register`（附加系统提示，带 order 刻度）与 `ctx.prompt.transformMessages`（改写发出去的请求体）；外部插件可用 `export const settingsSection` 声明自己的设置分区 id |
| 6 | 模型层两条缝：`ctx.llm.registerAdapter`（协议适配器 + 端点 `api` 字段 + `ctx.llm.stream` 派发）；`ctx.prompt.registerProjection`（命名纯投影，接替 v3 的匿名 `transformMessages`，内置 `fold-system` / `drop-images` 为保留名）；会话新增 `session.appendNote`（投影注入日志外内容必须落一条） |
| 4 | 新增三个内核扩展点：工具守卫链（`ctx.guards.register` / `registerObserver`）、快照片段（`ctx.surfaces.register`）、等人登记（`ctx.waiting.register`）；会话记录多一对按 id 存取的状态（`ctx.session.appendState` / `session.state`） |
| 5 | 新增一个可选服务 `sandbox`（当前档位、强制执行等级、可写根与路径判定；读它要用 `ctx.get('sandbox')`），并把「命令执行器缝」（`src/core/tools/command-runner.ts`，沙箱的容器后端换执行体用）开给随包发布的内置插件 |

`apiVersion = 1` 的旧插件在 v2 内核上照常挂载（判定只拒绝**高于**内核的声明），不用改代码；
但要用 §4.7 / §4.8 的扩展点就必须声明 `apiVersion = 2`。

### 3.3 AI 参与插件管理

内核内置 `plugin_manager` 工具（risk='write'，AI 调用会先经权限模式/审批卡）：
`list`（清单）/ `enable` / `disable`（热启停）/ `install`（安装本地 .js 绝对路径并热挂载）。
用户也可以在会话里输入 `/plugins` 查看清单。给 AI 的指引：安装第三方插件前先 `list`
确认没有同名文件；`install` 只接受绝对路径；版本不兼容的插件会被自动停用并在清单里
标注原因，此时应向用户说明而不是反复重试。

### 3.4 插件中心的三档：自定义 / 官方可开关 / 运行内核

桌面端「插件」页从上到下分三档，档位由插件元数据决定（`PluginMeta`，见 `dsc/src/core/plugin-registry.ts`）：

| 档位 | 判定 | 开关 |
|---|---|---|
| 自定义 | `source: 'external'`（`~/.dsc/plugins/*.js`） | 可拨，默认开 |
| 官方可开关 | `source: 'builtin'` 且 `toggleable: true` | 可拨，`defaultDisabled: true` 时默认关 |
| 运行内核 | `source: 'builtin'` 且没标 `toggleable` | 不给开关，页面只露 3 行，其余折叠 |

现有的十四个官方可开关插件：默认开的五个是 `web-search`（网页搜索）、`approval-floor`（审批灾难地板）、`spill`（大输出溢出）、`session-search`（会话全文检索）、`sandbox`（沙箱——不配就没有外部进程与外部服务器，且默认档 workspace-write 不挡正常的工作区读写）；默认关的九个是 `subagent`（智能体团队）、`computer-use`（电脑操作）、`lifecycle-hooks`（生命周期钩子）、`mcp`（MCP 客户端）、`tool-search`（工具渐进披露）、`schedule`（定时任务，到点会自己跑模型）、`lsp`（按需拉起语言服务器子进程）、`browser`（拉起浏览器进程并连调试端口）、`self-improve`（会写技能文件与提示词面）。各自干什么、默认开关按什么规矩定，见 development.md §4 那张表。

新增一档官方可开关插件要做的三件事：

1. 在 `dsc/src/host/kernel.ts` 的 `OFFICIAL_PLUGINS` 里登记元数据，带上
   `toggleable: true`、`settingsSection: '<分区 id>'`（该默认关的再加 `defaultDisabled: true`），
   并把插件对象填进同文件的 `OFFICIAL_OBJECTS`——少填这一处，内核装配时会直接跳过它，
   开关拨了也不挂载；
2. 插件如果要对外提供服务，在 `apply()` 末尾 `ctx.provide('<服务名>', {...})`；
   没有对外服务的（例如 `approval-floor`、`spill`）跳过这一步；
3. **不要**把这个可选服务写进 `inject`：插件关着时它不存在，写了 `inject` 会让整个挂载失败。
   别人（比如 runtime 的 `listTeammates`、tool-search 读 MCP 工具目录）要用 cordis 的
   `ctx.get('<服务名>')` 去读，读不到就是 `undefined`。直接写 `ctx.<服务名>?.` 也会被代理拦下抛
   `cannot get property "xxx" without inject`——`?.` 救不了，属性访问本身就先抛了。

配置存在条目树里（`writePluginConfig(file, patch)`）。只改配置值不会把插件点亮：
新建条目时沿用元数据声明的默认开关。

## 4. 服务 API 参考

以下签名来自 `dsc/src/services/types.ts` 与 `dsc/src/contract.ts`，是最准确的依据。

### 4.1 tools —— 注册供模型调用的工具

```ts
ctx.tools.register({
  name: string                              // 模型可见的工具名，全小写、稳定
  description: string                       // 模型据此决定何时调用，写清用途与返回值
  parameters: Record<string, unknown>       // JSON Schema（OpenAI function 格式）
  risk: 'read' | 'write' | 'exec'
  run(args: Record<string, unknown>, ctx: { cwd: string; signal: AbortSignal }): Promise<string>
}) => () => void                            // 返回退订函数
ctx.tools.list(): ToolEntry[]
```

要点：`parameters` 必须是合法 JSON Schema（`{ type: 'object', properties: {...} }`）；
`signal` 中止时尽快返回或抛错；**不要**在 run 里再向用户提问（用审批机制表达风险）。

**返回图像**（截图类工具）：返回 `{ text: string, images: ['data:image/png;base64,...'] }`
——消息以多模态 content 数组交给模型，**需要端点支持视觉**（如 GLM 视觉系列）；
纯文本端点会报错。参考 `examples/plugins/computer-use.js` 与 `browser-control.js`。

### 4.2 commands —— 注册斜杠命令

```ts
ctx.commands.register(
  { name: 'greet', args: '<名字>', description: '向某人问好' },
  ({ args, runtime, ui }) => {           // args: string[]；runtime: DscRuntime；ui 见下
    ui.notice(`你好，${args[0] ?? '朋友'}`)   // ui.notice(text) → 会话内灰色提示条
    // ui.openPicker()  → 请求打开会话选择面板（桌面端 / TUI 都会响应）
  },
) => () => void
ctx.commands.specs(): CommandSpec[]          // 全部命令（含内置），/help 与补全数据源
ctx.commands.run(input, runtime, ui): boolean // 派发一条 "/..." 输入（一般不需要直接调）
```

命令名小写、无 `/` 前缀；与内置命令同名会覆盖内置项（避免这样做）。

### 4.3 transcript —— 会话流（反馈用户的正道）

```ts
ctx.transcript.system(text: string)          // 追加一条 system 提示条目（最常用的反馈方式）
ctx.transcript.emit(event)                   // 折叠一条内核事件（CoreEvent）；插件慎用
ctx.transcript.getSnapshot(): RuntimeSnapshot // 读当前快照（entries/status/sessions…）
ctx.transcript.subscribe(listener): () => void  // 快照变化订阅（useSyncExternalStore 语义）
ctx.transcript.touch()                       // 手动失效快照缓存并通知 UI
```

### 4.4 llm —— 模型路由（只读为主 + 两条注册缝）

```ts
ctx.llm.provider / ctx.llm.model / ctx.llm.effort / ctx.llm.contextWindow   // 当前状态
ctx.llm.route(): LlmRoute               // { api, baseUrl, apiKey, model, maxTokens?, thinking? }
                                        // 注意：返回值含 apiKey，不要打印/落盘
ctx.llm.setModel(provider, model)       // 切换；端点/模型不存在时抛错
ctx.llm.setEffort('off' | 'low' | 'high' | 'max')
ctx.llm.listModels(): ModelChoiceView[] // [{ value: '端点/模型', provider, model, description }]

// 模型协议适配器（内核 API v6）：一种线上协议一份实现，端点在 config.yaml 里
// 用 `api: <id>` 选择。重复 id 抛错；返回卸载函数。
const off = ctx.llm.registerAdapter({
  id: 'my-protocol',
  async stream(request, handlers) {     // request: StreamRequest，handlers: { onDelta, onToolPrepare?, onRetry? }
    // 发请求 → 流式回调 handlers.onDelta('text'|'reasoning', piece)
    return { text, reasoning, toolCalls: [], usage, finishReason }   // StreamResult
  },
})
// 派发统一走 ctx.llm.stream(api, request, handlers)——循环/压缩/审批都从这条缝走
```

### 4.5 session / agent / approval / compact

```ts
ctx.session.current(): Session          // Session.meta: { id, cwd, createdAt }；Session.messages: 协议消息数组
ctx.session.open(filePath?: string): Promise<void>  // undefined=新建；传入 jsonl 路径=恢复
ctx.session.refresh(): Promise<void>    // 刷新会话列表缓存（ctx.session.sessions）
ctx.session.appendState(id, payload)    // 自己那块状态写进会话记录（见 §4.9 的键表）
ctx.session.current().state(id)         // 恢复会话时读回来；没写过就是 undefined

ctx.agent.followup(text: string)        // 以用户身份投递一条消息（触发完整 Agent 回合）
ctx.agent.interrupt()                   // 取消当前回合

ctx.approval.decide(request, signal): Promise<'allow-once' | 'reject'>  // 编程式审批
ctx.compact.run(): Promise<void>        // 手动压缩上下文
```

### 4.6 ui —— DscRuntime（与桌面端/TUI 同一接口）

`subscribe / getSnapshot / submit / interrupt / openSession / compact / setModel /
setEffort / refreshSessions / listModels / listPlugins / setPluginEnabled /
runCommand / answerApproval / exit / dispose`；
内核 API v2 另加技能与设置两批：`listSkills / readSkill / setSkillEnabled /
browseMarket / installMarketSkill / setMarketSources / getSettingsSections /
getSectionValues / setSettingValue / runSettingAction / getModelConfig /
saveProvider / removeProvider / setProviderKey / setDefaultModel`。
插件里通常用不到它（优先用 `agent` / `transcript`，改配置优先用 `settings` 服务）；
`exit()` 会结束宿主进程，务必只用于用户显式退出。

### 4.7 settings —— 往桌面端设置面板加一个分区

```js
const off = ctx.settings.registerSection({
  id: 'my-plugin-prefs',              // 导航键，建议 `<插件名>-<分区>`；内置 id 见下方规则
  title: '我的插件',                   // 左栏标题（插件贡献的分区会带上「插件」标记）
  subtitle: '轮询与同步设置',           // 可选：分区标题下的一行说明
  order: 30,                          // 小者在前；内置：通用 0 / 模型 10 / 技能 20 / 关于 900
  fields: () => [                     // 每次打开分区都调用；返回值必须能 JSON 序列化
    { type: 'switch', key: 'enabled', label: '启用轮询' },
    { type: 'select', key: 'interval', label: '间隔', options: [{ value: '60', label: '1 分钟' }, { value: '300', label: '5 分钟' }] },
    { type: 'text', key: 'webhook', label: 'Webhook', placeholder: 'https://…', mono: true },
    { type: 'number', key: 'retries', label: '重试次数', min: 0, max: 5 },
    { type: 'info', label: '数据目录', text: '/home/me/.dsc/cache/ping', mono: true, copyable: true },
    { type: 'button', action: 'sync-now', label: '立即同步', style: 'ghost' },
  ],
  values: () => ({ enabled: true, interval: '60', webhook: '', retries: 3 }),
  save: (key, value) => {             // 返回字符串或抛异常 = 失败原因，桌面端就地显示
    if (key === 'retries' && Number(value) < 0) return '重试次数不能是负数'
    state[key] = value
  },
  action: (name) => {                 // 按钮；返回字符串 = 完成后的提示文案
    if (name === 'sync-now') return `已同步 ${state.webhook}`
  },
})
return off                            // MUST 在 disposer 里退订
```

规则：
- 控件只有 `text` / `number` / `select` / `switch` / `info` / `button` 六种，样式由桌面端统一决定，
  别指望像素级控制，也不要塞 HTML；
- `fields()` 与 `values()` 每次打开分区都会调用，可随状态返回不同清单；
- `save()` 抛异常与返回字符串等价，都是一句就地错误（不会弹全局提示条）；
- 分区被停用时 disposer 执行完，分区立刻从左栏消失，用户已存的值不受影响；
- id 撞了内置的 `general` / `models` / `skills` / `about` 时，这个分区被忽略（设置面板里看不到），
  会话里会多一行系统提示说明原因，插件其余部分照常挂载；
- `custom: true`（界面由桌面端自己画）只给内置的「模型」「技能」分区用，
  插件请拆成几个普通分区，不要指望桌面端为你的分区写特判。

### 4.8 skills —— 挂一个技能来源或市场源

```js
const offProvider = ctx.skills.registerProvider({
  name: 'team-skills',                // 进 SkillInfoView.source，技能中心当成来源标记
  rank: 500,                          // 重名裁决：小者赢。内置目录占 100/200/300/400，插件用 500+
  list: (cwd) => [
    { name: 'deploy', description: '部署到测试环境', whenToUse: '用户说「部署」时', source: 'team-skills', rank: 500, modelInvocable: true, userInvocable: true, local: false },
  ],
  get: (name) => (name === 'deploy' ? { name, description: '部署到测试环境', content: '正文（Markdown）' } : undefined),
})
const offMarket = ctx.skills.registerMarket({
  name: 'internal',
  browse: async (refresh) => [{ name: 'deploy', description: '部署到测试环境', source: 'internal', installed: false }],
  install: async (name) => `已安装 ${name}（来自 internal）`,   // 返回一句给用户看的落点说明
})
ctx.skills.userDir                    // ~/.dsc/skills，技能中心「导入技能」的目标目录
ctx.skills.catalogText()              // 模型可见目录文本（只有名字 + 一句话说明）
return () => { offProvider(); offMarket() }
```

规则：
- `local: false` 的虚拟条目在技能中心只展示，没有启停开关（启停只对本地文件生效）；
- 来源清单变了要发 `ctx.emit('dsc/skills-changed')`，桌面端与模型可见目录都会重取；
- 正文会原样进入模型上下文，别塞密钥；描述写清「做什么 + 何时用」，模型据此决定是否调用。

### 4.9 guards / surfaces / waiting —— 内核的三个挂入点

内核 API v4 加的三个扩展点，外加会话记录里那一块自己的状态。共同点：`register(...)` 返回
退订函数，插件卸载就在下一次判定 / 下一次装配快照前生效；同 id 再注册算顶掉前一份。

```js
// 1) 工具动手之前拦一道。order 小的先问：灾难地板 5、协作模式 10、安全钩子 20、审批 30。
//    裁决三种：deny（当场拒，reason 原样回给模型）/ pass（免问直接执行）/ defer（问下一位）。
//    守卫自己抛错按 deny 处理——坏掉的闸门不该等于放行。
const offGuard = ctx.guards.register({
  id: 'my-plugin',
  order: 20,
  decide(input) {
    // input: { toolName, risk, cwd, args, target?, command?, signal }
    if (input.toolName === 'bash' && /sudo/.test(input.command ?? '')) {
      return { action: 'deny', reason: '这个插件不许代你跑 sudo' }
    }
    return { action: 'defer' }
  },
})

// 2) 改写工具的输出（进会话日志与回显之前）。内置刻度：密钥遮红 10、大输出溢出 50。
const offWatch = ctx.guards.registerObserver({
  id: 'my-plugin',
  order: 50,
  observe: (toolName, text) => text.replace(/秘密/g, '██'),
})

// 3) 界面快照里的一块状态投影：先在 contract.ts 的 RuntimeSurfaces 上声明合并这个键，
//    再来登记取值函数。装配快照的那一层不认识你的功能，它只问注册表要全部片段。
const offFace = ctx.surfaces.register('myPanel', () => ({ open: panelOpen }))

// 4) 有张卡片正挂着等用户点：登记一个「现在是否在等」的问法。
//    会话目标的自动续跑会看 ctx.waiting.any 刹车，免得卡片挂着没答就自己往下跑。
const offWaiting = ctx.waiting.register('my-plugin', () => panelOpen)
```

自己那块状态要跟着会话走，就写进会话记录（先在 `src/core/session.ts` 的 `SessionStateMap`
上声明合并这个键，`appendState` 与 `state()` 的类型才对得上）：

```js
ctx.session.appendState('myPanel', { open: true })   // 写一条 { type:'state', id, payload }
ctx.session.current().state('myPanel')               // 恢复会话时读回来
```

这四样都是**注册**，不是改内核：内置的协作模式闸门、审批卡、灾难地板、安全钩子、生命周期钩子、任务清单、计划评审、会话目标、密钥遮红、大输出溢出全都挂在这些点上，外部插件走同一扇门。

有些服务是可选的（插件关着时整个不存在，或者只在某些入口才登记），读它们只能用 `ctx.get('<服务名>')`，不能写进 `inject` 也不能用 `ctx.<服务名>?.`：`team`（智能体团队）、`mcp`（MCP 客户端）、`sessionSearch`（会话全文检索）、`approvalFloor`（灾难地板的只读视图，插件关着时不存在）、`interactive`（界面可达性，只有 tui 与 host-stdio 入口才登记）、`sandbox`（沙箱）、`lsp`（LSP 代码智能）。例如 tool-search 读 MCP 工具目录就是 `const mcp = ctx.get('mcp')`，读到 `undefined` 就当没接 MCP；审批插件读 `ctx.get('interactive')`，读到 `undefined` 且不是终端直连就当「没人能回答审批卡」。

### 4.10 prompt —— 附加系统提示与命名投影

```js
// 1) 附加系统提示（v3 起有）：每次组装请求时调用取文本；order 决定段次。
const offText = ctx.prompt.register('my-plugin', () => '我这段话每次都进系统提示', { order: 60 })

// 2) 命名投影（v6）：改写发给模型的消息。**必须是纯函数**——同一输入永远同一输出、
//    不碰注册表之外的任何状态。dsh 的「Model-visible ⟺ logged」不变量靠它成立：
//    模型看见什么 = 会话日志原文按 order 应用全部投影。
const offProj = ctx.prompt.registerProjection('my-plugin-prune', (messages) => {
  // 例：把过期截图从历史里裁掉
  return messages
}, { order: 60 })   // 内置刻度：插件投影 60（缺省）、fold-system 500（多条 system 并进头部）、drop-images 900（模型没勾照片时兜底）

// 3) 投影往请求里**加**日志上没有的内容时，必须同时落一条 note：
ctx.prompt.registerProjection('my-inject', (messages) => {
  const extra = takePending()
  if (extra === '') return messages
  ctx.session.current().appendNote('my-inject', extra)   // 没有这条，模型看到的东西就没法从日志重建
  return [...messages, { role: 'system', content: extra }]
})
```

规则：`fold-system` / `drop-images` 是内核保留名，同名注册直接报错；投影抛错时这一轮
跳过它并发一条通知，不拖垮请求；`transformMessages`（v3 的匿名改写）已移除，迁移就是把
函数换成命名投影。

## 5. 事件

`ctx.on(事件名, 处理器)` 监听、`ctx.emit(事件名, 载荷)` 发布（插件可发布自定义事件，
命名建议 `dsc/plugin/<插件名>/<事件>` 避免冲突）：

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `dsc/changed` | — | 任何影响快照的状态变化后 |
| `dsc/notice` | `(text: string)` | 请求写一条 system 条目 |
| `dsc/session-open` | `({ session, filePath })` | 会话已切换（filePath=undefined 表示新建） |
| `dsc/exit` | — | 请求收尾；监听器须同步执行 |
| `dsc/open-picker` | — | 命令请求打开会话选择面板 |
| `dsc/skills-changed` | — | 技能清单或启停状态变化（桌面端技能中心据此重取） |
| `dsc/mode-changed` | `(mode: CollaborationMode)` | 协作模式换档（含启动时那一次）。审批卡据此在卡上写当前档位，不必反过来问模式服务 |
| `dsc/turn-end` | `(reason: 'completed' \| 'aborted' \| 'error')` | 一个回合结束。只有 `completed` 会触发会话目标的自动续跑 |
| `dsc/plan` | `(plan: PlanView)` | 计划交付卡的内容有变（写出来、被批准或被驳回） |

## 6. 示例

> **综合参考**：`examples/plugins/browser-control.js`——外部插件里最长的一份：单工具 `browser`
> 按 action 分发、自己起受控浏览器子进程、经 CDP 的 WebSocket 收发、截图以图像返回模型，
> 带私有状态与卸载清理。要写「拉外部进程 + 返回图像」这类插件先读它；同类参照还有
> `examples/plugins/computer-use.js`（PowerShell 驱动 Windows 桌面）。
>
> **界面扩展参考**：`examples/plugins/settings-demo.js`——一个插件同时注册设置分区
> （含 switch/select/text/button）、一个虚拟技能来源、一个私有市场源。

### A. 最小命令插件（消费条目树 config）

```js
export const inject = ['commands']
export function apply(ctx, config) {
  const greeting = (config && config.greeting) || '你好'
  const off = ctx.commands.register(
    { name: 'roll', args: '[面数]', description: '掷一个骰子' },
    ({ args, ui }) => {
      const faces = Number(args[0]) || 6
      ui.notice(`${greeting}：🎲 ${1 + Math.floor(Math.random() * faces)}`)
    },
  )
  return off
}
```

对应条目树：`{ "file": "my-plugin.js", "disabled": false, "config": { "greeting": "嗨" } }`。

### B. 工具插件（带 JSON Schema 与风险分级）

```js
export const inject = ['tools']
export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'word_count',
    description: '统计一段文本的字符数与词数。需要统计长度时使用。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要统计的文本' } },
      required: ['text'],
    },
    risk: 'read',
    async run(args) {
      const text = String(args.text ?? '')
      return `chars=${text.length} words=${text.split(/\s+/).filter(Boolean).length}`
    },
  })
  return off
}
```

### C. 事件监听 + 状态维护 + 清理

```js
export const inject = ['transcript', 'session']
export function apply(ctx) {
  const openedAt = new Map()                       // 插件私有状态
  const offSession = ctx.on('dsc/session-open', ({ session, filePath }) => {
    openedAt.set(session.meta.id, { at: Date.now(), resumed: filePath !== undefined })
    ctx.transcript.system(`[my-plugin] 会话 ${session.meta.id.slice(0, 8)} 已就绪`)
  })
  const offNotice = ctx.on('dsc/notice', (text) => { /* 按需响应 */ })
  return () => {                                   // 停用/退出时必须清干净
    offSession()
    offNotice()
    openedAt.clear()
  }
}
```

### D. 界面扩展：设置分区 + 技能来源 + 私有市场源

完整可运行版本见 `examples/plugins/settings-demo.js`。骨架：

```js
export const name = '设置与技能示例'
export const description = '演示设置分区、技能来源、市场源三个扩展点'
export const apiVersion = 2
export const inject = ['settings', 'skills', 'transcript']

export function apply(ctx, config) {
  const state = { ...(config ?? {}), enabled: true, interval: '60', note: '' }

  const offSection = ctx.settings.registerSection({
    id: 'settings-demo-prefs',
    title: '示例插件',
    subtitle: '演示：控件声明由桌面端渲染，值存在插件里',
    order: 30,
    fields: () => [
      { type: 'switch', key: 'enabled', label: '启用', help: '关掉后技能来源不再贡献条目' },
      { type: 'select', key: 'interval', label: '轮询间隔', options: [{ value: '60', label: '1 分钟' }, { value: '300', label: '5 分钟' }] },
      { type: 'text', key: 'note', label: '备注', placeholder: '随便写点什么' },
      { type: 'button', action: 'reset', label: '恢复默认', style: 'ghost' },
    ],
    values: () => ({ enabled: state.enabled, interval: state.interval, note: state.note }),
    save: (key, value) => {
      if (key === 'interval' && !['60', '300'].includes(String(value))) return '间隔只能是 1 分钟或 5 分钟'
      state[key] = value
    },
    action: (name) => {
      Object.assign(state, { enabled: true, interval: '60', note: '' })
      ctx.emit('dsc/skills-changed')
      return '已恢复默认'
    },
  })

  const offProvider = ctx.skills.registerProvider({
    name: 'settings-demo',
    rank: 500,
    list: () => (state.enabled ? [{ name: 'demo-skill', description: '演示技能：说明写清做什么', whenToUse: '用户说「演示一下」时', source: 'settings-demo', rank: 500, modelInvocable: true, userInvocable: true, local: false }] : []),
    get: (name) => (name === 'demo-skill' ? { name, description: '演示技能', content: '# 演示技能\n\n正文由插件返回，会进入模型上下文。' } : undefined),
  })

  const offMarket = ctx.skills.registerMarket({
    name: 'settings-demo',
    browse: () => [{ name: 'demo-skill', description: '演示技能', source: 'settings-demo', installed: false }],
    install: (name) => `演示源不落地文件，直接用「技能」页的开关启用（${name}）`,
  })

  return () => { offSection(); offProvider(); offMarket() }
}
```

## 7. 交付前验证清单（AI 必须逐项执行）

1. **语法**：`node --check <文件>`（若报 "Cannot use import statement"，见 §8 首条）。
2. **安装**：把文件放进 `~/.dsc/plugins/`（或让用户走桌面端「+ 添加插件」）。
3. **加载**：重启宿主（桌面端插件页右上角电源按钮）。若加载失败，宿主会写
   system 条目「外部插件加载失败（…）：…」——修好再继续。
4. **功能**：命令插件 → 让用户输入 `/<命令名>`；工具插件 → 在对话里诱导模型调用并确认
   结果返回；事件插件 → 触发对应场景（如切换会话）。
5. **展示**：桌面端「插件」页确认 name/description 出现且开关可用。
   注册了设置分区 → 打开左栏「设置」，确认分区在左栏列出（带「插件」标记）、控件能读写、
   校验失败时错误就地显示；注册了技能来源 → 打开「技能」页，确认条目带来源标记且 `/技能名` 能调用。
6. **清理**：临时测试文件删除；若插件不应保留，移除文件并重启宿主。

## 8. 常见错误

| 症状 | 原因与修法 |
|---|---|
| 加载报 "Cannot use import statement outside a module" | 运行环境过旧、未启用 module 语法探测。在插件文件同目录放 `package.json` 内容 `{"type":"module"}`，或改写为 CommonJS（`exports.apply = ...`） |
| 插件没被加载 | 文件不在 `~/.dsc/plugins/`；后缀非 `.js`；条目树里 `disabled: true`；宿主未重启（目录里**新放入**的文件需重启或用 plugin_manager 工具 install） |
| 管理页显示 ⚠ 版本不兼容 | 插件 `apiVersion` 高于内核；升级 dsc，或把插件 `apiVersion` 降到当前内核版本 |
| `ctx.tools` 等是 undefined | 忘了在 `inject` 里声明该服务 |
| 控制台刷 `cannot get property "xxx" without inject` | 那是可选服务（插件关着时不存在）。别把它写进 `inject`，读它的人改用 `ctx.get('xxx')`；`ctx.xxx?.` 不算，属性访问就先抛了 |
| 桌面端看不到任何输出 | 用了 console.log；反馈必须走 `transcript.system` / `ui.notice` |
| 模型从不调用你的工具 | description 太弱或 parameters 不是合法 JSON Schema；name 要让模型望文生义 |
| 设置分区/技能来源没出现 | `inject` 里忘了声明 `settings` 或 `skills`；或分区 id 撞了内置的 `general/models/skills/about`（该分区被忽略，会话里有一行提示） |
| 设置分区里控件点不动、值不回填 | `values()` 返回的 key 和 `fields()` 里的 `key` 对不上；或 `values()` 返回了不能 JSON 序列化的对象（函数、Date） |
| 技能中心有条目但 `/名字` 调不动 | 条目 `userInvocable` 为 false，或名字撞了内置命令（new/resume/compact/model/help/exit/effort/plugins/skills） |
| 写入类工具绕过审批直接执行 | risk 误标为 `'read'`——写文件/执行命令必须是 `'write'`/`'exec'`（权限模式 readonly 下一律拒绝） |
| 插件被启用但行为还是旧的 | 文件变更后需重新停用→启用（或重启宿主）以触发重载 |

## 9. dsh 兼容层（挂载 DeepSeek Harness 的插件）

> 本节是速查；**逐插件的判定流程、API 映射表与实测坑见
> [dsh-plugin-porting.md](dsh-plugin-porting.md)（dsh 插件适配指南）**。

dsh（DeepSeek Harness）的外部插件与 dsc 同为 cordis 模块插件（命名导出 `inject`/`apply`），
cordis 版本一致，所以**一部分 dsh 插件可以直接挂到 dsc 上跑**。开关是官方可开关插件
「dsh 兼容层」（`dsh-compat`，默认关——它会改变外部插件的模块解析与工具注册行为，
按「拉起外部机制的默认关」的规矩走）。

### 9.1 支持范围

| dsh 插件用到 | dsc 兼容层给什么 |
|---|---|
| `inject: ['tools']`，`ctx.tools.register(defineTool({...}))` | 直接支持：ToolDefinition 转成 dsc 工具条目——参数 schema（defineTool 编译出的 JSON Schema）原样透传、`execute(args, exec)` 的 `exec.signal` 对应 dsc 取消信号、模型可见内容由 `output.render` 折成文本、`timeoutMs` 到点放弃等待 |
| `inject: ['logger']`，`ctx.logger.warn/error(...)` | 直接支持：cordis 内置 logger 管道 + 桥，warn/error 镜像进对话流（`[dsh 插件·名字]` 前缀），info/debug 不落地 |
| `export const Config = z.object({...})`（schemastery） | 挂载时调用一次做配置校验，失败响亮回滚（提示检查 plugins.json 的 config） |
| `inject` 里出现 `sessionProjections` / `agents` / `goals` / `systemPrompt` 等 | **不支持**：这些要整个 dsh 会话语义，挂载被拒绝并列出缺的服务名 |

`defineTool`、`z`、`@deepseek-ai/cordis` 这些 `@deepseek-ai/*` 导入不用装——兼容层把插件
目录里的这类导入重定向到 dsc 自带的 `@deepseek-ai/dsh-tools`（精确 pin 的 0.2.0-rc.2）与
cordis（保证单实例）。**cordis 版本必须两边一致**，升级 dsc 依赖时留意。

### 9.2 risk 映射（dsh 没有这个概念）

dsh 工具没有 risk 分级；转进 dsc 后缺省 `risk: 'exec'`（每次调用都过审批卡，宁多问不漏问）。
想放宽，在插件条目配置里写（`~/.dsc/plugins.json` 该条目的 `config`）：

```json
{ "file": "dsh-some-tool.js", "disabled": false, "config": { "risk": "read", "risks": { "dsh_echo": "read", "dsh_deploy": "write" } } }
```

`risk` 是这份插件全部工具的缺省，`risks` 按工具名覆盖；每次注册现读，改完重新启用插件即生效。

### 9.3 装一个真实的 dsh 插件

```sh
# dsh 插件是 npm 包时：把它的依赖连同本体装进插件目录（npm ≥7 会自动装 peer 依赖）
cd ~/.dsc/plugins && npm install <dsh 插件包>
# 然后在 config.yaml 的 plugins 段声明入口（包的 lib/index.js），或复制成单文件
```

自包含的 dsh 风格插件见 [examples/plugins/dsh-style-clock.js](../examples/plugins/dsh-style-clock.js)；
兼容层的自检（解析钩子、工具兼容面、logger 桥、不支持项拒绝）跑 `node shots/dsh-compat-check.mjs`。

---

## 10. 界面插件（`@dsc/ui` 契约）与版本纪律

宿主插件（上文 1–9 节）扩展**内核**；界面插件是另一条体系：一个 CJS bundle（构建产物外裹
`(globalThis.__DSC_UI_FACTORIES__ ??= {})[id] = function (require, module, exports) {…}`），
`apply(ui)` 里往槽位注册表登记组件，由浏览器壳或终端壳装载。两条体系版本独立、并存不合并。

### 10.1 契约版本与门禁

- 界面插件面对的契约是 **`@dsc/ui`**（壳的导出面 + 槽位语义 + 清单字段含义），契约版本从
  **1.0.0** 起（`ui-shell/package.json` 的 version，构建时写进 `lib/ui/plugins/manifest.json`
  顶层 `apiVersion`）。
- 第三方界面插件**必须**声明自己对着哪个区间（`plugin.json` 的 `api` 字段，semver，如
  `^1.0.0`）。宿主在组启动图时做 `satisfies(壳版本, 区间)` 判定：不满足就**不进启动图**，
  原因（「插件 X 要求 @dsc/ui ^2.0.0，当前壳 1.0.0，已跳过加载」）进诊断区。判定在宿主侧，
  浏览器产物里没有 semver。
- `workspace:` 前缀与非法区间一律拒绝——**请写具体版本区间**，没有「等于当前」的猜法。
- 豁免通道第一期不做。

### 10.2 升级纪律（壳作者遵守；插件作者按它写区间）

| 改动 | 版本动作 |
| --- | --- |
| 删导出、改导出语义、改槽位 options 形状、改 `inject`/清单字段含义 | **主版本 +1** |
| 纯增量（新导出、新槽、新可选字段） | 次版本 +1 |
| 修 bug 不改形状 | 补丁 +1 |

插件作者按此写区间：只用旧能力写 `^1.0.0`；用上新能力再抬下限。区间写宽了在语义变更的
大版本里会「加载成功但行为不对」——这正是门禁防的事，区间别写宽。

### 10.3 第三方界面插件：目录形状、信任与 rev

**装在哪**：`~/.dsc/plugins/<目录名>/`（宿主插件与界面插件同住一个目录）：

```
~/.dsc/plugins/demo-greeter/
  plugin.json     ← { "api": "^1.0.0", "platforms": ["web", "tui"], "phase": "early" }（api 必填）
  ui/client.js    ← 界面半边（CJS 工厂，注册名必须等于目录 id）
```

最小可抄的例子在 [examples/ui-plugin-demo/](../examples/ui-plugin-demo/)（手写 CJS，无需构建工具；
正式开发用打包器按同样的包装形状产出）。

**首次安装的信任确认**：发现新目录后宿主**不装载**，会话流里出现「还没有信任记录」提示；
用 `/ui-trust <目录名>` 确认——它会摊开这个插件声明对着哪个契约版本、跑在哪种壳、能调什么
（界面通道白名单方法 + 桌面窗口的原生桥），答一次落盘（`plugins.json` 顶层 `uiTrust` 段），
不是每次问。停用与宿主插件同格：`plugins.json` 的 `entries` 里写
`{ "file": "demo-greeter/ui/client.js", "disabled": true }`。

**产物复核（rev 的语义）**：内置与第三方插件的 rev 都是**内容摘要**（内置 sha256 前 12 位、
第三方前 16 位）：字节没变地址就不变（重新构建、touch 文件都不会换地址），字节一变 rev 必变，
旧页面的旧地址拿旧字节、新地址拿新字节。宿主换代时只保留**上一代**（单资源与批 combo 各一份），
更早的地址刷新页面即可。

### 10.4 chain 槽与壳内置平台层（1.1.0 起可用）

**chain 槽**：第四种槽形态，「条目自己选举」。声明方把它开成子槽（`children: { 'xxx.yyy': 'chain' }`），
渲染方对每一份 owner 值问一遍链上的登记：按 `priority` 升序逐个调 `select(owner)`，
第一个**不返回 null** 的当选——返回值原样交给组件的 `matched` prop；全体弃权时渲染方画兜底。
注册语法：`ui.slots.register(slot, { id, priority, select: (owner) => ... }, component)`——
**select 必填**，且必须是纯函数（只读 owner、不碰外部状态）。同 priority 多条并存合法（按注册序排队）。

内置例子：消息流插件声明 `transcript.toolview`（chain），内置工具卡是链上一条
catch-all（priority 100）。想接管某类工具卡的渲染：往这个槽注册一条 priority 更小、
`select` 只认领自己那类工具的登记即可，认领范围外返回 `null` 让给后面。

**壳内置平台层（仅 web 值面）**：`@dsc/ui` 从 1.1.0 起额外导出四件壳内置实现，
供界面插件直接用、**不必也不许**自带这些重依赖（平台模块表里没有它们）：

| 导出 | 用途 |
| --- | --- |
| `highlightLines(code, path)` | 按扩展名把一段代码高亮成逐行 token HTML（shiki 双主题 CSS 变量；无语法/超限返回 null） |
| `CodeView` | 代码视图组件（装语法期间纯文本回落、超限截断、`targetLine` 行号定位） |
| `MarkdownView` | markdown 渲染（react-markdown + gfm；代码块 shiki；传 `fsRead` 解析相对路径图片） |
| `PdfView` | PDF 逐页渲染（吃 fs-read 的 base64，≤50 页） |

终端壳（TUI 载体）的 `@dsc/ui` 不导出这四件——它们是 DOM 组件；双载体插件里请先判
`ui.host.platform` 再引用。

### 10.4.1 平台种子：可以按包名 require 的基元包（1.2.0 起）

除了 `@dsc/ui`，壳还把三个基元包作为**平台种子**下发（web 载体）。插件 bundle 里对它们的
引用由壳提供：构建期保留成 `require('@dsc/ui-primitives')` 这样的外部请求，运行期从壳的
模块表取——拿到的是**与界面壳内部同一份实例**。所以插件**不许也不必**自带这几个包的实现
（内联一份不只是体积问题：完成音、toast、确认框、右侧栏状态都带模块级状态，两份会各说各话）。

| 包名 | 里面有什么 |
| --- | --- |
| `@dsc/ui-primitives` | 图标集、`Select`、`Text`、文件图标、`DiffRows` / `CodeView` / `MarkdownView` / `PdfView` / `CsvView` / `XlsxView`、时间与 token 格式化、工具摘要口径、toast / confirm、面板几何 |
| `@dsc/ui-slots` | 槽名契约（`SLOT` / `SHELL_SLOTS`）与槽位的 React 渲染出口（`SlotOutlet` / `ChainOutlet`） |
| `@dsc/ui-dockkit` | 右侧栏的模型与状态（`useDockSurface` / `dockActions` / `registerDockTab` 等所在的那一套） |

边界（三条，别越）：

1. **仅 web 值面**：终端壳（TUI）的模块表里没有这三个包——双载体插件在值面上引用它们之前
   先判 `ui.host.platform`；只在类型面引用不会产生 require。
2. **`@dsc/ui-core` 不在种子里**（故意）：它是壳的内部实现，插件当值引用会得到
   「白名单外的模块」那句错；插件要的能力都经 `@dsc/ui` 或上面三个包给。
3. **类型面**：本仓库内置插件按源码即类型直接用；第三方 TS 作者今天没有随 SDK 发布的
   `.d.ts`（与 `@dsc/ui` 一样），按 JS 写、类型自备。

写法上两者等价、取向不同：`@dsc/ui` 是**聚合面**（少量重依赖与图标经它转出，老插件照旧
可用），按包名 require 是**按需取整包**（想用 `Select` 就写 `@dsc/ui-primitives`，语义直白）。

### 10.5 类型化槽位契约（1.2.0 起可用）

壳与插件用 **`declare module '@dsc/ui'`** 往一张槽位契约表 `SlotMap` 上并键（表声明在
`@dsc/ui` 本体里，插件 import 的就是它；`declare module` 的合并只认这个模块本身，别的
路径 re-export 不算）：

```ts
declare module '@dsc/ui' {
  interface SlotMap {
    // 你自己开出来的子槽：owner 是渲染方在 renderSlot 调用点传的 props，matched 是
    // chain 选择器的返回值类型。
    'myplugin.card.footer': { kind: 'list'; owner: { entry: MyEntry } }
  }
}
```

并上之后：

- `ui.slots.register(槽名, options, 组件)` 的槽名、`children` 的键与形态、keyed 的 `key`、
  chain 的 `select` 参数与返回类型全部从表里推——**写错在调用点就编不过**；
- 组件 props 用 `SlotComponentProps<Owner, ChildKeys, Matched, Store>` 声明，框架注入的
  `renderSlot` / `childSlots` / `renderFactorySlot`（以及席位的 `useStore`/`actions`）都在里面，
  自定义 owner 与 matched 直接并进顶层；
- 未声明过 `children` 的组件调 `renderSlot('某个槽')` 是编译错误；对子槽传错 owner props
  也是。运行期行为不变（拼错的名字仍当场抛装配错误）。

升级提示：1.2.0 把 `UiComponent` 从 `ComponentType<any>` 收窄成裸调用签名，**只影响类型面**——
零参组件与声明了 props 的组件都不需要改代码。

### 10.6 服务面：`provide` / `consume` 与 `inject` 双关（1.2.0 起可用）

插件之间共享对象走 **服务表**：

```ts
const seat = defineStore({ init: () => ({ list: [] }), actions: { setList(draft, list) { draft.list = list } } })
ui.provide('teammates', seat)          // 一个名字只能有一个提供者，重名当场抛装配错误（带两个插件 id）
const got = ui.consume<typeof seat>('teammates')   // 缺席给 undefined（软依赖）
```

- **硬依赖**写进 `plugin.json` 的 `inject: ["…"]`。这个名单是**双关**：先按「清单里另一个
  插件的 id」解（拓扑排序用的也是它），再按「服务名」解（服务表里有没有提供者）。两条路都
  解不到时插件**不 apply**，诊断区/会话流里留一行中文原因（「插件 X 没装上：…」或
  「服务 X 还没有提供者」）——等提供者装上后装载器会重试一轮。
- 想在**渲染期**跟着服务的出现/消失换数据源（例如提供者被停用），用 `useService<T>(name)`
  （React hook，缺席给 `undefined`；服务表出现变化会唤醒组件）。

### 10.7 席位：跨插件共享一份状态（1.2.0 起可用）

```ts
// 提供方：handle 在 apply 里现建（不许模块级——模块缓存会让它变成跨重载的伪单例）
const mates = defineStore({ init: () => ({ list: [] }), actions: { setList(draft, list) { draft.list = list } } })
ui.provide('teammates', mates)
ui.slots.register(SLOT.header, { id: 'team.toggle', store: mates }, TeamButton)

// 消费方：拿到 handle 后读同一份共享实例
const seat = useService<typeof mates>('teammates')
const instance = seat === undefined ? undefined : ui.slots.seat(seat)   // 该 handle 已有登记才给实例
const list = useSeat(instance, (state) => state.list)                  // 缺席给 undefined，自行回落
```

- 席位的**身份就是 handle 对象**：同一个 handle 的多个登记共享一个实例；实例在第一次渲染
  读时懒建，最后一个持有者卸载时释放。没有字符串键，也就没有「同名冲突」——冲突落在
  `provide` 重名上。
- 组件面：登记时给了 `store` 的条目，props 多出 `useStore(selector, isEqual?)`（读）与
  `actions`（写，draft 已烘掉）；`actions` 是唯一的写路径。
- 引擎口径：action 收到的是**顶层浅拷贝**，写嵌套字段请整体替换
  （`draft.list = [...draft.list, item]`），不要原地改嵌套对象。
- TUI：`ui.slots.seat` 与 `defineStore` 两壳一致；浏览器壳与终端壳都支持。

### 10.8 Component Factory：一份装配、多个父位置（1.2.0 起可用）

一份定义、若干**无关的父位置**各自渲染一次 occurrence，父按 occurrence 选局部组件：

```ts
// 定义方（写在 SlotFactoryMap 里声明形状，registerFactory 时组件 props 全按它校验）
declare module '@dsc/ui' {
  interface SlotFactoryMap {
    'myplugin.card': {
      props: { entry: MyEntry; variant?: 'main' | 'embedded' }
      slots: { header: { props: { title: string } } }   // 局部位置：父按 occurrence 选组件
      children: { 'myplugin.card.footer': 'list' }      // 普通子槽：任何插件可注册
    }
  }
}
ui.slots.registerFactory(
  { name: 'myplugin.card', children: { 'myplugin.card.footer': 'list' }, slots: { header: {} } },
  CardDefinition,
)

// 定义内部：没被选中的局部位置用 fallback 组件
function CardDefinition(props: FactoryComponentProps<'myplugin.card'>) {
  const Header = props.useFactorySlot('header', PlainHeader)
  return <>{props.renderSlot('myplugin.card.footer', {})}<Header title="…" /></>
}

// 父（任何有渲染能力的地方：条目组件 props.renderFactorySlot）
props.renderFactorySlot('myplugin.card', { entry }, {
  slots: { header: FancyHeader },
  fallback: null,   // 定义还没注册时画它（保险丝）
})
```

- 定义缺席渲染 `fallback`；`slots` 里出现没声明的局部位置、或定义递归渲染自己，都是
  **装配错误**（当场抛，不静默降级）；Factory 里的组件崩溃只记一条故障（诊断区可见），
  **不摘除共享定义**。
- 真实例子：`transcript.tool-card` 由消息流插件注册，对话页与轨迹页各自渲染——对话页选
  intended 预览 / 中文耗时 / 「将做的改动」/「在轨迹中查看」四件局部组件，轨迹页只选轨迹
  口径的耗时；两边共用同一份 head/body 骨架，第三方还可以往 `transcript.toolcard.footer`
  注册一行（`examples/ui-plugin-demo` 就是例子）。
### 10.9 启动分批、批取数与本页热更（1.2.0 起可用）

**`plugin.json` 的 `phase`**（内置插件写在目录里的可选 `plugin.json`，第三方写在自己的
`plugin.json`）：

| 取值 | 含义 |
| --- | --- |
| `early` | 首屏批：壳**装完这一批才画第一帧**。给输入区、状态栏这类「第一眼就要在」的插件。 |
| `application`（缺省） | 其余全部：首帧之后的空闲时刻才取字节、才 apply。 |

两条纪律：

1. **早期批要尽量小**——它的取数挡在首帧前面（一个批一次请求，见下），塞进三个以上插件
   就失去意义了。内置的 `composer` 与 `statusbar` 声明为 early，其余 14 个是 application。
2. **phase 是页面加载级的**：本页热更（改文件）不会改一条插件的 phase，改 phase 要刷新页面。
   写坏取值的方向：内置插件 = **构建失败**；第三方 = 记一条问题、按 application 处理（不进
   `early`，也不整条丢弃）。

**批取数（combo）**：一个批是**一条** `/plugins/??<id>/client.js,…&rev=<批 rev>` 请求
（不是每插件一个 `<script>`）。组合的成员集合只能来自宿主的产物表，未通告的地址一律 404；
批取数失败按「批 → 该行单资源」回退，一条缺失的插件最多花三次请求（批×2 重试 + 单资源×1），
且**绝不重放已经执行过的批**。可观测口径：一次页面加载的插件请求数 =
`globalThis.__DSC_UI_BOOT_STATE__.requests` 里 `/plugins/` 条目的条数（诊断区「批次」行画出
每批状态与 rev）。

**本页热更（HMR）**：开发态下宿主轮询插件产物（默认 500ms），字节真的变了才推一帧
`event: plugins`（`{rev, changed, removed, graph}`）；壳按 rev 只换装变了的那些插件，**不刷
整页**。口径：

- 插件内的 React 状态随换装丢失（重新 apply、重新挂载）；会话/工作区/连接这些数据层状态保留；
- 换装失败**不回滚**：旧条目已卸载、新条目没装上，诊断区出现「页内同步失败」+ 一条重试入口
  （对同一 rev 也可重试）；失败只影响这个页面，不动宿主的启停开关；
- 插件自己插入的 `<style>` 要在 apply / 首次渲染期间插（物化边界会给它打上归属标记），
  换装时整份剔除；**不要**依赖别的插件或壳未打标的全局样式，也不要往 `document.head`
  里挂长期存活、带外部引用的东西（换装不会替你收拾它）。

默认开关：**打包态关**（`lib/ui/plugins` 是只读产物）；开发/自检态（宿主以
`DSC_UI_SERVER=1` 起来，如 `scripts/_ui-shell-serve.mjs`）默认开；`DSC_UI_HMR=1` 强开、
`DSC_UI_HMR=0` 强关，间隔用 `DSC_UI_HMR_POLL_MS` 调。
