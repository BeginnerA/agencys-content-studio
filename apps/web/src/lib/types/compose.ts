import type { Asset } from './base'

// ===== [M19] 品牌配置（三层：平台 / 项目 / run；字段级浅合并） =====

/** [M19] 素材槽（水印/片头/片尾）：enabled=false 强制禁用；file=平台 BRAND_DIR 文件名；asset_id=项目资产 */
export interface BrandMaterialSlot {
  enabled?: boolean
  file?: string
  asset_id?: number
}

/** [M19] 品牌素材槽键（平台资产上传/预览/清除端点路径参数） */
export type BrandSlotKey = 'watermark' | 'intro' | 'outro'

/** [M19] 水印位置（九宫格：上/中/下 × 左/中/右） */
export type WatermarkPosition =
  'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'

/** [M19] 水印配置（服务端 clamp：opacity 0.05–1、width_pct 0.03–0.5、margin_px 0–200） */
export interface WatermarkConfig extends BrandMaterialSlot {
  position?: WatermarkPosition
  opacity?: number
  width_pct?: number
  margin_px?: number
}

/** [M19] 字幕样式结构化配置（字段缺省 = 公式基线：字号 4% 高 / 底边距 2%） */
export interface SubtitleStyleConfig {
  font?: string
  /** FontSize = round(H × size_pct)（服务端 clamp 0.008–0.06） */
  size_pct?: number
  color?: string
  outline_color?: string
  /** Outline = max(1, round(H × pct))（服务端 clamp 0–0.005） */
  outline_pct?: number
  shadow?: number
  /** MarginV = round(H × pct)（服务端 clamp 0–0.1） */
  margin_v_pct?: number
  /** ASS 对齐（2 底部 / 5 中间 / 8 顶部） */
  alignment?: 2 | 5 | 8
  bold?: boolean
}

/** [M19] 品牌配置（run 级 _compose.brand 同构；PUT 槽位传 null = 清除该槽覆盖回落继承） */
export interface BrandConfig {
  subtitle?: SubtitleStyleConfig | null
  watermark?: WatermarkConfig | null
  intro?: BrandMaterialSlot | null
  outro?: BrandMaterialSlot | null
}

// ===== [M11] 单步重跑 / 合成设置（BGM·转场） =====

/** [M11] 转场枚举（对齐 ffmpeg xfade 子集；与服务端 TRANSITIONS 同值） */
export type ComposeTransition =
  'none' | 'fade' | 'fadeblack' | 'slideleft' | 'slideright' | 'dissolve'

/** [M11] run 级合成配置（run.input._compose；空对象 = 未设置，走模板 params / 代码默认） */
export interface ComposeConfig {
  /** 回显宽松（服务端枚举校验；UI 对未知值降级 none） */
  transition?: string
  /** 0.1–2 秒（服务端 clamp） */
  transition_duration?: number
  /** 0–1（服务端 clamp） */
  bgm_volume?: number
  /** 0–2 秒（服务端 clamp） */
  bgm_fade?: number
  /** [M19] 品牌配置（run 级覆盖；PUT 槽位传 null = 清除该槽覆盖；整键 null = 清空） */
  brand?: BrandConfig | null
  /** [M19] per-shot 音效全局音量（默认 1；服务端 clamp 0–2） */
  sfx_volume?: number
  /** [M19] 多画幅原生渲染（B 路径：合成内多路；PUT null = 清除 = 不启用） */
  multi_aspect?: MultiAspectConfig | null
}

/** [M19] 镜头音效绑定项（GET /runs/:id/compose/sfx；每镜 ≤1 条有效） */
export interface ComposeSfxItem {
  shotId: string
  asset: Asset
}

/** [M19] 常用发布画幅（与服务端 ASPECTS 同值） */
export type AspectValue = '9:16' | '1:1' | '4:5' | '16:9'

/** [M19] 画幅适配策略（与服务端 ASPECT_STRATEGIES 同值）：crop 居中裁切 | pad 等比补黑边 */
export type AspectStrategy = 'crop' | 'pad'

/** [M19] 多画幅原生渲染配置（_compose.multi_aspect；aspects 去重后 1–3 项） */
export interface MultiAspectConfig {
  enabled: boolean
  aspects: AspectValue[]
  strategy: AspectStrategy
}

/** [M19] 派生画幅结果（POST /runs/:id/derive-aspect；reused = 同画幅+同策略+同源成片命中幂等） */
export interface DeriveAspectResult {
  ok: boolean
  asset: Asset
  reused: boolean
  note: string
}

/** [M11] 单步重跑结果（POST /runs/:id/steps/:stepKey/rerun；无 tasks_reset 字段，预计执行数在 note 文案） */
export interface RerunResult {
  ok: boolean
  run_id: number
  step_key: string
  has_tasks: boolean
  tasks_total: number
  tasks_succeeded: number
  note: string
}

/** 级联重跑：单步信息（GET/POST rerun-cascade chain 元素；后端 snake 保持 camel 原样） */
export interface ChainStepInfo {
  stepKey: string
  title: string
  actionKey: string
  isTarget: boolean
  tasksTotal: number
  tasksToRun: number
  charged: boolean
}

/** 级联重跑预览（GET /runs/:id/steps/:stepKey/rerun-cascade） */
export interface ChainRerunPreview {
  runId: number
  stepKey: string
  run_id: number
  step_key: string
  chain: ChainStepInfo[]
  totalTasksToRun: number
  chargedSteps: number
}

/** 级联重跑执行结果（POST /runs/:id/steps/:stepKey/rerun-cascade） */
export interface ChainRerunResult {
  ok: boolean
  run_id: number
  step_key: string
  chain: ChainStepInfo[]
  total_tasks_to_run: number
  charged_steps: number
  note: string
}
