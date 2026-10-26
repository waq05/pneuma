# 写一个 Pneuma 插件：从零到交付

给 Pneuma 写插件，产出的是一个独立文件或目录，不碰 Pneuma 自己的源码。这份文档是上手路径：先选形态、跑通一个最小的、再按速查表接扩展点，最后照自检清单交付。

需要完整签名、取值边界和内核内部约定时，看 [plugin-development.md](plugin-development.md)（规格书）；本文只给路径与速查，不重复它的细节。

| 想知道 | 去看 |
| --- | --- |
| 插件能挂哪些点、API 什么签名 | [plugin-development.md](plugin-development.md) |
| 从零跑通一个插件、装上去、验证、交付 | **本文** |
| 内核怎么装配、进程间协议是什么 | [development.md](development.md) |
| 每个服务是哪个插件提供的 | [development.md](development.md) 第 4 节 |

## 1. 先选形态

三种形态，按「要加什么」选：

| 要加的东西 | 形态 | 放哪 |
| --- | --- | --- |
| 工具、`/` 命令、事件监听、设置分区、技能来源 | 运行时插件（单文件 ESM） | `~/.dsc/plugins/<名字>.js` |
| 桌面界面里的一块（页签、面板、输入区组件） | 界面插件（`@dsc/ui` 契约） | `~/.dsc/plugins/<名字>/`（`plugin.json` + `ui/client.js`） |
| 已经在用的 dsh（DeepSeek Harness）插件 | 交给 `dsh-compat` 兼容层 | dsh 插件照原样放，装上 `dsh-compat` 即可 |

绝大多数需求落在第一种。界面插件要额外过契约版本门禁与首次信任，见第 6 节。

## 2. 十分钟跑通一个（运行时插件）

### 2.1 最小可运行

`~/.dsc/plugins/ping.js`：

```js
export const name = 'Ping'
export const description = '测试插件：注册 /ping 命令与 ping 工具'
export const inject = ['commands', 'tools']

export function apply(ctx) {
  ctx.commands.register(
    { name: 'ping', args: '', description: '测试外部插件（回复 pong）' },
    ({ ui }) => ui.notice('pong（来自外部插件 ping.js）'),
  )

  ctx.tools.register({
    name: 'ping',
    description: 'Ping the Pneuma host. Returns "pong".',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run() {
      return 'pong'
    },
  })
}
```

仓库里有一份同样的可跑样例：[examples/plugins/ping.js](../examples/plugins/ping.js)。

### 2.2 装上去

两种装法，二选一：

1. 把 `.js` 复制进 `~/.dsc/plugins/`，宿主启动时按文件名排序自动发现；
2. 在 `~/.dsc/config.yaml` 里声明路径：`plugins: [ "D:/dsc/examples/plugins/ping.js" ]`。相对路径按 `config.yaml` 所在目录解析。

插件目录可以用 `DSC_HOME` 指到别处，做隔离测试时不污染真实配置。

### 2.3 验证

- 会话里输入 `/plugins` 看清单，加载失败的条目会带原因；
- 输入 `/ping`，应弹一条 `pong`；
- 让模型调一次 `ping` 工具，看它拿到的是 `pong` 文本；
- 桌面端「插件」页确认条目在、停用开关可用。

### 2.4 迭代

改完文件**重新启用一次**就加载新代码（按文件 mtime 破模块缓存），不用重启宿主。停用是热卸载：`apply` 返回的清理函数会被立即调用，所以每个注册点都要把退订函数存下来。

## 3. 插件解剖

一个插件模块只靠模块级命名导出说话：

```js
export const name = '我的插件'            // 可选，管理页显示名（缺省 = 文件名去后缀）
export const description = '一句话描述'   // 可选
export const apiVersion = 2              // 可选，声明兼容的内核 API 版本
export const inject = ['tools', 'transcript']   // 声明依赖的服务

export function apply(ctx, config) {     // config = 条目树里该条目的 config 对象
  // 只能用 inject 声明过的服务：ctx.tools / ctx.transcript / ...
  const off = ctx.tools.register({ /* ... */ })
  return () => off()                     // 返回值 = disposer，停用时执行
}
```

四件事必须记住：`inject` 里没声明的服务在 `ctx` 上取不到；`apply` 的返回值是 disposer；模块顶层不要写有副作用的代码（加载时一定执行）；注册时都返回退订函数，统一在 disposer 里调用。

