/**
 * 文件图标：`FileIcon` 的兼容入口（树行 / 预览页签 / 工具卡 / 审查面板 / dock chip 共用一份）。
 *
 * **实现已换代**：这一层原是 vscode-icons 的常用子集（`file-icon-map.generated.ts`，
 * 115 枚图标 body 内联 533KB 的生成映射，色值是写死的十六进制）。现在它只是
 * {@link FileTypeIcon} 的薄转发——字形、分类与配色都在 `file-type-classify.ts` /
 * `file-type-icon.tsx` / `styles.css` 的 `.dsc-fti-*` 里。
 *
 * 为什么保留这一层而不是把 8 个调用点改成 `FileTypeIcon`：`FileIcon` 是 `@dsc/ui`
 * 的导出面（第三方插件也拿得到），改个名就是一次契约破坏，而这里除了转发没有别的活。
 * 旧桌面渲染层（`desktop/src/renderer/file-icons.tsx`，冻结的回落路径）**不共用**这一份，
 * 它仍带着自己的那张生成映射——两边的切换要等"一份还是两份 UI"的决定。
 *
 * @module dsc-ui-shell/ui-primitives/file-icons
 */
import type { ReactNode } from 'react'
import { classifyFileType } from './file-type-classify'
import { FileTypeIcon } from './file-type-icon'

/**
 * 文件名 → 类型档 id（`typescript` / `markdown` / `archive` / `other` …）。
 *
 * 注意语义与换代前不同：老版本返回的是 vscode-icons 的 iconify id（`file-type-markdown`），
 * 新版本返回本仓自己的档位名。仓内没有调用者（只有 `FileIcon` 自己用），导出保留是为了
 * `@dsc/ui` 的导出面逐名不变——第三方插件若拿它当查表键，换的就是那张表。
 *
 * @param name - 文件路径或基名。
 * @returns 该文件的类型档 id。
 */
export function fileIconName(name: string): string {
  return classifyFileType(name)
}

/**
 * 一个文件的彩色图标（树行、页签、工具卡里的那一枚）。
 *
 * @param props - `name` 是文件路径或基名，`size` 边长（默认 16），`className` 透传给字形。
 * @returns 该文件的类型字形。
 */
export function FileIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }): ReactNode {
  return <FileTypeIcon path={name} size={size} className={className} />
}
