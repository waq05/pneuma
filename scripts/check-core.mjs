/**
 * 内核侧探针总闸：`scripts/*-test.mjs` 里**不属于界面壳**的那一批。
 *
 * ## 这条通道是什么（2026-11-16 定稿，别误读）
 *
 * 它跑的是 **Vitest 表达不了的探针**，不是「还没迁完的遗留」。测试体系的主体已经迁到
 * Vitest：`pnpm test`（unit / ui / tui）、`pnpm run test:int`（真内核 + 临时 HOME）、
 * `pnpm run test:snapshot`（帧与录制回放）、`pnpm run test:cli`、`pnpm run test:live`。
 * 留在这里的每一条都有机制级理由，逐条的「钉什么 / 为什么迁不走 / 谁跑」写在
 * `docs/testing-backlog.md` 第三节的归属表里：
 *
 *   - `plugin-hot-update` / `plugin-library`：验 Node 的 ESM 缓存戳（`?t=mtime` 换新实例）。
 *     Vitest 的动态 import 走 Vite 管线、不吃这个缓存戳，硬迁只会得到恒绿或恒红的假证据；
 *   - `injection-card-tip` / `settings-embed-slot`：渲染段已由 ui spec 承接
 *     （`ui-transcript/ui/injection-card-tip.spec.tsx`、`ui-settings/ui/embed-slot.spec.tsx`），
 *     留下的是字典资源审计、源码身份钉与真终端探测那几段——jsdom 与宿主桩够不到；
 *   - `session-permissions` / `readme` / `release-notes`：验的是源码文本、文档与发版脚本，
 *     没有运行期接缝；`readme` / `release-notes` 属于文档闸，不属于产品测试。
 *
 * P3 收尾批（2026-11-16）对账过一轮：session-picker-mouse / session-title-live /
 * tui-gutter-hover / tui-snapshot-coalesce / settings 五条的行为段已整条迁进
 * tui / integration 层（逐条反向验证），探针已删；本条通道从 12 条降到 7 条。
 * 搬不动的在探针头部与 backlog 里留了理由——看到清单还剩这几条时先读那张表，
 * 别当成没迁完。
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
