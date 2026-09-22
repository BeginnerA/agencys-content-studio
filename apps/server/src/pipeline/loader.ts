import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { PROMPTS_DIR, TEMPLATES_DIR } from '../env'
import { createLogger } from '../logger'
import type { Template, TemplateInputDef, TemplateMeta, TemplateStepDef } from './types'
import { parseWhenExpr, whenRefs } from './refs'

const log = createLogger('loader')

/** M3 允许的 action 集合（registry 同步维护；loader 用它做加载期校验） */
export const KNOWN_ACTIONS = [
  'manual_ingest',
  'publication_ingest', // [整改] 复盘回灌：发布记录直接入库
  'literal',
  'ai_text',
  'ai_image',
  'ffmpeg_merge',
  'ai_video',
  'tts',
  'subtitle',
  'dialogue_subtitle',
  'memory_write',
  'memory_recall',
  'memory_summary',
  'compliance_check',
  'character_sync',
  'entity_sync',
  'text_split',
  'adapt_audit', // [M25·G4] 一致性回查（批 2 接线）
  'video_analyze', // [M25·G9] 视频解析含 ASR（批 3 接线）
] as const

const cache = new Map<string, Template>()

/** 模板文件路径（null = 不存在；.yaml/.yml 按序探测） */
export function templateFileOf(key: string): string | null {
  for (const ext of ['.yaml', '.yml']) {
    const p = join(TEMPLATES_DIR, `${key}${ext}`)
    try {
      if (statSync(p).isFile()) return p
    } catch {
      // 尝试下一扩展名
    }
  }
  return null
}

/**
 * [M23] 模板 key 避让：base 未被占用 → 原样返回；否则追加后缀 -2/-3/…（最多 30 层）；
 * 仍冲突 → null（调用方报错）。template-try 与 edit-save 共用。
 */
export function avoidTemplateKeyConflict(baseKey: string): string | null {
  let finalKey = baseKey
  let suffix = 2
  while (templateFileOf(finalKey) && suffix < 32) {
    finalKey = `${baseKey}-${suffix}`
    suffix += 1
  }
  return templateFileOf(finalKey) ? null : finalKey
}

