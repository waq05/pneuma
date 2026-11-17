/**
 * 浏览器 DOM 快照（P4 快照层）：10 个高频改动面，真宿主 + 真 Electron 渲染后逐字节钉住。
 *
 * ## 为什么是 DOM 文本而不是像素
 *
 * 像素跨机器必抖：字体、缩放、GPU 合成都会让同一份 DOM 差出几个像素。DOM 文本与元素
 * 计数只随产品改动变化，跨机器逐字节一致——所以产物是 `innerText` + `location.hash` +
 * 关键选择器计数，不是截图。驱动的实现见 `./drivers/dom-shot.cjs`（CDP over
 * `--remote-debugging-port`）。
 *
 * ## 一个场景跑一次真机
 *
 * 每个场景独立 `mkdtempHome` + `startUiHost` + `runElectronDriver`：隔离 HOME 里预置
 * `~/.dsc/config.yaml`、会话 jsonl、名册与用量流水；宿主在子进程里读这些文件，Electron
 * 用驱动把页面操作到目标面。场景之间不共享进程，失败也不会把下一场带脏。
 *
 * ## 归一化只做「与业务无关的无常项」
 *
 * 临时目录、会话 uuid、当天日期、相对时间、招呼语、版本号、耗时读数——这些每次运行
 * 都不同，不折成占位符 golden 会天天红。数字、文案、结构一律原样比：改一个标签、少一个
 * 元素计数，golden 必须红。每条规则的理由写在 `normalizeDom` 上方。
 *
 * ## 缺件时大声跳过
 *
 * Electron / `lib/` / `lib/ui/` 不在或比源码旧时，`probeFreshness()` 给出原因，
 * 整文件 `describe.skipIf` 并打印 `skipReason`——不静默绿（照
 * `tests/e2e/ui-anchor.e2e.ts`）。
 *
 * ## 更新 golden
 *
 * ```bash
 * UPDATE_GOLDEN=1 pnpm exec vitest run --project snapshot tests/snapshots/browser
 * ```
 *
 * 然后人工审 `tests/snapshots/golden/browser/*.txt` 的 diff 再提交。
 *
 * @module dsc/tests/snapshots/browser/dom.snapshot
 */
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { expectGolden } from '../../harness.js'
import {
  ROOT,
  electronUserData,
  freePort,
  mkdtempHome,
  probeFreshness,
  runElectronDriver,
  skipReason,
  startUiHost,
  stopHost,
  type UiHost,
} from '../../e2e/support/host.js'

const DRIVER = join(ROOT, 'tests', 'snapshots', 'browser', 'drivers', 'dom-shot.cjs')
/** 宿主进程的钉死时钟预加载（`node --require`；理由见该文件头注释）。 */
const HOST_CLOCK_PRELOAD = join(ROOT, 'tests', 'snapshots', 'browser', 'drivers', 'pin-host-clock.cjs')
/** 宿主进程的钉死工作目录预加载（`node --require`；理由见 {@link seedHostWorkdir}）。 */
const HOST_CWD_PRELOAD = join(ROOT, 'tests', 'snapshots', 'browser', 'drivers', 'pin-host-cwd.cjs')

/**
 * 往宿主子进程的 `NODE_OPTIONS` 里追加若干 `--require` 预加载（原有 flags 保留），
 * 连同预加载要读的环境变量一起返回。
 *
 * 为什么走 `NODE_OPTIONS`：宿主是 `startUiHost` 起的**子进程**
 * （`tests/e2e/support/host.ts:102`），测试进程里的 `vi.setSystemTime` / `process.chdir`
 * 都管不到它。页面侧的 `Date` 由 `bootScript` 单独钉；两侧同一个时刻，页面算相对时间才
 * 恒为非负。工作目录同理：`src/host/kernel.ts:47-48` 把 `process.cwd()` 交给 session 与
 * desktop-dock，必须在宿主启动前改掉。
 */
function hostPreloadEnv(preloads: readonly string[], env: Record<string, string>): Record<string, string> {
  // 路径按 NODE_OPTIONS 的解析规则加引号：检出目录带空格时也不能散架。
  const flags = preloads.map((file) => `--require "${file.replaceAll('\\', '/')}"`).join(' ')
  const existing = process.env['NODE_OPTIONS']
  return {
    ...env,
    NODE_OPTIONS: existing === undefined || existing === '' ? flags : `${existing} ${flags}`,
  }
}

const fresh = probeFreshness()
if (!fresh.ok) console.warn(skipReason(fresh))

/** 固定工作目录：会话列表按它分组，路径本身要稳定，不能出现临时目录。 */
const WORK = 'D:\\dom-work'
/** 一条固定会话 id（uuid 形状，归一化后统一成 `<id>`，这里仍写成真 uuid 便于真机排障）。 */
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
/** 固定的种子时刻：相对时间会被归一化，但排序与「用时」仍要稳定。 */
const T0 = Date.UTC(2025, 0, 2, 3, 4, 5)

interface BrowserAction {
  type: 'wait' | 'click' | 'eval' | 'key' | 'sleep' | 'scroll'
  selector?: string
  text?: string
  expression?: string
  key?: string
  code?: string
  modifiers?: number
  ms?: number
  top?: number
  timeoutMs?: number
}

interface CountSpec {
  name: string
  selector: string
}

/**
 * 一条 computed-style 读数。
 *
 * jsdom 不应用样式表、不布局，`text-wrap: balance` / 环形图尺寸这类只剩源码文本可钉；
 * 真 Chromium 读出的值是 CSS 真的生效后的结果。读不到元素时记 null，golden 里是
 * `（缺元素）`——元素被删会红，不会静默当 0。
 */
interface StyleSpec {
  name: string
  selector: string
  props: readonly string[]
}

interface DomShot {
  error?: string
  url?: string
  hash?: string
  pathname?: string
  title?: string
  viewport?: { width: number; height: number; dpr: number }
  counts?: Record<string, number>
  styles?: Record<string, Record<string, string> | null>
  text?: string
  console?: string[]
}

