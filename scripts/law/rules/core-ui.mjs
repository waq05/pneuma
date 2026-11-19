/**
 * 铁律 1：`src/core/**` 不许依赖界面层（ink / react / react-dom / electron）。
 *
 * 判据：剥掉注释与字符串内容后，找四种静态写法的说明符——
 * `import ... from '<说明符>'`、`export ... from '<说明符>'`、`require('<说明符>')`、
 * `import('<说明符>')`。说明符命中上面四个包（含子路径，如 `react-dom/client`）即违规。
 * 只扫 `.ts`（`src/core` 是内核，没有 JSX 文件）。
 *
 * 扫描面与判定语义见 docs/research/harness-engineering/numa/design/02-quality-cicd.md §Q2。
 *
 * @module scripts/law/rules/core-ui
 */

import { lineAt, maskStringsAndComments } from '../mask.mjs'

/** 允许的前缀：包名本身或它的子路径；`react-i18next` 这类同前缀包不算。 */
const UI_PACKAGE = /^(?:ink|react|react-dom|electron)(?:\/|$)/

/**
 * 四种写法。最后一个捕获组是说明符的定界引号；说明符内容从原文取
 * （遮罩把内容抹了，但引号还在原位，长度没变）。
 */
const FORMS = [
  { kind: 'import', re: /\bimport\s+[^;'"]*?\bfrom\s*(['"])/g },
  { kind: 'import（副作用）', re: /\bimport\s*(['"])/g },
  { kind: 'export from', re: /\bexport\s+[^;'"]*?\bfrom\s*(['"])/g },
  { kind: 'require', re: /\brequire\s*\(\s*(['"])/g },
  { kind: '动态 import', re: /\bimport\s*\(\s*(['"])/g },
]

function check(ctx) {
  const violations = []
  let files = 0
  for (const file of ctx.listFiles('src/core', { exts: ['.ts'] })) {
    files++
    const src = ctx.readFile(file)
    const code = maskStringsAndComments(src)
    for (const form of FORMS) {
      form.re.lastIndex = 0
      let m
      while ((m = form.re.exec(code))) {
        const quote = m[m.length - 1]
        const quoteAt = m.index + m[0].length - 1
        const end = src.indexOf(quote, quoteAt + 1)
        if (end < 0) continue
        const specifier = src.slice(quoteAt + 1, end)
        if (!UI_PACKAGE.test(specifier)) continue
        violations.push({
          file,
          line: lineAt(src, m.index),
          message: `${form.kind} ${JSON.stringify(specifier)}：src/core 不许依赖界面层，改用 src/contract 或事件`,
        })
      }
    }
  }
  return { violations, stats: { files, hits: violations.length } }
}

export default {
  id: 'core-ui',
  title: 'src/core 不出现 ink / react / react-dom / electron',
  severity: 'error',
  check,
}
