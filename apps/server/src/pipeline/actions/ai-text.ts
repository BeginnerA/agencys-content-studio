import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { genTasks, type GenTask } from '../../db/schema'
import { emitStudioEvent } from '../../services/events'
import { loadPromptTemplate, chatCompleteDetailed, resolveLlmEndpoint, type ChatMessage } from '../../services/llm'
import { isJsonTextFormat, readTextAsset, writeTextAsset } from '../../services/storage'
import { assetInput, safeRecordExecSnapshot, type ExecInputSpec } from '../../services/provenance'
import { recordLlmUsage } from '../../services/usage'
import { ContinuityError } from '../../services/continuity/contract'
import { executeContinuityText } from '../../services/continuity/invocation'
import { loadTargetPack } from '../../services/continuity/run-binding'
import { isContinuityPurpose } from '../../services/continuity/reserved'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import { runCancelled } from '../cancel'
import type { StepResult } from '../types'
import { validateTextOutput } from './text-output'
import { RunCancelledError } from '../types'

/**
 * ai_text：LLM 文本生成（spec §5.3）。
 * params.prompt_tpl → 提示词模板；inputs 中资产内容/文本注入；
 * output_format=storyboard-json/lines-json/characters-json/set-json/event-json/graph-json/plan-json/monetization-json
 * 时走 validateTextOutput 契约校验；
 * def.batch 存在→ aiTextBatch（按 JSON 列表逐项生成）；params.max_input_chars → 超长注入截断。
 * M70 连续性闸门：启用 run（with_continuity=true）仅允许唯一目标步（continuity_role=episode_script）
 * 经冻结承接包路径调用模型；batch 步一律拒绝；非目标步骤保持原 ctx.settings.llm 链不变。
 */
