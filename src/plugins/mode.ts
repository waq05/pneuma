/**
 * mode 插件：provide `mode` 服务（协作模式状态 + 守卫链上那道闸门 + 切换命令）。
 *
 * 模式这件事只干三件事，都在自己文件里：
 *   1. 往系统提示里换一段模式条款（提示词层，靠模型自觉）——登记进 prompt 服务的 order 30；
 *   2. 在工具执行前设一道闸门（这一层不依赖模型听话，判法在 `core/modes.ts`）
 *      ——注册成守卫链上 order 10 的那一位，排在审批（order 30）之前；
 *   3. 换档时广播 `dsc/mode-changed`，让想知道档位的别处（审批卡的说明文字）自己听。
 * 禁不禁写另有一根旋钮：权限模式（approval 插件）。两根旋钮互不越界，
 * 这个分工照 DSH（`packages/plan/plan-mode/src/index.ts:4-7`）与 Codex
 * （`protocol/src/config_types.rs:674` 的模式与 `SandboxMode` 互不引用）。
 *
 * 模式变更写进会话状态条目，恢复历史会话时模式跟着回来。
 *
 * @module dsc/plugins/mode
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { CollaborationMode, ModeSurface } from '../contract.js'
import type { ModeService } from '../services/types.js'
import { MODES, MODE_IDS, modeSpec, parseModeToken } from '../core/modes.js'
import { activeRules } from '../core/command-policy.js'
import { audit } from '../core/audit.js'
import type { ToolGuard } from '../core/tool-guards.js'
import type { Session } from '../core/session.js'

/** 命令名到模式的快查（`/plan`、`/explore`、`/quiet` 直接切档）。 */
const COMMAND_MODES: Record<string, CollaborationMode> = {
  plan: 'plan',
  explore: 'explore',
  quiet: 'quiet',
  build: 'build',
}

export const modePlugin: Plugin.Object = {
  name: 'mode',
  inject: ['session', 'commands', 'approval', 'guards', 'prompt', 'surfaces'],
  provide: 'mode',
  apply(ctx) {
    /**
     * 协作模式**按会话**读（2026-10-28）：值只在会话 `mode` 状态条目里，没有进程级变量。
     * 后台会话的守卫按它自己的记录判，不会因为你切到执行模式就放行。
     */
    const modeOf = (session: Session): CollaborationMode => session.state('mode') ?? 'build'
    /** 按会话 id 找模式（找不通常驻实例就按当前查看的会话）。 */
    const modeFor = (sessionId?: string): CollaborationMode => {
      const found = sessionId === undefined || sessionId === '' ? undefined : ctx.get('agent')?.sessionById(sessionId)
      return modeOf(found ?? ctx.session.current())
    }

    const apply = (next: CollaborationMode, opts: { record?: boolean; notice?: string } = {}): void => {
      const changed = modeFor() !== next
      if (opts.record !== false) ctx.session.current().appendState('mode', next)
      if (changed) {
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `协作模式 → ${MODES[next].label}`,
          mode: next,
          policy: ctx.approval.policy,
          sessionId: ctx.session.current().meta.id,
          cwd: ctx.session.current().meta.cwd,
        })
      }
      ctx.emit('dsc/notice', opts.notice ?? `协作模式切换为「${MODES[next].label}」：${MODES[next].hint}`)
      ctx.emit('dsc/mode-changed', next)
      ctx.emit('dsc/changed')
    }

    const service: ModeService = {
      get mode() {
        return modeOf(ctx.session.current())
      },
      modeFor,
      setMode(next) {
        apply(next)
      },
      surface(): ModeSurface {
        return {
          current: modeOf(ctx.session.current()),
          options: MODE_IDS.map((id) => ({ id, label: MODES[id].label, hint: MODES[id].hint })),
        }
      },
    }
    ctx.provide('mode', service)

    // 这一档的条款挂在**请求末尾的环境快照**里，不进系统提示词（2026-10-30）。
    // 原来它是一段 order 30 的系统提示段，换一次模式系统提示词就从头不同，服务端前缀
    // 缓存整段失效——一次 /plan 就能把几十 K 的命中打成未命中。挪到快照之后：
    // 前缀原样复用，模型每轮照样读到当前模式的规则（plan 的禁令一个字都不少）。
    ctx.prompt.registerEnvFacts('mode', (session) => modeSpec(modeFor(session?.meta.id)).prompt)

    // 闸门：执行档一律交给后面的权限模式与审批卡；其余三档照 core/modes.ts 的判法说话。
    const modeGuard: ToolGuard = {
      id: 'mode',
      order: 10,
      decide(input) {
        // 这次调用属于哪个会话就用那个会话的模式：后台会话在计划模式跑，你切到执行模式看它，
        // 也不该把它的写操作放行。
        const session =
          input.sessionId === undefined || input.sessionId === ''
            ? ctx.get('agent')?.sessionFor(input.sessionPath)
            : ctx.get('agent')?.sessionById(input.sessionId)
        const mode = modeOf(session ?? ctx.session.current())
        const gate = modeSpec(mode).gate({
          toolName: input.toolName,
          risk: input.risk,
          target: input.target,
          command: input.command,
          cwd: input.cwd,
          rules: activeRules(),
        })
        if (gate.action === 'deny') {
          // 这句话原样回给模型：它得知道自己是被哪一档拦下、为什么。
          return { action: 'deny', reason: `这次调用被模式拦下：${gate.reason}` }
        }
        return gate.action === 'pass' ? { action: 'pass' } : { action: 'defer' }
      },
    }
    ctx.guards.register(modeGuard)
    ctx.surfaces.register('mode', () => service.surface())

    // 恢复历史会话：模式跟着回来（不重复写记录，也不重复播报切换）。
    ctx.on('dsc/session-open', ({ session }) => {
      ctx.emit('dsc/mode-changed', modeOf(session))
      ctx.emit('dsc/changed')
    })
    // 挂载完就播一次当前档位：比本插件先挂载的监听者（审批插件）因此不会停在默认档位上。
    ctx.emit('dsc/mode-changed', modeOf(ctx.session.current()))

    /** `/mode <档位>`：支持中文别名（计划 / 探索 / 免打扰 / 执行）。 */
    ctx.commands.register(
      { name: 'mode', args: '<执行|计划|探索|免打扰>', description: '切换协作模式（写进会话记录，恢复会话时一起恢复）' },
      ({ args, ui }) => {
        const token = args[0] ?? ''
        const next = parseModeToken(token)
        if (next === null) {
          ui.notice(`模式可选：${MODE_IDS.map((id) => `${id}（${MODES[id].label}）`).join('、')}`)
          return
        }
        apply(next)
      },
    )

    // `/plan`、`/explore`、`/quiet`、`/build`：切档 + 把带进来的那句话照常发出去。
    for (const [name, target] of Object.entries(COMMAND_MODES)) {
      if (name === 'mode') continue
      ctx.commands.register(
        {
          name,
          args: '[要处理的事]',
          description:
            target === 'plan'
              ? '进入计划模式：只读地把方案写成计划文件等用户批'
              : target === 'explore'
                ? '进入探索模式：只读地回答代码问题'
                : target === 'quiet'
                  ? '进入免打扰模式：不弹审批卡，工作区内自动放行'
                  : '回到执行模式',
        },
        ({ args, runtime }) => {
          apply(target)
          const rest = args.join(' ').trim()
          // 带着话进来的时候顺手把它发出去：`/plan 给审批层加四档授权` 一句话就开工。
          if (rest !== '') runtime.submit(rest)
        },
      )
    }
  },
}
