/**
 * commands 插件：provide `commands` 服务（斜杠命令注册表 + 派发）。
 * 内置命令改为注册表条目，外部插件经 ctx.commands.register 注入新命令后
 * 自动进入 /help、补全与派发。
 *
 * spec 表与补全函数都在 core/commands-completion.ts（渲染层直接 import 那份；
 * 本模块顶层的 node 内置模块会把渲染进程炸成白屏——取数走 core/git-info）。
 *
 * @module dsc/plugins/commands
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type {
  AskService,
  CommandHandler,
  CommandInvocation,
  CommandService,
  CommandSpec,
} from '../services/types.js'
import type { DscRuntime, UsageStatsView } from '../contract.js'
import {
  collectReviewScope,
  listReviewBranches,
  listReviewCommits,
  reviewStatusText,
  reviewTaskText,
  type ReviewTarget,
} from '../core/git-info.js'
import { estimateTokens } from '../core/compact.js'
import { exportSessionMarkdown } from '../core/session-export.js'
import { checkForUpdate } from '../core/update-check.js'
import { errText } from '../core/err-text.js'
import { discoverThirdPartyUiArtifacts, readUiPluginManifestReport } from '../core/ui-bundles.js'
import { dscPath } from '../core/path-policy.js'
import { trustUiPlugin } from '../core/plugin-registry.js'
import { DSC_VERSION } from '../core/version.js'
import {
  addExtraSpec,
  allSpecs,
  BUILT_IN_COMMANDS,
  expandCommand,
  helpText,
  removeExtraSpec,
  shellHelpText,
} from '../core/commands-completion.js'

/** 当前壳的 `@dsc/ui` 契约版本（内置清单顶层那个）；读不到就不设门（发现层会给出问题清单）。 */
function shellApiVersionForTrust(): string | undefined {
  return readUiPluginManifestReport().apiVersion
}

