/**
 * 地址栏输入整成可加载地址（迁自 `scripts/ui-browser-address-test.mjs` 第 [1]、[2] 段）。
 *
 * `normalizeAddress` 是**地址栏唯一能去哪些地方**的判定口——原生视图那边只在校验
 * 「壳发起的 load 是 http/https」（`desktop/electron/main/dock.ts` 的 `navigateDockBrowser`），
 * 输入怎么整成地址这一步全在这里。这条闸门松一格，`javascript:` / `file:` 就能顺着
 * 地址栏进到那个网页视图里。两个导出都是零依赖纯函数，真跑结果就是被测行为。
 *
 * 没迁的（原探针第 [3] 段「插件只有这一个入口」，见交付报告缺口清单）：`ui.tsx` 的
 * import/调用点与空态文案是渲染接线文本钉，接缝在渲染层，归组件渲染批。
 *
 * @module dsc-ui-browser/ui/address.spec
 */
import { describe, expect, test } from 'vitest'
import { isBrowsableUrl, normalizeAddress } from './address.js'

describe('normalizeAddress：少打字也能用（本机补 http，其余补 https）', () => {
  test('裸域名补 https，带路径的裸域名整段保留', () => {
    expect(normalizeAddress('github.com')).toBe('https://github.com/')
    expect(normalizeAddress('github.com/foo/bar?q=1')).toBe('https://github.com/foo/bar?q=1')
  })

  test('本机地址补 http（开发服务器基本是明文）：localhost / 127.0.0.1 / [::1]', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeAddress('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
    expect(normalizeAddress('[::1]:3000')).toBe('http://[::1]:3000/')
  })

  test('写了协议就原样用：https 不改写、http 不会被改成 https', () => {
    expect(normalizeAddress('https://example.com/a')).toBe('https://example.com/a')
    expect(normalizeAddress('http://example.com/')).toBe('http://example.com/')
  })

  test('前后空格去掉', () => {
    expect(normalizeAddress('  https://example.com  ')).toBe('https://example.com/')
  })
})

describe('normalizeAddress：闸门——整不出来的一律 null', () => {
  test('空串与全是空格', () => {
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
  })

  test('伪协议与自造协议全拒：javascript / data / file / mailto / dsc://', () => {
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('data:text/html,<b>x</b>')).toBeNull()
    expect(normalizeAddress('file:///etc/passwd')).toBeNull()
    expect(normalizeAddress('file:/etc/passwd')).toBeNull()
    expect(normalizeAddress('mailto:a@b.c')).toBeNull()
    expect(normalizeAddress('dsc://whatever')).toBeNull()
  })

  test('带凭据的地址拒掉（会把账号密码留在地址栏）', () => {
    expect(normalizeAddress('https://user:pw@example.com/')).toBeNull()
  })

  test('只有协议没有主机、超长地址都拒', () => {
    expect(normalizeAddress('https://')).toBeNull()
    expect(normalizeAddress(`https://example.com/${'x'.repeat(5000)}`)).toBeNull()
  })
})

describe('isBrowsableUrl：只认 http/https', () => {
  test('http 与 https 都放行（大小写不敏感）', () => {
    expect(isBrowsableUrl('https://a.b')).toBe(true)
    expect(isBrowsableUrl('HTTP://a.b')).toBe(true)
  })

  test('file: 与前导空格的相对地址不放行', () => {
    expect(isBrowsableUrl('file:///x')).toBe(false)
    expect(isBrowsableUrl(' //a.b')).toBe(false)
  })
})
