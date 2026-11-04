/**
 * 文件名 → 文件类型档的分类表（纯逻辑，不碰 React：探针直接 `import` 这一份跑真值表）。
 *
 * 档位分两层：
 *
 * 1. **代码/配置档**（{@link CODE_FILE_TYPES}，48 个）——`.ts` / `.py` / `dockerfile` /
 *    `.gitignore` 这类，各有一枚**全彩品牌字形**（见 `code-file-icon-artwork.ts`）。
 *    语言标识不能丢：`.ts` 与 `.py` 长一个样就没人认得出文件了。
 * 2. **传统档**（{@link FileCategory} 里剩下那十几个）——文档 / 表格 / 图片 / 压缩包 /
 *    目录 / other，共用**同一个文档体 + 换 mark** 的单色字形，颜色按档走 `--dsc-*` 令牌
 *    （见 `file-type-icon.tsx` 与 `styles.css` 的 `.dsc-fti-*`）。
 *
 * 匹配优先级与 dsh（`packages/client/ui-primitives/src/code-file-types.ts`）逐条同序：
 * 文件名精确 → 文件名前缀 → 文件名后缀 → 扩展名。大小写不敏感，路径分隔符两种都吃。
 *
 * 与参考实现的**唯一差异**是 `archive` 档：dsh 把 `.zip` / `.tgz` 归进 other（灰文档），
 * dsc 的仓根常年躺着几十个 `.tgz` 发行包，全灰一片反而看不出是一类东西——单开一档给
 * 压缩包一个统一的"盒子"字形，仍走单色令牌色，不喧宾夺主。
 *
 * @module dsc-ui-shell/ui-primitives/file-type-classify
 */

/** 有专属全彩字形的代码 / 配置档（键集必须与 `CODE_FILE_ARTWORK` 逐项相等）。 */
export const CODE_FILE_TYPES = [
  'angular',
  'c',
  'clojure',
  'cmake',
  'cpp',
  'csharp',
  'css',
  'dart',
  'docker',
  'elixir',
  'env',
  'erlang',
  'flutter',
  'git',
  'go',
  'graphql',
  'haskell',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'makefile',
  'node',
  'objective-c',
  'perl',
  'php',
  'powershell',
  'protobuf',
  'python',
  'r',
  'react',
  'ruby',
  'rust',
  'scala',
  'shell',
  'solidity',
  'sql',
  'svelte',
  'swift',
  'toml',
  'typescript',
  'vue',
  'wasm',
  'xml',
  'yaml',
  'zig',
] as const

/** 一个代码 / 配置档（有专属全彩字形）。 */
export type CodeFileType = (typeof CODE_FILE_TYPES)[number]

/**
 * 文件类型档全集：48 个代码档 + 13 个传统档。
 * `folder` 只由调用方显式传（目录行的图标另有 `IconFolder/IconFolderOpen`），
 * 分类函数永远不会把文件判成它。
 */
export type FileCategory =
  | CodeFileType
  | 'archive'
  | 'code'
  | 'excel'
  | 'folder'
  | 'html'
  | 'image'
  | 'markdown'
  | 'other'
  | 'pdf'
  | 'ppt'
  | 'video'
  | 'word'

/** 已解析档位的兼容名（调用方手上已经有档、不必再传路径时用）。 */
export type FileTypeKind = FileCategory

/** 分类函数可能返回的一切（不含只能显式传的 `folder`）。 */
export type ClassifiedFileType = Exclude<FileCategory, 'folder'>

/** 传统档里的窄集（分类表自己的类型，`folder` 只能显式传、不在任何表里）。 */
type TraditionalFileType = Exclude<ClassifiedFileType, CodeFileType>

/** 可选的项目文件快照：给 `.dart` 之类需要看上下文的档（Flutter 与纯 Dart 字形不同）。 */
export interface FileTypeProjectContext {
  /** 按项目相对路径或基名索引的文本内容。 */
  readonly files: Readonly<Record<string, string | undefined>>
}

const CODE_FILE_TYPE_SET = new Set<string>(CODE_FILE_TYPES)

/** 完整文件名的精确匹配（vscode-icons-js 的"特殊文件名"规则换成了这张手写表）。 */
const FILE_NAME_TYPES: Readonly<Record<string, CodeFileType>> = {
  '.bash_profile': 'shell',
  '.bashrc': 'shell',
  '.env': 'env',
  '.gitattributes': 'git',
  '.gitconfig': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.mailmap': 'git',
  '.profile': 'shell',
  '.zprofile': 'shell',
  '.zshrc': 'shell',
  'bsdmakefile': 'makefile',
  'cmakelists.txt': 'cmake',
  'commit_editmsg': 'git',
  'compose.yaml': 'docker',
  'compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'docker-compose.yml': 'docker',
  'dockerfile': 'docker',
  'gemfile': 'ruby',
  'gnumakefile': 'makefile',
  'guardfile': 'ruby',
  'makefile': 'makefile',
  'npm-shrinkwrap.json': 'node',
  'package-lock.json': 'node',
  'package.json': 'node',
  'podfile': 'ruby',
  'rakefile': 'ruby',
}

