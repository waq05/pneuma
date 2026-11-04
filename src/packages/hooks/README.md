# hooks（安全钩子）

一句话：hooks 包把用户自己登记的规则与外部脚本挂到守卫链 order 20 上，作为「防模型手滑」的那一道闸。

## Model Experience（模型体验）

- 不注册工具：它往守卫链注册一位 order 20 的守卫，另在结果加工位注册一位 order 40 的观察者（index.ts:225-227、285-292、320-323）。
- 三种后果：deny 直接拦、ask 强制弹审批卡（当前档位本来会自动放行也照样弹）、note 只留一句话不拦（index.ts:8-12、253-281）。
- 提示词贡献为零：inject 列表里没有 `prompt`；模型只在被拦时看到拒绝理由（index.ts:265-266、core/hooks.ts:1000）。
- 脚本的 stdin 收到这次调用的 JSON，用退出码或 stdout 的 JSON 回话；四个事件里只有 pre-tool 能拦，post-tool / session-start / turn-end 只观察（index.ts:233-251、285-292、704-715、core/hooks.ts:7-8、45）。
- 停用之后，模型侧少掉：用户规则带来的拦截与那句留话，审批卡也不再被强制弹出。

## Known Limitations（已知限制）

- 只有加严的本事，没有「自动放行」这一档；要放宽请回 `policy.rules` 写前缀规则（core/hooks.ts:10-12）。
- 失败方向与 dsh / Hermes 相反：那两家遇到脚本超时、起不来、输出看不懂时一律放行（`agent/shell_hooks.py:388-395` 的 fail open），dsc 默认按「拦下来」处理，想退回放行有 `settings.scriptFailClosed`（core/hooks.ts:17-20）。
- 新加的脚本默认不执行，要用户批准一次；批准时记下脚本文件的修改时间，脚本改过就要重批（core/hooks.ts:14-15）。
- 硬上限：模式 300 字、理由 200 字、脚本超时 500~120000 毫秒（core/hooks.ts:57-63）。
- 每次判定都现读 `~/.dsc/hooks.json`，写入是整份覆盖，手改与界面改动会互相盖（core/hooks.ts:14）。
- post-tool 脚本只拿到工具结果的前 4000 个字符（index.ts:289）。

## 行与开关

- 行 id `hooks`，包名 `@pneuma/hooks`，order 190。
- resolution 是 pinned：profile 里的同名副本不生效（core/plugin-loader.ts:1503-1514）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 六个服务：`session`、`approval`、`guards`、`settings`、`transcript`、`commands`（index.ts:119）；provide 一个 `hooks`（index.ts:120、324）。
- 命令 `/hooks` 看规则、脚本与批准状态（index.ts:326-336）；设置分区 order 34（index.ts:542）；每个结论落一行 `~/.dsc/audit.jsonl`，种类 `hook`（index.ts:14、129-130）。
