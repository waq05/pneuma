# 批次 02：插件模型与装配

> 审查基线：分支 `feat/pluginization`，工作区现状（2026-11-09）。本批范围内**只有 `ui-shell/src/plugin-api.ts` 有未提交改动**；
> `src/host/kernel.ts`、`src/host/startup.ts`、`src/core/plugin-loader.ts`、`plugin-registry.ts`、`plugin-watch.ts`、`plugin-patch.ts`、
> `plugin-bundle.ts`、`plugin-locale.ts`、`ui-bundles.ts`、`ui-manifest.ts`、`profile-bootstrap.ts`、`profile-dir.ts`、
> `src/packages/{plugin-manager,runtime,runtime-api,dsh-compat}/`、`src/core/dsh-compat/` 均无未提交改动。

## 范围

实际读过的文件（行号均以工作区当前字节为准）：

- `src/host/kernel.ts`（120 行，全读）、`src/host/startup.ts`（90 行，全读）、`src/boot.ts`（仅 13–28 行）、`src/headless.ts`（仅 10–25 行）
- `src/core/plugin-loader.ts`（1986 行，全读）
- `src/core/plugin-registry.ts`（498 行，全读）
- `src/core/plugin-patch.ts`（223 行，全读）、`src/core/plugin-bundle.ts`（385 行，全读）
- `src/core/plugin-locale.ts`（145 行，全读）、`src/core/profile-dir.ts`（43 行，全读）、`src/core/profile-bootstrap.ts`（34 行，全读）
- `src/core/plugin-watch.ts`（1001 行，只核 import 面与 `startPluginWatch` 入口：31–44、972）
- `src/core/ui-bundles.ts`（1779 行，全读）
- `src/core/ui-manifest.ts`（317 行，全读）
- `src/core/ui-methods.ts`（507 行，只读 84–205、365–367）、`src/core/ui-boot-source.ts`（仅 1–30、85–115）、`src/core/ui-route.ts` / `ui-server.ts`（仅 grep 到的引用行）
- `src/packages/plugin-manager/index.ts`（159 行，全读）
- `src/packages/runtime/index.ts`（654 行，读 1–269）、`src/packages/runtime-api/index.ts`（157 行，全读）
- `src/packages/dsh-compat/index.ts`（71 行，全读）、`src/core/dsh-compat/*`（9 个文件，逐个过 import 面）
- `src/packages/{runtime,runtime-api,plugin-manager,dsh-compat}/package.json`
- `scripts/build-packages.mjs`（253 行，全读）、`scripts/build-runtime-package.mjs`（仅 1–40、90–125）、`scripts/plugin-dep-graph.mjs`（仅 100–115）
- `ui-shell/src/plugin-api.ts`（535 行，只读导出面）

## 结论摘要

- **P0 3 条 / P1 9 条 / P2 12 条（共 24 条）**
- 最重要的三句话：
  1. cordis patch 里的行 `config:` 从来没人读（`mountRow` 只传 inject / native / 宿主配置），
     而 `applyPatchLayers` 认真实现了「config 整块替换」；意思是**任何组合包在 patch 里写的配置都会被静默丢掉**，
     插件拿到的永远是 `~/.dsc/plugins.json` 里那一条。这是"读清单 / 校验 / 挂载"三段各自实现后的接缝漏了。
  2. 插件装配实际有 **5 条主路径 + 2 条增量路径**，其中「挂一个插件」的代码写了 **4 份**
     （内置 531–549、外部 579–607、热重挂 766–791、以及 `mountRow` 的准备段 1503–1609），
     只有「导入 + apiVersion + Config 校验」这一段被收敛进了 `inspectPluginModule`（421–507）。
  3. 同一个「插件开没开」有 **两套判定**（`plugin-registry.isPluginEnabled` 与 `plugin-loader.isDisabledByEntry`）
     和 **三种键形状**（`ui-<id>` / `<目录名>/ui/client.js` / `<包名>/client`），
     三者都往同一份 `plugins.json` 的 `entries` 里写，而 `listPluginInfos` 只认第一种。

## 按插件分节

### @pneuma/runtime-adapter（`src/packages/runtime/`，提供 `ui` 服务）

#### [P0] 同一件事写两次盘：界面点一次开关，`plugins.json` 被写两遍

- 位置：`src/packages/runtime/index.ts:179`、`src/core/plugin-loader.ts:920`、`src/core/plugin-loader.ts:924`
- 现象：`setPluginEnabled` 先调 `writePluginEnabled(file, enabled)` 判「能不能停」并写盘，随后对普通宿主插件
  继续调 `setPluginEnabledHot`，而后者在成功分支里又写一次盘。停用分支同样双写。
- 证据：
  ```
  179:        if (!writePluginEnabled(file, enabled)) {
  920:    writePluginEnabled(file, true)
  924:  writePluginEnabled(file, false)
  ```
- 影响：一次点击触发 2 次「读整份 JSON → 改一条 → 整份写回」。`writePluginEntries` 是
  「读旧文档 + 覆盖 entries」的非原子写法（`plugin-registry.ts:347-350`），两次调用之间的任何
  并发写者（插件中心信任、设置分区保存配置）都会被第二次覆盖回去。也解释了为什么
  `readEnabledPlugins` 要专门做批版（`plugin-registry.ts:394-413`）——单条判定本身就重。
- 建议：`writePluginEnabled` 只做「能不能停」的前置校验（拆出一个纯判定 `canTogglePlugin(file)`），
  写盘统一收到 `setPluginEnabledHot` 一处；`runtime/index.ts:179` 改成先判后调，不再自己写。
- 置信度：高（两个调用点全文核对过）

#### [P1] `runtime` 与 `runtime-api` 名字撞车、`@pneuma/runtime` 还是第三个东西

- 位置：`src/packages/runtime/package.json:2`、`src/packages/runtime-api/package.json:2`、
  `scripts/build-runtime-package.mjs:118`、`scripts/build-packages.mjs:82`
- 现象：三个"runtime"各指一件事：
  ① `src/packages/runtime/` 的**包名是 `@pneuma/runtime-adapter`**，行 id 是 `runtime`，做的是「把服务织成界面契约」；
  ② `src/packages/runtime-api/` 是只读工具 `runtime_api`；
  ③ `@pneuma/runtime` 是**构建生成的适配包**（`lib/node_modules/@pneuma/runtime`），它的 `core/*` 映射回 `src/core/*`。
- 证据：
  ```
  build-packages.mjs:82:    if (dirName === 'runtime') {
  build-packages.mjs:83:      problems.push(`${pkg.id} 的包名不能是 @pneuma/runtime：这个名字留给构建生成的运行时适配包`)
  ```
