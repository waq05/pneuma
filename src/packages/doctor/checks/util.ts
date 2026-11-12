/**
 * doctor 的公共小工具：应用根、版本、路径脱敏、目录遍历。
 *
 * 这些函数之所以独立成文件：它们要能被包级测试直接调，不必先搭一个 ctx。
 *
 * @module pneuma/doctor/checks/util
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 应用根目录。
 *
 * 本文件编译后在 `lib/packages/doctor/checks/`，往上四级就是应用根
 * （`checks → doctor → packages → lib → 根`）。打包后 `lib/` 仍在应用里，
 * 所以这个相对关系两种形态都成立。
 */
export function appRoot(): string {
  return resolve(import.meta.dirname, '../../../..')
}

/** 读应用根下的 `package.json` 版本；读不到给 undefined（体检要如实报「未知」而不是编一个）。 */
export function appVersion(): string | undefined {
  try {
    const json = JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof json.version === 'string' ? json.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 把家目录换成 `~`。
 *
 * `--json` 的输出是要贴给别人的，绝对路径里带着用户名，脱敏从这一步开始。
 */
export function redactHome(text: string): string {
  const home = homedir()
  if (home === '' || home === '/') return text
  return text.split(home).join('~')
}

/** 递归算一个目录的字节数；读不到就返回 0，不让权限问题中断体检。 */
export function dirSize(dir: string): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSize(path)
      else if (entry.isFile()) total += statSync(path).size
    } catch {
      // 单个文件读不到就跳过
    }
  }
  return total
}

/** 一层目录里的文件数（只看这一层，不算子树）。 */
export function countFiles(dir: string, suffix: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).length
  } catch {
    return 0
  }
}

/**
 * 按层级列出文件（只下潜 `depth` 层）。
 *
 * 会话目录是 `<sessions>/<工作区>/<会话>.jsonl` 这种两层结构，写死层数会随布局变化失效，
 * 所以按深度扫、由调用方自己筛后缀。
 */
export function walkFiles(dir: string, depth: number): string[] {
  if (depth < 0) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(path, depth - 1))
    else if (entry.isFile()) out.push(path)
  }
  return out
}
