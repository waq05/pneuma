/**
 * `core/tools/sandbox-args.ts` 的补测（W14）：升权参数的四种读法之外，补「档位字样不认识」
 * 那条拒绝路（`sandbox_permissions: root` 这类）。守卫按 malformed 拒，不给放行。
 *
 * @module dsc/core/tools/w14-sandbox-args.spec
 */
import { describe, expect, test } from 'vitest'
import { readSandboxRequest, SANDBOX_PERMISSION_VALUES } from './sandbox-args.js'

describe('升权参数读取', () => {
  test('什么都没给 = none', () => {
    expect(readSandboxRequest({})).toEqual({ kind: 'none' })
  })

  test('完整的请求：档位、理由、范围都收下（scope 缺省 once）', () => {
    expect(
      readSandboxRequest({
        sandbox_permissions: 'workspace-write',
        justification: ' 要写构建产物 ',
      }),
    ).toMatchObject({
      kind: 'ok',
      permission: 'workspace-write',
      justification: '要写构建产物',
      scope: 'once',
    })
  })

  test('档位字样不认识：按 malformed 拒，理由列出合法值', () => {
    const result = readSandboxRequest({
      sandbox_permissions: 'root',
      justification: '想直接改 /etc',
    })
    expect(result.kind).toBe('malformed')
    if (result.kind === 'malformed') {
      for (const value of SANDBOX_PERMISSION_VALUES) expect(result.reason).toContain(value)
    }
  })
})
