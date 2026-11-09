/**
 * P0-12 探针：「有动作、没眼睛」这件事必须消失，而且不能靠「整档拒」来消失。
 *
 * 断言的是一条**组合**，不是某个字段：
 *   1. 默认配置（`lookWithoutApproval` 不开）下 `browser_dock_look` **已注册**，风险档是
 *      `read`——只读权限档与计划/探索模式因此都放行到执行；人批这一步由工具自己
 *      **每次显式请求**一次审批（`forceAskReason`，跳过所有自动放行档），用户拒绝就抛错、
 *      不返回任何页面内容；
 *   2. `lookWithoutApproval: true` 时不再请求审批（直接读），与设置项的承诺一致；
 *   3. 两个工具同时在场：`browser_dock` 的说明让模型去调 `browser_dock_look action=snapshot`
 *      拿 ref，那条路必须真的存在；`click / hover / type` 这几个只收 ref 的动作才有来源；
 *   4. 档位闸门：把真实的模式闸（`session-core/modes.ts` 的 plan / explore）与真实的审批守卫
 *      （`core/tool-guards.ts` 的 `toolApprovalGuard`）装进真实的守卫链，验证 read 档在
 *      计划/探索模式里 `pass`、在只读权限档里根本走不到审批的 auto-deny 分支；同时钉住
 *      旧形状（`risk:'exec'` + 没有 command）在计划模式里被整档拒——那正是这次要修的残留。
 *
 * 为什么直读 `src/**` 而不是 `lib/`：这条闸要能拦住**还没构建**的改动（构建前的
 * `pnpm run typecheck` 与探针是一批跑的）。Node 24 能跑 TS，但源码用的是
 * `@pneuma/runtime/*` 这类构建期映射，所以下面挂了一个极小的 resolve/load 钩子：
 * 把包名映射回 `src/`，并用仓库自带的 typescript 现场转译（不依赖 Node 的类型擦除边界）。
 *
 * @module dsc/scripts/dock-browser-look-check
 */
import { existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 插件的 readConfig 会读 ~/.dsc/plugins.json：不隔离就会读到使用者真实那份，
// 「默认关着」这条断言会随环境飘。
const home = mkdtempSync(join(tmpdir(), 'dsc-dock-look-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })

/** `@pneuma/runtime/x` → `src/x`；`@pneuma/<id>/x.js` → `src/packages/<id>/x.ts`。 */
function mapSpecifier(specifier, parentUrl) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const base = new URL(specifier, parentUrl)
    const asTs = base.href.replace(/\.js$/, '.ts')
    if (existsSync(fileURLToPath(asTs))) return asTs
    return null
  }
  if (!specifier.startsWith('@pneuma/')) return null
  const rest = specifier.slice('@pneuma/'.length)
  const relative = rest.startsWith('runtime/') ? `src/${rest.slice('runtime/'.length)}` : `src/packages/${rest}`
  const base = join(root, relative)
  const candidates = /\.js$/.test(base)
    ? [base.replace(/\.js$/, '.ts'), base]
    : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  for (const candidate of candidates) if (existsSync(candidate)) return pathToFileURL(candidate).href
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = mapSpecifier(specifier, context.parentURL ?? pathToFileURL(join(root, 'x.js')).href)
    return mapped === null ? nextResolve(specifier, context) : { url: mapped, shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (!/\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context)
    const file = fileURLToPath(url)
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        verbatimModuleSyntax: false,
      },
    })
    return { format: 'module', source: output.outputText, shortCircuit: true }
  },
})

const { dockBrowserPlugin } = await import(pathToFileURL(join(root, 'src/packages/dock-browser/index.ts')).href)
const contract = await import(pathToFileURL(join(root, 'src/core/dock-browser.ts')).href)
const { HOST_BROWSER_SERVICE } = await import(pathToFileURL(join(root, 'src/core/host-browser-link.ts')).href)
const { ToolGuardRegistry, toolApprovalGuard } = await import(pathToFileURL(join(root, 'src/core/tool-guards.ts')).href)
const { MODES } = await import(pathToFileURL(join(root, 'src/packages/session-core/modes.ts')).href)
const { DOCK_ACTIONS, DOCK_LOOK_ACTIONS } = contract

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}

/**
 * 假的宿主链路：只够 `action=views` 跑通。
 *
 * `calls.views` 是「有没有真的读到页面」的证据：用户拒绝时它必须是 0。
 */
function fakeLink() {
  const calls = { views: 0 }
  return {
    calls,
    available: () => true,
    views: async () => {
      calls.views += 1
      return []
    },
    open: async () => ({ viewId: 'v1', attached: true, url: '' }),
    close: async () => {},
    call: async () => ({}),
    onEvent: () => () => {},
    session: () => ({ send: async () => ({}) }),
  }
}

