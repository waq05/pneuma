/**
 * harness 的 unit 层用例：只碰临时目录、本机回环假端点与 golden 文件。
 *
 * 真内核与真入口（`bootKernel` / `runCli`）放在同目录的 `harness.int.spec.ts`：
 * 它们要起真进程与插件图，unit 层 5 秒预算与「不碰真内核」的规矩都容不下。
 *
 * @module dsc/tests/harness.spec
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fakeLLM, readSessionJsonl, tempHome, type FakeLLM } from './harness.js'

/** 清理栈：每条用例自己登记，红了也照样在 afterEach 里执行。 */
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** golden 测试会真的往 `tests/snapshots/golden/` 写文件；目录原先不存在时连目录一起收掉。 */
const GOLDEN_DIR = join(process.cwd(), 'tests', 'snapshots', 'golden')
const GOLDEN_DIR_EXISTED = existsSync(GOLDEN_DIR)

/** 删掉一条自测 golden；目录是本条用例新建的且空了，就顺手删目录，避免 untracked 噪声。 */
function cleanGolden(name: string): void {
  rmSync(join(GOLDEN_DIR, `${name}.txt`), { force: true })
  if (!GOLDEN_DIR_EXISTED) {
    try {
      rmSync(GOLDEN_DIR, { recursive: false })
    } catch {
      // 目录里还有别的 golden（并发或上一轮没清干净）就留着，删失败不是测试失败。
    }
  }
}

/** 每条用例独立的临时工作目录。 */
let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dsc-harness-unit-'))
  cleanups.push(() => {
    rmSync(work, { recursive: true, force: true })
  })
})

/** 解析 SSE 文本里的 `data:` 帧，`[DONE]` 不算一帧。 */
function ssePayloads(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

/** 从 SSE 帧里拼出正文增量。 */
function textOf(text: string): string {
  return ssePayloads(text)
    .flatMap((payload) => (payload.choices as Array<{ delta?: { content?: string } }> | undefined) ?? [])
    .map((choice) => choice.delta?.content ?? '')
    .join('')
}

/** 从 SSE 帧里取出第一个工具调用增量。 */
function toolCallOf(text: string): { id?: string; function: { name: string; arguments: string } } | undefined {
  const calls = ssePayloads(text).flatMap(
    (payload) =>
      (payload.choices as
        | Array<{ delta?: { tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }> } }>
        | undefined) ?? [],
  )
  return calls.flatMap((choice) => choice.delta?.tool_calls ?? [])[0]
}

/** 发一次 OpenAI 兼容的流式请求；返回状态与完整 SSE 文本。 */
async function postChat(fake: FakeLLM, messages: unknown[]): Promise<{ status: number; text: string }> {
  const response = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages, stream: true }),
  })
  return { status: response.status, text: await response.text() }
}

describe('tempHome', () => {
  test('把 HOME 与 USERPROFILE 同时指向新建的临时目录', () => {
    // 只改一个在另一个平台上就是「没隔离」；两个都断言，漏改一个立刻红。
    const created = tempHome()
    cleanups.push(() => {
      created.restore()
      rmSync(created.home, { recursive: true, force: true })
    })
    expect(existsSync(created.home)).toBe(true)
    expect(created.home.startsWith(tmpdir())).toBe(true)
    expect(process.env.HOME).toBe(created.home)
    expect(process.env.USERPROFILE).toBe(created.home)
  })

  test('restore 还原成调用前的值，临时目录保留（不是删掉）', () => {
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    const created = tempHome()
    created.restore()
    expect(process.env.HOME).toBe(before.HOME)
    expect(process.env.USERPROFILE).toBe(before.USERPROFILE)
    // 失败时目录要留着翻日志；这里只验证 restore 没删它，随后由用例自己收尾。
    expect(existsSync(created.home)).toBe(true)
    rmSync(created.home, { recursive: true, force: true })
  })

  test('restore 可重复调用：afterEach 与 afterAll 同时注册也不会改坏环境', () => {
    const created = tempHome()
    created.restore()
    const afterFirst = process.env.HOME
    created.restore()
    expect(process.env.HOME).toBe(afterFirst)
    rmSync(created.home, { recursive: true, force: true })
  })

  test('前缀带路径分隔符或 ".." 时拒绝：否则目录会建到临时目录外面', () => {
    expect(() => tempHome('../escape-')).toThrow(/路径分隔符|\.\./)
    expect(() => tempHome('a/b-')).toThrow(/路径分隔符/)
    expect(() => tempHome('')).toThrow(/非空字符串/)
  })
})

