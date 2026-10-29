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

## 有什么

- **一颗内核，三种前端** — 终端 TUI、Electron 桌面端（默认已是插件化界面壳）、**手机浏览器遥控页**；局域网扫码配对，人在外面也能批卡、看进度、发消息（PWA + Web Push + Webhook）。
- **模型自由** — 多端点 / 多模型随意切；上下文窗口、思考档位、图片 / 视频模态逐模型配置并可就地实测。输入框底栏两颗 chip 直接换模型与思考强度：模型是两级菜单，思考强度是一条四档滑杆（关 / 低 / 高 / 最大，每档一套动效）。模型、档位与协作模式都**按会话记**：在 A 会话换模型，B 会话和后台子代理仍用自己的那一条。
- **智能体协作** — 子智能体、智能体团队（并行队友 + 收件箱 + 汇报）、任务清单、计划交付、跨轮目标续跑。叫停队友只是停当前那一轮：它在名册里留着，传话就能接着干，干完的汇报照旧回到主会话（要彻底清掉用「移除」）。
- **长期记忆** — 跨会话事实分「全局 / 用户偏好 / 工作区」三格，当轮生效，可评估、可整理。
- **插件化** — 每个服务一个 cordis 插件；官方 18 个可开关插件（见 [§插件](#插件)）+ 单文件 ESM 第三方插件；桌面界面壳本身也是插件架构（带 SDK）。
- **四档主题** — 深色（默认）/ 浅色 / Claude（暖米白，取 Anthropic 官方色板）/ 跟随系统；整屏颜色只由两个种子（墨色、强调色）与一组百分比旋钮派生，换皮肤不用改组件。
- **用量统计** — 设置 → 用量统计：汇总卡 + Token 活动热力图（今天 / 近 7 天 / 近 30 天 / 近一年，手机上只滚那一块）+ 分模型趋势折线 + 模型占比环形图；输入框上方的 Token 卡自动进位（1,238,946 读作 1.2M，335,048 读作 335K），精确值放在悬浮提示里。
- **可收起的右侧栏** — 关掉整块栏最后一张页签才收起（「开始」页留着，下次展开还是它）；只要还剩页签（哪怕只剩「开始」）就照旧展开，分栏清空一格也一样。
- **面板宽度记得住** — 侧栏、正文列、右侧栏、并排审查的宽度与侧栏收起状态跨重启保留：这几项落在 `~/.dsc/settings.json`，不靠浏览器存储，所以宿主换端口、切工作目录再回来，还是你拖出来的那个宽。
- **提问卡可收起** — 模型一次问好几题时，卡片分别是「标头（题目标签 + 题干）+ 作答区 + 翻页栏」；点标头右侧的折叠钮收起，只剩一行标头（题干两行封顶），输入框上方立刻让出空间。收起不平移内容：草稿、选到哪一题、翻页位置都留着，展开还是原样。
- **写前预览收成一行** — 模型改文件之前仍会把「改哪几行」摆进对话流，但默认只占一行（`编辑文件` / `新建文件` + 路径 + `+N 行 / -M 行`），点开才看 diff、再点收起；任务跑着的时候不再被十几块绿红 diff 冲掉。这一轮改完的文件在轮尾汇总成一张「已编辑 N 个文件」的卡。
- **安全默认** — 写 / 执行一律过审批卡（一次授权一次生效）；沙箱策略围栏、危险命令灾难地板；「沙箱三档」与「谁来审」是两个正交的旋钮（见 [§权限与安全边界](#权限与安全边界)）。
- **权限按会话独立** — 每个会话各记自己的沙箱档位、权限模式与审阅者：A 会话切「只读」不影响 B 会话和后台跑着的子代理；新会话按「默认权限预设」起步，之后改默认值不动已经打开的会话。
- **画面不串台** — 后台会话跑出来的工具卡、压缩提示、文件预览、钩子留言只落在它自己的会话里；切到新会话不会看到上一个会话还在动的「查找文件」。
- **启动不再刷权限提示** — 按偏好恢复的权限模式 / 审阅者 / 权限预设不再往对话流里写「切换为…」（这三项在输入框那颗旋钮上一直看得见）；主动点预设、`/policy`、`/reviewer` 该有的回执照旧。
- **新会话先不留痕** — 点「新会话」不再立刻在会话区多出一行：说过第一句话它才出现（磁盘上也才有文件）。输入框里打的半截话、贴的附件按会话暂存，切去「技能 / 插件」页再回来还在；重启不保留。
- **过程区更紧凑** — 工具调用与思考行去掉了卡片边框和悬停底色：一行只有图标 + 说明 + 摘要 + 行尾读数，点文字才展开；行高与行距各收一档，成功的行不再重复写「完成」。整轮「用时 X」与阶段组头这类汇总入口照留。
- **上下文占用不再归零** — 切会话、重启宿主后，底栏「上下文已用」按这条会话最后一次请求的真实占用回填，不再显示 0%；这条会话一行用量都没有时整段不画（不拿 0% 冒充「还没数」）。
- **折叠默认态改完立即生效** — 设置里改「工具卡 / 定稿的思考行」的默认展开态，屏幕上的会话立刻跟着变；你手动点开过的那几条保持原样。
- **长会话省 token** — 旧工具结果每轮清一次，且只有清掉的量占到整段提示词 25% 以上才真清（清得太少反而会打断前缀缓存）、历史图片按预算卸载、压缩前回插读过的文件、端点侧显式缓存断点；命中率实测 93%，单次未命中中位数 2.3k token。
- **子代理默认不限轮次** — 派出去的队友想跑几轮跑几轮，需要收口时在设置 → 子智能体里填「轮次上限」（与角色文件的 max-turns 取更小）；设限后最后一轮收走工具，只让它直接交结论，汇报里带运行记录路径。
- **旁问（只读、流式）** — 在会话里选中一段文字，点浮出的「问 AI」，右侧栏就地回答：不执行工具、不写主会话、
  不进会话列表；答案按会话留在内存里，重启清空。入口三个：选区浮钮、右侧栏「开始」页的「旁问」卡、`Ctrl+Shift+K`；
  命令面板（`Ctrl+K`）另有两行动作，它的可见入口在顶栏右上角。

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
| `/compact` | 手动压缩上下文（自动阈值：估算 tokens > 80% × 模型上下文窗口） |
| `/model [端点/]模型名` | 切换模型（下一次请求生效；候选来自配置里的全部 provider/model） |
| 桌面端 Ctrl+V / 拖文件 | 图片、视频、其它文件都能贴/拖进输入框：图片先规范化再随消息发出；视频存原件并把关键帧一起发给模型，气泡里是一张可播放的视频卡；其它文件给模型一条只读路径。模型没开 `image` 模态时会被拒绝（见 [§配置](#配置)） |
| 桌面端悬停待发附件 | 图片/视频是 64px 缩略图（视频角上标「N 帧」），文件是带名字与体积的卡片；`×` 移除，空输入框按 Backspace 撤最后一条；贴图与附件在会话切换后各回各的，不会串到别的会话 |
| `/help` `/exit` | 帮助 / 退出 |

面板打开时按 Enter 会采用当前选中项；命令名还支持**唯一前缀自动展开**（输入 `/ne` 按 Enter 即执行 `/new`），带参数时同样生效（`/di HEAD` → `/diff HEAD`）。

桌面端输入框里能跑的是 7 条：`/new` `/compact` `/status` `/usage` `/diff` `/review` `/help`；
在那里的 `/help` 只列这 7 条（以前会把 23 条全列出来，其中 16 条一敲就被拒）。权限、模型、
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

- **`~/.dsc/config.yaml`**（主配置）：`default`（默认 provider/model）+ `providers`
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

- **会话落盘**：`~/.dsc/sessions/<cwd 压缩名>/<uuid>.jsonl`（append-only，重放恢复）；
  `~/.dsc/.last-session` 是 `--resume` 无参时的指针。
- **附件落盘**：`~/.dsc/attachments/v1/objects/<sha 前两位>/<sha256>`（内容寻址，同字节只存一份）。
  会话 jsonl 里只记引用（`/api/attachments/<sha>`），图片在组装模型请求时才读成 base64；
  单图 ≤ 20MiB，一个视频/其它文件 ≤ 200MiB，一条消息最多 20 张图（含视频抽帧）。附件不会自动清理。

## 插件

每个服务一个 cordis 插件。官方可开关插件共 **18 个**（默认开：网页搜索、审批灾难地板、大输出溢出、会话全文检索、沙箱、文件更改预览；默认关：子智能体、智能体团队、电脑操作、生命周期钩子、MCP 客户端、工具渐进披露、定时任务、LSP 代码智能、浏览器自动化、侧栏浏览器控制、自我改进、dsh 兼容层等），在插件中心里手动开关；长期记忆是默认开的内核插件。完整清单与各自干什么见 [docs/development.md](docs/development.md) 第 4 节。

界面那一半（含 dsh 组合包自带的界面半）也在插件中心里管：手工放进 `~/.dsc/plugins/<目录>/` 的
要先点一次「确认信任」，用 `numa plugin add` 装进 profile 的组合包装了就算同意，直接在
「组合包界面」那一组里开关。

外部插件 = 单个 ESM `.js` 文件放进 `~/.dsc/plugins/`，可注册工具、命令、监听事件，
桌面端「插件」页可视化管理。完整 API、上手路径与扩展点速查见 **[docs/plugin-development.md](docs/plugin-development.md)**（§0 快速上手，§1–§10 完整规格）；可运行示例见 `examples/plugins/ping.js`。

## 架构

一条消息的旅程：

```
你的一句话 → ReAct 循环（流式）→ 写/执行类先过审批卡 → 工具 → 定稿 → JSONL 落盘 → 界面快照
```

```
bin/dsc.js          启动器（零依赖）：--resume / config 子命令 → spawn node lib/boot.js
src/boot.ts         进程入口：读配置 → createKernel()（cordis 装配）→ 装 UI 插件
src/tools/config-cli.ts  numa config 命令行工具
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
src/host/kernel.ts  内核装配顺序 + 三档插件清单（运行内核 / 官方可开关 / 自定义）
src/plugins/        每个服务一个 cordis 插件（含官方可开关插件，见上文清单）
src/app/            ink UI（App/ChatView/Composer/ToolCard/ApprovalCard/SessionPicker/StatusBar）
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

**外部实现拆解（按名字查的参考资料）**：[docs/codex-request-assembly.md](docs/codex-request-assembly.md)（codex 的请求组装）、[docs/dsh-request-assembly.md](docs/dsh-request-assembly.md)（dsh 的请求组装）、[docs/dsh-plugin-porting.md](docs/dsh-plugin-porting.md)（dsh 插件搬到 Pneuma 怎么改、哪些不支持）

**已归档**：已完成的历史计划、一次性审查报告与停更的对照表都移到 [docs/archive/](docs/archive/) 了，每篇开头有一行 `状态：已归档（原因）` 和去向说明。共 14 篇，另有 `archive/shots/` 下 6 份当时的施工自检报告。

## 许可

MIT，见 [LICENSE](LICENSE)。问题与建议走 [Issues](https://github.com/waq05/pneuma/issues)。
