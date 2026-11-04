# ui-terminal（终端）

一句话：ui-terminal 是停靠面板里终端页签的界面单元：首次可见就起一个 shell，之后的行编辑由界面自己做。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:29；ui/ui.tsx:63 只报名一个 dock 页签）。
- 用户在这里敲的命令不经过模型：输入只发给原生桥的 `term-input`，界面不把它交给宿主会话（ui/ui.tsx:6-9、172）。
- `term-spawn` 起的是子进程，输出只回到这一块界面，会话日志里没有它（ui/ui.tsx:230-232）。
- 停用后模型侧不变，终端页签消失（index.ts:7-9）。

## Known Limitations（已知限制）

- 管道模式没有 tty：vim、top 这类全屏交互程序不可用，行编辑、本地回显与退格由界面自己做（ui/ui.tsx:6-9）。
- 只走桌面原生桥：界面 HTTP 面没有 `term-*`，浏览器与远程壳里这块必然缺席，那时显示一句人话（ui/ui.tsx:14-15、73-75）。
- 切页签、切窗格、收起侧栏都只藏不卸，spawn 出来的 shell 与缓冲都活着；整个壳卸载才杀会话（ui/ui.tsx:61-62、107）。
- shell 选择只记在 localStorage（`dsc.dockShell`），换浏览器回到默认（ui/ui.tsx:16-17、55）。
- 切换 shell 等于杀旧起新，旧 shell 里的状态不保留（ui/ui.tsx:11-12、225）。

## 行与开关

- 行 id `ui-terminal`，包名 `@pneuma/ui-terminal`，order 366（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:29）。
- dock 页签 kind `terminal`、`keepMounted: true`，可以多开（ui/ui.tsx:63-69）。
- 停用后终端页签不出现，已经在跑的 shell 由壳卸载时收掉（index.ts:7-9）。
