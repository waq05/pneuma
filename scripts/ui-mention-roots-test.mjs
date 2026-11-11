/**
 * 桌面壳 @ 补全的多工作区根自检（T50 第④项）。
 *
 * 钉五件事：
 *   1. 第二根（配置里的额外根）的文件以**绝对路径**出现在候选里；
 *   2. 主根（会话 cwd）仍是相对路径，与旧行为逐字一致；
 *   3. 预算共享：第一个根几千条时第二根仍拿得到 `MIN_FILES_PER_ROOT` 条；
 *   4. `fs-roots` 抛错（旧宿主没有这个 op）时退回单根、不抛异常、`fs-list` 不传 root；
 *   5. 缓存键带根集合：60 秒内根一变就重扫（旧根的候选不会留着）。
 *
 * 用假通道直接驱动 `ui-composer/ui/mention.ts` 里导出的 `listWorkspaceFiles`（界面只
 * 通过 useMention 用它）。这是纯列表逻辑，不需要真渲染；本仓没有 mention 面板的渲染
 * 测试脚本，所以没做真渲染断言。
 *
 * 为什么直读 `.ts`：Node 24 的类型擦除能直接 import 零 JSX 的 `.ts`（与
 * `scripts/ui-git-branch-test.mjs` 同一套写法），不必先构建界面壳。
 *
 * 跑法：node scripts/ui-mention-roots-test.mjs
 *
 * @module dsc/scripts/ui-mention-roots-test
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  listWorkspaceFiles,
  MAX_FILES,
  MIN_FILES_PER_ROOT,
} from '../src/packages/ui-composer/ui/mention.ts'

let passed = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra === '' ? '' : `（${extra}）`}`)
    process.exitCode = 1
  }
}

/** 正斜杠 + 去尾部分隔符：与 mention.ts 的候选路径拼法对齐。 */
const posix = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '')

/** 单根兜底时 `fs-list` 不带 root，假通道用这个哨兵归账。 */
const MAIN_SENTINEL = '\u0000main'

/**
 * 假 dock 通道。
 *
 * @param {object} options
 * @param {Array<{ path: string, name: string, main: boolean }>} options.roots `fs-roots` 回包
 * @param {Record<string, Array<{ name: string, dir: boolean }>>} options.listing `根|dir` → 条目表
 * @param {boolean} [options.failRoots] 让 `fs-roots` 直接拒绝（模拟旧宿主）
 */
function makeChannel({ roots, listing, failRoots = false }) {
  const calls = []
  return {
    calls,
    async invoke(method, args = []) {
      calls.push({ method, args })
      if (method !== 'dock') throw new Error(`未预期的通道：${method}`)
      const [op, payload = {}] = args
      if (op === 'fs-roots') {
        if (failRoots) throw new Error('dock 未知操作：fs-roots')
        return { cwd: roots[0].path, roots }
      }
      if (op === 'fs-list') {
        const root = payload.root ?? MAIN_SENTINEL
        const key = `${root}|${payload.dir}`
        if (!(key in listing)) throw new Error(`ENOENT ${key}`)
        return { entries: listing[key] }
      }
      throw new Error(`未预期的 op：${op}`)
    },
  }
}

// ── 1) 两个根：第二根绝对路径、主根相对路径、别名/root 传参 ────────────────────
console.log('[1] 多根候选的路径形态')
{
  const main = resolve('fake-main')
  const extra = resolve('fake-extra')
  const roots = [
    { path: main, name: 'fake-main', main: true },
    { path: extra, name: 'fake-extra', main: false },
  ]
  const channel = makeChannel({
    roots,
    listing: {
      [`${main}|.`]: [
        { name: 'src', dir: true },
        { name: 'README.md', dir: false },
      ],
      [`${main}|src`]: [{ name: 'a.ts', dir: false }],
      [`${extra}|.`]: [{ name: 'b.txt', dir: false }],
    },
  })
  const files = await listWorkspaceFiles(channel)
  const extraFile = `${posix(extra)}/b.txt`

  check('第二根的文件出现在候选里', files.includes(extraFile), files.join(' / '))
  check('第二根候选是绝对路径（从根开始）', extraFile.startsWith(`${posix(extra)}/`), extraFile)
  check('主根候选仍是相对路径', files.includes('src/a.ts') && files.includes('README.md'), files.join(' / '))
  check(
    '主根候选不带主根绝对路径',
    files.filter((file) => file !== extraFile).every((file) => !file.includes(posix(main))),
    files.join(' / '),
  )
  check(
    'fs-list 按根传参：第二根带 root',
    channel.calls.some(
      (call) => call.args[0] === 'fs-list' && call.args[1]?.root === extra && call.args[1]?.dir === '.',
    ),
  )
  check(
    'fs-list 按根传参：主根也带自己的 root（不落到进程 cwd）',
    channel.calls.some(
      (call) => call.args[0] === 'fs-list' && call.args[1]?.root === main && call.args[1]?.dir === '.',
    ),
  )
  check('fs-roots 先问过宿主', channel.calls.some((call) => call.args[0] === 'fs-roots'))
}

