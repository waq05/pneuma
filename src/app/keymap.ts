/**
 * 键位的单一来源：**界面上写出来的键名**都在这里，提示语由它拼。
 *
 * 为什么要有这一层：提示语与实际绑定漂移过一次又一次（胶囊上写 Enter/End、回看浮层写
 * `[ ] 跳轮`、欢迎页写 Ctrl+T——同一批键名散在六个文件里各写一遍，改一处忘一处）。现在
 * 键名只在本文件出现，组件拼句子时插值引用。
 *
 * 边界要说清楚（别把它当成 dsh 的组合键表）：dsh 那套是**注册表**——combo 语法解析、
 * 用户可改键位、输入层按 combo 匹配。我们这里只有一个「显示名」表，输入层仍是 App 里
 * 逐条 `if (key.ctrl && input === 'o')` 的判断。做成可改键位得把输入层一起重写，不在这批里。
 *
 * @module dsc-tui/app/keymap
 */

/** 界面文案里出现的键名（改这里 = 全部提示一起改）。 */
export const KEYS = {
  /** 回看全文浮层。 */
  transcript: 'Ctrl+O',
  /** 思考块展开/折叠。 */
  thinking: 'Ctrl+T',
  /** 回到底部（输入框为空时）。 */
  bottom: 'Enter/End',
  /** 逐行滚动。 */
  lines: '↑↓/j·k',
  /** 翻页。 */
  page: 'PgUp/PgDn',
  /** 滚轮（与逐行/翻页同义）。 */
  wheel: '滚轮',
  /** 上一轮 / 下一轮。 */
  turnUp: '[',
  turnDown: ']',
  /** 关闭浮层。 */
  close: 'q/Esc',
  /** 关闭浮层（含回看浮层自己的开关）。 */
  closeTranscript: 'q/Esc/Ctrl+O',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: '空格',
  /** 列表里的上下选择。 */
  pick: '↑↓',
  /** 剪贴板贴图。 */
  paste: 'Ctrl+V',
} as const

/** 拼好的提示语（键名一律从这里取，不再各写一遍）。 */
export const HINT = {
  /** 回看浮层的提示行。 */
  transcript: `${KEYS.lines} 逐行 · ${KEYS.page} 翻页 · ${KEYS.wheel} 同义 · ${KEYS.turnUp} ${KEYS.turnDown} 跳轮 · 点刻度也能跳 · ${KEYS.close} 关闭`,
  /** 子代理只读转录的提示行（同一个视口，只多「只读」与多一个关闭键）。 */
  peek: `只读 · ${KEYS.lines} 逐行 · ${KEYS.page} 翻页 · ${KEYS.wheel} 同义 · ${KEYS.turnUp} ${KEYS.turnDown} 跳轮 · ${KEYS.closeTranscript} 关闭`,
  /** 「已离开最新」胶囊（浮在转录区最后一行上）。 */
  backToBottom: ` ↓ 回到底部（${KEYS.bottom}）`,
  /** 思考块的折叠提示（跟在标签后面）。 */
  thinkingExpand: `（${KEYS.thinking} 展开）`,
  /** 空会话/欢迎页那一行开场提示。 */
  empty: `输入消息开始对话；/help 查看命令，${KEYS.escape} 打断回合，${KEYS.transcript} 回看全文。`,
} as const