export const commandsPlugin: Plugin.Object = {
  name: 'commands',
  // /status 要问 llm 服务的窗口大小与当前端点名
  inject: ['session', 'llm'],
  provide: 'commands',
  apply(ctx) {
    const registry = new Map<string, { spec: CommandSpec; handler: CommandHandler }>()

    /**
     * `/help` 的文本按通道给：壳只列 `shell: true` 那批，终端列全量。
     * 两处共用一个注册表，但能跑的范围不同——文本必须跟着范围走（2026-10-27 查账）。
     */
    const helpFor = (ui: import('../services/types.js').CommandContext): string =>
      ui.shell === true ? shellHelpText() : helpText(service.specs())

    /**
     * 内置命令的 spec：**只从那张表取**，这里不再抄一份 args / description。
     *
     * 为什么原先抄过：注册要一个完整 CommandSpec，而 handler 是这一侧的事。但注册时
     * `register` 本来就会用 BUILT_IN 行覆盖它（下面那行 `builtin ?? spec`），抄的那份
     * 永远不生效——于是它只是第二份说明书，改文案时改错地方、也不会有人发现。
     *
     * @param name 内置命令名
     * @returns 表里那一行；表里没有（理论上不该发生）时给一个只有名字的空壳
     */
    const builtinSpec = (name: string): CommandSpec =>
      BUILT_IN_COMMANDS.find((entry) => entry.name === name) ?? { name, args: '', description: '' }

    const service: CommandService = {
      register(spec, handler) {
        // duringTask 以 BUILT_IN 表为准（spec 单一真源）：内置名注册时把声明合并进来，
        // 否则派发闸读到的注册 spec 缺 duringTask，回合中的 deny 全部落空。
        const builtin = BUILT_IN_COMMANDS.find((entry) => entry.name === spec.name)
        registry.set(spec.name, { spec: builtin ?? spec, handler })
        if (!BUILT_IN_COMMANDS.some((entry) => entry.name === spec.name)) addExtraSpec(spec)
        return () => {
          if (registry.get(spec.name)?.handler === handler) {
            registry.delete(spec.name)
            removeExtraSpec(spec)
          }
        }
      },
      specs() {
        return allSpecs()
      },
      run(input, runtime, ui) {
        if (!input.startsWith('/')) return false
        const expanded = expandCommand(input)
        const parts = expanded.slice(1).trim().split(/\s+/)
        const command = parts[0] ?? ''
        const args = parts.slice(1)
        if (command === '') {
          ui.notice(helpFor(ui))
          return true
        }
        const entry = registry.get(command)
        if (entry === undefined) {
          ui.notice(`未知命令：/${command}（/help 查看命令清单）`)
          return true
        }
        // T44：可用性矩阵统一在派发这一闸——回合跑着的时候 deny 的命令挡下，
        // 桌面 / TUI / 远端三端行为一致（以前只有桌面输入框自己禁了字）。
        if (
          entry.spec.duringTask === 'deny' &&
          runtime.getSnapshot().status.turnState !== 'idle'
        ) {
          ui.notice(`/${command} 要等当前回合结束（或先打断）再用`)
          return true
        }
        entry.handler({ args, runtime, ui })
        return true
      },
    }

    // ---- 内置命令注册 ----
    service.register(
      builtinSpec('help'),
      ({ ui }) => ui.notice(helpFor(ui)),
    )
    service.register(
      builtinSpec('new'),
      ({ runtime }) => void runtime.openSession(undefined),
    )
    service.register(
      builtinSpec('resume'),
      ({ ui }) => ui.openPicker(),
    )
    service.register(
      builtinSpec('agents'),
      ({ ui }) => ui.openAgents?.(),
    )
    service.register(
      builtinSpec('settings'),
      ({ ui }) => ui.openSettings?.(),
    )
    service.register(
      builtinSpec('model'),
      ({ args, runtime, ui }) => {
        const model = args[0]
        if (model === undefined || model === '') {
          // 裸 /model 直接开选择器；用法提示只活在补全面板里（打 / 就能看到），
          // 这里再发一条就变成常驻盒（0.6.66 用户反馈）。
          ui.openModels()
          return
        }
        void runtime.setModel(model)
      },
    )
    service.register(
      builtinSpec('status'),
      ({ ui }) => {
        const session = ctx.session.current()
        const messages = session.messages
        const compact = ctx.get('compact')
        ui.notice(
          statusReport({
            provider: ctx.llm.provider,
            model: ctx.llm.model,
            window: ctx.llm.contextWindow,
            tokens: estimateTokens(messages),
            messageCount: messages.length,
            toolCount: messages.filter((message) => message.role === 'tool').length,
            autoCompactPercent: compact !== undefined ? compact.describe().autoCompactPercent : 80,
          }),
        )
      },
    )
    service.register(
      builtinSpec('usage'),
      ({ runtime, ui }) => {
        void runtime
          .usageStats()
          .then((stats) => ui.notice(usageReport(stats)))
          .catch((cause: unknown) =>
            ui.notice(`/usage 失败：${cause instanceof Error ? cause.message : String(cause)}`),
          )
      },
    )
    service.register(
      builtinSpec('export'),
      ({ args, ui }) => {
        const session = ctx.session.current()
        if (session.messages.length === 0) {
          ui.notice('这个会话还没有消息，没东西可导出。')
          return
        }
        const stamp = new Date()
        const pad = (value: number): string => String(value).padStart(2, '0')
        const target =
          args[0] ?? join(
            session.meta.cwd || process.cwd(),
            `pneuma-export-${session.meta.id.slice(0, 8)}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`,
          )
        const markdown = exportSessionMarkdown({
          id: session.meta.id,
          cwd: session.meta.cwd,
          createdAt: session.meta.createdAt,
          messages: session.messages,
        })
        try {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, markdown, 'utf8')
        } catch (error) {
          ui.notice(`导出失败：${errText(error)}`)
          return
        }
        ui.notice(`已导出 ${session.messages.length} 条消息 → ${target}`)
      },
    )
    // ── /review：先选范围，再派只读审查队友（T45）────────────────────────────
    //
    // 范围分四档，与 codex /review 同口径：不传参数就先问「审什么」——diff 从哪来
    // 决定了这次审查在看什么，默认只审未提交改动会让「分支相对 main 改了什么」
    // 这种最常见的诉求每次都得自己先跑 git diff 再贴过来。
    // 传了参数（`/review 只看安全`）就按未提交改动审，那句话是关注点。
    /** 范围卡的四个选项（顺序即展示顺序）。 */
    const REVIEW_SCOPE_OPTIONS = [
      { label: '对比基准分支', description: '从共同祖先审查当前分支的更改' },
      { label: '审查未提交的更改', description: '暂存、未暂存与未跟踪的净改动' },
      { label: '审查某次提交', description: '挑一个提交看它改了什么' },
      { label: '自定义审查要求', description: '写一段要求，按它审当前改动' },
    ]

    /** 界面在用户点「跳过」时交回的原文（`answerOf` 的口径）；与空串一样算没答。 */
    const SKIPPED_ANSWER = '（用户跳过了这一题）'

    /**
     * 弹一张卡问一句，返回答案原文（空串 = 没答 / 跳过 / 没有提问通道）。
     *
     * 为什么这里的信号是自己 new 的：斜杠命令这条路口**没有回合取消信号**（它不是模型
     * 发起的那一轮工具调用），所以卡只能由用户自己答完或跳过。这个控制器因此不会主动
     * abort，只是为了满足 ask 的契约参数。
     */
    const askInCard = async (
      ask: AskService,
      question: { question: string; options: { label: string; description?: string }[] },
      signal: AbortSignal,
    ): Promise<string> => {
      const answer = await ask.ask(
        {
          question: question.question,
          header: '代码审查',
          options: question.options,
          multiSelect: false,
          allowFreeText: true,
        },
        signal,
      )
      const text = answer.trim()
      return text === SKIPPED_ANSWER ? '' : text
    }

    /**
     * 问出这次要审的范围；用户取消或空答返回 null（调用方收口成「审查已取消」）。
     *
     * 在范围卡上直接写自由文本时按「自定义审查要求」理解：用户写了话就是有要求，
     * 再追问一遍「你要什么要求」是废话。
     */
    const pickReviewTarget = async (
      cwd: string,
      ask: AskService,
      signal: AbortSignal,
    ): Promise<ReviewTarget | null> => {
      const choice = await askInCard(ask, { question: '选择审查范围', options: REVIEW_SCOPE_OPTIONS }, signal)
      if (choice === '') return null
      if (choice === '审查未提交的更改') return { kind: 'worktree' }
      if (choice === '自定义审查要求') {
        const instructions = await askInCard(
          ask,
          { question: '写一段审查要求，按它审当前的未提交改动', options: [] },
          signal,
        )
        return instructions === '' ? null : { kind: 'custom', instructions }
      }
      if (choice === '对比基准分支') {
        const branches = await listReviewBranches(cwd)
        const ref = await askInCard(
          ask,
          { question: '选择基准分支，也可以直接填写分支名或引用', options: branches.map((branch) => ({ label: branch })) },
          signal,
        )
        return ref === '' ? null : { kind: 'base', ref }
      }
      if (choice === '审查某次提交') {
        const commits = await listReviewCommits(cwd)
        const labels = commits.map((commit) => `${commit.sha.slice(0, 10)} ${commit.subject}`.trim())
        const answer = await askInCard(
          ask,
          { question: '选择提交，也可以直接填写提交 SHA', options: labels.map((label) => ({ label })) },
          signal,
        )
        if (answer === '') return null
        const at = labels.indexOf(answer)
        const picked = at < 0 ? undefined : commits[at]
        // 手填的 SHA 认不出来也照样交给 git：它自己会报「找不到这个引用」
        return picked === undefined
          ? { kind: 'commit', ref: answer }
          : { kind: 'commit', ref: picked.sha, ...(picked.subject === '' ? {} : { title: picked.subject }) }
      }
      // 认不出的答案就是用户在卡上直接写的要求
      return { kind: 'custom', instructions: choice }
    }

    service.register(
      builtinSpec('review'),
      ({ args, runtime, ui }) => {
        const session = ctx.session.current()
        const cwd = session.meta.cwd
        const focus = args.join(' ').trim()
        // 本命令自己的信号（见 askInCard 的说明）：命令这条路口没有回合取消信号。
        const signal = new AbortController().signal
        void (async () => {
          const ask = ctx.get('ask')
          let target: ReviewTarget | null
          if (focus !== '') {
            // 有参数 = 审未提交改动，那句话是关注点（不再弹卡，按回车就开跑）
            target = { kind: 'worktree' }
          } else if (ask === undefined) {
            // 没有提问通道（ask 插件关着）：退回默认口径，别让命令整个不可用
            ui.notice('这个会话没有提问卡通道，/review 按未提交改动审。')
            target = { kind: 'worktree' }
          } else {
            target = await pickReviewTarget(cwd, ask, signal)
          }
          if (target === null) {
            ui.notice('审查已取消。')
            return
          }
          const scope = await collectReviewScope(cwd, target, session.meta.id)
          if (scope === null) {
            ui.notice('这里不是 git 仓库，/review 没有可审查的改动。')
            return
          }
          if (scope.diffBytes === 0 && scope.untracked.length === 0) {
            ui.notice(`这个范围里没有可审查的改动（${scope.label}）。`)
            return
          }
          // 自定义要求已经写进 scope.target，不再算一次「关注点」（否则任务书里会出现两遍）
          const effectiveFocus = target.kind === 'custom' ? '' : focus
          // T18：subagent 插件开着就走只读审查队友——后台审，findings 直接出卡片，
          // 不占用当前会话的模型轮；插件没开（或额度满）回落主会话审查轮。
          const review = ctx.get('review')
          if (review !== undefined) {
            const spawned = review.spawn({ scope, focus: effectiveFocus })
            if (spawned.ok) {
              ui.notice(
                `已派出只读审查队友 ${spawned.name}（范围：${scope.label}），结论出来后直接出现在会话里；/review-status 看状态，/review-cancel 取消`,
              )
              return
            }
            ui.notice(`/review 没派出审查队友（${spawned.reason}），改在本会话里审`)
          }
          // 组装一条审查请求走正常对话轮（runtime.submit → agent.followup）：
          // 回复就是审查意见，与用户自己贴着 diff 问「帮我看看」同一条链路。
          runtime.submit(reviewTaskText(scope, effectiveFocus))
        })().catch((cause: unknown) => {
          ui.notice(`/review 失败：${errText(cause)}`)
        })
      },
    )
    service.register(
      builtinSpec('review-status'),
      ({ ui }) => {
        // 审查通道不存在（subagent 插件关着）时就是「没有记录」，与没跑过审查同一种回答
        ui.notice(reviewStatusText(ctx.get('review')?.status() ?? null))
      },
    )
    service.register(
      builtinSpec('review-cancel'),
      ({ ui }) => {
        const review = ctx.get('review')
        if (review === undefined) {
          ui.notice('审查通道没开着（subagent 插件关着），当前没有在跑的审查。')
          return
        }
        ui.notice(review.cancel() ? '已取消这次审查。' : '当前没有在跑的审查。')
      },
    )
    service.register(
      builtinSpec('diff'),
      ({ args, runtime, ui }) => {
        const file = args[0]
        void runtime
          .dock('git-diff', file === undefined ? {} : { file })
          .then((result) => {
            const diff = (result as { diff?: string }).diff ?? ''
            ui.notice(diff === '' ? '工作区没有未提交的改动（或这里不是 git 仓库）。' : diff)
          })
          .catch((cause: unknown) =>
            ui.notice(`/diff 失败：${cause instanceof Error ? cause.message : String(cause)}`),
          )
      },
    )
    service.register(
      builtinSpec('copy'),
      ({ runtime, ui }) => {
        const entries = runtime.getSnapshot().entries
        let text: string | null = null
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index]
          if (entry !== undefined && entry.kind === 'text' && entry.text.trim() !== '') {
            text = entry.text
            break
          }
        }
        if (text === null) {
          ui.notice('还没有可复制的回复。')
          return
        }
        const command =
          process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : 'wl-copy'
        try {
          const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'] })
          child.on('error', () => ui.notice(`复制失败：找不到 ${command} 命令`))
          child.stdin?.end(text)
          ui.notice(`已复制上一条回复（${text.length} 字符）到剪贴板`)
        } catch (error) {
          ui.notice(`复制失败：${errText(error)}`)
        }
      },
    )
    // 权限那三根旋钮各有一个入口，分工照着参考实现来：
    //   /permission  —— 打包预设（沙箱 + 权限模式 + 审阅者三合一的快捷档，dsh 同名命令的口径）；
    //   /policy      —— 权限模式单档（细调；拼出非预设组合时预设读作「自定义」）；
    //   /reviewer    —— 审阅者单轴（谁来裁要问的事）。
    // 三根都写 system 条目告知模型与用户，都记审计（在各自的服务里）。
    const switchPolicy: CommandHandler = ({ args, runtime, ui }) => {
      const surface = runtime.getSnapshot().surfaces.policy
      const query = args[0]?.toLowerCase() ?? ''
      if (query === '') {
        ui.notice(
          [
            `当前权限模式：${surface.current}`,
            ...surface.options.map((option) => `· ${option.id} — ${option.label}：${option.hint}`),
            '用法：/policy <档位>（支持前缀匹配，如 /policy full）',
          ].join('\n'),
        )
        return
      }
      const matches = surface.options.filter((option) => option.id.startsWith(query))
      if (matches.length !== 1) {
        ui.notice(
          matches.length === 0
            ? `未知权限档位：${args[0]}（可选：${surface.options.map((option) => option.id).join(' / ')}）`
            : `「${args[0]}」匹配到 ${matches.length} 个档位，请写全`,
        )
        return
      }
      const picked = matches[0]
      runtime.setPolicy(picked.id)
      // 回执在这里给：approval 的 setter 不再往对话里写（启动时会被复算刷好几行），
      // 而斜杠命令是用户主动要的那一下，没个回音就像没生效。
      ui.notice(`权限模式已切到「${picked.label}」`)
    }
    service.register(
      builtinSpec('policy'),
      switchPolicy,
    )
    service.register(
      builtinSpec('reviewer'),
      ({ args, runtime, ui }) => {
        const surface = runtime.getSnapshot().surfaces.policy
        const query = args[0]?.toLowerCase() ?? ''
        if (query === '') {
          ui.notice(
            [
              `当前审阅者：${surface.reviewer}`,
              ...surface.reviewerOptions.map((option) => `· ${option.id} — ${option.label}：${option.hint}`),
              '用法：/reviewer <user|auto-review>',
            ].join('\n'),
          )
          return
        }
        const matches = surface.reviewerOptions.filter((option) => option.id.startsWith(query))
        if (matches.length !== 1) {
          ui.notice(
            matches.length === 0
              ? `未知审阅者：${args[0]}（可选：${surface.reviewerOptions.map((option) => option.id).join(' / ')}）`
              : `「${args[0]}」匹配到 ${matches.length} 个审阅者，请写全`,
          )
          return
        }
        const picked = matches[0]
        runtime.setReviewer(picked.id)
        ui.notice(
          `审批审阅者已切到「${picked.label}」${
            picked.id === 'auto-review' ? '：要问的事先给模型判官，判不出来仍会问你' : ''
          }`,
        )
      },
    )
    service.register(
      builtinSpec('permission'),
      ({ args, runtime, ui }) => {
        const presets = runtime.getSnapshot().surfaces.permissionPresets
        const query = args[0] ?? ''
        if (query === '') {
          ui.notice(
            [
              `当前权限预设：${presets.current}${presets.current === 'custom' ? '（三根旋钮的组合不匹配任何预设）' : ''}`,
              ...presets.options.map((option) => `· ${option.name} — ${option.label}：${option.description}`),
              '用法：/permission <预设名>（如 /permission full-access）；细调单档用 /policy、/reviewer',
            ].join('\n'),
          )
          return
        }
        // 档位名被误当预设名时给一句能照着走的提示，别只说「认不出」
        if (runtime.getSnapshot().surfaces.policy.options.some((option) => option.id === query.toLowerCase())) {
          ui.notice(`「${query}」是权限档位不是预设：切档位用 /policy ${query}，切预设的名字见 /permission（不带参数）`)
          return
        }
        const matches = presets.options.filter((option) => option.name.startsWith(query.toLowerCase()))
        if (matches.length !== 1) {
          ui.notice(
            matches.length === 0
              ? `未知权限预设：${query}（可选：${presets.options.map((option) => option.name).join(' / ')}）`
              : `「${query}」匹配到 ${matches.length} 个预设，请写全`,
          )
          return
        }
        const result = runtime.usePermissionPreset(matches[0].name)
        if (!result.ok) ui.notice(result.error)
      },
    )
    service.register(
      builtinSpec('effort'),
      ({ args, runtime, ui }) => {
        const levels = [
          { id: 'default', label: '默认（不声明思考字段，跟随端点）' },
          { id: 'off', label: '关闭思考' },
          { id: 'low', label: '低' },
          { id: 'high', label: '高' },
          { id: 'max', label: '最大' },
        ] as const
        const query = args[0]?.toLowerCase() ?? ''
        if (query === '') {
          ui.notice(
            [
              `当前思考强度：${runtime.getSnapshot().status.effort}`,
              ...levels.map((level) => `· ${level.id} — ${level.label}`),
              '用法：/effort <档位>（当前模型不支持的档位会报错）',
            ].join('\n'),
          )
          return
        }
        const matches = levels.filter((level) => level.id.startsWith(query))
        if (matches.length !== 1) {
          ui.notice(
            matches.length === 0
              ? `未知思考档位：${args[0]}（可选：${levels.map((level) => level.id).join(' / ')}）`
              : `「${args[0]}」匹配到 ${matches.length} 个档位，请写全`,
          )
          return
        }
        void runtime.setEffort(matches[0].id)
      },
    )
    service.register(
      // dsh 语义：整本分叉成「可恢复的副本」，现场会话与跑动回合不动（kimi-code
      // 的 fork）。按分叉点选副本走 /resume 里的 Ctrl+F，这里只做整本。
      builtinSpec('fork'),
      ({ runtime, ui }) => {
        // sessionId 是 uuid，当文件用会按进程 cwd 解析出 ENOENT（0.6.66 实锤：
        // C:\Windows\System32\<uuid>）；落盘一律走 sessionPath。
        const path = runtime.getSnapshot().status.sessionPath
        if (path === undefined || path === '') {
          ui.notice('当前还没有可分叉的会话（先聊一句再分叉）。')
          return
        }
        void runtime
          .listUserMessages(path)
          .then((messages) => runtime.forkSession(path, messages.length))
          .then((result) => {
            if (!result.ok) {
              ui.notice(`/fork 失败：${result.error}`)
              return
            }
            const shortId = (result.path.split(/[\\/]/).pop() ?? result.path)
              .replace(/\.jsonl$/, '')
              .slice(0, 8)
            ui.notice(`已分叉出副本 ${shortId}，当前会话不变；/resume 里可以打开它`)
          })
          .catch((cause: unknown) => ui.notice(`/fork 失败：${errText(cause)}`))
      },
    )
    service.register(
      // 思考块显示切换：与 Ctrl+T 同一状态（会话内生效，不持久化——持久化的
      // 默认值在设置「新会话的思考块默认摊开」）。没有思考块的端忽略回调。
      builtinSpec('thinking'),
      ({ args, ui }) => {
        if (ui.toggleThinking === undefined) {
          ui.notice('当前界面不支持会话内切换思考块（桌面端在设置里改「新会话的思考块默认摊开」）。')
          return
        }
        const query = args[0]?.toLowerCase() ?? ''
        if (query === '') {
          ui.toggleThinking()
          return
        }
        if (query !== 'on' && query !== 'off') {
          ui.notice('用法：/thinking [on|off]（无参数 = 翻转当前显示）')
          return
        }
        ui.toggleThinking(query === 'on')
      },
    )
    service.register(
      builtinSpec('plugins'),
      ({ runtime, ui }) => {
        const plugins = runtime.listPlugins()
        if (plugins.length === 0) {
          ui.notice('没有已挂载的插件（内核自带服务不在此列）。')
          return
        }
        const lines = plugins.map((plugin) => {
          const flags = [plugin.source === 'builtin' ? '内核' : '外部', plugin.enabled ? undefined : '已停用']
            .filter((flag) => flag !== undefined)
            .join(' · ')
          const problem = plugin.problem !== undefined ? `（注意：${plugin.problem}）` : ''
          return `· ${plugin.name}（${flags}）— ${plugin.description}${problem}`
        })
        ui.notice(
          [
            `已挂载插件（${plugins.length} 个）`,
            ...lines,
            '启停与配置在桌面端「插件」页；外部插件放进 ~/.dsc/plugins 会自动加载。',
          ].join('\n'),
        )
      },
    )
    service.register(
      // 只查不装（0.6.50 起的边界）：结果与设置「关于」的检查按钮同一份回执口径，
      // 终端打不开浏览器，新版时把发布页 URL 一并给出。
      builtinSpec('update'),
      ({ ui }) => {
        void checkForUpdate()
          .then((result) => {
            if (!result.ok) {
              ui.notice(result.error)
              return
            }
            ui.notice(result.data?.url !== undefined ? `${result.notice}\n发布页：${result.data.url}` : result.notice)
          })
          .catch((cause: unknown) => ui.notice(`/update 失败：${errText(cause)}`))
      },
    )
    service.register(
      builtinSpec('ui-trust'),
      ({ args, ui }) => {
        const name = args[0] ?? ''
        if (name === '') {
          // 列出当前等着被确认的（discover 的 problems 里就有它们的名字）。
          const pending = discoverThirdPartyUiArtifacts(shellApiVersionForTrust(), new Set())
          const waiting = pending.problems.filter((line) => line.includes('还没有信任记录'))
          if (waiting.length === 0) {
            ui.notice('没有等着确认的第三方界面插件。装法：把 <目录名>/{plugin.json, ui/client.js} 放进 ~/.dsc/plugins/。')
            return
          }
          ui.notice(
            ['还没确认的第三方界面插件（能调宿主的界面方法与原生桥，确认前不装载）：', ...waiting.map((line) => `  ${line}`), '确认：/ui-trust <插件目录名>'].join('\n'),
          )
          return
        }
        const fileKey = `${name}/ui/client.js`
        // 摊开能力面再落信任：它声明对着哪个契约版本、跑在哪种壳，以及两条通用能力。
        const manifestPath = join(dscPath('plugins'), name, 'plugin.json')
        let api = '(没写)'
        let platforms = 'web'
        try {
          const doc = JSON.parse(readFileSync(manifestPath, 'utf8')) as { api?: unknown; platforms?: unknown }
          if (typeof doc.api === 'string') api = doc.api
          if (Array.isArray(doc.platforms) && doc.platforms.length > 0) platforms = doc.platforms.join('/')
        } catch {
          ui.notice(`读不到 ${fileKey} 的 plugin.json——目录名对吗？（要的是 ~/.dsc/plugins/<目录名>）`)
          return
        }
        trustUiPlugin(fileKey)
        ui.notice(
          [
            `已信任第三方界面插件「${name}」`,
            `  @dsc/ui 区间：${api}（当前壳 ${DSC_VERSION}，不满足会被门禁拦下并说明）`,
            `  载体：${platforms}`,
            '  能力：调用宿主界面通道的白名单方法；桌面窗口里可用原生桥（打开目录、终端等 14 个操作）',
            '  生效：重启宿主（或刷新浏览器页面）后装载；停用走 plugins.json 的启停或插件中心',
          ].join('\n'),
        )
      },
    )
    service.register(
      builtinSpec('exit'),
      ({ runtime }) => runtime.exit(),
    )

    serviceRef = service
    ctx.provide('commands', service)
  },
}

