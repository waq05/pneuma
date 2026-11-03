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
- 解析钩子只负责**库**：`@pneuma/runtime`（永远指向应用内那一份）与 `@deepseek-ai/*`（dsh 兼容），**不劫持 `@pneuma/<功能包>`**——劫持了 overridable 就永远不生效。钩子无条件生效，不依赖 dsh-compat 开关。

## 6. 运行时

`@pneuma/runtime` 是构建生成的适配包（`lib/node_modules/@pneuma/runtime`），每个模块只有一行 `export * from '../../../../core/<模块>.js'`。

- 它保证 `lib/core/*` 只有一个物理实例；两份实例会让 `core/tools/command-runner.ts` 的注册表落空、沙箱 fail-open。
- 源码期由 `tsconfig.paths` 把 `@pneuma/runtime/*` 映到 `src/*`。
- 不发布第二个 npm 包。

## 7. 版本闸

- `engines.pneuma` 对 `RUNTIME_CONTRACT_VERSION` 做 semver 比对。
- 插件模块仍可导出 `apiVersion`（数字），对 `KERNEL_API_VERSION` 比对；两者都在时都要满足。
- 不满足 → 跳过该行、写清原因，不影响其它行。

## 8. 界面半边

- 粒度和 dsh 一样是**包**，不是行：一个包最多一条界面声明。
- `pneuma.client.platform` 必须是 `pneuma`（写 `web`/`tui` 的属于 dsh 自己的壳，一律不收）；`api` 是 `@dsc/ui` 的 semver 区间；`inject` 是客户端服务名；入口用 `exports["./client"]`。
- 产物固定落 `lib/ui/plugins/<id>/client.js`；发现走现有三源（内置目录 / 第三方目录 / profile 包），不新增第四源。
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
