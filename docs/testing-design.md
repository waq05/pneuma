# dsc 测试体系概要设计（对齐 DSH / codex 路线）

> 给谁看：要补测试、要改测试门禁、要判断「这个改动验到什么程度算够」的人（包括下次坐到位子上的 AI 助手）。
> 状态：**设计定稿，尚未实施**。本文只写设计与工期，不含实现代码。
> 版本：v2（v1 只补基础；v2 按「对齐 codex 与 DSH 测试体系」扩到 8 层 + 工程化治理）。
> 依据：2026-11-13 对 dsc、DSH（deepseek-harness）、codex 三个仓库测试体系的实际调查，数字均取自当天仓库现场。

| 想知道 | 去看 |
| --- | --- |
| 测试是什么、怎么写一条好测试、什么算验收合格 | [testing-101.md](testing-101.md) |
| 配置写什么值、解析插件怎么实现、夹具 API 什么样 | [testing-detailed-design.md](testing-detailed-design.md) |
| 现有测试怎么跑、探针怎么写 | [development.md](development.md) 第 5 节「验证面」 |
| **测试体系该长成什么样、分几期、多少工** | **本文档** |
| 每一层对齐了谁的什么能力 | 第 2 节「对齐基线」 |
| 为什么这么设计 | 第 1 节、第 2 节 |
| 做完之后仍然缺什么 | 第 14 节「已知边界」 |

---

## 0 一句话

v1 用 Vitest 补上「细粒度单测 + 覆盖率 + PR 门禁」三项基础设施；v2 再补四层能力（录制回放、性能基准、真模型 e2e、真入口 e2e）与四类工程化治理（flake、分片、多版本、契约），目标是在**能力维度**对齐 DSH 与 codex，而不是在**用例总量**上追平。

---

## 1 现状：我们有什么、缺什么

### 1.1 存量数字（2026-11-13 实测）

| 项 | 数值 | 取证 |
| --- | --- | --- |
| 探针总数 | 201 条 `scripts/*-test.mjs` + 33 条 `*-check.mjs` + 11 条 `*-e2e.mjs` | `scripts/` 目录计数 |
| 探针代码量 | ≈ 47,064 行 | `Get-ChildItem scripts -Filter *test*.mjs \| Measure-Object -Line` |
| 源码量 | `src/` ≈ 167,594 行 | 同口径 |
| 断言总数 | ≈ 8,719 处自造 `check()` | 全 `scripts/**/*.mjs` 计数 |
| 引用编译产物 | 127 条探针 import `../lib/` | 全文匹配 `../lib/` |
| 起真内核 | 46 条调 `createKernel` | 全文匹配 |
| 起假 HTTP 服务 | 24 条 | 全文匹配 `createServer` |
| 界面侧探针 | 79 条 `ui-*` | 文件名前缀 |
| **包级测试** | **119 条 `src/packages/<id>/tests/*.test.mjs`，12,170 行，91 个插件包全覆盖** | 递归计数 |
| **包级测试跑法** | `node scripts/package-tests.mjs`，挂在 `check:plugin` 里 | package.json 第 39 行 |
| **包级测试进 CI** | **否**——verify.yml 里搜 `check:plugin` / `check:all` / `check:dsh` / `check:remote` 零命中 | 全文匹配 |
| 标准测试框架 | **0 个**（无 vitest / jest / node:test） | 7 个 `package.json` 全扫，零命中 |
| 覆盖率工具 | **0 个**（无 c8 / nyc / istanbul / v8） | 同上 |
| 真模型 API 测试 | **0 条**（`dsh-compat-live-check.mjs` 抬头写明「离线」） | 全文匹配 API_KEY 为零 |
| spawn 真 CLI 入口的测试 | **0 条**（`bin/dsc.js` 从未被测试启动） | 全文匹配 `bin/dsc.js` 为零 |
| 性能脚本 | 3 个零散脚本，不进门禁（`throughput-test.mjs` 260 行、`_perf-stream.mjs` 271 行、`load-bench.mjs` 70 行） | 文件名匹配 |
| PR 门禁内容 | 仅 typecheck×3 + 排版 | [verify.yml](../.github/workflows/verify.yml) 第 50-53 行 |
| 探针进 CI 的时机 | 夜跑 02:00 + 手动 | 同上第 96-99 行 |

### 1.2 三家对比（只列影响设计的）

| 维度 | dsc | DSH | codex |
| --- | --- | --- | --- |
| Runner | 无（裸脚本） | Vitest 4 | cargo-nextest |
| 用例规模 | 201 文件 / 8,719 断言 + **119 条包级测试** | 3,120 文件 / ≈3.7 万用例 | ≈22,800 测试函数 |
| 包级/单元测试 | **119 条，但只在本地跑，CI 不跑** | 2,721 个 spec，PR 必跑 | 1,615 个内联 `mod tests` |
| 覆盖率 | 无 | per-file 100% 硬门禁 | 无 |
| PR 门禁 | 只验编译 | 5 job 阻断 + 聚合 check | Bazel 子集 |
| 全量测试 | 夜跑 | PR（分区跑） | merge 后 5 平台 × 4 分片 |
| 快照 | 无 | 1,973 份录制会话 | 1,764 个 insta |
| 性能基准 | 无 | `.bench.ts` 进 PR | divan（仅一处，弱） |
| 真 API e2e | 无 | 独立 workflow + key 预检 | `#[ignore]` 门控 + 真 OpenAI API |
| 真入口 e2e | 无（起内核但同进程） | 真 Loader 子进程 | spawn 真 `codex exec` |
| 契约测试 | 源码文本断言（伪） | `contract-regressions.spec.ts` | 无明确对应 |
| 平台矩阵 | 仅本地 Windows + ubuntu | Linux/Win/mac/Wine + Node 24/26 | 5 平台 × 4 分片 |
| flake 治理 | 仅「串行 + 5 分钟超时」 | 分区覆盖 + fork 诊断 + 耗时历史 | retries + slow-timeout + JUnit + 串行组 |

---

## 2 对齐基线（本文的核心）

### 2.1 对齐等级定义

