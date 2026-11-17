# 测试操作手册（给 agent）

> 读者：第一次在这个仓库跑测试、或要给某个改动补测试的 agent。
> 目标：**三分钟内选对层、跑对命令、拿到可引用的结论**；不理解体系也能照做。
> 想先懂「为什么这样设计」，读 [testing-101.md](testing-101.md) 与 [testing-design.md](testing-design.md)；本文只讲「怎么做」。

---

## 0 三十秒判断

拿到任务先回答三个问题：

1. **改的是不是产品代码？** 是 → 必须补对应层的测试（见 §2）。
2. **改动碰没碰 `src/core/**` 或插件装配？** 碰了 → 先 `pnpm run build`，再跑 integration（见 §3）。
3. **这次要动的测试会不会写用户目录？** 会 → 用 `createTempDir()` / `tempHome()`，不要自己 `mkdtempSync`（见 §4）。

---

## 1 一张图

```
                     ┌ unit     src/**/*.spec.ts（纯函数/模块）
                     ├ ui       src/packages/*/ui/**/*.spec.tsx（jsdom）
pnpm test ───────────┤ tui      src/packages/tui/**（假终端）
                     └ （三层同时跑，PR 门）

pnpm run test:int ─── integration  *.int.spec.ts（真内核 + 临时 HOME，先 build）
pnpm run test:snapshot ─ snapshot  TUI 整屏帧 + 浏览器 DOM golden
pnpm run test:e2e ─── e2e        真 Electron + 真宿主（需要产物 + Electron）
pnpm run test:cli ─── cli        spawn 真 bin/dsc.js（先 build）
pnpm run test:built ── built     只验 lib/ 产物
pnpm run test:live ── live       真模型（要 key，没 key 整层 skip）
pnpm run test:coverage ─ 五层全跑 + 覆盖率门
```

快照层的会话场景默认整段 skip（当前仓库没有 `session.jsonl`）：收集期打一条 `console.warn`，要让它变红用 `DSC_SNAPSHOT_STRICT=1`。

---

## 2 选层：改什么，跑什么，为什么

| 改动面 | 命令 | 为什么是这一层 |
| --- | --- | --- |
| 纯函数、数据结构、插件包内部逻辑 | `pnpm exec vitest run --project unit <文件>` | 毫秒级，不碰网络与磁盘 |
| 会话落盘、插件加载、内核装配、工具执行 | `pnpm run test:int` | 要起真内核，必须读 `lib/`（命令自带 build） |
| React 组件、样式、交互 | `pnpm exec vitest run --project ui <文件>` | jsdom 渲染，不启 Electron |
| ink 终端界面 | `pnpm run test:tui` | 假终端抓帧，不能用 jsdom |
| TUI 帧、浏览器 DOM 的整屏结构 | `pnpm run test:snapshot` | golden 逐字节比，改结构必须更新 golden；会话场景默认 skip + warn，要让它红用 `DSC_SNAPSHOT_STRICT=1` |
| 真入口（`bin/dsc.js`）行为 | `pnpm run test:cli` | 必须 spawn 真进程，先 build |
| 真产物形状（`lib/ui/plugins/*/client.js`、SDK 类型树） | `pnpm run test:built` | 故意绕开 `src` 别名验产物 |
| 真 Electron 全链路、真宿主 | `pnpm run test:e2e` | 单条 10–60 秒，不进 PR 门 |
| 真模型冒烟 | `pnpm run test:live` | 要钱要 key，没有就 skip |
| 交付前看覆盖率 | `pnpm run test:coverage` | 五层全跑，约 7–8 分钟 |

**单条用例**：`pnpm exec vitest run --project unit <文件> -t "用例名片段"`。
**不确定该跑哪层**：先 `pnpm test`，红了再看红在哪个后缀（`.int.spec.ts` 就不是 unit 的活）。

---

## 3 跑之前的三个前提

1. **integration / cli / e2e / built 必须先构建**。
   `pnpm run build` 产出 `lib/`；界面相关还要 `pnpm -C ui-shell build`。
   忘了构建的表现不是「测试红」，是 `bootKernel` 直接抛：**「lib/ 比源码旧，先跑 pnpm run build」**（`tests/harness.ts:992`）。看到这句就去构建，别改测试。
