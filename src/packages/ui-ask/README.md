# ui-ask（旁问）

一句话：右侧栏的「旁问」——基于当前上下文只读地问答一次；`ask_user` 的选项卡不在这里，在 `ui-prompt`。

## Model Experience（模型体验）

- 纯界面单元：宿主半是空 `apply`，不注册工具、不写提示词（index.ts:3-9、31）。
- 旁问走一次独立请求：不执行工具、不写主会话、不进会话列表（ui/ui.tsx:1-5；core/side-ask.ts:1-13）。
- 模型只在这次请求里回答，结果留在面板；停用它不影响 `ask_user` 工具本身（ui/ui.tsx:100-113）。

## 面板与数据

- 四个入口：正文选中文字浮出「问 AI」、Ctrl+Shift+K、命令面板两条动作、右侧栏「开始」页的旁问卡（ui/ui.tsx:7-11）。
- 数据来源：宿主 `sideAsk` / `sideAskCancel` / `listModels` 通道（ui/ui.tsx:265、309、344），实现是 core/side-ask.ts。
- 页签注册成 `ask` kind，挂在右侧栏；切页签只藏不卸，正在回答的那条不被打断（ui/ui.tsx:103-110）。
- 模型选择存 localStorage 的 `dsc.ask.model`，空串 = 跟随主会话（ui/ui.tsx:66-67、258-259）。
- 停用后：右侧栏没有旁问页签、选区不浮钮、Ctrl+Shift+K 无效、命令面板两条动作消失（ui/ui.tsx:100-113、154-162）。

## Known Limitations（已知限制）

- 上限：问题 4000 字、引用 8000 字、输出 1200 token、90 秒超时（core/side-ask.ts:17-28）。
- 气泡只在内存里按会话分桶，重启即清空（ui/store.ts:1-8、32）。
- 流式增量按票据追加，最终答案再由 invoke 返回值覆盖一次（ui/ui.tsx:272-275）。
- 模型清单只在挂载时取一次，换端点后要重启宿主（ui/ui.tsx:262-270）。
- 引用只接受字符串；空串表示没有引用，中间不能塞 undefined（ui/ui.tsx:306-309）。

## 行与开关

- 行 id `ui-ask`，包名 `@pneuma/ui-ask`，order 351（package.json:10-18）。
- resolution 是 overridable；默认开（cordis.patch.yml 里没有 `disabled`）。
- dsh.client：platform `pneuma`、api `^0.9.0`，没有 phase / inject（package.json:20-25）。
- 宿主半 inject 无、provide 无（index.ts:15-31）。
- title 曾是「模型提问（界面）」、与宿主包 `ask` 重名，2026-11-04 已改成「旁问（界面）」；若看到旧界面截图里的名字，是那之前的（package.json:17-18）。