| 等级 | 含义 | 判定 |
| --- | --- | --- |
| **L1 等效** | 能力存在，质量与来源相当 | 能拦住同一类回归 |
| **L2 弱一档** | 能力存在，规模或严格度明显低于来源 | 能拦，但漏得多 |
| **L3 缺失** | 该能力完全没有 | 拦不住 |
| **— 不采纳** | 看过，判断不该学 | 写明理由 |

### 2.2 逐项对齐表

| # | 能力 | 来源与证据 | dsc 现状 | 目标 | 采纳 | 期 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 标准 runner + 分层 project | DSH vitest.config.ts:137-142,212-254 | L3 | L1 | 是 | P0 |
| 2 | 测试与代码同址 | DSH `packages/*/*/tests/`；codex 内联 `mod tests` | **L2**（包级测试已同址；内核无） | L1 | 是 | P0 |
| 3 | 细粒度单测层（内核） | DSH spec 2,721 个 | **L3**（`src/core` 无对应层） | **L2** | 是 | **P1a** |
| 4 | 细粒度单测层（插件包） | DSH spec 2,721 个 | **L2**（119 条包级测试，但用裸脚本、不在 CI） | **L1** | 是 | **P1b** |
| 5 | **包级测试进 CI** | 两家都在 PR 跑 | **L3**（`check:plugin` 在所有 workflow 里零引用） | **L1** | 是 | **P1a** |
| 6 | 集成测试（真内核 + 假模型） | codex `core/tests/suite` | L2（探针就是） | L1 | 是 | P2 |
| 7 | 共享测试设施（harness） | DSH `packages/test-support/*`（8 包）；codex `core/tests/common` | L3（24 处重复） | L1 | 是 | P1a |
| 8 | 覆盖率度量 | DSH v8 | L3 | L1 | 是 | P3 |
| 9 | 覆盖率硬门槛 | DSH per-file 100%（vitest.config.ts:423-431） | L3 | **不设 100%** | 部分 | P3 |
| 10 | **录制会话回放** | DSH snapshots 1,973 份；codex insta 1,764 个 | L3 | **L2** | 是 | **P4** |
| 11 | **TUI 帧快照** | codex tui 1,514 个 `.snap` | L3 | **L2** | 是 | **P4** |
| 12 | **浏览器快照** | DSH web 400 份（真 Chromium） | L3 | L2 | 是 | P3/P4 |
| 13 | **性能基准门禁** | DSH `.bench.ts` 进 PR | L3 | **L2** | 是 | **P5** |
| 14 | **真模型 API e2e** | DSH with-key policy + key 预检防假绿（e2e.yml:92-104） | **L3** | **L1** | 是 | **P5** |
| 15 | **真入口 e2e（spawn CLI）** | codex `exec/tests/suite` spawn 真 `codex exec` | **L3** | **L2** | 是 | **P6** |
| 16 | **契约测试** | DSH `contract-regressions.spec.ts` | L3（文本断言冒充） | L1 | 是 | **P5** |
| 17 | **flake 治理** | codex retries/slow-timeout/JUnit/串行组；DSH 分区+诊断 | L3 | **L1** | 是 | **P6** |
| 18 | **测试分片并行** | codex 5×4 分片；DSH 覆盖分区 | L3 | L2 | 是 | **P6** |
| 19 | Node 版本矩阵 | DSH Node 24.9/26（ci.yml:484-495） | L3 | L1 | 是 | **P6** |
| 20 | 单一聚合 check 做分支保护 | DSH ci.yml:558-584 | L3 | L1 | 是 | P6 |
| 21 | 属性测试 | 三家都没有 | L3 | L2 | 是（小幅） | P7 |
| 22 | 平台矩阵（Linux/macOS/Windows 三向） | codex 5 平台 | L2（单向） | L2 | 部分 | P7 |
| 23 | Bazel / 双构建 | codex 有 | — | — | **否** | — |
| 24 | clippy / cargo-shear 级静态门 | codex | — | — | **否**（语言差异） | — |
| 25 | 100% 覆盖率硬门槛 | DSH | — | — | **否**（见 §9.2） | — |

**结论**：25 项里 22 项采纳，3 项不采纳。做完后，**核心能力全部达到 L1 或 L2**，没有一项留在 L3。

**一条重要修正**：第 4、5 两项是 v1 设计漏掉的。仓库早就有 119 条包级测试（`src/packages/<id>/tests/*.test.mjs`，12,170 行，91 个包全覆盖），定位就是「本包自己的契约」（[package-tests.mjs](../scripts/package-tests.mjs) 第 16-20 行）。所以 dsc 不是「没有单测」，而是「插件包有单测但不在 CI、内核没有单测」。这让 P1 的性质从「从零建」变成「迁移 + 补齐」。

---

## 3 目标与不变量

**目标（可验）**：
1. `pnpm test` 秒级完成，进 PR 门禁。
2. 覆盖率有报告、有只降不升基线。
3. 有一层「不碰网络、不碰真模型也能回放全会话」的测试（第 8 层）。
4. 有 4 条性能门禁，退化即红。
5. 有 5 条真模型冒烟，无 key 自跳过、有 key 必须跑。
6. 有 8 条真 CLI 入口 e2e。
7. 有 3 份真契约测试，替换现有的源码文本断言。

**不变量**（违反任何一条，设计作废）：

1. **单实例约束**：`lib/node_modules/@pneuma/runtime` 桩包保证插件与内核共享同一份模块实例（[build-runtime-package.mjs](../scripts/build-runtime-package.mjs) 第 6-7 行：「两份副本 = 沙箱 fail-open」）。Vitest 只跑 **src 平面**，存量探针只跑 **lib 平面**，两者绝不交叉。
2. **构建产物不受污染**：`.spec.ts` 不得出现在 `lib/` 与 npm 包里。
3. **存量不倒退**：任何一期结束时，`check-core` 与 `check-ui` 的通过条数不得减少（迁走的除外，且迁移即删）。
4. **临时 HOME**：任何会在用户目录写文件的测试，必须走临时 HOME。
5. **无 key 不红**：所有真 API 测试在无 key 时必须自跳过，不得让无密钥的贡献者卡住。

