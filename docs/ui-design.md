# dsc 界面开发规范

面向**要动界面的人**。参考系是 hermes 桌面端（`D:\hermes\hermes-agent\apps\desktop\DESIGN.md`），
但那套 `--ui-*` 变量、Tabler 图标、nanostores 是 hermes 自己的实现；dsc 的落地是三份样式表加
一层原语，本文档讲的就是「hermes 的设计意图 → dsc 怎么写」。

| 想知道 | 去看 |
| --- | --- |
| 代码怎么分层、往哪改、怎么验证 | [development.md](development.md) |
| **界面长什么样、新控件往哪加** | **本文档** |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |

改界面之前先读第 1 节和第 2 节；写完自查用第 13 节。终端界面（`src/app/`，ink）不在本文档范围。

桌面端默认界面已是 `ui-shell/` 的插件化界面壳，壳与旧渲染层共用同一套 `--dsc-*` 令牌（壳侧那一份在 `ui-shell/src/legacy/`），本文档讲的令牌与原语两处都适用。

## 1. 七条设计原则

hermes 的 `DESIGN.md` 开头有七条，逐条换成 dsc 的说法：

| # | 原则 | 在 dsc 里意味着什么 |
| --- | --- | --- |
| 1 | **扁平，不做盒子套盒子** | 面板里不要再套卡片，不要用分隔线切列表。用留白和一条发丝线分组。 |
| 2 | **浮层用无边框抬升** | 弹层 = `--dsc-bg-popover` + `--dsc-shadow-float` + 一条 `--dsc-stroke-float`，不画粗边框。 |
| 3 | **一个关注点一个原语** | 按钮只有 `.dsc-btn`，列表行只有 `.dsc-row`。新需求先想能不能用已有的，不能就扩它，别另起一个。 |
| 4 | **用令牌，不用字面量** | 颜色、圆角、字号、间距、层级、时长一律写 `var(--dsc-*)`。样式表里出现十六进制颜色就算 bug（例外见 §2.6）。 |
| 5 | **样式住在原语里** | 调用点给 `data-variant` / `data-size`，不许在调用点覆盖原语的 padding、圆角、颜色。 |
| 6 | **意图先于自动** | 后台有结果回来可以更新角标和缓存，但不许自己切页面、抢焦点、弹面板。 |
| 7 | **即时反馈** | 直接操作先改界面，落盘和网络后面对账；失败了要看得见地回滚。 |

第 1、4、5 条是这轮重构的主线：改之前 `styles.css` 里有 28 处写死的颜色、24 处圆角字面量、
6 处 z-index 字面量，现在分别是 6 处（故意留的）、6 处、0 处。

## 2. 令牌体系（`styles/tokens.css`）

全部令牌在这一份文件里，**深色写在 `:root`，浅色写在 `[data-theme='light']`，密度写在
`[data-density='compact'|'roomy']`**。样式表其余部分只引用，不定义。

### 2.1 颜色是怎么长出来的

不是一张写死的色表，是一条「中性底 + 种子色 + 混比」的链条：

```
--dsc-neutral-page/-side/-card   中性底色（无彩）
--dsc-seed-page/-side/-card      带品牌倾向的种子色
--dsc-mix-page/-side/-card       种子色占多少
   ↓
--dsc-bg-page / --dsc-bg-side / --dsc-bg-card     页面 / 侧栏 / 卡片底
--dsc-bg-raised → --dsc-bg-popover                抬升面 → 浮层底
```

浅色主题只换中性底、种子色和混比这三组，上面那层派生自动跟着变。**加新的表面色要挂在这条链上**，
不要直接写 `#fff`。

### 2.2 颜色角色表

| 角色 | 令牌 | 用在哪 |
| --- | --- | --- |
| 页面 / 侧栏 / 卡片 | `--dsc-bg-page` `--dsc-bg-side` `--dsc-bg-card` | 三层底色，别越级 |
| 抬升 / 浮层 | `--dsc-bg-raised` `--dsc-bg-popover` | 弹层、菜单、对话框 |
| 软填充五档 | `--dsc-fill-primary` … `--dsc-fill-quinary` | 从最实到最淡的控制底，按「这块要多显眼」选 |
| 行 / 控制态 | `--dsc-row-hover-bg` `--dsc-row-active-bg` `--dsc-control-hover-bg` `--dsc-control-active-bg` | 悬停与选中 |
| 文字四级 | `--dsc-text-primary` `-secondary` `-tertiary` `-quaternary` | 正文 / 次要 / 提示 / 装饰，**不要自造透明度** |
| 骨架文字 | `--dsc-text-scaffold` `--dsc-text-scaffold-meta` | 顶栏、状态栏这类框架文字 |
| 描边四级 | `--dsc-stroke-1` … `--dsc-stroke-4` | 1 最强（最明显），界面分隔默认用 `--dsc-stroke-3` |
| 浮层发丝线 | `--dsc-stroke-float` | 只在浮层上，跟 `--dsc-shadow-float` 配对 |
| 语义色 | `--dsc-red` `-orange` `-yellow` `-green` `-cyan` `-purple` | 状态、图标、图表；深浅两套取值不同 |
| 品牌 | `--dsc-accent` `--dsc-accent-hover` `--dsc-accent-text` `--dsc-text-on-accent` | 主行动、选中、链接 |

`--dsc-accent-text` 和 `--dsc-accent-hover` 是**派生色**，写在 `tokens.css` 末尾的 `:root` 块里，
用 `color-mix()` 从主题变量算出来，这样浅色主题会自己重算。新增派生色照这个写法。

浅色主题的侧栏底色是**灰绿**（`--dsc-seed-side: #eef5f2`，`--dsc-mix-side: 100%`）：靠色相把侧栏与
正文白分开，不用再画分隔线。改它只动这一个变量，别在组件里写死。

**主色只干三件事**（2026-10-25 补，品牌声部的第一条规矩）：可交互（链接、主按钮）、选中（当前行、
当前页签）、焦点（焦环、输入框激活边）。**不拿它当装饰色**——标题、图标、空态底纹、图表系列色
一律走语义色或中性色。Codex 的招牌是薄荷侧栏 + 鱼形 logo，我们的招牌是灰绿侧栏 + 熊猫头，
主色只是第三个元素；三样东西各占一个层级，界面才有「这是谁」而不只是「这很干净」。

### 2.3 圆角、间距、尺寸

