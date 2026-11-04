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
pnpm run check:plugin                # 模型检查 + 清单快照 + 加载器 92 条 + list 15 条 + 换包 e2e 17 条
node scripts/check-core.mjs          # 97 套（hmr-dispose-test、plugin-hot-update-test 自动进来）
node scripts/ops-test.mjs
pnpm run check:dsh
```

`check:plugin` 的四个脚本分工：`plugin-model-check --strict`（结构：包数 / 行数 / 内核行数 / 缺口）、
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
| **Q5** | 壳层包化：`ui-layout`/`ui-primitives`/`ui-slots`/`ui-dockkit`/`ui-renderer`、TUI 组件树、CLI 子命令 | 每件都有 `package.json` + 行 + 可停用；壳只剩引导 |
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
- **CLI**：532 行，做成一个 `@pneuma/cli` 包 + 子命令注册表，保住 `bin/dsc.js` 零依赖保命设计。

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