---

## 4 分层设计（八层）

| # | project | 后缀 | 位置 | 环境 | 目标耗时 | 门禁 | 对齐 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `unit` | `*.spec.ts` | `src/**` | node | 秒级 | **PR** | DSH |
| 2 | `integration` | `*.int.spec.ts` | `src/**` | node + 临时 HOME + 假 SSE | 分钟级 | 核心目录进 PR，其余夜跑 | codex core suite |
| 3 | `ui` | `*.spec.tsx` | `src/packages/*/ui/**` | jsdom | 秒级 | **PR** | DSH jsdom |
| 4 | `e2e` | `*.e2e.ts` | `src/**` | 真 Chromium | 分钟级 | 夜跑 | DSH web lane |
| 5 | **`snapshot`** | `*.snapshot.ts` | `tests/snapshots/**` | node，回放录制 jsonl | 分钟级 | **PR（关键的 20 份）** | DSH snapshots / codex insta |
| 6 | **`bench`** | `*.bench.ts` | `tests/bench/**` | node，plain（不用 tsx） | 分钟级 | **PR** | DSH `.bench.ts` |
| 7 | **`live`** | `*.live.e2e.ts` | `tests/live/**` | node + 真 API key | 分钟级 | 独立 workflow，nightly | DSH with-key |
| 8 | **`cli`** | `*.cli.e2e.ts` | `tests/cli/**` | spawn 真 `bin/dsc.js` | 分钟级 | 夜跑 | codex exec/tests |
| — | `legacy` | `*-test.mjs` | `scripts/` | spawn 子进程 | 8 分钟 | 过渡期夜跑 | — |

**分层判据是「运行环境 × 耗时 × 是否需要外部资源」，不是「重要程度」**。这条与现有 [check-ui.mjs](../scripts/check-ui.mjs) 第 13 行同源：跑不动的东西不能卡人。

### 4.1 第 5 层：录制会话回放（snapshot）

**为什么必须有**：它是 DSH 与 codex 共有的核心资产，dsc 完全没有。作用是「录一次真会话，之后不碰网络回放」，让改一行代码也能验证全链路，同时不烧 API 额度。

**dsc 的天然优势**：会话本来就是 jsonl 事件流（`ctx.session.current().filePath`），录制格式已经存在，不需要新造。

设计：

```
tests/snapshots/session/
  ├── basic-turn/
  │   ├── scenario.snapshot.ts     ← 场景驱动：bootstrap → 喂输入 → 断言
  │   ├── session.jsonl            ← 录制下来的模型输出（回放源）
  │   └── expected.json            ← 期望的持久化终态
  ├── tool-call/
  └── compact/
```

回放器复用现有假 SSE 的骨架，但数据来源从「脚本」换成「录制文件」：按请求顺序吐出录制的 SSE chunk。

**录制命令**：`pnpm test:snapshot:record`（要 key），产物进版本库；回放时 `DSC_SNAPSHOT=replay`，CI 强制只读。

### 4.2 第 6 层：性能基准

现状是 3 个零散脚本（`throughput-test.mjs`、`_perf-stream.mjs`、`load-bench.mjs`），不进门禁、没有基线。

设计 4 条关键路径基准，全部跑在 plain node（不用 tsx，避免转译开销污染测量）：

| # | 基准 | 量什么 | 退化判据 |
| --- | --- | --- | --- |
| B1 | 会话启动 | `createKernel` → 首帧快照 | > 基线 1.5× |
| B2 | 首 token 延迟 | 请求发出 → 首个 SSE chunk 落地 | > 基线 1.5× |
| B3 | 压缩耗时 | 100 轮历史 → compact 完成 | > 基线 1.5× |
| B4 | 流式渲染 | 1,000 chunk → 帧合并次数 | > 基线 1.3× |

基线存 `tests/bench/baseline.json`，随代码更新手动刷新并 review。

### 4.3 第 7 层：真模型 API

**这是 v1 设计最大的漏洞**：dsc 现在 46 条端到端探针全用假 SSE，等于「自己造的假模型验证自己的客户端」。LLM 适配层（SSE 解析、tool_call 格式、thinking 档位、token 计数）从没被真模型碰过。

设计 5 条冒烟（对齐 DSH 的 with-key policy 与 [docs/testing.md:23-25](../../deepseek-harness/deepseek-harness/docs/testing.md)）：

| # | 冒烟 | 验什么 |
| --- | --- | --- |
| L1 | 单轮问答 | 能拿到回复、用量计数非零 |
| L2 | 工具调用 | 模型真的调了工具、结果回灌后能续 |
| L3 | 多轮上下文 | 第二轮能引用第一轮内容 |
| L4 | 流式中断 | 中途取消不产生孤儿 tool_call |
| L5 | 压缩后继续 | 压缩触发的会话还能正常对话 |

**防假绿**：CI 里 key 存在但 L1 被跳过 = 红灯。这条学 DSH 的 key 预检（e2e.yml:92-104）。无 key 时整层跳过，不算失败。

### 4.4 第 8 层：真入口 e2e

现在所有测试都「起内核但同进程」，`bin/dsc.js` 这个真入口从没被启动过。codex 的 `exec/tests/suite` 是 spawn 真二进制，这是它最有价值的一层——它能抓到同进程测试永远抓不到的错（模块解析、启动顺序、stdout 协议、退出码）。

8 条，全部 spawn 真 `node bin/dsc.js`：

| # | 场景 | 断言 |
| --- | --- | --- |
| C1 | `--help` | 退出码 0，输出含用法 |
| C2 | `--version` | 退出码 0，版本号与 package.json 一致 |
| C3 | 无参数启动 + 一句话 | 真模型回复（依赖 `live` 层的 key，无 key 自跳过） |
| C4 | 未知子命令 | 退出码非 0，错误信息可读 |
| C5 | 配置文件损坏 | 退出码非 0，不崩溃、不静默 |
| C6 | 无 TTY 管道输入 | 正确退化，不卡死 |
| C7 | SIGINT | 干净退出，会话文件可重放 |
| C8 | 并发两个实例 | 不互相写坏会话 |

---

