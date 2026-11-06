/**
 * 外部命令钩子（codex 事件名）的失败方向与配置读迁移自检：
 * **钩子没跑成不拦路**，只有明确的退出码 2 才挡工具。
 *
 * 为什么单开一条（2026-10-30 用户拍板）：以前默认 `failClosed: true`，脚本有个小毛病
 * （路径写错、超时、非 0 退出）就把**所有**工具调用一起掐死，而 codex 的语义是
 * 「非 2 的退出码记成 Failed，`should_block` 仍为 false」
 * （`codex-rs/hooks/src/engine/mod.rs` 的 pre_tool_use 用例）。
 * 这一节把这些事实钉住：
 *   [1] 缺省配置是「不拦」，显式 true 才拦；
 *   [2] 超时、起不来、退出码非 0、输出看不懂：默认只留一条提示，形态是 `pass` + problem；
 *   [3] 退出码 2（带 stderr 或不带）在任何配置下都拦，理由是 stderr 原文；
 *   [4] 钩子自己写的 `failClosed` 覆盖全局开关（codex 没有这一层，是 dsc 自己的扩展）；
 *   [5] JSON 结论照旧生效（放行 / 拦下 / 要人确认）——失败方向的改动不动它们；
 *   [6] 配置读迁移（0.9.0 合并进 `@pneuma/hooks`）：`hooks` 条目缺的项沿用旧条目
 *       `lifecycle-hooks` 的同名项、旧条目被停用过就按关处理，全程只读、幂等、不删旧条目。
 *
 * 引擎在合并后住 `lib/packages/hooks/lifecycle-hooks.js`（原 `lib/core/lifecycle-hooks.js`）。
 * 纯函数，起临时 HOME（不碰真实 `~/.dsc`）、不起内核。
 * 用法：pnpm build && node scripts/lifecycle-hook-default-test.mjs
 *
 * @module dsc/scripts/lifecycle-hook-default-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 临时 HOME：`dscPath` 在模块导入时读它，`plugins.json` 也就落在临时目录里。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-lifecycle-hooks-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
const pluginsJson = join(process.env.DSC_HOME, 'plugins.json')

const { LIFECYCLE_DEFAULTS, judgeBlockedByAllowlist, judgeLifecycleRun, resolveLifecycleConfig } = await import(
  '../lib/packages/hooks/lifecycle-hooks.js'
)

let failures = 0
let passes = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passes += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 写一份条目树（`null` = 干脆没有这个文件）。 */
const writeEntries = (entries) => {
  if (entries === null) {
    writeFileSync(pluginsJson, '', 'utf8')
    return
  }
  writeFileSync(pluginsJson, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

/** 一条 PreToolUse 钩子（`failClosed` 不写 = 跟全局开关走）。 */
const hook = (patch = {}) => ({
  id: 'PreToolUse#1.1',
  enabled: true,
  event: 'PreToolUse',
  matcher: '*',
  command: 'node guard.js',
  timeoutMs: 5000,
  failClosed: undefined,
  ...patch,
})

/** 一次执行结果（缺省 = 干净退出、什么都没说）。 */
const run = (patch = {}) => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  ms: 12,
  timedOut: false,
  spawnError: '',
  truncated: false,
  ...patch,
})

writeEntries(null)
console.log('外部命令钩子失败方向测试')

// ── [1] 缺省值与显式开关 ──────────────────────────────────────────────────────
{
  const cfg = resolveLifecycleConfig({})
  check('LIFECYCLE_DEFAULTS.failClosed 是 false', LIFECYCLE_DEFAULTS.failClosed === false, String(LIFECYCLE_DEFAULTS.failClosed))
  check('什么都不配时 failClosed=false（与 codex 一致）', cfg.failClosed === false, String(cfg.failClosed))
  check('什么都不配时默认开着（没有钩子可跑 = 空转）', cfg.enabled === true, String(cfg.enabled))
  check('显式写 true 才打开', resolveLifecycleConfig({ failClosed: true }).failClosed === true)
  check('字符串 "true" 也认（手改 plugins.json 会写成串）', resolveLifecycleConfig({ failClosed: 'true' }).failClosed === true)
  check('字符串 "false" 不会误开', resolveLifecycleConfig({ failClosed: 'false' }).failClosed === false)
}

