# sandbox（文件与命令围栏）

一句话：sandbox 包限制模型能写到哪里、能不能联网，越界写与关网时联网当场拒掉；写文件或改文件之前，还会先把「改了哪几行」的 diff 摆进对话流。

## Model Experience（模型体验）

- 不注册工具：它挂在守卫链的 order 8 上（index.ts:94、280-281），排在协作模式（10）与审批（30）之前先判。
- 只拒两件事：写目标超出可写根，以及网络被关时命令要联网；其余一律 defer 给后面的层（文件头 15-18、index.ts:259-275）。
- 提示词贡献：`registerEnvFacts('sandbox', …)` 把档位、强制执行等级、可写根、只读子路径与网络开关写进每轮请求末尾的环境快照，通常 4 到 6 行（index.ts:408-441）。
- 降级必须可见：容器或受限令牌没建起来时，如实写「partial —— 进程内策略围栏」，不许说成已隔离（index.ts:376-405）。
- 一次性升权：模型要越界写，必须在同一次调用里同时给 `sandbox_permissions` 与 `justification`；半截参数一律拒（index.ts:305-316）。
- 改动前预览不经过模型：预览由 `ctx.emit('dsc/notice', …)` 直接折成对话流里的一条 system 条目，模型拿到的参数与结果一个字没变（review.ts:405-457）。
- 停用之后，模型侧少掉：可写根与网络那几行环境说明，以及越界写的当场拒绝——写盘只剩权限模式与审批卡两道关；预览也一起没了。

## Known Limitations（已知限制）

- 策略围栏拦得住 dsc 自己发起的工具调用，拦不住命令内部的任意写（脚本里的 fs.writeFile 这类）；要真隔离，Windows 上「没显式选过后端」时默认档会自动启用受限令牌（系统层拒越界写），也可以显式选受限令牌或容器后端（index.ts:425）。
- runner 用哪个解释器是**显式算出来的**，不靠环境碰巧对：默认用宿主的 `process.execPath`；检测到 Electron 运行时（桌面端宿主是 `utilityProcess`）就自动置 `ELECTRON_RUN_AS_NODE=1`，否则 `electron.exe` 会按图形程序启动、runner 一行都跑不到；用户可以用 `DSC_NODE` 指定自己的 node 来覆盖（win/interpreter.ts:44-67）。
- 降级不走 fail-closed：后端建不起来时默认照常执行、由审批卡兜底，这是与 dsh 的明确分歧（文件头 11-12）。
- read-only 档不拒整个 exec，只在命令里出现写目标时拒；「要不要问」是权限模式与审批的事（文件头 16-17）。
- 只有两条规则能交给审批卡问一次：`outside-writable-roots` 与 `mode-read-only`，其余硬拒（index.ts:130）。
- 网络默认关（policy.ts:89-90），要联网得先在设置里打开。
- 预览：一条最多显示 120 行（可调 5~2000），每个 hunk 前后留 3 行上下文（可调 0~20），超出的在末尾写明还剩多少行（review.ts:56-76）。
- 预览：旧文件超过 2MB 不读；前 8192 字节里含 NUL 的按二进制处理，不读全文（review.ts:50-53）。
- 预览算不动时退回摘要或干脆跳过，绝不让预览把一次写操作拦下来——守卫链上抛错按拒处理，预览没有这个资格（review.ts:18-21、427-437）。
- 预览不再有独立的插件开关：它跟着沙箱一起启停。设置里那项「启用改动前预览」只决定「还贴不贴 diff」，沙箱本身照常拦。
- 命令只能叫 `/file-review`：内置的 `/review` 是「审查工作区未提交改动」，同名注册会把它顶掉，曾经发生过（index.ts:922-940）。

## 改动前预览（0.9.0 从 `@pneuma/file-review` 并进来）

写盘之前先给用户看一眼要改什么，这件事本来就与「能不能写」是一套动作，所以 0.9 把 `file-review` 并进本包：

- 守卫 id 仍是 `file-review`、order 仍是 25，链上位置与合包之前逐字一致：地板 5 → 沙箱 8 → 模式 10 → 安全钩子 20 → **改动前预览 25** → 审批 30（index.ts:363-370、review.ts:416-419）。
- 它永远 defer，从不 deny、从不 pass——纯观察的一位；返回 pass 会把后面的审批卡一起跳掉（review.ts:1-18）。
- 设置分区 id 仍是 `sandbox`，预览的三项收进同一分区里的「改动预览」组，字段 key 与从前一样是 `enabled` / `maxLines` / `contextLines`，落盘在 `~/.dsc/plugins.json` 的 `sandbox` 条目下（index.ts:620-626、864-884）。
- `/file-review` 命令照旧能看状态与最近 8 次预览的摘要（index.ts:922-940）。

## 行与开关

- 行 id `sandbox`，包名 `@pneuma/sandbox`，order 3700。
- resolution 是 overridable：profile 里同名的新版本可以覆盖它（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`，文件头第 2 行也写着「默认开」。
- inject 六个服务：`guards`、`transcript`、`settings`、`prompt`、`commands`、`session`（index.ts:139）。
- 两个守卫同住一个插件：order 8 的 `sandbox` 与 order 25 的 `file-review`（index.ts:280-281、363-370）。
- 默认档位 workspace-write；后端出厂写的是 policy，但 Windows 上「没显式选过」时默认档会自动启用受限令牌（`resolveBackendChoice` 的规则 3，policy.ts:143），其他平台或探测不可用时仍是策略围栏；缓存目录（npm/pnpm/cargo/pip/yarn）默认放行，只认已经存在的目录。设置分区 id `sandbox`、order 31，预览在其中的「改动预览」组（index.ts:620-626）；命令 `/sandbox` 看现状与最近 3 次拒绝（index.ts:911-919）。
