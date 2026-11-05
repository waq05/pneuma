# Pneuma 插件体系统一计划（对齐 dsh 行模型）

- 版本基线：0.8.1
- 日期：2026-11-03（第二版，按三份独立审计修正）
- 配套契约：`docs/plugin-model.md`

> 第一版有三处错：运行时打算搬 `src/core`（会打断 166 处探针 import）、把 npm 打包规则当成了障碍（实测嵌套 `lib/node_modules` 会被打进 tarball）、期序把应用锚点排在界面之后。第二版按实测与审计重写。

## 1. 目标与判定标准

一句话：所有功能都是 profile 里的一行，行从磁盘上的包装载，走同一条解析、启停、配置、版本闸路径。

五条判定（每条都要有可复核的证据）：

1. `numa plugin list` 列出全部 56 个功能，带包名、版本、行 id、来源；核心服务（llm/session/tools/approval）也在其中。
2. 每个功能由一份 `package.json` 声明：`pneuma.bundle.patch`、可选 `pneuma.client`、`pneuma.settingsSection`、`pneuma.resolution`、`engines.pneuma`。
3. 启停/配置/设置分区/版本闸只有一条实现；`src/boot.ts`、`src/headless.ts`、`src/host/kernel.ts` 都不再静态 import 插件。
4. `kernel.ts` ≤ 120 行。
5. 端到端换包：替换 `@pneuma/ops` 的目录 → 重启 → 列表版本与工具行为都变；删包 → 应用起得来并报出缺哪一行；替换 `pinned` 包 → 告警且行为不变。

## 2. 现状（实测数字）

- 插件：`src/plugins` 56 个文件、25,908 行；19 个官方可开关、30 个登记内置、4 个挂了未登记、3 个由入口挂（tui / host-stdio / remote）。
- 装配：`src/host/kernel.ts` 35 次固定 `await root.plugin(...)` + 尾部循环挂 19 个官方（`:404-413`）。
- 加载器：`mountBundlePlugins` 已存在（`plugin-loader.ts:466`），但只服务第三方；行目标不支持 `pkg/sub`（`:574-583`）、身份是 basename（`:173/194/283`）、无安装锚点（`:582`）。
- 探针：`scripts` 下 148 条 `*-test.mjs`，`check-core` 跑 93 套；其中 79 个文件 166 处 import `lib/core`，20 个文件 25 处 import `lib/plugins`。
- 界面：`ui-shell/src` 19 个界面单元，`build-plugins.mjs` 逐个出 `lib/ui/plugins/<id>/client.js`；宿主三源发现（内置目录 / 第三方目录 / profile 包），`ui-bundles.ts:1602-1626`。
- 服务契约：`src/services/types.ts` 纯类型，`declare module '@deepseek-ai/cordis'`；`contract/runtime.ts:243` 对外公布的扩展点名是 `@dsc/runtime/contract.js`。
- 插件之间确有直接引用：`dock-browser.ts:42` ← browser、`remote.ts:90` ← webserver、`tui.ts:21` ← `../app/App.js`。

## 3. 架构决定（第二版核心修正）

### 3.1 运行时用「生成适配包」，源码零移动

```
lib/core, lib/contract, lib/services, lib/adapter   # 原位不动（tsc 产物）
lib/node_modules/@pneuma/runtime/                   # 构建后生成
  package.json
  core/<每个模块>.js + .d.ts                        # 只有一行：export * from '../../../../core/<模块>.js'
  contract/ services/ adapter/                       # 同上
```

为什么这样做：

1. **单实例**：桩文件 `export * from '../../../../core/x.js'` 让真实模块 URL 仍是 `lib/core/x.js`，与探针、`src/boot.ts` 加载的是同一个实例。`core/tools/command-runner.ts:75` 那种模块级 Map（两份副本会让沙箱 fail-open）靠这条成立。
2. **不动 166 处探针与 94 个脚本**：`lib/core` 仍在原处，探针一行不用改。
3. **可发布**：实测 `npm pack` 会把 `lib/node_modules/@pneuma/runtime/**` 打进 tarball（2026-11-03 用 npm 11 验证）；`rootDir: src` 的 tsc 生不出这个目录，所以由 `scripts/build-runtime-package.mjs` 在 tsc 之后生成。
4. **源码期可编译**：`tsconfig.paths` 把 `@pneuma/runtime/*` 映到 `src/*`，插件源码 import 裸说明符，tsc 直接通过。

明确不做：不移动 `src/core`、不发布第二个 npm 包、不建 `packages/runtime` 工作区包。

### 3.2 包的落点

```
src/packages/<id>/package.json + cordis.patch.yml + index.ts   # 源码
lib/packages/<id>/package.json + cordis.patch.yml + index.js   # 构建产物
```

`lib/packages/<id>/index.js` 向上查找命中 `lib/node_modules/@pneuma/runtime`。profile 里装的同名包由解析钩子重定向到应用内的同一份。

### 3.3 解析优先级（统一机制，包级声明）

| 取值 | 顺序 | 用途 |
|---|---|---|
| `pinned` | 应用安装目录 → profile | 运行时与核心服务包 |
| `overridable` | profile → 应用安装目录 | 功能包、第三方包 |

规则由 `package.json` 的 `pneuma.resolution` 声明，没有第三个特例。全进程只维护**一张解析表**：每个包名一个物理目录，出现两个即启动失败（dsh 同口径，防两份服务实例）。解析钩子只劫持 `@pneuma/runtime` 与 `@deepseek-ai/*`，不劫持 `@pneuma/<功能包>`——劫持了 overridable 永远不生效。**解析授权不依赖 `dsh-compat` 开关**（现在依赖，见 `plugin-loader.ts:474`，P2 解耦）。

### 3.4 界面半边

界面源码搬进各自包（`src/packages/<id>/ui/`），但**产物仍落在 `lib/ui/plugins/<id>/`**，由 `build-plugins.mjs` 读包生成。这样三源发现不用改，也不用给界面加应用锚点。

## 4. 分期

### P0 契约与基线（1–2 天）

- `docs/plugin-model.md` 定稿：包形状、行 id、身份、解析、版本闸、`pneuma.settingsSection`、迁移表。
- `scripts/plugin-model-check.mjs`（已建）：0 包必须红、缺口数逐期递减、`--strict` 进 `check:all`；校验 `boot.ts`/`headless.ts`/`kernel.ts` 三处零静态 import、行 id 重复即 fatal。
- **golden 快照**：`docs/baseline/0.8.1/` 存三份机器可读清单——插件清单（`numa plugin list` 的 JSON）、设置分区列表、界面插件清单。P3 之后逐项 diff。
- 契约版本常量 `RUNTIME_CONTRACT_VERSION` 先落地，`engines.pneuma` 有可比对象。

完成证据：`plugin-model-check --json` 的基线（0 包 / 514 行 / 3 条缺口）存档；golden 三份文件入库。

### P1 运行时适配包（3 天）

- `scripts/build-runtime-package.mjs`：tsc 后生成 `lib/node_modules/@pneuma/runtime`（含 `.d.ts` 桩）。
- `tsconfig.paths` 映射；`package.json` 的 build 脚本串上生成步骤。
- 55 个插件文件 357 处 `../core/x.js` → `@pneuma/runtime/core/x.js`。
- 单实例自检：启动时比对 `plugin-registry` 与 `command-runner` 的模块指纹（同一实例才继续）。

完成证据：完整门禁全绿（148 条探针与现在同样的通过集合）；`grep -r "from '../core/" src/plugins` 零命中；启动日志与 0.8.1 存档逐行 diff 一致。

### P2 加载器对齐（5 天）

- 子路径行：用 Node 自己的解析（`createRequire(profile 的 package.json).resolve(name)`），不手写 exports 展开——手写会漏 conditions、通配、`#imports`。
- 身份 = 行 id，贯通 `mounted` / `plugins.json` / 插件中心 / `plugin_manager` 工具。
- 安装锚点 + `pinned/overridable`；解析钩子无条件覆盖 `@pneuma/*` 与 `@deepseek-ai/*`（不再依赖 dsh-compat）。
- `pneuma.settingsSection` 写进 meta；`defaultDisabled` 由行 `disabled` 决定，**disabled 行也要登记进目录**（现在直接 `continue`，插件中心看不到）。
- `plugins.json`：新旧键双读、惰性写回；**文件存在但解析失败时拒绝写盘**（现在会整份覆盖成空，`plugin-registry.ts:187`+ `:193`）。
- 行 id 重复：套完 patch 后重复即 fatal（现在后写覆盖前写，`plugin-patch.ts:129-135`）。

完成证据：四条新探针（子路径 / 身份 / 锚点 / 旧键迁移三样本）+ 用真 dsh-ops 包起一行子路径；`plugins.json` 三样本迁移后逐键相等。

### P3 功能包化（10–14 天，可并行）

- 56 个包，顺序：核心服务 → 官方可开关 → 未登记的 4 个 → 3 个入口插件。
- 每包 `package.json` + `cordis.patch.yml` + `index.ts`（源码从 `src/packages/x/index.ts` 搬进 `src/packages/x/index.ts`）。
- 依赖一律用行/插件的 `inject` 表达（行序不承载加载语义）；实在表达不了的三处（approval 要在 mode 首次广播前就位、transcript 要在 plan 恢复前清空、memory 要在 agent 之后）用行序兜底，patch 注释写明原因并用探针钉住。
- 共享常量下沉到 runtime/contract：browser 的 `CLOUD_METADATA_HOSTS`、webserver 的 `UI_EVENTS_PROTOCOL_VERSION`；`tui.ts` 对 `../app/App.js` 的引用改成构造参数。
- 三张表（`BUILTIN_PLUGINS`/`OFFICIAL_PLUGINS`/`OFFICIAL_OBJECTS`）退役。
- 20 个探针的 25 处 `lib/plugins/*` 改指向 `lib/packages/*`。

完成证据：golden 三份清单逐项 diff 为空；56 个包各有一条「能挂上」的探针；停用任意一行重启有明确告警；`plugin-model-check --strict` 绿。

### P4 界面半边归位（4–6 天）

- `ui-shell/src/plugins/<id>` 搬进 `src/packages/<id>/ui/`（`ui-shell` 只留壳与共享库）。
- `build-plugins.mjs` 改为读包清单，产物落点不变。
- 19 个单元里只有 browser / team 与宿主插件同名，其余按「界面单元独立包」处理（`@pneuma/ui-*` 或挂在最相近的功能包下），映射表写进契约。

完成证据：界面清单逐项与 golden 一致；`@dsc/ui` 版本闸对第三方仍生效；`ui-plugin-test.mjs` 绿。

### P5 桌面发布形态与换包 e2e（4 天）

- `prepare-runtime.mjs`：携带 `lib/packages`、`lib/node_modules/@pneuma/runtime`、默认 profile 模板 `profiles/default/`；闭包扫描跳过 `@pneuma/*`（它在 lib 内，不是外部依赖）。
- 首启：把模板铺到 `~/.dsc/profiles/default`（已存在不覆盖），并**写入 `config.yaml` 的 `profile: default`**（不写等于没铺，`profile-dir.ts:26` 默认 null）。
- `ops/worker.ts` 的 worker 查找补 `$DSC_HOME/profiles/<名字>/node_modules/dsh-ops`。
- `scripts/plugin-swap-e2e.mjs` 进 `check:all`：换包 / 删包 / 换 pinned 包三种断言。

