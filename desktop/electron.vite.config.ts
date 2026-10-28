import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

/**
 * dsc-desktop 构建配置（electron-vite 5）。
 * main/preload 入口显式声明（布局为 electron/{main,preload}）；
 * 两者都用 dsc 根目录的编译产物（../lib）作为源，alias `@dsc/runtime`
 * 指向它——dev 直接引用源仓库，打包时经 extraResources 携带
 * （见 scripts/prepare-runtime.mjs 与 electron-builder.yml）。
 *
 * main 也挂这个别名是为了共用宿主那份口径（会话用量的折叠、输出速度的算法在
 * core/usage-log.ts 与 core/throughput.ts 里各只有一份）：rollup 在构建时就把它们
 * 打进来，运行期不依赖 asar 之外的文件。
 *
 * 这里**只有 main 与 preload**：界面是插件壳（`ui-shell/`，产物落 `lib/ui/assets`，
 * 由宿主 webserver 伺服）。旧渲染层 21,035 行已整体删除（2026-10-28）。
 */
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@dsc/runtime': fileURLToPath(new URL('../lib', import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@dsc/runtime': fileURLToPath(new URL('../lib', import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload/index.ts') },
      },
    },
  },})
