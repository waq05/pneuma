/**
 * Vitest 主配置：五个常驻分层 project（unit / integration / ui / snapshot / tui）。
 *
 * ## 只解析 `src/`，不许 import `lib/`
 *
 * 本仓库只有一份实现：测试 import 的一律是 `src/**` 的源码。`lib/` 是 `pnpm build` 的产物，
 * 也是 `files` 白名单里随包发出去的那份；测试若落到 `lib/`，等于拿编译产物验源码，改一行
 * 源码不重新构建就看不到变化。这条与 `scripts/build-runtime-package.mjs` 第 6-7 行是同一
 * 约束的两面：那边禁止源码 import `lib/`，这边禁止测试 import `lib/`。
 *
 * ## 解析层为什么要两个插件
 *
 * 源码按 NodeNext 写相对导入带 `.js` 后缀（`./y.js`，磁盘上是 `y.ts`），Vite 不会自动改试，
 * 所以 `jsToTsFallback()` 补这一跳（见 `tests/plugins/js-to-ts.ts`）。
 * `@pneuma/*` 走 `tsconfig.json` 的 `paths`，交给 `vite-tsconfig-paths` 读同一份映射——
 * 手抄第六份别名表只会多一处漏改的地方。
 *
 * `@pneuma/runtime/*` 单独加一条 alias：`vite-tsconfig-paths` 会把
 * `@pneuma/runtime/core/x.js` 直接映射成相对的 `src/core/x.js` 就返回，解析插件看不到它。
 * 先经 alias 变成绝对路径，插件那支「绝对路径 + .js 不存在就试 .ts」才接得住。
 *
 * @module dsc/vitest.config
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { jsToTsFallback } from './tests/plugins/js-to-ts.js'
import { TERMINAL_TEST_ENV } from './tests/support/test-env.js'

/**
 * `@dsc/*` 别名：直接读界面壳的构建期别名表，不另抄一份。
 *
 * 抄一份的代价不是多写几行，是漂：`ui-shell/vite.config.ts` 与
 * `scripts/build-plugins.mjs` 都读这张表，测试侧再抄就是第三个事实源。漏改的表现不是报错，
 * 是测试里解析出另一份 React 实现，hooks 直接崩。
 */
/**
 * 覆盖率基线（P4 冻结）：阈值从 `coverage-baseline.json` 读，**初始即当前值**。
 *
 * 为什么留 0.5 个百分点余量：覆盖率的抖动来自「走得到走不到某条错误分支」的时序，
 * 不是代码改动；贴着基线卡会让无关提交红。0.5 以内视为噪声，降超过 0.5 才是真的掉了。
 *
 * ## 缺文件与坏文件必须分开处理（原来的整段 try/catch 是 fail-open）
 *
 * 以前整段包在 `try { ... } catch { return null }` 里：基线文件被删、被改成非法 JSON、
 * 或者某个字段写成字符串 / NaN，都会静默变成 `null`，下面 `coverage.thresholds` 整块
 * 不下发——覆盖率门无声消失，CI 照样绿。这是典型的 fail-open。
 *
 * 现在的口径：
 * - **文件不存在**：本地首次检出不该被卡死，所以只打一条显眼的 `console.warn` 并返回
 *   `null`；但 `CI` 是真值时必须抛错（判据见 `isCI()`：`CI=false` / `CI=0` 这类本地工具
 *   写出来的值不算）。基线文件是入库的（`git ls-files coverage-baseline.json` 有输出），
 *   CI 上缺它只可能是有人删了，必须当场红。
 * - **文件坏**（JSON 解析失败、缺四个指标之一、值不是 0..100 的有限数字）：一律抛错，
 *   本地也抛。坏文件说明有人在改基线，放行等于把门关掉。
 */
const BASELINE_FILE = fileURLToPath(new URL('./coverage-baseline.json', import.meta.url))

