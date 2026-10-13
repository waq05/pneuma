/**
 * 升权（sandbox_permissions / justification / sandbox_scope）与授权范围的端到端自检。
 *
 * 为什么单开这一个：升权是**唯一一条「模型主动申请放宽安全边界」的路**，它的两个目标档
 * 以前在守卫里是死的（都只是 defer），这一次才真正分家。分家之后每条分支都要有断言盯着：
 *   [1] 成对校验：半截请求（只给 justification / 只给 scope）一律 malformed；
 *   [2] 两档分家：danger-full-access 跳过判定（defer）；workspace-write 留沙箱里
 *       **放宽目标后重判**，受保护路径与只读子路径仍然被拒；
 *   [3] 范围：scope 默认 once、认 session；写类 + workspace-write 才给「本会话允许」；
 *   [4] 接线：审批卡答「本会话允许」时把目标并进**该会话**的可写根（文本钉，见下）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/escalation-scope-test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-escalation-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const { readSandboxRequest } = await import('../lib/core/tools/sandbox-args.js')

let failures = 0
function check(label, condition, extra = '') {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const kernel = await createKernel({ config: {}, resumeSessionPath: undefined })
const cwd = kernel.session.current().meta.cwd
const outside = process.platform === 'win32' ? 'D:\\dsc-escalation-probe\\out.txt' : '/tmp/dsc-escalation-probe/out.txt'

/** 直接在守卫链上问一次：给什么参数、拿什么裁决。 */
async function gate(toolName, args, risk = 'write', target) {
  return kernel.guards.gate({
    toolName,
    risk,
    cwd,
    args,
    ...(target === undefined ? {} : { target }),
    signal: new AbortController().signal,
    sessionId: kernel.session.current().meta.id,
    sessionPath: kernel.session.current().filePath,
  })
}

console.log('── 1. 成对校验（纯函数那一层）──')
const pair = readSandboxRequest({ sandbox_permissions: 'workspace-write', justification: '要写到另一个盘' })
check('成对给全 → ok，scope 默认 once', pair.kind === 'ok' && pair.scope === 'once', JSON.stringify(pair))
const scoped = readSandboxRequest({ sandbox_permissions: 'workspace-write', justification: 'x', sandbox_scope: 'session' })
check('scope 写 session → 认', scoped.kind === 'ok' && scoped.scope === 'session', JSON.stringify(scoped))
check('只给 justification → malformed', readSandboxRequest({ justification: '没说要放宽什么' }).kind === 'malformed')
check('只给 scope → malformed', readSandboxRequest({ sandbox_scope: 'session' }).kind === 'malformed')
check('scope 值不合法 → malformed', readSandboxRequest({ sandbox_permissions: 'workspace-write', justification: 'x', sandbox_scope: 'forever' }).kind === 'malformed')
check('三样都不给 → none', readSandboxRequest({}).kind === 'none')

console.log('\n── 2. 两档在守卫上真的分家 ──')
const noRequest = await gate('write', { path: outside, content: 'x' }, 'write', outside)
// 判据是「**哪一层**拒的」：链条最后的结论会是审批层的「用户拒绝」（无头跑没人能点卡），
// 那恰好证明沙箱这一环已经放行。所以看 reason 是不是沙箱的口径，而不是看 deny/defer。
const sandboxRefused = (verdict) => verdict.action === 'deny' && /沙箱拒绝/.test(verdict.reason ?? '')
check('工作区外写、不提放宽 → 沙箱这一层就拒（它是审批卡与升权的入口）', sandboxRefused(noRequest), JSON.stringify(noRequest))
const full = await gate(
  'write',
  { path: outside, content: 'x', sandbox_permissions: 'danger-full-access', justification: '要装到另一个盘' },
  'write',
  outside,
)
check('danger-full-access → 沙箱不再拦（跳过判定，交审批卡）', !sandboxRefused(full), JSON.stringify(full))
const soft = await gate(
  'write',
  { path: outside, content: 'x', sandbox_permissions: 'workspace-write', justification: '要装到另一个盘' },
  'write',
  outside,
)
check('workspace-write → 放宽目标后重判，普通工作区外目标可以过（沙箱不拦）', !sandboxRefused(soft), JSON.stringify(soft))
// 受保护名：即使「留在沙箱内放宽写边界」也不该放它过去
const protectedTarget = join(home, '.dsc', 'credentials.yaml')
const hard = await gate(
  'write',
  { path: protectedTarget, content: 'x', sandbox_permissions: 'workspace-write', justification: '想改凭据' },
  'write',
  protectedTarget,
)
// 受保护路径这一条其实**轮不到沙箱说话**：审批灾难地板排在守卫链 order 5、沙箱在 order 8，
// 地板先拒。这比沙箱自己拒更硬，所以这里只要求「被拒」，并顺带把层数关系钉住。
check('workspace-write 到受保护路径 → 仍然被拒（地板比沙箱更早说话）', hard.action === 'deny', JSON.stringify(hard))
check('拒它的是灾难地板那一层，不是沙箱', /灾难地板/.test(hard.reason ?? ''), JSON.stringify(hard))

// 「放宽了写边界也仍不合法」这一条得绕开地板，直接用纯策略层问：
// 可写根里带了只读子路径时，把根放宽出去也写不进那个子路径。
const { checkWrite, createPolicy } = await import('../lib/core/sandbox/policy.js')
const { sandboxTmpDir } = await import('../lib/core/sandbox/policy.js')
const base = createPolicy({
  mode: 'workspace-write',
  cwd,
  tmpDir: sandboxTmpDir(join(home, '.dsc'), cwd, kernel.session.current().meta.id),
  extraWritableRoots: [],
  readOnlySubpaths: [],
  dscHome: join(home, '.dsc'),
  networkAccess: false,
})
const widened = { ...base, roots: [...base.roots, join(home, 'granted')] }
check('把目标并进可写根后，目标本身可写（这才是「放宽」）', checkWrite(widened, join(home, 'granted', 'a.txt')).allowed)
const guarded = { ...widened, readOnlySubpaths: [join(home, 'granted', 'keep')] }
check('放宽的可写根里，只读子路径照旧不许写（放宽的是写边界，不是安全边界）', !checkWrite(guarded, join(home, 'granted', 'keep', 'a.txt')).allowed)

console.log('\n── 3. 范围与会话放宽的接线 ──')
const approvalSrc = readFileSync(new URL('../src/plugins/approval.ts', import.meta.url), 'utf8')
check('答「本会话允许」时把目标并进该会话的可写根', /grantSession\(current\.sessionPath, \[current\.sandboxSessionRoot\]\)/.test(approvalSrc))
check('只有写类 + workspace-write 才产生可放宽的根', /escalation\.permission === 'workspace-write' && target !== null && PATH_WRITE_TOOLS\.has\(request\.toolName\)/.test(approvalSrc))
check('升权卡不给 always（没有可持久化的前缀规则）', /escalation === null\) \{[\s\S]{0,200}scopes\.push\('always'\)/.test(approvalSrc))
const sandboxSrc = readFileSync(new URL('../src/plugins/sandbox.ts', import.meta.url), 'utf8')
check('沙箱按会话路径记账（一个会话放宽不影响别的会话）', /sessionRoots\.get\(sessionPath\)/.test(sandboxSrc))
check('会话放宽根并进可写根参与判定', /extraWritableRoots: \[\.\.\.config\.extraWritableRoots, \.\.\.granted\]/.test(sandboxSrc))

console.log(`\n升权与范围自检：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
