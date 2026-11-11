/**
 * `core/http-debug` 的探针：追踪号从哪几个头取、什么时候宁可不取。
 *
 * 为什么值得单独一条：这一段错的方式很隐蔽——取错了头，用户贴过来的号在服务端查不到；
 * 取太松（比如接受换行），日志会被切成两行，贴进 issue 还可能变成注入。
 *
 * @module dsc/scripts/http-debug-test
 */
import { requestDebugContext, formatRequestDebug } from '../lib/core/http-debug.js'

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

/**
 * 造一个只实现 `get()` 的桩。
 *
 * 为什么不用真的 `Headers`：它的构造器会拒绝带换行的值，而「带换行的号必须丢掉」
 * 正是这里要验的一条。函数只用到 `get()`，桩就够。
 */
const withHeaders = (pairs) => {
  const map = new Map(pairs.map(([name, value]) => [name.toLowerCase(), value]))
  return { get: (name) => map.get(name.toLowerCase()) ?? null }
}

check('认 x-request-id', requestDebugContext(withHeaders([['x-request-id', 'req_abc-123']]))?.requestId === 'req_abc-123')
check(
  '没有 x-request-id 时退到 x-openai-request-id',
  requestDebugContext(withHeaders([['x-openai-request-id', 'openai_42']]))?.requestId === 'openai_42',
)
check('认 cf-ray', requestDebugContext(withHeaders([['cf-ray', '8f1a2b3c4d5e-HKG']]))?.cfRay === '8f1a2b3c4d5e-HKG')
check('两个都有时都带上', (() => {
  const debug = requestDebugContext(withHeaders([['x-request-id', 'a1'], ['cf-ray', 'b2']]))
  return debug?.requestId === 'a1' && debug?.cfRay === 'b2'
})())
check('一个都没有就返回 undefined', requestDebugContext(withHeaders([['content-type', 'application/json']])) === undefined)
check('超长的不收（防止异常值把日志撑爆）', requestDebugContext(withHeaders([['x-request-id', 'x'.repeat(200)]])) === undefined)
check('带换行的不收（防止切日志 / 注入）', requestDebugContext(withHeaders([['x-request-id', 'abc\ndef']])) === undefined)
check('带空格的不收', requestDebugContext(withHeaders([['x-request-id', 'abc def']])) === undefined)

check('拼文案带括号', formatRequestDebug({ requestId: 'req_1' }) === '（request-id req_1）')
check('两个号用逗号连', formatRequestDebug({ requestId: 'req_1', cfRay: 'r2' }) === '（request-id req_1，cf-ray r2）')
check('没有号时是空串', formatRequestDebug(undefined) === '')

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
