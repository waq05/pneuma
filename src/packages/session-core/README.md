# session-core（会话核心库）

一句话：钩子、上下文压缩、系统提示词装配、ReAct 循环与协作模式五块会话底座，被十个功能包共用同一份实现。

## Model Experience（模型体验）

- 库包自己不注册工具、不写设置项、不挂生命周期；五个模块只导出函数、类与常量（index.ts:1-27）。
- 模型每轮看到的系统提示词由 `prompt.ts` 按固定段号装配：稳定的段在前、易变的段在后，服务端提示缓存才能一直命中（prompt.ts:1-21）。
- 上下文估算超过阈值时，`compact.ts` 把旧历史折成一条摘要，模型随后看到的是摘要加最近若干条原文（compact.ts:1-19）。
- 工具动手前的钩子规则或脚本命中后，模型收到的是一条「被拦下」的结果；脚本超时、起不来、输出看不懂时默认也按拦下来处理（hooks.ts:1-23）。
- 协作模式（build / plan / explore / quiet）决定这一轮工具闸门；它和权限模式是两根独立旋钮（modes.ts:1-18）。
- 循环本身不弹界面，可见状态都经事件与工具结果往外走（loop.ts:1-21）。

## Known Limitations（已知限制）

- 会话持久化不在本包：`hooks.ts` 自己读写 `~/.dsc/hooks.json` 与可信记录，其余模块只认调用方给的最小形状（hooks.ts:12-17）。
- 压缩是「保头折尾」的最小实现，没有 span 选择与锁（compact.ts:1-4）。
- 提示词只做装配与预算裁剪；环境事实（日期、平台、目录、git 分支）不在这份提示词里，由调用方作为请求末尾快照附上（prompt.ts:13-19）。
- 循环没有 step、子代理调度与 checkpoint 修复；单队列串行 turn，打断靠 AbortController 贯穿 fetch 与工具执行（loop.ts:2-7）。
- 钩子脚本第一次执行要用户批准一次，批准记录带脚本修改时间；脚本改动后停止执行并要求重批（hooks.ts:11-12）。
- 模式只做减法：工具白名单只能是全量的子集，任何模式都放宽不了安全（modes.ts:1-18）。

## 谁在用它

- `agent`、`subagent`：loop 的 MiniAgent；`subagent` 另用 prompt 与 modes。
- `hooks`：钩子引擎（dsc 自己的规则与脚本；0.9.0 起 codex 事件名的外部命令钩子也并在这个包里，另用超时上下限常量）。
- `compact`、`microcompact`：compactSession / DEFAULT_KEEP_RECENT / estimateTokens。
- `prompt`：buildSystemPrompt / composePrompt / environmentText 等。
- `mode`、`plan`：MODES / modeSpec / planFilePath。
- `commands`：只借 compact 的 estimateTokens。
- `src/services/types.ts`：只 import 类型。
