/**
 * 终端浮层的公共外框：一层圆角边框，里面一层贴顶容器。
 *
 * 为什么要抽：模型、模式、技能、会话、子代理这五个浮层（`/model`、`/preset`、`/skills`、
 * `/resume`、子代理清单）的外框与内层容器**逐字相同**——8 行属性一模一样。改一次圆角或
 * 内边距要改五遍，漏掉的那一个在终端里看着就是歪的，而这类偏差没人会专门去查。
 *
 * 只收这两层：标题、筛选行、候选行、脚注仍归各浮层自己排。它们本来就不一样（有的带
 * 计数、有的带分页、有的带状态色），硬凑成一个组件只会换来一堆布尔开关。
 *
 * @module dsc-tui/app/PickerFrame
 */
import { Box } from 'ink'
import type { JSX, ReactNode } from 'react'
import { BORDER, GAP, PAD } from './theme.js'

export function PickerFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      gap={GAP.none}
    >
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        {children}
      </Box>
    </Box>
  )
}
