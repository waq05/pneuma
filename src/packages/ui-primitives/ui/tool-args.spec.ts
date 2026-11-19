/**
 * 工具参数表的分流（ui 层）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [2] 段（0.6.67 报障 ④：编辑卡的展开体
 * 摊原始 JSON 参数——write / edit 的正文缩在 JSON 字符串里全是 `\n` 转义）与第 [4] 段的
 * `MUTATION_CONTENT_FIELDS` 表口径（write→content、edit→old+new）。
 *
 * 口径：壳照参考实现（dsh 的 FileMutationRow）分流——会改文件的工具正文走 diff 块，
 * 其余字段走参数表。`toolArgFields` 的真跑结果就是被测行为；原探针里钉 factory.tsx
 * 接线（「有没有 diff 就分流」「dsh 的补丁并进展开体」）的断言不迁，归组件渲染批；
 * 宿主 `fs-tools.ts` 侧的漂移钉（工具 schema 的参数名文本）也不迁——它是源码文本，
 * 且 fs-tools 的 import 链在界面层拉不动，见交付报告的缺口清单。
 *
 * @module dsc-ui-primitives/ui/tool-args.spec
 */
import { describe, expect, test } from 'vitest'
import { MUTATION_CONTENT_FIELDS, toolArgFields } from './tool-args.js'

describe('toolArgFields：会改文件的工具走参数表', () => {
  test('write 认成会改文件的工具，正文（content）不进参数表', () => {
    const write = toolArgFields('write', JSON.stringify({ path: 'a.md', justification: '因为', content: '# 标题\n正文' }))
    expect(write.mutating).toBe(true)
    expect(write.fields.some((field) => field.key === 'content')).toBe(false)
    expect(write.omitted).toContain('content')
  })

  test('其余字段按原序进表，值压成一行（正文之外的字段不留换行）', () => {
    const write = toolArgFields('write', JSON.stringify({ path: 'a.md', justification: '因为', content: '# 标题\n正文' }))
    expect(write.fields.map((field) => field.key).join(',')).toBe('path,justification')
    expect(write.fields.every((field) => !field.value.includes('\n'))).toBe(true)
  })

  test('edit 的 old / new 都剔出去', () => {
    const edit = toolArgFields('edit', JSON.stringify({ path: 'a.ts', old: '一', new: '二' }))
    expect(edit.omitted).toContain('old')
    expect(edit.omitted).toContain('new')
    expect(edit.fields).toHaveLength(1)
  })

  test('别家的写文件工具同样分流（str_replace_editor）', () => {
    const mcp = toolArgFields('str_replace_editor', JSON.stringify({ path: 'a.ts', old_str: 'x', new_str: 'y', file_text: 'z' }))
    expect(mcp.mutating).toBe(true)
    expect(mcp.fields).toHaveLength(1)
  })

  test('非文件工具不分流（照旧摊参数 JSON）', () => {
    const bash = toolArgFields('bash', JSON.stringify({ command: 'ls' }))
    expect(bash.mutating).toBe(false)
    expect(bash.fields).toHaveLength(0)
  })

  test('半截参数（流式中）仍报 mutating、但参数表为空', () => {
    const half = toolArgFields('write', '{"path":"a.md","cont')
    expect(half.mutating).toBe(true)
    expect(half.fields).toHaveLength(0)
  })

  test('参数不是对象也照上面那条降级', () => {
    const notObject = toolArgFields('write', '[1,2]')
    expect(notObject.mutating).toBe(true)
    expect(notObject.fields).toHaveLength(0)
  })

  test('对象/数组的值压成一行 JSON，正文之外的字段一个不丢', () => {
    const values = toolArgFields('write', JSON.stringify({ path: 'a.md', flags: [1, 2], meta: { a: 1 }, content: 'x' }))
    expect(values.fields.some((field) => field.key === 'flags' && field.value === '[1,2]')).toBe(true)
    expect(values.fields).toHaveLength(3)
  })
})

describe('MUTATION_CONTENT_FIELDS：壳的表与宿主口径一致', () => {
  test('write 的正文参数叫 content，edit 的两个参数叫 old / new', () => {
    expect(MUTATION_CONTENT_FIELDS['write']?.join(',')).toBe('content')
    expect(MUTATION_CONTENT_FIELDS['edit']?.join(',')).toBe('old,new')
  })

  test('两张表都覆盖 write / edit', () => {
    expect(['write', 'edit'].every((name) => name in MUTATION_CONTENT_FIELDS)).toBe(true)
  })
})
