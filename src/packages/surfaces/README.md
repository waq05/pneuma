# surfaces（快照片段注册表）

一句话：界面快照里每块状态投影由对应功能点自己登记，装配层只问注册表要全部片段。

## Model Experience（模型体验）

- 不注册工具、不贡献提示词：它只服务界面快照（index.ts:1-8）。
- 模型侧没有直接读写变化（index.ts:18-31）。
- 但 transcript 声明了 inject `surfaces`，缺了它快照装配起不来，界面上所有登记片段一起缺席（transcript/index.ts:89-90、302）。

## Known Limitations（已知限制）

- 同 id 后注册者顶掉先注册者，退订只撤自己这一份（core/surface-registry.ts:36-49）。
- 某个投影抛错时沿用上一次的值；从没成功过就整键缺席（core/surface-registry.ts:56-74）。
- 每次装配都同步调用所有 read；某个 read 很慢会拖慢整帧（core/surface-registry.ts:15-19、60-63）。
- 片段顺序按注册顺序，不按 id 排序（core/surface-registry.ts:23-25）。
- 没有生命周期钩子：注册了就一直在，直到退订（core/surface-registry.ts:40-49）。

## 行与开关

- 行 id `surfaces`，包名 `@pneuma/surfaces`，order 40（package.json:10-18）。
- resolution 是 pinned（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- provide `surfaces`；不 inject 任何服务（index.ts:15-31）。
- 服务面三个成员：register / build / ids（index.ts:20-31）。
