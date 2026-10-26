/**
 * dsh 工具定义 → dsc 工具条目的适配面（兼容层唯一认识 dsh 工具形状的地方）。
 *
 * dsh 的 ToolDefinition（`defineTool` 的产物）与 dsc 的 ToolEntry 在参数 schema 上
 * 同构（都是 JSON Schema 对象），差异在执行侧：
 *   dsh execute(args, exec) 返回「规范 JSON 值」，模型可见内容由 output.render 投影；
 *   dsc  run(args, ctx)   直接返回文本 / 文本+图像。
 * 适配层把 exec 缩成 dsc 拿得到的那两样（signal / cwd），把 render 的内容块折成文本；
 * risk 不是 dsh 概念，缺省 'exec'（每次都过审批卡），可被插件条目配置覆盖。
 *
 * @module dsc/core/dsh-compat/tools-facade
 */
import type { ToolContext, ToolEntry, ToolOutput, ToolPresentation } from '../tools.js'
import { asCardView, validateOutput, type JsonSchemaNode } from './presentation.js'

/** dsh ToolDefinition 里兼容层认得的字段（其余字段照原样被忽略）。 */
export interface DshToolDefinitionLike {
  name: unknown
  description: unknown
  parameters: unknown
  execute?: unknown
  /**
   * dsh 规定必填；兼容层对缺了它的定义容错（跳过投影直接字符串化）。
   *
   * - `schema`：规范值的 JSON Schema，**声明了就校验**（dsh 会拒收不合 schema 的返回值）；
   * - `render`：规范值 → 内容块（模型可见文本）；
   * - `presentationMeta`：可重放的展示投影（卡片数据，与值无关的纯数据）。
   */
  output?: { render?: unknown; schema?: unknown; presentationMeta?: unknown } | unknown
  /** 调用阶段怎么画（dsh 的 ToolCallView）。 */
  presentCall?: unknown
  /** 完成阶段怎么画（dsh 的 ToolResultView）。 */
  presentResult?: unknown
  /**
   * 执行体返回之后、任何策略之前，用它准备好的内容顶替模型可见内容
   * （dsh 的 projectContent；返回 undefined 表示保持原样）。
   *
   * dsh 里这一步跑在 `tools/post-execute` 之前，好让策略看见真实图片块；
   * 兼容层没有 post-execute 阶段，所以它直接排在 render 之后。
   */
  projectContent?: unknown
  /**
   * 最后一公里改写模型可见内容（dsh 的 finalizeContent；返回 undefined 表示保持原样）。
   *
   * dsh 对**每一个**结果都调用它，失败结果也在内——那正是「把长输出截断」类
   * 钩子能连错误文案一起裁的原因；兼容层照这个口径，成功路径在 render 之后调，
   * 失败路径在错误抛出前调。
   */
  finalizeContent?: unknown
  /** 这条调用能不能与同轮别的工具并行（只认明确的 true）。 */
  isConcurrencySafe?: unknown
  timeoutMs?: unknown
}

/** dsh 内容块的形状（render 的产物）。 */
interface DshContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** 插件条目树里关于 risk 的配置形状（值来自 JSON，宽松收进来再收敛）。 */
export interface DshRiskConfig {
  /** 这份插件所有工具的缺省 risk。 */
  risk?: unknown
  /** 按工具名覆盖。 */
  risks?: Record<string, unknown>
}

const RISKS = new Set(['read', 'write', 'exec'])

/** 判一个对象像不像 dsh 的 ToolDefinition（有 execute、没有 dsc 的 run）。 */
export function looksLikeDshToolDefinition(candidate: unknown): candidate is DshToolDefinitionLike {
  if (candidate === null || typeof candidate !== 'object') return false
  const record = candidate as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.execute === 'function' && typeof record.run !== 'function'
}

/** 把配置里的 risk 字样收敛成合法值；认不出就落回 'exec'（多问一次总比漏问强）。 */
function normalizeRisk(raw: unknown): ToolEntry['risk'] {
  return typeof raw === 'string' && RISKS.has(raw) ? (raw as ToolEntry['risk']) : 'exec'
}

function riskFor(definition: DshToolDefinitionLike, config: DshRiskConfig): ToolEntry['risk'] {
  if (config.risks !== undefined && typeof config.risks === 'object') {
    const own = config.risks[definition.name as string]
    if (own !== undefined) return normalizeRisk(own)
  }
  return normalizeRisk(config.risk)
}

