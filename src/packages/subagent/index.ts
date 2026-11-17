/**
 * 子智能体（官方插件，默认关闭）。
 *
 * 打开后模型多出 `subagent` 工具：派活、传话、打断。关掉后这个工具、它注入的
 * 提示词、以及在跑的队友一起消失——本插件不提供第二套 agent 实现，队友就是
 * 「另一个 MiniAgent 实例 + 它自己的会话文件 + 一张冻结的工牌」。
 *
 * 队友按会话隔离（对照 dsh 的 parentSession 过滤）：每个会话各自一份在队名单与
 * 并发额度，`subagent list` 只报本会话派出的队友。包里另带一块按会话分开的共享
 * 任务板（`team_task`）：板子可以在设置里单独关（「任务板」分组），关掉只是模型看
 * 不到这个工具与提示段，名册与派活照常——只想要一块共享待办的人可以这么用。
 *
 * 工牌（工具白名单 / 审批意愿 / 轮次预算 / 模型）在队友开工那一刻从角色文件复制进
 * 运行时并冻结，所以中途改角色文件只影响下一个新队友，也堵住了「队友跑一半给自己提权」。
 *
 * 审批取「全局上限」与「角色意愿」里更严的那个：全局选「不允许」时谁都别想弹卡；
 * 全局选「仅前台队友」时，后台队友自动退回不允许。弹出来的卡上写明是谁在请求。
 *
 * @module dsc/plugins/subagent
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { Transcript } from '@pneuma/runtime/adapter/transcript.js'
import {
  builtinRoleNames,
  builtinRole,
  DSC_AGENTS_DIR,
  ensureBuiltinRoles,
  findRole,
  listRoles,
  migrateBuiltinRoleMaxTurns,
  writeRole,
  type AgentRole,
  type TeammateApproval,
} from './agent-roles.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { MiniAgent } from '@pneuma/session-core/loop.js'
import { subagentEnvironmentText } from '@pneuma/session-core/prompt.js'
import { activeRules } from '@pneuma/runtime/core/command-policy.js'
import { modeSpec } from '@pneuma/session-core/modes.js'
import { REJECTED_TOOL_TEXT, Session, teammateRoot } from '@pneuma/runtime/core/session.js'
import { argsSummary, type ToolContext, type ToolEntry } from '@pneuma/runtime/core/tools.js'
import { toolApprovalGuard, type ToolGuard, type ToolGuardChain, type ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
import {
  BOARDS_DIR,
  boardCreate,
  boardUpdate,
  boardViewOf,
  inboxAppend,
  inboxRead,
  isReady,
  readBoard,
  recordBoardActivity,
  resetBoard,
  REVIEW_FINDINGS_OPEN,
  TEAMMATE_REPORT_OPEN,
  type BoardAction,
  type BoardUpdatePayload,
  type TeamActivity,
  type TeamBoard,
  type TeamTask,
} from '@pneuma/runtime/core/team-board.js'
import type {
  EffortLevel,
  SettingsCheckGroup,
  SettingsCheckOption,
  SettingsField,
  SettingsValue,
  TeammateView,
  TeamBoardView,
  TranscriptEntry,
} from '@pneuma/runtime/contract.js'
import type { ReviewService, ReviewSpawnRequest, ReviewSpawnResult, SettingsSectionSpec, TeamService } from '@pneuma/runtime/services/types.js'
import { reviewTaskText, ReviewJournal, REVIEW_CANCELED_TEXT } from '@pneuma/runtime/core/git-info.js'
import { clampInt as clamp } from '@pneuma/runtime/core/clamp.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 插件配置（存 `~/.dsc/plugins.json` 条目树的 config 里）。 */
interface SubagentConfig {
  /** 允许模型自己派活；关掉后两个工具连同提示词一起撤下。 */
  allowDelegation: boolean
  /** 同时干活的队友上限（满载直接拒绝，不排队；收工的不占额度）。 */
  maxTeammates: number
  /** 允许几层：0 = 只有用户能派队友，Lead 不许再往下派。 */
  maxDepth: number
  /** 审批上限：队友能不能向用户要授权。 */
  approval: TeammateApproval
  /** 后台队友干完：auto = 立刻把汇报接进 Lead 的下一轮；quiet = 只写进会话等用户下次说话。 */
  notify: 'auto' | 'quiet'
  /**
   * 新队友的默认模型（`端点/模型`）；空 = 跟随当前模型。
   *
   * @deprecated 设置页已不再展示这一项，改成「允许 Agent 为子队友选择模型」+ 授权模型清单。
   * 仍按旧配置读取，作为「spawn 显式 > 角色文件 model」之后、跟随会话之前的兜底，老安装
   * 不会因为升级丢掉模型设置。
   */
  defaultModel: string
  /**
   * 允许 Agent 派活时给新队友指定模型与思考强度。
   *
   * 关闭（默认）时 spawn 带 `model` 会被拒绝；开启后 `model` 只能从
   * {@link SubagentConfig.allowedModels} 里挑——用户授权的清单是唯一入口。
   */
  allowModelSelection: boolean
  /** 授权给 Agent 挑选的模型清单（`端点/模型`）；空数组 = 一个都没授权。 */
  allowedModels: string[]
  /**
   * 轮次上限：0 = 不限，队友自己决定跑几轮。
   *
   * 设了就与角色自己的预算取更严的那个（角色文件显式 max-turns 优先，其次看
   * {@link SubagentConfig.roleTurns}；角色写 0 也当不限）。设限后最后一轮
   * 留给汇报：先提醒它交结论，再把工具表收成空，逼它用正文收尾。
   */
  maxTurns: number
  /**
   * 各角色自己的默认轮次预算：`角色名 → 轮数`，0 = 不限。
   *
   * 角色文件里没写 `max-turns` 时用它；设置页「默认最大轮次」按角色改的就是这一份。
   * 出厂值见 {@link DEFAULT_ROLE_TURNS}。
   */
  roleTurns: Record<string, number>
  /**
   * 共享任务板：true = 注册 `team_task` / `team_message` 并注入板子提示段。
   *
   * 关掉只是模型看不到这两块；名册、派活、汇报都不受影响——留着「只想要一块共享
   * 待办」的用法。板子按会话各一块，数据在 `~/.dsc/team/boards/<会话 id>.json`。
   */
  board: boolean
  /**
   * 团队模式：允许二层派活（PM 可以再派人），并推荐 pm/architect/developer/tester/ops 角色。
   *
   * 实现口径：打开时把 `maxDepth` 抬到至少 2（`maxDepth` 的语义不变，仍是「允许几层」）；
   * 关闭只改这一项、不回退 `maxDepth`，避免替用户猜他想不想保留二层能力。
   */
  teamMode: boolean
}

const CONFIG_KEY = 'subagent'

/**
 * 内置角色的出厂轮次预算（设置页「默认最大轮次」的默认值；0 = 不限）。
 *
 * 为什么默认值不写在角色文件的 `max-turns` 里：文件里的值属于「显式声明」，会一直压过
 * 设置页；默认值放这里，用户改设置页才真的生效。旧安装里钉着旧默认值的角色文件由
 * `migrateBuiltinRoleMaxTurns` 迁移。
 */
export const DEFAULT_ROLE_TURNS: Readonly<Record<string, number>> = {
  pm: 48,
  architect: 32,
  developer: 128,
  tester: 64,
  ops: 32,
  critic: 16,
  reviewer: 64,
  writer: 128,
  explorer: 0,
}

/** 设置页「默认最大轮次」列出的角色：先列团队职能角色，再列通用角色，不限的垫底。 */
const TURN_ROLES: readonly string[] = [
  'pm',
  'architect',
  'developer',
  'tester',
  'ops',
  'critic',
  'reviewer',
  'writer',
  'explorer',
]

const DEFAULTS: SubagentConfig = {
  allowDelegation: true,
  maxTeammates: 4,
  maxDepth: 1,
  approval: 'forbid',
  notify: 'auto',
  defaultModel: '',
  allowModelSelection: false,
  allowedModels: [],
  maxTurns: 0,
  roleTurns: { ...DEFAULT_ROLE_TURNS },
  board: true,
  teamMode: false,
}

const APPROVAL_RANK: Record<TeammateApproval, number> = { forbid: 0, foreground: 1, ask: 2 }

/** 收工的队友最多在名单里留这么多个，超了就挤掉最老的（不占并发额度，只是别把名单撑爆）。 */
const MAX_LISTED_FINISHED = 12

/**
 * 轮次预算取更严的那个：角色与插件都设了上限时取小的；任一方为 0（不限）时看另一方。
 * @returns 0 = 不额外设限。
 */
function effectiveMaxTurns(roleTurns: number, pluginTurns: number): number {
  if (roleTurns <= 0) return Math.max(pluginTurns, 0)
  if (pluginTurns <= 0) return roleTurns
  return Math.min(roleTurns, pluginTurns)
}

/**
 * 一个角色此刻的轮次预算，三档优先级：
 *   1. 角色文件里**显式**写了 `max-turns`（写 0 也算显式，表示不限）→ 用文件里的；
 *   2. 没写 → 用设置页「默认最大轮次」里这个角色的值（{@link SubagentConfig.roleTurns}）；
 *   3. 全局 {@link SubagentConfig.maxTurns} 大于 0 时，再取更严的那个。
 *
 * 名册提示与队友冻结的工牌都走这一个函数，保证「展示的轮次」就是「实际给的轮次」。
 * @param role - 角色（只用到名字、max-turns 与是否显式声明）
 * @param roleTurns - 设置页按角色配的轮次表
 * @param globalTurns - 全局轮次上限（0 = 不设限）
 * @returns 0 = 这个角色不额外设限
 */
export function resolveMaxTurns(
  role: Pick<AgentRole, 'name' | 'maxTurns' | 'maxTurnsDeclared'>,
  roleTurns: Readonly<Record<string, number>>,
  globalTurns: number,
): number {
  const budget = role.maxTurnsDeclared ? role.maxTurns : (roleTurns[role.name] ?? 0)
  return effectiveMaxTurns(budget, globalTurns)
}

/**
 * 读配置里的 `roleTurns`：出厂默认打底，只认数字（夹进 0..200），坏值退回该角色的默认值。
 * 配置里没有的角色（包括用户自建角色）不写进表，解析时按 0（不限）处理。
 */
function readRoleTurns(raw: unknown): Record<string, number> {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, number> = { ...DEFAULT_ROLE_TURNS }
  for (const [name, value] of Object.entries(source)) {
    if (name === '') continue
    out[name] = clamp(value, 0, 200, DEFAULT_ROLE_TURNS[name] ?? 0)
  }
  return out
}

/** 思考强度档位（与角色文件 frontmatter、主会话 /model 的档位同一套）。 */
const EFFORT_LEVELS: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']

/**
 * 读配置里的 `allowedModels`：只收非空字符串、去重、保持原顺序。
 *
 * 这里不拿 `ctx.llm.listModels()` 过滤：模型清单跟着端点配置变，用户临时删掉一个端点
 * 不该把他勾过的授权静默清空；真到派活时那个模型解析不出来，会被校验拦下。
 */
export function readAllowedModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value !== '' && !out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 队友用哪个模型：spawn 显式指定 > 角色文件 model > 旧配置 defaultModel > 跟随当前会话。
 * @param spawnModel - spawn 参数里归一好的 `端点/模型`；null = 没指定
 * @param role - 角色（读它的 model）
 * @param fallbackModel - 旧配置 defaultModel；空串 = 没配
 * @returns null = 跟随当前会话的模型
 */
export function resolveTeammateModel(
  spawnModel: string | null,
  role: Pick<AgentRole, 'model'>,
  fallbackModel: string,
): string | null {
  if (spawnModel !== null) return spawnModel
  if (role.model !== null) return role.model
  return fallbackModel === '' ? null : fallbackModel
}

/**
 * 队友用哪个思考强度：spawn 显式指定 > 角色文件 effort > 跟随模型默认。
 * @returns null = 不覆盖，按模型默认档位
 */
export function resolveTeammateEffort(
  spawnEffort: EffortLevel | null,
  role: Pick<AgentRole, 'effort'>,
): EffortLevel | null {
  return spawnEffort ?? role.effort
}

/**
 * 队友系统提示里的「模型 / 思考强度」事实句。
 *
 * 只写它自己冻结的那一份与「仅影响新队友」的语义，**不列授权清单**：清单是派活方做
 * 合法选择要用的信息（写在名册提示里），对已经开工的队友来说既用不上，也不该被它拿去
 * 推断用户还有哪些模型没授权。
 * @param model - 冻结的模型（`端点/模型`，或跟随会话时的模型名）
 * @param effort - 冻结的思考强度；null = 跟随默认
 * @param selectionAllowed - 本会话是否放开了「允许 Agent 为子队友选择模型」
 */
export function teammateModelNote(model: string, effort: EffortLevel | null, selectionAllowed: boolean): string {
  const frozen = effort === null ? '，思考强度跟随默认' : `，思考强度 ${effort}`
  const future = selectionAllowed
    ? '如果你还能往下派（层级允许），派新队友时可以用 model / effort 指定模型与思考强度，但只能从用户授权的模型清单里挑——不在清单里会被直接拒绝，别反复试。'
    : '这个会话里派活的人不能指定模型。'
  return `模型：你开工时冻结为「${model}」${frozen}。这是派你的人在你开工那一刻定的：中途改角色文件或设置只影响之后新建的队友，改不了你这一份。${future}`
}

/** spawn 的 model / effort 校验结果：通过时给出要冻结进工牌的覆盖值。 */
export type SpawnOverrides =
  | { ok: true; model: string | null; effort: EffortLevel | null }
  | { ok: false; reason: string }

/**
 * 校验并归一 spawn 的 `model` / `effort`。
 *
 * 规则（与设置页的开关、授权清单同一条口径）：
 *   - `model` 在开关关闭时一律拒绝（明确告诉模型去设置里打开）；
 *   - 开关打开时，用 `parseModelRef` 归一成 `端点/模型`，必须落在授权清单里；
 *     清单为空 = 一个都没授权，同样拒绝并提示去勾选；
 *   - `effort` 只认 {@link EFFORT_LEVELS} 里的值，与开关无关（它不涉及选端点/模型）。
 *
 * @param rawModel - spawn 参数 `model` 原值
 * @param rawEffort - spawn 参数 `effort` 原值
 * @param selection - 开关与授权清单
 * @param parseModelRef - 归一模型引用（`ctx.llm.parseModelRef`）
 */
