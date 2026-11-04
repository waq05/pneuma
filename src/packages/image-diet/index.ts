/**
 * image-diet 插件：把「每轮图片按龄卸载」的三个预算 + 总开关交给设置界面。
 *
 * 卸载本体是一条内置投影（`image-diet`，order 550，登记在 plugins/prompt.ts 的投影链里，
 * 与 `fold-system` / `env-facts` / `drop-images` 同一条管道）；这里只负责它的配置界面：
 * 用户图留几张、工具结果图留几张、保留最近几个回合、以及总开关。
 * 配置落在 `~/.dsc/plugins.json` 里 `file: 'image-diet'` 这一项的 `config` 下，
 * 投影每次组装请求时现读——保存后下一轮就生效，不必重启宿主。
 *
 * 为什么默认开着：图片本来就是每轮重发的大块 base64，按龄卸载不需要用户先来点一下
 * （默认留最近 2 个回合、用户图 4 张、工具图 2 张，够用也不伤「当前正在看的那张」）。
 * 模型根本不声明收图时另有一条能力门（`drop-images`）会把图全剥，这条留着无害。
 *
 * @module dsc/plugins/image-diet
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { IMAGE_DIET_RANGES, readImageDietConfig } from '@pneuma/runtime/core/image-diet.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'image-diet'

export const imageDietPlugin: Plugin.Object = {
  name: 'image-diet',
  inject: ['settings'],
  apply(ctx) {
    // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值（照 compact 分区）。
    const current = () => readImageDietConfig(resolvePluginConfig(CONFIG_KEY))

    const fields: SettingsField[] = [
      {
        type: 'switch',
        key: 'enabled',
        label: t('field.enabled.label'),
        help: t('field.enabled.help'),
      },
      {
        type: 'number',
        key: 'userImageBudget',
        label: t('field.userImageBudget.label'),
        min: IMAGE_DIET_RANGES.userImageBudget.min,
        max: IMAGE_DIET_RANGES.userImageBudget.max,
        step: 1,
        help: t('field.userImageBudget.help'),
      },
      {
        type: 'number',
        key: 'toolImageBudget',
        label: t('field.toolImageBudget.label'),
        min: IMAGE_DIET_RANGES.toolImageBudget.min,
        max: IMAGE_DIET_RANGES.toolImageBudget.max,
        step: 1,
        help: t('field.toolImageBudget.help'),
      },
      {
        type: 'number',
        key: 'keepRounds',
        label: t('field.keepRounds.label'),
        min: IMAGE_DIET_RANGES.keepRounds.min,
        max: IMAGE_DIET_RANGES.keepRounds.max,
        step: 1,
        help: t('field.keepRounds.help'),
      },
    ]

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 38,
      fields: () => fields,
      values: (): SettingsValues => {
        const config = current()
        return {
          enabled: config.enabled,
          userImageBudget: config.userImageBudget,
          toolImageBudget: config.toolImageBudget,
          keepRounds: config.keepRounds,
        }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        if (key === 'enabled') {
          writePluginConfig(CONFIG_KEY, { enabled: value === true || value === 'true' })
          return
        }
        const range =
          key === 'userImageBudget'
            ? IMAGE_DIET_RANGES.userImageBudget
            : key === 'toolImageBudget'
              ? IMAGE_DIET_RANGES.toolImageBudget
              : key === 'keepRounds'
                ? IMAGE_DIET_RANGES.keepRounds
                : null
        if (range === null) return t('save.unknownKey', { key })
        const num = Number(value)
        if (!Number.isFinite(num)) return t('save.notNumber')
        writePluginConfig(CONFIG_KEY, { [key]: Math.min(Math.max(Math.round(num), range.min), range.max) })
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'image-diet: settings.registerSection')

    return () => offSection()
  },
}
