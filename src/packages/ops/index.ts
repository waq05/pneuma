/**
 * ops 插件：给 numa 补上「内置 read 做不到的那几件事」——文档、表格、批量读、
 * 差异预演、文件体检、16 进制视图。
 *
 * 内核不自己写：它是 dsh-ops 那个 Rust worker（见 `packages/ops/worker`）。这个插件只做
 * 装配——找 exe、注册十三个工具（七个只读 + 六个写类）、给一段系统提示、开一个设置分区。
 *
 * 为什么默认关：它会拉起一个外部进程（哪怕只是只读），按库里那条规矩「会拉起外部
 * 进程的先默认关」，用户按需打开。
 *
 * 找不到 worker 时不装作能用：工具一个都不注册，往会话流里说一句缺什么、怎么补，
 * 设置分区里也写清楚当前找过哪些位置。
 *
 * @module dsc/plugins/ops
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { bootNoticeOnce } from '@pneuma/runtime/core/boot-notices.js'
import { clampIntIn as clamp } from '@pneuma/runtime/core/clamp.js'
import { createOpsTools } from './tools.js'
import { OPS_MAX_BYTES, OPS_TIMEOUT_MS, resolveOpsWorker } from './worker.js'
import type { OpsWorkerLookup } from './worker.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 插件在条目树里的键，也是设置分区 id。 */
const CONFIG_KEY = 'ops'

/** 时限的可调区间：下限给慢盘留余地，上限压到 worker 自己的 30 秒。 */
export const OPS_TIMEOUT_RANGE = { min: 2_000, max: OPS_TIMEOUT_MS } as const

/** 插件配置。 */
export interface OpsConfig {
  /** 用户显式指定的 worker 路径；空串表示自动找。 */
  workerPath: string
  /** 单次调用时限（毫秒）。 */
  timeoutMs: number
}

/**
 * 读配置：类型不对就用缺省，数值夹回区间。
 *
 * @param passed - 挂载时传进来的原始配置（条目树里的那份优先）
 * @returns 收好的配置
 */
export function readOpsConfig(passed?: unknown): OpsConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const workerPath = typeof raw.workerPath === 'string' ? raw.workerPath.trim() : ''
  return {
    workerPath,
    timeoutMs: clamp(raw.timeoutMs, OPS_TIMEOUT_RANGE, OPS_TIMEOUT_MS),
  }
}

/** 工具那一组的中文名字，系统提示与设置页共用，免得两处说法不一致。 */
const TOOL_SUMMARY =
  '只读七个：ops_read_pdf 读 PDF、ops_read_docx 读 Word、ops_read_table 读 CSV/TSV、' +
  'ops_read_files 一次读多段、ops_diff 预演改动、ops_stat 看文件体检、ops_inspect_local_file 看文本或 16 进制；' +
  '写类六个：ops_write_file / ops_edit_file / ops_copy / ops_move / ops_remove / ops_replace，都带修订锚与 dryRun'

