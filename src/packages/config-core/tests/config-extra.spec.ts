/**
 * config-core 的补盲（`packages/config-core/presets.ts`）：模式文件的读写、frontmatter
 * 校验、mtime 缓存、坏文件与同名冲突、改名迁移、出厂模式回落。
 *
 * `tests/config-core.spec.ts` 只钉包身份与桶文件转出，`market*.spec.ts` 只管市场地址；
 * 这里把 presets 的文件面补上。`DSC_HOME` 在任何 import 之前指进临时目录
 * （`DSC_PRESETS_DIR` 在模块求值时算定）。
 *
 * @module dsc/packages/config-core/tests/config-extra.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-config-extra-'))
process.env['DSC_HOME'] = HOME

type Presets = typeof import('../presets.js')
let presets: Presets
let DIR: string

beforeAll(async () => {
  presets = await import('../presets.js')
  DIR = presets.DSC_PRESETS_DIR
})

afterAll(() => {
  delete process.env['DSC_HOME']
})

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

let mtimeBump = 0
/** 写一个模式文件并把 mtime 往前推（缓存按 mtime 判新，同毫秒写入会读到旧份）。 */
function presetFile(name: string, text: string): string {
  mkdirSync(DIR, { recursive: true })
  const file = join(DIR, `${name}.md`)
  writeFileSync(file, text, 'utf8')
  mtimeBump += 1
  const stamp = new Date(Date.now() + mtimeBump * 1000)
  try {
    utimesSync(file, stamp, stamp)
  } catch {
    // 改不了时间也没关系：内容不同，命中缓存也只会是旧内容而测试会暴露
  }
  return file
}

describe('出厂模式', () => {
  test('ensureBuiltinPresets 只补缺的四个，不覆盖用户改过的内容', () => {
    const created = presets.ensureBuiltinPresets()
    expect([...created].sort()).toEqual(['maker', 'minimal', 'ptc', 'standard'])
    for (const name of created) expect(existsSync(join(DIR, `${name}.md`))).toBe(true)

    const standard = join(DIR, 'standard.md')
    const mine = '---\nname: standard\nlabel: 我的标准\n---\n我的正文\n'
    writeFileSync(standard, mine, 'utf8')

    expect(presets.ensureBuiltinPresets()).toEqual([])
    expect(readFileSync(standard, 'utf8')).toBe(mine)
  })
})

describe('单文件读写与缓存', () => {
  test('frontmatter 字段齐全；第二次读命中缓存；mtime 变了才重新解析', () => {
    const file = presetFile(
      'review',
      [
        '---',
        'name: review',
        'label: 代码审查模式',
        'description:   找漏洞与测试缺口  ',
        'tools: read, grep',
        'deny: plugin_manager, bad.name, ok_tool',
        'drop: behavior, nope',
        'replace: true',
        '---',
        '',
        '正文第一行',
        '',
      ].join('\n'),
    )
    const parsed = presets.readPreset(file)!
    expect(parsed).toMatchObject({
      name: 'review',
      label: '代码审查模式',
      description: '找漏洞与测试缺口',
      tools: ['read', 'grep'],
      deny: ['plugin_manager', 'ok_tool'],
      drop: ['behavior'],
      replace: true,
      prompt: '正文第一行',
      builtin: false,
    })
    // 写错的 drop 不当哑巴：进 problem，让用户看得见。
    expect(parsed.problem).toContain('nope')

    expect(presets.readPreset(file)).toBe(parsed)

    presetFile('review', '---\nname: review\nlabel: 代码审查模式\n---\n\n新正文\n')
    const updated = presets.readPreset(file)!
    expect(updated).not.toBe(parsed)
    expect(updated.prompt).toBe('新正文')

    expect(presets.readPreset(join(DIR, 'missing.md'))).toBeNull()
  })

  test('frontmatter 的几种坏形状：坏 YAML、非法名、无 frontmatter、tools 的三种写法', () => {
    const broken = presets.readPreset(presetFile('broken', '---\nname: [unclosed\n---\nbody'))!
    expect(broken.name).toBe('broken')
    expect(broken.problem).toContain('不是合法 YAML')
    expect(broken.prompt).toBe('body')

    const badName = presets.readPreset(presetFile('good-file', '---\nname: Bad_Name\n---\nbody'))!
    expect(badName.name).toBe('good-file')
    expect(badName.problem).toContain('不合法')

    const plain = presets.readPreset(presetFile('plain', '只有正文，没有 frontmatter'))!
    expect(plain).toMatchObject({
      name: 'plain',
      label: 'plain',
      description: '',
      tools: null,
      deny: [],
      drop: [],
      replace: false,
      prompt: '只有正文，没有 frontmatter',
    })

    expect(presets.readPreset(presetFile('none-tools', '---\nname: none-tools\ntools: none\n---\n'))!.tools).toEqual([])
    expect(presets.readPreset(presetFile('empty-tools', '---\nname: empty-tools\ntools: []\n---\n'))!.tools).toEqual([])
    expect(
      presets.readPreset(presetFile('list-tools', '---\nname: list-tools\ntools: [read, grep]\n---\n'))!.tools,
    ).toEqual(['read', 'grep'])
  })
})

