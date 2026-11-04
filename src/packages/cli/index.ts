/**
 * `@pneuma/cli`：`numa config` 与 `numa plugin` 两个子命令的实现。
 *
 * 为什么是**库包**而不是装配行：这两个命令在**内核起来之前**跑（`bin/dsc.js` 直接 spawn
 * 编译产物）。给它们一行装配，得到的是一个「开不开都一样」的开关——那不是能力，是假象。
 * 库包的身份是诚实的：它有一份可被 `bin` 指到的入口，但不进启动图。
 *
 * 为什么不做成函数以便测试：两个脚本都在顶层读 `process.argv` 并 `process.exit`，那是
 * 命令行程序的本分；把它们包成函数要重排 435 行控制流，收益只是「能在测试里调一下」。
 * 这里改用一张**入口表**把「哪个子命令在哪个文件」钉成数据，包级测试比着它查文件在不在。
 *
 * @module @pneuma/cli
 */

/** 子命令 → 产物文件名（`bin/dsc.js` 按它拼 `lib/packages/cli/<file>`）。 */
export const CLI_ENTRIES = {
  config: 'config-cli.js',
  plugin: 'plugin-cli.js',
} as const

/** 子命令名（`bin/dsc.js` 认这几个词，其余参数透传给 boot）。 */
export type CliSubcommand = keyof typeof CLI_ENTRIES
