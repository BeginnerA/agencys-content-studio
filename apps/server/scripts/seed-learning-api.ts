/// <reference types="node" />
/**
 * 画布学习实例 seed · HTTP 工具 + 领域操作 + 共享类型。
 *
 * 从 seed-learning-canvases.ts 拆分而来（行为零变更切分）：
 * 纯 HTTP API 驱动（服务需已启动，默认 http://127.0.0.1:3001），
 * 供 seed 主流程与画布构建器（basic / drama）共同复用。
 */
import type { BlobBytes } from './node-body-types'

const BASE = process.env.CSTUDIO_BASE_URL ?? 'http://127.0.0.1:3001'
const API = `${BASE}/api/v1`
const PROJECT_NAME = '画布学习实例'

export function log(msg: string): void {
  console.log(`[seed] ${msg}`)
}

// ---------- HTTP 工具 ----------

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* 保留原始文本用于报错 */
  }
  if (!res.ok) {
    const detail = data?.error?.message ?? text.slice(0, 300)
    throw new Error(`${method} ${path} → ${res.status}：${detail}`)
  }
  return data
}

export async function uploadMedia(projectId: number, filename: string, bytes: Buffer | Uint8Array, mime: string, purpose: string): Promise<number> {
  const fd = new FormData()
  fd.set('purpose', purpose)
  fd.set('file', new Blob([bytes as unknown as BlobBytes], { type: mime }), filename)
  const res = await fetch(`${API}/projects/${projectId}/imports`, { method: 'POST', body: fd })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* ignore */
  }
  if (!res.ok || !data?.items?.[0]) {
    throw new Error(`上传素材 ${filename} 失败：${res.status} ${data?.error?.message ?? text.slice(0, 200)}`)
  }
  return data.items[0].id as number
}

export async function uploadEntityRef(entityId: number, filename: string, bytes: Buffer, mime: string): Promise<void> {
  const fd = new FormData()
  fd.set('file', new Blob([bytes as unknown as BlobBytes], { type: mime }), filename)
  const res = await fetch(`${API}/entities/${entityId}/ref-images`, { method: 'POST', body: fd })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`上传实体参考图 ${filename} 失败：${res.status} ${text.slice(0, 200)}`)
  }
}

// ---------- 领域操作 ----------

export async function ensureProject(): Promise<number> {
  const list = await api('GET', '/projects?status=active')
  const found = (list.items as any[]).find((p) => p.name === PROJECT_NAME)
  if (found) {
    log(`复用项目 #${found.id}（${PROJECT_NAME}）`)
    return found.id as number
  }
  const r = await api('POST', '/projects', {
    name: PROJECT_NAME,
    genre: 'other',
    template_key: 'mengbao-episode',
    brief: '内置 9 个复杂画布示例（含短剧实战、三级与季级四级合成链），用于学习创作画布的全部核心能力：节点类型 / 端口连线 / 编辑 / 多级合成 / 锁版 / 分组嵌套 / 快照。可直接把玩、运行与改造。',
    tags: ['学习', '画布示例'],
  })
  log(`已创建项目 #${r.project.id}（${PROJECT_NAME}）`)
  return r.project.id as number
}

export async function ensureEntity(projectId: number, kind: string, name: string, extra: Record<string, unknown>): Promise<number> {
  const list = await api('GET', `/entities?project_id=${projectId}&kind=${kind}`)
  const found = (list.items as any[]).find((e) => e.name === name)
  if (found) return found.id as number
  const r = await api('POST', '/entities', { kind, name, project_id: projectId, ...extra })
  log(`  已创建实体【${kind}】${name} #${r.entity.id}`)
  return r.entity.id as number
}

export async function ensureCanvas(projectId: number, name: string): Promise<{ id: number; needFill: boolean }> {
  const list = await api('GET', `/projects/${projectId}/canvases`)
  const found = (list.items as any[]).find((c) => c.name === name)
  if (found) {
    const doc = await api('GET', `/canvases/${found.id}`)
    return { id: found.id as number, needFill: (doc.nodes as any[]).length === 0 }
  }
  const r = await api('POST', `/projects/${projectId}/canvases`, { name })
  return { id: r.canvas.id as number, needFill: true }
}

export interface NodeIds {
  [key: string]: number
}

export async function addText(cid: number, x: number, y: number, title: string, text: string): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'text', spec: { text }, x, y, title })
  return r.node.id as number
}

export async function addGen(cid: number, x: number, y: number, title: string, spec: Record<string, unknown>): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'gen', spec, x, y, title })
  return r.node.id as number
}

export async function addAssetNode(cid: number, x: number, y: number, title: string, assetId: number): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'asset', assetId, x, y, title })
  return r.node.id as number
}

export async function addEntityNode(cid: number, x: number, y: number, title: string, entityId: number): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'entity', entityId, x, y, title })
  return r.node.id as number
}

export async function link(cid: number, from: number, to: number, port: string): Promise<void> {
  await api('POST', `/canvases/${cid}/edges`, { from, to, port })
}

export async function setSeq(nodeId: number, seq: number): Promise<void> {
  await api('PATCH', `/nodes/${nodeId}`, { seq })
}

export async function group(cid: number, title: string, color: string, nodeIds?: number[], groupIds?: number[]): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/groups`, { title, color, nodeIds, groupIds })
  return r.group.id as number
}

export async function setViewport(cid: number, zoom: number): Promise<void> {
  await api('PATCH', `/canvases/${cid}`, { viewport: { x: 0, y: 0, zoom } })
}

export async function snapshot(cid: number, label: string): Promise<void> {
  await api('POST', `/canvases/${cid}/snapshots`, { label })
}

// ---------- 共享类型 ----------

export interface Assets {
  cafeImg: number
  duskImg: number
  cameraImg: number
  bgmWav: number
  srt: number
  /** 蒙版占位图（08 编辑链 inpaint 用） */
  maskImg: number
}

export interface Entities {
  xiaoyang: number
  cafeScene: number
  ale: number
  duskStreet: number
  /** 09 季级实战新增：学徒小宇 */
  xiaoyu: number
}

export { BASE, API, PROJECT_NAME }
