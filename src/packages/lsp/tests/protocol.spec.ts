/**
 * LSP 的纯协议面：URI 换算、Content-Length 分帧、应答归并、诊断行位移、服务器解析。
 *
 * 这些都不碰进程与流，正好在 unit 层逐条钉；连接生命周期与真 spawn 归 integration/e2e。
 *
 * @module dsc/packages/lsp/tests/protocol.spec
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { encodeMessage, MAX_HEADER_BYTES, MessageDecoder, StderrTail } from '../framing.js'
import { buildLineShift, shiftDiagnostics } from '../line-shift.js'
import { diagnosticKey, normalizeDiagnostics, normalizeHover, normalizeLocations } from '../normalize.js'
import {
  describeServers,
  extensionOf,
  installHint,
  mergeServers,
  parseServerOverrides,
  resolveExecutable,
  type LspServerDef,
} from '../servers.js'
import {
  displayPath,
  hostWorld,
  pathToUri,
  pathWithin,
  samePath,
  toDisplayCharacter,
  toDisplayLine,
  toProtocolPosition,
  uriToPath,
} from '../uri.js'

const WIN = process.platform === 'win32'

let tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-lsp-proto-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('uri：路径与 URI 互转', () => {
  test('带空格 / # / 中文的路径来回转，盘符大小写不改变指向', () => {
    const path = WIN ? 'C:\\work\\a b#c 中文.ts' : '/work/a b#c 中文.ts'
    const uri = pathToUri(path)
    expect(uri.startsWith('file://')).toBe(true)
    expect(uri).toContain('%20')
    expect(uri).toContain('%23')
    expect(uriToPath(uri, WIN)).toBe(path.replace(/\//g, WIN ? '\\' : '/'))
    // 自己拼一份小写盘符 / 编码冒号的 URI，也要解回同一个路径。
    if (WIN) {
      expect(uriToPath('file:///c%3A/work/a.ts', true)).toBe('c:\\work\\a.ts')
      expect(samePath('file:///C:/work/A.ts', 'c:\\work\\a.ts', true)).toBe(true)
    }
  })

  test('非 file:、%2F、%00 都解不出来（返回 undefined，不猜）', () => {
    expect(uriToPath('jdt://contents/x.class')).toBeUndefined()
    expect(uriToPath('file:///a%2Fb.ts', WIN)).toBeUndefined()
    expect(uriToPath('file:///a%00b.ts', false)).toBeUndefined()
  })

  test('samePath：绝对化、Windows 折大小写、末尾分隔符不算数', () => {
    expect(samePath('/a/b/../c', '/a/c', false)).toBe(true)
    expect(samePath('/a/b/', '/a/b', false)).toBe(true)
    expect(samePath('/a/B', '/a/b', false)).toBe(false)
    expect(samePath('/a/B', '/a/b', true)).toBe(true)
    expect(samePath('file:///a/b.ts', '/a/b.ts', false)).toBe(true)
  })

  test('pathWithin：含相等，src2 不算在 src 里', () => {
    expect(pathWithin('/root/src', '/root/src', false)).toBe(true)
    expect(pathWithin('/root/src', '/root/src/a/b.ts', false)).toBe(true)
    expect(pathWithin('/root/src', '/root/src2/a.ts', false)).toBe(false)
    expect(pathWithin('/root/src', '/root/other/a.ts', false)).toBe(false)
  })

  test('displayPath：工作区内给相对路径、区外给绝对、虚拟文档原样', () => {
    expect(displayPath('jdt://contents/x', '/root', false)).toBe('jdt://contents/x')
    if (WIN) {
      expect(displayPath('C:\\root\\src\\a\\b.ts', 'C:\\root\\src', true)).toBe('a/b.ts')
      expect(displayPath('C:\\root\\src', 'C:\\root\\src', true)).toBe('.')
      expect(displayPath('C:\\other\\a.ts', 'C:\\root\\src', true)).toBe('C:/other/a.ts')
    } else {
      expect(displayPath('/root/src/a/b.ts', '/root/src', false)).toBe('a/b.ts')
      expect(displayPath('/root/src', '/root/src', false)).toBe('.')
      expect(displayPath('/other/a.ts', '/root/src', false)).toBe('/other/a.ts')
    }
  })

  test('一基与零基换算；非法输入抛清楚', () => {
    expect(toProtocolPosition(1, 1)).toEqual({ line: 0, character: 0 })
    expect(toProtocolPosition(3, 5)).toEqual({ line: 2, character: 4 })
    expect(() => toProtocolPosition(0, 1)).toThrow(/一基正整数/)
    expect(() => toProtocolPosition(1, 0)).toThrow(/一基正整数/)
    expect(toDisplayLine(0)).toBe(1)
    expect(toDisplayCharacter(4)).toBe(5)
    expect(typeof hostWorld()).toBe('boolean')
  })
})

describe('framing：Content-Length 分帧', () => {
  test('正文按 UTF-8 字节数报长度（中文不能按字符数算）', () => {
    const message = { jsonrpc: '2.0', method: 'x', params: { text: '中文' } }
    const bytes = encodeMessage(message)
    const text = bytes.toString('utf8')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    expect(text.startsWith(`Content-Length: ${String(body.length)}\r\n\r\n`)).toBe(true)
    expect(JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4))).toEqual(message)
  })

  test('序列化不出来就抛，不发半条消息', () => {
    expect(() => encodeMessage(undefined)).toThrow(/没法序列化/)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => encodeMessage(cyclic)).toThrow()
  })

  test('粘包：一次喂两条，按到达顺序吐两条', () => {
    const decoder = new MessageDecoder()
    const both = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })])
    expect(decoder.push(both)).toEqual([{ n: 1 }, { n: 2 }])
    expect(decoder.pending).toBe(0)
  })

  test('半包：头拆开、正文拆开都能拼回来', () => {
    const decoder = new MessageDecoder()
    const bytes = encodeMessage({ hello: '世界' })
    expect(decoder.push(bytes.subarray(0, 5))).toEqual([])
    expect(decoder.pending).toBe(5)
    expect(decoder.push(bytes.subarray(5, 20))).toEqual([])
    expect(decoder.push(bytes.subarray(20))).toEqual([{ hello: '世界' }])
  })

  test('容忍流开头的空行；正文里有换行也不受影响', () => {
    const decoder = new MessageDecoder()
    expect(decoder.push(Buffer.from('\r\n'))).toEqual([])
    expect(decoder.push(encodeMessage({ text: 'a\nb' }))).toEqual([{ text: 'a\nb' }])
  })

  test('协议错：缺 Content-Length / 正文非 JSON / 声明超上限', () => {
    expect(() => new MessageDecoder().push(Buffer.from('X: 1\r\n\r\n{}'))).toThrow(/没有 Content-Length/)
    expect(() => new MessageDecoder().push(Buffer.from('Content-Length: 1\r\n\r\n{'))).toThrow(/不是合法 JSON/)
    expect(() =>
      new MessageDecoder(4).push(Buffer.from('Content-Length: 5\r\n\r\nhello')),
    ).toThrow(/超过 4 字节的上限/)
  })

  test('头迟迟不出现分隔符：超过头上限就抛', () => {
    const junk = Buffer.alloc(MAX_HEADER_BYTES + 1, 0x61)
    expect(() => new MessageDecoder().push(junk)).toThrow(/仍没有出现/)
  })

  test('stderr 尾巴：超限丢最旧的，尾部行过滤空行', () => {
    const tail = new StderrTail(16)
    tail.push('hello\n')
    tail.push('big-error-line')
    expect(Buffer.byteLength(tail.text(), 'utf8')).toBeLessThanOrEqual(16)
    expect(tail.text()).toContain('big-error-line')
    tail.push('\nlast one\n')
    expect(Buffer.byteLength(tail.text(), 'utf8')).toBeLessThanOrEqual(16)
    expect(tail.text()).toContain('last one')
    expect(tail.tailLines(1)).toBe('last one')
    expect(tail.tailLines(3).split('\n').every((line) => line.trim() !== '')).toBe(true)
    tail.clear()
    expect(tail.text()).toBe('')
    expect(tail.tailLines(2)).toBe('')
  })
})

describe('normalize：应答归并', () => {
  const range = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } }

  test('Location / LocationLink / null 都收成同一种形状，额外字段丢掉', () => {
    expect(normalizeLocations(null)).toEqual([])
    expect(normalizeLocations({ uri: 'file:///a.ts', range, extra: 1 })).toEqual([
      { uri: 'file:///a.ts', range },
    ])
    expect(
      normalizeLocations([{ targetUri: 'file:///b.ts', targetSelectionRange: range }]),
    ).toEqual([{ uri: 'file:///b.ts', range }])
    expect(() => normalizeLocations([{ uri: 'x', range: null }])).toThrow(/既不是 Location 也不是 LocationLink/)
    expect(() => normalizeLocations([1])).toThrow(/不是对象/)
  })

  test('hover：字符串 / MarkupContent / MarkedString 数组 / range', () => {
    expect(normalizeHover(null)).toBeNull()
    expect(normalizeHover({ contents: '一句话' })).toEqual({ contents: '一句话' })
    expect(normalizeHover({ contents: { kind: 'markdown', value: '# 标题' } })).toEqual({ contents: '# 标题' })
    expect(
      normalizeHover({ contents: ['文字', { language: 'ts', value: 'const a = 1' }], range }),
    ).toEqual({ contents: '文字\n\n```ts\nconst a = 1\n```', range })
    expect(normalizeHover({ contents: { kind: 'markdown', value: '' } })).toBeNull()
    expect(() => normalizeHover({ contents: 'x', range: {} })).toThrow(/range 畸形/)
    expect(() => normalizeHover('x')).toThrow(/不是对象/)
  })

  test('诊断：缺 severity 当 1、code 转字符串、坏 range 跳过、坏项跳过', () => {
    const list = normalizeDiagnostics([
      { range, message: '错', code: 2322, source: 'ts', severity: 1 },
      { range, message: '没 severity' },
      { message: '没有 range' },
      null,
    ])
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ severity: 1, message: '错', code: '2322', source: 'ts' })
    expect(list[1]).toMatchObject({ severity: 1, message: '没 severity' })
    expect(normalizeDiagnostics({})).toEqual([])
  })

  test('diagnosticKey：任一维变化都换 key，重建同一条则稳定', () => {
    const one = { severity: 1, message: 'm', range }
    const two = { severity: 1, message: 'm', range: { ...range, start: { line: 2, character: 0 } } }
    expect(diagnosticKey(one)).toBe(diagnosticKey({ ...one, range: { ...range } }))
    expect(diagnosticKey(one)).not.toBe(diagnosticKey(two))
    expect(diagnosticKey(one)).not.toBe(diagnosticKey({ ...one, message: 'n' }))
  })
})

describe('line-shift：写前写后的行号映射', () => {
  test('文本没变：恒等映射', () => {
    const shift = buildLineShift('a\nb\nc', 'a\nb\nc')
    expect([0, 1, 2].map((line) => shift(line))).toEqual([0, 1, 2])
  })

  test('顶部插入两行：老行整体下移，尾部越界锚到最后一行', () => {
    const shift = buildLineShift('a\nb\nc', 'new1\nnew2\na\nb\nc')
    expect([0, 1, 2, 99].map((line) => shift(line))).toEqual([2, 3, 4, 4])
  })

  test('删掉第一行：被删的行给 null，后面的行上移', () => {
    const shift = buildLineShift('a\nb\nc', 'b\nc')
    expect(shift(0)).toBeNull()
    expect(shift(1)).toBe(0)
    expect(shift(2)).toBe(1)
  })

  test('替换中间一行：换掉的那行 null，前后行原位', () => {
    const shift = buildLineShift('a\nb\nc', 'a\nx\nc')
    expect(shift(0)).toBe(0)
    expect(shift(1)).toBeNull()
    expect(shift(2)).toBe(2)
  })

  test('shiftDiagnostics：跨被删区域整条出局，endLine 映射不到就跟着 start', () => {
    const shift = buildLineShift('a\nb\nc', 'a\nx\nc')
    const diagnostics = [
      { severity: 1, message: 'in b', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      { severity: 1, message: 'on c', range: { start: { line: 2, character: 0 }, end: { line: 1, character: 0 } } },
    ]
    const out = shiftDiagnostics(diagnostics, shift)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ message: 'on c', range: { start: { line: 2 }, end: { line: 2 } } })
  })
})

describe('servers：可执行文件解析与覆盖清单', () => {
  test('绝对路径找不到 → undefined；找到 → 目标（.cmd/.bat 走 shell）', () => {
    const dir = tempDir()
    expect(resolveExecutable(join(dir, 'missing'), {}, '')).toBeUndefined()
    const name = WIN ? 'tool.cmd' : 'tool'
    const file = join(dir, name)
    writeFileSync(file, 'x', 'utf8')
    if (!WIN) chmodSync(file, 0o755)
    const target = resolveExecutable(file, {}, '')
    expect(target).toMatchObject({ file, shell: WIN })
  })

  test('按 PATH 找：Windows 认 PATHEXT 后缀，POSIX 认可执行位', () => {
    const dir = tempDir()
    if (WIN) {
      const file = join(dir, 'faketool.EXE')
      writeFileSync(file, 'x', 'utf8')
      const target = resolveExecutable('faketool', { PATH: dir, PATHEXT: '.EXE' }, '')
      expect(target).toMatchObject({ file, shell: false })
    } else {
      const file = join(dir, 'faketool')
      writeFileSync(file, 'x', 'utf8')
      chmodSync(file, 0o755)
      expect(resolveExecutable('faketool', { PATH: dir }, '')).toMatchObject({ file, shell: false })
    }
  })

  test('describeServers：能起的给 executable，不能起的 available=false', () => {
    const dir = tempDir()
    const command = WIN ? 'present.exe' : 'present'
    const file = join(dir, command)
    writeFileSync(file, 'x', 'utf8')
    if (!WIN) chmodSync(file, 0o755)
    const servers: LspServerDef[] = [
      { id: 'present', languageId: 'p', extensions: ['.p'], command: file, args: [], markers: [] },
      { id: 'absent', languageId: 'q', extensions: ['.q'], command: join(dir, 'nope'), args: [], markers: [] },
    ]
    const info = describeServers(servers, {}, '')
    expect(info[0]).toMatchObject({ available: true, executable: file })
    expect(info[1]).toMatchObject({ available: false })
  })

  test('parseServerOverrides：空串 = 没有覆盖；坏 JSON / 非数组 / 逐项字段都拒', () => {
    expect(parseServerOverrides('  ')).toEqual({ servers: [], problem: null })
    expect(parseServerOverrides('{').problem).toContain('不是合法 JSON')
    expect(parseServerOverrides('{}').problem).toContain('要是一个数组')
    expect(parseServerOverrides('[1]').problem).toContain('不是对象')
    expect(parseServerOverrides('[{"command":"x","extensions":[".x"]}]').problem).toContain('id')
    expect(parseServerOverrides('[{"id":"x","extensions":[".x"]}]').problem).toContain('command')
    expect(parseServerOverrides('[{"id":"x","command":"c"}]').problem).toContain('extensions')
    expect(parseServerOverrides('[{"id":"x","command":"c","extensions":[]}]').problem).toContain('extensions')
    expect(parseServerOverrides('[{"id":"x","command":"c","extensions":[".x"],"args":[1]}]').problem).toContain('args')
    expect(parseServerOverrides('[{"id":"x","command":"c","extensions":[".x"],"markers":"m"}]').problem).toContain('markers')

    const ok = parseServerOverrides('[{"id":"Py","command":"pylsp","extensions":[".PY"]}]')
    expect(ok.problem).toBeNull()
    expect(ok.servers[0]).toEqual({
      id: 'Py',
      languageId: 'Py',
      extensions: ['.py'],
      command: 'pylsp',
      args: [],
      markers: [],
    })
  })

  test('mergeServers：新 id 排最前，同 id 就地顶掉，重复只留最后一份', () => {
    const builtin: LspServerDef[] = [
      { id: 'ts', languageId: 'ts', extensions: ['.ts'], command: 'ts', args: [], markers: [] },
      { id: 'py', languageId: 'py', extensions: ['.py'], command: 'py', args: [], markers: [] },
    ]
    const merged = mergeServers(builtin, [
      { id: 'new', languageId: 'n', extensions: ['.n'], command: 'n', args: [], markers: [] },
      { id: 'ts', languageId: 'ts', extensions: ['.ts'], command: 'ts2', args: ['--x'], markers: [] },
      { id: 'ts', languageId: 'ts', extensions: ['.ts'], command: 'ts3', args: [], markers: [] },
    ])
    expect(merged.map((server) => server.id)).toEqual(['new', 'ts', 'py'])
    expect(merged[1]!.command).toBe('ts3')
  })

  test('extensionOf / installHint：带点后缀、无后缀文件名、已知与否', () => {
    expect(extensionOf('/a/B.PY')).toBe('.py')
    expect(extensionOf('/a/Dockerfile')).toBe('dockerfile')
    expect(extensionOf('/a/home.blade.php')).toBe('.php')
    expect(installHint('typescript')).toContain('typescript-language-server')
    expect(installHint('nope')).toBeUndefined()
  })
})