- 影响：读 `import { x } from '@pneuma/runtime/core/y.js'` 的人无法从名字判断拿的是 core 还是包；
  改 `src/packages/runtime/index.ts` 时也容易以为动的是 `@pneuma/runtime`。构建期断言挡住了物理冲突，但没挡住理解成本。
  职责本身不重叠（一个是 UI 契约服务、一个是只读查询工具），所以不是重复实现，只是命名。
- 建议：`src/packages/runtime/` 目录改名为 `runtime-adapter`（与包名一致，行 id 仍可保持 `runtime`）；
  在 `docs/development.md` 加一句「`@pneuma/runtime` 是生成物、不是包」。
- 置信度：高

### @pneuma/plugin-manager（`src/packages/plugin-manager/`）

#### [P1] `plugin-manager` 与插件中心是两套动作面，但共用同一份实现——差异在「谁能停内核行」

- 位置：`src/packages/plugin-manager/index.ts:76`、`src/packages/runtime/index.ts:178-183`、`src/core/plugin-registry.ts:427-435`
- 现象：list/enable/disable **没有**两套实现（`plugin-manager` 只是 `listPluginInfos` / `setPluginEnabledHot` 的薄调用方，
  见 `index.ts:20-21`），但两条动作面的前置校验不同：插件中心先 `writePluginEnabled` 判 `toggleable`，
  `plugin-manager` 直接 `setPluginEnabledHot`，后者**不判 toggleable**（`writePluginEnabled` 被它自己吞了返回值）。
- 证据：
  ```
  76:            const outcome = await setPluginEnabledHot(file, action === 'enable')
  427:  export function writePluginEnabled(file: string, enabled: boolean): boolean {
  428:    const meta = catalog.get(file)
  429:    const canToggle = meta === undefined || meta.source === 'external' || meta.toggleable === true
  430:    if (!canToggle) return false
  ```
- 影响：模型通过 `plugin_manager` 工具可以停掉 `session` / `llm` 这类「运行内核」行，
  而界面上的开关是灰的。停掉后内核缺服务，下一次对话直接失败，且没有任何一处提示「这是内核行」。
- 建议：把 `canToggle` 判定上提到 `setPluginEnabledHot` 的入口（返回 `{ok:false, problem:'这一档属于运行内核'}`），
  删掉 `plugin-manager` 与 `runtime` 各自的调用前判断。
- 置信度：高（`setPluginEnabledHot` 全文读过，确实不判 toggleable）

#### [P2] `install` 的目标目录叫 `thirdPartyUiRoot()`，装的是宿主插件

- 位置：`src/packages/plugin-manager/index.ts:88-89`、`src/core/ui-bundles.ts:815-817`
- 现象：`install` 把 `.js` 复制到 `thirdPartyUiRoot()`，而这个函数名说的是「第三方**界面**插件根」，
  实际返回 `dscPath('plugins')`，与 `DSC_PLUGINS_DIR`（`plugin-loader.ts:936`）是同一个目录的两种命名。
- 证据：
  ```
  88:              const dest = join(thirdPartyUiRoot(), basename(src))
  815: export function thirdPartyUiRoot(): string {
  816:   return dscPath('plugins')
  ```
- 影响：同一个目录被两个名字指代，改路径时容易只改一处；新读者会以为复制进去的是界面半边。
- 建议：`thirdPartyUiRoot` 改为从 `plugin-loader` 的 `DSC_PLUGINS_DIR` 取值（或直接删掉，统一叫 `pluginsDir()`）。
- 置信度：高

### @pneuma/dsh-compat + `src/core/dsh-compat/`

#### [P1] 兼容层被劈成两半，同一件事两处各做一遍（没有环，但会改一处忘另一处）

- 位置：`src/packages/dsh-compat/index.ts:43`、`src/core/plugin-loader.ts:859-864`、
  `src/packages/dsh-compat/index.ts:36`、`src/core/plugin-loader.ts:433-436`
- 现象：两者是「可开关的插件壳」与「宿主内联垫片」的关系，不是两套实现：
  - `packages/dsh-compat` 负责 `provide('logger')`、把 warn/error 镜像进 transcript、兜底调 `ensureResolveHook`；
  - `core/plugin-loader` 负责 `ensureResolveHook` / `setResolveHookCompat` / `dshToolsFacade` / `compatCtx` / `normalizeDshHome`；
  - **`DSH_HOME` 归一两处都写**，`ensureResolveHook` 两处都调。
- 证据：
  ```
  packages/dsh-compat/index.ts:43:    process.env['DSH_HOME'] = dscPath()
  plugin-loader.ts:859: function normalizeDshHome(): void {
  plugin-loader.ts:863:   process.env['DSH_HOME'] = dscPath()
  ```
- 影响：import 方向是单向的（`packages/dsh-compat` → `core/dsh-compat/resolve-hook` + `core/plugin-loader` 的常量；
  `core/*` 从不反向 import `packages/*`），**没有 import 环**。但「兼容层开着时该做哪些副作用」没有单一清单：
  新增一条（例如把 `DSH_CONFIG` 也归一）要记得改两处，漏一处就是"开关开着但不生效"。
- 建议：把「兼容层开 / 关时要做的全部副作用」收成 `core/dsh-compat/activate.ts` 一个 `applyCompatEnv(root)`，
  由 loader 在 `inspectPluginModule`（433–437）调；`packages/dsh-compat` 只保留 `provide('logger')` 与 exporter 桥。
- 置信度：高（9 个 core/dsh-compat 文件的 import 面逐个核对过，确认无反向依赖）

#### [P2] `DSH_SERVICE_NAMES` 服务名白名单与 `service-map.ts` 的描述表要手工对齐

- 位置：`src/core/plugin-loader.ts:92-97`、`src/core/dsh-compat/service-map.ts`（全文件）
- 现象：一份是「dsc 有哪些服务」（Set），一份是「dsh 的服务名对应到什么」（描述表）。加一个 dsc 服务时
  只改前者，`describeForeignServices` 就会把新服务名当成"外来"去解释；反之新增一条 dsh 服务名也只改后者。
- 证据：
  ```
  92: const DSC_SERVICE_NAMES = new Set([
  93:   'llm', 'session', 'approval', 'mode', 'todo', 'plan', 'ask', 'goal', 'tools', 'transcript',
  ```
- 影响：`src/services/types.ts` 的 Context 声明是第三份服务名清单，三份之间没有机器校验。
- 建议：让 `DSC_SERVICE_NAMES` 直接从 cordis `Context` 的类型声明生成，或在 `plugin-standard-check.mjs` 里加一条断言比对。
- 置信度：中（未逐条比对三份清单的差集）

### @pneuma/base（`src/core/plugin-loader.ts` + `plugin-patch.ts`）

#### [P0] patch 行的 `config:` 被静默丢弃

