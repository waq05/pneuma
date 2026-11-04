# agent（Agent 循环）

一句话：agent 包给每个会话常驻一个 ReAct 循环（MiniAgent），并把回合起止、用量与工具耗时换成事件广播出去。

## Model Experience（模型体验）

- 不注册工具：这个包里没有一次 `ctx.tools.register`；模型能用哪些工具由 `ctx.tools.visible({sessionId})` 从别的包的注册表里挑，模式档位在这一步做减法（index.ts:101）。
- 提示词贡献：每轮请求前现拼整份系统提示词，分段与取舍按「这个 agent 自己的会话」算，拼好的全文同时写进该会话的 `system-prompt` 状态条目（hash 变了才写）（index.ts:85-97、39-43）。
- 体量：提示词的长度由 prompt 插件拼的各段决定，本包一个字不加；随会话增长的是历史消息，不是这一份（index.ts:86-87）。
- 落盘对齐：系统提示不进 user / assistant 消息流，靠上面那条状态条目保证「模型看到的 ⟺ 日志里查得到」，重放时最后一条就是当前提示词（index.ts:32-42）。
- 停用之后，模型侧少掉：整条对话——这个包就是循环本体，没有它，一次请求都发不出去，也没有任何工具会被调用。

## Known Limitations（已知限制）

- 常驻的是 agent，不是无限历史：切走且空闲的会话最多留 3 个，第 4 个起就地收摊、释放写租约与内存（index.ts:49、214-223）。
- 收摊后的会话再来消息不会唤醒它：只把那条文本写进会话文件等用户回去看，不起回合（index.ts:265-279）。
- 只有「当前查看」的 agent 的流式增量与工具卡进转录；后台会话的过程留在各自的 jsonl 里，切回去靠重放（index.ts:153-160）。
- 归档等收摊最多 10 秒，超时强制收（index.ts:344-349）。
- 被切走且还在跑的 agent 发回后台上报时，状态点在 working 与 awaiting-approval 之间二选一，不会报「已完成」（index.ts:243-253）。

## 行与开关

- 行 id `agent`，包名 `@pneuma/agent`，order 260。
- resolution 是 pinned：profile 里的同名副本不生效，loader 会把「你不生效的那份在哪」说出来（core/plugin-loader.ts:1503-1514）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 七个服务：`session`、`transcript`、`tools`、`llm`、`compact`、`prompt`、`guards`（index.ts:53）。
- provide 一个服务 `agent`（index.ts:54）：排队输入的改 / 删 / 插话只作用于当前查看的会话，中断与停机可以按文件路径点名（index.ts:281-351）。
