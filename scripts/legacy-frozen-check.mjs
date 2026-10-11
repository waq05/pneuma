/**
 * 冻结检查（阶段 8b）：ui-shell/src/legacy/ 的四份样式与桌面渲染层那份逐字节一致。
 *
 * PROVENANCE.md 的「逐字节副本」是一条可验证的事实：两边任何一边单独改动都会让
 * 「legacy/ 是旧界面样式的忠实副本」失效——壳以为自己在复刻旧界面，实际已经悄悄分叉。
 * 自桌面切壳（阶段 5.6）起，desktop/src/renderer/ 进入冻结（见那份 FROZEN.md）：
 * 这四对文件**两边都不该再动**；壳的新样式写 ui-shell/src/styles.css。
 *
 * 核对三件事：
 *   1. 四对文件两两 SHA256 一致（分叉即失败）；
 *   2. 与 PROVENANCE.md 里记录的「复制时哈希」一致（连 legacy 一侧也没人动过）；
 *   3. 顺序表（PROVENANCE 的四行）与目录里的实际文件对得上，防止单方面增删。
 *
 * 运行：node scripts/legacy-frozen-check.mjs
 *
 * @module dsc/scripts/legacy-frozen-check
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const legacyDir = join(root, 'ui-shell', 'src', 'legacy')
const rendererDir = join(root, 'desktop', 'src', 'renderer')

/** 四对文件的对应关系（来自 PROVENANCE.md 的表）。 */
const PAIRS = [
  { copy: 'tokens.css', source: join('styles', 'tokens.css') },
  { copy: 'base.css', source: join('styles', 'base.css') },
  { copy: 'primitives.css', source: join('styles', 'primitives.css') },
  { copy: 'views.css', source: 'styles.css' },
]

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16).toUpperCase()

// 解析 PROVENANCE.md 里记录的「复制时哈希 + 大小」
const provenance = readFileSync(join(legacyDir, 'PROVENANCE.md'), 'utf8')
const recordedHashes = new Map(
  [...provenance.matchAll(/\| `([^`]+)` \| `[^`]+` \| `([0-9A-F]{16})` \| (\d+) \|/g)].map(
    (match) => [match[1], { hash: match[2], size: Number(match[3]) }],
  ),
)

for (const pair of PAIRS) {
  const copyBytes = readFileSync(join(legacyDir, pair.copy))
  const sourceBytes = readFileSync(join(rendererDir, pair.source))
  check(
    `${pair.copy} ⇄ ${pair.source} 逐字节一致`,
    copyBytes.equals(sourceBytes),
    `legacy=${sha16(copyBytes)} renderer=${sha16(sourceBytes)}`,
  )
  const recorded = recordedHashes.get(pair.copy)
  check(
    `${pair.copy} 与 PROVENANCE 记录的复制时哈希一致（legacy 一侧没动过）`,
    recorded !== undefined && sha16(copyBytes) === recorded.hash && copyBytes.length === recorded.size,
    recorded === undefined ? 'PROVENANCE 里没有这一行' : `记录=${recorded.hash}/${String(recorded.size)} 实际=${sha16(copyBytes)}/${String(copyBytes.length)}`,
  )
}

// PROVENANCE 的表与目录对得上（防止单方面增删文件）
const listed = [...recordedHashes.keys()].sort().join(',')
check('PROVENANCE 的文件清单与实际目录一致', listed === PAIRS.map((pair) => pair.copy).sort().join(','), listed)

if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