| 组 | 令牌 | 取值 | 规矩 |
| --- | --- | --- | --- |
| 圆角 | `--dsc-r-control` `-badge` `-icon` `-block` `-row` `-overlay` `-card` `-composer` `-pill` | 6 / 3 / 4 / 7 / 8 / 8 / 14 / 12 / 999 px | 方角不做胶囊。**不许写圆角字面量**，没有合适的那一档再商量加一档。2026-10-24 外观档整档上调过一次（`ui-shell/src/styles.css` 末节）。 |
| 间距 | `--dsc-sp-0` … `--dsc-sp-8` | 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 px | 布局留白走这一套，别写 `gap: 13px` |
| 行几何 | `--dsc-row-h` `--dsc-row-pad-x` `--dsc-row-gap` `--dsc-row-lead` | 32px×密度 / 8 / 6 / 14 | 所有列表行共用；过程行另用 `--dsc-process-row-h`（28px×密度） |
| 控制尺寸 | `--dsc-ctl` `-sm` `-lg` `--dsc-send` `--dsc-input-min-h` `-max-h` | 24 / 20 / 32 / 26 / 26 / 150 px | 按钮与控制件对齐用 |
| 标题栏 | `--dsc-titlebar-h` `--dsc-titlebar-btn` `--dsc-titlebar-icon` | 36 / 24 / 13.9 px | 和原生控件条一起算，见 §10 |
| 版面 | `--dsc-sidebar-w` `--dsc-sidebar-rail` `--dsc-page-inset` `--dsc-page-max` `--dsc-thread-max` | 237px / 56px / clamp(20px,4vw,64px) / 1200px / 76ch | 正文列宽用 `ch`，别写 px |

### 2.4 字体阶梯

字号全部走 `--dsc-font-scale`，所以「外观 → 字号」改一档全局跟着变。

| 令牌 | 基准 | 用在哪 |
| --- | --- | --- |
| `--dsc-fs-body` / `--dsc-lh-body` | 14 / 20 px | 正文、会话标题（与正文 pro 档同大，长回答不再比侧栏字小） |
| `--dsc-fs-caption` / `--dsc-lh-caption` | 12 / 16 px | 说明、时间、次要信息 |
| `--dsc-fs-tool` | 11 px | 工具行参数与结果 |
| `--dsc-fs-label` `--dsc-fs-micro` | 10.2 / 9.6 px | 小节标签、角标 |
| `--dsc-fs-code` | 11.2 px | 代码块与行内代码 |
| `--dsc-fs-ui` `--dsc-fs-ui-lg` | 12 / 14 px | 界面控件文字 |
| `--dsc-fs-title` `--dsc-fs-hero` | 16 / 28 px | 面板标题、欢迎页大字 |
| `--dsc-fs-prose` / `--dsc-lh-prose` | 14 / 22 px | 模型长文（比界面正文大一档，读起来不费劲） |

小节标签还有 `--dsc-label-case: uppercase` 和 `--dsc-label-track: 0.16em`，用 `.dsc-sect` 自动带上。

### 2.5 密度

`--dsc-density` 一个数乘出行高、堆叠间距、块间距、回合间距：标准 `1`、紧凑 `0.9`、宽松 `1.15`。
**新写的垂直节奏要乘它**（`calc(6px * var(--dsc-density))`），否则「外观 → 密度」对它无效。

### 2.6 阴影、层级、动效

| 组 | 令牌 | 用在哪 |
| --- | --- | --- |
| 阴影 | `--dsc-shadow-xs` `-sm` `-md` `-float` `-composer` | `xs` 贴地、`md` 菜单与下拉、`float` 弹层与对话框、`composer` 输入区 |
| 层级 | `--dsc-z-dock` 20 / `-handle` 24 / `-menu` 40 / `-backdrop` 120 / `-modal` 130 / `-modal-popover` 140 / `-toast` 200 / `-tip` 210 / `-picker` 220 / `-crash` 1500 | 选一档，**不许写 `z-index: 9999`**。正文右上角的胶囊取 `-menu` − 1（39）：它要盖正文，但永远让位给菜单 |
| 动效 | `--dsc-dur` 140ms / `--dsc-dur-slow` 200ms / `--dsc-ease` `cubic-bezier(0.16, 1, 0.3, 1)` | 过渡只写 `var(--dsc-dur) var(--dsc-ease)`。缓动前段快、尾段收，位移收尾有「到位」感 |
| 提示 | `--dsc-tip-delay` 200ms / `--dsc-tip-warm` 300ms | 首次悬停等 200ms，热了之后 300ms 内秒开 |

**故意保留的颜色字面量只有两类**：界面自己的 6 处（品牌渐变 logo 和它上面的白字、彩底上的白色图标、
开关的白滑块、两处深色遮罩——`.dsc-overlay` 与设置页遮罩），以及**读对象本身颜色**的那几套：代码文件片的
品牌色（`code-file-icon-artwork.ts`）、工作区的彩色图标（`icons-workspace.tsx`：文件夹琥珀、终端绿、
VS Code 蓝、复制蓝灰）。后一类跟主题明暗无关，换成 `--dsc-*` 只会让图标随主题跳色。别的地方出现 `#`
开头的颜色就是漏网的。

## 3. 原语层（`styles/primitives.css`）

一个关注点一个原语，全部 `.dsc-` 前缀、全部用属性选档位。**调用点只给属性，不给尺寸。**

### 3.1 按钮 `.dsc-btn`

变体（`data-variant`）：`primary`（实心品牌色，一屏通常只该有一个）、`destructive`（危险）、
`secondary`（软填充，非主按钮的默认长相）、`outline`（透明底 + 1px 内描边）、`chip`（可点的筛选片）、
`ghost`（只靠悬停背景说话）、`floating`（浮在任意表面之外）、`grip`（拖拽把手）、
`text` / `textStrong` / `link`（行内文字行动作，前者悬停才下划线、中者始终带下划线）。

尺寸（`data-size`）：`xs` / `sm` / `lg` / `inline`（嵌在句子里、不带盒子）/ `micro`（状态条与表尾）、
`icon` / `icon-xs` / `icon-sm` / `icon-titlebar`。

规矩：基础圆角是 `--dsc-r-control`(2.5px)，只有图标档换成 `--dsc-r-icon`(4px)；按钮高度由 padding
和行高决定，不设固定高度（`primitives.css:15`）。SVG 尺寸由档位定，别在调用点改。

