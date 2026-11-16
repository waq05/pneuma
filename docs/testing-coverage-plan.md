# 覆盖率 90% 计划（2026-11-16 审计后）

> 用户目标：**整体行覆盖率 ≥ 90%**，不再往后拖。
> 这份文件只回答三件事：现在差多少、按什么口径算、分几批补。
> 现有体系见 [testing-handoff.md](testing-handoff.md)；欠账见 [testing-backlog.md](testing-backlog.md)。

## 1 现在差多少（实测，不是估算）

命令（三面口径，本次审计实跑）：

```sh
pnpm exec vitest run --coverage --project unit --project ui --project snapshot \
  --hookTimeout=20000 --testTimeout=20000
```

结果：`coverage/coverage-summary.json`

| 指标 | 数值 |
| --- | --- |
| 报告内可执行行 | **46,627** |
| 已覆盖行 | **15,772** |
| 行覆盖率 | **33.8%** |
| 到 90% 还需新覆盖 | **+26,192 行**（允许剩余 4,663 行未覆盖） |
| 0% 文件 | 93 个 / 5,766 行 |

按目录（未覆盖行降序；完整表在 `coverage/coverage-summary.json`）：

| 区域 | 行数 | 已覆盖 | 未覆盖 |
| --- | ---: | ---: | ---: |
| `src/core` | 9,364 | 34.2% | 6,161 |
| `sandbox` | 2,426 | 14.6% | 2,071 |
| `superagent` | 3,399 | 55.5% | 1,512 |
| `ui-composer` | 1,380 | 15.4% | 1,167 |
| `lsp` | 1,014 | 9.2% | 921 |
| `ui-primitives` | 1,670 | 48.3% | 864 |
| `self-improve` | 1,124 | 31.6% | 769 |
| `ui-transcript` | 2,895 | 75.1% | 720 |
| `remote` | 695 | 1.7% | 683 |
| `tools-default` | 847 | 25.1% | 634 |
| `cdp` / `ui-status` | 744 / 679 | 16.9% / 9.0% | 618 / 618 |
| `session-core` | 853 | 33.5% | 567 |
| `ops` | 549 | 3.1% | 532 |
| `ui-settings` | 1,127 | 53.5% | 524 |
| `browser` / `ui-core` / `hooks` | 557 / 581 / 523 | 11.1% / 16.9% / 9.2% | 495 / 483 / 475 |
| `ui-boot` | 474 | 0% | 474 |

单文件最大的十个缺口：`ui-status/ui/ui.tsx`（0%，618）、`core/plugin-loader.ts`（1.9%，608）、
`core/ui-bundles.ts`（7.5%，577）、`remote/index.ts`（1.7%，514）、`browser/index.ts`（11.1%，495）、
`subagent/index.ts`（16.2%，439）、`approval/index.ts`（18.9%，416）、`self-improve/index.ts`（20.8%，414）、
`sandbox/win/runner-entry.ts`（0%，400，子进程入口）、`core/plugin-watch.ts`（0%，393）。

## 2 先定口径：现在的口径与阈值互斥

本次审计实跑三面口径后，`src/core/**` 四项全红：

```
lines 34.2% < 40.68%   branches 28.43% < 34.56%
functions 33.81% < 42.42%   statements 32.59% < 39.02%
```

`coverage-baseline.json` 里 `src/core` 记的是 41.18% lines，且注释写「口径：unit + ui + snapshot」——
但三面跑只有 34.2%。41.18% 只能来自 integration/tui 也参与的那次跑法（integration 大量经过 core，
且不把 lib 算进分母）。**同一个文件同时写了两套口径的数值**，这是 D39 之外的新问题。

结论（建议，待拍板）：

1. **覆盖率门用「全部五个 project」的专用跑法**，而不是三面。integration 与 tui 是 core 覆盖的
   主要来源，把它们排除在外，core 的 90% 几乎只能靠重复单测堆出来。专用跑法要沿用
   `maxWorkers: 4` / `retry: 1` 的稳定性设置，并像 DSH 的 `coverage-partitions` 一样限制并发。