export async function aiText(ctx: StepContext): Promise<StepResult> {
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const enabled = runInput['with_continuity'] === true
  const role = ((ctx.def.params ?? {}) as Record<string, unknown>)['continuity_role']
  if (ctx.def.batch) {
    // batch 步不得承接承接包（创建期已拦，此处执行期兜底 fail-closed，先于 batch 字段解析）
    if (enabled) throw new ContinuityError('continuity_unsupported', 400)
    return aiTextBatch(ctx)
  }
  if (enabled && role === 'episode_script') return continuityAiText(ctx, runInput)
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = params['prompt_tpl']
  // prompt_inline 与 prompt_tpl 二选一必填（画布 llm 节点映射 → 直接内联指令，无需提示词文件）
  const inlinePrompt = params['prompt_inline']
  const hasTpl = typeof tplFile === 'string' && tplFile.length > 0
  const hasInline = typeof inlinePrompt === 'string' && inlinePrompt.trim().length > 0
  if (!hasTpl && !hasInline) throw new Error('params.prompt_tpl 或 params.prompt_inline 至少其一非空')
  const maxInputChars =
    typeof params['max_input_chars'] === 'number' && (params['max_input_chars'] as number) > 0
      ? Math.floor(params['max_input_chars'] as number)
      : 0
  const outputPurpose = typeof params['output_purpose'] === 'string' ? params['output_purpose'] : 'text'
  const outputFormat = typeof params['output_format'] === 'string' ? params['output_format'] : 'markdown'

  const templateText = hasTpl ? loadPromptTemplate(tplFile as string) : (inlinePrompt as string).trim()
  const sections: string[] = []
  // 冻结本步实际消费的输入资产（文本携版本指针）
  const execInputs: ExecInputSpec[] = []
  for (const [k, v] of Object.entries(ctx.input)) {
    if (k.startsWith('_')) continue // _review 等内部键不注入
    if (k === 'continuity_context') continue // M70 槽位：普通路径永不注入（启用 run 的非目标步按原路且不携包）
    const ids = asAssetIds(v)
    if (ids && ids.length > 0) {
      const rows = await ctx.assetsOf(ids)
      for (const a of rows) {
        if (a.purpose && isContinuityPurpose(a.purpose)) {
          // 保留产物不得伪装普通参考（M70 refs 通用归属检查同口径）
          throw new ContinuityError('continuity_unsupported', 400)
        }
        if (a.kind === 'text') {
          const content = await readTextAsset(a.id)
          sections.push(`--- ${k} / ${a.name} ---\n${clipContent(content, maxInputChars)}`)
          execInputs.push(await assetInput('text', a.id))
        } else {
          sections.push(`--- ${k} / ${a.name}（${a.kind} 资产：文本模型无法读取，路径 ${a.relPath ?? '?'}）---`)
          execInputs.push(await assetInput('text', a.id, { used: false, skipReason: `${a.kind} 非文本` }))
        }
      }
    } else if (typeof v === 'string') {
      sections.push(`--- ${k} ---\n${v}`)
    } else if (v !== undefined && v !== null) {
      sections.push(`--- ${k} ---\n${JSON.stringify(v, null, 2)}`)
    }
  }
  let userPrompt = templateText
  if (sections.length > 0) {
    userPrompt += `\n\n===== 输入资料 =====\n${sections.join('\n\n')}`
  }
  const review = (ctx.input['_review'] as { note?: string } | undefined)?.note
  if (review) {
    userPrompt += `\n\n===== 人工修改意见（必须逐条落实） =====\n${review}`
    ctx.log('检测到驳回修改意见，已注入本次生成')
  }

  const ep = await resolveLlmEndpoint()
  ctx.log(`调用 LLM：${ep.model}（${ep.baseUrl}）…`)
  const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
  // 默认 12000（deepseek 推理模型 reasoning 占预算）；分镜 JSON 输出长，固定 64000 兜底——
  // 实测 deepseek-flash 生成 20 镜分镜：reasoning 18-19K + 正文 5-6K tokens，24000 上限会在 JSON 中途
  // finish_reason=length 截断；64000 为其可用上限，生成自然收尾
  const maxTokens =
    outputFormat === 'storyboard-json'
      ? 64000
      : typeof llmCfg['max_tokens'] === 'number'
        ? llmCfg['max_tokens']
        : 12000
  // 推理模型长思维链 + 长 JSON 输出：默认 10 分钟超时（2 分钟在 64000 预算下会被 abort）；
  // params.timeout_ms → settings.llm.timeout_ms（模板 defaults / 项目设置）→ 600000 依次取
  const timeoutMs =
    typeof params['timeout_ms'] === 'number'
      ? params['timeout_ms']
      : typeof llmCfg['timeout_ms'] === 'number'
        ? llmCfg['timeout_ms']
        : 600_000
  const res = await chatCompleteDetailed(
    [
      { role: 'system', content: '你是内容创作流水线的执行引擎，严格按用户提供的提示词模板产出。只输出任务要求的内容本体，不输出任何解释性前言或后记。' },
      { role: 'user', content: userPrompt },
    ],
    ep,
    {
      temperature: typeof llmCfg['temperature'] === 'number' ? llmCfg['temperature'] : 0.8,
      maxTokens,
      timeoutMs,
    },
  )
  // 用量记录（LLM 单次调用 → tokens_in/out 两行；失败不影响流水线）
  await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id,
    provider: res.provider, model: res.model, usage: res.usage })
  const content = res.content
  ctx.log(`LLM 返回 ${content.length} 字符`)

  // 输出契约校验（storyboard-json / lines-json / characters-json；返回条目数供日志）
  let items: number
  try {
    items = validateTextOutput(content, outputFormat)
  } catch (err) {
    // 截断诊断：finish_reason=length（推理模型 reasoning 挤占预算）时，报错聚焦「预算不足」而非表层 JSON 语法
    if (res.finishReason === 'length') {
      throw new Error(
        `LLM 输出被 max_tokens=${maxTokens} 截断（输出 ${content.length} 字符；reasoning 可能占满预算，分镜过长需调大预算）：${(err as Error).message}`,
      )
    }
    throw err
  }
  if (outputFormat === 'storyboard-json') ctx.log(`分镜解析通过：${items} 个镜头`)
  if (outputFormat === 'lines-json') ctx.log(`台词解析通过：${items} 句`)
  if (outputFormat === 'characters-json') ctx.log(`角色档案解析通过：${items} 名`)
  if (outputFormat === 'set-json') ctx.log(`场景道具档案解析通过：${items} 项`)

  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : undefined
  const name = nameTpl ? interpolate(nameTpl, runInput) : defaultName(outputFormat, outputPurpose)
  const tag = tagOfFormat(outputFormat)
  const asset = await writeTextAsset(ctx.run.projectId, {
    name,
    content,
    purpose: outputPurpose,
    format: isJsonTextFormat(outputFormat) ? outputFormat : undefined,
    stepId: ctx.step.id,
    runId: ctx.run.id,
    prompt: userPrompt.slice(0, 4000),
    params: { model: ep.model, output_format: outputFormat, chars: content.length },
    tags: [tag],
  })
  ctx.log(`已写资产 asset#${asset.id} → ${asset.relPath}`)
  // 记录执行真实输入快照（旁路，失败不影响流水线）
  await safeRecordExecSnapshot({
    projectId: ctx.run.projectId,
    execKind: 'pipeline_step',
    runId: ctx.run.id,
    stepId: ctx.step.id,
    templateKey: ctx.run.templateKey,
    model: ep.model,
    inputs: execInputs,
  })
  return { assetIds: [asset.id] }
}

