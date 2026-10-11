/**
 * 内置示例插件：往**别人开的**子槽里放东西——而且**同一份 bundle 在两种载体下各跑一次**。
 *
 * 它存在的意义是证明两件容易写错的事：
 *
 *   1. 插件之间不必靠加载顺序排依赖。本插件的 id 是 `echo`，按 id 排序**先于** `hello`
 *      加载，而它要用的 `hello.card.footer` 子槽此刻还不存在——早先这种情形会当场报错，
 *      然后这一块永久缺席。现在用 `injectSlot` 等那个声明出现即可：hello 一装上，这里就被叫醒。
 *   2. 载体无关（阶段 6）：`apply` 按 `ui.host.platform` 分支——浏览器壳里进 hello 的
 *      子槽，终端壳里进壳自己声明的 `tui.notice.extensions`。构建只有一份产物
 *      （清单里 platform web / tui 两行），`@dsc/ui` 由各自壳的 require 表解析。
 *
 * @module dsc-ui-shell/plugins/echo
 */
import { defineUiPlugin, TUI_SLOTS, Text, type SlotComponentProps } from '@dsc/ui'

/** 浏览器壳里别人开的子槽；名字是 hello 定的，本插件只是认得它。 */
const FOOTER_SLOT = 'hello.card.footer'

export default defineUiPlugin({
  name: '子槽贡献',
  apply(ui) {
    if (ui.host.platform === 'tui') {
      // 终端壳：壳声明过的扩展槽（tui.ts 里 declare），这里往里放一行。
      ui.slots.injectSlot(TUI_SLOTS.noticeExtensions, () =>
        ui.slots.register(TUI_SLOTS.noticeExtensions, { id: 'echo.tui', order: 1 }, EchoTuiLine),
      )
      return
    }
    ui.slots.injectSlot(FOOTER_SLOT, () =>
      ui.slots.register(FOOTER_SLOT, { id: 'echo.footer', order: 1 }, EchoFooter),
    )
  },
})

/** 子槽里的那一行：证明 owner 值（渲染位置给的计数）真的传到了子槽贡献者手里。 */
function EchoFooter({ count }: SlotComponentProps<{ count?: number }>) {
  return (
    <span className="hello-badge" data-echo-count={count ?? 0}>
      子槽来自插件 echo，收到计数 {count ?? 0}
    </span>
  )
}

/** 终端壳里的那一行：渲染走 `@dsc/ui` 的载体基元（ink 的 Text），与 DOM 无关。 */
function EchoTuiLine() {
  return <Text>界面插件 echo 已接入终端壳（同一份 bundle）</Text>
}