## 4. 扩展点速查

「我想做 X」对应下面哪一行；每条都给出签名形状与必须注意的那一点。

| 想做 | 调用 | 注意 |
| --- | --- | --- |
| 给模型一个工具 | `ctx.tools.register(entry)` | `risk` 必须如实标；`run` 返回文本 |
| 加一个 `/` 命令 | `ctx.commands.register(spec, handler)` | 用户可见反馈走 `ui.notice()` |
| 加设置分区 | `ctx.settings.registerSection(spec)` | 取值夹取要自己写 |
| 工具动手前拦一道 | `ctx.guards.register({ id, order, decide })` | 抛错按拒绝处理 |
| 改工具结果的呈现文本 | `ctx.guards.registerObserver({ id, order, observe })` | 只改文本，不改结果 |
| 往界面快照里加一块状态 | `ctx.surfaces.register(id, read)` | `id` 要在 `RuntimeSurfaces` 里有位 |
| 登记「正在等用户」 | `ctx.waiting.register(id, pending)` | 返回当前是否还在等 |
| 附加系统提示词 | `ctx.prompt.register(id, text, { order })` | 瞬态内容别放头部 |
| 改写发出去的请求体 | `ctx.prompt.registerProjection(id, fn, { order })` | 注入日志外内容必须记一条 note |
| 挂技能来源 / 市场源 | `ctx.skills.registerProvider(...)` / `registerMarket(...)` | rank 用 500 以上 |
| 监听 / 发布事件 | `ctx.on(name, fn)` / `ctx.emit(name)` | 自定义事件名带插件前缀 |
| 往会话里写一条系统消息 | `ctx.transcript.system(text)` | 这是给用户看的正道 |

### 4.1 注册工具

```js
const off = ctx.tools.register({
  name: 'my_tool',
  description: '给模型看的一句话；它据此决定调不调',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  risk: 'read',                    // 'read' 自动放行；'write' / 'exec' 过权限与审批
  async run(args, ctx) {           // ctx: { cwd, signal, sessionId, sessionPath }
    return '一行结论'
  },
})
```

`parameters` 是 OpenAI function 的 JSON Schema。`run` 返回字符串（原样交给模型），也可以返回 `{ text, images }` 带图片。失败直接 `throw`。

### 4.2 注册命令

```js
const off = ctx.commands.register(
  { name: 'my-cmd', args: '[名字]', description: '一句话说明', duringTask: 'deny' },
  ({ args, runtime, ui }) => ui.notice(`收到：${args.join(' ')}`),
)
```

`duringTask: 'deny'` 表示回合进行中不给用（缺省允许）。`ui` 上还有 `openPicker()` / `openModels()` / `openSettings()` / `toggleThinking()` 等界面动作，走它们不要自己画界面。

### 4.3 设置分区

`ctx.settings.registerSection({ id, title, fields, values, save, action })`，控件类型是 `text` / `number` / `select` / `switch` / `info` / `button`。分区 order 惯例：通用 0、模型 10、技能 20、关于 900。框架不做取值夹取，`save(key, value)` 里自己判（越界返回字符串即失败原因，返回 `void` 即成功）。

### 4.4 守卫与观察者

`decide` 只回三种：`{ action: 'deny', reason }`、`{ action: 'pass' }`、`{ action: 'defer' }`。order 是刻度，数字小的先跑：灾难地板 5、沙箱 8、协作模式 10、安全钩子 20、审批 30。你的守卫要用 `defer`（交给后面的环），不要用 `pass`（会把后面的环一起跳掉）。

### 4.5 提示词与请求投影

`ctx.prompt.register(id, text, { order })` 附加一段系统提示，order 刻度：身份 0、做事方式 10、工具规范 20、模式条款 30、插件贡献 60（缺省）、指令文件 200、技能目录 210、模型信息 890。多做「加一段稳定文本」，少做「每轮都变」。

`ctx.prompt.registerProjection(id, fn, { order })` 拿整份消息数组做纯变换，order 刻度 60（插件缺省）／500／550／600／900 各有内核占用者，`fold-system` 与 `drop-images` 是保留名。**投影塞了日志里没有的内容时，必须同时 `ctx.session.current().appendNote(id, text)` 记一条**，否则请求与日志对不上，运行时会报不一致。

### 4.6 事件

