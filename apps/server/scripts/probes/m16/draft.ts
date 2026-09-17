/** M16④ draft：模板草案纯夹具快照 + 与 validateTemplateText 同源一致性（断言体逐字搬自原 probe-m16.ts） */
import type { CanvasDoc } from '../../../src/services/creation'
import type { M16Ctx } from './ctx'

export async function run(ctx: M16Ctx): Promise<void> {
  const { check, jreq, PID, buildTemplateDraftYaml, validateTemplateText } = ctx
  const emptyNode = {
    id: 0,
    kind: 'gen' as const,
    x: 0,
    y: 0,
    title: '',
    assetId: null,
    asset: null,
    spec: null,
    specError: null,
    status: null,
    latestTask: null,
    tasks: [],
    readiness: null,
    editCapability: null,
    canRun: null,
    canCancel: null,
  }
  const doc: CanvasDoc = {
    canvas: { id: 77, projectId: PID, name: '夹具画布', viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [
      {
        ...emptyNode,
        id: 1,
        kind: 'asset',
        title: '素材甲',
        assetId: 5,
        // [M22] 补全 asset（kind=image）——供参考边映射判定（真画布由 buildCanvasDoc 填充）
        asset: { id: 5, kind: 'image', purpose: null, name: '素材甲', mime: 'image/png', width: null, height: null, duration: null, prompt: null, urls: { file: 'f', thumb: null } },
      },
      { ...emptyNode, id: 2, title: '图片 #2', spec: { genKind: 'image', prompt: '镜头一' } },
      { ...emptyNode, id: 3, title: '视频 #3', spec: { genKind: 'video', prompt: '运镜', duration: 5 } },
      { ...emptyNode, id: 4, title: '编辑 #4', spec: { genKind: 'image', prompt: '', edit: { mode: 'inpaint', maskAssetId: 8 } } },
    ],
    edges: [
      { id: 1, from: 1, to: 2, port: 'reference' },
      { id: 2, from: 2, to: 3, port: 'first_frame' },
      { id: 3, from: 1, to: 4, port: 'source' },
    ],
  }
  // [M18] draft v2：buildTemplateDraftYaml 返回 {yaml, lossy[]}；asset 节点 → inputs（非 `inputs: []`）；
  // 编辑/参考/蒙版注释 → lossy 清单（不再写入 YAML 注释）
  const { yaml, lossy } = buildTemplateDraftYaml(doc, 'canvas-draft-77')
  check(
    yaml.includes('key: canvas-draft-77') &&
      yaml.includes('inputs:') &&
      yaml.includes('key: a1') &&
      yaml.includes('kind: files'),
    '草案 v2：key + asset 节点 → inputs.a1 files 输入',
  )
  const iN2 = yaml.indexOf('key: n2')
  const iN4 = yaml.indexOf('key: n4')
  const iN3 = yaml.indexOf('key: n3')
  check(iN2 > 0 && iN4 > iN2 && iN3 > iN4, '草案 v2：gen 节点拓扑序 n2 → n4 → n3')
  check(!yaml.includes('key: n1'), '草案 v2：素材节点不产生 step')
  check(yaml.includes('action: literal'), '草案 v2：image/video 节点前置 literal 包装步骤')
  check(yaml.includes('action: ai_video'), '草案 v2：视频节点 action=ai_video')
  check(yaml.includes('as: storyboard-single'), '草案 v2：literal as=storyboard-single 包装 prompt')
  check(yaml.includes('after: [n2]'), '草案 v2：边 → after 引用（n3 lit after n2）')
  check(
    lossy.some((s) => s.includes('#4') && s.includes('编辑模式')),
    '草案 v2 lossy：编辑模式节点写入 lossy 清单',
  )
  check(
    yaml.includes('refs:') && yaml.includes('- input.a1'),
    '草案 v2：reference 边（图片 asset 源）→ lit inputs.refs（M22 保真直通）',
  )
  check(
    yaml.includes('first_frame: steps.n2.asset'),
    '草案 v2：first_frame 边（image gen 源）→ lit inputs.first_frame（M22 保真直通）',
  )
  check(
    lossy.some((s) => s.includes('#4') && s.includes('未映射')),
    '草案 v2 lossy：编辑源连线未映射（M22 收缩文案）',
  )

  // DB 层 + 同源一致性
  const cn = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '草案画布' })
  const C3: number = cn.body.canvas.id
  await jreq('POST', `/api/v1/canvases/${C3}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '草案镜' }, x: 0, y: 0 })
  const dr = await jreq('POST', `/api/v1/canvases/${C3}/template-draft`, { key: `probe-draft-${C3}` })
  check(
    dr.status === 200 && typeof dr.body?.yaml === 'string' && Array.isArray(dr.body?.lossy),
    'POST template-draft → 200 {yaml, validation, lossy[]}',
  )
  const direct = validateTemplateText(dr.body.yaml, `probe-draft-${C3}`)
  check(
    dr.body?.validation?.ok === direct.ok &&
      JSON.stringify(dr.body?.validation?.errors) === JSON.stringify(direct.errors),
    '草案 validation 与 validateTemplateText 同源一致',
  )
  check((await jreq('POST', '/api/v1/canvases/999999/template-draft', {})).status === 404, 'template-draft 不存在画布 → 404')
  const badKey = await jreq('POST', `/api/v1/canvases/${C3}/template-draft`, { key: 'bad key!' })
  check(badKey.status === 400, 'template-draft 非法 key → 400')
  const { buildTemplateDraft } = await import('../../../src/services/creation')
  check((await buildTemplateDraft(999999)) === null, 'buildTemplateDraft 不存在 → null')
}
