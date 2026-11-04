# permission-core（权限核心库）

一句话：会话级权限三项（沙箱档位 / 权限模式 / 审阅者）的读写，以及「把三项捆成具名预设」的推导；approval / sandbox / settings / permission-presets 四个功能包共用。

## Model Experience（模型体验）

- 模型不直接看见本包；用户能感知到的是「在 A 会话切只读，B 会话不再跟着变」（permission-scope.ts:1-8）。
- 设置页的预设下拉与「自定义」标签由 `permission-presets.ts` 推导；不匹配任何预设的组合读作 `custom`，可以停在它上面，但不能被选中（permission-presets.ts:13-15）。
- 预设只做组合、不放宽安全：写口仍走沙箱与审批各自的 setter，由它们校验并记审计（permission-presets.ts:8-12）。
- 打开会话时补三条默认值只改内存、不立刻写盘，避免「只看一眼」就刷新会话文件时间、让侧栏的最近使用跳成「刚刚」（permission-scope.ts:12-16）。

## Known Limitations（已知限制）

- 这一层是纯的：不读磁盘、不认识插件，只认一个最小的会话形状（permission-scope.ts:18-20）。
- 三项的持久化靠会话日志的 `state` 条目，本包不写 jsonl，也不管会话的创建、恢复与分叉（permission-scope.ts:4-8）。
- 预设表是静态内置的，没有用户自定义预设的加载与校验（permission-presets.ts:53）。
- 灾难地板（看一眼命令就拦）不认预设，由调用方另行判定（permission-presets.ts:9-11）。
- 破坏性操作与审计记录的最终责任在调用方，本包不落任何日志（permission-scope.ts:18-20）。

## 谁在用它

- `approval`、`sandbox`：permissionOf / writePermissions 读写会话三项。
- `permission-presets`：matchPermissionPreset 等预设推导。
- `settings`：derivedPresetLabel 画预设说明。
