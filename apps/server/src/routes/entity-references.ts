/**
 * 实体参考图分层登记端点。
 *
 * 把分层登记服务（entity_references 表 + 派生同步）暴露为 REST，供前端管理面板与探针消费：
 * 逐镜取用预览是纯读（不落库、不触发派生同步）；能力解析失败已在服务层 notes 留痕，端点原样返回。
 *
 * 端点清单：
 *   GET    /entities/:id/references          — 分层清单（含停用行）+ 实体快照（states / refAssetIds 供状态下拉与旧扁平数据判定）
 *   POST   /entities/:id/references          — 新增分层登记（201 返回该行；同实体同资产重复登记 409）
 *   PATCH  /entity-references/:id            — 局部更新（enabled/role/stateKey/viewKey/note，缺省字段保持原值）
 *   DELETE /entity-references/:id            — 删除该行
 *   POST   /entities/:id/references/backfill — 历史扁平参考固化为基准分层行（幂等，返回 { added }）
 *   GET    /entities/:id/selection-preview   — 给定 scene/episode/text 上下文的逐镜取用预览 { selected, fallbacks, dropped }
 *   GET    /image-caps                       — 图像模型参考图能力解析（provider/model 查询参数，无配置时 supportsRefs=false 保守返回）
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  addEntityRef,
  backfillEntityRefs,
  describeEntityRefHost,
  EntityRefError,
  listEntityRefs,
  patchEntityRef,
  previewEntitySelection,
  removeEntityRef,
} from '../services/entity-references'
import { resolveImageCaps } from '../services/image-caps'
import { REF_ROLES } from '../services/ref-selection'
import { h, HttpError, idParam } from './helpers'

export const entityReferencesRoutes = new Hono()

/** 分层登记域错误状态 → 错误码（服务层只用这三档；其余状态按兜底处理） */
const REF_ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  409: 'conflict',
}

/** 分层登记域错误 → HttpError 状态直通（与工作台错误桥接同款）；其余异常原样抛出交统一兜底 */
async function throughRefErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof EntityRefError) throw new HttpError(err.status, REF_ERROR_CODES[err.status] ?? 'bad_request', err.message)
    throw err
  }
}

/** 可选文本字段：缺省/null → null（无值）；非字符串 → 400。PATCH 侧先判键是否出现，键出现才写入补丁（区分「不传=不变」「显式 null=清空」） */
function textOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new HttpError(400, 'bad_field_type', '该字段需为字符串或 null')
  return v
}

/** 整数查询参数：缺省 → undefined；非整数（含非数字串）→ 400 */
function intQuery(c: Context, name: string): number | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new HttpError(400, `bad_${name}`, `${name} 需为整数，got: ${raw}`)
  return n
}

// ─── GET /entities/:id/references —— 分层清单 + 实体快照 ─────────────────────

entityReferencesRoutes.get('/entities/:id/references', h(async (c) => {
  const entityId = idParam(c)

  // 实体快照由服务层只读函数提供（states 供状态下拉、refAssetIds 供旧扁平参考判定；实体缺失 404）
  const entity = await throughRefErrors(() => describeEntityRefHost(entityId))
  const refs = await throughRefErrors(() => listEntityRefs(entityId))
  return c.json({ refs, entity })
}))

// ─── POST /entities/:id/references —— 新增分层登记 ───────────────────────────

entityReferencesRoutes.post('/entities/:id/references', h(async (c) => {
  const entityId = idParam(c)

  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })

  const role = body['role']
  if (typeof role !== 'string' || !role.trim()) {
    throw new HttpError(400, 'bad_role', `role 需为 ${REF_ROLES.join('|')} 之一`)
  }
  const assetId = body['assetId']
  if (!Number.isInteger(assetId) || assetId <= 0) {
    throw new HttpError(400, 'bad_asset_id', 'assetId 需为正整数')
  }

  const ref = await throughRefErrors(() =>
    addEntityRef({
      entityId,
      assetId,
      role: role.trim(),
      stateKey: textOrNull(body['stateKey']),
      viewKey: textOrNull(body['viewKey']),
      note: textOrNull(body['note']),
    }),
  )
  return c.json(ref, 201)
}))

// ─── PATCH /entity-references/:id —— 局部更新分层登记 ────────────────────────

entityReferencesRoutes.patch('/entity-references/:id', h(async (c) => {
  const refId = idParam(c)

  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })

  const patch: { enabled?: boolean; role?: string; stateKey?: string | null; viewKey?: string | null; note?: string | null } = {}
  if (body['enabled'] !== undefined) {
    if (typeof body['enabled'] !== 'boolean') throw new HttpError(400, 'bad_enabled', 'enabled 需为布尔值')
    patch.enabled = body['enabled']
  }
  if (body['role'] !== undefined) {
    if (typeof body['role'] !== 'string' || !body['role'].trim()) {
      throw new HttpError(400, 'bad_role', `role 需为 ${REF_ROLES.join('|')} 之一`)
    }
    patch.role = body['role'].trim()
  }
  // 未出现的键不更新（服务层按 undefined 保持原值）；显式 null 表示清空该列
  if (body['stateKey'] !== undefined) patch.stateKey = textOrNull(body['stateKey'])
  if (body['viewKey'] !== undefined) patch.viewKey = textOrNull(body['viewKey'])
  if (body['note'] !== undefined) patch.note = textOrNull(body['note'])

  const ref = await throughRefErrors(() => patchEntityRef(refId, patch))
  return c.json(ref)
}))

// ─── DELETE /entity-references/:id —— 删除分层登记 ───────────────────────────

entityReferencesRoutes.delete('/entity-references/:id', h(async (c) => {
  await throughRefErrors(() => removeEntityRef(idParam(c)))
  return c.json({ ok: true })
}))

// ─── POST /entities/:id/references/backfill —— 历史扁平参考回填 ──────────────

entityReferencesRoutes.post('/entities/:id/references/backfill', h(async (c) => {
  const result = await throughRefErrors(() => backfillEntityRefs(idParam(c)))
  return c.json(result)
}))

// ─── GET /entities/:id/selection-preview —— 逐镜取用预览（纯读） ─────────────

entityReferencesRoutes.get('/entities/:id/selection-preview', h(async (c) => {
  const entityId = idParam(c)
  const scene = intQuery(c, 'scene')
  const episode = intQuery(c, 'episode')
  const text = c.req.query('text') ?? ''

  const preview = await throughRefErrors(() => previewEntitySelection(entityId, { scene, episode, text }))
  return c.json(preview)
}))

// ─── GET /image-caps —— 图像模型参考图能力解析 ───────────────────────────────

entityReferencesRoutes.get('/image-caps', h(async (c) => {
  const caps = await resolveImageCaps(c.req.query('provider'), c.req.query('model'))
  return c.json(caps)
}))
