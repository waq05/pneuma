/**
 * 注释与字符串遮罩：把不该当代码看的部分换成空格，长度与换行位置原样保留，
 * 于是「命中位置」直接按原文数行号即可，不会因为遮罩而错行。
 *
 * 为什么不用正则一把梭：`//` 会出现在字符串、正则字面量、URL 里；`'` 在 JSX 文本
 * （`Don't`）里也会骗过按行扫描；模板串还能嵌套（`${x.map((y) => `<li>${y}</li>`)}`）。
 * 这里按字符走一遍：单双引号只在「JS 语法位置」才算字符串开头（F2：前一个非空字符是
 * `=` `(` `,` `:` `[` `!` `&` `|` `?` `+` `-` `*` `/` `%` `<` `>` `~` `^` `;` `{` 之一、
 * 文件开头，或前面是 `return` / `from` 这类关键字；
 * JSX 文本里的撇号不算），串只在同一行内闭合；模板串允许跨行且递归处理 `${...}`
 * 里的代码（里面的注释照样抹、里面的字符串照样按参数处理），正则字面量按「前一个
 * 有效字符」猜。注释与串的定界符位置都保留。
 *
 * 已知覆盖不到（别当成已覆盖）：同一行内两个以上 JSX 文本撇号仍可能配对错；
 * `${...}` 里嵌 JSX 文本的撇号没做语法位置判断；这些记为 §Q2「本项不做」的延伸。
 *
 * 两个导出对应两种用法：
 * - `maskStringsAndComments()`：串内容一起抹掉，只留引号 —— core-ui 先用它定位
 *   `import` / `export ... from` / `require` / `import()` 的语法位置，再回原文取说明符；
 *   whitelist 也用它定位 `.invoke(...)`，首参再回原文取（字符串里的调用不算调用）。
 * - `maskComments()`：只抹注释，串内容原样保留 —— 要整体读一段文本时用（如解析
 *   `INVOKABLE_METHODS` 数组字面量）。
 *
 * @module scripts/law/mask
 */

/** 这些字符后面出现的 `/` 按正则字面量起始处理（除法不会紧跟在它们后面）。 */
const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%<>~^/'
/** `return /x/` 这类关键字后面的 `/` 也按正则起始。 */
const REGEX_KEYWORDS = /(?:return|typeof|case|delete|void|in|of|new|instanceof|do|else|yield|await)$/
/** 这些字符后面出现的引号才算字符串起始（与 F2 的口径一致，见上方说明）。 */
const STRING_PREFIX_CHARS = '(=,:[!&|?+-*/%<>~^;{'
/** 这些关键字后面出现的引号才算字符串起始。 */
const STRING_KEYWORDS =
  /(?:return|typeof|case|delete|void|in|of|new|instanceof|do|else|yield|await|throw|from|import|export|default|as|extends|implements|satisfies|keyof)$/

/**
 * 引号算不算字符串开头：只有「JS 语法位置」才算。
 * F2：JSX 文本里的撇号（`<p>Don't …`）前一个非空字符是字母，不是语法位置，
 * 不能当字符串开头——否则它会跟同一行后面 `.invoke('x')` 的引号配对，把调用遮掉。
 */
function stringStartAllowed(prev, prevWord) {
  if (prev === '') return true
  if (STRING_PREFIX_CHARS.includes(prev)) return true
  return STRING_KEYWORDS.test(prevWord)
}

/** 把 src[from, to) 里的非换行字符改成空格（写进 out）。 */
function blank(out, src, from, to) {
  for (let k = from; k < to && k < src.length; k++) if (src[k] !== '\n') out[k] = ' '
}

/** 引号串的结束位置（开区间右界）；行内不闭合返回 -1，表示这不是一个串。 */
function stringEnd(src, from, allowNewline) {
  const quote = src[from]
  let j = from + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === quote) return j + 1
    if (c === '\n' && !allowNewline) return -1
    j++
  }
  return -1
}