### 3.2 其余原语

| 原语 | 选择器 | 档位与要点 |
| --- | --- | --- |
| 表单控件 | `.dsc-ctl` | 输入框/文本域/下拉共用；静息描边 7%，悬停翻倍，聚焦更亮；`aria-invalid` 走危险色；`data-size: xs/sm` |
| 字段行 | `.dsc-field` `__label` `__help` | 设置页每一行就是「标签 + 说明 + 控件」 |
| 徽标 / 计数 | `.dsc-badge` | `data-tone: accent/muted/success/warn/danger/outline`，`data-size: xs`；**徽标不可点**，可点的筛选片是 `.dsc-btn[data-variant='chip']` |
| 分段选择 | `.dsc-segmented` `__btn` | 少量互斥选项（主题、密度、统计周期）；两态视图切换不用它，用一个 `ghost` 图标按钮显示「切过去是什么」 |
| 列表行 | `.dsc-row` `__body` `__lead` `__label` `__meta` `__actions` | 侧栏会话行是基准，导航行、插件行、技能行、设置行、归档行全沿用它的几何；`data-active` / `aria-current` 表选中 |
| 小节标签 | `.dsc-sect` `__meta` | `meta` 槽放计数 |
| 日期分隔 | `.dsc-date-sep` | 两侧发丝线由伪元素画 |
| 文本标签页 | `.dsc-tabs` `__btn` | 用 `aria-selected` 表选中 |
| 浮层容器 | `.dsc-pop` | `data-size: menu/menu-lg/menu-xl`；底色 + `--dsc-shadow-float` |
| 菜单 | `.dsc-menu` `__item` `__label` `__sep` `__key` | `__item[data-tone='danger']` 是危险项，`__key` 放快捷键 |
| 遮罩对话框 | `.dsc-overlay` `__card` | 卡片 = 抬升面 + 浮层阴影 |
| 确认框 | `.dsc-confirm` `__title` `__detail` `__actions` | 走 `confirmAction()`，见 §6 |
| 悬浮提示 | `.dsc-tip` | 走 `installTipLayer()`，见 §7 |
| 加载 / 骨架 / 空态 / 列表内空态 | `.dsc-loader` `.dsc-skeleton` `.dsc-state-empty` `.dsc-state-inlist` | 别再手写第三种居中空态 |
| 通告 / 吐司 | `.dsc-notice` `.dsc-toast` | 通告目前只有 `data-tone='danger'`；吐司有 `danger` 和 `success` |

### 3.3 什么时候扩原语、什么时候别新建

- 新控件只是**已有原语换一套参数**？加一档 `data-*`，别新建类。
- 新控件是**新的关注点**（dsc 里还没有的东西）？在 `primitives.css` 里按同样的写法加一节，
  并在本节表格里补一行。
- 只在**一个页面里用一次**、且不是通用语义？写进 `styles.css` 的功能区，标好注释。
- 想把某个页面的原语「微调一下」？先问是不是原语本身该改——改一处、处处受益，比在调用点覆盖强。

## 4. 布局与几何

- 三栏：56px 图标窄栏 → 可拖宽的侧栏（默认 237px）→ 正文列。侧栏和正文列两侧都能拖
  （`ThreadResizer.tsx`，拖出来的宽度写成根元素上的 CSS 变量）。
- 页面左右留白用 `--dsc-page-inset`，内容最大宽度 `--dsc-page-max`；正文段落宽度 `--dsc-thread-max`（76ch）。
- 列表行之间**默认不加分隔线**，用间距分开；确实需要时用一条 `--dsc-stroke-3` 发丝线。
- 顶栏高度和原生控件条联动，见 §10。
- 面板尺寸与收起状态存在 `panels.ts` 里，重启后恢复（`development.md` §13）。

## 5. 聊天、工具行与状态

- **对话是主界面**：正文栏永远优先，工具、预览、轨迹是补充。
- 工具行（`ToolCard.tsx`）：参数与结果用 `--dsc-fs-tool`；展开的详情高度上限 `--dsc-tool-detail-max-h`。
- **危险红只给真正的失败**：用户拒绝、执行报错才用 `--dsc-red`；读不到文件、退出码 1 这类模糊结果
  用中性通告（这就是「已拒绝」状态落盘那一轮改的东西）。
- 思考块、工具块这类「面板里的面」用 `--dsc-fill-quinary` 一档的软填充，不要描边。
- **收起态只占一行，结果靠「+N 行」提示**（2026-10-27 改口径，之前摊 3 行）：头行右侧写
  「+N 行」当读数，点开才看结果。原来照 codex 的 `DETAIL_PREVIEW_LINES=3` 摊预览，一张卡从一行
  变四行、一轮十几张就是半屏——预览是锦上添花，密度才是列表的常态。展开体与轨迹页不重复摊同一份结果。
- **失败数挂在组头**（`.step-fold-fail`）：阶段组收起时组头是唯一看得见的一行，
  「N 失败」只算 `failed`，不算 `rejected`（用户拒绝审批不是这一组跑挂）。
- **组体比组头缩进一格**：`.step-body` 左缘 3px + 1px `--dsc-stroke-2` 竖线 + 9px 内距。
  两层左缘对齐时，展开后的行会被读成组头的同级兄弟。
- **头行的读数让位给操作**：头行尾部那颗「在轨迹中查看」绝对定位压在读数上，
  悬停时读数淡出、按钮淡入——与侧栏会话行同一套手法，行内其他格子不动。
  **压在正文上的按钮，底色必须不透明**：摘要（`.preview`）是 `flex: 1`，会一路铺到药丸底下，
  而它不参与淡出；药丸如果还用 4% 的 `--dsc-fill-quaternary`，那半句路径就从按钮里透出来，
  读成「按钮和文字重叠」（2026-10-27 用户报障）。改用 `--dsc-bg-raised` 这种实色面。
- **过程行的标题照 dsh 的词表，不随状态变形**（2026-10-27，用户：「搜了、写了、跑了、思考过程，不舒服」）：
  行首写「这是什么操作」（读取 / 写入 / 编辑 / 运行命令 / 查找文件 / 搜索文件内容 / 网页获取，
  认不出的工具写「工具调用 · <原名>」），做没做完、成没成交给行尾状态词与状态点。
  同一行在三态之间换字（正在读 → 读了）会让一屏十几个标题都变成叙述句，而且中文的
  「了 / 正在」跟状态词叠在一起是重复信息。思考行的标题同理，用 dsh `message.think` 的两个字「思考」。
