/**
 * `@dsc/ui-boot`：界面引导的浏览器半边——启动图取回、平台种子表、cordis 根、分批装载
 * 会话、热更对账与页面入口。
 *
 * 与 dsh 的 `dsh-client-modules` 同位：它是**唯一 parser-blocking 的引导**，页面脚本
 * 自己就是入口，没有「装不装它」这一步（所以没有行、不能停用）。渲染器与骨架都不一样：
 * 那两条是带开关的插件，停用后由这里画诊断页。
 *
 * 包内分工：`boot.ts` 是装载会话与平台种子表，`hmr.ts` 是热更半边，`cordis-host.ts`
 * 是装配底座，`main.tsx` 是页面入口（HTML 指向它，刻意不从本索引转出——它带顶层副作用）。
 *
 * @module dsc-ui-shell/ui-boot
 */
export * from './boot'
export * from './cordis-host'
export * from './hmr'
