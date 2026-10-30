/**
 * 生命周期钩子的失败方向自检：**钩子没跑成不拦路**，只有明确的退出码 2 才挡工具。
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
 *   [5] JSON 结论照旧生效（放行 / 拦下 / 要人确认）——失败方向的改动不动它们。
 *
 * 纯函数，不用临时 HOME、不起内核。用法：pnpm build && node scripts/lifecycle-hook-default-test.mjs
 *
 * @module dsc/scripts/lifecycle-hook-default-test
 */

const { LIFECYCLE_DEFAULTS, judgeBlockedByAllowlist, judgeLifecycleRun, resolveLifecycleConfig } = await import(
  '../lib/core/lifecycle-hooks.js'
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

console.log('生命周期钩子失败方向测试')

// ── [1] 缺省值与显式开关 ──────────────────────────────────────────────────────
{
  const cfg = resolveLifecycleConfig({})
  check('LIFECYCLE_DEFAULTS.failClosed 是 false', LIFECYCLE_DEFAULTS.failClosed === false, String(LIFECYCLE_DEFAULTS.failClosed))
  check('什么都不配时 failClosed=false（与 codex 一致）', cfg.failClosed === false, String(cfg.failClosed))
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

console.log(`生命周期钩子失败方向电池：${passes} PASS / ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
