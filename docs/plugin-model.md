# Pneuma 插件模型（契约）

配套 `docs/plugin-equality-plan.md`。**代码与本文冲突时以本文为准；改契约先改这里。**

## 1. 一个功能 = 一个包

```
src/packages/<id>/
  package.json
  cordis.patch.yml
  index.ts              # 宿主半边入口
  ui/                   # 可选：界面半边源码（产物仍落 lib/ui/plugins/<id>）
```

构建产物：

```
lib/packages/<id>/{package.json, cordis.patch.yml, index.js}
lib/ui/plugins/<id>/client.js
```

## 2. package.json

```jsonc
{
  "name": "@pneuma/ops",
  "version": "1.2.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./panel": "./panel.js",          // 子路径行要用它
    "./package.json": "./package.json"
  },
  "pneuma": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "resolution": "overridable",       // pinned | overridable
    "order": 120,                      // 基础包里的行序（数字小的先）
    "title": "文档与批量读取",          // 插件中心显示名（不加载代码也能列出来）
    "description": "读 PDF / Word / CSV……",
    "settingsSection": "ops",          // 可选：插件中心齿轮跳转的分区 id
    "client": { "platform": "pneuma", "api": "^2.0.0", "inject": ["settings"] }
  },
  "engines": { "pneuma": ">=1.0.0 <2.0.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.4" }
}
```

第三方 dsh 包继续用 `dsh.bundle.patch` / `dsh.client` / `engines.dsh`，loader 两种前缀都读，语义一致。**没有只给官方包用的字段。**

## 3. 行

```yaml
- insert:
    - id: ops
      name: '@pneuma/ops'
      config: { timeoutMs: 30000 }
    - id: ops-panel
      name: '@pneuma/ops/panel'
      disabled: true
```

1. `id` 全局唯一，格式 `[a-z0-9][a-z0-9-]*`；重复即启动失败。缺 id 也启动失败（dsh 会随机生成一个，跨启动不稳定，我们不学）。
2. `name` 是包名或 `包名/子路径`，**用 Node 自己的解析**（`createRequire(profile 的 package.json).resolve(name)`），不手写 exports 展开——手写会漏 conditions、通配与 `#imports`。
3. **行序不是加载序**。依赖用行上的 `inject` 表达（dsh 的 base patch 开头就写明这一点）；行序只作「同一批依赖都就绪」时的稳定排序，保证可复现。
4. `disabled: true` = 默认关；用户开关写 `~/.dsc/plugins.json`，不改包内 patch。
5. 行 `config` 是默认值，`plugins.json` 的 config 逐键覆盖。
6. 行支持 `group`（`config` 即子行数组，子行 id 用 `组id:子id` 前缀，避免撞名）、`isolate`、`intercept`，原样透传给 cordis；不理解的行字段保留，不吞。
7. `!!js` 一律拒绝（dsh 会求值，等于让插件包在宿主进程里执行任意表达式）。这是有意偏离，写在文档里，不静默跳过。

## 4. 身份

- 运行时身份 = **行 id**。`mounted`、`plugins.json`、插件中心、`plugin_manager` 工具、设置分区关联全按行 id。
- 不再用文件名做身份。
- 同一个包的多行是多个身份，各自可停用；`disabled` 的行也进目录（能看见、能打开）。

## 5. 解析

| 取值 | 顺序 | 用途 |
|---|---|---|
| `pinned` | 应用安装目录 → profile | 运行时与核心服务包 |
| `overridable` | profile → 应用安装目录 | 功能包、第三方包 |

- 应用安装目录 = 运行中 Pneuma 的 `package.json` 所在目录（桌面端 `dsc-core/`）。
- 全进程**一张解析表**：每个包名只允许一个物理目录；同一包名解析出两个目录 = 启动失败并打印双方路径（dsh 同口径，防两份服务实例）。
- 包缺失：告警并跳过该行，其余照常；插件中心显示「缺包」与期望版本。
- **应用自带的行也走这套解析**：行目标是包名时按包自己的 `pneuma.resolution` 在「应用安装目录」与
  「生效的 profile」两个锚点里选（生效 = `activeProfileDir()`）。用户装一份改过的官方包，就会真的顶替
  应用那份；`pinned` 的包不认覆盖。
- **两个锚点不混用**：应用自带行的相对路径（`./x`）仍按 `@pneuma/base` 包目录算，包级覆盖去 profile 里找。
  混成一条会出两种错：相对路径跑进 profile，或者覆盖永远不生效。
