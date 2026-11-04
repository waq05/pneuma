# ask（模型提问）

一句话：ask 包提供 `ask` 服务与 `ask_user` 工具，把一批问题挂成一张卡让用户逐题作答，模型在一次调用里拿回全部答案。

## Model Experience（模型体验）

- 注册工具 `ask_user`：`questions` 数组至少一条，每项要有 `question`，`options` 里推荐的放第一个并在 label 结尾写「（推荐）」（index.ts:256-286）。
- 风险等级 read：不弹审批卡，但会挂住这一轮等人作答（index.ts:287、289）。
- 工具说明随配置变：描述里的「最多几个问题、每个最多几个选项、最多等多久」取自本插件配置，每次调用前重读一遍再裁剪参数（index.ts:243-255、291-292）。
- 一处调用拿全批答案：界面上用户逐题作答、统一提交，服务按题序收齐才让工具调用落地，模型看到的是「一次调用一次结果」（index.ts:7-10、319-323）。
- 停用之后，模型侧少掉：`ask_user` 这个工具，模型只能把要确认的事写进正文，不能再挂一张等回答的卡。

## Known Limitations（已知限制）

- 硬上限：一次最多 3 个问题、每个最多 4 个互斥选项，可调到 1~8；超出直接截断（index.ts:34、65-66、292、300-301）。
- 等一张卡默认 15 分钟，可调区间 10 秒到 1 小时；等到时限没人答，卡片撤掉，模型拿到一句「等了 N 分钟，用户没有回答这一题」，那不是用户的话（index.ts:37、78-83、53-55）。
- 收尾路径都写实话：用户中断、程序退出、被新的一批顶掉，各有固定的一句替代文本，不会拿空串冒充答案（index.ts:39-44）。
- 每个会话最多一张卡，多卡并存互不顶掉；同一会话重复挂卡时旧卡作废并收到「这一题作废」（index.ts:12-13、154-157）。
- 单个会话的作答只认当前查看的那张卡，后台会话的卡继续等（index.ts:127-134、228-235）。

## 行与开关

- 行 id `ask`，包名 `@pneuma/ask`，order 250。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 四个服务：`session`、`tools`、`surfaces`、`waiting`（index.ts:107）；provide 一个 `ask`（index.ts:108）。
- 对外两片：快照面 `pendingQuestion` 只出当前查看会话的那张卡（index.ts:238），`waiting` 登记「有卡在等」（index.ts:239）。
- 可调值在 `~/.dsc/plugins.json` 的 `ask` 条目（`maxQuestions` / `maxOptions` / `waitMs`），本包没有设置页分区（index.ts:26、61-83）。
