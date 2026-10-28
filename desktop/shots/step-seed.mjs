/**
 * 「阶段组折叠」桌面自检的种子数据：只写 `desktop/shots/step-home`（临时 HOME + 临时 userData），
 * 用户真实的 `~/.dsc` 与真实 workspace 一个字节都不写。
 *
 * 造三样东西：
 *   step-sessions.json 里记着两条会话：
 *   step-static —— 静态样张：三轮，覆盖阶段分组的三种形态
 *     · 第 1 轮：**三段阶段**。每段都是「思考 + 工具…」然后跟一条阶段正文，最后一条是最终回答。
 *       于是这一轮切出三个组，组头文案分别验「两类聚合 / 单类 / 两类不共享前缀」三种拼法，
 *       整轮展开时应当看到三行组头，整轮收起时三行一起消失。
 *     · 第 2 轮：思考 + 最终正文。组里一条工具都没有 → 组头应当是「已完成分析」。
 *     · 第 3 轮：**没有最终正文**（思考 + 工具就收工）。组头落在过程区里，
 *       验「一组以工具收尾」时组头与页脚的位置关系。
 *   step-live —— 实时样张：一条已定稿的短会话，配 step-fake-llm.mjs 再跑一轮真对话，
 *     用来验「跑动中的组默认展开、定稿后自动收起」。
 *
 * 环境变量：
 *   STEP_THEME=dark|light         写进 settings.json 的 ui.themeMode（默认 dark）
 *   STEP_PROCESS_FOLD=...         写进 ui.processFold（默认 standard）
 *   STEP_FAKE_PORT=18953          config.yaml 里假端点的端口
 *
 * 用法：node shots/step-seed.mjs（在 desktop/ 下）
 *
 * @module desktop/shots/step-seed
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\step-home'
const theme = process.env.STEP_THEME === 'light' ? 'light' : 'dark'
const processFold = process.env.STEP_PROCESS_FOLD ?? 'standard'
const port = Number(process.env.STEP_FAKE_PORT ?? 18953)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置；这个目录不存在时
// 它直接崩掉（0x80000003，stdout 一个字都留不下），所以隔离目录必须预先建好它。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置是按 homedir 算的。
process.env.HOME = home
process.env.USERPROFILE = home

// 实时用例里模型会调一次 read，读的就是它（假的端点脚本读 FOLD_PROBE_TARGET 这个变量名）。
const probeTarget = join(home, 'probe-target.txt')
writeFileSync(probeTarget, '这是一份供自检读取的样张文件：阶段组折叠的实时用例读它。\n', 'utf8')

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 阶段组折叠自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: STEP_FAKE_KEY
    models:
      - id: fake-chat
        name: Fake Chat
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)

writeFileSync(
  join(home, '.dsc', 'settings.json'),
  `${JSON.stringify(
    {
      // 实时用例里模型要调一次 read 工具：readonly 策略放行只读工具，不会弹审批卡。
      defaultPolicy: 'readonly',
      defaultEffort: null,
      marketSources: [],
      closeToTray: false,
      ui: {
        sessionSort: 'recent',
        sessionGroup: 'workspace',
        archivedFilter: 'hide',
        workspaceOrder: ['D:\\dsc'],
        workspaceAliases: {},
        themeMode: theme,
        fontSize: 1,
        buttonScale: 1,
        density: 'standard',
        processFold,
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

const core = await import('../../lib/core/session.js')

/** 一条工具调用（jsonl 里 tool_calls 的一项）。 */
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })

const staticSession = core.Session.create('D:\\dsc')

