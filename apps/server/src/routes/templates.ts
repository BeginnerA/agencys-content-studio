import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema'
import {
  deleteTemplate,
  listTemplates,
  loadTemplate,
  saveTemplate,
  templateFileOf,
  validateTemplateText,
} from '../pipeline/loader'
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
