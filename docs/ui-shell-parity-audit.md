# 界面壳 vs 旧桌面版：逐项功能核查对照表（2026-10-12）

这份表回答一句请求：「逐项功能核查，需要完全对齐旧版」。核查方法是**逐文件对照**——
旧版真身是 `desktop/src/renderer/`（经典渲染层，仍可作为回落档运行），壳侧是
`ui-shell/src/plugins/` 里对应的内置插件。对照结果分四种：

- **已对齐**：逐项核过，行为/文案/交互与旧版一致；
- **已修**：核出不一致，当场改掉（改动分别记在 `docs/development-log.md` 第五/六批）；
- **壳补**：旧版没有、壳里多出来的东西（功能是超集，不算缺口）；
- **未搬**：旧版有、壳里还没有（写进诚实边界，不装作对齐）。

> 第八批（2026-10-13 凌晨）更新：**思考块的两条报障（抽搐 / 关不掉）修好了**——根因是
  行 key 里带了直播段每口 delta 都刷新的 `ts`（每来一个字就重挂一次，`@starting-style`
  的高度过渡反复重播），外加壳版漏了旧版的「展开区条件渲染」；**阶段组的开合被摆到明面上**
  （行尾常显箭头 + 「N 项」读数，收起时 `.step-body` 有了自己的规则、真的收起来）；
  **输入区两根旋钮补齐**（预设菜单从快照读、不再崩掉输入区；权限模式接回旧版那条可切的
  路，写口开在原生桥）；新增**状态面板**插件（胶囊 / 面板两态，进程 + 智能体总览）与
  **子智能体右侧栏页签**（点队友行不再弹模态框）。同一个自检里还撞出并修掉一个真 bug：
  会话文件里一条没有正文的消息会让整段历史重放抛异常（打开那条会话是一片空白）。
> 第七批（2026-10-12 深夜）更新：轨迹页与右缘刻度条搬进壳，「在轨迹中查看」药丸、
  顶栏「对话 / 轨迹」两张脸；设置 → 模型页从只读变可编辑（写入口走原生桥）。
> 第六批（2026-10-12 晚）更新：**旧 dock 的动态页签系统整体搬进壳**（dock-model +
  Dock 渲染：开始页 / 页签多开 / 分栏 / 全屏 / 拖拽 / 每会话布局 / 宽度拖拽），
  右侧栏结构从此与旧桌面版逐块同构；**阶段组**（14 类过程聚合）搬进消息流；
  **内嵌浏览器页签**（原生桥三件套）补齐；**审查面板回到旧版的并排右栏形态**；
  另修一个真 bug：**文件树 / git / 终端的根都按当前会话的工作区解析**（原来钉在宿主
  进程启动目录——「文件管理显示的不是对应工作区的文件」）。
> 后续批次（第九～十五批，2026-10-13）更新——**这张表停在 2026-10-12**，之后壳又动过的几处
> 按开发日志对应批次看：**状态面板**从「进程 / 智能体两节」扩成**七区**（Git / 目标 / 计划 /
> 进程 / 终端 / 工作流 / 智能体；第十/十一/十二批：Git 每 12s 本地轮询、计划目录读会话账不扫盘、
> 后台活按当前会话筛）；**Git 页签**每文件 +N/−N、点行**就地展开**该文件 diff、提交改成对话框
> （可勾未暂存，第十四批）；**工具卡文件名**分流：edit/write → 本轮改动**补丁页签**、read → 当前
> 内容（第十四批）；**终端行**可点开**只读输出页签**（1s 轮询快照 + 跟随滚动，第十四批）；轨迹页
> 与可编辑的模型配置页（第七批）。**第十五批**按用户三张截图修六处：阶段组里**组员不再被铺
> 两遍**（一条思考栏出现两次）、写前预览从居中的一行改成**左对齐卡片**、直播思考行**不再被
> 替用户展开**（定稿那一拍不再闪屏折叠）、编辑卡展开体改给**「这次改动」diff + 参数字段表**
> （不摊原始 JSON）、git 胶囊补**事件催拍**（回合收工/换工作区）、长会话分页改**按条目数**
> （≥50 且 ≥2 轮 / ≤500 封顶）并补滚动锚定；顺带修「打开长会话停在最上面」。
> 这些旧桌面版没有（属「壳补」），与本表「已对齐」不冲突。
> **第十六批（2026-10-14 凌晨）**：权限模型改口径——权限模式**四档收成三档**、新增**审阅者**正交轴
> （本人 / AI 复核）、把沙箱 + 权限模式 + 审阅者捆成**打包权限预设**；输入区那颗权限旋钮改切
> **预设四选一**（不再直接是「权限模式四项菜单」），三根旋钮可在设置 → 通用细调。桥面新增三个
> 写口（`setReviewer` / `usePermissionPreset` / `setDefaultPermissionPreset`）与一个读口
> （`listPermissionPresets`），详见「五之四」与 `docs/development-log.md` 第十六批。
> **第十七批**：状态面板锚回正文右上角（`data-thread-area`）、输入区上方那颗**分支钮**。
> **第十八批（2026-10-14）**：模型行的**输入框重叠**（`.setting-input` 的 220px 下限在 110px
> 窄格里没被收回）、**拉取清单的忙碌态按端点隔离**、**拉来的模型按能力推断**（四档来源：
> 别的端点配过的同 id > id 里写的尺寸/视觉词 > 家族表 > 缺省）、**整轮过程折叠补开合动画**
> （`grid-template-rows` 0fr↔1fr，选型记录见 `docs/ui-motion-options.md`）。
> **第十九批（2026-10-14）**：空会话态**正文列宽收缩到内容宽**（拖动条因此卡在版心、压进输入框）、
> **分支钮移出输入框外框**（原来住在 `.composer` 里面，看着就是输入框的一部分）、设置页
> **不列技能分区**（壳侧滤掉，宿主那份留给 TUI 与旧桌面版）。
> **第二十批（2026-10-14）**：顶栏**「在文件资源管理器中打开」/ 终端 / VS Code 打开的不是当前工作区**
> （按钮原来说不清开哪个目录，主进程只好用宿主进程的**启动目录**）、**悬停预览卡的收卡口径**
> （100ms → 1s，并补上卡片自己的 `mouseleave`——原来进过一次卡就永远粘住）。
> **第二十二批（2026-10-14）**：设置 → 模型里给**每个具体模型**加了**测试连接**（真发一次最小请求，
> 看现在能不能通；与「拉取清单」的分工：那个只证明地址可达，这个证明 key / 模型 / 协议 /
> 端点要的请求头这一整套），卡片那排动作钮同时**只留图标**（名字悬停才出）。
> **第二十一批是宿主侧的一刀（opencode Go 的请求头），界面无改动，故此处不列。**

