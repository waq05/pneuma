/**
 * 启动收尾：读 config.yaml 的 plugins 段、把启动提示写进会话流。
 *
 * 从 kernel 拆出来的原因很具体：kernel 只该留「建 Context + 挂行」，这两个函数是
 * 启动策略（读哪份配置、写哪些提示），跟装配无关；拆出去之后 kernel 才能守住
 * 契约里「≤120 行」的那条线。
 *
 * @module dsc/host/startup
 */
import { existsSync, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { DscCoreConfig } from '../core/config.js'
import { bootNoticeOnce } from '../core/boot-notices.js'
import { activeConfigFile } from '../core/config-store.js'
import { parseTolerantYaml, type MigrationReport } from '../core/migrate.js'
import { readSessionUsage } from '../core/usage-log.js'

// ── config.yaml 的 plugins 段（外部插件清单） ────────────────────────────────

export interface UiConfig {
  plugins: string[]
}

export function readUiConfig(): UiConfig {
  try {
    const file = activeConfigFile()
    if (!existsSync(file)) return { plugins: [] }
    const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as {
      ui?: unknown
      plugins?: unknown
    }
    return {
      plugins: Array.isArray(doc.plugins)
        ? doc.plugins.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  } catch {
    return { plugins: [] }
  }
}

// ── 启动提示（boot 与 headless 共享；全部插件就绪后一次性写入 transcript） ────

export function emitStartupNotes(
  root: Context,
  migration: MigrationReport | null,
  config: DscCoreConfig,
): void {
  if (Object.keys(config.providers).length === 0) {
    root.transcript.system(
      'Pneuma：没有可用的模型端点。\n' +
        '请编辑 ~/.dsc/config.yaml 配置 providers（api: openai-completions 风格），\n' +
        'key 放到 apiKeyEnv 指向的环境变量或 ~/.dsc/credentials.yaml。\n' +
        '若本机有 dsh 配置，可运行 `numa config migrate --force` 迁移。',
      // 没有端点等于什么都干不了：标成错误，界面弹一次提示，不铺在首屏。
      'error',
    )
  }
  if (migration !== null) {
    root.transcript.system(
      `已从 dsh 迁移模型配置到 ${migration.configPath}（端点 ${migration.providers.join('、')}` +
        `${migration.credentialsPath === null ? '；凭据仍读 dsh 凭据库' : `；凭据已复制到 ${migration.credentialsPath}`}）`,
    )
  }
  if (root.session.startupNote !== null) root.transcript.system(root.session.startupNote)
  if (root.session.resumedStartup) {
    // 启动恢复了历史会话：重放历史到条目（与 dsc/session-open 的行为一致）
    root.transcript.replayHistory(
      root.session.current().messages,
      root.session.current().toolErrors,
      root.session.current().fileChanges,
      root.session.current().presentations,
      root.session.current().notices(),
    )
    // 重启后的第一帧状态栏也得有上下文读数：用量日志按会话存着最后一条请求的
    // 输入 token，它与前台切会话共用同一条回填口径。日志里没有这条会话就不填，
    // 免得把「还没数」画成 0%。
    const usage = readSessionUsage(root.session.current().meta.id)
    if (usage !== null) {
      ;(root.transcript as unknown as { seedContextUsage(used: number): void }).seedContextUsage(
        usage.lastInputTokens,
      )
    }
  }
  // 启动提示只展示一次（0.6.64）：同一会话同一模型的开机横幅只在首次见到时写，
  // 换会话/换模型自然重现。恢复会话时转录里本来就有历史可辨认，状态栏也带短 id。
  const bootBanner = `会话 ${root.session.current().meta.id.slice(0, 8)} · 模型 ${root.llm.provider}/${root.llm.model}`
  if (bootNoticeOnce('boot.session-model', bootBanner)) root.transcript.system(bootBanner)
  root.transcript.touch()
}