/** 假的审批服务：记下每一次请求，按给定结论回答。 */
function fakeApproval(decision = 'allow-once') {
  const calls = []
  return {
    calls,
    async decide(request, signal, options) {
      calls.push({ request, options, aborted: signal.aborted })
      return decision
    },
  }
}

/**
 * 用假 ctx 挂一次插件，收下注册进来的工具与设置分区。
 *
 * `plugins.json` 由 `passedConfig` 给（`resolvePluginConfig` 读的就是它），不碰真实 profile。
 * `services` 是 `ctx.get` 的表：审批、协作模式、宿主链路都从这里来。
 */
function mount(passedConfig, services = {}) {
  const tools = []
  const sections = []
  const ctx = {
    tools: {
      register: (entry) => {
        tools.push(entry)
        return () => {}
      },
    },
    settings: {
      registerSection: (section) => {
        sections.push(section)
        return () => {}
      },
    },
    get: (name) => services[name],
    effect: (execute) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  const off = dockBrowserPlugin.apply(ctx, passedConfig)
  return { tools, sections, off }
}

const byName = (tools, name) => tools.find((tool) => tool.name === name)

/** 一次工具调用要的上下文（工具只用得到这几个字段）。 */
const runCtx = (signal) => ({
  cwd: root,
  signal: signal ?? new AbortController().signal,
  sessionId: 'session-look-check',
  sessionPath: join(root, 'session-look-check.jsonl'),
})

/** 调一次 look，把「抛了什么 / 返回了什么」一起收下来。 */
async function callLook(tool, args, signal) {
  try {
    return { ok: true, value: await tool.run(args, runCtx(signal)) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

console.log('[1] 默认配置：look 已注册、read 档，但每次都请求一次审批')
{
  const approval = fakeApproval('allow-once')
  const link = fakeLink()
  const { tools, off } = mount(
    {},
    {
      [HOST_BROWSER_SERVICE]: link,
      approval,
      mode: { modeFor: () => 'build' },
    },
  )
  const look = byName(tools, 'browser_dock_look')
  const act = byName(tools, 'browser_dock')
  check(
    '默认配置下注册了 browser_dock_look',
    look !== undefined,
    `实际注册了 ${tools.map((tool) => tool.name).join('、') || '(空)'}：只注册动手工具时，模型拿不到 ref，click/hover/type 全不可用`,
  )
  check(
    '默认档的风险等级是 read（所有档位都放行到执行）',
    look?.risk === 'read',
    `risk=${String(look?.risk)}：给 exec 的话，没有 command 参数的 look 在只读权限档被一律拒、在计划/探索模式只跑只读命令时被拒，模型依旧拿不到 ref`,
  )
  check(
    '默认档声明了 waitsForHuman（等审批卡的时间不算进脚本时限）',
    look?.waitsForHuman === true,
    `waitsForHuman=${String(look?.waitsForHuman)}：PTC 脚本里调它会按 120 秒脚本时限被掐死`,
  )

  const allowed = await callLook(look, { action: 'views' })
  check(
    '默认档（未开免审批）调用时会请求一次审批',
    approval.calls.length === 1,
    `审批请求次数=${approval.calls.length}：0 次 = 没人同意就看了用户登录着的浏览器；>1 次 = 一次调用弹多张卡`,
  )
  check(
    '请求审批时带 forceAskReason（跳过所有自动放行档，每次都弹卡）',
    typeof approval.calls[0]?.options?.forceAskReason === 'string' &&
      approval.calls[0].options.forceAskReason.trim() !== '',
    `forceAskReason=${JSON.stringify(approval.calls[0]?.options?.forceAskReason)}：不带它的话「完全访问」档与 AI 复核会自动放行，等于默认档可以免审批读`,
  )
  check(
    '请求审批时带发起会话的身份（卡归属与审计按它记）',
    approval.calls[0]?.request?.sessionId === 'session-look-check' &&
      approval.calls[0]?.request?.sessionPath === runCtx().sessionPath,
    `sessionId=${String(approval.calls[0]?.request?.sessionId)} sessionPath=${String(approval.calls[0]?.request?.sessionPath)}`,
  )
  check(
    '同意后真的读到了（action=views 返回视图清单）',
    allowed.ok === true && String(allowed.value?.text ?? allowed.value ?? '').includes('dock 视图'),
    allowed.ok ? `返回：${String(allowed.value?.text ?? allowed.value).slice(0, 80)}` : `抛错：${allowed.error}`,
  )
  check('默认配置下动手工具仍在', act !== undefined, `实际注册了 ${tools.map((tool) => tool.name).join('、')}`)

  // 拒绝这一路：抛可读错误，且**一点页面内容都不碰**（views 一次都没调）。
  const rejectApproval = fakeApproval('reject')
  const rejectLink = fakeLink()
  const rejected = mount(
    {},
    {
      [HOST_BROWSER_SERVICE]: rejectLink,
      approval: rejectApproval,
      mode: { modeFor: () => 'build' },
    },
  )
  const denied = await callLook(byName(rejected.tools, 'browser_dock_look'), { action: 'views' })
  check(
    '用户拒绝时抛可读错误、不返回页面内容',
    denied.ok === false && denied.error.includes('没有读到任何页面内容'),
    denied.ok ? '拒绝了却还是返回了内容' : `错误文案：${denied.error}`,
  )
  check(
    '用户拒绝时没有去读那台浏览器（一次都没碰宿主链路）',
    rejectLink.calls.views === 0,
    `views 被调用 ${rejectLink.calls.views} 次：先读再问等于审批只是摆设`,
  )

  check(
    '设置分区仍有 lookWithoutApproval 开关（用户能自己决定免审批）',
    (() => {
      const section = mount({}).sections.find((item) => item.id === 'dock-browser')
      return section !== undefined && section.fields().some((field) => field.key === 'lookWithoutApproval')
    })(),
    '设置分区里没有那个开关：用户没有「免审批看自己登录着的浏览器」的入口',
  )
  if (typeof off === 'function') off()
}

console.log('\n[2] lookWithoutApproval: true：不请求审批，直接读')
{
  const approval = fakeApproval('allow-once')
  const link = fakeLink()
  const { tools } = mount(
    { lookWithoutApproval: true },
    {
      [HOST_BROWSER_SERVICE]: link,
      approval,
      mode: { modeFor: () => 'build' },
    },
  )
  const look = byName(tools, 'browser_dock_look')
  check('开着免审批时 look 仍是注册的', look !== undefined, `实际注册了 ${tools.map((tool) => tool.name).join('、')}`)
  check(
    '开着免审批时 look 的风险等级是 read',
    look?.risk === 'read',
    `risk=${String(look?.risk)}：这一档没降下来，用户点了开关也不生效`,
  )
  const direct = await callLook(look, { action: 'views' })
  check(
    '开着免审批时一次审批都不请求',
    approval.calls.length === 0,
    `审批请求次数=${approval.calls.length}：用户已经明确关掉逐次确认，还弹卡就是违约`,
  )
  check(
    '开着免审批时直接读到（views 走通、宿主链路被调用一次）',
    direct.ok === true && link.calls.views === 1,
    direct.ok ? `views 调用 ${link.calls.views} 次` : `抛错：${direct.error}`,
  )
  check(
    '开着免审批时不声明 waitsForHuman（没有要等的人）',
    look?.waitsForHuman !== true,
    `waitsForHuman=${String(look?.waitsForHuman)}`,
  )
}

console.log('\n[3] look 与 act 同时在场：ref 的来源不再悬空')
{
  const { tools } = mount({})
  const look = byName(tools, 'browser_dock_look')
  const act = byName(tools, 'browser_dock')
  check('两个工具同时存在', look !== undefined && act !== undefined, `实际注册了 ${tools.map((tool) => tool.name).join('、')}`)
  check(
    'look 的动作表里有 snapshot（ref 的唯一来源）',
    JSON.stringify(look?.parameters?.properties?.action?.enum) === JSON.stringify([...DOCK_LOOK_ACTIONS]) &&
      DOCK_LOOK_ACTIONS.includes('snapshot'),
    `look 的 action 枚举=${JSON.stringify(look?.parameters?.properties?.action?.enum)}，契约=${JSON.stringify([...DOCK_LOOK_ACTIONS])}`,
  )
  // 只收 ref 的动作（runAct 里 lookupRef(state, args.ref) 无兜底的那几个）。
  const refOnly = ['click', 'hover', 'type']
  const missing = refOnly.filter((action) => !DOCK_ACTIONS.includes(action))
  check('契约里 click / hover / type 都在（它们只认 ref）', missing.length === 0, `缺：${missing.join('、')}`)
  const description = String(act?.description ?? '')
  check(
    'act 的说明指向 browser_dock_look snapshot，且那个工具真的注册了',
    description.includes('browser_dock_look') && description.includes('snapshot') && look !== undefined,
    `说明里提到 look 吗：${description.includes('browser_dock_look')}；look 注册了吗：${look !== undefined}——工具说明让模型去调一个没注册的工具，模型会反复重试同一个失败`,
  )
  // look 的快照动作不带 viewId 也能列视图，模型有「先看看有哪几台」这一步。
  check(
    'look 的 action=views 在枚举里（拿 viewId 的入口）',
    DOCK_LOOK_ACTIONS.includes('views'),
    `契约 ${JSON.stringify([...DOCK_LOOK_ACTIONS])}`,
  )
}

console.log('\n[4] 档位闸门：只读权限档、计划档、探索档都不再整档拒')
{
  /**
   * 装一条**真的**守卫链：模式闸（order 10，直接用 `session-core/modes.ts` 的判定）
   * + 审批守卫（order 30，用真的 `toolApprovalGuard`）。
   */
  const gateWith = async (modeId, risk) => {
    const registry = new ToolGuardRegistry()
    const approvals = []
    registry.register({
      id: 'mode',
      order: 10,
      decide: (input) => {
        const gate = MODES[modeId].gate({
          toolName: input.toolName,
          risk: input.risk,
          target: input.target,
          command: input.command,
          cwd: input.cwd,
          rules: [],
        })
        if (gate.action === 'deny') return { action: 'deny', reason: gate.reason }
        return gate.action === 'pass' ? { action: 'pass' } : { action: 'defer' }
      },
    })
    registry.register(
      toolApprovalGuard({
        id: 'approval',
        approve: async (input) => {
          approvals.push(input)
          return true
        },
        deniedReason: '用户拒绝了这次调用',
      }),
    )
    const verdict = await registry.gate({
      toolName: 'browser_dock_look',
      risk,
      cwd: root,
      args: { action: 'views' },
      signal: new AbortController().signal,
      sessionId: 'session-look-check',
      sessionPath: join(root, 'session-look-check.jsonl'),
    })
    return { verdict, approvals }
  }

  for (const modeId of ['plan', 'explore']) {
    const { verdict } = await gateWith(modeId, 'read')
    check(
      `${modeId} 模式下 read 档的 look 直接放行（不再被模式闸拒）`,
      verdict.action === 'pass',
      `裁决=${JSON.stringify(verdict)}：read 档在 modes.ts 的 planGate/exploreGate 里是 pass 分支`,
    )
  }
  // 钉住旧形状：exec + 没有 command 的 look 在计划模式里就是这次要修的那种整档拒。
  const legacy = await gateWith('plan', 'exec')
  check(
    '旧形状（risk=exec、无 command）在计划模式下确实被整档拒（钉住 P0-12 残留）',
    legacy.verdict.action === 'deny',
    `裁决=${JSON.stringify(legacy.verdict)}：这条断言失败说明 modes.ts 的判法变了，得重新论证 look 的档位`,
  )
  // 只读权限档：审批守卫对 read 直接 defer，所以 `approval/index.ts` 里那段
  // 「readonly → 写与执行类一律拒」根本走不到；exec 则会走到（那里没有 command 就判不出只读）。
  const readOnlyTier = await gateWith('build', 'read')
  check(
    '只读权限档里 read 档的 look 不会去问审批（走不到 readonly 的 auto-deny 分支）',
    readOnlyTier.approvals.length === 0,
    `审批守卫被问了 ${readOnlyTier.approvals.length} 次：read 被问就说明 risk 还是 exec 那一档`,
  )
  const execTier = await gateWith('build', 'exec')
  check(
    'exec 档会被审批守卫接走（这正是旧形状在只读权限档被 auto-deny 的入口）',
    execTier.approvals.length === 1,
    `审批守卫被问了 ${execTier.approvals.length} 次`,
  )
}

console.log('\n[5] 免打扰模式：不弹卡，也不偷偷读')
{
  const approval = fakeApproval('allow-once')
  const link = fakeLink()
  const { tools } = mount(
    {},
    {
      [HOST_BROWSER_SERVICE]: link,
      approval,
      mode: { modeFor: () => 'quiet' },
    },
  )
  const denied = await callLook(byName(tools, 'browser_dock_look'), { action: 'views' })
  check(
    '免打扰模式下不弹审批卡（这一档的承诺就是不打断用户）',
    approval.calls.length === 0,
    `审批请求次数=${approval.calls.length}`,
  )
  check(
    '免打扰模式下抛可读错误、不读页面',
    denied.ok === false && denied.error.includes('免打扰模式') && link.calls.views === 0,
    denied.ok ? '免打扰模式居然读到了内容' : `错误文案：${denied.error}；views 调用 ${link.calls.views} 次`,
  )
}

if (home !== '') rmSync(home, { recursive: true, force: true })
console.log(`\nPASS ${passed} / FAIL ${failed}`)
if (failed > 0) process.exitCode = 1
