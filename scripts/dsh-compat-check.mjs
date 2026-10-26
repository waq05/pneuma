// dsh 兼容层自检：dsh 风格插件（真 import defineTool / schemastery）经解析钩子 +
// ctx.tools 兼容面挂载执行；不支持的服务响亮拒绝；兼容层没开时的提示；risk 配置映射。
// 跑法：cd D:\dsc && pnpm run build && node scripts/dsh-compat-check.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-dsh-compat-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc', 'plugins'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const { mountAllExternalPlugins } = await import('../lib/core/plugin-loader.js')
const { writePluginEnabled, writePluginConfig } = await import('../lib/core/plugin-registry.js')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

// ── 插件样例 ─────────────────────────────────────────────────────────────────
// 1) dsh 风格 + 真 import：走解析钩子到 dsc 自带的 dsh-tools 与 schemastery。
//    dsh 的 parameters 是纯对象方言（dsh tools 里 z 只用于 Config schema）
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-tool-real.js'),
  `import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-real'
export const inject = ['tools', 'logger']
export const Config = z.object({ prefix: z.string() })

export function apply(ctx, config) {
  ctx.logger.warn('dsh-real 已挂载（logger 桥可见）')
  ctx.logger.warn('printf %s 与 %d 还原', '占位', 42)
  const tool = defineTool({
    name: 'dsh_echo',
    description: 'Echo the given text.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args) => String(args.text),
  })
  const off = ctx.tools.register(tool)
  return () => off()
}
`,
  'utf8',
)

// 2) dsh 风格、自包含：ToolDefinition 对象直接注册，risk 经条目配置映射为 read
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-tool-plain.js'),
  `export const name = 'dsh-plain'
export const inject = ['tools']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_upper',
    description: 'Uppercase the given text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    timeoutMs: 5000,
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args) => String(args.text).toUpperCase(),
  })
  return () => off()
}
`,
  'utf8',
)

// 3) 依赖 dsh 会话语义：明确不支持
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-needs-projections.js'),
  `export const name = 'dsh-projections'
export const inject = ['tools', 'sessionProjections']
export function apply() {}
`,
  'utf8',
)

// 4) 值契约 + 卡片：schema 校验、presentationMeta / presentCall / presentResult、并发标记、exec 面
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-tool-cards.js'),
  `export const name = 'dsh-cards'
export const inject = ['tools']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_cards',
    description: 'Return a canonical value with a diff card.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: { n: { type: 'integer' }, text: { type: 'string' } },
        required: ['n', 'text'],
      },
      render: (args, value) => [{ type: 'text', text: String(value.text) }],
      presentationMeta: (args, value) => ({ kind: 'echo', n: value.n }),
    },
    presentCall: (args) => ({ card: 'generic', title: 'Echo ' + String(args.text) }),
    presentResult: (args, result) => ({
      card: 'diff',
      title: 'Echo diff',
      diffs: [{ path: 'note.txt', oldText: 'old line\\n', newText: 'new line\\n' }],
    }),
    execute: async (args, exec) => {
      globalThis.__dshExecProbe = {
        hasAgent: typeof exec.agent === 'object' && exec.agent !== null,
        agentName: exec.agent && exec.agent.name,
        hasToken: typeof exec.token === 'object' && exec.token !== null,
        hasDefer: typeof exec.deferContext === 'function',
        hasConclude: typeof exec.concludeTurn === 'function',
        cwd: exec.cwd,
        hasSignal: exec.signal !== undefined,
      }
      return { n: 7, text: String(args.text) }
    },
  })
  return () => off()
}
`,
  'utf8',
)

// 5) 返回值不合自己声明的 schema：必须报错，不能当成功
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-tool-badschema.js'),
  `export const name = 'dsh-badschema'
export const inject = ['tools']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_bad',
    description: 'Declares string but returns a number.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => 42,
  })
  return () => off()
}
`,
  'utf8',
)

// 6) dsh 客户端（界面）能力声明：只列不加载
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-client-capable.js'),
  `export const name = 'dsh-client-capable'
export const inject = ['tools']
export const client = { platform: 'web', inject: ['tools'], card: true }
export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_client_tool',
    description: 'A tool next to a client declaration.',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    execute: async () => 'ok',
  })
  return () => off()
}
`,
  'utf8',
)

