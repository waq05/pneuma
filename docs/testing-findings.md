# 测试体系照出来的源码问题

> 写测试时发现的、与设计无关的实现问题。这里只记录**现象与判据**，修不修、怎么修由人判断。
> 每条都注明「谁发现的」「用什么输入复现」，方便复跑。

## 一、实现与注释不符

### F1 `strings.ts` 的 `oneLine` 按 UTF-16 代码单元截断，会把 emoji 劈开

- 文件：`src/core/strings.ts:31-35`
- 现象：`oneLine('😀😀', 1)` 返回 `'\ud83d…'`（孤立高代理），渲染出来可能是 `�`
- 注释原文写「超过 limit 个字符」，实现是 `flat.slice(0, limit)`，切的是代码单元不是字符
- 判据：一个 emoji 占两个代码单元，`limit` 为奇数时必劈
- 建议：`Array.from(flat).slice(0, limit).join('')`——但这是行为变更（同样 limit 下能保留的字更多），要先确认界面有没有依赖当前截断长度
- 发现：P1a 工具类 spec 批次（`src/core/strings.spec.ts` 钉住了现状，注释里写明「不是文档承诺」）

### F2 `records.ts` 的注释说「普通对象」，实现只排除数组

- 文件：`src/core/records.ts:14-24`
- 现象：`Date`、`Map`、类实例都算「记录」
- 判据：`isRecord(new Date())` 返回 true
- 影响：当前只喂 `JSON.parse` 的结果，无害；但它是个对外导出的判定函数，别人拿来判真对象就会放行
- 发现：同上（`src/core/records.spec.ts`）

### F3 `token-estimate.ts` 的注释漏了工具名

- 文件：`src/core/token-estimate.ts:67` 注释 vs 第 102 行实现
- 现象：注释说「assistant 正文与工具调用参数归 assistant」，实现把 `function.name` 也算进去了
- 方向一致（都算输入 token），属注释不完整，不影响正确性
- 发现：同上（`src/core/token-estimate.spec.ts`）

### F4 `bytes.ts` 在 10 KB 边界上多进一位

- 文件：`src/core/bytes.ts:25`
- 现象：`formatBytes(10238)` 与 `formatBytes(10239)` 输出 `'10 KB'`，与注释「10KB 以下保留一位小数」不符
- 判据：`toFixed(1)` 把 9.96 显示成 `10.0`，再由 `replace(/\.0$/,'')` 变成 `10`
- 影响：显示层面，`10 KB` 本身不难看，属窄边界注释不符
- 发现：同上（`src/core/bytes.spec.ts`）

## 二、行为与文档承诺不符（可能咬人）

### F11 `web-search` 算出了带 key 的请求头，但从没传出去（功能实际不可用）

- 文件：`src/packages/web-search/index.ts:222-231`
- 现象：第 222 行算出 `const headers = … { authorization: 'Bearer ' + key } / { 'X-API-KEY': key }`，
  第 230、231 行调 `search(provider, query, maxResults, signal)` 时**没有把它传进去**；
  而 `search()` 内部的三家提供方一律 `postJson(url, {}, body, signal)`，请求头是空的
- 判据：读 `search()` 签名（第 126 行）与三处 `postJson(..., {}, ...)`（第 137/156/166 行）；
  `grep '\bkey\b'` 显示 `key` 只用于「有没有配」的判断与这段死掉的 headers
- 影响：真 API 一律 401/403，联网搜索**一次都没成功过**。假 fetch 的测试也不会发现，
  因为测试只断言 URL 与 body
- 修法：`search()` 收一个 `headers` 参数，三处 `postJson` 把它带上；顺手给设置里的
  「测试连接」那条（第 365 行）也传
- 状态：C1 批迁移时发现，超出白名单没动。新测试**故意不断言 authorization 头**，
  也不写成「预期没有这个头」——那会把缺陷固化成期望


### F7 `diff-text.ts` 的 hunk 头新侧起点错一，首行替换时给 0

- 文件：`src/core/diff-text.ts:283`
  `newStart: first.newLine ?? rows[range.from - 1]?.newLine ?? 0`
- 现象（本机复现，走 `renderDiff(diffLines(...))`）：

  | 输入 | 实际输出 | GNU diff |
  | --- | --- | --- |
  | `'a\nb\nc'` → `'A\nb\nc'`，上下文 1 | `@@ -1,2 +0,2 @@` | `@@ -1,2 +1,2 @@` |
  | `'a\nb\nc'` → `'a\nB\nc'`，上下文 0 | `@@ -2 +1 @@` | `@@ -2 +2 @@` |

- 严重性：`+0` 不是合法行号；审查面板与模型看到的 hunk 行号与正文自相矛盾。hunk 以删除行开头时必错
- 修法：删除行开头时取「本段第一个有 `newLine` 的行」的行号；纯删除保持现状（已与 GNU 一致）
- 现状：测试**故意没有钉住错值**，只钉正文与旧侧起点，避免把缺陷固化成期望
- 发现：P1a 文本类 spec 批次（`src/core/diff-text.spec.ts`）

### F8 `text-format.ts` 的注释与实现差一个斜杠

- 文件：`src/core/text-format.ts:22,25`
- 现象：注释写 `/a/b/c/d → …/c/d`，实现产出 `…c/d`
- 影响：显示层面，一条短路径前缀少个斜杠
- 现状：测试按现状钉住并注明差异；若判定是缺陷，改实现时同批改那条用例
- 发现：同上

