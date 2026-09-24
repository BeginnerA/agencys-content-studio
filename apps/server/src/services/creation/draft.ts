// 自 services/creation.ts 拆分：模板草案 v2（YAML 纯函数 + draft/template-try 两通道）+ 拓扑排序。
import { avoidTemplateKeyConflict, saveTemplate, validateTemplateText, type TemplateValidation } from '../../pipeline/loader'
import { createRunRow, InvalidRunInputError } from '../run-create'
import { buildCanvasDoc } from './doc'
import { isGenSpec, type CanvasDoc, type CanvasDocNode, type NodeSpec } from './spec'

/** 拓扑排序（gen 子图 Kahn；环兜底按 id 序追加——建边已防环，此为防务） */
export function topoSortGenNodeIds(genIds: number[], edges: Array<{ from: number; to: number }>): number[] {
  const gen = new Set(genIds)
  const indeg = new Map<number, number>(genIds.map((id) => [id, 0]))
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    if (!gen.has(e.from) || !gen.has(e.to)) continue
    const list = adj.get(e.from) ?? []
    list.push(e.to)
    adj.set(e.from, list)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const queue = genIds.filter((id) => (indeg.get(id) ?? 0) === 0)
  const out: number[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  for (const id of genIds) {
    if (!out.includes(id)) out.push(id) // 环残留（不应发生）
  }
  return out
}

// ---------- 模板草案 v2（literal + 主步骤 + lossy 清单） ----------

/** 画布 → 流水线模板草案 v2：text/asset 节点 → inputs；gen 节点→ literal 包装 + 主步骤；llm→ ai_text prompt_inline；compose→ ffmpeg_merge； 参考/首帧边（image 源）→ literal inputs；entity/run/末帧/编辑源/编辑/转场/BGM → lossy */
export async function buildTemplateDraft(
  canvasId: number,
  key?: string,
): Promise<{ yaml: string; validation: TemplateValidation; lossy: string[] } | null> {
  const doc = await buildCanvasDoc(canvasId)
  if (!doc) return null
  const draftKey = key?.trim() || `canvas-draft-${canvasId}`
  if (!/^[\w-]+$/.test(draftKey)) throw new Error(`key「${draftKey}」非法（仅字母/数字/下划线/中划线）`)
  const { yaml, lossy } = buildTemplateDraftYaml(doc, draftKey)
  return { yaml, validation: validateTemplateText(yaml, draftKey), lossy }
}

export interface TemplateDraftResult {
  yaml: string
  lossy: string[]
}

/** 纯函数：v2 YAML 文本 + lossy 清单（探针直接断言） */
export function buildTemplateDraftYaml(doc: CanvasDoc, key: string): TemplateDraftResult {
  const lossy: string[] = []
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const genSpecOf = (n: CanvasDocNode): NodeSpec | null => (n.kind === 'gen' && isGenSpec(n.spec) ? n.spec : null)
  const textOf = (n: CanvasDocNode): string | null => {
    if (n.kind !== 'text' || !n.spec || typeof n.spec !== 'object') return null
    const t = (n.spec as { text?: unknown }).text
    return typeof t === 'string' ? t : null
  }

  // 1) inputs 收集（text 节点 → text 输入；asset 节点 → files 输入）
  const inputsYaml: string[] = []
  const assetInputOf = new Map<number, string>() // asset nodeId → `a{id}`
  for (const n of doc.nodes) {
    if (n.kind === 'text') {
      inputsYaml.push(
        `  - { key: t${n.id}, kind: text, label: ${yamlScalar(n.title)}, default: ${yamlScalar(textOf(n) ?? '')}, required: false }`,
      )
    } else if (n.kind === 'asset' && n.assetId != null) {
      assetInputOf.set(n.id, `a${n.id}`)
      inputsYaml.push(`  - { key: a${n.id}, kind: files, label: ${yamlScalar(n.title)}, required: false }`)
    } else if (n.kind === 'entity') {
      lossy.push(`实体节点 #${n.id}（${n.title}）：模板引擎暂无参考图直通（写入注释）`)
    } else if (n.kind === 'run') {
      lossy.push(`运行节点 #${n.id}（${n.title}）：模板引擎不支持嵌套运行（写入注释）`)
    }
  }

  // 2) gen 节点拓扑序
  const genNodes = doc.nodes.filter((n) => genSpecOf(n) != null)
  const order = topoSortGenNodeIds(genNodes.map((n) => n.id), doc.edges)

  const lines: string[] = []
  lines.push(`# 由创作画布「${doc.canvas.name}」（canvas #${doc.canvas.id}）导出——模板 v2 草案`)
  lines.push('# 说明：literal 包装提示词为 shots/lines JSON；主步骤 ai_image/ai_video/tts/ai_text(prompt_inline)/ffmpeg_merge；参考/首帧边（图片源）映射 literal inputs；entity/run/末帧/编辑源/编辑/转场/BGM 写入 lossy。')
  lines.push(`key: ${key}`)
  lines.push('version: 1')
  lines.push(`name: ${yamlScalar(`${doc.canvas.name} 草案`)}`)
  lines.push('description: 从创作画布导出的 v2 草案')
  lines.push('genre: other')
  if (inputsYaml.length === 0) lines.push('inputs: []')
  else {
    lines.push('inputs:')
    lines.push(...inputsYaml)
  }

  if (order.length === 0) {
    lines.push('steps: []')
    return { yaml: `${lines.join('\n')}\n`, lossy }
  }

  lines.push('steps:')
  const finalStepOf = new Map<number, string>() // gen nodeId → 主步骤 key（供下游引用）

  for (const id of order) {
    const node = byId.get(id)!
    const spec = genSpecOf(node)!
    const incoming = doc.edges.filter((e) => e.to === id)

    // ---- llm → ai_text (prompt_inline) ----
    if (spec.genKind === 'llm') {
      const sk = `n${id}`
      finalStepOf.set(id, sk)
      const after = new Set<string>()
      const inputPairs: Array<[string, string]> = []
      let idx = 0
      for (const e of incoming) {
        if (e.port !== 'text' && e.port !== 'prompt') continue
        const up = byId.get(e.from)
        if (!up) continue
        if (up.kind === 'text') {
          inputPairs.push([`text${++idx}`, `input.t${up.id}`])
        } else if (up.kind === 'gen') {
          const fk = finalStepOf.get(up.id)
          if (fk) {
            inputPairs.push([`text${++idx}`, `steps.${fk}.asset`])
            after.add(fk)
          }
        }
      }
      const refEdges = incoming.filter((e) => e.port === 'reference')
      for (const e of refEdges) {
        const up = byId.get(e.from)
        if (up?.kind === 'gen') {
          const fk = finalStepOf.get(up.id)
          if (fk) after.add(fk)
        }
      }
      if (refEdges.length > 0) {
        lossy.push(`LLM 节点 #${id}（${node.title}）：${refEdges.length} 张参考图→ ai_text 不支持多模态输入（模板层降级，运行时需图生文替代）`)
      }
      lines.push(`  - key: ${sk}`)
      lines.push('    action: ai_text')
      lines.push(`    title: ${yamlScalar(node.title)}`)
      lines.push(`    after: [${Array.from(after).join(', ')}]`)
      if (inputPairs.length > 0) {
        lines.push('    inputs:')
        for (const [k, v] of inputPairs) lines.push(`      ${k}: ${v}`)
      } else {
        lines.push('    inputs: {}')
      }
      lines.push('    params:')
      lines.push(`      prompt_inline: ${yamlScalar(spec.prompt || '（画布节点未指定指令）')}`)
      lines.push('      output_purpose: creation_llm')
      lines.push('      output_format: markdown')
      if (spec.provider || spec.model) lines.push(`    # provider/model: ${spec.provider ?? '默认'} / ${spec.model ?? '默认'}`)
      continue
    }

    // ---- compose → ffmpeg_merge ----
    if (spec.genKind === 'compose') {
      const sk = `n${id}`
      finalStepOf.set(id, sk)
      const vidRefs: string[] = []
      const audRefs: string[] = []
      const after = new Set<string>()
      for (const e of incoming) {
        const up = byId.get(e.from)
        if (!up) continue
        if (e.port === 'video') {
          if (up.kind === 'gen') {
            const fk = finalStepOf.get(up.id)
            if (fk) {
              vidRefs.push(`steps.${fk}.asset`)
              after.add(fk)
            }
          } else if (up.kind === 'asset') {
            const ak = assetInputOf.get(up.id)
            if (ak) vidRefs.push(`input.${ak}`)
          }
        } else if (e.port === 'audio') {
          if (up.kind === 'gen') {
            const fk = finalStepOf.get(up.id)
            if (fk) {
              audRefs.push(`steps.${fk}.asset`)
              after.add(fk)
            }
          } else if (up.kind === 'asset') {
            const ak = assetInputOf.get(up.id)
            if (ak) audRefs.push(`input.${ak}`)
          }
        }
      }
      lines.push(`  - key: ${sk}`)
      lines.push('    action: ffmpeg_merge')
      lines.push(`    title: ${yamlScalar(node.title)}`)
      lines.push(`    after: [${Array.from(after).join(', ')}]`)
      if (vidRefs.length === 0 && audRefs.length === 0) {
        lossy.push(`合成节点 #${id}（${node.title}）：无视频/音频上游，运行时需手动提供 inputs`)
        lines.push('    inputs: {}')
      } else {
        lines.push('    inputs:')
        if (vidRefs.length > 0) {
          lines.push('      motion_clips:')
          for (const r of vidRefs) lines.push(`        - ${r}`)
        }
        if (audRefs.length > 0) {
          lines.push('      voices:')
          for (const r of audRefs) lines.push(`        - ${r}`)
        }
      }
      lines.push('    params:')
      if (spec.fps) lines.push(`      fps: ${spec.fps}`)
      if (spec.resolution) lines.push(`      resolution: ${yamlScalar(spec.resolution)}`)
      lines.push('      output_purpose: creation_compose')
      if (spec.transition) lossy.push(`合成节点 #${id}：转场 ${spec.transition}（模板 ffmpeg_merge 无 xfade 参数，运行时需手工滤镜）`)
      if (spec.bgmAssetId) lossy.push(`合成节点 #${id}：BGM asset#${spec.bgmAssetId}（模板无 BGM 专用字段，可手动追加至 voices）`)
      continue
    }

    // ---- image / video / audio → literal + 主步骤 ----
    const litKey = `n${id}_lit`
    const sk = `n${id}`
    finalStepOf.set(id, sk)
    let action: string
    let inputField: string
    let asKind: 'storyboard-single' | 'lines-single'
    let purpose: string
    if (spec.genKind === 'audio') {
      action = 'tts'
      inputField = 'lines'
      asKind = 'lines-single'
      purpose = 'voice'
    } else if (spec.genKind === 'video') {
      action = 'ai_video'
      inputField = 'shots'
      asKind = 'storyboard-single'
      purpose = 'creation_video'
    } else {
      action = 'ai_image'
      inputField = 'shots'
      asKind = 'storyboard-single'
      purpose = 'creation_image'
    }
    const promptEdge = incoming.find((e) => e.port === 'prompt')
    const promptFrom = promptEdge ? byId.get(promptEdge.from) : null
    const after = new Set<string>()
    let textRef: string | null = null
    if (promptFrom?.kind === 'text') {
      textRef = `input.t${promptFrom.id}`
    } else if (promptFrom?.kind === 'gen') {
      const fk = finalStepOf.get(promptFrom.id)
      if (fk) {
        textRef = `steps.${fk}.asset`
        after.add(fk)
      }
    }
    for (const e of incoming) {
      if (e === promptEdge) continue
      const up = byId.get(e.from)
      if (up?.kind === 'gen') {
        const fk = finalStepOf.get(up.id)
        if (fk) after.add(fk)
      }
    }

    // 参考边保真：reference（image 源）→ inputs.refs；first_frame（image 源，video 专用，取首条）→ inputs.first_frame；
    // 末帧/编辑源/非图片源/多帧溢出 → unmapped（lossy 汇总）；literal 侧 as=storyboard-single 直通 shots[0] 保真字段
    const refExprOf = (up: CanvasDocNode): string | null => {
      if (up.kind === 'asset') {
        const ak = assetInputOf.get(up.id)
        return ak && up.asset?.kind === 'image' ? `input.${ak}` : null
      }
      if (genSpecOf(up)?.genKind !== 'image') return null
      const fk = finalStepOf.get(up.id)
      return fk ? `steps.${fk}.asset` : null
    }
    const refExprs: string[] = []
    let ffExpr: string | null = null
    let unmappedRefs = 0
    for (const e of incoming) {
      if (e.port !== 'reference' && e.port !== 'first_frame' && e.port !== 'last_frame' && e.port !== 'source') continue
      const up = byId.get(e.from)
      const mapped =
        up && ((e.port === 'reference' && asKind === 'storyboard-single') || (e.port === 'first_frame' && action === 'ai_video'))
          ? refExprOf(up)
          : null
      if (!mapped) {
        unmappedRefs++
        continue
      }
      if (e.port === 'reference') refExprs.push(mapped)
      else if (ffExpr == null) ffExpr = mapped
      else unmappedRefs++
    }

    // lit 步骤
    lines.push(`  - key: ${litKey}`)
    lines.push('    action: literal')
    lines.push(`    title: ${yamlScalar(`${node.title} 文本`)}`)
    lines.push(`    after: [${Array.from(after).join(', ')}]`)
    if (textRef || refExprs.length > 0 || ffExpr != null) {
      lines.push('    inputs:')
      if (textRef) lines.push(`      text: ${textRef}`)
      if (refExprs.length > 0) {
        lines.push('      refs:')
        for (const r of refExprs) lines.push(`        - ${r}`)
      }
      if (ffExpr != null) lines.push(`      first_frame: ${ffExpr}`)
      lines.push('    params:')
      lines.push(`      as: ${asKind}`)
      if (!textRef) lines.push(`      payload: ${yamlScalar(spec.prompt || '（画布节点未指定提示词）')}`)
    } else {
      lines.push('    inputs: {}')
      lines.push('    params:')
      lines.push(`      as: ${asKind}`)
      lines.push(`      payload: ${yamlScalar(spec.prompt || '（画布节点未指定提示词）')}`)
    }
    // 主步骤
    lines.push(`  - key: ${sk}`)
    lines.push(`    action: ${action}`)
    lines.push(`    title: ${yamlScalar(node.title)}`)
    lines.push(`    after: [${litKey}${after.size > 0 ? `, ${Array.from(after).join(', ')}` : ''}]`)
    lines.push('    inputs:')
    lines.push(`      ${inputField}: steps.${litKey}.asset`)
    lines.push('    params:')
    if (spec.size) lines.push(`      size: ${yamlScalar(spec.size)}`)
    if (spec.duration) lines.push(`      duration: ${spec.duration}`)
    if (spec.resolution) lines.push(`      resolution: ${yamlScalar(spec.resolution)}`)
    if (spec.aspectRatio) lines.push(`      aspect_ratio: ${yamlScalar(spec.aspectRatio)}`)
    if (spec.voice) lines.push(`      voice: ${yamlScalar(spec.voice)}`)
    if (spec.speed) lines.push(`      speed: ${spec.speed}`)
    lines.push(`      output_purpose: ${purpose}`)
    if (spec.genKind === 'image') lines.push(`      use_style_preset: ${spec.useStylePreset !== false ? 'true' : 'false'}`)
    if (spec.provider || spec.model) lines.push(`    # provider/model: ${spec.provider ?? '默认'} / ${spec.model ?? '默认'}`)
    if (unmappedRefs > 0) {
      lossy.push(`${action} 节点 #${id}（${node.title}）：${unmappedRefs} 条连线未映射（末帧/编辑源/非图片源）→ 运行时需手工补充`)
    }
    if (spec.edit) {
      lossy.push(`${action} 节点 #${id}：编辑模式（${spec.edit.mode}）→ 模板层不支持，运行时需替换为普通生成或后处理`)
    }
  }

  return { yaml: `${lines.join('\n')}\n`, lossy }
}

// ---------- template-try（draft v2 → 保存模板 → 建 run） ----------

/** template-try 失败错误（路由转 400；detail 可选附送 validation.errors 清单） */
export class TemplateTryError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message)
    this.name = 'TemplateTryError'
  }
}