- 位置：`src/core/plugin-loader.ts:1580-1586`、`src/core/plugin-loader.ts:495`、`src/core/plugin-patch.ts:14-15`
- 现象：`applyPatchLayers` 明确实现「`config` 是整块替换，不是深合并」，但 `mountRow` 调 `mountExternalPlugin`
  时只传 `inject` / `native` / 宿主配置；`inspectPluginModule` 取配置的地方是
  `rowOptions.config ?? getPluginConfig(identity)` —— 磁盘上那份，**patch 行上的 `config` 从头到尾没被读过**。
- 证据：
  ```
  1580:  const ok = await mountExternalPlugin(file, rowId, {
  1581:    inject: rowInjectOf(row),
  1582:    native: typeof row.name === 'string' && row.name.startsWith('@pneuma/'),
  1583:    ...(hostConfig !== null && typeof hostConfig === 'object' && !Array.isArray(hostConfig)
  1584:      ? { config: hostConfig as Record<string, unknown> }
  1585:      : {}),
  495:  let configForApply = rowOptions.config ?? getPluginConfig(identity)
  15: *   5. 其余键**逐个覆盖**到目标行上——注意 `config` 是整块替换，不是深合并
  ```
- 影响：一个组合包在 `cordis.patch.yml` 里写
  `- id: mcp` + `config: { servers: [...] }`，装上去之后插件拿到的是空配置，而且**没有任何告警**。
  排查时只能看到「配置没生效」，因为 patch 层、plugins.json、宿主配置三层里前两层都以为自己在说话。
  当前仓库里没有任何一份 `cordis.patch.yml` 写 `config:`（全仓 grep `^\s+config:` 零命中），所以还没爆，
  但这条是给外部组合包准备的对外契约。
- 建议：`inspectPluginModule` 的配置三级合并口径定死并实现：
  `rowOptions.config`（宿主，整份替代）> `row.config`（patch 行，整块替换）> `getPluginConfig(identity)`（磁盘）。
  即 `mountRow` 把 `row.config`（当它是对象且不是 group 的数组时）作为 `config` 透传。
- 置信度：高（`row.config` 全仓只在 `collectRowIds` 的 group 分支被读，`plugin-loader.ts:1188`）

#### [P1] group 子行：能插、能统计，但永远不会被挂载

- 位置：`src/core/plugin-loader.ts:1182-1193`、`src/core/plugin-loader.ts:1414-1418`、`src/core/plugin-loader.ts:1168-1171`、`src/core/plugin-patch.ts:172-178`
- 现象：`applyPatchLayers` 支持把行 insert 进一个 `group: true` 的行（子行放在 `config` 数组里），
  `collectRowIds` 递归把子行 id 收进「这一代的行 id 全集」，但两个挂载循环都只遍历顶层 `applied.rows`。
- 证据：
  ```
  1188:      if (Array.isArray(row.config)) walk(row.config as PluginRow[])
  1414:  for (const row of applied.rows) {
  1415:    if (skipped !== undefined && typeof row.id === 'string' && skipped.has(row.id)) continue
  1416:    const failure = await mountRow(row, ctx)
  ```
- 影响：子行**既不挂载也不报失败**，而 `reconcileProfileBundles` 按 `listed` 判「哪一行还在」（1262），
  于是这条幽灵行永远留在 listed 里：既不挂上、也不会被卸掉。dsh 生态的真实组合包大量用 group 分层，
  一装就是「界面少一块、日志里一句解释都没有」。当前仓库无 `group: true` 使用者（全仓 grep 零命中），属"契约先于使用"。
- 建议：`mountRow` 里对 `row.group === true && Array.isArray(row.config)` 递归下钻（把子行的 `inject` 继承父行），
  或者干脆在 `applyPatchLayers` 之后把 group 摊平再交给挂载循环；不要让两段代码对"有哪些行"持两种看法。
- 置信度：高

#### [P1] 版本闸判两次，两处文案与跳过粒度都不同

- 位置：`src/core/plugin-loader.ts:1113-1119`、`src/core/plugin-loader.ts:1534-1576`、`src/core/plugin-bundle.ts:141-166`
- 现象：组合包在**包级**判一次 `enginesProblem`（不满足就 `continue`，整包所有行都不挂），
  每一行又在 `mountRow` 里判一次 `pneumaEnginesProblem`（不满足只跳过这一行）。
  两个函数的错误文案不一样，豁免名单也读自两个来源（包级用 `profile.exemptions`，行级用 `ctx.exemptions`）。
- 证据：
  ```
  1113:    const engineProblem = enginesProblem(manifest)
  1114:    if (engineProblem !== null && !exemptionAllows(profile.exemptions, info.name, info.version)) {
  1534:  const engineProblem = pneumaEnginesProblem(manifest)
  ```
- 影响：一个包声明了 `engines.pneuma` 不满足时，用户看到的是包级那句「这个包要求…先不装」，
  而 `compatibility.json` 里登记豁免之后，包级放行、行级再判一次 —— 两处判据用的是同一个版本常量，
  但豁免记录带 `dshVersion` 时只对第二处生效（`exemptionAllows` 的 `dshVersion` 分支）。
  同一个包可能"包级过了、行级被拦"，也能反过来，取决于豁免记录带没带版本。
- 建议：只留行级一处（它判的是**实际解析到的那个包**，口径更准，注释 1532–1533 已经说了理由），
  删掉 `mountBundlePlugins:1113-1119` 的包级闸；包级只保留「包不存在 / 没 package.json」这两条真·安装问题。
- 置信度：高

#### [P0] 「插件开没开」两套判定，`isDisabledByEntry` 不认别名、不认 `defaultDisabled`

- 位置：`src/core/plugin-loader.ts:1973-1975`、`src/core/plugin-registry.ts:404-421`、`plugin-loader.ts:957`、`plugin-loader.ts:1024`、`plugin-loader.ts:1566`
- 现象：外部插件扫描用 `isDisabledByEntry`（自己 `readPluginEntries().find(entry.file === file)`），
  行挂载用 `isPluginEnabled`（走 `entryIndexOf`，认 0.8.1 旧键别名、认 `defaultDisabled` 回落、
  读一次可复用的批版）。两者对同一份 `plugins.json` 给出不同答案。
- 证据：
  ```
  1973: function isDisabledByEntry(file: string): boolean {
  1974:   return readPluginEntries().find((entry) => entry.file === file)?.disabled ?? false
  957:    if (isDisabledByEntry(base)) continue
  1566:  if (!isPluginEnabled(rowId)) return null
  ```
- 影响：三处具体差异：① 0.8.1 写下的旧键（文件名）在外部路径上读不到，用户关掉的插件升级后又起来了；
  ② `defaultDisabled`（危险官方插件的"装完不主动拿到控制权"，见 `plugin-registry.ts:46-50`）在外部路径上被忽略；
  ③ `mountAllExternalPlugins` 在 `for` 循环里逐文件调它，N 个插件 = N 次「读整份 JSON + JSON.parse」。
- 建议：删掉 `isDisabledByEntry`，两处改调 `readEnabledPlugins(files)`（已有的批版，一次读盘）；语义与行路径完全对齐。
- 置信度：高

