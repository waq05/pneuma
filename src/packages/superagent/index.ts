/**
 * superagent 插件：把一句话需求派给一个独占工作区的智能体去改代码，结果回到工单里。
 *
 * **第 8 步的装配**：这个文件仍然只做装配——不写业务逻辑、不拼 SQL、不判定需求。
 * `apply` 里做六件事：
 *   1. 登记设置分区 `superagent`：`repoPath` / `maxWorkers` / `ticketTimeoutSeconds`
 *      三个字段，值现读 `~/.dsc/plugins.json`（`resolvePluginConfig`），保存走
 *      `writePluginConfig`——**重启宿主后值还在**，这是第 8 步唯一的硬验收；
 *   2. 注册 `/sa` 命令（`commands.ts`）；
 *   3. 起一个 2 秒的泵，调 `service.tick()`（`runtime.pump()` + 阶段变样时推快照）；
 *   4. 懒建 `SuperagentRuntime`：第一次用到（发命令 / 界面拉快照 / 调五个方法）才打开编排库；
 *   5. provide `superagent` 服务并把快照面登记进 `ctx.surfaces`（`service.ts` / `surface.ts`）；
 *   6. 向 doctor 的 `ctx.health` 登记三项体检：编排库能不能写、锁被占没有、几张工单卡在
 *      running；飞书来源连上没有、最近一条错误是什么；机器上 git 与 lark-cli 在不在。
 *
 * **两个外部来源，同一条节奏**：GitHub 靠 `startGithub`、飞书靠 `startFeishu`，都在
 * `ensure()` 建好运行期之后才起，都不在 `apply` 里做任何 IO；来源起来之前的三样前置条件
 * （开关、范围、口令/CLI）缺任何一样都只记一行日志、不启动、不抛。飞书默认关，所以不配
 * 就一个 lark-cli 子进程都不会起。
 *
 * 为什么懒建而不是 `apply` 时就连库：插件在设置页里是「可停用」的一行，宿主启动时
 * 十几行插件都会 `apply`；谁在 `apply` 里开库，谁就把「打开数据库」变成宿主启动的
 * 前置条件。一条插件挂了不该拖垮整个宿主（§5.4），所以连库推迟到真正有人用。
 *
 * 为什么泵不主动触发建库：泵每 2 秒跑一次，如果它负责建库，插件一启用就会去抢编排库
 * 的单实例锁——用户还没发任何需求，锁已经被占住。泵只驱动已经建好的运行期；
 * 用户第一次 `/sa new` 之后它才开始工作。
 *
 * **启动恢复与保留策略挂在「运行期第一次建起来」那一刻**（`ensure` 里）：懒启动下，
 * 那才是真正意义上的「这次启动」。恢复把上次崩在 `running` 的工单标成失败、把 `pending`
 * 的重新入队；保留策略删掉已结束超过 30 天的会话目录。之后每天再扫一次会话目录。
 *
 * **出错不炸宿主**：`ensure()` 把打开失败收敛成 `null` + 一条日志，命令据此显示
 * 「未启动」；泵的每一拍也各自捕获异常。插件停在「未启动」状态，与设计文档 §5.4 一致。
 *
 * @module pneuma/superagent
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsField, SettingsValue, SettingsValues } from '@pneuma/runtime/contract.js'
import type { HealthService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { clampInt } from '@pneuma/runtime/core/clamp.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { openStore, type DscStore } from './adapters/store.js'
import { type MessageSender } from './adapters/dispatch.js'
import { createGithubApi } from './adapters/github/api.js'
import { sendGithub } from './adapters/github/channel.js'
import { createGithubSource, pollPullChecks } from './adapters/github/source.js'
import { bindAgentPulls, pollTicketChecks, type OpenPull } from './adapters/github/bind.js'
import { sendFeishu } from './adapters/feishu/channel.js'
import { resolveFeishuCli, readFeishuBot, DEFAULT_FEISHU_CLI, type FeishuCli } from './adapters/feishu/cli-run.js'
import { createFeishuSource, type FeishuSource } from './adapters/feishu/loops.js'
import { SOURCE as FEISHU_SOURCE } from './adapters/feishu/trigger.js'
import type { AssessorComplete } from './adapters/assessor-model.js'
import { superagentScope } from './adapters/scope.js'
import { defaultSettings, GITHUB_SOURCE, normalizeFeishuAccount, normalizeGithubAccount, type FeishuAccount, type GithubAccount } from './adapters/settings.js'
import { registerCommands } from './commands.js'
import { LIMITS } from './core/limits.js'
import { createDependenciesHealth, createFeishuHealth, createSuperagentHealth } from './health.js'
import { SuperagentRuntime } from './runtime.js'
import { SuperagentService } from './service.js'
import { registerSurface, withRepoGuide } from './surface.js'
import { createReportTool } from './tools.js'

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名三处一致。 */
export const name = 'superagent'

/**
 * 依赖的服务：设置（分区）、命令（`/sa`），以及执行器要的模型 / 工具 / 守卫。
 *
 * 后三项从第 5 步起是硬依赖：worker 就是「另一个 MiniAgent」，没有 `llm` 发不出请求、
 * 没有 `tools` 只拿得到空工具表、没有 `guards` 则沙箱与审批整条链不在场。它们起不来时
 * 本插件也不该起来——这是正确的失败方式（不降级成「看起来能派工」）。
 * 沙箱与压缩是**可选**能力：执行器用 `ctx.get(...)` 读，不在场就少一道围栏 / 少一次压缩，
 * 不写进 inject，免得那两个插件停用时把本插件一起拖得挂不上。
 * `health`（doctor 的体检登记表）同样不写进 inject：doctor 停用时少一项体检，不影响派工。
 */
export const inject = ['settings', 'commands', 'tools', 'llm', 'guards', 'surfaces']

/**
 * 配置键：`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`。
 *
 * 与设置分区 id、patch 行 id 同一个字符串：三处一致，才不会出现「分区写进去了、
 * 插件读的是另一条」这种查半天的错。
 */
const CONFIG_KEY = 'superagent'

/** 设置分区里三个字段的键。P0 只有一个 `repoPath`，第 8 步补齐其余两个。 */
const REPO_PATH_KEY = 'repoPath'
const MAX_WORKERS_KEY = 'maxWorkers'
const TIMEOUT_KEY = 'ticketTimeoutSeconds'