- **胶囊不报全局增删行数**（2026-10-27，用户：「+/- 行数只在编辑文件的操作显示就行」）：
  那颗常驻胶囊量的是**整个工作区**相对 HEAD 的差（含不是这次会话改的、含还没提交的），
  它一直在跳、又对不上任何一次操作；真要按行数看改动，工具卡（写入 / 编辑）与轮尾
  「文件已更改」卡上那一份才是「这次改了什么」。胶囊与 Git 分区头现在只留「N 个文件」这个粗读数。
- 步骤时间线的竖线是**中性色**（`color-mix(in srgb, var(--dsc-base) 10%, transparent)`），
  不要用带品牌色的 `--dsc-stroke-1`——浅色主题下会变成一条很吵的蓝线。
- 审批卡（`ApprovalCard.tsx`）停在对话流里，不抢焦点、不自动展开面板。卡只渲染在**发起它的那个会话**的视图里
  （kernel 的 `pendingView` 按当前查看会话过滤，0.6.50）——后台会话的卡留在自己家，侧栏橙点引导你切过去；
  别的会话的卡挂着时，当前会话的输入框不被禁用。
- 用户气泡里的贴图（`.entry-user-images img`）用 132×96 固定框 + `object-fit: contain`：
  截图和 1×1 的小图都占同一格，点开是原图；输入框上方那排待发贴图（`.attach-strip`）同理由，56×56，
  双击开全屏 lightbox（`.img-lightbox`，遮罩走 `--dsc-scrim`，点击任意处或 Esc 关）——贴图是 dataURL
  没有路径，复用不了文件预览页签，才自立这个最轻的浮层。
- 后台事件（工具结果、队友完工）只更新角标和缓存，**不许替换前台正文或抢焦点**（原则 6）。
- **浮起的控件悬停只能叠加，不能换底**：`--dsc-control-hover-bg` 是 8% 的提亮色（浅色主题 9.8%），
  只配盖在不透明底上。浮钮 / 菜单这类自己带底的面，悬停要写成
  `linear-gradient(叠加色, 叠加色), var(--dsc-bg-popover)`——单独拿它当背景，底色就没了，下层正文透出来
  （2026-10-26 选区浮钮就是这个形状，`styles.css` 有注释）。
- **思考强度画成滑杆，不画成一列按钮**（2026-10-26）：关 < 低 < 高 < 最大 是有顺序的四档，
  一列按钮看不出顺序、也看不出「再往上还有一档」。滑杆用一条绿→蓝的渐变轨道（
  `--dsc-green` → `--dsc-cyan` → `--dsc-purple`），点亮到当前档，后面一截留淡色；
  拖动只预览、松手才发 `setEffort`，所以拖着扫过四档不会连着打四个请求。
  四档四套动效：关＝灰掉且静止；低＝慢呼吸；高＝一道扫光；最大＝扫光更快 + 轨道外发光 +
  滑钮光环。`prefers-reduced-motion` 下全停。
- **顶栏里的按钮必须自己声明 `no-drag`**：`.topbar` 整条是窗口拖拽区（`-webkit-app-region: drag`），
  按钮不带 `-webkit-app-region: no-drag` 时点击会被当成拖窗口，事件根本进不到 React——
  表现是「按钮点不动」（2026-10-26 顶栏搜索钮就是这个）。同坑的前车：`.dock-toggle` / `.ws-open`。
  **从 header 槽渲染的浮层要整块豁免**：遮罩（`.settings-mask` / `.palette-mask`）自己声明 `no-drag`，
  否则整块矩形仍在拖拽区里——真机上滚轮被当「在标题栏上滚」直接丢掉、行点不着、✕ 按不下去
  （2026-10-27 命令面板「还是不能滚动」就是这一条）。
  更要紧的是：**自检抓不到这类问题**。CDP 合成的鼠标事件绕过了操作系统的命中判定，
  探针全绿而用户滚不动——所以这类坑只能靠样式断言（认 `-webkit-app-region` 那几行）兜住。
  **「默认」不占滑杆的一格**：它是「不发思考字段、由端点自己定」，不在刻度上，摆进去会被
  当成一个真实档位（宿主仍停在默认时，轨道画成没落点的空态，要回默认去设置页）。
  压淡轨道底要用 `::before`，不能给轨道本体 `opacity`——那会把点亮段和白色滑钮一起灰掉。
- **要等宿主的开关，先给乐观值**：chip 读数取快照，一次写入要走「界面 → 宿主 → 快照 → 回推」。
  这期间不垫目标值，控件会先弹回旧值再跳到新值（2026-10-26 调档「卡顿」就是这个）。
  配套三件：读数对上就撤乐观值；超时（1.5 秒）退回宿主读数；宿主拒绝时撤值并报错。
  另外，纯界面上的状态切换（这里指拖动中的档位）**下标要同时存在 ref 里**——只放 state 的话，
  同一帧里按下再松开时处理函数读到 null，那一下会被吞掉。
  频繁调的小开关也别每次往对话里写一行 system 记录：写一次就多推一帧快照，档位在 chip 上本来就看得见
  （宿主侧 setEffort 的 quiet 实参就是给这件事的）。
- **浮层宽度按内容给，不写死**：模式菜单原来定宽 300px，四行短标签右边空出一条
  （2026-10-26 用户报的）。改成 `width: max-content` + 上下限；顶行只留一句标题，
  需要用户去别处操作的说明（「新建/编辑：设置 → 模式」）不摆在菜单里。
- **弹层里的列表要自己撑成滚动区**（2026-10-26，用户报「命令面板滚轮滑不动、翻不了页」）：
  只在列表上写 `overflow-y: auto` 不够——它是 flex 子项，`min-height: auto` 让内容把面板撑破，
  再被面板的 `overflow: hidden` 裁掉，看着像列表断了，实际滚不动。三条要一起给：
  `flex: 1 1 auto` + `min-height: 0` + `overscroll-behavior: contain`。
  滚轮也别只认「指针正落在列表上」：搜索栏、底栏、面板外的遮罩都要折算给列表（`wheelToList`），
  指针本来就在列表里时放行给浏览器原生滚动——自己再写一份速度和惯性只会跟系统打架。
  键盘一侧同样要补齐：`↑↓` 移到框外时跟着滚（`scrollIntoView({ block: 'nearest' })`），
  `PgUp / PgDn` 按可视高整页跳，`Home / End` 到头尾。只会一行一行挪的列表，用户会说「不能翻页」。