/** 把 dsh render 的内容块折成 dsc 的工具输出：文本拼起来，图像块以占位说明。 */
function blocksToOutput(blocks: unknown, name: string): string | ToolOutput {
  if (!Array.isArray(blocks)) {
    return typeof blocks === 'string' ? blocks : JSON.stringify(blocks, null, 2)
  }
  const texts: string[] = []
  const images: string[] = []
  for (const block of blocks as DshContentBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'image') texts.push(`[图像块已省略：${name} 返回的图像 dsc 兼容层暂不投递]`)
    else texts.push(JSON.stringify(block, null, 2))
  }
  const text = texts.join('\n')
  return images.length > 0 ? { text, images } : text
}

/** 规范 JSON 值 → 文本（没有 render 时的兜底）。 */
function valueToText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/**
 * 任意 render 产物 → 内容块数组。
 *
 * dsh 的 render 按契约返回 ContentBlock[]，但兼容层对写歪的定义容错（返回字符串
 * 或对象也收）：先归一成数组，两个内容钩子才有一致的入参。
 */
function asBlocks(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  return [{ type: 'text', text: JSON.stringify(raw, null, 2) ?? String(raw) }]
}

/** 内容块 → 纯文本（失败路径要把钩子改过的内容折回错误文案）。 */
function blocksToText(blocks: readonly unknown[], name: string): string {
  const out = blocksToOutput(blocks, name)
  return typeof out === 'string' ? out : out.text
}

/**
 * 跑 dsh 的两个内容钩子：先 projectContent，再 finalizeContent。
 *
 * 顺序与 dsh 一致（投影在策略前、定稿在策略后）；两边都只认「返回数组」这一种
 * 替换信号，返回 undefined 或抛错都保持原内容——与 dsh 的容错口径相同，
 * 钩子写坏了不该让工具结果变成错误。
 */
function applyContentHooks(
  definition: DshToolDefinitionLike,
  exec: Record<string, unknown>,
  value: unknown,
  blocks: unknown[],
  name: string,
): unknown[] {
  const project = definition.projectContent
  const finalize = definition.finalizeContent
  if (typeof project !== 'function' && typeof finalize !== 'function') return blocks
  let content = blocks
  // 冻结一份结果视图给钩子：dsh 传的是只读对象，插件不该能改我们的内部状态。
  const result = Object.freeze({ isError: false as const, value, content })
  if (typeof project === 'function') {
    try {
      const next = (project as (e: unknown, r: unknown) => unknown)(exec, result)
      if (Array.isArray(next)) content = next
    } catch (error) {
      console.warn(`[dsh-compat] 工具 ${name} 的 projectContent 抛错，保留 render 的原始内容：${String(error)}`)
    }
  }
  if (typeof finalize === 'function') {
    try {
      const next = (finalize as (e: unknown, r: unknown) => unknown)(exec, Object.freeze({ ...result, content }))
      if (Array.isArray(next)) content = next
    } catch (error) {
      console.warn(`[dsh-compat] 工具 ${name} 的 finalizeContent 抛错，保留前一步的内容：${String(error)}`)
    }
  }
  return content
}

/**
 * 失败路径的 finalizeContent：dsh 对这个钩子的承诺是「每个结果都调一次」，
 * 错误结果也不例外（长输出工具靠它把错误文案一起截断）。
 *
 * 只在插件确实声明了钩子时才介入：没声明的插件抛什么就还是什么，错误类型与
 * 堆栈一律不动；钩子自己抛错时退回原错误，绝不把错误换成「钩子失败」。
 */
function finalizeFailure(
  definition: DshToolDefinitionLike,
  exec: Record<string, unknown>,
  name: string,
  error: unknown,
): unknown {
  const finalize = definition.finalizeContent
  if (typeof finalize !== 'function') return error
  try {
    const message = error instanceof Error ? error.message : String(error)
    const content = [{ type: 'text', text: message }]
    const result = Object.freeze({ isError: true as const, error: Object.freeze({ message }), content })
    const next = (finalize as (e: unknown, r: unknown) => unknown)(exec, result)
    if (!Array.isArray(next)) return error
    const text = blocksToText(next, name)
    if (!(error instanceof Error)) return new Error(text)
    try {
      // 改 message 而不是新建错误：工具错误的类型（审批分类看得见）与堆栈都留住。
      error.message = text
      return error
    } catch {
      // 冻结/只读的错误对象改不动，那就退回原错误——文案不完美好过类型丢失。
      return error
    }
  } catch {
    return error
  }
}

