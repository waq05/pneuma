/**
 * doctor 插件：一条 `/doctor` 命令跑九项检查，可出人读版或 `--json`。
 *
 * **为什么它是插件而不是内核命令**：体检要问的九件事里，五件是别的插件才有的
 * （沙箱档位、插件清单、端点配置……）。放内核里就得在内核中硬编这些插件的名字；
 * 做成插件之后，它只认识 `ctx.health.register` 这一条契约，谁想加一项自己登记。
 *
 * **为什么检查项要能注册**：以后 `browser` 登记「Chromium 起不起得来」、`lsp` 登记
 * 「语言服务器拉不拉得起来」，都不用改这个文件一行。
 *
 * @module pneuma/doctor
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type {
  HealthCheck,
  HealthReport,
  HealthResult,
  HealthService,
  HealthStatus,
  LogService,
  SandboxService,
  SettingsService,
} from '@pneuma/runtime/services/types.js'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'
import { authCheck, configCheck, installCheck, terminalCheck } from './checks/environment.js'
import { diskCheck, recentSessionFiles, sessionCheck } from './checks/data.js'
import { pluginsCheck, reachabilityCheck, sandboxCheck } from './checks/ecosystem.js'
import { appVersion, redactHome } from './checks/util.js'
import { writeBundle, readSessionExcerpt } from './bundle.js'

/** 每种结论的标记。`skip` 用中点，表示「这一项没查」，与「查过没问题」区分开。 */
const MARKS: Record<HealthStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' }

/** 没有声明 order 的检查排最后。 */
const DEFAULT_ORDER = 999

/** 汇总一行：只数有问题的，全绿时单独说一句。 */
function summarize(report: HealthReport): string {
  const parts: string[] = []
  if (report.fail > 0) parts.push(`${report.fail} 项失败`)
  if (report.warn > 0) parts.push(`${report.warn} 项警告`)
  if (parts.length === 0) return report.skip === report.entries.length ? '全部跳过' : '全部正常'
  return parts.join('，')
}

/** 人读版：标题一行、每项一行，失败项把「修复」缩进挂在下面。 */
export function renderText(report: HealthReport): string {
  const version = appVersion() ?? '未知版本'
  const header = `Pneuma Doctor ${version} · ${process.platform} ${process.arch} · node ${process.version}`
  const width = report.entries.reduce((max, entry) => Math.max(max, entry.title.length), 0)
  const lines = [header, '']
  for (const entry of report.entries) {
    lines.push(`${MARKS[entry.status]} ${entry.title.padEnd(width, '　')}  ${entry.summary}`)
    if (entry.fix !== undefined && entry.fix !== '' && entry.status !== 'ok') {
      lines.push(`${' '.repeat(width + 4)}修复：${entry.fix}`)
    }
  }
  lines.push('', summarize(report))
  return lines.join('\n')
}

/** `--json` 版：同构、稳定、把家目录换成 `~`。 */
export function renderJson(report: HealthReport): string {
  const checks: Record<string, { status: HealthStatus; summary: string; detail?: string; fix?: string }> = {}
  for (const entry of report.entries) {
    checks[entry.id] = {
      status: entry.status,
      summary: redactHome(entry.summary),
      ...(entry.detail === undefined ? {} : { detail: redactHome(entry.detail) }),
      ...(entry.fix === undefined ? {} : { fix: redactHome(entry.fix) }),
    }
  }
  return JSON.stringify(
    {
      version: appVersion() ?? null,
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      at: new Date(report.at).toISOString(),
      status: report.fail > 0 ? 'fail' : report.warn > 0 ? 'warn' : 'ok',
      counts: { ok: report.ok, warn: report.warn, fail: report.fail, skip: report.skip },
      checks,
    },
    null,
    2,
  )
}

/**
 * 建一个空的体检登记表。
 *
 * 单独抽出来是为了能单测：`apply` 里那九项会去探 shell、发网络请求，测试不该为了
 * 验「排序与计数」去付这些代价。
 */
