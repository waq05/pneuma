/**
 * `core/secrets.ts` 超长输入分段遮红的补齐：4MB 以上走 `redactLong`，
 * 按 1MB 且尽量切在换行上分段，密钥不能因为跨段漏遮。
 *
 * 为什么单独一个文件：现有 `secrets.spec.ts` 只钉了 4MB 以内的快路径，
 * `redactLong` 整段（原 83-101 行）从未执行过。造 5MB 级字符串约 50ms，可接受。
 *
 * @module dsc/core/w12-secrets-long.spec
 */
import { expect, test } from 'vitest'
import { redactText } from './secrets.js'

/** 4MB 快路径的门槛；超过它才走分段。 */
const LONG_THRESHOLD = 4_000_000

/** 造一段多行长文本：每行 `line` 字符 + 换行。 */
function lines(line: number, count: number): string {
  return `${'a'.repeat(line)}\n`.repeat(count)
}

test('5MB 多行文本：分段后两处密钥都遮，kinds 不重复', () => {
  const head = 'sk-abcdefghijklmnop1234'
  const tail = 'sk-zyxwvutsrqponm9876'
  const body = `${head}\n${lines(1023, 4096)}\n${tail}`
  expect(body.length).toBeGreaterThan(LONG_THRESHOLD)
  const result = redactText(body)
  expect(result.text).not.toContain(head)
  expect(result.text).not.toContain(tail)
  expect(result.replaced).toBe(2)
  expect(result.kinds).toEqual(['deepseek-openai-key'])
  // 占位出现两次，说明两处都在各自的段里被替换。
  expect(result.text.match(/«redacted:secret»/g)).toHaveLength(2)
})

test('5MB 单行（没有换行可切）：仍能遮住段内密钥并保留全文长度结构', () => {
  const head = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  const body = head + '-'.repeat(LONG_THRESHOLD + 500_000)
  const result = redactText(body)
  expect(result.text).not.toContain(head)
  expect(result.kinds).toEqual(['github-token'])
  // 只替换密钥本身，其余字符数量保持不变。
  expect(result.text.length).toBe(body.length - head.length + '«redacted:secret»'.length)
})

test('刚过 4MB 门槛的文本也走分段，且不丢头部内容', () => {
  const body = `prefix-sentinel\n${lines(999, Math.ceil((LONG_THRESHOLD + 1) / 1000))}`
  expect(body.length).toBeGreaterThan(LONG_THRESHOLD)
  const result = redactText(body)
  expect(result.text.startsWith('prefix-sentinel\n')).toBe(true)
  expect(result.replaced).toBe(0)
  expect(result.text).toBe(body)
})

