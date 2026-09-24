/**
 * 模板编辑层（E3/E4 受控写面）：
 * - serializeTemplate：Template 对象 → YAML 文本（snake_case 还原，对齐 loader 解析规则逆向；
 *   parse ∘ stringify 往返等值由探针直测）；
 * - applyTemplateEdits：白名单 edits 纯应用（不改动入参；只产出新对象）+ 全量校验
 *   （key 存在 / after 引用存在且前置 / texts 键原值为 string / title 非空）；
 * - materializeAfter / addDep / removeDep：拖拽连线的边操作语义（缺省依赖物化 / 追加去重 /
 *   显式移除；前端编辑层镜像同规则——交互层先本地重绘，落盘统一经 edits 通道）。
 * 依赖方向：template-edit → types（纯函数，无 IO / 无 db / 无 env——探针直测）。
 */
import { stringify as stringifyYaml } from 'yaml'
import type { Template, TemplateStepDef } from './types'

/** edits 校验/应用错误（路由映射 400 bad_edits；message 面向用户） */
export class TemplateEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateEditError'
  }
}

/** 序列化选项（key 覆盖用于 edit-save 落新 key；缺省沿用原 key） */
export interface SerializeOptions {
  key?: string
}

/** Template → YAML 文本（键序对齐手写模板惯例；lineWidth=0 不折行） */
export function serializeTemplate(tpl: Template, opts?: SerializeOptions): string {
  const doc: Record<string, unknown> = {
    key: opts?.key ?? tpl.key,
    version: tpl.version,
    name: tpl.name,
  }
  if (tpl.description !== undefined) doc['description'] = tpl.description
  doc['genre'] = tpl.genre
  if (tpl.scene !== undefined) doc['scene'] = tpl.scene
  if (tpl.next !== undefined) doc['next'] = [...tpl.next]
  doc['inputs'] = tpl.inputs.map((d) => {
    const o: Record<string, unknown> = { key: d.key }
    if (d.label !== undefined) o['label'] = d.label
    o['kind'] = d.kind
    o['required'] = d.required
    if (d.accept !== undefined) o['accept'] = [...d.accept]
    if (d.default !== undefined) o['default'] = d.default
    return o
  })
  if (tpl.defaults !== undefined && Object.keys(tpl.defaults).length > 0) doc['defaults'] = tpl.defaults
  doc['steps'] = tpl.steps.map(serializeStep)
  return stringifyYaml(doc, { lineWidth: 0 })
}

/** 单步序列化（缺省字段省略；undefined 值绝不进入 YAML——库对 undefined 行为不可依赖） */
function serializeStep(s: TemplateStepDef): Record<string, unknown> {
  const o: Record<string, unknown> = { key: s.key, action: s.action, title: s.title }
  if (s.after !== undefined) o['after'] = [...s.after]
  if (s.when !== undefined) o['when'] = Array.isArray(s.when) ? [...s.when] : s.when
  if (s.when_any !== undefined) o['when_any'] = [...s.when_any]
  o['inputs'] = s.inputs
  if (s.params !== undefined && Object.keys(s.params).length > 0) o['params'] = s.params
  if (s.gate !== undefined) {
    const g: Record<string, unknown> = { mode: s.gate.mode, message: s.gate.message }
    if (s.gate.skip_label !== undefined) g['skip_label'] = s.gate.skip_label
    if (s.gate.when !== undefined) g['when'] = Array.isArray(s.gate.when) ? [...s.gate.when] : s.gate.when
    o['gate'] = g
  }
  if (s.batch !== undefined) {
    const b: Record<string, unknown> = { field: s.batch.field }
    if (s.batch.maxConcurrent !== undefined) b['max_concurrent'] = s.batch.maxConcurrent
    if (s.batch.retry !== undefined) b['retry'] = s.batch.retry
    o['batch'] = b
  }
  if (s.output !== undefined) o['output'] = { purpose: s.output.purpose }
  return o
}

/** edits.steps 单项（白名单字段；未出现的字段 = 不修改） */
export interface TemplateStepEdit {
  key: string
  /** null = 删除 after（回落「前一步」缺省语义）；数组 = 显式覆盖（须存在且为前置步骤） */
  after?: string[] | null
  title?: string
  /** inputs 顶层字符串字段覆盖（仅原值为 string 的键） */
  texts?: Record<string, string>
}

/** applyTemplateEdits 产物 */
export interface TemplateEditsResult {
  template: Template
  /** 实际改动的步骤数（edit-draft 端点 editsApplied 口径） */
  applied: number
}

/**
 * 白名单 edits 纯应用：逐项校验通过才返回（任一失败抛 TemplateEditError）。
 * - 不改动入参 tpl/edits（返回全新对象；未编辑步骤共享引用——只读语义安全）
 * - after 引用必须存在且为**前置**步骤（loader 校验语义「仅可引用上游」——数组序天然防环）
 * - texts 仅可覆盖 inputs 顶层原值为 string 的键
 */
