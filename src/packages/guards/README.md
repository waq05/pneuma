# guards（工具守卫链）

一句话：guards 包提供 `guards` 服务，把「工具执行前问一条守卫链、执行后过一条结果观察者链」做成内核扩展点，自己不做任何判定。

## Model Experience（模型体验）

- 不注册工具，也不加提示词：它只把一个注册表挂成服务，再交出 `register` / `registerObserver` / `chain` / `gate` / `observe` 五个入口（index.ts:20-31）。
- 链的语义决定模型看到什么：按 order 排序依次问，第一位给出 deny 或 pass 的赢，都没意见就 defer 让工具照常执行（core/tool-guards.ts:61-72）。
- 模型能感知的拒绝，全部来自链上的其它包：灾难地板 5、模式闸门 10、安全钩子 20、改动前预览 25、审批 30 各自写的 reason（刻度见 core/tool-guards.ts:47、file-review/index.ts:4-9）。
- 观察者链只加工工具结果文本，后一位看到的是前一位的输出；遮红是内置唯一一位（core/tool-guards.ts:53-59）。
- 停用之后，模型侧少掉：全部工具调用——agent 自己 inject 了 `guards`（agent/index.ts:53），服务缺席时对话循环根本挂不上。

## Known Limitations（已知限制）

- 它自己不做判定：链上没人注册时 `gate` 恒返回 defer，工具照常执行（core/tool-guards.ts:74-77）。
- 同 id 后注册者顶掉前注册者，不报冲突——两个插件用同一个 id 会互相覆盖（core/tool-guards.ts:45、82-88）。
- 观察者改的是文本，不能拦下调用，也不能改参数（core/tool-guards.ts:53-59）。
- 链上抛错按拒处理，所以挂进来的守卫必须自己吞掉「算不动」这类失败（core/tool-guards.ts:103-113，file-review 就为此自己兜底）。

## 行与开关

- 行 id `guards`，包名 `@pneuma/guards`，order 30。
- resolution 是 pinned：profile 里的同名副本不生效（core/plugin-loader.ts:1503-1514）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- 不 inject 任何服务，只 provide 一个 `guards`（index.ts:18-19、31）。
- 注册表本体在 `core/tool-guards.ts` 的 `ToolGuardRegistry`，自检脚本直接测那一份（index.ts:8-9、14）。
