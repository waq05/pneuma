# runtime-api（运行时查询）

一句话：runtime-api 包注册只读工具 `runtime_api`，把运行期的真状态（内核版本、插件、工具、提示段、守卫链、快照、模式）报给模型。

## Model Experience（模型体验）

- 注册工具 `runtime_api`：可选 `topic` 六选一（plugins / tools / prompt / guards / surfaces / presets），省略就六块全报；risk 标 read，不进审批卡（index.ts:86-124）。
- 只在创造模式下露面：工具条目带 `presets: ['maker']`，别的模式里连那段 schema 都不占（index.ts:8-9、112）。
- 提示词贡献：不注册提示段；工具说明本身约十行，教模型「写插件或加模式之前先问这里，别照文档里的旧说法猜」（index.ts:88-98）。
- 报的是运行期真值：开头两句给内核 API 版本、已挂插件数、工具数与模式数，并说明外部插件声明的 apiVersion 高于内核会被自动停用（index.ts:115-118）。
- `topic=prompt` 会列出内置骨架段的 order（identity 0、behavior 10、tool-rules 20、指令文件 200、技能目录 210、模型信息 890），并说明环境事实在投影里、不在提示词里（index.ts:51）。
- 停用之后，模型侧少掉 `runtime_api`：创造模式里它再没有别的办法查到当前内核 API 与真实工具目录（index.ts:86-125）。

## Known Limitations（已知限制）

- 只读：不改任何状态，也不会替模型验证它写下的插件或模式能不能挂上（index.ts:11）。
- 省略 topic 会把六块拼成一份长文本，说明里自己写明「只在需要通盘了解时用」（index.ts:98）。
- 工具那一块只给名字、风险档与截到 90 字的说明开头，不报实现文件或调用示例，细节仍要回源码看（index.ts:29-36）。

## 行与开关

- 行 id `runtime-api`，包名 `@pneuma/runtime-api`，order 340。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`；工具带 `presets: ['maker']`，只在创造模式露头（index.ts:112）。
- inject 五个服务：`tools`、`guards`、`prompt`、`surfaces`、`presets`（index.ts:27）。
- 没有设置分区、没有命令：它的全部接口就是那一个工具（index.ts:86）。