interface Scenario {
  /** golden 文件名（`browser/<slug>.txt`）。 */
  slug: string
  /** 测试名里的渲染面。 */
  title: string
  /** 文件头写清「为什么这个面稳定」。 */
  stable: string
  /** 预置隔离 HOME；调用前 `.dsc` 已建好。 */
  seed(dsc: string): void
  /**
   * 这一场界面看到的「当前工作区」有没有 git 读数（见 {@link seedHostWorkdir}）。
   *
   * 必填：当前会话的 cwd 默认是宿主进程 cwd = 本次检出的仓库根，工作树脏不脏会漏进
   * golden。要画「更改」胶囊 / 分支名的场景给 `dirty-repo`，不该有 Git 读数的场景给
   * `empty`——新加场景时编译器会拦一次，逼作者想清楚这一场依赖哪种现场。
   */
  hostWorkdir: HostWorkdir
  /** 窗口尺寸（窄屏场景用）。 */
  width?: number
  height?: number
  /** 首帧前注入页面的脚本（驱动注册后补一次 reload）；「页面时钟钉死」这类能力走这里。 */
  bootScript?: string
  /**
   * 宿主进程的钉死时刻（毫秒）：给了就用 `--require` 预加载把宿主的 `Date` / `Date.now()`
   * 也钉到这个值。页面侧走 `bootScript`，两侧必须**同一个**锚——否则页面的相对时间会
   * 因为宿主时钟往后跑而变负，整行消失（见 `drivers/pin-host-clock.cjs` 的注释）。
   */
  hostPinnedNow?: number
  actions: BrowserAction[]
  counts: CountSpec[]
  /** 真 Chromium 的 computed style（CSS 残留的替代断言；见 B37-R）。 */
  styles?: readonly StyleSpec[]
  /** 便宜的语义断言：整屏 diff 红之前先看场景意图有没有漂。 */
  expectText?: readonly string[]
}

