/**
 * 把 `src/packages/<id>/package.json` 的 `version` 全部对齐到根 `package.json`，
 * 并把界面插件的 `pneuma.client.api` 区间对齐到界面壳版本（同一份版本号）。
 *
 * ## 为什么要有它
 *
 * 86 个包各自写真实版本号（与 dsh 同形），发版时改一处根版本就要推 86 处；手推必然漏，
 * 漏了的表现是「装上的包里有一个还报着上个版本」，排查很费劲。
 * 门禁（plugin-standard-check 第 1 项）只认「等于根」，这个脚本负责把它改回来。
 *
 * ## 为什么 api 区间也在这里推
 *
 * 界面壳的 `version` 同时是插件清单的 `apiVersion`，22+ 个界面插件的
 * `pneuma.client.api` 声明「我面对哪一版契约」。包级测试要求它与壳版本**严格相等**
 * （`'^' + 壳 version`）：运行时靠 semver 区间 `^0.9.1` 也能满足 0.9.2，但两份版本号
 * 从这次发版起就开始漂，将来排查很费劲（0.9.1 发版提交里已经踩过一次）。
 * 0.9.2 发版时只推了 `version`、漏了 api 区间，`ui-layout` / `ui-plugins` /
 * `ui-renderer` 三条包级测试就在 CI 上红了——所以推进同一个脚本，不再靠人记。
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
const apiRange = `^${String(rootManifest.version)}`

/** 一条待改项：包 id + 文件 + 字段说明 + 旧值。 */
const drift = []

/**
 * 按「name、version 在前，其余键保持原序」重排后再写盘。
 *
 * 只重排顶层键：`pneuma.client.api` 在嵌套对象里，JSON.parse → 赋值 → stringify
 * 保持插入顺序，改一个叶子不会把整份清单的键序打乱。
 */
function writeManifest(file, manifest) {
  const ordered = {
    name: manifest.name,
    version: manifest.version,
    ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'name' && key !== 'version')),
  }
  writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', 'utf8')
}

for (const id of readdirSync(packagesDir)) {
  const file = join(packagesDir, id, 'package.json')
  if (!existsSync(file)) continue
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  let dirty = false

  if (manifest.version !== rootManifest.version) {
    drift.push({ id, file, field: 'version', from: String(manifest.version) })
    manifest.version = rootManifest.version
    dirty = true
  }

  const client = manifest.pneuma?.client
  if (client !== null && typeof client === 'object' && typeof client.api === 'string' && client.api !== apiRange) {
    drift.push({ id, file, field: 'pneuma.client.api', from: client.api })
    client.api = apiRange
    dirty = true
  }

  if (dirty && write) writeManifest(file, manifest)
}

if (drift.length === 0) {
  console.log(`版本一致：${String(rootManifest.version)}（${String(readdirSync(packagesDir).length)} 个包目录，界面契约区间 ${apiRange}）`)
  process.exit(0)
}
for (const item of drift) console.log(`${item.id}：${item.field} ${item.from} → ${item.field === 'version' ? String(rootManifest.version) : apiRange}`)
const versionCount = drift.filter((item) => item.field === 'version').length
const apiCount = drift.length - versionCount
console.log(
  write
    ? `已改 ${String(drift.length)} 处（version ${String(versionCount)} / api ${String(apiCount)}）`
    : `有 ${String(drift.length)} 处没对齐（version ${String(versionCount)} / api ${String(apiCount)}；加 --write 改盘）`,
)
process.exit(write ? 0 : 1)
