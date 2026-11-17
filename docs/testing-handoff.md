# 测试体系：交接说明（2026-11-16 定稿）

> 给接手这个任务的下一个人：目标、现场、验证面、还剩什么、哪些决定是刻意的，一次说清。
> 详细设计在 [testing-design.md](testing-design.md) / [testing-detailed-design.md](testing-detailed-design.md)；
> 决定在 [testing-deviations.md](testing-deviations.md)；欠账在 [testing-backlog.md](testing-backlog.md)；
> 源码问题在 [testing-findings.md](testing-findings.md)。

## 1 目标与当前位置

按 P0–P7 路线把 dsc 的测试体系补齐到对齐 codex 与 dsh 的水准。

| 期 | 状态 | 交付 |
| --- | --- | --- |
| **P0 地基** | ✅ | Vitest 4 + `js-to-ts` 解析插件 + 分层 project + CI 接线 |
| **P1a 设施** | ✅ | `tests/harness.ts`（tempHome / fakeLLM / replayLLM / bootKernel / runCli / readSessionJsonl / expectGolden）、内核 16 个模块 spec |
| **P1b 包级测试** | ✅ | 119 条包级 `.test.mjs` → `.spec.ts`（806 条用例），旧脚手架拆净 |
| **P2 内核探针** | ✅ | 122 → 7：能迁的迁进 unit/integration，剩下的 7 条是机制上迁不走的（§4） |
| **P3 ui 层** | ✅ | 九组代理迁移 + 四批渲染测试（R1/R2/R3a/R3b）+ 收尾对账；check-ui 80 → 42（全部是 jsdom 够不到的产物审计/源码闸/CSS） |
| **P4 快照层** | ✅ | TUI 帧 golden 30 份、浏览器 DOM 快照 11 份、**会话回放 1 场景已录制入库（B45 闭环，2026-11-17）**、覆盖率基线冻结 |
| **P5 live/bench/契约** | ✅ | live 冒烟 5 条（独立 workflow + 防假绿）、性能基准 4 条（基线 + PR 门）、契约测试 3 份 |
| **P6 CI/入口** | ✅ | integration 三片并行、Node 22/24 矩阵、真入口 e2e 8 条、flake 治理（K2+/K4）、聚合门（PR 门 `all-checks-passed` + 夜跑门 `all-nightly-passed`） |
| **P7 收尾** | ✅ | 属性测试 17 条、覆盖率基线门、Windows 车道、文档定稿；**2026-11-16 审计**补 B44–B53 与 [90% 计划](testing-coverage-plan.md) |

## 2 现场

```
工作树：D:\dsc\.worktrees\testing   （主仓 D:\dsc，别在那里改）
分支：  feat/testing-infra
主入口：pnpm test / pnpm run test:int / pnpm run test:snapshot / pnpm run test:cli
        pnpm run typecheck:spec / pnpm run check:style
```

**最终验收（2026-11-16，本机 Windows，Node 24.19）**

| 命令 | 结果 |
| --- | --- |
| `pnpm test`（unit + ui + tui） | **295 文件 / 3251 条 / exit 0**（2026-11-16 审计复跑） |
| `pnpm run test:int` | **114 文件 / 1883 通过 + 1 skip（ops 无 worker，B24）/ exit 0**（交接时记录，审计未重跑） |
| `pnpm run test:snapshot` | TUI 帧 30 + 浏览器 11 + 会话回放 1 场景（4 条，已录制入库）；夜跑设 `DSC_SNAPSHOT_STRICT=1`，缺录制即红 |
| `pnpm run test:cli` | 8 通过 + 1 显式 skip（C3 需要 PTY，B42/B50） |
| `pnpm run test:e2e` | **8 文件 / 161 通过 + 1 skip / exit 0**（2026-11-16 审计复跑；B40 的 6 红已归零） |
| `pnpm run typecheck:spec` | exit 0（2026-11-16 审计复跑，两份 tsconfig） |
| `pnpm run check:style` | exit 0（1500+ 文件） |
| `node scripts/check-core.mjs` | **7/7 通过**（Vitest 表达不了的探针，§4） |
| `node scripts/check-ui.mjs` | **42/42 通过** |
| `pnpm run test:bench` | 4 条 vs 本机基线，全部 ≤1.5×；runner 不符只记录（D35） |
| `pnpm run test:coverage` | **全五 project / 591 文件 / 8,156 过 + 5 skip / exit 0**：lines **92.09** / branches 81.85 / functions 89.70 / statements 89.68；`src/core` 92.43 / 81.56 / 93.34 / 89.26。基线已按此抬到 92.0 / 81.8 / 89.7 / 89.6（2026-11-17，见 [testing-coverage-plan.md](testing-coverage-plan.md) §1.8）；90% 目标已达成 |

