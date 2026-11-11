/**
 * 运行日志的配置口径：级别、目录、四个上限。
 *
 * **为什么放 core**：`@pneuma/log` 的采集口、`filter.ts` 的级别映射，以及 `/log` 命令与设置分区
 * 读的是同一份口径。各写一份默认值，早晚出现「设置页显示 8 MiB、采集按 4 MiB 轮转」这种事——
 * 那种 bug 没人会怀疑是两处默认值不一致。所以默认值与解析只在这里留一份，采集包不再自带副本。
 *
 * **这里不缓存**：`readLogConfig` 每次都真读盘、真解析，谁调谁拿到当下那份。缓存放在采集口那一层
 * （`packages/log/index.ts`）：它每判一条日志都要看级别，每条读一次盘太贵，所以那边是
 * 「缓存 + 保存时主动失效 + 250ms TTL 兜底」。两层分工别搞混——core 保证「读到的就是最新」，
 * 采集口负责「别每条都读」。
 *
 * 配置来源的优先级由 `resolvePluginConfig` 决定：`plugins.json`（保存即生效）盖过装配时的行配置。
 *
 * @module dsc/core/log-config
 */
import { dscPath } from './path-policy.js'
import { resolvePluginConfig } from './plugin-registry.js'

/** 级别名，下标就是 cordis 的数值级别（error=0、warn=1、info=2、debug=3）。 */
export const LEVEL_NAMES = ['error', 'warn', 'info', 'debug'] as const

export type LevelName = (typeof LEVEL_NAMES)[number]

/** 名字 → 数值。设置页选的是名字，exporter 的 `levels` 只认数字。 */
export const LEVEL_VALUES: Record<LevelName, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/** 配置或环境变量里读到的值是不是一个合法级别名。 */
export function isLevelName(value: unknown): value is LevelName {
  return typeof value === 'string' && (LEVEL_NAMES as readonly string[]).includes(value)
}

/** 数值级别 → 名字；越界时回落 info（宁可标错级别，也不要丢这一条）。 */
export function levelNameOf(level: number): LevelName {
  return LEVEL_NAMES[level] ?? 'info'
}

/** 解析后的配置。 */
export interface LogConfig {
  level: LevelName | 'off'
  dir: string
  maxFileBytes: number
  keepDays: number
  maxTotalBytes: number
}

/** 缺省值：单文件 8 MiB、留 10 天、总量 64 MiB。 */
export const LOG_DEFAULTS = {
  maxFileBytes: 8 * 1024 * 1024,
  keepDays: 10,
  maxTotalBytes: 64 * 1024 * 1024,
} as const

/** 面板与采集共用的插件键（`plugins.json` 里那条配置挂在这个名字下）。 */
export const LOG_PLUGIN_KEY = 'log'

/** 数值归一：读到的不是有限数就用缺省值。 */
export function asNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 从行配置 + `plugins.json` + 环境变量解析出一份可用配置。
 *
 * `DSC_LOG` 优先于配置：排障时人手敲的命令行不该被上次点过的设置盖掉。
 *
 * @param passed 插件 apply 收到的行配置（可为 undefined）。
 */
export function readLogConfig(passed: unknown): LogConfig {
  const raw = resolvePluginConfig(LOG_PLUGIN_KEY, passed)
  const fromEnv = process.env['DSC_LOG']
  const level: LogConfig['level'] = isLevelName(fromEnv)
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
    maxFileBytes: Math.max(64 * 1024, asNumber(raw['maxFileBytes'], LOG_DEFAULTS.maxFileBytes)),
    keepDays: Math.max(1, Math.round(asNumber(raw['keepDays'], LOG_DEFAULTS.keepDays))),
    maxTotalBytes: Math.max(256 * 1024, asNumber(raw['maxTotalBytes'], LOG_DEFAULTS.maxTotalBytes)),
  }
}
