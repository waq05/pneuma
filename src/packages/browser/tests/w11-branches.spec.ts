/**
 * `@pneuma/browser` 地址闸门的长尾分支（unit 层，纯函数）。
 *
 * `browser.spec.ts` 钉了主干（协议、私网、拒绝名单优先）。这一份补它没走到的边界：
 * 规则表的空项与 `!`/`-` 两种拒绝前缀、`*.` 与尾点归一、本机/链路本地/运营商 NAT/
 * 基准测试网段的每一档、URL 里的用户名密码、云元数据、查询串与锚点里的令牌、
 * 以及「允许名单不全为空但没命中」。
 *
 * @module @pneuma/browser/tests/w11-branches.spec
 */
import { describe, expect, test } from 'vitest'
import {
  CLOUD_METADATA_HOSTS,
  evaluateUrlPolicy,
  hostMatchesRule,
  isPrivateHost,
  parseDomainRules,
} from '../index.js'

describe('parseDomainRules：空项与两种拒绝前缀', () => {
  test('`.` / `!` / `-` 这些剥完变空的不进任何名单', () => {
    expect(parseDomainRules('.')).toEqual({ allow: [], deny: [] })
    expect(parseDomainRules('!')).toEqual({ allow: [], deny: [] })
    expect(parseDomainRules('-')).toEqual({ allow: [], deny: [] })
  })

  test('感叹号与减号都算拒绝；前导点与尾点都被归一掉', () => {
    expect(parseDomainRules('example.com., !bad.com, -worse.com, .leading.com')).toEqual({
      allow: ['example.com', 'leading.com'],
      deny: ['bad.com', 'worse.com'],
    })
  })
})

describe('hostMatchesRule：空规则 / 空主机 / 星号前缀', () => {
  test('任一侧为空都给 false', () => {
    expect(hostMatchesRule('', 'example.com')).toBe(false)
    expect(hostMatchesRule('example.com', '')).toBe(false)
    expect(hostMatchesRule('example.com', '*.')).toBe(false)
  })

  test('裸域命中自己与子域；星号只命中子域；尾点忽略', () => {
    expect(hostMatchesRule('example.com.', 'example.com')).toBe(true)
    expect(hostMatchesRule('a.example.com', 'example.com')).toBe(true)
    expect(hostMatchesRule('example.com', '*.example.com')).toBe(false)
    expect(hostMatchesRule('a.example.com', '*.example.com')).toBe(true)
  })
})

describe('isPrivateHost：每一档网段与后缀', () => {
  test('空主机与 localhost 家族', () => {
    expect(isPrivateHost('')).toBe(true)
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('a.localhost')).toBe(true)
  })

  test('IPv6 回环/任意地址与内网后缀', () => {
    for (const host of ['::1', '::', '0.0.0.0', 'printer.local', 'db.internal', 'nas.lan', 'box.home.arpa', 'x.localdomain', 'corp.corp']) {
      expect(isPrivateHost(host), host).toBe(true)
    }
  })

  test('IPv4 各段：10 / 127 / 0 / 192.168 / 172.16-31 / 169.254 / 100.64-127 / 198.18-19，其余公网', () => {
    for (const host of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '192.168.1.1', '172.16.0.1', '172.31.255.1', '169.254.169.254', '100.64.0.1', '100.127.1.1', '198.18.0.1', '198.19.2.2']) {
      expect(isPrivateHost(host), host).toBe(true)
    }
    for (const host of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '169.253.0.1', '100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1']) {
      expect(isPrivateHost(host), host).toBe(false)
    }
  })

  test('IPv6 唯一本地 / 链路本地；带方括号的主机名先剥括号', () => {
    expect(isPrivateHost('fd00::1')).toBe(true)
    expect(isPrivateHost('fc00::1')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true)
    expect(isPrivateHost('fe70::1')).toBe(false)
    expect(isPrivateHost('[::1]')).toBe(true)
  })
})

describe('evaluateUrlPolicy：每一种拒绝理由都能照着改', () => {
  const policy = { allowedDomains: '' }

  test('空地址、about:blank、解析失败', () => {
    expect(evaluateUrlPolicy('   ', policy)).toEqual({ allowed: false, reason: '地址是空的' })
    expect(evaluateUrlPolicy('about:blank', policy)).toEqual({ allowed: true, url: 'about:blank' })
    const bad = evaluateUrlPolicy('example.com/no-scheme', policy)
    expect(bad.allowed).toBe(false)
    expect(bad.allowed ? '' : bad.reason).toContain('地址解析不了')
  })

  test('非 http(s) 协议：理由里点名这一族', () => {
    const verdict = evaluateUrlPolicy('data:text/html,hi', policy)
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed ? '' : verdict.reason).toContain('只允许 http/https')
  })

  test('内嵌用户名/密码', () => {
    const verdict = evaluateUrlPolicy('https://user:pass@example.com/', policy)
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed ? '' : verdict.reason).toContain('内嵌了用户名/密码')
  })

  test('云元数据地址无条件拒', () => {
    const host = CLOUD_METADATA_HOSTS[0] as string
    const verdict = evaluateUrlPolicy(`http://${host}/latest/meta-data`, policy)
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed ? '' : verdict.reason).toContain('云元数据地址')
  })

  test('查询串里的令牌与锚点里的令牌各有一条理由', () => {
    const query = evaluateUrlPolicy('https://example.com/?access_token=abc', policy)
    expect(query.allowed).toBe(false)
    expect(query.allowed ? '' : query.reason).toContain('内嵌了凭据')
    const hash = evaluateUrlPolicy('https://example.com/#token=abc', policy)
    expect(hash.allowed).toBe(false)
    expect(hash.allowed ? '' : hash.reason).toContain('锚点片段里带着令牌')
  })

  test('查询串里的空值不算凭据', () => {
    expect(evaluateUrlPolicy('https://example.com/?token=', policy).allowed).toBe(true)
  })

  test('拒绝名单命中 / 允许名单没命中', () => {
    const deny = evaluateUrlPolicy('https://bad.example.com/', { allowedDomains: '!bad.example.com' })
    expect(deny.allowed).toBe(false)
    expect(deny.allowed ? '' : deny.reason).toContain('命中拒绝名单')
    const allow = evaluateUrlPolicy('https://other.test/', { allowedDomains: 'example.com' })
    expect(allow.allowed).toBe(false)
    expect(allow.allowed ? '' : allow.reason).toContain('不在允许名单里')
    expect(evaluateUrlPolicy('https://a.example.com/', { allowedDomains: '*.example.com' }).allowed).toBe(true)
  })
})
