/**
 * 凭据脱敏的单位测试。
 *
 * 为什么这组用例值得钉：redact 的输入是整段日志、输出还是整段日志，肉眼比对时
 * 「密钥消失了」与「密钥还在」在长文本里几乎看不出区别。所以每条用例都取**真实的
 * 密钥外形**（`Authorization:` 头、裸 Bearer、`api_key=`、`sk-` 前缀），断言两件事：
 * 原文搜不到了，并且紧挨着的正常文本还在。只钉「输出里出现 ***」是不够的——把整段
 * 文本替换成 '***' 也能过。
 *
 * 跳过：没有 I/O、没有全局状态，整个模块都是纯函数。
 *
 * @module dsc/core/redact.spec
 */
import { expect, test } from 'vitest'
import { redact } from './redact.js'

const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'

test('Authorization 头整条值被抹掉，连 Bearer 字面量一起', () => {
  // 为什么连 Bearer 一起吃掉：只抹 token 会留下一个光秃秃的 `Authorization: Bearer ***`，
  // 读日志的人分不清「这行本来有 token」还是「这行是脱敏后的」。
  const out = redact(`Authorization: Bearer ${TOKEN}\nGET /v1/models`)
  expect(out).not.toContain(TOKEN)
  expect(out).not.toContain('Bearer')
  expect(out).toContain('Authorization: ***')
})

test('Authorization 只吃到行尾：Basic 凭证也被抹，下一行原样保留', () => {
  // 用 Basic 而不是 Bearer 来钉这条，是因为 Bearer 会被第二条规则兜住——只测 Bearer
  // 时删掉第一条规则也照样「看起来抹掉了」。Basic 的 base64 只有第一条规则认得。
  const basic = 'dXNlcjpwYXNzd29yZA=='
  const out = redact(`Authorization: Basic ${basic}\n下一行：请求成功，耗时 120ms`)
  expect(out).not.toContain(basic)
  expect(out).toContain('下一行：请求成功，耗时 120ms')
})

test('没有 header 前缀的裸 Bearer token 也被抹，但保留 Bearer 这个词', () => {
  // 请求体里常见 `"token": "Bearer xxx"` 这种拼出来的字符串；此处留 Bearer 是为了
  // 让读者知道原文的认证方式，抹掉的只有凭证本体。
  const out = redact('请求体 {"token":"Bearer abcdefgh12345678"} 结束')
  expect(out).not.toContain('abcdefgh12345678')
  expect(out).toBe('请求体 {"token":"Bearer ***"} 结束')
})

test('Bearer 后不足 8 位的短串不抹（长度门槛）', () => {
  // 门槛 8 位是故意的：'Bearer 空' 这类多半是占位符或变量名，抹了会让正文读不懂。
  // 这条同时挡住「为了多抹而把门槛降到 1」的改动。
  expect(redact('Bearer abc')).toBe('Bearer abc')
})

test('Bearer 大小写不敏感', () => {
  // HTTP 头名本身不区分大小写，网关日志里小写 `bearer` 很常见。
  expect(redact('bearer abcdefgh1234')).toBe('bearer ***')
})

test('查询串里的 api_key 值被抹，URL 其余部分保留', () => {
  // 拼在 URL 里的密钥是真实事故形态（日志、报错里最常漏的就是它）。
  const out = redact('GET https://api.example.com/v1/x?api_key=abcdefgh1234&page=2 返回 401')
  expect(out).not.toContain('abcdefgh1234')
  expect(out).toBe('GET https://api.example.com/v1/x?api_key=***&page=2 返回 401')
})

test('JSON 里的 apiKey 双引号形态被抹，引号配平不破', () => {
  // 把闭合引号也吃掉的话，脱敏后的日志会变成没法解析的 JSON，事后没法复盘请求体。
  expect(redact('{"apiKey": "abcdefgh1234"}')).toBe('{"apiKey": "***"}')
})

test('access_token 与 secret_key 两种键名都命中', () => {
  const out = redact('access_token=aaaaaaaa1111\nsecret_key=bbbbbbbb2222')
  expect(out).not.toContain('aaaaaaaa1111')
  expect(out).not.toContain('bbbbbbbb2222')
  expect(out).toBe('access_token=***\nsecret_key=***')
})

