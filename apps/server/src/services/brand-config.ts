/**
 * [M19] 品牌配置三层模型服务（平台 settings.brand / 项目 projects.settings.brand / run.input._compose.brand）。
 * - 合并语义：字段级浅合并（槽内字段后层覆盖前层；槽整体保留）
 * - 来源解析：asset_id（须存在/属项目/未删/有 relPath，经项目目录）→ file（BRAND_DIR 内文件名）→ 无（禁用）
 * - enabled === false 强制禁用；文件缺失宽容降级（跳过 + log，不阻断合成）
 * - 纯函数（mergeBrand / sanitizeSubtitleStyle / sanitizeWatermark）导出供探针直测
 * - ffmpeg-merge 经 resolveBrandConfig 读取（唯一异步入口；不改 ctx.settings 构造，零侵入）
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { assets, projects, settings } from '../db/schema'
import { BRAND_DIR } from '../env'
import { createLogger } from '../logger'
import { absPathOf } from './storage'

const log = createLogger('brand-config')

// ---------- 类型 ----------

/** 素材槽（水印/片头/片尾通用）：file = BRAND_DIR 内文件名（平台级）；asset_id = 项目资产（项目/run 级） */
export interface BrandMaterialSlot {
  enabled?: boolean
  file?: string
  asset_id?: number
}

/** 水印位置（九宫格：上/中/下 × 左/中/右） */
export const WATERMARK_POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'] as const
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number]

export interface WatermarkConfig extends BrandMaterialSlot {
  position?: WatermarkPosition
  opacity?: number // clamp 0.05–1（默认 0.9）
  width_pct?: number // clamp 0.03–0.5（默认 0.15）
  margin_px?: number // clamp 0–200（默认 24）
}

/** 字幕样式结构化配置（字段缺省 = 现公式基线；consumption 见 buildSubtitleStyle） */
export interface SubtitleStyleConfig {
  font?: string // FontName（默认 'Noto Sans CJK SC'）
  size_pct?: number // FontSize = round(H × size_pct)（默认 0.04；clamp 0.008–0.06）
  color?: string // '#RRGGBB'（默认 #FFFFFF）
  outline_color?: string // '#RRGGBB'（默认 #000000）
  outline_pct?: number // Outline = max(1, round(H × pct))（默认 0.0009；clamp 0–0.005）
  shadow?: number // clamp 0–8（默认 0）
  margin_v_pct?: number // MarginV = round(H × pct)（默认 0.02；clamp 0–0.1）
  alignment?: 2 | 5 | 8 // ASS 对齐（2 底部 / 8 顶部 / 5 中间）
  bold?: boolean
}

/** 品牌配置（三层同构；字段级浅合并） */
export interface BrandConfig {
  subtitle?: SubtitleStyleConfig
  watermark?: WatermarkConfig
  intro?: BrandMaterialSlot
  outro?: BrandMaterialSlot
}

/** 水印参数解析结果（清洗 + 默认值应用后） */
export interface ResolvedWatermark {
  position: WatermarkPosition
  opacity: number
  width_pct: number
  margin_px: number
}

/** 品牌解析结果（ffmpeg-merge 消费形态：合并 + 清洗 + 来源路径落地） */
export interface ResolvedBrandConfig {
  subtitle?: SubtitleStyleConfig
  watermark?: ResolvedWatermark & { path: string; source: 'asset' | 'file' }
  intro?: { path: string; source: 'asset' | 'file' }
  outro?: { path: string; source: 'asset' | 'file' }
}

// ---------- 纯函数 ----------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

/** 字段级浅合并：槽内字段后层覆盖前层（null/undefined/非对象层跳过；纯函数，探针直测） */
export function mergeBrand(...layers: Array<BrandConfig | null | undefined>): BrandConfig {
  const out: BrandConfig = {}
  for (const layer of layers) {
    if (!isObj(layer)) continue
    if (isObj(layer.subtitle)) out.subtitle = { ...out.subtitle, ...(layer.subtitle as SubtitleStyleConfig) }
    if (isObj(layer.watermark)) out.watermark = { ...out.watermark, ...(layer.watermark as WatermarkConfig) }
    if (isObj(layer.intro)) out.intro = { ...out.intro, ...(layer.intro as BrandMaterialSlot) }
    if (isObj(layer.outro)) out.outro = { ...out.outro, ...(layer.outro as BrandMaterialSlot) }
  }
  return out
}

