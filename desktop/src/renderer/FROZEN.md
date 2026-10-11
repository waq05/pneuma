# 本目录已冻结（经典界面留档）

> 2026-10-11 起，桌面默认界面是**插件壳**（`desktop/electron/main/index.ts` 的
> `DEFAULT_UI_PROFILE = 'shell'`）。本目录是旧渲染层——它不再随版本演进，
> 只作为**回落路径**存在（`ui: 'legacy'`、`DSC_UI_SHELL=0`、或壳产物缺失时由宿主伺服）。

## 规矩

1. **不要在这里改样式**。这份样式表的新家在 `ui-shell/src/legacy/`（四份逐字节副本，
   见那份 `PROVENANCE.md`）与壳自己的 `ui-shell/src/styles.css`（壳新增的东西）。改这里
   等于改在一个默认没人加载的文件里——界面看不见变化、也不会报错，是最难查的一类问题。
   `scripts/legacy-frozen-check.mjs` 会把两边分叉检查出来。
2. **新能力不做在这里**。界面能力做成插件（`ui-shell/src/plugins/`，参照
   `docs/plugin-development.md` §10）；原生能力走原生桥（`src/core/native-bridge.ts`）。
3. **本目录唯一的合法改动**是回落路径必需的修复（认证、IPC 桥、加载器）——
   每一条都要在提交信息里写明「回落路径修复」。
4. `bridge.ts` 的退役归位表在它的文件头注释：26 个成员壳里由谁承担、物理删除的三条
   前置。删除本目录整体要等「一份还是两份 UI」的决定（阶段 8 之后）。

## 它还会被谁加载

- 回落路径：桌面窗口认证失败 / 拿不到地址 / 壳产物缺失时 `loadFile(out/renderer/index.html)`；
- 安装包里它随 asar 走（`out/**`），切换期两份 UI 并存是拍板过的过渡态。
