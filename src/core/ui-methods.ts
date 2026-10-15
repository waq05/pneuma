/**
 * 界面通道的方法白名单与实参校验（本机界面服务的调用面）。
 *
 * ## 为什么要在 `INVOKABLE_METHODS` 之外再切一份子集
 *
 * `core/host-methods.ts` 那份 61 个方法是**宿主进程内部协议**的全部可调用面：能碰它的人
 * 要么是宿主自己（host-stdio 那条进程内管道），要么是已经在终端里拿到宿主的人。
 * 本机界面服务不一样：它把调用面交给**页面**，而页面里跑着第三方插件 bundle（与壳同源）。
 * 只要有**任一**插件被投毒，或者某个存档渲染出 XSS 拿到 HttpOnly Cookie（同源请求自动带上），
 * 攻击者就顺着 `/api/invoke` 摸到整张清单——那等于把宿主全部控制面交出去了。
 *
 * 所以这里按"动作落在谁手里"重新切一遍：
 *
 * **放行**（桌面级界面真正要用的）：
 *   - 对话与回合：`submit` / `interrupt` / `editQueued` / `removeQueued` / `steerQueued` / `compact`
 *   - 会话库：`openSession` / `refreshSessions` / `archiveSessions` / `restoreSessions`
 *     / `renameSession` / `setSessionPinned` / `listUserMessages` / `forkSession`
 *     / `listArchivedSessions` / `usageStats` / `peekTranscript`
 *   - 模型与档位：`setModel` / `listModels` / `setEffort` / `setMode` / `getModelConfig`
 *     / `discoverModels` / `testConnection` / `setDefaultModel`
 *   - 审批与提问：`answerApproval` / `answerQuestion` / `answerPlan`
 *   - 界面偏好：`getUiPrefs` / `setUiPrefs`
 *   - 插件开关：`listPlugins` / `setPluginEnabled`
 *   - 工具与技能：`listTools` / `listSkills` / `readSkill` / `setSkillEnabled` / `browseMarket`
 *   - 模式（预设）：`listPresets` / `readPreset` / `usePreset` / `savePreset` / `removePreset`
 *     / `setDefaultPreset`
 *   - 设置页：`getSettingsSections` / `getSectionValues` / `setSettingValue` / `runSettingAction`
 *   - 队友：`listTeammates` / `stopTeammate` / `messageTeammate` / `removeTeammate`
 *   - 任务与目标：`clearTodos` / `goalAction`
 *   - 壳的 `/` 命令菜单：`listUiCommands`（只读元数据）+ `runUiCommand`——**只认
 *     `shell: true` 那批命令**（清单与挑选尺子在 `core/commands-completion.ts`：
 *     动作不出本清单已有的权力面，且壳里没有更顺手的替身）。它与被排除的 `runCommand`
 *     是两条路：那条能跑任意命令（含权限旋钮、写文件、落信任、退出），这条的名字面
 *     钉死在宿主那份表上，加一条新命令不会自动变可达。
 *   - 工作区文件与 git：`dock`——但**只放读与写两档**，终端那档不在放行面（见下）
 *
 * **排除**（`UI_EXCLUDED`，逐条有理由）：
 *   - 凭据类 `setProviderKey` / `saveProvider` / `removeProvider`：写 API key 与端点，
 *     是"用户要在终端或设置页亲手做一次"的动作；页面（尤其第三方插件）不该有能力改端点，
 *     否则一次 XSS 就顺手把流量指到攻击者的服务器。
 *   - 任意命令执行 `runCommand`（受限的那条叫 `runUiCommand`，见上面「放行」一节）。
 *   - 破坏性 `purgeSessions`：永久删除会话（移进回收站再 30 天清），不可逆；删除必须由人亲手点。
 *   - 策略 `setPolicy`：审批策略（要不要弹卡、沙箱档位）是安全闸门本身，
 *     能让页面改它，前面所有闸门就都成了摆设。**写口开在原生桥**（`NATIVE_OPS.setPolicy`）：
 *     旧桌面版的输入框本来就有这根能切的旋钮（`desktop/src/renderer/Composer.tsx` 的
 *     `proxy.setPolicy`），壳不能比旧版少一样东西；而桥只对装了 preload 的桌面窗口
 *     那份文档开放，浏览器页签 / 远程页面够不着——与 `saveProvider` 那三件同一先例。
 *   - 往本机装东西 `installMarketSkill` / `setMarketSources`：下载并安装第三方技能、
 *     改来源列表，等于供应链写入口（`browseMarket` 只是读列表，故放行）。
 *   - 落信任记录 `setUiTrust`：信任一个第三方界面插件等于放它进启动图（它从此能调界面
 *     通道方法与桌面窗口的原生桥），这声「我信任」必须是人在桌面窗口里答的——
 *     写走原生桥；列状态（`listUiTrust`）是读，放行。
 *
 * **`testConnection` 为什么可以放行（与 `discoverModels` 同一把尺）**：它拿**端点名**去测
 * ——实参只是一个名字（`MAX_NAME` 的字符串），端点地址与 key 都取自宿主那份配置，页面
 * 指不了别处。于是它是「让宿主按已配好的端点发一次最小对话请求」，与 `discoverModels`
 * （同样拿宿主那份 baseUrl + key 去 GET /models）是同一个权力级别：都能让宿主拿着用户的
 * 凭据敲一次那个端点，都改不了端点本身——想变成「把 key 发到任意地址」得先改端点，
 * 而那是 `saveProvider` 那三件被排除的事。代价是页面能反复点它烧 token（与能反复点
 * `discoverModels` 一样），记在这里，不另开闸。
 *
 * **`dock` 为什么从排除名单挪到放行面（2026-10-10，阶段 5.2）**：原来整条排除的理由是
 * 它里面混着 `term-spawn`（起 pwsh/cmd/bash/node）。现在按动作分三档（规格在
 * `core/dock-ops.ts`）：读类直接放行、写类走审批、**终端那档一步都没进这里**——
 * 放行的实参规格把 op 钉成 `DOCK_UI_OPS` 那个枚举（读 + 写），所以
 * `/api/invoke { method: 'dock', args: ['term-spawn', …] }` 会被实参校验当场拒。
 * 终端要走的是**桌面窗口的原生桥**（只对主窗口的文档开放），于是"只在桌面有效"
 * 由传输保证，而不是靠 payload 里一个谁都能填的标记位。
 *
 * `UI_EXCLUDED` 与 `UI_METHODS` 一起做编译期核对（`EXCLUSION_COVERAGE`）：往
 * `INVOKABLE_METHODS` 新加一个方法时，如果它既没进界面白名单也没写进排除清单，就编不过。
 * 这比"只核对白名单里的名字存在"更严——新方法不会静静地被界面通道继承。
 *
 * ## 实参校验
 *
 * 光有方法白名单不够：`Reflect.apply(runtime[method], runtime, args)` 会把页面给的实参
 * 原样铺开，而 `args` 是从网络来的任意 JSON。这里手写一份最小 schema（`UI_ARG_SPECS`，
 * 类型是 `Record<UiMethod, …>`，所以**每个放行的方法都必须写规格**，漏了编不过），
 * 校验四件事：参数个数上限、逐个的 JSON 类型、字符串（含字符串数组元素）长度上限、
 * 枚举取值。不引第三方校验库：这一层要的正是"最小且能读懂"。
 *
 * @module dsc/core/ui-methods
 */
