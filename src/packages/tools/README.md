# tools（工具注册表）

一句话：tools 包是工具注册表，谁想把工具递给模型就往它这里登记，模型每轮看到的那份目录由它按投影算出来。

## Model Experience（模型体验）

- 不注册工具：本包只做 `ctx.provide('tools', service)`（index.ts:81），自己不往目录里放任何条目。
- 模型每轮看到什么由 `visible()` 决定：先取全量注册表，再依次过一遍「投影」（index.ts:66-78）。投影是一个函数，入参是当前目录，出参是要给模型的那份。
- 投影只做减法：注册者返回的必须是入参的子集，不许凭空造一个工具（index.ts:10-11）。极简模式因此只把 bash 递给模型，而队友与界面仍旧看到完整注册表（index.ts:6-9）。
- 一条投影抛错不会让整轮请求失败：跳过它，模型这一轮看到未裁剪的目录，错误只写宿主日志（index.ts:69-75）。
- 登记时查形状：`run` 不是函数的条目当场拒收；对方若是 dsh 风格（有 `execute` 没有 `run`），报错会指引去开 dsh-compat（index.ts:23-36）。
- 停用之后，模型侧少掉整个工具目录：`ctx.tools` 不存在，声明 `inject: ['tools']` 的包（如 todo/index.ts:96、mcp/index.ts:142）挂不上，一个工具也调不到。

## Known Limitations（已知限制）

- 不承诺参数校验：形状检查只查 `name` 非空与 `run` 是函数（index.ts:23-36），参数结构对不对由登记方自己声明、自己保证。
- 同名工具后注册的覆盖先注册的：`register` 直接 `entries.set(entry.name, entry)`（index.ts:52），没有重名告警。
- 投影崩了会被静默跳过，只写 `console.error`（index.ts:74）；此时模型看到的是比预期更宽的目录，界面上没有提示。
- 与 dsh 同族能力的差异：这里认 `run` 不认 `execute`，dsh 风格的工具有 `execute` 没有 `run` 时被拒收（index.ts:26-33），必须先开 dsh-compat 兼容层。

## 行与开关

- 行 id `tools`，包名 `@pneuma/tools`，order 70。
- resolution 是 pinned：应用安装目录里的这一份优先（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- 不 inject 任何服务，只 provide `tools`（index.ts:38-41）。
- 不注册设置分区（package.json 里没有 `settingsSection`）。