完成证据：三条 e2e 全过；桌面打包后启动一次，插件清单与 golden 一致。

合计 **27–36 个工作日**（单人）；按四条线并行，日历约 14–20 天。并行不减少验收工作量——每期门禁由主控串行跑。

## 5. 半成品防线

1. `plugin-model-check --strict`：0 包、行 id 重复、kernel/boot/headless 残留静态 import，任一即红。
2. 破坏性自测：每期演示一次「故意写错 → 报错清楚」（删包、错行 id、版本不满足、坏 `plugins.json`）。
3. golden diff：插件清单 / 设置分区 / 界面清单三份快照，P3、P4 结束各 diff 一次。
4. 回滚兼容：0.8.1 读新 `plugins.json` 不崩（多出的键忽略）；新版本读 0.8.1 的旧键不丢配置。
5. 一期一提交，提交信息写清「这一期之后哪些行为变了」，不夹带重构。

## 6. 已知坑（P0 就要写进契约）

| 坑 | 位置 | 对策 |
|---|---|---|
| 解析授权绑在 dsh-compat | `plugin-loader.ts:474` | P2 解耦 |
| 解析钩子基点按文件深度算 | `dsh-compat/resolve-hook.ts:58` | 改成显式传入运行时根 |
| `contract/runtime.ts:243` 公布 `@dsc/runtime/contract.js` | 同上 | 保留该名，不改 |
| 行 id 重复静默覆盖 | `plugin-patch.ts:129-135` | fatal |
| 坏 `plugins.json` 会写空 | `plugin-registry.ts:187/193` | 拒绝写盘 |
| disabled 行不进目录 | `plugin-loader.ts:544` | 登记目录、挂载才跳过 |
| `ctx.get('lsp')` 无类型 | `services/types.ts` | 补声明 |
| 设置分区齿轮靠 meta | `kernel.ts:93-336` | 改 `pneuma.settingsSection` |
| 沙箱靠模块级 Map | `core/tools/command-runner.ts:75` | 单实例自检 |
| 换包后 `exports` 不重新解析、pinned 包换版要重打包 | dsh 同样如此 | e2e 用重启，不承诺热换 |

## 7. 门禁

```
pnpm run typecheck && pnpm --dir desktop typecheck
pnpm run build && pnpm run build:ui
pnpm run check:style --changed
pnpm run check:plugin                # 模型检查 + 包标准八条 + 清单快照 + 加载器 92 条 + list 15 条 + 换包 e2e 17 条
node scripts/check-core.mjs          # 97 套（hmr-dispose-test、plugin-hot-update-test 自动进来）
node scripts/ops-test.mjs
pnpm run check:dsh
```

`check:plugin` 的五个脚本分工：`plugin-model-check --strict`（结构：包数 / 行数 / 内核行数 / 缺口）、
`plugin-standard-check`（包标准八条硬项：清单字段 / exports 键集 / 清单本地化 / 行 / 入口导出 / 包间 import / order 撞号 / 文档与测试；模块级可变状态仍只提示）、
`plugin-inventory-check`（清单与该在的样子的逐项 diff）、`plugin-model-test`（加载器行为）、
`plugin-list-test`（用户看得见的那一屏）、`plugin-swap-e2e`（真进程里换包 / 覆盖 / 删包）。

## 8. 已裁决的偏差（不再当"范围外"用）

早期这份计划写过一版"范围外"清单，2026-11-04 用户裁决：**不设"明确不做"，目标是完全对齐 dsh 的插件结构，功能只增不减。** 下面四条因此改成"现状 + 差距 + 归到哪一期"，而不是"永不做"。

| 原"范围外" | 现状 | 归到哪期 |
|---|---|---|
| 不发布第二个 npm 包、不建运行时工作区包 | `@pneuma/runtime` 仍是构建生成的单实例适配包（`docs/plugin-model.md:97`） | Q6：包形态对齐（各包可独立发布的字段齐全）；运行时适配包是否保留，看 Q4 搬完之后 `lib/core` 还剩多少共享模块 |
| 不实现 `!!js` 表达式 | loader 读 patch 时一律拒绝（`plugin-model.md:68`） | **待用户裁决**：dsh 会求值（`vendor/include/src/index.ts:9-23`）。这是"插件包能在宿主进程里执行任意表达式"的安全边界，不对齐会缺一块能力，对齐会把安全模型打开一个口子 |
| 不做插件市场安装 UI | 只有 `numa plugin` 命令行 | Q6 之后单独立项（dsh 有 `apps/plugin-market-generator` + `plugin-manager` 的安装/卸载/升级） |
| 不改界面信息架构，只换归属 | 19 个界面单元已是 `src/packages/ui-<id>/` 的独立包 | Q3 已落地：每个界面单元一个包（薄宿主半 + `ui/`），信息架构没动，只动归属 |

## 9. 进度（2026-11-03）

| 期 | 状态 | 提交 | 备注 |
|---|---|---|---|
| P0 契约与基线 | 完成 | `19e0f92` | 契约、model-check、0.8.1 基线 |
| P1 运行时适配包 | 完成 | `3de6f11` | 577 个桩；481 处 import 改写；单实例自检 |
| P2 加载器对齐 | 完成 | 见 P3 提交 | 子路径行、行 id 身份、锚点、解析表、plugins.json 双键与拒写 |
| P3 功能包化 | 完成 | 见本次提交 | 56 个包；kernel 100 行；boot/headless 只传 surface |
| P4 界面半边 | 未开始 | — | 界面源码仍在 `ui-shell/src/plugins/` |
| P5 桌面发布形态 | 未开始 | — | dsc-core 携带 packages 与默认 profile |

P3 的三个已知偏差（都已写进契约 §11）：

1. 「运行时适配器」插件包名改为 `@pneuma/runtime-adapter`，行 id 仍是 `runtime`；
2. 原生包（行名 `@pneuma/*`）跳过 dsh 插件的服务名判定，也不套 dsh 工具兼容面；
3. `surface` 默认 `none`：不传 surface 时不挂 `tui` / `host-stdio` / `remote` 三行，
   探针直接 `createKernel` 不会被 TUI 或 stdio 拖住。

## 10. 进度（2026-11-03 收尾）

| 期 | 状态 | 提交 |
|---|---|---|
| P0 契约与基线 | 完成 | `19e0f92` |
| P1 运行时适配包 | 完成 | `3de6f11` |
| P2 加载器对齐 | 完成 | `52c48be` |
| P3 功能包化（56 个） | 完成 | `52c48be` |
| P4 界面半边归位（19 个） | 完成 | 见 P4/P5 提交 |
| P5 桌面发布形态与换包 e2e | 完成 | 见 P4/P5 提交 |

验收证据（2026-11-03）：

- `plugin-model-check --strict`：56 包 / 56 行 / kernel 100 行 / 0 缺口
- `plugin-model-test`：74/74；`plugin-swap-e2e`：10/10（换包、删可选包、删核心包）
- `check:plugin` 已进 `check:all`
- 打包产物冒烟：`desktop/runtime-staging/dsc-core` 起来后 19 个界面插件登记、0 个插件加载失败、
  默认 profile 自动铺好
- 界面产物：19 份，与 0.8.1 逐字节一致（构建日志「重写 0 份」）

P4 的实现取舍：界面包的源码放在 `ui-shell/src/packages/ui-<id>/`（React/xterm 依赖与构建都在壳里），
产物落点与 id 不变；宿主功能包在 `src/packages/<id>/`。两者都是包、都走同一份 `package.json` 契约。

## 11. 收尾（2026-11-03 晚）：把「半成品」那几处补齐

P5 交付后复核出来的四件事，全部有现场证据，逐条修完：

| 问题 | 现场 | 修法 | 验证 |
|---|---|---|---|
| 应用自带行不查 profile，37 个 `overridable` 包的用户覆盖永远不生效 | 把改过的 `@pneuma/todo` 放进 profile，启动后 `globalThis.__MARK` 仍是 undefined | `RowMountContext` 拆出 `overrideDir`，与「相对路径基准」分开；profile 的 `node_modules` 也交给解析钩子 | `plugin-model-test` 5 条 + e2e 2 条 |
| 行级 `engines.pneuma` 闸没实现 | `enginesProblem` 只在读组合包时调一次 | 新增 `pneumaEnginesProblem`，挂行前判；不满足登记 problem + 跳过；`compatibility.json` 可豁免 | `plugin-model-test` 12 条 |
| `numa plugin list` 看不出每行用的是谁 | 只有一行「应用自带 <root>」 | 行尾标 `← profile 覆盖` / pinned 让路说明，版本显示生效那份，末尾汇总覆盖行数 | `plugin-list-test` 15 条 |
| 换包 e2e 其实用了真实家目录；清单快照只导出不比对 | `spawnSync` 没传 env；`docs/baseline/0.8.1` 之后没有新快照 | e2e 把 `DSC_HOME` 指到副本并加 pinned 两个方向；新增 `plugin-inventory-check` + `docs/baseline/0.9.0/inventory.json` | e2e 17 条 + 清单闸（含反向自测） |

验收数字（2026-11-03 晚）：`check:plugin` 全绿——56 包 / 56 行 / kernel 103 行 / 0 缺口；清单 55 插件 /
24 设置分区 / 19 界面单元与快照一致；加载器 92 PASS；list 15 PASS；换包 e2e 17 PASS。

**这次算不算「完」**：判定标准 1–5 现在都有可复核的证据（第 5 条的两个方向都在真进程里跑了）。

---

## 12. 第二波（0.9.x）：完全对齐 dsh 的插件结构

第一波把"装配行"包化了，第二波解决三件没做完的事：**实现还在 core、界面半边不在包里、代码不能热更**。

### 12.1 目标（四条，逐条可验收）

| # | 目标 | 现在的反证 |
|---|---|---|
| 1 | **每个界面单元一个包**（薄宿主半 + `ui/`），宿主功能与界面各自成包 | 已落地：75 个包 = 56 宿主 + 19 界面单元，各自一行；宿主包里不再声明 `dsh.client` |
| 2 | **功能实现在包里**，core 只留内核 | 55/56 个包 `import '@pneuma/runtime/core/*'`，共 363 处；core 52,813 行 vs 包 25,908 行 |
| 3 | **改包代码不重启即生效**，失败保留旧版本 | `?t=mtime` 打在桩上被架空（`lib/node_modules/@pneuma/<id>/index.js` 只有一行 `export *`）；`mountRow` 幂等（`plugin-loader.ts:924`） |
| 4 | **开发标准与 dsh 一致** | 0 个包有 README、0 个包有包内测试；停用插件不注销注册（40 处 `ctx.tools.register` 仅 2 处 `ctx.effect`） |

### 12.2 目标包形态（镜像 dsh `packages/client/ui-layout`）