## 5 目录与命名

### 5.1 同址（层 1-4）

```
src/core/session/session.ts
src/core/session/session.spec.ts          ← unit
src/core/session/session.int.spec.ts      ← integration

src/packages/ui-status/ui/status-model.ts
src/packages/ui-status/ui/status-model.spec.ts   ← ui
```

### 5.2 集中（层 5-8）

跨模块的场景放顶层 `tests/`，与 DSH 的 `snapshots/`、codex 的 `exec/tests/` 同理：

```
tests/snapshots/   ← 录制回放
tests/bench/       ← 性能
tests/live/        ← 真模型
tests/cli/         ← 真入口
tests/harness.ts   ← 共享设施
```

**命名后缀唯一定义，不允许多重后缀**（`foo.int.spec.ts` 只算 integration）。

---

## 6 构建隔离（漏做就会把测试发布出去）

`pnpm build` 是 `tsc` 全量编译 `src/` → `lib/`，而 [package.json](../package.json) 的 `files` 只含 `bin`、`lib`、`package.json`。所以 `.spec.ts` 一旦进 `src/`，就会被编进 `lib/` 并随包发布。

必须同批完成：

| 文件 | 改动 |
| --- | --- |
| [tsconfig.json](../tsconfig.json) 第 31 行 | `exclude` 追加 `"src/**/*.spec.ts"`、`"src/**/*.int.spec.ts"`、`"src/**/*.e2e.ts"` |
| `ui-shell/tsconfig.json` | 追加 ui 半的 `*.spec.tsx` |
| `tsconfig.spec.json`（新建） | 测试专用的编译配置，给 `tsc --noEmit` 检查测试代码自身类型用 |

验证：`pnpm build && Get-ChildItem lib -Recurse -Filter *.spec.js` 必须为空。这条进 P0 验收。

---

## 7 解析层（技术风险最高的一块）

### 7.1 源码里有四种写法，Vitest 必须全部认

| # | 写法 | 现在的解析者 | Vitest 方案 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | `import './x.js'`（实际文件是 `x.ts`） | [_i18n-alias.mjs](../scripts/_i18n-alias.mjs) 第 44-47 行的 Node hook | **自写 Vite 插件** `jsToTsFallback()` | 低（20 行） |
| 2 | `import '@pneuma/runtime/core/x.js'` | `lib/node_modules/@pneuma/runtime` 桩包 | `vite-tsconfig-paths` 读 tsconfig.json:18 | 中 |
| 3 | `import '@pneuma/<id>'` | 同一条 paths 的数组候选 `["src/packages/*", "src/packages/*/index.ts"]` | 同上 | **高** |
| 4 | `import '@dsc/ui'` + `.json` 字典 | `ui-shell/packages.json` + Node hook | 读 packages.json 生成 alias；JSON 走 Vite 原生 | 低 |

### 7.2 配置骨架

```
vitest.config.ts
├─ resolve.alias      ← 展开 ui-shell/packages.json 全表（8 条）
├─ plugins            ← [tsconfigPaths({ projects: ['./tsconfig.json'] }), jsToTsFallback()]
├─ test.projects      ← unit / integration / ui / e2e / snapshot / bench / live / cli
└─ test.coverage      ← provider v8，分阶段启用门槛
```

另需两个独立配置，理由与 DSH 相同（不同层的超时、并发、环境完全不同）：

- `vitest.e2e.config.ts`（真 Chromium，依赖 `desktop/node_modules/electron`）
- `vitest.bench.config.ts`（plain node，禁用 tsx 转译）

### 7.3 单实例约束在配置里怎么落地

`vitest.config.ts` 顶部必须写明：**本项目只解析 src，禁止 import `lib/`**。理由见第 3 节不变量 1。与 [build-runtime-package.mjs](../scripts/build-runtime-package.mjs) 第 6-7 行是同一条约束的两面。

---

## 8 测试设施（harness）

现状：24 条探针各写一遍假 SSE server，46 条各建一次内核。

新建 `tests/harness.ts`（对应 DSH 的 `packages/test-support/*`、codex 的 `core/tests/common`）：

| 导出 | 职责 | 从哪抽 |
| --- | --- | --- |
| `tempHome()` | 建临时目录并覆盖 `HOME`/`USERPROFILE`，返回清理函数 | 现有探针开头三行 |
| `fakeLLM(script)` | 可编程 SSE：按轮次返回文本或 tool_call，记录请求体 | `todo-reminder-test.mjs` 第 160-203 行 |
| `replayLLM(recording)` | 读录制 jsonl 回放（第 5 层用） | 新建，复用 `fakeLLM` 骨架 |
| `bootKernel(opts)` | `createKernel` + 等 `turn-end` + 等 agent 空闲 | `todo-reminder-test.mjs` 第 206-250 行 |
| `readSessionJsonl(path)` | 解析会话 jsonl | 现有探针 |
| `runCli(args, opts)` | spawn 真 `node bin/dsc.js`，超时与信号封装（第 8 层用） | 新建 |
| `expectGolden(actual, name)` | 快照比对与更新（第 5、9 层用） | 新建 |

**收益量化**：一条典型 integration 测试从约 300 行降到约 60 行。

---

## 9 覆盖率策略

### 9.1 分期，不一次到位

| 阶段 | 做法 | 为什么 |
| --- | --- | --- |
| P3 | 只出报告：`include: ['src/core/**','src/packages/**']` | 先看清盲区分布 |
| P4 | 冻结基线：写进 `coverage-baseline.json`，跌破即红 | 「只降不升」 |
| P6 | 逐目录抬杠：`src/core/` 先 60%，再 70% | 分级抬，不搞一刀切 |

### 9.2 明确不学 DSH 的 100% 门禁

DSH 是 per-file 四项 100%，且它自己的 [docs/testing.md](../../deepseek-harness/deepseek-harness/docs/testing.md) 第 10 行写着「行覆盖必要但不充分」。dsc 存量几乎没有单测，一上来设 100% 只会逼出一批「调用一次不断言」的凑数测试，比没有更坏。

### 9.3 排除项

