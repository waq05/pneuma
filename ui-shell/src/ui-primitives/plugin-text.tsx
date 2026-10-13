/**
 * 浏览器壳的载体基元：插件渲染层站在这上面，就不必知道自己在哪种壳里。
 *
 * 终端壳的同名基元在 `src/ui/tui-plugin-api.ts`（那里 `Text` 是 ink 的 `<Text>`）。
 * 同一份插件 bundle 两个载体各拿各的实现（require 表各自解析 `@dsc/ui`），
 * 这就是阶段 6「同一份插件源码两种载体各跑一次」的落点。
 *
 * @module dsc-ui-shell/plugin-text
 */
import type { ReactNode } from 'react'

/** 一段行内文本（终端壳里对应 ink 的 `<Text>`）。className 只在浏览器壳有意义。 */
export function Text(props: { children?: ReactNode; className?: string }): ReactNode {
  return <span className={props.className}>{props.children}</span>
}