// 7) 内容钩子：projectContent 在 render 之后、finalizeContent 之前；失败结果也过 finalize
writeFileSync(
  join(home, '.dsc', 'plugins', 'dsh-tool-hooks.js'),
  `export const name = 'dsh-hooks'
export const inject = ['tools']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_hooked',
    description: 'Content goes through projectContent then finalizeContent.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    output: {
      schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      render: (args, value) => [{ type: 'text', text: 'render:' + String(value.body) }],
    },
    projectContent: (exec, result) => {
      globalThis.__dshHookProbe = {
        // 钩子拿到的应当是 execute 的规范值，不是 render 的文本
        projectValue: result.value && result.value.body,
        projectContentArrays: Array.isArray(result.content),
        isError: result.isError,
        execArgument: exec && exec.arguments && exec.arguments.text,
      }
      return [{ type: 'text', text: 'project:' + String(result.value.body) }]
    },
    finalizeContent: (exec, result) => {
      globalThis.__dshHookProbe = globalThis.__dshHookProbe || {}
      globalThis.__dshHookProbe.finalizeInput = result.isError ? 'error' : 'success'
      const first = Array.isArray(result.content) ? result.content[0] : undefined
      const text = first && typeof first.text === 'string' ? first.text : ''
      return [{ type: 'text', text: text + '|final' }]
    },
    execute: async (args) => {
      if (args.text === 'boom') throw new Error('原始错误文案')
      return { body: String(args.text) }
    },
  })
  // 钩子自己写坏了：不许让工具结果变成错误，保留 render 的文本
  const offBad = ctx.tools.register({
    name: 'dsh_hooked_bad',
    description: 'A broken projectContent must not break the call.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    projectContent: () => { throw new Error('钩子自己炸了') },
    execute: async () => 'safe',
  })
  return () => { off(); offBad() }
}
`,
  'utf8',
)

/** 起一个内核（dsh-compat 开关由调用方先行写盘）。 */
async function boot() {
  return createKernel({
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'k',
          models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })
}

async function stop(ctx) {
  ctx.emit('dsc/exit')
  const fiber = ctx?.fiber
  if (fiber !== null && fiber !== undefined && typeof fiber.dispose === 'function') await fiber.dispose()
}

console.log('兼容层没开：dsh 插件挂载被拦下且提示明确')
{
  const ctx = await boot()
  const failures = await mountAllExternalPlugins(ctx, [])
  check('七个 dsh 插件都没挂上', failures.length === 7, `实得 ${JSON.stringify(failures.map((f) => f.file))}`)
  const problems = failures.map((f) => f.problem).join('；')
  check('提示里点名 dsh-compat', problems.includes('dsh-compat'), `实得 ${problems}`)
  check('不支持的服务被点名', problems.includes('sessionProjections'), `实得 ${problems}`)
  const phase1Names = ctx.tools.list().map((t) => t.name)
  check('没装兼容层时 dsh 工具没进注册表', !phase1Names.includes('dsh_upper') && !phase1Names.includes('dsh_echo'), JSON.stringify(phase1Names))
  await stop(ctx)
}