// ── [2] 默认档：没跑成 = 只留提示 ────────────────────────────────────────────
{
  const cfg = resolveLifecycleConfig({})
  const cases = [
    ['超时被杀', run({ exitCode: -1, timedOut: true, ms: 5000 })],
    ['命令起不来', run({ exitCode: -1, spawnError: 'spawn cmd.exe ENOENT' })],
    ['非 0 退出且没给结论', run({ exitCode: 3, stderr: 'SyntaxError: boom' })],
    ['干净退出但输出看不懂', run({ exitCode: 0, stdout: 'not json' })],
    ['删除脚本后的 ENOENT', run({ exitCode: 1, stderr: "Cannot find module 'D:\\x\\guard.js'" })],
  ]
  for (const [label, result] of cases) {
    const judgement = judgeLifecycleRun(result, hook(), cfg)
    check(`默认档：${label} → 不拦（pass + problem）`, judgement.action === 'pass' && judgement.problem !== '', `action=${judgement.action} problem=${judgement.problem}`)
  }
}

// ── [3] 退出码 2：任何配置下都拦 ─────────────────────────────────────────────
{
  const loose = resolveLifecycleConfig({})
  const strict = resolveLifecycleConfig({ failClosed: true })
  const withStderr = judgeLifecycleRun(run({ exitCode: 2, stderr: '不许动生产库' }), hook(), loose)
  check('默认档：退出码 2 + stderr 照样拦', withStderr.action === 'block' && withStderr.message.includes('不许动生产库'), JSON.stringify(withStderr))
  const noReason = judgeLifecycleRun(run({ exitCode: 2 }), hook(), loose)
  check('退出码 2 没写原因也拦，理由说清「没给原因」', noReason.action === 'block' && noReason.message.includes('没给原因'), noReason.message)
  check('打开 failClosed 后退出码 2 一样拦', judgeLifecycleRun(run({ exitCode: 2, stderr: 'x' }), hook(), strict).action === 'block')
  const json = judgeLifecycleRun(run({ exitCode: 2, stdout: '{"action":"deny","message":"JSON 里的原因"}' }), hook(), loose)
  check('退出码 2 且 stdout 有结论时用 JSON 的理由', json.action === 'block' && json.message === 'JSON 里的原因', json.message)
}

// ── [4] 单条钩子覆盖全局 ─────────────────────────────────────────────────────
{
  const loose = resolveLifecycleConfig({})
  const mine = judgeLifecycleRun(run({ exitCode: 1 }), hook({ failClosed: true }), loose)
  check('单条写 failClosed: true 时它自己按拦处理（全局关着也拦）', mine.action === 'block', mine.action)
  const strict = resolveLifecycleConfig({ failClosed: true })
  const theirs = judgeLifecycleRun(run({ exitCode: 1 }), hook({ failClosed: false }), strict)
  check('单条写 failClosed: false 时全局开着它也不拦', theirs.action === 'pass', theirs.action)
  check('白名单挡下：默认只提示（action=pass，problem 说清原因）', judgeBlockedByAllowlist(hook(), loose).action === 'pass' && judgeBlockedByAllowlist(hook(), loose).problem.includes('白名单'))
  check('白名单挡下：全局开了才拦', judgeBlockedByAllowlist(hook(), strict).action === 'block')
}

// ── [5] JSON 结论不受失败方向影响 ────────────────────────────────────────────
{
  const cfg = resolveLifecycleConfig({})
  const deny = judgeLifecycleRun(run({ exitCode: 0, stdout: '{"action":"deny","message":"规则说不行"}' }), hook(), cfg)
  check('干净退出的 deny 结论照旧拦', deny.action === 'block' && deny.message === '规则说不行', JSON.stringify(deny))
  const ask = judgeLifecycleRun(run({ exitCode: 0, stdout: '{"action":"ask","message":"问一下"}' }), hook(), cfg)
  check('ask 结论照旧交给上层（由守卫按「先拒、让模型问人」处理）', ask.action === 'ask', ask.action)
  const pass = judgeLifecycleRun(run({ exitCode: 0, stdout: '{"action":"pass"}' }), hook(), cfg)
  check('pass 结论照旧放行', pass.action === 'pass' && pass.problem === '', `${pass.action} ${pass.problem}`)
  const exit2ok = judgeLifecycleRun(run({ exitCode: 2, stdout: '{"action":"block","message":"脚本自己要拦"}' }), hook(), cfg)
  check('退出码 2 与 JSON 都拦时理由取 JSON', exit2ok.message === '脚本自己要拦', exit2ok.message)
}