import type { ApprovalAnswer, CollaborationMode, EffortLevel, PlanDecision } from '../contract.js'
import { DOCK_UI_OPS } from './dock-ops.js'
import { INVOKABLE_METHODS, type InvokableMethod } from './host-methods.js'

/** 界面通道放行的方法。 */
export const UI_METHODS = [
  // 对话与回合
  'submit',
  'interrupt',
  'editQueued',
  'removeQueued',
  'steerQueued',
  'compact',
  // 会话库
  'openSession',
  'newSessionIn',
  'refreshSessions',
  'archiveSessions',
  'restoreSessions',
  'renameSession',
  'setSessionPinned',
  'listUserMessages',
  'forkSession',
  'listArchivedSessions',
  'usageStats',
  'peekTranscript',
  // 模型与档位
  'setModel',
  'listModels',
  'setEffort',
  'setMode',
  'getModelConfig',
  'discoverModels',
  'testConnection',
  'setDefaultModel',
  // 审批与提问
  'answerApproval',
  'answerQuestion',
  'answerPlan',
  // 界面偏好
  'getUiPrefs',
  'setUiPrefs',
  // 插件
  'listPlugins',
  'setPluginEnabled',
  // 第三方界面插件的信任：列状态是读，放行（「还没信过」的那些要能在卡片里看见）；
  // 落信任记录是写，走桌面窗口的原生桥（见 `UI_EXCLUDED` 与 native-bridge 的文件头）。
  'listUiTrust',
  // 工具与技能
  'listTools',
  'listSkills',
  'readSkill',
  'setSkillEnabled',
  'browseMarket',
  // 模式（预设）
  'listPresets',
  'readPreset',
  'usePreset',
  'savePreset',
  'removePreset',
  'setDefaultPreset',
  // 打包权限预设：读口（壳要画那颗旋钮）；写口（usePermissionPreset /
  // setDefaultPermissionPreset）与 setPolicy 同一条理由排除，见 UI_EXCLUDED。
  'listPermissionPresets',
  // 设置页
  'getSettingsSections',
  'getSectionValues',
  'setSettingValue',
  'runSettingAction',
  // 队友
  'listTeammates',
  'stopTeammate',
  'messageTeammate',
  'removeTeammate',
  // 后台作业与终端会话：只放行「收掉自己起的那个」与「只读看它的输出」两条
  // （起进程的入口仍只有工具与原生桥）；两条都带同口径的归属校验。
  'stopBackground',
  'readBackground',
  // 任务与目标
  'clearTodos',
  'goalAction',
  // 壳的 `/` 命令菜单：元数据是只读的；派发那条的名字面钉在宿主那份
  // `shell: true` 清单上（挑不出来的命令在宿主那侧直接报错，见 core/commands-completion.ts）。
  'listUiCommands',
  'runUiCommand',
  // 工作区文件与 git（dock 通道的读 + 写两档；终端那档留在原生桥，见 core/dock-ops.ts）
  'dock',
] as const satisfies readonly InvokableMethod[]

