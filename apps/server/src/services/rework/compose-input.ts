/**
 * 精确返修 · 合成输入本地返修：单一变更契约（切片2 规格 §3，纯函数段）。
 *
 * 与字幕 SubtitleChange 并列、不并入字幕 schema。五类变更均收敛到「本地重合成、零付费生成」：
 *   compose-config（字段级补丁，值=null 清除回落缺省）/ bgm（换绑 assetId 或 null 移除）/
 *   sfx（逐镜换绑/null 移除）/ shot-select（某镜在用资产换成同类另一 assetId）/
 *   shot-duration（某镜显示时长覆盖，切片2b 轻档；compile 期折进 _compose.shot_durations，apply 复用配置写路径）。
 * 本段只做**纯语义**：schema 判别 + 冲突检测 + 配置规范化（委托 compose-config 真源，不重抄 clamp/枚举）
 * + 逐处 原值→新值 diff + no_effect 整体拒绝。资产存在性/kind/项目归属/「同一生成步骤 output 同类候选」
 * 属**需查库**的校验，置于 preview（T3）；本模块不触 DB、不触执行。
 */
import { z } from 'zod'
import { normalizeComposeConfigPatch, type ComposeConfig } from '../compose-config'

export type ComposeInputChange =
  | { kind: 'compose-config'; patch: Record<string, unknown> }
  | { kind: 'bgm'; assetId: number | null }
  | { kind: 'sfx'; shotId: string; assetId: number | null }
  | { kind: 'shot-select'; shotId: string; assetId: number }
  // 镜头时长覆盖（切片2b）：把某镜(shotId)显示时长设为 sec 秒；compile 期折进 _compose.shot_durations。
  | { kind: 'shot-duration'; shotId: string; sec: number }

/** 单请求变更数上限（切片2 规格 §3） */
export const MAX_COMPOSE_INPUT_CHANGES = 500

export interface ComposeInputError {
  code: string
  message: string
}

const intId = z.number().int().positive()
const shotIdSchema = z.string().min(1).max(200)
/** 配置补丁：开放键值（键合法性与值 clamp/枚举由 compose-config 真源校验，此处仅要求非空对象） */
const configPatchSchema = z
  .object({})
  .catchall(z.unknown())
  .refine((o) => Object.keys(o).length > 0, { message: 'patch 不能为空' })

export const composeInputChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('compose-config'), patch: configPatchSchema }).strict(),
  z.object({ kind: z.literal('bgm'), assetId: intId.nullable() }).strict(),
  z.object({ kind: z.literal('sfx'), shotId: shotIdSchema, assetId: intId.nullable() }).strict(),
  z.object({ kind: z.literal('shot-select'), shotId: shotIdSchema, assetId: intId }).strict(),
  z.object({ kind: z.literal('shot-duration'), shotId: shotIdSchema, sec: z.number().finite().positive() }).strict(),
])

export const composeInputChangesSchema = z.array(composeInputChangeSchema).min(1).max(MAX_COMPOSE_INPUT_CHANGES)

/** zod 层拒绝（非数组/空/未知 kind/额外字段/assetId 非法/超上限）→ 领域错误列表；不产出部分结果 */
export function parseComposeInputChanges(input: unknown): { ok: true; changes: ComposeInputChange[] } | { ok: false; errors: ComposeInputError[] } {
  const parsed = composeInputChangesSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: 'invalid_change',
        message: `合成输入变更请求不合法（${i.path.join('.') || 'root'}）：${i.message}`,
      })),
    }
  }
  return { ok: true, changes: parsed.data as ComposeInputChange[] }
}

/** 预览所需当前状态快照（由 capability 基准提供，纯数据；不含需查库的资产存在性） */
export interface ComposeInputCurrentState {
  config: ComposeConfig
  /** 在用 BGM 资产 id（无则 null） */
  bgmAssetId: number | null
  /** 各镜在用 SFX 资产 id（无音效镜不入表） */
  sfxByShot: Record<string, number>
  /** 各镜在用（选片后）资产 id */
  selectedByShot: Record<string, number>
}

