/**
 * 属性测试六条（设计 P7 第 21 项）：用 fast-check 随机生成输入，钉住几个纯函数的**不变量**。
 *
 * ## 为什么这六处值得属性测试
 *
 * 它们都被「代码写对、边界写错」坑过，而且输入空间是字符串/数字的组合爆炸，例子测试只
 * 能覆盖手挑的那十几个：脱敏的正则边界（F10 的 `SK-` 漏抹）、cmd 引号的往返、路径包含
 * 判定、slug 的字符集、命令切段、数字收敛。属性测试在这里不是替代例子测试，而是补上
 * 「随机输入下不变量仍然成立」这一层。
 *
 * ## 为什么每条都包一层 `fc.assert`
 *
 * 不装 `@fast-check/vitest` 适配器：多一个包只为省几行包装，不值得。`fc.assert` 失败时
 * 会打印反例与 seed，与 vitest 的报错叠加仍然读得懂。样本数用 fast-check 缺省（100）。
 *
 * ## 属性只写可证伪的不变量
 *
 * 往返、幂等、上下界、字符集、顺序——写「等于某个具体值」就又回到例子测试了。每条
 * 不变量后面的注释写清它防的是哪一类错。
 *
 * @module dsc/core/properties.spec
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { join, resolve } from 'node:path'
import { clampInt, clampIntIn } from './clamp.js'
import { quoteForCmd } from './shell-quote.js'
import { redact } from './redact.js'
import { splitSegments } from './command-policy.js'
import { isInsideCwd } from './path-policy.js'
import { slugOf } from '../packages/superagent/adapters/worktree.js'

describe('属性：clampInt 的上下界与幂等', () => {
  test('有限数 → 落在 [min, max] 内的整数，再夹一次不变', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: -50, max: 0 }),
        fc.integer({ min: 1, max: 50 }),
        (value, min, max) => {
          const once = clampInt(value, min, max, 7)
          expect(Number.isInteger(once)).toBe(true)
          expect(once).toBeGreaterThanOrEqual(min)
          expect(once).toBeLessThanOrEqual(max)
          // 幂等：夹过的值再夹一次不该动。否则上层每轮重读配置都会漂一点。
          expect(clampInt(once, min, max, 7)).toBe(once)
        },
      ),
    )
  })

  test('Number() 后不是有限数 → 原样取缺省', () => {
    fc.assert(
      fc.property(
        // 判据与实现同源：先 Number(value) 再判有限性。注意 `null`/`''` 会经 Number 变成 0
        // ——这是实现口径（配置里的空值按 0 处理），不是漏判，所以不放进反例集。
        fc.oneof(fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity), fc.constant('abc')),
        (value) => {
          expect(clampInt(value, 0, 10, 4)).toBe(4)
          expect(clampIntIn(value, { min: 0, max: 10 }, 4)).toBe(4)
        },
      ),
    )
  })
})

describe('属性：quoteForCmd 的引号往返', () => {
  /** 把 quoteForCmd 的结果还原回原串（测试侧的逆运算，不 export 到产品里）。 */
  const unquote = (quoted: string): string =>
    quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')
      ? quoted.slice(1, -1).replace(/\\"/g, '"')
      : quoted

  test('任何字符串过一遍加引号、再按 cmd 规则还原，与原文逐字节相同', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(unquote(quoteForCmd(value))).toBe(value)
      }),
    )
  })

  test('不含空白与 cmd 元字符的串不加引号（加了会被多套一层）', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_./:=-]*$/), (value) => {
        expect(quoteForCmd(value)).toBe(value)
      }),
    )
  })

  test('含空白或元字符的串一定被双引号包住', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        fc.pre(/[\s"&|<>^()]/.test(value))
        const quoted = quoteForCmd(value)
        expect(quoted.startsWith('"')).toBe(true)
        expect(quoted.endsWith('"')).toBe(true)
      }),
    )
  })
})

