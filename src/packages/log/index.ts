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
 * **配置怎么读：内存缓存 + 保存时主动失效 + 短 TTL 兜底**：`readLogConfig` 走
 * `resolvePluginConfig`，磁盘上 `plugins.json` 那份会盖过装配时传进来的 `passed`。
 * 每条日志都要判一次级别，若每次都读盘，钱全花在同步文件 I/O（`existsSync` +
 * `readFileSync` + `JSON.parse` 整份文件）上，被过滤掉的行也要付。所以这里缓存一份
 * `LogConfig`：设置分区保存后先打掉缓存，下一行日志就用新值，不依赖计时；外部手改
 * 文件没有事件可听，靠 250 ms 的 TTL 兜底。挂载时那份快照只在磁盘没写这个键时作底。
 * core 里的 `readLogConfig` 保持无缓存——它是纯解析，别的消费方要的是最新值；
 * 缓存只在本插件的采集口这一层。
 *
 * @module pneuma/log
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { LOG_PLUGIN_KEY, readLogConfig } from '@pneuma/runtime/core/log-config.js'
import type { LogConfig } from '@pneuma/runtime/core/log-config.js'
import { writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'
import { formatBytes } from '@pneuma/runtime/core/bytes.js'
import type { LogService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import { LEVEL_NAMES, LEVEL_VALUES, isLevelName, levelNameOf, redact, renderMessage, toRecord } from './filter.js'
import type { LevelName } from './filter.js'
import { LogSink, dayKey } from './sink.js'

/** 插件在条目树里的键，也是设置分区 id；与 core 里那份同一个名字。 */
const CONFIG_KEY = LOG_PLUGIN_KEY

/** 设置分区的 order：靠后，排在「关于」前面一档。 */
const SECTION_ORDER = 880

/** 保留级别的合法取值：`off` 之外都是级别名。 */
const LEVEL_OPTIONS: ReadonlyArray<LevelName | 'off'> = ['off', ...LEVEL_NAMES]

/** `/log` 一次最多列多少条：再多就该自己去翻文件了。 */
const TAIL_MAX = 200

export const logPlugin: Plugin.Object = {
  name: 'log',
  inject: ['commands', 'settings'],
  apply(ctx, passed) {
    const t = hostT(import.meta.dirname)

    /**
     * 配置缓存的有效期：外部手改 `plugins.json`（不经过设置分区）最迟这么久生效。
     *
     * 为什么留 TTL 而不只靠主动失效：设置页之外的改动（人直接编辑文件、别的进程写）
     * 没有事件可听，不设上限就成了「改完要重启」。250 ms 足够短，用户感知不到。
     */
    const CONFIG_TTL_MS = 250

    /** 缓存的那份配置；`undefined` = 还没读过或刚被失效。 */
    let cachedConfig: LogConfig | undefined
    /** 取到缓存那一刻的 `Date.now()`，用来算 TTL。 */
    let cachedAt = 0

    /** 打掉缓存：下一次取值重新读盘。 */
    const invalidateConfig = (): void => {
      cachedConfig = undefined
    }

    /**
     * 当前配置：命中缓存直接用，未命中或过期才 `readLogConfig`。磁盘那份 `plugins.json`
     * 盖过 `passed`，所以设置页保存后立刻生效（保存路径会先失效，见 `save()`）。
     */
    const config = (): LogConfig => {
      if (cachedConfig !== undefined && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig
      cachedConfig = readLogConfig(passed)
      cachedAt = Date.now()
      return cachedConfig
    }

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
      // 先打掉缓存：这里读到的必须是刚写进磁盘的那份，不能是 250 ms 内的旧值
      invalidateConfig()
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
        label: t('command.label'),
        description: t('command.description'),
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
        // 保存路径主动失效：任何键（包括不重建 sink 的 level）保存之后，下一行日志都按
        // 新值走，不等 TTL。`rebuild()` 开头也打一次，留给将来直接调它的地方。
        invalidateConfig()
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
