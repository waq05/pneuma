/**
 * 浏览器壳声明的那几个槽（界面壳自己认识的位置）。
 *
 * 为什么集中在一处：槽名是宿主与插件之间的字符串契约，拼错了很难查
 * （注册时会报「未声明的槽」，但报错只能告诉你拼错了，不能告诉你该拼什么）。
 * 所以壳这一侧只认这一张表，文档与测试也读它。
 *
 * 两个导出是一份数据的两种用法：`SLOT` 给代码用（不手打字符串），
 * `SHELL_SLOTS` 给「声明一遍」用（从 `SLOT` 派生，新增槽时不会只改一处）。
 *
 * 命名约定：`区域.位置`。第三方插件只用这些名字，不自己发明（将来要加就加在这）
 * ——插件自己的扩展点由插件在 `register` 的 `children` 里开，不占壳的命名空间。
 *
 * @module dsc-ui-shell/slots
 */
import type { SlotKind } from '@dsc/ui-core'

/** 槽名的常量表。 */
export const SLOT = {
  /** 顶栏右侧：状态小药丸、版本徽标之类，横着排。 */
  header: 'shell.header',
  /** 左侧栏：会话列表这类「换主体」的东西。 */
  sidebar: 'shell.sidebar',
  /** 主区域：一张一张卡片。 */
  main: 'shell.main',
  /** 底部状态条右侧。 */
  statusbarRight: 'statusbar.right',
  /** 播报区：一句话的提示（同一时刻只显示第一条）。 */
  notice: 'shell.notice',
} as const

/** 界面壳声明的槽：名字 → 形态（键从 `SLOT` 取，值在这里定）。 */
export const SHELL_SLOTS: Readonly<Record<string, SlotKind>> = {
  [SLOT.header]: 'list',
  [SLOT.sidebar]: 'list',
  [SLOT.main]: 'list',
  [SLOT.statusbarRight]: 'list',
  [SLOT.notice]: 'single',
}

/** 槽名（联合类型）：插件里写 `SLOT.header` 时能查出错字。 */
export type ShellSlot = (typeof SLOT)[keyof typeof SLOT]
