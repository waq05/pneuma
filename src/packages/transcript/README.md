# transcript（会话流）

一句话：把会话事件折叠成对话条目，并装配界面要的整份快照。

## Model Experience（模型体验）

- 不注册工具、不贡献提示词；模型侧没有直接变化（index.ts:1-13、87-91）。
- 它提供的 `transcript` 服务是别的插件的输出通道：通知、计划卡、子代理卡、压缩提示都从这里进流（index.ts:266-298）。
- 模型看不到这些条目本身，条目只用于界面显示（index.ts:9-10）。
- 其他 inject `transcript` 的插件（如 spill、skills、subagent）靠它写提示；停用它，这些调用会报错，提示进不了会话流。

## Known Limitations（已知限制）

- 重放判重只比内容，忽略 id / ts / usage / 耗时；否则重复打开同一会话会整表重建（index.ts:161-181、397-441）。
- 后台会话的通知与计划卡按 sessionPath 过滤，串台的一律丢弃（index.ts:146-159、251-259）。
- 费用估算只对 DeepSeek 官方端点给；估不出就不带这个字段（index.ts:337-345）。
- 收件箱按来源拆成 queued / notices，index 保留原始位置，拆面不重新发号（index.ts:25-29、47-63）。
- 快照引用在两次通知之间保持同一个，靠作废缓存换新（index.ts:94-100）。

## 行与开关

- 行 id `transcript`，包名 `@pneuma/transcript`，order 90（package.json:10-18）。
- resolution 是 pinned（package.json:16）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject `session`、`llm`、`surfaces`；provide `transcript`（index.ts:87-91）。
- 清单仍声明 `exports["./client"]` 与 `dsh.client`，但本包没有 ui/ 目录；界面半已搬到 `ui-transcript`（package.json:6-9、20-25）。
