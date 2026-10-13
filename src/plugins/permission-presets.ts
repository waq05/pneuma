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
 *   2. 启动时应用偏好里的默认预设（在新会话上生效，之后改预设不动已有会话）；
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
    /** 当前沙箱档位；沙箱插件没挂时读作默认档（它会把 preset 之外的写口也一起停掉）。 */
    const sandboxOf = (): string => ctx.get('sandbox')?.mode ?? SANDBOX_FALLBACK

    /** 现在生效的预设名（三项全等匹配；拼不出预设就是 custom）。 */
    const currentName = (): string =>
      matchPermissionPreset(sandboxOf() as never, ctx.approval.policy, ctx.approval.reviewer)

    /** 新会话默认的预设名；偏好里没写就按内核默认三项推一个出来。 */
    const defaultName = (): string => {
      const saved = ctx.settings.prefs().defaultPermissionPreset
      if (saved !== '') return findPermissionPreset(saved) === null ? DEFAULT_PERMISSION_PRESET : saved
      return matchPermissionPreset(SANDBOX_FALLBACK, 'auto-edit', 'user')
    }

    /**
     * 应用一个预设：只写**实际不同**的那几根旋钮（一次选了等价预设不该产生任何写动作）。
     * @returns 给用户看的一句话。
     */
    const apply = (preset: PermissionPreset): string => {
      const sandbox = ctx.get('sandbox')
      let wrote = ''
      // 沙箱插件被停用时要明说：预设里那一半「关住写盘」的能力这次落不了地，
      // 用户不该以为自己已经被围起来了（权限模式那一半照旧生效）。
      let unapplied = ''
      if (sandbox === undefined) {
        if (preset.sandbox !== 'danger-full-access') unapplied = `沙箱插件没开，${preset.sandbox} 这一半没落地`
      } else if (sandbox.mode !== preset.sandbox) {
        sandbox.setMode(preset.sandbox)
        wrote += `${wrote === '' ? '' : '、'}沙箱→${preset.sandbox}`
      }
      if (ctx.approval.policy !== preset.policy) {
        ctx.approval.setPolicy(preset.policy)
        wrote += `${wrote === '' ? '' : '、'}权限→${preset.policy}`
      }
      if (ctx.approval.reviewer !== preset.reviewer) {
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
        policy: ctx.approval.policy,
        sessionId: ctx.session.current().meta.id,
        cwd: ctx.session.current().meta.cwd,
      })
      const notice =
        wrote === ''
          ? `权限预设已是「${preset.label}」，三项取值没变${unapplied === '' ? '' : `（${unapplied}）`}`
          : `权限预设切到「${preset.label}」（${wrote}）${unapplied === '' ? '' : `；${unapplied}`}`
      ctx.emit('dsc/notice', notice)
      // 只广播 dsc/changed：界面读的是快照里的 surfaces（不是推事件），
      // 多一个专用事件只会多一处要登记、要对齐的地方，收益为零。
      ctx.emit('dsc/changed')
      return notice
    }

    const service: PermissionPresetService = {
      get name() {
        return currentName()
      },
      get defaultName() {
        return defaultName()
      },
      surface(): PermissionPresetSurface {
        return {
          current: currentName(),
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
        ctx.settings.setPrefs({ defaultPermissionPreset: next })
        return `新会话默认权限预设已设为「${preset.label}」（当前会话不受影响）`
      },
    }
    ctx.provide('permissionPresets', service)

    ctx.surfaces.register('permissionPresets', () => service.surface())

    // 启动时应用默认预设：注入了 settings，所以排在它后面挂载，
    // 会盖过 settings 插件那两步按单旋钮应用的默认值（预设是「一次定三个」，优先级更高）。
    const saved = ctx.settings.prefs().defaultPermissionPreset
    if (saved !== '') {
      const preset = findPermissionPreset(saved)
      if (preset === null) {
        ctx.transcript.system(`偏好里的默认权限预设「${saved}」认不出来，已按「工作区可写」走`)
      } else {
        try {
          apply(preset)
        } catch (error) {
          ctx.transcript.system(`默认权限预设没生效：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  },
}
