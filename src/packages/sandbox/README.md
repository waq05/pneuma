# sandbox（文件与命令围栏）

一句话：sandbox 包限制模型能写到哪里、能不能联网，越界写与关网时联网当场拒掉。

## Model Experience（模型体验）

- 不注册工具：它挂在守卫链的 order 8 上（index.ts:77-78、335-336），排在协作模式（10）与审批（30）之前先判。
- 只拒两件事：写目标超出可写根，以及网络被关时命令要联网；其余一律 defer 给后面的层（文件头 15-18、index.ts:248-257）。
- 提示词贡献：`registerEnvFacts('sandbox', …)` 把档位、强制执行等级、可写根、只读子路径与网络开关写进每轮请求末尾的环境快照，通常 4 到 6 行（index.ts:375-408）。
- 降级必须可见：容器或受限令牌没建起来时，如实写「partial —— 进程内策略围栏」，不许说成已隔离（index.ts:347-373）。
- 一次性升权：模型要越界写，必须在同一次调用里同时给 `sandbox_permissions` 与 `justification`；半截参数一律拒（index.ts:287-298）。
- 停用之后，模型侧少掉：可写根与网络那几行环境说明，以及越界写的当场拒绝——写盘只剩权限模式与审批卡两道关。

## Known Limitations（已知限制）

- 策略围栏拦得住 dsc 自己发起的工具调用，拦不住命令内部的任意写（脚本里的 fs.writeFile 这类）；要真隔离得把后端换成 Windows 受限令牌或容器（index.ts:389-393）。
- 降级不走 fail-closed：后端建不起来时默认照常执行、由审批卡兜底，这是与 dsh 的明确分歧（文件头 12-13）。
- read-only 档不拒整个 exec，只在命令里出现写目标时拒；「要不要问」是权限模式与审批的事（文件头 17-18）。
- 只有两条规则能交给审批卡问一次：`outside-writable-roots` 与 `mode-read-only`，其余硬拒（index.ts:112-117）。
- 网络默认关（policy.ts:89-90），要联网得先在设置里打开。

## 行与开关

- 行 id `sandbox`，包名 `@pneuma/sandbox`，order 3700。
- resolution 是 overridable：profile 里同名的新版本可以覆盖它（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`，文件头第 2 行也写着「默认开」。
- inject 六个服务：`guards`、`transcript`、`settings`、`prompt`、`commands`、`session`（index.ts:121）。
- 默认档位 workspace-write、默认后端 policy（进程内策略围栏），设置分区 id `sandbox`，命令 `/sandbox` 看现状与最近 3 次拒绝（index.ts:806-814）。
