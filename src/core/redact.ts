/**
 * 凭据脱敏：一份实现，谁要抹就用这一份。
 *
 * **为什么从 `packages/log` 提到 core**：诊断包也要抹，而两份实现早晚会分叉——分叉那天
 * 就是「日志抹了、包里没抹」的事故。规则只该有一处。
 *
 * 抹的是**外形**，不是字段名：日志与导出的正文都是拼出来的字符串，没有「这个字段叫
 * apiKey」这种结构可用。宁可多抹。
 *
 * @module dsc/core/redact
 */

/**
 * 四类凭据外形，**顺序有讲究**：
 *
 * 1. 先吃掉整条 `Authorization:` 的值（到行尾为止）。放第一位，是因为后面的
 *    `Bearer` 规则只抹 token，留下一个光秃秃的 `Bearer` 反而更难读；
 * 2. 再抹裸的 `Bearer <token>`（请求体里常见，没有 header 前缀）；
 * 3. `api_key=…` / `apiKey: "…"` 这类键值对；
 * 4. OpenAI 系的 `sk-` 前缀。
 *
 * 长度门槛 8 位：太短的多半是变量名或占位符，抹了反而看不出正文在说什么。
 */
const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(Authorization\s*:\s*)[^\r\n]+/gi, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [
    /((?:api[_-]?key|apiKey|access[_-]?token|accessToken|secret[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1***',
  ],
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
]

/**
 * 把一段文本里的凭据换成 `***`。
 *
 * 纯函数、可重复调用：已经抹过的 `***` 不会再次命中（长度不足 8 位）。
 *
 * @param text 任意文本。
 * @returns 同一段文本，凭据位置已替换。
 */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement)
  return out
}
