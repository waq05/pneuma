/**
 * 内置示例插件：证明「内置」与「第三方」写的是同一份东西。
 *
 * 它做三件事：往主区放一张卡片（带一个计数器，证明插件里的 React 状态是活的）、
 * 往状态条右侧放一枚徽标、**在自己的卡片上开一个子槽**（`hello.card.footer`）留给别人。
 * 它 import 的 `@dsc/ui` 与 `react` 都由壳提供（bundle 里是外部依赖，不内联）。
 *
 * @module dsc-ui-shell/plugins/hello
 */
import { useState } from 'react'
import { defineUiPlugin, type SlotComponentProps } from '@dsc/ui'

/** 本插件开出来的子槽名：别人往这里放东西，每条卡片实例各渲染一遍。 */
const FOOTER_SLOT = 'hello.card.footer'

export default defineUiPlugin({
  name: '示例插件',
  apply(ui) {
    ui.slots.register(
      'shell.main',
      { id: 'hello.card', order: 10, children: { [FOOTER_SLOT]: 'list' } },
      HelloCard,
    )
    ui.slots.register('statusbar.right', { id: 'hello.badge', order: 10 }, () => (
      <span className="hello-badge">插件已生效</span>
    ))
  },
})

/** 主区卡片：显示自己的 id，带一个能点的计数器，并把计数器交给子槽的贡献者。 */
function HelloCard({ renderSlot }: SlotComponentProps) {
  const [count, setCount] = useState(0)
  return (
    <div style={{ padding: '14px 16px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>界面插件已生效</h2>
      <p style={{ margin: '0 0 10px', color: '#8b93a7', fontSize: 13 }}>
        这一块来自插件 <code>hello</code>，由宿主下发 bundle、注册进 <code>shell.main</code> 槽；
        下面那一行是**别的插件**往本卡片开的子槽里放的东西。
      </p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        点一下（{count}）
      </button>
      {/* 子槽的内容由渲染位置决定画在哪：这里就是卡片右下角。 */}
      <div style={{ marginTop: 10 }}>{renderSlot(FOOTER_SLOT, { count })}</div>
    </div>
  )
}
