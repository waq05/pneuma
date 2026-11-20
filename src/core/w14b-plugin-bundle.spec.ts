/**
 * `core/plugin-bundle.ts` 的缺口补齐：坏 package.json、两套版本闸的「范围写得不对」、
 * peerDependencies 那条回退链、豁免名单纯判定。
 *
 * 全部是纯函数 + 临时目录，不起内核、不碰 `~/.dsc`。
 *
 * @module dsc/core/w14b-plugin-bundle.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  DSH_CONTRACT_VERSION,
  enginesProblem,
  exemptionMissProblem,
  pneumaEnginesProblem,
  readBundle,
  type Exemption,
} from './plugin-bundle.js'

const ROOT = mkdtempSync(join(tmpdir(), 'dsc-w14b-bundle-'))

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** 一个新包目录。 */
function bundleDir(manifest: unknown): string {
  const dir = mkdtempSync(join(ROOT, 'pkg-'))
  if (manifest !== undefined) {
    writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
  }
  return dir
}

describe('readBundle：坏清单按「没有清单」处理', () => {
  test('package.json 不是合法 JSON：返回 null，不抛', () => {
    expect(readBundle(bundleDir('{not json'))).toBeNull()
  })
})

describe('pneumaEnginesProblem：范围对不上', () => {
  test('engines.pneuma 要求更高的运行时：给一句带版本的原因', () => {
    // semver 7.8.5 的 satisfies 对坏范围只返回 false、不抛（catch 分支是防御，见报告）。
    const problem = pneumaEnginesProblem({ engines: { pneuma: '>=9.0.0' } })
    expect(problem).toContain('要求 Pneuma 运行时')
    expect(problem).toContain('当前契约是')
  })
})

describe('enginesProblem：dsh 版本闸的三条路', () => {
  test('没有 engines.dsh 时回退到 peerDependencies 里的 @deepseek-ai/dsh*', () => {
    expect(enginesProblem({ peerDependencies: { '@deepseek-ai/dsh-core': '0.2.1' } })).toBeNull()
    // 非字符串的 peer 范围先跳过，后面的字符串才认。
    expect(enginesProblem({ peerDependencies: { '@deepseek-ai/dsh-core': 1, '@deepseek-ai/dsh-llm': '0.2.2-rc.1' } })).toBeNull()
  })

  test('engines.dsh 是非法 comparator：退化为一句原因而不是抛', () => {
    const problem = enginesProblem({ engines: { dsh: '1.2.3.4' } })
    expect(problem).toContain('版本范围写得不对')
  })
})

describe('exemptionMissProblem：这条豁免完全对得上时给 null', () => {
  test('包名、版本、运行时三条都一致：不是「对不上」，返回 null', () => {
    const exemptions: Exemption[] = [{ package: 'pkg-a', version: '1.0.0', dshVersion: DSH_CONTRACT_VERSION }]
    expect(exemptionMissProblem(exemptions, 'pkg-a', '1.0.0')).toBeNull()
  })
})
