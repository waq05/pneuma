/**
 * 侧栏组间顺序的回归探针（2026-11-13 报障：点会话时对应工作区跳到顶部）。
 *
 * 报障原话：在侧栏点别的历史会话，它所在的工作区会跑到顶部，希望保持原位。
 * 根因：`buildWorkGroups` 的手动档在 `workspaceOrder` 为空时，把「等于当前 cwd 的组」
 * 顶到最前；而 cwd 读的是 `status.cwd`（当前会话的目录），所以跨工作区点一条会话，
 * 宿主 cwd 一变，那个组就抢到第一位。
 *
 * 这里不读源码文本判行为，而是把真实的 `grouping.ts` 用 esbuild 打成一个 ESM 直接跑
 * （纯函数，可 import）：判据是「同一份会话库，cwd 从 A 换成 B，组顺序不变」。
 * 每条判据都配一条「脏副本必须红」——脏副本 = 打包产物里把新增的 `sessions.length === 0`
 * 守卫删掉，等价于回到报障前的行为；它红不了，就说明判据在空转。
 *
 * 跑法：node scripts/ui-sidebar-order-test.mjs
 *
 * @module dsc/scripts/ui-sidebar-order-test
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
    failures += 1
  }
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/**
 * 找 esbuild 的可执行文件。
 *
 * 为什么手找而不是 `npx esbuild`：这个仓库的 esbuild 只作为 desktop 的间接依赖装在
 * `.pnpm` 里，没在 `.bin` 挂快捷方式；探针必须在没有全局 esbuild 的机器上也跑得动。
 * 为什么用 `execFile` 而不是 esbuild 的 JS API：JS API 起子进程时用管道收输出，
 * 在受限环境里会被 EPERM 拦掉；直跑 CLI 并把 stdio 设成 inherit 就能过。
 */
function findEsbuild() {
  const store = join(root, 'desktop', 'node_modules', '.pnpm')
  if (!existsSync(store)) return null
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('@esbuild+')) continue
    const pkgDir = join(store, entry, 'node_modules', '@esbuild')
    if (!existsSync(pkgDir)) continue
    for (const platform of readdirSync(pkgDir)) {
      for (const name of ['esbuild.exe', 'esbuild']) {
        const bin = join(pkgDir, platform, name)
        if (existsSync(bin)) return bin
      }
    }
  }
  return null
}

const esbuild = findEsbuild()
if (esbuild === null) {
  console.log('  FAIL 找不到 esbuild（desktop/node_modules/.pnpm 下没有 @esbuild/*）')
  process.exit(1)
}

/** `@dsc/ui` 的最小替身：grouping.ts 只用它拿 `createT` 取一句文案。 */
const stub = join(tmpdir(), `dsc-sidebar-order-stub-${String(process.pid)}.mjs`)
writeFileSync(stub, 'export const createT = () => (key) => key\n')

/**
 * 把 `grouping.ts` 打成一个可直接 import 的 ESM，返回产物文本。
 * 入口用仓库里的原文件，相对 import（两个 locale json）才解析得到。
 */
