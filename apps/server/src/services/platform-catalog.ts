/**
 * [M36·G12.1] 平台导出规格单一真源目录（Tier A，零成本静态表）。
 * 目标：把「各已知平台的推荐导出规格」收敛为一份代码常量，供前端「从平台目录补全」一键带出，
 * 消除「加一个受支持平台要手填画幅/时长/命名」的手工会填。画幅/时长对齐既有 DEFAULT_PRESETS 与
 * workspace/prompts/adapt-text.md 平台规则速查，不凭记忆发明规则。
 * 机器键与 publications / exports 域对齐：视频号 = wechat_channels（非 adapt-text 的 shipinhao）。
 * 图文平台（wechat/zhihu/toutiao）无视频时长维度 → maxDuration = 0；aspect 取封面向 16:9（画幅白名单内）。
 */

export interface PlatformCatalogEntry {
  platform: string          // 机器键，与 publications.platform / export_presets 键对齐
  label: string             // 中文显示名
  kind: 'video' | 'text'    // 视频平台 vs 图文平台（影响 maxDuration 语义）
  aspect: string            // 推荐画幅（白名单：9:16 / 1:1 / 4:5 / 16:9）
  maxDuration: number       // 秒；图文平台 = 0（无时长维度）
  namingPattern: string
  includeCover: boolean
  includeSubtitle: boolean
  watermark: boolean
}

/** 8 平台单一真源（5 视频沿用既有 DEFAULT_PRESETS 值 + 3 图文新增） */
export const PLATFORM_CATALOG: PlatformCatalogEntry[] = [
  { platform: 'douyin', label: '抖音', kind: 'video', aspect: '9:16', maxDuration: 60, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true, watermark: false },
  { platform: 'wechat_channels', label: '视频号', kind: 'video', aspect: '9:16', maxDuration: 180, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true, watermark: false },
  { platform: 'kuaishou', label: '快手', kind: 'video', aspect: '9:16', maxDuration: 120, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true, watermark: false },
  { platform: 'xiaohongshu', label: '小红书', kind: 'video', aspect: '4:5', maxDuration: 60, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true, watermark: false },
  { platform: 'bilibili', label: 'B站', kind: 'video', aspect: '16:9', maxDuration: 600, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true, watermark: false },
  { platform: 'wechat', label: '公众号', kind: 'text', aspect: '16:9', maxDuration: 0, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: false, watermark: false },
  { platform: 'zhihu', label: '知乎', kind: 'text', aspect: '16:9', maxDuration: 0, namingPattern: '{project}_{template}_run{run}', includeCover: false, includeSubtitle: false, watermark: false },
  { platform: 'toutiao', label: '头条', kind: 'text', aspect: '16:9', maxDuration: 0, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: false, watermark: false },
]

const CATALOG_BY_KEY = new Map(PLATFORM_CATALOG.map((c) => [c.platform, c]))

/** 按机器键查目录条目；未登记 → null（不猜测） */
export function catalogByPlatform(platform: string): PlatformCatalogEntry | null {
  return CATALOG_BY_KEY.get(platform) ?? null
}

/** 给定已存在的平台键，返回目录中「尚未配置」的条目（补全只填缺失，用户已配/改过的不覆盖）；顺序稳定按目录序 */
export function seedMissing(present: string[], only?: string[]): PlatformCatalogEntry[] {
  const have = new Set(present)
  const want = only && only.length ? new Set(only) : null
  return PLATFORM_CATALOG.filter((c) => !have.has(c.platform) && (!want || want.has(c.platform)))
}