## 3 这套东西长什么样

主配置 [vitest.config.ts](../vitest.config.ts) 五个常驻 project；两条独立配置各管一层：

| project | 收什么 | 环境 / 超时 | 备注 |
| --- | --- | --- | --- |
| `unit` | `src/**/*.spec.ts`、`tests/**/*.spec.ts` | node，5s，threads | 显式排 `*.int.spec.ts` / tui / ui / live / cli |
| `integration` | `**/*.int.spec.ts` | node + forks，60s，`maxWorkers: 4` | 先 `pnpm run build`（D25 混合平面） |
| `ui` | `src/packages/*/ui/**/*.spec.{ts,tsx}` | jsdom，10s | 真渲染 React 组件 |
| `tui` | `src/packages/tui/**/*.spec.{ts,tsx}` | node + 假终端，15s | ink 整屏帧（快照版工具 `tests/snapshots/tui/frame-kit.ts`） |
| `snapshot` | `tests/snapshots/**/*.snapshot.ts` | node + forks，60s | TUI golden 30 + 会话回放 + 浏览器 DOM 11 |
| `cli`（独立配置） | `tests/cli/**/*.cli.e2e.ts` | node，60s | spawn 真 `bin/dsc.js` |
| `live`（独立配置） | `tests/live/**/*.live.spec.ts` | node，180s | 无 key 整层跳过；`test-live.yml` 防假绿 |
| `bench`（独立入口） | `tests/bench/*.mjs` | plain node | 只认 `lib/**`，先 build |

**两个容易再犯的错**：

1. `*.spec.ts` 的星号跨点不跨目录：按后缀收文件的 project 必须显式排掉 `*.int.spec.ts`
   与邻居（unit / integration / tui 三处都写过，见四次的教训）。加新的按后缀收文件
   的 project 时先看这段。
2. 五个 project 可能被一次 `vitest run` 全跑（`test:coverage`）：`maxWorkers` 不同而
   `sequence.groupOrder` 相同的 project 会被 Vitest 直接拒绝——每个 project 都给了唯一
   groupOrder（unit 1 / integration 2 / ui 3 / snapshot 4 / tui 5）。

## 4 剩下的 7 条 Node 探针是什么性质（别误读成「没做完」）

`check-core` 现在跑的是 **Vitest 表达不了的探针**，不是迁移遗留：

| 探针 | 为什么只能裸 Node |
| --- | --- |
| `plugin-hot-update`、`plugin-library` | 验 Node 的 ESM 缓存戳（`?t=mtime` 换新实例）；Vitest 走 Vite 管线，不吃这个缓存戳 |
| `session-permissions` | 11 条源码文本断言，没有运行期接缝 |
| `injection-card-tip`、`settings-embed-slot` | 行为段已迁（ui spec）；残留是字典资源审计、源码身份钉与真终端探测 |
| `readme`、`release-notes` | 文档与发版脚本的闸，不是产品测试 |

`check-ui` 的 42 条同理：插件产物审计（`lib/ui/plugins/*/client.js`）、源码文本闸、
CSS 与几何——jsdom 不应用样式表、不布局，产物层 vitest 主配置明令不碰。

## 5 没做到 / 只验证到一半的，明说

1. **e2e 已全绿**：B40 修完（`779498b7`），全量 `8 文件 / 161 通过 + 1 skip / exit 0`。
   原 6 条已知红（`ui-anchor`×5、`ui-plugin-disable`×1）全部转绿，不再是已知态。
