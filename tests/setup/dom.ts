/**
 * ui 层的 jsdom 补丁位（`vitest.config.ts` 的 ui project 引用本文件）。
 *
 * ## 现在为什么是空的
 *
 * 空的不是「还没想」，是查过之后的结论：jsdom 自带 `window` / `document` / 事件系统，
 * 而 ui 层第一条 POC（`ui-status/ui/status-model.spec.ts`）测的是纯派生函数——
 * 零 React、零 DOM 调用，只经 `createT` 取词。取词器读 `globalThis.__DSC_BOOT__`，
 * 读不到就按中文（`ui-core/i18n.ts` 的 `uiLanguage`），这正是断言要的那一档。
 * 整条 import 链也没有模块顶层碰浏览器 API，所以一条补丁都不需要。
 *
 * ## 什么时候该往这里加
 *
 * jsdom 没有、而组件在渲染或模块顶层会碰的 API，只在这里打桩：
 * `window.matchMedia`、`ResizeObserver`、`IntersectionObserver`、`Element.prototype.scrollTo`
 * 之类。桩要写在**测试文件 import 组件之前**（setupFiles 正是这个时机），
 * 否则模块顶层读一次就是 `undefined is not a function`。
 *
 * 不预埋桩：埋了却没人用，等于给下一个人一个「这里已经有桩了」的错觉，
 * 而真正缺的那个 API 未必在预埋清单里。
 *
 * @module dsc/tests/setup/dom
 */