## 一、侧边栏（旧 `Sidebar.tsx` ↔ `plugins/sessions`）

| 功能点 | 状态 |
| --- | --- |
| 品牌区 / 新会话 / 技能·插件一级入口 / 收起窄栏 | 已对齐 |
| 工作区分组：组行只切换自己、展开态持久化、树模式父节点默认展开、祖先折叠连带隐藏 | 已修（第五批：树默认展开口径、祖先过滤、自动展开当前工作区链并落盘） |
| 搜索 / 视图选项菜单（分组·排序·筛选三组单选） | 已对齐 |
| 每 5 条「展开剩余 N 个会话 / 收起」、收组重置进度 | 已对齐 |
| 会话行：单击打开、双击改名、行尾时间与操作钮 hover 互换 | 已修（第五批：Enter 键打开被修饰键判断挡住的 bug；「创建时间」档改显示创建时刻） |
| 归档行：点击被拦 + 一句回执、行尾「恢复」、右键菜单仍给置顶/改名/分叉/复制 ID | 已修（第五批） |
| 会话右键菜单（置顶/重命名 Ctrl+Alt+R/分叉 Ctrl+Alt+F/复制 ID/停止运行/归档 Ctrl+Shift+A） | 已对齐（+ 修了「复制 ID」抄的是完整路径而不是 uuid） |
| 分组行快捷键（Enter 开合、Ctrl+Alt+R 改显示名） | 已修（第五批） |
| 分叉位置选择器（居中浮层 + 背景遮罩 + 不足两条的报错文案） | 已修（第五批） |
| 工作区/会话拖拽排序（manual 档、置顶块约束、指示线、「放到最后」） | 已对齐（第三批实现） |
| 删除工作区（确认框去向说明） | 已对齐 |
| 会话库操作回执：`{ok:false}` 不再被当成成功 | 已修（第五批） |
| 底部：工作目录（点开换目录）/ 会话用量 / 设置 | 已修（第五批） |

## 二、消息流（旧 `ChatView.tsx` ↔ `plugins/transcript`）

| 功能点 | 状态 |
| --- | --- |
| 用户消息：气泡、贴图、hover 编辑并重发（Enter/Shift+Enter/Esc） | 已对齐 |
| 最终回答 markdown 渲染 | 已对齐 |
| 整轮过程折叠总开关「用时 X」四档能力表、跑动/插话/中断/失败强制展开 | 已修（第五批：用时口径不再被「已恢复会话」system 行拉成天文数字） |
| 轮尾一行：复制 · 分叉 · 用量 · 时刻（**赞 / 踩已按产品决定去掉**，第七批） | 已修（第五批：对齐旧版可见面与 title 口径；第七批去掉评价两颗钮——只记本机、没有上传通道） |
| 「文件已更改」聚合卡 | 已修（第五批：悬停 500ms 浮层预览、卡头点审查、行内「审查/打开」、>4 行折叠、彩色图标） |
| 工具卡：折叠行 + 参数/结果 | 已修（第五批：将做的改动、吸附快捷栏、跨重挂存档、formatDuration） |
| 工具卡行头形态 | 壳补（旧版是「工具名 + 摘要」卡行；壳保留 codex 风格的动词行） |
| 错误行 / 计划卡 / 结束标记 / 直播状态行 | 已对齐 |
| 队友卡（子智能体状态） | 壳补（旧消息流里没有对应物，`.shell-subagent` 是壳自己补的） |
| **阶段组（14 类过程聚合）**：组头 = 类别聚合 + 实时任务详情（150ms 防抖）、组体限高滚动与方向渐隐、默认收起、开合存档（`会话:step:轮:组`）、轮收尾复位、Ctrl+F 命中自动展开、键盘焦点保护 | **已搬**（第六批：`process-groups.ts` / `step-group-row.tsx` / `fold-seats.tsx` 从旧渲染层原样搬入，四档能力表的 stepGrouping / liveDetail 逐格生效；**第八批把开合摆到明面上**：行尾常显箭头 + 「N 项」读数（`StepGroup.size`）、类别图标不再与箭头互换，且 `.step-body[hidden]` 补了显式收起规则（原来只押在内核 `[hidden=until-found]` 上，实测出现过「组头像收起的、组体却摊着」） |
| **思考块**（旧 `ThinkingBlock.tsx` ↔ `ThinkRow`）：折叠态一行「星标 + 标题 + 分隔点 + 摘要」、跑动中取「最新一个写完的段落的首行」+ 右缘渐隐 + 扫光、展开区高度过渡、展开态存档、>400px 的吸附快捷栏 | **已修**（第八批：**行 key 去掉 ts**（直播段每口 delta 都刷新它，每字重挂 → 抽搐且关不掉）+ **展开区改回条件渲染**（壳版漏了 `open && …`，收起只转箭头）；摘要口径、`.think-sr` 读屏标签、`data-preview`、吸附栏一并照旧版补回） |
| 右缘刻度条（`jump-rail.tsx`，对照 dsh 的 TurnNavigator 重做） | **已搬**（第七批：20×2 刻度三态（静息 0.6 / 悬停 0.9 / 当前 1）、悬停预览卡（题面一行 + 回复三行）、轨道内滚动与两端 24px 渐隐、点「还没画出来」的早轮先放出来再滚、900px 窄容器整条收起；轨道宽 32→36px 与 `--dsc-jump-lane` 同步） |
| 轨迹页（旧 `TraceView`/`TraceTimeline`/`TraceInspector`/`trace-format` ↔ `plugins/trace`） | **已搬**（第七批：时间概览条（拖选 / 悬停提示 / 点或右键清除）、轮次记录表（折叠、压缩区段行、行内时刻·耗时·用量）、检查器（输入 / 输出 / 思考 / 子代理 / 系统 / 计划 / 计时 / 用量 + JSON 格式化 + 附件放大），尾部跟随同旧。壳增量：**搜索**（命中步骤高亮、未命中的轮收起来）、**滚轮缩放 + 右键平移**（旧版留的「这一轮不做」已补）、子代理 / 轮结束 / 长度上限 / 模型重试四类事件的行渲染（旧版这四类画成空行）） |
| 工具行「在轨迹中查看」药丸（dsh 同款） | **壳补**（第七批：hover / 键盘聚焦浮出，点一下切轨迹页并聚焦闪烁；跳转经 `thread-view` 的一次性 focus 指令） |
| 顶栏「对话 / 轨迹」页签 + 会话右键「查看轨迹」 | **壳补**（第七批：两张脸共用正文位（`SLOT.thread`），输入区与状态栏照旧；右键入口先开会话再切视图） |

