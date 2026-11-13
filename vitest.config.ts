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
  plugins: [
    /**
     * 两份 tsconfig 都要交给它。
     *
     * `vite-tsconfig-paths` 按 `include`/`exclude` 过滤 **importer**：导入方不在配置覆盖范围内，
     * 裸说明符就原样交给 Vite，于是 `tests/**` 里写 `import '@pneuma/todo'` 报
     * `Cannot find package`——而同样的写在 `src/**` 下是对的。
     * 根配置只 include `src`，`tsconfig.spec.json` 才 include `tests/**`，两份合起来才覆盖全部
     * 导入方。（`@pneuma/runtime/*` 不受这条影响：它走下面的 alias，与 importer 无关。）
     */
    tsconfigPaths({ projects: ['./tsconfig.json', './tsconfig.spec.json'] }),
    jsToTsFallback(),
  ],
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
          include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
          // `*.int.spec.ts` 的结尾同样是 `.spec.ts`，不显式排掉会被 unit 连跑一遍：
          // 5 秒超时 + 线程池，起真内核的用例在那套设置下必红，而且红得莫名其妙。
          // src 与 tests 两处都要排——tests/ 下的 harness 集成用例同样以 `.spec.ts` 结尾。
          exclude: [
            'src/packages/*/ui/**',
            'src/**/*.int.spec.ts',
            'tests/**/*.int.spec.ts',
            '**/node_modules/**',
          ],
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
          // tests/ 下也会有集成用例（tests/harness.int.spec.ts 这类起真内核/真 CLI 的），
          // 两处都收，语义一致：`*.int.spec.ts` 就是集成层。
          include: ['src/**/*.int.spec.ts', 'tests/**/*.int.spec.ts'],
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
      {
        extends: true,
        // TUI 组件不在 `ui/` 子目录下：`src/packages/tui/app/**` 是 ink 渲染层，
        // 既不是浏览器代码（不需要 jsdom），也不匹配 ui project 的
        // `src/packages/*/ui/**` 模式——没有这个 project，那批渲染探针无家可归。
        //
        // 与 ui 层的差别：ink 渲染在 node 里跑，靠假 stdin/stdout（PassThrough）拿帧，
        // 不是 jsdom + react-dom。所以这里 environment 是 node，也不挂 react 插件以外的
        // 浏览器桩。
        test: {
          name: 'tui',
          include: ['src/packages/tui/**/*.spec.ts', 'src/packages/tui/**/*.spec.tsx'],
          // `*.spec.ts` 的星号跨点不跨目录：`scroll-model.int.spec.ts` 同样以 `.spec.ts`
          // 结尾，不排掉会被 tui project 再跑一遍（integration 那份才是它的主）。
          // 这是同一类错第三次了（见 unit project 的 exclude），凡按后缀收文件的 project 都要写。
          exclude: ['src/**/*.int.spec.ts', '**/node_modules/**'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 15_000,
          retry: 0,
          // 假终端与定时器是进程级状态，线程间会互相踩。
          pool: 'forks',
        },
      },
    ],
  },
})
