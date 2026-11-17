/**
 * 移植自 dsh-superagent/src/app/skill-files.ts（32 行，逐字）。
 *
 * 唯一改动：上游 `import { packagePath } from '../infra/paths.ts'` 换成 `../paths.js`
 * （本仓 native 的 `packages/superagent/paths.ts`）。本仓 `paths.ts` 只导出 DSC 数据根
 * 相关路径（`superagentRoot` / `promptsDir` 等），没有上游的 `packagePath`——移植计划
 * §4.2 注明 `infra/paths.ts` 不移植，包根由构建布局保证。因此本文件在模块内按同一语义
 * 解析包根：`join(import.meta.dirname, '..', ...parts)`。编译后本文件位于
 * `<包根>/app/`，上一级就是包根，与上游 `packageRoot()` 走找到 `package.json` 的结果一致；
 * `scripts/build-packages.mjs:127-145` 会把 `prompts/**`、`skills/**` 原样抄进产物。
 * 其余逻辑逐行未动，上游英文 doc 注释保留原文。
 *
 * 从磁盘读打包进来的内置技能定义与提示词模板。
 *
 * @module dsc/packages/superagent/app/skill-files
 */
/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/** Resolves a packaged asset path from the compiled package root (the parent of this `app/` directory). */
const packagePath = (...parts: string[]): string => join(import.meta.dirname, '..', ...parts)
/**
 * Reads a packaged text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
 */
function packaged(...parts: string[]): { path: string; text: string } {
  const path = packagePath(...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
function load(name: string) {
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
export const bundledSkills = { feishu: load('feishu'), github: load('github') }
/**
 * Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
 * readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
export function promptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