/** 逐处旧→新差异（compose-config 按被改键一行；bgm/sfx/shot-select 按目标一行） */
export interface ComposeInputDiffEntry {
  kind: ComposeInputChange['kind']
  /** compose-config：字段键名；sfx/shot-select/shot-duration：shotId；bgm：'bgm' */
  field: string
  before: unknown
  after: unknown
  /** 镜头时长返修（切片2b）：请求短于该镜对齐语音时长 Σ 时，实际将落到该值（音画不脱节强制延长；未触发则不出现） */
  willClampToSec?: number
  /** 镜头时长返修：请求短于 Σ 触发自动延长告警（true 时 willClampToSec 必存在） */
  warn?: boolean
}

export interface NormalizedComposeInput {
  /** 规范化后变更（canonical 序：config→bgm→sfx→shot-select；供 previewHash 稳定 + apply 消费） */
  changes: ComposeInputChange[]
  /** 合并规范化后的完整配置（仅当含 compose-config 变更时给出；apply 逐键写回经真源） */
  nextConfig: ComposeConfig | null
  diffs: ComposeInputDiffEntry[]
}

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * 冲突检测 + 配置规范化（委托真源）+ diff + no_effect。整体成功或整体失败，绝不部分生效。
 * 资产存在性/kind/项目/同步骤候选集校验在 preview（T3）追加；此处 assetId 只作语义与幂等判定。
 */