// ── 第 1 轮：三段阶段（这是「多阶段工具调用也能自动折叠」的主样张） ──────────────
staticSession.appendUser('把会话区的阶段折叠做出来，我要每一步都能单独收起来。')
// 阶段一：先摸清现状（grep 先、read 后 → 组头「已搜索代码并读取文件」）
staticSession.appendAssistant(
  '',
  ['阶段一思考：先看现在的分组口径是什么，再决定新一层插在哪里。', '轮次边界在 turn-timing，条目类型在 contract。'].join('\n'),
  [
    call('call_step_grep', 'grep', { pattern: 'roundFold', path: 'D:\\dsc\\desktop\\src' }),
    call('call_step_read', 'read', { path: 'D:\\dsc\\desktop\\src\\renderer\\ChatView.tsx' }),
  ],
)
staticSession.appendTool('call_step_grep', 'grep', '匹配 3 处：ChatView.tsx:421 / :445 / :704')
staticSession.appendTool('call_step_read', 'read', '（读取成功：ChatView.tsx 已按行返回，内容从略）')
staticSession.appendAssistant('阶段一结论：分组口径现在只有一层，要补的是「正文之间夹着的思考与工具」。', '', [])

// 阶段二：跑一遍测试（bash → 组头「执行了命令」）
staticSession.appendAssistant(
  '',
  '阶段二思考：改之前先跑一遍现有自检，拿到基线。',
  [call('call_step_bash', 'bash', { command: 'node desktop/shots/fold-check.mjs' })],
)
staticSession.appendTool('call_step_bash', 'bash', '[fold-check] 断言 108 条，通过 108 条，失败 0 条')
staticSession.appendAssistant('阶段二结论：基线全过，可以动刀。', '', [])

// 阶段三：动手改（edit 先、write 后 → 组头「修改了文件并已写入文件」）
staticSession.appendAssistant(
  '',
  ['阶段三思考：新增一个纯函数分组器，渲染层只消费。', '组头文案照 dsh 的类别聚合拼法。'].join('\n'),
  [
    call('call_step_edit', 'edit', { file_path: 'D:\\dsc\\desktop\\src\\renderer\\ChatView.tsx' }),
    call('call_step_write', 'write', { file_path: 'D:\\dsc\\desktop\\src\\renderer\\process-groups.ts' }),
  ],
)
staticSession.appendTool('call_step_edit', 'edit', '已替换 1 处：ChatView.tsx 的 roundFold 段')
staticSession.appendTool('call_step_write', 'write', '已写入 process-groups.ts（303 行）')
staticSession.appendAssistant(
  '最终回答：一轮之内现在有三层显隐——整轮 → 阶段组 → 单条思考或工具；阶段组头是一行类别聚合文案，整行可点。',
  '',
  [],
)

// ── 第 2 轮：思考 + 最终正文（组里一条工具都没有 → 组头「已完成分析」） ──────────
staticSession.appendUser('那只有思考、没调工具的阶段会显示什么？')
staticSession.appendAssistant(
  '最终回答：组头显示「已完成分析」——只思考没动手的那一阶段就是这样。',
  '思考：确认一组零工具时走的是兜底文案，不是空标题。',
  [],
)

// ── 第 3 轮：**没有最终正文**（思考 + 工具就收工，组头落在过程区里） ──────────────
staticSession.appendUser('最后挑一处短名量的地方收个尾。')
staticSession.appendAssistant(
  '',
  '思考：只挑一处，量完就收工。',
  [call('call_step_glob', 'glob', { pattern: 'desktop/src/renderer/*.tsx' })],
)
staticSession.appendTool('call_step_glob', 'glob', '匹配 22 个文件：ChatView.tsx、StepGroupRow.tsx、process-groups.ts …')

// ── 第 4 轮：一个「压着几十条调用」的阶段（验组体限高、方向渐隐、组内独立滚动） ────
// 32 条 read 挤在同一段过程里，中间没有正文——于是它们同属一个阶段组，
// 组体远超 min(400px, 50vh) 的限高，展开时才有得量。
staticSession.appendUser('把整个渲染层扫一遍，别漏。')
staticSession.appendAssistant(
  '',
  '阶段一思考：先把渲染层的文件逐个读一遍，量出总量。',
  Array.from({ length: 32 }, (_unused, at) => call(
    `call_step_sweep_${String(at)}`,
    'read',
    { path: `D:\\dsc\\desktop\\src\\renderer\\file-${String(at)}.tsx` },
  )),
)
for (let at = 0; at < 32; at += 1) {
  staticSession.appendTool(
    `call_step_sweep_${String(at)}`,
    'read',
    `（第 ${String(at + 1)} 个文件读取成功，内容从略）`,
  )
}
staticSession.appendAssistant('最终回答：32 个文件都读完了，没有漏。', '', [])

