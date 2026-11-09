# 架构优化方案（基于 2026-11-09 审查，尚未动代码）

## 0. 一句话结论

现在的问题不是「包分得不够细」，而是三件事同时发生：

1. **旧路径没有退场**：`src/core/` 里 58 个文件只做一件事——把旧路径转发到
   `src/packages/`，其中 39 个已经没有任何引用（详见 `90-global-evidence.md` 第 1 节）。
2. **同一个事实存了多份**：会话费用、折叠偏好、主题默认值、会话轮数、插件开关，
   都是「内存一份、磁盘一份、界面再算一份」。
3. **上帝文件把多个职责绑在同一个状态簇上**：`ui-status` 2310 行、`ui-sessions` 2039 行、
   `approval` 1544 行、`subagent` 1527 行、`computer-use/desktop-control` 1522 行。

因此顺序应当是「先止血 → 再删旧路 → 再拆文件 → 最后抽公共层」，而不是先重排目录。
目录重排不会减少任何一条重复逻辑，只会让 diff 更大。

## 1. 目标分层

```
contract/          纯类型 + 纯常量 + 归一化函数（宿主与界面共用，零 node 依赖）
   ↑                        ↑
core/               宿主能力（可用 node）      ui-core/  浏览器共享面（只转出 core 中零依赖模块）
   ↑                        ↑
packages/           功能插件  ──→  库包（cdp / session-core / ui-* / permission-core …）
   ↑
carriers/           host-stdio / webserver / remote / ui-* / tui
```

允许的依赖方向：

| 从 \ 到 | contract | core | 库包 | 功能包 | 载体 |
| --- | --- | --- | --- | --- | --- |
| contract | — | 否 | 否 | 否 | 否 |
| core | 是 | 自己 | **否** | **否** | 否 |
| 库包 | 是 | 经 `@pneuma/runtime/*` | 自己 | **否** | 否 |
| 功能包 | 是 | 经 `@pneuma/runtime/*` | 是 | **否** | 否 |
| 载体 | 是 | 是 | 是 | 经服务/槽位 | 自己 |

## 2. 七条硬规矩

- **R1**：`src/core/` 不许 import `src/packages/`，包括 `export *` 与 `import type`。
- **R2**：功能包之间零直接 import；共享代码下沉到库包或 core。
- **R3**：一项设置、一个枚举、一组默认值只有一份归一化函数；界面经 `@dsc/ui-core`
  取（它已经在转出 `native-bridge`、`token-estimate`、`model-caps`、`diff-text`、
  `err-text`、`throughput` 这些零依赖模块）。
- **R4**：一个事实只有一个状态持有者。磁盘账（`usage.jsonl`、会话 jsonl）优先，
  内存只保留「本次进程的实时增量」。
- **R5**：包入口文件 800 行、React 组件 600 行封顶；超了按职责拆，不按行数硬切。
- **R6**：跨包通信只走三样——槽位、服务、动作表。禁止 `window.dispatchEvent(new CustomEvent('shell.xxx'))`
  这种字符串总线（现在有 6–8 个）。
- **R7**：门禁必须能看见相对路径的跨层 import。现在 `plugin-dep-graph.mjs` 只认
  `@pneuma/` 说明符，所以 58 个 `export * from '../packages/…'` 全部漏过（见证据第 7 节）。
- **R8**：凡是「按会话」的状态，读写都必须显式带 `sessionId/sessionPath`，不许用
  `ctx.session.current()` 代替调用方会话。多会话常驻之后，`current()` 只是「用户正在看的那条」。

## 3. 四期改造

### 第 0 期：止血（2–4 天，只修 P0）

