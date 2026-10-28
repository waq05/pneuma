/**
 * cmd.exe 那条路上的参数加引号（全仓库唯一一份）。
 *
 * 为什么单独一个模块：`core/mcp.ts` 起 MCP server、`core/lsp/client.ts` 起语言服务器，
 * 都在 Windows 上走 `shell: true`（命令由 cmd.exe 解析）；带空格或 `&|<>^` 的参数
 * 必须自己加双引号，否则会被 cmd 拆开。两处各写了一份逐字相同的实现，合并到这里。
 *
 * 顺带收着 `shellOf()`：两个跑钩子的模块（`core/hooks.ts`、`core/lifecycle-hooks.ts`）
 * 也各写了一份「该用哪个 shell、带什么参数」的逐字相同实现，同属「起 shell」这件事。
 *
 * 只在 shell 模式用；直接 spawn（不经 cmd）的参数不要过这一道——会被多套一层引号。
 *
 * @module dsc/core/shell-quote
 */

/** 含空白或 cmd 元字符就加双引号，内部双引号转义成 \"；否则原样返回。 */
export function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

/** 走 `-c` 那条路时该用哪个 shell：Windows 是 cmd.exe，其余是 /bin/sh。 */
export function shellOf(): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c'] }
    : { file: '/bin/sh', args: ['-c'] }
}
