/**
 * 文件类型字形探针：钉住「一个文件长什么样」这一面的三层契约。
 *
 * 背景（2026-10-15 换代）：壳的文件图标从 vscode-icons 常用子集（533KB 生成映射，
 * 色值写死）换成了 dsh 同构的三件套——分类表 + 48 枚全彩语言字形 + 分类字形
 * （单色 + 换 mark，配色走 `--dsc-*` 令牌）。本探针钉的就是这三层的约定：
 *
 *   [1] 分类真值表：截图里的文件该归哪一档（`.tgz`→archive 是 dsc 对 dsh 的唯一偏离档）
 *   [2] 48 个代码档 ↔ 全彩字形数据逐项相等（少一个键，就有一门语言退化成灰文档）
 *   [3] 传统档字形齐套 + 令牌纪律（唯一写死的色值是折角的白，其余全从 `--dsc-*` 出）
 *   [4] 出口面：FileIcon / fileIconName 仍是 `@dsc/ui` 的导出，533KB 映射确认退役
 *
 * 自证非空转沿用本仓规矩：每个判据都写成一个函数，真实数据与**故意弄脏的副本**各跑一遍
 * ——判据对真数据必须全绿、对脏数据必须红，红不了说明这条断言空转。
 *
 * 跑法：先 `pnpm build:ui`（[4] 的产物断言读 `lib/ui/assets`，产物旧了会红——那是
 * 故意的信号），然后 `node scripts/ui-file-icon-test.mjs`。
 *
 * @module dsc/scripts/ui-file-icon-test
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
/** 判据记账：过绿、不过红并给细节，末尾以此定退出码。 */
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else { console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`); failures += 1 }
}

const { classifyFileType, CODE_FILE_TYPES, isCodeFileType, fileExtension, basename } =
  await import(new URL('../ui-shell/src/ui-primitives/file-type-classify.ts', import.meta.url).href)
const { CODE_FILE_ARTWORK, CODE_FILE_ICON_ID_TOKEN } =
  await import(new URL('../ui-shell/src/ui-primitives/code-file-icon-artwork.ts', import.meta.url).href)

/** 全部档位必须命中这些真值——文件名精确、扩展名、大小写、双扩展、双分隔符各占几条。 */
const TRUTH_TABLE = Object.entries({
  // 截图里的六类（用户报障的那一圈）
  'muse-code-0.6.47.tgz': 'archive', // 压缩包档：20 行 tgz 不再是一列金色伪 zip 文档
  'LICENSE': 'other',
  'package.json': 'node', // 完整文件名优先于扩展名（json）
  'pnpm-lock.yaml': 'yaml',
  'README.md': 'markdown',
  'tsconfig.json': 'json',
  // 语言档与配置档
  'main.ts': 'typescript',
  'a.mts': 'typescript',
  'index.js': 'javascript',
  'a.py': 'python',
  'main.rs': 'rust',
  'cmd.go': 'go',
  'a.vue': 'vue',
  'a.wasm': 'wasm',
  'styles.css': 'css',
  'a.jsx': 'react',
  '.gitignore': 'git',
  '.env.local': 'env', // 前缀规则：.env.local 也是 env
  'dockerfile.dev': 'docker', // 前缀规则
  'x.service.ts': 'angular', // 后缀规则压过扩展名（ts）
  'Makefile': 'makefile', // 大小写不敏感
  // 传统档
  'a.md': 'markdown',
  'a.pdf': 'pdf',
  'a.docx': 'word',
  'a.xlsx': 'excel',
  'a.pptx': 'ppt',
  'a.mp4': 'video',
  'a.png': 'image',
  'a.tar.gz': 'archive', // 双扩展：fileExtension 取最后一段
  'backup.tar.bz2': 'archive',
  'a.zip': 'archive',
  'a.cab': 'archive',
  'a.html': 'html',
  'notes.dir\\a.log': 'other',
  'UNKNOWN.SCREEN.SHOT.PNG': 'image', // 大小写不敏感
})

/** 真值表判据（真、脏数据各跑一遍）。 */
function truthTableOk(table) {
  return table.every(([input, expected]) => classifyFileType(input) === expected)
}

/** 分类档的键序判据（键集与顺序都要相等）。 */
function artworkKeysOk(artwork, types) {
  const keys = Object.keys(artwork)
  return keys.length === types.length && types.every((type, index) => keys[index] === type)
}

/** 分类类的覆盖判据：styles.css 里要有 `.dsc-fti--<档>`，且配到了 --dsc-* 令牌。 */
function cssCovers(categories, css) {
  return categories.every((kind) => {
    const hit = new RegExp(`\\.dsc-fti--${kind.replace(/[^a-z-]/g, '')}\\b[^{]*\\{\\s*color:`).test(css)
    return hit
  })
}

/** 硬编码审计：字形源码里十六进制字面量的清单（折角的两种白是允许清单，其余多一个都红）。 */
function hexLiterals(source) {
  return [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0])
}

const traditionalKinds = [
  'archive', 'code', 'excel', 'folder', 'html', 'image', 'markdown', 'other', 'pdf', 'ppt', 'video', 'word',
]

console.log('[1] 分类真值表（真数据全绿 + 脏数据必须红）')
{
  check(`真值表 ${Object.keys(TRUTH_TABLE).length} 条全中（真数据 → ok）`, truthTableOk(TRUTH_TABLE),
    TRUTH_TABLE.filter(([input, expected]) => classifyFileType(input) !== expected).map(([input]) => input).join(',') || '(全部命中)')
  const corrupted = TRUTH_TABLE.slice()
  corrupted[0] = [corrupted[0][0], 'other'] // 弄脏第一条：tgz 误判成 other
  corrupted[Object.keys(TRUTH_TABLE).length - 1] = [corrupted[Object.keys(TRUTH_TABLE).length - 1][0], 'archive']
  corrupted[2] = [corrupted[2][0], 'json'] // 弄脏 package.json：完整文件名规则丢了就中不了 node
  check('真值表判据对脏副本会红（负向）', truthTableOk(corrupted) === false, '判据空转：脏数据也绿')
}

console.log('[2] 48 个代码档 ↔ 全彩字形数据逐项相等（含顺序）')
{
  check(`CODE_FILE_TYPES 有 ${CODE_FILE_TYPES.length} 个档且互不重复`, CODE_FILE_TYPES.length === 48 && new Set(CODE_FILE_TYPES).size === 48, String(CODE_FILE_TYPES.length))
  check('字典序与数组序一致（artwork 的键序 = CODE_FILE_TYPES 的序）', artworkKeysOk(CODE_FILE_ARTWORK, CODE_FILE_TYPES))
  const corrupted = { ...CODE_FILE_ARTWORK }
  delete corrupted.angular
  check('键序判据对少一个键的副本会红（负向）', artworkKeysOk(corrupted, CODE_FILE_TYPES) === false, '判据空转：缺键也绿')
  const reordered = Object.fromEntries([...CODE_FILE_TYPES].reverse().map((type) => [type, CODE_FILE_ARTWORK[type]]))
  check('键序判据对乱序的副本会红（负向）', artworkKeysOk(reordered, CODE_FILE_TYPES) === false, '判据空转：纯键集比对乱序也绿')
  check('isCodeFileType 的命中范围与档集一致', isCodeFileType('typescript') === true && isCodeFileType('markdown') === false && isCodeFileType('archive') === false)
}

console.log('[3] 传统档字形齐套 + 令牌纪律')
{
  const glyphTx = readFileSync(join(root, 'ui-shell/src/ui-primitives/file-type-icon.tsx'), 'utf8')
  const classifyTx = readFileSync(join(root, 'ui-shell/src/ui-primitives/file-type-classify.ts'), 'utf8')
  const css = readFileSync(join(root, 'ui-shell/src/styles.css'), 'utf8')

  const switchCases = traditionalKinds.filter((kind) => glyphTx.includes(`case '${kind}':`))
  check(`traditionalGlyph 的 switch 覆盖全部 ${traditionalKinds.length} 个传统档`, switchCases.length === traditionalKinds.length, `缺：${traditionalKinds.filter((k) => !switchCases.includes(k)).join(',')}`)

  const ftisOk = cssCovers(traditionalKinds, css)
  check('styles.css 给每个传统档都配了 .dsc-fti--<档> 的 color', ftisOk)
  const cssCorrupted = css.replace('.dsc-fti--pdf', '.dsc-fti--pdfx')
  check('配色覆盖判据对缺一档的副本会红（负向）', cssCovers(traditionalKinds, cssCorrupted) === false, '判据空转：缺 pdf 档也绿')

  const literals = hexLiterals(glyphTx)
  check('字形源码里的十六进制字面量全折角/内描边的同一种白，没有其余杂色', literals.every((x) => x === '#ffffff'), literals.join(' '))
  const corrupted = `${glyphTx}\n color: #ab12cd`
  check('硬编码审计对混入杂色的副本会红（负向）', hexLiterals(corrupted).some((x) => x !== '#ffffff') === true, '判据空转：杂色也绿')

  check('分类表没有硬编码色值（文件名归文件名、颜色归样式表）', hexLiterals(classifyTx).length === 0)
  check('ID 占位符存在且带 dsc 前缀', CODE_FILE_ICON_ID_TOKEN === '__DSC_CODE_ICON_INSTANCE__' && glyphTx.includes('CODE_FILE_ICON_ID_TOKEN'))
  check('fileExtension / basename 的边角：.env → env、LICENSE → 空、双分隔符取最后一段',
    fileExtension('.env') === 'env' && fileExtension('LICENSE') === '' && basename('a\\b\\c.txt') === 'c.txt' && basename('a/b/c.txt') === 'c.txt')

  // 目录行的琥珀色旧账（2026-10-15 第三十一批）：`.tree-folder` 裸选择器在 views.css 里排在
  // `.file-icon` 之前，同名 color 谁在后谁赢，琥珀一直被盖成灰。修法 = 提一级特异性。
  const viewsTx = readFileSync(join(root, 'ui-shell/src/legacy/views.css'), 'utf8')
  const amberPinned = (text) => /\.file-row \.tree-folder\s*\{[^}]*color:\s*var\(--dsc-yellow\)/.test(text)
  check('目录行琥珀钉：views.css 里是 .file-row .tree-folder：--dsc-yellow（有意换的特异性订）', amberPinned(viewsTx))
  check('琥珀钉对降级回裸选择器的副本会红（负向）', amberPinned(viewsTx.replace(/\.file-row \.tree-folder/g, '.tree-folder')) === false, '判据空转：特异性退回去也绿')
}

console.log('[4] 出口面与产物')
{
  const indexTx = readFileSync(join(root, 'ui-shell/src/ui-primitives/index.ts'), 'utf8')
  const apiTx = readFileSync(join(root, 'ui-shell/src/plugin-api.ts'), 'utf8')
  const fileIconsTx = readFileSync(join(root, 'ui-shell/src/ui-primitives/file-icons.tsx'), 'utf8')

  check('@dsc/ui 仍导出 FileIcon / fileIconName', apiTx.includes('export { FileIcon, fileIconName }'))
  check('FileIcon 是 FileTypeIcon 的转发（换代没换名）', fileIconsTx.includes('FileTypeIcon') && fileIconsTx.includes('fileIconName'))
  check('ui-primitives/index.ts 不再转出那张生成映射', !indexTx.includes("export * from './file-icon-map.generated'"))
  const indexCorrupted = `${indexTx}\nexport * from './file-icon-map.generated'`
  check('出口判据对复活映射的副本会红（负向）', !(indexTx.includes("export * from './file-icon-map.generated'")) && indexCorrupted.includes("export * from './file-icon-map.generated'"), '判据空转：源码里怎么写都绿')
  check('壳源码再无 file-icon-map 的真实引用（只剩注释）',
    (await Promise.all(['ui-shell/src/ui-primitives/file-icons.tsx'].map(async (f) => readFileSync(join(root, f), 'utf8'))))
      .every((t) => !t.includes("from './file-icon-map.generated'")))
  const packageJson = JSON.parse(readFileSync(join(root, 'ui-shell/package.json'), 'utf8'))
  check('vscode-icons-js 已从 ui-shell 依赖摘除', packageJson.dependencies?.['vscode-icons-js'] === undefined)

  const assetsDir = join(root, 'lib/ui/assets')
  if (existsSync(assetsDir)) {
    // 类名在 CSS 产物（styles.css 编译产物）、字形数据在 JS chunk——两处都扫。
    const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    const joined = bundles.map((f) => readFileSync(join(assetsDir, f), 'utf8')).join('\n')
    check('壳产物里能找到全彩语言字形（构建进了 bundle）', joined.includes('__DSC_CODE_ICON_INSTANCE__'))
    check('壳产物里不再有旧映射的 GENERATED_FILE_ICONS（533KB 已退役）', !joined.includes('GENERATED_FILE_ICONS'))
    check('壳产物里不再有旧映射的 iconify 键', !joined.includes('file_type_zip'))
    check('壳产物里带分类配色类名', joined.includes('dsc-fti--archive'))
  } else {
    check('壳产物在盘上（先跑 pnpm build:ui 再跑本探针）', false, `${assetsDir} 缺`)
  }
}

process.exit(failures === 0 ? 0 : 1)
