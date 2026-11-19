/**
 * runtime 插件：provide `runtime` 服务（DscRuntime 适配器）。
 * 把各服务织成 contract.ts 的 DscRuntime 契约——TUI（ink）与桌面端 renderer
 * 消费同一接口；/ 前缀命令派发仍在 UI 层（commands.runCommand）。
 * exit 语义：发出 dsc/exit（各插件同步收尾）后立即退进程，与 v2 行为一致。
 *
 * @module dsc/plugins/runtime
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { errText } from '@pneuma/runtime/adapter/transcript.js'
import { canTogglePlugin, listPluginInfos, writePluginEnabled } from '@pneuma/runtime/core/plugin-registry.js'
import { setPluginEnabledHot } from '@pneuma/runtime/core/plugin-loader.js'
import {
  discoverThirdPartyUiArtifacts,
  isPackageUiEntry,
  isThirdPartyUiEntry,
  readUiPluginManifestReport,
  scanPackageUiTrusts,
  scanThirdPartyUiTrusts,
  trustThirdPartyUiPlugin,
} from '@pneuma/runtime/core/ui-bundles.js'
import { buildUsageStats } from '@pneuma/runtime/core/usage-log.js'
import { sideAskOnce } from '@pneuma/runtime/core/side-ask.js'
import { shellCommandRejection, shellCommands } from '@pneuma/commands-core/commands-completion.js'
import type { DscRuntime, SettingsMutation, UiPrefsView } from '@pneuma/runtime/contract.js'
import {
  FONT_SIZE_PX_DEFAULT,
  fontScaleFromTextSizePx,
  normalizeTextSizePx,
  textSizePxFromLegacy,
} from '@pneuma/runtime/contract.js'
import type { UserFileAttachment } from '@pneuma/runtime/core/attachments.js'

/**
 * Super Agent 通道的工单 id。
 *
 * 契约形状是 `{ id }`，但界面半也可能直接传裸字符串（界面通道的实参规格是 json，
 * 两种都过形校验）。这里只认这两种，其它形状当场给一句能读的话——不做字符串化糊弄。
 */