/** 文件名**前缀**匹配（`Dockerfile.dev` / `.env.local` 这类）。 */
const FILE_NAME_PREFIX_TYPES: readonly (readonly [string, CodeFileType])[] = [
  ['dockerfile.', 'docker'],
  ['.env.', 'env'],
]

/** 文件名**后缀**匹配（`x.component.ts` 这类框架约定名比扩展名更准）。 */
const FILE_NAME_SUFFIX_TYPES: readonly (readonly [string, CodeFileType])[] = [
  ['.component.ts', 'angular'],
  ['.component.html', 'angular'],
  ['.directive.ts', 'angular'],
  ['.service.ts', 'angular'],
  ['.module.ts', 'angular'],
  ['.pipe.ts', 'angular'],
  ['.guard.ts', 'angular'],
  ['.interceptor.ts', 'angular'],
  ['.dockerfile', 'docker'],
]

/** 扩展名 → 代码 / 配置档。 */
const CODE_EXTENSION_TYPES: Readonly<Record<string, CodeFileType>> = {
  'bash': 'shell',
  'c': 'c',
  'c++': 'cpp',
  'cc': 'cpp',
  'cfg': 'ini',
  'cjs': 'javascript',
  'clj': 'clojure',
  'cljc': 'clojure',
  'cljs': 'clojure',
  'cmake': 'cmake',
  'cpp': 'cpp',
  'cs': 'csharp',
  'csh': 'shell',
  'css': 'css',
  'csx': 'csharp',
  'cts': 'typescript',
  'cxx': 'cpp',
  'dart': 'dart',
  'dtd': 'xml',
  'edn': 'clojure',
  'env': 'env',
  'erl': 'erlang',
  'es6': 'javascript',
  'escript': 'erlang',
  'ex': 'elixir',
  'exs': 'elixir',
  'fish': 'shell',
  'gemspec': 'ruby',
  'go': 'go',
  'gql': 'graphql',
  'graphql': 'graphql',
  'h': 'c',
  'h++': 'cpp',
  'hh': 'cpp',
  'hpp': 'cpp',
  'hrl': 'erlang',
  'hs': 'haskell',
  'hxx': 'cpp',
  'ini': 'ini',
  'ipp': 'cpp',
  'java': 'java',
  'js': 'javascript',
  'json': 'json',
  'json5': 'json',
  'jsonc': 'json',
  'jsx': 'react',
  'ksh': 'shell',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'lhs': 'haskell',
  'lua': 'lua',
  'm': 'objective-c',
  'mak': 'makefile',
  'mjs': 'javascript',
  'mk': 'makefile',
  'mm': 'objective-c',
  'mts': 'typescript',
  'node': 'node',
  'pch': 'objective-c',
  'php': 'php',
  'php3': 'php',
  'php4': 'php',
  'php5': 'php',
  'phps': 'php',
  'phtml': 'php',
  'pl': 'perl',
  'plist': 'xml',
  'pm': 'perl',
  'pod': 'perl',
  'proto': 'protobuf',
  'ps1': 'powershell',
  'psd1': 'powershell',
  'psm1': 'powershell',
  'py': 'python',
  'pyi': 'python',
  'pyw': 'python',
  'pyx': 'python',
  'r': 'r',
  'rake': 'ruby',
  'rb': 'ruby',
  'rmd': 'r',
  'rs': 'rust',
  'sc': 'scala',
  'scala': 'scala',
  'sh': 'shell',
  'sol': 'solidity',
  'sql': 'sql',
  'svelte': 'svelte',
  'swift': 'swift',
  't': 'perl',
  'tcsh': 'shell',
  'toml': 'toml',
  'tpp': 'cpp',
  'ts': 'typescript',
  'tsx': 'react',
  'vue': 'vue',
  'wasm': 'wasm',
  'wast': 'wasm',
  'wat': 'wasm',
  'xml': 'xml',
  'xsd': 'xml',
  'xsl': 'xml',
  'xslt': 'xml',
  'yaml': 'yaml',
  'yml': 'yaml',
  'zig': 'zig',
  'zsh': 'shell',
}

