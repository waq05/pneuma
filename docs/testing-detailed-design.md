# dsc 测试体系详细设计

> 给谁看：要按这份设计写代码的人。
> 与 [testing-design.md](testing-design.md) 的分工：那份讲「为什么这么做、分几期、多少工」，这份讲「每个文件长什么样、每个配置写什么值、每个接口收什么参数」。
> 状态：**设计定稿，尚未实施**。文中的代码块是规格与骨架，不是可运行文件。
> 不懂测试基本概念先读 [testing-101.md](testing-101.md)。

---

## 1 文件清单

### 1.1 新建

| 路径 | 职责 | 期 |
| --- | --- | --- |
| `vitest.config.ts` | 主配置：四个常驻 project（unit / integration / ui / snapshot） | P0 |
| `vitest.e2e.config.ts` | 真 Chromium 的独立配置 | P3 |
| `vitest.bench.config.ts` | 性能基准的独立配置（plain node，禁 tsx） | P5 |
| `vitest.live.config.ts` | 真模型冒烟的独立配置（无 key 整层跳过） | P5 |
| `tests/plugins/js-to-ts.ts` | 解析插件：`.js` → `.ts` 回退 | P0 |
| `tests/harness.ts` | 共享夹具（7 个导出） | P1a |
| `tests/bench/baseline.json` | 性能基线 | P5 |
| `tests/bench/run.mjs` | 基准跑分入口（多次采样取中位数） | P5 |
| `tests/snapshots/session/<场景>/` | 录制回放场景（见 §8） | P4 |
| `tests/cli/*.cli.e2e.ts` | 真入口 e2e（8 条） | P6 |
| `coverage-baseline.json` | 覆盖率基线 | P4 |
| `tsconfig.spec.json` | 测试代码的类型检查配置 | P0 |
| `.github/workflows/test-live.yml` | 真模型独立 workflow | P5 |

### 1.3 迁移（P1b，119 条包级测试）

| 现状 | 目标 | 数量 |
| --- | --- | --- |
| `src/packages/<id>/tests/*.test.mjs` | `src/packages/<id>/tests/*.spec.ts` | 119 条，覆盖 91 个包 |
| `scripts/package-tests.mjs` | 迁完后删除 | 1 个脚本 |
| `check:plugin` 里的 `package-tests.mjs` 那一步 | 迁完后删除 | 1 条 script 片段 |

转换规则见 §15.2。

### 1.2 修改

| 路径 | 改什么 | 期 |
| --- | --- | --- |
| [tsconfig.json](../tsconfig.json) | `exclude` 加三条 spec 后缀 | P0 |
| `ui-shell/tsconfig.json` | `exclude` 加 ui 半 spec 后缀 | P0 |
| [package.json](../package.json) | devDependencies + 11 条 scripts | P0 起 |
| [.github/workflows/verify.yml](../.github/workflows/verify.yml) | `core` job 加 `pnpm test` 与 `check:plugin`；`probe` job 加集成与覆盖率 | P1a |
| [docs/development.md](development.md) | 第 5 节「验证面」补新层 | P7 |

---

## 2 依赖与版本

```jsonc
// package.json → devDependencies（2026-11-13 实装，版本即实际解析结果）
"vitest": "^4.1.12",
"@vitest/coverage-v8": "^4.1.12",
"vite": "^7.3.8",
"vite-tsconfig-paths": "^5.1.4",
"jsdom": "^26.1.0",
"@vitejs/plugin-react": "^5.2.0",
"react-dom": "^19.2.0",          // 见下方「为什么根项目也要一份」
"fast-check": "^3.23.0"          // P7 属性测试才用，可后装
```

约束与理由：

| 依赖 | 为什么这个版本 |
| --- | --- |
| `vitest ^4.1` | 与 DSH 同版本，`projects` 配置在新版才稳定 |
| `vite ^7` | 对齐 ui-shell 已有的 vite 7，避免两份 vite 实例 |
| `@vitejs/plugin-react ^5` | 对齐 ui-shell，处理 `.tsx` 的 JSX 转换 |
| `jsdom ^26` | `ui` project 的环境 |
| `vite-tsconfig-paths ^5` | 解析 `@pneuma/*` 与 `@pneuma/runtime/*` |
| `react-dom ^19.2` | 界面半 spec 的 import 链会走到 `ui-primitives` 的 `createPortal`；根只声明了 `@types/react-dom`（pnpm 提升的），没有本体，运行期解析不到 |

**版本为什么不跟最新**：跑这件事时 registry 上已经是 `vitest 5.1.0` + `vite 8.3.8`，
但 `@vitejs/plugin-react` 的 6.x 对 vite 8 额外要求 `oxc-transform-react` 与
`@rolldown/plugin-babel` 两个原生依赖。**先跟上 DSH 那一档**，等这套体系站稳再单开一次升级。

**不装**：`jest`、`c8`、`nyc`、`ts-jest`、`@testing-library/react`（前四个与 Vitest 冲突或重复；最后一个等 ui 组件测试稳定后再议）。

---

## 3 `vitest.config.ts` 规格

### 3.1 整体形状

```ts
// 示意骨架，字段值与理由见下表
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import react from '@vitejs/plugin-react'
import { jsToTsFallback } from './tests/plugins/js-to-ts'

const root = fileURLToPath(new URL('.', import.meta.url))

// @dsc/* 别名：直接读界面壳的构建期别名表，不另抄一份（抄了会漂）
const uiAliases = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL('./ui-shell/packages.json', import.meta.url), 'utf8')))
    .map(([specifier, rel]) => [specifier, fileURLToPath(new URL(`./ui-shell/${rel}`, import.meta.url))]),
)

export default defineConfig({
  // 两份 tsconfig 都要交给它，见 §4.4「importer 必须落在 include 内」
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json', './tsconfig.spec.json'] }), jsToTsFallback()],
  resolve: { alias: { ...uiAliases, '@pneuma/runtime': `${root}src` } },
  test: {
    projects: [
      { extends: true /* unit */ },
      { extends: true /* integration */ },
      { extends: true /* ui */ },
      { extends: true /* snapshot */ },
    ],
  },
})
```

