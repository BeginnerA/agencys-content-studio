/** M18[P5] template-v2：模板 v2（draft 全节点型映射 + literal action + registry + template-try 全链）（断言体逐字搬自原 probe-m18.ts） */
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, db, mkProject, mkAsset, jreq, pipelineRuns, eq } = ctx
  const { buildTemplateDraftYaml, tryRunTemplate, parseNodeSpec } = await import('../../../src/services/creation')
  const { validateTemplateText, saveTemplate, deleteTemplate, KNOWN_ACTIONS, loadTemplate } = await import('../../../src/pipeline/loader')
  const { literal } = await import('../../../src/pipeline/actions/literal')
  const { listActionKeys } = await import('../../../src/pipeline/actions')
  const { readTextAsset } = await import('../../../src/services/storage')
  void saveTemplate
  type CanvasDocT = import('../../../src/services/creation').CanvasDoc

  // ---- ① draft v2 全节点型映射（纯函数） ----
  const emptyNode = {
    id: 0, kind: 'gen' as const, x: 0, y: 0, title: '',
    assetId: null, asset: null, spec: null, specError: null,
    status: null, latestTask: null, tasks: [], readiness: null,
    editCapability: null, canRun: null, canCancel: null,
  }
  const PID = await mkProject('M18 模板v2')
  const doc: CanvasDocT = {
    canvas: { id: 88, projectId: PID, name: '全型画布', viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [
      { ...emptyNode, kind: 'text', id: 1, title: '主题', spec: { text: '猫和咖啡' } },
      {
        ...emptyNode,
        kind: 'asset',
        id: 2,
        title: '参考图',
        assetId: 99,
        // [M22] 补全 asset（kind=image）——供参考边映射判定（真画布由 buildCanvasDoc 填充）
        asset: { id: 99, kind: 'image', purpose: null, name: '参考图', mime: 'image/png', width: null, height: null, duration: null, prompt: null, urls: { file: 'f', thumb: null } },
      },
      { ...emptyNode, kind: 'entity', id: 3, title: '主角', spec: { entityKind: 'character', entityId: 1, name: '小萌' } as any },
      { ...emptyNode, kind: 'run', id: 4, title: '嵌套运行', spec: { runId: 1 } as any },
      { ...emptyNode, id: 10, title: 'LLM 大纲', spec: parseNodeSpec({ genKind: 'llm', prompt: '扩写主题' }) },
      { ...emptyNode, id: 11, title: '首帧', spec: parseNodeSpec({ genKind: 'image', prompt: '小猫' }) },
      { ...emptyNode, id: 12, title: '视频', spec: parseNodeSpec({ genKind: 'video', prompt: '运镜', duration: 5 }) },
      { ...emptyNode, id: 13, title: '配音', spec: parseNodeSpec({ genKind: 'audio', prompt: '喵呜', voice: 'Cherry' }) },
      { ...emptyNode, id: 14, title: '合成', spec: parseNodeSpec({ genKind: 'compose', resolution: '720p', fps: 30, transition: 'fade', bgmAssetId: 100 }) },
    ],
    edges: [
      { id: 1, from: 1, to: 10, port: 'prompt' },
      { id: 2, from: 10, to: 11, port: 'prompt' },
      { id: 3, from: 2, to: 11, port: 'reference' },
      { id: 4, from: 11, to: 12, port: 'first_frame' },
      { id: 5, from: 12, to: 14, port: 'video' },
      { id: 6, from: 13, to: 14, port: 'audio' },
      { id: 7, from: 2, to: 13, port: 'reference' },
    ],
    groups: [],
  }

  const { yaml, lossy } = buildTemplateDraftYaml(doc, 'probe-v2-88')
  check(
    yaml.includes('key: t1') && yaml.includes('kind: text') && yaml.includes('default: "猫和咖啡"'),
    'draft v2：text → inputs t1 kind=text + default',
  )
  check(
    yaml.includes('key: a2') && yaml.includes('kind: files') && yaml.includes('required: false'),
    'draft v2：asset → inputs a2 files 选填',
  )
  check(lossy.some((s) => s.includes('实体节点 #3')), 'draft v2 lossy：entity #3')
  check(lossy.some((s) => s.includes('运行节点 #4')), 'draft v2 lossy：run #4')
  check(
    yaml.includes('action: ai_text') && yaml.includes('prompt_inline: "扩写主题"') && yaml.includes('output_purpose: creation_llm'),
    'draft v2：llm → ai_text prompt_inline + creation_llm',
  )
  check(yaml.includes('text1: input.t1'), 'draft v2：llm 从 text 节点 prompt 端口 → inputs.text1=input.t1')
  check(yaml.includes('action: ffmpeg_merge'), 'draft v2：compose → ffmpeg_merge')
  check(
    yaml.includes('motion_clips:') && yaml.includes('- steps.n12.asset'),
    'draft v2：compose motion_clips 引用 steps.n12.asset',
  )
  check(yaml.includes('voices:') && yaml.includes('- steps.n13.asset'), 'draft v2：compose voices 引用 steps.n13.asset')
  check(yaml.includes('fps: 30') && yaml.includes('resolution: "720p"'), 'draft v2：compose fps/resolution params')
  check(lossy.some((s) => s.includes('#14') && s.includes('转场')), 'draft v2 lossy：compose 转场')
  check(lossy.some((s) => s.includes('#14') && s.includes('BGM')), 'draft v2 lossy：compose BGM')
  check(
    yaml.includes('key: n11_lit') && yaml.includes('key: n11') && yaml.includes('action: ai_image'),
    'draft v2：image → lit + ai_image',
  )
  check(yaml.includes('as: storyboard-single'), 'draft v2：lit as=storyboard-single')
  check(yaml.includes('text: steps.n10.asset'), 'draft v2：lit inputs.text 引用上游 llm 产物')
  check(yaml.includes('shots: steps.n11_lit.asset'), 'draft v2：ai_image inputs.shots 引用 lit 产物')
  check(
    yaml.includes('key: n13_lit') && yaml.includes('as: lines-single') && yaml.includes('action: tts'),
    'draft v2：audio → lit(lines-single) + tts',
  )
  check(yaml.includes('payload: "喵呜"') && yaml.includes('voice: "Cherry"'), 'draft v2：audio lit payload 回退 + tts voice')
  check(
    yaml.includes('refs:') && yaml.includes('- input.a2'),
    'draft v2：image reference 边 → lit inputs.refs（M22 保真直通）',
  )
  check(
    yaml.includes('first_frame: steps.n11.asset'),
    'draft v2：video first_frame 边 → lit inputs.first_frame（M22 保真直通）',
  )
  check(
    lossy.some((s) => s.includes('#13') && s.includes('未映射')),
    'draft v2 lossy：audio reference 连线未映射（M22 收缩文案）',
  )
  const val = validateTemplateText(yaml, 'probe-v2-88')
  check(val.ok, `draft v2 通过 validateTemplateText：${val.errors.join(' | ')}`)

  // ---- ② literal action 直接执行（as 全矩阵 + payload 回退 + 空抛错 + 非法 as 抛错） ----
  const mkCtx = (over: Partial<import('../../../src/pipeline/context').StepContext>): any => ({
    run: { id: 0, projectId: PID, input: '{}' },
    step: { id: 0 },
    template: {},
    def: { key: 'probe_lit', params: {} },
    input: {},
    settings: {},
    log: () => {},
    assetIdsOf: () => [],
    readText: async (id: number) => await readTextAsset(id),
    pathOf: async () => '',
    assetsOf: async () => [],
    ...over,
  })
  // raw
  const rRaw = await literal(mkCtx({
    def: { key: 'lit_raw', action: 'literal', title: 'r', inputs: {}, params: { as: 'raw', payload: '字面 raw 内容' } } as any,
  }))
  check(rRaw.assetIds.length === 1, `literal as=raw → 1 资产 (id=${rRaw.assetIds[0]})`)
  const rawTxt = await readTextAsset(rRaw.assetIds[0]!)
  check(rawTxt === '字面 raw 内容', 'literal as=raw 内容不变')
  // storyboard-single
  const rSb = await literal(mkCtx({
    def: { key: 'lit_sb', action: 'literal', title: 'r', inputs: {}, params: { as: 'storyboard-single', payload: '一个镜头' } } as any,
  }))
  const sbTxt = JSON.parse(await readTextAsset(rSb.assetIds[0]!))
  check(
    Array.isArray(sbTxt.shots) && sbTxt.shots.length === 1 && sbTxt.shots[0].image_prompt === '一个镜头',
    'literal as=storyboard-single → shots[0].image_prompt',
  )
  // lines-single
  const rLn = await literal(mkCtx({
    def: { key: 'lit_ln', action: 'literal', title: 'r', inputs: {}, params: { as: 'lines-single', payload: '一句话' } } as any,
  }))
  const lnTxt = JSON.parse(await readTextAsset(rLn.assetIds[0]!))
  check(
    Array.isArray(lnTxt.lines) && lnTxt.lines.length === 1 && lnTxt.lines[0].text === '一句话',
    'literal as=lines-single → lines[0].text',
  )
  // inputs.text 优先 params.payload
  const rPri = await literal(mkCtx({
    def: { key: 'lit_pri', action: 'literal', title: 'r', inputs: {}, params: { as: 'raw', payload: 'P 兜底' } } as any,
    input: { text: 'T 优先' },
  }))
  const priTxt = await readTextAsset(rPri.assetIds[0]!)
  check(priTxt === 'T 优先', 'literal inputs.text 优先 params.payload')
  // 空抛错
  let threw = false
  try {
    await literal(mkCtx({ def: { key: 'lit_err', action: 'literal', title: 'r', inputs: {}, params: { as: 'raw' } } as any }))
  } catch {
    threw = true
  }
  check(threw, 'literal 无 text 无 payload → 抛错')
  // 非法 as 抛错
  threw = false
  try {
    await literal(mkCtx({ def: { key: 'lit_bad', action: 'literal', title: 'r', inputs: {}, params: { as: 'no-such', payload: 'x' } } as any }))
  } catch {
    threw = true
  }
  check(threw, 'literal as 非法 → 抛错')
  // 资产 id 引用→ readText
  const rRef = await literal(mkCtx({
    def: { key: 'lit_ref', action: 'literal', title: 'r', inputs: {}, params: { as: 'raw' } } as any,
    input: { text: rRaw.assetIds[0] },
  }))
  const refTxt = await readTextAsset(rRef.assetIds[0]!)
  check(refTxt === '字面 raw 内容', 'literal inputs.text=资产 id → 读全文')

  // ---- ③ registry / KNOWN_ACTIONS 新行 ----
  check((KNOWN_ACTIONS as readonly string[]).includes('literal'), 'KNOWN_ACTIONS 已含 literal')
  check(listActionKeys().includes('literal'), 'ACTIONS registry 已含 literal')

  // ---- ④ template-try 全链 ----
  const mkCanvas = async (name: string): Promise<number> =>
    (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name })).body.canvas.id
  const mkNode = async (canvasId: number, body: unknown): Promise<number> =>
    (await jreq('POST', `/api/v1/canvases/${canvasId}/nodes`, body)).body.node.id

  // 子图：asset→image (reference 无效连线不预含)，保留 prompt：text→image
  const CT = await mkCanvas('试跑画布甲')
  const AV = await mkAsset(PID, 'image', '参考图 A')
  const nA = await mkNode(CT, { kind: 'asset', assetId: AV, x: 0, y: 0 })
  const nT = await mkNode(CT, { kind: 'text', spec: { text: '提示文本' }, x: 0, y: 100 })
  const nI = await mkNode(CT, { kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 300, y: 0 })
  await jreq('POST', `/api/v1/canvases/${CT}/edges`, { from: nT, to: nI, port: 'prompt' })
  await jreq('POST', `/api/v1/canvases/${CT}/edges`, { from: nA, to: nI, port: 'reference' })

  const try1 = await jreq('POST', `/api/v1/canvases/${CT}/template-try`, { key: 'probe-try-a' })
  check(
    try1.status === 201 && typeof try1.body?.templateKey === 'string' && typeof try1.body?.runId === 'number',
    'template-try 201 {templateKey, runId, lossy, input}',
  )
  check(
    Array.isArray(try1.body?.lossy) && !try1.body.lossy.some((s: string) => s.includes('#' + nI) && s.includes('未映射')),
    'template-try lossy：参考连线已直通映射（M22，不计入 lossy）',
  )
  check(
    try1.body?.input && JSON.stringify(try1.body.input[`a${nA}`]) === JSON.stringify([AV]),
    'template-try inputs 预填：files ← asset assetId',
  )
  const runRow = (
    await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, try1.body.runId))
  )[0]
  check(runRow?.status === 'queued' && runRow?.templateKey === 'probe-try-a', 'template-try 已建 queued run（项目域 templateKey）')

  // 冲突自动后缀
  const try2 = await jreq('POST', `/api/v1/canvases/${CT}/template-try`, { key: 'probe-try-a' })
  check(try2.status === 201 && try2.body?.templateKey === 'probe-try-a-2', 'template-try key 冲突 → 自动后缀 -2')

  // nodeIds 子集（仅 image 节点，自动闭包上游 text+asset）
  const try3 = await jreq('POST', `/api/v1/canvases/${CT}/template-try`, { key: 'probe-try-sub', nodeIds: [nI] })
  check(try3.status === 201, 'template-try nodeIds 子集 → 201')
  const tplSub = loadTemplate('probe-try-sub')
  check(
    tplSub && tplSub.inputs.some((i) => i.key === `t${nT}`) && tplSub.inputs.some((i) => i.key === `a${nA}`),
    'template-try 子图闭包：text + asset 一同纳入 inputs',
  )

  // 无 gen 节点 → 400 validation_failed（steps: []）
  const CEmpty = await mkCanvas('空画布')
  const tryEmpty = await jreq('POST', `/api/v1/canvases/${CEmpty}/template-try`, { key: 'probe-try-empty' })
  check(tryEmpty.status === 400 && tryEmpty.body?.error?.code === 'validation_failed', 'template-try 无 gen → 400 validation_failed')

  // 非法 key / nodeIds / 不存在画布
  check((await jreq('POST', `/api/v1/canvases/${CT}/template-try`, { key: 'bad key!' })).status === 400, 'template-try 非法 key → 400')
  check(
    (await jreq('POST', `/api/v1/canvases/${CT}/template-try`, { nodeIds: ['x', 1] })).status === 400,
    'template-try nodeIds 非整数 → 400',
  )
  check((await jreq('POST', '/api/v1/canvases/999999/template-try', {})).status === 404, 'template-try 不存在画布 → 404')

  // 清理模板文件（防影响后续）
  for (const k of ['probe-try-a', 'probe-try-a-2', 'probe-try-sub']) {
    try {
      deleteTemplate(k)
    } catch {
      /* 已删 → 忽略 */
    }
  }
}