纯类型文件（`types.ts`）、入口（`bin/`）、构建生成物（`lib/ui/`）、ui 半（单独算）。

---

## 10 门禁、CI 与工程化治理

### 10.1 脚本（定稿）

```json
"test":             "vitest run --project unit --project ui --project snapshot",
"test:unit":        "vitest run --project unit",
"test:int":         "vitest run --project integration",
"test:e2e":         "vitest run --project e2e",
"test:bench":       "node --import tsx scripts/run-bench.mjs",
"test:live":        "vitest run --project live --config vitest.live.config.ts",
"test:cli":         "vitest run --project cli",
"test:snapshot":    "vitest run --project snapshot",
"test:coverage":    "vitest run --coverage",
"test:legacy":      "pnpm run check:core && pnpm run check:ui",
"check:all":        追加 "pnpm run test"
```

### 10.2 CI 分层

| 触发 | 跑什么 | 为什么 |
| --- | --- | --- |
| **PR** | typecheck + style + `test`（unit/ui/snapshot 关键 20 份）+ `test:bench` | 秒级到分钟级，红了能当场修 |
| **夜跑** | `test:int` + `test:e2e` + `test:cli` + `test:coverage` + legacy 探针 | 分钟级，依赖真内核与真浏览器 |
| **独立 workflow** | `test:live`（with-key，key 预检） | 需要密钥，不能污染普通 PR |
| **手动** | `test:coverage:refresh-baseline`、`test:snapshot:record` | 会改文件，必须人审 |

### 10.3 分支保护

对齐 DSH 的单一聚合 check：建一个 `all-checks-passed` job，`needs` 所有阻断 job，任一 failure/cancelled/skipped 即红。分支保护只要求这一个 check，不必枚举易变的 job 名。

### 10.4 flake 治理（P6）

| 机制 | 做法 | 对齐 |
| --- | --- | --- |
| 重试 | `retry: 1`，只对 integration/e2e 层开 | codex nextest retries=1 |
| 慢测试上限 | `testTimeout` 按层设：unit 5s、int 60s、e2e 120s、cli 60s | codex slow-timeout |
| 串行组 | 会争抢端口/临时目录的套件标记 `sequence.concurrent = false` | codex test-group |
| 报告 | JUnit XML 上报，CI 里能看每条用例 | codex JUnit |
| 诊断 | 失败时打印 PID、临时目录、最后 20 行输出 | DSH fork 诊断 |

### 10.5 分片（P6）

integration 层按目录切 3 片（`core/session`、`core/tools`+`core/llm`、`packages/`），用 `--shard=1/3`，为将来「integration 进 PR」铺路。

### 10.6 Node 版本矩阵（P6）

`engines` 是 `>=22.19`，CI 跑 Node 22 与 24（DSH 跑 24/26，dsc 的底线是 22，按自己的实际支持面来）。

---

## 11 迁移路线（八期）

### P0 地基（必须一次验收通过，否则方案回炉）

1. 装 `vitest` + `@vitest/coverage-v8` + `vite-tsconfig-paths`（devDependencies）。
2. 写 `vitest.config.ts`：alias 表、`jsToTsFallback()`、三个 project（unit/integration/ui）。
3. 改两处 tsconfig `exclude`，新建 `tsconfig.spec.json`。
4. 迁 3 条 POC。
5. 跑通 11.1 的四条验收。

**P0 不碰存量探针**：证的是「新体系能长出来」。

#### 11.1 P0 验收

```
pnpm vitest run --project unit --project ui     → 退出码 0，用例数 > 0
pnpm vitest run --project integration           → 退出码 0
pnpm run build                                  → 退出码 0，且 lib/ 下无 *.spec.js
node scripts/check-core.mjs --list              → 仍是 122 条（旧体系未被动到）
```

#### 11.2 三条 POC

| # | 目标文件 | 来源探针 | 验证 |
| --- | --- | --- | --- |
| 1 | `src/core/todo-reminder.spec.ts` | `todo-reminder-test.mjs` 的纯函数部分 | 相对路径 `.js→.ts`；unit |
| 2 | `src/core/session/session.int.spec.ts` | `session-dedupe-test.mjs` 的三层去重 | `@pneuma/runtime/*`；临时 HOME；integration |
| 3 | `src/packages/ui-status/ui/status-model.spec.ts` | `ui-status-panel-test.mjs` 的纯模型 | `@dsc/ui` + JSON；ui |

### P1a 地基加固 + 把已有的门接进 CI

1. `tests/harness.ts` 抽取（第 8 节前四个设施）。
2. 24 条探针的假 SSE 收敛到 `fakeLLM`。
3. **把 `check:plugin`（含 119 条包级测试）接进 verify.yml 的 PR 门禁**——这一步最便宜、见效最快：测试早就写好了，只是没人自动跑。先量它跑多久，超过 5 分钟就拆成独立 job。
4. 为 `src/core/` 纯函数模块补 spec：`clamp`、`records`、`strings`、`json-text`、`shell-quote`、`terminal-env`、`token-estimate`、`err-text`、`transcript-text`、`git-surface`、`todo-reminder`、`microcompact`、`compact-*`、`session-*`。

### P1b 迁包级测试（119 条）

`src/packages/<id>/tests/*.test.mjs` → `src/packages/<id>/tests/*.spec.ts`。

| 批次 | 包 | 条数 |
| --- | --- | --- |
| A | 核心装配包（agent、session、session-core、tools、tools-default、commands、settings、prompt） | 约 20 |
| B | 权限与沙箱（approval、approval-floor、permission-core、permission-presets、sandbox、guards） | 约 15 |
| C | 工具类（read/write/edit/glob/grep 所在包、lsp、mcp、skills、memory） | 约 25 |
| D | 界面侧包的宿主半（ui-* 的 index 部分） | 约 30 |
| E | 其余 | 约 29 |

迁移规则（详见详细设计 §15.2）：