**`extends: true` 是必需的，不是保险丝**：Vitest 3.2 起，`test.projects` 里的内联 project
只拿自己写的字段，根配置的 `plugins` 与 `resolve.alias` 不会自动继承。少了它，解析插件与
`@dsc/*` 别名对四个 project 全部失效，第一次 import `src/**` 就报 `Failed to resolve import`；
而 `--passWithNoTests` 因为一条测试都没跑，照样绿。实装时做过对照实验：去掉 `extends`，
同一个冒烟用例立刻失败。

### 3.2 四个常驻 project 的字段值与理由

| 字段 | `unit` | `integration` | `ui` | `snapshot` |
| --- | --- | --- | --- | --- |
| `include` | `['src/**/*.spec.ts']` | `['src/**/*.int.spec.ts']` | `['src/packages/*/ui/**/*.spec.{ts,tsx}']` | `['tests/snapshots/**/*.snapshot.ts']` |
| `exclude` | `['src/packages/*/ui/**', 'src/**/*.int.spec.ts', '**/node_modules/**']` | `['src/packages/*/ui/**']` | `['**/node_modules/**']` | 不写（沿用默认） |
| `environment` | `'node'` | `'node'` | `'jsdom'` | `'node'` |
| `testTimeout` | `5_000` | `60_000` | `10_000` | `60_000` |
| `hookTimeout` | `5_000` | `30_000` | `10_000` | `30_000` |
| `retry` | `0` | `1` | `0` | `1` |
| `pool` | 默认（threads） | `'forks'` | 默认 | `'forks'` |
| `sequence.concurrent` | 默认 | `false` | 默认 | `false` |
| `setupFiles` | 无 | `['tests/setup/temp-home.ts']` | `['tests/setup/dom.ts']` | 无 |
| `plugins` | 继承 | 继承 | `[react()]` 追加 | 继承 |

理由：

- **`unit` 必须显式排掉 `*.int.spec.ts`**：`*.spec.ts` 的星号不跨目录但跨点，
  `session.int.spec.ts` 同样以 `.spec.ts` 结尾，不排就会被 unit 层再跑一遍——5 秒超时
  加线程池，起真内核的用例必红，而且红得看不出原因。
- **`snapshot` 的 `exclude` 留空不写**：Vitest 的 `exclude` 一旦写值就整体替换默认列表，
  写 `[]` 会把 `**/node_modules/**` 一起丢掉。它的 `include` 已经限定在 `tests/snapshots/**`，
  两者行为等价，而不写不会误伤。
- **`unit` 用 threads**：纯函数无进程级状态，线程池启动快。DSH 全线用 forks 是因为它有大量进程相关测试；dsc 的 unit 层不需要。
- **`integration` 用 forks + `retry: 1`**：要起真内核与 HTTP 服务，线程之间共享端口与全局状态会互相踩。`retry: 1` 只在网络/时序抖动时给一次机会，**不掩盖真失败**（连续两次红仍然是红）。
- **`integration` 用 `sequence.concurrent: false`**：同一文件内串行跑，避免测试之间争用同名临时目录。
- **`snapshot` 用 forks**：录制回放要读写磁盘文件。

### 3.3 覆盖率配置（分阶段）

P3（只度量，不设门槛）：

```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'html', 'json-summary'],
  include: ['src/core/**/*.ts', 'src/packages/*/*.ts'],
  exclude: [
    'src/packages/*/ui/**',        // 界面半单独算
    '**/*.d.ts',
    '**/types.ts',                 // 纯类型文件
    'src/packages/*/ui/plugins/**',// 构建产物
  ],
}
```

P4（冻结基线）起，加自定义门槛，**不用** `perFile: 100`：

```ts
thresholds: {
  lines: baselineCoverage.lines,      // 从 coverage-baseline.json 读，初始即当前值
  branches: baselineCoverage.branches,
  functions: baselineCoverage.functions,
  statements: baselineCoverage.statements,
}
```

`coverage-baseline.json` 格式：

```json
{
  "updatedAt": "2026-12-01",
  "lines": 41.2,
  "branches": 33.8,
  "functions": 38.5,
  "statements": 41.0
}
```

抬高基线是**手动步骤**：跑 `pnpm test:coverage`，把新数字写进文件，review 里能看见这次抬了多少。

---

## 4 解析插件 `tests/plugins/js-to-ts.ts`

### 4.1 要解决的问题

源码是 NodeNext 写法：`import { x } from './y.js'`，但磁盘上是 `y.ts`。Vite 解析不到 `.js` 时**不会自动改试 `.ts`**，必须插件介入。

### 4.2 规格

| 项 | 值 |
| --- | --- |
| 插件名 | `dsc:js-to-ts` |
| `enforce` | `'pre'`（必须早于 Vite 内置 resolve） |
| 触发条件 | 说明符以 `.js` / `.mjs` 结尾，且原样解析失败 |
| 回退顺序 | `.ts` → `.tsx` |
| 不处理 | 真实的 `.js` 文件（先原样解析，成功就返回） |
| 不处理 | 裸说明符（`react`、`node:fs`）——交给其他插件 |
| 性能 | 每次回退最多 2 次 `fs.existsSync` |

### 4.3 骨架

```ts
import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type { Plugin } from 'vite'

export function jsToTsFallback(): Plugin {
  return {
    name: 'dsc:js-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      // 只要带 .js/.mjs 且是相对路径或绝对路径
      if (!importer) return null
      const cleaned = source.replace(/\?.*$/, '')
      if (!cleaned.endsWith('.js') && !cleaned.endsWith('.mjs')) return null
      // Windows 的绝对路径是 D:\… 或 D:/…，不是以 / 开头，必须用 isAbsolute 判，
      // 否则 alias 展开出来的绝对路径会被漏掉
      if (!cleaned.startsWith('.') && !isAbsolute(cleaned)) return null

      const absolute = resolvePath(dirname(importer), cleaned)
      if (existsSync(absolute)) return null            // 真 .js，交回默认解析

      const base = absolute.replace(/\.m?js$/, '')
      for (const ext of ['.ts', '.tsx']) {
        if (existsSync(base + ext)) return base + ext
      }
      return null
    },
  }
}
```

