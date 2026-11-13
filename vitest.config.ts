/**
 * Vitest 主配置：四个常驻分层 project（unit / integration / ui / snapshot）。
 *
 * ## 只解析 `src/`，不许 import `lib/`
 *
 * 本仓库只有一份实现：测试 import 的一律是 `src/**` 的源码。`lib/` 是 `pnpm build` 的产物，
 * 也是 `files` 白名单里随包发出去的那份；测试若落到 `lib/`，等于拿编译产物验源码，改一行
 * 源码不重新构建就看不到变化。这条与 `scripts/build-runtime-package.mjs` 第 6-7 行是同一
 * 约束的两面：那边禁止源码 import `lib/`，这边禁止测试 import `lib/`。
 *
 * ## 解析层为什么要两个插件
 *
 * 源码按 NodeNext 写相对导入带 `.js` 后缀（`./y.js`，磁盘上是 `y.ts`），Vite 不会自动改试，
 * 所以 `jsToTsFallback()` 补这一跳（见 `tests/plugins/js-to-ts.ts`）。
 * `@pneuma/*` 走 `tsconfig.json` 的 `paths`，交给 `vite-tsconfig-paths` 读同一份映射——
 * 手抄第六份别名表只会多一处漏改的地方。
 *
 * `@pneuma/runtime/*` 单独加一条 alias：`vite-tsconfig-paths` 会把
 * `@pneuma/runtime/core/x.js` 直接映射成相对的 `src/core/x.js` 就返回，解析插件看不到它。
 * 先经 alias 变成绝对路径，插件那支「绝对路径 + .js 不存在就试 .ts」才接得住。
 *
 * @module dsc/vitest.config
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { jsToTsFallback } from './tests/plugins/js-to-ts.js'

/**
 * `@dsc/*` 别名：直接读界面壳的构建期别名表，不另抄一份。
 *
 * 抄一份的代价不是多写几行，是漂：`ui-shell/vite.config.ts` 与
 * `scripts/build-plugins.mjs` 都读这张表，测试侧再抄就是第三个事实源。漏改的表现不是报错，
 * 是测试里解析出另一份 React 实现，hooks 直接崩。
 */
const uiAliases = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(new URL('./ui-shell/packages.json', import.meta.url), 'utf8')) as Record<
      string,
      string
    >,
  ).map(([specifier, relativePath]) => [
    specifier,
    // 表里的路径相对 `ui-shell/` 写，`../src/...` 由 URL 归一，不需要特判。
    fileURLToPath(new URL(`./ui-shell/${relativePath}`, import.meta.url)),
  ]),
)

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] }), jsToTsFallback()],
  resolve: {
    alias: {
      ...uiAliases,
      // 绝对路径：Vite 的 alias 插件排在所有自定义插件之前，展开后立刻落到下面的
      // jsToTsFallback 手里，把 `.js` 换成磁盘上真有的 `.ts`。
      '@pneuma/runtime': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    /**
     * 每个 project 的 `extends: true` 都是必需的，不是保险丝。
     *
     * Vitest 3.2 起，`test.projects` 里的内联 project 只拿自己写的字段：根配置的 `plugins`
     * 与 `resolve.alias` 不会自动继承。这条是文档里没写、踩了才知道的行为——少了它，
     * 上面两个解析插件与 `@dsc/*` 别名对四个 project 全部失效，测试第一次 import `src/**`
     * 就报 `Failed to resolve import`，而 `--passWithNoTests` 因为一个测试都没跑而照样绿。
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/packages/*/ui/**', '**/node_modules/**'],
          environment: 'node',
          testTimeout: 5_000,
          hookTimeout: 5_000,
          retry: 0,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.spec.ts'],
          exclude: ['src/packages/*/ui/**'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 30_000,
          // 只给网络与时序抖动一次机会，连续两次红仍是红——不拿重试掩盖真失败。
          retry: 1,
          // 线程池共享端口与全局状态，起真内核的用例会互相踩。
          pool: 'forks',
          // 同一文件内串行，避免两条用例争用同名临时目录。
          sequence: { concurrent: false },
          setupFiles: ['tests/setup/temp-home.ts'],
        },
      },
      {
        extends: true,
        // jsx 转换只对界面半有用，挂在这里而不是根上，免得拖慢 unit 层。
        plugins: [react()],
        test: {
          name: 'ui',
          include: ['src/packages/*/ui/**/*.spec.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
          environment: 'jsdom',
          testTimeout: 10_000,
          hookTimeout: 10_000,
          retry: 0,
          setupFiles: ['tests/setup/dom.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'snapshot',
          include: ['tests/snapshots/**/*.snapshot.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 30_000,
          retry: 1,
          // 录制回放要读写磁盘文件，线程间共享工作目录会互相覆盖。
          pool: 'forks',
          sequence: { concurrent: false },
        },
      },
    ],
  },
})
