/**
 * 语法高亮的补盲（`packages/ui-primitives/ui/highlight.ts`）。
 *
 * 原来没覆盖的是两处：
 * - `LANG_IMPORTS` 那张表里 59 门语法的懒加载器（每条都是一个真动态 import），
 *   这里逐条真装一遍——装不上会抛，断言用 `resolves`，不是「调用了就算」；
 * - `highlightToLines` 的回落分支：无语法 → null、表里没有 → null、shiki 解析失败 → null，
 *   以及 token → 行结构的映射（`htmlStyle`、`color`、两者都没有三种形状）。
 *
 * 单例 highlighter 是模块级状态：这里只 mock 外部 shiki 的 `codeToTokens` 来制造解析失败，
 * 被测函数本身一行不替换。
 *
 * @module dsc/packages/ui-primitives/ui/w12-highlight.spec
 */
import { describe, expect, test, vi } from 'vitest'
import { getHighlighter, highlightLines, highlightToLines, langForPath, loadLang } from './highlight.js'

/** 与源码 `LANG_IMPORTS` 的键一一对应（顺序无关，但漏一个就少覆盖一行）。 */
const LANG_IDS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'jsonc',
  'json5',
  'markdown',
  'mdx',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'kotlin',
  'swift',
  'php',
  'ruby',
  'lua',
  'scala',
  'shellscript',
  'bat',
  'powershell',
  'yaml',
  'toml',
  'ini',
  'dotenv',
  'html',
  'xml',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'sql',
  'graphql',
  'proto',
  'objective-c',
  'objective-cpp',
  'dart',
  'r',
  'julia',
  'elixir',
  'erlang',
  'haskell',
  'clojure',
  'perl',
  'zig',
  'solidity',
  'fsharp',
  'diff',
  'log',
  'rst',
  'latex',
  'makefile',
] as const

/** 59 门语法分五批装：每批单独一个用例，单批耗时不撞 10s 超时。 */
const BATCHES: string[][] = []
for (let index = 0; index < LANG_IDS.length; index += 12) {
  BATCHES.push([...LANG_IDS.slice(index, index + 12)])
}

describe('langForPath：扩展名与文件名（含两种分隔符）', () => {
  test('常见扩展名映射到 shiki 语法 id；没有映射返回 undefined', () => {
    expect(langForPath('src/a.ts')).toBe('typescript')
    expect(langForPath('D:\\proj\\b.tsx')).toBe('tsx')
    expect(langForPath('README.md')).toBe('markdown')
    expect(langForPath('no-ext')).toBeUndefined()
    expect(langForPath('a.unknown')).toBeUndefined()
    expect(langForPath('.gitignore')).toBeUndefined()
  })
})

describe('LANG_IMPORTS：每条懒加载器都真的能装上', () => {
  test.each(BATCHES)('第 %# 批：%j', async (batch) => {
    for (const id of batch) {
      await expect(loadLang(id)).resolves.toBeUndefined()
    }
  })

  test('重复装载是幂等的：同一门语法装两次不抛', async () => {
    await expect(loadLang('typescript')).resolves.toBeUndefined()
    await expect(loadLang('typescript')).resolves.toBeUndefined()
  })

  test('表里没有的语法 id：静默返回，不抛', async () => {
    await expect(loadLang('not-a-lang')).resolves.toBeUndefined()
  })
})

describe('highlightToLines：回落与映射', () => {
  test('没有围栏语言：直接 null', async () => {
    await expect(highlightToLines('const a = 1', undefined)).resolves.toBeNull()
  })

  test('围栏短名走别名（ts → typescript）并出结构化行', async () => {
    const lines = await highlightToLines('const a = 1\nlet b = 2', 'ts')
    expect(lines).not.toBeNull()
    expect(lines!.map((line) => line.map((span) => span.text).join(''))).toEqual(['const a = 1', 'let b = 2'])
    expect(lines![0]!.every((span) => typeof span.style === 'object')).toBe(true)
  })

  test('表里没有的语法：返回 null 让调用方回落纯文本', async () => {
    await expect(highlightToLines('x = 1', 'not-a-lang')).resolves.toBeNull()
  })

  test('shiki 解析抛错：返回 null 而不是把异常抛给渲染层', async () => {
    const highlighter = await getHighlighter()
    const spy = vi.spyOn(highlighter, 'codeToTokens').mockImplementationOnce(() => {
      throw new Error('语法坏了')
    })
    await expect(highlightToLines('x = 1', 'ts')).resolves.toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('token 的三种样式来源：htmlStyle / color / 都没有', async () => {
    const highlighter = await getHighlighter()
    vi.spyOn(highlighter, 'codeToTokens').mockImplementationOnce(
      () =>
        ({
          tokens: [
            [{ content: 'a', htmlStyle: { '--shiki-light': '#111', '--shiki-dark': '#eee' } }],
            [{ content: 'b', color: '#222' }],
            [{ content: 'c' }],
          ],
        }) as unknown as ReturnType<typeof highlighter.codeToTokens>,
    )
    const lines = await highlightToLines('abc', 'ts')
    expect(lines).toEqual([
      [{ text: 'a', style: { '--shiki-light': '#111', '--shiki-dark': '#eee' } }],
      [{ text: 'b', style: { color: '#222' } }],
      [{ text: 'c', style: {} }],
    ])
  })
})

describe('highlightLines：按路径整块高亮', () => {
  test('认不出语言：null', async () => {
    await expect(highlightLines('x', 'a.unknown')).resolves.toBeNull()
  })

  test('正常路径：逐行输出带双主题变量的 <span>，content 已转义', async () => {
    const lines = await highlightLines('const a = "<b>&"\nlet b = 2', 'a.ts')
    expect(lines).not.toBeNull()
    expect(lines).toHaveLength(2)
    expect(lines![0]!.segments.join('')).toContain('&lt;b&gt;')
  })

  test('超过 2000 行：整块回落 null', async () => {
    const code = Array.from({ length: 2001 }, () => 'const a = 1').join('\n')
    await expect(highlightLines(code, 'a.ts')).resolves.toBeNull()
  })

  test('shiki 解析抛错：返回 null', async () => {
    const highlighter = await getHighlighter()
    vi.spyOn(highlighter, 'codeToTokens').mockImplementationOnce(() => {
      throw new Error('解析失败')
    })
    await expect(highlightLines('const a = 1', 'a.ts')).resolves.toBeNull()
  })
})
