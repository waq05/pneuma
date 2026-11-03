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
- 每包 `package.json` + `cordis.patch.yml` + `index.ts`（源码从 `src/plugins/x.ts` 搬进 `src/packages/x/index.ts`）。
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
node scripts/plugin-model-check.mjs --strict
node scripts/check-core.mjs          # 93 套
node scripts/ops-test.mjs
pnpm run check:dsh
node scripts/plugin-swap-e2e.mjs     # P5 起
```

## 8. 范围外

- 不发布第二个 npm 包，不建运行时工作区包。
- 不实现 `!!js` 表达式。
- 不做插件市场安装 UI。
- 不改界面信息架构，只换归属。