export function createHealthRegistry(): HealthService {
  const checks = new Map<string, HealthCheck>()
  return {
    register(check) {
      if (checks.has(check.id)) throw new Error(`doctor: 体检项 id 重复：${check.id}`)
      checks.set(check.id, check)
      return () => {
        checks.delete(check.id)
      }
    },
    async run(): Promise<HealthReport> {
      const ordered = [...checks.values()].sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER))
      const entries: HealthReport['entries'] = []
      for (const check of ordered) {
        let result: HealthResult
        try {
          result = await check.run()
        } catch (error) {
          // 单项炸了只算这项失败：体检本身不该被某一项拖垮，否则最需要它的场景刚好用不了
          result = {
            status: 'fail',
            summary: '这项检查自己抛错了',
            detail: error instanceof Error ? error.stack ?? error.message : String(error),
            fix: '这是 doctor 的 bug，请把这一行连同上面的 detail 一起反馈',
          }
        }
        entries.push({ id: check.id, title: check.title, ...result })
      }
      return {
        at: Date.now(),
        entries,
        ok: entries.filter((entry) => entry.status === 'ok').length,
        warn: entries.filter((entry) => entry.status === 'warn').length,
        fail: entries.filter((entry) => entry.status === 'fail').length,
        skip: entries.filter((entry) => entry.status === 'skip').length,
      }
    },
  }
}

export const doctorPlugin: Plugin.Object = {
  name: 'doctor',
  inject: ['commands', 'settings'],
  apply(ctx) {
    const settings = ctx.settings as SettingsService
    const service = createHealthRegistry()
    const checks = service
    /** 内置九项的退订函数：卸载时一并摘掉。 */
    const offs: Array<() => void> = []

    ctx.provide('health', service)

    // 内置九项：环境四项、生态三项、数据两项
    const builtin = [
      installCheck(),
      configCheck(settings),
      authCheck(settings),
      pluginsCheck(),
      sessionCheck(),
      diskCheck(),
      sandboxCheck(() => ctx.get('sandbox') as SandboxService | undefined),
      reachabilityCheck(settings),
      terminalCheck(),
    ]
    for (const check of builtin) offs.push(checks.register(check))

    const offCommand = ctx.commands.register(
      {
        name: 'doctor',
        args: '[--json|--bundle [--with-session]]',
        label: '体检',
        description: '查安装、配置、认证、插件、会话、沙箱、连通性与终端；--bundle 写出诊断包',
        duringTask: 'allow',
      },
      async ({ args, ui }) => {
        const json = args.includes('--json')
        const wantBundle = args.includes('--bundle')
        const withSession = args.includes('--with-session')
        // 九项里有网络探测与 shell 探测，可能几秒；先给一句话，别让用户对着空屏等
        ui.notice('正在体检（9 项）…')
        const report = await service.run()
        if (wantBundle) {
          const log = ctx.get('log') as LogService | undefined
          const recent = recentSessionFiles(dscPath('sessions'), 1)
          const newest = recent[0]
          // 会话正文默认不带；只有用户明确加了 --with-session 才读最后一份
          const excerpt = withSession && newest !== undefined ? readSessionExcerpt(newest) : undefined
          const path = writeBundle({
            report,
            logTail: log?.tail(300) ?? [],
            sessionPaths: recentSessionFiles(dscPath('sessions'), 5),
            ...(excerpt === undefined ? {} : { sessionExcerpt: excerpt }),
          })
          const note =
            excerpt === undefined
              ? '（含体检结论与最近日志；不含密钥、请求正文与工具输出）'
              : `（另含最近 ${excerpt.events.length} 条对话摘要，已脱敏与截断；正文仍不含密钥）`
          ui.notice(`诊断包已写出：${path}\n${note}`)
          return
        }
        ui.notice(json ? renderJson(report) : renderText(report))
      },
    )

    return () => {
      offCommand()
      for (const off of offs) off()
    }
  },
}
