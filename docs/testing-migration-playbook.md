# 包级测试迁移手册（P1b：119 条 `.test.mjs` → `.spec.ts`）

> 这份手册给执行迁移的子代理看。设计依据在 `testing-design.md` §11 P1b 与
> `testing-detailed-design.md` §15.2，这里只写「具体怎么做、判据是什么」。

## 0 为什么要迁

现状 119 条包级测试用裸 `node` 跑（`scripts/package-tests.mjs`），没有统一断言库、
没有并发、没有快照、跑批要 73 秒且失败信息是裸栈。迁到 Vitest 后它们进 `pnpm test`
的统一报告，与内核 spec 用同一套断言语言。

## 1 两种写法，两套配方

先判断文件属于哪种：

```powershell
Select-String -Path <file> -Pattern "from 'node:test'"
```

### 1.1 `node:test` 风格（97 个文件）

结构已经是 `test()` / `describe()`，只换三样：

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 导入 | `import test from 'node:test'`、`import assert from 'node:assert/strict'` | `import { describe, expect, test } from 'vitest'` |
| 断言 | `assert.equal(a, b)` / `assert.deepEqual(a, b)` / `assert.ok(x)` | `expect(a).toBe(b)` / `expect(a).toEqual(b)` / `expect(x).toBe(true)` |
| 错误断言 | `assert.throws(fn, /msg/)` | `expect(fn).toThrow(/msg/)` |

映射表（常用部分）：

| node:assert | Vitest |
| --- | --- |
| `assert.equal` / `strictEqual` | `toBe` |
| `assert.deepEqual` / `deepStrictEqual` | `toEqual` |
| `assert.ok(x)` | `toBeTruthy()`（要判真值时用 `toBe(true)`） |
| `assert.match(s, re)` | `toMatch(re)` |
| `assert.throws(fn)` | `toThrow()` |
| `assert.rejects(p)` | `rejects.toThrow()` |
| `assert.doesNotThrow(fn)` | `not.toThrow()` |

### 1.2 自造 `check()` 风格（21 个文件）

这类文件开头自己写了个 `check(name, fn)` 或 `function check(...)`，逐条打印
`ok`/`FAIL` 并累加计数。**整份重写**：一条 `check(...)` → 一个 `test(...)`，
标题保留中文原意，断言改成 `expect`。计数与打印逻辑全部删掉——那是自造 runner，
Vitest 自己有。

这 21 个文件恰好是源码文本断言最集中的地方（`git`、`plan`、`mcp`、`memory`、
`web-search`、`skills`、`compact`、`todo`、`session`、`approval`、`settings` 等），
所以下面第 2 节主要冲它们来。

## 2 源码文本断言：必须重写，不许搬运

现状：99 个文件里 89 处 `assert.match(source, /.../)` 或读源码再 `toContain`。
典型形态：

```js
const source = readFileSync('src/packages/todo/index.ts', 'utf8')
assert.match(source, /name: 'todo_write'/)
```

**为什么不许搬运**：改引号、改缩进、把单引号换双引号 → 假红；把逻辑改坏但保留那串
字面量 → 假绿。它测的是「文件里有没有这句文本」，不是「程序做什么」。

按优先级选替代方案：

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **A 断言导出对象**（首选） | `import plugin from '../index.js'`，断言 `plugin.name`、`plugin.tool.schema`、注册表快照 | 被断言的字符串本来就是某个导出对象的字段 |
| **B 走公开 API 取真实结果** | 调导出函数/构造器，断言返回值 | 文本断言其实在描述某个函数的行为 |
| **C 删掉，换成等价行为用例** | 原文只是「这个常量存在」，而它已由 A/B 覆盖 | 剩下那些纯存在性断言 |
| **D 实在没有可测接缝** | 把断言的字符串提成源码里的具名导出，再断言该导出 | 字符串藏在函数体内部且无导出 |

选 D 时要动源码，**必须单独一次提交并写明理由**，不要和测试迁移混在一起。

## 3 迁移的机械步骤（每个文件）

1. `git mv src/packages/<id>/tests/<name>.test.mjs src/packages/<id>/tests/<name>.spec.ts`
2. 改导入：`../index.js` 这类相对路径保持不动（解析插件会把 `.js` 落到 `.ts`）；
   原来从 `../../../../lib/packages/<id>/index.js` 引的，改成 `../index.js`（源码面）。
3. 按第 1 节配方换断言库。
4. 按第 2 节处理源码文本断言。
5. 补类型：参数写类型注解，`any` 要说明为什么。
6. 跑单文件验证（见第 4 节）。
7. 提交。

## 4 单个文件的验收判据

```
pnpm exec vitest run --project unit src/packages/<id>/tests/<name>.spec.ts
```
- 退出码 0，用例数与迁移前**只许多不许少**（少的那条要说明为什么删）
- **反向验证**：故意改坏被测源码一处 → 该文件必须变红 → 改回必须变绿
- 迁移后 `node scripts/package-tests.mjs --list` 里该文件消失

## 5 批次划分

| 批 | 范围 | 文件数 | 难度 |
| --- | --- | --- | --- |
| A | 核心装配：agent、session、session-core、tools、tools-default、commands、commands-core、settings、config-core、presets、mode、prompt、runtime、runtime-api | 14 | 中（settings/session 有源码断言） |
| B | 权限与沙箱：approval、approval-floor、permission-core、permission-presets、sandbox(3)、guards、checkpoint(2)、hooks、host-stdio | 12 | 中 |
| C1 | 工具类上半：mcp、web-search、browser、cdp、computer-use、lsp、skills(3)、memory、tool-search | 13 | 高（`check()` 重写 + 源码断言最多） |
| C2 | 工具类下半：read/write/edit/glob/grep 所在包、ptc、ask、spill、image-diet、plan、goal、schedule、todo、compact、microcompact、transcript、log、doctor、ops、self-improve(3) | 22 | 高 |
| D1 | 界面侧前段：ui-actions、ui-ask、ui-boot、ui-browser、ui-composer、ui-core、ui-dockkit、ui-files、ui-layout、ui-palette、ui-plugins、ui-preview、ui-primitives | 13 | 中（注意界面半要 `@dsc/*` 与 jsdom 只在 ui project 生效；包级测试测的是宿主半，放 unit 层） |
| D2 | 界面侧后段：ui-prompt、ui-renderer、ui-runtime、ui-sessions、ui-settings、ui-skills、ui-slots、ui-status、ui-statusbar、ui-superagent(2)、ui-tasks、ui-team、ui-terminal、ui-trace、ui-transcript、desktop-dock(2)、tui | 18 | 中 |
| E | superagent(19)、cli、dsh-compat、llm、remote、subagent、webserver、waiting、surfaces、plugin-manager(2)、self-improve 已计 | 27 | 中（superagent 用 node:test，机械转换为主） |

## 6 收尾（全部迁完之后）

1. 删 `scripts/package-tests.mjs`。
2. 从 `package.json` 的 `check:plugin` 链里去掉 `node scripts/package-tests.mjs`。
3. 从 `.github/workflows/verify.yml` 的 `plugin` job 里去掉那一步（此时 PR 门已由 `pnpm test` 覆盖）。
4. 同步文档：`testing-design.md` §11 P1b、`testing-detailed-design.md` §15.2、§16。

**不要提前删**：`package-tests.mjs` 在还有 `.test.mjs` 时是唯一发现它们的入口，
提前删等于把没迁的测试静默丢掉。它第 91 行有「一个都没找到就报错」的保护，删之前在
`--list` 里确认是 0 条。