/**
 * 连续性目标路径（M70 Task6）：冻结承接包渲染注入一次（不裁剪、槽位跳过、保留 purpose 拒绝），
 * 完整 messages 交 executeContinuityText——调用证据/费用预检/产物与用量记录全部归 Task5 状态机。
 * 口径（勿改）：本路径走 continuity llmOptions 链（targets.ts 兜底 temperature 0 / maxTokens 24000 /
 * timeoutMs 600000，模板 defaults.llm 可覆盖 temperature/max_tokens）；非目标步骤保持原 ctx.settings.llm
 * 链不变。两链不同源是 Task4 configHash 既定语义所迫——改用 ctx 链会令冻结包预览哈希全量 409。
 */
async function continuityAiText(ctx: StepContext, runInput: Record<string, unknown>): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = params['prompt_tpl']
  const inlinePrompt = params['prompt_inline']
  const hasTpl = typeof tplFile === 'string' && tplFile.length > 0
  const hasInline = typeof inlinePrompt === 'string' && inlinePrompt.trim().length > 0
  if (!hasTpl && !hasInline) throw new Error('params.prompt_tpl 或 params.prompt_inline 至少其一非空')
  const outputPurpose = typeof params['output_purpose'] === 'string' ? params['output_purpose'] : 'text'
  const outputFormat = typeof params['output_format'] === 'string' ? params['output_format'] : 'markdown'
  const templateText = hasTpl ? loadPromptTemplate(tplFile as string) : (inlinePrompt as string).trim()
  // 两阶段绑定第二步（步骤级 CAS）+ 批准句柄全字段校验；行缺失/步骤不符在此 fail-closed，不派发模型
  const { doc } = await loadTargetPack(ctx)
  const sections: string[] = []
  for (const [k, v] of Object.entries(ctx.input)) {
    if (k.startsWith('_')) continue
    if (k === 'continuity_context') continue // 槽位由冻结包渲染替代，绝不二次注入
    const ids = asAssetIds(v)
    if (ids && ids.length > 0) {
      const rows = await ctx.assetsOf(ids)
      for (const a of rows) {
        if (a.purpose && isContinuityPurpose(a.purpose)) throw new ContinuityError('continuity_unsupported', 400)
        if (a.kind === 'text') {
          sections.push(`--- ${k} / ${a.name} ---\n${await readTextAsset(a.id)}`)
        } else {
          sections.push(`--- ${k} / ${a.name}（${a.kind} 资产：文本模型无法读取，路径 ${a.relPath ?? '?'}）---`)
        }
      }
    } else if (typeof v === 'string') {
      sections.push(`--- ${k} ---\n${v}`)
    } else if (v !== undefined && v !== null) {
      sections.push(`--- ${k} ---\n${JSON.stringify(v, null, 2)}`)
    }
  }
  let userPrompt = templateText
  if (sections.length > 0) userPrompt += `\n\n===== 输入资料 =====\n${sections.join('\n\n')}`
  const review = (ctx.input['_review'] as { note?: string } | undefined)?.note
  if (review) {
    userPrompt += `\n\n===== 人工修改意见（必须逐条落实） =====\n${review}`
    ctx.log('检测到驳回修改意见，已注入本次生成')
  }
  userPrompt += `\n\n===== 剧情连续性台账（已批准承接包） =====\n${doc.rendered}`
  ctx.log(`连续性目标路径：承接包 ${doc.entries.length} 条基线已注入（rendered ${doc.rendered.length} 字符）`)
  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : undefined
  const name = nameTpl ? interpolate(nameTpl, runInput) : defaultName(outputFormat, outputPurpose)
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是内容创作流水线的执行引擎，严格按用户提供的提示词模板产出。只输出任务要求的内容本体，不输出任何解释性前言或后记。' },
    { role: 'user', content: userPrompt },
  ]
  return executeContinuityText(ctx, messages, { name, purpose: outputPurpose, format: outputFormat })
}

