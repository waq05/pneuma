# Pneuma 代码规范与架构审查（2026-11-09）

分支：`feat/pluginization`　基线：`752badb chore(release): 升到 0.9.1`
工作区状态：审查期间有 31 个文件带未提交改动（其中 `ui-status/ui/ui.tsx` 是 00:37 的一次注释改动，
非本审查所为），审查按工作区现状进行。
纪律：**只读审查，不修改源码**；发现实时落到本目录。
规模：**10 个批次、200 条发现（P0 15 / P1 96 / P2 89；主控核对后 P0 保留 14 条）**。

## 批次

| 批次 | 主题 | 覆盖范围 | 报告 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | 内核底座与会话链路 | `src/core/session*`、`adapter/transcript`、`contract`、`services`、`packages/session*`、`transcript`、`compact`、`microcompact` | `01-kernel-session.md` | 已交付（P0 1 / P1 9 / P2 9） |
| 02 | 插件模型与装配 | `src/host`、`core/plugin-*`、`core/ui-bundles|manifest`、`profile-*`、`packages/plugin-manager`、`runtime*`、`dsh-compat` | `02-plugin-runtime.md` | 已交付（P0 3 / P1 9 / P2 12） |
| 03 | 界面壳与界面运行时 | `ui-shell/src`、`core/ui-*`、`packages/ui-core|ui-runtime|ui-boot|ui-layout|ui-dockkit|ui-slots|ui-renderer|ui-primitives|ui-palette|ui-actions` | `03-ui-shell.md` | 已交付（P0 1 / P1 7 / P2 7） |
| 04 | 对话呈现 | `ui-transcript`、`ui-composer`、`ui-prompt`、`ui-statusbar`、`ui-trace`、`ui-ask`、`ui-status`、`ui-team`、`ui-tasks` | `04-conversation-ui.md` | 已交付（P0 1 / P1 12 / P2 8） |
| 05 | 侧栏、设置与文件 | `ui-sessions`、`ui-settings`、`ui-plugins`、`ui-skills`、`ui-files`、`ui-preview`、`ui-browser`、`ui-terminal` | `05-sidebar-settings.md` | 已交付（P0 1 / P1 9 / P2 10） |
| 06 | 工具与安全 | `core/tools*`、`core/command-policy`、`path-policy`、`secrets`、`untrusted`、`packages/tools*`、`sandbox`、`approval*`、`permission-*`、`guards`、`hooks`、`ptc`、`spill` | `06-tools-security.md` | 已交付（P0 3 / P1 10 / P2 7） |
| 07 | 智能体编排 | `agent`、`subagent`、`goal`、`plan`、`mode`、`todo`、`waiting`、`commands*`、`skills`、`presets`、`prompt`、`self-improve`、`memory` | `07-agent-orchestration.md` | 已交付（P0 2 / P1 12 / P2 10） |
| 08 | 浏览器与桌面控制 | `browser`、`cdp`、`dock-browser`、`computer-use`、`desktop-dock` | `08-browser-desktop.md` | 已交付（P0 2 / P1 10 / P2 10） |
| 09 | 连接与外部工具 | `mcp`、`lsp`、`ops`、`web-search`、`remote`、`webserver`、`host-stdio`、`git`、`schedule` | `09-connectivity.md` | 已交付（P0 1 / P1 9 / P2 6） |
| 10 | TUI 与入口 | `packages/tui`、`src/boot.ts`、`src/headless.ts`、`src/cli` | `10-tui-entry.md` | 已交付（P0 0 / P1 9 / P2 10） |

## 汇总

- 跨批次汇总：`SUMMARY.md`（全部批次收齐后写）
- 架构优化方案：`ARCHITECTURE.md`（含分批改造顺序与验收口径）