2. `coverage-baseline.json` 的数值与注释按新口径**一次性重录**，不再混用。
3. 90% 的判据先定成 **lines ≥ 90**；branches / functions / statements 各自抬到 80% 以上并只升不降。
   逐目录门（`src/core/**` 等）每批抬一次，防止大文件补贴小文件。

## 3 六批推进（每批约 +10 个全局百分点）

每一批的退出条件相同：新增覆盖 ≥ 4,700 行、全局 lines 至少 +8 个点、该批涉及的目录门已抬、
新增 spec 都做过反向验证（改产品 → 红 → 还原 → 绿）。

| 批 | 主攻 | 预计新覆盖 | 落点 |
| --- | --- | ---: | --- |
| **W1 core 根模块** | `plugin-loader`、`plugin-watch`、`ui-bundles`、`schedule/*`、`session`、`config-core` | ~4,800 | unit + integration（loader/装配走真 `lib` 平面） |
| **W2 进程与外部面** | `sandbox`（含 `win/runner-entry` 子进程）、`lsp`、`cdp`、`hooks`、`remote` | ~4,900 | integration + 子进程；`runner-entry` 用 built/子进程层 |
| **W3 前端高频面** | `ui-composer`、`ui-status`、`ui-boot`、`ui-core`、`ui-plugins`、`ui-prompt`、`ui-skills`、`ui-files`、`ui-superagent` | ~4,800 | ui（jsdom + RTL），0% 文件优先 |
| **W4 工具与宿主** | `ui-primitives`、`self-improve`、`tools-default`、`session-core`、`ops`、`browser`、`subagent` | ~4,900 | unit + integration + ui |
| **W5 长尾 UI 与会话** | `ui-transcript`、`ui-settings`、`ui-sessions`、`approval`、`computer-use`、`desktop-dock`、`ui-dockkit`、`ui-trace`、`ui-layout`、`session-search` | ~4,800 | ui + integration |
| **W6 剩余与排除台账** | `superagent`、`mcp`、`memory`、`goal`、`schedule`、`checkpoint`、零散包；剩余确属不可测的写排除理由 | ~4,700 | 混合；达不到 90% 时只允许「带理由的排除」补差 |

**W6 之后的硬判据**：`coverage-summary.json` 的 total lines ≥ 90.0，且没有新的 0% 文件（除排除台账里的）。

## 4 不允许的做法（防止把 90% 变成数字游戏）

1. 不写「调用一次、不断言」的凑数测试。每条至少钉一个可证伪的行为（返回值、落盘、请求体、DOM、退出码）。
2. 不靠 `/* v8 ignore */` 刷数。确要排除（平台专属、子进程入口、生成物）必须在
   `docs/testing-coverage-exclusions.md` 写「文件 + 理由 + 替代验证」，并像 DSH 一样**每条 ignore 带理由**。
3. 不把 integration/tui 的覆盖算进「三面」再报一个更好看的数。口径只有一套，写进 `coverage-baseline.json` 的 note。
4. 每批结束先跑 `pnpm test`（unit/ui/tui）与对应层的定向用例，再跑覆盖率；
   覆盖率红了先修测试，不许先降门槛。

## 5 与剩余非覆盖率任务的关系

顺序按「先把除覆盖率以外的任务做完」：

1. 本轮审计已修：B40（e2e 6 红归零）、`collapse-prefs` 全量钩子超时。
2. 待做（非覆盖率）：CI 接 e2e / snapshot / coverage；会话回放录制；C3 PTY；B31/B32 产物层；
   B37-R CSS→真 Chromium；文档漂移订正。见 [testing-backlog.md](testing-backlog.md) 第五节。
3. 以上闭环后启动 W1；每批单独提交、单独抬基线。
