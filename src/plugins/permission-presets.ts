/**
 * permission-presets 插件：provide `permissionPresets` 服务——
 * 把沙箱档位、权限模式、审阅者三根旋钮捆成一颗按钮（表在 `core/permission-presets.ts`）。
 *
 * 为什么单开一个插件而不是塞进 approval：这一层要同时写**两个**插件的地盘
 * （`sandbox.setMode` 与 `approval.setPolicy/setReviewer`），塞进任一边都是反向依赖。
 * 它自己不认识任何执行策略——只查表、只调这两个 setter，所以「预设放宽不了安全」
 * 是结构上成立的，不是靠自觉。
 *
 * 三个登记点：
 *   1. `surfaces.permissionPresets`：输入框那颗权限旋钮与设置页读它（含 `custom` 状态）；
 *   2. 预设的切换只写**当前会话**（2026-10-28 起按会话隔离，见 core/permission-scope）；
 *      新会话的默认值仍由偏好里的 `defaultPermissionPreset` 决定；
 *   3. `dsc/permission-preset-changed` 广播，界面据此重画。
 *
 * @module dsc/plugins/permission-presets
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { PermissionPresetSurface, PermissionPresetView } from '../contract.js'
import type { PermissionPresetService } from '../services/types.js'
import {
  BUILTIN_PERMISSION_PRESETS,
  CUSTOM_PERMISSION_PRESET,
  DEFAULT_PERMISSION_PRESET,
  findPermissionPreset,
  matchPermissionPreset,
  type PermissionPreset,
} from '../core/permission-presets.js'
import { permissionOf, samePermissionKnobs, type PermissionKnobs } from '../core/permission-scope.js'
import type { Session } from '../core/session.js'
import { audit } from '../core/audit.js'

/** 沙箱服务缺席时（插件被停用）读作哪一档：与沙箱插件自己的出厂默认一致。 */
const SANDBOX_FALLBACK = 'workspace-write' as const

/** 预设 → 界面投影（只带界面要画的字段）。 */
function toView(preset: PermissionPreset): PermissionPresetView {
  return {
    name: preset.name,
    label: preset.label,
    description: preset.description,
    sandbox: preset.sandbox,
    policy: preset.policy,
    reviewer: preset.reviewer,
    builtin: preset.builtin,
  }
}