describe('readSessionJsonl', () => {
  test('跳过空行、坏行与非对象行，返回对象数组', () => {
    const file = join(work, 'session.jsonl')
    // 首行带 BOM、中间混入半截 JSON 与数组/数字：三种都不是会话记录，应该被剥掉。
    writeFileSync(
      file,
      '\uFEFF{"type":"meta","id":"m1"}\n\n{"type":"user","text":"hi"}\nnot-json\n[1,2]\n42\n{"type":"tool","callId":"c1"}\n',
      'utf8',
    )
    const records = readSessionJsonl(file)
    expect(records.map((record) => record.type)).toEqual(['meta', 'user', 'tool'])
  })

  test('文件不存在时抛可读错误，而不是返回空数组（空数组会让「没有 X」恒真）', () => {
    expect(() => readSessionJsonl(join(work, 'missing.jsonl'))).toThrow(/读不到会话文件/)
  })

  test('路径不是非空字符串时拒绝', () => {
    expect(() => readSessionJsonl('')).toThrow(/非空字符串/)
    expect(() => readSessionJsonl(undefined as never)).toThrow(/非空字符串/)
  })
})

describe('fakeLLM', () => {
  test('纯文本轮按探针的 SSE 形状应答：content 增量 + finish_reason + usage + [DONE]', async () => {
    // 这四段照抄 scripts/todo-reminder-test.mjs:154-163；少任何一段都会被真内核放大成
    // 超时或用量恒 0，所以逐段钉住，而不是只断言「响应里出现了你好」。
    const fake = await fakeLLM({ turns: ['你好'] })
    cleanups.push(() => void fake.close())
    const response = await postChat(fake, [{ role: 'user', content: '在吗' }])
    expect(response.status).toBe(200)
    expect(response.text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    const payloads = ssePayloads(response.text)
    expect(payloads[0]).toEqual({ choices: [{ delta: { content: '你好' } }] })
    expect(payloads.some((payload) => (payload.choices as Array<{ finish_reason?: string }>)[0]?.finish_reason === 'stop')).toBe(true)
    expect(payloads.find((payload) => (payload.choices as unknown[]).length === 0)?.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
    })
    expect(fake.bodies).toEqual([[{ role: 'user', content: '在吗' }]])
    expect(fake.requestCount).toBe(1)
  })

  test('工具调用轮：parameters 以 JSON 字符串上线、finish_reason 是 tool_calls', async () => {
    const fake = await fakeLLM({ turns: [{ toolCall: { name: 'read', args: { path: 'a.txt' } } }] })
    cleanups.push(() => void fake.close())
    const response = await postChat(fake, [{ role: 'user', content: '读文件' }])
    const call = toolCallOf(response.text)
    expect(call?.id).toBe('call_fake_1')
    expect(call?.function.name).toBe('read')
    // 线上协议里 arguments 是字符串，不是对象；写成对象真内核会当作坏块。
    expect(call?.function.arguments).toBe('{"path":"a.txt"}')
    expect(JSON.parse(call!.function.arguments)).toEqual({ path: 'a.txt' })
    expect(
      ssePayloads(response.text).some(
        (payload) => (payload.choices as Array<{ finish_reason?: string }>)[0]?.finish_reason === 'tool_calls',
      ),
    ).toBe(true)
  })

  test('剧本用完后继续用最后一条', async () => {
    const fake = await fakeLLM({ turns: ['第一轮'] })
    cleanups.push(() => void fake.close())
    await postChat(fake, [{ role: 'user', content: 'a' }])
    const second = await postChat(fake, [{ role: 'user', content: 'b' }])
    expect(textOf(second.text)).toBe('第一轮')
    expect(fake.requestCount).toBe(2)
  })

  test('标题请求单独应答：不占轮次、不记进 bodies', async () => {
    // 判据抄自 scripts/todo-reminder-test.mjs:183-190。这类请求若吃掉一轮剧本，
    // 后面所有轮次错位，失败会看起来「随机」。
    const fake = await fakeLLM({ turns: ['真实回答'] })
    cleanups.push(() => void fake.close())
    const title = await postChat(fake, [{ role: 'system', content: '你是会话标题生成器。根据对话起标题。' }])
    expect(textOf(title.text)).toBe('测试会话标题')
    expect(fake.requestCount).toBe(0)
    expect(fake.bodies).toHaveLength(0)

    const convo = await postChat(fake, [{ role: 'user', content: '真实对话' }])
    expect(textOf(convo.text)).toBe('真实回答')
    expect(fake.requestCount).toBe(1)
  })

  test('onRequest 收到原始请求体与轮次：标题请求是 0，会话请求从 1 起', async () => {
    const seen: Array<{ turn: number; count: number }> = []
    const fake = await fakeLLM({
      turns: ['a', 'b'],
      onRequest: (body, turn) => {
        seen.push({ turn, count: (body as { messages: unknown[] }).messages.length })
      },
    })
    cleanups.push(() => void fake.close())
    await postChat(fake, [{ role: 'system', content: '你是会话标题生成器。' }])
    await postChat(fake, [{ role: 'user', content: '第一句' }])
    await postChat(fake, [{ role: 'user', content: '第二句' }])
    // count 也一起断言：钩子拿到的是「原始请求体」，不是被裁过的 messages。
    expect(seen).toEqual([
      { turn: 0, count: 1 },
      { turn: 1, count: 1 },
      { turn: 2, count: 1 },
    ])
  })

  test('自定义 isTitleRequest 替换默认判据（不是叠加）', async () => {
    const fake = await fakeLLM({
      turns: ['走对话'],
      isTitleRequest: (body) => JSON.stringify(body).includes('TITLE-MARK'),
    })
    cleanups.push(() => void fake.close())
    // 默认判据认的这句提示词，在自定义判据下必须被当成普通会话请求。
    const response = await postChat(fake, [{ role: 'system', content: '你是会话标题生成器。' }])
    expect(fake.requestCount).toBe(1)
    expect(textOf(response.text)).toBe('走对话')
  })

  test('turns 为空 / 轮次形状错误 / 参数不可序列化时，起服务前就报可读的错', async () => {
    await expect(fakeLLM({ turns: [] })).rejects.toThrow(/turns 不能为空/)
    await expect(fakeLLM({ turns: [42 as never] })).rejects.toThrow(/第 1 轮/)
    await expect(fakeLLM({ turns: [{ toolCall: { args: {} } } as never] })).rejects.toThrow(/name/)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(fakeLLM({ turns: [{ toolCall: { name: 'x', args: circular } }] })).rejects.toThrow(/序列化/)
  })

  test('两个端点各自随机端口，并行不会撞端口', async () => {
    const first = await fakeLLM({ turns: ['a'] })
    const second = await fakeLLM({ turns: ['b'] })
    cleanups.push(() => void first.close())
    cleanups.push(() => void second.close())
    expect(first.baseUrl).not.toBe(second.baseUrl)
    expect(first.baseUrl.startsWith('http://127.0.0.1:')).toBe(true)
  })

  test('close 可重复调用；钩子抛错会让 close 抛错，不静默放过', async () => {
    const fake = await fakeLLM({
      turns: ['a'],
      onRequest: () => {
        throw new Error('钩子里的断言失败')
      },
    })
    const response = await postChat(fake, [{ role: 'user', content: 'x' }])
    // 400 而不是 500：500 会被内核的可重试清单接住，重试三次只是把同一错误拖长。
    expect(response.status).toBe(400)
    await expect(fake.close()).rejects.toThrow(/没有被正常应答/)
    await expect(fake.close()).rejects.toThrow(/没有被正常应答/)
  })
})