#### [P1] `plugin-loader.ts` 1986 行、五类职责，且与 `plugin-watch` 已成环（靠动态 import 破）

- 位置：`src/core/plugin-loader.ts`（1–1986）、`src/core/plugin-watch.ts:34-44`、`src/core/plugin-loader.ts:1443-1454`
- 现象：一个文件里装着：外部插件热挂载（517–792）、组合包/profile 装配（1071–1273）、
  应用自带行装配（1363–1424）、模块解析与锚点解析（1641–1960）、dsh 兼容 ctx（830–881）、
  热更轮询拉起（1443–1454）。
- 证据：
  ```
  plugin-watch.ts:44: } from './plugin-loader.js'
  plugin-loader.ts:1440: * 动态 import 而不是静态：plugin-watch 反过来要用本模块的
  plugin-loader.ts:1441: * `listMountedPluginSources` / `remountExternalPlugin`，静态 import 会成环。
  plugin-loader.ts:1446:    const watch = await import('./plugin-watch.js')
  ```
- 影响：环是真的（`watch → loader` 静态一条，`loader → watch` 动态一条），只是被 `import()` 挡住了。
  代价是：`plugin-watch` 永远不能用静态 import，任何人把它改成 `import { startPluginWatch }` 就得到运行时
  循环依赖（cordis 下表现为半个模块 undefined，不是编译错误）。改一行的成本从"改一行"变成"先读两个文件头"。
- 建议：把「解析一个行目标 → 文件路径」整段（1641–1960，`resolveBundleTarget` / `resolvePackageRow` /
  `entryFromAnchor` / `entryFileOf` / `exportsEntry` / `rememberResolvedDir`）抽到 `core/plugin-resolve.ts`；
  把「热更轮询拉起」移回宿主（`kernel.ts` 显式调），loader 不再需要 import watch，环自然消失。
- 置信度：高

#### [P2] 同一段「向上找最近 package.json」写了两遍，层数与终止条件都不同

- 位置：`src/core/plugin-loader.ts:179-188`（`pluginPackageDirOf`）、`src/core/plugin-loader.ts:1889-1901`（`manifestOfFile`）
- 现象：两份都是「从入口文件往上、最多 8 层、找 package.json」，但一份用 `parent === dir` 终止（根目录），
  一份用 `resolve(dir) === stop`（走到 profile 目录就停）并在找到清单时**同时返回目录**。
- 证据：
  ```
  181:  for (let depth = 0; depth < 8; depth += 1) {
  182:    if (existsSync(join(dir, 'package.json'))) return dir
  183:    const parent = dirname(dir)
  184:    if (parent === dir) return null
  1893:    const manifest = readJsonObject(join(dir, 'package.json'))
  1894:    if (manifest !== null) return { dir, manifest }
  1895:    if (resolve(dir) === stop) return null
  ```
- 影响：同一份 package.json 被读两次（一次 `existsSync` + 一次 `JSON.parse`）；两处"8 层"的魔数各写一份。
  另有一处差异：`manifestOfFile` 用 `stopAt` 防越界，`pluginPackageDirOf` 没有——它会把 profile 目录之外的
  祖先目录当"包"（虽然有 `node_modules` 那段围栏兜着，见 197–203）。
- 建议：合并成一个 `nearestManifest(file, { stopAt?, maxDepth? })`，返回 `{ dir, manifest }`，两处各取所需。
- 置信度：高

#### [P2] `reportFailures` 与 `loadExternalPlugins` 对「transcript 可能不存在」处理相反

- 位置：`src/host/kernel.ts:68-76`、`src/host/kernel.ts:110-116`
- 现象：同一个文件里，一个用可选链 + stderr 兜底，另一个直接 `root.transcript.system(...)`。
- 证据：
  ```
  70:  const transcript = root.get('transcript') as { system?: (text: string, level?: string) => void } | undefined
  73:    if (typeof transcript?.system === 'function') transcript.system(line, 'error')
  74:    else console.error('[numa] ' + line)
  112:    root.transcript.system(
  ```
- 影响：`transcript` 行挂不上时（`@pneuma/base` patch 缺失、或该行被用户停掉），
  `createKernel` 静默回来，`loadExternalPlugins` 在有外部插件加载失败时抛 `TypeError`，
  启动流程整个断在这儿，报错内容是「Cannot read properties of undefined」。
  `plugin-loader.ts:1456-1460` 的 `warnApplicationRow` 也是同一个可选链口径，说明"没有 transcript"是被承认的正常态。
- 建议：`kernel.ts:112` 改用同一份 `reportFailures` 逻辑（或复用 `warnApplicationRow`）。
- 置信度：中（`transcript` 行由 base patch 挂，缺失前提未实证；代码路径已核）

#### [P2] `startPluginHotUpdate` 被两条启动路径各拉一次，靠函数内幂等兜

- 位置：`src/core/plugin-loader.ts:1422`、`src/core/plugin-loader.ts:976`、`src/core/plugin-loader.ts:1436-1438`
- 现象：`mountApplicationRows` 结尾无条件拉一次（不带 profileDir），`mountAllExternalPlugins` 有 profile 时再拉一次（带 profileDir）。
  第二次是"补上 profile 这一路"，靠 `startPluginWatch` 自己幂等。
- 证据：
  ```
  1422:  await startPluginHotUpdate(root, appDir)
  976:    await startPluginHotUpdate(root, APP_INSTALL_DIR, profileDir)
  1437:  * 之后不用重启。装配路径与宿主启动路径的先后不保证，所以本函数允许被调两次：
  ```
- 影响：这条幂等性只写在注释里，没有类型或断言约束。若启动顺序变化（先 `loadExternalPlugins` 后 `createKernel`，
  或探针只调其一），profile 监听就不起来，现象是「`numa plugin add` 之后要重启」，与注释承诺相反。
- 建议：把轮询器启动收到 `kernel.ts` 一处显式调用，参数（appDir + profileDir）在那里一次算齐。
- 置信度：中

### `src/core/plugin-registry.ts`

#### [P1] 一个开关三种键形状，都落进同一份 `entries`，而插件中心只认一种

- 位置：`src/core/ui-bundles.ts:97-99`（内置界面单元 `ui-<id>`）、`src/core/ui-bundles.ts:911`（第三方 `<目录名>/ui/client.js`）、
  `src/core/ui-bundles.ts:1605`（组合包 `<包名>/client`）、`src/core/plugin-registry.ts:477-498`（`listPluginInfos` 只列 catalog）
- 现象：三类界面半边的启停键都写进 `plugins.json` 的 `entries`，但 `listPluginInfos` 遍历的是**注册表 catalog**
  （只有宿主行），所以插件中心的「插件」页看不到界面半边的开关；它们只在 `listUiTrust`（信任卡）里出现。