/**
 * 工作区准备命令：建好工作树之后、worker 开跑之前执行的一条 shell 命令。
 *
 * 对应上游 `executor.prepare`（`core/policy.ts` 的 `ExecutorConfigSchema`）。典型用法是
 * `pnpm install`：worker 的第一步往往就是跑测试，依赖没装就得它自己装，装不完还会撞超时。
 * 空串 = 不跑。
 */
const PREPARE_COMMAND_KEY = 'prepareCommand'

/** P2 的 GitHub 来源：仓库、机器人自己的登录名、谁能派活、令牌放在哪个环境变量里。 */
const GITHUB_REPOSITORY_KEY = 'githubRepository'
const GITHUB_LOGIN_KEY = 'githubLogin'
const GITHUB_ALLOWED_KEY = 'githubAllowed'
const GITHUB_TOKEN_ENV_KEY = 'githubTokenEnv'

/**
 * P2 的飞书来源：开关、CLI 路径、群清单、要不要收私聊。
 *
 * 两件事与 GitHub 不同，都是设置面的取舍：来源**默认关**（打开才起子进程），群清单只有
 * 一行逗号分隔的 `chat_id`（设置表单没有多行控件，与 `githubAllowed` 同一种写法）。
 */
const FEISHU_ENABLED_KEY = 'feishuEnabled'
const FEISHU_CLI_KEY = 'feishuCli'
const FEISHU_CHATS_KEY = 'feishuChats'
const FEISHU_DIRECT_KEY = 'feishuDirect'
/**
 * 允许派活的飞书 `open_id`（`ou_` 开头，逗号分隔）。
 *
 * 为什么必须单独一个名单：核心准入闸只认 `policy.sources[source].allowed` 里的精确 id
 * （`core/policy.ts:132`），没有通配。不填这个字段，飞书来源就没被登记进准入表，
 * 每条消息都会被判 `not_a_member`——消息收得到，工单一张也建不出来。
 */
const FEISHU_ALLOWED_KEY = 'feishuAllowed'

/** 令牌环境变量的缺省名。 */
const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN'

/** 判定用的模型：写成 `provider/model`，空 = 不调模型（用同步规则）。 */
const ASSESSOR_MODEL_KEY = 'assessorModel'

/** 泵的间隔：设计文档 §6.3 写的是 2 秒。 */
const PUMP_INTERVAL_MS = 2000

/**
 * GitHub 轮询间隔：30 秒。
 *
 * 上游是 60 秒一拍（`sources/poll.ts:33-39`），这里略密一点是因为 DSC 的泵本来就 2 秒一拍、
 * 顺手判断一次不花钱；真正的约束是接口配额——30 秒一次对一个仓库足够，再密也换不来更快的
 * 响应（上游的 60 秒是给多个仓库留的余量）。
 */
const GITHUB_POLL_INTERVAL_MS = 30_000

/**
 * 飞书补收间隔：60 秒，与适配器自己的缺省一致（`adapters/feishu/loops.ts:230`）。
 *
 * 为什么不是一个更小的数：补收是按时间窗读历史的，飞书那边的窗口精度只到秒，读得再密
 * 也换不来更快的响应，只会多花配额。事件本身走长连接，这条轮询只负责补漏。
 */
const FEISHU_POLL_INTERVAL_MS = 60_000

/**
 * 适配器内部那条补收循环的间隔：一天。
 *
 * 为什么不是默认的 60 秒：`createFeishuSource().start()` 自己会起一条每 60 秒 `tick()` 的
 * 循环（`loops.ts:591-599`），而泵这一拍也调 `tick()`（见 `pollFeishu`）。两条路都按 60 秒
 * 跑，等于每轮把同一段历史读两遍。把内部那条压到一天，`tick` 的节奏就只剩泵一处（与
 * GitHub 的 `pollGithub` 同构），而 `start()` 时的那第一轮基线照旧会跑。
 */
const FEISHU_INTERNAL_BACKFILL_MS = 24 * 60 * 60 * 1000

/** 会话目录的清扫间隔：启动时扫一次，之后每天一次。 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 超时的上限（秒）：24 小时。再长就等于不限，而「不限」用 0 表达。 */
const TIMEOUT_MAX_SECONDS = 24 * 60 * 60

/** 缺省值：并发 2（设计文档 §6.2）、单工单 30 分钟。 */
const DEFAULTS = { maxWorkers: 2, ticketTimeoutSeconds: 1800 } as const

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（中文原文是语义真源，英文是译本）。
 */
const t = hostT(import.meta.dirname)

/** 把未知异常压成一行，日志里用。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 设置面读回来的值（都收好了类型与区间）。 */
export interface SuperagentConfig {
  /** 执行器建工作树的仓库根；空 = 没配。 */
  repoPath: string
  /** 并发上限，夹在 1–16。 */
  maxWorkers: number
  /** 单工单超时秒数；0 = 不限。 */
  ticketTimeoutSeconds: number
  /**
   * 工作区准备命令；空 = 不跑。
   *
   * 在**工作树目录里**跑（上游在工单目录的父目录跑，因为上游的目录是 prepare 负责建的；
   * 当前目录由 `git worktree` 建好，prepare 的用途变成「在这棵树里装依赖」）。
   */
  prepareCommand: string
  /** GitHub 仓库 `owner/name`；空 = 没接这个来源。 */
  githubRepository: string
  /** 机器人自己的 GitHub 登录名；用它跳过自己发的评论。 */
  githubLogin: string
  /** 允许派活的人（已按逗号拆开、去空、去重）。 */
  githubAllowed: string[]
  /** 令牌所在的环境变量名。 */
  githubTokenEnv: string
  /** 飞书来源开关；默认关。关着时一个 lark-cli 进程都不起。 */
  feishuEnabled: boolean
  /** lark-cli 的路径；空 = 走 PATH 上的 `lark-cli`。 */
  feishuCli: string
  /** 要收的群 `chat_id`（已按逗号拆开、去空、去重）；空 = 不收任何群。 */
  feishuChats: string[]
  /** 允许派活的飞书 `open_id`（已按逗号拆开、去空、去重）；空 = 这个来源没接进准入表。 */
  feishuAllowed: string[]
  /** 收不收私聊；默认关。 */
  feishuDirect: boolean
  /** 判定用模型（`provider/model`）；空 = 不调模型。 */
  assessorModel: string
}

/** 把一个配置值读成去空白的字符串；类型不对或没给都算空。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读设置：**每次现读磁盘**，所以设置页保存完不必重启宿主。
 *
 * 三档来源由 `resolvePluginConfig` 统一决定（宿主直给 > patch 行 > `plugins.json`），
 * 这里只负责「类型不对用缺省、数值夹回区间」——库文件与配置文件用户都能手改，
 * 读路径不能信它们的形状。
 *
 * @param passed - 装配时传进来的行配置（cordis 的第二参数）
 */
