/**
 * e2e 独立配置（设计详设 §7.2）：真机探针不进主 `vitest.config.ts` 的 projects。
 *
 * ## 为什么独立一份，不在主配置里加一个 project
 *
 * 不同层的超时、并发、环境完全不同：
 *   - 每条用例 spawn 真 `bin/headless.cjs` + 真 Electron（`desktop/node_modules/electron`），
 *     一条 10-60 秒，最坏的驱动等待 240 秒——testTimeout/hookTimeout 与 unit 的 5 秒
 *     差两个数量级，塞进同一个 projects 数组只会让全量跑的人误触发这批用例；
 *   - 被测对象全是 `lib/` 与 `lib/ui/` 的**构建产物**，不需要主配置的
 *     `@pneuma/* → src` 解析（那套别名在这里反而是错误方向：e2e 故意验产物）；
 *   - 入口独立：`pnpm run test:e2e`（设计 §10.2 的夜跑通道）。原探针
 *     `scripts/*-e2e.mjs` 与 `check:ui:e2e` 不动，那条夜跑通道继续有效，本配置是第二入口。
 *
 * ## 运行前提
 *
 * `pnpm run build && pnpm run build:ui`（探针跑的是 lib 平面产物），
 * Electron 二进制在 `desktop/node_modules/electron/dist/electron.exe`。
 * 前提不满足时每个 spec 会**明确 skip 并写原因**（见 `tests/e2e/support/host.ts`
 * 的 `probeFreshness`），不会静默绿。
 *
 * ## 并发与隔离
 *
 * pool 用 forks：宿主与 Electron 是进程级资源（端口、userData 锁、plugins.json），
 * 线程池共享不了。maxWorkers 限 2：每文件一份宿主 + 一份 Chromium，再高机器扛不住
 * （integration 的教训：全量并行时 hook 撞超时线）。文件内串行（concurrent: false），
 * boot 一类的多段场景在同文件里有先后依赖。
 *
 * @module dsc/vitest.e2e.config
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    sequence: { concurrent: false },
    // 单条驱动等待上限 240s + 宿主 90s，最坏合计 ~5.5 分钟；hook 覆盖整段流程。
    testTimeout: 420_000,
    hookTimeout: 600_000,
    // 真机每条要一两分钟，重试只会把失败的等待时间翻倍；flake 治理交给夜跑观察（§10.4）。
    retry: 0,
  },
})
