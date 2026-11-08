<p align="center">
  <img src="docs/assets/readme/banner.png" width="560" alt="Pneuma — 独立终端 AI harness">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waq666/pneuma"><img src="https://img.shields.io/npm/v/@waq666/pneuma?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/waq05/pneuma/actions/workflows/release.yml"><img src="https://github.com/waq05/pneuma/actions/workflows/release.yml/badge.svg?branch=main" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >= 22.19"></a>
</p>

# Pneuma

> **全自研**的终端 AI 编程助手：自写 ReAct loop + 会话落盘 + 工具栈 + 审批，UI 用 ink（React for CLI），另有 Electron 桌面端；插件装配基于开源 cordis 上下文内核。

各版本的用户可见变化见 [CHANGELOG.md](CHANGELOG.md)。

## 有什么

- **一颗内核，三种前端** — 终端 TUI、Electron 桌面端（默认已是插件化界面壳）、**手机浏览器遥控页**；局域网扫码配对，人在外面也能批卡、看进度、发消息（PWA + Web Push + Webhook）。
- **模型自由** — 多端点 / 多模型随意切；上下文窗口、思考档位、图片 / 视频模态逐模型配置并可就地实测。输入框底栏两颗 chip 直接换模型与思考强度：模型是两级菜单，思考强度是一条四档滑杆（关 / 低 / 高 / 最大，每档一套动效）。模型、档位与协作模式都**按会话记**：在 A 会话换模型，B 会话和后台子代理仍用自己的那一条。
- **智能体协作** — 子智能体、智能体团队（并行队友 + 收件箱 + 汇报）、任务清单、计划交付、跨轮目标续跑。叫停队友只是停当前那一轮：它在名册里留着，传话就能接着干，干完的汇报照旧回到主会话（要彻底清掉用「移除」）。状态面板里分成两区：**子智能体**（谁在跑）与**共享任务**（任务板上有哪些事、谁负责，只读）；没派队友、没建任务时两区都不出现，队友也只能看见自己那条会话里的人和任务。
- **长期记忆** — 跨会话事实分「全局 / 用户偏好 / 工作区」三格，当轮生效，可评估、可整理。
- **插件化** — 每个功能都是一个可装可停的包（见 [§插件](#插件)）：核心服务与 16 个功能档没有区别，都是磁盘上的包 + 一行清单；第三方可以是包，也可以是单文件 ESM；桌面界面壳本身也是插件架构（带 SDK）。
- **四档主题** — Claude（暖米白，取 Anthropic 官方色板，**出厂默认**）/ 深色 / 浅色 / 跟随系统；整屏颜色只由两个种子（墨色、强调色）与一组百分比旋钮派生，换皮肤不用改组件。
- **默认终端可选** — 设置 → 终端环境会真去探这台机器上有哪些 shell（Windows PowerShell 5.1 / PowerShell 7 / Git Bash / WSL），探到才给选项；选中之后 bash 工具与终端会话都走它，模型看到的工具说明也跟着改口（选了 Git Bash，它就按 bash 的语法写命令），审批地板的引号与转义规则同步切换。探测结果缓存在本机 7 天，启动时不会为了列选项去起子进程；装了新 shell 点一下「重新检测」就刷新。
- **用量统计** — 设置 → 用量统计：汇总卡 + Token 活动热力图（今天 / 近 7 天 / 近 30 天 / 近一年，手机上只滚那一块）+ 分模型趋势折线 + 模型占比环形图；输入框上方的 Token 卡自动进位（1,238,946 读作 1.2M，335,048 读作 335K），精确值放在悬浮提示里。
- **可收起的右侧栏** — 关掉整块栏最后一张页签才收起（「开始」页留着，下次展开还是它）；只要还剩页签（哪怕只剩「开始」）就照旧展开，分栏清空一格也一样。
- **面板宽度记得住** — 侧栏、正文列、右侧栏、并排审查的宽度与侧栏收起状态跨重启保留：这几项落在 `~/.dsc/settings.json`，不靠浏览器存储，所以宿主换端口、切工作目录再回来，还是你拖出来的那个宽。
- **提问卡可收起** — 模型一次问好几题时，卡片分别是「标头（题目标签 + 题干）+ 作答区 + 翻页栏」；点标头右侧的折叠钮收起，只剩一行标头（题干两行封顶），输入框上方立刻让出空间。收起不平移内容：草稿、选到哪一题、翻页位置都留着，展开还是原样。
- **写前预览收成一行** — 模型改文件之前仍会把「改哪几行」摆进对话流，但默认只占一行（`编辑文件` / `新建文件` + 路径 + `+N 行 / -M 行`），点开才看 diff、再点收起；任务跑着的时候不再被十几块绿红 diff 冲掉。这一轮改完的文件在轮尾汇总成一张「已编辑 N 个文件」的卡。
- **安全默认** — 写 / 执行一律过审批卡（一次授权一次生效）；沙箱策略围栏、危险命令灾难地板；「沙箱三档」与「谁来审」是两个正交的旋钮（见 [§权限与安全边界](#权限与安全边界)）。
- **设置页不再重复问同一件事** — 通用页只留「权限预设」（沙箱 + 权限模式 + 审阅者三合一），下面那两个单旋钮与它重复，已经去掉；要拼预设外的组合仍可用 `/policy` 与 `/reviewer` 命令。
- **AI 复核看得见上下文** — 判官不再只拿「工具名 + 参数 + 最后一句用户原话」：它看到这一轮的全部历史（谁说的、做过什么、当前目标与未完成清单）。后台作业通知、队友汇报、环境快照只能当事实、不能当授权，长任务里因此不会再把「看下作业输出」当成「只许看输出」；判官的结论收紧成四种固定形状，说不清的一律回到你点卡；它还会收到项目规则与每个工具的参数说明，子代理会话里的「父代理指令」也不会被当成你的授权。判官自己没跑完时会发一条提示，不想让它回落放行可以打开 `approval.failClosed`（失败即拒绝）。用 `run_code` 写脚本时不再为「脚本本身」弹一张卡，脚本里每次真正的工具调用照样逐个审。
- **权限按会话独立** — 每个会话各记自己的沙箱档位、权限模式与审阅者：A 会话切「只读」不影响 B 会话和后台跑着的子代理；新会话按「默认权限预设」起步，之后改默认值不动已经打开的会话。
- **画面不串台** — 后台会话跑出来的工具卡、压缩提示、文件预览、钩子留言只落在它自己的会话里；切到新会话不会看到上一个会话还在动的「查找文件」。
- **启动不再刷权限提示** — 按偏好恢复的权限模式 / 审阅者 / 权限预设不再往对话流里写「切换为…」（这三项在输入框那颗旋钮上一直看得见）；主动点预设、`/policy`、`/reviewer` 该有的回执照旧。
- **新会话当场看得见** — 点「新会话」，侧栏当前工作区顶上立刻多出一行并高亮；切到别的会话它就消失（还没发过消息，磁盘上也还没有文件），发出第一句话之后它变成正式会话、位置与高亮都不跳。输入框里打的半截话、贴的附件按工作区暂存，切走再点「新会话」还是那一句；重启不保留。
- **切会话不再等半拍** — 点侧栏那一行，高亮当场就换（正文随后落地，不再「点了没动静」）；刚看过的三个会话留在内存里，切回去不重读磁盘。背后三笔账：切会话不再重扫技能目录与 git 状态（同一个工作区里它们一个字节都没变，原来每次白白多花 30–50ms）、侧栏列表按文件改动情况缓存（你机器上 76 条会话从原来每次 120–150ms 降到约 18ms）、快照推送不再固定等一个 80ms 的窗口。宿主侧实测从 60–150ms 降到 3–35ms。
- **轮尾只在悬浮时说话** — 「~653 tok · 21:53」这行附注与复制 / 分叉同一套：平时透明，鼠标压到这一轮的回复上（或键盘焦点进来）才浮现；隐着也占位，所以不会一出现就把版面顶跳。
- **重新编辑留在当前会话** — 点消息旁那颗铅笔改完重发，不再另开一条会话：这条消息及其之后的回答在当前会话里作废，改过的文字接着发。磁盘上原文一条不删（日志末尾记一句「从这里往后作废」），所以改错了还能回查。
- **会话时间跟着「最后一步」走** — 侧栏那列时间现在读这条会话最后一次对话的时刻，不再读文件被写过的时间；点开一条老会话，它不会再平白无故变成「刚刚」。只看一眼也不会再改动任何会话文件（补权限默认值改为等下次真要写日志时才落盘）。
- **置顶图钉换了** — 原来那枚斜着的小图标缩到 13px 糊成一团，现在换成竖向图钉、放大到 14px：没置顶的平时藏着、悬浮（或键盘聚焦）才浮出来，已置顶的钉身填实、染成提示色，一眼分得出有没有钉住。
- **过程区更紧凑** — 工具调用与思考行去掉了卡片边框和悬停底色：一行只有图标 + 说明 + 摘要 + 行尾读数，点文字才展开；行高与行距各收一档，成功的行不再重复写「完成」。整轮「用时 X」与阶段组头这类汇总入口照留。思考行、工具行、阶段组头现在是**同一套三级栅格**：左缘对齐、组头字号与思考行同档；**一个阶段一段过程**——思考与工具收在同一个组头下（「已读取文件并执行了命令」），点开才是那一阶段想过什么、调过哪些工具，不再是一条工具一行地摊在会话里。
- **跑动中的那一行带时长了** — 消息流末尾恢复成「Numa 工作中，用时 12分34秒 ···」：整句扫光、上面一条细线分隔，秒数每秒跳一次；跑动中的阶段组头（「准备运行代码」）和它同时出现——组头报阶段，它报状态和时长。等确认 / 等审批时这句换成「等待你的确认」。底部状态栏不再跟着跳同一个秒数，它只管轮/步、速度、token 与上下文占用（对齐 dsh）。
- **上下文占用不再归零** — 切会话、重启宿主后，底栏「上下文已用」按这条会话最后一次请求的真实占用回填，不再显示 0%；这条会话一行用量都没有时整段不画（不拿 0% 冒充「还没数」）。
- **折叠默认态改完立即生效** — 设置里改「工具卡 / 定稿的思考行」的默认展开态，屏幕上的会话立刻跟着变；你手动点开过的那几条保持原样。
- **长会话省 token** — 旧工具结果每轮清一次，且只有清掉的量占到整段提示词 25% 以上才真清（清得太少反而会打断前缀缓存）、超过 8000 字符的工具输出只留头 4K + 尾 1K（最近 4 条原样保留，中间写明省了多少、原文在日志里）、历史图片按预算卸载、压缩前回插读过的文件、端点侧显式缓存断点；**沙箱档位与当前模式挪到请求末尾的环境快照**，切权限 / 换模式不再让整个前缀缓存失效（实测切一次权限曾一次损失 59K 命中）。命中率实测 93%，单次未命中中位数 2.3k token。
- **子代理默认不限轮次** — 派出去的队友想跑几轮跑几轮，需要收口时在设置 → 子智能体里填「轮次上限」（与角色文件的 max-turns 取更小）；设限后最后一轮收走工具，只让它直接交结论，汇报里带运行记录路径。
- **旁问（只读、流式）** — 在会话里选中一段文字，点浮出的「问 AI」，右侧栏就地回答：不执行工具、不写主会话、
  不进会话列表；答案按会话留在内存里，重启清空。入口三个：选区浮钮、右侧栏「开始」页的「旁问」卡、`Ctrl+Shift+K`；
  命令面板（`Ctrl+K`）另有两行动作，它的可见入口在顶栏右上角。
- **后台提醒分得清结局** — 窗口不在前台时，一轮结束会按结局弹系统通知：完成、失败（带错误原文）、输出撞长度上限，以及模型停下来等你（提问 / 审批 / 计划评审）；自己按的停止不提示。提示音与后台通知在设置 → 通用「任务提醒」里有开关，音色 14 选 1、选中即试听。手机推送同一套口径：失败单独一条，短轮失败也推，中断不推。

## 快速开始

### 桌面端

自带运行时，不用装 Node：到 [Releases](https://github.com/waq05/pneuma/releases) 下载安装版
`pneuma-setup-x.y.z.exe`（可选安装目录）或免安装单文件 `pneuma-portable-x.y.z.exe`。

### CLI（`numa`）

需要 Node.js ≥ 22.19：

```sh
npm i -g @waq666/pneuma    # 或免安装：npx @waq666/pneuma
numa                       # 独立启动（新会话）
```

`numa --resume` 恢复上次会话；`numa --resume <会话jsonl路径>` 恢复指定会话。

### 从源码跑

```sh
git clone https://github.com/waq05/pneuma
cd pneuma && pnpm install && pnpm build
npm i -g file:.       # 全局 numa 命令指向本地构建
```

## 快捷键与斜杠命令

| 按键 / 命令 | 作用 |
| --- | --- |
| 直接输入 + Enter | 发送消息 |
| 输入 `/` 后 | 输入框上方弹出候选面板：每行是「图标 + 中文名 + 英文名 + 一句说明」，说明右对齐；`/model ` 后列**可用模型**（↑↓ 选择、Tab 补全、Esc 关闭）。桌面、手机、终端三处同一套中文名，来自宿主那张命令表 |
| ↑ / ↓（空输入时） | 翻输入历史 |
| Ctrl+C | 一次：打断当前回合；2 秒内两次：退出 |
| Ctrl+T | 展开/折叠思考（reasoning） |
| `/new` | 新建会话 |
| `/resume` | 恢复历史会话（↑↓ 选择，Enter 确认，Esc 取消） |
| `/compact` | 手动压缩上下文（自动阈值：估算 tokens 超过「窗口 × 80%」与「窗口 − 输出预留 − 安全余量」里较小的那个；压完保留的最近对话按模型窗口 16% 的 token 预算折算，两条都可在设置「上下文压缩」里调） |
| `/model [端点/]模型名` | 切换模型（下一次请求生效；候选来自配置里的全部 provider/model） |
| 桌面端 Ctrl+V / 拖文件 | 图片、视频、其它文件都能贴/拖进输入框：图片先规范化再随消息发出；视频存原件并把关键帧一起发给模型，气泡里是一张可播放的视频卡；其它文件给模型一条只读路径。模型没开 `image` 模态时会被拒绝（见 [§配置](#配置)） |
| 桌面端悬停待发附件 | 图片/视频是 64px 缩略图（视频角上标「N 帧」），文件是带名字与体积的卡片；`×` 移除，空输入框按 Backspace 撤最后一条；贴图与附件在会话切换后各回各的，不会串到别的会话 |
| `/help` `/exit` | 帮助 / 退出 |

面板打开时按 Enter 会采用当前选中项；命令名还支持**唯一前缀自动展开**（输入 `/ne` 按 Enter 即执行 `/new`），带参数时同样生效（`/di HEAD` → `/diff HEAD`）。`/review` 这类**要收一段输入**的命令是例外：回车只把它补进输入框（`/review `，光标落在空格后、下方显示提示），你写完要求再按回车才执行。

桌面端输入框里能跑的是 9 条：`/new` `/compact` `/status` `/usage` `/diff` `/review` `/review-status` `/review-cancel` `/help`；
在那里的 `/help` 只列这 9 条（以前会把 23 条全列出来，其中 16 条一敲就被拒）。权限、模型、
思考强度这些有底栏旋钮的命令，完整清单在终端里打 `/help` 看。

手机上打 `/` 也会弹同一张菜单（点一行采纳），发出去的命令走宿主那条派发通道——以前手机上
打 `/compact` 会被当成普通消息喂给模型，模型只好回一句「不认识」。

工具授权卡出现时：`y` 允许一次，`n`（或 Esc）拒绝。卡只弹在发起它的那个会话里——后台会话的卡不串到当前视图，切回去（状态点会亮）再答。

## 工具集（10 件）

`bash`（PowerShell）、`read`、`write`、`edit`（唯一匹配替换）、`glob`、`grep` 六件核心读写搜索工具；
另有 4 件：后台作业三件套 `job_output` / `job_list` / `job_kill`，以及交互终端 `terminal`。
读类工具自动放行；**写/执行类必须过审批卡**（无持久授权，一次授权一次生效）。

## 配置

Pneuma 只读**自己的**配置文件（`~/.dsc/`）：

- **`~/.dsc/config.yaml`**（主配置）：`language`（界面语言，`en` 开头即英文，其余中文，缺省中文）
  + `default`（默认 provider/model）+ `providers`
  （`displayName` / `baseURL` / `apiKeyEnv` / `models` 列表；可选 `api` 选线上协议适配器，
  缺省 `openai-compat` 风格的 `openai-completions`，装了提供别的协议的插件后可换）。
- **模型可选字段**（不写就用默认，设置界面「模型」分区每个模型一行可直接改）：

  ```yaml
  models:
    - id: hy3-a
      contextWindow: 200000        # 上下文窗口（用于压缩阈值与侧栏显示）
      maxTokens: 32000             # 单次输出上限
      thinkingLevels: [off, low, max]   # 这个模型支持哪几档思考（默认四档 off/low/high/max）
      thinkingParam: reasoning-effort   # 档位发哪个字段：thinking / reasoning-effort / none
      effortMap: { low: minimal, max: ultra_max }  # 各档发给端点的线上值（写 null = 不发字段）
      modalities: [text, image]    # 能收什么输入：text / image / video
  ```

  `thinkingParam` 默认 `thinking`（只有开关、无档位字段的协议），此时低/高/最大都发 `thinking: enabled`；
  网关按档位取值的（发 `reasoning_effort`）要显式写成 `reasoning-effort`，界面上的思考档位才会真的生效。
  `modalities` 没写 `image` 的模型，界面上贴图会被直接拒绝。
- **key 来源顺序**：`apiKeyEnv` 指向的环境变量 → `~/.dsc/credentials.yaml`。代码绝不打印 key。
- **`~/.dsc/config.json`**（可选轻量覆盖）：`{ "provider": "...", "model": "...", "temperature": 0.7 }`。

```sh
numa config show              # 查看当前生效的端点/模型/key 来源（不打印 key）
```

- **界面语言**（2026-11-05 起）：`config.yaml` 顶层写 `language: en`，重启宿主并刷新页面就是整页英文——
  侧栏、对话区、设置页每个分区与字段、内置权限档位名、内置模式名都跟着换。中文是语义原文，
  英文缺译会回落中文而不是显示键名；会话流里**已经记下**的宿主提示不翻译（记录按写入时的说法留着）。

- **会话落盘**：`~/.dsc/sessions/<cwd 压缩名>/<uuid>.jsonl`（append-only，重放恢复）；
  `~/.dsc/.last-session` 是 `--resume` 无参时的指针。
- **附件落盘**：`~/.dsc/attachments/v1/objects/<sha 前两位>/<sha256>`（内容寻址，同字节只存一份）。
  会话 jsonl 里只记引用（`/api/attachments/<sha>`），图片在组装模型请求时才读成 base64；
  单图 ≤ 20MiB，一个视频/其它文件 ≤ 200MiB，一条消息最多 20 张图（含视频抽帧）。附件不会自动清理。

## 插件

功能包共 **74 个**（默认关 11 个；其中 19 个是界面单元 `ui-<id>`、1 个是界面骨架 `ui-layout`、1 个是渲染器 `ui-renderer`）。每个功能是一个包，住在 `src/packages/<id>/`，构建后落到 `lib/node_modules/@pneuma/<id>`，由 `@pneuma/base` 的行清单按顺序挂载。**核心服务（模型路由、会话、工具注册表、审批…）与 16 个功能档没有区别**：都能在插件中心停用，停了以后依赖它的行会报出原因。

16 个功能档里，默认开 5 个（联网搜索、危险命令硬拦截、长输出转存、历史会话搜索、文件与命令围栏）；默认关 11 个，其中 8 个在官方档（子智能体与任务板、操作电脑桌面、MCP 外部工具、工具按需加载、定时任务、代码跳转与报错、受控浏览器、侧栏浏览器），另外 3 个收在「实验」档（经验沉淀、dsh 插件兼容、文档与批量读取）。完整清单与各自干什么见 [docs/development.md](docs/development.md) 第 4 节。

首启会在 `~/.dsc/profiles/default/` 铺一份 profile（已有就不动）。把一个改过的功能包放进
`~/.dsc/profiles/default/node_modules/@pneuma/<id>` 再重启，就顶替应用里那份，不用重新打包：
55 个功能包支持这样覆盖；`llm` / `session` / `tools` / `approval` 这 19 个核心包声明为 pinned，
不认覆盖，profile 里放同名副本时会告警并写清哪一份不生效。核心契约包 `@pneuma/runtime` 同样跟应用走。
`numa plugin list` 的每一行会标出现在到底用的是谁：`← profile 覆盖`，或者 pinned 让路时那句说明。
删掉一个可选包后应用照常启动，插件中心把那一行标成缺包。

`numa plugin add` / `remove` 之后**不用重启宿主**：宿主在跑的时候，热更轮询盯着 profile 的三份清单
（`package.json`、`compatibility.json`、`cordis.patch.yml`），变了就重算一次组合包——新包的行挂上、
删掉的包的行卸下（约 1 秒）。**带界面半边的包连页面也不用刷新**：宿主换完图会推一帧，界面当场多出（或少掉）那一块。
宿主没开就下次启动装配。

三件相关的事同样不用重启：

- **手工往 `~/.dsc/plugins/` 丢一个 `.js`**：连续两轮扫描（约 2 秒）指纹没变就挂上；删掉就卸下。
  走插件中心或工具安装的则当场挂载。
- **原地升级一个装好的包**：它 `client.js` 的字节变了，页面按新产物换装（界面产物热更默认开，
  `DSC_UI_HMR=0` 可关）。
- **信任一份第三方界面插件**：写盘之后立刻推帧装载，不用再按 F5。
- **手机端也吃同一条推帧**：远程壳（`/api/events` 的 `event: plugins`）在这轮接上了启动图——
  手机开着页面时在桌面上装/卸插件，手机上当场换图，不用下拉刷新。

装完想看「哪个包的安装脚本被 pnpm 跳过了」（它默认不跑第三方脚本）：`numa plugin builds`，
要跑就在那个 profile 里 `pnpm approve-builds` 勾选、再 `pnpm rebuild`。`add` 那一步也会把这个提示打出来。

版本闸拦下的包（包的 `engines.pneuma` 对不上当前运行时）可以精确授权，授权**只对这一个版本组合有效**：

```
numa plugin version-exemptions                    # 看已经授权了哪些，第一行会打出当前运行时版本
numa plugin allow-version @acme/x@1.2.3 --dsh-version <运行时版本> --accept-risk
numa plugin revoke-version @acme/x@1.2.3 --dsh-version <运行时版本>
```

不给 `--accept-risk` 就不写盘（不兼容插件可能崩溃或丢数据）。换个版本、或者换了运行时版本，都要重新授权。

界面包（19 个）是独立包，源码住在 `src/packages/` 下的 `ui-<id>` 目录（每个单元一个包，`index.ts` 是空 `apply` 的宿主半，界面半在 `ui/`），产物落 `lib/ui/plugins/`，id 与 0.8.1 一致。

「文档与批量读取」要先用一次 `npm install dsh-ops`（装在 `~/.dsc/plugins` 下即可），插件默认关，装好后在插件中心打开；没装时会一个工具都不注册，设置页写清找过哪些位置。

界面那一半（含 dsh 组合包自带的界面半）也在插件中心里管：手工放进 `~/.dsc/plugins/<目录>/` 的
要先点一次「确认信任」，用 `numa plugin add` 装进 profile 的组合包装了就算同意，直接在
「组合包界面」那一组里开关。信任**绑着当时那份产物**：插件内容换了（升级、重装、手改），
旧信任不再成立，卡片会要求重新确认——换过一次内容的插件不该沿用上一次的点头。

外部插件 = 单个 ESM `.js` 文件放进 `~/.dsc/plugins/`，可注册工具、命令、监听事件，
桌面端「插件」页可视化管理。完整 API、上手路径与扩展点速查见 **[docs/plugin-development.md](docs/plugin-development.md)**（§0 快速上手，§1–§10 完整规格）；可运行示例见 `examples/plugins/ping.js`。

## 架构

一条消息的旅程：

```
你的一句话 → ReAct 循环（流式）→ 写/执行类先过审批卡 → 工具 → 定稿 → JSONL 落盘 → 界面快照
```

```
bin/dsc.js          启动器（零依赖）：--resume / config 子命令 → spawn node lib/boot.js
src/boot.ts         进程入口：读配置 → createKernel()（按行挂载）→ 追加外部插件
src/packages/cli/  numa config / numa plugin 两个子命令（库包 @pneuma/cli，内核起来之前跑）
src/core/           自研引擎（零 UI 依赖）
  config.ts         读 ~/.dsc/config.yaml + key 来源链（env → 凭据文件）
  llm.ts            OpenAI chat-completions 流式客户端（SSE/reasoning/tool_calls/usage/重试）
  session.ts        JSONL 会话（append-only + 重放恢复）
  loop.ts           MiniAgent ReAct 循环（turn → stream → 审批 → 工具 → 定稿）
  tools/            bash/read/write/edit/glob/grep 注册表
  approval.ts       写/执行类挂起等 y/n
  compact.ts        保头折尾摘要压缩
src/adapter/        core 事件 → 快照投影（transcript 折叠 + core-runtime）
src/contract.ts     UI ⇄ 运行时 的中性契约（DscRuntime）
src/host/kernel.ts  内核装配器：建 Context、挂应用自带的行、挂外部插件（103 行）
src/packages/       86 个包：74 个功能包（含 19 个界面单元、界面骨架与渲染器）+ 12 个库包（package.json + cordis.patch.yml + index.ts）
src/packages/tui/app/  ink UI（App/ChatView/Composer/ToolCard/ApprovalCard/SessionPicker/StatusBar）
desktop/            Electron 桌面端：主进程 + 独立运行时子进程；界面就是插件壳（旧渲染层已删除）
ui-shell/           桌面与手机共用的界面壳（插件化：布局 + 基元 + 官方界面插件；产物落 lib/ui/assets）
scripts/composer-test.mjs  候选面板/输入行的确定性测试（node scripts/composer-test.mjs，16 项断言）
```

**模式（Agent 预设）**：一根独立的旋钮，决定模型是谁、手上有什么、被叮嘱了什么（提示词 + 工具目录）。出厂四个——标准 / PTC / 极简 / 创造（顺序与 dsh 的 preset 一致）：PTC 是全量工具再加 `run_code`，极简只有一条 shell 加 `read_image`、提示词换成一句固定话（保留 AGENTS.md 注入），创造在标准之上加 `runtime_api`。自己加的模式就是 `~/.dsc/presets/<名字>.md` 一个文件，设置页可图形编辑，输入框下方那颗旋钮或 `/preset <名字>` 切换。模式**只做减法**（工具白名单取子集、提示段只能摘掉四段），任何模式都放宽不了安全。详见 [docs/presets.md](docs/presets.md)。

## 权限与安全边界

三件事叠在一起，越靠后越硬：

- **权限预设（出厂四个）** — 只读 / 工作区可写（默认）/ 完全访问 / AI 复核，取值与 dsh 对齐：只读是「只读沙箱 + 拦下后问你一次」，工作区可写是「工作区沙箱 + 区外问」，完全访问是「不设围栏 + 不问」，AI 复核是「不设围栏 + 每次调用先过模型判官」。切预设时沙箱、权限模式、审阅者三根一起写盘，重启后还是同一档；要微调就逐格改，会落到 `custom`。
- **审批卡** — 区外写入与命令一律挂起等你按 `y` / `n`，**一次授权一次生效**，没有持久授权。卡上只放四样东西：这次要干什么（一行中文，例如「删除 D:\\dsc\\.tmp」）、命令原文、为什么现在问你、以及改动预览；`pnpm --version`、`node -v` 这类只打印版本或帮助的命令不再弹卡。
- **灾难地板** — 危险命令（格式化磁盘、递归删根、`git push --force` 之类）即使选了「完全访问」也直接拒。

**边界要说清楚**：沙箱是策略围栏（默认开的 sandbox 插件：可写根白名单、受保护路径、命令前缀策略、一次性升权），拦得住 Pneuma 自己发起的工具调用，**拦不住命令内部的任意写**——那要选容器后端；最终兜底仍是审批卡。

## 已知限制

- 插件能加工具、命令、事件监听、设置分区和技能来源，但拿不到 DOM：界面扩展只接受可 JSON 序列化的控件声明。
- Windows 中文输入法可能拦截审批卡的 y/n 键（输入法切英文即可）。
- **电脑控制**（无障碍元素级点击 / 拖拽 / 截图）目前仅 Windows，且没接沙箱——动作按危险分级审计，最终仍过审批卡。
- 跨进程的路由状态（当前模型/思考强度）不落盘，重启宿主后回到配置默认值。

## 开发

```sh
pnpm install
pnpm build        # 编内部引擎与宿主（tsc → lib/）
pnpm build:ui     # 编桌面 / 手机共用的界面壳（产物落 lib/ui/assets）
pnpm typecheck
pnpm dev          # tsc --watch

node scripts/composer-test.mjs   # 自检：scripts/ 下每个 *-test.mjs 都是一个能单独跑的无头脚本
cd desktop && pnpm dev           # 桌面端（先把上面两条 build 跑过）
```

桌面端的进程分层、宿主 ⇄ 壳协议与打包流程见 [desktop/README.md](desktop/README.md)。

## 文档

| 文档 | 讲什么 |
| --- | --- |
| [docs/development.md](docs/development.md) | 开发手册：运行时结构、三条启动链路、进程间协议、`~/.dsc` 数据面、扩展点清单、自检与打包、代码约定、排错与关键数值 |
| [docs/development-log.md](docs/development-log.md) | 开发记录：各阶段引入了什么、决策台账、真 bug 台账、还欠什么 |
| [docs/plugin-development.md](docs/plugin-development.md) | 插件开发：§0 从零上手（选形态、跑通最小链路、扩展点速查、交付自检）+ §1–§10 完整规格（全表签名、dsh 兼容层、界面插件契约） |
| [docs/presets.md](docs/presets.md) | **模式（Agent 预设）**：模式文件怎么写、出厂四个各是什么、可去掉哪些提示段、四条硬规矩 |
| [docs/ui-design.md](docs/ui-design.md) | 界面开发规范：设计原则、令牌体系、原语层、布局与反馈、键盘与动效、主题引擎对照 |

其余文档按用途分三类：

**活参考与现状说明**：[docs/harness-benchmark-roadmap.md](docs/harness-benchmark-roadmap.md)（对标差距与路线图）、[docs/peer-feature-inventory.md](docs/peer-feature-inventory.md)（三家功能面清单）、[docs/remote-tunnel.md](docs/remote-tunnel.md)（遥控端口走隧道）

**外部实现拆解（按名字查的参考资料）**：[docs/codex-request-assembly.md](docs/codex-request-assembly.md)（codex 的请求组装）、[docs/dsh-request-assembly.md](docs/dsh-request-assembly.md)（dsh 的请求组装）、[docs/dsh-plugin-porting.md](docs/dsh-plugin-porting.md)（dsh 插件搬到 Pneuma 怎么改、哪些不支持）、[docs/runtime-comparison.md](docs/runtime-comparison.md)（三家 runtime 逐轮编排对照）

**已归档**：已完成的历史计划、一次性审查报告与停更的对照表都移到 [docs/archive/](docs/archive/) 了，每篇开头有一行 `状态：已归档（原因）` 和去向说明。共 14 篇，另有 `archive/shots/` 下 6 份当时的施工自检报告。

## 许可

MIT，见 [LICENSE](LICENSE)。问题与建议走 [Issues](https://github.com/waq05/pneuma/issues)。