- profile 里的覆盖版会 `import '@pneuma/runtime/*'`，所以挂应用自带行时也要把 profile 的
  `node_modules` 交给解析钩子（否则覆盖版一加载就 `ERR_MODULE_NOT_FOUND`）。
- 解析钩子只负责**库**：`@pneuma/runtime`（永远指向应用内那一份）与 `@deepseek-ai/*`（dsh 兼容），**不劫持 `@pneuma/<功能包>`**——劫持了 overridable 就永远不生效。钩子无条件生效，不依赖 dsh-compat 开关。

## 6. 运行时

`@pneuma/runtime` 是构建生成的适配包（`lib/node_modules/@pneuma/runtime`），每个模块只有一行 `export * from '../../../../core/<模块>.js'`。

- 它保证 `lib/core/*` 只有一个物理实例；两份实例会让 `core/tools/command-runner.ts` 的注册表落空、沙箱 fail-open。
- 源码期由 `tsconfig.paths` 把 `@pneuma/runtime/*` 映到 `src/*`。
- 不发布第二个 npm 包。

## 7. 版本闸

- `engines.pneuma` 对 `RUNTIME_CONTRACT_VERSION` 做 semver 比对。
- 插件模块仍可导出 `apiVersion`（数字），对 `KERNEL_API_VERSION` 比对；两者都在时都要满足。
- 判**两次**：
  1. 读组合包时判一次（`engines.dsh` / `engines.pneuma`，管整包能不能装）；
  2. **挂每一行之前再判一次 `engines.pneuma`**，判的是这一行实际解析到的包——`overridable` 的行会被
     profile 里的副本换掉，换上来那份要求哪一代契约只有它自己知道。
- 行级闸不满足 → 目录里登记该行并带 `problem`（插件中心看得见），挂载跳过，其余行照常。
  `profile 的 compatibility.json` 里登记过包名就照挂，并在告警里说明是豁免放行的。
- dsh 包的 `engines.dsh` 只在整包那一次判：行级只看 `engines.pneuma`，否则老插件的
  `peerDependencies: @deepseek-ai/dsh ^0.1` 会在行级被误杀。

## 8. 界面半边

- 粒度和 dsh 一样是**包**：一个界面单元 = 一个独立的包，**不并进宿主功能包**。
  形态照 dsh 的 `packages/client/ui-goal`：宿主半边是空的 `apply() {}`（只为进 Loader、拿到自己那一行与开关），
  界面半边在 `ui/`。2026-11-04 起 19 个界面单元全部是这个形态，源码在 `src/packages/ui-<id>/ui/`。
- **为什么不做成"一个功能一个包"**：两个界面单元挤一个包，它们的开关就绑在一起了——关一个面板会连带关掉另一个。
  dsh 也是每个界面单元一个包（`dsh-client-ui-*`），host 功能另包。
- **id 由产物目录名决定**（`src/core/ui-bundles.ts:355`），不由包名决定。包里叫 `ui-<id>`，产物仍落
  `lib/ui/plugins/<id>/client.js`；换算只有一处：`build-plugins.mjs` 的 `hostIdOf()`（先查覆盖表、再剥 `ui-` 前缀）。
- **开关按行 id 走**：产物 id 是 `<id>`，行 id 是 `ui-<id>`，换算在 `ui-bundles.ts` 的 `builtinSwitchKey(id)`。
  所以 `cordis.patch.yml` 里的行 id **必须写 `ui-<id>`**；写成 `<id>` 的话这一行永远关不掉对应的面板。
- **order**：19 个界面单元统一占 `350–368` 专用段（按 id 字典序），界面行不做任何事，这个段只为人读得懂。
- `pneuma.client.platform` 必须是 `pneuma`（写 `web`/`tui` 的属于 dsh 自己的壳，一律不收）；`api` 是
  `@dsc/ui` 的 semver 区间；`inject` 是客户端服务名。`dsh.client` 继续兼容读（内置界面包目前写的就是它）。
- **`exports["./client"]` 只对装在 profile 里的包有意义**：它指向包自己构建出来的 `client.js`。
  内置界面半的产物不在包内（在 `lib/ui/plugins/<id>/`），所以构建时不把这条抄进产物清单——
  抄进去就是一条 `ERR_MODULE_NOT_FOUND`。内置包的界面声明留在 `dsh.client` 元数据里。