export const opsPlugin: Plugin.Object = {
  name: 'ops',
  inject: ['tools', 'settings', 'prompt', 'transcript'],
  apply(ctx, passed) {
    const config = (): OpsConfig => readOpsConfig(passed)
    /** 当前这批工具的卸载函数；换 worker 路径时整批换掉。 */
    let offTools: Array<() => void> = []
    /** 最近一次挂载的结论：设置页与系统提示都要读它。 */
    let lookup: OpsWorkerLookup = { ok: false, reason: '还没找过' }

    /**
     * 找一次 worker 并注册工具。
     *
     * 换路径后必须整批重注册：工具条目的 run 闭包里握着 exe 路径与时限，
     * 不重建就等于改了配置不生效。
     */
    /**
     * 工具层不再自己判沙箱档位：那是守卫链（sandbox 插件 order 8）与审批卡的职责，
     * 而且它们按**调用方会话**判，工具层拿 `ctx.session.current()` 会判错后台会话。
     */
    const createTools = (file: string): ReturnType<typeof createOpsTools> =>
      createOpsTools({
        file,
        timeoutMs: config().timeoutMs,
        maxBytes: OPS_MAX_BYTES,
      })

    const mount = (): void => {
      const found = resolveOpsWorker(config().workerPath)
      lookup = found
      if (!found.ok) return
      for (const off of offTools.splice(0)) off()
      for (const tool of createTools(found.file)) {
        offTools.push(ctx.effect(() => ctx.tools.register(tool), 'ops: tools.register'))
      }
    }

    /**
     * 换一个 worker 路径：先解析，解析成功才撤旧批次。
     *
     * 为什么不能先撤再解析：设置里打错一个字就把十三个能用的工具全收走，用户只看到
     * 「保存成功」而工具没了。解析失败时保持现状，把原因交回设置页。
     */
    const swap = (path: string): OpsWorkerLookup => {
      const found = resolveOpsWorker(path)
      if (!found.ok) return found
      for (const off of offTools.splice(0)) off()
      for (const tool of createTools(found.file)) {
        offTools.push(ctx.effect(() => ctx.tools.register(tool), 'ops: tools.register #2'))
      }
      lookup = found
      return found
    }

    mount()
    // 同一条原因只说一次：插件默认关，用户主动打开却没装 worker 时才会走到这里。
    if (!lookup.ok && bootNoticeOnce('ops.worker-missing', lookup.reason)) {
      ctx.transcript.system(`ops 工具没启用：${lookup.reason}`)
    }

    // ── 系统提示 ─────────────────────────────────────────────────────────────
    // 只在工具真的在架上时才说这段话：没装 worker 还教模型用它们，只会换来一串「工具不存在」。

    const offPrompt = ctx.prompt.register(
      'ops',
      () =>
        lookup.ok
          ? `读文档与批量读文件时优先用 ops 系列：${TOOL_SUMMARY}。` +
            '普通代码与文本文件仍用内置 read（更快、更省），只有 read 读不了的格式或要一次读很多段时才换 ops。'
          : '',
      { order: 60 },
    )
    ctx.effect(() => offPrompt, 'ops: prompt.register')

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    const fields = (): SettingsField[] => {
      const cfg = config()
      return [
        {
          type: 'info',
          label: t('field.status.label'),
          text: lookup.ok
            ? t('field.status.available', { source: lookup.source })
            : t('field.status.unavailable', { reason: lookup.reason }),
          help: t('field.status.help'),
        },
        ...(lookup.ok
          ? [{ type: 'info' as const, label: t('field.workerResolved.label'), text: lookup.file, mono: true, copyable: true }]
          : []),
        {
          type: 'text',
          key: 'workerPath',
          label: t('field.workerPath.label'),
          placeholder: t('field.workerPath.placeholder'),
          mono: true,
          help: t('field.workerPath.help'),
        },
        {
          type: 'number',
          key: 'timeoutMs',
          label: t('field.timeoutMs.label'),
          min: OPS_TIMEOUT_RANGE.min,
          max: OPS_TIMEOUT_RANGE.max,
          step: 1000,
          help: t('field.timeoutMs.help'),
        },
        {
          type: 'info',
          label: t('field.toolsInfo.label'),
          // i18n-keep 这一句与系统提示共用（TOOL_SUMMARY），翻了两处说法会不一致
          text: TOOL_SUMMARY,
        },
        {
          type: 'info',
          label: t('field.missing.label'),
          text: t('field.missing.text'),
        },
      ]
    }

    const section: SettingsSectionSpec = {
      id: 'ops',
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 48,
      fields,
      values(): SettingsValues {
        const cfg = config()
        return { workerPath: cfg.workerPath, timeoutMs: cfg.timeoutMs }
      },
      save(key, value): string | void {
        switch (key) {
          case 'workerPath': {
            const text = String(value).trim()
            writePluginConfig(CONFIG_KEY, { workerPath: text === '' ? null : text })
            const found = swap(text)
            if (!found.ok) {
              return t('save.workerPathSaved', { reason: found.reason })
            }
            return t('save.workerPathUpdated', { source: found.source })
          }
          case 'timeoutMs': {
            const number = Number(value)
            if (!Number.isFinite(number)) return t('save.badTimeout')
            writePluginConfig(CONFIG_KEY, { timeoutMs: clamp(number, OPS_TIMEOUT_RANGE, OPS_TIMEOUT_MS) })
            mount()
            return
          }
          default:
            return t('save.unknownKey', { key })
        }
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'ops: settings.registerSection')

    return () => {
      offSection()
      offPrompt()
      for (const off of offTools.splice(0)) off()
    }
  },
}