/** 把卡片数据挂到工具输出上（输出可能是字符串，那就升成对象）。 */
function withPresentation(output: string | ToolOutput, presentation: ToolPresentation | undefined): string | ToolOutput {
  if (presentation === undefined) return output
  return typeof output === 'string' ? { text: output, presentation } : { ...output, presentation }
}

/** 一次调用能拿到的卡片：presentCall / presentResult / presentationMeta 三者有其一。 */
function cardsOf(
  definition: DshToolDefinitionLike,
  args: unknown,
  value: unknown,
  rendered: string | ToolOutput,
): ToolPresentation | undefined {
  const call = typeof definition.presentCall === 'function'
    ? asCardView((definition.presentCall as (a: unknown) => unknown)(args))
    : undefined
  const result = typeof definition.presentResult === 'function'
    ? asCardView(
        (definition.presentResult as (a: unknown, r: unknown) => unknown)(args, {
          // dsh 的 ToolResult：这里能给的只有渲染后的内容，够画卡了
          content: typeof rendered === 'string' ? [{ type: 'text', text: rendered }] : [{ type: 'text', text: rendered.text }],
          text: typeof rendered === 'string' ? rendered : rendered.text,
        }),
      )
    : undefined
  const output = (definition.output ?? {}) as { presentationMeta?: unknown }
  const meta = typeof output.presentationMeta === 'function'
    ? (output.presentationMeta as (a: unknown, v: unknown) => unknown)(args, value)
    : undefined
  if (call === undefined && result === undefined && meta === undefined) return undefined
  return {
    ...(call === undefined ? {} : { call }),
    ...(result === undefined ? {} : { result }),
    ...(meta === undefined ? {} : { meta }),
  }
}

/**
 * 把一个 dsh ToolDefinition 包成 dsc ToolEntry。转出来的工具：
 *   - 参数 schema 原样透传（两边同是 JSON Schema，llm 层怎么发就怎么发）；
 *   - execute 收到的 exec 只保证有 `signal`（dsc 的执行上下文没有 agent 身份那些字段）；
 *   - 声明了 timeoutMs 时到点放弃等待（协作式的：工具内部自己看 signal 才是真取消）。
 */
export function dshToolToEntry(definition: DshToolDefinitionLike, config: DshRiskConfig): ToolEntry {
  const name = typeof definition.name === 'string' ? definition.name : 'unknown'
  const execute = definition.execute as ((args: unknown, exec: unknown) => Promise<unknown>) | undefined
  const render =
    definition.output !== null && typeof definition.output === 'object'
      ? (definition.output as { render?: unknown }).render
      : undefined
  const renderFn = typeof render === 'function' ? (render as (args: unknown, value: unknown) => unknown) : undefined
  const timeoutMs = typeof definition.timeoutMs === 'number' && definition.timeoutMs > 0 ? definition.timeoutMs : undefined
  const outputDef = (definition.output ?? {}) as { schema?: unknown }
  const schema = outputDef.schema === undefined ? undefined : (outputDef.schema as JsonSchemaNode)
  // 并发分类：只有明确返回 true 才算可并行（dsh 同一口径），抛错也当独占。
  const concurrency = definition.isConcurrencySafe

  const run = async (args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolOutput> => {
    if (execute === undefined) throw new Error(`工具 ${name} 没有 execute 实现`)
    const exec = dshExec(name, args, ctx)
    let value: unknown
    try {
      value = timeoutMs === undefined ? await execute(args, exec) : await withTimeout(execute(args, exec), name, timeoutMs)
    } catch (error) {
      // 失败结果也过一道 finalizeContent（声明了才走），见 finalizeFailure。
      throw finalizeFailure(definition, exec, name, error)
    }
    // 规范值契约：声明了 output.schema 就校验；不合 schema 的返回值**不当成功**。
    // 这条是 dsh 的硬规矩（违例抛 ToolArgsError），这里是同一处把关，只是文案说人话。
    if (schema !== undefined) {
      const violations = validateOutput(schema, value)
      if (violations.length > 0) {
        const head = violations.slice(0, 3).join('；')
        const more = violations.length > 3 ? `（另有 ${String(violations.length - 3)} 处）` : ''
        throw new Error(`工具 ${name} 的返回值不符合它自己声明的 output.schema：${head}${more}`)
      }
    }
    const raw = renderFn !== undefined ? renderFn(args, value) : valueToText(value)
    // 内容钩子排在 render 之后：compat 层没有 dsh 的 post-execute 阶段，
    // projectContent 与 finalizeContent 在这里一前一后跑完，都只认「返回数组」。
    const content = applyContentHooks(definition, exec, value, asBlocks(raw), name)
    const rendered = blocksToOutput(content, name)
    return withPresentation(rendered, cardsOf(definition, args, value, rendered))
  }

  return {
    name,
    description: typeof definition.description === 'string' ? definition.description : '',
    parameters:
      definition.parameters !== null && typeof definition.parameters === 'object'
        ? (definition.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} },
    risk: riskFor(definition, config),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(typeof concurrency === 'function'
      ? {
          isConcurrencySafe: (args: Record<string, unknown>): boolean => {
            try {
              return (concurrency as (a: unknown) => unknown)(args) === true
            } catch {
              // 分类器抛错当独占（与 dsh 同一口径：出错就不并行）。
              return false
            }
          },
        }
      : {}),
    run,
  }
}

