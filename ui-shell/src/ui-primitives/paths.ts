/**
 * 路径展示的纯工具（桌面渲染层 `file-util.ts` 同构移植的展示部分）。
 *
 * @module dsc-ui-shell/platform/paths
 */

/** 路径的展示形态（dsh `displayPathOf` 的同位函数）：工作目录内 → 相对路径；
 *  home 内 → `~/…`；其余原样。两段比较都按小写比——Windows 路径大小写不敏感，
 *  模型写的 `D:\dsc` 和宿主给回的 `d:\dsc` 是同一个目录。 */
export function displayPathOf(path: string, cwd: string, home = ''): string {
  if (path === '') return ''
  const posix = path.replace(/\\/g, '/')
  if (cwd !== '') {
    const base = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    const low = posix.toLowerCase()
    const baseLow = base.toLowerCase()
    if (low === baseLow.slice(0, -1)) return '.'
    if (low.startsWith(baseLow)) return posix.slice(base.length)
  }
  if (home !== '') {
    const base = `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    const low = posix.toLowerCase()
    const baseLow = base.toLowerCase()
    if (low === baseLow.slice(0, -1)) return '~'
    if (low.startsWith(baseLow)) return `~/${posix.slice(base.length)}`
  }
  return posix
}

/** 路径里的文件名（两种分隔符都认；`split(/[\\/]/).pop()` 的显式写法）。 */
export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