### 4.4 两个难点：一个按方案 A 解决了，一个是真限制

**难点一：`@pneuma/runtime/core/x.js` 是裸说明符。** 它经 tsconfig paths 映射到 `src/core/x.js`，但此时已经不是相对路径，上面的插件不会处理。

两套方案：

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A（已采用）** | 加一条 `resolve.alias`：`'@pneuma/runtime': <绝对路径>/src`，让说明符先变成绝对路径，再被本插件的绝对路径分支接住 | **POC-2 走的就是它**：`import { Session } from '@pneuma/runtime/core/session.js'` 一次通过，方案 B 没有启用 |
| **B（兜底，未用）** | 弃用 `vite-tsconfig-paths`，在插件里完整实现两条映射 | 多约 40 行代码，本次没走到这一步 |

**难点二（真限制，已解决）：`vite-tsconfig-paths` 按 include/exclude 过滤的是 importer，不是被导入的文件。**

这条比数组候选更容易踩，而且现象会误导人。规则是：导入方文件不在某份 tsconfig 的
`include` 里，裸说明符就原样交给 Vite，于是报 `Cannot find package`。
根 `tsconfig.json` 只 `include ["src"]`，所以：

| 导入方位置 | `import '@pneuma/todo'` |
| --- | --- |
| `src/**` | 解析到 `src/packages/todo/index.ts`（数组候选的第二个，正常工作） |
| `tests/**` | **报 `Cannot find package`**，与数组候选无关 |

解法不是改测试，是把 `tsconfig.spec.json` 一并交给插件：
`tsconfigPaths({ projects: ['./tsconfig.json', './tsconfig.spec.json'] })`。
两份合起来覆盖全部导入方。实装时验证过：同一行 `import '@pneuma/todo'`，
加之前报 `Cannot find package`，加之后通过。

`@pneuma/runtime/*` 不受这条约束——它走 alias，与 importer 无关。

### 4.5 `@dsc/ui` 与 `@dsc/ui-core` 的差别（容易踩）

| 说明符 | Vitest 侧指向 | Node 探针侧指向 | 为什么不同 |
| --- | --- | --- | --- |
| `@dsc/ui` | `ui-shell/src/plugin-api.ts`（读 `ui-shell/packages.json`） | `src/packages/ui-core/i18n.ts`（见 [_i18n-alias.mjs](../scripts/_i18n-alias.mjs)） | Vite 侧要完整的插件 API（含 React hook）；Node 侧只要取词器 |
| `@dsc/ui-core` | `src/packages/ui-core/index.ts` | 同左 | 两边一致 |

**不要在 Vitest 配置里照抄 `_i18n-alias.mjs` 的映射**，两边的目标不同。POC-3 要验证：在 jsdom 环境下 import `@dsc/ui` 拿到的 `createT` 能正常取词。

---

## 5 tsconfig 改动

### 5.1 根 [tsconfig.json](../tsconfig.json)

```jsonc
"exclude": [
  "src/packages/*/ui/**",
  "src/**/*.spec.ts",
  "src/**/*.int.spec.ts",
  "src/**/*.e2e.ts"
]
```

漏掉后三条的后果：`pnpm build` 会把测试编进 `lib/`，并随包发布（`files` 只含 `bin`、`lib`、`package.json`）。

### 5.2 `tsconfig.spec.json`（新建，管 node 侧）

测试代码自己也要过类型检查，但不能混进主构建。

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",          // 根配置是 src，而这份要查 tests/**，不覆盖报 TS6059
    "types": ["node"]        // 不开 globals，测试里显式 import vitest
  },
  "include": [
    "vitest.config.ts",
    "src/**/*.spec.ts", "src/**/*.int.spec.ts", "src/**/*.e2e.ts",
    "tests/**/*.ts"
  ],
  "exclude": ["node_modules", "lib", "tests/setup/dom.ts", "src/packages/*/ui/**"]
}
```

三条排除项各有原因，都不是凑数：

| 排除项 | 不排会怎样 |
| --- | --- |
| `src/packages/*/ui/**` | `src/**/*.spec.ts` 会把界面半 spec 一并收进来，在本配置下报 `@dsc/ui` 解析不到、JSON 缺 import attribute、`document` 不存在 |
| `tests/setup/dom.ts` | 它给 jsdom 打桩（`matchMedia` 之类），必然写 DOM API，归 §5.4 那份查 |
| `lib` | 构建产物里若有残留的 `.spec.js`，会被当源码再查一遍 |

**`vitest.config.ts` 必须进 include**：它不在主构建里（主构建只编 `src`），不列进来就是
「配置本身写错类型也没人管」。

### 5.3 `ui-shell/tsconfig.json`

`exclude` 追加 `"../src/packages/*/ui/**/*.spec.ts"`、`"../src/packages/*/ui/**/*.spec.tsx"`。
这份只做类型检查、不带测试运行时的类型，界面半 spec 混进来会逼着壳也装一遍 vitest 依赖。

### 5.4 `ui-shell/tsconfig.spec.json`（新建，管界面半）

界面半 spec 不能塞进 §5.2：那份是 node 环境，没有 DOM 库、`module` 是 NodeNext、
paths 只有 `@pneuma/*`。反过来把 DOM 库加进 §5.2 更糟——内核测试跑在 node 环境，
配上 DOM 库等于允许它们写 `document`，写了真跑就是 `undefined`，类型检查反而给出假绿。

```jsonc
{
  "extends": "./tsconfig.json",   // 界面壳那份：DOM 库、bundler 解析、全套 @dsc/* paths
  "include": [
    "../src/packages/*/ui/**/*.spec.ts",
    "../src/packages/*/ui/**/*.spec.tsx",
    "../src/packages/*/ui/**/*.d.ts",   // 见下：漏了报 TS2307
    "../tests/setup/dom.ts"
  ],
  "exclude": ["node_modules", "../node_modules"]   // 必须重写，父配置把 spec 排掉了
}
```

两处非写不可的细节：

- **`exclude` 必须重写**。父配置（§5.3）把界面半 spec 排除在外，不覆盖的话子配置的
  `include` 白写。
- **环境声明 `.d.ts` 必须带上**。`ui-primitives/ui/vite-env.d.ts` 里
  `declare module '*?url'` 是 `pdf-view.tsx` 那类 Vite 专有导入能过类型检查的唯一依据；
  父配置靠 include 整片 `../src/packages/*/ui` 收进来，这份只收 spec，漏了就报
  `Cannot find module 'pdfjs-dist/build/pdf.worker.min.mjs?url'`。

配两条 script，串起来跑：

```jsonc
"typecheck:spec": "tsc -p tsconfig.spec.json --noEmit && tsc -p ui-shell/tsconfig.spec.json --noEmit"
```

---

## 6 `tests/harness.ts` API 规格

七个导出，每个都写清签名、行为、失败模式。

### 6.1 `tempHome`

```ts
export function tempHome(prefix = 'dsc-test-'): {
  home: string
  restore: () => void
}
```

| 项 | 规格 |
| --- | --- |
| 行为 | `mkdtempSync(join(tmpdir(), prefix))`，同时覆盖 `process.env.HOME` 与 `process.env.USERPROFILE` |
| 返回 | 目录路径 + 还原函数（还原成测试开始前的值，不是删掉） |
| 清理 | **不自动删**：失败时留着供排查，`restore()` 只还原环境变量 |
| 失败模式 | 临时目录创建失败直接抛，不吞 |
| 用法 | `const h = tempHome(); afterEach(h.restore)` |

### 6.2 `fakeLLM`

```ts
export interface FakeLLMOptions {
  /** 每轮返回什么：字符串 = 纯文本回复；对象 = 一次工具调用 */
  turns: Array<string | { toolCall: { name: string, args: unknown } }>
  /** 每次请求到达时的钩子，用于断言请求体 */
  onRequest?: (body: unknown, turn: number) => void
  /** 标为「会话标题请求」的分支：这些请求不消耗 turns */
  isTitleRequest?: (body: unknown) => boolean
}

