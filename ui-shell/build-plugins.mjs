/**
 * 插件 bundle 的构建：把 `src/plugins/<id>/ui.tsx` 打成 `lib/ui/plugins/<id>/client.js`（CJS 工厂），
 * 并写一份 `manifest.json` 说明有哪些插件、依赖谁。
 *
 * 为什么是 CJS 而不是 ESM：插件 bundle 在页面里由加载器用受控的 `require` 执行
 * （见 `src/boot.ts`），这样 React 与 `@dsc/ui` 由壳提供而不是各带一份
 * ——两份 React 会让 hooks 直接崩。dsh 的客户端插件也是同一个形状。
 *
 * 可选：插件目录里放一个 `plugin.json` 可以声明 `inject` / `immediately` / `external`
 * （将来第三方插件用同一份字段）。
 *
 * @module dsc-ui-shell/build-plugins
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = join(root, 'src', 'plugins')
const outRoot = resolve(root, '..', 'lib', 'ui', 'plugins')
const uiCore = resolve(root, '..', 'src', 'ui', 'index.ts')
const pluginApi = join(root, 'src', 'plugin-api.ts')

/** 由壳提供的模块：插件 bundle 里对它们的引用保持原样，运行期从白名单表取。 */
const EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', '@dsc/ui']

/** 读可选的 plugin.json（写坏了就报错——清单错一半比没有更糟）。 */
function readMeta(dir) {
  const file = join(dir, 'plugin.json')
  if (!existsSync(file)) return {}
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const meta = {}
  if (Array.isArray(doc.inject)) meta.inject = doc.inject.filter((v) => typeof v === 'string')
  if (Array.isArray(doc.external)) meta.external = doc.external.filter((v) => typeof v === 'string')
  if (doc.immediately === true) meta.immediately = true
  if (doc.platform === 'tui') meta.platform = 'tui'
  return meta
}

const ids = readdirSync(srcDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(srcDir, entry.name, 'ui.tsx')))
  .map((entry) => entry.name)
  .sort()

if (ids.length === 0) {
  console.error('[build-plugins] src/plugins 下没有找到任何插件（缺 ui.tsx？）')
  process.exit(1)
}

const plugins = []
for (const id of ids) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias: { '@dsc/ui': pluginApi, '@dsc/ui-core': uiCore } },
    build: {
      outDir: join(outRoot, id),
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      lib: { entry: join(srcDir, id, 'ui.tsx'), formats: ['cjs'], fileName: () => 'client' },
      rollupOptions: {
        external: EXTERNAL,
        output: {
          exports: 'named',
          // lib 模式默认按 format 加后缀（type: module 的包会写成 .cjs）；
          // 宿主按 `client.js` 找文件，这里显式钉死扩展名。
          entryFileNames: 'client.js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  })
  const meta = readMeta(join(srcDir, id))
  plugins.push({ id, file: 'client.js', platform: 'web', ...meta })
  console.log(`[build-plugins] ${id} → lib/ui/plugins/${id}/client.js`)
}

/** 宿主只读这份清单（见 `src/core/ui-bundles.ts`）。 */
writeFileSync(
  join(outRoot, 'manifest.json'),
  `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`,
  'utf8',
)
console.log(`[build-plugins] manifest.json：${plugins.map((plugin) => plugin.id).join('、')}`)
