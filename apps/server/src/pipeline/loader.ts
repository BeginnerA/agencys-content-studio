import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { TEMPLATES_DIR } from '../env'
import { createLogger } from '../logger'
import type { Template, TemplateMeta, TemplateStepDef } from './types'

const log = createLogger('loader')

/** M1 允许的 action 集合（registry 同步维护；loader 用它做加载期校验） */
export const KNOWN_ACTIONS = [
  'manual_ingest',
  'ai_text',
  'ai_image',
  'ffmpeg_merge',
  'ai_video',
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
    }
    if (sRaw['batch']) {
      const b = sRaw['batch'] as Record<string, unknown>
      if (typeof b.field !== 'string' || !b.field) return fail(`步骤 ${key} 的 batch 缺 field`)
    }
    const title = sRaw['title']
    steps.push({
      key,
      action,
      title: typeof title === 'string' ? title : key,
      inputs: inputs as Record<string, unknown>,
      params: (sRaw['params'] as Record<string, unknown> | undefined) ?? {},
      gate: sRaw['gate'] as TemplateStepDef['gate'],
      batch: sRaw['batch'] as TemplateStepDef['batch'],
      output: sRaw['output'] as TemplateStepDef['output'],
    })
    order.set(key, steps.length - 1)
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
    inputs: Array.isArray(raw.inputs) ? (raw.inputs as Template['inputs']) : [],
    defaults: (raw.defaults as Record<string, unknown> | undefined) ?? {},
    steps,
  }
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
