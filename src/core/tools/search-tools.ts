/**
 * 搜索工具两件套：glob（文件名匹配）/ grep（内容匹配）。
 * 递归遍历默认跳过 node_modules / .git / dist 等大目录。
 *
 * @module dsc/core/tools/search-tools
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolEntry } from '../tools.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__'])
const MAX_FILE_BYTES = 1024 * 1024

/** 大括号展开最多出几条模式：`{a,b}{c,d}` 这种组合会指数增长，得有个头。 */
const BRACE_EXPANSION_LIMIT = 64

/** 按顶层逗号切一段（`a,{b,c}` 里内层的逗号不切）。 */
function splitBraceOptions(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * 把 `{a,b}` 展开成多条模式（花括号展开的最小子集，支持嵌套）。
 *
 * 为什么要有（2026-10-30）：反馈里那条 `{vue,ts,js,json}` 多选模式一条都没匹配上，
 * 而且**不报错**，看起来就像「这个目录是空的」——一次误判足以让模型走错方向。
 * 只有真带逗号的 `{a,b}` 才展开：`{single}` 在 shell 里是字面量，这里保持一致。
 * `{` 没有配对的 `}` 直接报错，不静默返回空结果。
 *
 * @param pattern - 原始模式。
 * @param limit - 最多展开出几条；超出后截断（宁少不多，避免一次请求铺开几百个匹配器）。
 * @returns 展开后的模式列表（不需要展开时就是原样一条）。
 */
export function expandBraces(pattern: string, limit = BRACE_EXPANSION_LIMIT): string[] {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '{') depth += 1
    else if (pattern[i] === '}') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) throw new Error(`glob 模式里的 { 没有配对的 }：${pattern}`)
  const options = splitBraceOptions(pattern.slice(open + 1, close))
  if (options.length < 2) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const out: string[] = []
  for (const option of options) {
    for (const expanded of expandBraces(`${prefix}${option}${suffix}`, limit)) {
      out.push(expanded)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 把 glob 模式转 RegExp：`**` 跨目录段，`*`/`?` 段内。 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        source += '.*'
        i += 1
        if (normalized[i + 1] === '/') i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= limit) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, full, out, limit)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

const displayPath = (root: string, file: string): string => relative(root, file).replace(/\\/g, '/')

export const globTool: ToolEntry = {
  name: 'glob',
  description:
    '按文件名模式查找文件（相对当前目录）。支持 ** 跨目录、* 段内通配、? 单字符、{a,b} 花括号多选。' +
    '例：**/*.ts、src/*.json、**/*.{vue,ts,js}。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（支持 {a,b} 多选）' },
      path: { type: 'string', description: '搜索根目录（默认当前目录）' },
      limit: { type: 'number', description: '最多返回条数（默认 100）' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  async run(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 必须是非空字符串')
    const root = typeof args.path === 'string' && args.path !== ''
      ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path))
      : ctx.cwd
    const limit = Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : 100)
    // {a,b} 先展开成多条模式再逐条编译：`**/*.{vue,ts}` 以前被当成字面量，静默给「无匹配」。
    const matchers = expandBraces(args.pattern).map(globToRegExp)
    const files: string[] = []
    await walk(root, root, files, 10_000)
    const hits = files
      .map((file) => displayPath(root, file))
      .filter((rel) => matchers.some((matcher) => matcher.test(rel)))
      .slice(0, limit)
    return hits.length === 0 ? `（无匹配：${args.pattern}）` : hits.join('\n')
  },
}

export const grepTool: ToolEntry = {
  name: 'grep',
  description: '在目录内按行搜索内容（正则或纯文本），返回 文件:行号: 内容。跳过二进制与大文件。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索内容（正则；非法正则退化为字面量）' },
      path: { type: 'string', description: '搜索根目录或单文件（默认当前目录）' },
      maxResults: { type: 'number', description: '最多返回行数（默认 100）' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  async run(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 必须是非空字符串')
    let matcher: RegExp
    try {
      matcher = new RegExp(args.pattern, 'i')
    } catch {
      matcher = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const maxResults = Math.max(1, typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 100)
    const root = typeof args.path === 'string' && args.path !== ''
      ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path))
      : ctx.cwd
    const rootStat = await fs.stat(root)
    const files = rootStat.isFile() ? [root] : []
    if (files.length === 0) await walk(root, root, files, 20_000)

    const lines: string[] = []
    for (const file of files) {
      if (lines.length >= maxResults) break
      let stat
      try {
        stat = await fs.stat(file)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      if (content.includes('\0')) continue
      const split = content.split(/\r?\n/)
      for (let index = 0; index < split.length; index += 1) {
        if (lines.length >= maxResults) break
        if (matcher.test(split[index])) {
          lines.push(`${displayPath(root, file)}:${index + 1}: ${split[index].trim().slice(0, 200)}`)
        }
      }
    }
    return lines.length === 0 ? `（无匹配：${args.pattern}）` : lines.join('\n')
  },
}