/** 模板轻量校验：缺关键字段/引用未知 step → 抛错（含模板名与路径提示） */
function validate(raw: Record<string, unknown>, key: string): Template {
  const name = typeof raw.name === 'string' ? raw.name : key
  const fail = (msg: string): never => {
    throw new Error(`模板「${name}」(${key}.yaml) 非法：${msg}`)
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail('steps 缺失或为空')
  // inputs 声明深校验（kind 合法集 + default 类型与 kind 一致）
  const inputDefs: TemplateInputDef[] = []
  const declaredInputs = new Set<string>()
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs)) fail('inputs 需为数组')
    for (const d of raw.inputs as Array<Record<string, unknown>>) {
      const ik = d['key']
      if (typeof ik !== 'string' || !ik) fail('inputs 存在缺 key 的项')
      const kind = d['kind']
      if (!['text', 'files', 'int', 'bool', 'publications'].includes(String(kind))) {
        return fail(`输入 ${ik} 的 kind「${kind}」非法（支持 text/files/int/bool/publications）`)
      }
      if (d['required'] !== undefined && typeof d['required'] !== 'boolean') {
        return fail(`输入 ${ik} 的 required 需为布尔`)
      }
      const dv = d['default']
      if (dv !== undefined) {
        const typeOk =
          kind === 'bool' ? typeof dv === 'boolean' : kind === 'int' ? typeof dv === 'number' : typeof dv === 'string'
        if (!typeOk) return fail(`输入 ${ik} 的 default 类型与 kind(${kind}) 不一致`)
      }
      inputDefs.push({
        key: ik as string,
        label: typeof d['label'] === 'string' ? d['label'] : undefined,
        kind: kind as TemplateInputDef['kind'],
        required: d['required'] === true,
        accept: Array.isArray(d['accept']) ? (d['accept'] as string[]) : undefined,
        default: dv as TemplateInputDef['default'],
      })
      declaredInputs.add(ik as string)
    }
  }
  const steps: TemplateStepDef[] = []
  const seenKeys = new Set<string>()
  const order = new Map<string, number>()
  for (const sRaw of raw.steps as Array<Record<string, unknown>>) {
    const key = sRaw['key']
    if (typeof key !== 'string' || key === '') return fail('存在无 key 的步骤')
    if (seenKeys.has(key)) return fail(`步骤 key 重复: ${key}`)
    seenKeys.add(key)
    const action = sRaw['action']
    if (typeof action !== 'string') return fail(`步骤 ${key} 缺 action`)
    if (!(KNOWN_ACTIONS as readonly string[]).includes(action)) {
      return fail(`步骤 ${key} 的 action「${action}」未注册（已知: ${KNOWN_ACTIONS.join('/')}）`)
    }
    const inputs = sRaw['inputs']
    if (!inputs || typeof inputs !== 'object') return fail(`步骤 ${key} 缺 inputs`)
    if (sRaw['gate']) {
      const g = sRaw['gate'] as Record<string, unknown>
      if (g.mode !== 'required' || typeof g.message !== 'string') {
        return fail(`步骤 ${key} 的 gate 需为 {mode: required, message: string}`)
      }
      if (g['skip_label'] !== undefined && typeof g['skip_label'] !== 'string') {
        return fail(`步骤 ${key} 的 gate.skip_label 需为字符串`)
      }
      if (g['reject'] !== undefined && g['reject'] !== 'stop') return fail(`步骤 ${key} 的 gate.reject 仅支持 stop`)
      if (g['reject'] === 'stop' && g['skip_label']) return fail(`步骤 ${key} 的停止型审阅不允许免审跳过`)
      if (g['when'] !== undefined && !isExprList(g['when'])) {
        return fail(`步骤 ${key} 的 gate.when 需为字符串或字符串数组`)
      }
    }
    if (sRaw['batch']) {
      const b = sRaw['batch'] as Record<string, unknown>
      if (typeof b.field !== 'string' || !b.field) return fail(`步骤 ${key} 的 batch 缺 field`)
      const mc = b['max_concurrent'] ?? b['maxConcurrent']
      if (mc !== undefined && (typeof mc !== 'number' || !Number.isInteger(mc) || mc < 1)) {
        return fail(`步骤 ${key} 的 batch.max_concurrent 需为 ≥1 的整数`)
      }
      if (b['retry'] !== undefined && (typeof b['retry'] !== 'number' || !Number.isInteger(b['retry']) || b['retry'] < 0)) {
        return fail(`步骤 ${key} 的 batch.retry 需为 ≥0 的整数`)
      }
    }
    const title = sRaw['title']
    const when = sRaw['when']
    if (when !== undefined && !isExprList(when)) {
      return fail(`步骤 ${key} 的 when 需为字符串或字符串数组`)
    }
    const whenAny = sRaw['when_any']
    if (whenAny !== undefined && (!Array.isArray(whenAny) || whenAny.some((x) => typeof x !== 'string'))) {
      return fail(`步骤 ${key} 的 when_any 需为字符串数组`)
    }
    const after = sRaw['after']
    if (after !== undefined && (!Array.isArray(after) || after.some((x) => typeof x !== 'string'))) {
      return fail(`步骤 ${key} 的 after 需为字符串数组（步骤 key 列表）`)
    }
    if (sRaw['after_skipped'] !== undefined && sRaw['after_skipped'] !== 'continue') return fail(`步骤 ${key} 的 after_skipped 仅支持 continue`)
    steps.push({
      key,
      action,
      title: typeof title === 'string' ? title : key,
      inputs: inputs as Record<string, unknown>,
      params: (sRaw['params'] as Record<string, unknown> | undefined) ?? {},
      gate: sRaw['gate'] as TemplateStepDef['gate'],
      batch: normalizeBatch(sRaw['batch']),
      output: sRaw['output'] as TemplateStepDef['output'],
      when: when as TemplateStepDef['when'],
      when_any: whenAny as TemplateStepDef['when_any'],
      after: after as TemplateStepDef['after'],
      ...(sRaw['after_skipped'] === 'continue' ? { after_skipped: 'continue' as const } : {}),
    })
    order.set(key, steps.length - 1)
  }
  // 条件表达式静态校验：when/when_any/gate.when 引用的 input 键必须在 inputs 声明、
  // steps.x.count 与 after 引用的步骤必须存在且位于本步骤之前
  const checkStepRef = (s: TemplateStepDef, target: string, what: string): void => {
    if (!seenKeys.has(target)) return fail(`步骤 ${s.key} 的 ${what} 引用了不存在的步骤 ${target}`)
    if ((order.get(s.key) ?? 0) <= (order.get(target) ?? -1)) {
      return fail(`步骤 ${s.key} 的 ${what} 引用了非前置步骤 ${target}（仅可引用上游）`)
    }
  }
  for (const s of steps) {
    const exprs = [
      ...(Array.isArray(s.when) ? s.when : s.when ? [s.when] : []),
      ...(s.when_any ?? []),
      ...(s.gate?.when ? (Array.isArray(s.gate.when) ? s.gate.when : [s.gate.when]) : []),
    ]
    for (const rawExpr of exprs) {
      let op
      try {
        op = parseWhenExpr(rawExpr)
      } catch (err) {
        return fail(`步骤 ${s.key} 的条件表达式非法：${(err as Error).message}`)
      }
      const refs = whenRefs(op)
      if (refs.inputKey && !declaredInputs.has(refs.inputKey)) {
        return fail(`步骤 ${s.key} 的条件表达式「${rawExpr}」引用了未声明的输入 ${refs.inputKey}`)
      }
      if (refs.stepKey) checkStepRef(s, refs.stepKey, `条件表达式「${rawExpr}」`)
    }
    for (const target of s.after ?? []) {
      checkStepRef(s, target, 'after')
    }
  }
  // 引用前向校验：steps.x.xxx 必须指向前置步骤
  for (const s of steps) {
    for (const [k, v] of Object.entries(s.inputs)) {
      if (typeof v !== 'string') continue
      const m = /^steps\.([\w-]+)\.(asset|assets)$/.exec(v)
      if (m) {
        const target = m[1]!
        if (!seenKeys.has(target)) return fail(`步骤 ${s.key} 的 inputs.${k} 引用了不存在的步骤 ${target}`)
        if ((order.get(s.key) ?? 0) <= (order.get(target) ?? -1)) {
          return fail(`步骤 ${s.key} 的 inputs.${k} 引用了非前置步骤 ${target}（仅可引用上游）`)
        }
      }
    }
  }
  // 展示元数据（scene/next）：类型非法即报错；缺省 undefined（不参与引擎执行）
  const sceneRaw = raw['scene']
  if (sceneRaw !== undefined && (typeof sceneRaw !== 'string' || !sceneRaw)) {
    return fail('scene 需为非空字符串（produce/plan/operate）')
  }
  const nextRaw = raw['next']
  if (nextRaw !== undefined && (!Array.isArray(nextRaw) || nextRaw.some((x) => typeof x !== 'string' || !x))) {
    return fail('next 需为模板 key 字符串数组')
  }
  return {
    key,
    version: typeof raw.version === 'number' ? raw.version : 1,
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    genre: typeof raw.genre === 'string' ? raw.genre : 'other',
    scene: typeof sceneRaw === 'string' ? sceneRaw : undefined,
    next: Array.isArray(nextRaw) ? (nextRaw as string[]) : undefined,
    inputs: inputDefs,
    defaults: (raw.defaults as Record<string, unknown> | undefined) ?? {},
    steps,
  }
}