- `import ... from '../../../../lib/packages/<id>/index.js'` → 改成相对源码路径 `../index.js`，靠解析插件落到 `.ts`。
- 自造 `check()` + `node:assert` → `test()` + `expect`。
- **源码文本断言必须重写**：现有 119 条里大量 `assert.match(source, /name: 'todo_write'/)`，这类断言改类名/改引号就假红、改逻辑但保留字面量就假绿。迁到 Vitest 时改成断言导出的对象（`todoPlugin` 的字段、`tool.schema` 等）。
- 迁完删旧 `.test.mjs`，`package-tests.mjs` 的发现列表随之缩短；全部迁完后这个脚本与 `check:plugin` 里的这一步一起删。

### P2 迁 integration（最大一块）

46 条起内核的探针 → `*.int.spec.ts`。

| 批次 | 内容 | 条数 |
| --- | --- | --- |
| A | 会话正确性（去重、重放、压缩、租约、权限） | 12 |
| B | 工具与沙箱（bash、read/write/edit、沙箱令牌、审批流） | 14 |
| C | 上下文与注入（todo 提醒、microcompact、环境快照） | 10 |
| D | 其余 | 10 |

每迁完一条，从 `scripts/` 删掉对应 `.mjs`，`check-core` 自动发现列表随之缩短。

### P3 ui 层 + e2e + 覆盖率开关

1. 79 条 `ui-*` 拆两类：纯模型（约 40 条）→ `*.spec.ts`；组件渲染（约 39 条）→ `*.spec.tsx`，现有源码文本断言逐步换成真渲染断言。
2. 启用 `e2e` project，迁 11 条 `*-e2e.mjs`。
3. 覆盖率报告上线（只出报告，不设门）。

### P4 快照层（对齐 DSH 的 snapshots、codex 的 insta）

1. 录制器 + 回放器（复用 `fakeLLM` 骨架）。
2. 30 份会话快照：会话基础、工具调用、压缩、中断恢复、子代理、多轮。
3. TUI 帧快照 30 个：把现有 8 条 `tui-*` 探针升级为 `expectGolden` 比对。
4. 浏览器快照 10 份：从 `desktop/shots/_verify-*` 挑稳定的转。
5. 冻结覆盖率基线。

### P5 真模型 + 性能 + 契约

1. 5 条 live 冒烟（第 4.3 节）+ 独立 workflow + key 预检防假绿。
2. 4 条 bench（第 4.2 节）+ 基线文件 + PR 门禁接入。
3. 3 份契约测试，替换源码文本断言：
   - `transcript`：事件 → 快照投影的形状（最易碎）
   - `settings`：设置读写与默认值
   - `session`：会话事件与持久化格式

### P6 工程化（对齐两家的 CI 质量）

1. flake 治理四件（retries / slow-timeout / 串行组 / JUnit）。
2. 分片 3 片。
3. Node 22/24 矩阵。
4. 单一聚合 check `all-checks-passed`。
5. 8 条真入口 e2e（第 4.4 节）。
6. 覆盖率逐目录抬杠。

### P7 补漏与收尾

| 项 | 内容 |
| --- | --- |
| 5 个无门脚本 | `_market-source-check`、`_market-speed-check`、`runtime-package-check`、`settings-sections-check`、`ui-switch-check` 挂进 `check-p0` 或删 |
| Windows lane | 8 条平台专属探针加 Windows CI job |
| 属性测试 | 6 条 fast-check：路径解析、`shell-quote`、沙箱策略、`clamp` |
| macOS 覆盖 | 至少 1 条 lane 跑核心 unit + cli（成本高，可延后） |
| 文档 | 更新 development.md 第 5 节、新增本文的索引行 |

---

## 12 开发工期

### 12.1 估算口径

- **1 人天 = 1 名熟悉本仓库的开发者工作 8 小时**。不熟悉仓库的人乘 1.5。
- 含「读代码 + 写 + 本地跑通 + 自检」，不含 review 与返工等待。
- 区间给「乐观 / 基准 / 悲观」：乐观假设解析层一次通过；悲观假设 paths 不可用需手写 alias、组件测试周期拉长、录制回放器比预期复杂。

### 12.2 逐期工时

| 期 | 工作项 | 乐观 | 基准 | 悲观 |
| --- | --- | --- | --- | --- |
| **P0** | 装依赖 + 配置骨架 | 0.5 | 0.5 | 1 |
| | `jsToTsFallback()` 插件 | 0.5 | 0.5 | 1 |
| | alias 表 + paths 验证（**最大不确定性**） | 0.5 | 1 | 2.5 |
| | POC-1 unit | 0.5 | 0.5 | 1 |
| | POC-2 integration | 0.5 | 1 | 1.5 |
| | POC-3 ui（jsdom） | 0.5 | 1 | 2 |
| | 两处 tsconfig + 产物校验 | 0.5 | 0.5 | 0.5 |
| **小计** | | **3.5** | **5** | **9.5** |
| **P1a** | harness 前四个设施 | 1.5 | 2 | 3 |
| | 24 条探针 SSE 收敛 | 1 | 2 | 3 |
| | **`check:plugin` 接进 PR 门禁**（119 条已存在，只差接线） | 0.5 | 1 | 2 |
| | `src/core/` 纯函数单测（约 30 模块） | 4 | 6 | 9 |
| **小计** | | **7** | **11** | **17** |
| **P1b** | 迁包级测试 119 条（模板化批量 + 逐条改断言） | 18 | 28 | 42 |
| **小计** | | **18** | **28** | **42** |
| **P2** | 批次 A（12 条，含模板期） | 6 | 9 | 13 |
| | 批次 B（14 条） | 6 | 9 | 13 |
| | 批次 C（10 条） | 4 | 6 | 9 |
| | 批次 D（10 条） | 4 | 6 | 9 |
| **小计** | | **20** | **30** | **44** |
| **P3** | ui 纯模型 40 条 | 8 | 12 | 17 |
| | ui 组件 39 条（文本断言转真渲染） | 14 | 20 | 30 |
| | e2e 11 条 | 3 | 5 | 7 |
| **小计** | | **25** | **37** | **54** |
| **P4** | 录制器 + 回放器 | 3 | 5 | 8 |
| | 30 份会话快照（录制 + 审查） | 7 | 10 | 15 |
| | TUI 帧快照 30 个 | 5 | 8 | 12 |
| | 浏览器快照 10 份 | 2 | 3 | 5 |
| | 覆盖率基线冻结 | 1 | 1.5 | 2 |
| **小计** | | **18** | **27.5** | **42** |
| **P5** | live 5 条 + workflow + key 预检 | 3 | 5 | 8 |
| | bench 4 条 + 门禁 | 4 | 6 | 9 |
| | 契约测试 3 份 | 6 | 10 | 15 |
| **小计** | | **13** | **21** | **32** |
| **P6** | flake 治理四件 | 2.5 | 4 | 6 |
| | 分片 3 片 | 2 | 3 | 5 |
| | Node 矩阵 + 聚合 check | 1.5 | 2 | 3 |
| | 真入口 e2e 8 条 | 5 | 8 | 12 |
| | 覆盖率逐目录抬杠 | 2 | 3 | 5 |
| **小计** | | **13** | **20** | **31** |
| **P7** | 5 个无门脚本 | 0.5 | 1 | 1.5 |
| | Windows lane | 2 | 3 | 5 |
| | 属性测试 6 条 | 3 | 4 | 6 |
| | macOS lane（可选） | 2 | 4 | 7 |
| | 文档收尾 | 0.5 | 1 | 1.5 |
| **小计** | | **8** | **13** | **21** |
| **合计** | | **125.5** | **192.5** | **292.5** |