| # | 动作 | 位置 | 验收 |
| --- | --- | --- | --- |
| 0.1 | 启动图补搬 `services` 字段 | `core/ui-manifest.ts:295-302` | 新探针：声明了 services 的条目，图里必须带 |
| 0.2 | patch 行的 `config` 透传给 `mountRow` | `core/plugin-loader.ts:1580-1586` | 新探针：组合包 patch 写 config，插件拿到它 |
| 0.3 | 「插件开没开」只留一套判定 | `core/plugin-registry.ts:404-421` 为准，删 `plugin-loader.ts:1973` | 别名 / `defaultDisabled` 两组用例 |
| 0.4 | 开关只写一次盘 | `packages/runtime/index.ts:179` 与 `plugin-loader.ts:920/924` | 探针数写入次数 = 1 |
| 0.5 | （P1，可顺手带上）折叠回复归一化收进 contract | `core/prefs.ts:182/291`、`ui-transcript:176`、`ui-runtime:119`、`ui-settings:1238` | 缺字段时四处都得到 `final` |
| 0.6 | 费用以磁盘为准或补回填 | `adapter/transcript.ts:288`、`packages/transcript:229`、`core/usage-log.ts:399` | 切走再切回，`status.cost` 仍在 |
| 0.7 | `waiting` 按会话登记/查询 | `packages/waiting/index.ts:29-40`、`goal:124`、`schedule:210` | 后台挂卡不再钉死当前会话的目标 |
| 0.8 | `todo` / `goal` 用调用方会话读写 | `packages/todo/index.ts:106/113`、`goal/index.ts:85` | 两个会话并行各写各的 jsonl |
| 0.9 | 队友改用全局守卫链 | `packages/subagent/index.ts:477-529`、`:622` | `hooks.json` 禁令对队友生效 |
| 0.10 | `grep` / `glob` 逐文件读盘前过读禁名单 | `packages/tools-default/search-tools.ts:389-425`、`core/path-policy.ts:169-200` | `grep .env` 拿不到键值 |
| 0.11 | 命令分类定优先级，三套表不再互相否决 | `core/command-policy.ts:303`、`sandbox/execpolicy.ts:321`、`approval-floor.ts:506` | `git push --force` 按设计弹卡 |
| 0.12 | `patchSources` 加失效策略 | `ui-dockkit/ui/dock-state.ts:276/346`、`ui-preview/ui/ui.tsx:112` | 关页签再点开，不显示旧 diff |
| 0.13 | 侧栏浏览器默认给快照入口（或让 act 支持 selector） | `dock-browser/index.ts:825/97` | 默认配置下 click/type 可用 |
| 0.14 | dock 侧处理 JS 对话框事件 | `core/dock-browser.ts:76`、`dock-browser/index.ts:291` | alert/confirm 不再卡 25 秒 |
| 0.15 | MCP 候选顺序改成「带后缀优先」 | `packages/mcp/mcp.ts:298-316` | Windows 上 `command: "npx"` 能起来 |

### 第 1 期：删旧路径（2–3 天）

1. 删 39 个零引用垫片（清单见证据第 1 节）。
2. 16 个测试脚本改成 `lib/packages/<包>/…`，再删对应垫片。
3. 3 处源码引用重定向：
   - `services/types.ts:16/20` 的类型 → `src/contract/`；
   - `lsp/manager.ts:16` 的 `buildChildEnv` → 抽到 core 的进程环境模块，或让 lsp 显式依赖 mcp。
4. 工具卡：确认 Factory 一定注册后，删 `rows/tool-row.tsx` 的完整实现，fallback 改成
   「无局部槽的 ToolCard」；`TraceToolRow` 同样处理。
5. 样式：先用 CDP 统计 `views.css` 每条规则在真实 DOM 的匹配数，再按清单删死规则；
   在删之前先把 `styles.css` 覆盖它的那批改回令牌（见批次 03 的 F5）。

### 第 2 期：拆上帝模块（1–2 周，按包独立验收）

| 文件 | 行数 | 拆成 | 风险 |
| --- | --- | --- | --- |
| `ui-status/ui/ui.tsx` | 2310 | 面板骨架 / 胶囊拖动 / 八个分区 / 三条轮询 / work 页签 | 低（界面可截图验收） |
| `ui-sessions/ui/ui.tsx` | 2039 | 列表 / 行 / 右键菜单 / 分组 / 偏好解析 | 低 |
| `ui-settings/ui/models.tsx` | 1936 | 端点列表 / 端点编辑 / 模型能力 / 探测 | 中（写配置） |
| `approval/index.ts` | 1544 | 判定 / diff 预览 / 升级参数 / 卡片数据 | 中（安全链） |
| `subagent/index.ts` | 1526 | 名册 / 派活 / 汇报等待 / 生命周期 | 中（并发） |
| `computer-use/desktop-control.ts` | 1522 | PowerShell / UIA / 输入 / 截图 | 中（平台相关） |
| `browser/index.ts` | 1475 | 会话 / 快照 / 动作 / 启动 | 中 |
| `ui-layout/ui/app.tsx` | 1296 | 骨架 / 面板几何 / 诊断 / chrome | 低 |
| `tui/app/App.tsx` | 1863 | 键位分发 / 浮层栈 / 滚动 / 输入 / 审批 / 状态栏 | 中 |
| `core/plugin-loader.ts` | 1987 | 扫描 / 套 patch / 挂载 / 启停 / 版本闸 | 高（装配核心） |
| `core/session.ts` | 1686 | 日志 / 状态存储 / 收件箱 / 会话库 | 高（日志兼容） |