- **收起的工具卡只占一行**（2026-10-27，用户报「折叠状态占用面积太大」）：原来照 codex 在头行下摊
  3 行结果预览，一张卡从一行变四行，一轮十几张就是半屏。现在收起态只有头行，右侧留「+N 行」当读数，
  点开才看结果（`.tool-tail` 那四条样式与渲染一起删了）。**预览是锦上添花，密度才是列表的常态**。
- **浮层贴着触发点展开时，要量一次再定位**（同上）：子智能体下拉是 `left: 0` 贴着胶囊展开，
  胶囊被长标题推到窗口右边时菜单就出界（用户看到的是「被遮挡」）。打开时量一次、
  `resize` 再量一次：右边超出多少就往左挪多少（最多到左边缘留 12px），下方不够高就把
  `max-height` 收到窗口底边。CSS 的 `max-width: calc(100vw - …)` 只能防宽度，防不了位置。
- **行内按钮不要再铺一层悬停底色**（同上）：整行已经由 `.sp-row:hover` 上底，行内按钮
  （`.sp-row-open` / `.sp-row-stop`）再写一次 `--dsc-control-hover-bg` 就会叠出一小块更亮的方片，
  看着像「底色没盖满按钮」。叠加色只该用在没有底色的面上，按钮在已上底的行里时只改字色。
- **嵌套滚动交给浏览器，不自己转发**（2026-10-27 第二轮，用户：「现在还是会出现粘滞」）：
  对话页有三层能各自纵向滚的容器——工具详情（`.tool-body .args` / `.result`）、阶段组体
  （`.step-body`）、会话流（`.chat`）。里层滚到底后，手势要继续带着外层走。
  上一版在会话流上挂 `wheel` + `preventDefault`，再 `scrollTop += delta` 自己转发；实测
  （Electron 里用 `Input.dispatchMouseEvent` 发真滚轮）**原生 scroll chaining 本来就通**：
  里层盒子到底后，会话流照样跟着走 120px；再滚一次再走 120px。自己转发把逐帧、惯性、平滑滚动
  全丢了，手感是一格一格地弹——这就是「粘滞」的一半。现在 `transcript/wheel-chain.ts` 已删，
  组体保留 `overscroll-behavior-y: auto`，手势全部交给浏览器。先信浏览器，真不通再补。
- **跟随到底部：读者一动手就松手**（同上，这是「粘滞」的另一半）：会话流与阶段组体都在「内容变长
  就贴到底」。旧实现只用一条 160px 的远近判据——往上滚 100px 仍算「在底部」，下一口流式内容一到
  就被钉回底部，人感觉像被胶住。口径改照 dsh 的 `use-scroll-follow.ts` / `use-chat-reading.ts`：
  1. **往回读先松手**：往上滚的滚轮、`↑` / `PgUp` / `Home` 一到，跟随当场取消，不等越过哪条线；
     位置落定（`scrollend`，或 180ms 没有新滚动）后再按距离判定。只认「往上」——在底部
     往下滚（或点开工具卡）时松手，只会让下一口流式内容没人追。
  2. **只认自己的写**：钉底写 `scrollTop` 会引发 scroll 事件，记下写到的位置，差 1px 以内就当自己滚的
     （dsh 的 `movedByReader` 同一口径）。
  3. **贴底的门槛要近**：外层 24px（dsh 25px），组体 4px（dsh 1px）；旧壳的 160px 太宽。
  内容变长走 `ResizeObserver`：跟随开着才钉底，读者在读时一个像素都不动。
  实测（隔离 HOME 真会话）：底部上滚 100px → 「回到底部」按钮当场出现；此刻追加 400px 内容 →
  滚动位置 988 不动（floor 变 1504）；滚回底部后按钮消失，再追加 400px → 位置跟到 floor 1920。
- **放不下的标题，悬停要能滚**（2026-10-27，用户：鼠标放到会话上，标题显示不全应该有滚动效果）：
  侧栏宽度有限，长标题被截成「当前项目最近对dsh插…」；本壳**没有 tooltip 层**（`data-tip` 只是属性，
  气泡早按需求下线，见 `styles.css` 那段「交互打磨」），所以截断的标题没有任何第二条路能读全。
  做法：标题拆成两层——外层 `.title` 是 flex 那一格（`min-width: 0` + `overflow: hidden` 负责裁），
  内层 `.title-text` 才是会动的盒子。静息时内层 `max-width: 100%` + 自己的 `text-overflow: ellipsis`
  （截断照样出省略号，与改动前一致），悬停或键盘聚焦时才放开 `max-width` 并按 `--title-shift` 位移。
  **位移与时长在指针进来那一刻量**（`scrollWidth − clientWidth`）：没溢出的行不加 `data-overflow`，
  一像素都不动——不能因为加了这条就让一列标题都抖一下。`prefers-reduced-motion` 下退回省略号
  （放开 `max-width` 会变成硬切，反而读不出「还有」）。
- **旁问（右侧栏）只读**：选中正文里的一段话 → 浮出「问 AI」→ 答案落在右侧栏页签里。
  答案**流式**出（增量走 `event: ask`，不占帧 hub；最终答案再由 invoke 的返回值补齐一次），
  模型可在页签底部选（「跟随主会话」是缺省，选择存 localStorage）。入口三个：选区浮钮、
  右侧栏「开始」页的「旁问」卡（2026-10-26 从左下角页脚搬到这里：它开的就是右侧栏的页签，
  摆在自己的开始页上才是本家；左侧栏那颗导航钮会让它看起来像个整页入口）、`Ctrl+Shift+K`；
  命令面板另有两行动作。搜索（命令面板）的可见入口在顶栏右上角，压在「在资源管理器打开」
  那组左边。
  它不执行工具、不写主会话、不进会话列表（宿主 `sideAsk`，见 `core/side-ask.ts`）；答案按会话
  记在内存里，重启即清。为什么不做成主会话的一条消息：旁问是伴读，正文是主语——写进去就成了
  「一边干活一边自问自答」。快捷键 `Ctrl+Shift+K`（面板 Ctrl+K、文件 Ctrl+P 之外的第三颗）。