export function readSuperagentConfig(passed?: unknown): SuperagentConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    repoPath: typeof raw[REPO_PATH_KEY] === 'string' ? raw[REPO_PATH_KEY].trim() : '',
    maxWorkers: clampInt(raw[MAX_WORKERS_KEY], LIMITS.maxWorkers.min, LIMITS.maxWorkers.max, DEFAULTS.maxWorkers),
    ticketTimeoutSeconds: clampInt(raw[TIMEOUT_KEY], 0, TIMEOUT_MAX_SECONDS, DEFAULTS.ticketTimeoutSeconds),
    // 长度上限与上游 schema 的 `LIMITS.prepareCommand` 对齐；超出部分截断而不是报错——
    // 这是启动路径，不能因为一条设置让整个插件起不来。
    prepareCommand: textOf(raw[PREPARE_COMMAND_KEY]).slice(0, LIMITS.prepareCommand),
    githubRepository: textOf(raw[GITHUB_REPOSITORY_KEY]),
    githubLogin: textOf(raw[GITHUB_LOGIN_KEY]),
    // 名单用逗号分隔：设置面只有 text 字段（`contract/settings.ts` 没有多行/标签类控件）。
    // 大小写不敏感的去重，免得 `Alice` 与 `alice` 生成两条没用的名单项。
    githubAllowed: [...new Set(
      textOf(raw[GITHUB_ALLOWED_KEY]).split(',').map((id) => id.trim()).filter((id) => id !== ''),
    )],
    githubTokenEnv: textOf(raw[GITHUB_TOKEN_ENV_KEY]) || DEFAULT_TOKEN_ENV,
    // 开关只认布尔：设置面给的是 `true` / `false`，手改 JSON 写成 `"true"` 不算打开——
    // 宁可让人再点一次，也不要把一个字符串悄悄当成「已启用」去起子进程。
    feishuEnabled: raw[FEISHU_ENABLED_KEY] === true,
    feishuCli: textOf(raw[FEISHU_CLI_KEY]),
    // 群名单与 githubAllowed 同一种写法：逗号分隔、去空白、去重。空串 = 没有群。
    feishuChats: [...new Set(
      textOf(raw[FEISHU_CHATS_KEY]).split(',').map((id) => id.trim()).filter((id) => id !== ''),
    )],
    feishuAllowed: [...new Set(
      textOf(raw[FEISHU_ALLOWED_KEY]).split(',').map((id) => id.trim()).filter((id) => id !== ''),
    )],
    feishuDirect: raw[FEISHU_DIRECT_KEY] === true,
    assessorModel: textOf(raw[ASSESSOR_MODEL_KEY]),
  }
}

/**
 * 把 `provider/model` 拆成判定器要的形状；空或格式不对返回 `null`（= 不调模型）。
 *
 * 只在这里拆一次：模型名是用户手填的，`null` 是「不调模型」的合法形态
 * （`core/policy.ts:98`），所以格式不对时按「不配」处理，而不是抛错让插件起不来。
 */
export function assessorTargetOf(config: SuperagentConfig): { provider: string; model: string } | null {
  const text = config.assessorModel.trim()
  const cut = text.lastIndexOf('/')
  if (cut <= 0 || cut === text.length - 1) return null
  const provider = text.slice(0, cut).trim()
  const model = text.slice(cut + 1).trim()
  return provider === '' || model === '' ? null : { provider, model }
}

/**
 * 建设置分区：执行器三字段 + GitHub 四字段 + 飞书四字段 + 判定模型，`values()` 现读磁盘、
 * `save()` 真落盘。
 *
 * 单独导出而不是在 `apply` 里内联，是为了包级测试能直接验「保存 → 读回 → 重开还在」，
 * 不必为一个设置分区造一整套 cordis 上下文。`apply` 用的就是这一个函数，没有第二份。
 *
 * @param passed - 装配时传进来的行配置；与 `apply` 收到的是同一个
 */
