// [M28·批1a] 自 services/creation.ts 拆分：端口矩阵/环检测/源侧类型校验与编辑能力声明。
import { getImageAdapter, resolveEndpoint } from '../../adapters/provider'
import { COMPOSE_CAP, EDGE_PORTS, LLM_TEXT_CAP, REF_CAP, type EditCapability, type NodeSpec } from './spec'

/** 环检测：加入 from→to 后是否成环（等价于「沿既有边 to 可达 from」） */
export function wouldCreateCycle(edges: Array<{ from: number; to: number }>, from: number, to: number): boolean {
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    const list = adj.get(e.from) ?? []
    list.push(e.to)
    adj.set(e.from, list)
  }
  const seen = new Set<number>([to])
  const stack = [to]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === from) return true
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return false
}

/** [M17] 建边 from 侧信息（补源侧类型校验） */
export interface FromNodeInfo {
  id: number
  kind: string
  spec?: NodeSpec | null
  /** kind=asset：引用资产类型（image|video|audio|text|archive|...） */
  assetKind?: string | null
}

/** [M17] gen 节点预期产物类型（edit 并入 image；compose 产 video） */
export function productKindOf(spec: NodeSpec | null): string | null {
  if (!spec) return null
  switch (spec.genKind) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'compose':
      return 'video'
    case 'llm':
      return 'text' // [M18] 产物为 text 资产
    default:
      return null
  }
}

/** [M17] from 侧产物类型：asset→资产类型；gen→预期产物；text/entity→虚拟类型（供端口校验） */
export function sourceKindOf(from: FromNodeInfo): string | null {
  if (from.kind === 'asset') return from.assetKind ?? null
  if (from.kind === 'gen') return productKindOf(from.spec ?? null)
  if (from.kind === 'text') return 'text'
  if (from.kind === 'entity') return 'entity'
  return null
}

/** 端口规则矩阵校验 v3（建边用；[M18] +text 端口 / +llm 目标；返回错误文案或 null；from 提供时执行源侧类型校验） */
export function validateNewEdge(
  to: { id: number; kind: string; spec: NodeSpec | null },
  port: string,
  fromId: number,
  existing: Array<{ from: number; to: number; port: string }>,
  from?: FromNodeInfo,
): string | null {
  if (!(EDGE_PORTS as readonly string[]).includes(port)) {
    return `端口非法：${port}（可选 ${EDGE_PORTS.join('|')}）`
  }
  if (to.kind === 'run' || from?.kind === 'run') return '运行节点不参与连线'
  if (to.kind !== 'gen') return '仅生成节点可接收连线'
  if (!to.spec) return '目标节点 spec 损坏，无法连线'
  const spec = to.spec
  const src = from ? sourceKindOf(from) : null
  const srcLabel = src ?? '未知'
  const cur = existing.filter((e) => e.to === to.id && e.port === port)
  if (cur.some((e) => e.from === fromId)) return '该连线已存在'
  if (port === 'reference') {
    if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'llm') return '参考图端口仅图片/视频/LLM 生成节点支持'
    if (from && src !== 'image' && src !== 'entity') return `参考图来源需为图片素材/生成图/实体节点（当前类型：${srcLabel}）`
    const cap = REF_CAP[spec.genKind as 'image' | 'video' | 'llm']
    if (cur.length >= cap) return `${spec.genKind === 'llm' ? 'LLM' : spec.genKind === 'video' ? '视频' : '图片'}生成节点参考图上限 ${cap} 张`
    return null
  }
  if (port === 'first_frame' || port === 'last_frame') {
    const label = port === 'first_frame' ? '首帧' : '尾帧'
    if (spec.genKind !== 'video') return `${label}仅视频生成节点支持`
    if (from && src !== 'image') return `${label}来源需为图片素材或生成图（当前类型：${srcLabel}）`
    if (cur.length >= 1) return `${label}最多 1 条`
    return null
  }
  if (port === 'source') {
    if (!spec.edit) return '源图端口仅编辑节点支持（spec.edit）'
    if (from && src !== 'image') return `源图来源需为图片素材或生成图（当前类型：${srcLabel}）`
    if (cur.length >= 1) return '编辑源图最多 1 条'
    return null
  }
  if (port === 'prompt') {
    if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'audio' && spec.genKind !== 'llm') {
      return '提示词端口仅图片/视频/音频/LLM 生成节点支持'
    }
    // 仅 text 节点或 llm 节点（产物文本）（文本资产节点执行侧无文本注入通道，一并拒绝）
    const fromText = from != null && (from.kind === 'text' || (from.kind === 'gen' && productKindOf(from.spec ?? null) === 'text'))
    if (from && !fromText) return `提示词端口仅接受文本节点或 LLM 节点（当前类型：${srcLabel}）`
    if (cur.length >= 1) return '提示词最多 1 条'
    return null
  }
  if (port === 'text') {
    // [M18] text 端口：仅 llm 目标；源 = text / llm 节点（素材文本，非指令）
    if (spec.genKind !== 'llm') return '文本素材端口仅 LLM 节点支持'
    const fromText = from != null && (from.kind === 'text' || (from.kind === 'gen' && productKindOf(from.spec ?? null) === 'text'))
    if (from && !fromText) return `文本素材来源需为文本节点或 LLM 节点（当前类型：${srcLabel}）`
    if (cur.length >= LLM_TEXT_CAP) return `文本素材上限 ${LLM_TEXT_CAP} 段`
    return null
  }
  if (port === 'video') {
    if (spec.genKind !== 'compose') return '视频输入端口仅合成节点支持'
    if (from && src !== 'video') return `视频输入来源需为视频素材或生成视频（当前类型：${srcLabel}）`
    if (cur.length >= COMPOSE_CAP) return `合成节点视频输入上限 ${COMPOSE_CAP} 条`
    return null
  }
  // audio
  if (spec.genKind !== 'compose') return '音频输入端口仅合成节点支持'
  if (from && src !== 'audio') return `音频输入来源需为音频素材或生成音频（当前类型：${srcLabel}）`
  if (cur.length >= COMPOSE_CAP) return `合成节点音频输入上限 ${COMPOSE_CAP} 条`
  return null
}

/** 编辑能力声明快照：解析当前图像端点 → adapter.editing；不可用 → 全 false（不炸） */
export async function editCapabilityOf(provider?: string): Promise<EditCapability> {
  try {
    const endpoint = await resolveEndpoint('image', provider)
    const adapter = getImageAdapter(endpoint.providerKey)
    const ed = adapter.editing
    const inpaint = ed?.inpaint === true
    return { inpaint, erase: inpaint, outpaint: ed?.outpaint === true }
  } catch {
    return { inpaint: false, erase: false, outpaint: false }
  }
}