export function applyTemplateEdits(tpl: Template, edits: unknown): TemplateEditsResult {
  if (!isPlainObject(edits)) throw new TemplateEditError('edits 需为对象')
  for (const k of Object.keys(edits)) {
    if (k !== 'steps') throw new TemplateEditError(`edits 含未知字段「${k}」`)
  }
  const stepsRaw = edits['steps']
  if (!Array.isArray(stepsRaw)) throw new TemplateEditError('edits.steps 需为数组')

  const index = new Map(tpl.steps.map((s, i) => [s.key, i]))
  const touched = new Map<string, TemplateStepDef>()
  for (const raw of stepsRaw as unknown[]) {
    if (!isPlainObject(raw)) throw new TemplateEditError('edits.steps 项需为对象')
    for (const k of Object.keys(raw)) {
      if (!['key', 'after', 'title', 'texts'].includes(k)) {
        throw new TemplateEditError(`步骤编辑含未知字段「${k}」`)
      }
    }
    const key = raw['key']
    if (typeof key !== 'string' || !key) throw new TemplateEditError('步骤编辑缺 key')
    const idx = index.get(key)
    if (idx === undefined) throw new TemplateEditError(`步骤「${key}」不存在于模板`)
    if (touched.has(key)) throw new TemplateEditError(`步骤「${key}」重复编辑`)
    const base = tpl.steps[idx]!
    let next = base
    let changed = false

    const after = raw['after']
    if (after === null) {
      next = { ...next }
      delete next.after
      changed = true
    } else if (after !== undefined) {
      if (!Array.isArray(after) || after.some((x) => typeof x !== 'string' || !x)) {
        throw new TemplateEditError(`步骤「${key}」的 after 需为步骤 key 字符串数组或 null`)
      }
      for (const ref of after as string[]) {
        const refIdx = index.get(ref)
        if (refIdx === undefined) throw new TemplateEditError(`步骤「${key}」的 after 引用了不存在的步骤「${ref}」`)
        if (refIdx >= idx) {
          throw new TemplateEditError(`步骤「${key}」的 after 引用非前置步骤「${ref}」（仅可引用上游）`)
        }
      }
      next = { ...next, after: [...(after as string[])] }
      changed = true
    }

    const title = raw['title']
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw new TemplateEditError(`步骤「${key}」的 title 需为非空字符串`)
      }
      next = { ...next, title }
      changed = true
    }

    const texts = raw['texts']
    if (texts !== undefined) {
      if (!isPlainObject(texts)) throw new TemplateEditError(`步骤「${key}」的 texts 需为对象`)
      for (const [fk, fv] of Object.entries(texts)) {
        if (typeof fv !== 'string') throw new TemplateEditError(`步骤「${key}」的 texts.${fk} 需为字符串`)
        if (!(fk in base.inputs)) throw new TemplateEditError(`步骤「${key}」的 texts.${fk} 不存在于 inputs`)
        if (typeof base.inputs[fk] !== 'string') {
          throw new TemplateEditError(`步骤「${key}」的 texts.${fk} 原值非字符串（仅可覆盖文本字段）`)
        }
      }
      next = { ...next, inputs: { ...next.inputs, ...(texts as Record<string, string>) } }
      changed = true
    }

    if (changed) touched.set(key, next)
  }
  if (touched.size === 0) return { template: tpl, applied: 0 }
  return { template: { ...tpl, steps: tpl.steps.map((s) => touched.get(s.key) ?? s) }, applied: touched.size }
}

// ---------- 拖拽连线边操作（交互层镜像同规则） ----------

/** 物化步骤 after：undefined（「前一步」语义）→ [上一步 key]（首步 → []）；显式 → 拷贝 */
export function materializeAfter(tpl: Template, stepKey: string): string[] {
  const idx = stepIndex(tpl, stepKey)
  if (tpl.steps[idx]!.after !== undefined) return [...tpl.steps[idx]!.after!]
  return idx > 0 ? [tpl.steps[idx - 1]!.key] : []
}

/** 加依赖（拖拽连线）：物化后追加（已存在 → 忽略）；fromKey 非前置 → 抛错 */
export function addDep(tpl: Template, toKey: string, fromKey: string): string[] {
  const toIdx = stepIndex(tpl, toKey)
  const fromIdx = stepIndex(tpl, fromKey)
  if (fromIdx >= toIdx) {
    throw new TemplateEditError(`仅支持前→后依赖：「${fromKey}」不是「${toKey}」的前置步骤`)
  }
  const list = materializeAfter(tpl, toKey)
  if (!list.includes(fromKey)) list.push(fromKey)
  return list
}

/** 删依赖（点选 sched 边删除）：物化后移除；保持显式（结果可为 []） */
export function removeDep(tpl: Template, toKey: string, fromKey: string): string[] {
  stepIndex(tpl, toKey)
  stepIndex(tpl, fromKey)
  return materializeAfter(tpl, toKey).filter((k) => k !== fromKey)
}

function stepIndex(tpl: Template, key: string): number {
  const idx = tpl.steps.findIndex((s) => s.key === key)
  if (idx < 0) throw new TemplateEditError(`步骤「${key}」不存在于模板`)
  return idx
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