/** 写一份可用的 config.yaml：模型设置与欢迎页都要它，不写会落在首跑引导态。 */
function writeConfig(dsc: string): void {
  writeFileSync(
    join(dsc, 'config.yaml'),
    [
      'default:',
      '  provider: demo',
      '  model: demo-chat',
      'providers:',
      '  demo:',
      '    displayName: 演示端点',
      '    baseURL: http://127.0.0.1:9/v1',
      '    apiKeyEnv: DSC_DOM_DEMO_KEY',
      '    models:',
      '      - id: demo-chat',
      '        name: Demo Chat',
      '        contextWindow: 128000',
      '        maxTokens: 4096',
      '      - id: demo-reasoner',
      '        name: Demo Reasoner',
      '        contextWindow: 64000',
      '        maxTokens: 8192',
      '  spare:',
      '    displayName: 备用端点',
      '    baseURL: http://127.0.0.1:9/v1',
      '    apiKeyEnv: DSC_DOM_SPARE_KEY',
      '    models:',
      '      - id: spare-chat',
      '        name: Spare Chat',
      '        contextWindow: 32000',
      '        maxTokens: 2048',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** 会话日志落点：`sessions/<slugCwd(cwd)>/<id>.jsonl`（与 `src/core/session.ts` 同口径）。 */
function sessionFile(dsc: string, id: string, cwd = WORK): string {
  const dir = join(dsc, 'sessions', cwd.replace(/[\\/:]+/g, '-'))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.jsonl`)
}

/** 写一份会话日志，并把 mtime 钉到 `updatedAt`（列表排序与「多久以前」都读它）。 */
function writeSession(
  dsc: string,
  id: string,
  records: readonly Record<string, unknown>[],
  updatedAt: number,
  cwd = WORK,
): string {
  const file = sessionFile(dsc, id, cwd)
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  utimesSync(file, new Date(updatedAt), new Date(updatedAt))
  return file
}

/** 一条消息流会话：用户 + 思考 + 工具调用 + 工具结果 + 收尾正文。 */
function messageRecords(): Record<string, unknown>[] {
  return [
    { type: 'meta', id: SESSION_ID, cwd: WORK, createdAt: T0 },
    { type: 'user', text: '看一下 README，然后说说测试层怎么搭。', ts: T0 + 1_000 },
    {
      type: 'assistant',
      text: '',
      reasoning:
        '先确认仓库结构，再读说明文件。测试层分 unit / integration / ui / snapshot / tui 五层，' +
        '浏览器快照只钉 DOM 文本，不钉像素。',
      ts: T0 + 2_000,
    },
    {
      type: 'assistant',
      text: '',
      reasoning: '',
      toolCalls: [
        { id: 'call-readme', name: 'read', arguments: '{"path":"README.md"}' },
      ],
      ts: T0 + 3_000,
    },
    {
      type: 'tool',
      callId: 'call-readme',
      name: 'read',
      text: '# Pneuma\n\n终端 AI 编程助手。\n\n## 测试\n\n五层：unit / integration / ui / snapshot / tui。',
      ts: T0 + 4_500,
    },
    {
      type: 'assistant',
      text: 'README 读完了：测试层按 unit、integration、ui、snapshot、tui 五层分工，快照层负责把渲染面钉成文本。',
      reasoning: '',
      ts: T0 + 6_000,
    },
  ]
}

/** 一条只含审查结论卡的用户消息（B37-R：徽标色与卡片块的真机断言）。 */
function reviewRecords(): Record<string, unknown>[] {
  const body = [
    '<review-findings teammate="writer-1" state="done">',
    '### [P1] 徽标颜色与优先级语义不一致',
    '- 位置：src/packages/ui-primitives/ui/review-findings-card.tsx:61',
    '- 说明：P1 的徽标与 P3 同色，扫一眼分不出优先级。',
    '- 建议：按 priority 分四档取色，并补 computed-style 断言。',
    '### [P3] 卡片说明段的折行偏窄',
    '- 位置：src/packages/ui-renderer/ui/styles/legacy/views.css:13000',
    '</review-findings>',
  ].join('\n')
  return [
    { type: 'meta', id: SESSION_ID, cwd: WORK, createdAt: T0 },
    { type: 'user', text: body, ts: T0 + 1_000 },
  ]
}

/** 名册：只放一位收工的队友；`sessionId` 与种子会话的 meta.id 对齐，状态面板才认得它。 */
function writeRoster(dsc: string, file: string): void {
  mkdirSync(join(dsc, 'team'), { recursive: true })
  writeFileSync(
    join(dsc, 'team', 'roster.json'),
    `${JSON.stringify(
      {
        teammates: [
          {
            name: 'writer-1',
            role: 'writer',
            state: 'idle',
            task: '写浏览器快照的说明',
            file,
            cwd: WORK,
            parent: 'lead',
            depth: 1,
            rounds: 2,
            mode: 'continuable',
            startedAt: T0 + 10_000,
            finishedAt: T0 + 75_000,
            sessionId: SESSION_ID,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

/** 队友运行记录：只读视图按普通会话日志重放。 */
function writeTeammateLog(dsc: string): string {
  const dir = join(dsc, 'sessions', '.teammates')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'writer-1.jsonl')
  const records: Record<string, unknown>[] = [
    { type: 'meta', id: '22222222-2222-4222-8222-222222222222', cwd: WORK, createdAt: T0 + 10_000 },
    { type: 'user', text: '写浏览器快照的说明：先说为什么选 DOM 文本，再说归一化边界。', ts: T0 + 11_000 },
    {
      type: 'assistant',
      text: '先写「为什么不是像素」这一段，再补归一化规则表。',
      reasoning: '',
      ts: T0 + 20_000,
    },
  ]
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  utimesSync(file, new Date(T0 + 75_000), new Date(T0 + 75_000))
  return file
}

/**
 * 快照的「今天」：钉死的时刻（本地正午）。热力图这类按真实日期铺格子的读数以它为锚，
 * golden 才不会随真实日历每天挪一格——2026-11-17 起实测跨天必红：网格从「今天」回溯、
 * 按周日对齐、尾部半列照收，`usage.heat.cells` 与 `dom.elements` 每天都 +1。
 * 种子与页面时钟（`bootScript`）都用同一锚，场景内的时间函数全部确定。
 */
const SNAP_NOW = Date.parse('2026-11-17T04:00:00Z') // +08:00 本地正午

/**
 * 种子 git 现场的分支名。golden 里归一成 `<branch>`（见 `normalizeDom`），与检出目录
 * 当前分支共用同一个占位符——两份都是「分支名」，换条分支跑不该红。
 */
const FIXTURE_BRANCH = 'snapshot-fixture'

/** 种子仓库初始提交的时刻：固定值，让仓库本身也可复现（提交哈希不进 DOM）。 */
const FIXTURE_COMMIT_AT = '2025-01-02T03:04:05Z'

/**
 * 给 git 子进程用的环境：剥掉继承来的 `GIT_*`（`GIT_DIR` 是 git worktree 的常规变量，
 * 留着会把种子命令带到别人的仓里），再叠固定的作者 / 提交时刻。
 *
 * 还要把**全局 / 系统级 git 配置**挡掉（`GIT_CONFIG_GLOBAL` 指向空文件 +
 * `GIT_CONFIG_NOSYSTEM=1`）：跑测试的人若在 `~/.gitconfig` 开了 `commit.gpgsign`、
 * 配了 `core.hooksPath` 或 `init.templateDir`，种子 `git commit` 会失败甚至挂住——那是
 * 机器配置问题，却会让 7 个 dirty 场景硬红（2026-11-17 验收 F2）。空配置下只剩本仓
 * `git config` 设的用户名与邮箱，行为与机器无关。
 *
 * @param emptyConfig - 空 git 配置文件路径（放在种子目录外、隔离 HOME 里）
 */
function fixtureGitEnv(emptyConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toUpperCase().startsWith('GIT_')) continue
    env[key] = value
  }
  return {
    ...env,
    GIT_AUTHOR_DATE: FIXTURE_COMMIT_AT,
    GIT_COMMITTER_DATE: FIXTURE_COMMIT_AT,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // 双保险：即使有别的配置来源把签名打开，也不让 commit 等用户输入。
    GIT_TERMINAL_PROMPT: '0',
  }
}

/**
 * 宿主启动时的工作目录现场：决定界面看到的**当前工作区有没有 git 读数**。
 *
 * - `dirty-repo`：种子造的临时 git 仓库（固定分支 + 固定两条未提交改动）→ 状态面板收起
 *   胶囊那行「更改」与输入框上方分支名恒出现；
 * - `empty`：只是一个空目录（不是 git 仓库）→ 状态面板不挂 Git 区、输入框上方没有分支名。
 *
 * 为什么必须有它（见 {@link seedHostWorkdir}）：界面读的是**宿主进程 cwd**，也就是本次
 * 检出的仓库根；不钉的话 golden 只能钉在「录的那一刻恰好脏 / 干净」。
 */
type HostWorkdir = 'dirty-repo' | 'empty'

/**
 * 造「界面所处状态」由场景自己决定的宿主工作目录，并让宿主在它里面启动。
 *
 * 为什么必须造：状态面板收起胶囊那行「更改」、输入框上方的分支名，读的都是**当前会话工作
 * 目录**的 git 状态；而当前会话（还没发过消息那条）的 cwd 来自宿主进程的 cwd
 * （`src/host/kernel.ts:47`）——本次检出的仓库根。它脏不脏取决于跑测试的人手上有没有未提交
 * 改动，golden 因此只能钉在「录的那一刻恰好脏 / 干净」：干净时状态面板整块不挂，
 * `dom.buttons` 少 5、`dom.elements` 少 53，那行「更改」也消失（反之亦然）。
 *
 * 修法：宿主是子进程（`tests/e2e/support/host.ts:102`），测试进程改不了它的 cwd；这里用
 * `node --require` 预加载（`drivers/pin-host-cwd.cjs`，与钉时钟同一套机制）在宿主启动前
 * `process.chdir()` 到种子目录。目录名与检出目录同名（侧栏工作区分组画的就是它，归一成
 * `<repo>`），所以 golden 的分组行不随机器变。
 *
 * `dirty-repo` 另外固定两件事：分支名 {@link FIXTURE_BRANCH}（归一成 `<branch>`），以及
 * 两条未提交改动（已跟踪的 `README.md` 改一行 + 未跟踪的 `notes.txt`）。当前会话仍是
 * 「没落盘的空会话」（不恢复任何会话文件），欢迎页与侧栏回执那一行照旧。
 *
 * @returns 种子目录的绝对路径（交给预加载当 `DSC_DOM_HOST_CWD`）。
 */
function seedHostWorkdir(home: string, mode: HostWorkdir): string {
  const dir = join(home, basename(ROOT))
  mkdirSync(dir, { recursive: true })
  if (mode === 'empty') return dir
  // 空 git 配置：挡掉宿主机的 ~/.gitconfig 与系统配置（理由见 {@link fixtureGitEnv}）。
  const emptyConfig = join(home, '.gitconfig-empty')
  if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, '', 'utf8')
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, env: fixtureGitEnv(emptyConfig), stdio: 'ignore' })
  }
  run('init', '-b', FIXTURE_BRANCH)
  run('config', 'user.email', 'snapshot@example.invalid')
  run('config', 'user.name', 'Snapshot Fixture')
  const readme = '# 快照种子仓库\n\n这个仓库由 `tests/snapshots/browser/dom.snapshot.ts` 现造。\n'
  writeFileSync(join(dir, 'README.md'), readme, 'utf8')
  run('add', 'README.md')
  run('-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'fixture: 初始提交')
  // 固定的一组未提交改动：一条已跟踪、一条未跟踪。worktree 与 index 的差就是它。
  writeFileSync(join(dir, 'README.md'), `${readme}\n未提交的一行。\n`, 'utf8')
  writeFileSync(join(dir, 'notes.txt'), '未跟踪的种子文件\n', 'utf8')
  return dir
}

/** 把页面 `Date` 钉死在 SNAP_NOW：`new Date()` 与 `Date.now()` 走固定值，parse/UTC/带参构造不动。 */
const PIN_CLOCK_BOOT = `(() => {
  const fixed = ${String(SNAP_NOW)}
  class PinnedDate extends Date {
    constructor(...args) { args.length === 0 ? super(fixed) : super(...args) }
    static now() { return fixed }
  }
  window.Date = PinnedDate
})()`

/** 用量流水：近七天的固定条数，热力图、趋势、环形图都有数据。 */
function writeUsage(dsc: string): void {
  const dir = join(dsc, 'usage')
  mkdirSync(dir, { recursive: true })
  const rows = Array.from({ length: 7 }, (_, index) => {
    const at = new Date(SNAP_NOW - (index + 1) * 86_400_000)
    at.setHours(10, 0, 0, 0)
    return {
      t: at.getTime(),
      provider: 'demo',
      model: index % 2 === 0 ? 'demo-chat' : 'demo-reasoner',
      i: 12_000 + index * 500,
      o: 900 + index * 40,
      ch: 4_000,
      cm: 500,
      sid: SESSION_ID,
    }
  })
  writeFileSync(join(dir, 'usage.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

/** 启用一个默认关闭的内置插件（条目树格式见 `core/plugin-registry.ts` 的 `readPluginEntries`）。 */
function enablePlugin(dsc: string, file: string): void {
  writeFileSync(
    join(dsc, 'plugins.json'),
    `${JSON.stringify({ version: 1, entries: [{ file, disabled: false, config: {} }] }, null, 2)}\n`,
    'utf8',
  )
}

/** 三个会话：标题来自首条用户消息，排序按 mtime（固定间隔）。 */
function seedSessions(dsc: string): void {
  const now = Date.now()
  writeSession(
    dsc,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    [
      { type: 'meta', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: WORK, createdAt: now - 7_200_000 },
      { type: 'user', text: '把浏览器快照层的设计写成一份说明', ts: now - 7_200_000 },
      { type: 'assistant', text: '好，先列大纲。', reasoning: '', ts: now - 7_100_000 },
    ],
    now - 7_000_000,
  )
  writeSession(
    dsc,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    [
      { type: 'meta', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cwd: WORK, createdAt: now - 172_800_000 },
      { type: 'user', text: '检查快照两遍是否逐字节一致', ts: now - 172_800_000 },
      { type: 'assistant', text: '我跑两遍再比。', reasoning: '', ts: now - 172_700_000 },
    ],
    now - 172_000_000,
  )
  writeSession(
    dsc,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    [
      { type: 'meta', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', cwd: WORK, createdAt: now - 259_200_000 },
      { type: 'user', text: '给移动端布局补一条窄屏快照', ts: now - 259_200_000 },
      { type: 'assistant', text: '窄屏靠视口宽区分，不需要 UA。', reasoning: '', ts: now - 259_100_000 },
    ],
    now - 259_000_000,
  )
}

const SCENARIOS: readonly Scenario[] = [
  {
    slug: '01-welcome-empty',
    title: '欢迎页（空会话 + 仅当前未落盘会话）',
    stable:
      '当前会话的工作目录是种子造的临时 git 仓库（目录名与检出目录同名，归一成 `<repo>`；' +
      '分支固定、归一成 `<branch>`；未提交改动固定两条），所以状态面板收起胶囊那行「更改」与' +
      '输入框上方分支名恒出现，不随跑测试时的工作树脏不脏变化。欢迎页只有四张静态能力卡与' +
      '输入框；招呼语按现在几点六选一（归一化成 `<greeting>`），版本号、仓库目录名与相对时间' +
      '也已归一。侧栏只有当前这条“还没发过消息”的会话回执，没有历史会话、没有用量。',
    seed: (dsc) => {
      writeConfig(dsc)
    },
    hostWorkdir: 'dirty-repo',
    actions: [
      { type: 'wait', selector: '.welcome' },
      { type: 'wait', selector: '.welcome-card' },
    ],
    counts: [
      { name: 'welcome.cards', selector: '.welcome-card' },
      { name: 'sessions.rows', selector: '.sess-item' },
      { name: 'sidebar', selector: '.sidebar' },
    ],
    styles: [
      // B37-R：`text-wrap: balance` 只剩源码文本钉；真 Chromium 读 computed style 才是行为断言。
      { name: 'welcome.h1', selector: '.welcome h1', props: ['text-wrap', 'line-height'] },
    ],
    expectText: ['看懂代码', '做点东西', '审查改动'],
  },
  {
    slug: '02-session-list',
    title: '会话列表（三条种子会话 + 接着上次）',
    stable:
      '当前会话的工作目录是种子造的临时 git 仓库（目录名与检出目录同名，归一成 `<repo>`；' +
      '分支与两条未提交改动都是固定值，状态面板的「更改」胶囊恒出现）。会话标题来自种子的' +
      '首条用户消息，分组按固定 cwd（`D:\\dom-work`），排序按固定 mtime；行尾相对时间归一成' +
      '`<time>`，空会话首屏的“接着上次”卡片只挑最近七天内最早更新的一条。',
    seed: (dsc) => {
      writeConfig(dsc)
      seedSessions(dsc)
    },
    hostWorkdir: 'dirty-repo',
    actions: [
      { type: 'wait', selector: '.sess-item' },
      // 种子会话在另一个工作区分组里，默认收起；展开它才看得到三条历史。
      { type: 'click', selector: '.group-row', text: 'dom-work' },
      {
        type: 'eval',
        expression:
          "const until = Date.now() + 10000; const wanted = ['把浏览器快照层的设计写成一份说明', '检查快照两遍是否逐字节一致', '给移动端布局补一条窄屏快照']; while (Date.now() < until && !wanted.every((text) => document.body.innerText.includes(text))) { await new Promise((r) => setTimeout(r, 100)); } return true;",
      },
      { type: 'wait', selector: '.welcome-resume' },
    ],
    counts: [
      { name: 'sessions.rows', selector: '.sess-item' },
      { name: 'sessions.groups', selector: '.group' },
      { name: 'welcome.resume', selector: '.welcome-resume' },
    ],
    expectText: ['把浏览器快照层的设计写成一份说明', '检查快照两遍是否逐字节一致', '给移动端布局补一条窄屏快照'],
  },
  {
    slug: '03-message-flow',
    title: '消息流（展开整轮，含思考与工具卡）',
    stable:
      '种子记录的时间戳与工具耗时都是固定值；展开的是同一棵已渲染的 DOM。工具结果与思考正文' +
      '来自种子文件本身，没有流式增量，因此整屏文本在静置后不再变化。',
    seed: (dsc) => {
      writeConfig(dsc)
      writeSession(dsc, SESSION_ID, messageRecords(), T0 + 5_000)
    },
    // 点开的是种子会话（cwd = 不存在的 `D:\dom-work`），本来就没有 Git 读数；宿主起始
    // 工作目录也钉成非仓库的空目录，避免开跑那一拍把本次检出的工作树状态带进来。
    hostWorkdir: 'empty',
    actions: [
      { type: 'wait', selector: '.sess-item' },
      // 种子会话在另一个工作区分组里，默认收起。
      { type: 'click', selector: '.group-row', text: 'dom-work' },
      { type: 'click', selector: '.sess-item', text: '看一下 README' },
      { type: 'wait', selector: '.chat-inner' },
      { type: 'wait', selector: '.turn-fold' },
      { type: 'click', selector: '.turn-fold' },
      // 标准档把过程按阶段分组，组默认收起；先展开阶段组，思考行与工具卡才进 innerText。
      { type: 'wait', selector: '.step-fold' },
      { type: 'click', selector: '.step-fold' },
      {
        type: 'eval',
        expression:
          "const until = Date.now() + 10000; while (Date.now() < until && !document.body.innerText.includes('思考')) { await new Promise((r) => setTimeout(r, 100)); } return true;",
      },
      { type: 'wait', selector: '.think-block' },
      { type: 'click', selector: '.think-head' },
      {
        type: 'eval',
        expression:
          "const until = Date.now() + 10000; while (Date.now() < until && !document.body.innerText.includes('先确认仓库结构')) { await new Promise((r) => setTimeout(r, 100)); } return true;",
      },
      { type: 'wait', selector: '.tool-card' },
      { type: 'click', selector: '.tool-click' },
      {
        type: 'eval',
        expression:
          "const until = Date.now() + 10000; while (Date.now() < until && !document.body.innerText.includes('终端 AI 编程助手')) { await new Promise((r) => setTimeout(r, 100)); } return true;",
      },
      { type: 'wait', selector: '.tool-body' },
    ],
    counts: [
      { name: 'transcript.user', selector: '.entry-user' },
      { name: 'transcript.tool', selector: '.entry.tool-card' },
      { name: 'transcript.think', selector: '.think-block' },
      { name: 'transcript.text', selector: '.entry-text' },
      { name: 'sessions.rows', selector: '.sess-item' },
    ],
    expectText: ['测试层按 unit、integration、ui、snapshot、tui 五层分工', '先确认仓库结构', '读取'],
  },
  {
    slug: '04-settings-models',
    title: '设置-模型（两个端点 + 三个模型）',
    stable:
      '端点与模型全部来自种子 config.yaml；密钥状态只看环境变量在不在（本次不设）；' +
      '配置路径里的隔离 HOME 归一成 `<TMP>`，版本号归一成 `<version>`。当前会话的 git 现场' +
      '也来自种子仓库（固定分支 + 固定两条未提交改动），侧栏「更改」胶囊恒出现。',
    seed: (dsc) => {
      writeConfig(dsc)
    },
    hostWorkdir: 'dirty-repo',
    actions: [
      { type: 'wait', selector: '.app' },
      {
        type: 'eval',
        expression: "window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'models' } })); return true",
      },
      { type: 'wait', selector: '.settings' },
      { type: 'wait', selector: '.models-page' },
      { type: 'wait', selector: '.models-rail-item' },
    ],
    counts: [
      { name: 'settings.nav', selector: '.settings-nav-item' },
      { name: 'models.rail', selector: '.models-rail-item' },
      { name: 'models.page', selector: '.models-page' },
    ],
    expectText: ['默认模型', '端点', '演示端点', '备用端点', 'demo-chat', 'demo-reasoner'],
  },
  {
    slug: '05-settings-usage',
    title: '设置-用量（热力图 + 趋势 + 环形图）',
    stable:
      '页面时钟钉死在 SNAP_NOW（2026-11-17 本地正午），用量流水按固定日期种子生成：' +
      '热力图按「今天」回溯铺格，格子数与元素总数不再随真实日历逐日漂移（2026-11-17 跨天必红的根因）；' +
      '汇总值（总 token / 活跃天数 / 缓存命中）只随种子变化；日期与月标签是时间函数，归一成 `<date>` / `<month>`。' +
      '当前会话的 git 现场也来自种子仓库（固定分支 + 固定两条未提交改动），侧栏「更改」胶囊恒出现。',
    seed: (dsc) => {
      writeConfig(dsc)
      writeUsage(dsc)
    },
    hostWorkdir: 'dirty-repo',
    bootScript: PIN_CLOCK_BOOT,
    // 宿主进程的时钟也钉到同一个 SNAP_NOW：侧栏「当前未落盘会话」的 createdAt 来自宿主
    // 进程（`Session.create` 的 `Date.now()`），只钉页面会让页面的相对时间变成负数，
    // 那一行的 `<time>` 从 2026-11-17 本地正午起整行消失（详见 pin-host-clock.cjs）。
    hostPinnedNow: SNAP_NOW,
    actions: [
      { type: 'wait', selector: '.app' },
      {
        type: 'eval',
        expression: "window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'usage' } })); return true",
      },
      { type: 'wait', selector: '.settings' },
      { type: 'wait', selector: '.usage' },
      { type: 'wait', selector: '.hm-grid' },
    ],
    counts: [
      { name: 'usage.cards', selector: '.usage-card' },
      { name: 'usage.heat.cells', selector: '.hm-cell' },
      { name: 'usage.trend', selector: '.trend-svg' },
      { name: 'usage.donut', selector: '.donut-svg' },
    ],
    styles: [
      // B37-R：环形图的宽高来自 CSS/媒体查询，jsdom 量不到。
      { name: 'usage.donut', selector: '.donut-svg', props: ['width', 'height'] },
      { name: 'usage.card', selector: '.usage-card', props: ['border-radius'] },
    ],
    expectText: ['Token 活动', '每日 Token 趋势', '模型用量', '累计 Token', '活跃天数'],
  },
  {
    slug: '06-plugin-center',
    title: '插件中心（整页）',
    stable:
      '插件清单来自随包发布的 manifest 与 plugins.json 的默认状态，场景不装任何用户插件；' +
      '版本号归一成 `<version>`，插件行的顺序由清单 order 固定。',
    seed: (dsc) => {
      writeConfig(dsc)
    },
    // 插件中心没有输入框与状态胶囊，但侧栏分组画的是当前工作区；钉成非仓库的空目录，
    // 让「有没有 Git 读数」也只由场景决定。
    hostWorkdir: 'empty',
    actions: [
      { type: 'wait', selector: '.nav-item' },
      { type: 'click', selector: '.nav-item', text: '插件' },
      { type: 'wait', selector: '.plugins' },
      { type: 'wait', selector: '.plugin-row' },
    ],
    counts: [
      { name: 'plugins.rows', selector: '.plugin-row' },
      { name: 'plugins.groups', selector: '.plugin-group-label' },
      { name: 'plugins.page', selector: '.plugins-inner' },
    ],
    expectText: ['插件', '官方', '界面单元', '内核', '停用'],
  },
  {
    slug: '07-command-palette',
    title: '命令面板（动作清单）',
    stable:
      '面板列出静态动作表与「最近会话」组里的当前会话；动作来自各插件注册，顺序稳定。' +
      '当前会话的工作目录是种子造的临时 git 仓库（目录名与检出目录同名，归一成 `<repo>`；' +
      '固定分支与固定两条未提交改动），面板打开后焦点在搜索框，输入内容不进 DOM。',
    seed: (dsc) => {
      writeConfig(dsc)
    },
    hostWorkdir: 'dirty-repo',
    actions: [
      { type: 'wait', selector: '.app' },
      { type: 'eval', expression: "window.dispatchEvent(new CustomEvent('shell.palette.open')); return true" },
      { type: 'wait', selector: '.palette' },
      { type: 'wait', selector: '.palette-row' },
    ],
    counts: [
      { name: 'palette.rows', selector: '.palette-row' },
      { name: 'palette.groups', selector: '.palette-group' },
      { name: 'palette.visible', selector: '.palette' },
    ],
    expectText: ['新会话', '设置', '技能', '插件'],
  },
  {
    slug: '08-subagent-reader',
    title: '子代理/队友页（状态面板 → 只读运行记录）',
    stable:
      '名册与队友日志都是种子文件；当前会话 cwd 指向不存在的 `D:\\dom-work`，状态面板因此没有 ' +
      'Git 读数（不会把工作树脏文件数带进 golden）；队友耗时用固定的 startedAt/finishedAt。',
    seed: (dsc) => {
      writeConfig(dsc)
      // `subagent` 出厂是关的：不开它，`listTeammates` 直接返回空表，状态面板没有名册可点。
      enablePlugin(dsc, 'subagent')
      writeSession(dsc, SESSION_ID, messageRecords(), T0 + 5_000)
      const mateFile = writeTeammateLog(dsc)
      writeRoster(dsc, mateFile)
    },
    // 点开的是种子会话（cwd = 不存在的 `D:\dom-work`），本来就没有 Git 读数；宿主起始
    // 工作目录也钉成非仓库的空目录，保证开跑那一拍也没有。
    hostWorkdir: 'empty',
    actions: [
      { type: 'wait', selector: '.sess-item' },
      // 种子会话在另一个工作区分组里，默认收起。
      { type: 'click', selector: '.group-row', text: 'dom-work' },
      { type: 'click', selector: '.sess-item', text: '看一下 README' },
      { type: 'wait', selector: '.chat-inner' },
      { type: 'wait', selector: '.sp-mini' },
      { type: 'click', selector: '.sp-mini' },
      { type: 'wait', selector: '.sp-section[data-sp-section="agent"]' },
      { type: 'wait', selector: '.sp-row-open[data-sp-agent="writer-1"]' },
      { type: 'click', selector: '.sp-row-open[data-sp-agent="writer-1"]' },
      { type: 'wait', selector: '.team-reader' },
    ],
    counts: [
      { name: 'team.rows', selector: '.sp-row-agent' },
      { name: 'team.reader', selector: '.team-reader' },
      { name: 'team.reader.entries', selector: '.team-reader-body .entry-row' },
    ],
    expectText: ['writer-1', '写浏览器快照的说明', '先写「为什么不是像素」这一段'],
  },
  {
    slug: '09-dock-panel',
    title: 'dock 面板（右侧栏 + 开始页）',
    stable:
      'dock 默认收起、内含一张 guide 页签；点开只改变展开态。guide 的四张入口卡与快捷键' +
      '都是静态文案，不随会话或用量变化。当前会话的工作目录是种子造的临时 git 仓库' +
      '（固定分支 + 固定两条未提交改动），「更改」胶囊恒出现。',
    seed: (dsc) => {
      writeConfig(dsc)
    },
    hostWorkdir: 'dirty-repo',
    actions: [
      { type: 'wait', selector: '.dock-toggle' },
      { type: 'click', selector: '.dock-toggle' },
      { type: 'wait', selector: '.dock' },
      { type: 'wait', selector: '.dock-guide' },
    ],
    counts: [
      { name: 'dock.panes', selector: '.dock-pane' },
      { name: 'dock.tabs', selector: '.dock-tab' },
      { name: 'dock.guide.cards', selector: '.dock-guide-entry' },
      { name: 'dock.strip', selector: '.dock-strip' },
    ],
    expectText: ['文件', '终端', '浏览器', 'Git'],
  },
  {
    slug: '10-mobile-layout',
    title: '窄屏（mobile）布局',
    stable:
      '视口宽 420 落在 `max-width: 860px` 断点内，壳走 narrow 分支：侧栏不画、导航挂在顶栏、' +
      '正文页签行收起。断点判定只读视口宽，与 UA 无关；招呼语归一成 `<greeting>`。' +
      '当前会话的工作目录是种子造的临时 git 仓库（固定分支 + 固定两条未提交改动），' +
      '「更改」胶囊恒出现。',
    width: 420,
    height: 860,
    seed: (dsc) => {
      writeConfig(dsc)
    },
    hostWorkdir: 'dirty-repo',
    actions: [
      { type: 'wait', selector: '.app' },
      { type: 'wait', selector: '.topbar-nav-btn' },
      { type: 'wait', selector: '.welcome' },
    ],
    counts: [
      { name: 'mobile.topbarNav', selector: '.topbar-nav-btn' },
      { name: 'mobile.search', selector: '.topbar-search' },
      { name: 'welcome.cards', selector: '.welcome-card' },
      { name: 'sessions.rows', selector: '.sess-item' },
    ],
    expectText: ['看懂代码', '做点东西'],
  },
  {
    slug: '11-review-findings',
    title: '审查结论卡（review-findings）',
    stable:
      '用户消息里的 `<review-findings>` 块由壳解析成卡片：徽标、标题、位置、说明都来自种子文本；' +
      '卡片不带流式状态，静置后 DOM 与 computed style 都不再变化（B37-R 的徽标色改量真值）。',
    seed: (dsc) => {
      writeConfig(dsc)
      writeSession(dsc, SESSION_ID, reviewRecords(), T0 + 5_000)
    },
    // 点开的是种子会话（cwd = 不存在的 `D:\dom-work`），本来就没有 Git 读数；宿主起始
    // 工作目录也钉成非仓库的空目录，保证开跑那一拍也没有。
    hostWorkdir: 'empty',
    actions: [
      { type: 'wait', selector: '.sess-item' },
      { type: 'click', selector: '.group-row', text: 'dom-work' },
      { type: 'click', selector: '.sess-item', text: 'review-findings' },
      { type: 'wait', selector: '.review-findings' },
      { type: 'wait', selector: '.review-finding-badge' },
    ],
    counts: [
      { name: 'review.cards', selector: '.review-findings' },
      { name: 'review.findings', selector: '.review-finding' },
      { name: 'review.badges', selector: '.review-finding-badge' },
    ],
    styles: [
      // B37-R 的四档徽标色：真 Chromium 读出 priority=1 与 priority=3 的实际颜色。
      { name: 'review.badge.p1', selector: '.review-finding[data-priority="P1"] .review-finding-badge', props: ['color', 'background-color', 'font-size', 'border-radius'] },
      { name: 'review.badge.p3', selector: '.review-finding[data-priority="P3"] .review-finding-badge', props: ['color', 'background-color', 'font-size', 'border-radius'] },
      { name: 'review.card', selector: '.review-findings', props: ['border-radius', 'padding-left'] },
    ],
    expectText: ['徽标颜色与优先级语义不一致', '卡片说明段的折行偏窄', 'P1', 'P3'],
  },
]

/**
 * 当前 git 分支：状态栏会显示宿主 cwd 的分支名（`startUiHost` 固定以仓库根为 cwd）。
 *
 * 快照 golden 进版本库后会在 `main` 与特性分支上跑；分支名不是被测内容，归一成
 * `<branch>`，否则同一份 DOM 换条分支就红。
 */
function currentBranch(): string {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * 仓库目录名：宿主当前会话落在仓库根，侧栏会把它作为工作区分组画出来。
 *
 * 工作树目录名随机器变化（本机叫 `testing`，主树叫 `dsc`，CI 叫 checkout 目录名），
 * 不是被测内容，归一成 `<repo>`。
 */
const REPO_NAME = basename(ROOT)

/** 正则转义（路径先换占位符，正则在 `normalizeDom` 里用）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 一条路径的三种写法：原生、正斜杠、反斜杠（Windows 上三者都可能出现）。 */
function pathVariants(path: string): string[] {
  return [...new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])]
}

/**
 * 把无常项折成占位符；每条规则都有明确理由。
 *
 * - 隔离 HOME / 临时目录：每次 `mkdtemp` 都不同，整段换成 `<TMP>`；
 * - 种子工作目录：宿主被钉在 `<home>/<检出目录名>` 里跑，界面会把它当「当前工作区」画
 *   出来（命令面板的「最近会话」直接给完整路径），换成 `<repo>`——与检出目录同义的占位符；
 * - 界面令牌：入口地址带 `?token=`，出现在标题或诊断行时不能进 golden；
 * - 会话 id / uuid：种子自己固定，但产品会在 DOM 里回显别的 id，统一折；
 * - 招呼语：按现在几点六选一，跨时段跑会红；
 * - 版本号：每次发版都变，版本一致性另有闸（根 package.json 与 tag），快照层不重复承担；
 * - 日期 / 时间 / 相对时间：种子按「相对今天」铺用量，日期标签是时间函数；
 * - 耗时读数：工具卡与队友卡的 `1.2s` / `1m4s` 来自时钟，不是业务文本。
 */
function normalizeDom(text: string, home: string, branch: string, workdir: string | null): string {
  let out = text.replace(/\r\n/g, '\n')
  // 种子工作目录在 home 下面，先折它——否则整段先被 `<TMP>` 吞掉。
  if (workdir !== null) for (const variant of pathVariants(workdir)) out = out.split(variant).join('<repo>')
  for (const variant of pathVariants(home)) out = out.split(variant).join('<TMP>')
  for (const variant of pathVariants(ROOT)) out = out.split(variant).join('<repo>')
  for (const variant of pathVariants(tmpdir())) {
    out = out.replace(new RegExp(`${escapeRegExp(variant)}[^\\s"'\`，。、；：（）,;:()\\[\\]{}<>]*`, 'gi'), '<TMP>')
  }
  // 分支名在状态栏里是独占一行；不要用子串替换（分支叫 `main` 时会把英文文本里的
  // `main` 一起吞掉）。目录名同理，见下。
  // 两个来源：检出目录的当前分支（`currentBranch()`）与种子仓库的固定分支
  // （`FIXTURE_BRANCH`）——都是「分支名」，golden 里共用 `<branch>`。
  for (const name of new Set([branch, FIXTURE_BRANCH])) {
    if (name !== '') out = out.replace(new RegExp(`^${escapeRegExp(name)}$`, 'gm'), '<branch>')
  }
  if (REPO_NAME.length > 2) out = out.replace(new RegExp(`^${escapeRegExp(REPO_NAME)}$`, 'gm'), '<repo>')
  out = out.replace(/token=[A-Za-z0-9_-]+/g, 'token=<token>')
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
  out = out.replace(
    /早上好，说说今天要做什么|上午好，有事直接说|中午好，先去吃个饭|下午好，剩下的交给我|晚上好，今天到这儿也行|夜深了，明天再弄/g,
    '<greeting>',
  )
  // 版本号必须带 `v` 前缀：不带前缀的三段数字会把 `127.0.0.1` 这类地址误吞进来。
  out = out.replace(/\bv\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g, '<version>')
  out = out.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
  out = out.replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, '<date>')
  // 中文日期与月标签没有「词边界」（月/日是 CJK，`\b` 在它们后面不成立），不能用 \b 收尾。
  out = out.replace(/近\s*\d+\s*[天日]/g, '近 <days>')
  out = out.replace(/\d{1,2} 月 \d{1,2} 日/g, '<date>')
  out = out.replace(/\b\d{1,2}\/\d{1,2}\b/g, '<date>')
  out = out.replace(/\d{1,2}月/g, '<month>')
  out = out.replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, '<time>')
  // 耗时读数先于相对时间：`用时 5 秒` 要折成 `<elapsed>`，不能被相对时间的「N 秒」规则吞成 `<time>`。
  out = out.replace(/(已用|用时)\s*\d+\s*分\s*\d+\s*秒/g, '$1 <elapsed>')
  out = out.replace(/(已用|用时)\s*\d+\s*秒/g, '$1 <elapsed>')
  out = out.replace(/\d+分\d+秒/g, '<elapsed>')
  out = out.replace(/\d+秒/g, '<elapsed>')
  // 相对时间在会话列表里写作「2天」「1小时」（数字与单位之间**没有空格**）；但首屏
  // 「接着上次」卡片写的是「2 小时前」，单位前有空格。用量卡片的「活跃 7 天」没有
  // 「前」，不能一起折——否则那几张卡的数字就被 golden 放过了。
  out = out.replace(/\d+\s*(?:秒钟?|分钟|小时|天|周|个月|年)前/g, '<time>')
  out = out.replace(/刚刚|\d+(?:秒钟?|分钟|小时|天|周|个月|年)前?/g, '<time>')
  out = out.replace(/\b\d+m\d+s\b/g, '<elapsed>')
  out = out.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '<elapsed>')
  return out.replace(/\n+$/, '')
}

/** 把一次真机读数转成 golden 文本：场景说明 + hash + 计数 + 整页文本。 */
function toGolden(scenario: Scenario, shot: DomShot, home: string, branch: string, workdir: string | null): string {
  const counts = Object.entries(shot.counts ?? {}).sort(([left], [right]) => left.localeCompare(right))
  const styleLines = Object.entries(shot.styles ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, props]) =>
      props === null
        ? [`#   ${name} = （缺元素）`]
        : Object.entries(props)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([prop, value]) => `#   ${name}.${prop} = ${value}`),
    )
  const header = [
    `# 场景：${scenario.title}`,
    `# 稳定：${scenario.stable}`,
    `# hash：${shot.hash === undefined || shot.hash === '' ? '（空）' : shot.hash}`,
    '# 计数：',
    ...counts.map(([name, value]) => `#   ${name} = ${String(value)}`),
    ...(styleLines.length === 0 ? [] : ['# 样式（真 Chromium computed style）：', ...styleLines]),
  ]
  return normalizeDom([...header, '', shot.text ?? ''].join('\n'), home, branch, workdir)
}

