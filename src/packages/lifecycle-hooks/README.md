# lifecycle-hooks（外部命令钩子）

一句话：lifecycle-hooks 包把 codex 的十四个生命周期事件名接到 dsc 的扩展点上，让外部命令在工具动手前后、会话起止与一轮收工时被调起来。

## Model Experience（模型体验）

- 不注册工具：它交的是一条 order 25 的守卫（PreToolUse，可 deny）和一条 order 45 的观察者（PostToolUse）（index.ts:159-205、240）。
- 提示词贡献：一条名为 `user-prompt-submit` 的投影，把攒下的钩子留言补在请求末尾、用 user 角色，正文自带 `<external_content source="hook:…">` 围栏标出处（index.ts:211-221）。
- 留言同时落库：塞进请求的同时往会话落一条 note，保证「模型可见 ⟺ 日志可重建」（index.ts:209-218）。
- 钩子输出一律过 `wrapUntrusted`：它说的话是数据，不是指令（index.ts:21-22、190）。
- 停用之后，模型侧少掉：请求末尾那几段钩子留言，以及 PreToolUse 的拦截。

## Known Limitations（已知限制）

- 十四个事件里有六个在 Pneuma 没有对应扩展点（PreModelRequest / PostModelRequest / PermissionRequest / PreCompact / SubagentStart / SubagentStop），配了也不执行，只把原因写进能力清单的 problems（index.ts:17-19）。
- PreToolUse 这个位置没有审批卡可弹：「要人确认」只能按拒绝回话，让模型自己去问用户（index.ts:179-188）。
- SessionEnd 不等钩子跑完就退出（index.ts:16）。
- 载荷里 `transcript_path` 恒为 null（取不到会话自己的 jsonl 路径），`Stop` 的 `stop_hook_active` 恒为 false（index.ts:88-89、262-263）。
- 与内置的「安全钩子」是两回事：两份配置各读各的（`~/.dsc/lifecycle-hooks.json` 与 `~/.dsc/hooks.json`），同时挂在链上（20 与 25）却互不认识（index.ts:4-7）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。

## 行与开关

- 行 id `lifecycle-hooks`，包名 `@pneuma/lifecycle-hooks`，order 3670。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。
- inject 七个服务：`session`、`llm`、`approval`、`guards`、`prompt`、`settings`、`commands`（index.ts:64）。
- 命令看能力清单与事件接通状态（index.ts:397-415）；设置分区 id `lifecycle-hooks`、order 36（index.ts:348-352）；钩子脚本的超时区间与内置安全钩子共用 500~120000 毫秒（index.ts:27、packages/session-core/hooks.ts:57-58）。