test('sk- 前缀的密钥被抹，紧挨着的中文正文不动', () => {
  // 这条同时钉住「不误伤」：只替换 token 本体，前后的正文一字不差。
  const out = redact(`配置里的密钥 ${TOKEN} 已失效，请重新登录`)
  expect(out).not.toContain(TOKEN)
  expect(out).toBe('配置里的密钥 sk-*** 已失效，请重新登录')
})

test('一条文本里的两个 sk- 密钥都被抹，不只有第一个', () => {
  // 正则漏了 g 标志时只会抹第一处，而一条日志里同时带新旧两个 key 很常见。
  const out = redact('old=sk-aaaaaaaa1111 new=sk-bbbbbbbb2222 end')
  expect(out).not.toContain('aaaaaaaa1111')
  expect(out).not.toContain('bbbbbbbb2222')
  expect(out).toBe('old=sk-*** new=sk-*** end')
})

test('sk- 后紧跟标点时只吃 token，标点留下', () => {
  // 字符类不该把逗号、括号吃进去，否则日志的句子结构会被破坏。
  expect(redact('token=sk-abcdefgh12345, 然后换行')).toBe('token=sk-***, 然后换行')
})

test('F10：大写 SK- 开头的密钥也被抹', () => {
  // 加 i 标志前只认小写 sk-，大写写法的真实密钥漏网。
  expect(redact('OPENAI_KEY=SK-abcdefghijklmnop1234')).toBe('OPENAI_KEY=sk-***')
})

test('F10：词边界控制误伤——task-12345678 里的 sk- 不命中', () => {
  // 加 i 标志会把更多正常文本卷进来；词边界把这层误伤挡回去（这条同时钉住
  // 「行为收窄」：改前 'sk-12345678' 会被误抹成 'ta'+sk-***，改后原样保留）。
  expect(redact('task-12345678 已完成')).toBe('task-12345678 已完成')
})

test('F10：AWS 访问键 ID（AKIA/ASIA + 16 位）被抹，前后正文不动', () => {
  const out = redact('aws_access_key_id=AKIAIOSFODNN7EXAMPLE aws_session_token=ASIAIOSFODNN7EXAMPLE')
  expect(out).toBe('aws_access_key_id=*** aws_session_token=***')
})

test('F10：GitHub token（ghp_ 系）被抹，前缀外形保留', () => {
  const out = redact('token: ghp_abcdefghijklmnopqrstuvwxyz012345')
  expect(out).toBe('token: gh***')
  // 词边界：嵌在词里的 ghp_ 不是 token（highp_…）不该动。
  expect(redact('highp_abcdefghijklmnopqrstuvwxyz012345 不动')).toBe('highp_abcdefghijklmnopqrstuvwxyz012345 不动')
})

test('F10：aws_secret_access_key 赋值形态被抹（值里的 / 也算值的一部分）', () => {
  const out = redact('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
  expect(out).toBe('aws_secret_access_key=***')
})

test('F10：裸 JWT（无 Bearer 前缀的三段式）被抹', () => {
  const out = redact('id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV')
  expect(out).toBe('id_token=***')
})

test('短值不抹：api_key=abc 原样返回', () => {
  // 与 Bearer 的门槛同一条：'abc' 更可能是占位符。这条防的是「宁可多抹」被写到
  // 把正常单词也抹掉的程度。
  expect(redact('api_key=abc')).toBe('api_key=abc')
})

test('纯正文里出现 Bearer 这个词但后面没有 token 时不动', () => {
  // 'Bearer' 是 HTTP 规范里的一个词，正文里讨论它会正常出现；没有凭证外形就不该改。
  expect(redact('请求头缺 Bearer，返回 401')).toBe('请求头缺 Bearer，返回 401')
})

test('空串原样返回', () => {
  expect(redact('')).toBe('')
})

test('重复调用幂等：已抹过的文本再抹一次结果不变', () => {
  // 日志会被多次经过（写文件、导诊断包、再脱敏）；不幂等就会越抹越长或吃掉正文。
  const once = redact(`Authorization: Bearer ${TOKEN}\napi_key=abcdefgh1234`)
  expect(redact(once)).toBe(once)
})
