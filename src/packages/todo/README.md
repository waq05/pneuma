# todo（任务清单）

一句话：todo 包给模型一张它自己维护、界面实时显示的任务清单，并在长会话里按轮数提醒它更新。

## Model Experience（模型体验）

- 注册工具 `todo_write`：传 `todos` 数组整表替换，或 `merge: true` 按 id 只改给出的几条；状态只有 pending / in_progress / completed / cancelled 四种（index.ts:51-91）。
- 工具回显整表与进度 `done/total`（index.ts:86-89），模型看到的和界面看到的是同一份。
- 提示词贡献一：压缩时把清单原文原样带过去，不让摘要模型改写它（index.ts:139，文本见 129-131）。
- 提示词贡献二：`todo-reminder` 投影，order 800，默认开、每 8 轮一次；只在清单里还有未完成项时往请求末尾补一条 user 文本，约 30 token（index.ts:150-161，core/todo-reminder.ts 文件头）。
- 停用之后，模型侧少掉：写清单的工具、压缩后原样保留的清单原文、以及那条节流提醒；界面上的进度条也一起消失（index.ts:137 的 `todos` 投影）。

## Known Limitations（已知限制）

- 提醒是追加一条 user 消息，不是系统指令，模型可以不理（core/todo-reminder.ts 的 `appendTodoReminder`）。
- 提醒不落会话日志：它是投影，每次组装请求时重算，刷新后重新拼（core/todo-reminder.ts 文件头）。
- 清单是会话级的：一个会话一份，切会话换一份（index.ts:221-226）。
- 有硬上限：单条正文 300 字、最多 64 条（core/todo.ts:26、29），超出的部分被截断，并在回显里说明。
- 「同一时刻最多一条 in_progress」只写在工具说明里（index.ts:56），存储层不校验（core/todo.ts:210-229）；传两条也照存，进度条只显示找到的第一条（core/todo.ts:117-125）。
- 与 dsh 同族能力的差异：待确认，本包只写「形状抄 Codex 的 update_plan 与 DSH 的 todo_write」（index.ts:13-14），没有列出差异。

## 行与开关

- 行 id `todo`，包名 `@pneuma/todo`，order 230。
- resolution 是 overridable：profile 里同名的新版本可以覆盖它（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 七个服务：`session`、`tools`、`commands`、`surfaces`、`compact`、`prompt`、`settings`（index.ts:96）。
- 设置分区 id `todo`，order 45，两项：总开关与「每隔几轮提醒一次」，间隔只能填 1..100（index.ts:163-207）。