export interface FakeLLM {
  baseUrl: string          // http://127.0.0.1:<随机端口>
  bodies: unknown[]        // 每次会话请求的请求体，按序
  requestCount: number
  close(): Promise<void>
}
```

| 项 | 规格 |
| --- | --- |
| 端口 | `listen(0, '127.0.0.1')`，随机端口避免并行冲突 |
| 协议 | SSE，`data: {...}\n\n`，末尾 `data: [DONE]` |
| 轮次 | 按请求顺序取 `turns[n]`；用完继续用最后一条 |
| 标题请求 | 默认按「system 里含会话标题生成器」识别并单独应答，不计入轮次（现有探针的行为） |
| 记录 | 每次请求体 push 进 `bodies`，只记录 `messages` 数组 |
| 关闭 | `close()` 必须 await，否则端口泄漏 |

### 6.3 `replayLLM`

```ts
export function replayLLM(recordingPath: string): Promise<FakeLLM>
```

| 项 | 规格 |
| --- | --- |
| 输入 | `session.jsonl` 路径（格式见 §8.3） |
| 行为 | 读全部 `kind: "response"` 行，按 `turn` 排序，逐轮吐出录制的 chunk |
| 校验 | 请求体 hash 与录制时的 `requestHash` 不符时**抛错**，不静默降级 |
| 目的 | 防止「代码改了导致请求形状变化，回放却照样通过」 |

### 6.4 `bootKernel`

```ts
export function bootKernel(opts: {
  providerBaseUrl: string
  config?: Record<string, unknown>
}): Promise<{
  ctx: unknown
  /** 跑一个真回合：发消息 → 等 turn-end → 等 agent 空闲 */
  runTurn(text: string): Promise<void>
  dispose(): Promise<void>
}>
```

| 项 | 规格 |
| --- | --- |
| 依赖 | 必须先调 `tempHome()`，否则会写真实 `~/.dsc` |
| provider | 固定一个名为 `test` 的供应商，`baseUrl` 指向假服务器 |
| `runTurn` | 监听 `dsc/turn-end`，`followup(text)`，等到 `!ctx.agent.isRunning`，再等 80ms 让写入落盘 |
| `dispose` | 关内核；失败时也要调（`afterEach`） |

### 6.5 `readSessionJsonl`

```ts
export function readSessionJsonl(path: string): Array<Record<string, unknown>>
```

跳过空行与坏行（`JSON.parse` 失败的行丢弃，不抛），返回对象数组。

### 6.6 `runCli`

```ts
export function runCli(args: string[], opts?: {
  timeoutMs?: number        // 默认 60_000
  input?: string            // stdin 内容
  env?: Record<string, string>
  cwd?: string              // 默认临时目录
}): Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>
```

| 项 | 规格 |
| --- | --- |
| 命令 | `spawn(process.execPath, [binPath, ...args])`，`binPath` = 仓库根 `bin/dsc.js` |
| 环境 | `HOME`/`USERPROFILE` 指向临时目录；`NO_COLOR=1`；`FORCE_COLOR=0` |
| 超时 | 超时后 `kill('SIGKILL')` 并返回，**不抛**（由断言判） |
| 编码 | `utf8`，stdout/stderr 全量收集 |

### 6.7 `expectGolden`

```ts
export function expectGolden(actual: string, name: string, opts?: { update?: boolean }): void
```

| 项 | 规格 |
| --- | --- |
| 落盘 | `tests/snapshots/golden/<name>.txt` |
| 更新 | `UPDATE_GOLDEN=1` 环境变量或 `opts.update` 时才写文件 |
| 比对 | 全文相等；不等时打印 unified diff（前 40 行） |
| 归一化 | 替换临时路径、时间戳、PID 为占位符后再比 |

---

## 7 各层规格

### 7.1 `unit`

| 项 | 规定 |
| --- | --- |
| 位置（内核） | 与源码同目录，`src/core/<module>.spec.ts` |
| 位置（插件包） | **沿用已有约定**：`src/packages/<id>/tests/<name>.spec.ts`（对应现在的 `*.test.mjs`） |
| 允许 | 纯函数、内存中的类、`node:fs`（仅临时目录） |
| 禁止 | 网络、真内核、真模型、读真实用户目录 |
| 单条预算 | < 100ms |
| 断言粒度 | 一个 test 一个行为 |
| 典型规模 | 内核每模块 5–15 条；插件包沿用现有条数 |

### 7.2 `integration`

| 项 | 规定 |
| --- | --- |
| 位置 | 与源码同目录，`<module>.int.spec.ts` |
| 必须 | `tempHome()` + `fakeLLM()` + `bootKernel()` |
| 允许 | 真内核、真会话落盘、真工具执行（沙箱内） |
| 禁止 | 真模型、真网络、真桌面 |
| 单条预算 | < 20s |
| 结构 | `beforeAll` 建内核，`afterAll` dispose；每个 test 之间清会话 |

### 7.3 `ui`

| 项 | 规定 |
| --- | --- |
| 位置 | `src/packages/<id>/ui/**/*.spec.ts(x)` |
| 环境 | jsdom |
| 允许 | React 组件渲染、DOM 断言、纯模型函数 |
| 禁止 | 真实浏览器 API（`IntersectionObserver` 等要打桩）、真实网络 |
| 单条预算 | < 500ms |
| 备注 | 组件测试可选 `@testing-library/react`；纯模型测试不要引入它 |

### 7.4 `e2e`

| 项 | 规定 |
| --- | --- |
| 位置 | `src/**/*.e2e.ts`，独立 config |
| 环境 | 真 Chromium（Playwright 或现有 Electron 通道） |
| 门禁 | 夜跑；默认 `pnpm test` 不包含 |
| 单条预算 | < 120s |

### 7.5 `snapshot`

见 §8。

### 7.6 `bench`

见 §9。

### 7.7 `live`

见 §10。

### 7.8 `cli`

见 §11。

---

## 8 快照层（录制会话回放）

### 8.1 目录结构

```
tests/snapshots/
├── session/
│   ├── basic-turn/
│   │   ├── scenario.snapshot.ts
│   │   ├── session.jsonl
│   │   └── expected.json
│   ├── tool-call/
│   ├── compact/
│   └── ...
└── golden/                      ← expectGolden 的文本快照（TUI 帧等）
```

### 8.2 `scenario.snapshot.ts` 接口

```ts
import { defineSnapshotScenario } from '../support/scenario'