/** 字幕样式清洗（类型过滤 + clamp；无合法字段 → undefined = 不接管） */
export function sanitizeSubtitleStyle(cfg: SubtitleStyleConfig | undefined): SubtitleStyleConfig | undefined {
  if (!isObj(cfg)) return undefined
  const out: SubtitleStyleConfig = {}
  if (typeof cfg.font === 'string' && cfg.font.trim()) out.font = cfg.font.trim()
  if (typeof cfg.size_pct === 'number' && Number.isFinite(cfg.size_pct)) out.size_pct = clamp(cfg.size_pct, 0.008, 0.06)
  if (isHexColor(cfg.color)) out.color = cfg.color
  if (isHexColor(cfg.outline_color)) out.outline_color = cfg.outline_color
  if (typeof cfg.outline_pct === 'number' && Number.isFinite(cfg.outline_pct)) out.outline_pct = clamp(cfg.outline_pct, 0, 0.005)
  if (typeof cfg.shadow === 'number' && Number.isFinite(cfg.shadow)) out.shadow = Math.round(clamp(cfg.shadow, 0, 8))
  if (typeof cfg.margin_v_pct === 'number' && Number.isFinite(cfg.margin_v_pct)) out.margin_v_pct = clamp(cfg.margin_v_pct, 0, 0.1)
  if (cfg.alignment === 2 || cfg.alignment === 5 || cfg.alignment === 8) out.alignment = cfg.alignment
  if (typeof cfg.bold === 'boolean') out.bold = cfg.bold
  return Object.keys(out).length > 0 ? out : undefined
}

/** 水印参数清洗（枚举 + clamp + 默认值；位置缺省 br / 透明度 0.9 / 宽 0.15 / 边距 24） */
export function sanitizeWatermark(cfg: WatermarkConfig | undefined): ResolvedWatermark {
  const position =
    cfg && WATERMARK_POSITIONS.includes(cfg.position as WatermarkPosition)
      ? (cfg.position as WatermarkPosition)
      : 'br'
  const opacity = cfg && typeof cfg.opacity === 'number' && Number.isFinite(cfg.opacity) ? clamp(cfg.opacity, 0.05, 1) : 0.9
  const width_pct =
    cfg && typeof cfg.width_pct === 'number' && Number.isFinite(cfg.width_pct) ? clamp(cfg.width_pct, 0.03, 0.5) : 0.15
  const margin_px =
    cfg && typeof cfg.margin_px === 'number' && Number.isFinite(cfg.margin_px)
      ? Math.round(clamp(cfg.margin_px, 0, 200))
      : 24
  return { position, opacity, width_pct, margin_px }
}

/** 水印显式字段规范化（仅保留显式提供的合法字段 + clamp；默认值在消费侧 sanitizeWatermark 应用） */
export function normalizeWatermarkPatch(cfg: WatermarkConfig): WatermarkConfig {
  const out: WatermarkConfig = {}
  if (typeof cfg.enabled === 'boolean') out.enabled = cfg.enabled
  if (typeof cfg.file === 'string' && cfg.file.trim()) out.file = cfg.file.trim()
  if (typeof cfg.asset_id === 'number' && Number.isFinite(cfg.asset_id)) out.asset_id = Math.round(cfg.asset_id)
  if (WATERMARK_POSITIONS.includes(cfg.position as WatermarkPosition)) out.position = cfg.position
  if (typeof cfg.opacity === 'number' && Number.isFinite(cfg.opacity)) out.opacity = clamp(cfg.opacity, 0.05, 1)
  if (typeof cfg.width_pct === 'number' && Number.isFinite(cfg.width_pct)) out.width_pct = clamp(cfg.width_pct, 0.03, 0.5)
  if (typeof cfg.margin_px === 'number' && Number.isFinite(cfg.margin_px)) out.margin_px = Math.round(clamp(cfg.margin_px, 0, 200))
  return out
}

/** 素材槽显式字段规范化（enabled/file/asset_id；片头尾/水印共用） */
export function normalizeMaterialSlot(slot: BrandMaterialSlot): BrandMaterialSlot {
  const out: BrandMaterialSlot = {}
  if (typeof slot.enabled === 'boolean') out.enabled = slot.enabled
  if (typeof slot.file === 'string' && slot.file.trim()) out.file = slot.file.trim()
  if (typeof slot.asset_id === 'number' && Number.isFinite(slot.asset_id)) out.asset_id = Math.round(slot.asset_id)
  return out
}

/**
 * 品牌写补丁规范化（updateComposeConfig / 设置写入共用）：类型校验 + clamp + 显式字段保留。
 * 槽值 null = 清除语义（由调用侧处理）；无任何已知槽键 → 抛错；非法子对象 → 抛错（调用侧转 WorkbenchError）。
 */