describe('清单', () => {
  test('出厂档排在前面；同名声明第二份带 problem 列出而不是静默丢弃；非 .md 不读', () => {
    presets.ensureBuiltinPresets()
    presetFile('aaa-custom', '---\nname: aaa-custom\n---\n')
    presetFile('zzz-custom', '---\nname: zzz-custom\n---\n')
    presetFile('a-dup', '---\nname: dup\n---\nA')
    presetFile('b-dup', '---\nname: dup\n---\nB')
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 'note.txt'), 'not a preset', 'utf8')

    const list = presets.listPresets()
    expect(list.slice(0, 4).map((item) => item.name)).toEqual(['standard', 'ptc', 'minimal', 'maker'])
    expect(list.map((item) => item.name)).not.toContain('note')

    const duplicate = list.find((item) => item.name === 'b-dup')!
    expect(duplicate.label).toContain('未生效')
    expect(duplicate.problem).toContain('已经有一个同名模式生效')
    expect(duplicate.prompt).toBe('')

    rmSync(DIR, { recursive: true, force: true })
    expect(presets.listPresets()).toEqual([])
  })

  test('findPreset 只认文件名与声明名一致的；standardPreset 在文件缺失时回落到出厂文本', () => {
    expect(presets.findPreset('Bad_Name')).toBeNull()
    expect(presets.findPreset('missing')).toBeNull()

    presetFile('review', '---\nname: other\n---\nbody')
    expect(presets.findPreset('review')).toBeNull()

    rmSync(DIR, { recursive: true, force: true })
    const fallback = presets.standardPreset()
    expect(fallback).toMatchObject({ name: 'standard', label: '标准模式', builtin: true })
    expect(fallback.tools).toBeNull()

    presetFile('standard', '---\nname: standard\nlabel: 我的标准\n---\n自定义正文')
    const custom = presets.standardPreset()
    expect(custom.label).toBe('我的标准')
    expect(custom.prompt).toBe('自定义正文')
  })

  test('standard.md 的 frontmatter 写坏时：当前实现仍返回该文件（带 problem），不回落出厂标签', () => {
    presetFile('standard', '---\nname: [unclosed\n---\n')
    const preset = presets.standardPreset()
    expect(preset.name).toBe('standard')
    expect(preset.problem).toContain('不是合法 YAML')
    // 出厂标签是「标准模式」；坏文件被当成一份没有 label 的模式，于是标签退成 name。
    expect(preset.label).toBe('standard')
  })
})

describe('写入、改名与删除', () => {
  test('writePreset 覆盖写并保留旧文件里表单没暴露的 deny/replace；改名删掉旧文件', () => {
    const created = presets.writePreset({
      oldName: null,
      name: 'review',
      label: '',
      description: '描述',
      tools: [],
      drop: [],
      deny: ['plugin_manager'],
      replace: true,
      prompt: '  正文  ',
    })
    expect(created).toMatchObject({
      name: 'review',
      label: 'review',
      tools: [],
      deny: ['plugin_manager'],
      replace: true,
      prompt: '正文',
    })
    const text = readFileSync(join(DIR, 'review.md'), 'utf8')
    expect(text).toContain('tools: none')
    expect(text).toContain('deny: plugin_manager')
    expect(text).toContain('replace: true')

    // 表单没有 deny/replace 两项：保存时沿用旧文件的值，不把用户手写的抹掉。
    const rewritten = presets.writePreset({
      oldName: 'review',
      name: 'review',
      label: '审查',
      description: '新描述',
      tools: ['read'],
      drop: ['nope', 'behavior'],
      prompt: 'p',
    })
    expect(rewritten).toMatchObject({
      label: '审查',
      tools: ['read'],
      drop: ['behavior'],
      deny: ['plugin_manager'],
      replace: true,
    })

    presets.writePreset({
      oldName: 'review',
      name: 'review2',
      label: '审查2',
      description: '',
      tools: null,
      drop: [],
      prompt: '',
    })
    expect(existsSync(join(DIR, 'review.md'))).toBe(false)
    expect(existsSync(join(DIR, 'review2.md'))).toBe(true)

    expect(() =>
      presets.writePreset({
        oldName: null,
        name: 'Bad Name',
        label: '',
        description: '',
        tools: null,
        drop: [],
        prompt: '',
      }),
    ).toThrow(/不合法/)
  })

  test('removePreset：内置不给删、名字非法、文件不存在都抛；自定义删掉后清单里消失', () => {
    expect(() => presets.removePreset('standard')).toThrow(/出厂内置/)
    expect(() => presets.removePreset('Bad_Name')).toThrow(/不合法/)
    expect(() => presets.removePreset('missing')).toThrow(/没有名为/)

    presetFile('gone', '---\nname: gone\n---\n')
    expect(presets.listPresets().some((item) => item.name === 'gone')).toBe(true)
    presets.removePreset('gone')
    expect(existsSync(join(DIR, 'gone.md'))).toBe(false)
    expect(presets.listPresets().some((item) => item.name === 'gone')).toBe(false)
  })
})

describe('模式词解析', () => {
  test('别名、显示名、大小写名字都认；空串与认不出的给 null', () => {
    expect(presets.parsePresetToken('极简')).toBe('minimal')
    expect(presets.parsePresetToken('标准')).toBe('standard')
    expect(presets.parsePresetToken('STANDARD')).toBe('standard')
    expect(presets.parsePresetToken('创造')).toBe('maker')
    expect(presets.parsePresetToken('   ')).toBeNull()
    expect(presets.parsePresetToken('no-such-thing')).toBeNull()

    const file = presetFile('review', '---\nname: review\nlabel: 代码审查\n---\n')
    const list = [presets.readPreset(file)!]
    expect(presets.parsePresetToken('代码审查', list)).toBe('review')
    expect(presets.parsePresetToken('REVIEW', list)).toBe('review')
    expect(presets.parsePresetToken('别的东西', list)).toBeNull()
  })
})