/** 注册表单例引用（App.tsx 的 runCommand 走它，外部命令一并派发）。 */
let serviceRef: CommandService | null = null

/** 兼容导出：v2 的 runCommand（App.tsx 零逻辑改动，仅 import 路径变化）。 */
export function runCommand(
  input: string,
  runtime: DscRuntime,
  ui: import('../services/types.js').CommandContext,
): boolean {
  return serviceRef !== null ? serviceRef.run(input, runtime, ui) : false
}

/**
 * /usage 的文本组装（独立成函数便于脱离命令体系直测）。
 * 缓存命中率只统计端点上报过明细的请求（usage-log 的口径），没上报的不掺进来。
 */
export function usageReport(stats: UsageStatsView): string {
  if (stats.totalTurns === 0) return '还没有用量记录（~/.dsc/usage/usage.jsonl 里一条都没有）。'
  const fmtTokens = (value: number): string =>
    value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(value)
  const lines = [
    `用量统计（自 ${new Date(stats.sinceTs ?? Date.now()).toISOString().slice(0, 10)}，${stats.activeDays} 天有活动）`,
    `· 累计：输入 ${fmtTokens(stats.totalInputTokens)} / 输出 ${fmtTokens(stats.totalOutputTokens)} tokens，共 ${stats.totalTurns} 轮请求`,
  ]
  const cacheTotal = stats.totalCacheHitTokens + stats.totalCacheMissTokens
  if (cacheTotal > 0) {
    lines.push(
      `· 前缀缓存命中：${Math.round((stats.totalCacheHitTokens / cacheTotal) * 100)}%（命中 ${fmtTokens(stats.totalCacheHitTokens)} / 未命中 ${fmtTokens(stats.totalCacheMissTokens)}，只统计上报过明细的请求）`,
    )
  }
  if (stats.peakDay !== null) {
    lines.push(
      `· 单日峰值：${stats.peakDay.date}（${fmtTokens(stats.peakDay.inputTokens + stats.peakDay.outputTokens)} tokens）`,
    )
  }
  lines.push(`· 连续活跃 ${stats.currentStreakDays} 天（最长 ${stats.longestStreakDays} 天）`)
  const top = stats.models.slice(0, 5)
  if (top.length > 0) {
    lines.push('按模型（Top 5）：')
    for (const model of top) {
      lines.push(`· ${model.key}：${fmtTokens(model.inputTokens + model.outputTokens)} tokens（${model.turns} 轮）`)
    }
  }
  return lines.join('\n')
}

/**
 * /status 的文本组装（独立成函数便于脱离命令体系直测）。
 * tokens 由调用方用 core/compact 的 estimateTokens 算——数字与自动压缩触发判定同源。
 */
export function statusReport(input: {
  provider: string
  model: string
  window: number
  tokens: number
  messageCount: number
  toolCount: number
  autoCompactPercent: number
}): string {
  const threshold = Math.round(input.window * (input.autoCompactPercent / 100))
  const share = input.window > 0 ? Math.round((input.tokens / input.window) * 100) : 0
  return [
    '上下文占用',
    `· 模型：${input.provider}/${input.model}（窗口 ${input.window.toLocaleString('zh-CN')} tokens）`,
    `· 消息：${input.messageCount} 条（其中工具结果 ${input.toolCount} 条）`,
    `· 估算用量：${input.tokens.toLocaleString('zh-CN')} tokens，约占窗口 ${share}%`,
    `· 自动压缩触发线：${input.autoCompactPercent}%（≈${threshold.toLocaleString('zh-CN')} tokens，还差 ${Math.max(0, threshold - input.tokens).toLocaleString('zh-CN')}）`,
    '· 估算口径与自动压缩同源（中文 0.65、其余 0.33 tokens/字符）',
  ].join('\n')
}