export function resolveSpawnOverrides(
  rawModel: unknown,
  rawEffort: unknown,
  selection: { allow: boolean; allowed: readonly string[] },
  parseModelRef: (ref: string) => { provider: string; model: string },
): SpawnOverrides {
  let model: string | null = null
  const modelText = typeof rawModel === 'string' ? rawModel.trim() : ''
  if (modelText !== '') {
    if (!selection.allow) {
      return {
        ok: false,
        reason:
          '不能指定模型：用户还没打开「允许 Agent 为子队友选择模型」' +
          '（设置 → 子智能体 → 队友模型）。不带 model 再派一次，它会跟随角色文件或当前会话的模型。',
      }
    }
    const parsed = parseModelRef(modelText)
    // 归一成清单里的形状：`端点/模型`（parseModelRef 对裸模型名会补上当前会话的端点）
    const value = parsed.model === '' ? parsed.provider : `${parsed.provider}/${parsed.model}`
    if (!selection.allowed.includes(value)) {
      const allowed = selection.allowed.join('、')
      return {
        ok: false,
        reason:
          `模型「${value}」不在用户授权的清单里。` +
          (allowed === '' ? '现在一个都没授权：去设置 → 子智能体 → 队友模型 里勾选。' : `可选的：${allowed}`),
      }
    }
    model = value
  }

  let effort: EffortLevel | null = null
  const effortText = typeof rawEffort === 'string' ? rawEffort.trim() : ''
  if (effortText !== '') {
    if (!EFFORT_LEVELS.includes(effortText as EffortLevel)) {
      return {
        ok: false,
        reason: `不认识的 effort「${effortText}」。要用的值：${EFFORT_LEVELS.join(' / ')}`,
      }
    }
    effort = effortText as EffortLevel
  }
  return { ok: true, model, effort }
}

/** 主会话这一方在任务板上的名字。 */
const LEAD = 'lead'

/** 队友的运行状态（`done` 不算一种状态：干完就是 idle，等人再传话）。 */
type TeammateState = 'working' | 'idle' | 'failed' | 'stopped'

/**
 * 干完之后还能不能接着问。
 *
 * 对照 dsh 的 `subagent/descriptor.mode`（`continuable` / `one-shot`）：dsh 里这一
 * 项由子代理后端决定——本地 spawn/fork 后端一律可续接，外部 CLI 后端一律一次性，
 * 模型侧没有开关。numa 只有本地后端，所以这里改成派活时显式要：不填就是寻常队友
 * （收工后传话能接着干），填了 `keep: false` 的就是一次性小工（干完出队、只留记录）。
 */
type TeammateMode = 'continuable' | 'one-shot'

/** 一个在队或收工的队友。 */
interface Teammate {
  name: string
  role: string
  task: string
  /** 绑定的任务板任务 id（spawn 带 `task_id` 才有）；undefined = 没绑定。 */
  taskId?: string
  /** 冻结的工牌。 */
  badge: {
    tools: string[] | null
    maxTurns: number
    approval: TeammateApproval
    model: string | null
    effort: EffortLevel | null
  }
  session: Session
  agent: MiniAgent
  /** 派它的那一方当时的会话对象：汇报要写回这个文件，而不是「现在界面上打开的那个」。 */
  parentSession: Session
  /**
   * 归属会话：派活时算一次并固化（一路走到最上层那条）。
   *
   * 为什么固化：父队友一次性收工或被挤出名单后就不再在 `teammates` 里，用时再沿
   * 往上找会断在中间层——沙箱回落成「用户正看着的会话」、审批卡按中间层路径登记
   * 而界面上看不见（2026-11-09 复审问题 2）。
   */
  ownerSession: Session
  state: TeammateState
  /** 已经发起过的模型请求轮数。 */
  rounds: number
  toolCalls: number
  depth: number
  /** 谁派的它（主会话是 'lead'）。 */
  parent: string
  /** 干完之后还能不能接着问；见 {@link TeammateMode}。 */
  mode: TeammateMode
  background: boolean
  startedAt: number
  finishedAt?: number
  lastText: string
  error?: string
  /** 等下一次 turn/end 的 waiter 队列。 */
  waiters: Array<() => void>
  /**
   * 传话之后还欠一次汇报：等「模型又说了至少一句」（rounds 长过 minRound）再回。
   *
   * 为什么要有：`reportHome` 原先只挂在 spawn 那一次等待上，给闲下来的队友传话后
   * 它再干完就没人接汇报了（2026-10-27 查账）。等待条件不能只看「回合结束了几次」：
   * 传话可能被并进当前这一轮（那一轮结束就该回），也可能排在下一轮（要等下一轮真产出）。
   */
  awaitReport?: { minRound: number }
  /** 上一次真正回报时的 rounds（防同一轮回两遍：spawn 的首报与传话的补报会落在同一拍）。 */
  lastReportedRound: number
  /**
   * 预算最后一轮还欠着：rounds 到 maxTurns - 1 时补了「直接给结论」的提醒。
   *
   * 为什么要记：那条提醒排在收件箱里，模型这一轮若已自然收口，提醒会单独起一轮。
   * 上一轮的 turn/end 先到，settle 若照常收工，就会把半截汇报发出去，真正最后一轮的
   * 结论反而没人接。所以这一拍先不 settle，等最后一轮跑完再报。
   */
  finalRoundPending?: boolean
  /** 输出瀑布的行池（最新在后，只留 8 行；正文行与工具结果首行都进）。 */
  outputLines: string[]
  /** 当前（或最后一把）工具，画内联卡的「当前工具行」。 */
  lastTool?: { name: string; args: string; status: 'running' | 'done' | 'failed' }
  /** 累计 token（输入+输出端点真值；内联卡显示用）。 */
  tokens: number
}

/** 调这两个工具的人是谁（决定任务板认领人、信箱署名、能不能再往下派）。 */
interface Caller {
  name: string
  depth: number
  background: boolean
  /**
   * 这次调用归属哪个会话：任务板读写、名册过滤都按它算。
   *
   * 队友转发时塞它派出去的那个会话；主会话自己的调用没有这一项，回落工具上下文里的
   * `sessionId`。**不能看 `ctx.session.current()`**——用户切到别的会话时它就是另一条
   * 会话了，后台队友的认领会落到别人的板上（2026-11-08 报障）。
   */
  sessionId?: string
}

/**
 * 协作类工具：不受角色工牌白名单限制。
 *
 * 为什么：白名单表达的是「这个角色能改哪些文件、能跑什么命令」，任务板是一次协作登记
 * （`risk` 声明为 read），不该因为角色写了 `tools: read, glob, grep` 就把它一起关掉。
 * 2026-11-08 报障：explorer 队友回「本次会话给我的可用工具只有 read、glob、grep」，
 * 领不到任务——根因就在 `toolsFor` 拿白名单把 team_task 一起筛掉了。
 */
export const COLLAB_TOOL_NAMES: readonly string[] = ['team_task', 'team_message']

/**
 * 每个队友每轮最多发几条 `team_message`。
 *
 * 为什么要有：队友互发消息后彼此会被叫醒，两个队友完全可以「你一句我一句」把轮次预算
 * 烧光。额度按「轮次」清零（`emit` 里 rounds +1 就是一轮），超了让它们改用任务板 note。
 */
const TEAM_MESSAGES_PER_ROUND = 3

/** 一条 team_message 的正文长度上限（与信箱单条上限一致）。 */
const MAX_TEAM_MESSAGE_CHARS = 8000

/**
 * 一行任务摘要（队友提示词、Lead 板子提示段、team_task list 共用）。
 *
 * 格式刻意压成一行：两条提示词都要塞「全部任务 + 最新进展」，多行会让系统提示膨胀。
 * @param noteChars - 最新进展截断长度（0 = 不显示进展）
 */
export function taskDigestLine(board: TeamBoard, task: TeamTask, noteChars = 80): string {
  const flags = [
    isReady(board, task) ? '可开工' : '',
    task.assignee === null ? '' : `绑定 ${task.assignee}`,
    task.blockedReason === null ? '' : `卡住：${task.blockedReason.replace(/\s+/g, ' ').slice(0, 80)}`,
  ].filter((part) => part !== '')
  const note = task.notes[0]
  const latest =
    note === undefined || noteChars <= 0
      ? ''
      : `｜最新进展（${note.by}）：${note.text.replace(/\s+/g, ' ').slice(0, noteChars)}`
  return `- ${task.id} [${task.status}${flags.length === 0 ? '' : ` · ${flags.join(' · ')}`}] ${task.subject}${task.owner === null ? '' : ` @${task.owner}`}${latest}`
}

/** 一行活动摘要（队友提示词与 Lead 板子提示段共用）。 */
export function activityDigestLine(entry: TeamActivity): string {
  const clock = new Date(entry.at)
  const hh = String(clock.getHours()).padStart(2, '0')
  const mm = String(clock.getMinutes()).padStart(2, '0')
  return `- ${hh}:${mm} ${entry.by} ${entry.kind}${entry.taskId === undefined ? '' : ` ${entry.taskId}`}：${entry.text}`
}

/** 记录在案的一个队友（`~/.dsc/team/roster.json`，重启后侧栏仍能看到收工的队友）。 */
interface RosterRecord {
  name: string
  role: string
  state: TeammateState
  task: string
  file: string
  cwd: string
  parent: string
  depth: number
  rounds: number
  startedAt: number
  finishedAt?: number
  /**
   * 干完之后还能不能接着问。老记录没有这一项：那时只有「可续接」一种队友，
   * 所以读档时缺省按 continuable 处理（跟 dsh 容忍老 catalog 版本一个道理）。
   */
  mode?: TeammateMode
  /**
   * 出生会话 id（派它的那个会话）。名册是跨重启的台账，所以这一项让队友永久带着
   * 「它是从哪个会话派出去的」。老记录没有这一项，读档时按 undefined 处理。
   */
  sessionId?: string
  /** 绑定的任务板任务 id（spawn 带 `task_id` 才有）；老记录没有这一项。 */
  taskId?: string
}

/** 名字合法字符，跟角色名同一套。 */
const NAME_OK = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 工作目录名 → 可当目录名的短名（队友日志按它分堆）。 */
function cwdSlug(cwd: string): string {
  const cleaned = cwd.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.slice(-40) === '' ? 'cwd' : cleaned.slice(-40)
}

/**
 * 把父会话切到「上一个完整回合」为止的记录行（不含 meta）。
 * 完整回合 = 一条没带工具调用的 assistant 回复；它的后面可能就是正干到一半的活，
 * 那些不要，否则队友一睁眼就看到半截工具调用。
 * @returns null = 这个会话还没有一个完整回合可带。
 */
function forkSeedLines(parentFile: string): string[] | null {
  let raw: string
  try {
    raw = readFileSync(parentFile, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/).filter((line) => line !== '')
  let cut = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]!) as { type?: string; toolCalls?: unknown }
      if (record.type === 'assistant' && record.toolCalls === undefined) {
        cut = index
        break
      }
    } catch {
      // 坏行：跳过继续往前找，不影响切点
    }
  }
  if (cut < 0) return null
  // 第 0 行是父会话自己的 meta，队友要用自己那条
  return lines.slice(1, cut + 1)
}

