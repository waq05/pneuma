/**
 * 思考展开区的**正文**（只画正文：行头、摘要、折叠与吸附栏都在 think-row.tsx 里）。
 *
 * 为什么单拆成一个文件：正文是「思考这个节点里最想被别人换掉的那一块」。
 * 会话区的节点级槽位（`transcript.reasoning.body`）接管的就是这个组件的位置——
 * 插件可以只换正文的排版，不必重写折叠交互。拆出来之后，槽的落空兜底就是这一个组件，
 * 换与不换的分界线看得见。
 *
 * 正文走 `MarkdownView`（会话正文同一个渲染器，`render.tsx` 的两个调用点也是它）：
 * 参考实现里思考正文同样交给 `MarkdownText`，代码块、列表、加粗都排得出来；本仓原来
 * 是 `white-space: pre-wrap` 直吐原文，同样的思考在这里是一坨纯文本（差距清单 S3）。
 *
 * 两条与调用点对齐的口径：
 *
 *   1. `baseDir` 递会话工作目录（`ShellCwdContext`）：思考里写的相对路径文件链接
 *      （`[package.json](package.json)`）要按它拼绝对路径，否则点一下只有空 href。
 *   2. `streaming` 递 `live`：流式期代码块等代码停顿 120ms 再上色（见 markdown.tsx 的
 *      `CodeBlock`），markdown 解析本身不降级——半截语法短暂错排是流式的固有代价。
 *
 * **签名冻结**：`{ text, live }` 两个入参不再增删，调用点在 render.tsx 的 thinking 分支。
 * DOM 根节点必须留着 `className="think-text"`：`.think-block.live .think-text` 依赖它，
 * 截图脚本也按这个类名认块。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/think-text
 */
import { useContext, type ReactNode } from 'react'
import { MarkdownView } from '@dsc/ui'
import { ShellCwdContext } from '../shared'

/**
 * 思考正文。
 * @param text - 思考原文（流式期是半截 markdown，允许短暂错排）
 * @param live - 这一条还在直播（决定排版要不要走「流式降级」）
 */
export function ThinkText({ text, live }: { text: string; live: boolean }): ReactNode {
  // 与正文同一个取法：槽渲染不穿 props 链，工作目录从 context 拿（见 shared.ts 的注释）。
  const cwd = useContext(ShellCwdContext)
  return (
    <div className="think-text" data-live={live ? '1' : undefined}>
      <MarkdownView text={text} path="" baseDir={cwd} streaming={live} />
    </div>
  )
}
