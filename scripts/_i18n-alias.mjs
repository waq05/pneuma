/**
 * 探针的模块别名：让 Node 直接跑纯逻辑的界面模块时，也能解析 `@dsc/ui` 与 `.json` 字典。
 *
 * 为什么需要：`activity.ts` / `process-groups.ts` / `rounds.ts` 这些模块是**纯函数**
 * （折叠分组、轮次统计、状态文案），探针一直用 Node 的类型擦除直接 import 它们——比读
 * 源码文本结实得多。它们现在要取词，于是多了一条 `import { createT } from '@dsc/ui'`
 * 与两条字典 JSON 的 import，而这两样在 Node 里都解析不了：
 *
 *   - `@dsc/ui` 是构建期别名（`ui-shell/packages.json`），Node 没有这张表；
 *   - 字典是 JSON，Node 的 ESM 要求 `with { type: 'json' }`，而源码里不写这个属性
 *     （vite 侧不需要，写了反而多一处噪音）。
 *
 * 所以探针开头 `import './_i18n-alias.mjs'`：把 `@dsc/ui` 指到**真正的实现**
 * （`src/packages/ui-core/i18n.ts`），并让 `.json` 按 JSON 载入。
 * 这不是桩：探针跑的是产品代码，取词行为与页面一致（没有启动图时按中文，正好是断言要的）。
 *
 * 第三条别名是相对的：`ui-core/i18n.ts` 把判定委托给 `../../core/i18n-text.js`
 * （宿主与界面共用一份），而源码写的是编译后的 `.js`。Node 的类型擦除只认实际存在的
 * 文件，所以这里补一条「`.js` 不在就找同名 `.ts`」——只对相对路径生效，别的解析照旧。
 *
 * 用 `registerHooks`（Node 22.15+ / 24 的同步钩子）：探针里的 `await import(...)` 发生在
 * 本模块求值之后，所以钩子一定先就位。
 *
 * @module dsc/scripts/_i18n-alias
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/** `@dsc/ui` 在 Node 里落到哪：只有取词器，没有任何别的依赖。 */
const I18N_ENTRY = new URL('../src/packages/ui-core/i18n.ts', import.meta.url).href

registerHooks({
  /**
   * 解析：`@dsc/ui` 与 `@dsc/ui-core` 都指到取词器那一个文件；相对的 `.js` 缺文件时找同名 `.ts`。
   *
   * 为什么 `@dsc/ui-core` 也接：库包（ui-primitives、ui-slots）按规矩从它取 `createT`，
   * 探针读到的纯模块可能来自任一侧。指到同一个文件不会产生两份实现——它没有状态。
   */
  resolve(specifier, context, nextResolve) {
    if (specifier === '@dsc/ui' || specifier === '@dsc/ui-core') {
      return { url: I18N_ENTRY, shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && typeof context.parentURL === 'string') {
      const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  /** 载入：`.json` 按 JSON 交出去（源码里不带 import 属性，vite 侧不需要它）。 */
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'json', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
