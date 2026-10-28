/**
 * 权限三项「按会话隔离」的确定性探针（2026-10-28）。
 *
 * 用户报障：在 A 会话切「只读」，B 会话与后台 agent 一起变。根因是三项权限
 * 存在进程级变量里。现在值存在会话日志的 `permissions` 状态条目，读时缺项才补
 * 默认值并钉住（口径照 dsh 的 permission-presets）。
 *
 * 五段：
 *   [1] 纯逻辑：缺项读默认值、只写一次、三项互不覆盖
 *   [2] 两会话隔离：A 设只读不影响 B
 *   [3] 钉住语义：老会话钉住后改默认值不漂
 *   [4] 接线形态：三个插件都按会话取值，没人再写回偏好/全局配置
 *   [5] 用量数字进位：1,238,946 → 1.2M
 *
 * 运行：node scripts/session-permissions-test.mjs
 *
 * @module dsc/scripts/session-permissions-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const scope = await import(new URL('../src/core/permission-scope.ts', import.meta.url).href)
const { storedPermissions, writePermissions, permissionOf, resolvePermissions, samePermissionKnobs } = scope
const tokens = await import(new URL('../ui-shell/src/ui-primitives/tokens.ts', import.meta.url).href)
const { formatTokens } = tokens

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(root + rel, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failures += 1
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + detail))
  }
}

/** 假会话：只实现 state/appendState，记录写了几次。 */
const makeSession = () => {
  const states = new Map()
  const writes = []
  const session = {
    state(id) {
      return states.get(id)
    },
    appendState(id, payload) {
      states.set(id, payload)
      writes.push({ id, payload })
    },
    writes,
  }
  return session
}

console.log('[1] 纯逻辑：缺项读默认值，只钉一次')
{
  const a = makeSession()
  check('初始没有任何权限状态', JSON.stringify(storedPermissions(a)) === JSON.stringify({ sandbox: null, policy: null, reviewer: null }))
  check('缺项时用默认值', permissionOf(a, 'policy', 'auto-edit') === 'auto-edit')
  check('第一次读会钉住（写一条）', a.writes.length === 1, String(a.writes.length))
  check('再读不再写', permissionOf(a, 'policy', 'readonly') === 'auto-edit' && a.writes.length === 1, String(a.writes.length))
  check('三项各自钉、互不覆盖', permissionOf(a, 'sandbox', 'workspace-write') === 'workspace-write' && storedPermissions(a).policy === 'auto-edit')
  check('writePermissions 合并而不是整份替换', writePermissions(a, { reviewer: 'user' }) && storedPermissions(a).sandbox === 'workspace-write')
  check('写同样的值不再产生新条目', writePermissions(a, { reviewer: 'user' }) === false)
  const b = makeSession()
  const all = resolvePermissions(b, { sandbox: 'read-only', policy: 'readonly', reviewer: 'auto-review' })
  check('resolvePermissions 一次补齐三项', all.sandbox === 'read-only' && all.policy === 'readonly' && all.reviewer === 'auto-review')
  check('samePermissionKnobs 比三项', samePermissionKnobs(all, { ...all }) && !samePermissionKnobs(all, { ...all, policy: 'auto-edit' }))
}

console.log('[2] 两会话隔离：A 设只读，B 不动')
{
  const a = makeSession()
  const b = makeSession()
  permissionOf(a, 'sandbox', 'workspace-write')
  permissionOf(b, 'sandbox', 'workspace-write')
  writePermissions(a, { sandbox: 'read-only' })
  check('A 是自己的只读', permissionOf(a, 'sandbox', 'workspace-write') === 'read-only')
  check('B 仍是工作区可写', permissionOf(b, 'sandbox', 'workspace-write') === 'workspace-write')
  writePermissions(b, { policy: 'full-access' })
  check('B 改权限模式不影响 A 的沙箱', permissionOf(a, 'sandbox', 'workspace-write') === 'read-only' && permissionOf(a, 'policy', 'auto-edit') === 'auto-edit')
}

console.log('[3] 钉住语义：老会话不跟着默认值漂')
{
  const old = makeSession()
  permissionOf(old, 'policy', 'auto-edit')
  // 用户在设置里把默认值改成 readonly：这个会话已经钉过，应该还是 auto-edit
  check('改默认值后老会话保持原值', permissionOf(old, 'policy', 'readonly') === 'auto-edit')
  const fresh = makeSession()
  check('新会话拿新默认值', permissionOf(fresh, 'policy', 'readonly') === 'readonly')
}

console.log('[4] 接线形态：按会话取值，不写回偏好/全局配置')
{
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const approval = strip(read('src/plugins/approval.ts'))
  check('approval 不再有模块级 let policy', !/let policy: ApprovalPolicy/.test(approval))
  check('approval 按请求会话解析 policy', approval.includes("permissionOf(session, 'policy', defaultPolicy())"))
  check('approval 的 setPolicy 写会话状态', approval.includes('writePermissions(ctx.session.current(), { policy: next })'))
  const sandbox = strip(read('src/plugins/sandbox.ts'))
  check('sandbox 的 setMode 写会话状态', sandbox.includes('writePermissions(ctx.session.current(), { sandbox: next })'))
  check('sandbox 另有 setDefaultMode 写 plugins.json', sandbox.includes('setDefaultMode(next: SandboxMode)') && sandbox.includes("writePluginConfig(SANDBOX_CONFIG_KEY, { mode: next })"))
  check('沙箱守卫用本次调用的会话取档位', sandbox.includes('modeOf(sessionOf(input.sessionId, input.sessionPath))'))
  const presets = strip(read('src/plugins/permission-presets.ts'))
  // apply 那条路一次 setPrefs 都没有；只有 setDefault（清空 / 设默认两处）写偏好。
  const applyBody = presets.slice(presets.indexOf('const apply ='), presets.indexOf('const service: PermissionPresetService'))
  check('预设 apply 不再写偏好', !applyBody.includes('setPrefs('))
  check('只有 setDefault 写偏好（两处）', (presets.match(/setPrefs\(/g) ?? []).length === 2)
  check('预设 setDefault 三根一起落默认', presets.includes('defaultPermissionPreset: next') && presets.includes('defaultPolicy: preset.policy') && presets.includes('defaultReviewer: preset.reviewer'))
  const settings = strip(read('src/plugins/settings.ts'))
  check('设置页权限两行只改当前会话（保存里没有 savePrefs）', !/key === 'policy'[\s\S]{0,400}savePrefs/.test(settings))
  const subagent = strip(read('src/plugins/subagent.ts'))
  check('队友审批带上父会话归属', subagent.includes('sessionId: teammate.parentSession.meta.id'))
}

console.log('[5] 用量数字自动进位')
{
  check('1,238,946 → 1.2M', formatTokens(1238946) === '1.2M', formatTokens(1238946))
  check('335,048 → 335K', formatTokens(335048) === '335K', formatTokens(335048))
  check('29,530 → 29.5K', formatTokens(29530) === '29.5K', formatTokens(29530))
  check('999 → 999', formatTokens(999) === '999', formatTokens(999))
  const bar = read('ui-shell/src/plugins/statusbar/ui.tsx')
  check('状态栏卡片用 K/M 缩写（不再有 formatExactTokens 直接当卡面）', bar.includes('value={formatTokens(cacheHit)}') && bar.includes('value={formatTokens(output)}'))
  check('精确值仍留在 title 里', bar.includes('title={`${formatExactTokens(props.total)} tok`}'))
}

console.log('')
console.log('通过 ' + String(passed) + '/' + String(passed + failures))
process.exit(failures === 0 ? 0 : 1)
