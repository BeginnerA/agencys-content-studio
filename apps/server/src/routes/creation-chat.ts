import { Hono, type Context } from 'hono'
import { ZodError } from 'zod'
import { CreationError } from '../services/creation-chat/contract'
import { createSession, refreshPreflight, sendCreationMessage } from '../services/creation-chat/planning'
import { addAttachment, addAttachmentFromAsset } from '../services/creation-chat/attachments'
import { cancelCreation, confirmCreation, retryCreation } from '../services/creation-chat/execution'
import { deleteCreationSession } from '../services/creation-chat/session-delete'
import { creationDetail, listCreationSessions } from '../services/creation-chat/store'

export const creationChatRoutes = new Hono()
const path = '/creation-sessions'
const id = (c: Context) => {
  const value = Number(c.req.param('id'))
  if (!Number.isInteger(value) || value <= 0) throw new CreationError('bad_id', '会话编号非法')
  return value
}
const body = async (c: Context) => {
  const text = await c.req.text()
  if (text.length > 16000) throw new CreationError('too_large', '请求过长，最多 6000 字创作需求', 422)
  try { return JSON.parse(text) as unknown } catch { throw new CreationError('bad_json', '请求不是有效 JSON') }
}
function route(fn: (c: Context) => Promise<Response>) {
  return async (c: Context) => {
    try { return await fn(c) }
    catch (error) {
      if (error instanceof CreationError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
      if (error instanceof ZodError) return c.json({ error: { code: 'invalid_request', message: '请求字段不符合契约，请刷新并检查输入长度' } }, 422)
      return c.json({ error: { code: 'creation_failed', message: '创作请求未完成，请刷新核对状态；不会自动重复提交' } }, 503)
    }
  }
}
creationChatRoutes.get(path, route(async (c) => c.json({ items: await listCreationSessions() })))
creationChatRoutes.post(path, route(async (c) => c.json(await createSession(await body(c)), 201)))
creationChatRoutes.get(`${path}/:id`, route(async (c) => c.json(await creationDetail(id(c)))))
// [M31] 附件上传（multipart file+role）：落会话所属项目、核验类型/大小、记 attachment 消息；不触发规划、不计费。
creationChatRoutes.post(`${path}/:id/attachments`, route(async (c) => {
  const sessionId = id(c)
  const form = await c.req.formData().catch(() => { throw new CreationError('bad_form', '非 multipart/form-data 请求') })
  const fileVal = form.get('file')
  if (!(fileVal instanceof File) || fileVal.size === 0) throw new CreationError('no_file', '未收到参考文件')
  const roleVal = form.get('role')
  const buf = new Uint8Array(await fileVal.arrayBuffer())
  return c.json(await addAttachment(sessionId, { name: fileVal.name || `reference-${Date.now()}`, data: buf }, typeof roleVal === 'string' ? roleVal : undefined), 201)
}))
// [M31+] 从素材选取：存量资产登记为参考（跨项目自动复制进会话项目）；规则与上传一致，不触发规划、不计费。
creationChatRoutes.post(`${path}/:id/attachments/from-asset`, route(async (c) => {
  const sessionId = id(c)
  const req = (await body(c)) as { assetId?: unknown; role?: unknown }
  if (typeof req.assetId !== 'number') throw new CreationError('bad_asset', 'assetId 需为数字', 400)
  return c.json(await addAttachmentFromAsset(sessionId, req.assetId, typeof req.role === 'string' ? req.role : undefined), 201)
}))
creationChatRoutes.post(`${path}/:id/messages`, route(async (c) => c.json(await sendCreationMessage(id(c), await body(c)))))
creationChatRoutes.post(`${path}/:id/preflight`, route(async (c) => c.json(await refreshPreflight(id(c)))))
creationChatRoutes.post(`${path}/:id/confirm`, route(async (c) => c.json(await confirmCreation(id(c), await body(c)), 202)))
creationChatRoutes.post(`${path}/:id/cancel`, route(async (c) => { await cancelCreation(id(c)); return c.json(await creationDetail(id(c))) }))
creationChatRoutes.post(`${path}/:id/retry`, route(async (c) => c.json(await retryCreation(id(c), await body(c)), 202)))
// [M40+] 删除会话：未立项时连影子项目一并清除；已立项只删会话记录（项目保留），mode/reason 如实回传。
creationChatRoutes.delete(`${path}/:id`, route(async (c) => c.json(await deleteCreationSession(id(c)))))
