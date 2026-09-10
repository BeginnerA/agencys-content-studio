import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { TEMPLATES_DIR } from '../env'
import { createLogger } from '../logger'
import type { Template, TemplateInputDef, TemplateMeta, TemplateStepDef } from './types'
import { parseWhenExpr, whenRefs } from './refs'

const log = createLogger('loader')

/** M2 允许的 action 集合（registry 同步维护；loader 用它做加载期校验） */
export const KNOWN_ACTIONS = [
  'manual_ingest',
  'ai_text',
  'ai_image',
  'ffmpeg_merge',
  'ai_video',
  'tts',
  'subtitle',
] as const

const cache = new Map<string, Template>()

function fileFor(key: string): string | null {
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
      if (!['text', 'files', 'int', 'bool'].includes(String(kind))) {
        return fail(`输入 ${ik} 的 kind「${kind}」非法（支持 text/files/int/bool）`)
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
      if (g['when'] !== undefined && !isExprList(g['when'])) {
        return fail(`步骤 ${key} 的 gate.when 需为字符串或字符串数组`)
      }
    }
    if (sRaw['batch']) {
      const b = sRaw['batch'] as Record<string, unknown>
      if (typeof b.field !== 'string' || !b.field) return fail(`步骤 ${key} 的 batch 缺 field`)
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
    steps.push({
      key,
      action,
      title: typeof title === 'string' ? title : key,
      inputs: inputs as Record<string, unknown>,
      params: (sRaw['params'] as Record<string, unknown> | undefined) ?? {},
      gate: sRaw['gate'] as TemplateStepDef['gate'],
      batch: sRaw['batch'] as TemplateStepDef['batch'],
      output: sRaw['output'] as TemplateStepDef['output'],
      when: when as TemplateStepDef['when'],
      when_any: whenAny as TemplateStepDef['when_any'],
      after: after as TemplateStepDef['after'],
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
  return {
    key,
    version: typeof raw.version === 'number' ? raw.version : 1,
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    genre: typeof raw.genre === 'string' ? raw.genre : 'other',
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

/** 读取并校验模板（进程内缓存；改文件后重启或 force 刷新） */
export function loadTemplate(key: string, force = false): Template {
  const hit = cache.get(key)
  if (hit && !force) return hit
  const file = fileFor(key)
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
