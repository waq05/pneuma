# config-core（配置核心库）

一句话：用户级「模式（preset）」文件的读写与技能市场的浏览安装，presets / runtime-api / skills / plugin-manager 四个功能包共用。

## Model Experience（模型体验）

- 用户能感知到 `/preset` 切换、设置页里的模式列表，以及「从市场装一个技能」；模型能感知到的是系统提示词里多出的一段模式条款（presets.ts:1-11）。
- 一个模式就是 `~/.dsc/presets/<名字>.md`：frontmatter 决定工具白名单与骨架段取舍，正文追加进提示词（presets.ts:1-4）。
- 默认档必须等价于「没有模式这个概念」：标准模式的工具投影是恒等映射、提示段是空串，系统提示词逐字节不变（presets.ts:12-16）。
- 市场支持 GitHub 目录链接与索引 JSON 两类源，条目清单缓存 1 小时（market.ts:1-15）。

## Known Limitations（已知限制）

- 模式只做减法：工具白名单只能是全量的子集，`drop` 只能去掉固定名单里的骨架段（presets.ts:9-11）。
- 坏的模式文件不拦启动：解析不出来就带 problem 列出来，模型仍按标准档跑（presets.ts:17-18）。
- 市场只拉 GitHub raw 与索引 JSON，没有鉴权与签名校验；匿名限额低，有 `GITHUB_TOKEN` 才用（market.ts:10-13）。
- 单文件超过 1.5 MB、单技能附属文件超过 40 个不拉，免得一次安装把家目录灌满（market.ts:13-15）。
- 写到哪儿由调用方给目录（技能目录或 `pluginsDir`），本包不判断目标目录的权限与可写性（market.ts:239-260）。

## 谁在用它

- `presets`：listPresets / readPreset / writePreset 等模式文件读写。
- `runtime-api`：DROPPABLE_SECTIONS / DSC_PRESETS_DIR 两个常量。
- `skills`：market 的技能浏览与安装。
- `plugin-manager`：market 的插件市场条目浏览与安装。