拆法统一：**先原样搬，不改逻辑**；搬完跑同一组门禁；确认无行为变化后再合并重复。

### 第 3 期：抽公共层（约 1 周）

| 公共件 | 现有份数 | 落点 |
| --- | --- | --- |
| 「真人发言」判据 | 5 | `core/human-message.ts` |
| 会话标题派生 | 4 | `core/session-title-text.ts` |
| 请求级 token 估算 | 3 | `core/token-estimate.ts` 增加 `estimateRequestTokens` |
| PowerShell 执行 | 3 | `core/win-exec.ts` |
| 子进程命令解析（PATH/PATHEXT） | 2 | `core/win-exec.ts`；LSP 那份已经修对，MCP 复用它 |
| 会话文件扫描 | 2 | `core/session-scan.ts`（`Session` 与 `session-search` 共用） |
| 时长 / 多久以前 / token 格式 | 各 2–3 | `ui-primitives/ui/time.ts`、`tokens.ts` |
| 路径展示 | 2 | `ui-primitives/ui/paths.ts` |
| 浏览器输入前的密钥拦截 | 3 | `core/secret-text.ts`（桌面侧额外挂命令判定） |
| 宽松 JSON 读盘 | 5+ | `core/json-file.ts` |
| 文件指纹 | 3 | `ui-bundles.ts` 的 `fileStamp()` |

### 第 4 期：状态收敛与总线（约 1 周）

1. 费用/用量：磁盘 `usage.jsonl` 为权威，`Transcript` 只留实时增量。
2. 会话扫盘：`core/session.ts` 与 `session-search` 共用一个 `scanSessionFiles`。
3. 主题、折叠偏好、字号旧档映射：收进 contract / ui-core，宿主与壳各 import。
4. `window` 事件：建 `SHELL_EVENTS` 常量表，或改用 `ui-actions` 的动作表。
5. `host-stdio` 与 `/api/invoke`：共用一份「方法合法性 + 实参校验」，节流抽
   `snapshot-throttle` 的 `createSnapshotPump({ mode })`。

## 4. 验收口径

每一期都必须跑：

```
pnpm run typecheck
pnpm --dir desktop typecheck
pnpm run check:plugin
pnpm run check:ui
```

按改动面加跑：

- 改界面：`node scripts/ui-locale-test.mjs --package <包>`、`node scripts/check-ui.mjs --e2e`；
- 改样式：`node scripts/ui-color-fallback-test.mjs`、`node scripts/ui-legacy-compat-test.mjs`；
- 改会话/审批/沙箱：对应的 `scripts/*-test.mjs`（见各批次报告的「验收」段）；
- 每个 P0 修完补一条探针，探针进 `check:plugin` 或 `check:core`，否则下次还会漏。

## 5. 不建议做的事

- **不要一次性重写 `core/session.ts`**。它背着 append-only 日志兼容与写租约，
  按「日志 / 状态 / 收件箱 / 会话库」四刀分开验收，每刀都保持旧记录可读。
- **不要把 TUI 与 Web 的组件合并**。两个载体的渲染方式不同，应该共享的是判据与
  格式化（第 3 期），不是 React 组件。
- **不要在没统计使用率之前删 `views.css`**。它 330KB，PROVENANCE 自己说九成规则不生效，
  但「不生效」要靠运行时匹配数证明，不能靠猜。
- **不要把 `host-stdio` 和 `webserver` 合成一条链**。一个走 Electron 进程内管道，
  一个走浏览器 HTTP + Cookie，安全模型不同；该合的是校验与节流这两块机制。
- **不要为了目录好看搬包**。搬包不减少重复，先解决旧路径与多份状态。

## 6. 风险与回退

- 删垫片：16 个测试脚本会红，必须同批改 import；`lib/` 产物由构建重新生成，无需手工处理。
- 拆 `approval` / `session`：涉及安全与日志格式，拆完必须跑全量 `check:core` 与
  会话恢复/分叉/rewind 探针。
- 改样式：先加统计脚本、保留旧文件一个版本，确认截图无回退再删。
- 每期独立提交，按仓库规范分批（杂务 → 启动器 → 内核 → 插件装配 → 桌面 → 文档）。