// ── 2) 预算共享：第一个根几千条，第二个根仍有最小份额 ─────────────────────────
console.log('[2] 多根共享预算 + 每根最小份额')
{
  const main = resolve('flood-main')
  const extra = resolve('flood-extra')
  const flood = Array.from({ length: 5000 }, (_, index) => ({ name: `m${index}.ts`, dir: false }))
  const plenty = Array.from({ length: 300 }, (_, index) => ({ name: `x${index}.ts`, dir: false }))
  const roots = [
    { path: main, name: 'flood-main', main: true },
    { path: extra, name: 'flood-extra', main: false },
  ]
  const channel = makeChannel({
    roots,
    listing: { [`${main}|.`]: flood, [`${extra}|.`]: plenty },
  })
  const files = await listWorkspaceFiles(channel)
  const extraPrefix = `${posix(extra)}/`
  const mainCount = files.filter((file) => !file.startsWith(extraPrefix)).length
  const extraCount = files.filter((file) => file.startsWith(extraPrefix)).length

  check('总条数不超过 MAX_FILES', files.length <= MAX_FILES, `${files.length} > ${MAX_FILES}`)
  check(
    `第二个根至少拿到 ${MIN_FILES_PER_ROOT} 条最小份额`,
    extraCount >= MIN_FILES_PER_ROOT,
    `extra=${extraCount}`,
  )
  check(
    '第一个根没有把预算全部吃光',
    mainCount <= MAX_FILES - MIN_FILES_PER_ROOT,
    `main=${mainCount} total=${files.length}`,
  )
  check('预算用满（两个根都还有货）', files.length === MAX_FILES, `length=${files.length}`)
}

// ── 3) fs-roots 失败：退回单根，不抛异常 ───────────────────────────────────────
console.log('[3] 旧宿主没有 fs-roots：退回单根')
{
  const main = resolve('legacy-main')
  const channel = makeChannel({
    roots: [],
    failRoots: true,
    listing: {
      [`${MAIN_SENTINEL}|.`]: [
        { name: 'keep.txt', dir: false },
        { name: 'src', dir: true },
      ],
      [`${MAIN_SENTINEL}|src`]: [{ name: 'legacy.ts', dir: false }],
    },
  })
  let files = null
  let error = null
  try {
    files = await listWorkspaceFiles(channel)
  } catch (caught) {
    error = caught
  }
  check('fs-roots 抛错时 listWorkspaceFiles 不抛', error === null, error instanceof Error ? error.message : String(error))
  check(
    '退回单根后候选仍是相对路径',
    Array.isArray(files) && files.includes('keep.txt') && files.includes('src/legacy.ts'),
    Array.isArray(files) ? files.join(' / ') : String(files),
  )
  const listCall = channel.calls.find((call) => call.args[0] === 'fs-list')
  check('单根兜底的 fs-list 不传 root（旧宿主也认识）', listCall !== undefined && !('root' in listCall.args[1]), JSON.stringify(listCall?.args))
  check('主根不再出现在候选里', Array.isArray(files) && files.every((file) => !file.includes(posix(main))), Array.isArray(files) ? files.join(' / ') : String(files))
}

// ── 4) 缓存键带根集合：60 秒内换根就重扫 ──────────────────────────────────────
console.log('[4] 根集合变了就重扫（缓存键）')
{
  const main = resolve('switch-main')
  const firstExtra = resolve('switch-b')
  const secondExtra = resolve('switch-c')
  const first = makeChannel({
    roots: [
      { path: main, name: 'switch-main', main: true },
      { path: firstExtra, name: 'switch-b', main: false },
    ],
    listing: {
      [`${main}|.`]: [{ name: 'main.txt', dir: false }],
      [`${firstExtra}|.`]: [{ name: 'b.txt', dir: false }],
    },
  })
  const before = await listWorkspaceFiles(first)
  const second = makeChannel({
    roots: [
      { path: main, name: 'switch-main', main: true },
      { path: secondExtra, name: 'switch-c', main: false },
    ],
    listing: {
      [`${main}|.`]: [{ name: 'main.txt', dir: false }],
      [`${secondExtra}|.`]: [{ name: 'c.txt', dir: false }],
    },
  })
  const after = await listWorkspaceFiles(second)

  check('换根前有旧根的候选', before.includes(`${posix(firstExtra)}/b.txt`), before.join(' / '))
  check('换根后新根的候选出现', after.includes(`${posix(secondExtra)}/c.txt`), after.join(' / '))
  check('换根后旧根的候选不再留着', !after.includes(`${posix(firstExtra)}/b.txt`), after.join(' / '))
  check('换根后确实重扫了（第二条通道收到 fs-list）', second.calls.some((call) => call.args[0] === 'fs-list'))
}

assert.ok(passed > 0)
console.log(`通过 ${passed} 项`)
process.exit(process.exitCode ?? 0)