内核事件集中定义在 `src/services/types.ts` 的 `Events` 接口：`dsc/changed`、`dsc/notice`、`dsc/plan`、`dsc/session-open`、`dsc/exit`、`dsc/open-picker`、`dsc/open-models`、`dsc/dock-data`、`dsc/skills-changed`、`dsc/mode-changed`、`dsc/preset-changed`、`dsc/turn-start`、`dsc/turn-end`、`dsc/agent-status`、`dsc/compacted`。自己发的事件用 `dsc/plugin/<插件名>/<事件>` 这样的名字，避免撞车。

## 5. 配置、版本与回滚

配置不用自建文件，写进 `~/.dsc/plugins.json` 的条目树：

```json
{
  "version": 1,
  "entries": [{ "file": "my-plugin.js", "disabled": false, "config": { "greeting": "hi" } }]
}
```

`config` 会作为 `apply(ctx, config)` 的第二个参数传进来；停用开关就是 `disabled`。桌面端「插件」页改的就是这份。

`apiVersion` 是模块级导出，内核只拒绝**高于**自己的版本（当前 `KERNEL_API_VERSION = 6`）。声明高了会拒绝挂载并**自动写入停用**，管理页显示原因，升级 Pneuma 后重新启用即可；不声明视为兼容。

## 6. 写界面插件

界面插件的契约版本就是 `ui-shell/package.json` 的 `version`（当前 **1.2.0**），壳与插件之间靠 semver 区间对账。

- 目录形状：`~/.dsc/plugins/<名字>/` 下放 `plugin.json` 与 `ui/client.js`，`plugin.json` 的 `api` 字段必填；
- 首次安装要信任一次（`/ui-trust <插件目录名>`，或桌面端走原生桥的 `setUiTrust`），未信任不加载；
- 每个产物带一个 `rev`（内容摘要），内容变了 rev 就变，用来判断要不要重新下发；
- 具体契约（槽位、席位、服务面 `provide` / `consume`、平台种子包、分批与热更）见 [plugin-development.md](plugin-development.md) 第 10 节。

## 7. 交付前自检

1. `/plugins` 里条目在，没有 problem 标注；
2. 每个工具的 `risk` 与它实际做的事一致（只读 `read`，写文件 `write`，执行命令 `exec`）；
3. 每个注册点的退订函数都进了 disposer；
4. 停用再启用一次，功能照常且没有重复注册；
5. 不假设界面形态：用户反馈走 `transcript.system()` 或命令的 `ui.notice()`，不用 `console.log`；
6. `apply` 里不抛未捕获异常，出错写一条系统消息说清原因；
7. 声明了 `apiVersion` 的话，不高于内核版本；
8. 用了 `registerProjection` 且注入日志外内容时，配了 `appendNote`。

## 8. 常见坑

| 现象 | 原因 |
| --- | --- |
| `ctx.tools` 是 undefined | 服务名没写进 `inject` |
| 加载时宿主就报错 | 模块顶层有副作用代码，挪进 `apply` |
| 插件页看不到任何输出 | 用了 `console.log`，改成 `transcript.system()` 或 `ui.notice()` |
| 模型收到的工具结果是 `[object Object]` | `run` 返回了对象，改回字符串（或规范的 `{ text, images }`） |
| 写操作没经过审批 | `risk` 标成了 `read` |
| 停用后功能还在 | 没保存退订函数，热卸载时旧监听没卸掉 |
| 重新启用加载的还是旧代码 | 文件名没变时不换 key；改 mtime 或换文件名 |
| 运行时提示请求与日志对不上 | 投影注入了日志外内容却没 `appendNote` |

## 9. 参考

- 规格书：[plugin-development.md](plugin-development.md)（服务 API 全表、dsh 兼容层、界面插件契约）
- 可跑样例（`examples/plugins/`）：
  - `ping.js` —— 最小链路：一个命令加一个工具；
  - `settings-demo.js` —— 设置分区 + 虚拟技能来源 + 私有市场源；
  - `dsh-style-clock.js` —— 用 dsh 的工具形状注册，走 `dsh-compat` 并消费 `ctx.logger`；
  - `browser-control.js` —— 经 CDP 驱动浏览器，单工具按 action 分发，截图以图片返回；
  - `computer-use.js` —— 操控 Windows 桌面，演示图像返回。
- 挂载机制：[development.md](development.md) 第 3 节三档插件与第 4 节服务清单。