describe('属性：redact 的幂等与形状覆盖', () => {
  test('抹一次与抹两次结果相同（已抹的 *** 不再二次命中）', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const once = redact(value)
        expect(redact(once)).toBe(once)
      }),
    )
  })

  test('任意形态的 sk- / SK- 密钥都会被抹掉', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9]{8,32}$/), (suffix) => {
        for (const prefix of ['sk-', 'SK-']) {
          const masked = redact(`前文 ${prefix}${suffix} 后文`)
          expect(masked).not.toContain(`${prefix}${suffix}`)
          expect(masked).toContain('***')
        }
      }),
    )
  })

  test('任意 gh[pousr]_ token 都会被抹掉', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9]{20,40}$/), (body) => {
        expect(redact(`ghp_${body}`)).not.toContain(`ghp_${body}`)
      }),
    )
  })

  test('任意 AKIA/ASIA 访问键都会被抹掉', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-Z]{16}$/), (body) => {
        expect(redact(`AKIA${body}`)).not.toContain(`AKIA${body}`)
      }),
    )
  })

  test('词边界不误伤：task-数字 这类普通标识不被当成 sk- 密钥', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{2,6}$/), fc.stringMatching(/^[0-9]{8,12}$/), (word, digits) => {
        const text = `${word}-${digits}`
        // 只有 word 恰好是 sk 时才该命中；其余原样保留。
        expect(redact(text)).toBe(word === 'sk' ? 'sk-***' : text)
      }),
    )
  })
})

describe('属性：isInsideCwd 的包含关系', () => {
  const segments = fc.array(fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/), { minLength: 1, maxLength: 4 })

  test('工作目录下的任意子路径都判在内部', () => {
    fc.assert(
      fc.property(segments, (parts) => {
        const root = resolve('/dsc-property-root')
        expect(isInsideCwd(root, join(root, ...parts))).toBe(true)
      }),
    )
  })

  test('上跳一层再进目录判在外部（防 `..` 逃逸）', () => {
    fc.assert(
      fc.property(segments, fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/), (parts, escape) => {
        const root = resolve('/dsc-property-root')
        expect(isInsideCwd(root, join(root, '..', escape, ...parts))).toBe(false)
      }),
    )
  })

  test('`..名字` 开头的点是根内普通文件，不是父目录', () => {
    fc.assert(
      fc.property(segments, (parts) => {
        const root = resolve('/dsc-property-root')
        expect(isInsideCwd(root, join(root, `..${parts[0]}`))).toBe(true)
      }),
    )
  })
})

describe('属性：slugOf 的字符集与幂等', () => {
  test('输出的字符集只含 [A-Za-z0-9._-]，非空，且能当文件名用', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const slug = slugOf(value)
        expect(slug).toMatch(/^[A-Za-z0-9._-]+$/)
        // 头尾不许是 `.`/`-`：Windows 会吞尾点，git 不许 ref 以点结尾。
        expect(slug.startsWith('.')).toBe(false)
        expect(slug.startsWith('-')).toBe(false)
        expect(slug.endsWith('.')).toBe(false)
        expect(slug.endsWith('-')).toBe(false)
        expect(slug.length).toBeLessThanOrEqual(60)
      }),
    )
  })

  test('幂等：slug 再过一遍不变（拿 slug 当 name 再调一次是安全的）', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const once = slugOf(value)
        expect(slugOf(once)).toBe(once)
      }),
    )
  })
})

describe('属性：splitSegments 的切分不丢内容', () => {
  /** 不含任何分隔符、引号、括号、反引号、续行的「一条简单命令」。 */
  const simple = fc
    .array(fc.stringMatching(/^[A-Za-z0-9_.:/=+-]{1,12}$/), { minLength: 1, maxLength: 6 })
    .map((words) => words.join(' '))

  test('没有分隔符时恒为一段，原文与输入一致（不吞字符）', () => {
    fc.assert(
      fc.property(simple, (command) => {
        const segments = splitSegments(command)
        expect(segments).toHaveLength(1)
        expect(segments[0]!.raw).toBe(command)
        expect(segments[0]!.tokens.length).toBeGreaterThanOrEqual(1)
      }),
    )
  })

  test('带一个分隔符时切成两段，两段按序落位（不合并、不重排）', () => {
    fc.assert(
      fc.property(simple, fc.constantFrom(';', '&&', '||', '|', '\n'), (left, separator) => {
        const right = ['x', ...left.split(' ')].join(' ')
        const command = `${left}${separator}${right}`
        const segments = splitSegments(command)
        expect(segments.length).toBeGreaterThanOrEqual(2)
        const first = command.indexOf(segments[0]!.raw)
        const second = command.indexOf(segments[1]!.raw)
        expect(first).toBeGreaterThanOrEqual(0)
        expect(second).toBeGreaterThan(first)
      }),
    )
  })
})
