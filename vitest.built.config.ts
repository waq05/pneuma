/**
 * 构建产物层（built）的独立配置：只验 `lib/` 里真出来的东西，不解析 `src/`。
 *
 * ## 为什么单开一层
 *
 * `vitest.config.ts` 明令测试只解析 `src/**`：落到 `lib/**` 就等于拿编译产物验源码，
 * 改一行不 build 看不到变化。但有一类断言恰好只有产物才成立——插件的
 * `lib/ui/plugins/<id>/client.js`、界面 SDK 的 `lib/ui/sdk/@dsc/<包>/` 类型树、
 * examples 对 SDK 的真 tsc 编译。这些在 DSH 里是 `.built.e2e.ts` 层，在本仓库以前
 * 只散落在 `scripts/*-test.mjs`（B31/B32）。
 *
 * 这一层刻意不挂 `@pneuma/runtime → src` 别名：用例自己用 `createRequire` / `readFileSync`
 * 读产物，绕开 Vite 解析；产物不在时**明确 skip 并写原因**（先 build），不静默绿。
 *
 * ## 运行
 *
 * ```sh
 * pnpm run build && pnpm -C ui-shell build
 * pnpm run test:built
 * ```
 *
 * @module dsc/vitest.built.config
 */
import { defineConfig } from 'vitest/config'
import { TERMINAL_TEST_ENV } from './tests/support/test-env.js'

export default defineConfig({
  test: {
    include: ['tests/built/**/*.built.e2e.ts'],
    // 测试进程按真实终端跑（原因见 tests/support/test-env.ts）：ink 在 CI 里只写最后一帧。
    env: TERMINAL_TEST_ENV,
    setupFiles: ['tests/setup/canonical-tmp.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    sequence: { concurrent: false },
    // tsc 编一个最小工程 + 读整棵 SDK 树，单条几十秒；不给宽松超时会把慢机器误判成红。
    testTimeout: 180_000,
    hookTimeout: 60_000,
    retry: 0,
  },
})