export function normalizeBrandPatch(raw: unknown): BrandConfig {
  if (!isObj(raw)) throw new Error('brand 需为对象')
  const cfg = raw as Record<string, unknown>
  const out: BrandConfig = {}
  let sawSlot = false
  const subtitle = cfg['subtitle']
  if (subtitle !== undefined) {
    sawSlot = true
    if (subtitle !== null) {
      if (!isObj(subtitle)) throw new Error('brand.subtitle 需为对象')
      const st = sanitizeSubtitleStyle(subtitle as SubtitleStyleConfig)
      if (!st) throw new Error('brand.subtitle 无合法字段（检查字段类型与取值范围）')
      out.subtitle = st
    }
  }
  const watermark = cfg['watermark']
  if (watermark !== undefined) {
    sawSlot = true
    if (watermark !== null) {
      if (!isObj(watermark)) throw new Error('brand.watermark 需为对象')
      const wm = normalizeWatermarkPatch(watermark as WatermarkConfig)
      if (Object.keys(wm).length === 0) throw new Error('brand.watermark 无合法字段')
      out.watermark = wm
    }
  }
  for (const slot of ['intro', 'outro'] as const) {
    const v = cfg[slot]
    if (v === undefined) continue
    sawSlot = true
    if (v === null) continue
    if (!isObj(v)) throw new Error(`brand.${slot} 需为对象`)
    const s = normalizeMaterialSlot(v as BrandMaterialSlot)
    if (Object.keys(s).length === 0) throw new Error(`brand.${slot} 无合法字段`)
    out[slot] = s
  }
  if (!sawSlot) throw new Error('brand 无已知槽键（subtitle/watermark/intro/outro）')
  return out
}

// ---------- 各层读取 ----------

/** 平台品牌：settings 表 key='brand'（缺失/损坏 → {}） */
export async function readPlatformBrand(): Promise<BrandConfig> {
  try {
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'brand')).limit(1)
    const raw = rows[0]?.value
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isObj(parsed) ? (parsed as BrandConfig) : {}
  } catch {
    return {}
  }
}

/** 项目品牌：projects.settings.brand（缺失/损坏 → {}） */
export async function readProjectBrand(projectId: number): Promise<BrandConfig> {
  try {
    const rows = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1)
    const raw = rows[0]?.settings
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { brand?: unknown }
    return isObj(parsed.brand) ? (parsed.brand as BrandConfig) : {}
  } catch {
    return {}
  }
}

/** run 品牌：run.input._compose.brand（缺失/损坏 → {}） */
export function readComposeBrand(runInput: string | null): BrandConfig {
  if (!runInput) return {}
  try {
    const obj = JSON.parse(runInput) as { _compose?: unknown }
    const c = obj._compose
    if (isObj(c) && isObj(c.brand)) return c.brand as BrandConfig
    return {}
  } catch {
    return {}
  }
}

// ---------- 来源解析 ----------

/** 素材槽来源路径解析：asset_id（存在/属项目/未删/有 relPath）优先 → file（BRAND_DIR 内）→ null（宽容降级） */
async function resolveMaterialPath(
  slotName: 'watermark' | 'intro' | 'outro',
  slot: BrandMaterialSlot,
  projectId: number,
): Promise<{ path: string; source: 'asset' | 'file' } | null> {
  if (slot.enabled === false) return null
  if (typeof slot.asset_id === 'number') {
    const rows = await db.select().from(assets).where(eq(assets.id, slot.asset_id)).limit(1)
    const a = rows[0]
    if (!a || a.deletedAt || a.projectId !== projectId || !a.relPath) {
      log.warn(`品牌素材槽 ${slotName}：资产 #${slot.asset_id} 不可用（不存在/已删/不属项目/无文件），已跳过`)
      return null
    }
    return { path: absPathOf(a.relPath), source: 'asset' }
  }
  if (typeof slot.file === 'string' && slot.file.trim()) {
    const p = join(BRAND_DIR, slot.file.trim())
    if (!existsSync(p)) {
      log.warn(`品牌素材槽 ${slotName}：平台文件 ${slot.file.trim()} 不存在，已跳过`)
      return null
    }
    return { path: p, source: 'file' }
  }
  return null
}

// ---------- 唯一异步入口 ----------

/**
 * 三层合并 + 清洗 + 来源解析（ffmpeg-merge 唯一入口）。
 * 平台 → 项目 → run 字段级覆盖；无任何新配置 → 返回 {}（调用方保持现行为逐字不变）。
 */
export async function resolveBrandConfig(projectId: number, runInput: string | null): Promise<ResolvedBrandConfig> {
  const [platform, project] = await Promise.all([readPlatformBrand(), readProjectBrand(projectId)])
  const merged = mergeBrand(platform, project, readComposeBrand(runInput))
  const out: ResolvedBrandConfig = {}
  const subtitle = sanitizeSubtitleStyle(merged.subtitle)
  if (subtitle) out.subtitle = subtitle
  if (merged.watermark) {
    const wm = await resolveMaterialPath('watermark', merged.watermark, projectId)
    if (wm) out.watermark = { ...sanitizeWatermark(merged.watermark), ...wm }
  }
  for (const slot of ['intro', 'outro'] as const) {
    const cfg = merged[slot]
    if (!cfg) continue
    const m = await resolveMaterialPath(slot, cfg, projectId)
    if (m) out[slot] = m
  }
  return out
}