export const permissionPresetsPlugin: Plugin.Object = {
  name: 'permission-presets',
  inject: ['approval', 'settings', 'surfaces', 'mode', 'session', 'transcript'],
  provide: 'permissionPresets',
  apply(ctx) {
    /** 默认权限模式 / 审阅者（偏好没写就按出厂值）。 */
    const defaultPolicy = () => ctx.settings.prefs().defaultPolicy ?? 'auto-edit'
    const defaultReviewer = () => ctx.settings.prefs().defaultReviewer ?? 'user'
    /** 沙箱默认档：沙箱服务在就是它当前那一档，不在就按出厂兜底。 */
    const defaultSandbox = () => ctx.get('sandbox')?.mode ?? SANDBOX_FALLBACK

    /** 三项全用「会话优先、缺项补默认」解析（缺项会顺手钉进会话）。 */
    const knobsOf = (session: Session): PermissionKnobs => ({
      sandbox: permissionOf(session, 'sandbox', defaultSandbox()),
      policy: permissionOf(session, 'policy', defaultPolicy()),
      reviewer: permissionOf(session, 'reviewer', defaultReviewer()),
    })

    /** 某个会话现在匹配到的预设名；拼不出预设就是 custom。 */
    const nameOf = (session: Session): string => {
      const knobs = knobsOf(session)
      return matchPermissionPreset(knobs.sandbox, knobs.policy, knobs.reviewer)
    }

    /** 新会话默认的预设名；偏好里没写就按默认三项推一个出来。 */
    const defaultName = (): string => {
      const saved = ctx.settings.prefs().defaultPermissionPreset
      if (saved !== '') return findPermissionPreset(saved) === null ? DEFAULT_PERMISSION_PRESET : saved
      return matchPermissionPreset(defaultSandbox(), defaultPolicy(), defaultReviewer())
    }

    /**
     * 应用一个预设：只写**实际不同**的那几根旋钮（一次选了等价预设不该产生任何写动作）。
     * 写口仍然只经过两个插件的 setter——预设放宽不了安全，是结构上成立的。
     * @param preset - 要应用的预设
     * @param quiet - 不往对话里写那一句（启动复算用：用户没动手，就不该看到「切到…」）
     * @returns 给用户看的一句话。
     */
    const apply = (preset: PermissionPreset, quiet = false): string => {
      const session = ctx.session.current()
      const sandbox = ctx.get('sandbox')
      const before = knobsOf(session)
      let wrote = ''
      // 沙箱插件被停用时要明说：预设里那一半「关住写盘」的能力这次落不了地，
      // 用户不该以为自己已经被围起来（权限模式那一半照旧生效）。
      let unapplied = ''
      if (sandbox === undefined) {
        if (preset.sandbox !== 'danger-full-access') unapplied = `沙箱插件没开，${preset.sandbox} 这一半没落地`
      } else if (before.sandbox !== preset.sandbox) {
        sandbox.setMode(preset.sandbox)
        wrote += `${wrote === '' ? '' : '、'}沙箱→${preset.sandbox}`
      }
      if (before.policy !== preset.policy) {
        ctx.approval.setPolicy(preset.policy)
        wrote += `${wrote === '' ? '' : '、'}权限→${preset.policy}`
      }
      if (before.reviewer !== preset.reviewer) {
        ctx.approval.setReviewer(preset.reviewer)
        wrote += `${wrote === '' ? '' : '、'}审阅→${preset.reviewer}`
      }
      // 参考实现的同一条规则：取值没变也要留一条选择记录——「用户想要的是哪个预设」
      // 是意图，光看旋钮值区分不出来（两个预设可能共享一部分取值）。
      audit({
        ts: Date.now(),
        kind: 'mode-change',
        reason: `权限预设 → ${preset.label}（${preset.name}）`,
        mode: ctx.mode.mode,
        policy: before.policy,
        sessionId: session.meta.id,
        cwd: session.meta.cwd,
      })
      const notice =
        wrote === ''
          ? `权限预设已是「${preset.label}」，三项取值没变${unapplied === '' ? '' : `（${unapplied}）`}`
          : `权限预设切到「${preset.label}」（${wrote}）${unapplied === '' ? '' : `；${unapplied}`}`
      if (!quiet) ctx.emit('dsc/notice', notice)
      // 只广播 dsc/changed：界面读的是快照里的 surfaces（不是推事件），
      // 多一个专用事件只会多一处要登记、要对齐的地方，收益为零。
      ctx.emit('dsc/changed')
      return notice
    }

    const service: PermissionPresetService = {
      get name() {
        return nameOf(ctx.session.current())
      },
      get defaultName() {
        return defaultName()
      },
      surface(): PermissionPresetSurface {
        return {
          current: nameOf(ctx.session.current()),
          defaultName: defaultName(),
          options: BUILTIN_PERMISSION_PRESETS.map(toView),
        }
      },
      use(next) {
        const preset = findPermissionPreset(next)
        if (preset === null) {
          const hint =
            next === CUSTOM_PERMISSION_PRESET
              ? `「${CUSTOM_PERMISSION_PRESET}」是拼出来的状态，不是可选预设：想离开它就直接选一个真预设`
              : `没有名为「${next}」的权限预设`
          throw new Error(hint)
        }
        return apply(preset)
      },
      setDefault(next) {
        if (next === '') {
          ctx.settings.setPrefs({ defaultPermissionPreset: '' })
          return '已清掉默认权限预设：新会话按沙箱与权限模式各自的默认走'
        }
        const preset = findPermissionPreset(next)
        if (preset === null) throw new Error(`没有名为「${next}」的权限预设`)
        // 默认值要三根一起落，新会话才会拿到完整的一档（只改预设名的话，
        // 沙箱与偏好仍是旧值，界面读出来会是 custom）。
        ctx.settings.setPrefs({
          defaultPermissionPreset: next,
          defaultPolicy: preset.policy,
          defaultReviewer: preset.reviewer,
        })
        ctx.get('sandbox')?.setDefaultMode(preset.sandbox)
        return `新会话默认权限预设已设为「${preset.label}」（当前会话不受影响）`
      },
    }
    ctx.provide('permissionPresets', service)

    ctx.surfaces.register('permissionPresets', () => service.surface())

    // 启动时只把当前会话缺失的权限项钉住（不应用默认预设、不写对话）：
    // 老会话第一次打开时用当时生效的值，新会话按偏好默认值；钉住之后改偏好不影响它。
    // 沙箱那一项不在这里钉——沙箱插件可能还没挂，由它自己第一次读取时钉。
    const current = ctx.session.current()
    permissionOf(current, 'policy', defaultPolicy())
    permissionOf(current, 'reviewer', defaultReviewer())
    // 换会话同样补钉一次：会话日志里已经有值的不会被覆盖。
    ctx.on('dsc/session-open', ({ session }) => {
      permissionOf(session, 'policy', defaultPolicy())
      permissionOf(session, 'reviewer', defaultReviewer())
    })
  },
}