- 缺产物 = 只上宿主半边，不报错（dsh 那边缺产物会让整页起不来，我们不跟）。

## 8.1 失败分级

| 情形 | 行为 |
|---|---|
| 包目录缺失 / 读不了 | 告警，跳过该包的全部行，其余照常 |
| 版本闸不满足 | 告警，跳过该包，其余照常（`compatibility.json` 可豁免） |
| 单行导入失败（模块语法/缺依赖） | 记 error，只跳过该行，进程继续 |
| 行 id 重复 / 缺 id | 启动失败（配置错误，不该带着跑） |
| 界面产物缺失 | 忽略该界面半边，宿主半边照常 |

## 9. 状态文件

- 插件开关与配置：`~/.dsc/plugins.json`（等价于 dsh 的 profile patch 行）。
- 读写按「新行 id → 旧键」双查，命中旧键时惰性写回新键。
- **文件存在但解析失败时拒绝写盘**并报错；不得整份覆盖成空。
- 未知键原样保留。

## 10. 内核职责

`src/host/kernel.ts` 只允许：建 Context、读 profile、调 `mountBundlePlugins`、启动收尾。行数 ≤ 120。
`src/boot.ts` / `src/headless.ts` 只允许选择 profile 与界面形态，不得静态 import 任何插件。
## 11. 界面形态与原生包

- **surface**：`createKernel` 收 `'tui' | 'headless'`。哪些行不挂写在 loader 的
  `SURFACE_ROW_SKIPS`（tui 不挂 `host-stdio`，headless 不挂 `tui`），是这张表的唯一出处；
  入口只传 surface，不自己判断。
- **原生包**：行名以 `@pneuma/` 开头的包不按 dsh 插件口径处理——不做「陌生服务名 = dsh 插件」
  的判定，也不套 dsh 的工具兼容面。否则 `inject: ['presets']` 这种自己的服务名会被误判成
  dsh 插件，天然挂不上。
- **名字冲突**：`@pneuma/runtime` 这个名字留给构建生成的运行时适配包。功能包里叫 `runtime`
  的那个（运行时适配器插件）包名是 `@pneuma/runtime-adapter`，行 id 仍是 `runtime`；
  构建脚本遇到包名撞 `@pneuma/runtime` 直接报错。
- **幂等按 root**：同一进程可以有多个 Context（自检会连开两个内核）。「已挂身份」按 root 记，
  换 Context 就该重新挂；看全局表会让第二个内核一行都起不来。
- **包产物是再导出桩**：`lib/packages/<id>/` 是唯一实体，`lib/node_modules/@pneuma/<id>/` 里每个文件只有一行
  `export * from '<指回 lib/packages 的相对路径>'`。这样探针/App 直接 import `lib/packages/...`、内核从
  `node_modules` 加载时，拿到的是**同一个模块实例**——`commands` 的 `serviceRef` 这类模块级单例才不会裂成两份。
- **界面半边是独立的包**：`src/packages/ui-<id>/`（薄宿主半 + `ui/`），19 个已全部落位，
  `ui-shell/src/packages/` 已删空。构建脚本仍保留旧根兜底分支与 `resolveUiHalf` 的三段查找，
  但正常路径上只会有新根。判据不变：一个包最多一条界面声明，缺产物只上宿主半边。
- **界面半边的依赖与类型归壳管**：`ui-shell/tsconfig.json` 反向 include `../src/packages/*/ui`，
  根 `tsconfig.json` 则 exclude 掉同一批路径（根 `lib` 只有 ES2023、没有 DOM）。
  两条必须同时成立，漏任一条的表现分别是「壳 typecheck 红」或「界面代码被当 Node 侧编进 lib」。

## 12. 默认 profile 与换包

- 首启（`createKernel` 第一行）铺 `~/.dsc/profiles/default/package.json`（`bundles: []`）。
  已有就一个字节不动。
- `activeProfileDir()` 的解析顺序：`DSC_PROFILE` → `config.yaml` 的 `profile:` →
  **存在就用的 `profiles/default`** → null。旧用户没铺过就走老路径。
- 用户装的包、覆盖版官方包都放这个 profile 的 `node_modules`；解析按包自己的
  `pneuma.resolution` 裁决（pinned 应用优先，overridable profile 优先）。
- 这条对**应用自带的 56 个功能包同样成立**：37 个 `overridable` 的包，用户在 profile 里放一份改过的
  就顶替应用那份（`numa plugin list` 会在那一行标「← profile 覆盖」，版本显示 profile 那份）；
  19 个 `pinned` 的包不认覆盖，profile 里有同名副本时告警并写清哪份不生效。
