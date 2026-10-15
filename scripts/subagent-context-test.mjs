/**
 * WS6(a) 子代理上下文：子代理的 system prompt 里带环境/模型事实（cwd、平台、日期、模型）。
 *
 * 背景：子代理的 MiniAgent deps 里没有 `rewrite`，主会话那条 env-facts 投影对它不生效；
 * 而它又不该拿主会话的环境快照——子代理有自己的会话目录与冻结的工牌模型。瞎猜路径的根因
 * 就是系统提示词里既没有 cwd、也没有模型名。这条线给子代理单独补一段（纯函数
 * `subagentEnvironmentText`），并用**派它的那个会话**的 cwd（不是进程 cwd）。
 *
 * 断言：
 *  ① 纯函数 `subagentEnvironmentText(cwd, model)` 含工作目录 / 平台 / 今天 / 模型；
 *  ② cwd 用传进来的那个，不是进程 cwd；给一个假 cwd 也照它写；
 *  ③ 端到端（真内核 + 假 SSE）：用 `ctx.session.open(undefined, 自定义目录)` 把父会话的
 *     cwd 换成一个临时目录，直接调 `subagent` 工具派一个队友，抓队友那次请求的 system，
 *     断言里面写着**父会话的 cwd**、平台、今天、模型名，且不含进程 cwd；
 *  ④ 模型名回填：工牌没指定模型时取 `ctx.llm.model`。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/subagent-context-test.mjs
 *
 * @module dsc/scripts/subagent-context-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-subagent-ctx-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 打开子智能体（官方插件默认关），并让收工汇报走 quiet（不额外唤起主会话的一轮，
// 免得那些请求混进本探针要观察的子代理请求里）；关掉长期记忆（回合结束会投机器通知）。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'subagent', disabled: false, config: { allowDelegation: true, notify: 'quiet' } },
        { file: 'memory', config: { enabled: false } },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

/** 父会话的 cwd：一个与进程 cwd 不同的临时目录，用来钉住「用的是父会话的 cwd」。 */
const parentCwd = join(home, 'work', 'proj-alpha')
mkdirSync(parentCwd, { recursive: true })

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

const { subagentEnvironmentText } = await import('../lib/core/prompt.js')

/** 平台文案与源码同款（探针独立算一遍，避免直接抄被测实现）。 */
const expectedPlatform = process.platform === 'win32' ? 'Windows' : process.platform
const today = (() => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
})()

console.log('[1] 纯函数：含 cwd / 平台 / 今天 / 模型，且用传进来的 cwd')
{
  const fakeCwd = '/definitely/not/this/process/dir'
  const text = subagentEnvironmentText(fakeCwd, 'deepseek-v9')
  check('以「环境事实：」开头', text.startsWith('环境事实：'), text.split('\n')[0])
  check('含工作目录 = 传进来的 cwd', text.includes(`- 工作目录：${fakeCwd}`), text)
  check('含平台', text.includes(`- 平台：${expectedPlatform}`), text)
  check('含今天', text.includes(`- 今天：${today}`), text)
  check('含模型名', text.includes('- 你用的模型：deepseek-v9'), text)
  check(
    'cwd 是传进来的那个、不是进程 cwd',
    !text.includes(process.cwd()) && text.includes(fakeCwd),
    `processCwd=${process.cwd()}`,
  )
  check('不查 git 分支（子代理每轮现算，跑 git 子进程不值当）', !text.includes('git 分支'), text)
}

// ── 假模型端点（真 SSE）：抓住子代理那次请求的 system ────────────────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'

/** 子代理请求（system 里带「# 你在团队里的位置」标志）的原样记录。 */
const subagentRequests = []
async function serve() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const system = messages.find((m) => m.role === 'system')
      const systemText = typeof system?.content === 'string' ? system.content : ''
      if (systemText.includes('# 你在团队里的位置')) {
        subagentRequests.push({ system: systemText, model: payload.model })
      }
      res.end(sseText('收到，已看过项目结构'))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import('../lib/host/kernel.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: site.baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

console.log('[2] 端到端：父会话 cwd 换成临时目录，派队友抓它的 system prompt')
{
  // 把当前会话的 cwd 换成 parentCwd（新会话，目录必须存在）
  await ctx.session.open(undefined, parentCwd)
  const tool = ctx.tools.list().find((entry) => entry.name === 'subagent')
  check('subagent 工具在场（allowDelegation 打开）', tool !== undefined, JSON.stringify(ctx.tools.list().map((t) => t.name)))
  const spawned = await tool.run(
    {
      action: 'spawn',
      role: 'explorer',
      task: '读一下这个项目的 package.json，用一句话汇报项目名与版本，再说明主入口文件在哪',
      background: true,
    },
    { cwd: parentCwd, signal: new AbortController().signal },
  )
  check('派活返回了队友名', typeof spawned === 'string' && spawned.includes('已派给'), spawned)

  const got = await until(() => subagentRequests.length > 0)
  const req = subagentRequests[0]
  check('子代理发起过一次模型请求', got, JSON.stringify(subagentRequests.length))
  check('system 里有「# 你在团队里的位置」（接线成功）', req?.system.includes('# 你在团队里的位置') === true, req?.system.slice(0, 80))
  check('system 里有「环境事实：」段', req?.system.includes('环境事实：') === true, '无环境段')
  check('工作目录 = **父会话的 cwd**（不是进程 cwd）', req?.system.includes(`- 工作目录：${parentCwd}`) === true, req?.system)
  check('不含进程 cwd', req?.system.includes(process.cwd()) === false, `processCwd=${process.cwd()}`)
  check('平台写在里面', req?.system.includes(`- 平台：${expectedPlatform}`) === true, req?.system)
  check('今天写在里面', req?.system.includes(`- 今天：${today}`) === true, req?.system)
  check('模型名回填 = ctx.llm.model', req?.system.includes(`- 你用的模型：${ctx.llm.model}`) === true, req?.system)
  check('请求的 model 字段是测试模型', req?.model === 'm', req?.model)
  check(
    '环境段落在角色提示之后、「# 你在团队里的位置」之前',
    (() => {
      const text = req?.system ?? ''
      const env = text.indexOf('环境事实：')
      const pos = text.indexOf('# 你在团队里的位置')
      return env >= 0 && pos > env
    })(),
    req?.system,
  )

  await until(() => !ctx.agent.isRunning)
  await sleep(80)
}

await ctx.dispose?.()
await site.close()
console.log('')
if (failures === 0) console.log('子代理上下文电池：全部通过')
else console.log(`子代理上下文电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
