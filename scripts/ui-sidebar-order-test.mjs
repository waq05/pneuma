/**
 * 侧栏组间顺序的回归探针，盯两起「组自己跑位」的报障。
 *
 * ## 2026-11-13：点会话时对应工作区跳到顶部
 *
 * 根因：`buildWorkGroups` 的手动档在 `workspaceOrder` 为空时，把「等于当前 cwd 的组」
 * 顶到最前；而 cwd 读的是 `status.cwd`（当前会话的目录），所以跨工作区点一条会话，
 * 宿主 cwd 一变，那个组就抢到第一位。
 *
 * ## 2026-11-17：在某工作区新建会话后，该目录整体移到顶部
 *
 * 报障原话：「工作区创建新会话后，目录会直接整体移到顶部。正常应该目录应该是不变位置的。」
 * 根因：manual 档组间兜底排序用的是「组内最近一条会话的 `updatedAt` 倒序」。新建的
 * 会话 `updatedAt` 就是「此刻」，于是整组顶到第一位。现在 manual 档只按「工作区第一次
 * 出现的时间」（组内最早一条 `createdAt`）倒序排，同键用 cwd 字符串兜底成全序；
 * `order` 非空时表外两组之间也不再掉回 `updatedAt` 比较。
 *
 * ## 怎么跑
 *
 * 这里不读源码文本判行为，而是把真实的 `grouping.ts` 用 esbuild 打成一个 ESM 直接跑
 * （纯函数，可 import）。每条判据都配一条「脏副本必须红」，脏副本有三种：
 *   - A：摘掉 `sessions.length === 0` 空组守卫 → 等价于 2026-11-13 报障前的行为；
 *   - B：把 manual 档两处 `byFirstSeen(a, b)` 兜底换回 `lastUsed` 倒序 → 等价于
 *     2026-11-17 报障前的行为；
 *   - C：摘掉两处 `createdAt` 非有限兜底 → 排序键遇 `undefined` 变 `NaN`，比较器失去全序，
 *     组顺序随会话库的输入序漂。
 * 脏副本红不了，就说明对应判据在空转。
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
 * 为什么手找而不是 `npx esbuild`：这个仓库的 esbuild 只作为间接依赖装在 `.pnpm` 里，
 * 没在 `.bin` 挂快捷方式；探针必须在没有全局 esbuild 的机器上也跑得动。
 * 为什么用 `execFile` 而不是 esbuild 的 JS API：JS API 起子进程时用管道收输出，
 * 在受限环境里会被 EPERM 拦掉；直跑 CLI 并把 stdio 设成 inherit 就能过。
 *
 * 2026-11 补：虚拟仓的位置取决于安装形态。四个项目收进一个 pnpm workspace 之后，
 * 干净 checkout 里只有仓库根的 `node_modules/.pnpm`，`desktop/node_modules/.pnpm`
 * 是旧安装留下的；只认后者会让这条探针在新 worktree 里直接判失败——那是脚本自己的
 * 环境假设坏了，不是被测行为坏了。所以三处都找。
 */
function findEsbuild() {
  const stores = [
    join(root, 'node_modules', '.pnpm'),
    join(root, 'desktop', 'node_modules', '.pnpm'),
    join(root, 'ui-shell', 'node_modules', '.pnpm'),
  ]
  for (const store of stores) {
    if (!existsSync(store)) continue
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
  }
  return null
}