console.log('兼容层开着：解析钩子 + 工具兼容面全链路')
{
  writePluginEnabled('dsh-compat', true)
  writePluginEnabled('dsh-tool-real.js', true)
  writePluginEnabled('dsh-tool-plain.js', true)
  writePluginEnabled('dsh-needs-projections.js', true)
  // 条目配置的 risk 映射：这份插件的所有工具按 read 放行（不弹审批卡）
  writePluginConfig('dsh-tool-plain.js', { risk: 'read' })
  const ctx = await boot()
  const failures = await mountAllExternalPlugins(ctx, [])
  check(
    'dsh-projections 仍被拒绝（超出兼容范围）',
    // 文案改过：现在逐条说清「服务名（原因）」，不再是一句「超出支持范围」。
    failures.some((f) => f.file === 'dsh-needs-projections.js' && /sessionProjections/.test(f.problem) && /投影/.test(f.problem)),
    JSON.stringify(failures),
  )
  const real = failures.find((f) => f.file === 'dsh-tool-real.js')
  check('真 import defineTool/schemastery 的插件挂上了', real === undefined, real === undefined ? '' : real.problem)
  const plain = failures.find((f) => f.file === 'dsh-tool-plain.js')
  check('自包含 dsh 插件挂上了', plain === undefined, plain === undefined ? '' : plain.problem)

  const tools = ctx.tools.list()
  const upper = tools.find((tool) => tool.name === 'dsh_upper')
  check('自包含 dsh 工具进了注册表', upper !== undefined, JSON.stringify(tools.map((t) => t.name)))
  check('条目配置的 risk: read 生效', upper?.risk === 'read', `实得 ${upper?.risk}`)
  const out = await upper.run({ text: 'hello dsh' }, { cwd: home, signal: new AbortController().signal })
  check('execute 经 render 折成模型可见文本', out === 'HELLO DSH', `实得 ${JSON.stringify(out)}`)

  const echo = tools.find((tool) => tool.name === 'dsh_echo')
  check('defineTool 产物也进了注册表', echo !== undefined, JSON.stringify(tools.map((t) => t.name)))
  check('schemastery spec 编译出的参数 schema 是 JSON Schema', echo?.parameters?.type === 'object' && echo.parameters?.properties?.text !== undefined, `实得 ${JSON.stringify(echo?.parameters)}`)
  const echoed = await echo.run({ text: 'compat' }, { cwd: home, signal: new AbortController().signal })
  check('defineTool 工具执行返回 render 文本', echoed === 'compat', `实得 ${JSON.stringify(echoed)}`)

  const transcriptText = JSON.stringify(ctx.transcript.getSnapshot())
  check('logger 桥把 warn 转进了对话流', transcriptText.includes('dsh-real 已挂载'), '快照里没有 logger 桥的文案')
  check('printf 占位符被还原而不是原样透传', transcriptText.includes('printf 占位 与 42 还原') && !transcriptText.includes('%s'), '快照里没有还原后的文案')
  await stop(ctx)
}

console.log('客户端能力：只列不加载')
{
  writePluginEnabled('dsh-client-capable.js', true)
  const ctx = await boot()
  const failures = await mountAllExternalPlugins(ctx, [])
  const problem = failures.find((f) => f.file === 'dsh-client-capable.js')
  check('声明了 client 的插件照常挂上（客户端部分不执行）', problem === undefined, problem === undefined ? '' : problem.problem)
  const { listPluginInfos } = await import('../lib/core/plugin-registry.js')
  const info = listPluginInfos().find((row) => row.file === 'dsh-client-capable.js')
  check('插件中心能读到界面能力清单', Array.isArray(info?.clientCapabilities), JSON.stringify(info?.clientCapabilities))
  check('能力清单里有 platform 与自定键', (info?.clientCapabilities ?? []).includes('platform:web') && (info?.clientCapabilities ?? []).includes('card'), JSON.stringify(info?.clientCapabilities))
  check('能力清单里也点出依赖的服务', (info?.clientCapabilities ?? []).includes('服务:tools'), JSON.stringify(info?.clientCapabilities))
  check('客户端插件没有因此多出工具或失败', ctx.tools.list().some((tool) => tool.name === 'dsh_client_tool'), JSON.stringify(ctx.tools.list().map((t) => t.name)))
  await stop(ctx)
}