export default defineSnapshotScenario({
  name: 'basic-turn',
  /** 输入：喂给 agent 的用户消息，按序 */
  inputs: ['你好，介绍一下你自己'],
  /** 期望的终态；与 expected.json 二选一，简单场景可内联 */
  expect: {
    messages: [
      { role: 'assistant', contains: '你好' },
    ],
  },
})
```

`defineSnapshotScenario` 由 `tests/snapshots/support/scenario.ts` 提供（骨架见附录），内部流程固定：

1. 建临时 HOME。
2. `replayLLM(session.jsonl)` 起回放服务器。
3. `bootKernel`，逐个 `inputs` 跑回合。
4. 读会话文件，按 `expect` 断言。
5. 如果是新场景（`session.jsonl` 不存在）且 `RECORD=1`，则连真模型录制。

### 8.3 `session.jsonl` 格式

一行一个事件，两种 `kind`：

```jsonl
{"kind":"request","turn":1,"requestHash":"sha256:ab12…","messages":[{"role":"user","content":"你好"}]}
{"kind":"response","turn":1,"chunks":[{"text":"你好"},{"text":"！"},{"done":true}]}
{"kind":"request","turn":2,"requestHash":"sha256:cd34…","messages":[...]}
{"kind":"response","turn":2,"chunks":[{"toolCall":{"name":"read","args":{"path":"a.txt"}}}]}
```

| 字段 | 作用 |
| --- | --- |
| `requestHash` | 回放时校验请求形状没变；对不上就报错，防止「代码改了但回放照样绿」 |
| `turn` | 回放顺序 |
| `chunks` | 原样喂给 SSE 的增量（文本、tool_call、done） |

**大小限制**：单个 `session.jsonl` 不超过 200 KB；超了说明场景太大，要拆。

### 8.4 `expected.json` 格式

```json
{
  "messages": [
    { "role": "assistant", "contains": "你好" }
  ],
  "sessionState": {
    "todos": [],
    "compacted": false
  },
  "files": {
    "a.txt": "内容"
  }
}
```

`files` 用于验证工具真的写了文件；路径相对临时 HOME。

### 8.5 录制与更新

| 命令 | 行为 |
| --- | --- |
| `RECORD=1 pnpm test:snapshot -- basic-turn` | 连真模型，录制 `session.jsonl` |
| `UPDATE_EXPECTED=1 pnpm test:snapshot -- basic-turn` | 只更新 `expected.json`，不重录 |
| `pnpm test:snapshot` | 纯回放，不碰网络 |
| CI | 强制 `DSC_SNAPSHOT=replay`，录制被禁用 |

**录制产物必须人审**：进 PR 时 review 重点是 `session.jsonl` 里模型说了什么，不是只看测试绿了。

---

## 9 性能基准（bench）

### 9.1 `baseline.json` 格式

```json
{
  "updatedAt": "2026-12-01",
  "runner": "local-win32-x64",
  "B1_session_boot_ms": { "median": 412, "samples": 9 },
  "B2_first_token_ms": { "median": 35, "samples": 9 },
  "B3_compact_ms": { "median": 890, "samples": 9 },
  "B4_stream_frame_ratio": { "median": 0.31, "samples": 9 }
}
```

### 9.2 测量规格

| 项 | 规定 |
| --- | --- |
| 预热 | 3 次，不计入 |
| 采样 | 9 次，取**中位数**（不是平均，避免离群值） |
| 运行环境 | plain `node`，**不用 tsx**（转译开销会污染测量） |
| 输入 | 固定种子数据，放 `tests/bench/fixtures/` |
| 退化判据 | 中位数 > 基线 × 1.5 → 失败；B4 用 × 1.3 |
| 机器差异 | 基线绑机器；CI 上跑用 CI 自己的基线文件（`runner` 字段区分） |

### 9.3 四条基准的定义

| # | 名称 | 起止点 | 量 |
| --- | --- | --- | --- |
| B1 | 会话启动 | `createKernel()` 调用 → 首帧快照产生 | 毫秒 |
| B2 | 首 token 延迟 | 请求发出 → 首个 SSE chunk 落地 | 毫秒 |
| B3 | 压缩耗时 | 喂 100 轮历史 → compact 完成 | 毫秒 |
| B4 | 流式渲染开销 | 1,000 chunk 输入 → 产生的帧数 / 1000 | 比值 |

### 9.4 入口

`tests/bench/run.mjs`：读 `baseline.json`，跑四条，打印表格，退化则 `process.exit(1)`。

---

## 10 真模型层（live）

### 10.1 key 与环境变量

| 项 | 值 |
| --- | --- |
| key 变量 | `DSC_LIVE_API_KEY` |
| baseUrl 变量 | `DSC_LIVE_BASE_URL`（缺省用官方地址） |
| 模型变量 | `DSC_LIVE_MODEL`（缺省用默认模型） |

### 10.2 跳过机制

```ts
const key = process.env.DSC_LIVE_API_KEY
describe.skipIf(key === undefined)('live: 单轮问答', () => { ... })
```

无 key 时整层跳过，**不算失败**，这是不变量 5（见 testing-design.md 第 3 节）。

### 10.3 防假绿（关键）

CI workflow 里两步：

```yaml
- name: 检查 key 是否配置
  run: |
    if [ -z "$DSC_LIVE_API_KEY" ]; then
      echo "::error::workflow 被触发但没配 key，拒绝假绿"
      exit 1
    fi
