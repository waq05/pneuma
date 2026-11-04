# prompt（提示词组装）

一句话：prompt 包是系统提示词的段落注册表与请求体投影链，谁想加一段话或改一次发给模型的消息，都登记到这里。

## Model Experience（模型体验）

- 不注册工具；它提供 `prompt` 服务，开放三类登记：提示段 `register`、环境事实 `registerEnvFacts`、命名投影 `registerProjection`，另加骨架过滤器 `registerSkeletonFilter`（index.ts:223-262）。
- 系统提示由它组装：各插件登记的段按 order 排，拼上技能目录与「当前模型」那一行（order 890），指令文件按字符预算截断，默认 20000 字、可填 4000..200000（index.ts:282-291、53-58，packages/session-core/prompt.ts:67）。
- 五条内置投影按固定次序串成链：fold-system（500）并 system、image-diet（550）卸载旧图、tool-result-prune（560）剪超长工具结果、env-facts（600）补环境快照、drop-images（900）剥图；插件投影插在中间（index.ts:137-221）。
- 环境快照把日期、平台、工作目录与各插件登记的事实拼成一条 user 消息补在请求末尾，默认每轮都发——「平台是 Windows」只有这一个载体，跳过一轮模型就可能写出 bash-ism（index.ts:144-186、319-322）。
- 投影是命名的纯函数，日志存原文、模型看投影结果，所以「模型看见了什么」可以从会话日志复算（文件头 15-16）。
- 停用之后：`prompt` 服务缺席，按 inject 规则依赖它的插件都挂不上，模型侧会一起少掉它们的提示段与投影（index.ts:85-88、308）。

## Known Limitations（已知限制）

- `fold-system` 与 `drop-images` 是内核保留的投影名，插件同名注册直接抛错（index.ts:45-46、236-239）。
- 容错方向是「少一段也别整轮失败」：某条投影抛错就跳过它并播一条 notice，提示段生成崩了同样跳过（index.ts:250-254、295-303）。
- 环境快照的「变了才发」是可选项，默认关（`envRefreshMs`=0 即每轮都发）；打开后被跳过的那几轮请求里确实没有快照，因为它是投影注入、不落会话历史（index.ts:61-83、144-157）。
- 指令文件预算的单位是字符不是字节，区间 4000..200000（index.ts:49-57）。
- 投影次序是硬编码的，插件只能给自己的投影一个 order，撞号时按 id 字典序排，不能插进两条护栏中间（index.ts:128-132）。

## 行与开关

- 行 id `prompt`，包名 `@pneuma/prompt`，order 120。
- resolution 是 pinned（package.json 的 `pneuma.resolution`），profile 里的同名版本换不掉它。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 三个服务：`llm`、`skills`、`session`，并 provide `prompt`（index.ts:87-88）。
- 没有设置分区与命令：两项配置（`instructionBudget`、`envRefreshMs`）只从条目树的 config 读（index.ts:33-34、53-83）。
