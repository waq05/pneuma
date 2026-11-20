/**
 * 设置契约投影（`tests/settings-contract.ts`）的逐分支覆盖。
 *
 * 这份 helper 是「webhook kind 的 `FieldSpec` 能过设置契约」的运行期/编译期证据，
 * 但它此前只被旧的 mjs 探针间接引用，vitest 一侧没有 import，switch 里的
 * text / number / switch / select / rows 列变体 / fact 可选字段整块没走过。
 *
 * 这里直接对每种 `FieldSpec` 造输入，把 `settingsFieldOf` 的每个分支与每个
 * 「可选字段给没给」的三元都走一遍，断言投影后的形状与 `src/contract/settings.ts`
 * 的对应分支逐字段一致。字段全部手工构造，不从 `webhookKind.FIELDS` 反推——
 * 否则声明改了、分支还是没走过，测试照样绿。
 *
 * @module dsc/packages/superagent-webhook/tests/w14-settings-contract
 */
import { describe, expect, test } from 'vitest'
import type { FieldSpec, Localized } from '@pneuma/superagent/sources/kind.js'
import { contractFact, contractRows, settingsFieldOf } from './settings-contract.js'

/** 造一份本地化文案；投影只取中文一份。 */
const zh = (text: string): Localized => ({ zh: text, en: `en:${text}` })

describe('settingsFieldOf：text / number / switch / select', () => {
  test('text：有 hint 时投影出 help，没有 hint 时不带 help 键', () => {
    const withHint: FieldSpec = {
      key: 'url',
      type: 'text',
      label: zh('地址'),
      hint: zh('填 http(s)'),
      pattern: '^https?://',
      readonly: true,
      choose: zh('从候选里挑'),
    }
    expect(settingsFieldOf(withHint)).toEqual({
      type: 'text',
      key: 'url',
      label: '地址',
      help: '填 http(s)',
    })

    const withoutHint: FieldSpec = {
      key: 'secret',
      type: 'text',
      label: zh('密钥'),
    }
    expect(settingsFieldOf(withoutHint)).toEqual({
      type: 'text',
      key: 'secret',
      label: '密钥',
    })
    expect('help' in settingsFieldOf(withoutHint)).toBe(false)
  })

  test('number：min/max 与 hint 一起投影，无 hint 时不带 help', () => {
    const full: FieldSpec = {
      key: 'pollSeconds',
      type: 'number',
      label: zh('刷新间隔'),
      hint: zh('只刷新体检格'),
      min: 5,
      max: 3600,
      advanced: true,
    }
    expect(settingsFieldOf(full)).toEqual({
      type: 'number',
      key: 'pollSeconds',
      label: '刷新间隔',
      min: 5,
      max: 3600,
      help: '只刷新体检格',
    })

    const bare: FieldSpec = {
      key: 'count',
      type: 'number',
      label: zh('数量'),
      min: 0,
      max: 10,
    }
    expect(settingsFieldOf(bare)).toEqual({
      type: 'number',
      key: 'count',
      label: '数量',
      min: 0,
      max: 10,
    })
  })

  test('switch：有/无 hint 两支都投影成 switch', () => {
    expect(
      settingsFieldOf({
        key: 'on',
        type: 'switch',
        label: zh('开关'),
        hint: zh('说明'),
      }),
    ).toEqual({
      type: 'switch',
      key: 'on',
      label: '开关',
      help: '说明',
    })
    expect(settingsFieldOf({ key: 'off', type: 'switch', label: zh('关') })).toEqual({
      type: 'switch',
      key: 'off',
      label: '关',
    })
  })

  test('select：options 逐项取中文 label，hint 可选', () => {
    const field: FieldSpec = {
      key: 'mode',
      type: 'select',
      label: zh('模式'),
      hint: zh('选一个'),
      options: [
        { value: 'a', label: zh('甲') },
        { value: 'b', label: zh('乙') },
      ],
    }
    expect(settingsFieldOf(field)).toEqual({
      type: 'select',
      key: 'mode',
      label: '模式',
      options: [
        { value: 'a', label: '甲' },
        { value: 'b', label: '乙' },
      ],
      help: '选一个',
    })

    expect(
      settingsFieldOf({
        key: 'plain',
        type: 'select',
        label: zh('朴素'),
        options: [],
      }),
    ).toEqual({
      type: 'select',
      key: 'plain',
      label: '朴素',
      options: [],
    })
  })
})

