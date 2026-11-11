/**
 * log 插件：把内核日志落到 `~/.dsc/logs`，并给 `/log` 与体检插件一个读入口。
 *
 * **它为什么排在最前面（`pneuma.order` = 5）**：要接管的是 `ctx.logger` 的 exporter，
 * 越早注册，能被记下来的启动期日志越多。排在 `llm`（10）之前，那一段也就进得来。
 *
 * **为什么 `inject` 里带了 commands / settings**：cordis 的插件在依赖齐了才 apply，
 * 少写一个 inject 就是运行时 undefined 崩在注册那一行。代价是日志管线要等这两个
 * 服务就绪（order 100 / 160）才开始记——那之前的启动日志目前记不到，属已知取舍。
 *
 * **级别为什么在 export 里再判一次**：exporter 的 `levels` 是注册时定死的阈值，
 * 而设置页允许运行中改级别。这里把 exporter 阈值放到最宽（debug），过滤挪进 export，
 * 改级别就立刻生效，不必重新注册。
 *
 * @module pneuma/log
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'
import { writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'
import { formatBytes } from '@pneuma/runtime/core/bytes.js'
import type { LogService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import { LEVEL_NAMES, LEVEL_VALUES, isLevelName, levelNameOf, redact, renderMessage, toRecord } from './filter.js'
import type { LevelName } from './filter.js'
import { LogSink, dayKey } from './sink.js'

/** 插件在条目树里的键，也是设置分区 id。 */
const CONFIG_KEY = 'log'

/** 设置分区的 order：靠后，排在「关于」前面一档。 */
const SECTION_ORDER = 880

/** 保留级别的合法取值：`off` 之外都是级别名。 */
const LEVEL_OPTIONS: ReadonlyArray<LevelName | 'off'> = ['off', ...LEVEL_NAMES]

/** `/log` 一次最多列多少条：再多就该自己去翻文件了。 */
const TAIL_MAX = 200

/** 解析后的配置。 */
interface LogConfig {
  level: LevelName | 'off'
  dir: string
  maxFileBytes: number
  keepDays: number
  maxTotalBytes: number
}

/** 数值归一：读到的不是有限数就用缺省值。 */
function asNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 从行配置 + 环境变量解析出一份可用配置。
 *
 * `DSC_LOG` 优先于 `plugins.json`：排障时人手敲的命令行不该被上次点过的设置盖掉。
 */
function readLogConfig(passed: unknown): LogConfig {
  const raw = (passed ?? {}) as Record<string, unknown>
  const fromEnv = process.env['DSC_LOG']
  const level = isLevelName(fromEnv)
    ? fromEnv
    : fromEnv === 'off'
      ? 'off'
      : isLevelName(raw['level'])
        ? raw['level']
        : raw['level'] === 'off'
          ? 'off'
          : 'info'
  const dir = typeof raw['dir'] === 'string' && raw['dir'].trim() !== '' ? raw['dir'].trim() : dscPath('logs')
  return {
    level,
    dir,
    maxFileBytes: Math.max(64 * 1024, asNumber(raw['maxFileBytes'], 8 * 1024 * 1024)),
    keepDays: Math.max(1, Math.round(asNumber(raw['keepDays'], 10))),
    maxTotalBytes: Math.max(256 * 1024, asNumber(raw['maxTotalBytes'], 64 * 1024 * 1024)),
  }
}

