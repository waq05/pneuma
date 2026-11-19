# 三家对标产品功能清单（dsh / codex / Pneuma）

> 状态：已归档（2026-11-17）：对标阶段收尾，留作三家功能面的证据底料。

[对标计划书](harness-benchmark-roadmap.md)的证据底料：三家产品的**全面功能清单**。前两节 2026-10-02 从各自源码逐包梳理得出，第三节 2026-11-03 按本仓库 0.8.1 的代码重写。计划书只引用本清单的结论（§7 差距登记），想核对某条差距的出处就回到这里。

> **快照时点**：前两节是对外部两家的事实快照，不随本仓库演进：dsh 快照提交 `4878cdabd8`，之后已 +4639 个提交；codex 快照 `1cc7e23612`，之后 +1384 个提交（数据按各自仓库的当前 HEAD 算）。行号与结论都按 2026-10-02 那一刻为准。第三节不同——它跟着本仓库走，时点是 0.8.1。

| 想知道 | 去看 |
| --- | --- |
| 这些清单怎么用、差距怎么排 | [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) |
| **本文档** | **三家各有什么（按能力域分组，带源码出处）** |
| dsh / codex 的请求组装细节（源码级拆解） | [dsh-request-assembly.md](dsh-request-assembly.md) · [codex-request-assembly.md](codex-request-assembly.md) |

取材方法与口径：

- **dsh**：`D:\deepseek-harness\deepseek-harness`，约 60 个功能包组、60+ client UI 插件包、4 个 app。工具权威目录 `docs/tool-catalog.md`、配置权威目录 `docs/config-catalog.md`（由脚本从运行时生成）。
- **codex**：`D:\codex\codex`，Rust 主体 `codex-rs`（150+ crate）+ `sdk/`（TS/Python）+ `docs/`。
- **Pneuma**：本仓库，基于代码取证 + [development-log.md](../development-log.md) 各阶段（已记到 0.8.1）。
- 全部为只读源码梳理，未运行任何一家；「未见」指在该仓库活动代码中未找到，不排除文档口径或仓库外实现。
- dsc 清单经三轮：第一轮按能力域盘点，第二轮对已具备能力做**实现深度复核**（与 dsh/codex 同层细比，确认的疏漏编号 T29–T47，登记在 [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) §7.5），第三轮在 0.8.1 上逐条重测——第二轮那批疏漏已全部修掉，因此本轮把「差距」翻成了现状，仍未做的收进 §12。

---

## 一、dsh（DeepSeek Harness）

定位：一切皆插件的 Cordis agent harness。每个模型可见工具都有独立包，UI 也是插件（`packages/client/ui-*`）。

