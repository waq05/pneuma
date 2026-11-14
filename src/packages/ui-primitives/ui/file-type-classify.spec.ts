/**
 * 文件类型分类与字形数据的契约（迁自 `scripts/ui-file-icon-test.mjs` 第 [1]、[2] 段
 * 与第 [3] 段里的纯函数边角）。
 *
 * 壳的文件图标是三件套——分类表 + 48 枚全彩语言字形 + 分类字形（配色走 `--dsc-*`
 * 令牌）。本文件钉住有运行期接缝的两层：分类真值表（`.tgz`→archive 是 dsc 对 dsh
 * 的唯一偏离档）与「48 个代码档 ↔ 全彩字形数据逐项相等」（少一个键，就有一门语言
 * 退化成灰文档）。原探针的「脏副本必须红」是判据自证（证明断言不是空转），在
 * Vitest 里断言本身就是判据，不再重复。
 *
 * 没迁的（原探针第 [3] 段其余与第 [4] 段，见交付报告缺口清单）：
 *   - 传统档 switch case 覆盖、`.dsc-fti--*` CSS 配色、十六进制字面量审计、琥珀钉
 *     ——源码/CSS 文本钉，字形形状的接缝在渲染层，归组件渲染批；
 *   - 出口面与产物段（`ui-shell/src/plugin-api.ts`、`lib/ui/assets`、
 *     `ui-shell/package.json` 依赖）——产物审计要 `pnpm run build:ui`，vitest 只解析
 *     src；出口转发属接线文本钉。
 *
 * @module dsc-ui-primitives/ui/file-type-classify.spec
 */
import { describe, expect, test } from 'vitest'
import { CODE_FILE_ARTWORK, CODE_FILE_ICON_ID_TOKEN } from './code-file-icon-artwork.js'
import { CODE_FILE_TYPES, basename, classifyFileType, fileExtension, isCodeFileType } from './file-type-classify.js'

/** 全部档位必须命中这些真值——文件名精确、扩展名、大小写、双扩展、双分隔符各占几条。 */
const TRUTH_TABLE: ReadonlyArray<readonly [string, string]> = [
  // 截图里的六类（用户报障的那一圈）
  ['muse-code-0.6.47.tgz', 'archive'], // 压缩包档：20 行 tgz 不再是一列金色伪 zip 文档
  ['LICENSE', 'other'],
  ['package.json', 'node'], // 完整文件名优先于扩展名（json）
  ['pnpm-lock.yaml', 'yaml'],
  ['README.md', 'markdown'],
  ['tsconfig.json', 'json'],
  // 语言档与配置档
  ['main.ts', 'typescript'],
  ['a.mts', 'typescript'],
  ['index.js', 'javascript'],
  ['a.py', 'python'],
  ['main.rs', 'rust'],
  ['cmd.go', 'go'],
  ['a.vue', 'vue'],
  ['a.wasm', 'wasm'],
  ['styles.css', 'css'],
  ['a.jsx', 'react'],
  ['.gitignore', 'git'],
  ['.env.local', 'env'], // 前缀规则：.env.local 也是 env
  ['dockerfile.dev', 'docker'], // 前缀规则
  ['x.service.ts', 'angular'], // 后缀规则压过扩展名（ts）
  ['Makefile', 'makefile'], // 大小写不敏感
  // 传统档
  ['a.md', 'markdown'],
  ['a.pdf', 'pdf'],
  ['a.docx', 'word'],
  ['a.xlsx', 'excel'],
  ['a.pptx', 'ppt'],
  ['a.mp4', 'video'],
  ['a.png', 'image'],
  ['a.tar.gz', 'archive'], // 双扩展：fileExtension 取最后一段
  ['backup.tar.bz2', 'archive'],
  ['a.zip', 'archive'],
  ['a.cab', 'archive'],
  ['a.html', 'html'],
  ['notes.dir\\a.log', 'other'],
  ['UNKNOWN.SCREEN.SHOT.PNG', 'image'], // 大小写不敏感
]

describe('分类真值表（classifyFileType）', () => {
  test(`${TRUTH_TABLE.length} 条全中：截图六类、语言档、前缀/后缀规则、双扩展、双分隔符`, () => {
    const missed = TRUTH_TABLE.filter(([input, expected]) => classifyFileType(input) !== expected)
    expect(missed.map(([input]) => input)).toEqual([])
  })

  test('边界：.env → env、LICENSE → 空、双分隔符取最后一段（fileExtension / basename）', () => {
    expect(fileExtension('.env')).toBe('env')
    expect(fileExtension('LICENSE')).toBe('')
    expect(basename('a\\b\\c.txt')).toBe('c.txt')
    expect(basename('a/b/c.txt')).toBe('c.txt')
  })
})

describe('48 个代码档 ↔ 全彩字形数据逐项相等（含顺序）', () => {
  test(`CODE_FILE_TYPES 有 48 个档且互不重复`, () => {
    expect(CODE_FILE_TYPES).toHaveLength(48)
    expect(new Set(CODE_FILE_TYPES).size).toBe(48)
  })

  test('artwork 的键序与 CODE_FILE_TYPES 的数组序一致（少一个键 / 乱序都要红）', () => {
    // toEqual 对数组同时比对长度、逐项内容与顺序：键序判据一句话说清。
    expect(Object.keys(CODE_FILE_ARTWORK)).toEqual([...CODE_FILE_TYPES])
  })

  test('isCodeFileType 的命中范围与档集一致', () => {
    expect(isCodeFileType('typescript')).toBe(true)
    expect(isCodeFileType('markdown')).toBe(false)
    expect(isCodeFileType('archive')).toBe(false)
  })

  test('ID 占位符带 dsc 前缀（渲染层靠它给全彩字形发实例 id）', () => {
    expect(CODE_FILE_ICON_ID_TOKEN).toBe('__DSC_CODE_ICON_INSTANCE__')
  })
})