function superagentTicketId(input: unknown): string {
  if (typeof input === 'string') return input
  if (input !== null && typeof input === 'object') {
    const id = (input as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  throw new Error('要给一个工单 id（`{ id }` 或裸字符串）')
}

/**
 * 回答工单问题的入参：`{ ticketId, text }`。
 *
 * 为什么在这里校验：实参规格只保证「是一个不超过字节上限的 JSON 对象」，里面可以什么
 * 都没有。ticketId 交给 `superagentTicketId` 收窄（它同时认 `{ id }` 与裸字符串），
 * text 在这里只判空与类型——4000 字的业务上限归服务层，那是业务规则，不是通道闸。
 */
function superagentAnswerOf(input: unknown): { ticketId: string; text: string } {
  if (input === null || typeof input !== 'object') throw new Error('要给 `{ ticketId, text }`：回哪张工单、回什么')
  const { ticketId, text } = input as { ticketId?: unknown; text?: unknown }
  if (typeof text !== 'string' || text.trim() === '') throw new Error('回答不能为空：写一句要回它的话')
  return { ticketId: superagentTicketId(ticketId), text }
}

export const runtimePlugin: Plugin.Object = {
  name: 'ui-runtime',
  inject: [
    'agent',
    'session',
    'transcript',
    'approval',
    'llm',
    'commands',
    'dock',
    'skills',
    'settings',
    'compact',
    // 设置 → 模式 的工具多选要读完整工具目录（listTools）
    'tools',
    // 界面上那几块卡片的操作要落到各自的功能点：档位切换、清单、计划卡、提问卡、目标。
    'mode',
    'presets',
    // 打包权限预设那颗旋钮（沙箱 + 权限模式 + 审阅者三合一）读它、切它。
    'permissionPresets',
    'todo',
    'plan',
    'ask',
    'goal',
  ],
  provide: 'ui',
  apply(ctx) {
    /**
     * 同步写动作的统一包装：功能点那边抛错是有意义的（名字非法、内置删不掉、
     * 文件写不进去），契约要求把失败原因原样交给界面显示，而不是让 IPC 那头收到一个异常。
     */
    function mutateWith(work: () => string): SettingsMutation {
      try {
        return { ok: true, notice: work() }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    }

    /**
     * / 命令执行期的界面回调（`runCommand` 与 `runUiCommand` 共用一份）。
     *
     * notice 写 transcript 条目（TUI 与壳都直接读它，所以命令输出在哪一端都看得见）；
     * openPicker / openModels 只是事件——终端壳与旧桌面渲染层各有一条转发链
     * （host-stdio / remote → 各自界面）。壳自己的那批命令不依赖这两个回调。
     */
    function commandUi(shell = false): import('@pneuma/runtime/services/types.js').CommandContext {
      return {
        // 壳那条通道只放行 `shell: true` 的命令，/help 据此只列能跑的那批
        ...(shell ? { shell: true } : {}),
        // 命令输出标一条 command：壳的空会话欢迎态会把首屏 system 条目整批不画，
        // 不标的话新会话里打第一条命令什么也看不到（2026-10-27 查账）
        notice: (text) => ctx.transcript.system(text, undefined, true),
        openPicker: () => ctx.emit('dsc/open-picker'),
        openModels: () => ctx.emit('dsc/open-models'),
      }
    }

    /**
     * 进行中的旁问：票据 → 取消信号。
     *
     * 为什么要一张表：
     * - 界面要能「停止」（一张票据换一个 AbortController）；
     * - 同一张票据重复发（双击）时先掐掉旧的，不留两条同时烧 token。
     */
    const sideAsks = new Map<string, AbortController>()

    const runtime: DscRuntime = {
      subscribe(listener) {
        return ctx.transcript.subscribe(listener)
      },

      getSnapshot() {
        return ctx.transcript.getSnapshot()
      },

      submit(text: string, images?: string[], files?: UserFileAttachment[]) {
        ctx.agent.followup(text, images, undefined, 'user', files)
      },

      interrupt() {
        ctx.agent.interrupt()
      },

      // 排队输入（0.6.67）：界面上的队列条按快照的 queued 画，这三个是它的动作面。
      editQueued(index: number, text: string) {
        return ctx.agent.editQueued(index, text)
      },

      removeQueued(index: number) {
        return ctx.agent.removeQueued(index)
      },

      steerQueued(index?: number) {
        return ctx.agent.steerQueued(index)
      },

      openSession(filePath?: string) {
        return ctx.session.open(filePath)
      },

      newSessionIn(cwd: string) {
        return ctx.session.open(undefined, cwd)
      },

      async compact() {
        await ctx.compact.run()
      },

      async setModel(model: string) {
        // 引用的解析交给 llm 服务（端点名最长前缀匹配）：模型 id 自己可能带斜杠，
        // 在界面通道这层按首个斜杠切会把「command/deepseek/deepseek-v4.1-flash」
        // 切碎成「command + deepseek」，报出「端点 command 没有模型 deepseek」。
        const target = ctx.llm.parseModelRef(model)
        try {
          ctx.llm.setModel(target.provider, target.model)
          ctx.transcript.system(`模型切换为 ${ctx.llm.provider}/${ctx.llm.model}（下一次请求生效）`)
        } catch (error) {
          ctx.transcript.system(errText(error))
        }
        ctx.transcript.touch()
      },

      async setEffort(effort, quiet = false) {
        try {
          ctx.llm.setEffort(effort)
        } catch (error) {
          ctx.transcript.system(errText(error))
          ctx.transcript.touch()
          return
        }
        // quiet：输入区滑杆调档不写这一行（2026-10-26）。写的话每换一档就往正文里塞一行，
        // 还要跟着多推一帧；档位在 chip 上读得到，不需要回执。快照仍要 touch 一次：
        // status.effort 变了，界面得靠它把乐观值换成真实值。
        if (!quiet) {
          const label =
            effort === 'default'
              ? '默认（不声明思考）'
              : effort === 'off'
                ? '关闭'
                : { low: '低', high: '高', max: '最大' }[effort]
          ctx.transcript.system(`思考强度设为「${label}」（下一次请求生效）`)
        }
        ctx.transcript.touch()
      },

      listPlugins() {
        return listPluginInfos()
      },

      async setPluginEnabled(file, enabled) {
        // 能不能停只判一次、**不写盘**：以前这里先 writePluginEnabled 判一下并顺手写盘，
        // 随后 setPluginEnabledHot 里又写一次，点一次开关就把整份 plugins.json
        // 「读 → 改一条 → 写回」跑两遍；中间任何并发写（界面信任、设置保存）会被后一遍盖掉（P0-3）。
        // 现在落盘只有下面每一条路径各一处：界面半边自己写（没有宿主光纤可热挂），
        // 其余宿主行交给 setPluginEnabledHot（唯一持久化点）。
        if (!canTogglePlugin(file)) {
          ctx.transcript.system('这一档属于运行内核，构成 dsc 本身，不能停用')
          ctx.transcript.touch()
          return
        }
        /**
         * 页面的根：骨架与渲染器。
         *
         * 别的界面单元是往槽里挂一块，换掉它只是重装一条；这两个换掉等于换整页
         * （渲染器在首帧之前就把骨架取出来画上了），所以它们仍然提示刷新。
         * 判据用启停键——它们是内置界面单元，键是 `ui-<产物 id>`。
         */
        const rootEntry = file === 'ui-layout' || file === 'ui-renderer'
        // 第三方界面插件（<目录名>/ui/client.js）没有宿主半边可挂：写盘之后由 webserver
        // 换图并推一帧，页面按那一帧卸载/装载这一条（与产物热更同一条通道）。
        if (isThirdPartyUiEntry(file)) {
          // 这一支不走热挂载，落盘就留在这里（一次点击只写这一次）。
          writePluginEnabled(file, enabled)
          const name = file.split('/')[0] ?? file
          if (!rootEntry) ctx.emit('dsc/ui-plugins-changed', { file, enabled })
          ctx.transcript.system(
            `已${enabled ? '启用' : '停用'}第三方界面插件「${name}」，${rootEntry ? '刷新页面（或重启宿主）后生效' : '即时生效'}`,
          )
          ctx.transcript.touch()
          return
        }
        // 组合包的界面半边（<包名>/client）同一条理由：没有宿主半边可热挂。
        if (isPackageUiEntry(file)) {
          writePluginEnabled(file, enabled)
          const name = file.slice(0, -'/client'.length)
          ctx.transcript.system(`已${enabled ? '启用' : '停用'}组合包的界面半「${name}」，即时生效`)
          ctx.emit('dsc/ui-plugins-changed', { file, enabled })
          ctx.transcript.touch()
          return
        }
        const shown = listPluginInfos().find((item) => item.file === file)?.name ?? file
        // 热启停：即时挂载/卸载，**落盘由 setPluginEnabledHot 负责（宿主行唯一一处）**；
        // 这里不再自己写盘，写两次就是 P0-3 那个覆盖窗口。失败回滚（挂载失败自动停用）也在它里面。
        const outcome = await setPluginEnabledHot(file, enabled)
        if (!outcome.ok) {
          ctx.transcript.system(`插件「${shown}」没能启用：${outcome.problem ?? '未知原因'}（已经退回停用状态）`)
        } else {
          // 带界面半边的插件（19 个界面单元都是）启停之后，页面那一份启动图跟着换：
          // 不推这一下的话，宿主这边已经停了、页面还挂着这块界面，要刷新才对齐。
          if (!rootEntry) ctx.emit('dsc/ui-plugins-changed', { file, enabled })
          ctx.transcript.system(`已${enabled ? '启用' : '停用'}插件「${shown}」，即时生效`)
        }
        ctx.transcript.touch()
      },

      listUiTrust() {
        const report = readUiPluginManifestReport()
        const builtinIds = new Set(report.entries.map((entry) => entry.id))
        const third = scanThirdPartyUiTrusts(report.apiVersion, builtinIds)
        // 组合包的撞名要和发现层一个口径：内置 + 第三方里**真进了启动图**的那些
        //（被停用或没信任的第三方不占 id，不能拿来判别人撞名）。
        const accepted = discoverThirdPartyUiArtifacts(report.apiVersion, builtinIds)
        const taken = new Set([...builtinIds, ...accepted.entries.map((entry) => entry.id)])
        return [...third, ...scanPackageUiTrusts(report.apiVersion, taken)]
      },

      setUiTrust(name) {
        const report = readUiPluginManifestReport()
        const outcome = trustThirdPartyUiPlugin(name, report.apiVersion, new Set(report.entries.map((entry) => entry.id)))
        // 信任落盘之后它的界面半边就**可以**进启动图了：立刻告诉有通道的那一端换图推帧，
        // 页面当场把它装上，不用人按 F5。失败（名字写错、没写 api）什么都不发。
        if (outcome.ok) ctx.emit('dsc/ui-graph-dirty')
        return outcome
      },

      listTeammates() {
        // 「子智能体」没开时这个服务就不存在，侧栏因此看到空列表。
        // 必须走 ctx.get：cordis 的上下文代理对没 inject 的属性是直接抛错的，`ctx.team?.` 也会先抛
        const team = ctx.get('team')
        return team === undefined ? [] : team.list()
      },

      listTeamBoard() {
        // 状态面板画的是「用户正在看的这条会话」的板：切会话就换一块。
        // 队友认领走的是另一条口径（派它的那个会话，见 subagent 的 runTeamTask），两边都不看「当前会话」猜。
        const team = ctx.get('team')
        if (team === undefined) return { revision: 0, tasks: [] }
        return team.board(ctx.session.current().meta.id)
      },

      openTeammate(name) {
        // 与 stopTeammate 同一条理由：team 是可选服务，只能 ctx.get。
        // 点开一位队友 = 打开它那条真会话；收工的可续接队友由 subagent 插件先复活再打开。
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，没有队友可以打开'))
        return team.open(name)
      },

      stopTeammate(name) {
        // 与 listTeammates 同一条理由：team 是可选服务，只能 ctx.get
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，没有队友可以收掉'))
        return team.stop(name)
      },

      messageTeammate(name, text) {
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，没法给队友传话'))
        return team.message(name, text)
      },

      removeTeammate(name) {
        // 与 stopTeammate 同一条理由：team 是可选服务，只能 ctx.get
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，名册里没有可移除的队友'))
        return team.remove(name)
      },

      async stopBackground(id) {
        // 与 stopTeammate 同一条理由：这是可选服务，只能 ctx.get（探针的迷你内核里没有它）
        const works = ctx.get('backgroundWorks')
        if (works === undefined) throw new Error('后台作业表不在（内置工具插件没挂），没有后台活可以收')
        return works.stop(id)
      },

      async readBackground(id) {
        // 与 stopBackground 同一条理由与同一档归属校验：只读看自己起的后台活的输出
        const works = ctx.get('backgroundWorks')
        if (works === undefined) throw new Error('后台作业表不在（内置工具插件没挂），没有输出可读')
        return works.read(id)
      },

      peekTranscript(file) {
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，看不到队友的运行记录'))
        return team.peek(file)
      },

      // ── Super Agent 工单 ───────────────────────────────────────────────────
      // 宿主插件默认关着，所以只能 ctx.get（不写进 inject：关着时不该把整条运行期拖挂）。
      // 这几条只做转发，业务与装配都在 @pneuma/superagent（service.ts / surface.ts）。
      superagentPublish(input) {
        const superagent = ctx.get('superagent')
        if (superagent === undefined) return Promise.reject(new Error('Super Agent 插件没开，发不了工单'))
        return superagent.publish(input)
      },

      superagentStopTicket(input) {
        const superagent = ctx.get('superagent')
        if (superagent === undefined) return Promise.reject(new Error('Super Agent 插件没开，没有工单可停'))
        return superagent.stop(superagentTicketId(input))
      },

      superagentRetryTicket(input) {
        const superagent = ctx.get('superagent')
        if (superagent === undefined) return Promise.reject(new Error('Super Agent 插件没开，没有工单可重试'))
        return superagent.retry(superagentTicketId(input))
      },

      superagentAnswer(input) {
        const superagent = ctx.get('superagent')
        if (superagent === undefined) return Promise.reject(new Error('Super Agent 插件没开，没法回话'))
        const { ticketId, text } = superagentAnswerOf(input)
        return superagent.answer({ ticketId, text })
      },

      superagentCleanWorktree(input) {
        const superagent = ctx.get('superagent')
        if (superagent === undefined) return Promise.reject(new Error('Super Agent 插件没开，没有工作树可清理'))
        return superagent.clean(superagentTicketId(input))
      },

      superagentPeekSession(input) {
        const superagent = ctx.get('superagent')
        if (superagent === undefined) return Promise.reject(new Error('Super Agent 插件没开，看不到执行会话'))
        return superagent.peekSession(superagentTicketId(input))
      },

      setPolicy(policy) {
        ctx.approval.setPolicy(policy)
      },

      setReviewer(reviewer) {
        ctx.approval.setReviewer(reviewer)
      },

      // ── 打包权限预设（沙箱 + 权限模式 + 审阅者）──
      listPermissionPresets() {
        return ctx.permissionPresets.surface()
      },

      usePermissionPreset(name) {
        return mutateWith(() => ctx.permissionPresets.use(name))
      },

      setDefaultPermissionPreset(name) {
        return mutateWith(() => ctx.permissionPresets.setDefault(name))
      },

      setMode(mode) {
        ctx.mode.setMode(mode)
      },

      // ── 模式（预设）──
      listPresets() {
        return ctx.presets.surface()
      },

      async readPreset(name) {
        try {
          return { ok: true, name, text: ctx.presets.read(name) }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      usePreset(name) {
        return mutateWith(() => ctx.presets.use(name))
      },

      savePreset(draft) {
        return mutateWith(() => ctx.presets.save(draft))
      },

      removePreset(name) {
        return mutateWith(() => ctx.presets.remove(name))
      },

      setDefaultPreset(name) {
        return mutateWith(() => ctx.presets.setDefault(name))
      },

      listTools() {
        return ctx.tools.list().map((entry) => ({
          name: entry.name,
          risk: entry.risk,
          description: entry.description,
          ...(entry.presets !== undefined ? { presets: [...entry.presets] } : {}),
        }))
      },

      answerQuestion(answer) {
        ctx.ask.answerQuestion(answer)
      },

      answerPlan(decision, feedback) {
        ctx.plan.answerPlan(decision, feedback)
      },

      goalAction(action) {
        return ctx.goal.goalAction(action)
      },

      clearTodos() {
        ctx.todo.clearTodos()
      },

      dock(op, payload) {
        return ctx.dock.handle(op, payload ?? {})
      },

      runCommand(input) {
        // / 命令统一在宿主命令注册表派发（内置 + 外部插件命令）；
        // notice 反馈写 transcript 条目，openPicker 经事件转发给宿主壳。
        return ctx.commands.run(input, runtime, commandUi())
      },

      listUiCommands() {
        // 菜单与派发读同一份 `shellCommands()`，所以「列出来的」与「能跑的」不会漂。
        return shellCommands().map((spec) => ({
          name: spec.name,
          args: spec.args,
          description: spec.description,
          ...(spec.label === undefined ? {} : { label: spec.label }),
          // 要收输入的命令（/review）：壳据此把回车改成「先补全、不执行」。
          ...(spec.input === undefined ? {} : { input: spec.input }),
          duringTask: spec.duringTask ?? 'allow',
        }))
      },

      runUiCommand(input) {
        // 界面通道的命令面：只有标了 `shell: true` 的才派发（失败关闭，尺子写在
        // packages/commands-core/commands-completion.ts）。判据是纯函数 `shellCommandRejection`——
        // 壳能跑什么，探针直测那一份；这里只负责「不放行就抛、放行走同一条注册表」。
        const rejection = shellCommandRejection(input)
        if (rejection !== null) throw new Error(rejection)
        return ctx.commands.run(input, runtime, commandUi(true))
      },

      listModels() {
        return ctx.llm.listModels()
      },

      // ── 技能中心 ──
      listSkills() {
        return ctx.skills.list()
      },

      readSkill(name) {
        return ctx.skills.read(name)
      },

      setSkillEnabled(name, enabled) {
        return ctx.skills.setEnabled(name, enabled)
      },

      // 第三参 refresh 由界面「刷新」按钮传入（ui-methods 的 browseMarket 规格已放行
      // 一个可选 boolean）：true = 跳过缓存强制联网；省略/false = 先用新鲜缓存。
      // 显式标注类型：契约里这条只声明了两个可选参数，第三个由这里补成可选，
      // 让实现在类型上仍能赋给 DscRuntime（多一个可选参数不算加宽调用面）。
      browseMarket(source: string | undefined, query: string | undefined, refresh?: boolean) {
        return ctx.skills.browseMarket(source ?? '', refresh === true, query)
      },

      installMarketSkill(source, name) {
        return ctx.skills.installMarketSkill(source, name)
      },

      setMarketSources(sources) {
        ctx.settings.setPrefs({ marketSources: sources })
        return { ok: true, notice: `已保存 ${sources.length} 个市场源` }
      },

      // ── 设置界面 ──
      getSettingsSections() {
        return ctx.settings.sections()
      },

      getSectionValues(id) {
        return ctx.settings.values(id)
      },

      setSettingValue(id, key, value) {
        return ctx.settings.save(id, key, value)
      },

      runSettingAction(id, action) {
        return ctx.settings.action(id, action)
      },

      getModelConfig() {
        return ctx.settings.modelConfig()
      },

      async saveProvider(draft) {
        return ctx.settings.saveProvider(draft)
      },

      async discoverModels(provider) {
        return ctx.settings.discoverModels(provider)
      },

      async testConnection(provider, model) {
        return ctx.settings.testConnection(provider, model)
      },

      async removeProvider(name) {
        return ctx.settings.removeProvider(name)
      },

      async setProviderKey(name, apiKey) {
        return ctx.settings.setProviderKey(name, apiKey)
      },

      async setDefaultModel(provider, model) {
        return ctx.settings.setDefaultModel(provider, model)
      },

      async setConfigFile(path) {
        return ctx.settings.setConfigFile(path)
      },

      refreshSessions() {
        return ctx.session.refresh()
      },

      // ── 会话库（归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉） ──
      async archiveSessions(paths) {
        return ctx.session.archive(paths)
      },

      listArchivedSessions() {
        return Promise.resolve(ctx.session.archived())
      },

      usageStats() {
        return Promise.resolve(buildUsageStats())
      },

      // ── 旁问（只读一次性问答，支持流式与指定模型） ──
      async sideAsk(question, quote, requestId, provider, model) {
        sideAsks.get(requestId)?.abort()
        const controller = new AbortController()
        sideAsks.set(requestId, controller)
        // 空串 = 跟随主会话当前路由；两个都给了才切到指定模型（界面传的就是一对）。
        const route = provider !== '' && model !== '' ? ctx.llm.routeTo(provider, model, 'default') : ctx.llm.route()
        try {
          const outcome = await sideAskOnce({
            route,
            stream: (api, request, handlers) => ctx.llm.stream(api, request, handlers),
            question,
            quote,
            signal: controller.signal,
            // 增量经 cordis 事件转给界面通道（webserver 订阅后广播 `event: ask`）。
            onText: (delta) => {
              ctx.emit('dsc/side-ask-chunk', { id: requestId, delta })
            },
          })
          return outcome
        } finally {
          // 收尾信号：界面据此把「正在回答」收掉（结果本身由 invoke 的返回值补齐）。
          ctx.emit('dsc/side-ask-chunk', { id: requestId, delta: '', done: true })
          // 只清自己的那张：同一票据被后一次覆盖时，别把新的那条删了。
          if (sideAsks.get(requestId) === controller) sideAsks.delete(requestId)
        }
      },

      sideAskCancel(requestId) {
        const controller = sideAsks.get(requestId)
        if (controller === undefined) return Promise.resolve(false)
        controller.abort()
        return Promise.resolve(true)
      },

      async restoreSessions(paths) {
        return ctx.session.restore(paths)
      },

      async purgeSessions(paths) {
        return ctx.session.purge(paths)
      },

      async renameSession(path, title) {
        return ctx.session.rename(path, title)
      },

      async setSessionPinned(path, pinned) {
        return ctx.session.setPinned(path, pinned)
      },

      listUserMessages(path) {
        return Promise.resolve(ctx.session.userMessages(path))
      },

      forkSession(path, index) {
        return Promise.resolve(ctx.session.fork(path, index))
      },

      rewindSession(path, keep, text) {
        return Promise.resolve(ctx.session.rewind(path, keep, text))
      },

      getUiPrefs() {
        return ctx.settings.prefs().ui
      },

      setUiPrefs(patch) {
        const current = ctx.settings.prefs().ui
        // 字号的真源是 px；倍率是派生值。写盘前先把两者对齐，别等下一次读档——
        // 同一次会话里旧消费方（手机远程、没升级的插件）读 `getUiPrefs().fontSize`
        // 会读到旧数，表现就是「设置里显示 16px、远程那边还是 14px」。
        const next: Partial<UiPrefsView> = { ...patch }
        if (next.textSizePx !== undefined) {
          // 先归一再派生：插件可能发 30 或 16.6，落盘的 px 与派生的倍率必须同源，
          // 否则会出现「设置页显示 30px、正文按 22px 画」这种要等下次读档才对齐的偏差。
          next.textSizePx = normalizeTextSizePx(next.textSizePx)
          next.fontSize = fontScaleFromTextSizePx(next.textSizePx)
        } else if (next.fontSize !== undefined) {
          // 旧插件还在发倍率：顺手换算成 px 一起写，免得下一次读档把它的改动吃掉
          // （读档以 textSizePx 为准，只发倍率的话下一次启动就退回原值）。
          next.textSizePx = textSizePxFromLegacy(next.fontSize) ?? FONT_SIZE_PX_DEFAULT
          next.fontSize = fontScaleFromTextSizePx(next.textSizePx)
        }
        ctx.settings.setPrefs({ ui: { ...current, ...next } })
        // 分组展开态与会话拖拽顺序是点一下/拖一下就写一次的高频静默写入，
        // 弹回执反而吵：这两类补丁直接返回，不进下面的文案链。
        // 面板几何同理（拖完松手一次），而且它只可能是壳发的——用户看不见任何回执才好。
        if (patch.sessionExpansion !== undefined || patch.sessionOrder !== undefined) {
          return Promise.resolve({ ok: true })
        }
        if (patch.panelWidths !== undefined && Object.keys(patch).length === 1) {
          return Promise.resolve({ ok: true })
        }
        const notice =
          patch.sessionSort !== undefined
            ? patch.sessionSort === 'recent'
              ? '会话改为按最近更新排序（置顶的仍排最前）'
              : patch.sessionSort === 'created'
                ? '会话改为按创建时间排序（置顶的仍排最前）'
                : '会话改为手动排序：工作区按拖动顺序，没拖过就活动区置顶'
            : patch.sessionGroup !== undefined
              ? '已切换会话列表的分组方式'
              : patch.archivedFilter !== undefined
                ? '已切换已归档会话的显隐'
                : patch.workspaceOrder !== undefined
                  ? '已保存工作区顺序'
                  : patch.themeMode !== undefined ||
                      patch.fontSize !== undefined ||
                      // 字号（px 真源）与两套字体也属于外观：改完要给一句「已保存外观设置」，
                      // 否则会掉到最后的「已保存工作区名字」，用户以为改错了地方。
                      patch.textSizePx !== undefined ||
                      patch.textFontFamily !== undefined ||
                      patch.codeFontFamily !== undefined ||
                      patch.density !== undefined ||
                      patch.buttonScale !== undefined
                    ? '已保存外观设置'
                    : patch.processFold !== undefined
                      ? patch.processFold === 'compact'
                        ? '过程折叠程度改为紧凑：整轮收起、阶段分组，思考行不显示摘要，组头不报实时详情'
                        : patch.processFold === 'detailed'
                          ? '过程折叠程度改为详细：整轮照旧收起，但只有历史轮分组，正在跑的那一轮直接摊开'
                          : patch.processFold === 'verbose'
                            ? '过程折叠程度改为逐条摊开：不做整轮折叠，阶段也不分组'
                            : '过程折叠程度改为标准：整轮过程收起，摘要照显，组头带实时详情'
                      : patch.reasoningDefaultOpen !== undefined
                        ? patch.reasoningDefaultOpen
                          ? '定稿的思考行默认展开'
                          : '定稿的思考行默认收起'
                        : patch.toolDefaultOpen !== undefined
                          ? patch.toolDefaultOpen
                            ? '工具卡默认展开'
                            : '工具卡默认收起'
                          : patch.collapseTiming !== undefined
                            ? patch.collapseTiming === 'next-input'
                              ? '折叠时机改为下次发言时收起：一轮跑完先在屏幕上摊着，等你下次发言、它不再是最后一轮了才收起'
                              : '折叠时机改为立即收起：一轮跑完当场收起'
                            : patch.foldedReplies !== undefined
                              ? patch.foldedReplies === 'final'
                                ? '收起后只留最终回答：过程中的阶段性回复一并收进折叠区'
                                : '收起后保留全部回复：过程中的阶段性回复留在屏幕上'
                              : patch.turnCompleteSound !== undefined ||
                                  patch.turnCompleteSoundVariant !== undefined ||
                                  patch.turnCompleteNotify !== undefined
                                ? '已保存任务提醒设置'
                                : patch.statusBar !== undefined
                                  ? '已保存状态栏显示设置'
                                  : '已保存工作区名字'
        return Promise.resolve({ ok: true, notice })
      },

      answerApproval(answer, source) {
        ctx.approval.answer(answer, source)
      },

      exit(): void {
        ctx.emit('dsc/exit')
        process.exit(0)
      },

      async dispose() {
        ctx.emit('dsc/exit')
      },
    }

    ctx.provide('ui', runtime)
  },
}