console.log('值契约 + 卡片：schema 校验、presentationMeta、present 视图、并发标记、exec 面')
{
  writePluginEnabled('dsh-tool-cards.js', true)
  writePluginEnabled('dsh-tool-badschema.js', true)
  const ctx = await boot()
  const failures = await mountAllExternalPlugins(ctx, [])
  const cardsFail = failures.find((f) => f.file === 'dsh-tool-cards.js')
  check('带卡片与 schema 的插件挂上了', cardsFail === undefined, cardsFail === undefined ? '' : cardsFail.problem)
  const tools = ctx.tools.list()
  const cards = tools.find((tool) => tool.name === 'dsh_cards')
  check('工具进了注册表', cards !== undefined, JSON.stringify(tools.map((t) => t.name)))
  check('timeoutMs 透传到工具条目', cards?.timeoutMs === 5000, String(cards?.timeoutMs))
  let concurrent = 'none'
  try {
    concurrent = String(cards?.isConcurrencySafe?.({ text: 'x' }))
  } catch (error) {
    concurrent = 'threw: ' + String(error)
  }
  check('isConcurrencySafe 透传且只认 true', concurrent === 'true', concurrent)

  const out = await cards.run({ text: 'hello' }, { cwd: home, signal: new AbortController().signal })
  const shaped = typeof out === 'string' ? null : out
  check('返回值按 schema 放行后仍是文本 + 卡片数据', shaped !== null && shaped.text === 'hello', JSON.stringify(out))
  check('presentResult 的 diff 卡片带出来了', shaped?.presentation?.result?.card === 'diff', JSON.stringify(shaped?.presentation?.result))
  check('presentCall 的卡片也带出来了', shaped?.presentation?.call?.card === 'generic', JSON.stringify(shaped?.presentation?.call))
  check('presentationMeta 原样带出（可重放）', shaped?.presentation?.meta?.n === 7, JSON.stringify(shaped?.presentation?.meta))
  const diff = shaped?.presentation?.result?.diffs?.[0]
  check('diff 卡片是「改前全文 + 改后全文」', diff?.path === 'note.txt' && diff?.oldText === 'old line\n' && diff?.newText === 'new line\n', JSON.stringify(diff))
  const exec = globalThis.__dshExecProbe
  check('exec 里有 agent（从 caller 折出来）', exec?.hasAgent === true && exec?.agentName === 'lead', JSON.stringify(exec))
  check('exec 里有 token / deferContext / concludeTurn / signal / cwd', exec?.hasToken === true && exec?.hasDefer === true && exec?.hasConclude === true && exec?.hasSignal === true && exec?.cwd === home, JSON.stringify(exec))

  const bad = tools.find((tool) => tool.name === 'dsh_bad')
  check('不合 schema 的工具也进了注册表（错在调用时暴露）', bad !== undefined)
  let badError = null
  try {
    await bad.run({}, { cwd: home, signal: new AbortController().signal })
  } catch (error) {
    badError = String(error instanceof Error ? error.message : error)
  }
  check('返回值不合 output.schema 时报错而不是当成功', badError !== null && badError.includes('output.schema'), String(badError))
  check('报错文案点出类型不符', badError !== null && badError.includes('string'), String(badError))
  await stop(ctx)
}

console.log('内容钩子：projectContent 在前、finalizeContent 在后，失败结果也过 finalize')
{
  writePluginEnabled('dsh-tool-hooks.js', true)
  const ctx = await boot()
  const failures = await mountAllExternalPlugins(ctx, [])
  const hookFail = failures.find((f) => f.file === 'dsh-tool-hooks.js')
  check('带内容钩子的插件挂上了', hookFail === undefined, hookFail === undefined ? '' : hookFail.problem)
  const hooked = ctx.tools.list().find((tool) => tool.name === 'dsh_hooked')
  check('两个钩子的工具都进了注册表', hooked !== undefined && ctx.tools.list().some((t) => t.name === 'dsh_hooked_bad'), JSON.stringify(ctx.tools.list().map((t) => t.name)))

  const out = await hooked.run({ text: 'hi' }, { cwd: home, signal: new AbortController().signal })
  check('projectContent 的替换结果又过了 finalizeContent', out === 'project:hi|final', JSON.stringify(out))
  const probe = globalThis.__dshHookProbe
  check('钩子拿到的是 execute 的规范值，不是 render 的文本', probe?.projectValue === 'hi', JSON.stringify(probe))
  check('钩子拿到的 content 已经是内容块数组', probe?.projectContentArrays === true && probe?.isError === false, JSON.stringify(probe))
  check('finalizeContent 这次看到的是成功结果', probe?.finalizeInput === 'success', JSON.stringify(probe))

  let boomError = null
  try {
    await hooked.run({ text: 'boom' }, { cwd: home, signal: new AbortController().signal })
  } catch (error) {
    boomError = error instanceof Error ? error.message : String(error)
  }
  check('失败结果的最终文案也过 finalizeContent', boomError === '原始错误文案|final', String(boomError))
  check('失败路径下钩子看到的是 isError', globalThis.__dshHookProbe?.finalizeInput === 'error', JSON.stringify(globalThis.__dshHookProbe))

  const bad = ctx.tools.list().find((tool) => tool.name === 'dsh_hooked_bad')
  const safe = await bad.run({}, { cwd: home, signal: new AbortController().signal })
  check('钩子自己抛错时保留 render 的内容，不把工具变成错误', safe === 'safe', JSON.stringify(safe))
  await stop(ctx)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
