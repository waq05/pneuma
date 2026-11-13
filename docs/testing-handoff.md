# 测试体系：交接说明（2026-11-14）

> 这份是给**接手这个任务的下一个人**看的。目标、现场、还剩什么、怎么继续，一次说清。
> 详细设计在 [testing-design.md](testing-design.md) 与 [testing-detailed-design.md](testing-detailed-design.md)；
> 决定在 [testing-deviations.md](testing-deviations.md)；欠账在 [testing-backlog.md](testing-backlog.md)。

## 1 目标与当前位置

原目标：按 P0–P7 路线把 dsc 的测试体系补齐到对齐 codex 与 dsh 的水准。

| 期 | 状态 | 说明 |
| --- | --- | --- |
| **P0 地基** | ✅ 完成 | Vitest 4 + 解析插件 + 四个分层 project + 三条 POC + CI 接线 |
| **P1a 设施** | ✅ 完成 | `tests/harness.ts`（8 个 API）、内核 16 个模块的 spec |
| **P1b 包级测试** | ✅ 完成 | 119 条 `.test.mjs` → `.spec.ts`，806 条用例；旧脚手架已拆 |
| **P2 内核探针** | ⏳ 收尾中 | 122 → 20：3 条还要迁、7 条永远留 Node 侧、8 条归 P3、2 条归 P7（见 §4） |
| P3 ui 层 | 未开始 | 80 条 `ui-*` 探针 + 8 条从 P2 转来的缺口 |
| P4 快照层 | 未开始 | 录制回放 + golden |
| P5 真模型/性能 | 未开始 | 需要 key 的 e2e、bench |
| P6 CI 工程化 | 未开始 | 分片、矩阵、flake 治理 |
| P7 收尾 | 未开始 | 文档定稿、缺口清单收口 |

## 2 现场

```
工作树：D:\dsc\.worktrees\testing   （主仓 D:\dsc，别在那里改）
分支：  feat/testing-infra          基于 78f0912c
主入口：pnpm test / pnpm run test:int / pnpm run typecheck:spec / pnpm run check:style
```

**验证面（2026-11-14 实测）**

| 命令 | 结果 |
| --- | --- |
| `pnpm test`（unit + ui + tui） | **186 文件 / 2018 条 / exit 0** |
| `pnpm run test:int` | 78 文件 / 约 1190 条，**3 文件红**——全是并行负载超时（那 3 个单独跑 31 条全绿，见 K4）。这不是断言问题，但交接时它是红的 |
| `pnpm run typecheck:spec` | exit 0 |
| `pnpm run check:style` | exit 0 |
| `node scripts/check-core.mjs --list` | **20 条**探针（旧体系，见 §4） |

## 3 这套东西长什么样

四个常驻 project + 一个 tui project，全在 [vitest.config.ts](../vitest.config.ts)：

| project | 收什么 | 环境 |
| --- | --- | --- |
| `unit` | `src/**/*.spec.ts`、`tests/**/*.spec.ts` | node，5s |
| `integration` | `**/*.int.spec.ts` | node + forks，60s，先 `pnpm build` |
| `ui` | `src/packages/*/ui/**/*.spec.{ts,tsx}` | jsdom，10s |
| `tui` | `src/packages/tui/**/*.spec.{ts,tsx}` | node + 假终端，15s |
| `snapshot` | `tests/snapshots/**/*.snapshot.ts` | 还没建 |

**每条 exclude 里那一行 `*.int.spec.ts` 不是装饰**：`*.spec.ts` 的星号跨点不跨目录，
漏了就会双跑或串层。这个错犯了四次（unit 收 int、tests 收 int、tui 收 int、unit 收 tui），
根因都一样：**按后缀收文件的 project 必须显式排掉邻居**。

## 4 那 20 条探针是什么性质（别误读成「没做完」）

合计 20 条，四类加起来正好是 20：

| 类别 | 条数 | 明细 |
| --- | --- | --- |
| **还要迁** | 3 | `hmr-dispose`、`ops`、`remote-host`——R1 做到一半没完成，探针原样还在 |
| **永远留 Node 侧** | 7 | `plugin-hot-update`、`plugin-library`、`session-permissions`、`settings`、`settings-embed-slot`、`session-picker-mouse`、`session-title-live`。理由见 D26/D28——**迁了会变成假绿** |
| **归 P3（ui/tui 层）** | 8 | `injection-card-tip` + 7 条 `tui-*` |
| **归 P7（文档闸）** | 2 | `readme`、`release-notes` |

