/**
 * 技能市场源的纯解析（`packages/config-core/market.ts`）：源识别、榜单/搜索地址、GitHub 目录链接、UI 视图。
 *
 * 网络浏览与安装归 integration（要真 fetch / 真解压）；这里只钉「地址怎么拼、条目怎么认」。
 *
 * @module dsc/packages/config-core/tests/market.spec
 */
import { describe, expect, test } from 'vitest'
import {
  clawHubListUrl,
  isClawHubSource,
  isSkillsShSource,
  parseGitHubTree,
  skillsShSearchUrl,
  toMarketSkillView,
  type MarketEntry,
} from '../market.js'

describe('源识别', () => {
  test('ClawHub：按域名认，带路径/查询也算；形近域名不算', () => {
    expect(isClawHubSource('https://clawhub.ai')).toBe(true)
    expect(isClawHubSource(' https://clawhub.ai/ ')).toBe(true)
    expect(isClawHubSource('https://clawhub.ai/api/v1/skills?x=1')).toBe(true)
    expect(isClawHubSource('https://clawhub.ai.evil.com/')).toBe(false)
    expect(isClawHubSource('http://clawhub.ai')).toBe(true)
  })

  test('skills.sh：同样按域名认', () => {
    expect(isSkillsShSource('https://skills.sh/api/search')).toBe(true)
    expect(isSkillsShSource('https://skills.sh?x')).toBe(true)
    expect(isSkillsShSource('https://skills.shh/')).toBe(false)
  })
})

describe('地址拼装', () => {
  test('ClawHub：已经是 /api/ 路径就原样用（尊重 sort/limit），站点根补默认下载榜', () => {
    const api = 'https://clawhub.ai/api/v1/skills?sort=stars&limit=10'
    expect(clawHubListUrl(api)).toBe(api)
    expect(clawHubListUrl('https://clawhub.ai/')).toBe('https://clawhub.ai/api/v1/skills?sort=downloads&limit=100')
    expect(clawHubListUrl('not a url')).toBe('https://clawhub.ai/api/v1/skills?sort=downloads&limit=100')
  })

  test('skills.sh：带 q= 原样、没有就按关键词拼 /api/search', () => {
    expect(skillsShSearchUrl('https://skills.sh/api/search?q=pdf', 'ignored')).toBe('https://skills.sh/api/search?q=pdf')
    expect(skillsShSearchUrl('https://skills.sh', '导出 pdf')).toBe('https://skills.sh/api/search?q=%E5%AF%BC%E5%87%BA%20pdf&limit=100')
    expect(skillsShSearchUrl('https://skills.sh/api/search', 'x')).toBe('https://skills.sh/api/search?q=x&limit=100')
    // 旧查询串/锚点不参与拼接
    expect(skillsShSearchUrl('https://skills.sh/base?old=1#x', 'y')).toBe('https://skills.sh/base/api/search?q=y&limit=100')
  })

  test('GitHub tree 链接：owner/repo/ref/dir，根目录与尾斜杠都认，别的形状给 null', () => {
    expect(parseGitHubTree('https://github.com/o/r/tree/main/skills/foo')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dir: 'skills/foo',
    })
    expect(parseGitHubTree('https://github.com/o/r/tree/v1.2.3')).toEqual({ owner: 'o', repo: 'r', ref: 'v1.2.3', dir: '' })
    expect(parseGitHubTree('https://github.com/o/r/tree/main/')).toEqual({ owner: 'o', repo: 'r', ref: 'main', dir: '' })
    expect(parseGitHubTree('https://github.com/o/r')).toBeNull()
    expect(parseGitHubTree('https://gitlab.com/o/r/tree/main/x')).toBeNull()
  })
})

describe('toMarketSkillView', () => {
  test('已安装按名字命中；可选字段原样带出', () => {
    const entry: MarketEntry = {
      name: 'pdf',
      description: '处理 PDF',
      version: '1.2.0',
      source: 'ClawHub',
      kind: 'zip',
      root: 'https://x/y.zip',
      mainFile: 'SKILL.md',
      stats: { downloads: 10, stars: 3 },
    }
    expect(toMarketSkillView(entry, new Set(['pdf']))).toEqual({
      name: 'pdf',
      description: '处理 PDF',
      source: 'ClawHub',
      version: '1.2.0',
      installed: true,
      stats: { downloads: 10, stars: 3 },
    })
    expect(toMarketSkillView(entry, new Set()).installed).toBe(false)
  })
})
