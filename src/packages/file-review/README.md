# file-review（改动前预览）

一句话：file-review 包在 `write` / `edit` 动手之前，把「改了哪几行」算成 unified diff 摆进对话流，让人在点「允许」之前先看见改动。

## Model Experience（模型体验）

- 不注册工具：它是守卫链 order 25 的一位守卫，只表态 defer，从不 deny、从不 pass（index.ts:379-414）。
- 触发条件很窄：只认会落盘的 `write` 与 `edit`；只读工具不预览，bash 之类执行类工具没法在动手前知道它写了什么，也不预览（index.ts:45、386-387）。
- 产出不经过模型：预览走 `ctx.emit('dsc/notice', …)` 折成一条 system 条目，先出现、审批卡随后才弹（index.ts:405-411）。
- 提示词贡献为零：没有 `ctx.prompt` 调用，模型拿到的参数与结果一个字没变。
- 停用之后，模型侧什么都不少；少掉的是用户眼前的 diff——审批卡下面不再有「要改哪几行」。

## Known Limitations（已知限制）

- 一条预览最多显示 120 行（可调 5~2000），每个 hunk 前后留 3 行上下文（可调 0~20），超出的在末尾写明还剩多少行（index.ts:54-69）。
- 旧文件超过 2MB 不读；前 8192 字节里含 NUL 的按二进制处理，不读全文（index.ts:48、51）。
- 算不动时退回摘要或干脆跳过，绝不让预览把一次写操作拦下来——守卫链上抛错按拒处理，预览没有这个资格（index.ts:20-21、392-402）。
- 命令只能叫 `/file-review`：内置的 `/review` 是「审查工作区未提交改动」，同名注册会把它顶掉，曾经发生过（index.ts:429-432）。
- 关掉之后审批照常问，只是不再先贴 diff（index.ts:73）。

## 行与开关

- 行 id `file-review`，包名 `@pneuma/file-review`，order 3710。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`，配置里 `enabled` 缺省也是 true（index.ts:66）。
- inject 三个服务：`guards`、`settings`、`commands`（index.ts:364）。
- 命令 `/file-review` 看状态与最近 8 次预览的摘要（index.ts:369-377、429-435）；设置分区 id `file-review`、order 36（index.ts:438-443）。
- 挂在哪一环：地板 5、模式 10、安全钩子 20、本插件 25、审批 30（index.ts:4-9、381）。
