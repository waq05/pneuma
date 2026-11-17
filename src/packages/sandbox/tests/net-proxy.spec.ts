/**
 * 出网白名单代理（`src/packages/sandbox/net-proxy.ts`）：总开关、白名单、CONNECT 中继、日志。
 *
 * 用本机回环上的假上游，不碰外网：放行路径验「真的转发了」，阻断路径验「403 且一个字节
 * 都没出」。日志是 `/sandbox` 诊断的唯一证据，条数上限也在这儿钉。
 *
 * @module dsc/packages/sandbox/tests/net-proxy.spec
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { createNetProxy, proxyEnvVars, type NetProxy } from '../net-proxy.js'

const proxies: NetProxy[] = []
const servers: Array<{ close: (done?: () => void) => void }> = []

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close()
  for (const server of servers.splice(0)) server.close()
})

/** 起一个回环 HTTP 上游，回显请求体。 */
async function upstreamHttp(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      hits.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`upstream:${req.url ?? ''}`)
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  servers.push(server)
  return { port: (server.address() as AddressInfo).port, hits }
}

/** 起一个回环 TCP 回显上游。 */
async function upstreamTcp(): Promise<number> {
  const server = createTcpServer((socket) => {
    socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`))
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  servers.push(server)
  return (server.address() as AddressInfo).port
}

/** 走代理发一次绝对形式 HTTP 请求。 */
function viaProxy(
  proxy: NetProxy,
  url: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolveDone, rejectDone) => {
    const request = httpRequest({ host: '127.0.0.1', port: proxy.port, path: url, method }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolveDone({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    request.on('error', rejectDone)
    request.end()
  })
}

/** 走代理发 CONNECT，成功后发一段数据并等上游回显。 */
function connectThrough(proxy: NetProxy, target: string): Promise<{ head: string; echoed: string }> {
  return new Promise((resolveDone, rejectDone) => {
    const socket = tcpConnect(proxy.port, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`)
    })
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('HTTP/1.1 200') && !buffer.includes('echo:')) {
        socket.write('ping')
        return
      }
      if (buffer.includes('403')) {
        socket.end()
        rejectDone(new Error(buffer))
        return
      }
      if (buffer.includes('echo:')) {
        const head = buffer.slice(0, buffer.indexOf('\r\n\r\n'))
        const echoed = buffer.slice(buffer.indexOf('echo:'))
        socket.end()
        resolveDone({ head, echoed })
      }
    })
    socket.on('error', rejectDone)
    socket.setTimeout(5_000, () => {
      socket.destroy()
      rejectDone(new Error(`CONNECT 超时：${buffer}`))
    })
  })
}

describe('proxyEnvVars', () => {
  test('大小写都给，NO_PROXY 置空', () => {
    expect(proxyEnvVars('http://127.0.0.1:1234')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:1234',
      HTTPS_PROXY: 'http://127.0.0.1:1234',
      http_proxy: 'http://127.0.0.1:1234',
      https_proxy: 'http://127.0.0.1:1234',
      ALL_PROXY: 'http://127.0.0.1:1234',
      all_proxy: 'http://127.0.0.1:1234',
      NO_PROXY: '',
      no_proxy: '',
    })
  })
})

describe('HTTP 绝对形式', () => {
  test('总开关关了：403 + 可读原因，日志记阻断', async () => {
    const proxy = await createNetProxy({ online: () => false, allowlist: () => ['127.0.0.1'] })
    proxies.push(proxy)
    const response = await viaProxy(proxy, `http://127.0.0.1:1/x`)
    expect(response.status).toBe(403)
    expect(response.body).toContain('网络开关是关的')
    expect(proxy.log().at(-1)).toMatchObject({ host: '127.0.0.1', allowed: false })
  })

  test('白名单为空：403 说明「开了网也没放任何域名」', async () => {
    const proxy = await createNetProxy({ online: () => true, allowlist: () => [] })
    proxies.push(proxy)
    const response = await viaProxy(proxy, 'http://example.com/x')
    expect(response.status).toBe(403)
    expect(response.body).toContain('白名单是空的')
  })

  test('在白名单里：真的转发到上游，日志放行', async () => {
    const upstream = await upstreamHttp()
    const proxy = await createNetProxy({ online: () => true, allowlist: () => ['127.0.0.1'] })
    proxies.push(proxy)
    const response = await viaProxy(proxy, `http://127.0.0.1:${String(upstream.port)}/hello`)
    expect(response.status, response.body).toBe(200)
    expect(response.body).toBe('upstream:/hello')
    expect(proxy.log().at(-1)).toMatchObject({ host: '127.0.0.1', allowed: true, why: '在白名单里' })
  })

  test('认不出目标主机：400，不进日志', async () => {
    const proxy = await createNetProxy({ online: () => true, allowlist: () => ['x'] })
    proxies.push(proxy)
    const response = await new Promise<number>((resolveDone, rejectDone) => {
      // 相对路径按 Host 头判；故意给一个认不出的 Host。
      const request = httpRequest(
        { host: '127.0.0.1', port: proxy.port, path: '/relative', method: 'GET', headers: { host: 'bad' } },
        (res) => {
        res.resume()
        resolveDone(res.statusCode ?? 0)
      })
      request.on('error', rejectDone)
      request.end()
    })
    expect(response).toBe(400)
    expect(proxy.log()).toHaveLength(0)
  })

  test('日志条数上限：环形裁剪', async () => {
    const proxy = await createNetProxy({ online: () => false, allowlist: () => [], keep: 3 })
    proxies.push(proxy)
    for (let index = 0; index < 5; index += 1) {
      await viaProxy(proxy, `http://host${String(index)}.test/x`)
    }
    const log = proxy.log()
    expect(log).toHaveLength(3)
    expect(log.map((entry) => entry.host)).toEqual(['host2.test', 'host3.test', 'host4.test'])
  })
})

describe('CONNECT 中继', () => {
  test('在白名单里：200 建连并双向透传', async () => {
    const port = await upstreamTcp()
    const proxy = await createNetProxy({ online: () => true, allowlist: () => ['127.0.0.1'] })
    proxies.push(proxy)
    const { head, echoed } = await connectThrough(proxy, `127.0.0.1:${String(port)}`)
    expect(head).toContain('200')
    expect(echoed).toContain('echo:ping')
  })

  test('不在白名单：403 并说明拒因', async () => {
    const proxy = await createNetProxy({ online: () => true, allowlist: () => ['allowed.test'] })
    proxies.push(proxy)
    await expect(connectThrough(proxy, '127.0.0.1:1')).rejects.toThrow()
    expect(proxy.log().at(-1)).toMatchObject({ host: '127.0.0.1', allowed: false })
    expect(proxy.log().at(-1)?.why).toContain('不在出网白名单里')
  })
})
