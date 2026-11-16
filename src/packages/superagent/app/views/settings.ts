/**
 * 移植自 dsh-superagent/src/app/views/settings.ts（43 行，逐字）。
 * 改动只有 import 路径（目录已按上游镜像，与上游只差 NodeNext 的 `.js` 扩展名；Policy 在本仓 `core/`）：
 *   `../deployment.ts` → `../deployment.js`；`../kv.ts` → `../kv.js`；`../policy.ts` → `../core/policy.js`
 *   `../sources/registry.ts` → `../sources/registry.js`；`../execution-environment.ts` → `../execution-environment.js`
 *   `./store.ts` → `./store.js`；`./sources.ts` → `./sources.js`
 * 逻辑、导出名与上游英文 doc 注释均逐字未改。
 *
 * 设置视图：带版本号的配置块、各来源的表单与策略元数据、执行环境详情。
 *
 * @module dsc/packages/superagent/app/views/settings
 */
/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { SETUP_FIELDS } from '../../deployment.js'
import { KV } from '../../kv.js'
import { policyVersion } from '../../core/policy.js'
import type { SourceRegistry } from '../../sources/registry.js'
import { declaredVariables, executionRoot } from '../execution-environment.js'
import type { Store } from '../store.js'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.js'

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.id] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
