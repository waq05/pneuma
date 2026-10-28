/**
 * git unified diff 文本 → 结构化 hunk。
 *
 * 实现已上移到 `src/core/unified-diff.ts`（界面壳与审查面板也用它），这里只做转出，
 * 免得两份「以实际行数为准」的容错各改一半。等旧渲染层整体退役，这份文件跟着删。
 *
 * @module desktop/renderer/unified-diff
 */
export * from '@dsc/runtime/core/unified-diff.js'