const esbuild = findEsbuild()
if (esbuild === null) {
  console.log('  FAIL 找不到 esbuild（node_modules/.pnpm 与 desktop、ui-shell 的 .pnpm 下都没有 @esbuild/*）')
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
 * 脏副本 A：把两条 `sessions.length === 0` 守卫删掉，等价于 2026-11-13 报障前的「活动组恒置顶」。
 * 找不到这两处就直接报失败——否则「脏副本不红」会被误读成判据有效。
 */
const dirtyText = bundled.replace(/&& [ab]\[1\]\.length === 0/g, '')
const dirtied = bundled.length - dirtyText.length > 0
check('脏副本 A 构造成功（两处空组守卫都被摘掉）', (bundled.match(/&& [ab]\[1\]\.length === 0/g) ?? []).length === 2)
const dirtyOut = join(tmpdir(), `dsc-sidebar-order-dirty-${String(process.pid)}.mjs`)
writeFileSync(dirtyOut, dirtyText)

/**
 * 脏副本 B：把 manual 档两处 `return byFirstSeen(a, b)` 兜底换回旧的 `lastUsed` 倒序，
 * 等价于 2026-11-17 报障前的行为（组间顺序跟着会话活动跑）。两处都换：
 * 一处是 `order` 为空的兜底（「建新会话整组跳顶」的主线），一处是 `order` 非空时
 * 表外两组的兜底（同一根因的第二处）。换不到两处就报失败，别让判据空转。
 */
const dirtyBText = bundled.split('return byFirstSeen(a, b)').join('return lastUsed(b[1]) - lastUsed(a[1])')
const dirtyBPatched = (bundled.match(/return byFirstSeen\(a, b\)/g) ?? []).length === 2
check('脏副本 B 构造成功（两处 manual 兜底换回 updatedAt 倒序）', dirtyBPatched)
const dirtyBOut = join(tmpdir(), `dsc-sidebar-order-dirty-b-${String(process.pid)}.mjs`)
writeFileSync(dirtyBOut, dirtyBText)

/**
 * 脏副本 C：把两处 `Number.isFinite(s.createdAt) ? s.createdAt : 0` 兜底摘掉，
 * 等价于「meta 行缺 `createdAt` 时排序键变 NaN」的状态（NaN 比较器对两个方向都返回 -1，
 * 全序失效）。换不到两处就报失败。
 */
const dirtyCText = bundled.split('Number.isFinite(s.createdAt) ? s.createdAt : 0').join('s.createdAt')
const dirtyCPatched = (bundled.match(/Number\.isFinite\(s\.createdAt\) \? s\.createdAt : 0/g) ?? []).length === 2
check('脏副本 C 构造成功（两处 createdAt 非有限兜底都被摘掉）', dirtyCPatched)
const dirtyCOut = join(tmpdir(), `dsc-sidebar-order-dirty-c-${String(process.pid)}.mjs`)
writeFileSync(dirtyCOut, dirtyCText)

const load = async (file) => (await import(`${pathToFileURL(file).href}?v=${String(Date.now())}`)).buildWorkGroups
const real = await load(bundleOut)
const dirty = await load(dirtyOut)
const dirtyB = await load(dirtyBOut)
const dirtyC = await load(dirtyCOut)

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

// ── [2] 脏副本 A（2026-11-13 报障前的行为）必须红 ────────────────────────────────
const dirtyAfter = frame(dirty, 'C:\\Users\\waq')
check(
  '[2] 脏副本 A 上同一判据必须红（活动组抢到第一位）',
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

// ── [7] 2026-11-17 报障主线：在某个工作区新建会话，组间顺序不变 ────────────────────
// 新建会话的 createdAt / updatedAt 都是「此刻」——旧代码用 updatedAt 倒序排组，于是它顶到第一。
const newInWaq = { id: 'C:/Users/waq/new.jsonl', cwd: 'C:\\Users\\waq', createdAt: now, updatedAt: now, title: '新会话' }
const newInDsc = { id: 'D:/dsc/new.jsonl', cwd: 'D:\\dsc', createdAt: now, updatedAt: now, title: '新会话' }
const withNewInWaq = [...sessions, newInWaq]
const afterNewInWaq = frame(real, 'D:\\dsc', { sessions: withNewInWaq })
check(
  '[7] 在排序靠后的工作区新建会话，组顺序不变',
  same(afterNewInWaq, before),
  `新建前 ${JSON.stringify(before)}，新建后 ${JSON.stringify(afterNewInWaq)}`,
)
check(
  '[7] 在排第一的工作区新建会话，顺序也不变',
  same(frame(real, 'D:\\dsc', { sessions: [...sessions, newInDsc] }), before),
)
const dirtyBAfterNew = frame(dirtyB, 'D:\\dsc', { sessions: withNewInWaq })
check(
  '[7] 脏副本 B 上同一判据必须红（新建的会话把整组顶到第一）',
  dirtyBPatched && !same(dirtyBAfterNew, before) && dirtyBAfterNew[0] === 'C:\\Users\\waq',
  JSON.stringify(dirtyBAfterNew),
)

// ── [8] order 非空、且存在表外组时，表外组也不随会话活动位移 ────────────────────────
// 只在 order 里排了 dsc，waq 与 proj 都是「表外组」；旧代码在两边都 -1 时掉回 updatedAt 比较。
const outOfTable = [
  ...sessions,
  { id: 'E:/proj/p.jsonl', cwd: 'E:\\proj', createdAt: now - 900_000, updatedAt: now - 900_000, title: '老活' },
]
const orderOnlyDsc = ['D:\\dsc']
const outBase = frame(real, 'D:\\dsc', { order: orderOnlyDsc, sessions: outOfTable })
check(
  '[8] 表外组排在表内之后，表外之间按首次出现时间',
  same(outBase, ['D:\\dsc', 'C:\\Users\\waq', 'E:\\proj']),
  JSON.stringify(outBase),
)
const withNewInProj = [
  ...outOfTable,
  { id: 'E:/proj/new.jsonl', cwd: 'E:\\proj', createdAt: now, updatedAt: now, title: '新会话' },
]
const outAfterActivity = frame(real, 'D:\\dsc', { order: orderOnlyDsc, sessions: withNewInProj })
check('[8] 表外组里新建会话，表外组之间位置不变', same(outAfterActivity, outBase), JSON.stringify(outAfterActivity))
const dirtyBOutOfTable = frame(dirtyB, 'D:\\dsc', { order: orderOnlyDsc, sessions: withNewInProj })
check(
  '[8] 脏副本 B 上表外判据必须红（proj 被顶到表外第一）',
  dirtyBPatched && !same(dirtyBOutOfTable, outBase) && dirtyBOutOfTable[1] === 'E:\\proj',
  JSON.stringify(dirtyBOutOfTable),
)

// ── [9] 没有会话的空组（recentCwds）：createdAt 视为 -Infinity，排最后 ──────────────
const withEmpty = frame(real, 'D:\\dsc', { recentCwds: ['D:\\new-dir'] })
check(
  '[9] 空组排在最后',
  same(withEmpty, ['D:\\dsc', 'C:\\Users\\waq', 'D:\\new-dir']),
  JSON.stringify(withEmpty),
)
check(
  '[9] 别的组新建会话，空组仍在最后',
  same(frame(real, 'D:\\dsc', { recentCwds: ['D:\\new-dir'], sessions: withNewInWaq }), withEmpty),
)

// ── [10] 首次出现时间相同时按 cwd 字符串兜底：全序，不随输入序换位 ─────────────────
const tie = [
  ...sessions,
  { id: 'E:/alpha/a.jsonl', cwd: 'E:\\alpha', createdAt: now - 500_000, updatedAt: now - 500_000, title: 'α' },
  { id: 'E:/beta/b.jsonl', cwd: 'E:\\beta', createdAt: now - 500_000, updatedAt: now - 500_000, title: 'β' },
]
const tieOrder = frame(real, 'D:\\dsc', { sessions: tie })
check(
  '[10] 同键组按 cwd 字符串定序',
  same(tieOrder, ['D:\\dsc', 'C:\\Users\\waq', 'E:\\alpha', 'E:\\beta']),
  JSON.stringify(tieOrder),
)
check('[10] 同键组不随输入序换位（比较器是全序）', same(frame(real, 'D:\\dsc', { sessions: [...tie].reverse() }), tieOrder))

// ── [11] 源码判据：manual 档两处兜底都走 byFirstSeen，没有 updatedAt 比较残留 ──────
check('[11] manual 档两处兜底都走 byFirstSeen', (source.match(/return byFirstSeen\(a, b\)/g) ?? []).length === 2)
/**
 * 判据不依赖缩进：每行先压掉全部空白再比。原写法带着 8 个空格去 `includes`，
 * 别人把旧兜底换成 4 空格 / 制表符缩进写回来，它就漏了——等于没判。
 * （`split('\n')` 留下行尾 `\r` 也会被 `\s+` 一并抹掉，CRLF 检出同样认。）
 */
const OLD_FALLBACK = 'return lastUsed(b[1]) - lastUsed(a[1])'
const hasOldManualFallback = (text) =>
  text.split('\n').some((line) => line.replace(/\s+/g, '') === OLD_FALLBACK.replace(/\s+/g, ''))
/** 把源码里两处 `return byFirstSeen(a, b)` 换成给定缩进的旧兜底，模拟「改回去」。 */
const withOldFallback = (indent) =>
  source
    .split('\n')
    .map((line) => (line.trim() === 'return byFirstSeen(a, b)' ? `${indent}${OLD_FALLBACK}` : line))
    .join('\n')
check('[11] 现有源码里没有旧兜底', !hasOldManualFallback(source))
check(
  '[11] 判据对 8/4/2 空格与制表符缩进的旧兜底都必须红（不靠缩进抓）',
  ['        ', '    ', '  ', '\t', ' '].every((indent) => hasOldManualFallback(withOldFallback(indent))),
)
check(
  '[11] 不误伤时间档那一行（lastUsed 仍服务 recent 档）',
  !hasOldManualFallback(
    'return sort === "created" ? lastCreated(b[1]) - lastCreated(a[1]) : lastUsed(b[1]) - lastUsed(a[1])',
  ),
)
/**
 * 一次性对照：把修复前的源码（`git show HEAD:` 的文本）喂进同一个判据，必须判红。
 * 修复合入后 HEAD 就是新代码，这里自动跳过——它证明的是「判据真能抓到旧文件」，
 * 不是常驻判据；常驻的是上面那组换缩进的模拟。
 */
function headSource() {
  try {
    return execFileSync('git', ['show', 'HEAD:src/packages/ui-sessions/ui/grouping.ts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    return null
  }
}
const headText = headSource()
if (headText === null) console.log('  skip [11] git 读不到 HEAD 文本，跳过修复前源码对照')
else if (headText.includes('byFirstSeen')) console.log('  skip [11] HEAD 已含修复，跳过修复前源码对照')
else check('[11] 对修复前的源码（HEAD）必须判红', hasOldManualFallback(headText))

// ── [12] createdAt 非有限（meta 行缺字段）：排序键不能变 NaN，顺序不能随输入序漂 ──
// `core/session.ts:1552` 原样透传 `record.createdAt`；`Math.min(Infinity, undefined)` 是 NaN。
const broken = { id: 'E:/broken/x.jsonl', cwd: 'E:\\broken', createdAt: undefined, updatedAt: now - 700_000, title: '坏 meta' }
const nanForward = frame(real, 'D:\\dsc', { sessions: [...sessions, broken] })
const nanReverse = frame(real, 'D:\\dsc', { sessions: [broken, ...[...sessions].reverse()] })
check(
  '[12] createdAt 缺失的组：正序/逆序输入给同一个组顺序',
  same(nanForward, nanReverse),
  `正序 ${JSON.stringify(nanForward)}，逆序 ${JSON.stringify(nanReverse)}`,
)
check(
  '[12] 时间未知的组按 0 计，排在有时间的组之后',
  same(nanForward, ['D:\\dsc', 'C:\\Users\\waq', 'E:\\broken']),
  JSON.stringify(nanForward),
)
const dirtyCNanForward = frame(dirtyC, 'D:\\dsc', { sessions: [...sessions, broken] })
const dirtyCNanReverse = frame(dirtyC, 'D:\\dsc', { sessions: [broken, ...[...sessions].reverse()] })
check(
  '[12] 脏副本 C 上同一判据必须红（NaN 键让顺序随输入序漂）',
  dirtyCPatched && !same(dirtyCNanForward, dirtyCNanReverse),
  `正序 ${JSON.stringify(dirtyCNanForward)}，逆序 ${JSON.stringify(dirtyCNanReverse)}`,
)

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
process.exit(failures === 0 ? 0 : 1)