```
src/packages/<id>/
  package.json          # exports: "." 宿主半、"./client" 界面半、"./locale/*.json"
  cordis.patch.yml      # 行（不变）
  index.ts              # 宿主半边
  client/               # 界面半边（React），产物仍落 lib/ui/plugins/<id>/client.js
  locale/en.json        # 界面文案（dsh 同款）
  README.md             # 两段：Model Experience / Known Limitations
  tests/                # 包级测试（走真实组合，不只手搓 ctx.plugin）
```

`package.json` 关键字段（对齐 dsh `package-surface.md:79` 的标准键集）：

| 字段 | dsh | numa 目标 |
|---|---|---|
| `exports["."]` | `{types, default}` | 同 |
| `exports["./client"]` | `{types, default}` | 新增（界面半边的唯一入口） |
| `exports["./locale/*.json"]` | 有 | 新增 |
| `dsh.client` / `pneuma.client` | `{platform, inject, immediately}` | 统一写 `pneuma.client`（`dsh.client` 继续兼容读） |
| `engines` | `engines.dsh` | `engines.pneuma`（已有） |
| `private` / `version` | `private:true` + 与根同版本 | 同（当前 `0.0.0` 是构建期改写，要改成与根一致） |

### 12.3 分期

| 期 | 内容 | 验收（可复核） |
|---|---|---|
| **Q0** | 契约与计划改写：删掉"不承诺热换""明确不做"；补壳层口径 | 文档与代码一致，无自相矛盾条目 |
| **Q1** | 销毁即注销：所有注册经 `ctx.effect`；新增"停用后必须消失"的探针 | 停用 `todo` 后 `todo_write` 不在 `visible()`；`settings.sections()` 不抛错；停用 `goal/plan/ask` 同理 |
| **Q2** | 代码热更新：解析钩子代数戳 + 文件监听（去抖）+ 单行重挂；**先导入新的成功再停旧的，失败保留旧版本** | 改 `lib/packages/todo/index.js` 不重启即生效；故意写坏语法后旧版本继续工作且报一条失败 |
| **Q3** | 一个包两半边：19 个界面包并入宿主包 | 插件清单从 19 份并到 56 份；界面产物逐字节不变 |
| **Q4** | 实现搬包：core 的实现按域搬进对应包 | core 行数降到内核线；搬完的包能单独替换（不再依赖 core 里的同名实现） |
| **Q5** | 壳层包化：`ui-layout`/`ui-primitives`/`ui-slots`/`ui-dockkit`/`ui-renderer`、TUI 组件树、CLI 子命令 | 五层各一个**库包**（`pneuma.library`、无装配行），TUI 一个功能包，样式随入口走；`ui-shell/` 只剩构建装置。别名落点必须正好是包内 `ui/index.ts`，包间零相对 import（§12.10） |
| **Q6** | 包形态与开发标准：README 两段、包级 `tests/`、`exports` 标准键集、导出形状、可发布字段 | 新包缺项即红（门禁）；20 条检查清单全绿 |

### 12.4 热更新的实现路线（与 dsh 的差异）

dsh 走 Node 内部接口（`loadCache` / `require.cache` / `ResolveCache` 打补丁），代价是要 `--expose-internals`、要对 Node 版本敏感。numa 走另一条：

1. `registerHooks` 的 resolve 钩子已经能看到包内部的相对 `import`（实测：`./real.mjs` 会进来）；
2. 给 `lib/packages/**` 打**代数戳** `?g=N`：`N=0` 不打（启动时与探针共享同一实例，保住 `@pneuma/runtime` 单实例约定），换代时 `N+1`；
3. 桩 `export * from '...?g=N'` 重新求值 → 拿到新代码，不碰任何 Node 内部接口。

失败语义按用户 2026-11-04 裁决：**先导入新模块成功，再停旧 fiber；失败保留旧版本**（dsh 是逐出后失败即失败，旧代码不回来）。

### 12.5 Q3 界面半边归位：已完成（2026-11-04）

**最终形态（用户裁决，照 dsh）**：一个界面单元 = 一个**独立的包**，`src/packages/ui-<id>/`，
宿主半边是空的 `apply() {}`（只为进 Loader、拿到自己那一行与开关），界面半边在 `ui/`。
**不并进宿主功能包**——两个面板挤一个包，它们的开关就绑在一起，关一个会连带关另一个；
dsh 也是每个界面单元一个包（`dsh-client-ui-*`），host 功能另包。

为什么换位置可以很便宜：内置 id 由**产物目录名**决定（`src/core/ui-bundles.ts:355`），
包名叫 `ui-<id>` 只是把 `ui-` 前缀剥掉（`build-plugins.mjs` 的 `hostIdOf()`），
产物仍是 `lib/ui/plugins/<id>/client.js`——启动图条目、停用记录、探针全都不用改。

| 项 | 结果 |
|---|---|
| 包数 / 行数 | 56 → **75**（19 个界面单元各一个包、各一行） |
| 19 份 `client.js` | sha256 与改造前**逐个逐字节一致**（含 settings 那份 222KB 的） |
| 启动图整图 rev | `be3b5638799b` 未变 |
| order | 19 个单元统一占 `350–368` 专用段（按 id 字典序），界面行不做任何事 |
| 开关 | 产物 id `<id>` ↔ 行 id `ui-<id>`，换算只在 `builtinSwitchKey()`；`UiArtifactCache.table()` 取表时按开关切 |
| 行 id 约定 | `cordis.patch.yml` 必须写 `ui-<id>`，写成 `<id>` 就永远关不掉 |
| 残留 | `ui-shell/src/packages/` 已删空；构建脚本保留旧根兜底与 `resolveUiHalf` 三段查找 |

**过程中踩到的三个坑**（都写进注释了）：
1. **tsc 按文件位置找 node_modules**，不看 tsconfig 在哪。源码一搬出 `ui-shell`，`build:ui` 第一步 tsc
   就红在 `react-dom` 类型上，解法是根 devDeps 补类型包。
2. **两份 React**：解析起点从 `ui-shell` 变成仓库根，workspace 下会落到两个路径，加了 dedupe。
3. **`settings` 的 client.js 内联了 `qrcode`**（它不在壳的 platform-modules 里），根 devDeps 的版本
   与 `ui-shell` 差一格，sha256 立刻变——这是「字节一致」这条验收线最容易被无声破坏的地方。

**还没做的**：包级 README / `tests/` 仍缺（Q6）；界面包现在是"空宿主半"，将来若要给它真正的
宿主逻辑（例如预取数据），行已经有了，不用再改结构。

### 12.6 Q5 壳层包化：边界

dsh 的答案分三层：页面内核 → 模块系统（唯一 bootstrap，只有 `dsh-client-modules` 一个包是 parser-blocking）→ 其余全是插件（`ui-renderer` 声明 `immediately:true`，`ui-layout` 带 5 条 inject）。种子包 `ui-slots`/`ui-primitives`/`ui-dockkit` **是包但不当插件**——别人要 require 同一份实例。

numa 对应：
- **必须留在壳里**：`boot.ts` 的 MODULES 表与取启动图那一段（必须在第一个 bundle 执行前存在）；
- **可变成插件**：`ui-layout`（先拆 `@dsc/ui` 的 static 转出，否则两份实现）、`ui-renderer` 的「取图 + 建会话」（前提是把 App 的 7 个 props 改成服务）；
- **留在种子表**：`ui-slots`/`ui-primitives`/`ui-dockkit`；
- **TUI**：dsh 没有对应物（无 ink 依赖、无 TUI 文档），拆包前要先做组件树分层、槽位表扩到 4–5 个、状态来源从「整份 DscRuntime 当 prop」改成服务订阅；
- **CLI**：435 行，已搬成 `@pneuma/cli` **库包**（`src/packages/cli/`）。为什么是库包：两个子命令在**内核起来之前**跑（`bin/dsc.js` 直接 spawn 产物），给它一行装配只会得到一个「开不开都一样」的开关。`index.ts` 导出 `CLI_ENTRIES`（子命令 → 产物文件名），`bin/dsc.js` 仍零依赖、只拼路径。

### 12.7 Q4 实现搬包：硬规则与分档（2026-11-04 勘查）

实测口径：`src/core` 170 个 `.ts`、53,586 行；55 个包 import `@pneuma/runtime/core/*` 共 375 处（134 个不同模块）。

**硬规则（比 import 路径重要得多）**：§14 的代数戳只给 `lib/packages/**` 打，`lib/core/**` 与 `@pneuma/runtime/**` 永不打。所以**模块一旦搬进包，它就成了热更换代对象**；只要内核还 import 它，换代后内核握着旧实例、包拿到新实例。`core/tools/command-runner.ts:75` 的模块级 Map 不会「自然消失」，会变成两份——`bash.ts:18` 与 `sandbox/index.ts:40` 分居两侧，就是沙箱 fail-open。

因此：**只先搬「零内核引用」的那一档**；「解耦后可搬」的那一档必须先让内核不再 import 它，再搬。

| 档 | 文件 / 行数 | 判据 |
|---|---|---|
| 可直接搬 | 39 个 / 14,920 行 | 零内核引用（sandbox 17、lsp 7、self-improve 3、computer-use 1、ops 3、approval-floor 1、lifecycle-hooks 1、microcompact 1、settings 2、commands 1、prompt 1、surfaces 1） |
| 解耦后可搬 | 40 个 / 13,044 行 | 内核有引用，要先断（browser/cdp 7、dsh-compat 9、schedule 3、tools-default 4、remote 8、memory 2、mcp 1、approval 2、todo 1、goal 1、git 2） |
| 留内核 | 91 个 / 25,792 行 | 加载器、事件总线、路径策略、工具注册表、会话、压缩、UI 装载等 |

**说明符处置**：直接改 import 要动约 620 处（包 375 + ui/services/boot 63 + 探针 185），还得扩 `build-runtime-package.mjs` 的 ROOTS。推荐**留一行转发桩**：`src/core/x.ts` = `export * from '../packages/<id>/x.js'`，0 处调用方改动——但要注意：转发桩本身在 `lib/core`（不戳），所以被转发模块的**换代可见性**只对包侧生效，内核侧仍是旧实例。这正是上面那条硬规则要挡住的情形。

**只用环**：3 个 2-环（git-info↔services/types、learnings/skill-write↔learnings/ledger、lsp/normalize↔lsp/client）。真正的耦合是内核单点入口：`path-policy.ts` 被 41 个 core 文件引用、`tools.ts` 16 个、`llm.ts` 14 个。

**反面案例（看着能搬其实不能）**：`dsh-compat/resolve-hook.ts`（plugin-loader 直接 import，是加载器本体）、`cdp/transport.ts`（dock-session、host-browser-link 直接 import）、`tools/command-runner.ts`（注册表本体）、`goal.ts`（session.ts 与 services/types 引它）、`memory.ts`（类型被 services/types 引用且带跨会话缓存）。

**第一批**：sandbox（17 文件 5,755 行，占 core 的 10.7%，7 处包引用、2 个探针、零内核引用）。它同时验证「内核注册表 + 包实现」这条缝。

### 12.8 Q6 包形态与开发标准：检查清单

对齐 dsh 的 `packages/AGENTS.md` 与 `docs/defensive-patterns/package-surface.md`，落到 numa 的写法。**能在门禁里机器判的必须机器判**，判不了的在评审时逐条勾。

