/**
 * 内核自检总闸：`scripts/*-test.mjs` 里**不属于界面壳**的那一批。
 *
 * ## 它现在的角色（2026-11-13 起，别误读）
 *
 * 这个脚本**不再是主测试入口**。测试体系迁到 Vitest 之后（`pnpm test` / `pnpm run test:int`），
 * 留在 `scripts/` 的探针分两类，只有第二类是真的长期住户：
 *
 *   1. **还没迁的**——P2 正在分批往 `*.int.spec.ts` 搬，搬完就从这里消失；
 *   2. **迁不走的**——`plugin-hot-update` 与 `plugin-library` 验的是 Node 的 ESM 模块缓存
 *      语义（`?t=mtime` 换新实例），而 Vitest 的动态 import 走 Vite 管线、不吃这个缓存戳。
 *      硬迁出来的测试要么恒绿要么恒红，那是假证据。**这两条有意留在这里，由裸 Node 跑。**
 *
 * 所以：看到清单里还剩几条，先看 `docs/testing-backlog.md` 第三节，别一律当成「没迁完」。
 * 判据、例外与归属都写在那份文档里。
 *
 * 与 `check-ui.mjs` 的分工按目录约定来，不按重要性：
 *   - `ui-*` 归 `check:ui`（眨眼级，改壳的人随时跑）；
 *   - 其余归这里（内核、协议、TUI、会话库、LLM 适配）；
 *   - `ui-hmr-machine.mjs`（真机走查，会改源码再还原）与 `desktop/shots/*.ps1`
 *     （要真桌面窗口）都不在这条路上，手动跑。
 *
 * 为什么也按文件名自动发现：这套门禁的最大教训是「靠人记着跑哪几条」——库里有几十条
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
