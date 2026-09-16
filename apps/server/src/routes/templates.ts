import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema'
import {
  avoidTemplateKeyConflict,
  deleteTemplate,
  listTemplates,
  loadTemplate,
  saveTemplate,
  templateFileOf,
  validateTemplateText,
} from '../pipeline/loader'
import {
  applyTemplateEdits,
  serializeTemplate,
  TemplateEditError,
  type TemplateEditsResult,
} from '../pipeline/template-edit'
import type { Template } from '../pipeline/types'
import { HttpError, h } from './helpers'

export const templatesRoutes = new Hono()

// GET /templates —— 模板清单（扫描 workspace/templates；promptsDirty=引用体检提示）
templatesRoutes.get('/templates', (c) => {
  return c.json({ items: listTemplates() })
})

// GET /templates/:key —— 完整模板 + 原文 YAML（编辑器消费）
templatesRoutes.get('/templates/:key', h((c) => {
  const key = c.req.param('key') ?? ''
  try {
    const template = loadTemplate(key)
    const file = templateFileOf(key)
    const yaml = file ? readFileSync(file, 'utf8') : ''
    return c.json({ template, yaml })
  } catch (err) {
    throw new HttpError(404, 'template_not_found', (err as Error).message)
  }
}))

// POST /templates/validate —— 纯校验不落盘 {yaml, key?} → {ok, errors, warnings}
templatesRoutes.post('/templates/validate', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const yaml = body['yaml']
  if (typeof yaml !== 'string' || !yaml.trim()) throw new HttpError(400, 'bad_yaml', 'yaml 需为非空字符串')
  const key = typeof body['key'] === 'string' && body['key'] ? body['key'] : undefined
  return c.json(validateTemplateText(yaml, key))
}))

// POST /templates —— 新建 {key, yaml}（同名已存在 → 409；更新走 PUT）
templatesRoutes.post('/templates', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const key = body['key']
  const yaml = body['yaml']
  if (typeof key !== 'string' || !/^[\w-]+$/.test(key)) {
    throw new HttpError(400, 'bad_key', 'key 需匹配 [A-Za-z0-9_-]+')
  }
  if (typeof yaml !== 'string' || !yaml.trim()) throw new HttpError(400, 'bad_yaml', 'yaml 需为非空字符串')
  if (templateFileOf(key)) {
    throw new HttpError(409, 'template_exists', `模板「${key}」已存在（更新请用 PUT /templates/${key}）`)
  }
  const res = validateTemplateText(yaml, key)
  if (!res.ok || !res.template) throw new HttpError(400, 'template_invalid', res.errors.join('；'))
  const template = saveTemplate(key, yaml)
  return c.json({ ok: true, template, warnings: res.warnings }, 201)
}))

// PUT /templates/:key —— 覆盖更新（key 不可改；校验通过才 rename 覆盖）
templatesRoutes.put('/templates/:key', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!templateFileOf(key)) throw new HttpError(404, 'template_not_found', `模板「${key}」不存在`)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const yaml = body['yaml']
  if (typeof yaml !== 'string' || !yaml.trim()) throw new HttpError(400, 'bad_yaml', 'yaml 需为非空字符串')
  const res = validateTemplateText(yaml, key)
  if (!res.ok || !res.template) throw new HttpError(400, 'template_invalid', res.errors.join('；'))
  const template = saveTemplate(key, yaml)
  return c.json({ ok: true, template, warnings: res.warnings })
}))

// DELETE /templates/:key —— 删除文件 + invalidate；被项目引用 → 409 列出项目名
templatesRoutes.delete('/templates/:key', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!templateFileOf(key)) throw new HttpError(404, 'template_not_found', `模板「${key}」不存在`)
  const refs = await db
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.templateKey, key), isNull(projects.deletedAt)))
  if (refs.length > 0) {
    return c.json(
      {
        error: {
          code: 'template_in_use',
          message: `模板「${key}」被 ${refs.length} 个项目引用，无法删除：${refs.map((r) => r.name).join('、')}`,
          projects: refs.map((r) => r.name),
        },
      },
      409,
    )
  }
  deleteTemplate(key)
  return c.json({ ok: true })
}))

/** [M23] edits 应用（TemplateEditError → 400 bad_edits；其余原样上抛） */
function applyEditsOr400(tpl: Template, edits: unknown): TemplateEditsResult {
  try {
    return applyTemplateEdits(tpl, edits)
  } catch (err) {
    if (err instanceof TemplateEditError) throw new HttpError(400, 'bad_edits', err.message)
    throw err
  }
}

// [M23] POST /templates/:key/edit-draft —— 受控编辑草案（edits 白名单应用 → 序列化 YAML；不落盘）
// body { edits } → { yaml, validation, editsApplied }；模板缺失 404；edits 非法 400 bad_edits
templatesRoutes.post('/templates/:key/edit-draft', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!templateFileOf(key)) throw new HttpError(404, 'template_not_found', `模板「${key}」不存在`)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const result = applyEditsOr400(loadTemplate(key), body['edits'])
  const yaml = serializeTemplate(result.template)
  return c.json({ yaml, validation: validateTemplateText(yaml, key), editsApplied: result.applied })
}))

// [M23] POST /templates/:key/edit-save —— edits 落盘为新模板（key 缺省 <原key>-edit；冲突自动后缀避让；
// 原文件零触碰）→ { templateKey, validation, editsApplied }；校验失败 400 template_invalid
templatesRoutes.post('/templates/:key/edit-save', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!templateFileOf(key)) throw new HttpError(404, 'template_not_found', `模板「${key}」不存在`)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const result = applyEditsOr400(loadTemplate(key), body['edits'])
  const newKeyRaw = body['newKey']
  if (newKeyRaw !== undefined && newKeyRaw !== null && typeof newKeyRaw !== 'string') {
    throw new HttpError(400, 'bad_key', 'newKey 需为字符串')
  }
  const proposed = typeof newKeyRaw === 'string' && newKeyRaw.trim() ? newKeyRaw.trim() : `${key}-edit`
  const baseKey = proposed.slice(0, 60)
  if (!/^[\w-]+$/.test(baseKey)) {
    throw new HttpError(400, 'bad_key', `key「${baseKey}」非法（仅字母/数字/下划线/中划线）`)
  }
  const finalKey = avoidTemplateKeyConflict(baseKey)
  if (!finalKey) throw new HttpError(409, 'key_conflict', `模板 key「${baseKey}」冲突无法避让`)
  const yaml = serializeTemplate(result.template, { key: finalKey })
  const validation = validateTemplateText(yaml, finalKey)
  if (!validation.ok || !validation.template) {
    throw new HttpError(400, 'template_invalid', validation.errors.join('；'))
  }
  saveTemplate(finalKey, yaml)
  return c.json({ templateKey: finalKey, validation, editsApplied: result.applied })
}))
