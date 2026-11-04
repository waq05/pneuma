# spill（长输出转存）

一句话：工具输出超过阈值就写到磁盘，模型只看到头尾几行、文件路径和续读写法。

## Model Experience（模型体验）

- 观察者 order 50，排在遮红（把密钥换成占位符，order 10）之后：写盘的已经是脱敏文本（index.ts:3-8、32）。
- 超过阈值（默认 4000 字符）就落盘，回给模型的是头尾若干行预览、路径与 `read(path, offset, limit)` 续读写法（core/spill.ts:67-75）。
- `read` 豁免：它读的就是模型点名要的那段，再落盘只会让模型去读另一个文件（index.ts:34-35）。
- 设置保存后立刻生效；阈值、预览行数、续读行数、单文件上限、保留天数、总量上限都可调（index.ts:41-42、89-168）。
- 落盘失败就原文返回，并只在本次挂载内提醒一次，不让工具结果丢失（index.ts:10-12、73-81）。

## Known Limitations（已知限制）

- 清理是节流的：5 分钟才扫一次目录，退出时再扫一次；刚落盘的那份始终保留（index.ts:45-48、62-71、227-232）。
- 目录权限 0700、文件 0600；换目录后第一次落盘才创建（index.ts:152-153）。
- 观察者顺序不能反：order 若小于 10，密钥会以原文落盘（index.ts:3-8）。
- 预览是截断文本，模型要细节必须再发一次 read，会多一轮工具调用（core/spill.ts:1-8）。
- 只处理工具输出，不处理用户消息、模型正文或提示词（index.ts:55-60）。

## 行与开关

- 行 id `spill`，包名 `@pneuma/spill`，order 3650（package.json:10-18）。
- resolution 是 overridable（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject `guards`、`session`、`settings`、`transcript`（index.ts:39）。
- 设置分区 id `spill`，order 37，含六项数值、目录与「立刻清理」按钮（index.ts:171-223）。