/** 界面通道认得的方法名。 */
export type UiMethod = (typeof UI_METHODS)[number]

/** 明确排除、且逐条写了理由的方法（见文件头注释）。 */
export const UI_EXCLUDED = [
  'runCommand',
  'setPolicy',
  // 审阅者与打包权限预设改的同样是安全闸门本身（审阅者 = 谁来裁；预设 = 一次写
  // 沙箱 + 权限模式 + 审阅者三个旋钮）。写口照旧开在原生桥
  // （NATIVE_OPS.setReviewer / usePermissionPreset / setDefaultPermissionPreset）。
  'setReviewer',
  'usePermissionPreset',
  'setDefaultPermissionPreset',
  'purgeSessions',
  'saveProvider',
  // 换配置文件：改的是「以后读哪一份配置」——等于换掉整份端点与密钥引用，比改单个端点更大，
  // 所以与它同一先例：只对主窗口那份文档开放（NATIVE_OPS.setConfigFile）。
  'setConfigFile',
  'removeProvider',
  'setProviderKey',
  'installMarketSkill',
  'setMarketSources',
  'setUiTrust',
] as const satisfies readonly InvokableMethod[]

/** 白名单里有没有协议根本不认识的方法（名字打错、方法被删）：有就报下面那个元组类型。 */
type NotInvokableInUi = Exclude<UiMethod, (typeof INVOKABLE_METHODS)[number]>
const UI_COVERAGE: NotInvokableInUi extends never
  ? true
  : ['界面白名单里有协议不认识的方法：', NotInvokableInUi] = true
