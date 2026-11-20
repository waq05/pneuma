/**
 * `tools-default/search-tools.ts` 的 glob / grep 边角覆盖（W14）。
 *
 * 既有 `search-ignore.spec.ts` 只跑常规匹配；这里补的是：
 *   - 花括号嵌套展开与 `?` 通配；
 *   - `.gitignore` 里 `**` 与 `?` 的转换、向上找 git 根后逐层读 ignore 的链路；
 *   - glob 的根是文件时 walkFiles 的 readdir 失败兜底；
 *   - grep 的非法正则退化成字面量、读禁文件跳过说明（含超过 5 个时的省略号）、单文件读禁直接报错、
 *     以及 maxResults 到量后的截断提示。
 *
 * 全部落 mkdtemp 临时目录，不碰仓库工作区。
 *
 * @module dsc/packages/tools-default/tests/w14-search-edges
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { expandBraces, globTool, grepTool, parseGitignore } from '../search-tools.js'

/** 工具 run 只读 `cwd`。 */
const ctxOf = (cwd: string) => ({ cwd }) as never

function write(file: string, text = ''): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

describe('expandBraces / glob 通配', () => {
  test('嵌套花括号展开出全部组合，超出上限就截断', () => {
    expect(expandBraces('src/*.{vue,{ts,js}}')).toEqual(['src/*.vue', 'src/*.ts', 'src/*.js'])
    expect(expandBraces('{a,b}', 1)).toEqual(['a'])
    expect(expandBraces('plain')).toEqual(['plain'])
  })

  test('glob 的 ? 只匹配一个非分隔符字符', async () => {
    const dir = createTempDir('dsc-tools-glob-q-')
    write(join(dir, 'a1.ts'))
    write(join(dir, 'a12.ts'))
    const out = await globTool.run!({ pattern: 'a?.ts', path: dir }, ctxOf(dir))
    expect(out).toBe('a1.ts')
  })
})

describe('parseGitignore：** 与 ? 的转换', () => {
  test('`**/` 跨目录、`?` 单字符，都会转成正则片段', () => {
    const rules = parseGitignore('**/secret?.log\nlogs/\n', '/repo')
    expect(rules[0]!.regex.test('deep/nested/secret1.log')).toBe(true)
    expect(rules[0]!.regex.test('secret12.log')).toBe(false)
    expect(rules[1]!.dirOnly).toBe(true)
  })
})

describe('glob：向上找 git 根并逐层读 .gitignore', () => {
  test('子目录里的 glob 会用仓库根的 .gitignore 链过滤', async () => {
    const root = createTempDir('dsc-tools-gitroot-')
    // 仓库根：.git 目录 + 一条忽略规则。
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.gitignore'), '*.log\n', 'utf8')
    write(join(root, 'sub', 'keep.ts'))
    write(join(root, 'sub', 'drop.log'))
    const out = await globTool.run!({ pattern: '**/*', path: join(root, 'sub') }, ctxOf(root))
    expect(out).toContain('keep.ts')
    expect(out).not.toContain('drop.log')
  })

  test('搜索根本身是文件：readdir 失败按「没有匹配」返回，不抛', async () => {
    const dir = createTempDir('dsc-tools-glob-file-')
    const file = join(dir, 'only.ts')
    write(file, 'x')
    await expect(globTool.run!({ pattern: '*', path: file }, ctxOf(dir))).resolves.toBe('（无匹配：*）')
  })
})

describe('grep：正则退化、读禁与截断', () => {
  test('非法正则退化成字面量搜索', async () => {
    const dir = createTempDir('dsc-tools-grep-literal-')
    write(join(dir, 'a.txt'), 'array[0] = 1\nplain line\n')
    const out = await grepTool.run!({ pattern: '[', path: dir }, ctxOf(dir))
    expect(out).toContain('a.txt:1:')
  })

  test('单文件搜索（不是受保护文件）：整份扫完并按文件回显行号', async () => {
    const dir = createTempDir('dsc-tools-grep-file-')
    const file = join(dir, 'plain.txt')
    write(file, 'first\nneedle here\n')
    const out = await grepTool.run!({ pattern: 'needle', path: file }, ctxOf(dir))
    expect(out).toContain('plain.txt:2: needle here')
  })

  test('目录里跳过受保护文件并写明数量（超过 5 个时带省略号）', async () => {
    const dir = createTempDir('dsc-tools-grep-blocked-')
    for (const name of ['.env', '.env.local', '.env.production', '.env.development', '.env.test', '.env.staging']) {
      write(join(dir, name), 'SECRET=1\n')
    }
    write(join(dir, 'readme.md'), 'hello\n')
    const out = await grepTool.run!({ pattern: 'SECRET', path: dir }, ctxOf(dir))
    expect(out).toContain('无匹配')
    expect(out).toContain('已跳过 6 个受保护文件')
    expect(out).toContain('…')
    expect(out).not.toContain('SECRET=1')
  })

  test('单文件直读受保护文件：整条报错，而不是「跳过 1 个」', async () => {
    const dir = createTempDir('dsc-tools-grep-single-')
    const env = join(dir, '.env')
    write(env, 'TOKEN=x\n')
    await expect(grepTool.run!({ pattern: 'TOKEN', path: env }, ctxOf(dir))).rejects.toThrow(/禁止读取/)
  })

  test('命中数到 maxResults 就截断，并提示收窄范围', async () => {
    const dir = createTempDir('dsc-tools-grep-trunc-')
    // 第一个文件恰好填满 2 条（不带结尾换行：scan 不会在循环里提前 return false），
    // 于是下一个文件开始前由遍历回调判定「够数了」，打上 truncated。
    write(join(dir, 'a.txt'), 'needle one\nneedle two')
    write(join(dir, 'b.txt'), 'needle three\n')
    const out = await grepTool.run!({ pattern: 'needle', path: dir, maxResults: 2 }, ctxOf(dir))
    expect(out).toContain('needle one')
    expect(out).toContain('只显示前 2 条')
    expect(out).not.toContain('needle three')
  })
})
