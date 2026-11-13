# 测试体系：与设计文档不同的决定（台账）

> 这份台账只记**与 `testing-design.md` / `testing-detailed-design.md` 不一致的地方**。
> 一致的部分不重复。每条写清：设计原文说什么、实做是什么、为什么、影响面、当前状态。
>
> 状态含义：**已定** = 我认为理由充分、无需再议；**待定** = 需要你拍板。
>
> 同步回设计文档的条目不再重复记账——文档已经改成实做形态的，这里只留一行索引。

## 一、P0 地基与三条 POC

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | `vitest ^4.1` + `vite ^7` + `plugin-react ^5`（详设 §2） | 同左，但锁到具体解析版本 4.1.12 / 7.3.8 / 5.2.0；不跟 registry 上最新的 vitest 5.1 + vite 8 | plugin-react 6 对 vite 8 额外要求 `oxc-transform-react` 与 `@rolldown/plugin-babel` 两个原生依赖；vitest 4 与 DSH、codex 的配置写法可直接对照 | 已定 |
| D2 | 依赖清单里没有 `react-dom` | 根 `devDependencies` 补 `react-dom ^19.2.0` | 界面半 spec 一 import `@dsc/ui` 就经 `plugin-api.ts` → `ui-primitives` 桶 → `image-lightbox.tsx` 的 `createPortal`；根 `node_modules` 只有 `@types/react-dom`（pnpm 提升的），没有本体。版本由既有 `pnpm.overrides` 钉在 19.3.1 | 已定 |
| D3 | `tsconfig.spec.json` 的 `types: ["node", "vitest/globals"]`（详设 §5.2） | `types: ["node"]`，不用 globals，测试里显式 `import { test, expect } from 'vitest'` | 隐式全局让「这个文件用到了哪些测试 API」不可见；显式导入也能让 `tsc` 在缺导入时直接报错 | 已定 |
| D4 | 只有一份 `tsconfig.spec.json`（详设 §5.2） | 新增 `ui-shell/tsconfig.spec.json`，`typecheck:spec` 串两条 `tsc` | 界面半 spec 需要 DOM 库、`bundler` 解析、`@dsc/*` paths 与 `resolveJsonModule`，根那份是 node 环境（ES2023、NodeNext）。把 DOM 库塞进根配置更糟：内核测试跑在 node 环境，配上 DOM 等于允许它们写 `document`，写了真跑就是 `undefined`，类型检查反而给出假绿 | 已定 |
| D5 | `tsconfigPaths({ projects: ['./tsconfig.json'] })`（详设 §3.1） | 传两份：`['./tsconfig.json', './tsconfig.spec.json']` | 该插件按 `include`/`exclude` 过滤的是 **importer**。根 tsconfig 只 include `src`，于是 `tests/**` 里写裸 `@pneuma/<id>` 报 `Cannot find package`。设计里把这归因于「数组候选不支持」，是判断错了 | 已定 |
| D6 | unit 的 `exclude: ['src/packages/*/ui/**', '**/node_modules/**']`（详设 §3.2） | 补 `src/**/*.int.spec.ts` | `*.spec.ts` 的星号不跨目录但跨点，`session.int.spec.ts` 同样以 `.spec.ts` 结尾，会被 unit 层再跑一遍（5s 超时 + 线程池） | 已定 |
| D7 | snapshot 的 `exclude: []`（详设 §3.2） | 不写该字段 | Vitest 的 `exclude` 一旦写值就整体替换默认列表，写 `[]` 会把 `**/node_modules/**` 一起丢掉 | 已定 |
| D8 | POC-3 目标 `src/packages/ui-status-panel/ui/model.spec.ts`（概要 §11.2） | `src/packages/ui-status/ui/status-model.spec.ts` | 库里没有 `ui-status-panel` 这个包，实际包名是 `ui-status`，纯模型文件是 `ui/status-model.ts` | 已定（文档已订正） |
| D9 | 三条 POC 的顺序是插件 → 配置 → tsconfig → POC-1/2/3（详设 §16） | 中间插了一步「建 `tests/setup/temp-home.ts` 与 `dom.ts`」 | `vitest.config.ts` 的 `setupFiles` 指向这两个文件，缺了报 `Cannot find module` 而不是「测试失败」，且 integration/ui 层第一条用例就会撞上 | 已定（文档已订正） |

## 二、CI 接线

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D10 | 「把 `check:plugin` 接进 verify.yml 的 **PR 门禁**」（概要 §11 P1a 第 3 项） | PR 门只跑 `node scripts/package-tests.mjs`（119 条，72.7s，只需 `pnpm build`）；整串 `check:plugin` 挂到夜跑 `probe` job 末尾 | 整串里的 `plugin-inventory-check` 要读 `lib/ui/plugins/`（界面单元），那批产物得先 `pnpm -C ui-shell build`——把界面壳整个编一遍。为 119 条测试让每个 PR 等这个不划算。夜跑那边本来就为界面探针构建了界面壳，加这条不多花构建时间 | 待定（是否接受「PR 跑不全量插件门禁」） |
| D11 | `pnpm test:int` 排在夜跑 `probe` job（详设 §12.1） | 提前到 PR 门 `core` job | 15 条守的是线上事故（同一 callId 两条工具结果 → 网关 400），隔夜才发现太慢；它只解析 `src/**`、不依赖 `lib/`，本地 905ms。设计的排法是按「集成层会长到分钟级」预留的，等 P2 迁完存量探针再移回夜跑 | 待定（提前是否有必要） |
| D12 | 排版闸门扫描目录不含 `tests`（`scripts/style-check.mjs:40`） | 加上 `tests` | 不扫就是「测试体系新写的代码不受排版闸门管」，而闸门正是靠这份清单才看得见东西 | 已定 |

## 三、协作方式（不是设计里的内容，是执行时的取舍）

| # | 设计原文 | 实做 | 为什么 | 状态 |
| --- | --- | --- | --- | --- |
| D13 | 设计假设「一个阶段一口气做完」 | 同一棵工作树里并行跑多个子代理，**代理只跑自己文件的定向验收**，全仓验收由我在阶段末统一跑 | 实测过一次误判：三个代理并行时，一个代理跑全仓 `vitest run --project unit`，看见另外两个代理在途的红（14 failed），归因错误。全仓验收在并行阶段没有意义，因为工作树状态每几分钟就变一次 | 已定 |

## 四、已知问题（不是偏离设计，是现场状况）

| # | 现象 | 判据 | 影响 |
| --- | --- | --- | --- |
| K1 | `check-core.mjs` 全量跑两遍都是 121/122 | 失败的是 `scripts/panel-prefs-test.mjs`，退出码 `0xC0000409`（进程崩溃，非断言失败）；单独跑 41/41 全绿。runner 自己在结尾也抛 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)` | 旧体系回归证据只能算「121 条确认通过 + 1 条环境崩溃」。不是本次改动引起（本次没碰 src 逻辑），但没有第二台机器对照 |
| K2 | `src/packages/superagent/tests/executor.test.mjs` 在 `check:plugin` 跑批时红过一次 | 断言「会话文件应在 start 之后落盘」；单独连跑三次全绿 | 既有时序不稳。它已随 119 条进 PR 门，会表现为偶发红。设计 P6 的 flake 治理有了第一个具体对象 |