export function createSettingsSection(passed?: unknown): SettingsSectionSpec {
  return {
    id: CONFIG_KEY,
    title: t('section.title'),
    subtitle: t('section.subtitle'),
    // 排在「定时任务」（32）、「子代理」（29）之后：都属于「让别的智能体替你干活」那一类。
    order: 39,
    fields(): SettingsField[] {
      return [
        {
          type: 'text',
          key: REPO_PATH_KEY,
          label: t('field.repoPath.label'),
          placeholder: '/path/to/repo',
          mono: true,
          help: t('field.repoPath.help'),
        },
        {
          type: 'text',
          key: PREPARE_COMMAND_KEY,
          label: t('field.prepareCommand.label'),
          placeholder: 'pnpm install',
          mono: true,
          help: t('field.prepareCommand.help'),
        },
        {
          type: 'number',
          key: MAX_WORKERS_KEY,
          label: t('field.maxWorkers.label'),
          min: LIMITS.maxWorkers.min,
          max: LIMITS.maxWorkers.max,
          step: 1,
          help: t('field.maxWorkers.help'),
        },
        {
          type: 'number',
          key: TIMEOUT_KEY,
          label: t('field.ticketTimeoutSeconds.label'),
          min: 0,
          max: TIMEOUT_MAX_SECONDS,
          step: 60,
          help: t('field.ticketTimeoutSeconds.help'),
        },
        {
          type: 'text',
          key: GITHUB_REPOSITORY_KEY,
          label: t('field.githubRepository.label'),
          placeholder: 'owner/name',
          mono: true,
          help: t('field.githubRepository.help'),
        },
        {
          type: 'text',
          key: GITHUB_LOGIN_KEY,
          label: t('field.githubLogin.label'),
          placeholder: 'your-bot-login',
          mono: true,
          help: t('field.githubLogin.help'),
        },
        {
          type: 'text',
          key: GITHUB_ALLOWED_KEY,
          label: t('field.githubAllowed.label'),
          placeholder: 'alice, bob',
          mono: true,
          help: t('field.githubAllowed.help'),
        },
        {
          type: 'text',
          key: GITHUB_TOKEN_ENV_KEY,
          label: t('field.githubTokenEnv.label'),
          placeholder: DEFAULT_TOKEN_ENV,
          mono: true,
          help: t('field.githubTokenEnv.help'),
        },
        {
          type: 'switch',
          key: FEISHU_ENABLED_KEY,
          label: t('field.feishuEnabled.label'),
          help: t('field.feishuEnabled.help'),
        },
        {
          type: 'text',
          key: FEISHU_CLI_KEY,
          label: t('field.feishuCli.label'),
          placeholder: 'lark-cli',
          mono: true,
          help: t('field.feishuCli.help'),
        },
        {
          type: 'text',
          key: FEISHU_CHATS_KEY,
          label: t('field.feishuChats.label'),
          placeholder: 'oc_xxx, oc_yyy',
          mono: true,
          help: t('field.feishuChats.help'),
        },
        {
          type: 'text',
          key: FEISHU_ALLOWED_KEY,
          label: t('field.feishuAllowed.label'),
          placeholder: 'ou_xxx, ou_yyy',
          mono: true,
          help: t('field.feishuAllowed.help'),
        },
        {
          type: 'switch',
          key: FEISHU_DIRECT_KEY,
          label: t('field.feishuDirect.label'),
          help: t('field.feishuDirect.help'),
        },
        {
          type: 'text',
          key: ASSESSOR_MODEL_KEY,
          label: t('field.assessorModel.label'),
          placeholder: 'provider/model',
          mono: true,
          help: t('field.assessorModel.help'),
        },
      ]
    },
    values(): SettingsValues {
      // 现读磁盘而不是读闭包里的缓存：这是「重启后值还在」与「保存即生效」的同一条路径。
      const config = readSuperagentConfig(passed)
      return {
        [REPO_PATH_KEY]: config.repoPath,
        [MAX_WORKERS_KEY]: config.maxWorkers,
        [TIMEOUT_KEY]: config.ticketTimeoutSeconds,
        [PREPARE_COMMAND_KEY]: config.prepareCommand,
        [GITHUB_REPOSITORY_KEY]: config.githubRepository,
        [GITHUB_LOGIN_KEY]: config.githubLogin,
        // 设置面只认标量，名单在磁盘上存成一行逗号分隔的文本。
        [GITHUB_ALLOWED_KEY]: config.githubAllowed.join(', '),
        [GITHUB_TOKEN_ENV_KEY]: config.githubTokenEnv,
        [FEISHU_ENABLED_KEY]: config.feishuEnabled,
        [FEISHU_CLI_KEY]: config.feishuCli,
        // 与 githubAllowed 一样：磁盘上存一行逗号分隔的文本，设置面只认标量。
        [FEISHU_CHATS_KEY]: config.feishuChats.join(', '),
        // 与 githubAllowed 同一种写法：磁盘上一行逗号分隔的 open_id。
        [FEISHU_ALLOWED_KEY]: config.feishuAllowed.join(', '),
        [FEISHU_DIRECT_KEY]: config.feishuDirect,
        [ASSESSOR_MODEL_KEY]: config.assessorModel,
      }
    },
    save(key: string, value: SettingsValue): string | void {
      /** 文本类字段的统一写法：去空白，空串 = 删掉这个键。 */
      const saveText = (field: string, text: string) => {
        writePluginConfig(CONFIG_KEY, { [field]: text === '' ? null : text })
      }
      switch (key) {
        case REPO_PATH_KEY: {
          const text = String(value).trim()
          // 空串 = 删掉这个键（回到缺省的空路径）；写空串只会在 plugins.json 里留一条没意义的记录。
          writePluginConfig(CONFIG_KEY, { [REPO_PATH_KEY]: text === '' ? null : text })
          return
        }
        case MAX_WORKERS_KEY: {
          const number = Number(value)
          if (!Number.isFinite(number)) return t('save.maxWorkersBad')
          writePluginConfig(CONFIG_KEY, {
            [MAX_WORKERS_KEY]: clampInt(number, LIMITS.maxWorkers.min, LIMITS.maxWorkers.max, DEFAULTS.maxWorkers),
          })
          return
        }
        case TIMEOUT_KEY: {
          const number = Number(value)
          if (!Number.isFinite(number)) return t('save.timeoutBad')
          writePluginConfig(CONFIG_KEY, {
            [TIMEOUT_KEY]: clampInt(number, 0, TIMEOUT_MAX_SECONDS, DEFAULTS.ticketTimeoutSeconds),
          })
          return
        }
        case PREPARE_COMMAND_KEY: {
          // 空串 = 删掉这个键（回到「不跑准备命令」）。
          const text = String(value).trim()
          if (text.length > LIMITS.prepareCommand) return t('save.prepareCommandTooLong')
          saveText(PREPARE_COMMAND_KEY, text)
          return
        }
        case GITHUB_REPOSITORY_KEY: {
          const text = String(value).trim()
          // 只认 `owner/name`：写错了不会报错，只会静默地一条工单都不建（轮询打的是一个不存在的仓库）。
          // 空串是「关掉这个来源」，不算写错。
          if (text !== '' && !/^[\w.-]+\/[\w.-]+$/.test(text)) return t('save.githubRepositoryBad')
          saveText(GITHUB_REPOSITORY_KEY, text)
          return
        }
        case GITHUB_LOGIN_KEY: {
          saveText(GITHUB_LOGIN_KEY, String(value).trim())
          return
        }
        case GITHUB_ALLOWED_KEY: {
          // 存成逗号分隔的一行；顺手去掉多余空白与重复项，免得名单里躺着两条一样的。
          const names = [...new Set(String(value).split(',').map((id) => id.trim()).filter((id) => id !== ''))]
          saveText(GITHUB_ALLOWED_KEY, names.join(', '))
          return
        }
        case GITHUB_TOKEN_ENV_KEY: {
          saveText(GITHUB_TOKEN_ENV_KEY, String(value).trim())
          return
        }
        case FEISHU_ENABLED_KEY: {
          // 关掉时写 `false` 而不是删键：删了会回到缺省（也是关），两种写法效果一样，
          // 但留下 `false` 能让「用户主动关过」与「从来没配过」在磁盘上分得清。
          writePluginConfig(CONFIG_KEY, { [FEISHU_ENABLED_KEY]: value === true })
          return
        }
        case FEISHU_CLI_KEY: {
          // 路径原样存；空串 = 删掉这个键（回到 PATH 上的 lark-cli）。
          saveText(FEISHU_CLI_KEY, String(value).trim())
          return
        }
        case FEISHU_CHATS_KEY: {
          // 与 githubAllowed 同一种整理：去空白、去重，存成一行逗号分隔的文本。
          const chats = [...new Set(String(value).split(',').map((id) => id.trim()).filter((id) => id !== ''))]
          saveText(FEISHU_CHATS_KEY, chats.join(', '))
          return
        }
        case FEISHU_DIRECT_KEY: {
          writePluginConfig(CONFIG_KEY, { [FEISHU_DIRECT_KEY]: value === true })
          return
        }
        case FEISHU_ALLOWED_KEY: {
          // 与 githubAllowed 同一种整理：去空白、去重，存成一行逗号分隔的文本。
          const ids = [...new Set(String(value).split(',').map((id) => id.trim()).filter((id) => id !== ''))]
          saveText(FEISHU_ALLOWED_KEY, ids.join(', '))
          return
        }
        case ASSESSOR_MODEL_KEY: {
          saveText(ASSESSOR_MODEL_KEY, String(value).trim())
          return
        }
        default:
          return t('save.unknownKey', { key })
      }
    },
  }
}

