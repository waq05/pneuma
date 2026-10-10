/**
 * 内置示例插件：往**别人开的**子槽里放东西。
 *
 * 它存在的意义是证明一件容易写错的事：插件之间不必靠加载顺序排依赖。
 * 本插件的 id 是 `echo`，按 id 排序**先于** `hello` 加载，而它要用的
 * `hello.card.footer` 子槽此刻还不存在——早先这种情形会当场报错，然后这一块
 * 永久缺席。现在用 `injectSlot` 等那个声明出现即可：hello 一装上，这里就被叫醒。
 *
 * @module dsc-ui-shell/plugins/echo
 */
import { defineUiPlugin, type SlotComponentProps } from '@dsc/ui'

/** 别人开的子槽；名字是 hello 定的，本插件只是认得它。 */
const FOOTER_SLOT = 'hello.card.footer'

export default defineUiPlugin({
  name: '子槽贡献',
  apply(ui) {
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
