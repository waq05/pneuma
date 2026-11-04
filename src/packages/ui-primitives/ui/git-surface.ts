/**
 * git 读数的相等判断（转 `@dsc/ui-core` 里那一份，与宿主同一个口径）。
 *
 * 为什么要转这一手：插件只许从平台种子里取东西，而这份实现住在 core。
 * 见 `docs/plugin-development.md` 的「界面插件能 import 什么」。
 *
 * @module dsc/ui-primitives/git-surface
 */
export { sameGitSurface } from '@dsc/ui-core'