- 证据：
  ```
  97: function builtinSwitchKey(id: string): string {
  98:   return `ui-${id}`
  911:    const fileKey = `${name}/ui/client.js`
  1605:    const key = `${name}/client`
  ```
- 影响：用户看到的"已安装插件"是两张互不重叠的表：`plugin_manager` 工具列的是 catalog，
  界面信任卡列的是界面半边。同一个人装一个带界面半边的组合包，会看到它出现在两处、两处开关各自独立、
  关掉「插件」页那一项界面还在（因为界面半边是另一个键）。改键形状时要同时改 4 处。
- 建议：在 `plugin-registry` 里显式登记「一个插件可能有的多个启停键」的映射（`plugin → [hostKey, uiKey]`），
  让 `listPluginInfos` 能带出界面半边的启用状态；三种键的生成函数收到一处（现在 `builtinSwitchKey` 只有 ui-bundles 用）。
- 置信度：高（三处键的生成与消费点都读过）

#### [P2] `listPluginInfos` 与 `readEnabledPlugins` 对 `toggleable` 的处理不一致

- 位置：`src/core/plugin-registry.ts:477-498`、`src/core/plugin-registry.ts:404-413`
- 现象：`listPluginInfos` 里不可停用的行强行 `disabled = false`（`enabled: true`），
  `readEnabledPlugins` 却会照 `entries` 里的 `disabled` 返回（不可停用的行走 `entryIndexOf` 命中后直接看 `entry.disabled`）。
- 证据：
  ```
  482:    const disabled = canToggle ? (entry?.disabled ?? meta.defaultDisabled === true) : false
  409:    const on = index < 0 ? catalog.get(file)?.defaultDisabled !== true : !entries[index]!.disabled
  ```
- 影响：内核行（`session` / `llm` 等）若在 `plugins.json` 里被写成 `disabled: true`（旧版本留下的、或 `plugin_manager`
  绕过 `toggleable` 写进去的，见上一条），界面显示"启用"，实际挂载路径却按"停用"跳过。两侧读同一状态、结论相反。
- 建议：把「判定 + 展示」收成一个函数 `pluginSwitchState(file)`，两处都用它。
- 置信度：高

### `src/core/ui-bundles.ts` + `ui-manifest.ts`

#### [P1] `ui-bundles.ts` 1779 行装四件事，中段还有一条 import

- 位置：`src/core/ui-bundles.ts:30-37` 与 `src/core/ui-bundles.ts:782-785`（同一个文件的第二组 import）
- 现象：四块职责：①内置产物清单（40–773）、②第三方界面插件发现 + 信任（775–1182）、
  ③组合包界面半边（1185–1690）、④平台汇总与按 rev 取字节（1692–1779）。
  第三方/组合包两块各带一套缓存（843 / 1227），各带一套"发现 + 信任卡"两条腿。
- 证据：
  ```
  782: import { readdirSync } from 'node:fs'
  783: import type { UiTrustProblemKind, UiTrustView } from '../contract.js'
  784: import { dscPath } from './path-policy.js'
  785: import { isPluginEnabled, readEnabledPlugins, readUiPluginTrust, trustUiPlugin, type UiPluginTrustEntry } from './plugin-registry.js'
  ```
- 影响：文件中部出现 import 说明它是"后期追加的一段代码"，与前半段共享 `PLUGIN_ID` / `inside` 但依赖面完全不同。
  想把"第三方界面插件"整个拿掉（阶段 7 的实验特性）时，删不干净——缓存、`lookup*`、`isThirdPartyUiEntry` 分散在四处。
  另：`readEnabledPlugins` 被 import 进来只服务内置那一档（650），第三方/组合包那两条路仍逐条读（见本节 P2）。
- 建议：按三块拆成 `ui-bundles-builtin.ts` / `ui-bundles-third-party.ts` / `ui-bundles-package.ts`，
  `ui-bundles.ts` 只留 `collectUiArtifactsForPlatform` 与 `toUiPluginRows` 两个汇总口。
- 置信度：高

#### [P1] 第三方的「发现」与「信任卡」是两份完整判定链，组合包侧已抽公共函数、第三方没抽

- 位置：`src/core/ui-bundles.ts:864-979`（`discoverThirdPartyUiArtifacts`）与 `1005-1083`（`scanThirdPartyUiTrusts`）
- 现象：同一套判定（`plugin.json` 存在 → `api` 必填 → 撞名 → 门禁 → 停用 → 信任）写了两遍，顺序与文案各一份；
  而组合包那侧已经抽出了 `judgePackageClient`（1405–1469）供 `discoverPackageUiArtifacts:1505` 与
  `scanPackageUiTrusts:1626` 共用。**同一个文件里，一条路抽了公共函数、另一条没抽。**
- 证据：
  ```
  918:    const gate = evaluateUiApiGate(api, shellApiVersion)
  919:    if (gate !== null) {
  1064:      const gate = evaluateUiApiGate(api, shellApiVersion)
  1065:      if (gate !== null) {
  ```
- 影响：两处的"下一步动作"分类要对齐（`problemKind` 只有信任卡那侧产出）。现在 `discoverThirdParty` 加了新判据
  （比如再挡一种 id 形状），信任卡不会跟着说，用户看到卡片"没问题"但插件就是不装载——这正是 996–998 注释想避免的情况。
- 建议：照 `judgePackageClient` 的做法抽出 `judgeThirdPartyClient(name, dir, doc, shellApiVersion, builtinIds)`，
  两个函数都只做"形状转换"。
- 置信度：高

#### [P2] 三种「是否启用」的界面半边判定键各自实现，没共用

- 位置：`src/core/ui-bundles.ts:1149-1155`（`isThirdPartyUiEntry`）、`src/core/ui-bundles.ts:1653-1660`（`isPackageUiEntry`）、
  `src/core/ui-bundles.ts:97-99`（`builtinSwitchKey`）
- 现象：三个函数都在回答"这个 `plugins.json` 键是不是界面半边的开关"，前两个靠字符串切分 + 回查磁盘，
  内置那个连反查都没有（只用来生成键）。
- 证据：
  ```
  1150:  const at = file.indexOf('/ui/')
  1154:  return existsClient(thirdPartyUiRoot(), name)
  1654:  const suffix = '/client'
  1659:  return decl !== null && decl.platform === 'pneuma'
  ```
- 影响：`runtime/index.ts:194` 与 `:204` 依次调这两个函数（先第三方后组合包），顺序即优先级；
  一个键既像第三方又像组合包时（目录名恰好等于包名），判定结果依赖调用顺序，而这个顺序没有任何注释或断言约束。
- 建议：合成一个 `uiSwitchKind(file): 'builtin' | 'third-party' | 'package' | null`，判定顺序写在函数里。
- 置信度：中（未构造冲突用例实证）

#### [P2] 文件戳三种实现，两处取整一处不取整

