/**
 * 快照场景：单轮问答（快照层的首条端到端骨架）。
 *
 * ## 三种形态（按现场自动选）
 *
 * 1. **回放**（CI 与日常）：`session.jsonl` 在场 → `replayLLM` 回放，不碰网络；
 *    请求指纹对不上当场 409（代码改了请求形状，必须重新录制，不许放宽校验）。
 * 2. **录制**：`session.jsonl` 不在，且给了 `DSC_SNAPSHOT_RECORD_KEY` 与
 *    `DSC_SNAPSHOT_BASE_URL`（真模型基地址）→ 内核经录制代理（`recorder.ts`）打真
 *    API，跑完把录制落盘。产物**要人审**再进版本库（key 不落盘，落的是指纹与应答）。
 * 3. **跳过**：没录制也没 key → `describe.skip` 并写明原因。无 key 不红，但 skip
 *    必须响亮——静默绿是快照层最大的假绿来源。所以收集期固定打一条 `console.warn`
 *    说清缺什么、怎么录；再给一个 `DSC_SNAPSHOT_STRICT=1` 开关，开了就**必须红**
 *    （夜跑设了这个变量：录制已在库，回放必跑；只在录制文件丢失时才该红）。
 *
 * ## 场景约定
 *
 * 一个场景一个目录：`session.jsonl`（录制）+ 本文件（场景驱动）。断言钉的是
 * **持久化终态**（会话 jsonl 的记录序列），不是渲染帧——帧归 tui project。
 *
 * ## 为什么把 cwd 钉到一个固定名字的空临时目录
 *
 * 系统提示里的「指令文件」段是**从 cwd 发现**的（`packages/session-core/prompt.ts:153-194`）：
 * 跑在仓库里时它会读 `AGENTS.md`，并把本机绝对路径 `【D:\dsc\.worktrees\testing\AGENTS.md】`
 * 连同整篇正文拼进系统提示。这条路径每台机器不同、仓库说明改一个字也会变，于是同一份录像
 * 换机器必然 409——而本场景的断言与仓库说明无关（只问「回合跑完、会话落盘、正文非空、
 * 记账非零」），所以钉一个空目录不改变场景本意：它把「不属于本场景的外部状态」摘出去。
 *
 * 名字固定（不是随机）是为了让「工作目录」这一行在两次录制之间也稳定；每次先删再建，
 * 防止上一次被强杀的残留文件混进来。`afterAll` 切回原目录并删掉它。
 *
 * @module dsc/tests/snapshots/session/basic-turn
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, readSessionJsonl, replayLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../harness.js'
import { startRecordProxy } from '../../recorder.js'

/**
 * 录制文件的**原生路径**。
 *
 * 不能直接拿 `URL.pathname` 当文件路径：Windows 上它是 `/D:/...`，`writeFileSync` 会把它
 * 解释成「当前盘根 + D:」拼成 `D:\D:\...`（实测 ENOENT，且只在 Windows 上炸）。统一在
 * 模块顶层换一次，下面的读写都只用这一个是非 URL 的路径。
 */
const RECORDING = fileURLToPath(new URL('./session.jsonl', import.meta.url))
const KEY = process.env['DSC_SNAPSHOT_RECORD_KEY'] ?? ''
const BASE_URL = process.env['DSC_SNAPSHOT_BASE_URL'] ?? ''
/** 录制与回放共用同一条会话根：tempHome 一个文件只能调一次。 */
const home = tempHome('dsc-snapshot-basic-')

/**
 * 本场景的工作目录：固定名字、空目录、在系统临时区。
 *
 * 理由见文件头「为什么把 cwd 钉到一个固定名字的空临时目录」：不让仓库的 `AGENTS.md`
 * 与它的绝对路径进系统提示。固定名字是为了两次录制之间「工作目录」这一行也一致。
 */
const SNAPSHOT_CWD = join(tmpdir(), 'dsc-snapshot-cwd')
/** 切 cwd 前的原目录；空串表示还没切过（skip 模式或 chdir 之前就失败）。 */
let originalCwd = ''

/**
 * 尽力删掉固定 cwd。删不掉**不判红**：Windows 上目录句柄释放有延迟（实测 `rmSync` 偶发 EPERM，
 * 连目录本身都删不掉），而残留目录不影响请求形状——路径是常量，目录里没有 git 仓库、也没有
 * 指令文件，env-facts 那一行只会是「工作目录：<常量>」。真残留由临时目录清扫兜底。
 */