/** 一个场景的一轮真机。 */
async function runScenario(scenario: Scenario): Promise<void> {
  const { home, dsc } = mkdtempHome(`dsc-dom-${scenario.slug}-`)
  mkdirSync(dsc, { recursive: true })
  // 会话根必须先存在：`listSessions()` 读它，目录不在时列表刷新直接失败（空态会「看不见当前
  // 这条未落盘会话」），同一场景第二次跑就可能因为时序差出一行。
  mkdirSync(join(dsc, 'sessions'), { recursive: true })
  let host: UiHost | null = null
  try {
    scenario.seed(dsc)
    // 宿主的启动工作目录（必填）：界面看到的「当前工作区」因此由场景决定，不是本次检出。
    const workdir = seedHostWorkdir(home, scenario.hostWorkdir)
    // 两处预加载可能同时要（05：钉时钟 + 钉工作目录），合并到同一条 NODE_OPTIONS 里。
    const preloads: string[] = [HOST_CWD_PRELOAD]
    const preloadEnv: Record<string, string> = { DSC_DOM_HOST_CWD: workdir }
    if (scenario.hostPinnedNow !== undefined) {
      preloads.push(HOST_CLOCK_PRELOAD)
      preloadEnv['DSC_DOM_HOST_NOW'] = String(scenario.hostPinnedNow)
    }
    const cdpPort = await freePort()
    host = await startUiHost({
      label: scenario.slug,
      envExtra: {
        HOME: home,
        USERPROFILE: home,
        DSC_HOME: dsc,
        // 端点解析要求 apiKeyEnv 真有值；给假串只是为了“已配置”这一支，不发请求。
        DSC_DOM_DEMO_KEY: 'dom-demo-key',
        DSC_DOM_SPARE_KEY: 'dom-spare-key',
        ...(preloads.length === 0 ? {} : hostPreloadEnv(preloads, preloadEnv)),
      },
    })
    const resultPath = join(home, 'dom-shot.json')
    // 所有场景共用的一拍：会话列表先刷出来（当前未落盘会话那一行）。
    // 少了它，侧栏可能停在「还没有历史会话」的初帧，同一场景两次跑差一行——这是
    // 本批真机第一次跑就撞到的竞态（refreshSessions 是异步的）。
    const actions: BrowserAction[] = [
      { type: 'wait', selector: '.sess-item', timeoutMs: 25_000 },
      ...scenario.actions,
    ]
    const shot = (await runElectronDriver({
      driver: DRIVER,
      url: host.url,
      resultPath,
      timeoutMs: 180_000,
      envExtra: {
        DSC_DOM_RESULT: resultPath,
        DSC_DOM_CDP_PORT: String(cdpPort),
        DSC_DOM_USER_DATA: electronUserData(home),
        DSC_DOM_ACTIONS: JSON.stringify(actions),
        DSC_DOM_COUNTS: JSON.stringify(scenario.counts),
        DSC_DOM_STYLES: JSON.stringify(scenario.styles ?? []),
        DSC_DOM_WIDTH: String(scenario.width ?? 1280),
        DSC_DOM_HEIGHT: String(scenario.height ?? 860),
        ...(scenario.bootScript === undefined ? {} : { DSC_DOM_BOOT_SCRIPT: scenario.bootScript }),
        DSC_DOM_BOOT: '.composer',
        DSC_DOM_SETTLE_MS: '1200',
      },
    })) as DomShot
    if (shot.error !== undefined) {
      const preview = (shot.text ?? '').slice(0, 1200)
      throw new Error(
        `[${scenario.slug}] 驱动失败：${shot.error}\n—— 现场文本 ——\n${preview}\n—— 计数 ——\n${JSON.stringify(shot.counts ?? {})}\n—— 控制台 ——\n${(shot.console ?? []).join('\n')}\n—— 宿主 stderr ——\n${(host.stderr ?? []).slice(-8).join('\n')}`,
      )
    }
    if (!shot.error && (shot.text ?? '') === '') throw new Error(`[${scenario.slug}] 驱动写了空读数`)
    const golden = toGolden(scenario, shot, home, currentBranch(), workdir)
    // `DSC_DOM_DEBUG=1` 时把归一后的文本打出来：golden 红了先看这一份，不必再去翻临时目录。
    if (process.env['DSC_DOM_DEBUG'] === '1') console.log(`\n=== ${scenario.slug} ===\n${golden}`)
    for (const needle of scenario.expectText ?? []) {
      expect(golden, `场景意图漂了：缺 ${JSON.stringify(needle)}`).toContain(needle)
    }
    expectGolden(golden, `browser/${scenario.slug}`)
  } finally {
    await stopHost(host)
    rmSync(home, { recursive: true, force: true })
  }
}

describe.skipIf(!fresh.ok)('浏览器 DOM 快照（真宿主 + 真 Electron）', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.slug} ${scenario.title}`, async () => {
      await runScenario(scenario)
    }, 300_000)
  }
})
