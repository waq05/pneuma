/**
 * 冻结检查：`desktop/src/renderer/` 那份旧界面样式没被人偷改。
 *
 * 阶段 8b 立这条探针时的规矩是「四对样式两边都不许动」。**PROVENANCE.md 后来改了口径**
 * （也是实际走法）：`ui-shell/src/legacy/` 才是这份样式表的新家——旧界面停用之后，
 * 加某个视图的布局只能加在 `legacy/views.css`（改在没人加载的旧文件里等于没改，
 * 还不报错）。所以这条探针现在钉的是**冻结**那一半：
 *
 *   1. **desktop 侧四份必须与 PROVENANCE 记录的「复制时哈希」一致**——旧渲染层是
 *      留档待弃的回落档（见它的 FROZEN.md），任何人动它都是改在一个没人维护的文件里；
 *   2. legacy 侧的 `base.css` / `primitives.css` 仍要求逐字节一致（这两份还没分叉）；
 *   3. legacy 侧的 `tokens.css` / `views.css` **允许分叉**（新家），不一致只报一行
 *      「已分叉」当记录，不算失败；
 *   4. 顺序表（PROVENANCE 的四行）与目录里的实际文件对得上，防止单方面增删。
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

/** 四对文件的对应关系（来自 PROVENANCE.md 的表）；`owned` = 这一份已被壳认领为新家、允许分叉。 */
const PAIRS = [
  { copy: 'tokens.css', source: join('styles', 'tokens.css'), owned: true },
  { copy: 'base.css', source: join('styles', 'base.css'), owned: false },
  { copy: 'primitives.css', source: join('styles', 'primitives.css'), owned: false },
  { copy: 'views.css', source: 'styles.css', owned: true },
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
  const recorded = recordedHashes.get(pair.copy)

  // ① 冻结那一半：桌面渲染层那份不许再动（与复制时哈希一致）。
  check(
    `${pair.source} 是冻结的（与 PROVENANCE 记录的复制时哈希一致）`,
    recorded !== undefined && sha16(sourceBytes) === recorded.hash && sourceBytes.length === recorded.size,
    recorded === undefined ? 'PROVENANCE 里没有这一行' : `记录=${recorded.hash}/${String(recorded.size)} 实际=${sha16(sourceBytes)}/${String(sourceBytes.length)}`,
  )

  // ② legacy 侧：未认领的两个必须逐字节一致；认领为新家的两个允许分叉（只记录）。
  const same = copyBytes.equals(sourceBytes)
  if (pair.owned) {
    if (!same) {
      console.log(`  INFO  legacy/${pair.copy} 已分叉（本目录是新家，允许带壳自己的增改）legacy=${sha16(copyBytes)} renderer=${sha16(sourceBytes)}`)
    } else {
      console.log(`  INFO  legacy/${pair.copy} 仍与冻结副本一致（未见分叉）`)
    }
  } else {
    check(
      `legacy/${pair.copy} 与冻结副本逐字节一致（这一份还没被认领为新家）`,
      same,
      `legacy=${sha16(copyBytes)} renderer=${sha16(sourceBytes)}`,
    )
  }
}

// PROVENANCE 的表与目录对得上（防止单方面增删文件）
const listed = [...recordedHashes.keys()].sort().join(',')
check('PROVENANCE 的文件清单与实际目录一致', listed === PAIRS.map((pair) => pair.copy).sort().join(','), listed)

if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
