/** M22[P1] refs：参考保真（直通字段 + draft 映射）（断言体逐字搬自原 probe-m22.ts） */
import type { CanvasDoc, CanvasDocNode } from '../../../src/services/creation/spec'
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, normalizePositiveIds, shotFirstFrameOf, collectRefAssetIds, collectSetRefAssetIds, buildTemplateDraftYaml, validateTemplateText } = ctx
  check(normalizePositiveIds([3, [4, 'x', 6], 3, 0, -1, 2.5, [7]]).join(',') === '3,4,6,7', 'normalizePositiveIds：flatten + 正整数过滤 + 保序去重')
  check(normalizePositiveIds('5').length === 0 && normalizePositiveIds(undefined).length === 0, '非数组/缺失 → 空集')

  check(shotFirstFrameOf({ id: 's1', image_prompt: 'x', first_frame_asset_id: 5 }) === 5, 'shotFirstFrameOf：正整数有效')
  check(
    shotFirstFrameOf({ id: 's1', image_prompt: 'x', first_frame_asset_id: 0 }) === null &&
      shotFirstFrameOf({ id: 's1', image_prompt: 'x' }) === null &&
      shotFirstFrameOf({ id: 's1', image_prompt: 'x', first_frame_asset_id: 1.5 }) === null,
    'shotFirstFrameOf：0/缺失/小数 → null（回退 gen_frames）',
  )

  const emptyIdx = { characters: new Map(), scenes: new Map(), props: new Map() }
  check(collectRefAssetIds({ id: 's1', image_prompt: 'x', ref_asset_ids: [9, 3, 9] }, emptyIdx).join(',') === '9,3', 'ai_image：直通 ref_asset_ids 前插 + 去重')
  const setOut = collectSetRefAssetIds({ id: 's1', image_prompt: 'x', ref_asset_ids: [9, 3] }, new Map(), new Map())
  check(setOut.length === 0, 'ai_video：collectSetRefAssetIds 只含场景/道具（直通在调用点合并）')
  check(normalizePositiveIds([9, 3, 9, ...setOut]).join(',') === '9,3', 'ai_video：直通 + 场景/道具 合并保序去重')

  // draft：参考/首帧边映射（mkNode 补齐 CanvasDocNode 必填字段）
  const mkNode = (id: number, kind: CanvasDocNode['kind'], extra: Partial<CanvasDocNode>): CanvasDocNode => ({
    id,
    kind,
    x: 0,
    y: 0,
    title: `N${id}`,
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
    ...extra,
  })
  const imgNode = (id: number, assetId: number): CanvasDocNode =>
    mkNode(id, 'asset', {
      assetId,
      asset: { id: assetId, kind: 'image', purpose: null, name: '图', mime: 'image/png', width: null, height: null, duration: null, prompt: null, urls: { file: 'f', thumb: null } },
    })
  const doc: CanvasDoc = {
    canvas: { id: 9, projectId: 1, name: 'T', viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [
      imgNode(10, 100),
      mkNode(12, 'text', { spec: { text: '提示词' } }),
      mkNode(13, 'gen', { spec: { genKind: 'image', prompt: '首帧' } }),
      mkNode(11, 'gen', { spec: { genKind: 'video', prompt: '镜头' } }),
    ],
    edges: [
      { id: 1, from: 12, to: 11, port: 'prompt' },
      { id: 2, from: 10, to: 11, port: 'reference' },
      { id: 3, from: 13, to: 11, port: 'first_frame' },
    ],
    groups: [],
  }
  const r1 = buildTemplateDraftYaml(doc, 'probe-m22-draft')
  check(r1.yaml.includes('      refs:\n        - input.a10\n'), 'draft：reference 边（图片 asset 源）→ lit inputs.refs')
  check(r1.yaml.includes('      first_frame: steps.n13.asset\n'), 'draft：first_frame 边（image gen 源）→ lit inputs.first_frame')
  check(!r1.lossy.some((l) => l.includes('未映射')), 'draft：参考/首帧已映射 → 无 unmapped lossy 条目')
  const v = validateTemplateText(r1.yaml, 'probe-m22-draft')
  check(v.ok, `draft YAML 通过 loader 校验${v.ok ? '' : `：${v.errors.join('；')}`}`)

  const doc2: CanvasDoc = { ...doc, edges: [...doc.edges, { id: 4, from: 13, to: 11, port: 'last_frame' }] }
  const r2 = buildTemplateDraftYaml(doc2, 'probe-m22-draft2')
  check(r2.lossy.some((l) => l.includes('未映射')), 'draft：末帧边 → unmapped（lossy 汇总）')
}