- name: 跑 live 冒烟
  run: pnpm test:live --reporter=json --outputFile=live.json
- name: 确认真的跑了用例
  run: |
    node -e "
      const r = require('./live.json')
      if (r.numTotalTests === 0) { console.error('一条 live 用例都没跑'); process.exit(1) }
    "
```

第二条是 DSH 的做法：**key 存在却 0 条用例执行 = 红灯**。

### 10.4 五条用例的断言要点

| # | 用例 | 断言 |
| --- | --- | --- |
| L1 | 单轮问答 | 回复非空；`usage.promptTokens > 0` 且 `completionTokens > 0` |
| L2 | 工具调用 | 模型确实发起了工具调用；结果回灌后完成第二轮 |
| L3 | 多轮上下文 | 第二轮的回复里包含第一轮的词 |
| L4 | 流式中断 | 中途 `abort`；会话里没有孤儿 tool_call（复用 `sanitizeToolOrphans` 的判据） |
| L5 | 压缩后继续 | 触发压缩后再问一句，能正常回复 |

---

## 11 真入口 e2e（cli）

### 11.1 共同约定

| 项 | 规定 |
| --- | --- |
| 命令 | `node bin/dsc.js <args>`，cwd 为临时目录 |
| 环境 | 临时 HOME、`NO_COLOR=1`、`CI=1` |
| 超时 | 60s，超时 kill 并判失败 |
| 断言 | 退出码 + stdout/stderr 关键内容 |

### 11.2 八条用例

| # | 场景 | 断言 |
| --- | --- | --- |
| C1 | `--help` | 退出码 0；stdout 含 `用法` 或 `Usage` |
| C2 | `--version` | 退出码 0；版本号等于 `package.json.version` |
| C3 | 无参数 + 一句输入 | 有 key 时退出码 0 且回复非空；无 key 自跳过 |
| C4 | 未知子命令 | 退出码非 0；stderr 有可读提示（不含 `undefined`/堆栈） |
| C5 | 配置文件损坏 | 退出码非 0；不崩、不静默吞掉 |
| C6 | 管道输入 | `echo "hi" \| node bin/dsc.js` 不卡死，正常退出 |
| C7 | `SIGINT` | 进程干净退出；会话文件可被重新加载 |
| C8 | 两个实例并发 | 都能起；会话文件不互相写坏（复用租约测试的判据） |

---

## 12 CI 配置

### 12.1 `verify.yml` 改动

```yaml
  core:
    steps:
      # ... 现有：安装、typecheck
      - name: 测试代码的类型检查（两份 tsconfig）
        run: pnpm run typecheck:spec
      # ... 现有：check:style
      - name: 单元与界面测试
        run: pnpm test
      - name: 集成测试
        run: pnpm test:int          # 2026-11-13 提前到 PR 门，见下方说明

  plugin:                            # 2026-11-13 新增（P1a 第 3 项）
    steps:
      # ... 安装、build
      - name: 包级测试（119 条）
        run: node scripts/package-tests.mjs

  probe:
    steps:
      # ... 现有：build、check:core、pnpm -C ui-shell build、check:ui
      - name: 插件门禁全量
        run: pnpm run check:plugin   # 需要 lib/ui/plugins/，所以排在界面壳构建之后
      - name: 真入口 e2e
        run: pnpm test:cli
      - name: 覆盖率
        run: pnpm test:coverage
      - name: 性能基准
        run: pnpm test:bench