### 1. 会话管理
- 事件溯源会话日志：JSONL 可选 Zstandard 压缩（`packages/session/session-persistence-jsonl`），格式版本迁移链 v0→v4（`session-format-*`）
- 列表：工作区分组或扁平、最近/手动排序、置顶分区、拖拽、每组 5 条折叠展开（`ui-workspace/README.md`）
- 管理操作：新建、改名、排序、搜索、fork、归档、工作区删除；子代理会话隐藏；**待处理交互警告圆点**；有定时任务的空闲会话显示时钟标记
- 多会话并行：Host 同时驱动多 agent/多 session；桌面退出守卫统计 running agents（含子代理、审批等待、排队消息、jobs、armed reminders）
- resume：持久会话恢复 + 崩溃中断 turn 修复（`core/agent-loop`）；语义崩溃检查点（`session-checkpoint-policy`）
- fork：会话行 fork 菜单 + `subagent_fork` 工具（以父会话已完成 turns 播种，`subagent-fork-in-process`）
- **会话标题生成**（`session-title`）：首条消息回退词 / LLM 策略（两个包：首条 prompt 或全部 prompts）/ 用户改名 + `refresh()` 重生成；永不进模型输入
- 查询/导出：统一查询层（list/filter/read/trace/**全文搜索**，`session-query`）+ SQLite FTS5 后端；`/export` 导出会话日志 ZIP（`session-log-export`）

### 2. 模型与 provider
- DeepSeek 原生 adapter：Messages 协议、thinking 档位（off/low/high/max）、图像 Files API（上传 + base64 回退）、私有 wire 扩展（`llm-deepseek` + `docs/deepseek-llm-api-wire-extensions.md`）
- 多 provider：pi-ai 目录（anthropic/openai/kimi/GLM 等 + 手工声明网关）、OAuth/交互式 key 登录、per-route 兼容开关、自托管端点的思考预算参数（`llm-pi-ai`）
- 自定义端点：设置页 Add model provider（Provider ID/baseURL/协议三选一/凭据/模型清单 + **「Fetch available models」在线发现**）
- 模型切换：`/model` 弹窗 + composer 模型位；会话已发请求则锁定日志中记录的模型
- 推理档位：Model/Effort 双行选择器（档位来自 Host 模型元数据）；档位词汇可重映射（如 `max: ultra`）
- **token 用量与占用**（`token-meter`）：replay 确定性测量（tokenUsage/contextPressure/contextBreakdown，无模型调用）；UI 上下文占用表 + ContextMeter（`ui-conversation`）；Trajectory 检查器显示 token/duration
- 重试：durable step 边界恢复（`llm-retry`）；DeepSeek 账号 OAuth 登录（`deepseek-account(-platform)`）

### 3. 工具集（30+ 工具包）
- 文件：`read`/`write`/`edit`/`read_image`（`tool-fs` + read-before-write 策略）、Claude-Code 风格 `str_replace_editor`
- 搜索：`glob`/`grep` 内置打包 ripgrep，超限结果 spill 落盘可续读
- Shell：一次性 `bash`/`pwsh` + **持久 PTY 版**（`tool-bash-persistent` 等）+ **六个持久终端工具** `terminal_open/read/send/signal/close/list`（`tool-terminal`）
- **PTC 编程式调用**：`run_code`（模型写 TS 经绑定调全部工具，嵌套调用重入完整安全管线、并发上限、沙箱提权需 justification+审批）；Python 版（CPython 子进程 + fd-3 协议）；Node 运行时
- Web：`web_search`/`web_fetch`，后端可换（DeepSeek 原生/Exa/Perplexity/匿名 HTTP）
- 子代理：`subagent` + `send_message`/`interrupt_agent`/`list_agents`；后端可插拔：in-process spawn/fork、ACP、DSH SDK、**Claude Code、Codex**
- **后台任务**：`run_in_background` + `job_output`/`job_list`/`job_kill`（`tool-jobs`），完成通知经 `agent.inject()` 注入
- 结构化：`todo_write`、`exit_plan_mode`、`create/get/update_goal`、`schedule_create/list/update/delete`（after/at/every/daily/weekly/cron + IANA 时区）、`ask_user_question`
- 交付与发现：`present`（交付卡）、`load_workspace_dependencies`（离线 Python/Node/pnpm 载荷）、`skill`（技能目录 + 本地文件系统技能源 + 内置 Office 技能）、会话历史五工具（`session_search`/`session_trace`/`session_event_*`）、`lsp` 四个只读导航操作
- 运行时自省/管理：`cordis_inspect_*`（Creator mode 只读自省）、`plugin_manager`（安装/启停 bundle，需 danger 权限或审批）
- MCP：stdio + Streamable HTTP、自动重连退避、工具名 `mcp__<server>__<tool>`、server instructions 进 system prompt、stdio 启动前清洗凭据环境变量；`mcp-resources` 三个资源工具
- experimental：Agent Team 九工具、Stagehand 浏览器六工具
- 工具权限：per-agent allow/deny mask（`ctx.tools.restrict`）；pre-execute allow/deny/ask waterfall 管线
- 未见：notebook/Jupyter 工具

### 4. 权限与审批
- 沙箱三档 read-only / workspace-write / danger-full-access；Linux/macOS 本地沙箱、**Windows 受限令牌 ACL**（`sandbox-windows-acl`）
- 审批策略 `ask`/`never` 两档；**fail-closed**（无 answerer 时拒）；**明确只有一次性 allow-once**，无 always-allow/记忆规则/撤销存储（README Known Limitations 原文）；每次请求与结果入审计日志
- 权限预设：sandbox+approval 两旋钮捆绑预设，`/permission` 命令 + 设置默认行 + Auto 实验预设（`permission-presets`）
- 审批卡：composer takeover 卡片，Enter 批准 / Escape 拒绝
- 危险动作：沙箱拒绝以政策文案回给模型；fs-sandbox 限制会话 workspace 写
- Auto review（实验）：每次工具调用前由当前模型审查，允许则以 Full access 执行、拒绝转人工
- 计划模式：`exit_plan_mode` 呈现计划，approve / 带反馈继续规划

### 5. diff 与代码审查
- 轮尾聚合 changed-files 卡：Host 侧 turn 首尾 git 快照 diff + 文件工具整文件捕获（maxFiles=500），UI 带行数统计
- 审查面板：右侧栏 changes-review tab——unified/side-by-side、换行开关、文件选择器、截断状态提示、Shiki 高亮
- 悬停预览：changed-file 行悬停 500ms 弹该文件 diff 预览（与侧栏共享缓存）
- 工具卡内嵌输出卡（terminal/read/diff/search/web）；正文 `code` 文件引用可点击打开侧栏预览
- 交付卡 `present` + Open in default app / reveal（解析已装编辑器/Git GUI/终端/文件管理器）
- GitHub PR 审查自动化：签名 webhook，PR ready-for-review 自动创建只读 review 会话
- 未见：`/review` 斜杠命令、per-hunk 接受/拒绝、per-tool always-allow

### 6. 命令系统
- 宿主命令：`/plan` `/compact` `/permission` `/export` `/feedback` `/goal` `/model` `/skill`（各由独立包注册）
- 命令基础设施：插件自有命令注册表（三种 dispatch、per-session 目录、附件准入）；client 侧 `/` 触发管道 + 分组候选菜单
- @提及：`@file`（本地 provider + 统一文件/会话选择器）、`@session` 跨会话引用、`@` 子代理引用
- 未见：用户自定义命令文件（命令只能由插件注册）

### 7. 上下文工程
- system prompt 组装：sections/variables/tool-schema sources 插件可扩展
- AGENTS.md 记忆链：`$DSH_HOME/AGENTS.md` + 项目根→cwd 全链（AGENTS.md/CLAUDE.md + .local 叠加）、去重、65,536 字节预算、深层目录增量发现、resume 对账
- 压缩：token 压力自动压缩 + overflow 后压缩重试 + `/compact` 手动；**超限工具输出先裁剪**（`compaction-tool-result-pruner`）；**图像预算卸载**（`compaction-image-offload`）
- 溢出保护：超限文本/图像落盘为可恢复文件 + 定位符回给模型（spill 组）
- 上下文注入：每步时钟/浏览器时区/elapsed（`time-context`）、tmux 感知、跨会话快照引用（不受信上下文）
- 计划/todo/goal：todos 投影清单；plan mode + 状态 chip；goal 持久目标 + 自动 continuation 轮次（含 blocked 下限轮数）

### 8. 终端与执行
- shell seam：bash/pwsh 各有 local 与 sandbox 两版；每调用新进程、托管环境变量；长输出截尾 + 全量落盘；**超时不 kill 而是转后台 job**
- 后台任务：per-owner 准入、输出 ring、事件流；前台 job 化路径
- 持久终端：PTY、readiness 检测、有界行输出；用户交互终端 controller（screen recovery）
- 信号：`terminal_signal` 白名单（SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP，对 shell 的 SIGKILL 拒绝）
- **SSH 执行**：OpenSSH 连接配置、远程 subprocess/terminal/fs、远程沙箱效果约束（`packages/ssh/*`）

### 9. UI 形态
- 布局：三栏 AppFrame（左栏 264–420px、折叠 56px rail、右栏 45%→70%）；可停靠分页树（`ui-dockkit`）；右侧栏多 tab：文件树/交互终端/沙箱浏览器/文档预览（Markdown、code、image、PDF、Office、HTML）
- 开始页：Session Intent hero + 工作区选择；目录选择三后端（native OS chooser / Miller 列浏览 / 自动）
- 主题：light/dark/system + 内容字号档 + `--dsw-*` token + 第三方主题注册
- 快捷键：按 device×OS 默认、覆盖持久化、双键 chord、冲突检测；`ui-shortcuts` 命令浏览/搜索；审批 Enter/Escape
- 设置页：General / Models（provider 卡+自定义 API+发现）/ Plugins 分功能 tab / Account / Plugin inventory
- 会话内：工具卡（root 树+嵌套 subcall）、Trajectory 视图（turn-aware 事件台账+时间线+记录检查器）、Reasoning 预览/Verbose 模式、**Like/Dislike 消息评分**（`ui-message-feedback`）、附件栏（拖放/图片 gallery/lightbox）+ 流式上传、上下文占用表
- 通知：仅桌面更新系统通知；会话/任务完成无 OS 通知
- i18n：zh/en + 浏览器回退

### 10. 传输与部署
- CLI：`dsh web`（本地 server + 自动开浏览器）、`--profile headless`（一次性任务）、`--profile sdk`（JSON-RPC stdio）、`--profile acp`、`dsh plugin`、`--patch` 配置覆盖层、`--dump-config[-schema]`
- HMR：监视 profile manifest + patch，插件代码与配置热重载
- Web Host：named routes + WebSocket + SPA fallback；typed Client↔Host gateway + 各 controller
- Desktop：Electron 壳（端口 19387）、托盘、退出任务守卫、应用内自动更新（强制更新流、签名）、`dsh://open` 协议、**内置离线 Python(numpy/pandas/python-docx/pptx/openpyxl/Pillow/lxml/XlsxWriter)/Node/pnpm 载荷**、内置 Office 技能、麦克风权限管理
- SDK：TS + Python（打包 dsh 可执行与原生 sidecar）；ACP server；Webhook 规则路由外部事件为会话
- 网络代理：HTTPS_PROXY 全局支持，拒绝项目 .env 决定代理
- 多设备：浏览器多客户端共享会话（steering inbox 排序、本地回声、原子对账）；OpenTelemetry 遥测

### 11. 其他差异化
- 一切皆插件 + 运行时自修改：插件管理器 UI、HMR、**Creator mode 让 agent 自省并自装插件**、浏览器端动态 Cordis 包
- Agent presets：单进程多组合（standard/ptc/cordis）+ persona 行插件
- Agent Teams（实验）：命名队友 + 持久消息 + 共享任务板 + roster/task board UI
- 语音输入（实验）：录音→可审阅转写；本地 CPU SenseVoice worker
- 防御性治理：同类工具循环提醒守护、协作式超时策略
- 会话日志上传（官方 DeepSeek 请求元数据，可关）
- 基建：双语文档 + 生成目录、recorded-session 快照回放测试、100% 覆盖率 gate

### dsh 招牌能力（按完成度排序）
1. 一切皆插件的运行时可组合架构（插件管理器 + HMR + Creator mode 自装插件）
2. PTC（run_code）编程式工具调用，native/ptc/both 三态呈现
3. 轮尾 changed-files 卡 + 侧栏 review tab 的 turn 级 diff 审查流
4. 三档沙箱 × fail-closed 审批 ×（实验）Auto review，三平台真沙箱（含 Windows ACL）
5. 一套代码五种部署形态：web / desktop / headless / SDK(TS+Python) / ACP
6. 深度 DeepSeek 纵向集成（OAuth、Files API、thinking、原生搜索、日志上传）
7. 多会话 Workspace 管理（置顶/排序/fork/归档/FTS5 全文搜索/ZIP 导出/崩溃检查点）
8. 长任务驱动（goal 自动续轮 + cron 定时跨重启补投 + 后台 job 三工具）
9. 运行中 steering（多客户端排队 inbox）
10. 子代理生态互通（in-process/ACP/SDK/Claude Code/Codex 五后端）
- 未见：notebook、per-hunk 接受/拒绝、`/review` 命令、per-tool always-allow、用户自定义命令文件、移动端专属 UI、会话完成 OS 通知

---

## 二、codex（OpenAI Codex CLI）

定位：Rust 工业级编码 agent，OS 级沙箱 + 客户端-服务架构 + 多前端。

### 1. 会话管理
- Rollout JSONL 持久化（专用 crate：recorder/压缩/search/索引/SQLite 状态库/写锁/维护）
- 历史模型：Legacy 与 Paginated 双模式；`codex resume`（picker/--last/--all）+ 协议侧 by thread_id / by history / by rollout path 三来源 resume，支持带权限 profile 与 turns 分页
- fork：CLI `codex fork` + TUI `/fork` + 协议 `thread/fork`
- 多会话：共享 app-server daemon；`codex agents` 浏览全部会话；**side conversation（`/side`、`/btw` 临时分支）**；`codex queue` 向已有会话排队消息；`/rename` `/archive` `/delete`
- **Backtrack**：Esc-Esc 进 transcript 浏览，左右选 prompt、Enter 回退到该 turn 前并重新编辑（`tui/src/app_backtrack.rs`）
- 轨迹调试：rollout-trace crate + `codex debug replay-trace`、`/rollout`

### 2. 模型与推理
- reasoning effort：none/minimal/low/medium/high/xhigh/max/ultra/persistent/custom（`protocol/src/openai_models.rs:59`）
- 模型目录：后端 `/models` 拉取 + 内置 catalog；`/model` 选择模型与 effort；模型升级/退役迁移文案
- ModelInfo 元数据面：context_window、effective_context_window_percent（默认 95%）、auto_compact_token_limit（默认 90%）、truncation_policy、service tiers、verbosity、输入模态、tool_mode（Direct/CodeMode/CodeModeOnly）、multi_agent_version、**model_messages（可覆盖每个内置工具的描述与 JSON Schema）**
- Provider：OpenAI 默认、自定义 provider、Amazon Bedrock（含 AWS auth/workload identity）、Ollama、LM Studio
- Context 工具：`get_context_remaining`、`new_context`（换新窗口）；token budget 提醒

### 3. 工具集
- **exec_command（统一 exec）**：PTY 运行、`yield_time_ms`/`max_output_tokens`、返回 session_id 供续写、`write_stdin` 交互；`sandbox_permissions`（use_default/with_additional/require_escalated）+ justification + prefix_rule
- `apply_patch`（freeform/custom 工具形态、流式事件）、`update_plan`、`view_image`、`web_search`（hosted）
- **request_permissions**：运行时申请文件系统 read/write 路径 + 网络（session scope）
- request_user_input（结构化提问，同步/异步）、send_message_to_user_async
- curr_time / sleep / wait_for_environment
- **tool_search + 延迟加载**（`tools/src/tool_discovery.rs`）；插件安装类工具；imagegen 图像生成
- MCP client：stdio/HTTP、**OAuth login/logout**、elicitation、MCP resources、CLI `codex mcp list/get/add/remove/login/logout`
- 子代理：V1/V2 两代协议（spawn/send_message/wait/interrupt/resume + **channels 消息板**）、spawn 深度限制
- **Code Mode**：JS/TS 代码方式调工具（V8 运行时，gRPC host、cell actor），per-model 可强制 CodeModeOnly
- 未见：MCP server 模式（把自身暴露为 MCP server；用 app-server/exec-server 代替）

### 4. 权限与审批
- approval_policy：untrusted / on-request（默认）/ **granular**（细分 sandbox_approval、rules、skill_approval、request_permissions、mcp_elicitations）/ never
- sandbox_policy：danger-full-access / read-only / external-sandbox / workspace-write（writable_roots、network_access、exclude_tmpdir）；WritableRoot 支持只读子路径与受保护元数据名（.git、.codex、.git/hooks）
- 平台沙箱：macOS Seatbelt（.sbpl 策略文件 + daemon）、Linux Landlock + seccomp（pid namespace、bwrap）、**Windows 受限令牌/提权后端**（`windows-sandbox-rs` + process-hardening）
- 网络管控：execpolicy 规则、network policy decision、**MITM 网络代理 + 凭据 broker**
- 审批交互：TUI 审批 overlay + diff 预览头部、prefix_rule 复用批准、session 级授权、`/permissions` 命令 + config `[permissions]` 命名 profile
- **Guardian 自动审查**：隔离同步审查者自动复核审批决策（专用模型 codex-auto-review），`/approve` 允许一次被拒重试
- config.toml：分层配置、profiles、`-c` 覆盖、`--strict-config`、约 150 个 feature flags

### 5. diff 与代码审查
- apply_patch 审批：PatchApproval 事件 + TUI diff 渲染
- `/diff`：show git diff (including untracked files)
- **`/review`**：审查范围 UncommittedChanges（含 untracked）/ BaseBranch / Commit / **Custom instructions**；**独立 review 子线程**（独立 review_model、禁用 web_search/view_image）；**结构化输出 findings[title/body/confidence/priority/code_location(文件+行区间)] + overall_correctness/explanation/confidence_score**；delivery 分 inline/detached
- 非交互审查：`codex exec review --uncommitted/--base/--commit`
- git 集成：git-utils crate、`codex apply`（git apply 应用 agent diff）、`/worktree`、doctor 的 git 检查

### 6. 命令系统
- TUI 斜杠命令约 60 条（`tui/src/slash_command.rs`，声明式矩阵管 inline args 与任务中可用性）：`/model /ide /permissions /keymap /vim /setup-default-sandbox /experimental /approve /memories /skills /import /hooks /review /rename /new /archive /delete /resume /fork /worktree /app /init /compact /recap /plan /voice /goal /agents /side /copy /export /raw /tui /diff /mention /status /daemon /warnings /cd /pwd /usage /debug-config /title /statusline /theme /mcp /apps /plugins /logout /quit /exit /feedback /rollout /ps /stop /clear …`
- **自定义 prompts 目录未见**（被 skills + 旧命令迁移器取代，`core-plugins/src/command_migration.rs` 含 Claude Code 命令迁移 profile）
- **@ 文件提及**：`/mention` + 文件搜索弹窗（`file-search` crate）；`@` 文本提及、`$` 工具提及
- 补全：composer 命令弹窗；CLI `codex completion`（shell 补全）

### 7. 上下文工程
- AGENTS.md 发现链：cwd 上溯到 project root（marker 默认 `.git`），根→cwd 全部拼接；`AGENTS.override.md` 与 fallback 文件名；`/init` 生成
- compact：手动 `/compact`、`/recap`；自动阈值 min(配置, 90%)；mid-turn vs pre-turn 压缩语义；远端 compact v2；**图像预算**；fallback 模型；Pre/PostCompact hooks
- `/status`：账户/plan、credits、rate limits（多窗口）、thread token 用量与**美元成本估算**、模型+reasoning、fork 来源、profile、sandbox/approval、远端连接
- 其他：IDE 上下文注入（/ide 选区与打开文件）、`<environment_context>`、`/import` 从 Claude Code 导入

### 8. 交互形态
- 布局：底部 composer + footer 状态行、transcript overlay（Ctrl+T）、审批 overlay、命令/文件搜索/多选 picker、排队消息预览、状态 shimmer
- Backtrack（见 §1）；**可重映射 keymap** + **Vim 模式**
- 附件：剪贴板图片粘贴、CLI `--image`、thread attachments
- 通知：legacy `notify` 钩子；`/warnings` 诊断
- 主题：`/theme` 内置 + `.tmTheme` 自定义 + 实时预览；`/statusline`、`/title`；`/pets` 终端宠物；`/raw` 原始 scrollback；`/export` markdown；**`/voice` 实时语音**（WebRTC）

### 9. 部署形态
- CLI/TUI 默认交互；`codex exec`（别名 e）：`--json`（JSONL 事件）、`--output-last-message`、`--output-schema`（结构化最终输出）、`--skip-git-repo-check`、`--ephemeral`、stdin prompt、resume/fork/review 子命令
- **app-server**：JSON-RPC v2，方法面一目录一域（thread/turn/account/model/review/mcp/memory/plugin/apps/fs/command_exec/feedback/browser_use_config/computer_use_config/realtime…）；传输 stdio/unix/ws/off；可生成 TS 绑定与 JSON Schema；remote control + 共享 daemon
- exec-server 独立执行器服务
- Desktop App（`codex app`，macOS/Windows）+ TUI `/app` 接力；IDE 扩展（VS Code/Cursor/Windsurf）经 app-server
- 云任务：`codex cloud` 浏览/新建/本地 apply（scrollable diff）
- SDK：TypeScript（spawn CLI + JSONL）+ Python + python-runtime
- GitHub Actions：不在本仓库（官方独立仓库）

### 10. 其他差异化
- login：ChatGPT OAuth PKCE + Device Code、API key、Bedrock、workload identity、**密钥存 OS keyring**
- 更新：`codex update` 自更新、启动时 update prompt
- **doctor**：`codex doctor` 体检安装/配置/auth/网络/桌面安全
- 遥测：otel（session）+ analytics（可关）；`/feedback` 上报日志
- Hooks 12 事件（PreToolUse/PermissionRequest/PostToolUse/PreCompact/PostCompact/SessionStart/SessionEnd/UserPromptSubmit/SubagentStart/SubagentStop/Stop/Interrupt，9 类支持 matcher，hook outcome 可改变行为）
- **Memories 两阶段**：phase1 提取 → phase2 汇总落盘 + citations/usage、线程级开关、`codex memory-reset`、外部 agent 记忆导入
- Worktree 隔离：受管 worktree 创建/base 分支/保留数量 + `/worktree`
- Skills/Plugins/Apps：SKILL.md 解析/隐式调用检测；插件 marketplace（add/remove/upgrade/policy）；ChatGPT Apps/Connectors 经 MCP
- 多代理 V2 + agent 命令中心（`/agents`）+ proactive 模式
- 浏览器/Computer Use 确认策略；attestation、cyber access program；`/experimental` 特性开关面板

### codex 招牌能力（按完成度排序）
1. 统一 exec（PTY + 续写 + 交互 stdin）+ 三平台原生沙箱（Seatbelt/Landlock+seccomp/Windows 受限令牌）+ 网络MITM 代理
2. 四档 approval_policy + granular 细粒度 + per-command sandbox_permissions + prefix_rule 复用批准 + Guardian 自动审查
3. Rollout 持久化 + resume/fork/backtrack 回退重编辑 + 共享 daemon 多会话 + 消息排队
4. 独立 review 子代理（uncommitted/base/commit/自定义，结构化 findings+置信度+行级定位）+ `codex exec review`
5. AGENTS.md 链 + 多级 compact（手动/自动 90%/mid-turn/远端 v2）+ token budget 提醒
6. 12 事件 hooks + skills + 插件 marketplace + MCP client（OAuth/elicitation/resources/tool_search）
7. app-server JSON-RPC 协议 + TS/Python SDK + IDE 扩展 + Desktop App + 云任务
8. 多代理 V2（spawn/channels 消息板/interrupt/wait + `/agents` 命令中心）
9. Memories 两阶段写入（提取/汇总 + citations）与线程级开关
10. Code Mode：V8 中以 JS/TS 编排工具调用
- 未见：自定义 prompts 目录加载、把自身暴露为 MCP server、GitHub Actions（独立仓库）

---

## 三、Pneuma（本仓库，dsc）

**Pneuma 段截至 0.8.1**（2026-11-03）。这一节按代码现状重写过一遍：早期以「差距」口吻登记的条目，多数已在 0.6.27–0.8.1 之间修掉，下面只写现在成立的事实；仍未做的统一收在 §12。

定位：个人终端 harness，TS + cordis 插件 + Electron 桌面端 + ink TUI + 手机 PWA 遥控端。内核装配 48 条元数据（内置 30 + 官方可开关 18，`src/host/kernel.ts:85,262`），另有 4 个无元数据的常驻插件（`permission-presets`、`desktop-dock`、`git`、`plugin-manager`）。

### 1. 会话管理 ——【完整】
- append-only JSONL 落盘与重放恢复（`src/core/session.ts:1080`）；summary/keep 压缩折叠、state/note 记录、「模型可见 ⟺ 已记录」不变量
- **跨进程写租约**：同工作区的会话被第二个宿主打开时争用失败并明说，不再两边交错写坏同一份日志；`meta.json` 归同一把锁（`src/core/session.ts:20`，锁实现在 `src/core/lockfile.ts`）
- **头行损坏可抢救**：meta 半截 JSON 时按内容反推 cwd 重建，不再整份会话打不开（`src/core/session.ts:306`）
- **中断回合自愈**：恢复时给「已发起、结果未知」的工具调用落盘补合成结果，模型知道先核查再重试，重复恢复幂等（`src/core/session.ts:872-896`）
- 列表：三种分组（工作区/树/单列）+ 三种排序 + 置顶（竖钉图标，未置顶时悬停才显）+ 拖拽 + 每组 5 条增量展开 + 展开态持久化；侧栏本地过滤搜索框；会话时间取最后一条对话，不读文件写过的时间
- 重命名/置顶/归档/回收站（30 天后自动清空）/恢复/永久删除/分叉/重新编辑（`src/packages/session/index.ts:236`）
- 跨会话全文检索：纯 TS 倒排索引（中文 1+2-gram，两段式召回，严格没命中按多数两字词兜底并标成模糊命中），`session_search` 工具 + `/search` 命令 + 后台回填（`src/packages/session-search/index.ts:171`）
- 恢复启动：`--resume auto`（.last-session 指针）；孤儿 tool_calls 由请求侧 `sanitizeToolOrphans` 兜底
- **后台会话**：每会话一个常驻 agent，切换只换「当前查看」，运行中的回合在后台跑完；侧栏状态点（working / awaiting-approval / just-finished）与「已完成未读」徽标（`src/contract/snapshot.ts:26,42`）
- 会话标题：首回合后用一个独立小请求起名，用户改名后永不覆盖（`src/packages/session-title/index.ts`）
- 导出：`/export` 与 `src/core/session-export.ts` 的 markdown 序列化
- 输入侧：`@` 文件提及补全（`src/core/mention.ts`，桌面与 TUI 共用同一纯模块）
- 已知边界：无格式版本迁移链（有意不加版本号，损坏走抢救而非升级）；无 `@session` 跨会话引用

### 2. 模型与 provider ——【完整】
- 协议接缝 `registerAdapter`（内置 openai-completions，SSE 手写解析）；config.yaml 多端点多模型，`/model` 带参数级补全
- 推理档位五档（default/off/low/high/max）+ 档位字段三态（thinking / reasoning-effort / none）+ 模型能力字段（`src/core/model-caps.ts` 单一真源）
- **在线模型发现**：`GET {baseURL}/models` 拉取填充，认 OpenAI / ollama / 纯数组三种形状（`src/core/model-discovery.ts`）
- **会话级模型记忆**：会话 state 记实际发过请求的模型，恢复会话优先取它而不是回落 config 默认（`src/core/session.ts:228-231`、`src/packages/llm/index.ts:70`）
- **流中断不丢已收内容**：半截回复按 `StreamInterruptedError` 落库，连接期有重试预算（`src/core/llm.ts:8-12`）
- 用量统计：usage.jsonl + 设置页聚合（汇总卡 + 全年热力图 + 分模型趋势 + 环形图，`src/packages/ui-settings/ui/usage.tsx`）
- 上下文占用表：`/status` 与壳里的占用卡，估算口径与自动压缩同源（`src/packages/commands/index.ts:766`）
- dsh 配置一次性只读迁移
- 已知边界：账号 OAuth 不做；**有人民币花费估算**（按 DeepSeek 官方单价 + 峰谷分桶，`src/core/pricing.ts`，状态栏与用量页都显示），但只对名含 deepseek 的端点生效，其它 provider 不显示金额

### 3. 工具集 ——【完整，多为官方插件可开关】
- 内置工具面：`bash`（含 `run_in_background`）、`job_output`/`job_list`/`job_kill`、`terminal`（open/read/send/close/list 五动作，无 PTY）、`read`/`read_image`/`write`/`edit`/`glob`/`grep`（`src/packages/tools-default/index.ts:197-205`）
- **输出防线齐了**：`read` 有 16000 字符顶 + 2000 行长上限 + NUL 二进制检测（`src/core/tools/fs-tools.ts:19-24`）；`edit`/`write` 带 mtime 锚，读改写窗口内被别人改过会当场拒（`:176`、`:241`）；bash 超时走 SIGTERM → 3 秒宽限 → 杀进程树，已收输出保留（`src/packages/tools-default/bash.ts:186-232`）；大输出溢出落盘（spill 插件，observer order 50）
- MCP：stdio + streamable-http 手写 JSON-RPC，`mcp__服务器__工具`，环境变量白名单；**resources / prompts / elicitation 三类能力齐全**（`src/packages/mcp/mcp.ts:128,150`），server instructions 进系统提示（`:183`）
- 子代理（MiniAgent 队友，按会话隔离、审批意愿取全局∩角色）+ 智能体团队（共享任务看板 + `team_task`）；级联默认限 1 层
- 电脑操作（PowerShell + user32，DPI 感知，每次审批）；浏览器自动化（CDP DOM 级，ref 代际校验，默认关）；侧栏浏览器页签
- 网页搜索（tavily/bocha/serper，**域过滤 include/exclude_domains 直通**，`src/packages/web-search/index.ts:123-135`）；定时任务；LSP（定义/引用/实现/悬停 + 写后新引入报错）
- PTC：`run_code` 同进程 `node:vm`，整段脚本时限 300 秒、同步执行段 15 秒、内部调用总数 200；**读写闸写独占**，两个写调用不会并发（`src/core/ptc.ts:31,38,41`、`src/packages/ptc/index.ts:177-190`）
- 工具渐进披露（`tool_search`/`tool_describe`/`tool_call` + 手写 BM25，默认关）
- 结构化工具：`ask_user_question`、`exit_plan_mode`、`todo_write`、goal 四件、`schedule_*`、`memory`、`skill`/`skill_write`、`session_search`、self-improve 三闭环
- 已知边界：无 notebook/Jupyter 工具；MCP 无 dynamic tools（prompts→工具）

### 4. 权限与审批 ——【完整，本仓库最重】
- 双旋钮：协作模式四档（build/plan/explore/quiet）× 权限模式三档（readonly/auto-edit/full-access）+ 审阅者正交轴（user/auto-review）；打包权限预设四档（只读 / 工作区可写（默认）/ 完全访问 / AI 复核），三根一起写盘
- **审批裁决四档**：allow-once（y）/ allow-session（a）/ allow-always（p）/ reject（n 或 Esc），另 `v` 切 diff；风险动态限档（`src/packages/tui/app/App.tsx:1241-1250`）
- 审批灾难地板（order 5 硬拒 + 命令白名单 + deny 黑名单 + 熔断 + 无人值守拒）；命令策略引擎（逐段判定 + 前缀 DSL 规则文件 + 加载期自检）
- AI 复核轴（模型逐次判断，失败退人工卡，与权限模式正交）；安全钩子（规则 + 脚本，fail-closed，mtime 信任名单）；生命周期钩子（codex 十四事件名：3 个完整接通、5 个部分、6 个无挂点）
- 守卫链固定刻度：5 地板 / 8 沙箱 / 10 模式 / 20 安全钩子 / 25 文件预览 / 30 审批（`src/core/tool-guards.ts:147`）
- 审计日志 + 密钥遮红；**权限四项与模型、思考档位按会话隔离**，A 会话换档不影响 B 会话与后台子代理
- 沙箱三档 + 可写根白名单 + 受保护路径 + 命令前缀策略 + 一次性升权（`sandbox_permissions` + `sandbox_scope`（once/session）+ `justification` 成对）；三个后端 `policy` / `docker` / `windows-token`（`src/packages/sandbox/policy.ts:43`）
- **Windows 受限令牌后端已实现**（`src/core/sandbox/win/`，ACL 能力 SID + WRITE_RESTRICTED pass-2 + 换执行体），并如实披露三个缺口：硬链接别名、读不受限、网络只有软墙（`src/packages/sandbox/win/backend.ts:1-26`）；ACL 授权任一步失败就自废后端退回策略围栏，不搞半吊子强制
- 沙箱越界改成「拦下之后问一次」，不再静默失败

### 5. diff 与代码审查 ——【完整】
- 底层 LCS unified diff（`diff-text.ts`）
- 工具卡 intended diff：write/edit running 期间从参数 + 盘上现值推演写后 diff，折叠行 +N -M 徽标 + mismatch 预告「执行会失败」
- 审批卡内嵌 diff：弹卡前推演、密钥遮红、默认收起一键展开
- 轮尾聚合卡「N 个文件已更改」（第一方归因）+ 回合级基线聚合（turnBaselines，纯内存）
- 右栏审查面板：unified⇄split、换行、shiki 高亮、拖宽、系统打开
- 悬停预览：轮尾卡行 / 正文提及 chip 停 500ms 出该文件 diff（Esc capture 截停防误拒审批）
- git 页签 diff：全量 / 单文件 `git diff HEAD --no-textconv --no-ext-diff` + stage/commit
- **`/review` 四档范围**（未提交改动 / 基准分支 / 某次提交 / 自定义关注点），派一个工牌强制只读的审查队友，产出结构化 `review-findings` 卡并支持行号跳转；配 `/review-status`、`/review-cancel`（`src/packages/commands/index.ts:223-370`、`src/packages/subagent/index.ts:816-882`）
- 已知边界：审查面板纯只读（无部分行接受）；bash/sed 改的文件不进第一方归因卡（靠 git 页签兜底）

### 6. 命令系统 ——【完整】
- 内置 **25 条**（`src/packages/commands-core/commands-completion.ts:32-78`，单一真源）：`/new` `/resume` `/agents` `/compact` `/model` `/policy` `/reviewer` `/permission` `/effort` `/thinking` `/fork` `/plugins` `/ui-trust` `/update` `/status` `/usage` `/diff` `/copy` `/export` `/review` `/review-status` `/review-cancel` `/settings` `/help` `/exit`
- **回合中可用性声明矩阵**：`duringTask: 'deny'` 的五条（`/new` `/resume` `/compact` `/fork` `/update`）在回合跑动时挡下，其余随时可用；壳的派发闸与菜单读同一份 spec
- 插件注册约 21 条（`/search` `/plugins` `/floor` `/hooks` `/learn` `/learnings` `/lifecycle-hooks` `/memory` `/mode` `/sandbox` `/schedule` `/skills` `/skills-ledger` `/todo` `/goal` `/browser` 等）
- 补全：命令前缀候选 + `/model` 参数级候选 + 唯一前缀自动展开（渲染层/TUI/插件共用同一纯模块）；菜单三列「中文名 + 英文名 + 说明」
- 自定义命令：外部插件 `ctx.commands.register`
- 已知边界：无 `@session` 跨会话引用

### 7. 上下文工程 ——【完整】
- system prompt 分段注册（稳定在前缓存友好）；AGENTS.md / CLAUDE.md 发现链：有 git 仓库时按 project root → cwd 有序发现，另有 `AGENTS.override.md` 与 `*.local.md` 覆盖层，20k 预算头尾保留（`src/packages/session-core/prompt.ts:74,127-130,159`）
- compact：手动 `/compact` + 自动阈值（80%×contextWindow，CJK 感知），保头折尾 + 锚点索引 + 用户原话逐字 + 细节找回指针；**压缩前先机械瘦身**（超长工具结果换指针、图像按预算卸载，`src/packages/session-core/compact.ts:41-55,91-116`）
- 微压缩冻结到「轮」，前缀缓存命中从七成拉回约九成
- 长期记忆三格 Markdown（global/USER/workspace）+ 轮尾自动复盘；todo 实时进度条；goal 跨轮续跑（带刹车）；技能（四层发现根 + 市场缓存）
- 模式（Agent 预设）：标准/极简/创造/PTC 四内置 + 自定义 `presets/*.md`
- **计划拒绝带反馈**：驳回时用户的原文捎进工具结果，模型不必盲猜（`src/packages/plan/index.ts:202-204`）
- 技能目录行带上 `whenToUse` 那一句（`src/packages/skills/index.ts:114-116`）
- 已知边界：压缩不可取消（interrupt 停不掉压缩那次模型调用）

### 8. 终端与执行 ——【部分，缺 PTY】
- `bash` 前台一次性（30s/120s 预算、8000 字符输出）；超时 SIGTERM → 宽限 → 杀树，已收输出仍可读；长活走 `run_in_background` + `job_*` 三工具
- 模型可用的 `terminal` 五动作工具（open/read/send/close/list），**无 PTY**——全屏程序跑不了，这是 T20 的降级版
- 桌面交互终端面板（xterm.js 多页签，人用）；设置里可选 PowerShell 5.1 / PowerShell 7 / Git Bash / WSL，工具说明跟着改口
- 执行体缝：沙箱容器后端与受限令牌后端都经 `src/core/tools/command-runner.ts` 真换执行体
- 已知边界：PTY 完整版（signal 真中断）未做，T48 立项待排期

### 9. UI ——【完整】
- 布局：左栏会话区 + 正文列 + 右侧 dock（guide/terminal/browser/files/git/preview 多页签、两格分栏、全屏、每会话布局持久化、caption 避让）；会话列宽默认 96ch
- 进程区：三级栅格（思考行 / 工具行 / 阶段组头同一套对齐）+ 四档展示档位（compact / standard / detailed / verbose）；只有一条工具调用时不套组头
- 主题：深 / 浅 / 跟随系统 + 四档出厂主题 + 原生控件条 IPC 同步 + 密度档；设计令牌 `--dsc-*`
- 快捷键：键位表 10 条（`Ctrl K` 命令面板、`Ctrl B` 侧栏、`Ctrl P` 文件、`` Ctrl ` `` 终端、`Ctrl T` 浏览器、`Ctrl Enter` 插话、`Ctrl Alt R` 重命名、`Ctrl Alt F` 分叉、`Ctrl Shift A` 归档、`Esc` 关浮层），按 `?` 随时打开（`src/packages/ui-palette/ui/ui.tsx:327-338`）
- 设置页：8 个内置分区（通用 / 模型 / 预设 / 技能 / 归档 / 用量 / 终端 / 关于，`src/packages/settings/index.ts:520`）+ 声明了 `inSettings: true` 的插件分区（远程控制、终端环境）；其余插件分区只在插件中心那张卡上
- 附件：内容寻址仓库 + 输入框贴图与文件 + 消息只留引用 + 附件卡与图片 lightbox
- 状态栏三段式（轮 / 步取宿主真值，不再估算）；轨迹页（TraceView / Timeline / Inspector）；队友面板 / 用量面板 / 技能中心 / 插件中心 / 配对弹窗
- 托盘（关窗缩托盘 + 一次性气泡）；检查更新（更新源已接 GitHub Releases，只查不装，有新版给「立即更新」或打开发布页）
- **手机遥控（独有）**：PWA 遥控端（visualViewport 键盘适配、图片压缩上传、增量帧重连补帧）+ Web Push（VAPID）+ Webhook（Bark/ntfy）+ 二维码半小时配对 + 逐台设备吊销；推送三处盲区已修（2 分钟升级再提醒 ×3、节流键带卡号、ask 提问卡与计划评审卡入列，`src/packages/remote/index.ts:657-706`）
- 已知边界：**有**桌面原生系统通知（后台回合跑完且窗口不在前台时弹「任务完成」，点击回主窗，设置可关，`src/packages/ui-transcript/ui/ui.tsx:156-185`）；手机端有模式面板与归档管理，只缺团队名册/任务板

### 10. 传输部署 ——【完整】
- 远程宿主：HTTP + WS **10 条 `api` 路由**（pair/ticket/revoke/upload/push-key/push-subscribe/push-unsubscribe/invoke/events/boot，`src/packages/remote/routes.ts:310-405`）+ 主控位锁 + 多设备 `devices.json` + `INVOKABLE_COVERAGE` 编译期兜底
- 桌面宿主通道：Electron utilityProcess + host-stdio JSONL（协议 v2，白名单由 DscRuntime 推出）；嵌入运行时依赖闭包自动组装
- TUI（ink，同契约）+ CLI 入口（`bin/dsc.js`）+ headless；SSH 隧道只有文档（`remote-tunnel.md`），无隧道代码
- 界面壳：插件化装配（cordis），19 个内置界面插件，组合包（宿主半 + 界面半）按 `package.json` 的 `dsh.client` 收进启动图
- 已知边界：无对外 SDK / 协议面（host-stdio 是内部协议）；无 ACP

### 11. 插件系统与杂项 ——【完整】
- 三档插件（内核不可停 30 / 官方可开关 18 / 外部单文件）+ 热挂载 + `plugin_manager` 工具（含 `browse_remote` / `install_remote` 远程安装，必须 https，装前过审批）+ dsh 插件兼容层（logger 桥 / 模块解析钩子 / 双形状 `ctx.tools`）
- 界面插件契约 2.0：槽位、chain 槽、类型化槽位、`provide`/`consume`、席位、Component Factory、动作表、分批启动与 HMR；第三方目录要过一次 `/ui-trust` 信任，产物带内容摘要 rev
- 服务面 39 个 `ctx.provide`（tools / commands / prompt / guards / surfaces / waiting / session / approval / sandbox / lsp / mcp / team / review / backgroundWorks / webServer …），`KERNEL_API_VERSION = 6`（`src/core/plugin-registry.ts:93`）
- 技能市场（GitHub 目录 / 索引 JSON 两类源，缓存 1h）
- 已知边界：宿主插件无 HMR（界面插件有）；无 doctor 式体检命令；插件远程安装只支持 https 直链（npm 包形态 T49 未做）

### 12. 仍未做（原样登记，别把上面当成「全齐了」）

| 项 | 现状 |
| --- | --- |
| checkpoint / rewind / 部分行接受 | 已有会话级回退（双击 Esc 撤回上一轮、`rewind` 记录截断重发）；文件级回滚与 per-hunk 接受未做，T51/T52 立项未动工，审查面板仍纯只读 |
| 对外 SDK / 协议面、ACP | host-stdio 只够内部用；CLI 只有 `--resume` / `config` / `plugin` 三路子命令 |
| SSH 远程执行 | 只有隧道文档，无隧道代码（T54） |
| 可观测性 otel | 无（只有本地审计日志） |
| doctor 体检命令 | 沙箱有 Windows 网络六项驻检（`/sandbox doctor`）；安装 / 配置 / auth 的总检没有 |
| 宿主插件 HMR、npm 包形态安装 | 界面插件有 HMR；宿主插件只能启停热挂载；远程安装单文件只认 https 直链，组合包走 pnpm |
| PTY 完整版 | `terminal` 是管道降级版（五动作、无 tty、无 signal 真中断）（T48） |
| 完整 steering | 只有 async-inbox 最小版（步骤边界落库），无多端排队 inbox |
| 子代理级联 | 默认 1 层，可配到 2（不是硬限） |
| 会话格式版本迁移链 | 有意不加版本号 |
| 移动端团队名册 / 任务板 | 模式面板与归档管理都做了，只缺这一块 |

### Pneuma 独有/领先项（相对 dsh 与 codex）
1. **手机遥控**：PWA + Web Push/Webhook + 二维码配对 + 逐台设备管理——三家都没有
2. **审批安全纵深**：灾难地板 + 熔断 + 命令策略引擎逐段判定 + 安全钩子 fail-closed + AI 复核轴 + 无人值守拒——比 dsh（ask/never 两档）细，且审批推送带升级再提醒
3. **中文优先**：会话检索 1+2-gram 与模糊兜底、界面全中文（codex/dsh 主英文）
4. 用量统计面板（热力图/趋势/环形）+ token 与上下文占用同源估算
5. 技能自修 + 台账回滚（self-improve 三闭环 + 老化）
6. 会话回收站（30 天可捞回）+ 会话写租约 + 头行抢救
7. 目标续跑带刹车 + 定时任务 pre-dispatch 校验（坏配置一次 token 不花）
8. 轨迹页（整轮折叠 + 时间线 + 独立节点检查器）
9. Windows 受限令牌沙箱（与 dsh 各自独立实现，均如实披露缺口）