| # | 要求 | 现在 | 怎么验 |
|---|---|---|---|
| 1 | 入口只导出 `name`/`inject`/`Config`/`apply`（或 default 导出服务类），两种形状不混用 | loader 两种都收，不强制 | `plugin-model-check` 加一条静态检查 |
| 2 | 可选服务一律 `ctx.get(name)`，不进 `inject` | 未强制 | 评审 |
| 3 | 每个注册都有 disposer（`ctx.effect` 或显式接退订），并有「停用即消失」的断言 | 139 处已改，探针 34 条 | `hmr-dispose-test` 扩成覆盖全部可停用行 |
| 4 | `package.json` 字段齐全：`version` 与根一致、`type:module`、`exports` 含 `.`/`./client`/`./package.json`/`./locale/*.json` | 源码是 `0.0.0`、`exports` 只有 `.` | 新门禁脚本逐包比对 |
| 5 | 界面半边写在 `pneuma.client`（`dsh.client` 继续兼容读），值域 `platform/api/inject/immediately/phase` | 19 个界面包写的是 `dsh.client` | 门禁比对键名 |
| 6 | 包级 `tests/`，产品可见的插件要有走 Loader 的真实组合测试 | 0 个包有包内测试（全在仓库级 `scripts/`） | 分批迁，先给新包立规矩 |
| 7 | `README.md` 两段：Model Experience / Known Limitations | 0 个包有 README | 门禁检查两段标题 |
| 8 | 禁止模块级可变单例（`core/tools/command-runner.ts` 属内核，是例外） | 少数包有模块级缓存 | 评审 + 静态扫描 |
| 9 | 包间零直接 import（只走服务） | 0 处，保持 | 门禁加一条反向断言 |

**顺序**：第 1、4、5、7 条可先做静态门禁（不动行为），第 3 条已经落地，第 6 条跟着 Q4 逐批走。

### 12.9 Q4 进度：实现搬包（2026-11-04，第二、三批）

按 §12.7 的硬规则只搬「零内核引用」这一档。每搬一个，`src/core/x.ts` 就变成一行转发桩，调用方一行不改。

| 批 | 文件 → 包 | 行数 |
|---|---|---|
| 一 | sandbox 17 件、lsp 7 件、self-improve 3 件、computer-use / ops / approval-floor / lifecycle-hooks / microcompact / settings / commands / prompt / surfaces 各若干 | 见 §9–§11 |
| 二 | `mcp.ts`→`mcp`、`memory.ts`/`memory-eval.ts`→`memory`、`tools/{bash,image-tool,search-tools}.ts`→`tools-default`、`call-meaning.ts`/`approval.ts`→`approval`、`agent-roles.ts`→`subagent` | 11 个文件 / 5,954 行，桩 11 行 |
| 三 | `session-index.ts`→`session-search`、`tool-search.ts`→`tool-search` | 2 个文件 / 1,336 行 |
| 四（Q4-b2） | `hooks`/`compact`/`prompt`/`loop`/`modes`→`session-core`；`permission-scope`/`permission-presets`→`permission-core`；`presets`/`market`→`config-core`；`commands-completion`→`commands-core` | 10 个文件 → 4 个库包，71 处说明符 |

**第四批为什么可以直接搬（与第三批的硬规则不冲突）**： §12.7 挡的是「内核还 import 它」的模块——那种一搬就成两份实例。
这 10 个逐个 grep 过：**没有任何 `src/core` 文件 import 它们**，引用方全在 `src/packages/*` 与 `src/services/*`。
搬进库包后它们多了一个换代资格，而同一个库被所有引用方共读，换代时 `registerLibraryGenerationRoots` 会把这些行一起重挂，
不存在「一半新一半旧」。**不留转发桩**：`src/core/<模块>.ts` 直接消失（桩只会留下一份不换代的老副本）。

**为什么 `tools/command-runner.ts` 搬不走**：它有一张模块级 Map（正在跑的命令）。`bash.ts` 与 `sandbox/index.ts` 必须拿到**同一个**实例，而代数戳只打在 `lib/packages/**` 上——搬进包就等于给它换代资格，内核算旧表、包算新表，沙箱判定会 fail-open。所以 `bash.ts` 搬进包、`command-runner` 留在内核，包用相对路径 import 内核那一份（`packages/tools-default/bash.ts:18`）。

**这一批暴露的第三个坑：直读源码的探针会被转发桩断掉。** 四支探针读 `src/core/*.ts` 的**文本**做断言（`session-open-in-test`、`ui-status-panel-test`、`readme-test`），还有一支直接 import 源码（`memory-eval-test`）。桩只有一行，断言要么假失败、要么 `ERR_MODULE_NOT_FOUND`。修法不是逐个改路径（每搬一个文件就要改一次），而是加一支 `scripts/_source.mjs`：识别「整份文件只有一行再导出」的桩，跟到真文件再给文本 / 再 import。多层转发也跟，环有 8 层上限；断言内容一个字没改。

顺带记一个容易误判的现象：Node 的类型擦除**不会**把源码里 `export * from './x.js'` 回落到 `./x.ts`。`microcompact-test` 之所以没断，是因为它自己注册了 resolve 钩子（`scripts/microcompact-test.mjs:41`），不是 Node 默认行为。

### 12.10 Q5 壳层包化：五个层是**库包**，不是装配行（2026-11-04 裁决）

**形态**：`src/packages/ui-{layout,primitives,slots,renderer,dockkit}/`，各有 `package.json`（`private:true`、`pneuma.library:true`、`version` 随根）与 `index.ts` 半（13 行、空 `apply`），**没有** `cordis.patch.yml`、**不占**装配行。真实现在 `ui/`，`ui/index.ts` 是出口桶（barrel）。

**为什么不做成行**（这里的取舍与 §12.5 的界面单元相反，理由必须写清）：

1. numa 的界面是**一个预构建 bundle**，不是运行期按包拼装。给壳层加一行，得到的是一个开关：打开等于现在的行为，关掉等于白屏——它不改变任何东西，属于"看起来可停用，其实不可停用"，比没有更糟。
2. `ui-primitives` 若拆成独立产物，它导出的 React context 会在 19 个插件 bundle 里各内联一份，同一棵树上出现两个 Provider：表现为"状态改了、组件不重渲染"，排查成本极高。dsh 同样把种子包排除在插件产物之外。
3. 热更新能力不靠"是不是行"来获得：`registerLibraryGenerationRoots`（`src/core/plugin-loader.ts:193`）会把库包目录登记为换代根，引用它的行在库改动后被重新挂载。所以库包照样热更新，只是它自己没有开关。

**两个名字**（维护陷阱，`[5b]` 已钉）：

| 名字 | 用途 | 出处 |
|---|---|---|
| `@pneuma/ui-<id>` | 包身份：loader/注册表/清单认它 | 各包 `package.json` 的 `name` |
| `@dsc/ui-<id>` | 作者面：插件与壳内部 import 用它 | `ui-shell/packages.json` + `ui-shell/tsconfig.json` 的 `paths` |

别名必须**正好**落在 `src/packages/ui-<id>/ui/index.ts`：落点写歪成包根也编译得过去，代价是类型面与运行期实现分家。

**这一批踩到的坑**：

1. **tsc 按文件位置找 `node_modules`**，不看 tsconfig 在哪。源码搬到 `src/packages/**` 后，`react-dom` / `shiki` / `papaparse` / `xlsx` / `pdfjs-dist` 的类型全部解析失败（81 条 TS2307）。解法是把这 9 个包补进**根** devDeps，而不是给 tsconfig 加 `paths`——后者能让 tsc 假绿，vite 构建仍旧红。
2. **样式得跟着入口走**。`main.tsx` 原来 import `../legacy/*.css`，搬到 `ui-renderer/ui/` 后这条相对路径指到了空处（vite: `Could not resolve "../legacy/base.css"`）。四份 legacy 样式、补充层 `styles.css`、色板兜底生成物一起搬进 `src/packages/ui-renderer/ui/styles/`，色板生成脚本的 `TOKENS_PATH`/`OUT_PATH` 同步改。
3. **26 支探针按路径读样式源码做断言**（`ui-attach-preview-test`、`ui-color-fallback-test` 等）。搬家必须同批改，否则断的是"断言读不到文件"，而不是样式回归。

**`ui-shell/` 现在只剩构建装置**：`packages.json`（别名唯一真源）、`tsconfig.json`、`vite.config.ts`、`build-plugins.mjs`、`build-types.mjs`、`index.html`、`src/plugin-api.ts`（`@dsc/ui` 的类型面）、`src/slot-contract.typecheck.tsx`。这里不是"代码放错了地方"，是"壳的构建配方放这里"——产物落点、产物 id 换算、种子表都在其中。
### 12.11 Q6 落地：八条硬项与一处故意不对齐（2026-11-04）

**已升成硬项（不通过就退出 1）**：

| 项 | 判据 | 现在 |
|---|---|---|
| 清单字段 | name / 0.0.0 / private / type:module / exports 两个基础键 / engines.pneuma / cordis peer | 81/81 |
| exports 键集 | 只许 `.`、`./client`、`./package.json`、`./locale/*.json`；库包额外许 `./x.js`，且键与目标一字不差 | 81/81 |
| 行 id 与 name | cordis.patch.yml 恰好一条 insert，行 id = 目录名，行 name = 包名 | 75/75 |
| 入口导出 | index.ts 有 apply / default / 恰好一个带 apply 的插件对象 | 75/75 |
| 依赖方向 | 功能→库允许；功能→功能、库→任何包、core→任何包都红（含 import type） | 81/81 |
| order 撞号 | 每个功能包的 pneuma.order 唯一 | 75/75 |
| 清单本地化 | 声明 `./locale/*.json` 就必须真有译本，且 title / description 非空 | 87/87 |
| 文档与测试 | README 有 Model Experience / Known Limitations 两节；tests/ 下至少一个 *.test.mjs | 87/87（87 个用例 / 437 条断言） |

第 7 项这次从「待办只提示」升级成硬项。理由是这两件事都不是有空再补的装饰：README 两段是给**模型**看的（这段代码在什么场景下被用到、边界在哪），tests 是给**改这个包的人**看的护栏。只有目录没有文件的那种「看起来有测试」最坏，所以判据落在文件上，不看目录。

**故意不对齐 dsh 的两处**（理由写在这，避免下次又被当成遗漏）：

1. ~~源码清单的 version 固定 0.0.0~~ → **2026-11-04 晚改为与 dsh 一致**：87 个包各写真实版本号（都等于根 `0.8.1`），发版时 `node scripts/sync-versions.mjs --write` 一起推，门禁只认「等于根」。当时判断「只有根一个版本源更省事」，用户裁决对齐 dsh；实际代价也就是一条命令，换来的是「随便打开哪个包，都看得出它属于哪一版」。
2. **写 pneuma.client，读 pneuma.client 与 dsh.client 两处**：我们自己那 19 个界面包写 pneuma.client（本项目命名空间），读的一侧同时认 dsh.client——真实 dsh 生态里有 90 个包写的是 dsh.client，那是别人发布的，不能要求他们改。读两处、写一处，兼容但不将就。