staticSession.close()

// ── 计划卡（验「封掉前面的组、自己不进组」） ─────────────────────────────────────
// 为什么直接往 jsonl 追加一条老格式的 plan 记录：`Session` 没有 appendPlan（计划走
// `ctx.session.appendState('plan', …)`，那是状态不是会话流条目）。而 `Session.load` 认识
// `{type:'plan'}` 这个老记录（core/session.ts:255-257），会把它塞进 `state('plan')`，
// plan 插件在 dsc/session-open 时再 emit 回会话流（src/plugins/plan.ts:114-121）。
// 重放路径下这条卡会落在会话流**末尾**（插件是在会话打开后 emit 的）——所以截图上能验的是
// 「它封掉了前面的组、自己不被任何组收走」；「它之后另起一组」由行为单测第 5 组覆盖。
appendFileSync(
  staticSession.filePath,
  `${JSON.stringify({
    type: 'plan',
    plan: {
      file: 'D:\\dsc\\docs\\render-sweep.md',
      title: '渲染层清点计划',
      text: '## 渲染层清点计划\n\n1. 逐个读渲染层的 tsx 与 ts\n2. 汇总行数与依赖\n3. 按依赖顺序排一遍改动\n',
      decision: 'approved',
    },
    ts: Date.now(),
  })}\n`,
  'utf8',
)

// ── 实时样张：短会话，配假端点再跑一轮（验跑动中组默认展开、定稿后收起） ──────────
const liveSession = core.Session.create('D:\\dsc')
liveSession.appendUser('把阶段分组那处改动再确认一遍。')
liveSession.appendAssistant('好，我调一次读文件确认入口。', '思考：先确认入口在哪。', [])
liveSession.close()

// ── 分页样张：12 轮，比一页的 8 轮（ChatView 的 PAGE_ROUNDS）多出 4 轮 ──────────
// 用来验「初始只画最近一页」＋「加载更早之后锚点不动、保留组级开合」。
// 每轮都是「用户消息 + 一条回答」，形状简单，断言好写。
const pagingSession = core.Session.create('D:\\dsc')
for (let at = 0; at < 12; at += 1) {
  pagingSession.appendUser(`第 ${String(at + 1)} 件事：这是分页样张的第 ${String(at + 1)} 轮。`)
  // 每轮都带一段思考 + 一条回答：这样每一轮都有**可折的过程**，整轮总开关才是可点的，
  // 「加载更早之后手动展开的还开着」这条断言才有东西可验（只有一条回答的轮没过程可折，
  // 那一行是 disabled 的，压根点不动）。
  pagingSession.appendAssistant(
    `第 ${String(at + 1)} 轮的回答：收到。`,
    `思考：第 ${String(at + 1)} 轮先想一下再答。`,
    [],
  )
}
pagingSession.close()

console.log(`seeded ${home} (theme=${theme}, processFold=${processFold})`)
console.log(`static session: ${staticSession.filePath}`)
console.log(`live session:   ${liveSession.filePath}`)
console.log(`probe target:   ${probeTarget}`)
// 把路径留给截图脚本用：会话文件名是随机 id，脚本不该去猜。
writeFileSync(
  'D:\\dsc\\desktop\\shots\\step-sessions.json',
  `${JSON.stringify({ home, theme, processFold, static: staticSession.filePath, live: liveSession.filePath, paging: pagingSession.filePath, probeTarget }, null, 2)}\n`,
  'utf8',
)