2. **快照层的会话回放已闭环**（B45，2026-11-17）：`tests/snapshots/session/basic-turn/`
   `session.jsonl` 已入库（2 行 / 496 字节，模型输出经人审），回放连跑两次各 4 passed；
   TUI 帧 30 与浏览器 11 是实跑的。夜跑设 `DSC_SNAPSHOT_STRICT=1`，缺录制即红。
    **已知红**：浏览器 DOM 快照里 01 / 02 / 04 / 05 / 07 / 09 / 10 七条 golden 与当前
    运行时的界面对不上（少一个「更改」页签：`dom.buttons` 35→30、`dom.elements` 315→262），
    TUI 30 条与会话回放 4 条全绿；`git diff HEAD -- ui-shell src lib` 为空、golden 未动，
    与本轮 13 个提交无关（属 HEAD 自带红）。需 golden 负责人判断「重录」还是「UI 真漏了页签」；CI 上是否同样红要等夜跑/手动触发的实证。
   `e2e`、`coverage`、`probe` 四个夜跑 job，并由 `all-nightly-passed` 汇总；PR 门上刻意
   不跑这四道（进了 needs 会因为 skipped 把每个 PR 判红）。
4. **live 层从未对真模型执行过**（K6）：开发机没有 `DSC_LIVE_API_KEY`，只验了
   「无 key 整层跳过（exit 0）」与类型检查。`test-live.yml` 的 key 预检 / 非零用例断言
   也没在 Actions 上跑过——首次夜间跑才算实证。
5. **CI 没有真跑过**：`verify.yml` 的全部 job（core / integration 三片 / bench / cli /
   windows / ui / desktop / probe，夜跑的 snapshot / e2e / coverage，以及两个聚合门
   `all-checks-passed` / `all-nightly-passed`）与 `test-live.yml` 只在本机按同一脚本验证过命令，
   GitHub 上没跑过一次。Windows 车道与 Ubuntu 的差异（路径、ConPTY、Electron）要等首跑。
6. **覆盖率 90% 已达成**（2026-11-17 实测 lines 92.09 / branches 81.85）：基线抬到
   92.0 / 81.8 / 89.7 / 89.6，逐目录门只升不降；剩余长尾债（`approval` 深层决策、
   `resolve-hook` 回调、`runner-entry.ts`）与理由见 [testing-coverage-plan.md](testing-coverage-plan.md) §1.8。
7. **F13 ConPTY Ctrl+C** 仍是 `test.skip`（B25）：当前环境 3/3 稳定红、老探针同红。
8. **浏览器快照 4 条残留**（B43）：模型页写操作、运行中队友、dock 原生页签、键盘路径。
9. **C3 无参数 + 一句输入**没有自动化（B42/B50）：需要 PTY；当前显式 `test.skip`。

## 6 源码层已修 / 还欠什么

**已修（本任务同批）**：

- **F10** `redact.ts` 补齐七类凭据（AWS/GitHub/`sk-`/`SK-`/裸 JWT…），属性测试反向验证；
- **F11** `web-search` 的 `authHeaders` 从未传给 `search()`（真 API 一律 401）——已传；
- **F15** `numa bogus` 被静默透传、TUI 照常起来——未知裸词现在 exit 1 + 可读提示；
- **F16** 非交互 stdin 结束后 TUI 永不退出（`echo hi | numa` 挂死）——非 TTY 在
  `end` 上收场。两条都有 CLI 用例做反向验证。

**还欠（要拍板）**：

- **F14** `DiffBlock` 可用行数算错（4 行 hunk 显示「… 还有 10 行」）——**已修**（`dabfe652`），
  新增 `DiffBlock.spec.ts` 6 条整屏帧断言，golden `12-approval-diff.txt` 同批重生成。

**还欠（要拍板 / 下一阶段）**：