export const subagentPlugin: Plugin.Object = {
  name: 'subagent',
  inject: ['session', 'tools', 'llm', 'approval', 'guards', 'transcript', 'prompt', 'settings', 'agent'],
  apply(ctx, passed) {
    ensureBuiltinRoles()
    // 旧安装的角色文件里钉着旧出厂轮次（critic 4 / reviewer 16 / writer 20）：删掉这几行，
    // 让设置页的按角色默认值生效。只补缺、不覆盖的 ensureBuiltinRoles 管不到这一步。
    // 幂等，且函数内部吞掉所有异常——迁移失败最多沿用旧轮次，不能影响启动。
    migrateBuiltinRoleMaxTurns()

    // ── 配置 ────────────────────────────────────────────────────────────────
    const readConfig = (): SubagentConfig => {
      const raw = resolvePluginConfig(CONFIG_KEY, passed)
      const approval = APPROVAL_RANK[String(raw.approval) as TeammateApproval] === undefined
        ? DEFAULTS.approval
        : (String(raw.approval) as TeammateApproval)
      return {
        allowDelegation: raw.allowDelegation !== false && raw.allowDelegation !== 'false',
        maxTeammates: clamp(raw.maxTeammates, 1, 8, DEFAULTS.maxTeammates),
        maxDepth: clamp(raw.maxDepth, 0, 2, DEFAULTS.maxDepth),
        approval,
        notify: raw.notify === 'quiet' ? 'quiet' : 'auto',
        defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '',
        allowModelSelection: raw.allowModelSelection === true || raw.allowModelSelection === 'true',
        allowedModels: readAllowedModels(raw.allowedModels),
        maxTurns: clamp(raw.maxTurns, 0, 200, DEFAULTS.maxTurns),
        roleTurns: readRoleTurns(raw.roleTurns),
        board: raw.board !== false && raw.board !== 'false',
        teamMode: raw.teamMode === true || raw.teamMode === 'true',
      }
    }
    let config = readConfig()
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig()
    }

    /** 角色此刻的轮次预算：名册提示与开工冻结的工牌共用这一个（见 {@link resolveMaxTurns}）。 */
    const roleMaxTurns = (role: AgentRole): number => resolveMaxTurns(role, config.roleTurns, config.maxTurns)

    /**
     * 派活方（Lead 或还能往下派的队友）看到的模型授权说明。
     *
     * 授权清单本身就是它做合法 spawn 调用要用的信息，所以这里完整列出；开关关闭时明确说
     * 不能指定，免得模型反复试错。清单外的端点/模型细节（还有哪些模型没授权）不提。
     */
    const modelRuleText = (): string => {
      if (!config.allowModelSelection) {
        return '模型：派活时不能指定模型或思考强度；队友用角色文件里的 model / effort，没写就跟随当前会话。'
      }
      const list =
        config.allowedModels.length === 0
          ? '（还没有授权任何模型，先去设置 → 子智能体 → 队友模型 里勾选）'
          : config.allowedModels.join('、')
      return `模型：spawn 时可以用 model 指定模型、用 effort 指定思考强度（${EFFORT_LEVELS.join('/')}）。模型只能从用户授权的清单里挑：${list}。只影响之后新建的队友，正在跑的改不了。`
    }

    // ── 名册持久化 ──────────────────────────────────────────────────────────
    const rosterFile = join(ctx.settings.about().home, 'team', 'roster.json')
    /**
     * 名册读缓存。
     *
     * 为什么要有：界面快照每次重建都会问一次名册（`transcript.ts:231` → `team.list()`
     * → 这里），而快照重建跟着流式增量走——原先这里是**每次重建一次同步
     * readFileSync + JSON.parse**，直接落在渲染路径上。
     *
     * 为什么按 mtime 而不是 TTL：名册是「远程待命的双进程共享」的一只文件（见 `list()`
     * 那段僵尸读作 stopped 的注释），别的进程随时可能往里写一条。TTL 会让这类写入有
     * 一段看不见的窗口（`resident-agents-test` 的僵尸用例就是这么抓到的）；而 stat 一次
     * 比读全文 + 解析便宜得多，换来的是**从不同步**——文件没动就不重读，动了立刻重读。
     */
    let rosterCache: RosterRecord[] | null = null
    /** 缓存对应的文件 mtime（null = 当时文件不在/读不到）。 */
    let rosterStamp: number | null = null
    const rosterMtime = (): number | null => {
      try {
        return statSync(rosterFile).mtimeMs
      } catch {
        return null
      }
    }
    const readRosterFromDisk = (): RosterRecord[] => {
      try {
        const doc = JSON.parse(readFileSync(rosterFile, 'utf8')) as { teammates?: unknown }
        return Array.isArray(doc.teammates) ? (doc.teammates as RosterRecord[]) : []
      } catch {
        return []
      }
    }
    const readRoster = (): RosterRecord[] => {
      const stamp = rosterMtime()
      if (rosterCache !== null && stamp === rosterStamp) return rosterCache
      rosterCache = readRosterFromDisk()
      rosterStamp = stamp
      return rosterCache
    }
    const writeRoster = (records: RosterRecord[]): void => {
      try {
        mkdirSync(join(ctx.settings.about().home, 'team'), { recursive: true })
        writeFileSync(rosterFile, `${JSON.stringify({ teammates: records }, null, 2)}\n`, 'utf8')
      } catch {
        // 名册写不下去只影响重启后侧栏看不到收工的队友，不该让派活失败
      }
      // 写失败也照此记缓存：下次读 mtime 对不上会强制回读
      rosterCache = [...records]
      rosterStamp = rosterMtime()
    }
    const remember = (teammate: Teammate): void => {
      const record: RosterRecord = {
        name: teammate.name,
        role: teammate.role,
        state: teammate.state,
        task: teammate.task,
        file: teammate.session.filePath,
        cwd: teammate.session.meta.cwd,
        parent: teammate.parent,
        depth: teammate.depth,
        rounds: teammate.rounds,
        startedAt: teammate.startedAt,
        mode: teammate.mode,
        // 出生会话：队友从哪个会话派出去的，名册上永久记着（用户切走会话也认得出它属于谁）
        sessionId: teammate.parentSession.meta.id,
        ...(teammate.taskId === undefined ? {} : { taskId: teammate.taskId }),
        ...(teammate.finishedAt !== undefined ? { finishedAt: teammate.finishedAt } : {}),
      }
      const rest = readRoster().filter((entry) => entry.name !== teammate.name)
      writeRoster([...rest, record].slice(-200))
    }

    // ── 队友运行时 ──────────────────────────────────────────────────────────
    const teammates = new Map<string, Teammate>()
    /** 正在干活的队友（并发额度按会话各计各的，对照 dsh 的 per-session 团队）：收工的不占坑。 */
    const busyFor = (sessionId: string): Teammate[] =>
      [...teammates.values()].filter(
        (entry) => entry.state === 'working' && entry.parentSession.meta.id === sessionId,
      )

    const waitForIdle = (teammate: Teammate): Promise<void> =>
      teammate.state !== 'working'
        ? Promise.resolve()
        : new Promise<void>((resolve) => teammate.waiters.push(resolve))

    /**
     * 绑定任务在队友**成功收工**时自动结项。
     *
     * 只认「任务仍是 in_progress 且负责人就是它」：中途被重新指派、被别人改过、或队友是
     * 被打断/失败收工的，都留给 Lead 在板上处理。CAS 失败只吞掉——板子被并发改过时，
     * 不能因为自动结项把队友的收工流程打断。
     */
    const finishBoundTask = (teammate: Teammate): void => {
      if (teammate.taskId === undefined || teammate.state !== 'idle') return
      const sessionId = teammate.parentSession.meta.id
      try {
        const board = readBoard(sessionId)
        const task = board.tasks.find((entry) => entry.id === teammate.taskId)
        if (task === undefined || task.status !== 'in_progress' || task.owner !== teammate.name) return
        const summary =
          teammate.lastText.trim() === ''
            ? '（队友没有留下文字结论，按收工自动结项）'
            : teammate.lastText.trim().slice(0, 800)
        boardUpdate(sessionId, task.id, board.revision, 'complete', { by: teammate.name, text: summary })
      } catch {
        // 板子被并发改过 / 写不进去：不阻断收工，Lead 还能在板上手动 complete
      }
    }

    const settle = (teammate: Teammate, reason: 'completed' | 'aborted' | 'error', error?: string): void => {
      // 预算最后一轮还欠着（提醒已排队、那一轮还没跑）：这一拍是自然收口，不算收工
      if (teammate.finalRoundPending === true && reason === 'completed' && teammate.rounds < teammate.badge.maxTurns) return
      teammate.finalRoundPending = false
      teammate.finishedAt = Date.now()
      // 汇报正文取「最后一条非空 assistant 正文」：最后一轮可能是纯工具调用（正文为空），
      // 直接取最后一条就会把它当成「什么也没说」，前面真交过的结论反而丢了。
      const tail = [...teammate.session.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim() !== '')
      teammate.lastText = typeof tail?.content === 'string' ? tail.content : ''
      if (reason === 'completed') teammate.state = 'idle'
      else if (reason === 'aborted') teammate.state = 'stopped'
      else {
        teammate.state = 'failed'
        teammate.error = error
      }
      remember(teammate)
      // 绑定任务自动结项：成功收工时把终稿摘要写进任务 note，Lead 不用再猜它做完没有
      finishBoundTask(teammate)
      // T21：队友状态进了快照的跨会话状态面，动一下要跟着失效
      ctx.transcript.touch()
      const waiters = teammate.waiters.splice(0)
      for (const resolve of waiters) resolve()
      // 传话之后欠的那次汇报：等到模型又说过话（或直接失败）才回，且同一轮不重复回
      const pending = teammate.awaitReport
      if (
        pending !== undefined &&
        (teammate.state === 'failed' ||
          (teammate.rounds >= pending.minRound && teammate.rounds > teammate.lastReportedRound))
      ) {
        teammate.awaitReport = undefined
        reportHome(teammate)
      }
      // 一次性的（spawn 时 keep=false）干完就出队：名册里那条记录留着供查看，但不再
      // 占内存、也不再接传话。对照 dsh 的 one-shot：子代理一结束就从 resident 表删掉，
      // 父会话只剩 catalog 里一行；能续接的那种恰恰相反，收工后还能 send_message 叫醒。
      if (teammate.mode === 'one-shot') teammates.delete(teammate.name)
    }

    /** 队友的工具表：按工牌白名单筛。subagent 换成它自己的署名；team_task（本包注册的
     * 共享任务板）保留原实现，只把自己的身份与归属会话塞进上下文，看板认领人才不会都算成
     * lead，也不会在用户切会话后认到别人的板上。协作类工具（{@link COLLAB_TOOL_NAMES}）
     * 不参与白名单筛选：那是协作登记，不是文件权限。 */
    const toolsFor = (teammate: Teammate): ToolEntry[] => {
      const all = ctx.tools.list()
      const allowed =
        teammate.badge.tools === null
          ? all
          : all.filter((entry) => teammate.badge.tools!.includes(entry.name) || COLLAB_TOOL_NAMES.includes(entry.name))
      const self = (): Caller => ({
        name: teammate.name,
        depth: teammate.depth,
        background: teammate.background,
        sessionId: teammate.parentSession.meta.id,
      })
      return allowed.map((entry) => {
        if (entry.name === 'subagent') {
          // 嵌套派活：子队友的父会话是这个队友自己的会话，不是用户正看着的那条。
          return { ...entry, run: (args: Record<string, unknown>, runCtx: ToolContext) => runSubagent(args, runCtx, self(), teammate.session) }
        }
        if (entry.name === 'team_task' || entry.name === 'team_message') {
          // 协作工具：署自己的名字、归属派它的那个会话（板子/消息都不落「当前查看的会话」）
          return { ...entry, run: (args: Record<string, unknown>, runCtx: ToolContext) => entry.run(args, { ...runCtx, caller: self() }) }
        }
        return entry
      })
    }

    /**
     * 队友在**共享守卫链**上的两位守卫（2026-11-09，P0-8）。
     *
     * 以前每个队友自己 `new` 一条 `ToolGuardRegistry`，只挂模式与审批：
     * 主链上的灾难地板（5）、沙箱（8）、安全钩子（20）、生命周期钩子（25）、
     * 改动前预览（25）与溢出（观察者 50）对队友全部不生效——用户在 hooks.json
     * 里写「本项目禁止碰 migrations/」，主会话守得住，队友照样改。
     * 现在队友走共享的 `ctx.guards`（只在一层薄适配器里改写会话归属，见 startTeammate
     * 的 `guards:`），下面两位按**调用方会话归属**分流：只对队友会话说话，对主会话一律 defer。
     *
     * 两条链的差集只保留三处，都是「队友特有、主链给不了」的，写在这里防止以后
     * 又被合并掉：
     *   1. 模式来源：按**派它的那个会话**的 mode 判，不读队友会话自己的状态。
     *      队友会话是临时 jsonl，模式记在派它的那个会话上。
     *   2. 审批等级：全局上限与角色工牌取更严的；后台队友按 foreground 档不许问。
     *   3. 审批归属：卡上写队友的名字，授权记账挂**父会话**，不落到用户正看着的那条。
     * 其余一律共享。共享只会让队友多受约束，不会放宽。
     */

    /** 适配器给守卫入参打的标记：`teammate` 只给本插件自己的两位守卫认人用。 */
    type TeammateGuardInput = ToolGuardInput & { teammate?: string }

    /**
     * 一条会话的「归属会话」：一路走到最上层那个（嵌套队友的父会话可能还是队友）。
     *
     * 权限档、沙箱档、协作模式都记在**用户那条会话**上；停在中间层会拿到一条不在
     * agent 常驻表里的会话，沙箱与审批只能回落成「用户正看着的那条」。
     *
     * 只该在**派活时算一次**（结果存进 `Teammate.ownerSession`）：父队友一次性收工
     * 或被挤出名单后，再沿 `teammates` 往上找会断在中间层（2026-11-09 复审问题 2）。
     */
    const ownerOfSession = (from: Session): Session => {
      let current = from
      const seen = new Set<string>()
      while (!seen.has(current.meta.id)) {
        seen.add(current.meta.id)
        const parent = [...teammates.values()].find((entry) => entry.session.meta.id === current.meta.id)
        if (parent === undefined) break
        current = parent.parentSession
      }
      return current
    }

    /** 队友的归属会话：启动时固化，出队后仍指对最上层那条（见 {@link ownerOfSession}）。 */
    const ownerSession = (teammate: Teammate): Session => teammate.ownerSession

    /**
     * 把「队友会话」登记成共享守卫链上的会话别名：`gate` 分发前会换成归属会话。
     *
     * 为什么在服务层做：MiniAgent 的调用有适配器改写（见 `teammateGuardChain`），但
     * `run_code`（PTC）在脚本里直接 `ctx.guards.gate`，绕过适配器——沙箱据此按队友
     * 会话查表落空，回落成「用户正看着的会话」的档位（2026-11-09 复审问题 1）。
     * 登记在这里，MiniAgent、PTC、钩子三条路自动吃到同一份改写，不用各抄一遍。
     *
     * 生命周期跟着 `teammates` 走：队友出队（一次性收工 / 被挤出名单 / 名册移除）后
     * 表里没了它，解析自然失效；仍在队里的一直指向启动时固化的那条归属会话。
     * 插件卸载时 `ctx.effect` 收回解析器。
     */
    ctx.effect(() => {
      const off = ctx.guards.registerSessionResolver?.('subagent', (sessionId) => {
        for (const teammate of teammates.values()) {
          if (teammate.session.meta.id !== sessionId) continue
          return {
            sessionId: teammate.ownerSession.meta.id,
            sessionPath: teammate.ownerSession.filePath,
            // 原始执行者：写后诊断这类观察者要记回队友会话，不能记到派活会话上。
            facts: { teammate: teammate.name, teammateSessionId: teammate.session.meta.id },
          }
        }
        return undefined
      })
      return () => off?.()
    }, 'subagent: guards.registerSessionResolver')

    /** 按会话 id（或适配器标记）找在队队友；找不到 = 这次调用不是队友发起的。 */
    const teammateOf = (input: ToolGuardInput): Teammate | undefined => {
      const marked = (input as TeammateGuardInput).teammate
      if (marked !== undefined) return teammates.get(marked)
      for (const teammate of teammates.values()) {
        if (teammate.session.meta.id === input.sessionId) return teammate
      }
      return undefined
    }

    /**
     * 队友交给 MiniAgent 的守卫链：**就是共享的 `ctx.guards`**，只在入口把调用方
     * 会话改写成「派它的那个会话」。
     *
     * 为什么必须改写：沙箱（8）、模式（10）、审批（30）都按 `input.sessionId` /
     * `sessionPath` 找会话。队友的运行记录不在 agent 的常驻会话表里（`agent.sessionById`
     * 只认常驻 agent），不改写就会回落成「用户正看着的那条」——用户切到完全访问档的
     * 会话时，队友的写操作会跟着免掉沙箱（2026-11-09 复核发现）。改写后队友按父会话
     * 的档位与策略判，审批卡也仍然落在父会话名下。
     *
     * 这不是第二份注册表：链上每一位仍由主会话那条全局链提供，这里只是把
     * 「这次调用替谁执行」说清楚；`teammate` 标记给本插件自己的两位守卫认人。
     */
    const teammateGuardChain = (teammate: Teammate): ToolGuardChain => ({
      gate: (input) => {
        const owner = ownerSession(teammate)
        const marked: TeammateGuardInput = {
          ...input,
          sessionId: owner.meta.id,
          sessionPath: owner.filePath,
          teammate: teammate.name,
          // 原始执行者（本适配器直接改写、不经解析器，所以这里也要带上）：LSP 诊断按它归属。
          teammateSessionId: teammate.session.meta.id,
        }
        return ctx.guards.gate(marked)
      },
      observe: (toolName, text) => ctx.guards.observe(toolName, text),
    })

    /**
     * 队友的协作模式闸门：order 9 夹在沙箱（8）与主模式闸门（10）之间。
     * 先让沙箱把越界写拦掉，再按**父会话**的档判；判 pass 时与主会话的模式闸门
     * 同一语义（跳过后面的钩子与审批卡，例如免打扰档的工作区内写），判 defer 时
     * 主模式闸门随后仍会按队友会话自己的记录跑一遍（通常是 build → defer）。
     *
     * 为什么不能放 order 5：守卫链里 `pass` 会让后面的守卫全部跳过。放 5 的话，
     * 免打扰模式里一次「工作区内写自动放行」会把 order 8 的沙箱也一起跳掉。
     */
    const teammateModeGuard: ToolGuard = {
      id: 'teammate-mode',
      order: 9,
      decide(input) {
        const teammate = teammateOf(input)
        if (teammate === undefined) return { action: 'defer' }
        const mode = String(ownerSession(teammate).state('mode') ?? 'build')
        const spec = modeSpec(mode)
        const gate = spec.gate({
          toolName: input.toolName,
          risk: input.risk,
          cwd: input.cwd,
          target: input.target,
          command: input.command,
          rules: activeRules(),
        })
        if (gate.action === 'deny') {
          return { action: 'deny', reason: `父会话在「${spec.label}」模式：${gate.reason}` }
        }
        return gate.action === 'pass' ? { action: 'pass' } : { action: 'defer' }
      },
    }
    ctx.effect(() => ctx.guards.register(teammateModeGuard), 'subagent: guards.register (teammate-mode)')

    /**
     * 队友的审批：与主链 order 30 的 `approval` 管同一件事，但**必须排在它前面**（29）。
     * 主审批只认父会话的权限档，不知道队友的工牌：全局上限与角色意愿取更严、后台队友
     * 按 foreground 档不许问、卡上要写是谁在请求——这些只有这里知道。排在 29 还能保证
     * 沙箱（8）、安全钩子（20）、生命周期钩子（25）先说话。
     */
    const teammateApproval = toolApprovalGuard({
      id: 'teammate-approval',
      async approve(input) {
        const teammate = teammateOf(input)
        // 外层 decide 已经筛过：这里找不到只可能是注册后队友被移出表，按拒处理（fail closed）。
        if (teammate === undefined) return false
        const rank = Math.min(APPROVAL_RANK[config.approval], APPROVAL_RANK[teammate.badge.approval])
        const canAsk = rank >= APPROVAL_RANK.foreground && (rank === APPROVAL_RANK.ask || !teammate.background)
        if (!canAsk) return false
        const owner = ownerSession(teammate)
        const decision = await ctx.approval.decide(
          {
            toolName: `队友 ${teammate.name}（${teammate.role}）· ${input.toolName}`,
            argsSummary: argsSummary(input.args),
            args: input.args,
            cwd: input.cwd,
            // 队友的审批按**派它的那个会话**归属：不能落到「用户正在看的会话」，
            // 否则权限模式会拿错档（2026-10-28 按会话隔离后这条必须显式给）。
            sessionId: owner.meta.id,
            sessionPath: owner.filePath,
          },
          input.signal,
        )
        return decision !== 'reject'
      },
      deniedReason: REJECTED_TOOL_TEXT,
    })
    const teammateApprovalGuard: ToolGuard = {
      ...teammateApproval,
      order: 29,
      async decide(input) {
        // 只对队友会话生效；主会话与后台会话的调用照旧交给 order 30 的审批。
        if (teammateOf(input) === undefined) return { action: 'defer' }
        return teammateApproval.decide(input)
      },
    }
    ctx.effect(() => ctx.guards.register(teammateApprovalGuard), 'subagent: guards.register (teammate-approval)')

    /**
     * 队友系统提示里的「团队协作」段（每次渲染现读磁盘与内存，天然最新）。
     *
     * 为什么要在**每个队友**的提示里写队伍与任务板：用户要求「任何队友都能看到板上进展
     * 与其他队友进展」。只靠 Lead 转述时，队友连板子长什么样都不知道，更谈不上自己认领、
     * 写进展、找别人协商。这里只塞摘要（最多 20 条任务、10 条活动），不是整份板子。
     */
    const teamCollabText = (teammate: Teammate): string => {
      const sessionId = teammate.parentSession.meta.id
      const board = readBoard(sessionId)
      const mates = [...teammates.values()].filter((entry) => entry.parentSession.meta.id === sessionId)
      const mateLines = mates.map(
        (entry) =>
          `- ${entry.name}（${entry.role}，${entry.state}${entry.taskId === undefined ? '' : `，绑定 ${entry.taskId}`}）`,
      )
      const boardBlock = config.board
        ? `

任务板（第 ${board.revision} 版，队友和 Lead 共用同一块）：
${board.tasks.slice(0, 20).map((task) => taskDigestLine(board, task)).join('\n') || '- （板上还没有任务）'}

最近活动（新的在前）：
${board.activity.slice(0, 10).map(activityDigestLine).join('\n') || '- （暂无）'}`
        : ''
      const rules = config.board
        ? `
协作规则：
1. 动手前先 team_task list 与 action=activity，看板上已有什么、别人做到哪一步，别重复别人正在做的事。
2. 进展写进任务：team_task action=note（做了什么、验证结果、下一步）；卡住用 action=block 写原因，解除用 unblock。
3. 要问人、要协调用 team_message：send 点对点（队友名或 lead）、broadcast 广播；同一轮最多发 ${TEAM_MESSAGES_PER_ROUND} 条。
4. 写作用域和别人的任务重叠时先 team_message 协商，不要同时改同一批文件。
5. 你绑定的任务在成功收工时会自动结项并写入你的最终结论；有遗留问题就写进结论里。`
        : '\n协作规则：本会话任务板未开启；需要找人时用可用的消息工具，重要结论写进你的最终回复。'
      return `# 团队协作
你所在队伍的队友（本会话）：
${mateLines.join('\n') || '- （只有你）'}${boardBlock}${rules}`
    }

    function startTeammate(input: {
      name: string
      role: AgentRole
      task: string
      caller: Caller
      background: boolean
      seed: string[] | null
      parentSession: Session
      /** 不填 = 寻常队友（收工后还能传话接着干）。 */
      mode?: TeammateMode
      /** spawn 显式指定的模型（已归一成 `端点/模型`）；不填看角色文件与旧配置兜底。 */
      model?: string | null
      /** spawn 显式指定的思考强度；不填看角色文件。 */
      effort?: EffortLevel | null
      /** spawn 带 `task_id` 时绑定的任务板任务 id（认领与绑定已在 runSubagent 里做完）。 */
      taskId?: string
    }): Teammate {
      const cwd = input.parentSession.meta.cwd
      const file = join(teammateRoot(), cwdSlug(cwd), `${randomUUID()}.jsonl`)
      mkdirSync(join(teammateRoot(), cwdSlug(cwd)), { recursive: true })
      const id = randomUUID()
      let session: Session
      if (input.seed === null) {
        session = Session.create(cwd, file)
      } else {
        const meta = JSON.stringify({ type: 'meta', id, cwd, createdAt: Date.now() })
        writeFileSync(file, [meta, ...input.seed].join('\n') + '\n', 'utf8')
        session = Session.load(file, true)
      }

      // 优先级：spawn 显式 > 角色文件 > 旧配置 defaultModel（兼容兜底）> 跟随当前会话
      const model = resolveTeammateModel(input.model ?? null, input.role, config.defaultModel)
      const effort = resolveTeammateEffort(input.effort ?? null, input.role)
      const teammate: Teammate = {
        name: input.name,
        role: input.role.name,
        task: input.task,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        // 工牌在此刻冻结：此后改角色文件不影响它
        badge: {
          tools: input.role.tools,
          // 角色文件显式 max-turns > 设置页按角色默认值 > 全局上限（取更严），见 resolveMaxTurns
          maxTurns: roleMaxTurns(input.role),
          approval: input.role.approval,
          model,
          effort,
        },
        session,
        parentSession: input.parentSession,
        // 归谁管：派活时算一次并固化，父队友后来出队也不影响（见 ownerOfSession）
        ownerSession: ownerOfSession(input.parentSession),
        state: 'working',
        rounds: 0,
        toolCalls: 0,
        lastReportedRound: 0,
        depth: input.caller.depth + 1,
        parent: input.caller.name,
        mode: input.mode ?? 'continuable',
        background: input.background,
        startedAt: Date.now(),
        lastText: '',
        waiters: [],
        outputLines: [],
        tokens: 0,
        agent: undefined as unknown as MiniAgent,
      }

      /** 正文按行攒的缓冲（delta 碎片凑整行进瀑布）。 */
      let lineBuffer = ''
      teammate.agent = new MiniAgent(
        {
          route: () => {
            // 模型：显式指定优先；否则跟着父会话的端点/模型走。
            // 思考强度要单独覆盖：即使模型跟随会话，spawn/角色文件给的 effort 也得生效，
            // 所以这里用 routeTo（不改当前选择）而不是直接 routeForSession。
            if (teammate.badge.model !== null) {
              const at = teammate.badge.model.indexOf('/')
              const provider = at > 0 ? teammate.badge.model.slice(0, at) : teammate.badge.model
              const modelId = at > 0 ? teammate.badge.model.slice(at + 1) : ''
              return ctx.llm.routeTo(provider, modelId, teammate.badge.effort ?? 'default')
            }
            if (teammate.badge.effort !== null) {
              return ctx.llm.routeTo(
                ctx.llm.providerOf(teammate.parentSession),
                ctx.llm.modelOf(teammate.parentSession),
                teammate.badge.effort,
              )
            }
            return ctx.llm.routeForSession(teammate.parentSession)
          },
          // 子代理的 deps 没有 rewrite（主会话的 env-facts 投影对子代理不生效），
          // 又没有尾部快照那条路，所以环境/模型事实直接写进它自己的系统提示词。
          // cwd 取派它的那个会话（子代理在父会话的 cwd 下干活），模型取冻结的工牌。
          systemPrompt: () => {
            const text = `${input.role.prompt}

${subagentEnvironmentText(input.parentSession.meta.cwd, teammate.badge.model ?? ctx.llm.model)}

# 你在团队里的位置
你是队友「${teammate.name}」（角色 ${teammate.role}），派你活的是「${teammate.parent}」。
${
            teammate.badge.maxTurns > 0
              ? `你最多能发 ${teammate.badge.maxTurns} 次模型请求，用完会被自动收手，请把力气花在关键处；最后一轮不再给你工具，那轮直接交结论。`
              : '轮次不设上限，但每轮都要往结论推进，别在同一个问题上打转。'
          }
${teammateModelNote(teammate.badge.model ?? ctx.llm.model, teammate.badge.effort, config.allowModelSelection)}
${teammate.badge.tools === null ? '' : `你只被授权这些工具：${teammate.badge.tools.join('、')}。用别的办法办不成就在最后一段说清楚，让 ${teammate.parent} 决定。${config.board ? '协作类工具（team_task）不受这份名单限制：任务板是团队共用的登记表，认领与结项直接用。' : ''}`}
${teammate.badge.approval === 'forbid' ? '你不能向用户请求授权：需要授权的操作会被直接拒绝，不要反复尝试。' : '需要授权的操作可以向用户请求，审批卡上会写明是你（' + teammate.name + '）在请求。'}
${teamCollabText(teammate)}
干完活用一段话交结果：做了什么、看到什么证据（文件名:行号）、还有什么没做。`
            // 队友的提示词不在段注册表里（它是几块直接拼的），给「系统提示」卡一条合成段：
            // 卡片至少能显示体量与来源，不至于空着一张段清单（队友的日志只在只读浮层里看）。
            return {
              text,
              sections: [{ id: 'teammate', order: 0, chars: text.length, from: 'plugin:subagent' as const }],
            }
          },
          // 设限时的最后一轮：工具表收成空，逼它用文本交结论（否则它会一直调工具直到被掐）
          tools: () =>
            teammate.badge.maxTurns > 0 && teammate.rounds >= teammate.badge.maxTurns - 1
              ? []
              : toolsFor(teammate),
          guards: teammateGuardChain(teammate),
          stream: (api, request, handlers) => ctx.llm.stream(api, request, handlers),
          emit: (event) => {
            if (event.type === 'turn/start') {
              // 被传话叫醒的队友从「已停止」回到干活中：状态不翻，界面会一直挂着停着的字样
              teammate.state = 'working'
              delete teammate.finishedAt
              ctx.transcript.touch()
            } else if (event.type === 'message') {
              teammate.rounds += 1
              const budget = teammate.badge.maxTurns
              if (budget > 0) {
                if (teammate.rounds >= budget) {
                  // 轮次预算到点就收手：这就是「子智能体不许无限自转」的闸门。
                  // 最后一轮的工具表已经收成空，正常应当以正文收束；它偏要再调工具
                  // 才真正掐掉（走到 executeToolCalls 之前就会看到 aborted）。
                  if ((event.toolCalls?.length ?? 0) > 0) teammate.agent.cancel()
                } else if (teammate.rounds === budget - 1) {
                  // 最后一轮留给汇报：先提醒它交结论，下一轮再把工具收走。
                  // 提醒排在收件箱里，模型若就此收口，它会单独起最后一轮（settle 那边等着）。
                  teammate.finalRoundPending = true
                  teammate.agent.followup('下一轮是最后一次，直接给结论，不要再调工具', undefined, 'notice')
                }
              }
            } else if (event.type === 'tool/call') {
              teammate.toolCalls += 1
              teammate.lastTool = {
                name: event.name,
                args: event.args.replace(/\s+/g, ' ').trim().slice(0, 60),
                status: 'running',
              }
            } else if (event.type === 'tool/result') {
              if (teammate.lastTool !== undefined) {
                teammate.lastTool = {
                  ...teammate.lastTool,
                  status: event.error !== undefined && event.error !== 'rejected' ? 'failed' : 'done',
                }
              }
              // 工具结果首行进瀑布：跑动期间 teammate 说话少、动手多，结果行才是活信号
              const firstLine = event.text.split('\n').map((line) => line.trim()).find((line) => line !== '')
              if (firstLine !== undefined) pushLines(teammate.outputLines, firstLine)
            } else if (event.type === 'delta' && event.kind === 'text') {
              // 正文增量按行攒：成行的推进瀑布（跟主会话直播尾同一节奏，不需要节流器）
              lineBuffer += event.text
              let newline = lineBuffer.indexOf('\n')
              while (newline >= 0) {
                pushLines(teammate.outputLines, lineBuffer.slice(0, newline))
                lineBuffer = lineBuffer.slice(newline + 1)
                newline = lineBuffer.indexOf('\n')
              }
            } else if (event.type === 'usage') {
              teammate.tokens += event.inputTokens + event.outputTokens
            } else if (event.type === 'turn/end') {
              if (lineBuffer.trim() !== '') pushLines(teammate.outputLines, lineBuffer)
              lineBuffer = ''
              settle(teammate, event.reason, lastError.get(teammate.name))
            } else if (event.type === 'error') {
              lastError.set(teammate.name, event.message)
            }
            forwardSubagent()
          },
        },
        session,
      )

      teammates.set(teammate.name, teammate)
      remember(teammate)
      // T21：新队友一上场就是 working，快照的状态面跟着失效
      ctx.transcript.touch()
      teammate.agent.followup(input.task)
      // 开卡先落一张头行（事件流到达前的 0 空窗），之后每次事件原位刷新
      forwardSubagent()
      return teammate

      /** 正文行进瀑布：只留最后 8 行，瀑布永远显示「最新发生的事」。 */
      function pushLines(pool: string[], line: string): void {
        const trimmed = line.trim()
        if (trimmed === '') return
        pool.push(trimmed)
        if (pool.length > 8) pool.splice(0, pool.length - 8)
      }

      /**
       * 把队友的当前快照转发给父会话的内联卡。只在父会话正被查看时投递——
       * 转录是「当前查看会话」的那一份，往里折别家会话的卡就是串台；切回时
       * 转录插件按名册种回头行卡，之后的转发接上原位刷新。
       */
      function forwardSubagent(): void {
        if (ctx.session.current() !== teammate.parentSession) return
        ctx.transcript.emit({
          type: 'subagent',
          row: {
            name: teammate.name,
            role: teammate.role,
            task: teammate.task,
            state: teammate.state,
            mode: teammate.mode,
            model: teammate.badge.model ?? ctx.llm.model,
            rounds: teammate.rounds,
            toolCalls: teammate.toolCalls,
            startedAt: teammate.startedAt,
            ...(teammate.finishedAt !== undefined ? { finishedAt: teammate.finishedAt } : {}),
            ...(teammate.lastTool !== undefined ? { lastTool: { ...teammate.lastTool } } : {}),
            ...(teammate.outputLines.length > 0 ? { outputLines: [...teammate.outputLines] } : {}),
            ...(teammate.tokens > 0 ? { tokens: teammate.tokens } : {}),
            ...(teammate.error !== undefined ? { error: teammate.error } : {}),
            file: teammate.session.filePath,
          },
        })
      }
    }

    /** 队友报错文本暂存（emit 的 error 事件比 turn/end 早一步）。 */
    const lastError = new Map<string, string>()

    /**
     * 没留下文字结论时的说明。
     *
     * 为什么单独写：队友被停机、或轮次预算用完时，运行记录里往往只有一串工具调用、
     * 一句正文都没有；原话「（它没留下文字结论）」既不说明原因，也不给证据位置。
     * 这里标出原因并把运行记录路径给用户，让人能自己去看它干到了哪一步。
     * @param withPath - 上文已经给过路径时传 false，免得同一段话里出现两遍。
     */
    const noTextNote = (teammate: Teammate, withPath = true): string => {
      const budget = teammate.badge.maxTurns
      const why =
        budget > 0 && teammate.rounds >= budget
          ? `轮次预算用完（${budget} 轮），没交最终结论`
          : teammate.state === 'stopped'
            ? `被停机（第 ${teammate.rounds} 轮），没交最终结论`
            : '没交最终结论'
      return withPath ? `${why}。运行记录：${teammate.session.filePath}` : why
    }

    /** 后台队友干完，把汇报交给派它的那一方。 */
    const reportHome = (teammate: Teammate): void => {
      teammate.lastReportedRound = teammate.rounds
      const state = teammate.state === 'idle' ? '已完成' : teammate.state === 'stopped' ? '已停止' : '已失败'
      const body =
        teammate.state === 'failed'
          ? `（它失败了：${teammate.error ?? '未知错误'}）`
          : teammate.lastText === ''
            ? noTextNote(teammate)
            : teammate.lastText
      const notice = `${TEAMMATE_REPORT_OPEN}from="${teammate.name}" role="${teammate.role}" state="${state}">
派给它的任务：${teammate.task}
它的汇报：
${body}
</teammate-report>`
      if (teammate.parent !== LEAD) {
        // 派它的是另一个队友：直接投进它的信箱并叫醒它
        const parent = teammates.get(teammate.parent)
        if (parent !== undefined) {
          inboxAppend(parent.name, notice)
          parent.agent.followup(notice, undefined, 'notice')
          return
        }
      }
      const line = `队友 ${teammate.name}，角色 ${teammate.role}，${state}`
      const live = ctx.session.current() === teammate.parentSession
      // 0.6.48 常驻多 agent：父会话正被查看、或它的 agent 还常驻（后台跑着/刚切走），
      // 汇报都投给那个 agent（跑动中进收件箱，闲置的唤起一轮后台回合）；已经收摊的
      // 才写文件等用户回去看到——不打断也不抢跑。
      const parentResident = ctx.agent.hasAgent(teammate.parentSession.meta.id)
      if (config.notify === 'auto' && (live || parentResident)) {
        // 队友汇报是机器发起的唤醒：跑动中入箱时标 notice，界面画在输入框上方的
        // 只读通知条（不是输入框下方的用户队列条），不给人编辑 / 撤掉 / 插话。
        ctx.agent.followup(notice, undefined, teammate.parentSession.meta.id, 'notice')
        // 带归属：父会话在后台时，这句回执只该进它自己的视图（0.6.68）
        ctx.transcript.system(
          `${line}，汇报已${live ? '并入下一轮' : '投进后台会话'}`,
          undefined,
          undefined,
          teammate.parentSession.meta.id,
        )
      } else {
        // 静默，或者父会话的 agent 已收摊：话写进它所属的那个会话文件，
        // 等用户回到那个会话再说话时模型自然看到，不打断也不抢跑。
        teammate.parentSession.appendUser(notice)
        ctx.transcript.system(
          live
            ? `${line}，汇报已写入会话，下一条消息时模型会看到`
            : `${line}，汇报写入了派出它的会话`,
          undefined,
          undefined,
          teammate.parentSession.meta.id,
        )
      }
    }

    // ── 侧栏要的服务 ────────────────────────────────────────────────────────
    // 队友清单、只读查看与两条管理通道：UI 因此不必知道队友文件放在哪，
    // 插件关着时这个服务也不存在。
    const teamService: TeamService = {
      list: (): TeammateView[] => {
        const views: TeammateView[] = []
        for (const record of readRoster()) {
          // 在队的队友以内存为准（轮数、状态都在动），收工的以名册为准
          const live = teammates.get(record.name)
          const finishedAt = live?.finishedAt ?? record.finishedAt
          // 出生会话同理：在队的问内存里那个会话对象，收工的问名册（老记录没有这一项）
          const sessionId = live?.parentSession.meta.id ?? record.sessionId
          const taskId = live?.taskId ?? record.taskId
          views.push({
            name: record.name,
            role: record.role,
            // 本进程里它并不活着，却按名册残留报「working」就是撒谎（上次进程没
            // settle 就退了）——僵尸读作 stopped；远程待命的双进程共享名册，
            // 所以只修读路径、不做启动清写，避免误标宿主进程的活队友。
            state: live !== undefined ? live.state : record.state === 'working' ? 'stopped' : record.state,
            task: record.task,
            file: live === undefined ? record.file : live.session.filePath,
            parent: record.parent,
            depth: record.depth,
            // 老名册没有这一项：那时只有可续接的一种，缺省按它算
            mode: live?.mode ?? record.mode ?? 'continuable',
            rounds: live === undefined ? record.rounds : live.rounds,
            startedAt: record.startedAt,
            ...(finishedAt === undefined ? {} : { finishedAt }),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(taskId === undefined ? {} : { taskId }),
          })
        }
        return views.sort((a, b) => b.startedAt - a.startedAt)
      },
      board: (sessionId: string): TeamBoardView => {
        // 只读投影：界面只画「有哪些事、谁负责、可不可以开工」与最新进展/活动，
        // 改任务仍旧只走模型的 team_task。投影与提示词共用 boardViewOf，口径只有一份。
        return boardViewOf(readBoard(sessionId))
      },
      peek: async (file: string): Promise<TranscriptEntry[]> => {
        const resolved = resolve(file)
        if (!resolved.startsWith(resolve(teammateRoot()))) {
          throw new Error('这里只能看队友的运行记录（其它会话请在左侧打开）')
        }
        // 只读：载入内存重放，不往那个文件写任何东西（也不拿写租约——队友可能正活着写它）
        const session = Session.load(resolved, true, { lease: false })
        const replay = new Transcript()
        replay.replayHistory(session.messages, session.toolErrors, session.fileChanges, session.presentations)
        return [...replay.entries, ...replay.liveEntries()]
      },
      // 用户从界面上管理队友的两条通道：与模型用的 subagent 工具走同一段逻辑，
      // 只是署名换成 user（队友信箱里看得出这句话是人说的）；
      // 名字不存在时返回的那句话本身就是给用户看的错误说明。
      stop: async (name: string): Promise<string> => stopTeammate(name, 'stop'),
      // 会话级的收摊（superagent 的执行器在工单结束时调）：它派出去的队友不该继续跑，
      // 那些队友的父会话已经没人认领了。上游同一步是 `stopSubagents`
      //（`executor/background.ts:141-153`）。单个收不掉不影响其它的——一个失败的队友
      // 不该把整张工单的收尾拖垮。
      stopBySession: async (sessionId: string): Promise<string[]> => {
        const mine = [...teammates.values()].filter((entry) => entry.parentSession.meta.id === sessionId)
        const names: string[] = []
        for (const entry of mine) {
          try {
            stopTeammate(entry.name, 'stop')
            names.push(entry.name)
          } catch {
            // 见上：一个收不掉不拦其它的。
          }
        }
        return names
      },
      message: async (name: string, text: string): Promise<string> => messageTeammate(name, text, 'user'),
      remove: async (name: string): Promise<string> => {
        // 还在干活的先停止（文件正被流式写入，删了也会被重建）；收工的才许移除
        const live = teammates.get(name)
        if (live !== undefined && live.state === 'working') {
          return `队友「${name}」还在干活：先停止，再从名册移除。`
        }
        const record = readRoster().find((entry) => entry.name === name)
        if (live === undefined && record === undefined) return `名册里没有叫「${name}」的队友。`
        // 真正收掉这一位：会话文件要关（释放写租约），再从名单里摘
        live?.agent.dispose()
        teammates.delete(name)
        writeRoster(readRoster().filter((entry) => entry.name !== name))
        // 运行记录文件一并删：它只在名册里可达，留着就是孤儿。只认 teammateRoot 下的路径，
        // 删不动（被占用等）不算失败——名册已经摘掉，孤儿文件不影响任何列表。
        const file = live?.session.filePath ?? record?.file
        let removedFile = false
        if (typeof file === 'string' && file !== '') {
          const resolvedFile = resolve(file)
          if (resolvedFile.startsWith(resolve(teammateRoot()))) {
            try {
              // rmSync 的 force 对不存在的文件也算成功：如实报告文件本来就在不在
              const existed = existsSync(resolvedFile)
              rmSync(resolvedFile, { force: true })
              rmSync(`${resolvedFile}.lock`, { force: true })
              removedFile = existed
            } catch {
              // 文件被占用：下次同位置的记录不冲突（uuid 命名），孤儿文件无害
            }
          }
        }
        // T21：队友名册进了快照的跨会话状态面，摘掉也要让侧栏/面板立刻知道
        ctx.transcript.touch()
        return removedFile
          ? `已把「${name}」从名册移除，运行记录一并删除。`
          : `已把「${name}」从名册移除（它的运行记录文件不在了，跳过删除）。`
      },
    }
    ctx.provide('team', teamService)

    // ── 只读代码审查通道（T45）─────────────────────────────────────────────
    // /review 的升级路径：派一个工牌被强制压到只读交集的队友（工具 = read/glob/grep，
    // 审批 = forbid，与角色文件怎么改无关），后台审查，findings 以 <review-findings>
    // 包裹写回发起会话——渲染层解析成卡片，主会话不吃模型轮。
    //
    // 完整 diff 由 core/git-info 的 collectReviewScope 落盘，任务书里只给路径与读法：
    // 审查队友有 read，可以按 offset/limit 分批读完，不需要把 diff 截断塞进描述。
    const READONLY_TOOLS = ['read', 'glob', 'grep']

    /**
     * 审查记录账本：内存记「本会话有没有在跑的审查」，磁盘留最近一次的状态与结论。
     * 数据目录取 settings.about().home（就是 DSC_HOME），重启后 /review-status 仍读得到。
     */
    const reviewJournal = new ReviewJournal(ctx.settings.about().home)

    const spawnReviewer = (request: ReviewSpawnRequest): ReviewSpawnResult => {
      const parentSession = ctx.session.current()
      const working = busyFor(parentSession.meta.id)
      if (working.length >= config.maxTeammates) {
        return {
          ok: false,
          reason: `正在干活的队友已到上限 ${config.maxTeammates} 个（${working.map((entry) => entry.name).join('、')}），等一个收工再 /review`,
        }
      }
      // 角色文件被用户删掉也照常可审：从出厂定义就地取（不落盘）；无论来自哪个文件，
      // 工牌都再压一次只读交集——审查通道的「天然安全」不依赖用户配置。
      const base = findRole('reviewer') ?? builtinRole('reviewer')
      if (base === null) return { ok: false, reason: 'reviewer 角色定义不可用（内置角色缺失）' }
      const role: AgentRole = { ...base, tools: [...READONLY_TOOLS], approval: 'forbid' }
      const teammate = startTeammate({
        name: uniqueName('reviewer'),
        role,
        task: reviewTaskText(request.scope, request.focus),
        caller: { name: LEAD, depth: 0, background: true },
        background: true,
        seed: null,
        parentSession,
      })
      // 先登记再等收工：这中间用户可能已经 /review-status 或 /review-cancel
      reviewJournal.begin(parentSession.meta.id, {
        target: request.scope.label,
        handle: teammate.name,
        startedAt: teammate.startedAt,
      })
      void waitForIdle(teammate).then(() => deliverReview(teammate))
      return { ok: true, name: teammate.name }
    }

    /** 审查收工：findings（或失败原因）写进发起会话，渲染层认 <review-findings> 标记出卡。 */
    const deliverReview = (teammate: Teammate): void => {
      const sessionId = teammate.parentSession.meta.id
      // 取消过的那次：记录与上屏都用同一句实话，别让「已停止」把「被取消」盖掉
      const wasCancelled = reviewJournal.wasCancelled(sessionId)
      const state = teammate.state === 'idle' ? '已完成' : teammate.state === 'stopped' ? '已停止' : '已失败'
      const body =
        wasCancelled
          ? REVIEW_CANCELED_TEXT
          : teammate.state === 'failed'
            ? `审查没有完成：${teammate.error ?? '未知错误'}`
            : teammate.state === 'stopped'
              ? '审查被停止，没有交回结论。'
              : teammate.lastText === ''
                ? '审查没有留下文字结论。'
                : teammate.lastText
      const notice = `${REVIEW_FINDINGS_OPEN}teammate="${teammate.name}" state="${state}">\n${body}\n</review-findings>`
      const line = `审查队友 ${teammate.name}，${state}`
      teammate.parentSession.appendUser(notice)
      // 记录跟着收工：/review-status 回看的就是这里写下去的那份
      reviewJournal.finish(sessionId, body, teammate.name)
      const live = ctx.session.current() === teammate.parentSession
      ctx.transcript.system(live ? `${line}，findings 已写进会话` : `${line}，findings 写入了派出它的会话`)
      ctx.transcript.touch()
    }

    const reviewService: ReviewService = {
      spawn: spawnReviewer,
      status() {
        return reviewJournal.status(ctx.session.current().meta.id)
      },
      cancel() {
        const sessionId = ctx.session.current().meta.id
        const run = reviewJournal.running(sessionId)
        if (run === undefined) return false
        // 叫停走队友那条现成的路（agent.cancel + 保留名册），再把记录标成取消
        stopTeammate(run.handle, 'stop')
        reviewJournal.cancel(sessionId)
        return true
      },
    }
    ctx.provide('review', reviewService)

    // ── 模型侧工具 ──────────────────────────────────────────────────────────
    function uniqueName(role: string): string {
      // 收工队友的名字也占着（名册里），不然两次启动会撞名
      const remembered = new Set(readRoster().map((entry) => entry.name))
      for (let index = 1; index < 100; index += 1) {
        const candidate = `${role}-${index}`
        if (!teammates.has(candidate) && !remembered.has(candidate)) return candidate
      }
      return `${role}-${Date.now()}`
    }

    /**
     * `subagent` 的 interrupt/stop 与界面管理通道（TeamService.stop）共用的那一条。
     * 两条路的话术刻意保持一字不差：模型与用户看到的是同一件事。
     */
    function stopTeammate(name: string, mode: 'interrupt' | 'stop'): string {
      const teammate = teammates.get(name)
      if (teammate === undefined) {
        // 一次性收工后已经从在队表里摘掉，但名册里还有它那一行：说「没这个队友」是错的。
        const record = readRoster().find((entry) => entry.name === name)
        if (record?.mode === 'one-shot') return `${name} 是一次性子智能体，已经结束了，没有在跑的回合可以叫停。`
        return `没有叫 ${name} 的队友（subagent list 看现役名单）`
      }
      teammate.agent.cancel()
      // 两种叫停都**保留**这个队友：dsh 的 interrupt_agent 就是这个口径——停当前这一轮，
      // 之后还能用 send_message 接着聊。以前 stop 直接把它从名单里删掉，于是「中断之后
      // 还能不能继续」的答案是「不能」，信箱里的话也没人读（2026-10-27 查账）。
      // 真要清掉走名册里的「移除」（TeamService.remove），那里才删文件、释放名字。
      return `${name} ${mode === 'interrupt' ? '这一轮被打断了（信箱里的话还在，传话就能接着用）' : '已叫停（保留在名册里，可以传话接着用；要彻底清掉用名册里的移除）'}`
    }

    /**
     * `subagent` 的 message 与界面传话通道（TeamService.message）共用的那一条。
     * @param from - 署名：模型派话是派它的那一方，用户传话是 'user'。
     */
    function messageTeammate(name: string, text: string, from: string): string {
      const trimmed = text.trim()
      if (trimmed === '') return 'message 要带上 text（想传的话）'
      const teammate = teammates.get(name)
      // 一次性的已经收工（settle 时从队里摘掉了）：它不接后续消息。这一步排在写信箱
      // 之前——否则这句话会投进一个没人读的信箱，界面还回一句「话已投给」，看着像送到了。
      // 对照 dsh 的 NOT_CONTINUABLE 报错：「does not accept follow-up input」。
      if (teammate === undefined) {
        const record = readRoster().find((entry) => entry.name === name)
        if (record?.mode === 'one-shot') {
          return `${name} 是一次性子智能体：干完就结束了，不再接后续消息。它的运行记录还在，点开能看完整过程。`
        }
      }
      const wrapped = `<message from="${from}"> ${trimmed} </message>`
      inboxAppend(name === '' ? 'unknown' : name, wrapped)
      if (teammate === undefined) return `没有叫 ${name} 的队友，话写进了它的信箱（${join(ctx.settings.about().home, 'team', 'inbox')}）但没人会读`
      // 传话之后欠一次汇报：它这一轮（或下一轮）说完了，主会话要接得到
      teammate.awaitReport = { minRound: teammate.rounds + 1 }
      teammate.agent.followup(wrapped)
      return `话已投给 ${name}${teammate.state === 'working' ? '（它正在干，会在这轮结束后看到）' : '（已把它叫醒）'}，它说完会把结果报回来`
    }

    async function runSubagent(
      args: Record<string, unknown>,
      runCtx: { cwd: string; signal: AbortSignal },
      caller: Caller,
      parent: Session,
    ): Promise<string> {
      const action = String(args.action ?? '')
      const roster = listRoles()
      // 名单按会话隔离（对照 dsh 的 parentSession 过滤）：本会话只能看见自己派出的队友，
      // 别的会话的在队名单不外漏；跨会话管理请回到派出它的那个会话。
      // 归属会话来自调用方，不看 `ctx.session.current()`：队友在后台跑、用户切走之后，
      // 「当前查看的会话」已经不是派它的那一条了。
      const currentId = parent.meta.id
      const mine = [...teammates.values()].filter((entry) => entry.parentSession.meta.id === currentId)
      if (action === 'list') {
        const lines = mine.map(
          (entry) =>
            `- ${entry.name}（角色 ${entry.role}，${entry.state}${entry.mode === 'one-shot' ? '，一次性' : ''}，第 ${entry.rounds} 轮，${entry.toolCalls} 次工具调用）派给它的任务：${entry.task.slice(0, 60)}`,
        )
        const roles = roster.map((role) => `- ${role.name}${role.enabled ? '' : '（已停用）'}：${role.description || '（没写 description）'}`).join('\n')
        return lines.length === 0
          ? `本会话没有在队或收工的队友。\n\n可用角色：\n${roles}`
          : `本会话在队/收工的队友：\n${lines.join('\n')}\n\n可用角色：\n${roles}`
      }
      if (action === 'interrupt' || action === 'stop') {
        return stopTeammate(String(args.name ?? ''), action)
      }
      if (action === 'message') {
        return messageTeammate(String(args.name ?? ''), String(args.text ?? ''), caller.name)
      }
      if (action !== 'spawn') {
        return `不认识的 action「${action}」。要用的值：spawn / list / message / interrupt / stop`
      }

      if (caller.depth >= config.maxDepth) {
        return `你在第 ${caller.depth} 层，设置只允许到 ${config.maxDepth} 层，不能再往下派队友（要放开去设置「子智能体」调「允许层数」）`
      }
      const roleName = String(args.role ?? '').trim()
      const role = findRole(roleName)
      if (role === null) {
        const available = roster.filter((entry) => entry.enabled).map((entry) => entry.name)
        return `角色 ${roleName || '（没填）'} 不可用。可用角色：${available.join('、') || '（无，去 ' + DSC_AGENTS_DIR + ' 建一个）'}${roster.some((entry) => entry.name === roleName && !entry.enabled) ? `；${roleName} 存在但被停用了，在设置「子智能体」里打开` : ''}`
      }
      const task = String(args.task ?? '').trim()
      if (task.length < 8) return '任务描述太短：队友看不到你和用户的对话，请把背景、目标、交付格式写清楚'
      // 模型/思考强度覆盖：开关关闭时带 model 直接拒；开启时只能在用户授权的清单里挑。
      // 归一结果在工牌冻结那一刻生效（见 startTeammate），只影响这个新队友。
      const overrides = resolveSpawnOverrides(
        args.model,
        args.effort,
        { allow: config.allowModelSelection, allowed: config.allowedModels },
        (ref) => ctx.llm.parseModelRef(ref),
      )
      if (!overrides.ok) return overrides.reason
      const working = busyFor(currentId)
      if (working.length >= config.maxTeammates) {
        return `本会话正在干活的队友已到上限 ${config.maxTeammates} 个（${working.map((entry) => entry.name).join('、')}）。等一个收工，或去设置「子智能体」里提高上限`
      }
      // 收工的队友留着可以被追问，但攒太多就把最老的挤出名单（磁盘上的运行记录不动）
      const finished = [...teammates.values()].filter((entry) => entry.state !== 'working')
      if (finished.length > MAX_LISTED_FINISHED) {
        for (const entry of finished
          .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))
          .slice(0, finished.length - MAX_LISTED_FINISHED)) {
          // 挤出名单不能只删 Map 项：队友会话还握着写租约，不 close 会一直占着，
          // 下次同路径会话可能被当成「另一个进程正在写」。取消是幂等的（收工后再调是空操作）。
          entry.agent.cancel()
          entry.session.close()
          teammates.delete(entry.name)
        }
      }
      const requested = String(args.name ?? '').trim()
      if (requested !== '' && !NAME_OK.test(requested)) {
        return `队友名「${requested}」不合法：只能用小写字母、数字、连字符`
      }
      const name = requested === '' ? uniqueName(role.name) : requested
      if (teammates.has(name)) return `队友名 ${name} 已经在用，换一个`

      // 任务绑定：带 task_id 就顺手认领并绑定（一次 CAS 里做完 owner + assignee）。
      // 认领前必须满足「没完成、没被别人认领、依赖都完成」——不满足就给明确原因，
      // 不要悄悄派出去（队友干到一半才发现板子上不归它）。
      const taskId = String(args.task_id ?? '').trim()
      if (taskId !== '') {
        const board = readBoard(currentId)
        const target = board.tasks.find((entry) => entry.id === taskId)
        if (target === undefined) {
          return `任务板上没有 ${taskId}。先 team_task action=list 确认 id，或去掉 task_id 直接派`
        }
        if (target.status === 'completed') return `${taskId} 已经完成了，不用再派队友去做`
        if (target.owner !== null && target.owner !== name) {
          return `${taskId} 已经被 ${target.owner} 认领了，换一条任务或先让它 release`
        }
        if (!isReady(board, target)) {
          const pending = target.blockedBy.filter(
            (dep) => board.tasks.find((entry) => entry.id === dep)?.status !== 'completed',
          )
          return pending.length > 0
            ? `${taskId} 还在等依赖完成：${pending.join('、')}，现在派出去它也只能干等`
            : `${taskId} 现在不能开工（状态 ${target.status}${target.owner === null ? '' : `，负责人 ${target.owner}`}）`
        }
        try {
          boardUpdate(currentId, taskId, board.revision, 'claim', { owner: name, assignee: name, by: caller.name })
        } catch (error) {
          return `认领 ${taskId} 失败：${error instanceof Error ? error.message : String(error)}`
        }
      }

      const context = String(args.context ?? 'fresh')
      let seed: string[] | null = null
      if (context === 'fork') {
        seed = parent.persisted ? forkSeedLines(parent.filePath) : null
        if (seed === null) {
          return `带不上父会话的内容：这个会话还没有一个完整回合（它得先完整回答过一次），改用 context="fresh" 把背景写进任务描述`
        }
      } else if (context !== 'fresh') {
        return `不认识的 context「${context}」。要用的值：fresh / fork`
      }

      const background = args.background === true || args.background === 'true'
      // 一次性小工：干完就结束，不再接传话。缺省是寻常队友（keep 不填 = true），
      // 只认显式 false；`"false"` 字符串也当 false，别的值一律按留用处理。
      const mode: TeammateMode = args.keep === false || args.keep === 'false' ? 'one-shot' : 'continuable'
      const teammate = startTeammate({
        name,
        role,
        task,
        caller,
        background,
        seed,
        parentSession: parent,
        mode,
        model: overrides.model,
        effort: overrides.effort,
        ...(taskId === '' ? {} : { taskId }),
      })

      if (!background) {
        // 用户取消这一轮就等于把队友也停下：先挂监听，再等它空下来
        const onStop = (): void => teammate.agent.cancel()
        runCtx.signal.addEventListener('abort', onStop, { once: true })
        await waitForIdle(teammate)
        runCtx.signal.removeEventListener('abort', onStop)
        const head = `${teammate.name}（${teammate.role}）${teammate.state === 'idle' ? '干完了' : teammate.state === 'stopped' ? '被打断' : '失败'}：第 ${teammate.rounds} 轮、${teammate.toolCalls} 次工具调用。运行记录：${teammate.session.filePath}`
        if (teammate.lastText !== '') return `${head}\n\n${teammate.lastText}`
        // 没有正文：失败先报错误，其余按「预算用完 / 被停机」说清原因（路径已在 head 里）
        const reason =
          teammate.state === 'failed' && teammate.error !== undefined
            ? `（它失败了：${teammate.error}）`
            : noTextNote(teammate, false)
        return `${head}\n${reason}`
      }

      void waitForIdle(teammate)
        .then(() => reportHome(teammate))
        .catch(() => {
          // 尽力而为的汇报：宿主先于队友收尾（关机、测试拆内核）时，等待环的下一拍会摸到
          // 已停用的 context（"cannot get required service"）。拆都拆了，汇报没有意义，
          // 吞掉——不能让一条后台汇报变成 unhandled rejection 打断收尾。
        })
      const bound = taskId === '' ? '' : `已认领并绑定任务 ${taskId}（它成功收工后会自动结项并写入最终结论）。`
      const tail =
        teammate.mode === 'one-shot'
          ? '它是一次性的：干完这次就结束，之后不能再传话，只在名册里留一条运行记录。'
          : '它在后台干，不用等也不用问：干完我会把汇报接进来。你现在可以继续做别的，或者再派一个。'
      return `已派给 ${teammate.name}（角色 ${teammate.role}，${teammate.badge.tools === null ? '不限工具' : `工具 ${teammate.badge.tools.join('、')}`}）。${bound}${tail}`
    }

    const subagentTool = (): ToolEntry => ({
      name: 'subagent',
      description:
        '把一件可以独立完成的活派给一个有明确授权的队友（角色见 ~/.dsc/agents），或者给在队队友传话、打断它。' +
        'background=true 时立刻返回，它干完后汇报会自己接进你的下一轮；background=false 时你这一轮会等它的结果。' +
        'interrupt / stop 都只是叫停当前这一轮：队友留在名册里，传话（message）就能接着用，别把它当成已经没了。' +
        'keep=false 派的是「一次性小工」：只跑这一趟，干完就结束，之后不能再传话——适合跑个命令、查一个事实这种不用追问的活。' +
        'spawn 时可以带 model / effort 给新队友指定模型与思考强度，但只有用户打开「允许 Agent 为子队友选择模型」后才可用，且模型只能挑授权清单里的；这些只影响新队友。' +
        '带 task_id 会把新队友绑定到共享任务板上的某条任务（顺手认领），它成功收工后自动结项。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['spawn', 'list', 'message', 'interrupt', 'stop'], description: '要做什么' },
          role: { type: 'string', description: 'spawn 必填：角色名，例如 explorer / writer / critic' },
          task: { type: 'string', description: 'spawn 必填：交给它的活。队友看不到你和用户的对话，把背景、目标、交付格式写全' },
          name: { type: 'string', description: '队友名；不填自动生成「角色名-序号」。message/interrupt/stop 用它指定对象' },
          context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh = 只知道这条任务；fork = 额外带上父会话到上一个完整回合为止的内容' },
          background: { type: 'boolean', description: 'true = 后台干（推荐，可并行多个）；false = 这一轮等它结果' },
          keep: { type: 'boolean', description: 'spawn 可选：false = 一次性的，干完就结束、不再接传话（只留一条运行记录）；不填 = 寻常队友，收工后传话还能接着干' },
          model: { type: 'string', description: 'spawn 可选：队友模型，写「端点/模型」（或模型名）。只能在设置 → 子智能体 → 队友模型 授权的清单里挑；开关没开时不许带。只影响这个新队友' },
          effort: { type: 'string', enum: [...EFFORT_LEVELS], description: 'spawn 可选：思考强度；不填用角色文件的 effort，再否则跟随默认' },
          task_id: { type: 'string', description: 'spawn 可选：绑定到共享任务板上的某条任务（先 team_task list 看 id）。会顺手认领并绑定负责人，队友成功收工后自动结项' },
          text: { type: 'string', description: 'message 必填：要传的话' },
        },
        required: ['action'],
      },
      risk: 'read',
      // 归属会话按这次调用算：回合可能在后台跑，`ctx.session.current()` 那时未必是它。
      run: (args, runCtx) => {
        // 父会话按调用方的 `sessionId` 查，查不到就报错——**绝不回落** `ctx.session.current()`。
        //
        // 为什么：superagent 的 worker 是执行器自己造的会话（不经常驻 agent 名册），
        // 它调这个工具时用户可能正看着别的会话；回落等于把队友派到别人名下，
        // 名册、额度、任务板全落到错的那条会话上（2026-11-13 查账）。查不到是配置问题，
        // 说清楚比派错好——内核的 `ctx.agent.attach` 就是给这种会话登记用的。
        const parent = ctx.agent.sessionById(runCtx.sessionId)
        if (parent === undefined) {
          throw new Error(
            `这个会话（${runCtx.sessionId}）不在内核的会话表里，派不了队友：` +
              '把会话登记进 ctx.agent（attach）之后再用这个工具',
          )
        }
        return runSubagent(
          args,
          runCtx,
          { name: LEAD, depth: 0, background: false, sessionId: runCtx.sessionId },
          parent,
        )
      },
    })

    // ── 共享任务板（原「智能体团队」插件，2026-11-06 并入本包）───────────────
    // 板子按会话各一块（`~/.dsc/team/boards/<会话 id>.json`）：切到别的会话就是另一块
    // 板。只开板子不开派活也能用——一块只有 lead 在写的看板就是一份共享 todo。
    // 两个都开时，队友的工具表把 team_task 转发时塞了自己的名字（见 `toolsFor`），
    // 看板认领人才不会都算成 lead。
    async function runTeamTask(args: Record<string, unknown>, runCtx: ToolContext): Promise<string> {
      // 归属会话：队友转发时由 `toolsFor` 塞它派出去的那个会话；主会话自己的调用回落
      // 这次工具调用的会话。不看 `ctx.session.current()`——用户切走之后那是另一条会话，
      // 后台队友的认领会悄悄落到别人的板上（2026-11-08 查账）。
      const sessionId = runCtx.caller?.sessionId ?? runCtx.sessionId
      const caller = runCtx.caller?.name ?? LEAD
      const action = String(args.action ?? '')
      const board = readBoard(sessionId)
      const id = String(args.id ?? '')
      const revision = Number(args.expected_revision)
      // 改状态必须带版本号：不传就默认「当前版本」等于把并发冲突检测关掉，
      // 两个队友同时认领同一条时后到的会悄悄覆盖先到的。
      const MUTATING_ACTIONS = new Set([
        'claim',
        'release',
        'complete',
        'reopen',
        'delete',
        'set_dependencies',
        'note',
        'block',
        'unblock',
        'assign',
      ])
      if (MUTATING_ACTIONS.has(action) && !Number.isInteger(revision)) {
        return `改任务板状态要带 expected_revision（你上次 list/create 看到的版本号，当前第 ${board.revision} 版）。`
      }
      const ownerDefault = caller
      try {
        switch (action) {
          case 'create': {
            const scopes = Array.isArray(args.write_scopes) ? args.write_scopes.map(String) : []
            const blocked = Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : []
            const created = boardCreate(sessionId, {
              subject: String(args.subject ?? ''),
              description: String(args.description ?? ''),
              blockedBy: blocked,
              writeScopes: scopes,
              actor: ownerDefault,
            })
            const warnings =
              created.warnings.length === 0
                ? ''
                : `\n提醒（不拦你，最后看 diff 裁决）：\n${created.warnings.map((line) => `- ${line}`).join('\n')}`
            if (args.claim_now !== true) return `已建 ${created.task.id}：${created.task.subject}${warnings}`
            // 认领走正常的 claim：依赖没做完一样会被拦下，正好复用同一套校验
            try {
              boardUpdate(sessionId, created.task.id, created.board.revision, 'claim', {
                owner: ownerDefault,
                by: ownerDefault,
              })
            } catch (error) {
              return `已建 ${created.task.id}：${created.task.subject}，但没能认领：${error instanceof Error ? error.message : String(error)}${warnings}`
            }
            return `已建 ${created.task.id}：${created.task.subject}，状态直接进 in_progress（认领人 ${ownerDefault}）${warnings}`
          }
          case 'list': {
            if (board.tasks.length === 0) return '本会话的任务板是空的（team_task action=create 建第一条）'
            // 摘要行里带负责人、绑定、卡住原因与最新进展：队友看这一行就知道该不该插手
            const lines = board.tasks.map((task) => taskDigestLine(board, task, 60))
            const recent = board.activity.slice(0, 5).map(activityDigestLine)
            return `本会话任务板第 ${board.revision} 版：\n${lines.join('\n')}\n\n最近活动：\n${recent.join('\n') || '- （暂无）'}\n（改状态要带 expected_revision=${board.revision}）`
          }
          case 'get': {
            const task = board.tasks.find((entry) => entry.id === id)
            if (task === undefined) return `任务板上没有 ${id}`
            const notes =
              task.notes.length === 0
                ? '（还没有进展记录）'
                : task.notes
                    .map((note) => `- ${new Date(note.at).toLocaleString()} ${note.by}：${note.text}`)
                    .join('\n')
            const related = board.activity
              .filter((entry) => entry.taskId === task.id)
              .slice(0, 5)
              .map(activityDigestLine)
            return [
              `第 ${board.revision} 版里的 ${task.id}：`,
              `标题：${task.subject}`,
              `说明：${task.description || '（空）'}`,
              `状态：${task.status}${isReady(board, task) ? ' · 可开工' : ''}，负责人 ${task.owner ?? '（无）'}`,
              `绑定队友：${task.assignee ?? '（未绑定）'}`,
              `卡住：${task.blockedReason ?? '（没卡）'}`,
              `依赖：${task.blockedBy.join('、') || '（无）'}`,
              `作用域：${task.writeScopes.join(', ') || '（未声明）'}`,
              `进展（${task.notes.length} 条，新的在前）：`,
              notes,
              `最近活动：\n${related.join('\n') || '（暂无）'}`,
            ].join('\n')
          }
          case 'activity': {
            const limit = clamp(args.limit, 1, 50, 20)
            const lines = board.activity.slice(0, limit).map(activityDigestLine)
            return lines.length === 0
              ? '任务板还没有活动记录（别人认领/写进展/完成任务、互发消息都会记进来）'
              : `任务板第 ${board.revision} 版最近 ${lines.length} 条活动（新的在前）：\n${lines.join('\n')}`
          }
          case 'note':
          case 'block':
          case 'unblock':
          case 'assign':
          case 'claim':
          case 'release':
          case 'complete':
          case 'reopen':
          case 'delete':
          case 'set_dependencies': {
            const payload: BoardUpdatePayload = { by: caller }
            if (action === 'claim') payload.owner = String(args.owner ?? ownerDefault)
            if (action === 'set_dependencies') {
              payload.blockedBy = Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : []
            }
            if (action === 'note' || action === 'block' || action === 'unblock' || action === 'complete') {
              payload.text = String(args.text ?? '')
            }
            if (action === 'assign') payload.assignee = args.assignee === null ? null : String(args.assignee ?? '')
            const result = boardUpdate(sessionId, id, revision, action as BoardAction, payload)
            const ready = result.board.tasks.filter((task) => isReady(result.board, task)).map((task) => task.id)
            const latest = result.task.notes[0]
            const extraParts: string[] = []
            if (latest !== undefined && (action === 'note' || action === 'block' || action === 'complete')) {
              extraParts.push(`最新进展（${latest.by}）：${latest.text.slice(0, 100)}`)
            }
            if (action === 'assign') extraParts.push(`绑定：${result.task.assignee ?? '（已解绑）'}`)
            if (action === 'block' || action === 'unblock') {
              extraParts.push(`卡住原因：${result.task.blockedReason ?? '（没卡）'}`)
            }
            const extra = extraParts.length === 0 ? '' : `\n${extraParts.join('\n')}`
            return `${id} → ${result.task.status}${result.task.owner === null ? '' : `（${result.task.owner}）`}，任务板第 ${result.board.revision} 版。${extra}\n现在可开工：${ready.join('、') || '（无）'}`
          }
          default:
            return `不认识的 action「${action}」。要用的值：create / list / get / activity / claim / release / complete / reopen / note / block / unblock / assign / set_dependencies / delete`
        }
      } catch (error) {
        return `任务板操作没做成：${error instanceof Error ? error.message : String(error)}`
      }
    }

    // ── 队友互通消息（P1 横向通道）─────────────────────────────────────────
    /**
     * 消息额度：key = 队友名，记录它在第几轮发了几条。轮次一变自动清零
     * （`emit` 里每轮 rounds +1），所以「每轮最多 3 条」是真实的按轮计数。
     * Lead 不在表里、也不受额度限制。
     */
    const messageQuota = new Map<string, { round: number; used: number }>()

    /** 给 Lead（派活方会话）投一条队友消息：常驻会话走 followup，收摊会话写进文件。 */
    const deliverToLead = (text: string, from: string, sessionId: string): string => {
      const wrapped = `<team-message from="${from}" to="lead"> ${text} </team-message>`
      const session = ctx.agent.sessionById(sessionId) ?? ctx.session.current()
      if (ctx.agent.hasAgent(session.meta.id)) {
        ctx.agent.followup(wrapped, undefined, session.meta.id, 'notice')
        return 'lead（已并入它的下一轮）'
      }
      session.appendUser(wrapped)
      return 'lead（写入会话，下次对话时模型可见）'
    }

    async function runTeamMessage(args: Record<string, unknown>, runCtx: ToolContext): Promise<string> {
      // 归属会话与署名同 team_task：队友转发时 caller 是它自己，主会话是 lead
      const sessionId = runCtx.caller?.sessionId ?? runCtx.sessionId
      const from = runCtx.caller?.name ?? LEAD
      const action = String(args.action ?? '')
      if (action === 'inbox') {
        const limit = clamp(args.limit, 1, 20, 10)
        const all = inboxRead(from)
        if (all.length === 0) return '你的信箱是空的（别人用 team_message 发给你的话会出现在这里）'
        const tail = all.slice(-limit)
        return `你的信箱最近 ${tail.length} 条（共 ${all.length} 条；信箱没有已读状态，按写入顺序）：\n${tail.map((line) => `- ${line}`).join('\n')}`
      }
      if (action !== 'send' && action !== 'broadcast') {
        return `不认识的 action「${action}」。要用的值：send / broadcast / inbox`
      }
      const text = String(args.text ?? '').trim()
      if (text === '') return '要带上 text（想说的话）'
      if (text.length > MAX_TEAM_MESSAGE_CHARS) {
        return `一条消息最长 ${MAX_TEAM_MESSAGE_CHARS} 字，这条有 ${text.length} 字；长内容写进任务 note 或文件里`
      }

      // 防轰炸：只对队友计额度（Lead 是派活方，不由这条闸管）
      const me = teammates.get(from)
      let quotaNote = ''
      if (me !== undefined) {
        const used = messageQuota.get(from)?.round === me.rounds ? messageQuota.get(from)!.used : 0
        if (used >= TEAM_MESSAGES_PER_ROUND) {
          return `本轮已经发了 ${used} 条消息（每轮上限 ${TEAM_MESSAGES_PER_ROUND} 条）；剩下的话写进任务 note，或者等下一轮再说`
        }
        messageQuota.set(from, { round: me.rounds, used: used + 1 })
        quotaNote = `（本轮还剩 ${TEAM_MESSAGES_PER_ROUND - used - 1} 条额度）`
      }

      const wrap = (body: string, to: string): string => `<team-message from="${from}" to="${to}"> ${body} </team-message>`
      // 「lead」投到最上层会话：嵌套队友（PM 派的人）的 parentSession 是 PM 的会话，
      // 而用户真正看的是再上一层——用 ownerSession 才不会把话投进中间层没人看的文件。
      const leadSessionId = me?.ownerSession.meta.id ?? sessionId
      const delivered: string[] = []
      const missed: string[] = []
      const targets: string[] = []
      if (action === 'send') {
        const to = String(args.to ?? '').trim()
        if (to === '') return 'send 要带上 to（队友名或 lead）'
        if (to === from) return `收件人就是你自己（${from}），换个人发`
        targets.push(to)
      } else {
        // 广播：同会话在队队友 + Lead（不含自己）
        for (const mate of teammates.values()) {
          if (mate.name === from) continue
          if (mate.parentSession.meta.id !== sessionId) continue
          targets.push(mate.name)
        }
        if (from !== LEAD) targets.push(LEAD)
        if (targets.length === 0) return '现在没有可发的对象：本会话没有其他在队队友，也没有可投的 Lead 会话'
      }

      for (const to of targets) {
        if (to === LEAD || to === 'lead') {
          delivered.push(deliverToLead(text, from, leadSessionId))
          continue
        }
        const mate = teammates.get(to)
        const wrapped = wrap(text, to)
        inboxAppend(to, wrapped)
        if (mate !== undefined) {
          // 叫醒目标：跑动中排在它当前回合之后，闲置的唤起一轮
          mate.agent.followup(wrapped)
          delivered.push(`${to}${mate.state === 'working' ? '（正在干，这一轮之后看到）' : '（已叫醒）'}`)
        } else {
          missed.push(`${to}（不在队：收工或一次性，话写进了信箱但没人会读）`)
        }
      }

      // 消息也进板子活动（kind=message，不写 notes）：Lead 与队友从活动时间线看得到协作过程
      try {
        recordBoardActivity(sessionId, {
          by: from,
          kind: 'message',
          text: `${from} → ${targets.join('、')}：${text.replace(/\s+/g, ' ').slice(0, 120)}`,
        })
      } catch {
        // 板子写不进去不影响消息本身已经投递
      }

      const head =
        action === 'broadcast' ? `已广播给 ${delivered.length} 个对象` : delivered.length > 0 ? '已送达' : '没送达'
      const parts = [head, ...delivered.map((line) => `- ${line}`), ...missed.map((line) => `- ${line}`)]
      return `${parts.join('\n')}${quotaNote}`
    }

    const teamTaskTool = (): ToolEntry => ({
      name: 'team_task',
      description:
        '共享任务板（本会话）：登记要做的事、看谁在做什么、认领和结项，并写进展/标阻塞/绑定队友。' +
        '改状态要带 expected_revision（list 返回的那一版），别人抢先改过就会失败，重来一次即可。' +
        '动手前先 list + activity 看别人做到哪一步；进展用 note 写，卡住用 block，队友互相对话用 team_message。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'create',
              'list',
              'get',
              'activity',
              'claim',
              'release',
              'complete',
              'reopen',
              'note',
              'block',
              'unblock',
              'assign',
              'set_dependencies',
              'delete',
            ],
            description: '要做什么',
          },
          subject: { type: 'string', description: 'create 必填：任务标题' },
          description: { type: 'string', description: 'create：任务的详细说明（背景、验收口径）' },
          id: { type: 'string', description: '除 create/list/activity 外必填：任务 id，例如 t3' },
          expected_revision: { type: 'number', description: '改状态（claim/release/complete/reopen/delete/set_dependencies/note/block/unblock/assign）必填：你上次 list/create 看到的版本号' },
          owner: { type: 'string', description: 'claim 时的认领人；不填就是你自己' },
          claim_now: { type: 'boolean', description: 'create：true = 建完直接算你认领（状态直接进 in_progress）' },
          write_scopes: { type: 'array', items: { type: 'string' }, description: 'create：这个任务打算改的路径前缀，用于提醒别人别撞车' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'create/set_dependencies：依赖哪些任务 id' },
          text: { type: 'string', description: 'note/block/unblock 必填（complete 可选）：进展内容 / 卡住原因 / 解除说明 / 终稿摘要' },
          assignee: { type: 'string', description: 'assign：绑定哪个队友；空串表示解绑' },
          limit: { type: 'number', description: 'activity：返回最近多少条（默认 20，上限 50）' },
        },
        required: ['action'],
      },
      risk: 'read',
      run: (args, runCtx) => runTeamTask(args, runCtx),
    })

    const teamMessageTool = (): ToolEntry => ({
      name: 'team_message',
      description:
        '队友之间直接交流（本会话）：点对点 send、广播 broadcast、看自己收到的 inbox。' +
        '消息会写进对方信箱并叫醒它，同时记进任务板活动；每个队友每轮最多发 3 条。' +
        '重要结论仍以任务板 note 为准——消息是协调用的，不是台账。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send', 'broadcast', 'inbox'], description: '要做什么' },
          to: { type: 'string', description: 'send 必填：队友名或 lead' },
          text: { type: 'string', description: 'send/broadcast 必填：要说的话（最长 8000 字）' },
          limit: { type: 'number', description: 'inbox：读最近多少条（默认 10，上限 20）' },
        },
        required: ['action'],
      },
      risk: 'read',
      run: (args, runCtx) => runTeamMessage(args, runCtx),
    })

    /** 板子提示段：只有板上真开了才注册；关掉时模型不该看到这个工具的任何说明。 */
    const boardPromptText = (): string => {
      const sessionId = ctx.session.current().meta.id
      const board = readBoard(sessionId)
      const taskLines = board.tasks.slice(0, 20).map((task) => taskDigestLine(board, task))
      const activityLines = board.activity.slice(0, 10).map(activityDigestLine)
      const mates = [...teammates.values()].filter((entry) => entry.parentSession.meta.id === sessionId)
      const mateLines = mates.map(
        (entry) =>
          `- ${entry.name}（${entry.role}，${entry.state}${entry.taskId === undefined ? '' : `，绑定 ${entry.taskId}`}）`,
      )
      return `# 共享任务板
本会话有一块共享任务板，你可以用 team_task 工具登记要做的事、认领和结项、写进展、标阻塞；队友和你看到的是同一块板。
${taskLines.length === 0 ? '板上还没有任务。' : `板上的任务（含负责人与最新进展）：\n${taskLines.join('\n')}`}

在队队友与绑定任务：
${mateLines.join('\n') || '- （当前没有在队队友）'}

最近活动（新的在前）：
${activityLines.join('\n') || '- （暂无）'}

任务板的规矩：
1. 多人协作先上任务板：create 时写清 write_scopes（打算改哪些路径）与依赖，别人 claim 时才抢不过你；改状态要带 expected_revision。
2. 认领前先 list / activity：依赖没完成的任务开不了工；完成一条，等它的人就能开工。
3. 派活时优先用 subagent 的 task_id 把队友绑定到它负责的任务：认领会一起做掉，队友成功收工自动结项。
4. 队友之间可以直接用 team_message 交流（点对点或广播），不必都经你转述；重要结论以任务板 note 为准。
5. 进展用 note 写、卡住用 block 标，别只写在汇报里——汇报只给你看，板子是全队看的。`
    }

    /**
     * 三个开关各管一段：
     * - `allowDelegation` 管 `subagent` 工具、`team_message` 与名册提示；
     * - `board` 管 `team_task` 与板子提示段；
     * - `teamMode` 只影响提示与 `maxDepth` 的默认值（见 settings 保存逻辑）。
     * 前两个独立，所以「只要共享待办、不要派活」与「只要派活、不要板子」都能表达。
     */
    let disposers: Array<() => void> = []
    const syncTools = (): void => {
      for (const off of disposers) off()
      disposers = []
      if (config.allowDelegation) {
        disposers.push(ctx.effect(() => ctx.tools.register(subagentTool()), 'subagent: tools.register'))
        // 横向通道跟着「有没有队友」走：没有队友时它没有收件人，注册了只会白占一个工具位
        disposers.push(ctx.effect(() => ctx.tools.register(teamMessageTool()), 'subagent: team_message.register'))
        disposers.push(
          ctx.effect(() => ctx.prompt.register('subagent', () => {
            const roles = listRoles().filter((role) => role.enabled)
            const lines = roles.map((role) => {
              const tools = role.tools === null ? '不限工具' : role.tools.length === 0 ? '不带工具' : role.tools.join('/')
              const turns = roleMaxTurns(role)
              return `- ${role.name}：${role.description || '（没写 description）'}（${tools}，${turns === 0 ? '轮次不限' : `最多 ${turns} 轮`}）`
            })
            // 板子与派活是同一层的协作：分开成两个包时，子智能体提示里不提板子，
            // 模型就永远不会用 team_task（旧决策见 docs/development-log.md:848）；
            // 现在同一包里，必须提一句，否则板子等于没有。
            // 规则用数组拼：板子、模型说明、团队模式各自可选，编号才不会跳号或重号。
            const rules = [
              '队友看不到你和用户的对话（context="fork" 只能带到上一个完整回合为止），所以任务描述里必须写清背景、目标、交付格式。',
              `本会话同时干活上限 ${config.maxTeammates} 个（收工的不占额度）。后台队友干完后汇报会自己接进你的下一轮，不要反复去问它好了没。`,
              '只读角色改不了文件；要落地代码用 developer / writer 或者你自己动手。',
              '派完活自己接着干别的，别闲着等。',
              '分工协议：按真实团队流程派活——需求不清先派 pm（确认需求与验收口径、拆任务上板），方案与契约派 architect，实现按 write_scopes 并行派 developer，独立验证派 tester，构建发布与环境检查派 ops，最后由你汇总向用户交付。派活时用 task_id 绑定它负责的任务。',
              ...(config.board
                ? [
                    '多人协作还有一块共享任务板：用 team_task 登记、认领、结项、写进展，队友看到的是同一块板；队友之间可以直接用 team_message 交流，重要结论以任务板 note 为准。',
                  ]
                : []),
              ...(config.teamMode
                ? ['团队模式已开：maxDepth 允许到 2（pm 可以自己再派人）；放开后仍受 maxTeammates 与各角色轮次预算约束。']
                : []),
              modelRuleText(),
            ]
            return `# 子智能体
你可以用 subagent 工具把能独立完成的活派给队友。
可用角色（文件在 ${DSC_AGENTS_DIR}，用户可以自己加）：
${lines.join('\n') || '- （没有启用中的角色，先在设置「子智能体」里打开或新建）'}

派活的规矩：
${rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}`
          }), 'subagent: prompt.register'),
        )
      }
      if (config.board) {
        disposers.push(ctx.effect(() => ctx.tools.register(teamTaskTool()), 'subagent: team_task.register'))
        disposers.push(ctx.effect(() => ctx.prompt.register('team', boardPromptText), 'subagent: board prompt.register'))
      }
    }
    syncTools()

    // ── 设置分区 ────────────────────────────────────────────────────────────
    /**
     * 授权模型多选清单：按端点显示名分组，值用 `端点/模型`（与 `listModels()` 一致）。
     *
     * 只列当前配置里存在的模型；已存但端点/模型被删掉的授权仍留在配置里（见
     * {@link readAllowedModels}），恢复端点后自动回到清单里，不用重新勾。
     */
    const modelCheckGroups = (): SettingsCheckGroup[] => {
      const groups = new Map<string, SettingsCheckOption[]>()
      for (const choice of ctx.llm.listModels()) {
        const title = choice.providerDisplayName === '' ? choice.provider : choice.providerDisplayName
        const options = groups.get(title) ?? []
        options.push({ value: choice.value, label: choice.model, detail: choice.description })
        groups.set(title, options)
      }
      return [...groups].map(([title, options]) => ({ title, options }))
    }

    const fields = (): SettingsField[] => [
      {
        type: 'switch',
        key: 'allowDelegation',
        label: t('field.allowDelegation.label'),
        help: t('field.allowDelegation.help'),
      },
      { type: 'number', key: 'maxTeammates', label: t('field.maxTeammates.label'), min: 1, max: 8, step: 1, help: t('field.maxTeammates.help') },
      { type: 'number', key: 'maxDepth', label: t('field.maxDepth.label'), min: 0, max: 2, step: 1, help: t('field.maxDepth.help') },
      {
        type: 'switch',
        key: 'teamMode',
        label: t('field.teamMode.label'),
        help: t('field.teamMode.help'),
      },
      {
        type: 'number',
        key: 'maxTurns',
        label: t('field.maxTurns.label'),
        min: 0,
        max: 200,
        step: 1,
        help: t('field.maxTurns.help'),
      },
      // ── 默认最大轮次（按角色；角色文件里显式写了 max-turns 的以文件为准）────
      ...TURN_ROLES.map((role) => ({
        type: 'number' as const,
        key: `roleTurns.${role}`,
        label: t('field.roleTurns.label', { role }),
        min: 0,
        max: 200,
        step: 1,
        help: t('field.roleTurns.help'),
        group: 'turns',
      })),
      {
        type: 'select',
        key: 'approval',
        label: t('field.approval.label'),
        options: [
          { value: 'forbid', label: t('option.approval.forbid') },
          { value: 'foreground', label: t('option.approval.foreground') },
          { value: 'ask', label: t('option.approval.ask') },
        ],
        help: t('field.approval.help'),
      },
      {
        type: 'select',
        key: 'notify',
        label: t('field.notify.label'),
        options: [
          { value: 'auto', label: t('option.notify.auto') },
          { value: 'quiet', label: t('option.notify.quiet') },
        ],
      },
      // ── 队友模型：允许 Agent 指定 + 授权清单 ──────────────────────────────
      {
        type: 'switch',
        key: 'allowModelSelection',
        label: t('field.allowModelSelection.label'),
        help: t('field.allowModelSelection.help'),
        group: 'models',
      },
      {
        type: 'checks',
        key: 'allowedModels',
        label: t('field.allowedModels.label'),
        groups: modelCheckGroups(),
        help: t('field.allowedModels.help'),
        group: 'models',
      },
      { type: 'info', label: t('field.rolesDir.label'), text: DSC_AGENTS_DIR, mono: true, copyable: true, help: t('field.rolesDir.help', { names: builtinRoleNames().join(t('field.rolesDir.separator')) }) },
      { type: 'button', action: 'new-role', label: t('field.newRole.label'), style: 'ghost', help: t('field.newRole.help') },
      // ── 任务板（原「共享任务板」插件的设置，并进同一分区）───────────────
      {
        type: 'switch',
        key: 'board',
        label: t('field.board.label'),
        help: t('field.board.help'),
        group: 'board',
      },
      { type: 'info', label: t('field.boardDir.label'), text: BOARDS_DIR, mono: true, copyable: true, help: t('field.boardDir.help'), group: 'board' },
      { type: 'button', action: 'clear-board', label: t('field.clearBoard.label'), style: 'ghost', help: t('field.clearBoard.help'), group: 'board' },
    ]

    const section: SettingsSectionSpec = {
      id: 'subagent',
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 40,
      groups: [
        { id: 'turns', title: t('group.turns.title'), description: t('group.turns.description') },
        { id: 'models', title: t('group.models.title'), description: t('group.models.description') },
        { id: 'board', title: t('group.board.title'), description: t('group.board.description') },
      ],
      fields,
      values: (): Record<string, SettingsValue> => {
        const values: Record<string, SettingsValue> = {
          allowDelegation: config.allowDelegation,
          maxTeammates: config.maxTeammates,
          maxDepth: config.maxDepth,
          teamMode: config.teamMode,
          maxTurns: config.maxTurns,
          approval: config.approval,
          notify: config.notify,
          allowModelSelection: config.allowModelSelection,
          allowedModels: [...config.allowedModels],
          board: config.board,
        }
        for (const role of TURN_ROLES) {
          values[`roleTurns.${role}`] = config.roleTurns[role] ?? DEFAULT_ROLE_TURNS[role] ?? 0
        }
        return values
      },
      // 契约：save 返回字符串 = 失败原因；action 返回字符串 = 完成后的提示文案，失败直接抛
      save: (key, value): string | void => {
        // 按角色轮次是一组带点号的平铺键（`roleTurns.<角色>`），整块对象写进 config.roleTurns
        if (key.startsWith('roleTurns.')) {
          const role = key.slice('roleTurns.'.length)
          if (!TURN_ROLES.includes(role)) return t('save.unknownKey', { key })
          const turns = Number(value)
          if (!Number.isFinite(turns) || turns < 0 || turns > 200) {
            return t('save.badTurns', { value: String(value) })
          }
          // writePluginConfig 是顶层键浅合并：roleTurns 按对象整块写，别的角色不会丢
          applyConfig({ roleTurns: { ...config.roleTurns, [role]: Math.round(turns) } })
          return
        }
        switch (key) {
          case 'allowDelegation':
            applyConfig({ allowDelegation: value === true || value === 'true' })
            break
          case 'maxTeammates':
            applyConfig({ maxTeammates: Number(value) })
            break
          case 'maxDepth':
            applyConfig({ maxDepth: Number(value) })
            break
          case 'teamMode': {
            const enabled = value === true || value === 'true'
            // 团队模式 = 允许二层派活（PM 可以再派人）：打开时顺手把 maxDepth 抬到 2。
            // 关闭只关这一项、不回退 maxDepth（用户可能自己就是想要二层，替他降级更意外）。
            applyConfig(enabled ? { teamMode: true, maxDepth: Math.max(config.maxDepth, 2) } : { teamMode: false })
            break
          }
          case 'maxTurns':
            applyConfig({ maxTurns: Number(value) })
            break
          case 'approval': {
            const next = String(value) as TeammateApproval
            if (next !== 'forbid' && next !== 'ask' && next !== 'foreground') {
              return t('save.badValue', { value: String(value) })
            }
            applyConfig({ approval: next })
            break
          }
          case 'notify':
            applyConfig({ notify: String(value) === 'quiet' ? 'quiet' : 'auto' })
            break
          case 'allowModelSelection': {
            const enabled = value === true || value === 'true'
            // 开关开着却一个模型都没授权：Agent 没有任何合法可选值，先拦下比让它每次派活都报错好
            if (enabled && config.allowedModels.length === 0) return t('save.needAllowedModel')
            applyConfig({ allowModelSelection: enabled })
            break
          }
          case 'allowedModels': {
            const list = readAllowedModels(value)
            if (config.allowModelSelection && list.length === 0) return t('save.needAllowedModel')
            applyConfig({ allowedModels: list })
            break
          }
          case 'board':
            applyConfig({ board: value === true || value === 'true' })
            break
          default:
            return t('save.unknownKey', { key })
        }
        // 开关会影响工具与提示段在不在场（派活与板子各管一半），改完立刻重挂一次
        syncTools()
      },
      action: (name): string => {
        if (name === 'new-role') {
          const file = writeRole('starter', {
            description: '我在这个角色里干什么（一句话，模型据此决定要不要派它）',
            prompt: '把这一段改成这个角色的职责与做事步骤。它是模型看到的唯一说明书。',
          })
          return t('action.roleWritten', { file })
        }
        if (name === 'clear-board') {
          return t('action.clearBoard', { count: resetBoard(ctx.session.current().meta.id) })
        }
        throw new Error(`这个分区没有这个按钮：${name}`)
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'subagent: settings.registerSection')

    // ── 卸载 ────────────────────────────────────────────────────────────────
    return () => {
      offSection()
      for (const off of disposers) off()
      disposers = []
      for (const teammate of teammates.values()) teammate.agent.cancel()
      for (const teammate of teammates.values()) teammate.session.close()
      teammates.clear()
    }
  },
}
