/**
 * 内核自检总闸：`scripts/*-test.mjs` 里**不属于界面壳**的那一批（49 条）。
 *
 * 与 `check-ui.mjs` 的分工按目录约定来，不按重要性：
 *   - `ui-*` 归 `check:ui`（眨眼级，改壳的人随时跑）；
 *   - 其余归这里（内核、协议、TUI、会话库、LLM 适配），跑一遍约 7–8 分钟，
 *     提交前跑一次就够；
 *   - `ui-hmr-machine.mjs`（真机走查，会改源码再还原）与 `desktop/shots/*.ps1`
 *     （要真桌面窗口）都不在这条路上，手动跑。
 *
 * 为什么也按文件名自动发现：这套门禁的最大教训是「靠人记着跑哪几条」——库里有 84 条
 * `*-test.mjs`，手挂的清单永远追不上。新探针命名成 `<话题>-test.mjs` 就自动进来。
 *
 * 用法：
 *   node scripts/check-core.mjs          # 全部
 *   node scripts/check-core.mjs --list   # 只列会跑哪些
 *   node scripts/check-core.mjs session-dedupe-test.mjs   # 只跑点名的
 */
import { discover, runSequential } from './_check-runner.mjs'

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const named = args.filter((arg) => !arg.startsWith('--'))

const all = discover(['-test.mjs']).filter((file) => !file.startsWith('ui-'))
const picked = named.length
  ? named.map((name) => (name.endsWith('.mjs') ? name : name + '.mjs'))
  : all

if (picked.length === 0) {
  console.error('没找到任何内核探针')
  process.exit(2)
}
if (listOnly) {
  for (const file of picked) console.log(file)
  process.exit(0)
}

process.exit((await runSequential(picked)) === 0 ? 0 : 1)
