# session-title（会话标题）

一句话：首回合正常结束后用一次独立的小模型请求给会话起标题，写进 `autoTitle`；用户改过名就不覆盖。

## Model Experience（模型体验）

- 不注册工具、不写提示词：模型看不到标题，也不会因为起标题多出一轮（index.ts:2-7）。
- 只认 `dsc/turn-end` 且 reason 为 completed；失败或中断的回合不起名（index.ts:57-59）。
- 送给标题模型的只有最近 3 条用户消息、每条截 600 字；输出上限 40 字，20 秒超时（index.ts:22-27、80-108）。
- 已有 `title` 或 `autoTitle` 就跳过；请求回来后再查一次，期间用户改名优先（index.ts:76-78、111-114）。
- 失败完全静默，兜底仍是首条消息截断（index.ts:11-13、120-122）。

## Known Limitations（已知限制）

- 只在回合正常结束后触发；首回合被打断、或会话没有用户消息，就一直用兜底标题（index.ts:57-59、85）。
- 标题只走展示链，不进模型上下文：用户改名 → 自动标题 → 首条消息截断（index.ts:6-8）。
- 后台收工的会话也起名：按 turn-end 载荷的 sessionPath 找目标，载荷缺省才退回当前会话（index.ts:9-10、61）。
- 请求用当前会话的路由与模型，不另挑便宜模型；用量记在被起名那条会话上（index.ts:87-96）。
- 20 秒只 abort 不重试；同一个会话同时只发一次，靠文件路径去重（index.ts:54-55、67-68）。

## 行与开关

- 行 id `session-title`，包名 `@pneuma/session-title`，order 220（package.json:10-18）。
- resolution 是 overridable：用户 profile 里的同名副本优先换掉它（package.json:15；core/plugin-loader.ts:1483-1490、1575-1579）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 两个服务：`session`、`llm`（index.ts:52）。
- 没有设置分区，也不登记快照片段。
