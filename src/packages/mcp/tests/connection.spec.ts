/**
 * MCP 连接层（`packages/mcp/mcp.ts` 的 `openConnection`）：stdio 握手、工具/资源/提示模板
 * 的翻页与结果归并、反向 elicitation、错误与超时。
 *
 * 对端是 `tests/fixtures/fake-mcp-server.mjs`（真 node 子进程，按行 JSON-RPC）。
 * 插件层怎么把连接挂成工具在 `mcp.spec.ts` 里用假连接测过；这里只管通道与协议。
 *
 * @module dsc/packages/mcp/tests/connection.spec
 */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { openConnection, type McpConnection, type McpServerConfig } from '../mcp.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
const open: McpConnection[] = []

afterEach(() => {
  for (const connection of open.splice(0)) {
    try {
      connection.close()
    } catch {
      // 已经断了
    }
  }
})

function serverOf(mode: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture, mode],
    cwd: '',
    env: {},
    url: '',
    headers: {},
    risk: {},
    defaultRisk: 'read',
    ...overrides,
  }
}

const options = { connectTimeoutMs: 5_000, callTimeoutMs: 5_000, onClose: () => undefined }
const signal = (): AbortSignal => AbortSignal.timeout(5_000)

async function connect(mode: string, overrides: Partial<McpServerConfig> = {}, extra: Partial<typeof options> = {}): Promise<McpConnection> {
  const connection = await openConnection(serverOf(mode, overrides), { ...options, ...extra })
  open.push(connection)
  return connection
}

describe('握手', () => {
  test('谈成 server 回的旧版本；instructions 与能力声明带回来；close 后 alive 变假', async () => {
    const connection = await connect('ok')
    expect(connection.protocolVersion).toBe('2025-03-26')
    expect(connection.instructions).toContain('用法说明')
    expect(connection.capabilities).toEqual({ resources: true, prompts: true })
    expect(connection.alive).toBe(true)
    connection.close()
    expect(connection.alive).toBe(false)
    await expect(connection.listTools(signal())).rejects.toThrow(/已经关了/)
  })

  test('协议版本不在支持集合：握手失败并说清版本', async () => {
    await expect(connect('bad-version')).rejects.toThrow(/1999-01-01.*不在 dsc 支持的范围/)
  })

  test('命令解析不到：不 spawn，直接说 PATH 里找不到', async () => {
    await expect(connect('ok', { command: 'no-such-mcp-bin-xyz' })).rejects.toThrow(/no-such-mcp-bin-xyz/)
  })

  test('server 不回应：握手超时', async () => {
    await expect(connect('silent', {}, { connectTimeoutMs: 250 })).rejects.toThrow(/闸门已开|没回/)
  })
})

describe('工具、资源与提示模板', () => {
  test('tools/list 翻页到底；没有名字的项丢掉；游标兜圈立刻收手', async () => {
    const connection = await connect('pages')
    const tools = await connection.listTools(signal())
    expect(tools.map((tool) => tool.name)).toEqual(['first', 'second'])
    expect(tools[0]).toMatchObject({ description: '第一个', parameters: { type: 'object' } })
  })

  test('tools/call：文本拼起来，图片只留一句说明；isError 原样带回', async () => {
    const connection = await connect('ok')
    const result = await connection.callTool('echo', { text: '你好' }, signal())
    expect(result.text).toContain('echo:你好')
    expect(result.text).toContain('[image 类型的内容')
    expect(result.isError).toBe(false)
  })

  test('JSON-RPC error：带 code 的错误话术', async () => {
    const connection = await connect('error')
    await expect(connection.callTool('boom', {}, signal())).rejects.toThrow(/MCP 错误 -32000：工具炸了/)
  })

  test('资源：列表跳过坏项；正文把 blob 翻成一句说明', async () => {
    const connection = await connect('ok')
    const resources = await connection.listResources(signal())
    expect(resources).toEqual([{ uri: 'file:///a.txt', name: 'A', description: '', mimeType: 'text/plain' }])
    const read = await connection.readResource('file:///a.txt', signal())
    expect(read.text).toContain('第一段')
    expect(read.text).toContain('二进制资源（image/png）')
    expect(read.isError).toBe(false)
  })

  test('提示模板：参数名只留字符串项；取模板把消息拼成 [角色] 正文', async () => {
    const connection = await connect('ok')
    const prompts = await connection.listPrompts(signal())
    expect(prompts).toEqual([{ name: 'greet', description: '打招呼', arguments: ['who'] }])
    const prompt = await connection.getPrompt('greet', { who: '小明' }, signal())
    expect(prompt.text).toContain('[user]')
    expect(prompt.text).toContain('你好 小明')
  })

  test('server 没声明能力：capabilities 两项都是假（插件据此不注册那两件工具）', async () => {
    const connection = await connect('nocaps')
    expect(connection.capabilities).toEqual({ resources: false, prompts: false })
  })
})

describe('反向 elicitation（stdio 专有）', () => {
  test('有处理器：把客户端答复的动作带回工具结果', async () => {
    const answers: Array<{ message: string }> = []
    const connection = await connect('elicit', {}, {
      onElicitation: async (request) => {
        answers.push({ message: request.message })
        return { action: 'accept' }
      },
    })
    const result = await connection.callTool('ask', {}, signal())
    expect(answers[0]?.message).toBe('要确认吗')
    expect(result.text).toBe('elicit:accept')
  })

  test('没处理器：按不支持回错误，server 回 refused', async () => {
    const connection = await connect('elicit')
    const result = await connection.callTool('ask', {}, signal())
    expect(result.text).toBe('elicit:refused')
  })
})