- 换包分两种：
  - **换目录**（把包装到另一个物理目录）仍需重启：解析表在启动时建一次，同一包名两个目录是启动失败（见 §5）。
  - **改代码**（同一个包目录里文件变了）**不重启就生效**：监视器发现变化 → 换代 → 重挂那一行，见 §14。
- 验收脚本 `scripts/plugin-swap-e2e.mjs`（进 `check:plugin`）：把 `lib/` 拷到临时目录、
  家目录也指到副本里，一个字节不碰真实的 `~/.dsc`；五件事——换包验行为变化、
  换 pinned 包的 profile 副本验「不让路 + 告警」、把声明改成 overridable 验「同一份副本立刻生效」、
  删可选包验仍能启动、删核心包验报出缺哪行。

## 13. 清单快照（门禁）

- 快照：`docs/baseline/0.9.0/inventory.json`，内容是「插件清单 / 设置分区 / 界面单元」三份，由
  `scripts/plugin-inventory.mjs` 在临时家目录里起一遍内核导出。
- 比对：`scripts/plugin-inventory-check.mjs` 逐项 diff（少的、多的、字段变了的都列出来），不一致非零退出；
  `--write` 表示「这次变化是有意的」，重写快照。它进 `check:plugin`。
- 0.8.1 那一份留在 `docs/baseline/0.8.1/`，只作改造前后的对照，不参与门禁（行数本来就该变）。

## 14. 热更新（改包代码不重启）

**适用范围**：从磁盘加载的行（应用自带的 56 个包、profile 组合包的行）。内置插件（对象随内核编译、磁盘上没有产物）没有新旧版本可言，监视器跳过。

### 14.1 为什么需要「代数戳」

包入口是一层再导出桩（`lib/node_modules/@pneuma/<id>/index.js` 只有一行 `export * from '../../../packages/<id>/index.js'`）。加载器早先靠 `?t=<mtime>` 破坏缓存，但戳打在**桩**上，桩背后的真实文件 URL 不变——改真实代码不生效（实测：同一个桩用两个不同 `?t` 导入，拿到的值完全相同）。

改法在**解析钩子**里：`registerHooks` 的 resolve 能看到包内部的相对 import，所以给落在功能包目录里的解析结果追加 `?g=<代数>`。

- **代数 0 = 启动态，不加任何戳**。启动路径与探针裸 import 命中同一物理实例，`@pneuma/runtime` 的单实例约定不破（§6）。
- **热重挂前 `bumpGeneration()`**：之后所有落在功能包目录里的 URL 都带新代数，Node 的 ESM 缓存不再复用旧模块；桩在新一代重新求值，它的 `export *` 再解析到新的真实文件。
- 同一代内所有入口收敛到同一个 URL（一代一实例），换代才出现新实例。
- `lib/core/**` 与 `@pneuma/runtime/**` **永远不戳**：戳了就是第二份内核状态，模块级注册表会落空、沙箱会 fail-open。

### 14.2 重挂的时序与失败语义

`remountExternalPlugin(行 id)`：

1. `bumpGeneration()`；
2. 导入新模块并跑全套校验（插件对象形状 / `apiVersion` / 行级 inject 的陌生服务 / `Config`）——与首次挂载共用同一个判定函数，避免两条路径各判一遍；
3. **全部通过**才停旧 fiber、挂新对象；
4. 导入或校验失败：**旧 fiber 原样继续跑**，只记 `meta.problem`「热重挂失败：…（旧版本继续运行）」，不停用、不写盘；
5. 挂新对象这一步失败：用首次挂载留存的对象与配置**回滚**，文案区分「已回滚到旧版本」与「旧版本也没能恢复」。

这与 dsh 不同：dsh 是逐出后失败即失败、旧代码不回来；我们要求保留旧版本，理由是用户手滑存坏一次不该把插件弄死。

### 14.3 触发与开关

- 监视器轮询（不用 fs.watch / chokidar：网络盘没有 inotify，Windows 上 fs.watch 不可靠，构建是「写临时文件再 rename」）。默认 1000ms 一轮、200ms 去抖，同一轮构建写多个文件只重挂一次。
- 监视范围是**包目录下的 .js / .json** 加上「桩指回的真实目录」——只盯入口文件会漏掉最常见的那种改动。
- 默认开；`DSC_HOT=0` 关闭。
- 失败必有一行 warn + `meta.problem`，不静默。