/**
 * 输出契约校验：实现原样抽至 ./text-output（M70 连续性调用复用同一入口），行为零变更；
 * 此处 re-export 保持既有引用路径（services/asset-content 与各探针）零改动。
 */
export { validateTextOutput }

function asAssetIds(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null
  const ids = v.map(Number)
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null
}

function defaultName(format: string, purpose: string): string {
  if (format === 'storyboard-json') return 'storyboard.json'
  if (format === 'lines-json') return 'lines.json'
  if (format === 'characters-json') return 'characters.json'
  if (format === 'set-json') return 'sets.json'
  if (format === 'event-json') return 'events.json'
  if (format === 'graph-json') return 'event-graph.json'
  if (format === 'plan-json') return 'plan.json'
  if (format === 'monetization-json') return 'monetization.json'
  return `${purpose}.md`
}

/** 输出格式 → 资产 tag（单调用与 batch 共用口径） */
function tagOfFormat(format: string): string {
  if (format === 'storyboard-json') return 'storyboard'
  if (format === 'lines-json') return 'lines'
  if (format === 'characters-json') return 'characters'
  if (format === 'set-json') return 'sets'
  if (format === 'event-json') return 'events'
  if (format === 'graph-json') return 'graph'
  if (format === 'plan-json') return 'plan'
  if (format === 'monetization-json') return 'monetization'
  return 'script'
}

/** 注入截断（max_input_chars>0）：头半 + 省略标记 + 尾半（采样覆盖文首文末格式差异） */
function clipContent(content: string, maxChars: number): string {
  if (maxChars <= 0 || content.length <= maxChars) return content
  const half = Math.floor(maxChars / 2)
  return `${content.slice(0, half)}\n…（中间省略，全文 ${content.length} 字符）\n${content.slice(-half)}`
}

/**
 * ai_text batch：按 JSON 列表逐项生成（对齐 ai_image batch 范式）。
 * batch.field → 输入资产（首个为列表 JSON）→ 数组逐项：一条 gen_task（kind=text）→
 * 幂等（params.itemId）/ 并发池 / 失败重试 / 取消感知 → 产物按 items 顺序聚合。
 * 逐项提示词 = 模板 + 静态输入 sections（跳过 field 键）+ item JSON + item.asset_id 资产全文。
 */