/**
 * 装配入口：设置分区 + `/sa` 命令 + 2 秒泵 + 体检项，运行期懒建。
 *
 * 返回值故意是 void：所有退订 / 清理都交给 `ctx.effect` 统一收口（与 schedule、
 * approval-floor 同一写法），停用这一行时 cordis 自动调它，不需要手写清理清单。
 * @param ctx - 插件上下文（cordis 注入，`settings` 与 `commands` 服务已就绪）
 * @param passed - 装配时传进来的行配置（`cordis.patch.yml` 那一行的 `config`）
 */
export function apply(ctx: Context, passed?: unknown): void {
  /** 现读设置：每次用值时都调它，保存完立刻生效。 */
  const config = (): SuperagentConfig => readSuperagentConfig(passed)

  /**
   * 配好的 GitHub 来源；没配全就是 `undefined`。
   *
   * 三个字段缺一不可（仓库、机器人登录名、至少一个允许的登录名）：半配状态下把来源登记进来，
   * 只会得到「轮询在跑、一条单也不建」——那种失败没有任何提示，最难查。
   */
  const githubAccount = (): GithubAccount | undefined => {
    const current = config()
    return normalizeGithubAccount({
      repository: current.githubRepository,
      login: current.githubLogin,
      allowed: current.githubAllowed,
    })
  }

  /**
   * 配好的飞书来源；名单空就是 `undefined`。
   *
   * 判据只有一条：名单里至少一个人。群清单**不**参与——它决定「收哪些群」，不决定
   * 「谁的话算数」。把两件事混成一个判据，就会出现「配了群、没配人」这种看起来能用、
   * 实际一条单也建不出来的状态（修之前就是这个状态：消息收得到，全被判 `not_a_member`）。
   */
  const feishuAccount = (): FeishuAccount | undefined => {
    const current = config()
    return normalizeFeishuAccount({ allowed: current.feishuAllowed })
  }

  const offSection = ctx.settings.registerSection(createSettingsSection(passed))
  ctx.effect(() => offSection, 'superagent: settings.registerSection')

  // ── 运行期：懒建 / 泵 / 命令 ────────────────────────────────────────────────

  /** 打开着的库；它归插件这一侧所有，运行期关闭时**不**替我们关（见 `close()`）。 */
  let store: DscStore | null = null
  /** 已建好的运行期；null = 还没人用过（或上次启动失败）。 */
  let runtime: SuperagentRuntime | null = null
  /** 启动失败只记一次日志：泵每 2 秒一拍，不设这道闸会把控制台刷满。 */
  let warned = false
  /** 上次建库失败的一句人话；成功即清空（快照面 `problem.detail` 读它）。 */
  let lastProblem: string | null = null
  /**
   * 失败后多久才重试建库（毫秒）。
   *
   * 快照每次装配都会问 `surface()`，而它要拿运行期；不设这道闸，库一直打不开时
   * 每次重画界面都会重试一次 open + 抢锁。10 秒既不让界面卡在旧状态太久，也不打转。
   */
  let retryAt = 0
  const RETRY_MS = 10_000

  /**
   * 取运行期，没有就建一个。
   *
   * 失败一律收敛成 `null`：调用方（命令、服务）据此显示「未启动」，插件本身继续挂在
   * 宿主上。这是 §5.4「拿不到锁 / 库损坏 → 插件停在未启动，不崩宿主」的落点。
   *
   * 建起来之后立刻跑两件只在启动时做的事（各带自己的 try/catch，失败不影响插件可用）：
   *   - `recover()`：上次崩溃留下的 `running` 起新分配接续、`pending` 重新入队；
   *   - `sweep()`：删掉已结束超过 30 天的会话目录。
   */
  /**
   * 建好的 GitHub 来源；`null` = 没配、拿不到令牌、或建失败。
   *
   * `busy` 是「上一拍还没回来」：轮询是网络活，慢的时候会比间隔长，不设这道闸就会在
   * 同一个账号上越堆越多请求——配额打满之后症状是「突然一条评论都收不到了」。
   */
  let github: {
    source: ReturnType<typeof createGithubSource>
    api: ReturnType<typeof createGithubApi>
    /** 机器人自己的登录名：回评论时要用它认「这条标记是我发的」。 */
    login: string
    lastAt: number
    busy: boolean
  } | null = null

  /**
   * 建好的飞书来源；`null` = 没开、没配群、CLI 找不到，或建失败。
   *
   * `busy` 与 GitHub 那格同一个意思：上一拍还没回来就不重复 tick。`lastAt` 记的是「上一次
   * 交给来源的时刻」，不是「来源自己记的 lastPollAt」——两件事差着一次网络往返。
   * `run` 留着给发送泵用：回一条飞书消息要走同一个 CLI 执行器。
   */
  let feishu: { source: FeishuSource; run: FeishuCli['run']; lastAt: number; busy: boolean } | null = null

  /**
   * 建 GitHub 来源：三个字段配全、且读得到令牌才建。
   *
   * 三种没建起来的情况都只记一行日志、不抛：来源是可选件，缺了它插件其余部分照常工作。
   * 令牌只从环境变量读、绝不落盘——写进 `plugins.json` 就等于把它交给任何能读那台机器的人。
   */
  function startGithub(target: SuperagentRuntime): void {
    const account = githubAccount()
    if (account === undefined || store === null) return
    const variable = config().githubTokenEnv
    const token = (process.env[variable] ?? '').trim()
    if (token === '') {
      console.warn(`[superagent] GitHub 来源没启动：环境变量 ${variable} 里没有令牌`)
      return
    }
    try {
      const api = createGithubApi({ token, repository: account.repository, log: (line) => { console.warn(line) } })
      github = {
        api,
        source: createGithubSource({
          api,
          repository: account.repository,
          login: account.login,
          engine: target.sourceBridge(),
          store,
          now: () => new Date().toISOString(),
          log: (line) => { console.warn(line) },
        }),
        login: account.login,
        lastAt: 0,
        busy: false,
      }
      console.warn(`[superagent] GitHub 来源已启动：${account.repository}，每 ${String(GITHUB_POLL_INTERVAL_MS / 1000)} 秒一拍`)
    } catch (error) {
      console.warn(`[superagent] GitHub 来源没建起来：${errorText(error)}`)
    }
  }

  /** 泵的一拍里顺手推一次：到点、且上一拍没在飞才发。 */
  function pollGithub(): void {
    if (github === null || github.busy) return
    const now = Date.now()
    if (now - github.lastAt < GITHUB_POLL_INTERVAL_MS) return
    github.lastAt = now
    github.busy = true
    // 先把两个活对象抓在手里：`github` / `runtime` 都是可变的 `let`，停用插件时会被置空，
    // 而 `.then` 里的回调是几十毫秒之后才跑的，回调里再读就可能读到 null。
    const source = github.source
    const target = runtime
    void source.tick()
      .catch((error: unknown) => { console.warn(`[superagent] GitHub 轮询失败：${errorText(error)}`) })
      // 顺序：事件流 → 订阅线程的新评论 → 绑 PR → 看 CI。
      // 订阅线程要单独读（工单跟着的 PR / Issue 不在事件流里，只有合并且会经 threadClosed 报进来）；
      // 订阅清单从运行期拿（工单的 follows 只有它知道），运行期没起来就跳过这一步。
      // 这一步失败只记日志：`pollThreads` 自己已经逐线程兜住，这里再兜一层「取清单就抛了」的情况，
      // 不让它挡住后面的绑 PR 与 CI。
      .then(() => source.pollThreads(target?.subscribedThreads() ?? []))
      .catch((error: unknown) => { console.warn(`[superagent] GitHub 订阅线程轮询失败：${errorText(error)}`) })
      // 事件流看完再看 PR 的 CI：两件事的失败互不影响，所以各有各的 catch。
      // 先认领 PR（智能体自己开的那张），再看已认领的 CI——顺序反了会白等一拍。
      .then(() => bindPulls())
      .then(() => { pollPullCi() })
      .finally(() => { if (github !== null) github.busy = false })
  }

  /**
   * 出站消息的发送方：来源起来了才有对应的那一条。
   *
   * 为什么是 getter：`ensure()` 建运行期时两个来源都还没起（先有运行期，来源要拿它的
   * `sourceBridge()`）。写成现成的表，就是「插件启动那一刻排队的回复永远发不出去」。
   *
   * 没起来的来源不出现在表里，发送泵按「来源还没起来」退避重试（`dispatch.ts` 的
   * `defer`），所以「飞书晚两秒起来」不会把那条回复弄丢，而「飞书没配」会在试满几次之后
   * 丢弃并记一行——不会在库里堆一批永远发不出去的行。
   */
  function outboxSenders(): Partial<Record<string, MessageSender>> {
    const senders: Partial<Record<string, MessageSender>> = {}
    if (github !== null) {
      const current = github
      senders[GITHUB_SOURCE] = (message) => sendGithub(current.api, message, current.login)
    }
    if (feishu !== null) {
      const current = feishu
      senders[FEISHU_SOURCE] = (message) => sendFeishu(current.run, message)
    }
    return senders
  }

  /**
   * 建飞书来源：开关打开、群非空、CLI 能解析，三样都满足才起。
   *
   * 与 `startGithub` 的差别只有一处：机器人身份要问 CLI（`auth status` + `bot/v3/info`），
   * 那是一次异步调用，所以收尾在 `void (async () => ...)()` 里，`ensure()` 不等它。三样
   * 前置条件任何一样不满足都只记一行日志、不启动、不抛：来源是可选件，缺了它插件其余
   * 部分照常工作（与 §5.4 同一条）。
   *
   * 默认关的意义就在这里：不配飞书时这里一次都不会走到 spawn，机器上不会多出任何
   * lark-cli 子进程。
   */
  function startFeishu(target: SuperagentRuntime): void {
    try {
      const current = config()
      if (!current.feishuEnabled) {
        console.warn('[superagent] 飞书来源没启动：设置里没打开')
        return
      }
      if (current.feishuChats.length === 0) {
        console.warn('[superagent] 飞书来源没启动：没填群 chat_id')
        return
      }
      const resolved = resolveFeishuCli(current.feishuCli)
      if (!resolved.ok) {
        console.warn(`[superagent] 飞书来源没启动：${resolved.reason}`)
        return
      }
      // 库句柄在 `ensure()` 里刚拿到；这里再判一次是为了让类型收窄，不是真的有第二条路。
      const db = store
      if (db === null) return
      void (async () => {
        try {
          const bot = await readFeishuBot(resolved.run)
          // 等身份的这一两秒里插件可能已经被停用：运行期换了或没了就不要再起子进程，
          // 否则停用之后仍挂着一条长连接收消息（设计文档 §1.1 禁止）。
          if (runtime !== target) return
          const source = createFeishuSource({
            run: resolved.run,
            consume: resolved.consume,
            bot,
            engine: target.sourceBridge(),
            store: db,
            config: {
              chats: current.feishuChats.map((chatId) => ({ chatId })),
              directMessages: current.feishuDirect,
            },
            now: () => new Date().toISOString(),
            log: (line) => { console.warn(line) },
            // 话题轮询的三个动作（活在哪些话题、话题上最新那条消息、话题属性）：都只有运行期知道。
            threads: target.feishuThreads(),
            // 适配器内部那条循环压到一天，`tick` 的节奏只留泵一处；理由见常量注释。
            backfillEveryMs: FEISHU_INTERNAL_BACKFILL_MS,
          })
          source.start()
          feishu = { source, run: resolved.run, lastAt: Date.now(), busy: false }
          console.warn(
            `[superagent] 飞书来源已启动：${String(current.feishuChats.length)} 个群，`
              + `每 ${String(FEISHU_POLL_INTERVAL_MS / 1000)} 秒补收一轮`,
          )
        } catch (error) {
          console.warn(`[superagent] 飞书来源没启动：${errorText(error)}`)
        }
      })()
    } catch (error) {
      // 读设置本身失败（plugins.json 被手改坏）也只记一行：`ensure()` 不该因为一个可选来源
      // 走进「编排库没打开」那条分支，把已经建好的运行期关掉。
      console.warn(`[superagent] 飞书来源没启动：${errorText(error)}`)
    }
  }

  /** 泵的一拍里顺手补收一轮飞书：到点、且上一拍没在飞才发（与 `pollGithub` 同构）。 */
  function pollFeishu(): void {
    if (feishu === null || feishu.busy) return
    const now = Date.now()
    if (now - feishu.lastAt < FEISHU_POLL_INTERVAL_MS) return
    feishu.lastAt = now
    feishu.busy = true
    void feishu.source.tick()
      // `tick()` 自己已经把每个群的失败收进 `status().lastError`（`loops.ts:421-447`），
      // 这里再兜一层：来源整体抛了也只记日志，不打断泵的下一拍。
      .catch((error: unknown) => { console.warn(`[superagent] 飞书补收失败：${errorText(error)}`) })
      .finally(() => { if (feishu !== null) feishu.busy = false })
  }

  /**
   * 把「智能体自己开的 PR」绑到工单上。
   *
   * 判断与循环都在 `adapters/github/bind.ts`（那里能对着假数据测）；这里只把活对象接成
   * 五个动作。之所以不在来源适配器里绑，理由见那个文件的文件头。
   */
  async function bindPulls(): Promise<void> {
    const current = github
    const target = runtime
    const account = githubAccount()
    if (current === null || target === null || account === undefined) return
    await bindAgentPulls({
      pulls: () => current.api.slurp<OpenPull>('pulls?state=open&per_page=100'),
      tickets: () => target.openTickets(),
      account,
      bind: (ticketId, thread, own) => target.sourceBridge().bindThread(ticketId, thread, own),
      log: (line) => { console.warn(`[superagent] ${line}`) },
    })
  }

  /**
   * 关注了 PR 的工单，每张顺手看一眼 CI。
   *
   * 不 `await`：泵的下一拍不该为一次 PR 检查停住，与原来一样是发出去就走。单张失败在
   * `pollTicketChecks` 里逐单收掉，这里不会再抛。
   */
  function pollPullCi(): void {
    const current = github
    const target = runtime
    if (current === null || target === null || store === null) return
    const options = { api: current.api, engine: target.sourceBridge(), store, now: () => new Date().toISOString() }
    void pollTicketChecks({
      tickets: () => target.openTickets(),
      check: (number) => pollPullChecks(options, number),
      log: (line) => { console.warn(`[superagent] ${line}`) },
    })
  }

  /**
   * 判定器的一次问答：走宿主的模型服务，不建会话。
   *
   * 宿主没接 `llm` 时返回 `undefined`——那不是错误，是「这台机器上没有模型可用」，
   * 判定器会退回同步规则（`adapters/assessor-select.ts`）。
   *
   * 为什么用窄接口而不是 import `LlmService`：本包只用到三个方法，写成本文件里的形状，
   * 宿主那边换实现也不用跟着改（与本包执行器的做法一致）。
   */
  function oneShot(): AssessorComplete | undefined {
    const llm = ctx.get('llm') as {
      route(): { api: string; baseUrl: string; apiKey: string; model: string }
      routeTo(provider: string, model: string, effort: string): { api: string; baseUrl: string; apiKey: string; model: string }
      stream(api: string, request: Record<string, unknown>, handlers: { onDelta(delta: string): void }): Promise<{ text: string }>
    } | undefined
    if (llm === undefined) return undefined
    return async (prompt) => {
      const target = assessorTargetOf(config())
      const route = target === null ? llm.route() : llm.routeTo(target.provider, target.model, 'medium')
      const result = await llm.stream(route.api, {
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        model: route.model,
        maxTokens: 800,
        temperature: 0,
        messages: [
          { role: 'system', content: '你只输出一个 JSON 对象，不要解释。' },
          { role: 'user', content: prompt },
        ],
      }, { onDelta: () => {} })
      return result.text
    }
  }

  function ensure(): SuperagentRuntime | null {
    if (runtime !== null) return runtime
    if (Date.now() < retryAt) return null
    try {
      store = openStore()
      // 运行期的日志走宿主控制台：`ctx.logger` 不在本包的 inject 里，P0 不为一条日志
      // 多认一个硬依赖。
      // 执行器从 `ctx` 取模型 / 工具 / 守卫；仓库路径、并发上限、超时都从设置现读——
      // 设置页改了，下一张工单 / 下一拍就用新值。
      const complete = oneShot()
      const opened = new SuperagentRuntime(store, {
        log: (line) => { console.warn(line) },
        ctx,
        worker: { repo: () => config().repoPath, maxWorkers: config().maxWorkers, prepare: () => config().prepareCommand, model: null },
        timeoutSeconds: () => config().ticketTimeoutSeconds,
        // 策略与来源范围都现读：设置页改完名单，下一条消息就按新名单判，不必重启宿主。
        settings: () => defaultSettings(githubAccount(), feishuAccount()),
        scope: superagentScope(githubAccount, feishuAccount),
        // 模型名在装配时读一次：换判定模型要重开宿主（改一条设置就重建运行期代价太大）。
        assessorModel: assessorTargetOf(config()),
        ...(complete === undefined ? {} : { assessorComplete: complete }),
        // 发送方现读：两个来源在本函数返回之后才起来（`startGithub` / `startFeishu`）。
        senders: outboxSenders,
        // 判定器的线程上下文要读 GitHub（backlog S1）：来源同样是本函数返回后才起，
        // 所以给 getter；没配 GitHub 时它是 `null`，判定器就按没有上下文判。
        githubApi: () => github?.api ?? null,
      })
      runtime = opened
      warned = false
      lastProblem = null
      // 恢复与清扫各自兜底：它们坏了不该让「插件已经能用」这件事退回去。
      try {
        const recovery = opened.recover()
        if (recovery.resumed.length > 0 || recovery.requeued.length > 0) {
          console.warn(
            `[superagent] 启动恢复：${String(recovery.resumed.length)} 张接续（起新分配、工作树沿用）、` +
              `${String(recovery.requeued.length)} 张重新入队`,
          )
        }
      } catch (error) {
        console.warn(`[superagent] 启动恢复失败（插件照常可用）：${errorText(error)}`)
      }
      try {
        opened.sweep()
      } catch (error) {
        console.warn(`[superagent] 会话清理失败（插件照常可用）：${errorText(error)}`)
      }
      // 来源最后建：它要拿运行期已经装好的引擎，且失败不该影响「插件已经能用」。
      startGithub(opened)
      startFeishu(opened)
      return runtime
    } catch (error) {
      const reason = errorText(error)
      lastProblem = `编排库没打开：${reason}`
      retryAt = Date.now() + RETRY_MS
      if (!warned) {
        warned = true
        console.warn(`[superagent] 未启动：编排库没打开（${reason}）`)
      }
      // 建库失败时 `openStore` 已经把自己的连接关掉了；这里只兜「赋值到一半」的情况。
      store?.close()
      store = null
      return null
    }
  }

  // ── 服务：五个可调方法 + 快照面 ─────────────────────────────────────────────
  // 服务只拿回调，不持有库：谁开谁关的规则仍然由本文件一个人守（见 `ensure`）。
  const service = new SuperagentService({
    current: () => runtime,
    ensure,
    problem: () => (lastProblem === null ? null : { code: 'store_unavailable', detail: lastProblem }),
    changed: () => { ctx.emit('dsc/changed') },
  })
  ctx.provide('superagent', service)
  // 面登记包在 ctx.effect 里（见 `surface.ts`），停用插件即摘掉这一格。
  // 仓库路径在这里拼进快照面：`service.surface()` 是薄层、不读配置，而「路径没填」这条
  // 引导要现读设置（见 `surface.ts` 的 `withRepoGuide`）。
  registerSurface(ctx, () => withRepoGuide(service.surface(), config().repoPath))

  // ── worker 的报告工具（backlog G7）────────────────────────────────────────────
  // worker 在后台跑，正文里提的问题没有人接：给它一个工具，把 blocked / progress / ready
  // 主动说给工单。工具自己不碰库，真正的状态变更由引擎做（`core/assignments.ts:99-134`），
  // 所以这里只把「按会话反查 worker」这一手接到运行期上。
  ctx.effect(
    () => ctx.tools.register(createReportTool({
      // 运行期还没建（没人用过这个插件）时返回 false，工具会报「只在这个 worker 会话里可用」。
      report: (sessionId, report) => runtime?.reportBySession(sessionId, report) ?? false,
    })),
    'superagent: tools.register (superagent_report)',
  )
  // 主会话不该看见这个工具：worker 的目录由执行器自己按名字算（`adapters/executor.ts` 的
  // `tools()` 走 `list()`，不过投影），所以这道投影只作用在用户会话上。不藏的话，
  // 模型会在主会话里替某张工单「报进度」——那条会话连 worker 都不是，只会撞一句报错。
  ctx.effect(
    () => ctx.tools.project('superagent.worker-only', (tools) => tools.filter((tool) => tool.name !== 'superagent_report')),
    'superagent: tools.project (worker-only)',
  )

  // ── 体检项：登记进 doctor 的 health 表 ──────────────────────────────────────
  // doctor 的 pneuma.order 是 3450，早于本插件的 3800，所以 apply 时它已经 provide 了
  // `health`。doctor 没开（或将来被换掉）时 `ctx.get` 给 undefined，少一项体检而已。
  const health = ctx.get('health') as HealthService | undefined
  if (health !== undefined) {
    const offHealth = health.register(createSuperagentHealth({
      store: () => store,
      running: () => runtime?.runningStats() ?? { total: 0, orphaned: 0 },
    }))
    ctx.effect(() => offHealth, 'superagent: health.register (orchestrator)')
    // 飞书那一项单独登记：两项各自有开关与生命周期，合成一条会让一项失败拖掉另一项的读数。
    const offFeishuHealth = health.register(createFeishuHealth({
      status: () => feishu?.source.status() ?? null,
    }))
    ctx.effect(() => offFeishuHealth, 'superagent: health.register (feishu)')
    // 机器依赖那一项：git 与 lark-cli 在不在。只读设置、起两个 --version 子进程，缺了只报
    // warn（见 `health.ts`），不影响插件启动。lark-cli 的默认名从适配器拿，别在这里再写一遍。
    const offDependenciesHealth = health.register(createDependenciesHealth({
      larkCli: () => config().feishuCli || DEFAULT_FEISHU_CLI,
    }))
    ctx.effect(() => offDependenciesHealth, 'superagent: health.register (dependencies)')
  }

  ctx.effect(() => {
    const offCommands = registerCommands(ctx, ensure)
    const timer = setInterval(() => {
      // 泵不触发懒建（见文件头）；运行期建好后它负责兜底：超时取消、到期 Eval、
      // 待判定候选，并在工单阶段变了时推一次快照（`service.tick`，见 `service.ts`）。
      if (runtime === null) return
      try {
        service.tick()
      } catch (error) {
        // 单拍失败只记日志，不中断下一拍（§5.4「泵任务抛错：记日志，不中断下一轮」）。
        console.warn(`[superagent] 泵失败：${errorText(error)}`)
      }
      // 两个来源各自 try/catch：飞书读失败不该把 GitHub 那一拍一起吃掉，反之亦然。
      try {
        // GitHub 轮询挂在泵上（不自带定时器）：时间到了、上一拍也没在飞才发。
        pollGithub()
      } catch (error) {
        console.warn(`[superagent] GitHub 轮询失败：${errorText(error)}`)
      }
      try {
        pollFeishu()
      } catch (error) {
        console.warn(`[superagent] 飞书轮询失败：${errorText(error)}`)
      }
    }, PUMP_INTERVAL_MS)
    // 每天清一次会话目录。启动那次已经在 `ensure` 里跑过；这里只接「长期开着」的那一段。
    const sweeper = setInterval(() => {
      if (runtime === null) return
      try {
        runtime.sweep()
      } catch (error) {
        console.warn(`[superagent] 会话清理失败：${errorText(error)}`)
      }
    }, SWEEP_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      clearInterval(sweeper)
      offCommands()
      // 飞书先停：`stop()` 关长连接、关 stdin 并杀子进程。漏了这一步就是「停用插件后还挂着
      // 进程收消息」，设计文档 §1.1 明确禁止。顺序放在运行期与库之前：循环还在跑时库必须
      // 还在，否则它最后一次回写游标会打在已关闭的连接上。
      feishu?.source.stop()
      feishu = null
      // 来源先丢：它持有 HTTP 客户端与运行期的桥，留着只会在停用后继续发请求。
      github = null
      // 先关运行期（它只释放自己的队列），再关库（库归本文件所有）。
      runtime?.close()
      runtime = null
      store?.close()
      store = null
    }
  }, 'superagent: commands + pump + sweep + runtime')
}
