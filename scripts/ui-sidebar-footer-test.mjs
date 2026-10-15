/**
 * 侧栏页脚探针：钉住左下角两行的契约（2026-10-15 batch34 改版——「打开目录」行下岗，
 * 「会话用量」改「今日总用量」）。
 *
 *   [1] 单位量级口径：formatTokens（共享份 `ui-primitives/tokens.ts`——会话页脚 / 状态栏 /
 *       轮尾 / 轨迹页同一份）的 K/M 真值表；0→'0'、1000→'1K'、1500→'1.5K'、46000→'46K'、
 *       128000→'128K'、1e6→'1M'、2.5e6→'2.5M'、987654321→'988M'、非有限 / 负数→'0'。
 *       判据对「永不缩写」的假实现必须红。
 *   [2] 页脚契约（sessions/ui.tsx 文本钉，正反双验）：
 *       正——今日总用量文案（恰好一处）、宿主 usageStats 通道接线、days 末位取今天那格、
 *       60 秒兜底轮询；负——「会话用量」「在别的目录开新会话」「页脚内派发
 *       shell.session.new」不出现在本文件。弄脏副本各红。
 *   [3] 通道可用性钉：'usageStats' 在桌面界面白名单（core/ui-methods.ts）与手机 remote 面
 *       （plugins/remote/types.ts）各在一条——哪一边摘了它，哪一边的页脚断量。
 *   [4] 产物钉（依赖 `pnpm build:ui`，产物旧了会红——那是故意的信号）：
 *       lib/ui/plugins/sessions/client.js 含今日总用量与 usageStats 接线，
 *       不再含旧口径两条。
 *
 * 自证非空转沿用本仓规矩：每条判据成对给出「真数据绿 / 弄脏副本红」，红不了就是空转。
 *
 * 跑法：先 `pnpm build:ui`（[4] 读 lib/ui/assets），然后 `node scripts/ui-sidebar-footer-test.mjs`。
 *
 * @module dsc/scripts/ui-sidebar-footer-test
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
/** 判据记账：过绿、不过红并给细节，末尾以此定退出码。 */
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else { console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`); failures += 1 }
}
const read = (part) => readFileSync(join(root, part), 'utf8')
/** 全量替换（string.replaceAll 的保守写法）：弄脏副本制作用。 */
const dirtyAll = (hay, from, to) => hay.split(from).join(to)

// ── [1] 单位量级口径（共享 formatTokens 的 K/M 真值表） ──────────────────────────

const { formatTokens } =
  await import(new URL('../ui-shell/src/ui-primitives/tokens.ts', import.meta.url).href)

/** 全部档位必须命中——0 / 个位 / 千档 / 万档 / 百 K / M 档 / 千 M 档 / 非法值各占几条 */
const TRUTH_TABLE = [
  [0, '0'],
  [1, '1'],
  [999, '999'],
  [1000, '1K'],
  [1500, '1.5K'],
  [19428, '19.4K'],
  [46000, '46K'],
  [128000, '128K'],
  [1000000, '1M'],
  [2500000, '2.5M'],
  [12300000, '12.3M'],
  [987654321, '988M'],
  [NaN, '0'],
  [Infinity, '0'],
  [-5, '0'],
]

/** 真值表判据：真实现必须全绿；「永不缩写」的假实现必须红——量级换算不再是装饰。 */
function truthTableOk(fmt) {
  return TRUTH_TABLE.every(([input, expected]) => fmt(input) === expected)
}

check('[1] K/M 量级真值表（共享 formatTokens）', truthTableOk(formatTokens))
check('[1] 真值表对「永不缩写」假实现必须红', !truthTableOk((value) => String(Math.round(value))),
  '真值表收不了假实现——换算口径的断言空转')
check('[1] tokens 从共享出口（ui-primitives/index.ts）',
  read('ui-shell/src/ui-primitives/index.ts').includes("export * from './tokens'"),
  'index.ts 没把 tokens 从种子出口——页脚的共享引用会静默 undefined')

// ── [2] 页脚契约（sessions/ui.tsx 文本钉） ────────────────────────────────────────

const src = read('ui-shell/src/plugins/sessions/ui.tsx')
const labelOnce = (s) => s.split('<span>今日总用量</span>').length === 2
const channelCall = (s) => s.includes(".invoke<UsageStatsView>('usageStats')")
const lastDayCell = (s) => s.includes('stats.days[stats.days.length - 1]')
const pollTimer = (s) => s.includes('window.setInterval(load, 60_000)')
const noLegacyLabel = (s) => !s.includes('会话用量')
const noLegacyBrowse = (s) => !s.includes('在别的目录开新会话')
const noFooterDispatch = (s) => !s.includes("dispatchEvent(new CustomEvent('shell.session.new'")
const tipReachable = (s) => s.includes('data-tip={FOOTER_USAGE_TIP} title={FOOTER_USAGE_TIP}')

check('[2] 页脚文案改为今日总用量（恰好一处）', labelOnce(src))
check('[2] 今日口径走宿主 usageStats 通道', channelCall(src))
check('[2] days 末位取今天那格', lastDayCell(src))
check('[2] 60 秒兜底轮询在（其他窗口的量靠它跟上）', pollTimer(src))
check('[2] 本文件不再有会话口径文案', noLegacyLabel(src))
check('[2] 目录行的 tip 字样已从本文件绝迹', noLegacyBrowse(src))
check('[2] 页脚只订不派 shell.session.new（选目录开会话归组头 ➕）', noFooterDispatch(src))
check('[2] 悬浮说明走原生 title（壳不渲染 data-tip）', tipReachable(src))

// 弄脏副本各红（每条正判据一个专属脏法）
check('[2] 文案判据对脏副本必须红', !labelOnce(dirtyAll(src, '今日总用量', '会话用量')))
check('[2] 通道判据对脏副本必须红', !channelCall(dirtyAll(src, "'usageStats'", "'usageStats2'")))
check('[2] days 末位判据对脏副本必须红', !lastDayCell(dirtyAll(src, 'stats.days.length - 1', '0')))
check('[2] 轮询判据对脏副本必须红', !pollTimer(dirtyAll(src, '60_000', '86400000')))
check('[2] 旧口径缺席判据对脏副本必须红', !noLegacyLabel(src + '会话用量'))
check('[2] 目录行缺席判据对脏副本必须红', !noLegacyBrowse(src + '在别的目录开新会话'))
check('[2] 派发缺席判据对脏副本必须红',
  !noFooterDispatch(src + "window.dispatchEvent(new CustomEvent('shell.session.new', { detail: { cwd: 'x' } }))"))
check('[2] title 判据对脏副本必须红', !tipReachable(dirtyAll(src, 'title={FOOTER_USAGE_TIP}', 'title="x"')))

// ── [3] 通道可用性钉（两条传输面都开着） ─────────────────────────────────────────

const uiMethodsSource = read('src/core/ui-methods.ts')
const remoteTypesSource = read('src/plugins/remote/types.ts')
check('[3] 桌面界面白名单放行 usageStats', uiMethodsSource.includes("'usageStats'"))
check('[3] 手机 remote 面放行 usageStats', remoteTypesSource.includes("'usageStats'"))
check('[3] 桌面判据对脏副本必须红',
  !uiMethodsSource.split("'usageStats'").join("'usageStats2'").includes("'usageStats'"))
check('[3] 手机判据对脏副本必须红',
  !remoteTypesSource.split("'usageStats'").join("'usageStats2'").includes("'usageStats'"))

// ── [4] 产物钉（依赖 pnpm build:ui） ─────────────────────────────────────────────

const clientPath = 'lib/ui/plugins/sessions/client.js'
if (!existsSync(join(root, clientPath))) {
  console.log(`  FAIL [4] 找不到壳产物 ${clientPath}——先跑 pnpm build:ui`)
  failures += 1
} else {
  const client = read(clientPath)
  check('[4] 产物含今日总用量文案', client.includes('今日总用量'))
  check('[4] 产物含 usageStats 接线', client.includes('usageStats'))
  check('[4] 产物不再含旧口径两条', !client.includes('会话用量') && !client.includes('在别的目录开新会话'))
  check('[4] 「在」判据可红（自证）', !client.includes('侧栏页脚探针自证哨兵'))
}

console.log('─'.repeat(24))
if (failures === 0) {
  console.log(`ui-sidebar-footer-test：${String(failures)} 处未过，全部绿。`)
  process.exit(0)
}
console.log(`ui-sidebar-footer-test：${String(failures)} 处未过。`)
process.exit(1)
