/**
 * 文本类文件的扩展名 → shiki 语法 id 表（旧渲染层 file-util.ts:42-64 的逐字节副本）。
 *
 * 为什么单独一个无依赖小文件：highlight.ts 要在 Node 侧探针与浏览器两侧都能载入，
 * 把这张纯数据表独立出来，谁要「扩展名算语法 id」都不必拖上 shiki 本体。
 *
 * @module dsc-ui-shell/platform/lang-table
 */

/** 文本类文件的扩展名 → shiki 语法 id（没列出的按纯文本渲染）。 */
export const SHIKI_LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', tsx: 'tsx',
  json: 'json', jsonc: 'jsonc', json5: 'json5',
  md: 'markdown', mdx: 'mdx',
  py: 'python', pyi: 'python',
  rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  php: 'php', rb: 'ruby', lua: 'lua', scala: 'scala',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'dotenv',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', props: 'xml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', vue: 'vue', svelte: 'svelte', astro: 'astro',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  m: 'objective-c', mm: 'objective-cpp', dart: 'dart', r: 'r', jl: 'julia',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure', cljs: 'clojure',
  pl: 'perl', pm: 'perl', zig: 'zig', sol: 'solidity', fs: 'fsharp',
  diff: 'diff', patch: 'diff', log: 'log', rst: 'rst', tex: 'latex',
  makefile: 'makefile', mk: 'makefile',
}