## 三、右侧栏（旧 `Dock.tsx` + `dock-model.ts` + `DiffPane.tsx` ↔ `src/dock.tsx` + `dock-model.ts` + `plugins/{terminal,files,preview,browser}` + `review-pane.tsx`）

| 功能点 | 状态 |
| --- | --- |
| 布局模型：页签多开（终端不限、浏览器/文件/Git 单例、预览按路径去重每格 ≤10）、开始页（guide）门面与就地替换、分栏（≤2 格 + 宽度比）、每会话一份布局、`dsc.dock.surfaces` 持久化 | **已搬**（第六批：`dock-model.ts` 原样搬入；`dock-state.ts` 做 React 接线） |
| 页签条：chip（图标 + 标题）点击聚焦、中键关闭、右键菜单（向右分栏/收回分栏/关闭页签）、拖拽跨窗格、`+` 开开始页、条尾 chrome（全屏 / 收起） | **已搬**（第六批：`src/dock.tsx` 从旧 `Dock.tsx` 搬） |
| 开始页：罗盘 + 四张入口卡（工作区文件 / 新建终端 / 浏览器 / Git 管理）+ 快捷键角标 | **已搬**（第六批） |
| 展示：贴边（占正文轨道）与全屏（盖顶栏以下）、窄视口自动全屏、收起滑出右缘不卸载、左缘拖宽（`dsc.dockWidth`，双击复位 420） | **已搬**（第六批） |
| 快捷键 Ctrl+P / Ctrl+\` / Ctrl+T（旧版语义：开始页挂着就地替换、单例聚焦现成的、展开侧栏） | **已搬**（第六批） |
| 顶栏「工作区面板」开合钮只在收起时出现 | 已对齐（第六批按旧版条件重写） |
| 终端页签：首次可见自动起 shell、Shell 下拉（自绘）、本地提示符、`dsc.dockShell`、管道模式灰字 | 已对齐（第五批回改；第六批改挂进动态页签，keepMounted 保活） |
| 文件页签：懒加载树、每工作区根一棵树（展开集 / 各层 listing / 滚动位，重挂与切会话恢复）、根行写「工作区根目录」、刷新、彩色图标、点文件开预览页签 | **已修 + 已对齐**（第六批：树状态搬旧版 `files-tree-store` 按 cwd 分份；**根 = 当前会话的工作区**——宿主 deskop-dock 按会话解析，见下） |
| 文件预览页签：markdown/代码/csv/xlsx/pdf/图片/二进制分流、头部图标 + 相对路径、状态文案 | 已对齐（第五批 + 第六批改挂进动态页签：同文件去重、每格 ≤10） |
| 预览头部「用系统程序打开」 | 壳补（旧预览头部没有这颗钮；保留超集能力） |
| Git 页签（旧 `GitPane`）：状态三分组、暂存/取消暂存、提交（带审批）、提交历史、单文件/全量 diff | 已对齐（第五批结构照旧；第六批改挂进动态页签） |
| 浏览器页签：原生 `WebContentsView` 覆盖层、地址栏 / 后退 / 前进 / 刷新、URL 记忆 `dsc.dock.browserUrl` | **已搬**（第六批：原生桥加 `dockBrowser` / `browserNav` / `browser-state` 三件套，页面只报「显示在哪」） |
| 子智能体页签（`kind: 'subagent'`，对照 dsh 的 `sidebarRight.openResource(…, {kind:'subagentchat'})`）：一个子智能体一张，同会话文件去重 = 聚焦，页签体是只读运行记录（`peekTranscript`） | **壳补**（第八批：`dock-model.ts` 的 `openSubagent` 照 `openPreview` 的形状；`DockTab` 加 `label`——子智能体的会话文件名是 uuid，标题要用名册里的名字。队友下拉点一行也改走这里，不再弹模态框盖住正在跑的会话） |
| 审查栏（旧 `DiffPane` 并排右栏）：文件下拉、分栏/换行、彩色图标、系统打开、打开（进预览页签）、关闭、宽度拖拽 `dsc.diffPaneWidth` | **已搬回并排形态**（第六批：从「停靠区一块面板」改回正文右侧并排栏，`.thread-zone[data-review]` 同旧版；正文拖拽条在审查开着时让位） |

## 四、顶栏 / 输入区 / 状态栏 / 整页（旧 `App.tsx` / `Composer.tsx` / `StatusBar.tsx` / `SkillsView.tsx` / `PluginsView.tsx` / `SettingsModal.tsx` / `TeamPanel.tsx` ↔ app.tsx 与对应插件）

| 功能点 | 状态 |
| --- | --- |
| 顶栏：会话标题、智能体团队入口、工作区打开组、面板开合钮 | 已对齐 |
| 输入区：发送/打断、排队条、模型与思考强度、@ 文件提及、贴图、草稿按会话 | 已对齐 |
| 输入区**权限档位**（旧 `Composer.tsx:475-511` 的 `policyOpen` 菜单 ↔ 壳） | 已修（第八批接回死按钮，**第十六批改口径**：这颗旋钮现在切的是**打包权限预设四选一**——只读 / 工作区可写 / 完全访问 / AI 复核（读 `surfaces.permissionPresets`，不匹配读作「自定义」），不再是「权限模式四项菜单」；权限模式**三档**与审阅者**两档**在设置 → 通用分区各自细调。写口走原生桥 `NATIVE_OPS.usePermissionPreset` / `setPolicy` / `setReviewer`——界面通道按安全闸门理由持续排除，与 `saveProvider` 同一先例。**与参考实现的有意差异**：参考实现对「完全访问 / AI 复核」加风险确认弹窗，这里按「旧版有的照旧版」不加） |
| 输入区**模式（预设）旋钮** | 已修（第八批：原来把 `listPresets` 的回执当数组用（宿主回的是 `PresetSurface`），点一下 `presets.map` 抛异常、错误边界把整个输入区顶掉——「点预设按钮输入框没了」即此；改为从快照 `surfaces.preset` 读，菜单带「默认 / 有问题」小标） |
| **状态面板**（正文右上角浮层，对照 ZCode 的「状态」面板） | **壳补**（第八批：胶囊态报「N 个智能体在跑 / 进程 N/M」，面板态分「进程 / 智能体」两节、行是胶囊行（状态点 + 标题 + 时长 + 停止），三档展示策略（自动 / 始终展开 / 始终收起），定位靠哨兵找定位父级再 portal——不写像素。**第十七批改锚点**：认正文区那一格（`.thread-main` 上的 `data-thread-area`）而不再认 `.chat-wrap`——空会话态里后者只有内容高、还被居中边距推着走，面板会落在版心（用户报障「更改面板位置不对，应该在右上角」）） |
| 输入区**分支钮**（照片参考实现的输入框上方那一行：`⑂ main ▾`） | **壳补**（第十七批：输入框上方一行左侧一颗钮 → 菜单（搜索 / 分支清单（当前排第一、展开滚进视野）/ 新建分支…）。读数读宿主快照面 `surfaces.git`（**不是仓库整行不画**）；切与建走 `dock` 的写类 op（`git-checkout` / `git-branch-create`，**过审批**），清单走读类 op `git-branches`（直接放行）。**与参考实现的有意差异**：① 参考实现那一行左侧还有一颗工作区/目录钮，dsc 没做（换工作区 = 换会话，侧栏已有入口，不在输入框上放第二份）；② 参考实现在「改动会被覆盖」时另开「提交后再切」弹框，dsc 把 git 原文照给 + 补一句往哪儿走（提交面本来就在右侧栏「变更」页签） |
| 状态栏：轮次·步数、实时耗时、用量与上下文百分比、吞吐读数 | 已对齐 |
| 技能页 / 插件页 / 设置各分区 | 已对齐（前三/四批实现） |
| **设置 → 模型：可编辑形态**（旧 `SettingsModal` 的 `ModelsPanel`/`ProviderForm`/`ModelRow` ↔ `plugins/settings/models.tsx`） | **已搬**（第七批：端点卡片（密钥快捷行 / 拉取清单 / 编辑 / 删除）、**端点表单**（名字 / 显示名 / Base URL / **API key** 一次改完 + **批量文本**模式）、**模型行**（id / 显示名 / 上下文 / 最大输出 + **思考档位四档 chip + 思考参数下拉 + reasoning_effort 逐档线上值 + 输入模态三档**——与宿主 `core/model-caps.ts` 同一份枚举）、默认模型两个自绘下拉。dsh 式增量：列表尾「＋添加端点」虚线卡、**拉取清单弹窗**（搜索 + 全选 + 复选 + 一次采用）。**写入口走原生桥**（`saveProvider`/`removeProvider`/`setProviderKey` 被界面通道有意排除，见第五节）；浏览器无桥时整页降级只读并说明 |
| 审批卡 / 计划卡 / 提问卡 / 目标条 / 任务条 / 队友面板 | 已对齐 |
| **拉取清单：忙碌态按端点 + 拉来的模型按能力推断**（第十八批） | 忙碌态从「一个全局布尔」改成按端点记的集合 —— 原来点一张卡四张一起写「拉取中…」。能力也不再一律按缺省装：新模块 `plugins/settings/model-infer.ts` **四档来源**从强到弱推断（`known` 别的端点配过的同 id 照抄 / `marker` id 里写着 `-1m`、`-vl` / `family` 家族白名单表（明说「猜的」）/ `default` 与宿主缺省一致并明说「没查到」），每行右边画推断结果、提示里给依据（`data-discover-source`）。**只推断填错也不致命的字段**：`thinkingParam` 填错会在非缺省档位发一个端点不认的字段，所以家族表里只在有公开惯例时才给 |
| **模型行输入框重叠**（第十八批） | `.setting-input` 的共用下限 `min-width: 220px` 只在设置页「一行一个输入框」的场景正确；模型行的「上下文 / 最大输出」两列只有 110px，实机在 1280px 宽下两个框**互相压住 102px**、右格还探出整行。修法只在这几处窄格收回下限（`.model-row-field .setting-input`、同样 84px 的 `.cap-wire-input`），别处照旧 |
| **整轮过程折叠的开合动画**（第十八批） | 之前点「用时 X」是硬切。过程区包一层（`.turn-process` > `.turn-process-body`）后走 `grid-template-rows` 0fr↔1fr + 内容淡入淡出（180ms，令牌 `--dsc-dur-slow` / `--dsc-ease`）；阶段组那一级补 `max-height` 过渡。收起方向必须**延迟挂 `hidden`**（高度按内容算，挂早了动画归零），收起态留 0 高盒子并以负 `margin-top` 抵掉多算的座位 gap。**三个参考实现的做法与另外四种选型记录在 `docs/ui-motion-options.md`**（dsh 不做高度动画、codex 是 TUI 无补间、zcode 是 300ms 关键帧 + 延迟 300ms 卸载） |
| **空会话态正文列宽**（第十九批） | 空态给 `.chat` / `.chat-inner` 换成 flex 列后，legacy 的 `margin: 0 auto` 在交叉轴上压过 `align-items: stretch`——欢迎语比 76ch 窄时这一格收缩到内容宽（实机 370px）。两个后果：拖动改的 `--dsc-thread-max` 不再决定宽度（**把手卡住不动**），`ThreadResizer.measure()` 量到的是内容边而不是列缘（**把手落在版心、高亮条压进输入框**）。补 `.thread-main-empty .chat-inner { width: 100% }`：宽度交还 max-width，余量仍由 auto 外边距居中，观感不变 |
| **分支钮移出输入框**（第十九批） | `.composer-git` 原来是 `.composer`（带描边与圆角的输入框本体）的子节点，被同一个外框圈住 → 看着就是输入框的一部分。改成框外一列两行（`.composer-stack` > `.composer-git` + `.composer`），贴图 / 拖文件三个事件与故障便条留在/挪到框外那层；`.git-btn` 自己加一圈 `--dsc-stroke-3` 描边（hover / 展开换 `--dsc-stroke-2`） |
| **设置页不列技能分区**（第十九批） | 技能中心已是侧栏的独立整页（`plugins/skills`），设置里那份开关是第二个入口。壳侧 `HIDDEN_SECTIONS = new Set(['skills'])`，**导航列表 / 选中分区查找 / 侧栏跳转 target 三处都过它**（漏一处就是「未知分区」）；壳里那份实现（`SkillsGroup` / `listSkills` / `setSkillEnabled`）整块撤掉。**宿主那份故意留着**——TUI 的设置浮层与冻结的旧桌面版消费同一张分区表 |
| **顶栏「在资源管理器 / 终端 / VS Code 中打开」**（第二十批） | 壳按**当前会话的 cwd** 显示「当前工作区」（`status.cwd`，侧栏底部那一行的读数），但按钮原先只报一个 kind 不说开哪个目录 → 主进程只好用 `hostCwd`（**宿主进程的启动目录**，`startHost(cwd)` 时定的）。常驻多会话模型下两者经常不是同一个目录（用户机器：宿主起在 `C:\Users\waq`，看的会话在 `D:\dsc`）。修法：壳把**自己显示的那个值**当第二个实参传下去（`invoke('openWorkspace', [kind, cwd])`），原生桥规格里那条路径实参**可选**（省略 = 旧行为，旧桌面版照旧），主进程 `openWorkspace(kind, requested?)` 给了就用、没有才回落 `hostCwd` |
| **悬停预览卡的收卡口径**（第二十批） | 两处毛病：收卡延迟照参考实现是 **100ms**（能读的 diff 卡，手从行上往卡里挪都来不及）；卡片只挂 `onMouseEnter`（keep）**没挂 `onMouseLeave`**，而行上的 `mouseleave` 早在指针进卡那一刻就烧掉了 → **进过一次卡就再也不会自己收**（只能 Esc）。修法：壳侧 `HOVER_CLOSE_MS` 100 → **1000**（有意与参考实现分道，旧渲染层那份不动），`DiffHoverCard` 补 `onMouseLeave` 接同一条倒计时。实机量到离卡 **1007ms** 收、行上移开 **1015ms** 收 |
| **每个模型后面的「测试连接」**（第二十二批） | 新增一条界面可见动作 + 一条宿主方法（`testConnection(provider, model?)`）。形状照同类客户端的连接测试契约：**固定两条探针消息**（system + user `hi`）、无历史无工具、输出预算压到 16、**走与正常对话同一条链路**（同协议适配器、同一份端点要的请求头——上一批那个 opencode Go 的会话头也在内），流正常收尾即算通。实参只收**端点名 + 模型名**（地址与 key 都由宿主那份配置出，页面指不了别处），与 `discoverModels` 同一把尺；端点不存在 / 没配 key / 没模型都当场说清。按钮挂在**具体模型后面**（用户要知道的是「这一条路能不能通」），结论就地做一个点（`✓`/`✗`，读数在悬浮说明里）。**卡片那排动作钮同时改成只留图标**（名字进 `data-tip`，悬停才出）——五颗带字的钮会把端点地址压成一截省略号；图标钮给足 24px 见方，命中区不跟着字一起变小 |

## 五、宿主侧配套修复（第六批，`src/plugins/desktop-dock.ts`）

| 项 | 说明 |
| --- | --- |
| dock 读写的基准目录 = **当前会话的 cwd**（原来钉在 `process.cwd()` 挂载时的值） | fs-list / fs-read / git-* / term-spawn 全部改按会话解析；安全边界（`inside` 越界检查）仍在，只是基准从「进程启动目录」换成「会话工作目录」——与沙箱 `canWrite(path, cwd)` 的既有口径对齐。用户报障「文件管理显示的不是对应工作区的文件」即此 |

## 五之二、宿主侧配套（第七批）

| 项 | 说明 |
| --- | --- |
| 原生桥新增模型端点三件套 `saveProvider` / `removeProvider` / `setProviderKey`（`src/core/native-bridge.ts` + 主进程 `NATIVE_HANDLERS` 转发 `protocol.invoke`） | 三个方法都写 `config.yaml` 或凭据库，界面通道（浏览器与远程页够得着的那条面）持续排除——写口只开在桌面窗口那份文档上，与 `installMarketSkill` / `setUiTrust` 同一先例。规格里新加 `stringOrNull` 形状：`setProviderKey` 的 null 是**清除**而不是省略 |
| `core/model-caps.ts` 进共享面（`src/ui/index.ts` 的 `export * from`） | 思考档位 / 档位字段 / 输入模态三组枚举与中文标签**只有一份**：界面勾的四档与宿主发请求时算的字段不会各说各话；`ProviderDraft` / `ThinkingParam` / `EffortMap` 三个类型也补进 `@dsc/ui-core` 的类型转出面 |
| 轨迹页的口径件也归了平台层 | `platform/time.ts`（`entryTs`/`formatClock`/`formatDuration`/`formatTraceDuration`，消息流与轨迹页共用）、`platform/tokens.ts`（`formatTokens`）、`platform/tool-summary.ts`（工具摘要 / 状态词 / 图标动词，对话页与轨迹页共用） |

## 五之三、宿主侧配套（第八批）

| 项 | 说明 |
| --- | --- |
| 原生桥新增 `setPolicy`（`src/core/native-bridge.ts` + 主进程转发） | 四档枚举校验（`readonly` / `auto-edit` / `full-access` / `ai-review`，`satisfies readonly ApprovalPolicy[]` 保证漏一档编不过）。界面通道的 `UI_EXCLUDED` 条目一并写明「写口去哪了、为什么」——审批策略是安全闸门本身，能改它的仍只有桌面窗口那份文档 |
| `contentText` / `contentImages` 兜住 `undefined` 与认不出的形状（`src/core/llm.ts:89`） | **自检里撞出的真 bug**：会话文件里一条没有 `content` 的消息（类型上写着非可缺，盘上的老日志却可能没有）会让 `replayHistory` 当场抛异常——用户打开那条会话看到的是一片空白，历史像丢了。这一层的职责是「取文本」，取不到交白卷即可 |

## 五之四、宿主侧配套（第十六批：权限收敛 + 打包权限预设）

| 项 | 说明 |
| --- | --- |
| 原生桥 `setPolicy` 的枚举收敛为**三档**（`readonly` / `auto-edit` / `full-access`） | `ApprovalPolicy` 去掉 `ai-review`（`src/contract.ts`）；`satisfies readonly ApprovalPolicy[]` 仍在，漏一档编不过 |
| 原生桥新增 `setReviewer`（`user` / `auto-review`） | 审阅者是**与权限模式正交**的一根新轴（谁来裁要问的事）；写口与 `setPolicy` 同一条理由住在桥上（安全闸门本身），宿主那侧走 `approval.setReviewer` |
| 原生桥新增 `usePermissionPreset` / `setDefaultPermissionPreset` | 打包权限预设（沙箱 + 权限模式 + 审阅者三合一）的**选择**与**默认档**；`use('custom')` 被拒——`custom` 是推导状态、不是可选项 |
| 界面通道新增**读口** `listPermissionPresets`（三个写口继续排除） | 壳画输入区那颗权限旋钮与设置 → 通用那个 select 读它；`UI_EXCLUDED` 里三条写口逐条写明「写口去哪了、为什么」。与 `saveProvider` / `setProviderKey` 同一先例：写口只开在桌面窗口那份文档上 |

## 五之五、宿主侧配套（第十七批：git 快照面 + 三个 dock op）

| 项 | 说明 |
| --- | --- |
| 新插件 `src/plugins/git.ts` → 快照面 `surfaces.git`（`repo` / `branch` / `detached` / `dirtyFileCount`） | 输入框上那颗分支钮与状态面板的分支行读同一份。为什么住宿主：这颗钮要**一直**显示分支，界面自己拉 `dock git-status` 会跟状态面板各拍一次（大仓里是拿 CPU 换同一行字），两处还会短暂不一致 |
| 节奏：三档（12s / 30s / 60s）＋ 事件催拍（`dsc/turn-end` / `dsc/session-open` / 写类 op 落盘后 `ctx.get('git')?.refresh()`）；**没人看就不拍** | 快照的 `read()` 只在有人连着界面时发生（`core/ui-events.ts`：没有连接就不造帧），所以「这片最近被读过」＝「界面活着」；CLI / TUI 会话里一次 git 都不跑 |
| `dock` 新增 `git-branches`（**读类**，界面 HTTP 通道直接放行） | 本地分支清单，排序照参考实现：当前分支第一、其余按最后一次提交时间从新到旧；空仓库（HEAD 未出生）时把 `rev-parse --abbrev-ref HEAD` 那个还没进 refs 的分支名补进清单 |
| `dock` 新增 `git-checkout` / `git-branch-create`（**写类**，与暂存/提交同一档：过审批） | 卡片文案进 `DOCK_WRITE_LABEL`（「git: 切换分支 → 切到 X」）。执行用 `git switch --no-guess`（避开 `checkout <名字>` 的分支/路径歧义，也不顺手从远端建分支）；工作树有会被覆盖的改动时 git 自己拒，stderr 原样回给界面 |
| git 执行与 porcelain 解析抽到 `src/core/git-exec.ts`（`git` / `parsePorcelainZ` / `repoPrefix` / `toWorkspacePath`） | desktop-dock 与 git 插件**共用一份**：`-z` 的 rename 双记录这种细节抄一遍就等着某处先漂；改动计数因此与「变更」页签、状态面板同口径（含未跟踪、只看 cwd 之内） |
| 界面通道的 `invoke` 支持按调用给超时（`InvokeOptions.timeoutMs`）+ `HUMAN_WAIT_TIMEOUT_MS = 330_000` | 写类 dock op 在宿主侧**挂着审批卡**执行（卡能等 5 分钟），默认那 30 秒会把「等你点卡」报成「调用宿主方法超时（30000 毫秒）」，而且点完卡那次调用已被页面放弃。四个过审批的 git 写口（暂存 / 提交 / 切 / 建）都带上长窗口。**实机走查抓到的** |

## 六、验证落点（第六批）

- `desktop/shots/ui-batch6-check.ps1`：**37/37 通过**。种子 = 宿主启动目录 ≠ 会话工作区 +
  一轮两个阶段组的定稿会话。覆盖阶段组（组头 counts/聚合文案/默认收起/开合双态）、
  文件树根、开始页四卡、终端（开始页入口）、分栏 / 全屏 / 收起展开、浏览器页签（单例）、
  并排审查、预览页签、`~/.dsc` 零污染。
- 回归：`ui-batch5-check.ps1` 27/27（三处断言按新行为跟改：并排审查 / 预览页签 /
  开始页开终端）；`ui-batch4-check.ps1` 29/29（dock 打开路径改 Ctrl+P）。
- 探针：`ui-native-bridge-test` 79/79（跟改：形状表加 bool/rect、浏览器三件套正向断言、
  动词表加 dock/browser）；`ui-parity-check` / `ui-statusbar-check` / `ui-switch-cwd-check`
  三组界面探针全绿；`remote-e2e` 83/85（2 条与基线一致的预存在失败）。
- 三侧 TypeScript 全绿；`desktop/dist/win-unpacked` 重打 + asar 内容核对（browser 插件、
  新 dock/阶段组代码都在包里）+ `pkg-smoke` `rendered:true`。
- 自检知识：浏览器页签（原生 WebContentsView）挂着时 `capturePage` 会失败
  （UnknownVizError）——截图前先关掉浏览器页签。

## 六之二、验证落点（第七批）

- `desktop/shots/ui-batch7-check.ps1`：**41/41 通过**。种子 = 三轮会话（3 工具 + 2 思考）+
  本机假端点（`_batch7-fake-llm.mjs`，含 `GET /v1/models`）。覆盖：顶栏页签与
  `.trace-page` 切换（`.chat-wrap` 收走、输入区仍在）、时间条（6 个标记 = 3 工具条
  （宿主重放路径用 jsonl 的 ts 差算出 200/400/1000ms）+ 3 个起点刻度 + 3 条轮次分隔）、
  轮次表（默认只展开最新一轮、轮头统计、开合双态、压缩区段）、检查器（kind/分区/Esc）、
  搜索（命中计数 / `is-search-hit` / 未命中轮收起 / 清除复原）、拖选（选区 chip /
  `is-hit` / 点一下清除）、滚轮缩放（`data-zoomed` / 全览复位）、会话右键「查看轨迹」、
  刻度条（3 刻度、非隐藏）、药丸（卡数与药丸数一致 + 点击切页并闪烁）、**实跑一轮**
  （假端点真跑一次 read：新工具卡 + 新轮 + 轨迹条数增加 + 行内「用时」读数）。
- `desktop/shots/ui-batch7b-models-check.ps1`：模型页专项（形态 / 编辑表单能力项 /
  改能力保存 / 新增端点 / 拉取清单弹窗 / 删除确认），断言分两层：eval 读 DOM +
  **PowerShell 直接读隔离 HOME 的 `config.yaml`**（落盘证据）。
- 探针：`ui-native-bridge-test` **96/96**（跟改：形状表加 `stringOrNull`、动词表加
  `save`、新增模型三件套一节 15 条）；`ui-api-gate-test` / `ui-plugin-test` /
  `ui-third-party-test` / `ui-serve-test` / `ui-tui-plugin-test` 全绿。
- 三侧 TypeScript 全绿；宿主 `lib/`、壳 `lib/ui/`（含 trace 插件）、desktop `out/` 重建。

## 六之三、验证落点（第八批）

- `desktop/shots/ui-batch8-check.ps1`：**37/37 通过**（新增）。种子 = 两轮定稿会话
  （思考 + 工具）+ 一条「已收工」队友名册（`~/.dsc/team/roster.json` + `sessions/.teammates`
  下的运行记录）+ 本机假端点 `_batch8-fake-llm.mjs`（四拍：慢速长思考 → `todo_write` →
  `read` → 收尾）。覆盖：思考块的收放（定稿块收起时正文不在 DOM 里、点开有内容、再点消失）、
  **直播块点收起后连推三拍仍是同一个 DOM 节点且仍收起**（抽搐 / 关不掉的回归判据）、
  阶段组（「N 项」读数 + 常显箭头 + 收起时高度真为 0 + 开合双态）、两根旋钮（权限菜单四项
  且菜单开着时输入框还在、点非当前档文案跟手、预设菜单可开且当前档不可点）、
  状态面板（`1/3` 进度 + 三行任务 + 一行队友）、**点队友行在右侧栏开出 `reader-1` 页签
  并读出只读运行记录**、`~/.dsc` 零污染。
- 回归：`ui-batch6-check.ps1` **38/38**、`ui-batch7-check.ps1` **41/41**（都没跟改——
  组头 DOM 与 CSS 的改动对旧断言透明）。
- 探针：`ui-api-gate-test` / `ui-plugin-test` / `ui-third-party-test` / `ui-serve-test` /
  `ui-tui-plugin-test` / `ui-native-bridge-test` / `legacy-frozen-check`。
- 三侧 TypeScript 全绿；宿主 `lib/`、壳 `lib/ui/`（16 个插件，新增 `status`）、
  desktop `out/` 重建。

## 六之四、验证落点（第十七批：面板锚点 + 分支钮）

- 新探针 `scripts/ui-git-branch-test.mjs` **41 条**：纯逻辑（`plugins/composer/git-branch.ts`
  的 `filteredBranches` / `wouldOverwrite`）、壳侧接线（读数取 `surfaces.git`、不是仓库整行
  不画、两个写口走 `dock` 写类 op、四颗旋钮浮层互斥、等人的调用带长超时）、`desktop-dock`
  三个 op 的实现与催拍、**CSS 幽灵令牌差集扫描**。
- `scripts/ui-status-data-test.mjs` 增 **[8] 21 条**（真内核 + 真 git 仓库）：快照面首读催拍、
  分支名与改动计数同口径、清单当前分支第一、**只读档下切分支被拒**、完全访问下真切 + 快照面
  跟上、建分支、非仓库 `repo: false`。
- `scripts/ui-status-panel-test.mjs` 增 **[9] 5 条**：面板定位锚（认 `data-thread-area`、
  不再认 `.chat-wrap`、锚点自带 `position: relative`）；其中三条读 `desktop-dock.ts` 原文的
  断言随 git 助手抽取改指 `core/git-exec.ts`。
- 全量电池复跑绿（`ui-plugin-test` / `ui-sdk-types-test` / `ui-api-gate-test` / `ui-batches-test`
  / `ui-hmr-test` / `ui-third-party-test` / `ui-serve-test` / `remote-host-test` 140/140 /
  `legacy-frozen-check` / `commands-battery` / `ui-native-bridge-test` 96 条 / 内核那几条）。
- 三侧 TypeScript 全绿；宿主 `lib/`、壳 `lib/ui/`（composer bundle 含 `composer-git`、
  `assets/*.css` 含 `.composer-git`）重建。

## 六之五、验证落点（第十八批：模型行 / 拉取清单 / 折叠动画）

- 新探针 `scripts/ui-model-caps-test.mjs` **48 条**：`model-infer.ts` 的纯逻辑（归一化 / 尺寸
  标记 / 视觉词 / 四档来源的优先级 / 家族表顺序 / 已知索引的两条边界）、**缺省值与宿主同源**
  （对着 `lib/core/model-caps.js` 与 `src/core/config.ts` 的原文断言）、`models.tsx` 的接线
  （忙碌态是集合、每卡只认自己那位、采用时按推断填、弹窗每行给来源）、**窄格 CSS**
  （220px 下限在模型行里被收回、`.cap-wire-input` 同样收回）。
- `scripts/ui-transcript-render-test.mjs` 增 **[5] 17 条**：过程区包两层、`grid-template-rows`
  两头、内层 `min-height: 0` + `overflow: hidden`、收起态是 0 高盒子（不是 `display: none`）
  与负 `margin-top`、内容淡入淡出、时长走令牌、**收起延迟挂 `hidden` 且只给两层 `display:none`**、
  组体那级走 `max-height` 过渡、`base.css` 的全局 reduced-motion 兜底。
- 实机（隔离 HOME + 假端点 + 浏览器）：重叠 102px → 0px（1280px 与 900px 两档都量）；
  「拉取中…」只出现在被点的那张卡；拉取弹窗 7 行四档来源齐全，采用后写进 `saveProvider`
  的能力逐条核对；**展开方向逐帧采样到 0 → 24px / 180ms 的平滑曲线**。
- 全量无头电池 **39 个探针全绿**；三侧 TypeScript 全绿；`lib/ui/plugins/settings/client.js`
  含 `data-discover-source`，`lib/ui/assets/*.css` 含 `.turn-process` 与两条窄格规则。

## 六之六、验证落点（第十九批：空态列宽 / 分支钮出框 / 设置不列技能）

- 新探针 `scripts/ui-thread-resizer-test.mjs` **49 条**：`panels.ts` 的纯逻辑（夹取区间、右缘轨道宽
  从样式表现读 + 缺省回退、存档读写与「传 null = 复位」、开关、根变量；三个 DOM 面用桩顶上）、
  **空态列宽这条 CSS 契约**（`.thread-main-empty .chat-inner` 的 `width: 100%`、与它配对的 legacy
  `margin: 0 auto` + `max-width`、触发条件仍在、幽灵令牌差集）、**把手几何**（24px 让位、12px 热区、
  `min()` 兜底、2px 高亮条只在 hover / 拖动亮）、**量算契约**（量 `.chat-inner` 的矩形、三路重量、
  左右 sign −2 / +2、松手才落盘、启动铺存档）。
- 新探针 `scripts/ui-settings-nav-test.mjs` **28 条**：三处都过 `HIDDEN_SECTIONS`（含出现次数 = 3）、
  技能那份实现整块撤掉（`SkillsGroup` / `SkillRow` / `listSkills` / `setSkillEnabled` / `IconBolt`）、
  其余四个手画分区照旧在链上、边界（宿主仍发技能分区且 order 还是 20、侧栏技能整页入口与它的写口照旧）。
- `scripts/ui-git-branch-test.mjs` 扩到 **46 条**：新增「分支行与输入框是兄弟（列 → 分支行 → 输入框
  的顺序）」「三个贴图事件仍挂在输入框本体上」「故障便条在框外」，以及 `.composer-stack` 列布局、
  `.composer-git` 的间距从框内上内距改成与下方框的间隔、`.git-btn` 的描边与 hover 档。
- 实机（`_ui-shell-serve.mjs`，浏览器 1440×900）：列宽 533px = 76ch、`colStart` 315、左把手 x 516
  （离输入框左缘 44px）；真实指针拖左把手 90px → 列宽 713 且落盘 `dsc.threadWidth = 713`；
  **复现对照**：把开场便条改短成用户那样后，修前列宽 370 / colStart 396 / 把手 x 597（**落在输入框
  x 572..1105 里**），修后 533 / 315 / 516。设置导航 8 项无技能，模型 / 模式 / 归档 / 用量四个面板
  逐个点开照常渲染。
- 全量无头电池 **42 个探针全绿**（含 `legacy-frozen-check`）；三侧 TypeScript 全绿；
  `lib/ui/assets/*.css` 含 `.composer-stack` 与空态那条 `width: 100%`。

## 六之七、验证落点（第二十批：打开按钮认当前工作区 / 悬停预览收卡 1s）

- `scripts/ui-native-bridge-test.mjs` 扩到 **106 条**：新增「`openWorkspace` 的第二个实参是可选路径」
  与四条实参校验（三个档 + 目录能过、只传 kind 照旧能过、未知档 / 类型不对 / 超长 / 多传第三个都被拒），
  以及**两侧接线**（壳的调用点带 `cwd`、主进程按实参取目录且缺省回落 `hostCwd`、分派把第二个实参透传）。
- `scripts/ui-transcript-render-test.mjs` 扩到 **61 条**：新增 [6] 组钉收卡口径——出卡仍是 500ms、
  收卡是 **1000**、**旧渲染层那份仍 100ms**（改的只在壳侧）、为什么分道写在注释里、预览卡
  `onMouseEnter`（keep）+ `onMouseLeave`（disarm）成对、`onLeave` 这个 prop 与调用点、`disarm`
  就是那条倒计时、「卡会粘住」在注释里留了档。
- 实机（`_ui-shell-serve.mjs`，宿主进程 cwd 故意设成 `C:\Windows\System32`、种子会话 cwd 是
  `D:\dsc`）：页面里装假原生桥后点壳里那颗钮，三个档的实参都是 `['explorer'/'terminal'/'vscode', 'D:\dsc']`
  （与侧栏底部读数同源，**不是** System32）。
- 实机（真 Electron，隔离 home + `DSC_DESKTOP_SHOT_EVAL`）：种子会话的 cwd 指向不存在的
  `D:\zz-not-here-92`（宿主启动目录是 `C:\Users\waq`）→ 点壳里那颗钮 → 便条
  `打开失败：工作目录不存在：D:\zz-not-here-92`；再直连桥换一个目录 → `{ok:false,error:'工作目录不存在：D:\zz-not-here-93'}`。
  用不存在的目录当靶子：既证明实参被认，又不真弹资源管理器窗口。
- 悬停预览（同一份壳，页面内时戳）：行上停 500ms 出卡 → 指针进卡（keep 取消倒计时）→ 出卡
  **1007ms** 后收；另一路从行上直接移开 **1015ms** 后收（MutationObserver 全程只有一次 ADD / 一次 REMOVE，
  修前这两条都会在 100ms 收，且「进过卡」那条根本不收）。
- 三侧 TypeScript 全绿；全量无头电池（`scripts/*-test.mjs` 39 个 + `commands-battery` +
  `legacy-frozen-check` + `settings-sections-check`，排除 `ui-hmr-machine`）**42 个全绿**；
  `docs/development-log.md` 第二十批记了同一批读数与诚实边界。

## 六之八、验证落点（第二十二批：每个模型后面的「测试连接」）

- 新探针 `scripts/connection-test-test.mjs`（**81 条**，六层）：
  ①探针请求形状（两条消息 / system 在最前 / user 只有 `hi` / 不带工具 / 不带 signal / 预算 16 /
  路由声明的思考字段原样带 / messages 是副本不污染常量）+ 回话摘要口径；
  ②成功路径（假 stream：流收尾即 ok、正文为空也算通、信号挂上了且此刻未中止、按路由声明的协议派发）；
  ③失败路径（端点报错折成 `ok:false` + 「连接失败：」+ 端点原文；挂住的端点在 300ms 后按
  「超时」收，且**说得清不是端点拒的**）；
  ④挑模型口径（显式 > 默认端点那份默认模型 > 清单第一个 > 空串）；
  ⑤接线钉（源码）：界面白名单 + 实参规格（端点名 + 可选模型名）、宿主清单、契约、宿主实现四条
  （端点不存在抛错 / 没 key 先说清 / 没模型先说清 / 档位取默认）、运行时透传、旧桥 RuntimeProxy；
  **界面形态**：测试钮挂在模型芯片后面（`data-probe-model` / `onProbe(model.id)`）、模型那一格
  把芯片+钮+结论点收进 `.model-slot`、忙碌态按「端点/模型」记、结论点 `probe-badge` 带 ok/bad、
  **动作排四颗钮都只画图标且名字都在 `data-tip` 里**（并反证旧的带字形态已不画）、卡片级那条
  结论行已撤（`provider-probe` 全库无残留）；
  **样式**：`.icon-btn` 24px 见方 + 悬停换底色用令牌、`.model-probe` 20px 且平时淡、`.probe-badge`
  成功绿失败红都用令牌（并查无硬编码色值）；
  ⑥**真端到端**：真 `createKernel` + 本地假端点（`127.0.0.1`）——从设置服务一路走到线上请求，
  断言请求打到 `/chat/completions`、头上是宿主那份 key、线上就两条消息、不带工具、
  `max_tokens === 16`、默认端点点名不带模型时挑的是它配的默认模型、401 折成 `ok:false`、
  不存在的端点与没有模型的端点各自抛错。
- 三侧 TypeScript 全绿（根 + `ui-shell` + `desktop`，后者是为了 `RuntimeProxy` 那一站）；
  全量无头电池 **44 个全绿**。
- **真机自检**（真 Electron + 隔离 HOME + 本地假端点，读数是页面里 `executeJavaScript` 的返回值）：
  动作排 `textContent` 为空、四颗钮各自文字都是空串、四句悬浮说明齐（`密钥已配置 · …` /
  `拉取清单 · …` / `编辑这个端点` / `删除这个端点`）；`m-1` 芯片后面那颗钮的说明是
  「测试连接 · 拿 m-1 真发一次最小请求（与正常对话同一条链路）」，DOM 顺序确认钮在芯片之后；
  点它 → 结论点 `✓`（class `probe-badge ok`，tip `通了 · m-1 · 17 ms · 回了「ok」`），
  假端点的 wire.log 同步记下这次请求（`Authorization: Bearer local-ui-key`、两条消息、`max_tokens: 16`）。
- **边界**：按钮测的是**已保存**的端点（表单里的改动要先保存——按钮的提示里写着）。想让
  「改一笔先测一笔」也行，那得把测试挪到**原生桥**上（与 `saveProvider` 同一先例），本批没做。
