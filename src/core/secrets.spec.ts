/**
 * 凭据遮红与环境脱敏（`core/secrets.ts`）：工具输出、会话日志、子进程环境三条路。
 *
 * @module dsc/core/secrets.spec
 */
import { describe, expect, test } from 'vitest'
import { redact, redactText, scrubChildEnv } from './secrets.js'

describe('redactText', () => {
  test('空文本原样返回，不算命中', () => {
    expect(redactText('')).toEqual({ text: '', replaced: 0, kinds: [] })
  })

  test('sk- 与 JWT 各遮一段，记录规则名不记录原文', () => {
    const result = redactText('key=sk-abcdefghijklmnop123 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.abcdefghijklmnop')
    expect(result.text).not.toContain('sk-abcdefghijklmnop123')
    expect(result.text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(result.replaced).toBe(2)
    expect(result.kinds).toEqual(expect.arrayContaining(['deepseek-openai-key', 'jwt']))
    expect(result.text).toContain('«redacted:secret»')
  })

  test('kv-secret 只遮值，保留键名给人看上下文', () => {
    const result = redactText('api_key = super-secret-value-1234')
    expect(result.text).toContain('api_key')
    expect(result.text).toContain('«redacted:secret»')
    expect(result.text).not.toContain('super-secret-value-1234')
  })

  test('PEM 私钥整块替换；GitHub token 与 URL 里的密码也遮', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
    expect(redactText(pem).text).not.toContain('MIIEvQIBADANBgkq')
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123456789').kinds).toContain('github-token')
    const url = redactText('https://user:hunter2pass@example.com/x')
    expect(url.text).not.toContain('hunter2pass')
    expect(url.kinds).toContain('url-credentials')
  })

  test('普通文本不动；redact 只回文本', () => {
    expect(redactText('今天天气不错').replaced).toBe(0)
    expect(redact('nothing secret here')).toBe('nothing secret here')
  })
})

describe('scrubChildEnv', () => {
  test('密钥形状的变量名与显式凭据都剥掉，系统变量保活', () => {
    const { env, stripped } = scrubChildEnv({
      PATH: '/bin',
      HOME: '/home/u',
      OPENAI_API_KEY: 'sk-x',
      GITHUB_TOKEN: 'ghp_x',
      AWS_SECRET_ACCESS_KEY: 'aws',
      MY_SECRET: 's',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u' })
    expect(stripped).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_SECRET']))
  })

  test('dsc/别家 harness 的私有变量也剥；DSC_ENV_PASS 能保住普通变量但保不住密钥', () => {
    const old = process.env['DSC_ENV_PASS']
    process.env['DSC_ENV_PASS'] = 'DSC_KEEP,MY_TOKEN'
    try {
      const { env } = scrubChildEnv({ DSC_KEEP: 'ok', DSC_DROP: 'no', ANTHROPIC_BASE_URL: 'https://x', MY_TOKEN: 'secret' })
      expect(env).toEqual({ DSC_KEEP: 'ok' })
    } finally {
      if (old === undefined) delete process.env['DSC_ENV_PASS']
      else process.env['DSC_ENV_PASS'] = old
    }
  })
})
