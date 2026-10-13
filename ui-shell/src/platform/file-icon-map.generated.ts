/** 迁移期转发壳：实现已搬进 `src/ui-primitives/file-icon-map.generated.ts`（`@dsc/ui-primitives`）——调用点不归本轮改，
 * 让它们照旧 import 旧路径；**收尾时删除本文件**。
 *
 * ⚠ `desktop/scripts/build-icon-map.mjs:117` 仍往这个旧路径写：重跑那个生成器会把本壳
 * 覆盖成一份真实映射表（FileIcon 会静默用上旧图标）。收尾时应把生成器的落点改到
 * `src/ui-primitives/`，或删掉本壳并确认没有别的调用点。
 */
export * from '@dsc/ui-primitives'