/** when/gate.when 字段形态检查：字符串或字符串数组 */
function isExprList(v: unknown): v is string | string[] {
  if (typeof v === 'string') return true
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * batch 归一化：YAML 惯用 snake_case（max_concurrent）→ 类型层 camelCase（maxConcurrent）。
 * 此前未归一化导致模板写的 max_concurrent 从未生效（恒走默认 2）——模板写法保持 spec §3.1 不变。
 */
function normalizeBatch(v: unknown): TemplateStepDef['batch'] {
  if (!v || typeof v !== 'object') return undefined
  const b = v as Record<string, unknown>
  return {
    field: String(b['field']),
    maxConcurrent: (b['max_concurrent'] ?? b['maxConcurrent']) as number | undefined,
    retry: b['retry'] as number | undefined,
  }
}

/** 读取并校验模板（进程内缓存；改文件后重启或 force 刷新） */
export function loadTemplate(key: string, force = false): Template {
  const hit = cache.get(key)
  if (hit && !force) return hit
  const file = templateFileOf(key)
  if (!file) throw new Error(`模板「${key}」不存在于 ${TEMPLATES_DIR}`)
  let raw: Record<string, unknown>
  try {
    raw = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`模板「${key}」YAML 解析失败: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || !raw) throw new Error(`模板「${key}」内容为空`)
  const tpl = validate(raw, key)
  cache.set(key, tpl)
  return tpl
}

/** prompt_tpl 引用体检：返回缺失的提示词文件（相对 PROMPTS_DIR 路径）列表 */
export function missingPromptsOf(tpl: Template): string[] {
  const missing = new Set<string>()
  for (const s of tpl.steps) {
    const p = s.params?.['prompt_tpl']
    if (typeof p !== 'string' || !p) continue
    try {
      if (!statSync(join(PROMPTS_DIR, p)).isFile()) missing.add(p)
    } catch {
      missing.add(p)
    }
  }
  return [...missing]
}

/** 模板文本校验结果（POST /templates/validate 与保存前检查共用） */
export interface TemplateValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  template?: Template
}

/**
 * 纯文本校验（不落盘）：YAML 语法/结构/引用错误 → errors；
 * prompt_tpl 文件缺失 → warnings（运行时才致命，编辑期放行）。
 */
export function validateTemplateText(text: string, expectKey?: string): TemplateValidation {
  const errors: string[] = []
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { ok: false, errors: [`YAML 解析失败: ${(err as Error).message}`], warnings }
  }
  if (typeof raw !== 'object' || !raw || Array.isArray(raw)) {
    return { ok: false, errors: ['内容为空或非对象'], warnings }
  }
  const rawObj = raw as Record<string, unknown>
  const keyInYaml = typeof rawObj['key'] === 'string' && rawObj['key'] ? (rawObj['key'] as string) : undefined
  const key = expectKey ?? keyInYaml
  if (!key) return { ok: false, errors: ['缺少 key 字段'], warnings }
  if (!/^[\w-]+$/.test(key)) {
    return { ok: false, errors: [`key「${key}」非法（仅字母/数字/下划线/中划线）`], warnings }
  }
  if (keyInYaml && keyInYaml !== key) {
    return { ok: false, errors: [`YAML 内 key「${keyInYaml}」与目标 key「${key}」不一致（key 不可改）`], warnings }
  }
  try {
    const tpl = validate(rawObj, key)
    for (const miss of missingPromptsOf(tpl)) warnings.push(`params.prompt_tpl 引用的提示词文件不存在: ${miss}`)
    for (const nk of tpl.next ?? []) {
      if (!templateFileOf(nk)) warnings.push(`next 引用的模板不存在: ${nk}`)
    }
    return { ok: true, errors, warnings, template: tpl }
  } catch (err) {
    return { ok: false, errors: [(err as Error).message], warnings }
  }
}

/** 原子保存模板（临时文件 → 校验 → rename 覆盖；失败保留原文件并清理临时件） */
export function saveTemplate(key: string, text: string): Template {
  if (!/^[\w-]+$/.test(key)) throw new Error(`模板 key「${key}」非法`)
  const res = validateTemplateText(text, key)
  if (!res.ok || !res.template) throw new Error(`模板「${key}」校验未通过：${res.errors.join('；')}`)
  const target = templateFileOf(key) ?? join(TEMPLATES_DIR, `${key}.yaml`)
  const tmp = join(TEMPLATES_DIR, `.${key}.tmp-${Date.now()}.yaml`)
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // 清理失败忽略
    }
    throw new Error(`模板「${key}」写入失败: ${(err as Error).message}`)
  }
  invalidateTemplate(key)
  log.info(`模板「${key}」已保存（${text.length} 字符）`)
  return res.template
}

/** 删除模板文件（不存在 → 抛错） */
export function deleteTemplate(key: string): void {
  const file = templateFileOf(key)
  if (!file) throw new Error(`模板「${key}」不存在`)
  unlinkSync(file)
  invalidateTemplate(key)
  log.info(`模板「${key}」已删除`)
}

/** 扫描模板目录（坏文件跳过并告警） */
export function listTemplates(): TemplateMeta[] {
  const metas: TemplateMeta[] = []
  for (const name of readdirSync(TEMPLATES_DIR)) {
    const m = /^([\w-]+)\.ya?ml$/.exec(name)
    if (!m) continue
    const key = m[1]!
    try {
      const tpl = loadTemplate(key)
      metas.push({
        key,
        name: tpl.name,
        description: tpl.description,
        genre: tpl.genre,
        version: tpl.version,
        stepCount: tpl.steps.length,
        updatedAt: statSync(join(TEMPLATES_DIR, name)).mtimeMs,
        promptsDirty: missingPromptsOf(tpl).length > 0,
        scene: tpl.scene,
        next: tpl.next,
      })
    } catch (err) {
      log.warn(`模板 ${name} 被跳过: ${(err as Error).message}`)
    }
  }
  return metas.sort((a, b) => a.key.localeCompare(b.key))
}

/** 清除缓存（模板文件热更新时用） */
export function invalidateTemplate(key?: string): void {
  if (key) cache.delete(key)
  else cache.clear()
}

export interface RunTemplateSource {
  templateKey: string
  templateSnapshot: string | null
}

/**
 * run 的模板来源（spec §3.5）：优先 template_snapshot（run 创建时固化），
 * 缺失/损坏 → 回退 loadTemplate 并告警（存量 run 兼容）。
 */
export function templateForRun(run: RunTemplateSource): Template {
  if (run.templateSnapshot) {
    try {
      const tpl = JSON.parse(run.templateSnapshot) as Template
      if (tpl && typeof tpl === 'object' && tpl.key === run.templateKey && Array.isArray(tpl.steps)) return tpl
      log.warn(`run「${run.templateKey}」模板快照损坏，回退文件加载`)
    } catch {
      log.warn(`run「${run.templateKey}」模板快照解析失败，回退文件加载`)
    }
  }
  return loadTemplate(run.templateKey)
}