function removeSnapshotCwd(): void {
  try {
    rmSync(SNAPSHOT_CWD, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    console.warn(
      `[snapshot] 清不掉临时工作目录 ${SNAPSHOT_CWD}，留给临时目录清扫：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const mode = existsSync(RECORDING) ? 'replay' : KEY !== '' && BASE_URL !== '' ? 'record' : 'skip'

/** 严格模式开关：值为 `1` 时「一个用例都没跑」必须红；其余值（含未设置）保持跳过。 */
const STRICT = process.env['DSC_SNAPSHOT_STRICT'] === '1'

/**
 * 跳过原因。`short` 进用例名（报告里一行别撑爆），`full` 进 warn 与报错。
 * `full` 的路径用 `fileURLToPath` 换成平台原生形态：`URL.pathname` 在 Windows 上是
 * `/D:/...` 且空格变 `%20`，照着打不开。
 */
const SKIP_REASON = (() => {
  const missing = [
    KEY === '' ? 'DSC_SNAPSHOT_RECORD_KEY' : '',
    BASE_URL === '' ? 'DSC_SNAPSHOT_BASE_URL' : '',
  ].filter((name) => name !== '')
  const envPart = missing.length === 0 ? '' : `也没给 ${missing.join(' / ')}`
  return {
    short: envPart === '' ? '没有录制文件' : `没有录制文件，${envPart}`,
    full: `没有录制文件 ${RECORDING}` + (envPart === '' ? '' : `，${envPart}`),
  }
})()

/**
 * 收集期就把「这层为什么一个用例都没跑」喊出来。
 *
 * skip 本身不红（夜跑没有 key 是常态），但**静默**绿是快照层最大的假绿来源：报告里只多
 * 一行 skip，没人知道端到端其实没测。warn 走 stderr，`vitest run` 原样打出来。
 */
if (mode === 'skip') {
  console.warn(
    `[snapshot] basic-turn 未执行任何用例：${SKIP_REASON.full}。` +
      '录制办法：DSC_SNAPSHOT_RECORD_KEY=... DSC_SNAPSHOT_BASE_URL=... pnpm test:snapshot:record，' +
      '产物 tests/snapshots/session/basic-turn/session.jsonl 要人审后再入库。' +
      '要让它红：DSC_SNAPSHOT_STRICT=1。',
  )
}

/**
 * 非严格模式用 `describe.skip` 并让名字带原因；严格模式用 `describe` 只注册一条必红用例。
 */
const d = mode === 'skip' && !STRICT ? describe.skip : describe

let llm: FakeLLM
let kernel: BootedKernel
let proxy: Awaited<ReturnType<typeof startRecordProxy>> | null = null
let runError: unknown

/** 当前会话文件路径（BootedKernel 只暴露 ctx，会话服务从 ctx 上窄化取）。 */
function sessionFile(): string {
  const surface = kernel.ctx as unknown as { session: { current(): { filePath: string } } }
  return surface.session.current().filePath
}

/**
 * 读内核的 token 记账。
 *
 * 记账**不在会话 jsonl 里**：会话 jsonl 的五种记录是 meta / state / user / assistant（外加
 * 工具条目），用量由 usage 服务单独追加到 `<DSC_HOME>/usage/usage.jsonl`。原来的断言在会话
 * jsonl 里找 `type === "usage"`，录制模式因此恒红（实测 expected undefined to be defined）——
 * 钉错了观察点，不是产品漏记。这里直接读真正的记账文件。
 */
function readUsage(): Array<Record<string, unknown>> {
  const file = join(home.home, '.dsc', 'usage', 'usage.jsonl')
  if (!existsSync(file)) return []
  const records: Array<Record<string, unknown>> = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>)
      }
    } catch {
      // 半截行（进程被杀时正常）跳过，与 readSessionJsonl 同口径。
    }
  }
  return records
}

beforeAll(async () => {
  if (mode === 'skip') return
  originalCwd = process.cwd()
  try {
    // 先删再建：上一次被强杀留下的残留文件会让「工作目录」那一行（以及指令文件发现）不一样。
    removeSnapshotCwd()
    mkdirSync(SNAPSHOT_CWD, { recursive: true })
    process.chdir(SNAPSHOT_CWD)
    if (mode === 'record') {
      proxy = await startRecordProxy(BASE_URL)
      llm = {
        baseUrl: proxy.baseUrl,
        bodies: [],
        requestCount: 0,
        close: () => proxy!.close(),
      }
    } else {
      llm = await replayLLM(RECORDING)
    }
    kernel = await bootKernel({
      providerBaseUrl: llm.baseUrl,
      config: {
        providers: {
          real: {
            name: 'real',
            displayName: 'Recorded',
            baseUrl: llm.baseUrl,
            apiKey: mode === 'record' ? KEY : 'recorded',
            models: [
              {
                id: 'm',
                name: 'm',
                contextWindow: 128_000,
                maxTokens: 2_000,
                modalities: ['text'],
                thinkingLevels: [],
                thinkingParam: 'none',
                effortMap: {},
              },
            ],
          },
        },
        defaultProvider: 'real',
        defaultModel: 'm',
      },
    })
    await kernel.runTurn('用一句话介绍你自己')
  } catch (error) {
    runError = error
  }
})

afterAll(async () => {
  await kernel?.dispose()
  if (mode === 'record' && proxy !== null) {
    if (runError === undefined) {
      // 录制落盘后要人审再提交；这里只写文件，不进 git（产物进版本库是人的决定）。
      proxy.save(RECORDING)
    }
    await proxy.close().catch(() => {})
  }
  await llm?.close()
  home.restore()
  // 切回原目录再删：目录被删时 cwd 还指着它的话，后续相对路径解析会落到一个不存在的目录。
  if (originalCwd !== '') {
    process.chdir(originalCwd)
    removeSnapshotCwd()
  }
})

d(`快照场景：单轮问答（${mode === 'skip' ? `skip：${SKIP_REASON.short}` : mode}）`, () => {
  /**
   * 严格模式（`DSC_SNAPSHOT_STRICT=1`）：没录制就必须失败。用一条真用例而不是模块级
   * throw，报告里能看到是哪一层没跑；非严格模式不进这个分支，四条例行用例照旧被 skip。
   */
  if (mode === 'skip' && STRICT) {
    test('快照层未执行任何用例', () => {
      throw new Error(
        `快照层未执行任何用例：${SKIP_REASON.full}。` +
          '本次只看会话层，TUI 帧与浏览器快照另有结果。' +
          '补齐办法：设 DSC_SNAPSHOT_RECORD_KEY 与 DSC_SNAPSHOT_BASE_URL 后跑 pnpm test:snapshot:record，' +
          '把产物 session.jsonl 人审后入库；或去掉 DSC_SNAPSHOT_STRICT 允许跳过。',
      )
    })
    return
  }

  test('回合正常完成', () => {
    expect(runError).toBeUndefined()
  })

  test('会话落盘，记录序列是 user → assistant', () => {
    const sessionPath = sessionFile()
    expect(existsSync(sessionPath)).toBe(true)
    const records = readSessionJsonl(sessionPath)
    const types = records.map((record) => record['type']).filter((type) => type === 'user' || type === 'assistant')
    expect(types[0]).toBe('user')
    expect(types.at(-1)).toBe('assistant')
  })

  test('assistant 的正文非空（真模型/录制里都有实际回答）', () => {
    const assistant = readSessionJsonl(sessionFile()).find((record) => record['type'] === 'assistant')
    expect(typeof (assistant as { text?: unknown } | undefined)?.text).toBe('string')
    expect(String((assistant as { text?: unknown }).text).length).toBeGreaterThan(0)
  })

  test('用量计数非零（快照层顺手钉住 token 记账）', () => {
    // 录制与回放都走真内核、真记账：录制读真模型的 usage 帧，回放读 replayLLM 合成的
    // usage 块（harness 的 sseBody 固定给 100 / 20）。两种模式都要求有一条非零记账。
    const usage = readUsage()
    expect(usage.length).toBeGreaterThan(0)
    const first = usage[0]!
    expect(first['provider']).toBe('real')
    expect(Number(first['i'])).toBeGreaterThan(0)
    expect(Number(first['o'])).toBeGreaterThan(0)
  })
})