/** 正则字面量的结束位置；跨行返回 -1（正则不能跨行）。 */
function regexEnd(src, from) {
  let j = from + 1
  let inClass = false
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n') return -1
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j++
      while (j < src.length && /[a-z]/i.test(src[j])) j++
      return j
    }
    j++
  }
  return -1
}

/**
 * 模板串：内容按 maskStrings 处理，`${...}` 里的表达式当代码继续扫（递归），
 * 返回闭合反引号之后的位置。
 */
function templateEnd(src, from, maskStrings, out) {
  let j = from + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      if (maskStrings) blank(out, src, j, j + 2)
      j += 2
      continue
    }
    if (c === '`') return j + 1
    if (c === '$' && src[j + 1] === '{') {
      j = expressionEnd(src, j + 2, maskStrings, out)
      continue
    }
    if (maskStrings) blank(out, src, j, j + 1)
    j++
  }
  return src.length
}

/** `${...}` 里的表达式：按代码扫到配平的 `}`，里面的注释 / 字符串 / 模板照规则处理。 */
function expressionEnd(src, from, maskStrings, out) {
  let j = from
  let depth = 1
  while (j < src.length) {
    const c = src[j]
    const c2 = src[j + 1]
    if (c === '/' && c2 === '/' && src[j - 1] !== '\\') {
      let end = src.indexOf('\n', j)
      if (end < 0) end = src.length
      blank(out, src, j, end)
      j = end
      continue
    }
    if (c === '/' && c2 === '*' && src[j - 1] !== '\\') {
      const close = src.indexOf('*/', j + 2)
      const end = close < 0 ? src.length : close + 2
      blank(out, src, j, end)
      j = end
      continue
    }
    if (c === "'" || c === '"') {
      const end = stringEnd(src, j, false)
      if (end < 0) {
        j++
        continue
      }
      if (maskStrings) blank(out, src, j + 1, end - 1)
      j = end
      continue
    }
    if (c === '`') {
      j = templateEnd(src, j, maskStrings, out)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return src.length
}

function mask(src, maskStrings) {
  const out = src.split('')
  const n = src.length
  let i = 0
  let prev = ''
  let prevWord = ''
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    // 注释：前一个字符是反斜杠时按转义处理（`/\/\//` 这类正则里的 `//` 不是注释）。
    if (c === '/' && c2 === '/' && src[i - 1] !== '\\') {
      let j = src.indexOf('\n', i)
      if (j < 0) j = n
      blank(out, src, i, j)
      i = j
      continue
    }
    if (c === '/' && c2 === '*' && src[i - 1] !== '\\') {
      const close = src.indexOf('*/', i + 2)
      const j = close < 0 ? n : close + 2
      blank(out, src, i, j)
      i = j
      continue
    }
    if ((c === "'" || c === '"') && stringStartAllowed(prev, prevWord)) {
      const end = stringEnd(src, i, false)
      if (end < 0) {
        i++
        continue
      }
      if (maskStrings) blank(out, src, i + 1, end - 1)
      i = end
      prev = c
      prevWord = ''
      continue
    }
    if (c === '`') {
      i = templateEnd(src, i, maskStrings, out)
      prev = '`'
      prevWord = ''
      continue
    }
    if (c === '/' && (REGEX_PREFIX_CHARS.includes(prev) || REGEX_KEYWORDS.test(prevWord))) {
      const end = regexEnd(src, i)
      if (end >= 0) {
        i = end
        prev = '/'
        prevWord = ''
        continue
      }
    }
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) prevWord += c
      else prevWord = ''
      prev = c
    }
    i++
  }
  return out.join('')
}

export function maskComments(src) {
  return mask(src, false)
}

export function maskStringsAndComments(src) {
  return mask(src, true)
}

/** 第 index 个字符所在的行号（1 起）；遮罩不改长度，所以对原文也对遮罩文本都对。 */
export function lineAt(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++
  return line
}