- **手机上的输入行只有一层**：权限 / 模式 / 模型 / 档位四颗 chip 只画「图标 + 箭头」，
  档位名在 ≤560 用 `display: none` 藏掉（DOM 留着，读屏靠 `aria-label` 读当前值）。
  两行按钮会把底栏抬到 70px，手机上一眼就散；一层是 40px。

## 6. 反馈：加载、空态、错误、确认

| 场景 | 用什么 | 注意 |
| --- | --- | --- |
| 加载中 | `Skeleton` / `SkeletonText`（2026-10-25 补回；旧的 `.dsc-loader` / `.dsc-skeleton` 早已移除） | 不要写「加载中…」这种死文字配一个转圈 |
| 列表为空 | `.dsc-state-inlist` | 行内空态，带一个图标和一句为什么空 |
| 整页为空 | `.dsc-state-empty` | 标题 + 说明，别手写第三种居中空态 |
| 报错 | `.dsc-notice[data-tone='danger']` | 说明**发生了什么 + 怎么办**，不要只贴错误码 |
| 轻提示 | `toastOk()` / `toastErr()` | 一次性、可自动消失；要用户做决定的事不要用吐司 |
| 要用户确认 | `confirmAction({...})` | 唯一的「你确定吗」通道；打开即聚焦确认键，`Enter` 确认、`Esc` 取消；**不许用 `window.confirm`** |
| 悬停解释 | `installTipLayer()` + `.dsc-tip` | 只在「悬停能学到新东西」时用，详 §7 |

**加载态（2026-10-25）**：数据没回来时画骨架，不写「正在读取…」。

- 用 `Skeleton` / `SkeletonText`（`ui-primitives/skeleton.tsx`）；外层加 `role="status"` + 一句
  `aria-label`，读屏读到的是「正在读取分区」而不是空白；
- 高度按真实内容估：比内容矮会「先缩后弹」，比内容高会「先空后收」；
- 扫光 1.4s 一轮，`prefers-reduced-motion` 时换成静态底色；
- 只给「首次取数」用。已有数据在刷新时保持旧值（别把人看得见的东西换成骨架）。

**通道断开（2026-10-25）**：断线是「正在自愈」，不是「出错了」——顶栏一条警示黄，带「立即重连」，
连上自动消失；**延迟 3 秒才出**（EventSource 自己每 3 秒重试，立刻弹会天天闪）。宿主造帧出错
另有一条红色（`.host-error`）：那条要重启宿主，这条先重连。

**错误文案（2026-10-25）**：一律过 `humanizeError()`（`ui-primitives/humanize-error.ts`）。

- 三段：`title` 发生了什么、`hint` 下一步做什么、`detail` 原文留给诊断；
- toast 用 `humanErrorLine()`（一行：标题——下一步），内联说明用 `humanErrorText()`；
- 不再写「失败：+ 宿主原文」：`ECONNREFUSED` 是给我们看的，不是给用户看的。

## 7. 提示、图标与品牌

**提示**（hermes 的 `<Tip>` 规则，dsc 一致）：

- 该提示的：没标签的顶栏/工具栏图标、快捷键、被截断的路径、归属标记。
- **不该提示的**：菜单触发器（`⋯`、齿轮——它自己的语义就是「打开菜单」，动词在菜单里）、关闭叉、
  以及可见文字已经说清楚的控件。
- 别用原生 `title=`：样式不可控、延迟约 500ms，和自绘提示打架。
- 时序：首次悬停等 `--dsc-tip-delay`(200ms)，之后 `--dsc-tip-warm`(300ms) 内秒开；出场 100ms 淡出。

**图标**：`icons.tsx` 是自维护的细线 SVG 集（`stroke-width: 1.6`、`currentColor`、默认 16px）。
一个动作对应一个图标，不引入第二套图标库、不在同一组控件里混风格。品牌方块是 `.welcome-mark`
（首屏那颗 52px 的渐变色块，`styles.css:850`）和侧栏的 `.sidebar-header .brand`，它们是 §2.6 里
允许写死颜色的地方。

**logo 两档（2026-10-25，2026-10-27 减一档）**：`--dsc-logo-sm` 20px（侧栏行内）、
`--dsc-logo-md` 22px（收起后的窄栏）。两档都是变量，别在组件里写像素。
原来还有第三档 `--dsc-logo-xl` 28px 给空会话首屏，2026-10-27 去掉——用户说首屏中间那颗图标
「有点突兀」。**正文里不再出现 logo**：空态第一眼落在标题上，品牌声部只留在侧栏与窄栏。

**并排卡片的说明文字要留满两行**（同上，2026-10-27）：四张能力卡里提示语一句还是两句，
会把卡片标题顶得高低不一（「从需求一路写到能跑」只有一行，标题就比邻卡低一行）。
给 `.welcome-card-hint` 一个 `min-height: 2lh`，文字块等高、标题落在同一条线上；
真写满三行时照样往下长，不裁字。

**彩色图标只有一套：`icons-workspace.tsx`**（2026-10-25）。它服务的是「工作区」这一个语义——顶栏
打开方式组、侧栏工作区行、打开方式菜单里的四条——**不是**通用图标集：

- 为什么另立：`IconFolder` 被侧栏、文件树、工具卡的 read、技能菜单共用，染上颜色就是几十处一起变。
- 为什么双色：单色实心块在 15px 上只是一块色斑；分开背板（暗）与前片（亮）才一眼读成文件夹。
- 尺寸必须经 `iconSizeStyle()` 写 `--dsc-icon-size`：菜单行与图标按钮的尺寸走按钮倍率，不挂这个变量
  的图标在「按钮大小」滑杆上不跟队。
- 新增彩色图标先问一句：它是不是在画**对象本身**（文件夹、应用、文件类型）？是界面动作就用线性集。

**终端配色**：`components/terminalTheme.ts` 把 `--dsc-*` 转成 xterm 的 `ITheme`。注意 xterm 只认
具体色值，而令牌大多是没求值的 `color-mix(...)` 原文，所以它和 `appearance.ts` 用的是同一套两步
取色：先借隐藏元素拿计算色，再过 1×1 画布归一成 sRGB。**加终端颜色不要另写一套取色**。

## 8. 动效与直接操作

- 过渡用 `var(--dsc-dur) var(--dsc-ease)`（100ms）或 `--dsc-dur-slow`（180ms）。**不许写 `transition: all`**，
  也不许在热交互上做布局动画。
