# mcp（MCP 外部工具）

一句话：mcp 包把外部 MCP 服务器上的工具接进本机工具目录，让模型能像调内置工具一样调它们。

## Model Experience（模型体验）

- 默认关：cordis.patch.yml 里写着 `disabled: true`，要在插件中心手动打开才开始连服务器。
- 连上之后，每个服务器的工具以 `mcp__<server>__<tool>` 注册进工具目录（文件头 2-3、index.ts:121-131），描述前带「（MCP server：名字）」。
- 返回值先过外部内容围栏再回模型，server 报错也包完再抛（index.ts:207-219），防的是把 server 的原文当指令读。
- 两个按能力注册的工具：`mcp_resources`（list / read）与 `mcp_prompts`（list / get）；只有 server 在握手时声明了对应能力，这两个工具才存在（index.ts:272-291）。
- 提示词贡献：server 自带的 instructions 挂进系统提示，上限 4000 字符，order 55（index.ts:239-255）。
- 停用之后，模型侧少掉：全部 `mcp__*` 工具、`mcp_resources`、`mcp_prompts`，以及各 server 的用法说明那一段。

## Known Limitations（已知限制）

- 服务器清单只能在设置里存成一行 JSON，多行结构摆不下；保存时整份校验，任一项不合法就整份拒收（文件头 10-11）。
- 连不上不阻塞宿主：连接全在后台跑，失败按退避重连，默认最多 5 次、单次退避上限 30 秒（index.ts:57-66、457-525）。
- 没配风险等级的 MCP 工具一律按 exec 算（index.ts:56-59），因此默认会走审批卡。
- 一个 server 掉线只撤它自己的工具，其余 server 与宿主照常（文件头 6-8、434-446）。
- 与 dsh 同族能力的差异：待确认，本包代码里没有与 dsh 的对照说明。

## 行与开关

- 行 id `mcp`，包名 `@pneuma/mcp`，order 3680。
- resolution 是 overridable：profile 里同名的新版本可以覆盖它（core/plugin-loader.ts:1306-1312）。
- 默认关：cordis.patch.yml 的 `disabled: true`，这是本批 10 个包里唯一默认关的一个。
- inject 六个服务：`tools`、`transcript`、`settings`、`prompt`、`approval`、`session`（index.ts:142）。
- 设置分区 id `mcp`，里面存服务器清单与超时、重连参数（index.ts:157）。
