/**
 * approval-floor 插件：把审批灾难地板挂到守卫链的 order 5 上（官方可开关插件）。
 *
 * 判定逻辑全在 `approval-floor.ts`，这个文件只做四件装配的事：
 *   1. 把守卫注册进守卫链；
 *   2. 把白名单的结论以 `approvalFloor` 服务交出去，由审批层免卡放行（地板自己不 return pass，
 *      否则排在 order 20 / 25 的安全钩子会被一起跳掉）；
 *   3. 每次判定现读配置（`resolvePluginConfig('approval-floor', passed)` + 磁盘），
 *      设置页改完立刻生效；
 *   4. 注册 `/floor` 命令与设置分区，把当前规则与熔断状态摆给用户看。
 *
 * 这个插件不认识协作模式：模式闸门（order 10）排在地板后面，它会自己拦该拦的档位，
 * 地板只要保证「不拒的时候不越权替别人放行」就够了。
 *
 * @module dsc/plugins/approval-floor
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import {
  createApprovalFloor,
  FLOOR_CONFIG_KEY,
  FLOOR_LIMITS,
  parseGlobListText,
  parsePrefixListText,
  resolveFloorConfig,
  type FloorConfig,
} from './approval-floor.js'
import { activeRules } from '@pneuma/runtime/core/command-policy.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import type { SettingsField, SettingsValue, SettingsValues } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'
import { readShellChoice, shellFlavor } from '@pneuma/runtime/core/terminal-env.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 配置与设置提示里要写清的来源文件（手改它同样生效）。 */
const PLUGINS_FILE = dscPath('plugins.json')

/** 前缀清单的多行文本形式（设置页那个框读写的就是它）。 */
function prefixText(config: FloorConfig): string {
  return config.allowPrefixes.map((pattern) => pattern.join(' ')).join('\n')
}

/** 一份数值字段的区间校验，失败返回给用户看的原因。 */
function checkInt(value: SettingsValue, limits: { min: number; max: number }, label: string): string | null {
  const num = Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num)) return t('save.notInteger', { label })
  if (num < limits.min || num > limits.max) return t('save.outOfRange', { label, min: limits.min, max: limits.max })
  return null
}