/** 扩展名 → 传统档（代码档没命中时才查这一张）。 */
const EXTENSION_TYPES: Readonly<Record<string, TraditionalFileType>> = {
  '7z': 'archive',
  'apk': 'archive',
  'avi': 'video',
  'avif': 'image',
  'bat': 'code',
  'bmp': 'image',
  'br': 'archive',
  'bz2': 'archive',
  'cab': 'archive',
  'cmd': 'code',
  'csv': 'excel',
  'doc': 'word',
  'docx': 'word',
  'fods': 'excel',
  'gif': 'image',
  'gz': 'archive',
  'heic': 'image',
  'heif': 'image',
  'htm': 'html',
  'html': 'html',
  'ico': 'image',
  'jar': 'archive',
  'jpeg': 'image',
  'jpg': 'image',
  'key': 'ppt',
  'less': 'code',
  'lz': 'archive',
  'lzma': 'archive',
  'markdown': 'markdown',
  'm4v': 'video',
  'md': 'markdown',
  'mdx': 'markdown',
  'mkv': 'video',
  'mov': 'video',
  'mp4': 'video',
  'mpeg': 'video',
  'mpg': 'video',
  'numbers': 'excel',
  'odp': 'ppt',
  'ods': 'excel',
  'odt': 'word',
  'ots': 'excel',
  'pages': 'word',
  'pdf': 'pdf',
  'png': 'image',
  'ppt': 'ppt',
  'pptx': 'ppt',
  'rar': 'archive',
  'rtf': 'word',
  'sass': 'code',
  'scss': 'code',
  'svg': 'image',
  'tar': 'archive',
  'taz': 'archive',
  'tbz': 'archive',
  'tbz2': 'archive',
  'tgz': 'archive',
  'tif': 'image',
  'tiff': 'image',
  'tsv': 'excel',
  'txz': 'archive',
  'webm': 'video',
  'webp': 'image',
  'xls': 'excel',
  'xlsb': 'excel',
  'xlsm': 'excel',
  'xlt': 'excel',
  'xltm': 'excel',
  'xltx': 'excel',
  'xlsx': 'excel',
  'xz': 'archive',
  'zip': 'archive',
  'zst': 'archive',
}

/** 完整文件名的传统档匹配（无扩展名的约定文件）。 */
const NAME_TYPES: Readonly<Record<string, TraditionalFileType>> = {
  changelog: 'markdown',
  contributing: 'markdown',
  readme: 'markdown',
}

/** 取路径最后一段（两种分隔符都吃；反斜杠是 Windows 的常规写法）。 */
export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * 取基名最后一个 `.` 之后的部分（不改大小写）。
 * 前导点算起点（`.env` → `env`），没有点或点结尾给空串（`LICENSE` → `''`）。
 */
export function fileExtension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

/** 这个档是不是有专属全彩字形的那一类。 */
export function isCodeFileType(type: string): type is CodeFileType {
  return CODE_FILE_TYPE_SET.has(type)
}

/**
 * 按 dsh 的四级优先级解析代码 / 配置档。
 *
 * @param name - 已小写的基名。
 * @param extension - 已小写、不含点的扩展名。
 * @param context - 可选的项目文件快照（`.dart` 要看 pubspec 里有没有 `flutter:`）。
 * @returns 命中的代码档；没命中给 null（交给传统档那张表）。
 */
export function classifyCodeFileType(
  name: string,
  extension: string,
  context?: FileTypeProjectContext,
): CodeFileType | null {
  const exact = FILE_NAME_TYPES[name]
  if (exact !== undefined) return exact
  for (const [prefix, type] of FILE_NAME_PREFIX_TYPES) {
    if (name.startsWith(prefix)) return type
  }
  for (const [suffix, type] of FILE_NAME_SUFFIX_TYPES) {
    if (name.endsWith(suffix)) return type
  }
  if (extension === 'dart' && context !== undefined) {
    const pubspec = Object.entries(context.files).find(([path]) => basename(path).toLowerCase() === 'pubspec.yaml')?.[1]
    if (pubspec?.includes('flutter:') === true) return 'flutter'
  }
  return CODE_EXTENSION_TYPES[extension] ?? null
}

/**
 * 文件名 / 路径 → 类型档。大小写不敏感；代码档先于传统档；都没命中给 `other`。
 *
 * @param path - 文件路径或基名（两种分隔符都行）。
 * @param context - 可选的项目文件快照（只有上下文敏感的档会读它）。
 * @returns 这个文件的呈现档位。
 */
export function classifyFileType(path: string, context?: FileTypeProjectContext): ClassifiedFileType {
  const name = basename(path).toLowerCase()
  const extension = fileExtension(name).toLowerCase()
  return classifyCodeFileType(name, extension, context)
    ?? NAME_TYPES[name]
    ?? EXTENSION_TYPES[extension]
    ?? 'other'
}
