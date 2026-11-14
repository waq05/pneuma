/**
 * 壳侧 `formatBytes` 与宿主那份的输出等价（迁自 `scripts/ui-bytes-test.mjs` 第 [2] 段）。
 *
 * 原探针的背景：这个函数曾有五份拷贝（附件、暂存清理、输入区附件、对话流附件行、
 * 文件树），单位与小数位各不相同。合并后按「宿主一份（`src/core/bytes.ts`）+ 壳一份
 * （本目录 `sizes.ts`）」拆——分层不许互相 import，两份一旦漂移，同一个界面出现两种
 * 写法。原探针靠逐字比对函数体钉住；这里换成行为口径：**同一批样本（含 0 / 负数 /
 * NaN / Infinity 边界与 TB 档）两侧真跑必须同串**。core 侧的逐档格式另有
 * `src/core/bytes.spec.ts` 全量钉着，两侧等价就把它升格成两侧的共同契约。
 *
 * 没迁的（原探针第 [1]、[3] 段，见交付报告缺口清单）：
 *   - [1] 函数体逐字相同——文本级比对，无行为接缝可替；输出等价是它的行为化近似，
 *     但「注释外漂移」抓不到（比如加了死代码）；
 *   - [3] 全仓没有第三份拷贝——纯仓库扫描，属源码钉，主线统一登记 backlog。
 *
 * @module dsc-ui-primitives/ui/sizes.spec
 */
import { describe, expect, test } from 'vitest'
import { formatBytes as hostFormatBytes } from '../../../core/bytes.js'
import { formatBytes } from './sizes.js'

/** 两侧必须给出同一串的全部样本：逐档边界 + 三个非有限/负数边界。 */
const SAMPLES: readonly number[] = [
  0, 1, 999, 1023, 1024, 1536, 10 * 1024, 1024 * 1024, 10 * 1024 * 1024, 1024 * 1024 * 1024,
  1.5 * 1024 * 1024 * 1024, 1024 * 1024 * 1024 * 1024, 1.5 * 1024 * 1024 * 1024 * 1024,
  -1, Number.NaN, Number.POSITIVE_INFINITY,
]

describe('两侧 formatBytes 输出等价（宿主 src/core/bytes.ts ↔ 壳 sizes.ts）', () => {
  test('全部样本两侧同串（含 0 / 负数 / NaN / Infinity 边界）', () => {
    const differ = SAMPLES.filter((value) => hostFormatBytes(value) !== formatBytes(value))
    expect(differ).toEqual([])
  })

  test('逐档格式：B / KB / MB / GB / TB 全在两侧一致', () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, '0 B'],
      [512, '512 B'],
      [1023, '1023 B'],
      [1024, '1 KB'],
      [1536, '1.5 KB'],
      [10 * 1024, '10 KB'],
      [1024 * 1024, '1 MB'],
      [1.5 * 1024 * 1024, '1.5 MB'],
      [1024 * 1024 * 1024, '1 GB'],
      // TB 这一档是 2026-11-12 加的：doctor 的磁盘占用会真的报到 TB 级。
      [1024 * 1024 * 1024 * 1024, '1 TB'],
      [1.5 * 1024 * 1024 * 1024 * 1024, '1.5 TB'],
    ]
    for (const [bytes, expected] of cases) {
      expect(formatBytes(bytes), `${String(bytes)} 字节`).toBe(expected)
      expect(hostFormatBytes(bytes), `宿主 ${String(bytes)} 字节`).toBe(expected)
    }
  })

  test('负数与非有限数给破折号（界面上不出现 -1 B / NaN）', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—')
    expect(hostFormatBytes(-1)).toBe('—')
    expect(hostFormatBytes(Number.NaN)).toBe('—')
    expect(hostFormatBytes(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
