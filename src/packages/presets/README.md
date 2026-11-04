# presets（模式预设）

一句话：presets 包管「模型是谁、手上有什么、被叮嘱了什么」——按会话换一段模式正文、收窄工具目录、按名单摘掉骨架提示段。

## Model Experience（模型体验）

- 不注册工具；注册一段系统提示，order 15，排在做事方式（10）之后、工具规范（20）之前，正文就是这个模式的提示词（index.ts:166-168）。
- 骨架取舍有两档手段：按 `drop` 名单整段去掉提示词（名单只有 behavior / tool-rules / instructions / skills 四段）；极简档用 `replace: true` 只留模式正文与 AGENTS.md 注入，插件贡献段全不进（core/presets.ts:55-63、index.ts:172-180）。
- 工具目录投影 `ctx.tools.project`：白名单只能从全量里取子集，带 `presets` 标签的工具只在列出的档里露面；极简档因此只剩 bash 与 read_image（index.ts:184-193、core/presets.ts:107-119）。
- 出厂四档：标准、极简、创造、PTC；第一次用到时写出文件，已存在的一律不覆盖（core/presets.ts:99-165、172-186）。
- 命令 `/preset <名字>` 支持中文别名；接了浮层的端开选择器，没接的端回一份清单（index.ts:208-233）。
- 停用之后，模型侧少掉模式正文与工具收窄：所有会话都回到全量工具与出厂提示词（index.ts:52-55）。

## Known Limitations（已知限制）

- 只做减法：工具白名单只能是全量子集，`drop` 只能在四段名单里挑；任何模式都放宽不了审批地板与守卫链（core/presets.ts:11-12）。
- 模式是会话属性：切走的会话在后台那一轮仍用它自己的档，不会因为你看别的会话而换掉工具目录（index.ts:65-83、200-204）。
- 标准档必须等价于「没有模式」：正文空、投影恒等；否则系统提示前缀一变，服务端提示缓存整段失效（core/presets.ts:13-15）。
- 坏文件不拦启动：解析不出来就带 `problem` 列出来，模型仍按标准档跑（core/presets.ts:16）。
- 模式名只许小写字母数字与连字符、最长 32 字符（core/presets.ts:66）。
- 模式文件放在 `~/.dsc/presets/<名字>.md`，一个模式一个文件；解析按 mtime 缓存，改完下一帧生效（core/presets.ts:2、195-229）。

## 行与开关

- 行 id `presets`，包名 `@pneuma/presets`，order 140。
- resolution 是 pinned（package.json 的 `pneuma.resolution`），profile 里的同名版本换不掉它。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 八个服务：`session`、`commands`、`prompt`、`tools`、`settings`、`surfaces`、`approval`、`mode`，并 provide `presets`（index.ts:54-55）。
- `pneuma.title` 2026-11-04 起是「模式预设」（原为「模式」，与 mode 包的「协作模式」只差两个字，容易点错）：本包管人格 + 工具集 + 提示词，不碰权限与闸门（core/presets.ts:6-8）。
- 没有设置分区：入口是 `/preset` 命令与快照 `preset`（index.ts:195）。
