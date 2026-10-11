import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 界面壳（应用本体）的构建配置。
 *
 * 产物落点：宿主 webserver 插件固定从 `lib/ui/assets` 伺服，所以 outDir 由本文件按自身
 * 位置算出来，从任何 cwd 执行构建都落在同一处（与 remote-web 同一套做法）。
 *
 * 注意 emptyOutDir 只清 `lib/ui/assets`——插件 bundle 在隔壁的 `lib/ui/plugins`，
 * 由 build-plugins.mjs 单独产出，两个构建互不踩。
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url))
const outDir = fileURLToPath(new URL('../lib/ui/assets', import.meta.url))

/** 共用核心（槽位 + 清单）挂在 @dsc/ui-core 上：宿主与界面壳同一份源码。 */
const uiCore = fileURLToPath(new URL('../src/ui/index.ts', import.meta.url))

/** 本地 dev 时把 /api 与 /plugins 转发给宿主（默认端口由 webserver 插件分配，可用环境变量指）。 */
const devOrigin = process.env.DSC_UI_ORIGIN ?? 'http://127.0.0.1:17322'

export default defineConfig({
  root: rootDir,
  // 相对路径引用资产：宿主把产物目录挂在 / 上，绝对路径也能用，
  // 但相对路径在「挂到子路径」时同样成立，容错更宽。
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@dsc/ui-core': uiCore },
    // pnpm workspace 下 ui-shell 有自己的一份 react 物理副本，而 @dsc/ui-core（../src/ui）
    // 解析到根仓库的那份——两份 React 的 dispatcher 互不相通，渲染期直接白屏
    // （Cannot read properties of null (reading 'useCallback')）。dedupe 把全图钉到根那份。
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  },
  server: {
    host: '127.0.0.1',
    port: 5373,
    proxy: {
      '/api': { target: devOrigin, changeOrigin: true },
      '/plugins': { target: devOrigin, changeOrigin: true },
    },
  },
  build: {
    outDir,
    // outDir 在 root 之外，必须显式声明才允许清空。
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app-[hash].js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
})