export interface TemplateTryResult {
  templateKey: string
  runId: number
  lossy: string[]
  input: Record<string, unknown>
}

/** 从中文名称提取可安全的模板 key 基名（非字母数字下划线中划线 → '-'；默认 'canvas'） */
function sanitizeTplKey(name: string): string {
  const s = name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s || 'canvas'
}

/**
 * 画布→模板→一键试跑：
 * - nodeIds 给定：保留该集 + 上游闭包（包含资产/文本/实体），边只保留两端均在保留集内；
 * - draft v2 同同构建 YAML + lossy；validate 失败 → TemplateTryError('validation_failed')；
 * - key 缺省 `<canvas.name>-try`（sanitize）；冲突自动后缀 -2/-3/…（最多 30 层）；
 * - inputs 预填：text 型不传（default 自会回填）；files 型传 asset 节点 assetId；
 * - createRunRow（queued）→ {templateKey, runId, lossy, input}。
 */
export async function tryRunTemplate(
  canvasId: number,
  p: { nodeIds?: number[]; key?: string } = {},
): Promise<TemplateTryResult | null> {
  const fullDoc = await buildCanvasDoc(canvasId)
  if (!fullDoc) return null

  // 子图过滤：nodeIds + 上游闭包
  let doc = fullDoc
  if (p.nodeIds && p.nodeIds.length > 0) {
    const byId = new Map(fullDoc.nodes.map((n) => [n.id, n]))
    const incomingByTo = new Map<number, Array<{ from: number; to: number; port: string; id: number }>>()
    for (const e of fullDoc.edges) {
      const arr = incomingByTo.get(e.to) ?? []
      arr.push(e)
      incomingByTo.set(e.to, arr)
    }
    const keep = new Set<number>()
    const stack: number[] = []
    for (const id of p.nodeIds) if (byId.has(id)) stack.push(id)
    while (stack.length) {
      const id = stack.pop()!
      if (keep.has(id)) continue
      keep.add(id)
      for (const e of incomingByTo.get(id) ?? []) if (!keep.has(e.from)) stack.push(e.from)
    }
    doc = {
      ...fullDoc,
      nodes: fullDoc.nodes.filter((n) => keep.has(n.id)),
      edges: fullDoc.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    }
  }

  const baseKey = (p.key?.trim() || `${sanitizeTplKey(fullDoc.canvas.name)}-try`).slice(0, 60)
  if (!/^[\w-]+$/.test(baseKey)) throw new TemplateTryError('bad_key', `key「${baseKey}」非法（仅字母/数字/下划线/中划线）`)
  const finalKey = avoidTemplateKeyConflict(baseKey)
  if (!finalKey) throw new TemplateTryError('key_conflict', `模板 key「${baseKey}」冲突无法避让`)

  const { yaml, lossy } = buildTemplateDraftYaml(doc, finalKey)
  const validation = validateTemplateText(yaml, finalKey)
  if (!validation.ok) {
    throw new TemplateTryError('validation_failed', validation.errors.join('；'), validation.errors)
  }
  try {
    saveTemplate(finalKey, yaml)
  } catch (err) {
    throw new TemplateTryError('save_failed', (err as Error).message)
  }

  // inputs 预填（files ← asset 节点 assetId；text 默认从模板 default 回填）
  const input: Record<string, unknown> = {}
  for (const n of doc.nodes) {
    if (n.kind === 'asset' && n.assetId != null) input[`a${n.id}`] = [n.assetId]
  }

  try {
    const run = await createRunRow({
      projectId: doc.canvas.projectId,
      templateKey: finalKey,
      input,
    })
    return { templateKey: finalKey, runId: run.id, lossy, input }
  } catch (err) {
    if (err instanceof InvalidRunInputError) throw new TemplateTryError('bad_input', err.message)
    throw new TemplateTryError('run_create_failed', (err as Error).message)
  }
}

function yamlScalar(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function yamlComment(s: string): string {
  return s.replace(/\s*\n\s*/g, ' / ').trim()
}