### 12.12 与 dsh 完全对齐的四件（2026-11-04 晚，用户裁决「全做」）

| 项 | dsh 的做法 | numa 现在 | 代价 / 说明 |
|---|---|---|---|
| 界面契约包 | `ui-slots` / `ui-primitives` / `ui-dockkit` 是包不是插件；`ui-layout` / `ui-renderer` 是插件 | `src/ui/` 搬成 `@pneuma/ui-core` 库包（14 个文件），`manifest.ts` 下沉成 `src/core/ui-manifest.ts`；别名 `@dsc/ui-core` 落点改到包内 `index.ts` | core 要用 `manifest.ts`，而「core → 包」是禁的；把启动图那部分留在内核，才既包化又不反向依赖 |
| 壳层是插件 | `ui-layout` 是普通客户端插件（inject 5、无 immediately）；`ui-renderer` 是 `immediately: true` 的引导 | `ui-layout` 去掉 `pneuma.library`，加 `cordis.patch.yml`（order 349、`phase: early`）与 `./client`；`ui-renderer` 声明 `pneuma.client.immediately`、**不占行** | 停用 layout 后壳画诊断页（说清哪一行没了、去哪打开），不白屏；骨架代码仍在壳的 app bundle 里，停用省的是「装这一行」而不是下载量 |
| 逐包版本号 | 370 个包各写真实版本 | 87 个包全部写 `0.8.1`，`node scripts/sync-versions.mjs --write` 一起推，门禁只认「等于根」 | 发版时一条命令推 87 处，漏一个当场红 |
| 清单本地化 | `locale/*.json` + `exports['./locale/*.json']` | 87 个包各有 `locale/en.json`（title / description），`config.yaml` 的 `language:` 决定读哪份，缺字段逐条回落中文 | 只到「清单两行字」；界面内文案仍是中文（写在各包 README 的 Known Limitations 里） |

**为什么不把骨架实现也搬进 layout 的 bundle**：`@dsc/ui`（`ui-shell/src/plugin-api.ts`）把 layout 的读 hook 整包转出给插件用。bundle 若内联一份，插件的 `useHostSnapshot` 与 App 会落在两个 `RuntimeContext` 里，首渲染直接抛「必须在 RuntimeProvider 里用」。所以 layout 同时是**平台种子**（`platform-modules.json` + `boot.ts` 的 MODULES），bundle 只是薄入口（1.2 KB）。这与 dsh 把 `ui-slots` 列为种子包是同一个道理。

**`ui-renderer` 为什么不给行**：它是 `index.html` 里唯一 parser-blocking 的脚本，与 dsh 的 `dsh-client-modules` 同位。给它一行，关掉的结果是整页白屏——那不是开关，是断电。

### 12.13 数字对账（避免下次把正常差值当回归）

| 数字 | 含义 |
|---|---|
| 89 | `src/packages/` 下的包目录（77 功能包 + 12 库包） |
| 77 | 装配行数（= 功能包数；库包不占行） |
| 76 | `plugin-inventory` 数出的插件数：headless 不挂 `tui` 那一行 |
| 21 | `lib/ui/plugins/` 的界面产物（19 个单元 + layout + renderer） |
| 89 | 包级测试用例数（每个包一个 `tests/*.test.mjs`，合计 447 条断言） |

### 12.14 审查后逐条确认：还差的三条与撤回的一条

**① 引导与渲染器同包（本轮修掉）**。dsh 是 `dsh-client-modules`（parser-blocking 引导）+ `dsh-client-ui-renderer`
（`immediately` 的客户端插件）；numa 原来两者都在 `ui-renderer` 一个包里，且 renderer 无行。拆开后：
`ui-boot` 是库包（无行、HTML 入口），`ui-renderer` 有行（order 348）与 `./client`；停用 renderer 或 layout，
引导画诊断页。**判据**：`lib/ui/plugins/` 20 → 21；装配行 76 → 77。

**② layout 的实现不在自己的 bundle 里（仍未补，代价最大）**。实测：`lib/ui/plugins/layout/client.js` **1320 B**，
壳的 app bundle **990 KB**。原因：`@dsc/ui`（`ui-shell/src/plugin-api.ts`）把 `@dsc/ui-layout` 的读 hook 整包转出给插件，
layout 的实现因此被静态编进壳；bundle 只是薄入口（`require('@dsc/ui-layout')` 命中平台种子）。
**要补必须三件一起做**，缺一件就退化成分裂的 `RuntimeContext`：
1. `plugin-api.ts` 不再静态 import layout，改成运行时委托（layout bundle 加载时写进 `__DSC_LAYOUT_API__`）；
2. build-plugins 对 layout 关掉 `@dsc/ui-layout` 的 external（让它内联自己的实现），同时保留 `@dsc/ui` 的 external；
3. 19 个单元的 bundle 必须在 layout **之后**求值（它们 import 的 hook 从那份委托取），启动分批次序要钉死。
收益：停用 layout 真的省掉那块代码；风险：20 份 bundle 的字节与首帧时序全变，19 个单元逐个复验。

**③ 界面内文案仍是中文（仍未补）**。locale 机制已就位（每包可带 `locale/<lang>.json`、内核按 `language` 读），
但只覆盖清单两行字。要补到界面，得给每个 UI 单元抽字符串、定键名、写 en 译本；19 个单元每个几十到上百条，
这是排期活，不是一次改动。

**④ 撤回一条**：上一轮说「`src/contract.ts` 是单文件契约桶、与 dsh 不同」——复核后不是偏离。dsh 也没有
`packages/contract`，契约散在 `packages/api`、`packages/sdk`、`packages/core` 里；numa 的 `src/contract.ts` 只有 27 行，
底下 `src/contract/*.ts` 按域拆了 10 个文件，与 `packages/api` 同形。

**⑤ 浏览器 e2e 没跑**：诊断页与首帧只在类型、产物、真实启动图三层验过。补法：仿 `scripts/ui-dsh-card-e2e.mjs`
起真宿主 + 真 Electron，三态截图（正常 / 停用 layout / 停用 renderer），断言诊断文案可见。

### 12.15 补完 ②③：共享运行时成库包，布局回落成真插件；界面文案走 per-package 译本（2026-11-04 夜）

用户裁决「继续，把所有未完成的都完成」。两条都按**能被门禁判死**的方式收尾，不留「做了七成」的灰区。

#### ② layout 的实现搬进自己的 bundle：换一条路（比 12.14 的原方案便宜，且更贴 dsh）

12.14 写的三件套（运行时委托全局 + 关 external + 钉死 19 个单元的求值顺序）代价在于第三件：
求值顺序变成隐性契约，谁在后面加一个单元就可能踩空。改成按 dsh 的真实形状切——**共享的留下，画图的搬走**：

| 归属 | 内容 | 理由 |
|---|---|---|
| 新库包 `@pneuma/ui-runtime`（`pneuma.library: true`、无行、进平台种子表） | 宿主通道 `host-channel.ts`、`runtime-context.tsx`（RuntimeContext + 四个 hook）、`page-state.ts`、`thread-view.ts`、`appearance.ts`、`usage-today.ts` | 这些是**状态**：React context、页 / 视图信号、外观的模块级记录。全页只能有一份，且必须与插件读到的是同一份 |
| `@pneuma/ui-layout`（有行、`./client`、`phase: early`） | `app.tsx`（App 骨架）、`review-pane.tsx`、`update-button.tsx`、入口 `ui.tsx` | 这些是**画图**：组件与它自己的 DOM 结构。dsh 的 `ui-layout` 同样是普通客户端插件，靠 `ui-slots` 这些种子拿共享面 |

配套三处：
1. `ui-shell/src/plugin-api.ts` 的整包转出改指 `@dsc/ui-runtime`——插件写的 `useHostSnapshot()` 一字不改。
2. 平台种子表（`platform-modules.json` ↔ `boot.ts` 的 MODULES）用 `@dsc/ui-runtime` 换掉 `@dsc/ui-layout`：
   布局不再是种子，它的 `client.js` 内联自己的组件。
3. `app.tsx` 里那两枚 `@dsc/ui-core` 的**值**（`NATIVE_BRIDGE_VERSION` / `NATIVE_OPS`）改经 `@dsc/ui-runtime` 转出：
   `@dsc/ui-core` 是故意不给插件的（进了 bundle 就是运行期一句「白名单外的模块」）。构建脚本新增一条硬断言：
   任何 `client.js` 里出现 `require("@dsc/ui-core")` 即构建失败。

**判据**：`lib/ui/plugins/layout/client.js` 从 1.3 KB 涨到 30 KB 以上；停用 layout 后 19 个单元仍在、只是没有骨架（已有的诊断页）。
风险：布局 bundle 的字节与首帧时序变了，19 个单元与三态 e2e 全部重跑。

**结果（同夜完成）**：布局产物 **1,320 B → 41,714 B**，壳的主 bundle **990 KB → 969.9 KB**；
`platform-modules.json` 换成 `@dsc/ui-runtime`，`@dsc/ui-layout` 出表；构建新增「产物里不许 require 内核或布局包」
的硬断言。验证：`check:plugin` 89/89、`check:ui` 54/54、三态 e2e 29 条断言全绿（正常态截图确认骨架画得对）。
包数 88 → **89 = 77 功能包 + 12 库包**。

#### ③ 界面文案本地化：per-package 译本 + 一条能判死的闸

dsh 的现状值得照抄：每个包的 `locale/*.json` 只放清单两行字（`meta.title/description`），界面内的文案走运行期
locale 服务与各包自带的字典。numa 照这个分两层：

1. **清单两行**：已有（`plugin-locale.ts`，`locale/en.json`）。
2. **界面内文案**：每个界面单元在 `locale/ui.zh.json` / `ui.en.json` 里放自己的键值，入口 `import` 这两个 JSON
   （vite 直接内联进 `client.js`，不需要宿主下发文件），语言由启动图的 `host.language` 决定（新增字段，
   来源是 `config.yaml` 的 `language:`，由 `webserver` 经 `languageOfConfigFile(activeConfigFile())` 带下来）。
3. `@dsc/ui-core` 新增 `i18n.ts`（`createT` / `uiLanguage` / `normalizeLanguage`），`@dsc/ui` 转出给插件：
   `t(key, params?)`，插值写 `{name}`；英文缺译回落中文原文，中文也缺给键名并在控制台报一次——**不许静默变空白**。
   语言只分两档（`en` 开头即英文），与内核 `plugin-locale.ts` 同一口径。
4. 门禁 `scripts/ui-locale-test.mjs`（进 `check:ui`）：用 TypeScript 语法树扫 `src/packages/<包>/ui/`，
   - 字符串字面量、模板串、JSX 文本里**不许再有汉字**（`console.*` 与 `throw` 里的开发面文案豁免）；
   - 每份 `ui.zh.json` 的每个键，`ui.en.json` 必须有、译文不含汉字；英文多出的键也报；
   - 每个 `t('...')` 的键必须在该包的 zh 字典里；字典里没人用的键也报（防止「改了没生效」）。
   这条闸把「译了一半」变成红，而不是靠人眼扫。单包排查用 `--package <名字>`。

