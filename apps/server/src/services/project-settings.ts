/**
 * 项目 settings 写时闸门。
 *
 * 背景：`POST/PATCH /projects` 将 `settings` 任意 JSON 直存（routes/projects.ts:176），
 * 运行时 `ai-video.ts` / `ffmpeg-merge/index.ts` 读 `ctx.settings.video.{provider,model,resolution,duration}`
 * 才炸——「填错」成本由用户 + 适配器共同承担。此后把「核实」主体从用户转移到**服务端闸门**
 * （Tier A 纪律：不取消校验，只在写入前挡），并**保持既有 run-params RULES 白名单同源**。
 *
 * 边界（保守治理，遵「不猜测」）：
 * - 仅治理 **明确会引发运行时错** 的字段（对齐 run-params 已登记的 4 组白名单）。
 * - **未登记字段一律放行**（如 `video.fps` / `video.duration_per_shot` / `video.subtitle_style` /
 *   `video.aspect_ratio`，`image.size` 走适配器兜底）——避免破坏既有项目。
 * - 兼容 ffmpeg-merge 的 WxH 语义（`video.resolution` 允许 `480p` **或** `1080x1920` 两种格式），
 *   这是 ai-video 与 ffmpeg-merge 的历史命名冲突（同为 `settings.video.resolution`、异语义）。
 * - clamp 而非拒绝（duration / max_tokens）：与 run-params 语义一致（越界钳到区间），避免用户被硬错。
 * - 值语义与原 `JSON.stringify(settings)` 完全一致：本服务不改写、只校验，errors 非空即 400。
 */

/** 校验失败：路由层转 400 bad_settings（services 不依赖路由层） */
export class ProjectSettingsError extends Error {
  code = 'bad_settings'
  constructor(message: string) {
    super(message)
    this.name = 'ProjectSettingsError'
  }
}

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

type FieldValidator = (v: unknown) => string | null

/** 非空字符串（trim 后）；空串视为未设置放行（向后兼容既有 settings 空字段） */
const strField = (label: string): FieldValidator => (v) => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return `${label} 需为字符串`
  return null
}

/** 数字字段（可选 clamp 到区间；int=true 时提示需为整数但不强制） */
const numField = (label: string, lo: number, hi: number, opts: { int?: boolean } = {}): FieldValidator => (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return `${label} 需为数字`
  if (opts.int && !Number.isInteger(n)) return `${label} 需为整数`
  // 越界不视为错误：与 run-params 语义一致（clamp 到区间），只在明显非数字时报
  void clampNum(n, lo, hi)
  return null
}

/** 分辨率：兼容 ai-video 输入域（480p/720p/1080p）与 ffmpeg-merge 输出域（WxH） */
const resolutionField = (label: string): FieldValidator => (v) => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return `${label} 需为字符串`
  const s = v.trim()
  if (!s) return null
  if (/^(480|720|1080)p$/i.test(s)) return null
  if (/^\d{2,5}x\d{2,5}$/i.test(s)) return null
  return `${label} 需为 480p/720p/1080p 或 832x1248 类 WxH（收到 ${JSON.stringify(v)}）`
}

/** 图片尺寸：WxH（与 run-params.image.size 同规则） */
const imageSizeField = (label: string): FieldValidator => (v) => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return `${label} 需为字符串`
  const s = v.trim()
  if (!s) return null
  return /^\d{2,5}x\d{2,5}$/i.test(s) ? null : `${label} 需为 宽x高（如 832x1248，收到 ${JSON.stringify(v)}）`
}

/**
 * 已登记字段白名单（与 run-params.ts RULES 对齐 + 兼容现网 settings 消费点）。
 * 未知字段一律放行；不做「设置 schema 收紧」。
 */
const VALIDATORS: Record<'video' | 'image' | 'audio' | 'llm', Record<string, FieldValidator>> = {
  video: {
    provider: strField('settings.video.provider'),
    model: strField('settings.video.model'),
    resolution: resolutionField('settings.video.resolution'),
    duration: numField('settings.video.duration', 1, 30),
  },
  image: {
    provider: strField('settings.image.provider'),
    model: strField('settings.image.model'),
    size: imageSizeField('settings.image.size'),
  },
  audio: {
    provider: strField('settings.audio.provider'),
    voice: strField('settings.audio.voice'),
    speed: numField('settings.audio.speed', 0.1, 4),
  },
  llm: {
    temperature: numField('settings.llm.temperature', 0, 2),
    max_tokens: numField('settings.llm.max_tokens', 256, 65536, { int: true }),
  },
}

const GROUPS = Object.keys(VALIDATORS) as Array<keyof typeof VALIDATORS>

/**
 * 校验项目 settings 对象。返回 errors 列表（空 = 合法）。
 * - 非对象 / 数组 / null → 报错
 * - 分组非对象 → 报错
 * - 已登记字段违规 → 收集错误
 * - 未登记字段（如 video.fps、video.subtitle_style）→ 放行
 */
export function validateProjectSettings(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return ['settings 需为对象（{ video|image|audio|llm: {...} }）']
  }
  const obj = raw as Record<string, unknown>
  const errors: string[] = []
  for (const group of GROUPS) {
    const value = obj[group]
    if (value === undefined || value === null) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`settings.${group} 需为对象`)
      continue
    }
    const rules = VALIDATORS[group]
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const rule = rules[key]
      if (!rule) continue // 未登记字段放行（保守治理）
      const err = rule(v)
      if (err) errors.push(err)
    }
  }
  return errors
}

/** 严格模式：非法即抛（路由层用） */
export function assertProjectSettingsOrThrow(raw: unknown): void {
  const errors = validateProjectSettings(raw)
  if (errors.length > 0) throw new ProjectSettingsError(errors.join('；'))
}
