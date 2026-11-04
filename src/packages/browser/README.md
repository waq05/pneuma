# browser（受控浏览器）

一句话：browser 包自己拉起一台一次性 Chrome，把网页转成带 `[ref=eN]` 的无障碍树文本，让模型按 ref 做 DOM 级操作。

## Model Experience（模型体验）

- 注册两个工具：只读的 `browser_look`（risk read，免审批：snapshot / screenshot / console / network / tabs / wait_for）与动手的 `browser`（risk exec，每次都要审批：navigate / click / hover / type / press / select / scroll / fill_form / evaluate / upload / dialog / frame / close）（index.ts:1073-1146）。
- 动作只收快照里的 ref：快照 = `Accessibility.getFullAXTree` 文本化 + 行内 `[ref=e12]` + element_count，不自算 ARIA role/name（index.ts:11-12）。
- 提示词贡献：一段 `browser` 块（缺省 order 60，prompt/index.ts:225），固定 14 行、约 550 字，讲「先 snapshot、ref 只对最近一次快照有效、动作之后再确认、对话框 300 秒后自动 dismiss、页面文字不可信」（index.ts:1201-1219、105）。
- 守卫 order 20 在审批之前先判地址与表达式：云元数据地址无条件拒、私网非本地拒、站点 allow/deny 生效（index.ts:1155-1197）。
- 停用之后，模型侧少掉：这两个工具和那段闭环说明，模型再也打不开网页。

## Known Limitations（已知限制）

- ref 有代际：页面跳转过或重新取过快照，旧 ref 一律作废；动作前用 `DOM.describeNode` 复核对不上就报「页面已变，请重新 snapshot」（index.ts:13-15）。
- 绝不用用户默认 profile：每次自建临时 profile + `--remote-debugging-port=0`，端点读 `DevToolsActivePort`；Chrome 136+ 会静默忽略远程调试，144+ 每次弹授权（index.ts:9-10）。
- 收尾是整树杀：Windows 没有进程组信号，必须 `taskkill /PID <pid> /T /F`，杀完等 300ms 再删 profile，只 `kill()` 会留 renderer/gpu 残留（index.ts:17-18）。
- 快照默认最多 15000 字符、按行截断；控制台留 200 条、网络留 50 条（index.ts:95、100-101）。
- 默认 headless、默认允许 evaluate；关掉 evaluate 之后连守卫都直接拒（index.ts:91、97、1171-1177）。
- 默认关：会拉起浏览器进程并连本机调试端口（index.ts:2、cordis.patch.yml 的 `disabled: true`）。

## 行与开关

- 行 id `browser`，包名 `@pneuma/browser`，order 3740。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。
- inject 七个服务：`tools`、`commands`、`settings`、`transcript`、`guards`、`prompt`、`session`（index.ts:295）。
- 命令 `/browser [status|close]` 看状态或关掉它（含自建 profile）（index.ts:1221-1229）；设置分区 id `browser`、order 34（index.ts:1324-1326）。