2. **e2e 还要 Electron**：`desktop/node_modules/electron` 在才行；不满足时用例**显式 skip 并写原因**，不是静默绿。
3. **live 要 `DSC_LIVE_*` 之类的 key**（见 `vitest.live.config.ts` 头注释）；没 key 整层 skip 是预期行为，不算通过。

---

## 4 写一条测试：四个骨架

### 4.1 unit（最常用）

```ts
import { describe, expect, test } from 'vitest'
import { 被测函数 } from '../被测模块.js'   // 注意：带 .js 后缀，Vite 会回落 .ts

describe('什么条件下', () => {
  test('期望什么', () => {
    expect(被测函数(输入)).toBe(期望)
  })
})
```

规矩：
- **只 import `src/**`**，绝不 import `lib/**`（那是产物，改源码不重建就看不到变化）。
- 测行为，不测实现：别断言「内部调了几次 `slice`」，断言「压缩后剩几轮」。
- 一条用例只断言一件事；红了能立刻定位。
- 不读源码文本当断言（`read(FILE).includes('class-name')` 是假绿高发区）。

### 4.2 integration（要真内核）

```ts
import { afterAll, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome } from '../../harness.js'

const { home, restore } = tempHome()
afterAll(restore)
const llm = await fakeLLM({ turns: [{ content: '收到' }] })
const kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
afterAll(async () => {
  await kernel.dispose()
  await llm.close()
})

test('发一句话，落盘一条会话', async () => {
  await kernel.runTurn('你好')
  expect(读会话(home)).toContain('你好')
})
```

要点：
- `fakeLLM` 返回 `{ baseUrl, bodies, requestCount, close }`；`bodies` 是模型真正收到的 `messages`，断言「模型看到了什么」用它，别猜。
- `tempHome()` 会换 `HOME`/`USERPROFILE`；integration 项目另有 `tests/setup/temp-home.ts` 兜底。
- `bootKernel` 起的是「宿主来自 src、插件来自 lib」的混合体，所以**先 build**。
- 需要回放真实会话用 `replayLLM`（请求指纹对不上会 409，必须重录）。
- 需要固定时间：不要改系统时钟，给假模型脚本写固定值，或照 `dom.snapshot.ts` 的 `SNAP_NOW` 做法注入。

### 4.3 ui（React 组件）

```tsx
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App } from './app.js'

afterEach(cleanup)

test('空列表画空态', () => {
  render(<App items={[]} />)
  expect(screen.getByText('还没有内容')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
})
```

要点：
- 组件不直接导出时，照壳装载插件那条路走（`src/packages/ui-composer/ui/composer.spec.tsx` 就是收 `shell.composer` 的登记再渲染），别为了测试改产品导出。
- jsdom 里没有真实布局，别断言像素与宽高；交互用 `fireEvent`/`userEvent`。
- 组件在模块顶层碰的浏览器 API（`matchMedia`、`ResizeObserver`）才往 `tests/setup/dom.ts` 加桩，且写在 import 组件之前。

### 4.4 snapshot（整屏/golden）

```ts
import { expect, test } from 'vitest'
import { expectGolden } from '../../harness.js'

test('场景：设置页', () => {
  const frame = 渲染整屏()
  expectGolden(frame, 'tui/05-settings')   // 落 tests/snapshots/golden/tui/05-settings.txt
})
```

更新 golden：

```bash
UPDATE_GOLDEN=1 pnpm exec vitest run --project snapshot <场景文件>
```

**更新后必须人工审 diff 再提交**（`git diff tests/snapshots/golden`）。golden 红不等于代码坏，也可能是预期变化——先看 diff 再决定改代码还是改 golden。

---

## 5 五条硬规矩（违反会得到假绿/假红）

