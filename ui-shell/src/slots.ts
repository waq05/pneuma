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
  /**
   * 顶栏右侧：工作区打开组、开合钮这类**贴右缘**的操作，横着排。
   *
   * 「子智能体 / 智能体团队」不在这里——旧界面它们跟在标题后面（左簇），
   * 与右侧的操作组隔着一根弹性填充；见 {@link headerLead}。
   */
  header: 'shell.header',
  /** 顶栏标题旁（左簇）：子智能体菜单、智能体团队钮。 */
  headerLead: 'shell.header.lead',
  /** 左侧栏：会话列表这类「换主体」的东西。 */
  sidebar: 'shell.sidebar',
  /**
   * 主区整页（插件中心这类）：`shell.page` 的条目自己读 page-state 决定画不画。
   * 有人顶上时壳不渲染 `thread-zone`（顶栏与正文都换成页自己的，旧界面同构）。
   */
  page: 'shell.page',
  /** 主区域：一张一张卡片。 */
  main: 'shell.main',
  /**
   * 正文区的「另一张脸」：执行轨迹页（`thread-view` 切到 `trace` 时才渲染）。
   *
   * 为什么单开一个槽而不是让轨迹插件也住 `shell.main`：两张脸在旧界面里就是互斥的
   * 分支（`tab === 'trace' ? <TraceView/> : <ChatView/>`），由壳来切比让两个插件
   * 各读状态互斥干净——槽里站着谁就是谁，不会出现「两个条目都在画，靠 CSS 藏一个」。
   */
  thread: 'shell.thread',
  /**
   * 输入区：输入框、排队条与插在输入框上方的各种卡（审批 / 提问 / 计划）。
   *
   * 为什么把卡也放进来：旧界面里它们就是输入区这个纵向容器里的兄弟节点，上下顺序
   * 由 `order` 定（卡在前、输入框在中、排队条在后）。拆成两个槽的话，「卡在输入框上方」
   * 这条布局关系就得靠壳的硬编码去维持，而它本来是插件之间的一次排序。
   */
  composer: 'shell.composer',
  /** 底部状态栏：一段一段的读数，居中排。 */
  statusbar: 'shell.statusbar',
  /** 播报区：一句话的提示（同一时刻只显示第一条）。 */
  notice: 'shell.notice',
} as const

/** 界面壳声明的槽：名字 → 形态（键从 `SLOT` 取，值在这里定）。 */
export const SHELL_SLOTS: Readonly<Record<string, SlotKind>> = {
  [SLOT.header]: 'list',
  [SLOT.headerLead]: 'list',
  [SLOT.sidebar]: 'list',
  [SLOT.page]: 'list',
  [SLOT.main]: 'list',
  [SLOT.thread]: 'list',
  [SLOT.composer]: 'list',
  [SLOT.statusbar]: 'list',
  [SLOT.notice]: 'single',
}

/** 槽名（联合类型）：插件里写 `SLOT.header` 时能查出错字。 */
export type ShellSlot = (typeof SLOT)[keyof typeof SLOT]
