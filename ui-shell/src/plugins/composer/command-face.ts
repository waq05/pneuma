/**
 * `/` 菜单每行左侧的图标（中文短名与说明由宿主给，见 `CommandSpec.label`）。
 *
 * 为什么图标住在壳里而不是随 `listUiCommands` 下来：图标是**这一端的画法**，终端那边
 * 用字符标记、手机那边用内联 SVG，三端各一套；宿主只该给语义（名字、中文名、说明）。
 * 认不出的命令不给图标——菜单行退成纯文字，外部插件注册的命令也不会因为缺一条映射
 * 就报错。
 *
 * @module dsc-shell/plugins/composer/command-face
 */
import type { ComponentType } from 'react'
import { IconActivity, IconChart, IconCode, IconDiff, IconInfo, IconLayers, IconNewChat } from '@dsc/ui'

/** 图标组件的入参（与 `@dsc/ui` 的图标集同一形状）。 */
type GlyphProps = { size?: number }

/** 命令名 → 图标。只列壳里真跑得了的那几条（`shell: true` 那批）。 */
const GLYPHS: Readonly<Record<string, ComponentType<GlyphProps>>> = {
  new: IconNewChat,
  compact: IconLayers,
  status: IconActivity,
  usage: IconChart,
  diff: IconDiff,
  review: IconCode,
  help: IconInfo,
}

/**
 * 取一条命令的图标。
 *
 * @param name 命令名（不含斜杠）
 * @returns 图标组件；这条命令没配图标时返回 null（调用方不画那一格）
 */
export function commandGlyph(name: string): ComponentType<GlyphProps> | null {
  return GLYPHS[name] ?? null
}
