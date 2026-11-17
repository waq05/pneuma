/**
 * 真模型冒烟（live）的独立配置（设计 §10）。
 *
 * ## 为什么不并进主配置
 *
 * live 用例连**真实模型**：要钱、要网、要 key，还慢（单条几十秒）。主配置的 `pnpm test`
 * 是 PR 门，不该因为「本机恰好有 key」就发起真请求。分开之后两条路径各自成立：
 * 没 key 时 `describe.skipIf` 整层跳过（不变量 5：跳过不算失败）；有 key 时由
 * `test-live.yml` 或手动 `pnpm test:live` 显式跑。
 *
 * ## 与主配置同源的部分
 *
 * 解析插件与 `@pneuma/runtime` 别名照抄主配置——live 用例同样 import `src/**` 与
 * `tests/harness.ts`，换一套解析规则只会让「主配置能过、live 起不来」。
 * 不挂 react：live 层不渲染界面。
 *
 * @module dsc/vitest.live.config
 */
import { fileURLToPath, URL } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { jsToTsFallback } from './tests/plugins/js-to-ts.js'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json', './tsconfig.spec.json'] }), jsToTsFallback()],
  resolve: {
    alias: {
      '@pneuma/runtime': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'live',
    // 真模型冒烟也会建临时 HOME；收尾口径与主配置一致（全绿清、有红留）。
    globalSetup: ['tests/setup/global-clean.ts'],
    include: ['tests/live/**/*.live.spec.ts'],
    environment: 'node',
    // 一条请求 + 一次工具往返就可能 60s 以上；给到 3 分钟，红的就该是真红。
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // 不重试：live 层一次失败已经花了钱，重试等于再花一次，而且会掩盖真实的不稳定。
    retry: 0,
    // 真内核有进程级状态，线程间会互相踩。
    pool: 'forks',
    sequence: { concurrent: false },
    setupFiles: ['tests/setup/temp-home.ts'],
  },
})
