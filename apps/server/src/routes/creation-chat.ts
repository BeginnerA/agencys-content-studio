import { Hono, type Context } from 'hono'
import { ZodError } from 'zod'
import { CreationError } from '../services/creation-chat/contract'
import { createSession, refreshPreflight, sendCreationMessage } from '../services/creation-chat/planning'
import { addAttachment } from '../services/creation-chat/attachments'
import { cancelCreation, confirmCreation, retryCreation } from '../services/creation-chat/execution'
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
creationChatRoutes.post(`${path}/:id/messages`, route(async (c) => c.json(await sendCreationMessage(id(c), await body(c)))))
creationChatRoutes.post(`${path}/:id/preflight`, route(async (c) => c.json(await refreshPreflight(id(c)))))
creationChatRoutes.post(`${path}/:id/confirm`, route(async (c) => c.json(await confirmCreation(id(c), await body(c)), 202)))
creationChatRoutes.post(`${path}/:id/cancel`, route(async (c) => { await cancelCreation(id(c)); return c.json(await creationDetail(id(c))) }))
creationChatRoutes.post(`${path}/:id/retry`, route(async (c) => c.json(await retryCreation(id(c), await body(c)), 202)))
