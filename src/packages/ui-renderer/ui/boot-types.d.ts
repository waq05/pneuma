/**
 * `@pneuma/ui-boot/boot.js` / `hmr.js` 的本地类型桥。
 *
 * 为什么需要它：引导（`@pneuma/ui-boot`）不在平台模块表里，渲染器的插件 bundle 运行期
 * 拿不到它；渲染器对引导只有**类型**边。而界面的作者面是 `@dsc/ui-boot` 这个别名
 * （`ui-shell/packages.json` → `ui-boot/ui/index.ts`）。这里把发布包的两个子路径声明成
 * 转发到同一份源码，于是渲染器可以按发布包的写法 import type，解析的仍是同一组类型；
 * 运行期因为 `import type` 被擦除，不产生任何跨包 import。
 *
 * @module @pneuma/ui-renderer/boot-types
 */
declare module '@pneuma/ui-boot/boot.js' {
  export type { UiBootSession, UiRendererApi } from '@dsc/ui-boot'
}

declare module '@pneuma/ui-boot/hmr.js' {
  export type { UiPluginHmr } from '@dsc/ui-boot'
}
