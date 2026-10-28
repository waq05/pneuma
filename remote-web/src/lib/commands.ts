/**
 * 输入框 `/` 命令菜单的纯逻辑（与桌面壳的 `composer/commands.ts` 同一套口径）。
 *
 * 与桌面壳的区别只有一处：手机上没有 Tab 补全、没有 ↑↓ 常驻，点一行就是采纳，
 * 所以这里不导出「按前缀唯一展开」，只导出「菜单里有什么」和「这条文本该当命令跑还是
 * 当消息发」。两条口径仍然对齐：整条输入以 `/` 开头、光标还在第一个词里才算命令位。
 *
 * @module dsc-remote-web/lib/commands
 */

/** 菜单一行（宿主 `listUiCommands` 返回的形状，字段与 UiCommandView 同形）。 */
export interface PhoneCommandView {
  name: string
  /** 参数占位提示（空串 = 无参数）；菜单里不显示，只决定采纳后补不补空格。 */
  args: string
  description: string
  /** 中文短名（2–4 字）；缺省 = 只显示英文名。 */
  label?: string
  duringTask: 'allow' | 'deny'
}

/**
 * 光标处是不是在打命令名；是就给出查询词（已小写），否则 null。
 *
 * @param value 输入框全文
 * @param caret 光标位置（0 起）
 * @returns 查询词；不在命令位时 null
 */
export function commandQueryAt(value: string, caret: number): string | null {
  if (!value.startsWith('/')) return null
  if (caret < 1) return null
  const word = value.slice(1, caret)
  if (/\s/.test(word)) return null
  return word.toLowerCase()
}

/**
 * 按前缀过滤；表本身的次序就是展示次序。
 *
 * @param commands 宿主给的清单（已经是 `shell: true` 那批）
 * @param query 查询词
 * @returns 命中的行
 */
export function filterCommands(
  commands: readonly PhoneCommandView[],
  query: string,
): PhoneCommandView[] {
  const lower = query.toLowerCase()
  return commands.filter((command) => command.name.toLowerCase().startsWith(lower))
}

/**
 * 采纳一行时填进输入框的文本：`/名字`，有参数再补一个空格。
 *
 * @param command 选中的那一行
 * @returns 输入框里该有的文本
 */
export function insertCommand(command: PhoneCommandView): string {
  return `/${command.name}${command.args === '' ? '' : ' '}`
}

/**
 * 这条文本该当命令跑，还是当普通消息发。
 *
 * 认两种写法：精确命令名（`/diff`）与唯一前缀（`/di`）。只认清单里的名字——
 * 清单来自宿主那份 `shell: true`，所以这里放行的与桌面壳能跑的完全同一批。
 *
 * @param text 用户按发送时的全文
 * @param commands 宿主给的清单
 * @returns 要派发的整条文本；不是命令时 null
 */
export function commandToRun(text: string, commands: readonly PhoneCommandView[]): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head = '', ...rest] = trimmed.split(/\s+/)
  const name = head.slice(1)
  if (name === '') return null
  if (commands.some((command) => command.name === name)) return trimmed
  const matches = commands.filter((command) => command.name.startsWith(name.toLowerCase()))
  const only = matches.length === 1 ? matches[0] : undefined
  if (only === undefined) return null
  return [`/${only.name}`, ...rest].join(' ')
}
