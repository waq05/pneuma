/**
 * 真入口 e2e（cli）的独立配置（设计 §11）。
 *
 * ## 为什么独立
 *
 * 每条用例都 spawn 真的 `node bin/dsc.js`（它再 spawn `lib/boot.js`），单条 2–5 秒、
 * 含强杀与并发实例，与 `pnpm test` 的「秒级 PR 门」不是一档。独立之后 PR 门保持轻，
 * CLI 层按需跑（verify.yml 的 `cli` job 与本地手动）。
 *
 * ## 依赖产物
 *
 * `bin/dsc.js` 起的是 `lib/boot.js`：跑之前必须 `pnpm run build`（与 `test:int` 同一条
 * 新鲜度要求）。产物不存在时用例会以「启动失败」红——比静默跳过诚实。
 *
 * @module dsc/vitest.cli.config
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
    name: 'cli',
    // 临时 HOME 的收尾（全绿才清）与新主进程共享同一套判定。
    globalSetup: ['tests/setup/global-clean.ts'],
    include: ['tests/cli/**/*.cli.e2e.ts'],
    environment: 'node',
    // 单条上限 60s（设计 §11.1）；C7/C8 要等 TUI 落盘，给足。
    testTimeout: 60_000,
    hookTimeout: 30_000,
    retry: 0,
    // 共享 HOME 的用例会互相踩；并发实例由单个用例自己起（C8）。
    pool: 'forks',
    sequence: { concurrent: false },
  },
})
