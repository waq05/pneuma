# permission-presets（权限预设）

一句话：permission-presets 包把沙箱档位、权限模式、审阅者三根旋钮捆成一颗按钮，用户选一次就同时落三处。

## Model Experience（模型体验）

- 不注册工具、不注册提示词段：它只登记界面快照 `permissionPresets`（输入框那颗权限旋钮与设置页读它），模型侧看到的审批行为由沙箱与审批插件决定（index.ts:176、138-144）。
- 出厂四个预设：只读、工作区可写、完全访问、AI 复核；每个捆三根旋钮，取值见 core/permission-presets.ts:53-93。
- 应用时只写实际不同的那几根：沙箱走 `sandbox.setMode`，权限与审阅走 `approval.setPolicy` / `setReviewer`，所以预设结构上放宽不了安全（index.ts:87-108）。
- 三项拼不出任何预设时读作 `custom`：可以停在上面（设置页逐格改就会落到这里），但不能用 `use('custom')` 选它（core/permission-presets.ts:116-131、index.ts:145-155）。
- 停用之后，模型侧没有直接变化：少掉的是用户一键切档的能力，界面只能一格一格改沙箱与审批；模型收到的审批卡与放行范围仍由那两根旋钮决定（index.ts:33-34、87-96）。

## Known Limitations（已知限制）

- 沙箱插件没开时只落地权限那一半，并当场说一句「沙箱插件没开，read-only 这一半没落地」（index.ts:92-96）。
- 切换只写当前会话；新会话的默认档来自偏好 `defaultPermissionPreset`，出厂是「工作区可写」（index.ts:11-13、74-78，core/permission-presets.ts:96）。
- 取值一个都没变也照记一条审计：光看旋钮值分不出用户想要哪个预设，得靠这条记录（index.ts:109-119）。
- 四个内置预设删不掉；想微调就去设置页逐格改，改完读作 `custom`（core/permission-presets.ts:35-36）。
- 离开 `custom` 只能选一个真预设，`use('custom')` 会抛错并解释（index.ts:146-153）。

## 行与开关

- 行 id `permission-presets`，包名 `@pneuma/permission-presets`，order 180。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 六个服务：`approval`、`settings`、`surfaces`、`mode`、`session`、`transcript`，并 provide `permissionPresets`（index.ts:51-52）。
- package.json 的 `pneuma.title` 现在写着包名 `permission-presets`，没写中文名；插件中心会照它显示。
- 没有设置分区：入口只有那颗权限旋钮与设置页里逐格改的沙箱 / 审批项（index.ts:176）。
