# 测试迁移手册（通用）

> 这份手册给执行迁移的人看：把 `scripts/` 下用裸 `node` 跑的探针，或者旧的 `.test.mjs`，
> 迁进 Vitest。
>
> **P1b（119 条包级测试）已按这里的方法迁完**，那一批的配方与判据保留下来给 P3 复用。
> 设计依据在 [testing-design.md](testing-design.md) §11 与 [testing-detailed-design.md](testing-detailed-design.md) §15。

## 0 迁移对象与现状

| 批次 | 对象 | 状态 |
| --- | --- | --- |
| P1b | `src/packages/<id>/tests/*.test.mjs`（119 条） | ✅ 全部迁完，旧 runner `scripts/package-tests.mjs` 已删 |
| P2 | `scripts/*-test.mjs`（122 条内核探针） | ⏳ 122 → 20，其余见 [testing-backlog.md](testing-backlog.md) |
| P3 | `scripts/ui-*-test.mjs`（80 条界面探针） | 未开始 |

迁到 Vitest 的收益很具体：统一断言库、统一报告、能并行、能出覆盖率，失败信息不再是一段裸栈。

## 1 两种旧写法，两套配方

### 1.1 `node:test` 风格

```powershell
Select-String -Path <file> -Pattern "from 'node:test'"
```

结构已经是 `test()` / `describe()`，只换三样：

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 导入 | `import test from 'node:test'`、`import assert from 'node:assert/strict'` | `import { describe, expect, test } from 'vitest'` |
| 断言 | `assert.equal` / `assert.deepEqual` / `assert.ok` | `expect(a).toBe(b)` / `toEqual(b)` / `toBe(true)` |
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

### 1.2 自造 `check()` / `ok()` 风格

文件开头自己写了 `check(name, fn)`、`ok(...)` 或计数器，逐条打印 `ok`/`FAIL`。
**整份重写**：一条 `check(...)` → 一个 `test(...)`，标题保留中文原意，断言改成 `expect`。
计数与打印逻辑全部删掉——那是自造 runner，Vitest 自己有。

这类文件恰好是源码文本断言最集中的地方，所以第 2 节主要冲它们来。

## 2 源码文本断言：必须重写，不许搬运

典型形态：

```js
const source = readFileSync('src/packages/todo/index.ts', 'utf8')
assert.match(source, /name: 'todo_write'/)
```

**为什么不许搬运**：改引号、改缩进 → 假红；把逻辑改坏但保留那串字面量 → 假绿。
它测的是「文件里有没有这句文本」，不是「程序做什么」。

按优先级选替代方案：

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **A 断言导出对象**（首选） | `import plugin from '../index.js'`，断言 `plugin.name`、`plugin.tool.schema`、注册表快照 | 被断言的字符串本来就是某个导出对象的字段 |
| **B 走公开 API 取真实结果** | 调导出函数/构造器，断言返回值 | 文本断言其实在描述某个函数的行为 |
| **C 换成真判定**（比删更好） | `assert.match(source, /isUiMethod\('x'\)/)` → 直接 `expect(isUiMethod('x')).toBe(true)` | 被判定的函数本身有导出 |
| **D 删掉，换成等价行为用例** | 原文只是「这个常量存在」，而它已由 A/B 覆盖 | 剩下那些纯存在性断言 |
| **E 提成具名导出** | 把字符串提成源码里的导出，再断言它 | 字符串藏在函数体内部且无导出 |

选 E 要动源码，**必须单独一次提交并写明理由**，不要和测试迁移混在一起。

## 3 机械步骤（每个文件）

1. 决定落位（见第 6 节），建文件；旧的用 `git mv` 或新建后 `git rm` 旧文件。
2. 改导入：`../index.js` 这类相对路径保持不动（解析插件会把 `.js` 落到 `.ts`）；
   原来从 `lib/packages/<id>/index.js` 引的，改成源码入口。
3. 按第 1 节配方换断言库。
4. 按第 2 节处理源码文本断言。
5. 补类型：参数写类型注解，`any` 要说明为什么。
6. 反向验证（见第 4 节）。
7. 提交：`git add` + `git commit --only -- <路径>`。

## 4 单文件验收判据

```
pnpm exec vitest run --project <unit|integration|ui|tui> <file>
```

- 退出码 0，用例数与迁移前**只许多不许少**（少的那条要说明为什么删）
- **反向验证**：故意改坏被测源码一处 → 该文件必须变红 → 改回必须变绿。
  改 `src` 后 integration 层要 `pnpm run build` 才生效（D25）。**第一次跑绿不要当结论**，复跑一次。
- 迁移后 `node scripts/check-core.mjs --list`（或 `--list` 对应的旧 runner）里该文件消失

## 5 删探针：看剩下的是什么性质

| 剩下的是什么 | 删不删 | 说明 |
| --- | --- | --- |
| **行为断言**（有可观察行为还没迁完） | **不删** | D24：删早了等于静默丢覆盖，宁可两处并存 |
| **纯源码文本断言** | **删** | 按第 2 节本身就是必删项，留着不算覆盖 |
| **纯注释 / 类型字面量** | **删** | 编译期或纯文字，没有运行期行为 |

删掉的那批**必须逐条进** [testing-backlog.md](testing-backlog.md) 的 B 表，三列写清：
原来钉什么、为什么没有等价行为、该补在哪一层。**不记 = 静默丢覆盖**，比留着更糟。

## 6 落位规则

| 被测对象 | 落哪 | project |
| --- | --- | --- |
| 某个模块的纯函数 | 与源码同目录 `<module>.spec.ts` | `unit` |
| 某个模块但需要真内核/真文件 | 与源码同目录 `<module>.int.spec.ts` | `integration` |
| 跨领域、或「整套装配之后才成立」 | `tests/integration/<topic>.int.spec.ts` | `integration` |
| React 组件（jsdom） | `src/packages/<id>/ui/**/*.spec.{ts,tsx}` | `ui` |
| ink 整屏帧 / 鼠标序列 | `src/packages/tui/**/*.spec.{ts,tsx}` | `tui` |

**后缀很重要**：`.int.spec.ts` 会被 integration 收走；`tui` 与 `ui` 的文件名**不能带 `.int`**。
每个 project 的 exclude 里那行 `*.int.spec.ts` 不是装饰——`*.spec.ts` 的星号跨点不跨目录，
漏了就会双跑或串层（这个错犯过四次）。

## 7 已完成批次的记录（供参考，不要重做）

| 批 | 范围 | 结果 |
| --- | --- | --- |
| A | 核心装配 14 包 | 72 条 |
| B | 权限与沙箱 12 文件 | 106 条 |
| C1/C2 | 工具类 11 + 功能包 17 | 66 + 122 条 |
| D1/D2 | 界面侧 13 + 19 | 67 + 97 条 |
| E | superagent 等 29 文件 | 228 条 |
| F | git / dock-browser / session-search / session-title | 28 条 |

包级测试总计：119 个 spec、806 条用例。旧 runner 与 `check:plugin` 里那一步、`verify.yml` 的
`plugin` job 都已删除。