export const logPlugin: Plugin.Object = {
  name: 'log',
  inject: ['commands', 'settings'],
  apply(ctx, passed) {
    const t = hostT(import.meta.dirname)
    const config = (): LogConfig => readLogConfig(passed)

    /** 当前生效的阈值（数值）。`off` 用一个不存在的负数表示「一条都不发」。 */
    const threshold = (): number => {
      const level = config().level
      return level === 'off' ? -1 : LEVEL_VALUES[level]
    }

    let sink = makeSink(config())
    /** 重建 sink 时要保留的已排队行：改目录那一刻别把攒着的日志丢了。 */
    function makeSink(cfg: LogConfig): LogSink {
      const next = new LogSink({
        dir: cfg.dir,
        maxFileBytes: cfg.maxFileBytes,
        keepDays: cfg.keepDays,
        maxTotalBytes: cfg.maxTotalBytes,
      })
      // 立刻清一遍旧文件：拖到第一次写入才扫，可能已经写了几十 MB 才想起预算
      next.prune(true)
      return next
    }

    /** 配置里的目录/上限变了就换一个 sink（旧句柄先冲刷）。 */
    const rebuild = (): void => {
      const cfg = config()
      if (cfg.dir === sink.dirOf() && cfg.maxFileBytes === sink.limitOf()) return
      sink.close()
      sink = makeSink(cfg)
    }

    // ── 1. 接管 exporter ──────────────────────────────────────────────────────

    const offExporter = ctx.logger.exporter({
      // 阈值放到最宽，真正的过滤在 export 里按当前设置判（见模块注释）
      levels: { default: LEVEL_VALUES.debug },
      export: (message) => {
        if (message.level > threshold()) return
        sink.write(JSON.stringify(toRecord(message)))
      },
    })

    // ── 2. 崩溃现场 ───────────────────────────────────────────────────────────

    /** 正在处理崩溃时置位：避免 uncaught 里再抛又进来一次。 */
    let crashing = false

    /** 把一条进程级错误写成记录并立刻刷盘。 */
    const capture = (kind: string, error: unknown): void => {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
      sink.write(
        JSON.stringify({
          t: new Date().toISOString(),
          lvl: 'error' satisfies LevelName,
          name: 'process',
          sn: 0,
          msg: redact(`[${kind}] ${text}`),
        }),
      )
      sink.flush()
    }

    const onUncaught = (error: unknown): void => {
      if (!crashing) {
        crashing = true
        capture('uncaughtException', error)
      }
      // 恢复默认观感：栈照样打到终端，然后退出
      try {
        console.error(error)
      } catch {
        // 终端也坏了就算了
      }
      process.exit(1)
    }

    const onRejection = (reason: unknown): void => {
      if (!crashing) {
        crashing = true
        capture('unhandledRejection', reason)
      }
      try {
        console.error(reason)
      } catch {
        // 同上
      }
      process.exit(1)
    }

    /** 正常退出时把队列里剩下的刷掉（进程结束就没有下一次定时器了）。 */
    const onExit = (): void => {
      sink.flush()
    }

    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onRejection)
    process.on('exit', onExit)

    // ── 3. ctx.log 服务 ───────────────────────────────────────────────────────

    const service: LogService = {
      file: () => sink.file(),
      dir: () => config().dir,
      level: () => config().level,
      tail: (count = 20): string[] => {
        const want = Math.max(0, Math.min(Math.trunc(count) || 20, TAIL_MAX))
        return ctx.logger.buffer
          .slice(-want)
          .map((message) => `${levelNameOf(message.level)} ${message.name || '-'} ${redact(renderMessage(message))}`)
      },
      flush: () => sink.flush(),
    }
    ctx.provide('log', service)

    // ── 4. `/log` 命令 ────────────────────────────────────────────────────────

    const offCommand = ctx.commands.register(
      {
        name: 'log',
        args: '[条数]',
        label: '日志',
        description: '看日志落在哪、最近几条',
        duringTask: 'allow',
      },
      ({ args, ui }) => {
        const cfg = config()
        const asked = Number(args[0])
        const count = Number.isFinite(asked) && asked > 0 ? Math.min(asked, TAIL_MAX) : 20
        const lines = service.tail(count)
        const head = [
          t('notice.file', { file: sink.file() }),
          t('notice.level', { level: cfg.level === 'off' ? t('level.off') : cfg.level }),
          t('notice.limit', {
            keepDays: String(cfg.keepDays),
            total: formatBytes(cfg.maxTotalBytes),
          }),
        ]
        ui.notice([...head, '', ...lines].join('\n'))
      },
    )

    // ── 5. 设置分区 ───────────────────────────────────────────────────────────

    /** 字段是函数：设置页每次打开都重算，目录与上限改了马上是新值。 */
    const fields = (): SettingsField[] => [
      {
        type: 'select',
        key: 'level',
        label: t('field.level.label'),
        options: LEVEL_OPTIONS.map((value) => ({
          value,
          label: value === 'off' ? t('level.off') : value,
        })),
        help: t('field.level.help'),
      },
      {
        type: 'text',
        key: 'dir',
        label: t('field.dir.label'),
        mono: true,
        placeholder: t('field.dir.placeholder'),
        help: t('field.dir.help'),
      },
      {
        type: 'number',
        key: 'keepDays',
        label: t('field.keepDays.label'),
        min: 1,
        max: 365,
        step: 1,
        help: t('field.keepDays.help'),
      },
      {
        type: 'number',
        key: 'maxFileMB',
        label: t('field.maxFileMB.label'),
        min: 1,
        max: 512,
        step: 1,
        help: t('field.maxFileMB.help'),
      },
      {
        type: 'number',
        key: 'maxTotalMB',
        label: t('field.maxTotalMB.label'),
        min: 8,
        max: 8192,
        step: 8,
        help: t('field.maxTotalMB.help'),
      },
      {
        type: 'info',
        label: t('field.now.label'),
        mono: true,
        text: sink.file(),
      },
      {
        type: 'button',
        action: 'cleanup',
        label: t('field.cleanup.label'),
        style: 'ghost',
        help: t('field.cleanup.help'),
      },
    ]

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: SECTION_ORDER,
      fields,
      values(): SettingsValues {
        const cfg = config()
        return {
          level: cfg.level,
          dir: cfg.dir,
          keepDays: cfg.keepDays,
          maxFileMB: Math.round(cfg.maxFileBytes / (1024 * 1024)),
          maxTotalMB: Math.round(cfg.maxTotalBytes / (1024 * 1024)),
        }
      },
      save(key, value): string | void {
        switch (key) {
          case 'level': {
            const next = String(value)
            if (next !== 'off' && !isLevelName(next)) return t('save.badLevel')
            writePluginConfig(CONFIG_KEY, { level: next })
            return
          }
          case 'dir': {
            const next = String(value).trim()
            if (next === '') return t('save.dirEmpty')
            writePluginConfig(CONFIG_KEY, { dir: next })
            rebuild()
            return
          }
          case 'keepDays':
          case 'maxFileMB':
          case 'maxTotalMB': {
            const num = Number(value)
            if (!Number.isFinite(num) || num <= 0) return t('save.notNumber')
            const rounded = Math.round(num)
            if (key === 'keepDays') writePluginConfig(CONFIG_KEY, { keepDays: rounded })
            else if (key === 'maxFileMB') writePluginConfig(CONFIG_KEY, { maxFileBytes: rounded * 1024 * 1024 })
            else writePluginConfig(CONFIG_KEY, { maxTotalBytes: rounded * 1024 * 1024 })
            rebuild()
            return
          }
          default:
            return t('save.unknownKey', { key })
        }
      },
      action(name): string | void {
        if (name !== 'cleanup') return t('action.unknown', { name })
        const result = sink.prune(true)
        return t('action.cleanupDone', { dirs: String(result.dirs), bytes: formatBytes(result.bytes) })
      },
    }

    const offSection = ctx.settings.registerSection(section)

    // ── 6. 卸载 ───────────────────────────────────────────────────────────────

    return () => {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onRejection)
      process.off('exit', onExit)
      offSection()
      offCommand()
      void offExporter()
      sink.close()
    }
  },
}

/** 导出给测试与体检插件：不经过 ctx 也能算「今天写哪」。 */
export { dayKey }