void UI_COVERAGE

/**
 * 协议里的方法有没有"既没放行、也没说明为什么排除"的漏网之鱼。
 * 这是失败关闭的那一半：新方法默认进不了界面通道，想放行必须显式改这份文件。
 */
type UndecidedMethod = Exclude<InvokableMethod, UiMethod | (typeof UI_EXCLUDED)[number]>
const EXCLUSION_COVERAGE: UndecidedMethod extends never
  ? true
  : ['这些方法既没进界面白名单也没写进排除清单（新方法默认不放行，请显式决定）：', UndecidedMethod] = true
void EXCLUSION_COVERAGE

/** 查表用的集合。 */
export const UI_METHOD_SET: ReadonlySet<string> = new Set<string>(UI_METHODS)

/** 把线上来的方法名收窄成"界面通道允许调用的方法"。 */
export function isUiMethod(method: string): method is UiMethod {
  return UI_METHOD_SET.has(method)
}

/** 一个实参的形状。 */
type ArgShape =
  | { kind: 'string'; max: number }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'strings'; maxItems: number; max: number }
  | { kind: 'json'; maxBytes: number }

/** 一个实参的规格。 */
interface ArgSpec {
  shape: ArgShape
  /** 可不传：省略（或页面显式传 null / undefined）表示"没这个实参"。 */
  optional?: boolean
}

/**
 * 一个方法的实参规格：数组长度就是参数个数上限，下标就是参数位置。
 *
 * 为什么写死上界而不是照抄 TS 签名：TS 的可选参数在线上就是"少传一个"，
 * 而网络那头可以多传、可以传错类型、可以传 100 万个字符。这份规格管的是**入口**。
 */
type MethodSpec = readonly ArgSpec[]

/** 长度上限：会话 jsonl 路径、模型名、技能名都不该超过它。 */
const MAX_PATH = 4096
const MAX_NAME = 200
/** 用户消息 / 提问回答的上限（请求体本身另有 64KB 上限，见 core/web-http.ts）。 */
const MAX_TEXT = 32000
/** 图片以 data URL 形式随消息发，单条 32KB（请求体上限之下）。 */
const MAX_IMAGE = 32000
const MAX_IMAGES = 8
/** 一批会话路径的条数上限（归档 / 恢复）。 */
const MAX_PATHS = 500
/** 偏好 / 设置值 / 预设草稿这类 JSON 实参的上限（按序列化后的文本长度算）。 */
const MAX_PREF_JSON = 32000

/** 枚举取值直接绑到契约的类型上：契约改了而这里没跟上，编译期就报错。 */
const EFFORT_LEVELS = ['default', 'off', 'low', 'high', 'max'] as const satisfies readonly EffortLevel[]
const MODES = ['build', 'plan', 'explore', 'quiet'] as const satisfies readonly CollaborationMode[]
const PLAN_DECISIONS = ['pending', 'approved', 'rejected'] as const satisfies readonly PlanDecision[]
const APPROVAL_ANSWERS = ['allow-once', 'allow-session', 'allow-always', 'reject'] as const satisfies readonly ApprovalAnswer[]
const ANSWER_SOURCES = ['app', 'web'] as const
const GOAL_ACTIONS = ['pause', 'resume', 'clear', 'extend'] as const

/**
 * 每个放行方法的实参规格。
 *
 * 类型写成 `Readonly<Record<UiMethod, MethodSpec>>`：少写一个方法、多写一个不存在的方法
 * 都编不过，所以"放行"与"有校验"这两件事在这里被绑死。
 */
