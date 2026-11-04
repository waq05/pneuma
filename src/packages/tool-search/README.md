# tool-search（工具按需加载）

一句话：把动手类与 MCP 工具从每轮请求里撤下，只留三个桥接工具按需检索、看参数、调用。

## Model Experience（模型体验）

- 三个常驻工具：`tool_search` 按中英文关键词检索并按词频打分、`tool_describe` 取完整 schema、`tool_call` 按真名调用（index.ts:5-9、229-356）。
- 只有 write / exec 风险的工具会被撤；read 工具一律留在台面（index.ts:11-14）。
- 档位 1 只撤 MCP，档位 2 再按规则撤，档位 3 除保留名单外全撤（index.ts:406-415）。
- `tool_call` 用被调工具的真名与真实风险过守卫链，一次动作只弹一张审批卡（index.ts:15-17、329-341）。
- 搜不到时会把台面上的工具名一并列出，提醒「搜不到不等于没有这个工具」（index.ts:260-270）。

## Known Limitations（已知限制）

- 默认关闭：cordis.patch.yml 里 `disabled: true`。
- 撤下的工具调一次多两次往返（tool_search → tool_call，看参数还要 tool_describe）（index.ts:12-13）。
- 配置换挡会先还原再撤，工具列表顺序会被打乱一次（index.ts:108-124）。
- MCP 是可选服务：没开 MCP 时只撤注册表工具（index.ts:80-81、125-133）。
- 三个桥接工具自己不能被撤下，也不能经 `tool_call` 再包一层（index.ts:43-44、345-347）。

## 行与开关

- 行 id `tool-search`，包名 `@pneuma/tool-search`，order 3690（package.json:10-18）。
- resolution 是 overridable，默认关闭（package.json:15；cordis.patch.yml）。
- inject `tools`、`settings`（index.ts:67）。
- 设置分区 id `tool-search`，order 47，含 MCP 开关、档位、延后规则、保留名单与检索条数（index.ts:383-505）。
- 卸载时把撤下的工具放回台面，并收回 MCP 的撤下状态（index.ts:511-520）。