### 12.3 里程碑

| 里程碑 | 内容 | 累计（基准） | 达成后的能力 | 对齐等级 |
| --- | --- | --- | --- | --- |
| **M0** | P0 | 5 | 新体系可跑，解析层风险出清 | L3→基础 |
| **M1** | +P1a | 16 | **119 条包级测试进 CI**，核心纯函数有回归网 | unit L2、包级 L1 |
| **M1b** | +P1b | 44 | 包级测试全部转成 Vitest | **包级 L1** |
| **M2** | +P2-A | 53 | 会话正确性有细粒度守护 | integration L1 |
| **M3** | +P2 全 | 74 | 端到端探针一半转正，check:core 缩短 | integration L1 |
| **M4** | +P3 | 111 | 全量迁移完成，覆盖率可见 | ui/e2e L2 |
| **M5** | +P4 | 138.5 | 录制回放 + 帧快照可用 | snapshot L2 |
| **M6** | +P5 | 159.5 | 真模型、性能、契约三线补齐 | **live/bench/contract L1-L2** |
| **M7** | +P6 | 179.5 | flake、分片、多版本、真入口 | **工程化 L1** |
| **M8** | +P7 | 192.5 | 补漏完成，体系定型 | **全部 ≥L2** |

### 12.4 关键路径与并行

- **关键路径**：P0 → harness（P1a 首项）→ P2 → P4（录制回放依赖 harness 的回放能力）。
- **可并行**：P3（ui）与 P2 在 harness 完成后并行；P5（live/bench/契约）与 P4 独立，可另一人做；**P1b（包级测试迁移）可以交给第二个人全程并行**，它只碰 `src/packages/*/tests/`，与主线几乎不冲突。
- **最短可用路径**：P0（5）+ harness（2）+ **`check:plugin` 接线（1）** + P2-A（9）= **17 人天**，让会话正确性进 PR 级守护，并让 119 条既有测试第一次出现在 CI 里。
- **最便宜的一刀**：只做 **`check:plugin` 接线（1 人天）**——119 条测试早就写好了，接进 CI 立刻多一层回归网，投入产出比全场最高。
- **对齐最小集**（只补三处最大空白，不追完整体系）：P0 + harness + live 5 条 + bench 4 条 + 契约 3 份 = **5 + 2 + 5 + 6 + 10 = 28 人天**，把 L3 的三项（真模型、性能、契约）提到 L2。

### 12.5 工期不确定性来源

| 来源 | 影响 | 应对 |
| --- | --- | --- |
| `vite-tsconfig-paths` 吃不掉 paths 数组候选 | P0 多 1–2 天，可能全盘改 alias | POC 优先，两天内出结论 |
| ui 半的构建期别名 + jsdom 组合 | P3 组件测试翻倍 | POC-3 提前验证 |
| 录制回放器比预期复杂（SSE 时序、会话状态机） | P4 多 3–5 天 | 先用最简单的单轮场景打通，再扩 |
| 存量探针混着源码文本断言 | 迁移时要重写而非翻译 | 迁到哪条重写到哪条，不追 1:1 |
| AI 协作易过度铺量、断言偏弱 | 测试多但不拦回归 | 每条 spec 要求「引入回归必须红」自证（见 §15） |
| 119 条包级测试里源码文本断言占比高 | 迁移时大量要重写，不能机械翻译 | 按包分批，先迁断言结实的包；文本断言的包单列「重写」而非「迁移」 |

### 12.6 排期建议（按周，1 人全职 + 1 人半职并行）

| 周 | 主线 | 并行 |
| --- | --- | --- |
| W1 | P0（M0） | —— |
| W2 | P1a（M1） | —— |
| W3–W5 | P1b 包级测试迁移（M1b） | —— |
| W6–W7 | P2-A、B（M2） | P7 五个无门脚本 |
| W8–W10 | P2-C、D（M3） | P3 ui 纯模型 |
| W11–W13 | P4 录制回放（M5 前置） | P3 组件 + e2e |
| W14–W15 | P4 帧快照 + 基线（M5） | P5 live |
| W16–W18 | P5 bench + 契约（M6） | P6 flake + 分片 |
| W19–W21 | P6 真入口 e2e（M7） | P7 Windows lane |
| W22–W24 | P7 属性测试 + macOS + 文档（M8） | —— |

按此排期约 **24 周**（基准 192.5 人天，含并行）。

### 12.7 如果预算有限，怎么砍

