/**
 * 子进程环境白名单（`core/child-env.ts`）：MCP / LSP 起第三方程序时只给系统变量与显式声明的名字。
 *
 * @module dsc/core/child-env.spec
 */
import { describe, expect, test } from 'vitest'
import { BASE_ENV_NAMES, buildChildEnv } from './child-env.js'

describe('buildChildEnv', () => {
  test('白名单里的系统变量原样带过去，空值不带', () => {
    const env = buildChildEnv([], {}, { PATH: '/usr/bin', HOME: '/home/u', TEMP: '', SECRET_TOKEN: 's' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' })
    expect(BASE_ENV_NAMES).toContain('PATH')
  })

  test('显式声明的名字：给了值用配置的，没给从父环境取；空值不带', () => {
    const env = buildChildEnv(['GITHUB_TOKEN', 'EMPTY', 'MISSING'], { GITHUB_TOKEN: 'from-config', EMPTY: '' }, {
      GITHUB_TOKEN: 'from-parent',
      MISSING: 'parent-value',
    })
    expect(env['GITHUB_TOKEN']).toBe('from-config')
    expect(env['MISSING']).toBe('parent-value')
    expect(env).not.toHaveProperty('EMPTY')
  })

  test('没声明的一律不出现（父环境的 key 与令牌不外泄）', () => {
    const env = buildChildEnv([], {}, { OPENAI_API_KEY: 'sk-x', DSC_HOME: '/h', PATH: '/bin' })
    expect(Object.keys(env)).toEqual(['PATH'])
  })

  test('Windows 上变量名不分大小写：小写的 Path 也能当 PATH 读到', () => {
    if (process.platform !== 'win32') return
    const env = buildChildEnv([], {}, { path: 'C:\\bin' })
    expect(env['PATH']).toBe('C:\\bin')
  })
})