async function aiTextBatch(ctx: StepContext): Promise<StepResult> {
  const batch = ctx.def.batch!
  const field = batch.field
  const concurrency = Math.max(1, batch.maxConcurrent ?? 2)
  const maxRetry = Math.max(0, batch.retry ?? 1)
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = params['prompt_tpl']
  // prompt_inline 与 prompt_tpl 二选一必填（batch 同步支持，保证行为一致）
  const inlinePrompt = params['prompt_inline']
  const hasTpl = typeof tplFile === 'string' && tplFile.length > 0
  const hasInline = typeof inlinePrompt === 'string' && inlinePrompt.trim().length > 0
  if (!hasTpl && !hasInline) throw new Error('params.prompt_tpl 或 params.prompt_inline 至少其一非空')
  const outputPurpose = typeof params['output_purpose'] === 'string' ? params['output_purpose'] : 'text'
  const outputFormat = typeof params['output_format'] === 'string' ? params['output_format'] : 'markdown'
  const itemKey = typeof params['item_key'] === 'string' ? params['item_key'] : null
  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : undefined
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>

  // 列表定位：field 键首个资产（产物顺序契约：manifest/plan 排第一）
  const ids = ctx.assetIdsOf(field)
  if (ids.length === 0) throw new Error(`inputs.${field} 无列表资产`)
  let obj: unknown
  try {
    obj = JSON.parse(await ctx.readText(ids[0]!))
  } catch (err) {
    throw new Error(`列表 JSON 解析失败（inputs.${field}）: ${(err as Error).message}`)
  }
  const items = extractBatchItems(obj, field)
  if (items.length === 0) throw new Error(`列表内容缺 ${field} 数组（或为空）`)
  const itemIds = items.map((item, i) => batchItemId(item, i, itemKey))
  const seen = new Set<string>()
  for (const id of itemIds) {
    if (seen.has(id)) throw new Error(`batch item 标识重复：${id}（请检查 item_key 或数据中的 id/index/ep）`)
    seen.add(id)
  }

  const templateText = hasTpl ? loadPromptTemplate(tplFile as string) : (inlinePrompt as string).trim()
  const staticSections = await buildStaticSections(ctx, field)
  const epHint = await resolveLlmEndpoint().catch(() => null)

  // 既有任务（幂等续跑）：params.itemId → task
  const existing = await db
    .select()
    .from(genTasks)
    .where(and(eq(genTasks.runId, ctx.run.id), eq(genTasks.stepId, ctx.step.id)))
  const taskByItem = new Map<string, GenTask>()
  for (const t of existing) {
    try {
      const p = JSON.parse(t.params) as { itemId?: unknown }
      if (p.itemId !== undefined) taskByItem.set(String(p.itemId), t)
    } catch {
      // 参数损坏任务：跳过（不参与队列也不视为成功）
    }
  }

  // 入队 / 同步：逐项构造 prompt（快照）+ name
  // batch 实际输入快照：列表资产（source）+ 逐项章节文本资产（携版本指针）
  const batchInputs: ExecInputSpec[] = [await assetInput('source', ids[0]!)]
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const itemId = itemIds[i]!
    let itemAssetSection: string | undefined
    const assetIdRaw = item['asset_id']
    if (typeof assetIdRaw === 'number' && Number.isInteger(assetIdRaw) && assetIdRaw > 0) {
      const rows = await ctx.assetsOf([assetIdRaw])
      const a = rows[0]
      if (a && a.kind === 'text') {
        itemAssetSection = `--- 章节原文 / ${a.name} ---\n${await ctx.readText(a.id)}`
        batchInputs.push(await assetInput('text', a.id, { shotId: itemId }))
      }
    }
    const prompt = buildItemPrompt({
      templateText,
      staticSections,
      itemJson: JSON.stringify(item, null, 2),
      itemAssetSection,
    })
    const name = nameTpl ? interpolate(nameTpl, { ...runInput, ...item }) : defaultName(outputFormat, outputPurpose)
    const paramsJson = JSON.stringify({
      itemId,
      itemKey,
      output_format: outputFormat,
      output_purpose: outputPurpose,
      name,
    })
    const existingTask = taskByItem.get(itemId)
    if (!existingTask) {
      const t = nowMs()
      const row = (
        await db
          .insert(genTasks)
          .values({
            projectId: ctx.run.projectId,
            runId: ctx.run.id,
            stepId: ctx.step.id,
            kind: 'text',
            provider: epHint?.providerKey ?? null,
            model: epHint?.model ?? null,
            prompt,
            params: paramsJson,
            status: 'pending',
            attempts: 0,
            createdAt: t,
            updatedAt: t,
          })
          .returning()
      )[0]!
      taskByItem.set(itemId, row)
    } else if (existingTask.status !== 'succeeded' && existingTask.status !== 'cancelled') {
      // 未成功任务同步最新 prompt/参数；failed 且有变化 → 归零重排队；succeeded 保持产物溯源不动
      const changed = existingTask.prompt !== prompt || existingTask.params !== paramsJson
      if (changed) {
        const requeue = existingTask.status === 'failed'
        await db
          .update(genTasks)
          .set({
            prompt,
            params: paramsJson,
            ...(requeue ? { status: 'pending', attempts: 0, errorMsg: null } : {}),
            updatedAt: nowMs(),
          })
          .where(eq(genTasks.id, existingTask.id))
        existingTask.prompt = prompt
        existingTask.params = paramsJson
        if (requeue) {
          existingTask.status = 'pending'
          existingTask.attempts = 0
          existingTask.errorMsg = null
        }
      }
    }
  }

  // 执行队列：非 succeeded 且有重试余量；cancelled 不参与
  const queue = itemIds
    .map((id) => taskByItem.get(id)!)
    .filter((t) => {
      if (t.status === 'succeeded' || t.status === 'cancelled') return false
      if (t.status === 'failed' && t.attempts > maxRetry) return false
      return true
    })
  const doneCount = items.length - queue.length
  if (doneCount > 0) ctx.log(`跳过已有成功产物的 ${doneCount} 项`)
  if (queue.length === 0) ctx.log('全部项已有成功产物，无新生成')

  const failures: Array<{ itemId: string; error: string }> = []
  await runPool(queue, concurrency, async (task) => {
    const fail = await runOneTextTask(ctx, task, { maxRetry })
    if (fail) failures.push(fail)
  })
  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => `item ${f.itemId}: ${f.error}`)
      .join('；')
    throw new Error(`文本生成失败 ${failures.length} 项（可修正后断点续跑/重试任务）：${sample}`)
  }

  // 产物按 items 顺序聚合
  const assetIds = itemIds
    .map((id) => taskByItem.get(id)!.resultAssetId)
    .filter((id): id is number => typeof id === 'number')
  if (assetIds.length !== items.length) {
    throw new Error(`产物与列表数不符（${assetIds.length}/${items.length}），请重试`)
  }
  ctx.log(`按列表生成完成：${assetIds.length} 份 → ${assetIds.join(', ')}`)
  // 记录 batch 执行真实输入快照（旁路，失败不影响流水线）
  await safeRecordExecSnapshot({
    projectId: ctx.run.projectId,
    execKind: 'pipeline_step',
    runId: ctx.run.id,
    stepId: ctx.step.id,
    templateKey: ctx.run.templateKey,
    model: epHint?.model ?? null,
    inputs: batchInputs,
  })
  return { assetIds }
}

