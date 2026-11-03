/**
 * 运行时适配包的验收：从**包目录**里用裸说明符解析，且桩与真模块必须是同一实例。
 *
 * 为什么不在本文件里直接 import：脚本在 `scripts/`，向上查不到
 * `lib/node_modules/@pneuma/runtime`。真正要验证的场景是「`lib/packages/<id>/` 里的
 * 插件包 import 裸说明符」，所以生成一个临时探针包放进去跑。
 *
 * @module scripts/runtime-package-check
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const probeDir = join(root, 'lib', 'packages', '__runtime_probe__')

const probe = `import * as realClamp from '../../core/clamp.js'
import * as viaClamp from '@pneuma/runtime/core/clamp.js'
import * as realRunner from '../../core/tools/command-runner.js'
import * as viaRunner from '@pneuma/runtime/core/tools/command-runner.js'

let bad = 0

if (realClamp.clampIntIn !== viaClamp.clampIntIn) {
  console.log('FAIL clamp：不是同一个函数（两份模块）')
  bad += 1
} else {
  console.log('ok clamp')
}

// 模块级注册表才算真考验：从真模块注册，经适配包能不能看见。
const off = realRunner.registerCommandRunner({ id: 'runtime-probe', spawn: () => null })
const seen = viaRunner.commandRunnerIds().includes('runtime-probe')
off()
if (!seen) {
  console.log('FAIL command-runner：真模块注册的执行器，适配包看不见（两份 Map）')
  bad += 1
} else {
  console.log('ok command-runner 注册表共用')
}
process.exit(bad === 0 ? 0 : 1)
`;

rmSync(probeDir, { recursive: true, force: true })
mkdirSync(probeDir, { recursive: true })
writeFileSync(join(probeDir, 'probe.mjs'), probe, 'utf8')

const result = spawnSync(process.execPath, [join(probeDir, 'probe.mjs')], { encoding: 'utf8' })
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
rmSync(probeDir, { recursive: true, force: true })

if (result.status !== 0) {
  console.error('FAIL 运行时适配包：见上面的原因')
  process.exit(1)
}
console.log('PASS 运行时适配包：包目录里解析到同一实例')
