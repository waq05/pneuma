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
 * ## 为什么是「整段 messages 的 JSON 文本」
 *
 * `requestHash` 要挡的事故是「代码改了导致请求形状变化，回放却照样通过」。请求形状里
 * 真正影响模型输入的就是 messages（system 提示、历史、工具结果）。只 hash 用户可见的
 * 正文会漏掉系统提示与工具 schema 的变化，而那两类恰恰是改代码最容易动到的地方。
 * 取 JSON 文本而不是结构化摘要，是因为它在两层之间不依赖任何字段顺序约定：录制端把
 * **线上实际发出去的那一份 messages** 原样写进 jsonl，回放端把收到的同一份再序列化一次。
 *
 * @module dsc/tests/support/hash
 */
import { createHash } from 'node:crypto'

/**
 * 算一段请求消息的形状指纹，形如 `sha256:<64 位小写十六进制>`。
 *
 * 参数故意收 `unknown`：调用方可能在验证一个还没解析过的请求体，这里只要求它是数组，
 * 元素形状交给 `JSON.stringify` 原样表达。数组以外一律抛错——传错类型时静默算出一个
 * 空数组的 hash，会让「所有请求看起来都一样」，恰好绕过这段校验要防的事。
 */
export function hashChatMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    throw new TypeError('hashChatMessages：messages 必须是数组')
  }
  const payload = JSON.stringify(messages)
  // JSON.stringify 对含 BigInt / 循环引用的结构会抛错，对 undefined 返回 undefined。
  // 后者不该被当成「空请求」的合法指纹：那是调用方传错了，不是一条空消息。
  if (payload === undefined) {
    throw new TypeError('hashChatMessages：messages 序列化后是 undefined（不是数组？）')
  }
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}
