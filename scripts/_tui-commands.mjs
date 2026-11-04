/**
 * TUI 探针用的命令派发器：把 `commands` 插件挂在一个最小假 ctx 上，拿到它的服务。
 *
 * 为什么需要：终端组件树搬进 `src/packages/tui/` 之后，App 不再直接 import 命令实现
 * （那是「功能包不许 import 功能包」），改由宿主半每次派发时现查 `ctx.commands` 并作为
 * prop 传进来。探针只渲染 App、不建内核，所以要么自己给一个派发器，要么所有 `/xxx` 都
 * 落进 `() => false` 的兜底——表现就是浮层永远不弹。
 *
 * 这里挂的是**真的** commands 插件（不是桩）：命令表、回执、`ui` 回调全走产品代码。
 */
const { commandsPlugin, runCommand } = await import('../lib/packages/commands/index.js')

/** 最小 ctx：commands 的 apply 只用到这几样，缺哪个它会当场抛，别猜。 */
const ctx = {
  provide() {},
  get() {
    return undefined
  },
  effect(fn) {
    if (typeof fn === 'function') fn()
  },
  on() {
    return () => {}
  },
  emit() {},
}

commandsPlugin.apply(ctx)

/** 派发一条输入（与宿主半同一条路径）。 */
export const dispatchCommand = (input, runtime, ui) => runCommand(input, runtime, ui)