- 动效跟着状态走，**绝不延迟状态**：选中、按下、拖拽目标当帧就位。
- `base.css` 已经处理了两件事：`prefers-reduced-motion` 时一律瞬时到位；
  `prefers-reduced-transparency` 时撤掉所有 `backdrop-filter`（模糊层每帧重采样，贵）。
- 直接操作先画界面、后落盘，失败可见地回滚（原则 7）。
- 隐藏不等于卸载：贵的界面保持挂载，用 `hidden` / `inert` 控制可见性。

## 9. 键盘、焦点与取消

- 键盘归属跟着焦点走：焦点在哪块，哪块收键；全局快捷键不许抢终端和编辑器的绑定。
- 焦环统一由 `base.css` 画（3px 强调色环），原语自己带，调用点不要另外加 `outline`。
- 选中文本用暖黄而不是品牌蓝：蓝底压白字在深色主题里会把字吃掉（`base.css:32`）。
- 一次取消只做一件事：取消当前交互，**或**关掉最上层可关的面，不许两个都做。
- `Esc` 关掉所有可关的浮层；取消在界面上是同步的，哪怕清理是异步的。
- **弹层焦点**：一律走 `useDialogFocus(active, onClose)`（`ui-primitives/dialog-focus.ts`）——打开记来源、
  焦点移进弹层、Tab 在弹层内循环、Esc 关、关闭归还焦点。嵌套弹层靠 Esc 的 `stopPropagation` 只关里层。
  别在组件里各写一份（壳里 9 个 `role="dialog"`，只有一份实现才不会有一半忘了还焦点）。
- **菜单的收起时机**：组外 `pointerdown`（捕获阶段）+ `Esc`，两路都要。别只挂一张全屏遮罩
  ——遮罩与浮层同层时压不住后挂的元素，还会把别处按钮的点击一起吞掉（顶栏「更多打开方式」
  2026-10-25 就是这个形状：点胶囊不收起，点插件钮只收菜单、页面不动）。

## 10. 外观设置与主题

「外观」四项存在 `~/.dsc/settings.json` 的 `ui` 里（`themeMode` / `fontSize` / `density` / `buttonScale`），
设置界面改完立刻生效并落盘：

1. `appearance.ts` 的 `applyAppearance()` 往 `<html>` 写 `data-theme` / `data-density` / `--dsc-font-scale` / `--dsc-btn-scale`，
   样式表据此换色、换字号、换按钮大小；
2. 同一份外观写一份 localStorage 镜像，`main.tsx` 首帧和 `App.tsx` 的 `uiPrefs` 初值都读它——
   这样宿主返回真实设置之前不会先闪一次默认深色；
3. `pushWindowChrome()` 把 `--dsc-chrome-bar` / `--dsc-chrome-symbol` 算成 `#rrggbb` 通过
   `dsc:set-window-chrome` 发给主进程，主进程调 `setTitleBarOverlay` + `setBackgroundColor` 改
   系统画的那三个窗口按钮。

细节和坑（`color(srgb …)` 序列化、只收不透明色、深浅默认值）写在
[development.md §13「主题色怎么送到原生窗口控件」](development.md)。

**加一层主题要做什么**：只换 `tokens.css` 里那三组（中性底、种子色、混比）就够，
其它文件不该认识主题；派生色一律写在末尾 `:root` 块，让它跟着重算。

## 11. hermes 的主题引擎，以及要不要搬

