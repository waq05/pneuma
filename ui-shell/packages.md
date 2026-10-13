# ui-shell 的逻辑分包（packages.json）

`packages.json` 是「包名 → 源码落点」的单一事实源（值相对本目录）。`vite.config.ts` 与
`build-plugins.mjs` 直接读它生成 alias；`tsconfig.json` 的 `paths` 读不了 JSON，只能手抄，
`scripts/ui-plugin-test.mjs` 会逐条比对、不一致当场红。

**新增一个包要同时改四处**（JSON 装不下这段注释，所以在这里）：

1. 本目录 `packages.json` 加一条 `"@dsc/ui-xxx": "./src/…/index.ts"`；
2. `tsconfig.json` 的 `paths` 抄同一条（写法与上面一致，漂移检查会盯）；
3. 新包的源码目录放 `package.json`（`name` 与包名一致、`types` 指向入口——漂移检查拿它当锚）；
4. 定它在构建期的身份：**要下发给插件**就加进 `src/platform-modules.json`，同时在
   `src/boot.ts` 的 `MODULES` 里挂上实现（两边漂移由 `MODULE_DRIFT` 当场报）；
   **只给壳自己用**就加进 `build-plugins.mjs` 的 `EXTERNAL`（构建期保留成 require、
   运行期故意不给——插件当值用它时得到「白名单外的模块」那句错）。

E2/E3/E5（第 5 波）起 `@dsc/ui-primitives` / `@dsc/ui-dockkit` / `@dsc/ui-layout` 已按上面
配方登记（源码在 `src/ui-<包名后半>/`，每包一个 `index.ts`）。`@dsc/ui-slots` /
`@dsc/ui-renderer` **仍刻意不预注册**：这两个包要到 E4 才拆出来，alias 指向不存在的文件只会
把"漏改的包名"从编译错误变成运行期怪事。

旧路径（`src/icons.tsx`、`src/dock-state.ts`、`src/platform/*` …）上留了**迁移期转发壳**
（一行 `export * from '<包名>'`）：调用点（`plugin-api.ts` / `boot.ts` / `main.tsx` /
`src/plugins/**`）不归拆包那一轮改，让它们照旧 import 旧路径。E4/收尾把调用点改成包名之后，
那些壳应逐个删掉——它们只是过渡态，不是新接口。
