import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { PROMPTS_DIR } from '../env'
import { h, HttpError } from './helpers'
import {
  getRolePersona,
  listRoleConfigs,
  setRolePersona,
  ROLE_CARDS,
  getRole,
} from '../services/creation-chat/agent/roles'

export const rolesRoutes = new Hono()

/** 递归收集目录下 .md 文件的相对路径（POSIX 斜杠） */
function walkMd(dir: string, base = ''): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkMd(abs, rel))
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(rel)
  }
  return out
}

// GET /roles —— 列出所有注册角色及其当前 personaFile 配置
rolesRoutes.get('/roles', h(async (c) => {
  const items = await listRoleConfigs()
  return c.json({ items })
}))

// GET /roles/:key/persona —— 获取指定角色的当前 personaFile（数据库覆盖优先，回落代码默认）
rolesRoutes.get('/roles/:key/persona', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!getRole(key)) throw new HttpError(404, 'role_not_found', `未知角色 key：${key}`)
  const personaFile = await getRolePersona(key)
  return c.json({ roleKey: key, personaFile })
}))

// PATCH /roles/:key —— 更新角色 personaFile 覆盖
rolesRoutes.patch('/roles/:key', h(async (c) => {
  const key = c.req.param('key') ?? ''
  if (!getRole(key)) throw new HttpError(404, 'role_not_found', `未知角色 key：${key}`)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const personaFile = body['personaFile']
  if (typeof personaFile !== 'string' || !personaFile.trim()) {
    throw new HttpError(400, 'bad_persona_file', 'personaFile 需为非空字符串')
  }
  await setRolePersona(key, personaFile.trim())
  return c.json({ ok: true, roleKey: key, personaFile: personaFile.trim() })
}))

// GET /persona-files —— 列出 PROMPTS_DIR 内所有 .md 文件（供前端下拉选择）
rolesRoutes.get('/persona-files', h((c) => {
  const rolesDir = join(PROMPTS_DIR, 'roles')
  const files = walkMd(rolesDir, 'roles')
  // 同时包含根目录下的 .md 文件（不限定 roles/ 子目录）
  const rootFiles = walkMd(PROMPTS_DIR).filter((f) => !f.startsWith('roles/'))
  return c.json({ items: [...files, ...rootFiles].sort() })
}))

// GET /roles/defaults —— 返回代码注册表中的默认 personaFile（供前端对比"已覆盖/默认"）
rolesRoutes.get('/roles/defaults', h((c) => {
  const defaults = ROLE_CARDS.map((card) => ({
    roleKey: card.key,
    name: card.name,
    defaultPersonaFile: card.personaFile,
  }))
  return c.json({ items: defaults })
}))