const bundleOut = join(tmpdir(), `dsc-sidebar-order-${String(process.pid)}.mjs`)
execFileSync(
  esbuild,
  [
    join(root, 'src', 'packages', 'ui-sessions', 'ui', 'grouping.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--alias:@dsc/ui=${stub}`,
    `--outfile=${bundleOut}`,
    '--log-level=silent',
  ],
  { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
)
const bundled = readFileSync(bundleOut, 'utf8')

/**
 * 脏副本：把两条 `sessions.length === 0` 守卫删掉，等价于报障前的「活动组恒置顶」。
 * 找不到这两处就直接报失败——否则「脏副本不红」会被误读成判据有效。
 */
const dirtyText = bundled.replace(/&& [ab]\[1\]\.length === 0/g, '')
const dirtied = bundled.length - dirtyText.length > 0
check('脏副本构造成功（两处空组守卫都被摘掉）', (bundled.match(/&& [ab]\[1\]\.length === 0/g) ?? []).length === 2)
const dirtyOut = join(tmpdir(), `dsc-sidebar-order-dirty-${String(process.pid)}.mjs`)
writeFileSync(dirtyOut, dirtyText)

const load = async (file) => (await import(`${pathToFileURL(file).href}?v=${String(Date.now())}`)).buildWorkGroups
const real = await load(bundleOut)
const dirty = await load(dirtyOut)

const now = Date.now()
/** 两个工作区：dsc 最近动过，waq 的会话都更旧。 */
const sessions = [
  { id: 'D:/dsc/a.jsonl', cwd: 'D:\\dsc', createdAt: now - 9000, updatedAt: now - 1000, title: '开跑' },
  { id: 'D:/dsc/b.jsonl', cwd: 'D:\\dsc', createdAt: now - 9000, updatedAt: now - 8000, title: '开跑 2' },
  { id: 'C:/Users/waq/c.jsonl', cwd: 'C:\\Users\\waq', createdAt: now - 90_000, updatedAt: now - 50_000, title: '你是谁' },
]

/** 跑一帧：只关心组顺序（cwd 序列）。 */
const frame = (fn, cwd, extra = {}) =>
  fn({
    sessions,
    recentCwds: [],
    cwd,
    sort: 'manual',
    group: 'workspace',
    archived: 'hide',
    trimmed: '',
    aliases: {},
    order: [],
    sessionOrder: {},
    ...extra,
  }).map((group) => group.cwd)

// ── [1] 点会话不位移 ──────────────────────────────────────────────────────────────
const before = frame(real, 'D:\\dsc')
const after = frame(real, 'C:\\Users\\waq')
check('[1] 基线：最近使用的工作区在前', same(before, ['D:\\dsc', 'C:\\Users\\waq']), JSON.stringify(before))
check(
  '[1] 点开另一个工作区的会话，组顺序不变',
  same(before, after),
  `点前 ${JSON.stringify(before)}，点后 ${JSON.stringify(after)}`,
)
check('[1] 再从 waq 点回 dsc，顺序仍然不变', same(frame(real, 'D:\\dsc'), after))

// ── [2] 脏副本（报障前的行为）必须红 ─────────────────────────────────────────────
const dirtyAfter = frame(dirty, 'C:\\Users\\waq')
check(
  '[2] 脏副本上同一判据必须红（活动组抢到第一位）',
  dirtied && !same(before, dirtyAfter) && dirtyAfter[0] === 'C:\\Users\\waq',
  JSON.stringify(dirtyAfter),
)

// ── [3] 新工作区仍然置顶：切过去还没发消息的空目录要第一眼看得见 ──────────────────
const fresh = real({
  sessions,
  recentCwds: ['D:\\new-dir'],
  cwd: 'D:\\new-dir',
  sort: 'manual',
  group: 'workspace',
  archived: 'hide',
  trimmed: '',
  aliases: {},
  order: [],
  sessionOrder: {},
}).map((group) => group.cwd)
check('[3] 切到空工作区，它排在第一位', fresh[0] === 'D:\\new-dir', JSON.stringify(fresh))
check('[3] 空工作区置顶不挤掉其余组', fresh.length === 3 && same(fresh.slice(1), before), JSON.stringify(fresh))

// ── [4] 手动拖过的顺序优先，活动组不抢位 ─────────────────────────────────────────
const manual = frame(real, 'D:\\dsc', { order: ['C:\\Users\\waq', 'D:\\dsc'] })
check('[4] workspaceOrder 非空时按手动顺序', same(manual, ['C:\\Users\\waq', 'D:\\dsc']), JSON.stringify(manual))
check('[4] 手动顺序下点会话也不位移', same(frame(real, 'C:\\Users\\waq', { order: ['C:\\Users\\waq', 'D:\\dsc'] }), manual))

// ── [5] 时间档不受影响：只按时间，不看 cwd ────────────────────────────────────────
check('[5] 最近更新档按时间倒序', same(frame(real, 'C:\\Users\\waq', { sort: 'recent' }), ['D:\\dsc', 'C:\\Users\\waq']))
check('[5] 创建时间档同上', same(frame(real, 'C:\\Users\\waq', { sort: 'created' }), ['D:\\dsc', 'C:\\Users\\waq']))

// ── [6] 源码判据（打包产物口径）：守卫真的在比较器里 ───────────────────────────────
const source = readFileSync(join(root, 'src', 'packages', 'ui-sessions', 'ui', 'grouping.ts'), 'utf8')
const hasGuard = (text) =>
  text.includes('const aFresh = a[0] === cwd && a[1].length === 0') &&
  text.includes('const bFresh = b[0] === cwd && b[1].length === 0')
check('[6] 比较器里留着「空的活动组才置顶」守卫', hasGuard(source))
check(
  '[6] 守卫判据对脏副本必须红',
  !hasGuard(source.split('const aFresh = a[0] === cwd && a[1].length === 0').join('const aFresh = a[0] === cwd')),
)

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
process.exit(failures === 0 ? 0 : 1)
