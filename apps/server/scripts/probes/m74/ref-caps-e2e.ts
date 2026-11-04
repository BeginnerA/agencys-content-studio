/**
 * 出图入队真实引擎节（跑 aiImage 动作本体，零外发：适配器生成方法打桩、参考图读本地盘）。
 *
 * 锁定本轮进入出图快照的新行为——模型能力收紧总量在选择层的落地：
 *   1. 模型上限把本镜参考总量掐到低于宿主总量时，被总量挤掉的候选在 params 快照里
 *      按「超出模型参考图上限(N)」归类，且逐实体选择结果（refSelection）每项都在实发列表（refAssetIds）里；
 *   2. 分层行存在但本镜取不到 → 回退基准的留痕（refFallbacks）随参数快照落库，
 *      运行数据才解释得了「这一镜为什么用基准图而不是状态图」。
 *
 * 夹具口径：项目 / 角色 / 分层登记 / 图片资产全部经真实服务与端点产生；
 * 运行记录与步（ai_image）是出图动作的历史输入（无独立服务形态），由本文件按既有引擎探针同款方式直建。
 */
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { StepContext } from '../../../src/pipeline/context'
import { initDatabase, newImageAsset } from './bootstrap'
import { test } from './helpers'

export async function runRefCaps(checker: Checker): Promise<void> {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const { db } = await import('../../../src/db')
  const { apiConfigs, assets, genTasks, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { resolveEndpoint, getImageAdapter } = await import('../../../src/adapters/provider')
  const { aiImage } = await import('../../../src/pipeline/actions/ai-image')
  const { upsertEntity } = await import('../../../src/services/character')
  const { addEntityRef } = await import('../../../src/services/entity-references')
  const { absPathOf } = await import('../../../src/services/storage')

  const provider = 'gemini_image'
  const model = 'gemini-2.5-flash-image'
  process.env.PROBE_M74_CAPS_KEY = 'offline-caps'
  const now = Date.now()
  const [cfg] = await db
    .insert(apiConfigs)
    .values({ name: '离线出图能力', serviceType: 'image', providerKey: provider, model, baseUrl: 'http://localhost:0', apiKeyRef: 'env:PROBE_M74_CAPS_KEY', isActive: 1, createdAt: now, updatedAt: now })
    .returning()
  const endpoint = await resolveEndpoint('image', provider, { configId: cfg!.id })

  const proj = await db.insert((await import('../../../src/db/schema')).projects).values({ name: `M74出图能力-${now}`, createdAt: now, updatedAt: now }).returning()
  const projectId = proj[0]!.id

  // 甲：五张基准分层行（超模型上限）；画布直通一张逼出「总量比本段更紧」的模型上限裁剪
  const jia = await upsertEntity({ projectId, kind: 'character', name: '甲', appearance: '圆脸短发', states: [], refAssetIds: [] })
  const jiaRefs: number[] = []
  for (let k = 0; k < 5; k += 1) {
    const id = await newImageAsset(projectId, `甲基准${k + 1}`)
    jiaRefs.push(id)
    await addEntityRef({ entityId: jia.id, assetId: id, role: 'base' })
  }
  const canvasA = await newImageAsset(projectId, '画布直通参考')

  // 乙：只有取不到的状态行、无基准 → 本镜零可取，触发「回退基准」留痕
  const STATE_ONLY = '第1场：受伤'
  const yi = await upsertEntity({ projectId, kind: 'character', name: '乙', appearance: '长发', states: [STATE_ONLY], refAssetIds: [] })
  await addEntityRef({ entityId: yi.id, assetId: await newImageAsset(projectId, '乙状态'), role: 'state', stateKey: STATE_ONLY })

  const shots = [
    { id: 's1', characters: ['甲'], ref_asset_ids: [canvasA], image_prompt: '甲登场全景', motion_prompt: '固定机位' },
    { id: 's2', characters: ['乙'], image_prompt: '乙特写', motion_prompt: '缓推' },
  ]

  const [run] = await db.insert(pipelineRuns).values({ projectId, templateKey: 'mengbao-episode', input: '{}', createdAt: now, updatedAt: now }).returning()
  const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 0, stepKey: 'frames', actionKey: 'ai_image', createdAt: now, updatedAt: now }).returning()

  // 分镜以真实文本资产落盘：动作按 inputs.shots 取资产 id 再读文，执行快照也复用同一资产
  const { importFiles, readTextAsset } = await import('../../../src/services/storage')
  const [shotsAsset] = await importFiles(projectId, [{ name: `shots-${now}.json`, data: new TextEncoder().encode(JSON.stringify(shots)) }], { purpose: 'storyboard' })

  const ctxS: StepContext = {
    run: run!,
    step: step!,
    template: { key: 'mengbao-episode', version: 1, name: '探针', genre: 'story', inputs: [], steps: [] } as never,
    def: { key: 'frames', action: 'ai_image', title: '首帧', inputs: {}, params: { use_character_refs: true, use_style_preset: false }, batch: { field: 'shots', maxConcurrent: 1, retry: 0 } } as never,
    input: {},
    settings: { image: { provider, model, size: '1024x1024', configId: endpoint.configId, configHash: endpoint.configHash } } as never,
    log: () => {},
    assetIdsOf: (key) => (key === 'shots' ? [shotsAsset!.id] : []),
    readText: readTextAsset,
    pathOf: async (id) => absPathOf((await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]!.relPath!),
    assetsOf: async (ids) => (ids.length ? await db.select().from(assets).where((await import('drizzle-orm')).inArray(assets.id, ids)) : []),
  }

  const adapter = getImageAdapter(provider)
  const originalGenerate = adapter.generate
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6QAAAABJRU5ErkJggg=='
  adapter.generate = async () => ({ kind: 'base64', data: png, mime: 'image/png' })
  try {
    await aiImage(ctxS)
    const tasks = await db.select().from(genTasks).where(eq(genTasks.stepId, step!.id))
    const byShot = new Map<string, Record<string, any>>(tasks.map((t) => [String((JSON.parse(t.params) as { shotId?: string }).shotId ?? ''), JSON.parse(t.params) as Record<string, unknown>]))

    await t('入队快照登记模型上限（缺省未登记模型收紧到四张，低于宿主总量六张）', () => {
      const caps = byShot.get('s1')?.caps as { supportsRefs: boolean; maxRefs: number } | undefined
      assert.ok(caps, '新任务一律写入能力快照')
      assert.equal(caps!.maxRefs, 4, `未登记模型取保守缺省四张上限，实得 ${caps!.maxRefs}`)
      assert.equal(caps!.supportsRefs, true, 'gemini 图像适配器声明可带参考图')
    })

    await t('模型上限裁剪归因：实发列表锁在四张、逐实体选择每项都在实发集合内', () => {
      const p = byShot.get('s1')!
      const sent = p.refAssetIds as number[]
      assert.equal(sent.length, 4, `总量被模型上限掐死在四张（含画布直通那张），实得 ${JSON.stringify(sent)}`)
      const dropped = (p.refDropped ?? []) as Array<{ assetId: number; reason: string }>
      const capped = dropped.filter((d) => d.reason.includes('超出模型参考图上限(4)'))
      assert.ok(capped.length >= 1, `被模型总量挤掉的候选按模型上限归类，实得裁剪 ${JSON.stringify(dropped.map((d) => d.reason))}`)
      const selection = (p.refSelection ?? []) as Array<{ refs: Array<{ assetId: number }> }>
      const picked = selection.flatMap((ent) => ent.refs.map((r) => r.assetId))
      assert.ok(picked.length >= 1, '逐实体选择快照非空')
      assert.ok(picked.every((assetId) => sent.includes(assetId)), `refSelection ⊆ 实发列表（不得谎报未发出的参考），实得 ${JSON.stringify(picked)} vs ${JSON.stringify(sent)}`)
      assert.ok(sent.includes(canvasA), `画布直通那张计入实发上限、占掉一格模型额度，实发 ${JSON.stringify(sent)} 应含 ${canvasA}`)
      assert.ok(!picked.includes(canvasA), '画布直通不属分层选择集合，只进实发不进逐实体选择快照')
    })

    await t('本镜零可取的分层实体 → 回退基准留痕随参数快照落库', () => {
      const p = byShot.get('s2')!
      const fallbacks = p.refFallbacks as string[] | undefined
      assert.ok(Array.isArray(fallbacks) && fallbacks.length > 0, `无基准可取时 refFallbacks 入快照，实得 ${JSON.stringify(p)}`)
      assert.ok(fallbacks!.some((f) => f.includes('回退基准')), `说明含「回退基准」，实得 ${JSON.stringify(fallbacks)}`)
    })
  } finally {
    adapter.generate = originalGenerate
    await db.update(apiConfigs).set({ isActive: 0 }).where(eq(apiConfigs.id, cfg!.id))
  }
}
