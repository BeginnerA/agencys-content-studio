/**
 * 集级参数覆盖服务（run 级生成参数）。
 * - 载体：run.input._params（下划线内部键，对齐 run.input._compose 先例）——
 *   { image: {...}, video: {...}, audio: {...}, llm: {...} }，启动时快照、随 run 固化。
 * - 校验：键白名单 + 类型 + clamp（非法 → 抛 RunParamsError，路由层转 400）。
 * - 生效：context.createStepContext 在 settings 合并链顶层叠加
 *   （run 覆盖 > 项目 settings > 模板 defaults）；action 零改动。
 * - 无 _params 的 run：readRunParams 返回 {}，三层叠加逐字等价现行为。
 */

/** 校验失败（路由层转 400 bad_params；services 不依赖路由层） */
export class RunParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunParamsError'
  }
}

/** 可覆盖的参数分组（与 settings 四组对齐） */
export const PARAM_GROUPS = ['image', 'video', 'audio', 'llm'] as const
export type ParamGroup = (typeof PARAM_GROUPS)[number]

export interface RunParams {
  image?: Record<string, unknown>
  video?: Record<string, unknown>
  audio?: Record<string, unknown>
  llm?: Record<string, unknown>
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

type FieldRule =
  | { kind: 'string'; transform?: (s: string) => string; test?: (s: string) => boolean; hint?: string }
  | { kind: 'number'; lo: number; hi: number; int?: boolean }

/** 键白名单（组 → 字段 → 规则）；未知键/非法值一律 400 */
const RULES: Record<ParamGroup, Record<string, FieldRule>> = {
  image: {
    provider: { kind: 'string', transform: (s) => s.trim() },
    model: { kind: 'string', transform: (s) => s.trim() },
    size: {
      kind: 'string',
      transform: (s) => s.trim(),
      test: (s) => /^\d{2,5}x\d{2,5}$/i.test(s),
      hint: '需为 宽x高（如 832x1248）',
    },
  },
  video: {
    provider: { kind: 'string', transform: (s) => s.trim() },
    model: { kind: 'string', transform: (s) => s.trim() },
    resolution: {
      kind: 'string',
      transform: (s) => s.trim(),
      test: (s) => /^(480|720|1080)p$/i.test(s),
      hint: '需为 480p/720p/1080p',
    },
    duration: { kind: 'number', lo: 1, hi: 30 },
  },
  audio: {
    provider: { kind: 'string', transform: (s) => s.trim() },
    voice: { kind: 'string', transform: (s) => s.trim() },
  },
  llm: {
    temperature: { kind: 'number', lo: 0, hi: 2 },
    max_tokens: { kind: 'number', lo: 256, hi: 65536, int: true },
  },
}

/** 校验结果（route 转 400 用）：错误列表（空 = 合法） */
export function validateRunParams(raw: unknown): { params: RunParams; errors: string[] } {
  const errors: string[] = []
  if (raw === undefined || raw === null) return { params: {}, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { params: {}, errors: ['_params 需为对象（{ image|video|audio|llm: {...} }）'] }
  }
  const params: RunParams = {}
  const obj = raw as Record<string, unknown>
  for (const [group, value] of Object.entries(obj)) {
    if (!(PARAM_GROUPS as readonly string[]).includes(group)) {
      errors.push(`_params.${group} 不是可覆盖分组（允许：${PARAM_GROUPS.join('/')}）`)
      continue
    }
    if (value === undefined || value === null) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`_params.${group} 需为对象`)
      continue
    }
    const rules = RULES[group as ParamGroup]
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const rule = rules[key]
      if (!rule) {
        errors.push(`_params.${group}.${key} 不是可覆盖参数（允许：${Object.keys(rules).join('/')}）`)
        continue
      }
      if (v === undefined || v === null || v === '') continue
      if (rule.kind === 'string') {
        if (typeof v !== 'string' && typeof v !== 'number') {
          errors.push(`_params.${group}.${key} 需为字符串`)
          continue
        }
        const s = rule.transform ? rule.transform(String(v)) : String(v)
        if (!s) continue
        if (rule.test && !rule.test(s)) {
          errors.push(`_params.${group}.${key} 非法（${rule.hint ?? '格式不符'}）`)
          continue
        }
        out[key] = s
      } else {
        const n = Number(v)
        if (!Number.isFinite(n)) {
          errors.push(`_params.${group}.${key} 需为数字`)
          continue
        }
        out[key] = rule.int ? Math.round(clamp(n, rule.lo, rule.hi)) : clamp(n, rule.lo, rule.hi)
      }
    }
    if (Object.keys(out).length > 0) params[group as ParamGroup] = out
  }
  return { params, errors }
}

/** 严格模式：非法即抛（run 创建链路用） */
export function normalizeRunParamsOrThrow(raw: unknown): RunParams {
  const { params, errors } = validateRunParams(raw)
  if (errors.length > 0) throw new RunParamsError(errors.join('；'))
  return params
}

/** run.input JSON → 集级覆盖（损坏/缺省 → {}；context 每步解析用） */
export function readRunParams(inputJson: string | null): RunParams {
  if (!inputJson) return {}
  try {
    const obj = JSON.parse(inputJson) as { _params?: unknown }
    const { params } = validateRunParams(obj._params)
    return params
  } catch {
    return {}
  }
}