export const UI_ARG_SPECS: Readonly<Record<UiMethod, MethodSpec>> = {
  // ── 对话与回合 ─────────────────────────────────────────────────────────────
  submit: [{ shape: { kind: 'string', max: MAX_TEXT } }, { shape: { kind: 'strings', maxItems: MAX_IMAGES, max: MAX_IMAGE }, optional: true }],
  interrupt: [{ shape: { kind: 'string', max: MAX_PATH }, optional: true }],
  editQueued: [{ shape: { kind: 'number' } }, { shape: { kind: 'string', max: MAX_TEXT } }],
  removeQueued: [{ shape: { kind: 'number' } }],
  steerQueued: [{ shape: { kind: 'number' }, optional: true }],
  compact: [],
  // ── 会话库 ────────────────────────────────────────────────────────────────
  openSession: [{ shape: { kind: 'string', max: MAX_PATH }, optional: true }],
  // 在指定目录里新建会话：实参只是一个**目录名**（能否用由宿主校验：绝对 + 存在 +
  // 是目录），不写配置、不改策略、不执行命令——与 `openSession(path)` / `discoverModels`
  // 同一把尺。目录是会话自己的数据（jsonl 的 meta 行），所以换目录新建**不需要重启
  // 宿主**，也就不会再顺带把整个窗口重载一遍（工作区行那颗 ⊕ 走的就是这条路）。
  newSessionIn: [{ shape: { kind: 'string', max: MAX_PATH } }],
  refreshSessions: [],
  archiveSessions: [{ shape: { kind: 'strings', maxItems: MAX_PATHS, max: MAX_PATH } }],
  restoreSessions: [{ shape: { kind: 'strings', maxItems: MAX_PATHS, max: MAX_PATH } }],
  renameSession: [{ shape: { kind: 'string', max: MAX_PATH } }, { shape: { kind: 'string', max: MAX_NAME } }],
  setSessionPinned: [{ shape: { kind: 'string', max: MAX_PATH } }, { shape: { kind: 'boolean' } }],
  listUserMessages: [{ shape: { kind: 'string', max: MAX_PATH } }],
  forkSession: [{ shape: { kind: 'string', max: MAX_PATH } }, { shape: { kind: 'number' } }],
  listArchivedSessions: [],
  usageStats: [],
  peekTranscript: [{ shape: { kind: 'string', max: MAX_PATH } }],
  // ── 模型与档位 ────────────────────────────────────────────────────────────
  setModel: [{ shape: { kind: 'string', max: MAX_NAME } }],
  listModels: [],
  setEffort: [{ shape: { kind: 'enum', values: EFFORT_LEVELS } }],
  setMode: [{ shape: { kind: 'enum', values: MODES } }],
  getModelConfig: [],
  discoverModels: [{ shape: { kind: 'string', max: MAX_NAME } }],
  testConnection: [
    { shape: { kind: 'string', max: MAX_NAME } },
    { shape: { kind: 'string', max: MAX_NAME }, optional: true },
  ],
  setDefaultModel: [{ shape: { kind: 'string', max: MAX_NAME } }, { shape: { kind: 'string', max: MAX_NAME } }],
  // ── 审批与提问 ────────────────────────────────────────────────────────────
  answerApproval: [
    { shape: { kind: 'enum', values: APPROVAL_ANSWERS } },
    { shape: { kind: 'enum', values: ANSWER_SOURCES }, optional: true },
  ],
  answerQuestion: [{ shape: { kind: 'string', max: MAX_TEXT } }],
  answerPlan: [
    { shape: { kind: 'enum', values: PLAN_DECISIONS } },
    { shape: { kind: 'string', max: MAX_TEXT }, optional: true },
  ],
  // ── 界面偏好 ──────────────────────────────────────────────────────────────
  getUiPrefs: [],
  setUiPrefs: [{ shape: { kind: 'json', maxBytes: MAX_PREF_JSON } }],
  // ── 插件 ──────────────────────────────────────────────────────────────────
  listPlugins: [],
  setPluginEnabled: [{ shape: { kind: 'string', max: MAX_PATH } }, { shape: { kind: 'boolean' } }],
  listUiTrust: [],
  // ── 工具与技能 ────────────────────────────────────────────────────────────
  listTools: [],
  listSkills: [],
  readSkill: [{ shape: { kind: 'string', max: MAX_NAME } }],
  setSkillEnabled: [{ shape: { kind: 'string', max: MAX_NAME } }, { shape: { kind: 'boolean' } }],
  browseMarket: [{ shape: { kind: 'string', max: MAX_NAME }, optional: true }],
  // ── 模式（预设） ──────────────────────────────────────────────────────────
  listPresets: [],
  readPreset: [{ shape: { kind: 'string', max: MAX_NAME } }],
  usePreset: [{ shape: { kind: 'string', max: MAX_NAME } }],
  savePreset: [{ shape: { kind: 'json', maxBytes: MAX_PREF_JSON } }],
  removePreset: [{ shape: { kind: 'string', max: MAX_NAME } }],
  setDefaultPreset: [{ shape: { kind: 'string', max: MAX_NAME } }],
  // ── 打包权限预设（只读口；三个写口在原生桥，见 UI_EXCLUDED）────────────────
  listPermissionPresets: [],
  // ── 设置页 ────────────────────────────────────────────────────────────────
  getSettingsSections: [],
  getSectionValues: [{ shape: { kind: 'string', max: MAX_NAME } }],
  setSettingValue: [
    { shape: { kind: 'string', max: MAX_NAME } },
    { shape: { kind: 'string', max: MAX_NAME } },
    { shape: { kind: 'json', maxBytes: MAX_PREF_JSON } },
  ],
  runSettingAction: [{ shape: { kind: 'string', max: MAX_NAME } }, { shape: { kind: 'string', max: MAX_NAME } }],
  // ── 队友 ──────────────────────────────────────────────────────────────────
  listTeammates: [],
  stopTeammate: [{ shape: { kind: 'string', max: MAX_NAME } }],
  messageTeammate: [{ shape: { kind: 'string', max: MAX_NAME } }, { shape: { kind: 'string', max: MAX_TEXT } }],
  removeTeammate: [{ shape: { kind: 'string', max: MAX_NAME } }],
  // 后台作业 / 终端会话的 id（job-N / term-N）：短标识，给 MAX_NAME 绰绰有余。
  stopBackground: [{ shape: { kind: 'string', max: MAX_NAME } }],
  readBackground: [{ shape: { kind: 'string', max: MAX_NAME } }],
  // ── 任务与目标 ────────────────────────────────────────────────────────────
  clearTodos: [],
  goalAction: [{ shape: { kind: 'enum', values: GOAL_ACTIONS } }],
  // ── 壳的 `/` 命令菜单 ─────────────────────────────────────────────────────
  listUiCommands: [],
  // 一条命令行（`/review 关注点` 这样的原文，长度按输入框上限收）：具体名字准不准
  // 由宿主那侧按 `shell: true` 清单判，这一层只管形状。
  runUiCommand: [{ shape: { kind: 'string', max: MAX_TEXT } }],
  // ── 工作区文件与 git ──────────────────────────────────────────────────────
  // 第一个实参是 op，钉死在 `DOCK_UI_OPS`（读 + 写）；**终端那档不在枚举里**，
  // 于是走 HTTP 的 term-spawn 会被这一层的枚举校验当场拒，而不是进到宿主才算。
  dock: [
    { shape: { kind: 'enum', values: DOCK_UI_OPS } },
    { shape: { kind: 'json', maxBytes: MAX_PREF_JSON }, optional: true },
  ],
}

