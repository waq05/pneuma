/**
 * 宿主半：一个最普通的 cordis 插件（命名导出 inject / apply）。
 *
 * 与 `~/.dsc/plugins/` 里的单文件插件写法完全一样——两半的差别只在包装：
 * 界面半在 `package.json` 的 `dsh.client` 里声明，代码在 `exports["./client"]`。
 */
export const name = 'dsc-demo-two-halves'
export const inject = ['tools']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'two_halves_hi',
    description: 'Say hello from the host half of a two-half package.',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => '两半都在',
  })
  return () => off()
}
