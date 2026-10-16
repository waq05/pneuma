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
- **模型自由** — 多端点 / 多模型随意切；上下文窗口、思考档位、图片 / 视频模态逐模型配置并可就地实测。输入框底栏两颗 chip 直接换模型与思考强度。
- **智能体协作** — 子智能体、智能体团队（并行队友 + 收件箱 + 汇报）、任务清单、计划交付、跨轮目标续跑。
- **长期记忆** — 跨会话事实分「全局 / 用户偏好 / 工作区」三格，当轮生效，可评估、可整理。
- **插件化** — 每个服务一个 cordis 插件；官方 18 个可开关插件（见 [§插件](#插件)）+ 单文件 ESM 第三方插件；桌面界面壳本身也是插件架构（带 SDK）。
- **安全默认** — 写 / 执行一律过审批卡（一次授权一次生效）；沙箱策略围栏、危险命令灾难地板；「沙箱三档」与「谁来审」是两个正交的旋钮（见 [§权限与安全边界](#权限与安全边界)）。
- **长会话省 token** — 旧工具结果按轮微压缩、历史图片按预算卸载、压缩前回插读过的文件、端点侧显式缓存断点。

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
| 输入 `/` 后 | 输入框上方弹出候选面板：命令阶段列命令，`/model ` 后列**可用模型**（↑↓ 选择、Tab 补全、Esc 关闭） |
| ↑ / ↓（空输入时） | 翻输入历史 |
| Ctrl+C | 一次：打断当前回合；2 秒内两次：退出 |
| Ctrl+T | 展开/折叠思考（reasoning） |
| `/new` | 新建会话 |
| `/resume` | 恢复历史会话（↑↓ 选择，Enter 确认，Esc 取消） |
| `/compact` | 手动压缩上下文（自动阈值：估算 tokens > 80% × 模型上下文窗口） |
| `/model [端点/]模型名` | 切换模型（下一次请求生效；候选来自配置里的全部 provider/model） |
| 桌面端 Ctrl+V / 拖文件 | 把图片贴进输入框，随这条消息一起发出（模型没勾「照片」会被拒绝，见 [§配置](#配置)） |
| 桌面端双击待发贴图 | 全屏预览大图（点任意处或 Esc 关闭）；贴图在会话切换后各回各的，不会串到别的会话 |
| `/help` `/exit` | 帮助 / 退出 |

面板打开时按 Enter 会采用当前选中项；命令名还支持**唯一前缀自动展开**（输入 `/ne` 按 Enter 即执行 `/new`）。

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

## 插件

每个服务一个 cordis 插件。官方可开关插件共 **18 个**（默认开：网页搜索、审批灾难地板、大输出溢出、会话全文检索、沙箱、文件更改预览；默认关：子智能体、智能体团队、电脑操作、生命周期钩子、MCP 客户端、工具渐进披露、定时任务、LSP 代码智能、浏览器自动化、侧栏浏览器控制、自我改进、dsh 兼容层等），在插件中心里手动开关；长期记忆是默认开的内核插件。完整清单与各自干什么见 [docs/development.md](docs/development.md) 第 4 节。

外部插件 = 单个 ESM `.js` 文件放进 `~/.dsc/plugins/`，可注册工具、命令、监听事件，
桌面端「插件」页可视化管理。完整 API 与开发规范见 **[docs/plugin-development.md](docs/plugin-development.md)**，上手路径与扩展点速查见 **[docs/writing-plugins.md](docs/writing-plugins.md)**；可运行示例见 `examples/plugins/ping.js`。

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
desktop/            Electron 桌面端：主进程 + 独立运行时子进程；界面默认加载壳产物，可回退旧渲染层
ui-shell/           桌面与手机共用的界面壳（插件化：布局 + 基元 + 官方界面插件；产物落 lib/ui/assets）
scripts/composer-test.mjs  候选面板/输入行的确定性测试（node scripts/composer-test.mjs，16 项断言）
```

**模式（Agent 预设）**：一根独立的旋钮，决定模型是谁、手上有什么、被叮嘱了什么（提示词 + 工具目录）。出厂四个——标准 / 极简 / 创造 / PTC，自己加的模式就是 `~/.dsc/presets/<名字>.md` 一个文件，设置页可图形编辑，输入框下方那颗旋钮或 `/preset <名字>` 切换。模式**只做减法**（工具白名单取子集、提示段只能摘掉四段），任何模式都放宽不了安全。详见 [docs/presets.md](docs/presets.md)。

## 权限与安全边界

三件事叠在一起，越靠后越硬：

- **权限预设（出厂四个）** — 只读 / 工作区可写（默认）/ 完全访问 / 自动审查。「沙箱三档」（只读 / 工作区可写 / 不设围栏）与「谁来审」（**本人** / **模型**）是两个正交的旋钮，四个预设就是它们的出厂组合；要微调就逐格改，会落到 `custom`。
- **审批卡** — 区外写入与命令一律挂起等你按 `y` / `n`，**一次授权一次生效**，没有持久授权。
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
| [docs/plugin-development.md](docs/plugin-development.md) | 插件 API 与开发规范（规格书：全表签名、dsh 兼容层、界面插件契约） |
| [docs/writing-plugins.md](docs/writing-plugins.md) | 写一个插件：选形态、跑通最小链路、扩展点速查、交付自检 |
| [docs/presets.md](docs/presets.md) | **模式（Agent 预设）**：模式文件怎么写、出厂四个各是什么、可去掉哪些提示段、四条硬规矩 |
| [docs/ui-design.md](docs/ui-design.md) | 界面开发规范：设计原则、令牌体系、原语层、布局与反馈、键盘与动效、主题引擎对照 |

其余文档按用途分三类：

**活参考与现状说明**：[docs/harness-benchmark-roadmap.md](docs/harness-benchmark-roadmap.md)（对标差距与路线图）、[docs/peer-feature-inventory.md](docs/peer-feature-inventory.md)（三家功能面清单）、[docs/remote-tunnel.md](docs/remote-tunnel.md)（遥控端口走隧道）、[docs/ui-shell-parity-audit.md](docs/ui-shell-parity-audit.md)（界面壳 vs 旧桌面版逐项对照）、[docs/ui-model-picker.md](docs/ui-model-picker.md)（输入区模型与档位选择）

**已完成的历史计划与施工书**：[docs/context-token-plan.md](docs/context-token-plan.md)（上下文与 token 优化）、[docs/dock-browser-control.md](docs/dock-browser-control.md)（侧栏浏览器控制）、[docs/plugin-runtime-parity-plan.md](docs/plugin-runtime-parity-plan.md)（插件运行时分批与懒物化）、[docs/ui-plugin-parity-plan.md](docs/ui-plugin-parity-plan.md)（桌面界面插件化）、[docs/ui-motion-options.md](docs/ui-motion-options.md)（整轮折叠动效选型）

**外部实现拆解与调查存档**：[docs/codex-request-assembly.md](docs/codex-request-assembly.md)、[docs/dsh-request-assembly.md](docs/dsh-request-assembly.md)、[docs/dsh-plugin-porting.md](docs/dsh-plugin-porting.md)、[docs/opencode-go-session-header.md](docs/opencode-go-session-header.md)

已归档的旧计划在 [docs/archive/](docs/archive/)（会话折叠清单、TUI 适配计划、TUI 视觉对齐计划）。

## 许可

MIT，见 [LICENSE](LICENSE)。问题与建议走 [Issues](https://github.com/waq05/pneuma/issues)。
