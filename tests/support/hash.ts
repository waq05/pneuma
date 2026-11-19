/**
 * 会话录制里「请求形状」的指纹算法。
 *
 * ## 为什么要有单独一份，而不是在 harness 里算一遍就完
 *
 * 录制的写入方（快照层的 recorder）与回放方（`replayLLM`）必须算出逐字节相同的 hash，
 * 这条校验才有意义。两边各写一份 `JSON.stringify` + sha256 的代价不是多几行代码，是漂移：
 * 哪天有人在其中一边给消息补了 `ts` 字段、或者改了序列化顺序，hash 就永远对不上，
 * 回放整体失效——而失效的样子是「每个快照场景都红」，排查会从「测试坏了」开始，
 * 离真正原因很远。这个模块是唯一事实源，两边都 import 它。
 *
 * ## 为什么是「整段 messages 的 JSON 文本」——但先摘掉运行时注入段
 *
 * `requestHash` 要挡的事故是「代码改了导致请求形状变化，回放却照样通过」。请求形状里
 * 真正影响模型输入的就是 messages（system 提示、历史、工具结果）。只 hash 用户可见的
 * 正文会漏掉系统提示与工具 schema 的变化，而那两类恰恰是改代码最容易动到的地方。
 * 取 JSON 文本而不是结构化摘要，是因为它在两层之间不依赖任何字段顺序约定：录制端把
 * **线上实际发出去的那一份 messages** 原样写进 jsonl，回放端把收到的同一份再序列化一次。
 *
 * 但「整段原样」有一个不能忍的副作用：请求尾部那条**运行时注入快照**（环境事实：今天日期 /
 * 平台 / 工作目录 / git 分支 / 工作区脏标）在每次请求时现算，内容依赖机器与外部状态。
 * 实测同一台机器录完两分钟，只因为录像文件自己进了 `git status`，回放就 409——这不是
 * 「代码改了请求形状」，是测试在拿易变段当判据。
 *
 * 放宽口径**不许另发明一套**：产品侧已经有一份「哪些段天生不满足重放可复现」的正式约定，
 * 指纹照抄它（见下方 {@link RUNTIME_INJECTION_MARKERS}）。口径只有这一处放宽，其余消息
 * ——系统提示正文、工具 schema、历史组装、用户原话——照旧整段 hash，改一个字都必须红。
 *
 * @module dsc/tests/support/hash
 */
import { createHash } from 'node:crypto'

/**
 * 运行时注入段的识别标记。
 *
 * **产品侧唯一事实源：`src/core/request-invariant.ts:139-143` 的
 * `RUNTIME_INJECTION_MARKERS`（配套判定在同文件 `:146-149` 的 `isRuntimeInjection`）。**
 * 那段注释把这三类段的来源与「为什么天生不满足重放可复现」写全了：
 *   - env-facts：`plugins/prompt.ts` 的 environmentSnapshot（每条请求尾部现算）
 *   - lsp-write-diagnostics：`plugins/lsp.ts`
 *   - user-prompt-submit：`packages/hooks/index.ts`
 *
 * 产品侧那个常量**没有 export**，测试侧又禁止改产品代码，所以只能在这里逐字复制一份。
 * 改这里之前先改产品侧，两边必须同步；`tests/support/hash.spec.ts` 有一条用例直接读
 * 产品源文件核对每个字面量都还在，漏同步会当场红。
 */
const RUNTIME_INJECTION_MARKERS = [
  '本条是程序在每次请求时自动附上的当前环境快照',
  '【LSP 诊断】',
  '<external_content source="hook:',
]

/**
 * 一条消息的正文文本（多模态数组只拼文本片段）。
 *
 * 线上下发的一般是字符串，但 `content` 允许是 `[{type:'text',text}]` 这种数组；判定要
 * 与产品侧 `request-invariant.ts` 的 `contentText` 同口径，否则换个形状就漏摘——漏摘的
 * 表现是「偶尔 409」，比稳定红难查得多。
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const text = (part as { text?: unknown }).text
    if (typeof text === 'string') texts.push(text)
  }
  return texts.join('\n')
}

/**
 * 这条是不是「运行时注入段」（尾部追加、正文依赖外部状态的 user 消息）。
 *
 * 判据与产品侧 `request-invariant.ts:146-149` 逐字一致：只认 `role === 'user'`，正文含任一
 * 标记。只对 user 放宽是刻意的——同样的字串出现在 system 或 tool 消息里仍是正文，照旧进
 * hash（否则模型输入里真有内容变化会被放过）。
 */
function isRuntimeInjection(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false
  const { role, content } = message as { role?: unknown; content?: unknown }
  if (role !== 'user') return false
  const text = contentText(content)
  return RUNTIME_INJECTION_MARKERS.some((marker) => text.includes(marker))
}

/**
 * 算一段请求消息的形状指纹，形如 `sha256:<64 位小写十六进制>`。
 *
 * 参数故意收 `unknown`：调用方可能在验证一个还没解析过的请求体，这里只要求它是数组，
 * 元素形状交给 `JSON.stringify` 原样表达。数组以外一律抛错——传错类型时静默算出一个
 * 空数组的 hash，会让「所有请求看起来都一样」，恰好绕过这段校验要防的事。
 *
 * 唯一的放宽：先按 {@link RUNTIME_INJECTION_MARKERS} 摘掉运行时注入段（整条消息，与产品侧
 * `stripRuntimeInjections` 同口径），再对剩下的 messages 整段序列化取 sha256。**不截断、
 * 不改写、不排序**其余任何消息：任何一处正文变化仍然会改变指纹。
 */
export function hashChatMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    throw new TypeError('hashChatMessages：messages 必须是数组')
  }
  // 摘掉易变段之后再序列化：位置（第几条）会跟着变，但录制端与回放端跑的是同一个函数，
  // 两侧摘法一致，指纹因此可比。留下的消息一条都不动。
  const stable = messages.filter((message) => !isRuntimeInjection(message))
  const payload = JSON.stringify(stable)
  // JSON.stringify 对含 BigInt / 循环引用的结构会抛错，对 undefined 返回 undefined。
  // 后者不该被当成「空请求」的合法指纹：那是调用方传错了，不是一条空消息。
  if (payload === undefined) {
    throw new TypeError('hashChatMessages：messages 序列化后是 undefined（不是数组？）')
  }
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}