/** 单任务执行：attempts 续增，达上限后不再重试 */
async function runOneTextTask(
  ctx: StepContext,
  task: GenTask,
  cfg: { maxRetry: number },
): Promise<{ itemId: string; error: string } | null> {
  const parsed = JSON.parse(task.params) as {
    itemId?: unknown
    output_format?: string
    output_purpose?: string
    name?: string
  }
  const itemId = String(parsed.itemId ?? '?')
  const outputFormat = parsed.output_format ?? 'markdown'
  const outputPurpose = parsed.output_purpose ?? 'text'
  const p = (ctx.def.params ?? {}) as Record<string, unknown>
  const maxAttempts = cfg.maxRetry + 1
  let attempts = task.attempts
  for (;;) {
    if (await runCancelled(ctx.run.id)) {
      await db
        .update(genTasks)
        .set({ status: 'cancelled', errorMsg: 'run cancelled', updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      throw new RunCancelledError()
    }
    attempts += 1
    await db
      .update(genTasks)
      .set({ status: 'processing', attempts, errorMsg: null, updatedAt: nowMs() })
      .where(eq(genTasks.id, task.id))
    emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'processing' })
    try {
      const ep = await resolveLlmEndpoint()
      const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
      const maxTokens =
        outputFormat === 'storyboard-json'
          ? 64000
          : typeof llmCfg['max_tokens'] === 'number'
            ? (llmCfg['max_tokens'] as number)
            : 12000
      const timeoutMs =
        typeof p['timeout_ms'] === 'number'
          ? (p['timeout_ms'] as number)
          : typeof llmCfg['timeout_ms'] === 'number'
            ? (llmCfg['timeout_ms'] as number)
            : 600_000
      const res = await chatCompleteDetailed(
        [
          {
            role: 'system',
            content: '你是内容创作流水线的执行引擎，严格按用户提供的提示词模板产出。只输出任务要求的内容本体，不输出任何解释性前言或后记。',
          },
          { role: 'user', content: task.prompt ?? '' },
        ],
        ep,
        {
          temperature: typeof llmCfg['temperature'] === 'number' ? (llmCfg['temperature'] as number) : 0.8,
          maxTokens,
          timeoutMs,
        },
      )
      await recordLlmUsage({
        projectId: ctx.run.projectId,
        runId: ctx.run.id,
        stepId: ctx.step.id,
        provider: res.provider,
        model: res.model,
        usage: res.usage,
      })
      try {
        validateTextOutput(res.content, outputFormat)
      } catch (err) {
        if (res.finishReason === 'length') {
          throw new Error(
            `LLM 输出被 max_tokens=${maxTokens} 截断（输出 ${res.content.length} 字符）：${(err as Error).message}`,
          )
        }
        throw err
      }
      const asset = await writeTextAsset(ctx.run.projectId, {
        name: parsed.name ?? defaultName(outputFormat, outputPurpose),
        content: res.content,
        purpose: outputPurpose,
        format: isJsonTextFormat(outputFormat) ? outputFormat : undefined,
        stepId: ctx.step.id,
        taskId: task.id,
        runId: ctx.run.id,
        prompt: (task.prompt ?? '').slice(0, 4000),
        params: { model: res.model, output_format: outputFormat, itemId, chars: res.content.length },
        tags: [tagOfFormat(outputFormat)],
      })
      await db
        .update(genTasks)
        .set({ status: 'succeeded', resultAssetId: asset.id, completedAt: nowMs(), updatedAt: nowMs() })
        .where(eq(genTasks.id, task.id))
      task.status = 'succeeded'
      task.resultAssetId = asset.id
      emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'succeeded' })
      ctx.log(`item ${itemId} 完成 → asset#${asset.id}（${res.content.length} 字符）`)
      return null
    } catch (err) {
      const msg = (err as Error).message
      if (attempts >= maxAttempts) {
        await db
          .update(genTasks)
          .set({ status: 'failed', errorMsg: msg, completedAt: nowMs(), updatedAt: nowMs() })
          .where(eq(genTasks.id, task.id))
        emitStudioEvent({ type: 'task.updated', runId: ctx.run.id, taskId: task.id, status: 'failed', error: msg })
        ctx.log(`item ${itemId} 失败（已尝试 ${maxAttempts} 次）：${msg}`)
        return { itemId, error: msg }
      }
      ctx.log(`item ${itemId} 第 ${attempts}/${maxAttempts} 次失败，1.5s 后重试：${msg}`)
      await sleep(1500)
    }
  }
}