export function compileComposeInputChanges(args: {
  changes: ComposeInputChange[]
  current: ComposeInputCurrentState
}): { ok: true; normalized: NormalizedComposeInput } | { ok: false; errors: ComposeInputError[] } {
  const { changes, current } = args
  const errors: ComposeInputError[] = []

  // 1) 单 run 仅一个 BGM 目标
  const bgmChanges = changes.filter((c) => c.kind === 'bgm') as Array<Extract<ComposeInputChange, { kind: 'bgm' }>>
  if (bgmChanges.length > 1) errors.push({ code: 'conflicting_changes', message: '单个 run 仅有一条 BGM，不能同时提交多次 BGM 变更' })

  // 2) sfx / shot-select 同镜唯一（各自命名空间内；跨 kind 同 shotId 允许——一管音效一管在用画面）
  const sfxChanges = changes.filter((c) => c.kind === 'sfx') as Array<Extract<ComposeInputChange, { kind: 'sfx' }>>
  const selectChanges = changes.filter((c) => c.kind === 'shot-select') as Array<Extract<ComposeInputChange, { kind: 'shot-select' }>>
  for (const [list, label] of [[sfxChanges, 'SFX'], [selectChanges, '候选改选']] as const) {
    const seen = new Set<string>()
    for (const c of list) {
      if (seen.has(c.shotId)) errors.push({ code: 'conflicting_changes', message: `镜头 ${c.shotId} 的${label}被重复指定` })
      seen.add(c.shotId)
    }
  }

  // 3) compose-config：合并多个补丁；同键异值冲突；委托真源逐键规范化（clamp/枚举/白名单/brand/multi_aspect）
  //    镜头时长（shot-duration，切片2b）折进同一 shot_durations 键，共用 nextConfig/apply 配置写路径（零新增 apply 分支）。
  const configChanges = changes.filter((c) => c.kind === 'compose-config') as Array<Extract<ComposeInputChange, { kind: 'compose-config' }>>
  const durationChanges = changes.filter((c) => c.kind === 'shot-duration') as Array<Extract<ComposeInputChange, { kind: 'shot-duration' }>>
  // 时长同镜唯一
  {
    const seen = new Set<string>()
    for (const c of durationChanges) {
      if (seen.has(c.shotId)) errors.push({ code: 'conflicting_changes', message: `镜头 ${c.shotId} 的时长被重复指定` })
      seen.add(c.shotId)
    }
  }
  const mergedPatch: Record<string, unknown> = {}
  let nextConfig: ComposeConfig | null = null
  if (configChanges.length > 0 || durationChanges.length > 0) {
    for (const c of configChanges) {
      for (const [key, value] of Object.entries(c.patch)) {
        if (key in mergedPatch && !jsonEq(mergedPatch[key], value)) {
          errors.push({ code: 'conflicting_changes', message: `配置项 ${key} 被多次指定为不同值` })
          continue
        }
        mergedPatch[key] = value
      }
    }
    if (durationChanges.length > 0) {
      const base = current.config.shot_durations ?? {}
      const fromConfig = mergedPatch['shot_durations'] && typeof mergedPatch['shot_durations'] === 'object' && !Array.isArray(mergedPatch['shot_durations'])
        ? (mergedPatch['shot_durations'] as Record<string, unknown>)
        : base
      const merged: Record<string, unknown> = { ...fromConfig }
      for (const c of durationChanges) merged[c.shotId] = c.sec
      mergedPatch['shot_durations'] = merged
    }
    if (errors.length === 0) {
      try {
        nextConfig = normalizeComposeConfigPatch(current.config, mergedPatch)
      } catch (err) {
        errors.push({ code: 'bad_field', message: (err as Error).message })
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  // 4) 逐处 diff（旧→新）；仅记录实际改变者（shot_durations 逐镜单列，不并入配置键 diff）
  const diffs: ComposeInputDiffEntry[] = []
  if (nextConfig) {
    for (const key of Object.keys(mergedPatch)) {
      if (key === 'shot_durations') continue
      const before = (current.config as Record<string, unknown>)[key] ?? null
      const after = (nextConfig as Record<string, unknown>)[key] ?? null
      if (!jsonEq(before, after)) diffs.push({ kind: 'compose-config', field: key, before, after })
    }
  }
  const durNext = nextConfig?.shot_durations ?? {}
  const durCur = current.config.shot_durations ?? {}
  for (const c of durationChanges) {
    const before = durCur[c.shotId] ?? null
    const after = durNext[c.shotId] ?? null
    if (before !== after) diffs.push({ kind: 'shot-duration', field: c.shotId, before, after })
  }
  for (const c of bgmChanges) {
    if (c.assetId !== current.bgmAssetId) diffs.push({ kind: 'bgm', field: 'bgm', before: current.bgmAssetId, after: c.assetId })
  }
  for (const c of sfxChanges) {
    const before = current.sfxByShot[c.shotId] ?? null
    if (c.assetId !== before) diffs.push({ kind: 'sfx', field: c.shotId, before, after: c.assetId })
  }
  for (const c of selectChanges) {
    const before = current.selectedByShot[c.shotId] ?? null
    if (c.assetId !== before) diffs.push({ kind: 'shot-select', field: c.shotId, before, after: c.assetId })
  }

  // 5) 无任何有效变更整体拒绝
  if (diffs.length === 0) {
    return { ok: false, errors: [{ code: 'no_effect', message: '变更结果与当前合成输入基准完全一致，没有需要应用的修改' }] }
  }

  // 6) canonical 序（config 合并为单条 + 规范化值；bgm 单条；sfx/shot-select 按 shotId 升序）
  const normalized: ComposeInputChange[] = []
  if (nextConfig) {
    const canonPatch: Record<string, unknown> = {}
    for (const key of Object.keys(mergedPatch).sort()) {
      canonPatch[key] = (nextConfig as Record<string, unknown>)[key] ?? null
    }
    normalized.push({ kind: 'compose-config', patch: canonPatch })
  }
  for (const c of bgmChanges) normalized.push({ kind: 'bgm', assetId: c.assetId })
  for (const c of [...sfxChanges].sort((a, b) => (a.shotId < b.shotId ? -1 : a.shotId > b.shotId ? 1 : 0))) {
    normalized.push({ kind: 'sfx', shotId: c.shotId, assetId: c.assetId })
  }
  for (const c of [...selectChanges].sort((a, b) => (a.shotId < b.shotId ? -1 : a.shotId > b.shotId ? 1 : 0))) {
    normalized.push({ kind: 'shot-select', shotId: c.shotId, assetId: c.assetId })
  }
  // shot-duration 显式保留为独立 canonical 条目（不折进 compose-config 后丢失语义）：
  //   apply 期从 changesJson 重编译时据此复现 shot-duration diff（否则 durationChanges 空、
  //   而 config 键又跳过 shot_durations → diffs 空 → 误判 no_effect）。
  for (const c of [...durationChanges].sort((a, b) => (a.shotId < b.shotId ? -1 : a.shotId > b.shotId ? 1 : 0))) {
    normalized.push({ kind: 'shot-duration', shotId: c.shotId, sec: c.sec })
  }
  return { ok: true, normalized: { changes: normalized, nextConfig, diffs } }
}
