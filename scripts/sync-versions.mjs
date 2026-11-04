/**
 * 把 `src/packages/<id>/package.json` 的 `version` 全部对齐到根 `package.json`。
 *
 * 为什么要有它：86 个包各自写真实版本号（与 dsh 同形），发版时改一处根版本就要推 86 处；
 * 手推必然漏，漏了的表现是「装上的包里有一个还报着上个版本」，排查很费劲。
 * 门禁（plugin-standard-check 第 1 项）只认「等于根」，这个脚本负责把它改回来。
 *
 * 用法：
 *   node scripts/sync-versions.mjs          # 只报差异，不写盘
 *   node scripts/sync-versions.mjs --write  # 写盘
 *
 * @module scripts/sync-versions
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const write = process.argv.includes('--write')
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packagesDir = join(root, 'src', 'packages')

const drift = []
for (const id of readdirSync(packagesDir)) {
  const file = join(packagesDir, id, 'package.json')
  if (!existsSync(file)) continue
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (manifest.version === rootManifest.version) continue
  drift.push({ id, file, from: manifest.version })
  if (!write) continue
  // 保持键序：name 之后紧跟 version。
  const ordered = {
    name: manifest.name,
    version: rootManifest.version,
    ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'name' && key !== 'version')),
  }
  writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', 'utf8')
}

if (drift.length === 0) {
  console.log(`版本一致：${String(rootManifest.version)}（${String(readdirSync(packagesDir).length)} 个包目录）`)
  process.exit(0)
}
for (const item of drift) console.log(`${item.id}：${String(item.from)} → ${String(rootManifest.version)}`)
console.log(write ? `已改 ${String(drift.length)} 个清单` : `有 ${String(drift.length)} 个清单没对齐（加 --write 改盘）`)
process.exit(write ? 0 : 1)