- 位置：`src/core/ui-bundles.ts:488-495`（`stampOf`，`Math.trunc(mtimeMs)`）、`:1300-1307`（`statStamp`，原值 mtime）、
  `:1356-1362`（`existsStamp`，只 mtime）
- 现象：三份"文件有没有变"的指纹，两处是 `mtime:size`，一处只 mtime，一处把毫秒截断。
- 证据：
  ```
  491:    return `${String(Math.trunc(stat.mtimeMs))}:${String(stat.size)}`
  1303:    return `${String(stat.mtimeMs)}:${String(stat.size)}`
  1358:    return statSync(path).mtimeMs
  ```
- 影响：`stampOf` 的服务对象（内置产物缓存）与 `statStamp` 的服务对象（包声明缓存）对"同一毫秒内的重写"
  判据不同：截断那份会把同毫秒改写当"没变"而继续给旧字节（`ui-manifest.ts:207-208` 的注释专门讨论过这个问题）。
- 建议：只留一份 `fileStamp(path)`（不截断），另两个删掉。
- 置信度：高

#### [P2] 内置界面单元用批版读开关（19 个一次读盘），第三方与组合包仍逐条读

- 位置：`src/core/ui-bundles.ts:650`（批版）与 `:923`、`:1040`、`:1527`、`:1619`、`:1633`（单条版）
- 现象：同一个文件里两种读法并存。内置那一档专门写了注释解释「为什么必须批读」，
  第三方（923 在 `for (const name of names)` 里）与组合包（1527 在 `for (const {name, dir} of packageDirs(...))` 里）
  还是每条一次 `isPluginEnabled` → 每次「读整份 `plugins.json` + `JSON.parse`」。
- 证据：
  ```
  646:    * 表本身照旧缓存，这里每次只按开关切一刀（`readEnabledPlugins` 一次读盘）。
  650:    const enabled = readEnabledPlugins(this.entries.map((entry) => builtinSwitchKey(entry.id)))
  923:    if (!isPluginEnabled(fileKey)) {
  1527:    if (!isPluginEnabled(where)) {
  ```
- 影响：`plugins.json` 里条目越多、profile 里包越多，组图越慢：N 个包 = N 次整份 JSON 解析。
  `collectUiArtifactsForPlatform` 每次 `/boot.js` 与 HMR 轮询都会跑（`ui-bundles.ts:1312-1313` 的注释承认过这个调用频次）。
  批版已经存在，只是没铺到后两条路。
- 建议：`discoverThirdPartyUiArtifacts` 与 `discoverPackageUiArtifacts` 也先在循环外取一次批版集合，循环内查表。
- 置信度：高

#### [P2] 「pneuma 段优先、dsh 段兜底」的读法在 `plugin-bundle` 与 `ui-bundles` 各写一遍

- 位置：`src/core/plugin-bundle.ts:183-192`、`src/core/ui-bundles.ts:1259-1263`
- 现象：两处都在读 `pneuma.*` 与 `dsh.*` 两个命名空间，选择规则略有不同：
  `readBundle` 是「`own.bundle` / `own.client` 都没有才整段用 foreign」；`readClientDeclaration` 是
  「`pneuma.client ?? dsh.client`」逐字段兜底。
- 证据：
  ```
  plugin-bundle.ts:191:  const bundle = own?.client === undefined && own?.bundle === undefined ? foreign : own
  ui-bundles.ts:1263:  const client = sectionOf('pneuma')?.['client'] ?? sectionOf('dsh')?.['client']
  ```
- 影响：一份包同时写 `pneuma.bundle` 与 `dsh.client` 时，两处会给出不同答案：宿主插件侧认为"全用 pneuma"，
  界面侧认为"pneuma 没有 client，用 dsh 的 client"。这正是"读一处忘一处"的典型。
- 建议：抽 `readPneumaSection(manifest)`，返回 `{ namespace: 'pneuma'|'dsh', bundle?, client? }`，两处都用。
- 置信度：中（未构造同时声明两侧的用例）

#### [P2] `inject` 没走 `readNameList`，`services` / `external` 走了

- 位置：`src/core/ui-bundles.ts:1544-1546`、`:1517-1521`、`:456-468`
- 现象：组合包界面半边的 `services` / `external` 走 `readNameList`（坏值记 problem），
  `inject` 直接在构造条目时 `Array.isArray` + `filter`（坏值静默丢弃）。
- 证据：
  ```
  1517:    const services = readNameList(decl.services, name, 'pneuma.client.services', problems)
  1521:    const external = readNameList(decl.external, name, 'pneuma.client.external', problems)
  1544:      ...(Array.isArray(decl.inject)
  1545:        ? { inject: decl.inject.filter((value): value is string => typeof value === 'string') }
  ```
- 影响：`pneuma.client.inject: ['a', 42]` 里那个 42 会无声消失，用户拿到的启动图里少一条依赖边，
  装载器因此不会等它——表现是"明明写了依赖，就是没生效"，且诊断区不报。
- 建议：`inject` 同样走 `readNameList(decl.inject, name, 'pneuma.client.inject', problems)`。
- 置信度：高

### `plugin-locale.ts` / `profile-*`

#### [P2] 缺省语言常量两处：`DEFAULT_LANGUAGE` 与 config 的 `language`

- 位置：`src/core/plugin-locale.ts:23`、`src/core/plugin-locale.ts:71-73`
- 现象：只有 `en*` 会取译本，其余一律用清单原文（中文）。`languageOfConfigFile` 每次调用都读一次 config.yaml。
- 证据：
  ```
  72:  return language.trim().toLowerCase().startsWith('en') ? 'en' : null
  ```
- 影响：`mountRow` 每行读一次 config 已经被 `RowMountContext.language` 一次性收口（`plugin-loader.ts:1486-1491`，做得对）；
  但 `ui-bootstrap` 那条路（`ui-boot-source.ts` 的 host.language）是另算的。新增第三种壳时又要算一次。