/** 校验结果：过了一条新实参数组（尾部空值已去掉），没过给一句能读的错。 */
export type UiArgCheck = { ok: true; args: unknown[] } | { ok: false; error: string }

/**
 * 校验并规整一次调用的实参。
 *
 * 规整的那一件事：页面用 `null` 表示"这个可选参数不传"（JSON 里没有 undefined），
 * 所以尾部的 null / undefined 一律当"省略"去掉——省略只能从尾部开始，中间空一个
 * 会让后面的参数错位（那正是要拒的形状）。
 *
 * @param method - 已收窄的界面通道方法名
 * @param args - 页面给的实参（来自网络，任何形状都可能）
 */
export function validateUiArgs(method: UiMethod, args: readonly unknown[]): UiArgCheck {
  const spec = UI_ARG_SPECS[method]
  if (args.length > spec.length) {
    return { ok: false, error: `界面通道：${method} 最多收 ${String(spec.length)} 个实参，收到 ${String(args.length)} 个` }
  }
  const checked: unknown[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    const arg = spec[index]
    if (value === null || value === undefined) {
      if (arg.optional !== true) {
        return { ok: false, error: `界面通道：${method} 的第 ${String(index + 1)} 个实参不能为空` }
      }
      for (let later = index + 1; later < args.length; later += 1) {
        const rest = args[later]
        if (rest !== null && rest !== undefined) {
          return {
            ok: false,
            error: `界面通道：${method} 的第 ${String(index + 1)} 个实参省略了，但第 ${String(later + 1)} 个还在（省略只能从尾部开始）`,
          }
        }
      }
      break
    }
    const problem = checkShape(arg.shape, value)
    if (problem !== null) {
      return { ok: false, error: `界面通道：${method} 的第 ${String(index + 1)} 个实参${problem}` }
    }
    checked.push(value)
  }
  // 必传的实参一个都不能少：少了就当场拒，不能把 undefined 铺给宿主方法
  // （`submit()` 收到 text=undefined 会被 Reflect.apply 原样传进去）。
  for (let index = checked.length; index < spec.length; index += 1) {
    if (spec[index].optional !== true) {
      return { ok: false, error: `界面通道：${method} 的第 ${String(index + 1)} 个实参是必传的` }
    }
  }
  return { ok: true, args: checked }
}