### F9 `unified-diff.ts` 对 CRLF 的 diff 取错文件路径

- 文件：`src/core/unified-diff.ts:98`，正则 `^a\/(.*) b\/(.*)$`
- 现象（本机复现）：喂 `diff --git a/src/a.ts b/src/a.ts\r\n--- …` 这类 CRLF diff，`splitUnifiedDiffByFile` 返回的 `path` 是整行 `'a/src/a.ts b/src/a.ts'`
- 原因：`(.*)` 不匹配 `\r`，而 `$` 要求整串结尾，于是整条匹配失败
- 影响：`parseUnifiedDiff` 本身能吃 CRLF，只有按文件切段这一支坏
- 修法：切出首行后 `.trim()` 再匹配，或正则改 `\r?$`
- 发现：同上

### F10 `redact.ts` 有四个真实的凭证形态漏抹（安全相关）

- 文件：`src/core/redact.ts`
- 实测未被抹除的输入：

  | 形态 | 例子 |
  | --- | --- |
  | AWS Access Key ID | `AKIAIOSFODNN7EXAMPLE` |
  | GitHub token | `ghp_xxxxxxxx…` |
  | OpenAI 风格密钥的大写写法 | `SK-…`（现有第四条规则没带 `i` 标志，只认小写 `sk-`） |
  | AWS secret 赋值形式 | `aws_secret_access_key=…` |
  | 不带 `Bearer` 前缀的裸 JWT | `eyJhbGci….eyJzdWIi….sig` |

- 影响：这些内容会原样进请求体发往模型提供方。前四种是真实常见形态
- 修法：补规则，或给第四条加 `i`。**注意**：加了 `i` 之后 `sk-` 会匹配到更多正常文本，要连带跑一遍「不误伤」的用例
- 现状：测试按现状写（没把漏抹当期望），并在用例标题里写明「已知盲区」
- 发现：同上（`src/core/redact.spec.ts`）

> F10 与 F11 是我认为该从「记录」升级成「尽快修」的两条：F10 把密钥发给第三方，
> F11 让联网搜索一次都没成功过。两条都不是显示问题。

### F5 `json-text.ts` 对 NaN / Infinity 返回字符串 `'null'`，不是 `null`

- 文件：`src/core/json-text.ts`
- 现象：`jsonText(NaN)` 返回字符串 `"null"`（`JSON.stringify` 对非有限数的行为），而循环引用 / BigInt / 函数返回的是 `null` 值
- 判据：调用方若用 `result === null` 判「序列化失败」，NaN 会被当成成功，拿到 `"null"` 这串文本
- 建议：统一成 `null`，或在注释里明确「非有限数会变成字符串 null」
- 发现：同上（`src/core/json-text.spec.ts`）

### F6 `terminal-env.ts` 在 Windows 上把 `sh` 列为可选 shell

- 文件：`src/core/terminal-env.ts` 的 `SHELL_CHOICES`
- 现象：`resolveShellExecutable('sh')` 在 Windows 上回落成 `'sh'`，spawn 可能 `ENOENT`
- 未判定：也可能是「配置跨平台共用，值原样传下去」的有意宽容
- 需要人判断：这是 bug 还是设计
- 发现：同上（`src/core/terminal-env.spec.ts`，本地是 Windows，只测到这一支）

## 四、复现记录（2026-11-13，本机 Windows / Node 24.19）

用一个临时 spec 直接调这三个导出，跑完即删：

```
F1  oneLine('😀😀', 1)      → "\ud83d…"     （长度 2：孤立高代理 + 省略号）
F4  formatBytes(10238)      → "10 KB"
    formatBytes(10239)      → "10 KB"
    formatBytes(10240)      → "10 KB"
F5  jsonText(NaN)           → string "null" （不是 null 值）
    jsonText(Infinity)      → string "null"
```

F2、F3 是读代码直接可判（`isRecord(new Date())`、注释与实现的归属），未单独跑；
F6 只在 Windows 上观察到这一支行为，未判定是 bug。

F7、F9 另跑过一遍（2026-11-13，走 `lib/` 编译产物）：

```
renderDiff(diffLines('a\nb\nc', 'A\nb\nc', 1)) → @@ -1,2 +0,2 @@     ← 新侧起点 0
renderDiff(diffLines('a\nb\nc', 'a\nB\nc', 0)) → @@ -2 +1 @@        ← 新侧少一
splitUnifiedDiffByFile(CRLF 的 diff)          → path = 'a/src/a.ts b/src/a.ts'
```

## 五、覆盖缺口（不是 bug，是没测到的面）

| 缺口 | 原因 | 该补在哪 |
| --- | --- | --- |
| `terminal-env.ts` 的探测/缓存族 8 个导出：`detectShells`、`shellsCached`、`forgetShellDetection`、`readShellChoice`、`wslDistroName`、`shellLabel`、`resolveShellExecutable`、`shellChoiceLabel` | 要么 spawn 子进程、要么读 `<DSC_HOME>/cache/shells.json`、要么读写模块级单例缓存，unit 层（node、5s、无 setup）注入不了假 HOME | integration 层，`tests/setup/temp-home.ts` 已具备 |
| `shellOf` 的 POSIX 分支 | 开发机是 Windows，只跑到 win32 那一支 | CI 的 ubuntu job，或打桩 `process.platform` |