**判据**：上述闸 0（26 个包 / 0 条硬编码 / 两份字典键集相同）；`language: en` 时真机截图里界面是英文。

**结果（同夜完成）**：26 个界面包全部迁完——**1890 个键**（中英各一份）、**2135 处 `t()`**、
**0 条硬编码中文**、**17 条协议豁免**（每一条都在行尾写了 `i18n-keep` 与理由）。真机 e2e 加了第四段
`language: en`：启动图带 `host.language: en`、侧栏是 "New session / Skills / Plugins / Settings"、
整页不再出现「新会话 / 设置」，截图 `desktop/shots/ui-boot-english.png`。

**已知未覆盖的一层（新发现，单列下批）**：宿主机**声明的配置面**仍是中文——设置分区与字段
（`pneuma.settingsSection` 的 `title` / `label` / `description`，分散在各宿主包里）、内置权限档位名
（只读 / 工作区可写 / 完全访问 / AI 复核）、内置模式名（标准 / 极简 / 创造 / PTC）。它们由**宿主**拼好交给界面，
不在 `src/packages/*/ui/` 里，所以这道闸管不到；英文界面下它们仍显示中文（截图里输入框上那两颗 chip 就是）。
补法：让设置面按语言出两份（`getSettingsSections(language)`），各宿主包把自己的 `title/label/description`


### 12.16 第三轮审查（2026-11-05 凌晨）：宿主配置面补完、开关即时生效、真机 69 步走查

用户要求「重新审查任务完成情况、检查未完成项、全部对齐 dsh、复查代码再功能测试」。这一轮做了四件事，
并把**仍然没对齐的项**逐条记进 12.17（不再散落在报告里）。

**① 宿主声明的配置面补完**（12.15 末尾那条「下一批」）。28 个宿主包迁进同一套 locale/ui.zh.json 与
ui.en.json，取词器 hostT(import.meta.dirname)（src/core/i18n.ts），判定与插值共用 src/core/i18n-text.ts
（与界面半的 createT 同一份）。权限档位名与模式名不在 registerSection 里，改在投影那一步换译本。
闸门 ui-locale-test 扩成两半都扫：**54 个包 / 2790 个键 / 3047 处 t() / 0 条硬编码**。

**② 界面半边开关即时生效**（第三次对账里唯一用户可感知的缺陷）。runtime.setPluginEnabled 发
dsc/ui-plugins-changed，webserver 换图推帧，壳侧按图卸载/装载。**骨架与渲染器例外**（页面的根，
换掉等于换整页，仍提示刷新）。判据：停用「命令面板」后不刷新页面，Ctrl+K 打不开；再启用，又打得开。

**③ 内联脚本被 CSP 拦掉**（真机走查发现）。ui-shell/index.html 里那段主题预涂是内联脚本，而界面的
CSP 是 script-src 'self'——被拦之后主题回默认、启动占位的兜底计时器不跑，只有控制台一行警告。
搬成同源外链 ui-shell/public/theme.js（仍不带 defer/async，所以还在样式之前执行）。

**④ 真机走查装置**：scripts/ui-sweep.mjs（临时 HOME + 假模型端点 + 真 Electron）+
scripts/_ui-sweep-main.cjs（按清单点/断言/截图）。69 步覆盖启动、侧栏折叠、新建会话、发消息、
底栏三颗 chip、斜杠与 @ 菜单、技能页、插件页、界面插件热更、轨迹页、设置七个分区、命令面板；
中文 69/69、英文 69/69。

### 12.17 第三轮对账后**仍未对齐**的项（按影响排序）——2026-11-05 晚全部关闭，见 12.19

| 优先级 | 项 | dsh | numa 现状 | 代价 |
|---|---|---|---|---|
| 1 | 装包即生效 | 监听 profile 的 package.json 与 patch，自动重组行 | numa plugin add 之后要重启宿主（src/packages/cli/plugin-cli.ts:145），plugin-watch 不盯 profile | 中：运行时重跑一遍「组合包 → patch 层 → 行」的组合，再挂新增行 |
| 2 | 平台种子表缺 cordis / zod / react-virtual | 壳把这几样给客户端插件共用 | platform-modules.json 只有自家模块；插件拿不到壳的 cordis 实例 | 中：要先把「客户端插件的上下文」定死，再决定放哪几样 |
| 3 | 包清单的 npm 发布字段 | 每包有 description / files / main / types，exports 带 types 条件 | 只有 pneuma.*；exports 是纯字符串 | 低，意义也低：numa 的包随 app 发布、不单独上 npm |
| 4 | cordis.patch.yml 的导出键 | 23 个 bundle 包导出它 | 包标准第 3 项把它判成「计划外」 | 低：门禁白名单 + 77 个 package.json 各加一行 |
| 5 | dsh.client.external | 插件可声明额外平台模块 | 无此字段，表外模块一律运行期报错 | 中：与第 2 项同一件事 |
| 6 | README 内容闸 | 5 条 doc-sync 闸（模型体验、已知限制等） | 只判两段标题在不在 | 低（评审活） |
| 7 | 真实组合测试 | 产品可见插件有走 Loader 的组合测试 | 包级测试只测包内 | 高 |
| 8 | 第三方安装入口 / 版本豁免 / 信任强度 | dsh plugin --profile 透传；--accept-risk；信任记录带内容摘要 | 只有 add/remove/list；豁免要手改 compatibility.json；信任只记 trustedAt，换内容仍可信 | 中 |

**会话流文案**（transcript.system 与命令输出）仍中文，属于**产品口径**而不是漏做：它们是写进会话记录的
内容，翻了新旧记录会混排。要翻得先定「记录按当时语言还是按当前语言显示」。


### 12.18 第四轮：八项逐条核查（查出一项漏记，共九项）

**做法**：不照抄 12.17 的结论，逐项回源码找证据，判「成立 / 描述有偏差 / 不成立」。

| # | 项 | 证据（文件:行号） | 判定 |
|---|---|---|---|
| 1 | 装包即生效 | `mountBundlePlugins` 只在启动时由 `mountAllExternalPlugins` 调一次（src/core/plugin-loader.ts:949）；热更轮询只盯**已挂载行**的目录与库包（src/core/plugin-watch.ts:319、:283）；CLI 明说「重启宿主后生效」（src/packages/cli/plugin-cli.ts:145、:164） | 成立 |
| 2 | 平台种子缺 cordis / zod / react-virtual | src/packages/ui-boot/ui/platform-modules.json 只有 11 项自家模块；dsh 的种子表 11 项里有 `cordis` / `zod` / `@tanstack/react-virtual`（packages/client/web/src/seed.ts:30-42） | 成立 |
| 3 | 包的 npm 发布字段 | src/packages/ui-palette/package.json:1-31 无 `description` / `main` / `types` / `files`，exports 是纯字符串；dsh 每个包都带（packages/client/ui-renderer/package.json:17-44） | 成立（但包标了 `private: true`，不单独上 npm，价值低） |
| 4 | `cordis.patch.yml` 的导出键 | dsh 的 web-app 导出 `"./cordis.patch.yml"`（packages/bundle/web-app/package.json:25）；numa 的白名单只有 `.` / `./client` / `./package.json`（scripts/plugin-standard-check.mjs:69） | 成立 |
| 5 | `dsh.client.external` | dsh 解析它并写进启动图行（packages/client/modules/src/client/manifest.ts:183、:67）；numa 的 `pneuma.client` 收了 platform / platforms / api / inject / services / phase / immediately，**独缺 external**（src/core/ui-bundles.ts:1471-1500） | 成立 |
| 6 | README 内容闸 | numa 只判两个标题在不在（scripts/plugin-standard-check.mjs:455-460），标题下一行没有也过；dsh 三条闸：Summary 字数上限 100 词、Model Experience 一节、Known Limitations 必须有一条顶格 `- ` 且标题唯一规范（scripts/verify-package-readme-summaries.ts:42、verify-package-readme-limitations.ts:75-86） | 成立 |
| 7 | 真实组合测试 | 清单脚本真起内核（scripts/plugin-inventory.mjs:33），但 `createKernel` 返回的挂载失败**被丢掉**——一个包挂不上、meta 记了 problem，快照照样收下它，门禁看不出来 | 成立 |
| 8 | 第三方入口 / 豁免 / 信任 | CLI 只有 add / remove / list（src/packages/cli/plugin-cli.ts:4-6）；dsh 有 `--accept-risk` 与 `allow-version` / `revoke-version` / `version-exemptions`（packages/boot/plugin-manager/README.md:83）；numa 的豁免只能手改 profile 的 compatibility.json（src/core/plugin-bundle.ts:222-227）；信任记录只存 `trustedAt`（src/core/plugin-registry.ts 的 `trustUiPlugin`） | 成立 |
| **9** | **组合包的 patch 不支持数组**（漏记） | dsh 的 `dsh.bundle.patch` 可以是字符串数组（packages/bundle/web-app/package.json:47-55）；numa 只认字符串（src/core/plugin-bundle.ts:171），第三方包写数组会**整份当成没声明 patch**，装进去只剩空壳 | 成立，新增 |

**结论**：12.17 的八项都成立，另有一项当时漏了（第 9 项）。九项都不涉及「做不做」的口径问题，全部补齐。

#### 补齐方案

| 项 | 做法 | 验收 |
|---|---|---|
| 1 | 热更轮询加一路「profile 清单」：盯 `<profile>/package.json` 与 `compatibility.json` 的指纹，变了就重跑 `mountBundlePlugins`（`mountRow` 按身份幂等，已在的行不会重挂），并卸掉已经不是这个 profile 成员的行 | 夹具：运行中往 profile 清单加一个包 → 下一轮它的行挂上、服务可用；删掉 → 行下线；`numa plugin add` 的提示改成「宿主在跑就即时生效」 |
| 2 | 种子表加 `zod` / `@tanstack/react-virtual` / `cordis`：`build-plugins.mjs` 的 external、`boot.ts` 的 MODULES、类型面一份；壳真的 import 这三样，插件 bundle 里因此不再内联自己的那份 | `ui-sdk-types-test` 的「种子 ↔ 类型面一一对应」照过；新增一条「种子表每一项都能在壳里被 require 到」的探针 |
| 3 | 89 个包补 `description` / `main` / `types` / `files`，`exports["."]` 改成带 `types` 条件的对象 | 标准闸第 1、2 项按新形状判；`node --input-type=module -e "import('@pneuma/ui-palette')"` 在 lib 下解得开 |
| 4 | `exports` 允许 `./cordis.patch.yml`；77 个功能包各加一行；标准闸加判「声明了 patch 就必须导出它」 | 标准闸红→绿，且反向夹具（删掉某包的导出键）会红 |
| 5 | `pneuma.client.external` 进声明、进行、进启动图；装载前校验「声明的每个外部模块要么是种子、要么是同一张图里的另一个包」，不满足就明确报错不静默 | 夹具：一个声明 `external: ['zod']` 的包能 require 到壳那份；声明一个表外模块时构建/装载期给人话 |
| 6 | 标准闸第 8 项升级：`## Model Experience` 标题下必须有正文、`## Known Limitations` 下必须有顶格 `- ` 且同类标题只许一个、H1 下要有一句话摘要 | 89 个包照旧全绿；反向夹具（删掉一节正文）会红 |
| 7 | 新脚本 `scripts/plugin-compose-check.mjs`：真起内核（headless），断言挂载失败为 0、没有带 problem 的条目、77 行全在（headless 少 tui 一行）、每个包声明的设置分区都注册上了、界面清单里每条都有对应的宿主行 | 进 `check:plugin`；人为把某包的入口改坏 → 脚本红 |
| 8 | CLI 补 `version-exemptions` / `allow-version <包@版本> --dsh-version <运行时> --accept-risk` / `revoke-version`；信任记录加内容摘要（`bytes` 的 sha256），摘要变了重新征得同意 | CLI 夹具：不加 `--accept-risk` 拒绝写入；改插件内容后信任失效一条新记录 |
| 9 | `readBundle` 接受字符串或字符串数组，按顺序叠成多层；标准闸允许数组 | 夹具：一个包声明两个 patch 文件，两层都生效 |

