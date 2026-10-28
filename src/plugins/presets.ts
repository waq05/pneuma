/**
 * presets 插件：provide `presets` 服务（模式状态 + 三个登记点 + 切换命令）。
 *
 * 模式（模式文件见 `core/presets.ts`）只干三件事，都在自己文件里：
 *   1. 往系统提示里加一段这个模式的话（提示词层，order 15，排在「做事方式」之后、
 *      「工具规范」之前），并登记一个骨架取舍把该摘的叮嘱段摘掉；
 *   2. 给主会话的工具目录过一层投影（`ctx.tools.project`）——极简档因此只把 bash
 *      递给模型，而队友、界面、工具检索看到的仍是完整注册表；
 *   3. 换模式时广播 `dsc/preset-changed`，并把档位写进会话状态（恢复会话时跟着回来）。
 *
 * 三件事都只做减法：工具白名单只能从全量里取子集、drop 只能在名单里去掉提示段。
 * 权限模式（approval 插件）与协作模式（mode 插件）各自是另外两根旋钮，这里一个都不碰——
 * 审批灾难地板与守卫链不看模式，所以再野的模式也放宽不了安全。
 *
 * @module dsc/plugins/presets
 */
import { readFileSync } from 'node:fs'
import type { Plugin } from '@deepseek-ai/cordis'
import type { PresetDraft, PresetSurface, PresetView } from '../contract.js'
import type { AgentScope, PresetService } from '../services/types.js'
import type { Session } from '../core/session.js'
import {
  DROPPABLE_LABELS,
  DROPPABLE_SECTIONS,
  STANDARD_PRESET,
  ensureBuiltinPresets,
  findPreset,
  listPresets,
  parsePresetToken,
  removePreset,
  standardPreset,
  writePreset,
  type Preset,
} from '../core/presets.js'
import { audit } from '../core/audit.js'

/** 模式 → 界面投影（IPC 只带这些字段）。 */
function toView(preset: Preset): PresetView {
  return {
    name: preset.name,
    label: preset.label,
    description: preset.description,
    tools: preset.tools,
    drop: preset.drop,
    replace: preset.replace,
    prompt: preset.prompt,
    builtin: preset.builtin,
    ...(preset.problem !== undefined ? { problem: preset.problem } : {}),
  }
}

