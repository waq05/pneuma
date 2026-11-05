# ui-composer（输入区）

一句话：输入区界面单元——输入框、模型与思考两颗粒、权限预设、附件与排队消息条。

## Model Experience（模型体验）

- 纯界面单元：宿主半是空 `apply`，不注册工具、不写提示词（index.ts:3-9、30）。
- 用户消息经 `submit` 进入回合；插话与打断也走宿主通道，不另起一条模型链路（ui/ui.tsx:383、397、415）。
- `/` 指令在入口被拦下，不再把斜杠文本当普通消息发给模型（ui/ui.tsx:21-23）。
- 权限预设的写路径走原生桥 `usePermissionPreset`，不在界面通道白名单里（ui/ui.tsx:14-20、433-435）。

## 面板与数据

- 三个槽：通知条 order 40、排队条 order 45、输入框 order 50，排队条紧贴在输入框**上面**（ui/ui.tsx:139-145）。
- 数据来自快照：`turnState`、`hasApproval`、`inboxCount`、`permissionPresets`、`preset`、`git`、`sessionPath`（ui/ui.tsx:132-139）。
- 发送走 `submit`，插话走 `steerQueued`，打断走 `interrupt`（ui/ui.tsx:383、397、415）。
- 队列条用 `editQueued` / `removeQueued` / `steerQueued` 改收件箱（ui/queue-dock.tsx:76-103）。
- 停用后：输入框、模型与档位旋钮、附件、排队条一起消失；首屏能力卡的 `composerDraft` 写入服务也没了（ui/ui.tsx:113-127）。

## Known Limitations（已知限制）

- 草稿只活在进程内，刷新页面不恢复（ui/ui.tsx:102-111）。
- 历史输入只留 50 条（ui/ui.tsx:90-91）。
- 权限预设写口只对装了 preload 的桌面窗口开放，浏览器里点选项会明确说不行（ui/ui.tsx:18-20）。
- 视频要在本机抽 6 帧当图片带给模型，不支持视频输入的模型只能看关键帧（ui/ui.tsx:26-28）。
- 输入框自动增高上限 200px（ui/ui.tsx:88-89）。

## 行与开关

- 行 id `ui-composer`，包名 `@pneuma/ui-composer`，order 353（package.json:10-18）。
- resolution 是 overridable；默认开（cordis.patch.yml 里没有 `disabled`）。
- dsh.client：platform `pneuma`、api `^0.9.0`、phase `early`，没有 inject（package.json:20-26）。
- 宿主半 inject 无；界面半 provide `composerDraft`（index.ts:15-30；ui/ui.tsx:117-121）。
