# ui-shell 的逻辑分包（packages.json）

`packages.json` 是「包名 → 源码落点」的单一事实源（值相对本目录）。`vite.config.ts` 与
`build-plugins.mjs` 直接读它生成 alias；`tsconfig.json` 的 `paths` 读不了 JSON，只能手抄，
`scripts/ui-plugin-test.mjs` 会逐条比对、不一致当场红。

**新增一个包要同时改四处**（JSON 装不下这段注释，所以在这里）：

1. 本目录 `packages.json` 加一条 `"@dsc/ui-xxx": "./src/…/index.ts"`；
2. `tsconfig.json` 的 `paths` 抄同一条（写法与上面一致，漂移检查会盯）；
3. 新包的源码目录放 `package.json`（`name` 与包名一致、`types` 指向入口——漂移检查拿它当锚）；
4. 定它在构建期的身份：**要下发给插件**就加进 `src/platform-modules.json`，同时在
   `src/ui-renderer/boot.ts` 的 `MODULES` 里挂上实现（两边漂移由 `MODULE_DRIFT` 当场报，
   且被 `scripts/ui-plugin-test.mjs` 的 [5b] 用「键集且顺序全等」钉住）；
   **只给壳自己用**就加进 `build-plugins.mjs` 的 `EXTERNAL`（构建期保留成 require、
   运行期故意不给——插件当值用它时得到「白名单外的模块」那句错）。

七个包已按上面配方登记（源码在 `src/ui-<包名后半>/`，每包一个 `index.ts`）：

| 包名 | 落点 | 构建期身份 |
| --- | --- | --- |
| `@dsc/ui` | `src/plugin-api.ts` | 下发给插件（平台种子，本包没有包帧——落点是单文件） |
| `@dsc/ui-core` | `../src/ui/index.ts` | **只给壳**（`EXTERNAL` 里「故意不给」的那一格） |
| `@dsc/ui-primitives` / `@dsc/ui-slots` / `@dsc/ui-dockkit` | `src/ui-*/index.ts` | 下发给插件（E6 起进 `platform-modules.json`） |
| `@dsc/ui-layout` / `@dsc/ui-renderer` | `src/ui-*/index.ts` | 只给壳（插件不该直接消费骨架与装载器） |

旧路径（`src/icons.tsx`、`src/dock-state.ts`、`src/platform/*`、`src/slots.ts`、
`src/boot.ts` …）上的**迁移期转发壳已全部删除**（E4 收尾）：调用点（`plugin-api.ts` /
`src/plugins/**` / 各包）都改成按包名 import。新代码见到的旧路径一律是漏改，别再往回加壳。

**类型产物不用额外登记**：`build-types.mjs`（`tsconfig.types.json`）按 `src/ui-*/index.ts`
的 glob 收集入口、再照 `packages.json` 把声明归位到 `lib/ui/sdk/@dsc/<包名>/`——新包只要按
上面「源码在 `src/ui-<x>/index.ts`」的约定放，就会自动进 SDK 类型树；落点不合约定时
`build-types.mjs` 当场报错（不会静默漏一个包）。