| 预算 | 做到哪 | 买到什么 | 放弃什么 |
| --- | --- | --- | --- |
| **1 人天** | 只把 `check:plugin` 接进 CI | 119 条既有测试第一次自动跑 | 其余全部 |
| **17 人天** | P0 + P1a 的 harness 与接线 + P2-A | 新体系能跑、119 条进 CI、会话正确性进 PR | 迁移包级测试、快照、工程化 |
| **28 人天** | P0 + harness + P5 三线 | 补掉三个 L3 空白（真模型/性能/契约） | 会话测试仍靠探针 |
| **56 人天** | +P1a +P1b | 单元与包级两层齐，全部进 CI | 快照、工程化 |
| **137 人天** | +P2 +P3 +P4 | 全量迁移 + 录制回放 | 真模型、性能、工程化 |
| **193 人天** | 全量 | 全部 ≥L2 | —— |

---

## 13 风险与应对

| # | 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- | --- |
| 1 | 解析层跑不通 | 中 | P0 失败，方案回炉 | POC 前置；准备手写 alias 的 B 方案 |
| 2 | src/lib 双平面混用 | 低 | 沙箱 fail-open 类隐蔽 bug | 配置顶部硬注释 + review 检查项 |
| 3 | spec 被发布进 npm 包 | 中 | 包体积与类型污染 | tsconfig exclude + P0 验收第四条 |
| 4 | 迁移中旧断言被「翻译」而非重写 | 高 | 测试变绿但不再守护 | 每条迁移自证（§15） |
| 5 | 覆盖率门槛诱导凑行 | 中 | 测试数量涨、质量降 | 分期设门槛（§9） |
| 6 | 真模型测试因 key 缺失长期不跑 | 高 | 真 API 层形同虚设 | key 预检防假绿（§4.3） |
| 7 | 录制快照录制时污染仓库 | 中 | 大文件进 git | 录制产物只留 jsonl、限大小、PR 必审 |
| 8 | bench 在共享 CI 上抖 | 高 | 假红 | 录基线用多次中位数；只在固定 runner 上跑 |
| 9 | 工期低估 | 高 | 延期 20–50% | 预算按悲观档做（§12.2） |

---

## 14 已知边界（做完之后仍然缺什么）

诚实记账：即使全部做完，以下仍与两家有差距，**且是明知不填的**。

| # | 仍缺的 | 与谁比 | 差距量级 | 为什么不填 |
| --- | --- | --- | --- | --- |
| 1 | 用例总量 | DSH 3.7 万 / codex 2.28 万 | dsc 约 1,500–2,500 条，差 10–15 倍 | 仓库规模差一个量级（16.8 万行 vs codex 5,927 个 `.rs` 文件），硬追是浪费 |
| 2 | 100% 覆盖率硬门槛 | DSH | 差一整个门槛制度 | 会诱导凑数断言（§9.2） |
| 3 | 平台矩阵广度 | codex 5 平台、DSH Linux/Win/mac/Wine | dsc 只有 Win+Linux（macOS 可选一条） | 用户与发布面没到那个规模 |
| 4 | 浏览器快照规模 | DSH 400 份、codex TUI 1,514 个 | dsc 约 40 份 | 前期只需覆盖高频改动面 |
| 5 | 双构建校验 | codex Bazel+Cargo | 无 | dsc 只有一个构建系统，没有可校验的第二套 |
| 6 | 语言级静态门 | codex clippy 35 条 deny + shear | 弱一档（只有 tsc strict + style） | TypeScript 生态没有等价物 |
| 7 | 真机桌面走查自动化 | —— | `desktop/shots` 仍以人眼为主 | 多数一次性走查，只有 10 条值得固化 |

**如果将来要填**：优先级依次是 平台矩阵 > 快照规模 > 覆盖率严格度 > 用例总量。前两项是真实风险，后两项是虚荣指标。

---

## 15 每期必做的自证（防止「绿了但没用」）

每个新增测试文件提交前必须做一次反向验证：

1. 故意引入一处回归（改条件、删赋值、换分支）。
2. 跑该测试，**必须变红**。
3. 还原回归，跑，**必须变绿**。
4. 在提交信息里写一句「反向验证：改了 X，测试 Y 变红」。

这条对齐 DSH 的 [docs/testing.md:40](../../deepseek-harness/deepseek-harness/docs/testing.md)「A guard only guards if the regression fails it」。不做的后果就是「测试数量涨、回归拦不住」，这是 AI 协作写测试最容易翻车的地方。

---

## 16 验收清单（每期收尾自查）

| 检查项 | 命令 | 期望 |
| --- | --- | --- |
| 新测试全绿 | `pnpm test` | 退出码 0 |
| 存量未倒退 | `pnpm run check:core --list` 条数对比 | 只减不增（迁移即删） |
| 产物干净 | `pnpm run build && Get-ChildItem lib -Recurse -Filter *.spec.js` | 为空 |
| 类型不破 | `pnpm run typecheck` | 退出码 0 |
| 排版 | `pnpm run check:style` | 退出码 0 |
| 覆盖不出错 | `pnpm run test:coverage` | 退出码 0，生成报告 |
| 反向验证 | 见 §15 | 每个新文件至少一条 |
| 基准未退化 | `pnpm run test:bench` | 在 1.5× 内 |

---

## 附：数字口径与取证命令

本文所有数字均可在仓库根复现：

```powershell
# 探针数量
(Get-ChildItem scripts -Filter *-test.mjs).Count
(Get-ChildItem scripts -Filter *-check.mjs).Count
# 断言数量
(Get-ChildItem scripts -Filter *.mjs | Select-String -Pattern '\bcheck\(' | Measure-Object).Count
# 探针行数
(Get-ChildItem scripts -Filter *test*.mjs | Get-Content | Measure-Object -Line).Lines
# src 行数
(Get-ChildItem src -Recurse -Include *.ts,*.tsx | Get-Content | Measure-Object -Line).Lines
# 测试框架有无
Get-ChildItem -Filter package.json -Recurse -Depth 2 | Where-Object { $_.FullName -notmatch 'node_modules' } | Select-String 'vitest|jest|node:test'
# 真 API key 用量（应为 0）
(Get-ChildItem scripts -Filter *-test.mjs | Select-String -Pattern 'apiKey:\s*process\.env' | Measure-Object).Count
# 真 CLI 入口测试（应为 0）
(Get-ChildItem scripts -Filter *.mjs | Select-String -Pattern 'bin/dsc\.js' | Measure-Object).Count
```