describe('settingsFieldOf：rows', () => {
  test('text 列不带任何可选属性时，不出现 pattern/optional/choose/refresh 键', () => {
    const field: FieldSpec = {
      key: 'targets',
      type: 'rows',
      label: zh('目标表'),
      columns: [{ key: 'name', type: 'text', label: zh('名字') }],
    }
    const projected = settingsFieldOf(field)
    expect(projected).toEqual({
      type: 'rows',
      key: 'targets',
      label: '目标表',
      columns: [{ key: 'name', type: 'text', label: '名字' }],
    })
    const column = (projected as Extract<typeof projected, { columns: unknown }>).columns[0] ?? {}
    for (const key of ['pattern', 'optional', 'choose', 'refresh']) expect(key in column).toBe(false)
  })

  test('text 列四个可选属性都给了：逐项带出来，select 列走 options 分支', () => {
    const field: FieldSpec = {
      key: 'mixed',
      type: 'rows',
      label: zh('混合表'),
      hint: zh('表说明'),
      advanced: true,
      columns: [
        {
          key: 'dir',
          type: 'text',
          label: zh('目录'),
          pattern: '^/',
          optional: true,
          choose: zh('挑目录'),
          refresh: zh('改了重读'),
        },
        {
          key: 'kind',
          type: 'select',
          label: zh('类型'),
          options: [{ value: 'x', label: zh('某项') }],
        },
      ],
    }
    expect(settingsFieldOf(field)).toEqual({
      type: 'rows',
      key: 'mixed',
      label: '混合表',
      columns: [
        {
          key: 'dir',
          type: 'text',
          label: '目录',
          pattern: '^/',
          optional: true,
          choose: true,
          refresh: true,
        },
        {
          key: 'kind',
          type: 'select',
          label: '类型',
          options: [{ value: 'x', label: '某项' }],
        },
      ],
      help: '表说明',
      advanced: true,
    })
  })

  test('optional 显式 false、choose/refresh 缺省时不投影（只认 true/给值）', () => {
    const field: FieldSpec = {
      key: 'plainRows',
      type: 'rows',
      label: zh('朴素表'),
      columns: [{ key: 'cell', type: 'text', label: zh('格子'), optional: false }],
    }
    expect(settingsFieldOf(field)).toEqual({
      type: 'rows',
      key: 'plainRows',
      label: '朴素表',
      columns: [{ key: 'cell', type: 'text', label: '格子' }],
    })
  })
})

describe('settingsFieldOf：fact', () => {
  test('有 hint / settings / advanced 时三项都带出来', () => {
    const field: FieldSpec = {
      key: 'delivery',
      type: 'fact',
      label: zh('投递方式'),
      hint: zh('只读'),
      settings: 'deployment',
      advanced: true,
    }
    expect(settingsFieldOf(field)).toEqual({
      type: 'fact',
      key: 'delivery',
      label: '投递方式',
      help: '只读',
      settings: 'deployment',
      advanced: true,
    })
  })

  test('三项都没有时只留 type/key/label', () => {
    const projected = settingsFieldOf({
      key: 'delivery',
      type: 'fact',
      label: zh('投递方式'),
    })
    expect(projected).toEqual({
      type: 'fact',
      key: 'delivery',
      label: '投递方式',
    })
    for (const key of ['help', 'settings', 'advanced']) expect(key in projected).toBe(false)
  })
})

describe('模块级编译期常量', () => {
  test('contractRows / contractFact 由 webhookKind 的 rows / fact 字段投影而来', () => {
    expect(contractRows.type).toBe('rows')
    if (contractRows.type !== 'rows') throw new Error('unreachable')
    expect(contractRows.key).toBe('targets')
    expect(contractRows.columns.map((column) => column.key)).toEqual(['name', 'address'])

    expect(contractFact).toMatchObject({
      type: 'fact',
      key: 'delivery',
      label: '投递方式',
    })
  })
})