**共同验收**：`typecheck` / `build` / `check:plugin` / `check:ui` / `check:core` / `check:style` / `locale` 全绿，中英各走一遍 69 步真机清单。

### 12.19 九项全部补齐（2026-11-05 晚），12.17 那张表关闭

12.17 的八项 + 12.18 查出的第九项，这一轮全部落地。逐项的做法与证据：

| # | 项 | 落地 | 判据（跑过的） |
|---|---|---|---|
| 1 | 装包即生效 | `core/plugin-watch` 加 profile 清单一路（三份文件指纹，同一去抖窗口）→ `reconcileProfileBundles`：挂新行、按 `meta.bundle` 卸删掉的包 | `scripts/profile-hot-mount-test.mjs` 28 条；`plugin-hot-update-test` 第 7 段 6 条 |
| 2 | 平台种子 | 种子表 14 项（cordis / zod / react-virtual），MODULES 同序，构建期 external 同源，类型面逐字节转出 | `ui-sdk-types-test` 92 条、`ui-plugin-test` 279 条、`ui-boot` 包测试 4 条 |
| 3 | 发版字段 | 89 个包补 description / main / types / files，根入口 `{types,default}`；产物清单跟带 | 标准闸第 1、2 项 89/89 |
| 4 | patch 导出键 | 77 个功能包导出 `./cordis.patch.yml`，白名单放行 | 标准闸 89/89 + 反向夹具（删键即红） |
| 5 | `pneuma.client.external` | 声明 → 行 → 启动图；合法值 = 种子 ∪ 本图插件；构建期与装载期同一句话 | `ui-plugin-test` [3b]、排序断言、`ui-third-party-test` 28 条 |
| 6 | README 内容闸 | 摘要 + Model Experience 正文 + Known Limitations 至少一条顶格条目 + 同类标题唯一 | 标准闸第 8 项 89/89 + 反向夹具（只有标题即红） |
| 7 | 真实组合测试 | `scripts/plugin-compose-check.mjs` 走 `createKernel` 真路径，`kernel.ts` 交出挂载失败 | 77 包 / 76 注册 / 63 实挂 / 0 失败 / 26 分区 / 21 界面 id |
| 8 | 第三方入口 / 豁免 / 信任 | CLI 三个子命令 + `--accept-risk`；豁免精确到包版本 × 运行时版本；信任绑产物 sha256 | `cli.test.mjs` 12 条（含不给 --accept-risk 不写盘）、`ui-third-party-test` 改字节后要求重新确认 |
| 9 | patch 数组 | `readBundle` 返回 `PatchLayer[]`，多层按声明顺序叠 | `profile-hot-mount-test` 第 4 段（两层都挂上、标签带文件名） |

**复审时自己修掉两处**：① 豁免「包版本读不到就跳过比对」是失败开放，改成对不上就拒绝；
② 装载期 external 报错直接写在 `boot.ts` 里被 `ui-locale-test` 拦下，改成走本包字典 `boot.external.unknown`。

**仍然记着的边界**（不假装做完）：TUI 的 require 表没跟着扩三项；信任摘要不符没有单独的问题类别，
按「未信任」档渲染（dsh 没有这层信任，见 §12.20）。

（原文还记着「只删 profile 自己那层 patch 的某一条 insert 时那一行不会卸」——已按 dsh 的做法改成
行 id 集合的差，见 §12.20，这条边界作废。）

### 12.20 三条边界的对照（2026-11-05 深夜）

用户问「三条边界 dsh 怎么做的、会话流文案 dsh 怎么做的」，回源码核了一遍，结论如下。

**① 只删 profile 自己那层 patch 的一条 insert，那一行会不会卸 —— dsh 会卸，我们原来不会（已修）。**
dsh 的 `recomposeProfile` 比的是**行 id 集合**：`listed`（新 patch 列表）与 `composed`（旧 patch 列表），
不在 `listed` 里的行先停掉、等释放完成，失败则把停掉的行放回原位重启
（`packages/boot/app-boot/src/index.ts:350-373`；README 那句「removes the rows the generation no longer lists」）。
它不看「这一行是哪个包给的」——profile 自己那层 patch 插的行因此同样会下线。
我们的 `reconcileProfileBundles` 原来只按 `meta.bundle` 认领，profile 自己那层 patch 插的行没有归属，
所以留着。现已改成同一口径：属于这份 profile 的行（`meta.bundle` 有值，或入口文件在 profile 目录里）
里，id 不在这一代组合中的就卸掉；`mountBundlePlugins` 新增返回这一代的行 id 全集（含 group 子行）。
判据：`scripts/profile-hot-mount-test.mjs` 第 3b 段四条（挂上 → 删 insert → 下线 → 别的行不受影响），32 条全过。

**② 信任摘要不符按哪一档渲染 —— dsh 没有这一层，无从对照。**
dsh 没有「界面插件内容信任」这种记录：profile 里装上的客户端插件下次启动就装载，不问也不记录摘要。
它只有三道别的闸：`allowBuilds` 对安装脚本逐个点头（`packages/boot/plugin-manager/src/build-approval.ts`）、
版本豁免要 `--accept-risk`（`plugin-compatibility.ts`）、Web 端的 `--trusted-host` 围栏。
所以「摘要不符算不算单独一类问题」是我们自己的界面粒度，不是对齐项。

**③ 会话流里的宿主提示与斜杠命令输出 —— dsh 不翻译，写源语言。**
dsh 的 locale 服务只在浏览器里（`packages/client/locale`，`ctx.locale.register` 注册命名空间），
宿主侧没有任何调用点（全仓 `ctx.locale` 的命中都在 `src/client/` 下）。命令输出是宿主写死的英文，
例如 `/compact` 的 `Compacted ${n} history items (~${n} tokens).`（`packages/compaction/command-compact/src/index.ts:71`），
客户端把 `result.text` 原样画进会话（`packages/client/ui-commands/src/client/service.ts:430`）。
也就是说：**界面文案随语言变，写进会话记录的内容不随语言变**，中文界面里看到的是英文提示。
我们是同一条口径，只是源语言是中文——中文记录在任何界面语言下都保持中文。这一条按 dsh 的做法定案，不再作为待决项。

### 12.21 信任「内容变了」单列一档（2026-11-05 深夜，用户点头后做）

上一轮说过：摘要不符时按现有「未信任」档渲染，没有单独的问题类别。用户同意单列，已改。

- 契约：`UiTrustProblemKind` 加 `'stale'`（src/contract/plugin.ts:53 附近的四条说明补第五条）。
  语义是「信任记录在，但产物字节与当初同意的那份对不上（或记录来自没有摘要的老版本）」——
  用户曾经点过头，下一步只要再确认一次，不用从头读一遍披露。
- 判定：`scanThirdPartyUiTrusts` 在别的档都没话说时标 `problemKind = 'stale'`（core/ui-bundles.ts）。
  组合包那一档走不到（装进 profile 就是同意），但界面两张档位表必须同构，所以也给了文案。
- 界面：`ui-plugins` 的两张档表各加一条（`plugins.problem.stale.*` 与 `plugins.problem.packageStale.*`，
  中英各两份）。
- 判据：`scripts/ui-third-party-test.mjs` 加三条——改字节后那一行 `problemKind === 'stale'` 且 `trusted === false`；
  没被换过内容的插件不沾 stale；说明里说清要重新确认。

### 12.22 热生效补齐（2026-11-05 深夜，用户问「现在能做到插件热生效了吗」）

那一问逼出六条真缺口。先回 dsh 源码核了一遍「它怎么做的」，再逐条补。**dsh 的答案**（一个只读子代理在
`D:\deepseek-harness\deepseek-harness` 里核的，行号是他报的原样）：

1. profile 重算之后**有推送**，SSE：`recomposeProfile`（`packages/boot/app-boot/src/index.ts:305`）→
   宿主 `ClientModuleRegistry` 标脏重算图（`packages/client/modules/src/index.ts:680、1158`）→
   `client-hmr` 宿主半写 graph 帧（`packages/client/hmr/src/index.ts:195、162`）→ 浏览器半
   `entries.sync(graph)`（`packages/client/hmr/src/client/index.ts:83`、`.../client/entries.ts:111`），**不刷新**。
   只有流断了才要求刷新（`.../client/index.ts:41`）。
2. 运行时装包之后界面半边**会**出现，前提是这个 profile 开了 HMR：install 走
   `hmr.reconcileProfile`（`packages/boot/plugin-manager/src/index.ts:1254`），结果 `applied`，再走第 1 条。
   Web 组合默认挂 `client-hmr`（`packages/bundle/web-app/cordis.patch.yml:222`），关掉它的 `sdk-app`
   只报 restart-required（`packages/bundle/sdk-app/cordis.patch.yml:23`）。
3. dsh **没有**插件目录发现：只盯 profile 的 `package.json` 与两份 patch（`packages/boot/hmr/src/index.ts:384、406`），
   manifest 只在 `dsh.profile.bundles` 变了才重载；手工丢目录不写进 bundles/patch 不装载
   （`packages/boot/hmr/README.md:73`）。
4. 启动图标在宿主组合时算好并缓存，`rev = hash(entries+batches)`，**注入 index.html** 下发，每次页面请求现渲染；
   之后的变更靠 SSE。rev 只是一致性锚与 URL 缓存键。
5. dsh 只有 Web 载体（`dsh.client` 只认 `platform === 'web'`），没有终端壳的客户端装载器；
   唯一的 require 白名单在浏览器模块表（13 项种子，`packages/client/web/src/platform.ts:8`）。

**这一轮补的六条**：