/** 基线四指标；顺序固定，校验、报错、构造阈值都按它走。 */
const METRICS = ['lines', 'branches', 'functions', 'statements'] as const
type Metric = (typeof METRICS)[number]
type BaselineRow = Record<Metric, number>
/**
 * 下发给 `coverage.thresholds` 的形状：根阈值四个数，外加逐目录的 glob 键。
 * 目录键与 `lines` 这类指标键同一层，所以索引签名取两者的并集。
 */
type Thresholds = BaselineRow & { [glob: string]: number | BaselineRow }

/** 报错用：把任意值说成人能读的一小段，NaN / undefined / 数组都有话说。 */
function showValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `非有限数字 ${String(value)}`
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return '数组'
  return `${typeof value} 对象`
}

/** 校验一条 row：四个指标缺一不可，且都必须是 0..100 的有限数字。 */
function readBaselineRow(row: unknown, where: string): BaselineRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error(`[coverage] 基线字段非法：${BASELINE_FILE} 的 ${where} 应是对象，实际是 ${showValue(row)}。`)
  }
  const source = row as Record<string, unknown>
  const checked = {} as BaselineRow
  for (const metric of METRICS) {
    const value = source[metric]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(
        `[coverage] 基线字段非法：${BASELINE_FILE} 的 ${where}.${metric} = ${showValue(value)}，` +
          '要求 0..100 的有限数字。',
      )
    }
    checked[metric] = value
  }
  return checked
}

/** 阈值 = 基线四指标各减 0.5（噪声余量，理由见上）。 */
function withMargin(row: BaselineRow): BaselineRow {
  return {
    lines: row.lines - 0.5,
    branches: row.branches - 0.5,
    functions: row.functions - 0.5,
    statements: row.statements - 0.5,
  }
}

/** 解析 + 校验 + 逐目录展开；任何一步坏了都抛，错误里带文件路径与具体字段。 */
function parseBaseline(raw: string): Thresholds {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `[coverage] 基线文件不是合法 JSON：${BASELINE_FILE}（${(error as Error).message}）。` +
        '修复：git checkout -- coverage-baseline.json',
    )
  }
  const root = readBaselineRow(parsed, '（根）')
  // `directories` 是可选的：字段**完全缺席**按空表处理；但显式写 `null`（以及数字、字符串、
  // 数组）是「有人想配逐目录门却写错了」，必须报错。原来的 `?? {}` 把显式 null 也当成缺席，
  // `src/core/**` 那几条逐目录阈值整块消失、只剩根阈值，而且没人发现——逐目录口径上的 fail-open。
  // 所以判据必须是「键存不存在」，不能用 `??` 或 `=== undefined`（两者都会把 null 吞掉）。
  const fields = parsed as Record<string, unknown>
  const directories = Object.prototype.hasOwnProperty.call(fields, 'directories') ? fields['directories'] : {}
  if (typeof directories !== 'object' || directories === null || Array.isArray(directories)) {
    throw new Error(
      `[coverage] 基线字段非法：${BASELINE_FILE} 的 directories 应是对象，实际是 ${showValue(directories)}。`,
    )
  }
  // 逐目录门（P6）：design 的「src/core 先 60% 再 70%」还没达到，先把当前值钉住，
  // 保证只升不降；目标值与差距写在 deviations D39。语义与原来一致：每个目录单独一条，
  // 与根阈值平铺进同一张阈值表（目录键是 glob，Vitest 按 glob 匹配文件）。
  const perDirectory = Object.fromEntries(
    Object.entries(directories as Record<string, unknown>).map(([glob, row]) => [
      glob,
      withMargin(readBaselineRow(row, `directories[${JSON.stringify(glob)}]`)),
    ]),
  )
  return { ...withMargin(root), ...perDirectory }
}

/**
 * 是否是真正的 CI 环境。
 *
 * 判据三条同时成立：`CI` 存在、不是空串、且不是 `'false'` / `'0'`（大小写不敏感）。
 * 为什么不能只判「非空」：本地有些前端工具会 `export CI=false`，照「非空即 CI」的口径，
 * 本地首次检出缺基线就会直接抛错——正好和下面 `missingBaseline` 承诺的「本地可放行」相反。
 */