export const approvalFloorPlugin: Plugin.Object = {
  name: 'approval-floor',
  inject: ['guards', 'commands', 'settings'],
  apply(ctx, passed) {
    const readConfig = () => resolveFloorConfig(resolvePluginConfig(FLOOR_CONFIG_KEY, passed))
    const floor = createApprovalFloor({
      readConfig,
      rules: () => activeRules(),
      // 结构扫描按**实际执行命令的终端**判（2026-10-30 默认终端可切换）：
      // 选了 Git Bash / WSL 就按 POSIX 规则看引号与转义，不能继续套 PowerShell 那套。
      shell: () => shellFlavor(readShellChoice()),
    })
    const offGuard = ctx.guards.register(floor.guard)
    ctx.effect(() => offGuard, 'approval-floor: guards.register')

    // 白名单的结论交给审批层执行：地板不自己 pass，因此排在中间的钩子照常被问到。
    const offService = ctx.provide('approvalFloor', {
      whitelist: (command: string) => floor.whitelist(command),
      count: () => readConfig().config.allowPrefixes.length,
    })

    // 换会话把熔断清掉：上一个会话连着撞的坑不该让新会话一开局就被熔断拦住。
    ctx.on('dsc/session-open', () => floor.reset())

    /** `/floor` 与设置分区共用的那段说明。 */
    const describe = (): string => {
      const { config, problems } = readConfig()
      const breaker = floor.breaker()
      const lines: string[] = []
      lines.push('危险命令硬拦截：守卫链 order 5（先于模式 10、安全钩子 20、审批 30）')
      lines.push(`白名单（命中由审批层免卡放行，共 ${config.allowPrefixes.length} 条）：`)
      for (const pattern of config.allowPrefixes) lines.push(`  ${pattern.join(' ')}`)
      lines.push(`deny 黑名单（命中即拒，共 ${config.denyGlobs.length} 条）：`)
      for (const glob of config.denyGlobs) lines.push(`  ${glob}`)
      lines.push(`命令长度上限：${config.maxCommandLength} 字符｜无人值守：${config.unattended ? '开（ask 级命令与工作区外的写一律拒）' : '关'}`)
      lines.push(
        config.circuitBreakerEnabled
          ? `熔断：开｜连续被拒 ${config.circuitBreakerThreshold} 次后冷却 ${Math.round(config.circuitBreakerCooldownMs / 1000)} 秒｜当前连续 ${breaker.consecutiveDenies} 次${breaker.tripped ? '，正在熔断中' : ''}`
          : '熔断：关',
      )
      lines.push(`配置文件：${PLUGINS_FILE} 的 ${FLOOR_CONFIG_KEY} 条目（设置页也能改）`)
      if (problems.length > 0) {
        lines.push('⚠ 配置有问题，现在一律拒：')
        for (const problem of problems) lines.push(`  ${problem}`)
      }
      return lines.join('\n')
    }

    const offCommand = ctx.commands.register(
      { name: 'floor', args: '', description: '看危险命令硬拦截的规则、白名单与熔断状态' },
      ({ ui }) => {
        ui.notice(describe())
      },
    )
    ctx.effect(() => offCommand, 'approval-floor: commands.register')

    // ── 设置分区 ──────────────────────────────────────────────────────────────

    const section: SettingsSectionSpec = {
      id: FLOOR_CONFIG_KEY,
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 33,
      fields(): SettingsField[] {
        const { config, problems } = readConfig()
        const list: SettingsField[] = [
          {
            type: 'info',
            label: t('field.chain.label'),
            text: t('field.chain.text'),
          },
          {
            type: 'info',
            label: t('field.order.label'),
            text: t('field.order.text'),
          },
          {
            type: 'text',
            key: 'allowPrefixes',
            label: t('field.allowPrefixes.label'),
            placeholder: 'pnpm run build',
            mono: true,
            help: t('field.allowPrefixes.help'),
          },
          {
            type: 'text',
            key: 'denyGlobs',
            label: t('field.denyGlobs.label'),
            placeholder: '*etc/passwd*',
            mono: true,
            help: t('field.denyGlobs.help'),
          },
          {
            type: 'number',
            key: 'maxCommandLength',
            label: t('field.maxCommandLength.label'),
            min: FLOOR_LIMITS.maxCommandLength.min,
            max: FLOOR_LIMITS.maxCommandLength.max,
            step: 500,
            help: t('field.maxCommandLength.help', { min: FLOOR_LIMITS.maxCommandLength.min, max: FLOOR_LIMITS.maxCommandLength.max }),
          },
          {
            type: 'switch',
            key: 'unattended',
            label: t('field.unattended.label'),
            help: t('field.unattended.help'),
          },
          { type: 'switch', key: 'circuitBreakerEnabled', label: t('field.circuitBreakerEnabled.label') },
          {
            type: 'number',
            key: 'circuitBreakerThreshold',
            label: t('field.circuitBreakerThreshold.label'),
            min: FLOOR_LIMITS.circuitBreakerThreshold.min,
            max: FLOOR_LIMITS.circuitBreakerThreshold.max,
            step: 1,
            help: t('field.circuitBreakerThreshold.help'),
          },
          {
            type: 'number',
            key: 'circuitBreakerCooldownMs',
            label: t('field.circuitBreakerCooldownMs.label'),
            min: FLOOR_LIMITS.circuitBreakerCooldownMs.min,
            max: FLOOR_LIMITS.circuitBreakerCooldownMs.max,
            step: 1000,
            help: t('field.circuitBreakerCooldownMs.help'),
          },
          { type: 'info', label: t('field.allowCount.label'), text: String(config.allowPrefixes.length) },
          { type: 'info', label: t('field.denyCount.label'), text: String(config.denyGlobs.length) },
        ]
        if (problems.length > 0) {
          list.push({
            type: 'info',
            label: t('field.problems.label'),
            text: problems.join('；'),
            help: t('field.problems.help'),
          })
        }
        return list
      },
      values(): SettingsValues {
        const { config } = readConfig()
        return {
          allowPrefixes: prefixText(config),
          denyGlobs: config.denyGlobs.join('\n'),
          maxCommandLength: config.maxCommandLength,
          unattended: config.unattended,
          circuitBreakerEnabled: config.circuitBreakerEnabled,
          circuitBreakerThreshold: config.circuitBreakerThreshold,
          circuitBreakerCooldownMs: config.circuitBreakerCooldownMs,
        }
      },
      save(key, value): string | void {
        switch (key) {
          case 'allowPrefixes': {
            const parsed = parsePrefixListText(typeof value === 'string' ? value : String(value))
            if (!parsed.ok) return parsed.error
            writePluginConfig(FLOOR_CONFIG_KEY, { allowPrefixes: parsed.values })
            break
          }
          case 'denyGlobs': {
            const parsed = parseGlobListText(typeof value === 'string' ? value : String(value))
            if (!parsed.ok) return parsed.error
            writePluginConfig(FLOOR_CONFIG_KEY, { denyGlobs: parsed.values })
            break
          }
          case 'maxCommandLength': {
            const problem = checkInt(value, FLOOR_LIMITS.maxCommandLength, t('field.maxCommandLength.label'))
            if (problem !== null) return problem
            writePluginConfig(FLOOR_CONFIG_KEY, { maxCommandLength: Number(value) })
            break
          }
          case 'circuitBreakerThreshold': {
            const problem = checkInt(value, FLOOR_LIMITS.circuitBreakerThreshold, t('field.circuitBreakerThreshold.label'))
            if (problem !== null) return problem
            writePluginConfig(FLOOR_CONFIG_KEY, { circuitBreakerThreshold: Number(value) })
            break
          }
          case 'circuitBreakerCooldownMs': {
            const problem = checkInt(value, FLOOR_LIMITS.circuitBreakerCooldownMs, t('field.circuitBreakerCooldownMs.label'))
            if (problem !== null) return problem
            writePluginConfig(FLOOR_CONFIG_KEY, { circuitBreakerCooldownMs: Number(value) })
            break
          }
          case 'unattended':
            writePluginConfig(FLOOR_CONFIG_KEY, { unattended: value === true })
            break
          case 'circuitBreakerEnabled':
            writePluginConfig(FLOOR_CONFIG_KEY, { circuitBreakerEnabled: value === true })
            break
          default:
            return t('save.unknownKey', { key })
        }
        // 值改完可能把熔断打开或关掉，顺手清一次计数，让新配置从干净状态开始。
        floor.reset()
        ctx.emit('dsc/changed')
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'approval-floor: settings.registerSection')

    // 配置坏掉时说一次：地板会一律拒，用户得知道去改哪儿。
    const problems = readConfig().problems
    if (problems.length > 0) {
      ctx.emit('dsc/notice', `危险命令硬拦截配置有问题，现在一律拒：${problems.join('；')}（改 ${FLOOR_CONFIG_KEY} 的配置后立刻恢复）`)
    }

    // 注册一律返回清理函数，这里把四份合成一份。
    return () => {
      offSection()
      offCommand()
      offService()
      offGuard()
    }
  },
}
