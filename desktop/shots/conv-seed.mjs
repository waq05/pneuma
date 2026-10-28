/**
 * 「对话区按钮位置与边界优化」自检的种子数据。
 *
 * 隔离：只写 desktop/shots/conv-home（临时 HOME + 临时 userData），
 * 用户真实的 ~/.dsc 一个字节都不写。假端点见 conv-fake-llm.mjs。
 *
 * 造两份数据：
 * 1. 一条自己的会话（三轮，每轮都有回复）：三轮是有意的——轮数够多、正文够长，
 *    右缘的刻度条（要两枚以上刻度 + 内容比视口高）才会真的画出来，拖宽那个用例
 *    才有刻度轨道可量；
 * 2. 一份队友运行记录 + 名册：只读视图（TeammatePeek）要验「编辑与分叉都不出现」。
 *    队友记录必须落在 ~/.dsc/sessions/.teammates 下（宿主只认这个前缀），
 *    而「子智能体团队」这个官方插件默认是关的，所以还要写 plugins.json 把它打开。
 *
 * 用法：node shots/conv-seed.mjs   （两个路径写进 conv-sessions.json）
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const shots = 'D:\\dsc\\desktop\\shots'
const home = join(shots, 'conv-home')
const theme = process.env.CONV_THEME === 'light' ? 'light' : 'dark'
const port = Number(process.env.CONV_FAKE_PORT ?? 18971)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'sessions'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置按 homedir 算。
process.env.HOME = home
process.env.USERPROFILE = home

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 对话区自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: CONV_FAKE_KEY
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
      defaultPolicy: null,
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
        fontSize: 'md',
        density: 'standard',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// 「子智能体团队」默认关着，开了它 team 服务才存在，listTeammates 才读得到名册
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`,
  'utf8',
)

const core = await import('../../lib/core/session.js')

const seed = core.Session.create('D:\\dsc')

seed.appendUser('第一轮：帮我把对话流里的工具卡收成一行，展开再看细节。')
seed.appendAssistant(
  '先看一下现有工具卡的结构：紧凑行负责扫视，展开区放参数与结果。',
  '用户要的是「一屏扫过更多调用」；那我得把入参从行上挪进展开区，行上只留摘要。',
  [
    {
      id: 'call_conv_seed_1',
      name: 'read',
      arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\ToolCard.tsx' }),
    },
  ],
)
seed.appendTool('call_conv_seed_1', 'read', '读到了 301 行：紧凑行 + 展开区 + 超 400px 的吸附快捷栏。')

seed.appendUser('第二轮：折叠条的 hover 底色再改一档，跟侧栏那套令牌对齐。')
seed.appendAssistant('好，我把 hover 与按下两档都换成控制层令牌，这样两处不会各自漂。', '', [
  {
    id: 'call_conv_seed_2',
    name: 'bash',
    arguments: JSON.stringify({ command: 'rg -n "control-hover-bg" D:/dsc/desktop/src/renderer/styles.css' }),
  },
])
seed.appendTool('call_conv_seed_2', 'bash', '12 处命中：.meta-btn、.tool-head、.think-head 都在用同一档。')

// 第三轮故意写长：内容要真的比视口高，右缘刻度条才会画出来
seed.appendUser('第三轮：正文拖宽时右缘别压到刻度条，顺便把每轮的分叉按钮挪到时间那一行。')
seed.appendAssistant(
  [
    '这两件事都落在右缘那一条带上，一起说：',
    '',
    '1. 拖宽的上限原来只算了「两侧热区 + 安全区」80px，刻度轨道（16px 刻度 + 4px 与正文的缝 + 12px 与滚动条的缝）',
    '和滚动条（8px）是靠 `.chat` 的右内距替正文让位的。现在把这两条轨道也算进上限里，上限自己守住刻度。',
    '2. 分叉按钮从气泡内部右下角挪到每轮末尾的时间行上，跟 HH:mm、用时排在同一行，只读视图里不画。',
    '',
    '顺带记一下量到的数：拖到最宽时 `.chat-inner` 的右缘离刻度轨道左缘还有余量，两列不会叠在一起。',
    '再补一句把这一段撑长：刻度条的命中测试走 `data-round`，轮与轮的边界因此要真的落在 DOM 上，',
    '长正文在滚动时才不会出现「高亮还停在上一轮」的情况。',
  ].join('\n'),
  '',
  [
    {
      id: 'call_conv_seed_3',
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'dsc-jump-lane', path: 'D:\\dsc\\desktop\\src\\renderer' }),
    },
  ],
)
seed.appendTool('call_conv_seed_3', 'grep', '3 处命中：tokens.css 的定义、styles.css 的右内距、panels.ts 的上限推导。')
seed.close()

// ── 只读视图用的队友运行记录 ──
const mateFile = join(home, '.dsc', 'sessions', '.teammates', 'D-dsc', 'conv-mate.jsonl')
mkdirSync(join(home, '.dsc', 'sessions', '.teammates', 'D-dsc'), { recursive: true })
const mate = core.Session.create('D:\\dsc', mateFile)
mate.appendUser('把对话区那几条样式改动逐条核一遍，只读，不要动文件。')
mate.appendAssistant('核完了：正文宽度上限、气泡操作条、每轮页脚三处都对得上，没有人写裸色值。', '', [
  {
    id: 'call_conv_mate_1',
    name: 'read',
    arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\styles.css' }),
  },
])
mate.appendTool('call_conv_mate_1', 'read', '读了 styles.css 末尾新增的那一段。')
mate.close()

// 名册：listTeammates 读的就是这一份（队友在队时以内存为准，收工后以名册为准）
mkdirSync(join(home, '.dsc', 'team'), { recursive: true })
writeFileSync(
  join(home, '.dsc', 'team', 'roster.json'),
  `${JSON.stringify(
    {
      teammates: [
        {
          name: '小灰',
          role: 'reader',
          state: 'idle',
          task: '只读核对对话区样式改动',
          file: mateFile,
          cwd: 'D:\\dsc',
          parent: 'lead',
          depth: 1,
          rounds: 1,
          startedAt: Date.now() - 60000,
          finishedAt: Date.now() - 30000,
        },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(`seeded ${home} (theme=${theme})`)
console.log(`session: ${seed.filePath}`)
console.log(`teammate: ${mate.filePath}`)
writeFileSync(
  join(shots, 'conv-sessions.json'),
  `${JSON.stringify({ home, theme, static: seed.filePath, mate: mate.filePath }, null, 2)}\n`,
  'utf8',
)
