/**
 * 云元数据地址清单：这些主机给虚拟机发临时凭据，浏览器自动化一律拒绝。
 *
 * 放在 core 而不是 browser 插件里：dock-browser 也要用同一条黑名单。
 * 两个插件各抄一份迟早会漂，所以只有这一份，browser 插件转出它保持旧引用可用。
 *
 * @module dsc/packages/cdp/cloud-metadata
 */
export const CLOUD_METADATA_HOSTS: readonly string[] = [
  '169.254.169.254', // AWS / Azure / GCP / Oracle 的实例元数据
  '169.254.170.2', // ECS 任务元数据
  '100.100.100.200', // 阿里云
  'fd00:ec2::254', // AWS 的 IPv6 元数据
  'metadata.google.internal',
  'metadata.goog',
]