/** 校验一个值是不是这个形状；不是就回一句人话。 */
function checkShape(shape: ArgShape, value: unknown): string | null {
  switch (shape.kind) {
    case 'string':
      if (typeof value !== 'string') return '必须是字符串'
      if (value.length > shape.max) return `是字符串但太长（${String(value.length)} > ${String(shape.max)} 字符）`
      return null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : '必须是有限数字'
    case 'boolean':
      return typeof value === 'boolean' ? null : '必须是布尔值'
    case 'enum':
      return typeof value === 'string' && shape.values.includes(value)
        ? null
        : `必须是这几个值之一：${shape.values.join(' / ')}`
    case 'strings': {
      if (!Array.isArray(value)) return '必须是字符串数组'
      if (value.length > shape.maxItems) return `数组太长（${String(value.length)} > ${String(shape.maxItems)} 项）`
      for (const item of value) {
        if (typeof item !== 'string') return '数组里必须全是字符串'
        if (item.length > shape.max) return `数组里有字符串太长（${String(item.length)} > ${String(shape.max)} 字符）`
      }
      return null
    }
    case 'json': {
      const text = jsonText(value)
      if (text === null) return '不是可序列化的 JSON 值'
      if (text.length > shape.maxBytes) return `是 JSON 但太长（${String(text.length)} > ${String(shape.maxBytes)} 字符）`
      return null
    }
  }
}

/** 一段 JSON 文本；序列化不了（循环引用、BigInt、函数）给 null。 */
function jsonText(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}