function isCI(): boolean {
  const value = process.env['CI']
  if (value === undefined || value === '') return false
  const normalized = value.toLowerCase()
  return normalized !== 'false' && normalized !== '0'
}

/**
 * 文件不存在时的唯一分支：本地警告放行，CI 抛错（理由见上面的注释块）。
 * 返回 `null` 表示「这一轮不设覆盖率阈值」，调用点据此整块不下发 thresholds。
 */
function missingBaseline(): null {
  const consequence = '本次覆盖率门不生效（coverage.thresholds 整块不下发）'
  const restore = '恢复：git checkout -- coverage-baseline.json'
  if (isCI()) {
    throw new Error(
      `[coverage] 缺基线文件：${BASELINE_FILE}。该文件已入库，CI 上缺它只可能是被删了，` +
        `拒绝静默降级：${consequence}。${restore}`,
    )
  }
  warnOnce(
    `[coverage] ⚠ 找不到基线文件 ${BASELINE_FILE}：${consequence}。` +
      `本地首次检出可以不管，CI 上同一情况会直接报错。${restore}`,
  )
  return null
}

/**
 * 一次 `vitest run` 会把本模块求值多次：根配置一次，五个 project 的 `extends: true`
 * 各一次（实测 6 次）。警告靠 `globalThis` 上的标记只打一次，免得一条提示刷六遍。
 */
const WARNED_KEY = Symbol.for('dsc.coverageBaseline.warned')

function warnOnce(message: string): void {
  const scope = globalThis as { [key: symbol]: boolean | undefined }
  if (scope[WARNED_KEY] === true) return
  scope[WARNED_KEY] = true
  console.warn(message)
}

const coverageBaseline = ((): Thresholds | null => {
  let raw: string
  try {
    raw = readFileSync(BASELINE_FILE, 'utf8')
  } catch (error) {
    // 只有「文件不存在」是本地可放行的情形。EACCES / EISDIR 这类是环境坏了，照抛——
    // 把它们当「没有基线」同样是 fail-open。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missingBaseline()
    throw error
  }
  return parseBaseline(raw)
})()

const uiAliases = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(new URL('./ui-shell/packages.json', import.meta.url), 'utf8')) as Record<
      string,
      string
    >,
  ).map(([specifier, relativePath]) => [
    specifier,
    // 表里的路径相对 `ui-shell/` 写，`../src/...` 由 URL 归一，不需要特判。
    fileURLToPath(new URL(`./ui-shell/${relativePath}`, import.meta.url)),
  ]),
)