`check-core.mjs` 的文件头已经写明它**不再是主测试入口**，而是跑那些 Vitest 表达不了的
探针的通道。别看到还剩 20 条就以为没迁完——先查 [testing-backlog.md](testing-backlog.md)。

## 5 下一步怎么接

### 立刻要做的三件

1. **P2 尾巴**：迁 `hmr-dispose`、`ops`、`remote-host` 三条。
   注意 R1 试过 `hmr-dispose` 但没做成（草稿已删，失败原因未记录）；
   `ops` 需要「真 HOME 里装了 worker」，要么自造最小 worker，要么明确 skip 并记缺口——
   **不许静默绿**（`permission-core` 的旧测试就是这么骗了半年）。
2. **补 B18/B19**：沙箱那两条现在可补（D16 已订正，开沙箱能正常跑，6.7s）。
3. **修 K4**：integration 全量并行超时。建议 `poolOptions.forks.maxForks` 限 3–4。

### 然后按 P3 → P7 推

P3 的清单在 [testing-design.md](testing-design.md) 的 §11，缺口承接在
[testing-backlog.md](testing-backlog.md) 的 B 表（B1–B23）。P3 要接的三类：
纯派生（unit）/ 组件渲染（ui project）/ 整屏帧与鼠标序列（tui project）。

## 6 给下一个人立过的规矩（都踩过坑，别重犯）

1. **禁止 `git commit --amend` 与 `git reset`**（D30）。多人共用一棵树时 `amend` 改的是
   「HEAD 那个」，你无法确定是谁的提交。实测出过一次事故。补一行就新开提交。
2. 提交用 `git add` + `git commit --only -- <路径>`；`--only` 对未跟踪文件不生效。
3. **integration 跑的是 lib 平面**（D25）：改了 `src` 必须 `pnpm run build`，否则内核跑旧
   产物、用例假绿。`bootKernel` 有新鲜度守卫会拦，但不 build 时它拦得晚。
4. 反向验证：改 src → build → 必须红 → 还原 → build → 必须绿。**第一次绿不要当结论**
   （Vite 缓存），复跑一次。
5. 别读 src 侧的模块级缓存（`activeConfigFile`、`allSpecs` 各两份），读
   `ctx.settings.prefs()` / `ctx.commands.specs()` 这类服务事实。
6. 要验「连不上」用 `fakeLLM({ status: 401 })`，真连不上会走超时重试，2 秒变 17 秒。
7. 读 git 工作区状态的用例用 `tempRepo()`，否则会把别人未提交的改动记进 `turnDiff`。
8. 不要用固定 `sleep`，轮询到条件成立。

`tests/harness.ts` 的文件头有完整的「踩过的坑」八条，写新 spec 前先看那个。

## 7 源码层待修的问题（不在测试体系范围内，但很重要）

[testing-findings.md](testing-findings.md) 记了 12 条，其中两条建议**尽快修**：

- **F10** `redact.ts` 漏抹四类真实凭证（AWS `AKIA…`、GitHub `ghp_…`、大写 `SK-`、裸 JWT）。
  这不是显示问题，是把密钥发给模型提供方。
- **F11** `web-search` 算出带 key 的请求头但从没传出去（`index.ts:222` 算了 `headers`，
  230/231 行调 `search()` 时没传），真 API 一律 401，联网搜索一次都没成功过。

其余是行为与注释不符（`oneLine` 劈开 emoji、`diff-text` hunk 行号错位、`unified-diff`
CRLF 取错路径等），可以排期。

## 8 没做完 / 没验证的，明说

- `test:int` 全量仍红 3 个文件（K4 负载问题），不是断言问题，但**交接时它是红的**。
- P3–P7 完全没开始。
- 覆盖率一个字没配（设计里的 P3 第 3 项）。
- CI 没跑过：`verify.yml` 改过（加了 `pnpm test` / `test:int` / `typecheck:spec`，
  删了 plugin job），但这些改动**只在本机验证过命令，没在 GitHub 上跑过一次**。
- `docs/` 里还有几处提到已删的探针脚本名（`README.md:239`、`docs/development.md:651` 等），
  属历史记录，留给 P7 统一清理。