| # | 缺口 | 做法 | 判据 |
|---|---|---|---|
| A | 装/卸组合包之后界面不换图（要 F5） | 新增事件 `dsc/ui-graph-dirty`（`services/types.ts`）；`plugin-watch` 重算完且行集合真的变了就发（`core/plugin-watch.ts` 的 `announceGraphDirty`）；webserver 与开关事件**共用同一个推帧函数**，并在卸载时退订 | `profile-hot-mount-test` 第 6 段 4 条：不动不发、装包发一次、卸包再发一次、两轮没变化不再打扰 |
| B | 信任第三方界面插件之后要人按 F5 | `runtime.setUiTrust` 与 `/ui-trust` 命令在落盘成功后发同一条事件；三条提示文案从「重启宿主（或刷新页面）后装载」改成「界面收到通知就装载它」 | 与 A 同一条链路（事件 → 换图 → 推帧），命令侧由 `cli`/命令测试覆盖 |
| C | 手工往 `~/.dsc/plugins/` 丢 `.js` 永远不挂 | 轮询加第四路：比文件名集合；新名字**连续两轮指纹不变**才挂（半个文件挂失败会被写盘停用，必须躲开），删掉立刻卸；挂/卸的判断仍只在 `adoptPluginsFromDisk` 一处（`core/plugin-loader.ts`），与启动路径同规则（`plugins.json` 停用过的跳过） | `plugin-hot-update-test` 第 8 段 8 条：基线不扫、刚出现不挂、第二轮才交出、不重复挂、删掉立刻扫、两组日志、无告警 |
| D | 终端壳的 require 表没跟上平台种子，也没有 external | `ui-core/tui-plugins.ts`：种子加 `cordis` / `zod`（浏览器种子表里也有这两项）；`external` 按条目解析——平台表 → 本图已装好的插件 → 报错；声明了终端给不了的模块（`react-virtual` 这类要 DOM 的）**装载前**就拒并列全可用的 | `ui-tui-plugin-test` 用例四 3 条：cordis/zod 都拿得到、external 指向本图插件能取到导出、声明终端给不了的模块被拒且报错列出 cordis |
| E | 文档里三个旧数字（56 / 37 / 19） | 77 功能包、58 overridable、19 pinned（实际枚举过 `src/packages/*/package.json`）；界面单元 19 + 骨架/渲染器 2 = 21 个产物，原文那两处「19 个界面单元」本身是对的，不动 | 数字由脚本枚举得出，不是照抄 |
| F | §16.6 说「切语言要刷新页面」，实际要重启宿主 | 改成「重启宿主」并写清原因（语言在建服务时进启动图）；顺手把 `plugin-model.md` §12/§14 的 56 也改掉 | 代码位置：`webserver/index.ts` 的 `host.language` |

**顺手改的一处对齐**：界面产物热更原来是「打包态默认关」，理由写的是「只读产物白烧轮询」。
dsh 的 Web 组合默认就带着 `client-hmr`，代价是「原地升级一个装好的包之后页面不换装」。
已改成**默认开**（`webserver/index.ts` 的 `pickHmr`，`DSC_UI_HMR=0` 或 `hmr: false` 关），
这样「包的界面半边被换掉」与「包被卸掉」一样是当场生效。

**没做的、以及为什么不假装做完**：

- dsh 把客户端包**构建产物缺失**报成 `MissingClientBundleError`（`packages/client/modules/src/index.ts:1017`）。
  我们对应的是 `exports["./client"] 指向的 <路径> 读不到`（`core/ui-bundles.ts:1512`），同样带包名与
  缺的那个路径——这一条是**等价**的，不是缺口（写这段时没回代码核，补正）。
- dsh 的 SSE 断线要求刷新页面；我们的壳在断线重连时会重取 `plugins.initial`（`webserver/index.ts:205-209`），
  语义等价，没有额外做「断线提示」。
- dsh 没有插件目录发现，我们这条（C）是**多做**的一步，不是对齐项。

### 12.23 第二轮对照：安装脚本的知情（2026-11-05 深夜，用户要求「对比 dsh，再查未做之事」）

补完 12.22 后又对着 dsh 过了一遍，剩下的差异逐条判：

| 差异 | dsh | 我们 | 判 |
|---|---|---|---|
| 客户端产物缺失的报错 | `MissingClientBundleError`，说清包名与缺哪个入口 | `exports["./client"] 指向的 <路径> 读不到`，同样带包名与路径 | 等价，见上一条的补正 |
| 安装脚本（postinstall 这类） | 把被拦下的名字记进 profile 的 `allowBuilds`，逐个点头（`packages/boot/plugin-manager/src/build-approval.ts`） | 原来**完全没提**：pnpm 10 起默认不跑第三方脚本，装完只看到「装上了」 | **补了**，见下 |
| SSE 断线 | 要求刷新页面 | 壳重连时重取 `plugins.initial` | 等价 |
| 插件目录发现 | 没有 | 有（12.22 的 C） | 多做 |
| 手机端（远程壳） | 没有这个载体 | 原来不推帧、只能刷新；**已补**，与本地共用 `core/ui-graph-frames.ts`（见 12.25） | 齐 |

**安装脚本这一条怎么补的**：不另造策略文件——授权仍走 pnpm 自己的 `approve-builds`（本仓 pnpm 10.15
的入口），我们只负责「把被跳过的名字摆到人面前」：

- `numa plugin add` 装完问一次 `pnpm ignored-builds`，有就打印名单 + 影响 + 授权命令；
- 新增 `numa plugin builds [--profile 名字]`，装了几个包之后再确认也查得到；
- 解析放在 `src/packages/cli/pnpm-builds.ts`（`plugin-cli.ts` 顶层就 `process.exit`，当库 import 跑不起来），
  包级测试直接钉它：`pnpm ignored-builds` 的列表、`pnpm add` 的单行摘要、裸包名与带版本都认、
  「没有 node_modules」那句说明不能被当成一堆包名。

**判据**：`node --test src/packages/cli/tests/cli.test.mjs` 19 项（新增 7 项）。

**没做的（记着，不装做完）**：手机端（`remote`）没有帧通道，刷新页面才看到新插件——dsh 没有这个载体，
无从对照；要补就是给远程也接一条推送，属于另一项工程。

> 这条已经在 12.25 里做掉了（见文末）。

### 12.24 跟上 dsh 0.2.2-rc.1：依赖层升上去，插件内核一行没动（2026-11-05 傍晚）

用户把 dsh 源码从 `8bd073392e` 拉到 `fcc0ad4621`（260 个提交、1665 个文件），其中包括
`release(dsh): 0.2.2-rc.1` 与 `release(vendor): cordis 4.1.0, hmr 1.1.0, loader 1.1.0, …`。
先判一件事：**这 260 个提交有没有动插件内核**。逐个文件 diff 的结果是没有——
`packages/boot/app-boot/src/index.ts`、`packages/boot/plugin-manager/src/{index,build-approval}.ts`、
`packages/client/modules/src/index.ts`、`packages/client/hmr/src/index.ts`、
`packages/host/plugin-inventory/src/index.ts`、`packages/client/web/src/platform.ts` 全部**无改动**；
变的是版本号、界面组件（菜单锚点、鲸鱼、HOC 插槽）与桌面打包。所以这一轮对齐落在依赖层。

**cordis 4.0.4 → 4.1.0 到底改了什么**（拿 npm 包源码与 dsh vendor 源码逐文件 diff）：

| 变化 | 含义 | 我们受不受影响 |
|---|---|---|
| `fiber.store` → `fiber.committed` | 装载时定格的依赖快照改由 `committed` 持有，另加 `provisions`（本纤维提供的服务，带 `uid` 与 `dependents`） | **受影响一处**：界面壳算「还差哪些服务」读的就是它 |
| 卸载等依赖先走 | 服务提供者卸载时先等持有者卸完，再释放自己的副作用 | 对我们有利（热重挂顺序更稳），无代码改动 |
| 配置解析分两步 | `internal/config` 变成 `(fiber, next)`，`internal/update` 变成 `(resolved, next)`（去掉 `noSave`），新增 `internal/commit`；`update()` 返回可等的 promise 而不是吞掉 | **不受影响**：全仓 0 处 `internal/update` / `internal/config` / `fiber.update(` |
| `LoggerLevel` 重排（WARN=1、INFO=2） | 级别数值换了序 | **不受影响**：全仓 0 处引用 |

改法只有三步：三处依赖拉上去（cordis `^4.1.0`、loader `^1.1.0`、dsh-tools `0.2.2-rc.1`）；
界面壳那一处读 `fiber.store` 改成 `fiber.committed`；89 个包 manifest 的 peer 一起写 `^4.1.0`。

**顺手对齐的一处语义**：`DSH_CONTRACT_VERSION` 从 `0.2.1` 到 `0.2.2`，而且**判定方式一起换了**。
dsh 自己的包在 `peerDependencies` 里写的是**精确版本**（`@deepseek-ai/dsh-llm: 0.2.2-rc.1`），我们原来
拿常量去 `satisfies` 这个范围——点判断一次只放行一个点：常量停在 0.2.1 时 0.2.2 的包被拒；
就算升到 0.2.2，`satisfies('0.2.2', '0.2.2-rc.1')` 仍然是 false（预发布比正式版小），照样拒。
改成**比区间交集**（`>=0.2.0-0 <=0.2.2`），两代精确 pin 都装得上，要求 `>=0.2.3` 的仍被挡下。
代价写清楚：`compatibility.json` 里按 `dshVersion: 0.2.1` 记的豁免会失配（授权只对当时的运行时有效，
重按一次才作数）。
判据：`scripts/dsh-bundle-check.mjs` **18 条**（新增 3 条：上一代 pin 照装、当前代 rc pin 照装、两代都不报警告）。

**判据**：`check:core` 100/100（916.1 秒）、`check:plugin` 89 包 / 466 条断言、清单 76/24/21、
`check:ui` 55/55、`check:dsh` 170 PASS / 0 FAIL、`check:style` 1245 文件、`check:ui:e2e` 5/5（187.2 秒）。

### 12.25 手机端推帧 + 下拉浮层改锚点定位（2026-11-05 傍晚，用户点了「1 和 2」）

**手机端**：上一轮判成「没有帧通道」，复核后是「通道有、宿主没接」。`remote` 装配 `createUiEvents`
时补上 `plugins` 源，并订 `dsc/ui-plugins-changed` / `dsc/ui-graph-dirty`；帧的组装与扇出抽到
`core/ui-graph-frames.ts`，本地壳与手机壳共用（`removed` 由前后两帧 id 差算，`initial` 那一帧要
`remember` 当基准，否则第一次推帧的 `removed` 永远空——这条路是自检抓出来的）。

**锚点定位**：`Select`（6 个包在用）从「打开后量一次再改坐标」改成 CSS 锚点定位
（`anchor-name` / `position-anchor` / `anchor()` / `position-try-fallbacks: flip-block`），
不支持锚点的浏览器仍走原来的测量。dsh 这轮删掉 `useAnchoredPosition`、25 个文件改成同一种写法，
我们这边对应的是这一个共享组件加一个工具模块（`ui-primitives/ui/anchored.ts`）。

**顺带发现**：`scripts/remote-e2e.mjs` 不在任何门禁里（`check:core` 只收 `-test.mjs`、`check:ui` 只收
`ui-*`），而且有两条一直是红的（设备清单两行、第二宿主休眠）。在 HEAD 上复跑报错逐字相同，不是本轮
弄坏的；这轮只把新加的三条挂进去跑通，那两条没动。

**判据**：`ui-graph-frames-test` 18 条、`ui-anchored-test` 11 条、`ui-anchor-e2e` 真机 11 条、
`remote-e2e` 新增 3 条；`check:ui` 57/57、`check:ui:e2e` 6/6、`check:dsh` 170 PASS。