export default defineConfig({
  plugins: [
    /**
     * 两份 tsconfig 都要交给它。
     *
     * `vite-tsconfig-paths` 按 `include`/`exclude` 过滤 **importer**：导入方不在配置覆盖范围内，
     * 裸说明符就原样交给 Vite，于是 `tests/**` 里写 `import '@pneuma/todo'` 报
     * `Cannot find package`——而同样的写在 `src/**` 下是对的。
     * 根配置只 include `src`，`tsconfig.spec.json` 才 include `tests/**`，两份合起来才覆盖全部
     * 导入方。（`@pneuma/runtime/*` 不受这条影响：它走下面的 alias，与 importer 无关。）
     */
    tsconfigPaths({ projects: ['./tsconfig.json', './tsconfig.spec.json'] }),
    jsToTsFallback(),
  ],
  resolve: {
    alias: {
      ...uiAliases,
      // 绝对路径：Vite 的 alias 插件排在所有自定义插件之前，展开后立刻落到下面的
      // jsToTsFallback 手里，把 `.js` 换成磁盘上真有的 `.ts`。
      '@pneuma/runtime': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    /**
     * 每轮开跑前清扫过期临时目录。
     *
     * 正常收尾由 `tests/support/tmp-dir.ts` 在 worker 退出时做（全绿才删，失败保留）；
     * 这条只补「被强杀 / CI 取消」留下的残留，门槛 24 小时，不误伤正在并行跑的另一份。
     */
    globalSetup: ['tests/setup/global-clean.ts'],
    // 测试一律按真实终端跑（原因见 tests/support/test-env.ts）：ink 在 CI 里只写最后一帧，
    // tui / integration / snapshot 三层探针都靠逐帧读假 stdout 断言。
    env: TERMINAL_TEST_ENV,
    // 覆盖率（P3 第 3 项）：只出报告不设门（概要设计 §9.1——先看清盲区分布，
    // P4 冻结基线、P6 逐目录抬杠）。纯类型文件与入口不算覆盖面。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // 只收代码文件：'src/packages/**' 会把 README.md / locale/*.json / *.yml 也收进来，
      // V8 provider 会把它们当 JS 解析并在日志里刷 PARSE_ERROR（覆盖率数字同时归零）。
      include: ['src/core/**/*.ts', 'src/packages/**/*.ts', 'src/packages/**/*.tsx'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.int.spec.ts',
        'src/**/types.ts',
        'src/packages/tui/**', // tui 由 tui project 单独跑，coverage 汇总口径随 P4 基线再定
        '**/node_modules/**',
      ],
      // 阈值见 coverage-baseline.json 的说明：只降不升，留 0.5 个百分点余量。
      ...(coverageBaseline === null ? {} : { thresholds: coverageBaseline }),
    },
    /**
     * 每个 project 的 `extends: true` 都是必需的，不是保险丝。
     *
     * Vitest 3.2 起，`test.projects` 里的内联 project 只拿自己写的字段：根配置的 `plugins`
     * 与 `resolve.alias` 不会自动继承。这条是文档里没写、踩了才知道的行为——少了它，
     * 上面两个解析插件与 `@dsc/*` 别名对四个 project 全部失效，测试第一次 import `src/**`
     * 就报 `Failed to resolve import`，而 `--passWithNoTests` 因为一个测试都没跑而照样绿。
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // 五个 project 可能被一次 `vitest run` 全跑（test:coverage）：
          // maxWorkers 不同但 groupOrder 相同的 project 会被 Vitest 拒绝
          // （实测 integration 的 maxWorkers: 4 与 snapshot 的默认值撞车）。
          sequence: { groupOrder: 1 },
          include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
          // `*.int.spec.ts` 的结尾同样是 `.spec.ts`，不显式排掉会被 unit 连跑一遍：
          // 5 秒超时 + 线程池，起真内核的用例在那套设置下必红，而且红得莫名其妙。
          // src 与 tests 两处都要排——tests/ 下的 harness 集成用例同样以 `.spec.ts` 结尾。
          exclude: [
            'src/packages/*/ui/**',
            // tui 的组件在 src/packages/tui/app/**，由 tui project 单独收（node + 假终端），
            // 这里不排就会双跑：测试文件**会被两个 project 各跑一遍，多花时间还让人以为
            // 用例数对不上。
            'src/packages/tui/**',
            'src/**/*.int.spec.ts',
            'tests/**/*.int.spec.ts',
            // live / cli 两层各走独立配置（真模型要钱、真入口要 spawn 进程）：
            // 后缀同样以 `.spec.ts` 结尾，不排就会被 unit 连跑一遍——live 会因为没 key
            // 整层跳过（看起来绿），cli 会在 5 秒超时下红。
            'tests/live/**',
            'tests/cli/**',
            '**/node_modules/**',
          ],
          environment: 'node',
          testTimeout: 5_000,
          hookTimeout: 5_000,
          retry: 0,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // groupOrder 必须唯一（见 unit 的说明）：integration 限了 maxWorkers，更要显式。
          sequence: { groupOrder: 2, concurrent: false },
          // tests/ 下也会有集成用例（tests/harness.int.spec.ts 这类起真内核/真 CLI 的），
          // 两处都收，语义一致：`*.int.spec.ts` 就是集成层。
          include: ['src/**/*.int.spec.ts', 'tests/**/*.int.spec.ts'],
          exclude: ['src/packages/*/ui/**', 'tests/live/**', 'tests/cli/**'],
          environment: 'node',
          testTimeout: 60_000,
          // hook 60s 而不是 30s：每个文件都要起一次真内核（build 产物 + 插件装配），
          // 机器被别的活占住时 30s 会直接超时。实测四个代理并行时 4 个文件撞了 30s 线，
          // 单跑全过——那种红会把人引向错误方向。
          hookTimeout: 60_000,
          // 只给网络与时序抖动一次机会，连续两次红仍是红——不拿重试掩盖真失败。
          retry: 1,
          // 线程池共享端口与全局状态，起真内核的用例会互相踩。
          pool: 'forks',
          // K4：每个集成文件都要起一次真内核（build 产物 + 全插件装配），默认并行度
          // （=核数）下同时起十几个内核，机器扛不住——79 个文件全量并行时 hook/runTurn
          // 撞超时线，单独跑全绿。限到 4：全量 ~6 分钟变 ~8 分钟，换「全量红才算真红」。
          // 旋钮是 `maxWorkers`（Vitest 4 的用户面字段）；`poolOptions.forks.maxForks`
          // 在 4.x 的运行时里已经没人读（4.1.12 实测 14 倍并行照跑），别写回那个。
          maxWorkers: 4,
          setupFiles: ['tests/setup/temp-home.ts'],
        },
      },
      {
        extends: true,
        // jsx 转换只对界面半有用，挂在这里而不是根上，免得拖慢 unit 层。
        plugins: [react()],
        test: {
          name: 'ui',
          sequence: { groupOrder: 3 },
          include: ['src/packages/*/ui/**/*.spec.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
          environment: 'jsdom',
          testTimeout: 10_000,
          hookTimeout: 10_000,
          retry: 0,
          setupFiles: ['tests/setup/dom.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'snapshot',
          sequence: { groupOrder: 4, concurrent: false },
          include: ['tests/snapshots/**/*.snapshot.ts'],
          environment: 'node',
          testTimeout: 60_000,
          // hook 60s 而不是 30s：每个文件都要起一次真内核（build 产物 + 插件装配），
          // 机器被别的活占住时 30s 会直接超时。实测四个代理并行时 4 个文件撞了 30s 线，
          // 单跑全过——那种红会把人引向错误方向。
          hookTimeout: 60_000,
          retry: 1,
          // 录制回放要读写磁盘文件，线程间共享工作目录会互相覆盖。
          pool: 'forks',
        },
      },
      {
        extends: true,
        // TUI 组件不在 `ui/` 子目录下：`src/packages/tui/app/**` 是 ink 渲染层，
        // 既不是浏览器代码（不需要 jsdom），也不匹配 ui project 的
        // `src/packages/*/ui/**` 模式——没有这个 project，那批渲染探针无家可归。
        //
        // 与 ui 层的差别：ink 渲染在 node 里跑，靠假 stdin/stdout（PassThrough）拿帧，
        // 不是 jsdom + react-dom。所以这里 environment 是 node，也不挂 react 插件以外的
        // 浏览器桩。
        test: {
          name: 'tui',
          sequence: { groupOrder: 5 },
          include: ['src/packages/tui/**/*.spec.ts', 'src/packages/tui/**/*.spec.tsx'],
          // `*.spec.ts` 的星号跨点不跨目录：`scroll-model.int.spec.ts` 同样以 `.spec.ts`
          // 结尾，不排掉会被 tui project 再跑一遍（integration 那份才是它的主）。
          // 这是同一类错第三次了（见 unit project 的 exclude），凡按后缀收文件的 project 都要写。
          exclude: ['src/**/*.int.spec.ts', '**/node_modules/**'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 15_000,
          retry: 0,
          // 假终端与定时器是进程级状态，线程间会互相踩。
          pool: 'forks',
        },
      },
    ],
  },
})
