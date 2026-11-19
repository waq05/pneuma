/**
 * 测试进程的终端环境开关：一律让 ink 按「真实终端」工作，不走 CI 分支。
 *
 * ## 为什么需要它
 *
 * ink 6.8 用 `is-in-ci`（`CI` 存在且不是 `0`/`false` 就算在 CI）判断环境：在 CI 里它
 * **不逐帧写流**，只在卸载时吐最后一帧（`node_modules/ink/build/ink.js:262` 渲染时直接
 * return，`:484` 卸载时才 write）。而本仓库各层探针大量靠「读假 stdout 的帧」断言：
 *   - `tui` project 的组件探针（composer / status-bar / App …）；
 *   - `integration` 里装进终端壳的 ink 帧（`ui-tui-plugin` / `two-halves`）；
 *   - `cli` 的 C3：真 PTY 里敲字、等模型回复画出来再按 Ctrl+C；
 *   - `snapshot` 的 TUI 帧快照。
 * GitHub Actions 默认带 `CI=true`，这些用例读到的帧全是空串，报出来的红（`expected '' to
 * contain ...`）指向 ink 组件，实际只是环境开关——2026-11-19 就是这么红了一片。
 *
 * 本仓库没有一条用例需要 ink 的 CI 分支（那是给「把 TUI 跑在 CI 日志里」用的），
 * 而 `CI=false` 正是 `is-in-ci` 认可的关闭值。
 *
 * ## 为什么放一份常量而不是每个 config 抄一遍
 *
 * 独立配置有五份（主配置 + `cli` / `e2e` / `built` / `live`），漏一份就重现一次同样的红。
 * 抄六行注释也留不住「为什么」——所以注释和值都只在这里留一份。
 *
 * @module dsc/tests/support/test-env
 */

/** 给各 vitest 配置的 `test.env` 用：测试进程按真实终端跑。 */
export const TERMINAL_TEST_ENV = { CI: 'false' } as const