1. **测试只解析 `src/`，不 import `lib/`**。违反的后果：改源码不重建，测试照样绿。
2. **integration 前必须 build**；`bootKernel` 的守卫会拦，但别等它拦。
3. **会写用户目录的测试必须换 HOME**：用 `tempHome()` 或 `createTempDir('dsc-xxx-')`，不要裸 `mkdtempSync`（后者不进登记表，收尾清不到）。
4. **写完必须反向验证**：把产品代码改坏一行，确认测试**红**；不红就是摆设。
5. **「通过」要带证据**：命令 + 退出码 + 关键输出；没跑就说没跑。

---

## 6 跑完自检

- **临时目录**：全绿时 teardown 会自动清（`tests/setup/global-clean.ts`）。想确认：`%TEMP%\dsc-*` 应为 0；有红时目录会保留，路径打在 stderr。
  - 要保留现场：`DSC_KEEP_TMP=1 pnpm ...`
  - 手动清：`pnpm run clean:test-tmp`
- **覆盖率**（只有 `test:coverage`）：阈值来自 `coverage-baseline.json`，跑过基线要抬就改这个文件并 review（只升不降）。缺文件：本地打一条 warn 后放行、`CI` 为真值直接报错；文件坏（非法 JSON / 缺指标 / 值越界 / `directories` 为 null）：本地也报错，报错带文件路径与字段名。
- **工作区**：`git status` 应只剩你该改的文件；`*.log`、`reports/`、`coverage/` 已忽略。

---

## 7 红了怎么查（按顺序，别跳）

1. **是不是环境假红**：源码比 `lib/` 新 → `pnpm run build` 再跑；换了分支/拉了代码 → 先 `pnpm install`。
2. **是不是超时**：看耗时是不是贴着 5s/60s 线；unit 里 spawn 真进程的用例本来就容易撞 5 秒线，单跑复现不了就是负载问题（不是代码问题），记录后重跑。
3. **看现场**：失败轮次的 `%TEMP%\dsc-*` 保留了会话 jsonl、锁文件；报错里给了路径。
4. **看报告**：CI 用 JUnit（`--reporter=junit --outputFile.junit=reports/x.xml`），逐条可查。
5. **还查不出**：缩小到单文件、单用例（`-t`），再不行 `--reporter=verbose` 看钩子执行顺序。

---

## 8 常见坑（本项目踩过的）

| 坑 | 现象 | 正解 |
| --- | --- | --- |
| `extends: true` 忘了写 | 新 project 里 `import '@pneuma/xxx'` 报 `Failed to resolve import` | 每个 project 都加 `extends: true`（`vitest.config.ts` 注释有说明） |
| `groupOrder` 重复 | 五个 project 一次跑时报错「maxWorkers 不同但 groupOrder 相同」 | 1–5 各自唯一 |
| `*.int.spec.ts` 收进 unit | 5 秒超时、红得莫名其妙 | unit 的 exclude 已排；新加 project 记得照抄 |
| Vitest 4 钩子首参 | `FixtureParseError` | 首参必须是解构（`({}, suite)`），第二个参数才是文件级 task |
| Windows 删目录 EPERM | 收尾报错删不掉 | 用 `removeTempDir()`（自带重试与 cwd 保护） |
| 快照跨午夜变红 | golden 每天 +1 格 | 场景里把页面 `Date` 钉死（`SNAP_NOW`），种子同锚 |
| 改了 `src` 没 build 就跑 int | `bootKernel` 抛「lib 比源码旧」 | 别改测试，去 build |
| `pnpm test` 起不来、报 `[coverage] 基线…` | `coverage-baseline.json` 被改坏（非法 JSON / 缺指标 / 越界） | `git checkout -- coverage-baseline.json` |

---

## 9 交付时写什么

给用户的报告至少四行：

```text
跑过的命令：pnpm test（EXIT=0，6232 条：6195 过 / 37 红——37 红是既有超时抖动，见下）
没跑的：pnpm run test:coverage（未跑，原因：不在本轮范围）
新增测试：<文件:行>，反向验证：改坏 X → 红 → 还原 → 绿
残余风险：<已知偶发红/未覆盖分支>
```

**别写「全部通过」**——写「N 过 / M 红 / 跳过 K，退出码 X」。
