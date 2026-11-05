# ui-prompt（等待用户决定的卡）

一句话：ui-prompt 是「输入框上方那三张等人决定的卡」的界面单元——画审批卡、计划审阅卡与提问卡，不碰提示词组装（那是宿主包 `prompt` 的事；本包只是包名沿用了它）。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词：宿主半是空 `apply`；界面半只注册一个槽条目（index.ts:31，ui/ui.tsx:63）。
- 模型卡在哪，它就画哪：三张卡分别读快照 `surfaces` 的 `pendingApproval` / `pendingPlan` / `pendingQuestion`（ui/ui.tsx:18-19、74-76）。
- 用户点下的答案经 `answerApproval` / `answerPlan` / `answerQuestion` 回到宿主（ui/ui.tsx:380、625、892），这就是模型那次挂起调用的结果——下一轮看到的是用户的选择，而不是这层卡片。
- 权限档位只显示、不给控件：`setPolicy` 不在界面通道白名单里（ui/ui.tsx:20-21）。
- 停用后模型侧不变，只是没人替它显示和应答这三张卡（index.ts:7-9）。

## Known Limitations（已知限制）

- 三张卡按「审批 → 计划 → 提问」固定次序排，不从偏好里读（ui/ui.tsx:68）。
- 样式一行不新写，class 名逐字照抄旧实现；改外观得改 `legacy/views.css`（ui/ui.tsx:9-13）。
- 三张卡各包一层错误边界，崩一张只顶掉那一张，另外两张照常能答（ui/ui.tsx:170-176、186-195）。
- 三张卡的动作只走界面通道放行的方法，表里没有的调不到（ui/ui.tsx:19-21）。

## 行与开关

- 行 id `ui-prompt`，包名 `@pneuma/ui-prompt`，order 358（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:31）。
- 槽条目 `shell.composer`、order 10，排在输入框（50）与排队条（60）之前（ui/ui.tsx:62-63）。
- 停用后这三张卡不出现；宿主侧那三份挂起状态还在，只是网页界面里没有地方应答（index.ts:7-9）。