这一节是**参考资料**，给以后想扩主题系统的人看。dsc 现在是「一份纯 CSS 变量表 + 深/浅两套」，
hermes 是一整套运行时主题引擎（`D:\hermes\hermes-agent\apps\desktop\src\themes\`，15 个模块）。
结论先给：**dsc 不需要引入构建期主题编译器——hermes 也没有那东西**，它的主题全链路都是运行时。

### 11.1 hermes 是怎么组织的

| 层 | 位置 | 干什么 |
| --- | --- | --- |
| 数据模型 | `themes/types.ts:13-105` | `DesktopTheme` = 名字/标签 + `colors`（19 必填 + 7 可选的颜色槽）+ `darkColors` + `typography` + `terminal`（16 个 ANSI 槽）+ `customCSS` |
| 内置预设 | `themes/presets.ts:398-410` | 11 套：`nous`（默认）、`github`、`catppuccin`、`everforest`、`solarized` 从上游主题 fork；`nous-alt`、`midnight`、`ember`、`mono`、`cyberpunk`、`slate` 是第一方手写 |
| 颜色数学 | `themes/color.ts` | OKLCH 工具箱：`normalizeHex`、`mixOklab`、`oklchToHex`（出界二分降彩度保色相）、`ensureContrastOklch`（只走亮度，每步 0.02，最多 40 步）、`readableInk` |
| 重染 | `themes/retint.ts:91-198` | 从一个种子色重算整个强调色族：强调色槽继承种子色相、保留各自亮度；`primaryForeground` 用 `readableInk` 重挑；对侧栏的对比度下限 4.5:1 |
| 皮肤互换 | `themes/skin.ts:58-116` | 把 CLI/TUI 的 YAML skin 转成桌面主题，只从几个「负载最重」的键取种子，其余靠混 |
| 用户主题 | `themes/user-themes.ts` | 存 **localStorage**（不是文件），模块求值时同步读——为了 React 挂载前的首帧也能解析；逐条校验，用户主题不许遮蔽内置名 |
| VS Code 导入 | `themes/vscode.ts` | JSONC 容错 → workbench 键映射到自己的槽位（约 15 个键，强调色有 12 级回退链）→ 混出其余 |
| 落变量 | `themes/context.tsx:227-353` | 唯一写 token 的地方：往 `<html>` 的行内样式写三组变量（种子 `--theme-*`、混比 `--theme-mix-*`、应用层 `--dt-*`） |

两个值得记住的设计判断：

1. **深浅和皮肤是两个独立维度**。皮肤 = 调色板身份，模式 = `light/dark/system` 决定取哪套槽位；
   还有第三层 `renderedModeFor`（`context.tsx:191-201`）**按实际背景亮度判定真实明暗**，
   可以推翻用户选的模式——这样「声明 dark 但底色是亮的」主题不会让终端和图片反色错。
2. **sRGB 与 OKLab 分工明确**：页面/卡片/描边/文字这些层级梯度用 CSS
   `color-mix(in srgb, …)` 声明式推导（和 dsc 现在的做法一样）；只有品牌色族的派生走 OKLab，
   因为 sRGB 混白会把饱和蓝带偏约 8° 变成薰衣草色（`color.ts:253-265`）。

### 11.2 如果以后要搬，哪些能抄

| 判断 | 条目 | 代价 |
| --- | --- | --- |
| **能直接照抄** | 种子 + 声明式阶梯的分层（JS 只写种子和比例，层级交给 CSS） | 几乎为零，dsc 已经是这个结构 |
| | 强调色的最小对比度门槛（4.5:1）与「压色文字按实测择优」 | 约 30 行启动期 JS |
| | 按背景亮度判定真实明暗 | 一个 6 行的亮度函数，能防住终端/图片反色错 |
| | 「预设从上游 fork，不手改 hex」的纪律 | 零 |
| **要自己实现** | `retintTheme` + 它依赖的 OKLCH 工具箱 | 约 400～500 行纯函数。这是「把色相旋钮开放给用户」的前提，不做就只能让用户选整套预设 |
| | 首帧预涂（`index.html` 内联脚本 + 模块级首次上色） | 小。dsc 已有 localStorage 镜像这一层（§10），只差「允许用户自定义主题」时的扩展 |
| | 只给暗色盘的主题在浅色模式下的合成 | 一套额外混色规则；不做则暗色-only 主题在浅色下没有外观 |
| **建议放弃** | 11 套内置预设全搬 | 每套要维护 19 个颜色 × 深浅两套 + 一张 ANSI 表 |
| | 语义色朝强调色「弯」一点（`harmonize`） | 审美决策，会让「成功」的绿偏离用户预期 |
| | per-profile 皮肤分配、dev-only 的强调色覆盖 | dsc 单 profile 单窗口，复杂度换不来收益 |
| | VS Code 主题导入 | 纯增量功能（`themes/vscode.ts` 372 行 + JSONC 容错 + 多变体合并 + 主进程解 `.vsix`），不做不影响主题成立。终端配色 dsc 已经有了（`components/terminalTheme.ts`） |

### 11.3 结论

dsc 现在这套（`tokens.css` 一份、深色默认、浅色用 `[data-theme='light']` 覆盖、派生色写在末尾
`:root`）**不是欠账**，和 hermes 的 CSS 推导层是同一个思路。真要往「用户可调主题」走，
按这个顺序补：先按背景亮度判定真实明暗 → 再补种子与比例的可配置化 → 最后才轮到 OKLCH 重染。
前两件是小时级，第三件要认真评估（那是 `color.ts` 331 行的体量）。

## 12. 术语对照

| hermes | dsc | 说明 |
| --- | --- | --- |
| `--ui-*` / `--theme-*` | `--dsc-*` | 令牌前缀，全部集中在 `tokens.css` |
| `--theme-fill-*` / `--theme-stroke-*` 比例旋钮 | `--dsc-mix-*` / `--dsc-stroke-*` 百分比 | 同一套思路：调比例而不是调颜色 |
| `DesktopTheme.darkColors`（主题自带两套盘） | `[data-theme='light']` 覆盖块 | hermes 一个「皮肤」可带深浅两套；dsc 只有一份主题的深浅两份，不引入第三层身份 |
| `shadow-nous` + `--stroke-nous` | `--dsc-shadow-float` + `--dsc-stroke-float` | 浮层抬升组合 |
| `<Button variant size>` | `.dsc-btn[data-variant][data-size]` | 同一套变体名，dsc 多了 `chip` / `floating` / `grip` |
| `SearchField` | `.dsc-ctl` | dsc 没有独立搜索框原语 |
| `SegmentedControl` | `.dsc-segmented` | 语义一致 |
| `ListRow` | `.dsc-row` | 语义一致 |
| `ConfirmDialog` / `confirm()` | `confirmAction()` | 语义一致 |
| `Loader` / `ErrorState` / `EmptyState` | `.dsc-loader` / `.dsc-notice` / `.dsc-state-*` | 语义一致 |
| Tabler + Codicon | `icons.tsx` | dsc 自维护细线图标集 |
| `useI18n()` | 无 | **dsc 的中文文案直接写在组件里**，不做多语言 |
| nanostores | React state + IPC 快照流 | dsc 的状态来自运行时快照 |
| `--z-*` 层级阶梯 | `--dsc-z-*` | 同一套思路 |

## 13. 加一个界面之前——自查清单

- [ ] 能复用已有原语吗？不能的话，是加一档 `data-*` 还是真要新原语？
- [ ] 有没有颜色 / 圆角 / 字号 / 间距 / 层级 / 时长写成了字面量？
- [ ] 有没有在调用点覆盖原语的 padding、圆角、颜色？
- [ ] 新写的垂直节奏乘了 `--dsc-density` 吗？字号走 `--dsc-font-scale` 了吗？
- [ ] 浮层用了 `--dsc-shadow-float` + `--dsc-stroke-float`，没画粗边框？
- [ ] 列表没有平白加分隔线、没有卡片套卡片？
- [ ] 加载 / 空 / 错三种状态都有，且说清「发生了什么、怎么办」？
- [ ] 要用户确认的事情走了 `confirmAction()`，没走 `window.confirm`？
- [ ] 提示只出现在「悬停能学到新东西」的地方，没给菜单触发器和关闭叉加提示？
- [ ] 后台事件不会切页面、抢焦点、自动展开面板？
- [ ] 键盘归属正确，`Esc` 只关一层，焦环没被覆盖？
- [ ] **深色和浅色都看过**（`外观 → 主题` 切换），对比度都够？
- [ ] 改完跑了 `cd D:\dsc\desktop && pnpm run typecheck`？

## 14. 改完怎么验证

```sh
# 类型检查
cd D:\dsc\desktop && pnpm run typecheck

# 开发态起界面（改 renderer 会热更新）
cd D:\dsc\desktop && pnpm dev

# 打包版实拍（快捷键指向的就是它）
cd D:\dsc\desktop && pnpm run dist:dir     # → dist/win-unpacked/Pneuma.exe
```

实拍的环境变量钩子（`desktop/electron/main/index.ts`）见
[development.md §8](development.md)。看深浅两套时**务必两边都拍**：这轮重构里
「浅色主题下弹层还是深色」「原生控件条不跟主题」都是只在浅色下才暴露的问题。