```

两处与最初设想不同，都是实装时量出来的：

| 项 | 最初设想 | 实装 |
| --- | --- | --- |
| `check:plugin` | PR 门整串跑 | PR 只跑 `package-tests.mjs`（119 条，72.7s，只需 `pnpm build`）；整串进夜跑，因为它含 `plugin-inventory-check`，要读 `lib/ui/plugins/`，得先编界面壳 |
| `test:int` | 夜跑 | PR 门。15 条守线上事故（同一 callId 两条工具结果 → 网关 400），隔夜太慢；它只解析 `src/**` 不依赖 `lib/`，本地 905ms。超过两分钟再移回夜跑 |

### 12.2 新增 `test-live.yml`

```yaml
name: Live
on:
  schedule: [{ cron: '0 18 * * *' }]
  workflow_dispatch:
jobs:
  live:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ... setup pnpm/node、install、build
      - name: key 预检
        env: { DSC_LIVE_API_KEY: "${{ secrets.DSC_LIVE_API_KEY }}" }
        run: |
          if [ -z "$DSC_LIVE_API_KEY" ]; then echo "::error::缺 key"; exit 1; fi
      - name: 跑 live
        env: { DSC_LIVE_API_KEY: "${{ secrets.DSC_LIVE_API_KEY }}" }
        run: pnpm test:live
      - name: 确认非零用例
        run: pnpm test:live:assert-ran
```

**安全**：不允许改成 `pull_request_target`（fork 的 PR 会拿到密钥），这条照抄 DSH 的 e2e.yml 注释。

### 12.3 聚合 check

```yaml
  all-checks-passed:
    needs: [core, ui, desktop, probe]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: |
          if [ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" = "true" ]; then
            exit 1
          fi
```

分支保护只要求这一个 check。

---

## 13 `package.json` scripts

```jsonc
{
  "test":             "vitest run --project unit --project ui",
  "test:unit":        "vitest run --project unit",
  "test:int":         "vitest run --project integration",
  "test:ui":          "vitest run --project ui",
  "test:snapshot":    "vitest run --project snapshot",
  "test:e2e":         "vitest run --config vitest.e2e.config.ts",
  "test:bench":       "node tests/bench/run.mjs",
  "test:live":        "vitest run --config vitest.live.config.ts",
  "test:live:assert-ran": "node tests/live/assert-ran.mjs",
  "test:cli":         "vitest run --project cli",
  "test:coverage":    "vitest run --coverage",
  "test:legacy":      "pnpm run check:core && pnpm run check:ui",
  "typecheck:spec":   "tsc -p tsconfig.spec.json --noEmit"
}
```

`check:all` 在现有链尾追加 `pnpm run test`（只加快档）。

---

## 14 失败诊断输出

runner（现有 [_check-runner.mjs](../scripts/_check-runner.mjs) 的升级目标）在失败时打印：

```
── src/core/session/session.int.spec.ts ──────────────────
  ✗ 同 callId 两条工具结果只保留首条（3.2s）
    期望: 1
    实际: 2
    位置: src/core/session/session.int.spec.ts:42:5
──────────────────────────────────────────────────────────
9/10 通过，1 条失败，合计 12.4s
```

三项必须齐：**用例名、期望 vs 实际、文件:行号**。只有「FAIL」两个字等于没报。

---

## 15 迁移映射（样例）

存量探针 → 目标层与文件。先列 20 条打样，其余按同一规则推。

| 存量探针 | 目标层 | 目标文件 | 说明 |
| --- | --- | --- | --- |
| `session-dedupe-test.mjs` | integration | `src/core/session/session.int.spec.ts` | 三层去重搬成 3 个 test |
| `todo-reminder-test.mjs` | unit + integration | `src/core/todo-reminder.spec.ts` + `src/packages/todo/todo.int.spec.ts` | 纯函数与端到端拆开 |
| `microcompact-test.mjs` | unit | `src/core/microcompact.spec.ts` | 纯逻辑 |
| `context-segments-test.mjs` | unit | `src/core/context-segments.spec.ts` | 纯逻辑 |
| `compact-token-tail-test.mjs` | unit | `src/core/compact-token-tail.spec.ts` | 纯逻辑 |
| `llm-timeout-test.mjs` | integration | `src/core/llm-timeout.int.spec.ts` | 需假服务器 |
| `session-lease-test.mjs` | integration | `src/core/session/lease.int.spec.ts` | 需临时 HOME |
| `sandbox-win-token-test.mjs` | integration | `src/packages/sandbox/sandbox-win.int.spec.ts` | 平台门控 |
| `ui-status-panel-test.mjs` | ui | `src/packages/ui-status/ui/status-model.spec.ts` | 纯模型 |
| `ui-tool-views-test.mjs` | ui | `src/packages/ui-tool-views/ui/*.spec.tsx` | 文本断言要重写成渲染断言 |
| `tui-features-test.mjs` | snapshot | `tests/snapshots/golden/tui-features.txt` | 帧快照 |
| `statusbar-test.mjs` | unit | `src/packages/tui/statusbar.spec.ts` | 纯投影 |
| `command-policy-test.mjs` | unit | `src/core/command-policy.spec.ts` | 纯逻辑 |
| `env-facts-test.mjs` | unit | `src/core/env-facts.spec.ts` | 纯逻辑 |
| `path-symlink-test.mjs` | unit | `src/core/path-symlink.spec.ts` | 平台门控 |
| `mention-multi-root-test.mjs` | unit | `src/core/mention.spec.ts` | 纯逻辑 |
| `repeat-reminder-test.mjs` | unit | `src/core/repeat-reminder.spec.ts` | 纯逻辑 |
| `session-activity-time-test.mjs` | unit | `src/core/session-activity.spec.ts` | 纯逻辑 |
| `turn-changes-test.mjs` | unit | `src/core/turn-changes.spec.ts` | 纯逻辑 |
| `ui-dsh-card-replay-test.mjs` | snapshot | `tests/snapshots/card/dsh-card/` | 回放 |

**规则**：一条探针只迁一半时，旧探针保留、旧断言在迁移完成前不动；迁完把旧文件删掉，`check-core` 的自动发现列表随之缩短。

### 15.2 包级测试迁移（119 条，P1b）

仓库里已经有 119 条包级测试，位置 `src/packages/<id>/tests/*.test.mjs`，由 `scripts/package-tests.mjs` 跑。它们不是新写的，是**换 runner**。

#### 为什么现在是 `.mjs` 而不是 `.ts`

这不是随手选的：`tsc` 只处理 `.ts`/`.tsx`，不搬 `.mjs`，所以测试文件放在插件目录里也不会被编译、不会进 `lib/packages/<id>/`、不会被 [build-packages.mjs](../scripts/build-packages.mjs) 遍历到生成桩。

换成 `.ts` 后，这条「白拿的隔离」就没了，必须靠 §5.1 的 `tsconfig.exclude` 兜住。**两个约束要同时成立**：

1. `tsconfig.json` 的 `exclude` 里有 `src/**/*.spec.ts`（已被 §5.1 覆盖）；
2. `ui-shell/tsconfig.json` 不把插件包的 `tests/` 编进去。

验证命令：`pnpm run build && Get-ChildItem lib -Recurse -Filter *.spec.js` 必须为空。

#### 转换规则（逐条）

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 导入 | `await import(new URL('../../../../lib/packages/todo/index.js', import.meta.url).href)` | `import { todoPlugin } from '../index.js'`（解析插件落到 `.ts`） |
| 断言库 | `node:assert/strict` + 自造 `check()` | Vitest 的 `expect` + `test()` |
| 计数 | 文件末尾 `通过 N` + `process.exit(1)` | 不需要，runner 自己汇总 |
| 源码文本断言 | `assert.match(source, /name: 'todo_write'/)` | **必须重写**：断言导出的对象字段，或把 schema 从 `apply` 里提出来导出后再断言 |

第三条是重点。以 [todo.test.mjs](../src/packages/todo/tests/todo.test.mjs) 为例，现在有 4 条断言是 `assert.match(source, /.../)`：改引号就红、改逻辑但保留字符串就绿。迁移时要做的是：

- 能看到工具定义的地方，断言真实对象（`todoPlugin` 上挂的东西、`ctx.tools.register` 收到的参数）。
- 真拿不到的（工具在 `apply` 里现造的），**先把 schema 提成具名导出**，再断言它——这是对源码的小重构，但换来一条会红的测试，值得。

#### 迁移顺序（按断言质量排）

| 批次 | 包 | 理由 |
| --- | --- | --- |
| A | agent、session、session-core、tools、tools-default、commands、settings、prompt | 断言最结实，改动影响最大，先立模板 |
| B | approval、approval-floor、permission-core、permission-presets、sandbox、guards | 安全相关，必须有回归网 |
| C | lsp、mcp、skills、memory、todo、compact、spill | 逻辑为主 |
| D | ui-* 的宿主半 | 多为声明检查 |
| E | 其余 | —— |

每迁完一个包：删旧 `.test.mjs`、跑 `node scripts/package-tests.mjs --list` 确认条目减少、跑 `pnpm test` 确认新 spec 绿。

全部迁完后，`package-tests.mjs` 与 `check:plugin` 里的那一步一起删。

---

## 16 实施顺序（文件级）

P0 已按这张表做完（2026-11-13），表中的「验收」列写的是当时真跑出来的判据。

| 步 | 做什么 | 产出 | 验收 |
| --- | --- | --- | --- |
| 1 | 装依赖 | `package.json` | `pnpm install` 退出码 0 |
| 2 | 写解析插件 | `tests/plugins/js-to-ts.ts` | 单测不了，靠第 6 步验证 |
| 3 | 写主配置 | `vitest.config.ts` | `vitest run --project unit --passWithNoTests` 退出码 0 |
| 4 | 改 tsconfig | 三处 exclude + `tsconfig.spec.json` + `ui-shell/tsconfig.spec.json` | `pnpm build` 后 `lib` 下 `*.spec.*` 为 0；`typecheck:spec` 退出码 0 |
| 5 | **建两个 setup** | `tests/setup/temp-home.ts`、`tests/setup/dom.ts` | 第 6、7 步的前置，缺了直接报 `Cannot find module`（不是可跳过的装饰） |
| 6 | 迁 POC-1 | `src/core/todo-reminder.spec.ts` | 19 条绿 |
| 7 | 迁 POC-2 | `src/core/session/session.int.spec.ts` | 15 条绿（解析层难度在此暴露） |
| 8 | 迁 POC-3 | `src/packages/ui-status/ui/status-model.spec.ts` | 44 条绿 |
| 9 | 接门禁 | `verify.yml` + scripts | PR 能看到 `pnpm test` |
| 10 | **把 `check:plugin` 接进 PR 门禁** | `verify.yml` | 119 条包级测试第一次在 CI 里跑 |
| 11 | 迁包级测试（P1b） | `src/packages/*/tests/*.spec.ts` | 每迁一个包，`package-tests.mjs --list` 少一条 |

第 5 步容易被跳过：`vitest.config.ts` 的 `setupFiles` 指向这两个文件，没有它们，
integration 与 ui 层的第一条用例直接报 `Cannot find module`，而不是「测试失败」。
两者都要有，`dom.ts` 就算是空的也得留着——先查再决定是否加桩，不预埋。

第 7 步是全套设计的分水岭：它绿了，后面的迁移就是重复劳动；它红着，先解决解析层，别往下铺。
实装结果是一把过：`@pneuma/runtime` 的 alias 方案 A 就够，方案 B 没启用。

第 10 步是**最便宜的一刀**：不写一行测试，只是把已经存在的 119 条接进 CI。

**反向验证不是可选项**：POC-3 落地时把源码的 `Math.round` 改成 `Math.floor`，44 条里
43 条照绿——用例输入全是整秒，两种实现给同一个字符串。补一条 `1_500ms → 2秒` 之后，
同样的破坏才会变红。这一步只能靠「故意改坏」发现，读测试代码看不出来。

---

## 17 与概要设计的对应关系

| 概要设计 | 详细设计 |
| --- | --- |
| 第 4 节 八层 | §7 各层规格、§8–§11 四层细则 |
| 第 7 节 解析层 | §4 插件规格 + §4.4 两个难点 |
| 第 8 节 harness | §6 七个 API |
| 第 9 节 覆盖率 | §3.3 配置与基线文件 |
| 第 10 节 门禁 | §12 CI、§13 scripts、§14 诊断 |
| 第 11 节 迁移路线 | §15 映射样例、§16 实施顺序 |
