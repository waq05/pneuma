# 门禁操作手册（AI 版）

> 谁读：在本仓库干活的所有 AI 代理。`AGENTS.md` 是规矩，这页是可执行动作；判据依据见第 0 批设计与交付记录 `docs/research/harness-engineering/numa/design/`（研究目录，暂未入库）。<!-- docs-check:external: docs/research/harness-engineering/ -->
> 退出码只有三种：**0 通过 / 1 有违规 / 2 工具或环境错误**。2 不等于通过，先修环境（缺 git 历史、坏 JSON、参数写错）再重跑。

## 1 改完代码跑什么

| 改动面 | 命令 | 耗时 |
| --- | --- | --- |
| `src/core/**`、`src/packages/ui-*/ui/**`、`desktop/electron/**` | `pnpm run law` | 约 2s |
| 新增/改名了 `scripts/*.mjs` | `pnpm run probe-inventory` | 约 0.3s |
| `package.json` 的 scripts、`.github/workflows/**` | `pnpm run ci-coverage` | 约 0.2s |
| `docs/**`、`AGENTS.md` | `pnpm run docs-check` | 约 0.6s |
| 版本号、打 tag 前 | `node scripts/version-check.mjs --tag 0.9.1` | 约 0.3s |
| 提交前（四条连跑） | 上面前四条 | 约 5s |
| 发版前 / 大改后 | `pnpm run check:all`（含远程 e2e，重） | 分钟级 |
| 只验一条探针 | `node scripts/check-core.mjs <名>-test.mjs` | 秒级 |

## 2 红了怎么修

| 门禁 | 红说明什么 | 改哪里 |
| --- | --- | --- |
| `law` | `src/core` 引了 ink/react/electron；界面调了不在 `INVOKABLE_METHODS` 的方法；改动碰了 `src/packages/session-core/loop.ts` | 改用 `src/contract` 或事件；方法加进 `src/core/host-methods.ts` 白名单并实现；功能挂 cordis 扩展点。动态调用确属正常 → 登记 `scripts/law/manual-confirm.json` 的 `{file,line,reason,owner}` |
| `probe-inventory` | 有 `scripts/*.mjs` 不属于任何一类，等于永远没人跑 | 回归探针改名为 `<话题>-test.mjs`；手工工具在 `scripts/probe-manual.json` 写 `{file,reason,owner,addedAt,runBy}` |
| `ci-coverage` | 新 `check:*` 没归属；push/nightly 门禁没在 workflow 真跑；`gate.json` 条目过期 | 同批改 `scripts/gate.json`（只许 6 个字段：`cmd/timeoutMs/stage/needs/informational/platforms`）或 `scripts/gate-manual.json`，并给 workflow 补步骤，再复跑自检 |
| `docs-check` | 文档点名的仓库路径或相对链接不存在 | 先改文档；引外部仓库用窄前缀 `<!-- docs-check:external: src/app/ -->`；历史引用进 `scripts/docs-check-baseline.json`，同时把 `maxEntries` 调小 |
| `version-check` | tag / 根 / desktop / ui-shell / `src/packages/*` 包组版本不一致 | 跑 `node scripts/sync-versions.mjs --write` 推齐包版本；改过 ui-shell 再跑 `pnpm -C ui-shell run build:plugins` |

## 3 不许做的事

- 不许为了变绿删断言、放宽判据、把新违规抄进基线。基线**只减不增**（`maxEntries` 是上限，调大等于作弊，必须删条目时才调小）。
- 不许长期挂 `NUMA_GATE_DISABLE`。用了要在 PR 写原因，只给发布窗口留紧急通道。
- 不许把 `docs-check:ignore` / `external` 当常规手段。`external` 的前缀要窄到刚好覆盖那类外部引用，不许整篇 `ignore-file`（除非整篇都是外来内容，并在 PR 说明）。
- 不许改 `scripts/check-core.mjs`、`scripts/check-ui.mjs` 的「只看退出码」判定语义；新能力只能加。

## 4 加东西

- **加探针**：`scripts/<话题>-test.mjs` 自动被 `check:core` 收（`ui-` 前缀归 `check:ui`）。P0 定点探针用 `<话题>-check.mjs` 并登记进 `scripts/check-p0.mjs`。
- **加铁律规则**：只在 `scripts/law/rules/` 放 `<id>.mjs`，导出 `{id,title,severity,check}`，主脚本自动发现，不改主文件。
- **加门禁**：三处同批改（`package.json` 脚本、`scripts/gate.json`、`.github/workflows/verify.yml`），然后 `pnpm run ci-coverage` 自证接线成功。

## 5 CI 里发生什么

- **push / PR**：`verify.yml` 的 core job（Node 22 与 24 各一遍）依次跑 typecheck → typecheck:spec → check:style → **law** → **ci-coverage** → **probe-inventory** → 既有 `test`；`p0-list` 与 `docs-check` 是 `continue-on-error`，只报不拦。
- **夜跑**：既有 probe job 跑 `check:core` / `check:ui` / `check:plugin` / `check:ui:e2e`。
- **发版**：`release.yml` 的 verify 跑 `version-check`，与旧四方对账 shell 并存一次发版，两条都绿才许发。
- 本地全绿不等于 CI 绿：CI 跑 Linux、干净检出、`law` 要 git 历史（checkout 已设 `fetch-depth: 0`，base 由 `NUMA_LAW_BASE` 传）。

## 6 紧急关闭

```powershell
$env:NUMA_GATE_DISABLE='law-check,ci-coverage'   # 逗号分隔，命中打印一行并退 0
pnpm run law
```

五个门禁名：`probe-inventory`、`law-check`、`ci-coverage`、`docs-check`、`version-check`。CI 里临时关要在对应 step 加 `env:`，PR 里写明原因。

## 7 现在还不覆盖

- 没有统一调度器（`gate-run` 属第 3 批），是「多条命令 + CI 多个 step」，不是一条命令跑全部。
- 不做增量，每次全量扫；`check:ui`、真机 e2e、P0 那 19 条不在这五条里。
- `law` 已知漏报面：`(channel).invoke`、`(channel as any).invoke`、`channel['invoke']()`、别名接收者——这些不算覆盖，别拿来当证据。
- `docs-check` 第一批只报不拦，转阻塞条件是基线命中占比 < 5% 且一周无新增；`loop-owner` 只警告，2026-12-02 后转阻塞。

## 8 文件索引

| 用途 | 位置 |
| --- | --- |
| 门禁台账 | `scripts/gate.json`、`scripts/gate-manual.json` |
| 探针登记 | `scripts/probe-manual.json` |
| 铁律规则与动态调用登记 | `scripts/law/rules/`、`scripts/law/manual-confirm.json` |
| 版本清单 | `scripts/version-sites.json` |
| 文档基线与术语 | `scripts/docs-check-baseline.json` |
| 探针基线 | `docs/baseline/probe-baseline-20261118.json` |