/**
 * 造 dsh 的执行上下文（`exec`）。
 *
 * 能给的真给，给不了的**明确降级**而不是假装有：
 *   - `signal` / `cwd`：真值；
 *   - `arguments`：真值（dsh 声明它是解析后的参数）；
 *   - `agent`：从 dsc 的 `caller` 折出来（队友名/层级；主会话是 lead）；
 *   - `token`：合成的对象（dsc 没有传输级执行令牌，这里只有身份信息，不要当授权凭据用）；
 *   - `callId`：合成（dsc 的 callId 在循环那边，工具层拿不到）；
 *   - `deferContext`：**收下但不投递**——dsc 的循环没有「延迟上下文」这条通道，
 *     照 dsh 的说法这会把内容推迟进下一轮请求，我们没有对应落点，只能记一条告警；
 *   - `concludeTurn`：**空操作**（dsc 的收尾由循环自己判，工具说不了话）。
 *
 * 这两条降级在开发日志里有记录：用到它们的 dsh 插件行为会不完整，但不会崩。
 */
function dshExec(name: string, args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> {
  let warned = false
  const warnOnce = (what: string): void => {
    if (warned) return
    warned = true
    console.warn(`[dsh-compat] 工具 ${name} 用了 ${what}，dsc 没有对应通道，已按空操作处理`)
  }
  return {
    signal: ctx.signal,
    cwd: ctx.cwd,
    arguments: args,
    callId: `${name}@${String(Date.now())}`,
    token: { name, sessionId: ctx.sessionId, synthetic: true },
    agent: {
      name: ctx.caller?.name ?? 'lead',
      depth: ctx.caller?.depth ?? 0,
      background: ctx.caller?.background ?? false,
    },
    deferContext: (message: unknown): void => {
      warnOnce('deferContext（延迟上下文）')
      void message
    },
    concludeTurn: (): void => {
      warnOnce('concludeTurn（工具收尾本轮）')
    },
  }
}

async function withTimeout(promise: Promise<unknown>, name: string, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`工具 ${name} 超时（${timeoutMs}ms）`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * dsh `ctx.tools` 的兼容面：register 收 dsh ToolDefinition，其余成员一律响亮报错——
 * 静默装作支持只会让插件在更深处莫名坏掉。risk 映射每次注册时经 readConfig 现读，
 * 插件条目配置里改 risk 不必重挂。
 */
export function dshToolsFacade(register: (entry: ToolEntry) => () => void, readConfig: () => DshRiskConfig): unknown {
  const target = {
    register(definition: unknown): () => void {
      if (!looksLikeDshToolDefinition(definition)) {
        throw new Error('ctx.tools.register 收到的不是 dsh 风格的工具定义（要有 name/execute）')
      }
      return register(dshToolToEntry(definition, readConfig()))
    },
  }
  return new Proxy(target, {
    get(item, prop, receiver) {
      if (prop in item) return Reflect.get(item, prop, receiver)
      throw new Error(`dsc 兼容层只支持 ctx.tools.register，当前插件调用了 ctx.tools.${String(prop)}`)
    },
  })
}
