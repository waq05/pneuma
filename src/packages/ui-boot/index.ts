/**
 * `@pneuma/ui-boot` 的 Node 侧包入口。
 *
 * 引导的实体在**浏览器**（`ui/`）：启动图、cordis 根、分批装载与页面入口都只有浏览器
 * 语义，Node 这一侧没有可执行的东西。这个文件存在是为了让包加载器认得本包、让
 * `@pneuma/ui-boot` 在 `lib/packages/` 里有一份真实产物（`build-packages` 按
 * `index.ts` 找编译产物）；没有插件对象、没有 `apply`、没有行。
 *
 * 浏览器半边由界面壳的构建直接读源码（`ui/index.ts` 与 `ui/main.tsx`），不经过这里。
 *
 * @module @pneuma/ui-boot
 */
export {}
