/**
 * 浏览器壳声明的那几个槽（界面壳自己认识的位置）。
 *
 * 为什么集中在一处：槽名是宿主与插件之间的字符串契约，拼错了很难查
 * （注册时会报「未声明的槽」，但报错只能告诉你拼错了，不能告诉你该拼什么）。
 * 所以壳这一侧只认这一张表，文档与测试也读它。
 *
 * 命名约定：`区域.位置`。第三方插件只用这些名字，不自己发明（将来要加就加在这）。
 *
 * @module dsc-ui-shell/slots
 */
import type { SlotKind } from '@dsc/ui-core'

/** 界面壳声明的槽：名字 → 形态。 */
export const SHELL_SLOTS: Readonly<Record<string, SlotKind>> = {
  /** 顶栏右侧：状态小药丸、版本徽标之类，横着排。 */
  'shell.header': 'list',
  /** 主区域：一张一张卡片。 */
  'shell.main': 'list',
  /** 底部状态条右侧。 */
  'statusbar.right': 'list',
  /** 播报区：一句话的提示（同一时刻只显示第一条）。 */
  'shell.notice': 'single',
}

/** 槽名的常量表，插件里别再手打字符串。 */
export const SLOT = {
  header: 'shell.header',
  main: 'shell.main',
  statusbarRight: 'statusbar.right',
  notice: 'shell.notice',
} as const