// ── [6] 配置读迁移：`hooks` 缺的项沿用旧 `lifecycle-hooks` 条目 ───────────────
console.log('\n── 合并后的配置读迁移（只读回落，不写不删） ──')
{
  /** 旧条目：用户在 lifecycle-hooks 设置里改过四项、没动开关。 */
  const legacyOnly = [
    {
      file: 'lifecycle-hooks',
      disabled: false,
      config: { failClosed: true, timeoutMs: 7000, configPath: 'C:\\me\\lc.json', commandAllowlist: 'node' },
    },
  ]
  writeEntries(legacyOnly)
  const before = readFileSync(pluginsJson, 'utf8')
  const migrated = resolveLifecycleConfig({})
  check('旧条目的 failClosed 沿用了', migrated.failClosed === true, String(migrated.failClosed))
  check('旧条目的 timeoutMs 沿用了', migrated.timeoutMs === 7000, String(migrated.timeoutMs))
  check('旧条目的 configPath 沿用了', migrated.configPath.endsWith('lc.json'), migrated.configPath)
  check('旧条目的 commandAllowlist 沿用了', migrated.commandAllowlist === 'node', migrated.commandAllowlist)
  check('旧条目没写 enabled、又没被停用过 → 仍默认开', migrated.enabled === true, String(migrated.enabled))
  check('读一次不写盘：plugins.json 逐字节没变', readFileSync(pluginsJson, 'utf8') === before)
  const again = resolveLifecycleConfig({})
  check('再读一次结果一样（幂等）', JSON.stringify(again) === JSON.stringify(migrated), JSON.stringify(again))
  check('读两次之后旧条目还在（不删）', JSON.parse(readFileSync(pluginsJson, 'utf8')).entries.some((entry) => entry.file === 'lifecycle-hooks'))
}
{
  // 旧条目在插件中心被关过（disabled: true）：合并后这条 codex 事件链常驻，不能因此悄悄开起来。
  // 停用标记排在旧配置的 enabled 前面——配置里还留着 true 也一样按关处理。
  writeEntries([{ file: 'lifecycle-hooks', disabled: true, config: {} }])
  const off = resolveLifecycleConfig({})
  check('旧条目被停用过 → 外部命令钩子按关处理', off.enabled === false, String(off.enabled))
  writeEntries([{ file: 'lifecycle-hooks', disabled: true, config: { enabled: true } }])
  check('旧条目被停用过，配置里留着 enabled:true 也按关处理', resolveLifecycleConfig({}).enabled === false)
  writeEntries([{ file: 'lifecycle-hooks', disabled: false, config: { enabled: false } }])
  check('旧条目配置里显式 enabled:false 也认', resolveLifecycleConfig({}).enabled === false)
  writeEntries([{ file: 'lifecycle-hooks', disabled: false, config: { enabled: true } }])
  check('旧条目配置里显式 enabled:true 认', resolveLifecycleConfig({}).enabled === true)
}
{
  // 新条目写过的值一律优先（用户在合并后的设置页改过）
  writeEntries([
    { file: 'hooks', disabled: false, config: { enabled: true, failClosed: false, timeoutMs: 5000, commandAllowlist: '' } },
    { file: 'lifecycle-hooks', disabled: true, config: { failClosed: true, timeoutMs: 9000, commandAllowlist: 'node' } },
  ])
  const merged = resolveLifecycleConfig({})
  check('新条目的 failClosed 压过旧条目', merged.failClosed === false, String(merged.failClosed))
  check('新条目的 timeoutMs 压过旧条目', merged.timeoutMs === 5000, String(merged.timeoutMs))
  check('新条目把白名单清空也算「写过」（空串优先级高于旧值）', merged.commandAllowlist === '', JSON.stringify(merged.commandAllowlist))
  check('新条目的 enabled 压过旧条目的停用标记', merged.enabled === true, String(merged.enabled))
  const saved = readFileSync(pluginsJson, 'utf8')
  check('合并读取之后两份条目都还在（旧条目留给回滚）', saved.includes('"lifecycle-hooks"') && saved.includes('"hooks"'))
}

console.log(`\n外部命令钩子失败方向与读迁移电池：${passes} PASS / ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