- 建议：把「当前显示语言」收成 `core/i18n.ts` 的一个取值口（已有该文件），locale 与 boot graph 都从它取。
- 置信度：中（未核 `i18n.ts` 是否已有等价函数）

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
|---|---|---|---|---|
| 内核能力实现位置（18 个一行转发垫片） | `src/core/<x>.ts`（1 行 `export * from '../packages/…'`） | `src/packages/<pkg>/<x>.ts` | `src/services/types.ts:16`（approval）、`:20`（memory，均只取类型）；`src/packages/lsp/manager.ts:16`（mcp，运行时函数）；9 个测试脚本 import `lib/core/*.js` | 6 个零引用直接删（见下表）；12 个把调用方改成 `@pneuma/<pkg>` 后删 |
| 外部插件来源 | `config.yaml` 的 `plugins:` 段（`startup.ts:24-40`，只有字符串路径） | `~/.dsc/plugins/*.js` 自动发现 + 上述 extraPaths | 两条都在启动时跑（`boot.ts:27`、`headless.ts:24`） | 保留，但把 `readUiConfig` 的段名从 `ui.plugins`/`plugins` 二义收成一个 |
| 应用自带行装配 | `mountApplicationRows` 读 `@pneuma/base/cordis.patch.yml`（`plugin-loader.ts:1375-1387`） | 各包自己的 `cordis.patch.yml` → 由 `build-packages.mjs:245` 合成一层 | 活的两段，同时存在 | 保留（合成是构建期行为，运行时只见一层） |
| 组合包装配 | `mountBundlePlugins`（启动时一次，`plugin-loader.ts:1071`） | `reconcileProfileBundles`（热更每轮按 id 差，`:1231`） | 两条都在用（`mountAllExternalPlugins:969` 与 `plugin-watch`） | 让启动路径也走 reconcile（传空 baseline），删掉重复的"读层 → 套 patch"那段 |
| 界面插件来源 | 第三方 `~/.dsc/plugins/<目录>/ui/client.js`（`ui-bundles.ts:864`） | 组合包 `<包>/client`（`ui-bundles.ts:1477`） | 两条都在用，由 `collectUiArtifactsForPlatform:1698` 合并 | 保留两条来源，但把判定抽成一份（见 P1「第三方没抽 judge」） |
| 界面半边的开关键 | `ui-<id>`（内置，`ui-bundles.ts:97`） | `<目录>/ui/client.js`（第三方，`:911`）／`<包名>/client`（组合包，`:1605`） | 三种都写进同一份 `plugins.json` | 收成一个 `uiSwitchKind()`；`listPluginInfos` 要能带出它们 |
| dsh 兼容层的副作用 | `core/plugin-loader` 内联（`:433-437`、`:830-850`、`:859-864`） | `packages/dsh-compat` 插件（`index.ts:34-70`） | 两处各做一半（`DSH_HOME`、`ensureResolveHook` 重复） | 抽 `core/dsh-compat/activate.ts`，插件只留 logger |
| 界面形态判定 | 宿主行 `SURFACE_ROW_SKIPS`（`plugin-loader.ts:1299-1310`，决定挂不挂 `tui`/`host-stdio`/`remote` 行） | 界面产物 `platform: 'web' \| 'tui'`（`ui-manifest.ts:16`，`collectUiArtifactsForPlatform:1698`） | 两条都在用（`ui-core/tui-plugins.ts:98` 用后者） | 两件事（挂不挂宿主行 / 出不出界面产物）保持分开，但在文档里点明它们是两个轴 |
| 插件管理动作 | `plugin_manager` 工具（`packages/plugin-manager/index.ts:76`） | 插件中心 `setPluginEnabled`（`packages/runtime/index.ts:178`） | 两条都在用 | 共享一份 `setPluginEnabledHot`，前置校验上提（见 P1） |

### 18 个一行转发垫片的逐个引用结果

全仓 `^export \* from '../packages/` 命中 **18 个**（不是任务描述里的 58 个；`src/core/` 共 88 个 `.ts`，其余都有实现）。
「引用」= 全仓 `*.ts/*.tsx/*.mjs/*.js` 里出现 `core/<名字>.js` 或等价相对路径。

| # | 垫片 | 引用方 | 分类 | 处置 |
|---|---|---|---|---|
| 1 | `approval.ts` | `src/services/types.ts:16`（类型） | src | 与 #10 一起改：`types.ts` 直连 `@pneuma/approval` 后删 |
| 2 | `memory.ts` | `src/services/types.ts:20`（类型） | src | 同上，直连 `@pneuma/memory` |
| 3 | `mcp.ts` | `src/packages/lsp/manager.ts:16`（`buildChildEnv`，运行时） | src | **包 import 包**（`lsp` → `mcp` 内部文件），应改走 `@pneuma/mcp` 的导出或抽进库包 |
| 4 | `approval-floor.ts` | `scripts/floor-shell-and-budget-test.mjs:16`、`terminal-env-test.mjs:34`、`tool-output-fixes-test.mjs:20` | scripts | 保留（测试 import 的是 `lib/core/*`，删垫片就要改 3 个脚本） |
| 5 | `call-meaning.ts` | `scripts/call-meaning-test.mjs:18` | scripts | 同上 |
| 6 | `connection-test.ts` | `scripts/connection-test-test.mjs:43` | scripts | 同上 |
| 7 | `desktop-control.ts` | `scripts/computer-use-test.mjs:57` | scripts | 同上 |
| 8 | `microcompact.ts` | `scripts/context-pipeline-test.mjs:33` | scripts | 同上 |
| 9 | `tool-result-prune.ts` | `scripts/context-segments-test.mjs:42` | scripts | 同上 |
| 10 | `tool-search.ts` | `scripts/tool-search-test.mjs:50` | scripts | 同上 |
| 11 | `session-index.ts` | `scripts/session-index-fuzzy-test.mjs:61` | scripts | 同上 |
| 12 | `agent-roles.ts` | `scripts/resident-agents-test.mjs:329` | scripts | 同上 |
| 13 | `goal.ts` | **无引用** | 可删 | 删（真实调用方 `packages/goal/index.ts:20` 走 `./goal.js`） |
| 14 | `todo.ts` | **无引用** | 可删 | 删（`packages/todo/index.ts:21` 走 `./todo.js`） |
| 15 | `session-export.ts` | **无引用** | 可删 | 删（`packages/commands/index.ts:32` 走 `./session-export.js`） |
| 16 | `surface-registry.ts` | **无引用** | 可删 | 删（`packages/surfaces/index.ts:11` 走 `./surface-registry.js`） |
| 17 | `model-discovery.ts` | **无引用** | 可删 | 删（`packages/settings/index.ts:37` 走 `./model-discovery.js`） |
| 18 | `memory-eval.ts` | **无引用** | 可删 | 删（`packages/memory/index.ts:42-43` 走 `./memory-eval.js`） |

