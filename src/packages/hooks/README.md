# hooks（安全钩子）

一句话：hooks 包把用户自己登记的规则与外部脚本挂到守卫链上，作为「防模型手滑」的那一道闸；
0.9.0 起它还收着 codex 那十四个事件名的外部命令钩子（原 `@pneuma/lifecycle-hooks` 包），
两块共用一页设置、同一条守卫链，配置仍是两份各读各的。

## Model Experience（模型体验）

- 不注册工具：它往守卫链注册两位守卫——安全钩子 order 20（index.ts:380-381）、外部命令钩子的 PreToolUse order 25（index.ts:453-454）；再在结果加工位注册两位观察者——order 40（index.ts:440-441）与 PostToolUse 的 order 45（index.ts:488-489）。两位 id 仍是 `hooks` 与 `lifecycle-hooks`，order 一个没动，所以链上先后与合并前逐字一致。
- 三种后果：deny 直接拦、ask 强制弹审批卡（当前档位本来会自动放行也照样弹）、note 只留一句话不拦（index.ts:8-12、382-435）。
- 提示词贡献：一条名为 `user-prompt-submit` 的投影，把外部钩子攒下的留言补在请求末尾、用 user 角色，正文自带 `<external_content source="hook:…">` 围栏标出处（index.ts:536-547）；留言同时往会话落一条 note，保证「模型可见 ⟺ 日志可重建」。
- 外部钩子的话进模型之前一律过 `wrapUntrusted`（来源 `hook:<事件名>`）：它说的话是数据，不是指令（index.ts:66、355、481、lifecycle-hooks.ts:704-712）。
- 脚本的 stdin 收到这次调用的 JSON，用退出码或 stdout 的 JSON 回话；安全钩子四个事件里只有 pre-tool 能拦（index.ts:380-397、440-446、1090-1106）；外部钩子只有 PreToolUse 能 deny，PostToolUse 挂后台跑、话进下一次请求。
- 停用之后，模型侧少掉：用户规则带来的拦截与那句留话，审批卡也不再被强制弹出。外部钩子那一半在 `hooks` 包里不可停用（包是 pinned），只能关它自己的「启用外部命令钩子」开关。

## Known Limitations（已知限制）

- 只有加严的本事，没有「自动放行」这一档；要放宽请回 `policy.rules` 写前缀规则（packages/session-core/hooks.ts:10-12）。
- 失败方向与 dsh / Hermes 相反：那两家遇到脚本超时、起不来、输出看不懂时一律放行（`agent/shell_hooks.py:388-395` 的 fail open），dsc 默认按「拦下来」处理，想退回放行有 `settings.scriptFailClosed`（packages/session-core/hooks.ts:17-20）。外部钩子相反：默认与 codex 同口径（只有退出码 2 才拦），要「没跑成也算拦」得打开「钩子没跑成就算拦」。
- 新加的安全钩子脚本默认不执行，要用户批准一次；批准时记下脚本文件的修改时间，脚本改过就要重批（packages/session-core/hooks.ts:14-15）。
- 硬上限：模式 300 字、理由 200 字、脚本超时 500~120000 毫秒（packages/session-core/hooks.ts:56-63）。
- 每次判定都现读 `~/.dsc/hooks.json`，写入是整份覆盖，手改与界面改动会互相盖（packages/session-core/hooks.ts:14）。
- post-tool 安全钩子脚本只拿到工具结果的前 4000 个字符（index.ts:443）。
- 外部钩子的十四个事件里有六个在 Pneuma 没有对应扩展点（PreModelRequest / PostModelRequest / PermissionRequest / PreCompact / SubagentStart / SubagentStop），配了也不执行，只把原因写进能力清单的 problems（lifecycle-hooks.ts:17-19、93-178）。
- 外部钩子的 PreToolUse 这个位置没有审批卡可弹：「要人确认」只能按拒绝回话，让模型自己去问用户（index.ts:469-479）；SessionEnd 不等钩子跑完就退出。
- 外部钩子的载荷里 `transcript_path` 恒为 null，`Stop` 的 `stop_hook_active` 恒为 false（index.ts:306-314、1126-1128）。
- 合并后的读迁移是**只读**的：`~/.dsc/plugins.json` 里 `hooks` 条目缺的项沿用旧 `lifecycle-hooks` 条目的同名项；旧条目被停用过就按关处理，旧条目一个字节都不删（留给回滚），所以读多少次结果都一样（lifecycle-hooks.ts:239-287）。

## 行与开关

- 行 id `hooks`，包名 `@pneuma/hooks`，order 190。
- resolution 是 pinned：profile 里的同名副本不生效（core/plugin-loader.ts:1503-1514）。
- 默认开：cordis.patch.yml 里没有 `disabled`。外部命令钩子原来那一行（id `lifecycle-hooks`、order 3670、默认关、可停用）已从 base 清单消失，所以外面没有第二个开关。
- inject 八个服务：`session`、`llm`、`approval`、`guards`、`prompt`、`settings`、`transcript`、`commands`（index.ts:176）；provide 一个 `hooks`（index.ts:177、530）。
- 命令 `/hooks` 看规则、脚本与批准状态（index.ts:563-573）；`/lifecycle-hooks` 看外部钩子的能力清单与已加载的钩子（index.ts:575-593）。
- 设置分区 id `hooks`、order 34（index.ts:891-894）；外部命令那一组 id `external`、标题「外部命令（codex 事件名）」（index.ts:895-901），字段键带 `external` 前缀，落到 `plugins.json` 上仍是原来的键名。
- 每个结论落一行 `~/.dsc/audit.jsonl`，种类 `hook`（index.ts:14、172-184）。