/** 静态 sections：照单调用规则，但跳过 field 键（其资产由数组 + 逐项机制替代）；M70 保留键/保留 purpose 同闸 */
async function buildStaticSections(ctx: StepContext, skipKey: string): Promise<string[]> {
  const sections: string[] = []
  for (const [k, v] of Object.entries(ctx.input)) {
    if (k.startsWith('_') || k === skipKey || k === 'continuity_context') continue
    const ids = asAssetIds(v)
    if (ids && ids.length > 0) {
      const rows = await ctx.assetsOf(ids)
      for (const a of rows) {
        if (a.purpose && isContinuityPurpose(a.purpose)) throw new ContinuityError('continuity_unsupported', 400)
        if (a.kind === 'text') {
          sections.push(`--- ${k} / ${a.name} ---\n${await readTextAsset(a.id)}`)
        } else {
          sections.push(`--- ${k} / ${a.name}（${a.kind} 资产：文本模型无法读取，路径 ${a.relPath ?? '?'}）---`)
        }
      }
    } else if (typeof v === 'string') {
      sections.push(`--- ${k} ---\n${v}`)
    } else if (v !== undefined && v !== null) {
      sections.push(`--- ${k} ---\n${JSON.stringify(v, null, 2)}`)
    }
  }
  return sections
}

/** 列表提取（纯函数，供探针断言）：obj[field] 数组 ?? 根数组 ?? [] */
export function extractBatchItems(obj: unknown, field: string): Record<string, unknown>[] {
  const arr = Array.isArray(obj)
    ? obj
    : obj && typeof obj === 'object'
      ? (obj as Record<string, unknown>)[field]
      : undefined
  if (!Array.isArray(arr)) return []
  return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
}

/** item 标识（纯函数，供探针断言）：item_key → 探测 id/index/ep → pos:{序号} */
export function batchItemId(item: Record<string, unknown>, pos: number, itemKey?: string | null): string {
  if (itemKey && item[itemKey] !== undefined && item[itemKey] !== null) return String(item[itemKey])
  for (const k of ['id', 'index', 'ep']) {
    const v = item[k]
    if (v !== undefined && v !== null) return String(v)
  }
  return `pos:${pos}`
}

/** 逐项提示词拼装（纯函数，供探针断言）：模板 + 静态 sections + item JSON + item 资产全文 */
export function buildItemPrompt(opts: {
  templateText: string
  staticSections: string[]
  itemJson: string
  itemAssetSection?: string
}): string {
  const parts = [...opts.staticSections, `--- item ---\n${opts.itemJson}`]
  if (opts.itemAssetSection) parts.push(opts.itemAssetSection)
  return `${opts.templateText}\n\n===== 输入资料 =====\n${parts.join('\n\n')}`
}

/** 简易并发池：all 结束后统一返回（任务内部已捕获失败） */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
}

const nowMs = (): number => Date.now()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))