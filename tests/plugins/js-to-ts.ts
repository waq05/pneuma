/**
 * 解析插件：把源码里的 `./y.js` 落到磁盘上的 `y.ts`。
 *
 * ## 为什么需要它
 *
 * 源码按 NodeNext 写：`import { x } from './y.js'`。这不是笔误，是 TypeScript ESM 的硬要求
 * ——写 `./y.ts` 连 `tsc` 都过不了，编译产物里也确实是 `y.js`。但跑测试时磁盘上只有 `y.ts`，
 * `y.js` 要等 `pnpm build` 之后才出现。Vite 的默认解析器查不到 `./y.js` 时**不会**改试
 * `./y.ts`，于是 Vitest 一碰 `src/**` 就报 `Failed to resolve import`。
 *
 * 所以补一条 `resolveId`：说明符带 `.js` / `.mjs` 且原样解析失败时，按 `.ts` → `.tsx` 再找一次。
 * 真 `.js` 文件（手写的、或 `lib/` 的构建产物）存在时立刻 `return null` 交回默认解析，
 * 不抢那条路——否则会绕开 Vite 自己的缓存与外部化判定。
 *
 * 只管相对路径与绝对路径：裸说明符（`react`、`node:fs`、`@pneuma/xxx`）归别的插件。
 * 绝对路径这一支不是凑数：`@pneuma/runtime` 在 `vitest.config.ts` 里被 alias 展开成绝对
 * 路径之后，才轮到本插件把它从 `.js` 换成 `.ts`。
 *
 * @module dsc/tests/plugins/js-to-ts
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import type { Plugin } from 'vite'

/** 先 `.ts` 再 `.tsx`，和 `tsc` 对同名文件的取用顺序一致。 */
const FALLBACK_EXTENSIONS = ['.ts', '.tsx'] as const

export function jsToTsFallback(): Plugin {
  return {
    name: 'dsc:js-to-ts',
    // 必须早于 Vite 内置的 `vite:resolve`：那条先跑会把 `.js` 判成不存在并直接抛错，
    // 没有第二次机会留给后面的插件。
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null

      // 说明符可能带查询串（`./y.js?raw`）：查磁盘时要去掉，否则 existsSync 永远为假。
      // 但回退命中后要把查询串接回去——`?raw` 的语义是「取文件原文」，
      // 丢掉它不报错，只是悄悄变成「取模块导出」，调用方拿到的类型和值全变了样。
      const [cleaned, ...queryParts] = source.split('?')
      const query = queryParts.length === 0 ? '' : `?${queryParts.join('?')}`
      if (!cleaned.endsWith('.js') && !cleaned.endsWith('.mjs')) return null
      // Windows 绝对路径是 `D:\...` 或 `D:/...`，不是以 `/` 开头，所以用 isAbsolute 判。
      if (!cleaned.startsWith('.') && !isAbsolute(cleaned)) return null

      const target = resolvePath(dirname(importer), cleaned)
      if (existsSync(target)) return null

      const base = target.replace(/\.m?js$/, '')
      for (const extension of FALLBACK_EXTENSIONS) {
        if (existsSync(base + extension)) return base + extension + query
      }
      return null
    },
  }
}
