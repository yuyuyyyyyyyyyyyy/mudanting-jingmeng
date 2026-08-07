/**
 * 图片来源基址。
 * 腾讯云 COS 桶默认域名（免备案）→ 国内 CDN 秒开，测试者不再被隧道带宽卡图。
 * 留空 = 回退本地 /assets（开发模式、COS 未配好时用）。
 * 注意：COS 桶里的 6 张 webp 在桶根目录（不带 assets/ 前缀）。
 */
export const ASSET_BASE = 'https://mdting-images-1332506039.cos.ap-guangzhou.myqcloud.com'

export const assetUrl = (name: string) =>
  ASSET_BASE ? `${ASSET_BASE}/${name}` : `/assets/${name}`