- **B45**：已闭环（2026-11-17 录制入库，夜跑开严格模式）；后续可补 tool-call / compact 场景。
- **B54**：已修（覆盖率自检 + 夜跑并发分组）。
- **B46**：CI 接 e2e / snapshot / coverage 三个入口——**夜跑已接**（三个 job + `all-nightly-passed` 汇总，2026-11-17）；仍欠「首次真跑验证」与 PR 侧是否要纳入其中某一道。
- **B47**：覆盖率口径与阈值互斥，90% 计划见 [testing-coverage-plan.md](testing-coverage-plan.md)。
- **B37-R / B48**：R3b 迁移后 13 条探针的 CSS 与源码残留；CSS 转真 Chromium computed-style。
- **B31/B32 / B49**：界面 SDK 产物层与插件产物审计——建 `tests/built/*.built.e2e.ts`，对齐 DSH。
- **B50**：C3 用 Python `pty.fork()` 驱动补上（POSIX 跑、Windows 显式 skip）。
- **B13/B21**：桌面主进程（更新检查、dock 浏览器）要不要真主进程测试通道——本轮判定
  不做（D38）。

## 7 给下一个人立过的规矩（都踩过坑）

1. **禁止 `git commit --amend` 与 `git reset`**（D30）——多人共用一棵树时你无法确定
   HEAD 是谁的。补一行就新开提交；提交用 `git commit --only -m "…" -- <路径…>`，
   **`-m` 必须在 `--` 之前**（放后面会被当成路径），删除的文件也要列进路径表。
2. **integration 跑 lib 平面**（D25）：改 `src` 必须 `pnpm run build`；`bootKernel` 有
   新鲜度守卫，但不 build 时它拦得晚。
3. **反向验证**：改产品 → 红 → 还原 → 绿。第一次绿不要当结论（Vite 缓存），复跑一次。
4. 别读 src 侧模块级缓存（`activeConfigFile`、`allSpecs` 各两份），读服务事实
   （`ctx.settings.prefs()`、`ctx.commands.specs()`）。
5. 要验「连不上」用 `fakeLLM({ status: 401 })`；真连不上会走超时重试，2 秒变 17 秒。
6. 读 git 工作区状态的用例用 `tempRepo()`，否则会把别人未提交的改动记进 `turnDiff`。
7. 不要固定 `sleep`，轮询到条件成立。
8. 共享 `git index` 的并行代理要各自 `--only` 提交；`index.lock` 0 字节且无 git 进程
   才是陈锁（K-系列），先查再删。
9. 局部重试：`describe.configure({ retry })` 在 Vitest 4.1.12 里**不是函数**
   （`test.describe.configure` 与 `describe.configure` 都 TypeError）；要局部重试只能
   换层或改 project 配置。
10. 基准测的是构建产物：`pnpm run build` 之后才 `test:bench`；runner 不符只记录不判退化
    （D35），要恢复数值闸就按同格式提交本机基线。

`tests/harness.ts` 文件头有完整的「踩过的坑」八条，写新 spec 前先看那份。

## 8 交接检查清单

```sh
git status --porcelain          # 应为空
git log --oneline -10           # 本阶段的提交（P3–P7 + 2026-11-16 审计修复）
pnpm test                       # 295 文件 / 3251 条
pnpm run test:int               # 先 build；integration 全量（114 / 1883 + 1 skip）
pnpm run test:snapshot          # TUI 30 + 浏览器 11 + 会话回放 4 条（已录制入库）；夜跑设 DSC_SNAPSHOT_STRICT=1，缺录制即红
pnpm run test:cli               # 8 + 1 skip
pnpm run test:e2e               # 8 文件 / 161 通过 + 1 skip
pnpm run typecheck:spec && pnpm run check:style
node scripts/check-core.mjs     # 7/7
node scripts/check-ui.mjs       # 42/42
```

**覆盖率**：`pnpm run test:coverage` 跑全五 project，当前 lines 92.09 / branches 81.85
（基线 92.0 / 81.8 / 89.7 / 89.6，阈值再减 0.5）；抬基线要改 `coverage-baseline.json`
并 review，只升不降。别拿单批数字当整体结论，口径见 [testing-coverage-plan.md](testing-coverage-plan.md)。