### 14.4 边界

- 换**目录**仍要重启（解析表不重置，同一包名两个目录是启动失败）。
- 换代后旧 URL 的模块实例留在进程里直到退出；开发态可接受，重启即清。
- 外部单文件插件（`~/.dsc/plugins/*.js`）仍用入口 URL 的 `?t=<mtime>` 换代，不参与代数戳。

## 15. 包标准（门禁）

`scripts/plugin-standard-check.mjs` 进 `check:plugin`，对 `src/packages/*` 逐包判。**八条硬项不过就红**，一条待办只打印不挡合并（它没有全绿之前，别对外说"标准齐了"）。

| # | 硬项 | 判据 |
|---|---|---|
| 1 | 清单字段 | `name`、`version`（**与根 package.json 一致**，发版用 `node scripts/sync-versions.mjs --write` 一起推）、`private`、`type`、`exports` 至少 `.` 与 `./package.json`、`pneuma.bundle.patch`、`pneuma.resolution`、`pneuma.order`、`engines.pneuma`、cordis 对等依赖 |
| 2 | exports 键集 | 只许标准键：`.`、`./client`、`./package.json`、`./locale/*.json`；多一个就报出来由人决定 |
| 3 | 清单本地化 | 声明了 `./locale/*.json` 就必须真有译本文件，且每个译本 `title` / `description` 都是非空字符串（坏 JSON、缺字段、只有键没有文件都红） |
| 4 | 行 | `cordis.patch.yml` 恰好一条 insert、一行；行 id 与目录约定一致（`ui-<id>` 目录 → `ui-<id>`，其余 → 目录名）；行 name 等于包名 |
| 5 | 入口导出 | 能按 loader 的兜底规则拿到插件对象（用 TypeScript 语法树判，不用正则） |
| 6 | 包间 import | 功能包之间零直接 import；功能包 → 库包允许；库包 → 任何包禁止；core → 包禁止（含 `import type`） |
| 7 | order | 撞号即红（两个包同号） |
| 8 | 文档与测试 | README 两段（Model Experience / Known Limitations）+ `tests/` 下至少一个 `*.test.mjs`（只有目录不算） |

待办一项：可疑的模块级可变状态（只打印）。

**现状（2026-11-04 晚）**：**87 个包 = 76 功能包 + 11 库包**，八项全绿；
87 篇 README 两段齐全、87 个包各有包级测试（87 个用例 / 437 条断言）；
「模块级可变状态」30 条里绝大多数是导出的只读常量表，剩下几条要人逐条看。
版本号已按 dsh 的做法写在每个包里（都与根 `0.8.1` 一致）。

### 15.0 README 与标题的写法约定

- README 首行固定 `# <目录名>（<pneuma.title 去掉尾部「（界面）」>）`。界面包的 title 带「（界面）」
  后缀用于插件中心区分同名宿主包，README 里再套一层括号会难看，所以只在 README 里去后缀。
- 每篇三节：`## Model Experience（模型体验）` / `## Known Limitations（已知限制）` / `## 行与开关`。
- 每条结论都要能指回代码（`文件:行号`）。**查不到就删掉那条，不许写「待确认」占位**——
  占位会让人以为有人核对过。
- 与 dsh 的差异只在查到实证时写；绝大多数包没有可指认的差异，就不写这一条。

### 15.1 一处比 dsh 松，且是有意的

dsh 要求函数插件命名导出 `name`/`inject`/`Config`/`apply`，服务插件 default 导出服务类。numa 的宿主包写的是
`export const xxxPlugin = { name, provide, apply }`，靠 `plugin-loader` 的兜底规则（默认导出带 apply → 唯一命名导出带 apply → 模块自身 apply）加载。

**不改的原因是产物形状**：`lib/node_modules/@pneuma/<id>/` 是 `export *` 桩，而 `export *` 不转发 `default`——
改成 default 导出，运行时反而拿不到，只是看着合规。要真走 dsh 形状，得先改 `build-packages.mjs` 的 `stubBody`。

### 15.2 门禁判不了、只能靠评审的三件事

1. 行的 `disabled` 该不该关、`order` 的先后有没有依赖依据（行序运行期由 `inject` 决定，静态看不出来）。
2. 动态拼出来的说明符（`import('@pneuma/' + name)`）与绕相对路径跨包。
3. README 的内容质量（门禁只判两段标题在不在）。

