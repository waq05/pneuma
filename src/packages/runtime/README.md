# runtime（运行时适配器）

一句话：runtime 包把各服务织成界面消费的 `DscRuntime`，让终端与桌面渲染层读同一份契约。

## Model Experience（模型体验）

- 不注册工具、不注册提示段、不做投影：它对模型没有直接贡献，所有方法都是界面在调（index.ts:28-53、95-617）。
- 界面上每块卡片都落到具体插件：切档调 mode / presets / permissionPresets，清单调 todo，计划卡调 plan，提问卡调 ask，目标调 goal（index.ts:43-51）。
- 唯一碰得到模型可见面的地方：命令输出经 `transcript.system` 落成会话条目并标 `command`，两侧界面都看得见（index.ts:74-84）。
- 工具目录连同 `presets` 标签一起交给界面，设置页的工具多选因此知道哪个工具只属于哪个模式（index.ts:328-332）。
- 停用之后：界面层拿不到 `ui` 服务，TUI、桌面壳、远程页都起不来；模型侧本身不缺提示段与工具，缺的是人在界面上能点的入口（index.ts:53、617）。

## Known Limitations（已知限制）

- 它是纯适配层，不自己判事：同步写动作抛错时由 `mutateWith` 包成 `{ ok: false, error }` 交回界面（index.ts:55-65）。
- `exit` 的语义是发出 `dsc/exit` 后立即退进程，各插件只做同步收尾，没有异步清理的时间（文件头 5）。
- 命令派发走 `commands.run`；壳那条通道只放行声明了 `shell: true` 的命令（index.ts:355-381）。
- 旁问按票据登记：同一票据重复发会先掐掉旧的那条，不留两条同时烧 token（index.ts:86-93、481-513）。
- 包名是 `@pneuma/runtime-adapter`，与目录名 `runtime`、行 id `runtime` 都不一致；插件对象里还叫 `ui-runtime`（package.json:2、index.ts:29）。

## 行与开关

- 行 id `runtime`，包名 `@pneuma/runtime-adapter`，order 290。
- resolution 是 pinned（package.json 的 `pneuma.resolution`），profile 里的同名版本换不掉它。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 十八个服务：agent、session、transcript、approval、llm、commands、dock、skills、settings、compact、tools、mode、presets、permissionPresets、todo、plan、ask、goal，并 provide `ui`（index.ts:30-53）。
- 没有设置分区、没有工具、没有命令：它就是界面契约本身（index.ts:95-617）。
