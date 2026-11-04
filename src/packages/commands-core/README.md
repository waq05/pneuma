# commands-core（命令补全库）

一句话：斜杠命令表、补全候选与唯一前缀展开的唯一一份实现，commands / runtime / tui 三个功能包与界面输入框共用。

## Model Experience（模型体验）

- 用户敲 `/` 看到的候选、`/help` 的文本、`/mod` 能否唯一展开，都来自这一份表（commands-completion.ts:1-8）。
- 表里 `shell: true` 的命令同时是桌面输入框能列出、也能执行的命令（commands-completion.ts:13-20）。
- 模型看不到本包本身；命令执行后的效果由 commands 包的 handler 决定（commands-completion.ts:3-10）。

## Known Limitations（已知限制）

- 顶层不许出现任何 Node 内置模块：渲染层 Composer 直接 import 它，vite 遇到内置模块会白屏（commands-completion.ts:3-7）。
- 补全只做前缀与参数候选，不做模糊匹配（commands-completion.ts:145-200）。
- 命令表是编译期常量加运行期 `addExtraSpec` 的追加，没有持久化（commands-completion.ts:84-103）。
- 命令是否危险、要不要确认，由审批与守卫判定；本包只认命令名与参数形状（commands-completion.ts:108-130）。

## 谁在用它

- `commands`：内置命令表与 `/help` 文本。
- `runtime`：`shellCommands` / `shellCommandRejection` 两条界面通道校验。
- `tui`：输入框的 `completionsFor` / `expandCommand` / `inputClaimOf`。
