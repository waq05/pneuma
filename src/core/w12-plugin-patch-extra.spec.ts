/**
 * 插件行 patch 层（`core/plugin-patch.ts`）的分支补齐：YAML 形状错误、insert 的
 * 四种落点（顶层 / group / 目标不存在 / 目标不是 group）、非 insert 缺 id、
 * 名字核对、逐键覆盖与重复 id 报告。
 *
 * @module dsc/core/w12-plugin-patch-extra.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { PatchLayer, PluginRow } from './plugin-patch.js'
import { applyPatchLayers, parsePatchList, PatchUnsafeError, readPatchFile } from './plugin-patch.js'

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('parsePatchList 的形状校验', () => {
  test('!!js 一律拒绝（不让插件包在宿主里执行表达式）', () => {
    expect(() => parsePatchList('- config: !!js/function >\n', 'demo.yml')).toThrow(PatchUnsafeError)
  })

  test('非法 YAML / 顶层不是数组 / 元素不是 mapping 都给出可读错误', () => {
    expect(() => parsePatchList('foo: [unclosed', 'demo.yml')).toThrow(/不是合法的 YAML/)
    expect(() => parsePatchList('foo: bar', 'demo.yml')).toThrow(/顶层必须是 YAML 数组/)
    expect(() => parsePatchList('- 42\n', 'demo.yml')).toThrow(/不是 mapping/)
  })

  test('空文件返回空列表', () => {
    expect(parsePatchList('', 'empty.yml')).toEqual([])
    expect(parsePatchList('null', 'null.yml')).toEqual([])
  })

  test('readPatchFile：文件不存在给 null，存在就解析', () => {
    expect(readPatchFile(join(tmpdir(), 'dsc-w12-not-exist.patch.yml'))).toBeNull()
    dir = mkdtempSync(join(tmpdir(), 'dsc-w12-patch-'))
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, '- id: grp\n  config:\n    value: 1\n', 'utf8')
    const layer = readPatchFile(file)
    expect(layer?.label).toBe(file)
    expect(layer?.patches).toHaveLength(1)
  })
})

describe('applyPatchLayers 的 insert 落点', () => {
  test('不带 id 追加到顶层；带 id 插进 group 子行；group.config 不是数组时补成数组', () => {
    const rows: PluginRow[] = [
      { id: 'grp', group: true, config: [{ id: 'child' }] },
      { id: 'grp-empty', group: true, config: 'not-an-array' },
    ]
    const layer: PatchLayer = {
      label: 'demo',
      patches: [
        { insert: [{ id: 'top-added' }] },
        { id: 'grp', insert: [{ id: 'child2' }] },
        { id: 'grp-empty', insert: [{ id: 'into-empty' }] },
      ],
    }
    const result = applyPatchLayers(rows, [layer])
    expect(result.warnings).toEqual([])
    expect(result.rows.some((row) => row.id === 'top-added')).toBe(true)
    const grp = result.rows.find((row) => row.id === 'grp')!
    expect((grp.config as PluginRow[]).map((row) => row.id)).toEqual(['child', 'child2'])
    const empty = result.rows.find((row) => row.id === 'grp-empty')!
    expect((empty.config as PluginRow[]).map((row) => row.id)).toEqual(['into-empty'])
  })

  test('insert 目标不存在 / 目标不是 group：只告警不抛', () => {
    const result = applyPatchLayers([{ id: 'leaf', name: 'leaf' }], [
      { label: 'demo', patches: [{ id: 'ghost', insert: [{ id: 'x' }] }, { id: 'leaf', insert: [{ id: 'y' }] }] },
    ])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('不存在')
    expect(result.warnings[1]).toContain('不是 group')
  })

  test('非 insert 缺 id / 目标不存在 / 名字不符：三种都告警跳过', () => {
    const result = applyPatchLayers([{ id: 'leaf', name: 'leaf' }], [
      {
        label: 'demo',
        patches: [{ config: { a: 1 } }, { id: 'ghost', config: { b: 2 } }, { id: 'leaf', name: 'other', disabled: true }],
      },
    ])
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings[0]).toContain('必须写 id')
    expect(result.warnings[1]).toContain('找不到 id')
    expect(result.warnings[2]).toContain('名字对不上')
    // 名字不符的那条不能改动目标行
    expect(result.rows[0]!.disabled).toBeUndefined()
  })

  test('其余键逐个覆盖（config 整块替换，不是深合并）', () => {
    const result = applyPatchLayers([{ id: 'leaf', config: { keep: 1, drop: 2 } }], [
      { label: 'demo', patches: [{ id: 'leaf', config: { only: 3 }, disabled: true }] },
    ])
    const leaf = result.rows[0]!
    expect(leaf.config).toEqual({ only: 3 })
    expect(leaf.disabled).toBe(true)
  })
})

describe('重复行 id 报告', () => {
  test('初始行里同一个 id 出现两次会报重复', () => {
    const result = applyPatchLayers([{ id: 'dup' }, { id: 'dup' }], [])
    expect(result.duplicates).toHaveLength(1)
    expect(result.duplicates[0]!.id).toBe('dup')
    expect(result.duplicates[0]!.first).toBe('调用方传入的初始行')
  })

  test('insert 进来的行再撞同一个 id：第二个来源指向具体层与条数', () => {
    const result = applyPatchLayers([{ id: 'dup' }], [
      { label: 'layer-a', patches: [{ insert: [{ id: 'dup' }] }] },
    ])
    expect(result.duplicates).toHaveLength(1)
    expect(result.duplicates[0]!.second).toContain('layer-a 第 1 条')
  })
})
