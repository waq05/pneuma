/**
 * 输入框 `/` 命令菜单的纯逻辑（候选表来自宿主，本文件不 import React / 宿主）。
 *
 * 与 TUI 的关系：壳里**不抄命令表**。宿主那份 `core/commands-completion.ts` 里标了
 * `shell: true` 的命令，经界面通道 `listUiCommands` 读出来（名字 / 参数占位 / 说明 /
 * 回合中能否用），执行的原文再交回 `runUiCommand`——列出来的与真能跑的同一批，
 * 加一条新命令不会在壳里静默多出/少掉一条。
 *
 * 这里只放三件纯事：光标处算不算「在打命令名」、按前缀过滤、补全要填的文本。
 * 行为口径照 TUI（`src/app/Composer.tsx`）：整条输入以 `/` 开头才算命令位，
 * 参数阶段（打了空格）菜单收起——参数没有候选可列。
 *
 * @module dsc-ui-shell/plugins/composer/commands
 */

/** 菜单一行（宿主 `UiCommandView` 的同形；壳只读不造）。 */
export interface ShellCommandView {
  name: string
  /** 参数占位提示（空串 = 无参数）。 */
  args: string
  description: string
  /** 回合跑着时能不能用；`deny` 的行在菜单里标灰（真闸在宿主派发那一步）。 */
  duringTask: 'allow' | 'deny'
}

/**
 * 光标处是不是在打命令名；是就给出查询词（已小写），否则 null。
 *
 * 两条口径与 TUI 相同：以 `/` 开头，且光标还在第一个词里（`/review 关注点` 这种
 * 参数阶段返回 null）。光标落在 `/` 之前（行首按左键）也不开——那时没在打名字。
 */
export function commandQuery(value: string, caret: number): string | null {
  if (!value.startsWith('/')) return null
  if (caret < 1) return null
  const word = value.slice(1, caret)
  if (/\s/.test(word)) return null
  return word.toLowerCase()
}

/** 前缀过滤（大小写不敏感）；表本身的次序就是展示次序，不重排。 */
export function filterCommands(
  commands: readonly ShellCommandView[],
  query: string,
): ShellCommandView[] {
  const lower = query.toLowerCase()
  return commands.filter((command) => command.name.toLowerCase().startsWith(lower))
}

/** 补全要填进输入框的文本：`/名字` + 有参数时带一个空格（与宿主补全面板的 insert 同口径）。 */
export function insertCommand(command: ShellCommandView): string {
  return `/${command.name}${command.args === '' ? '' : ' '}`
}

/**
 * 这一行现在能不能跑：菜单据此标灰。只是**提示**——回合一跑起来，
 * 真闸在宿主（`commands.run` 的 duringTask 那一段），壳这边判错也拦不住什么。
 */
export function blockedNow(command: ShellCommandView, working: boolean): boolean {
  return working && command.duringTask === 'deny'
}
