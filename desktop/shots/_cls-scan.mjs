/** 类名撞名扫描（开发辅助）：新加的类名在壳与 legacy 的 CSS 里各定义了几次。 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui-shell', 'src')
const flat = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
const shell = flat('styles.css')
const legacy = ['legacy/views.css', 'legacy/tokens.css', 'legacy/base.css', 'legacy/primitives.css']
  .map(flat)
  .join('\n')

const names = process.argv.slice(2)
const count = (css, name) => (css.match(new RegExp(`\\.${name}[\\s,{:.]`, 'g')) ?? []).length
console.log('类名'.padEnd(26), 'styles', 'legacy', '合计')
for (const name of names) {
  const a = count(shell, name)
  const b = count(legacy, name)
  console.log(name.padEnd(26), String(a).padStart(6), String(b).padStart(6), String(a + b).padStart(5), a + b > 1 ? '  <== 撞名' : '')
}
