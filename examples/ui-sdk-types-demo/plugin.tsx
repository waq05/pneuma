/**
 * 第三方界面插件的**最小示例**：只为证明「一条 `@dsc/*` paths 就能拿到官方类型」。
 *
 * 这里不构建、不运行——它是一份**类型用例**：`pnpm -C examples/ui-sdk-types-demo typecheck`
 * （即 `tsc -p tsconfig.json`）零错，就说明作者按包名 import 拿到的类型是完整可用的，
 * 包括壳槽（`SLOT.*`）与 `declare module '@dsc/ui'` 往 `SlotMap` 并子槽的合并。
 *
 * 演示的四件事：
 *   1. `@dsc/ui` 的聚合面（`defineUiPlugin` / `SLOT` / `useHostSnapshot` / 载体基元 `Text`）；
 *   2. 平台种子包按包名取（`@dsc/ui-primitives` 的图标、`@dsc/ui-dockkit` 的类型）；
 *   3. `declare module '@dsc/ui'` 并一个**自己开出来的子槽**——合并锚点是 `@dsc/ui` 本体，
 *      SDK 里那份 `index.d.ts` 就是 `plugin-api.ts`，所以合并被认得出；
 *   4. 槽位契约的编译期校验：往 `SlotMap` 里并过的槽名可注册、组件 props 由 owner 推。
 *
 * @module dsc-ui-sdk-types-demo/plugin
 */
import type { ReactNode } from 'react'
import {
  SLOT,
  Text,
  defineUiPlugin,
  useHostSnapshot,
  type SlotComponentProps,
  type UiPlugin,
} from '@dsc/ui'
import { IconPlus } from '@dsc/ui-primitives'
import type { DockTabKindMeta } from '@dsc/ui-dockkit'

// ③ 并一个本插件开的子槽。owner 就是渲染方在 renderSlot 调用点会传的 props。
declare module '@dsc/ui' {
  interface SlotMap {
    'demo.card.footer': { kind: 'list'; owner: { label: string } }
  }
}

/** ④ 组件 props 用 `SlotComponentProps<Owner>` 声明：框架注入的 renderSlot 等都在里面。 */
function FooterSlot(props: SlotComponentProps<{ label: string }>): ReactNode {
  return <Text className="demo-footer">{props.label}</Text>
}

/** 状态栏里的一条：读宿主快照（类型来自 SDK，`useHostSnapshot` 的返回形状由声明给出）。 */
function StatusChip(): ReactNode {
  const snapshot = useHostSnapshot()
  const status = snapshot?.['status']
  const model = typeof status === 'object' && status !== null ? (status as Record<string, unknown>)['model'] : null
  return (
    <Text>
      <IconPlus size={12} /> {typeof model === 'string' ? model : 'demo'}
    </Text>
  )
}

/** 只是取一下 dockkit 的类型，证明种子包的类型面也在 SDK 里。 */
export type TabMeta = DockTabKindMeta

const plugin: UiPlugin = defineUiPlugin({
  name: '类型示例',
  apply(ui) {
    // 壳槽：名字来自 `@dsc/ui-slots` 并进 SlotMap 的 9 个壳位置。
    ui.slots.register(SLOT.statusbar, { id: 'demo.status', order: 5 }, StatusChip)
    // 自己开的子槽：拼错的槽名在这里就编不过。
    ui.slots.register('demo.card.footer', { id: 'demo.footer' }, FooterSlot)
  },
})

export default plugin
