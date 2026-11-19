/**
 * dsh 凭据 shim（`core/dsh-compat/shims/credentials.ts`）：只复刻名字语法与校验。
 *
 * 这一层没有 IO、没有环境依赖，覆盖重点是**坏输入**：非 POSIX 环变量名、大小写不合法的
 * 地址段、多段/缺段地址、两端同时非法时的报错文案。每条断言都钉「抛 TypeError」而不是
 * 某一种 Error——调用方靠类型区分「插件写错了」与「宿主坏了」。
 *
 * @module dsc/core/dsh-compat/credentials.spec
 */
import { describe, expect, test } from 'vitest'
import {
  credentialKey,
  credentialKeyId,
  credentialKeyScope,
  credentialRef,
  isCredentialKeySegment,
  isCredentialRefName,
  parseCredentialKey,
} from './shims/credentials.js'

describe('credentialRef：环变量名的类型化包装', () => {
  test('合法名原样返回（下划线开头、全大写、混合大小写都收）', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('a1_2')).toBe('a1_2')
  })

  test('非法名抛 TypeError，文案带出合法形状的正则', () => {
    for (const bad of ['', '1ABC', 'A-B', 'A B', 'A.B', '中文名']) {
      expect(() => credentialRef(bad), bad).toThrow(TypeError)
      expect(() => credentialRef(bad), bad).toThrow(/must match \/\^\[A-Za-z_\]/)
    }
  })

  test('isCredentialRefName 与构造器同一判据：边界字符逐个钉住', () => {
    expect(isCredentialRefName('A')).toBe(true)
    expect(isCredentialRefName('_')).toBe(true)
    expect(isCredentialRefName('0')).toBe(false)
    expect(isCredentialRefName('A_0')).toBe(true)
    expect(isCredentialRefName('A-0')).toBe(false)
    expect(isCredentialRefName('')).toBe(false)
    expect(isCredentialRefName('A\n')).toBe(false)
  })
})

describe('credentialKey：scope/id 地址', () => {
  test('两段都合法时拼成 scope/id', () => {
    expect(credentialKey('provider', 'openai')).toBe('provider/openai')
    expect(credentialKey('a', 'b-c1')).toBe('a/b-c1')
  })

  test('任一段非法都抛 TypeError，文案同时点出两侧规则', () => {
    expect(() => credentialKey('Provider', 'openai')).toThrow(TypeError)
    expect(() => credentialKey('provider', 'OpenAI')).toThrow(/must match/)
    expect(() => credentialKey('1provider', 'openai')).toThrow(/both sides/)
    expect(() => credentialKey('provider', 'open_ai')).toThrow(/both sides/)
  })

  test('isCredentialKeySegment：必须小写字母开头、只含小写字母数字与短横线', () => {
    expect(isCredentialKeySegment('a')).toBe(true)
    expect(isCredentialKeySegment('openai-compatible2')).toBe(true)
    expect(isCredentialKeySegment('a-')).toBe(true)
    expect(isCredentialKeySegment('-a')).toBe(false)
    expect(isCredentialKeySegment('1a')).toBe(false)
    expect(isCredentialKeySegment('OpenAI')).toBe(false)
    expect(isCredentialKeySegment('open_ai')).toBe(false)
    expect(isCredentialKeySegment('')).toBe(false)
  })
})

describe('parseCredentialKey：拆分与再校验', () => {
  test('合法地址拆成两段；取 scope / id 各走同一条解析', () => {
    expect(parseCredentialKey('provider/openai')).toBe('provider/openai')
    expect(credentialKeyScope('provider/openai')).toBe('provider')
    expect(credentialKeyId('provider/openai')).toBe('openai')
  })

  test('段数不对抛 TypeError：缺 id、多一段、空串都拒', () => {
    for (const bad of ['provider', 'a/b/c', '']) {
      expect(() => parseCredentialKey(bad), bad).toThrow(TypeError)
      expect(() => parseCredentialKey(bad), bad).toThrow(/must be scope\/id/)
    }
    // 段数对但某段是空串：落到 credentialKey 的段校验，报的是形状不对。
    expect(() => parseCredentialKey('/')).toThrow(/must match/)
    expect(() => parseCredentialKey('a/')).toThrow(/must match/)
  })

  test('段数对了但某一段非法：仍交给 credentialKey 抛，不允许它们漏过去', () => {
    expect(() => parseCredentialKey('Provider/openai')).toThrow(/must match/)
    expect(() => parseCredentialKey('provider/OpenAI')).toThrow(/must match/)
    expect(() => credentialKeyScope('bad key/id')).toThrow(TypeError)
    expect(() => credentialKeyId('good/bad id')).toThrow(TypeError)
  })
})