结论：**6 个可立即删**（#13–18），**9 个因测试脚本必须保留**（#4–12，除非同批改 9 个脚本的 import），
**3 个因 src 内引用暂时保留**（#1–3，其中 #3 是包 import 包，属分层违规，优先级高于删垫片）。
`ui-shell/` 与 `desktop/` 对 18 个垫片**零引用**（ui-shell 只 import `@dsc/*` 与 `@pneuma/runtime/*`）。

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
|---|---|---|---|---|
| 「这个插件开没开」 | `plugin-registry.ts:404-421`（认别名、认 `defaultDisabled`、有批版） | `plugin-loader.ts:1973-1975`（只认精确 file、无回落、每次全量读盘） | B 少两条语义、多 N 次读盘；两处对同一份 JSON 结论可不同 | 删 B，改调 `readEnabledPlugins` |
| 「向上找最近 package.json」 | `plugin-loader.ts:179-188` | `plugin-loader.ts:1889-1901` | A 用根目录终止、无 stopAt；B 用 profile 目录终止并回传清单 | 合成 `nearestManifest(file, {stopAt})` |
| 「JSON 松读」 | `plugin-bundle.ts:102-109`（`readJson`） | `plugin-loader.ts:1963-1971`（`readJsonObject`）、`ui-bundles.ts` 内联 5 处（270/325/884/1023/1254）、`plugin-registry.ts:285-301`（严格版，抛错） | 语义从"给 null"到"抛错"三档；`ui-bundles` 全内联 | 抽 `core/json-file.ts`：`readJsonLoose` / `readJsonStrict` |
| 「挂一个插件」 | `plugin-loader.ts:531-549`（内置对象） | `plugin-loader.ts:579-607`（外部模块）、`:766-791`（热重挂） | 内置那份不走 `inspectPluginModule`、不登记 alias/source、错误处理自己一套 | 三处都收到 `mountInspected(inspected, meta, options)` |
| 「插件配置从哪来」 | `plugin-patch.ts:199-202`（patch 行 config 整块替换） | `plugin-registry.ts:388-392`（`resolvePluginConfig`：磁盘覆盖装配值）、`plugin-loader.ts:495`（宿主整份替代） | 三套合并口径，且 patch 那套**没有消费者** | 定一份优先级并只在一处实现（见 P0） |
| 「文件指纹」 | `ui-bundles.ts:488-495`（trunc mtime） | `ui-bundles.ts:1300-1307`（原值 mtime）、`:1356-1362`（只 mtime） | 截断与否不同，对同毫秒重写判据不同 | 只留 `fileStamp()` |
| 「pneuma/dsh 段选择」 | `plugin-bundle.ts:183-192` | `ui-bundles.ts:1259-1263` | A 整段二选一；B 逐字段兜底 | 抽 `readPneumaSection(manifest)` |
| 「platforms 校验」 | `ui-bundles.ts:357-365`（bundle.json） | `ui-bundles.ts:897-904`（plugin.json）、`:1389-1397`（`packagePlatformsOf`）、`:1049-1056`（信任卡只读不校验） | 三处报错文案不同；信任卡那处不校验 | 抽 `readPlatforms(raw)`，四处共用 |
| 「phase 校验」 | `ui-bundles.ts:431-435` | `ui-bundles.ts:906-910`、`:1522-1526` | 三份逐字相同 | 同上，抽 `readPhase(raw)` |
| 「第三方界面插件判定链」 | `ui-bundles.ts:864-979` | `ui-bundles.ts:1005-1083` | 顺序与文案各一份；只有 B 产出 `problemKind` | 照 `judgePackageClient`（1405）抽 `judgeThirdPartyClient` |
| 「界面半边的启停键」 | `ui-bundles.ts:97-99` | `ui-bundles.ts:911`、`:1605` | 三种形状，靠字符串切分互认 | 抽 `uiSwitchKind()` |
| 「引擎版本闸」 | `plugin-loader.ts:1113`（包级，整包跳过） | `plugin-loader.ts:1534`（行级，单行跳过） | 判据相同、文案不同、跳过粒度不同、豁免来源不同 | 删包级那一处 |
| 「transcript 可能不存在」 | `kernel.ts:68-76`（可选链 + stderr） | `kernel.ts:110-116`（直调）、`plugin-loader.ts:1456-1460`（可选链） | 一处会抛 TypeError | 统一走 `reportFailures` |
| 「DSH_HOME 归一」 | `plugin-loader.ts:859-864` | `packages/dsh-compat/index.ts:43` | 逐字相同的两行 | 收进 `applyCompatEnv` |
| 「服务名是否属于 dsc」 | `plugin-loader.ts:92-97`（Set） | `core/dsh-compat/service-map.ts`（描述表）、`src/services/types.ts`（Context 声明） | 三份清单无机器校验 | 从类型生成，或加断言脚本 |

## 待核实

1. **`group` 子行的真实使用面**：全仓 `grep "group: *true"` 零命中，所以 P1 的 group 断点当前不可触发。
   但 `scripts/dsh-bundle-check.mjs`（15 KB）与 `scripts/dsh-real-package-e2e.mjs` 会装真实 dsh 包，
   未逐行核对这些夹具里有没有 group 形态的 patch——若有一份，则该条升 P0。
2. **`ui-shell` 侧读启动图的位置**：`ui-shell/src/` 对 `UiPluginRow` / `UiBootGraph` / `__DSH_BOOT__` / `combo` **零命中**，
   启动图的消费方是 `src/packages/ui-boot/ui/boot.ts:271-282`（`readBootGraph`）。所以「ui-manifest 与 plugin-api 重复定义协议类型」
   这个问题**不成立**（`plugin-api.ts` 是槽位/组件 API，不含启动图类型）。但 `ui-boot` 是否在运行时另建了一份形状校验未读，待核。
3. **`plugin-watch.ts` 全文**：只核了 import 面（31–44）与 `startPluginWatch`（972）。它内部是否对
   「同一批只换一代」（`remountExternalPlugins`）有第二套调度逻辑未核——若有，属新的重复。
4. **`scripts/build-packages.mjs:47-49` 只收 `insert` 行**：包自己的 patch 里「按 id 改别的行」的条目会被静默丢掉。
   是否刻意（各包只许插自己的行）未在文档里找到说明，待与作者确认。
5. **`plugin-registry.ts:172-190` `putEntry` 的"旧键双写"**：命中旧键时会 push 一条新键条目，于是
   `readPluginEntries()` 里同一个插件出现两条（旧键 + 新键）。`listPluginInfos:478` 用 `new Map(...)` 按 file 建索引，
   两条会互相覆盖，结果取决于数组顺序。是否已有清理动作（读时迁移后删旧键）未找到，待核。
6. **`isPackageUiEntry` / `isThirdPartyUiEntry` 的先后**：`runtime/index.ts:194` 与 `:204` 的判定顺序，
   在"第三方目录名 == profile 里的包名"时的行为未构造用例验证。
7. **`plugin-loader.ts:1582` 的 `native` 判定**：靠 `row.name.startsWith('@pneuma/')` 猜"这是自家包"。
   一个 profile 里的第三方包恰好叫 `@pneuma/foo`（或官方包被改名为别的 scope）时会走错分支——
   `native` 决定要不要套 dsh 兼容面，错判会让插件挂不上。是否有意以 scope 为界，待与作者确认。
8. **`plugin-loader.ts:1582` 的 `native` 判定**：靠 `row.name.startsWith('@pneuma/')` 猜"这是自家包"。
   一个 profile 里的第三方包恰好叫 `@pneuma/foo`（或官方包被改名为别的 scope）时会走错分支——
   `native` 决定要不要套 dsh 兼容面，错判会让插件挂不上。是否有意以 scope 为界，待与作者确认。