export const presetsPlugin: Plugin.Object = {
  name: 'presets',
  inject: ['session', 'commands', 'prompt', 'tools', 'settings', 'surfaces', 'approval', 'mode'],
  provide: 'presets',
  apply(ctx) {
    // 出厂四个模式：第一次用到时写出去；已存在的一律不覆盖（用户改过的永远留着）
    ensureBuiltinPresets()

    /** 名字解析：文件不在了就回落标准档（模式文件可能刚被删，偏好里还留着旧名字）。 */
    const resolve = (candidate: string): string => (findPreset(candidate) === null ? STANDARD_PRESET : candidate)
    /** 新会话默认模式（读偏好，认不出回落标准档）。 */
    const savedDefault = (): string => resolve(ctx.settings.prefs().defaultPreset)

    /**
     * **每个会话自己的模式**（key = 会话 id）。
     *
     * 为什么不是一个模块级的 `name`：宿主从 0.6.48 起同时常驻多个会话的 agent——
     * 你切走的那个会话，它那一轮还在后台跑。模式是**会话的属性**，原来却是一个全局量，
     * 而 `dsc/session-open` 一打开别的会话就把它改掉，于是后台那一轮的工具目录与系统
     * 提示跟着换：模型照上一份 schema 喊出来的工具，执行时已经不在目录里，全落进
     * 「未知工具」（2026-10-28 用户报的那一串失败就是这么来的）。
     *
     * 现在谁问就给谁算（{@link AgentScope}.sessionId），不传就按当前查看的会话——
     * 界面、`/preset` 命令、设置页这些单会话入口一个字都不用改。
     */
    const bySession = new Map<string, string>()
    /** 这次问的是哪个会话：调用方给了就用它，没给就按「当前查看的会话」。 */
    const idOf = (scope?: AgentScope): string => scope?.sessionId ?? ctx.session.current().meta.id
    /** 这个会话现在用哪一档；没登记过（理论上只有宿主刚起、会话还没打开时）按默认档。 */
    const presetIdOf = (scope?: AgentScope): string => resolve(bySession.get(idOf(scope)) ?? savedDefault())
    /** 某一档的规格；任何异常路径最后都落到 standardPreset()（它绝不返回 null）。 */
    const specOf = (scope?: AgentScope): Preset => findPreset(presetIdOf(scope)) ?? standardPreset()
    /** 打开会话时该用哪个模式：会话记过就跟着会话，没记过就用默认。 */
    const presetOfSession = (session: Session): string => {
      const stored = session.state('preset')
      return typeof stored === 'string' && stored !== '' ? resolve(stored) : savedDefault()
    }

    // 启动时把当前会话登记进来：宿主起来就有一份「这个会话用哪一档」的答案。
    bySession.set(ctx.session.current().meta.id, presetOfSession(ctx.session.current()))

    /**
     * 换档：写会话记录 + 审计 + 广播。
     * @returns 给用户看的一句话（调用方拿去当返回文案；这里同时发一条 dsc/notice，
     *          所以 `/preset` 这类不消费返回值的入口也能在会话流里看到它）。
     */
    const apply = (next: string, opts: { notice?: string } = {}): string => {
      const session = ctx.session.current()
      const changed = presetIdOf({ sessionId: session.meta.id }) !== next
      bySession.set(session.meta.id, next)
      session.appendState('preset', next)
      if (changed) {
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `模式（预设）→ ${specOf({ sessionId: session.meta.id }).label}`,
          mode: ctx.mode.mode,
          policy: ctx.approval.policy,
          sessionId: session.meta.id,
          cwd: session.meta.cwd,
        })
      }
      const notice = opts.notice ?? `模式切换为「${specOf().label}」：${specOf().description || '见设置 → 模式'}`
      ctx.emit('dsc/preset-changed', next)
      ctx.emit('dsc/notice', notice)
      ctx.emit('dsc/changed')
      return notice
    }

    const service: PresetService = {
      get name() {
        return presetIdOf()
      },
      get defaultName() {
        return savedDefault()
      },
      surface(): PresetSurface {
        return {
          current: presetIdOf(),
          defaultName: savedDefault(),
          options: listPresets().map(toView),
          droppable: DROPPABLE_SECTIONS.map((id) => ({ id, label: DROPPABLE_LABELS[id] ?? id })),
        }
      },
      use(next) {
        if (findPreset(next) === null) throw new Error(`没有名为「${next}」的模式`)
        return apply(next)
      },
      read(target) {
        const preset = findPreset(target)
        if (preset === null) throw new Error(`没有名为「${target}」的模式`)
        return readFileSync(preset.file, 'utf8')
      },
      save(draft: PresetDraft) {
        const written = writePreset(draft)
        if (written.problem !== undefined) throw new Error(written.problem)
        return draft.oldName === null ? `已创建模式「${written.label}」` : `已保存模式「${written.label}」`
      },
      remove(target) {
        const label = findPreset(target)?.label ?? target
        removePreset(target)
        // 删掉的正是当前这一档时当场回落标准档，别让会话停在一个不存在的模式上
        if (presetIdOf() === target) apply(STANDARD_PRESET, { notice: `模式「${label}」已删除，当前回落到「${specOf().label}」` })
        else ctx.emit('dsc/notice', `已删除模式「${label}」`)
        return `已删除模式「${label}」`
      },
      setDefault(target) {
        if (findPreset(target) === null) throw new Error(`没有名为「${target}」的模式`)
        ctx.settings.setPrefs({ defaultPreset: target })
        return `新会话默认模式已设为「${findPreset(target)?.label ?? target}」（当前会话不受影响）`
      },
    }
    ctx.provide('presets', service)

    // 1. 模式自己那段话：排在做事方式（10）之后、工具规范（20）之前。
    // 空正文（标准档）会被 composePrompt 滤掉，所以默认档的系统提示逐字节不变。
    ctx.prompt.register('preset:persona', (scope) => specOf(scope).prompt, { order: 15 })

    // 2. 骨架取舍：drop 里那几段整段不进提示词。
    // 只碰提示词文本——审批硬地板、命令策略、路径策略都在代码里，少几段叮嘱不等于放宽安全。
    ctx.prompt.registerSkeletonFilter('preset', (ids, scope) => {
      // 替换式模式（极简档）：只留模式自己的正文与 AGENTS.md 注入。插件贡献段
      // （沙箱说明、协作模式条款、技能目录…）全部不进——参考实现的 minimal 就是这样，
      // 它的 persona 是 complete + 不给运行时上下文。
      const preset = specOf(scope)
      if (preset.replace) return ids.filter((id) => id === 'preset:persona' || id === 'instructions')
      const drop = preset.drop
      return drop.length === 0 ? ids : ids.filter((id) => !drop.includes(id))
    })

    // 3. 工具目录投影：白名单取交集；带 presets 标签的工具只在它列出的模式里露面。
    // 直接写进白名单的工具名也算「露面」（用户的显式意图优先于标签）。
    ctx.tools.project('preset', (tools, scope) => {
      const allowed = specOf(scope).tools
      // 标签比对认**这个会话**的档，不是「你此刻在看的那一档」
      const tag = presetIdOf(scope)
      return tools.filter((entry) => {
        const explicit = allowed !== null && allowed.includes(entry.name)
        if (entry.presets !== undefined && !entry.presets.includes(tag) && !explicit) return false
        return allowed === null || explicit
      })
    })

    ctx.surfaces.register('preset', () => service.surface())

    // 恢复历史会话：模式跟着回来（不重复写记录，也不重复播报切换）。
    // 只登记**这一个**会话（打开它才会走到这里），别的会话各记各的——后台跑着的那一轮
    // 因此不会被「你点开了另一个会话」改掉工具目录与提示词。
    ctx.on('dsc/session-open', ({ session }) => {
      bySession.set(session.meta.id, presetOfSession(session))
      ctx.emit('dsc/preset-changed', presetIdOf({ sessionId: session.meta.id }))
      ctx.emit('dsc/changed')
    })
    // 挂载完就播一次：比本插件先挂载的监听者因此不会停在「没听过模式」的状态上。
    ctx.emit('dsc/preset-changed', presetIdOf())

    /** `/preset <名字>`：支持中文别名（标准 / 极简 / 创造 / 代码）。 */
    ctx.commands.register(
      {
        name: 'preset',
        args: '<名字>',
        description: '切换模式（模式 = 人格 + 工具集 + 提示词；写进会话记录，恢复会话时一起恢复）',
      },
      ({ args, ui }) => {
        const token = args.join(' ').trim()
        if (token === '') {
          // 有选择器的端（TUI）开浮层；没接的端保持 notice 清单（桌面有自己的模式页）。
          if (ui.openPresets !== undefined) {
            ui.openPresets()
            return
          }
          ui.notice(`当前模式：${specOf().label}。可选：${listPresets().map((item) => `${item.label}（/preset ${item.name}）`).join('、')}`)
          return
        }
        const target = parsePresetToken(token)
        if (target === null) {
          ui.notice(`认不出模式「${token}」。可选：${listPresets().map((item) => `${item.label}（${item.name}）`).join('、')}`)
          return
        }
        service.use(target)
      },
    )
  },
}
