/**
 * M31 探针（对话式参考输入：图 / 视频 / 角色 / BGM）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m31.ts [--section=attachment|fromasset|hashguard|capability|bgm|firstframe]
 *
 * 隔离策略：isolatedEnv('m31', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费模型调用、零计费：
 *   - attachment：直调 addAttachment/resolveAttachmentRefs（真实本地文件落盘、sha256 去重、跨项目拒绝）；
 *   - fromasset：[M31+] 直调 addAttachmentFromAsset（存量资产选取：同项目直登、跨项目复制+去重、拒绝面全覆盖）；
 *   - hashguard：refs 进 planHash + 确认冻结链 → 编辑/软删/迁移项目一律停机（不静默消费）；无参考零回归；
 *   - capability：视觉不可用不假称理解、无 i2v 拒绝降级、无图像端点拒绝图片参考、成本可见（预检纯函数）；
 *   - bgm：严格合成 BGM 窄口径 opt-in（有 role:'bgm' 才混音、无则 params.bgm=null）；
 *   - firstframe：首帧参考冻结并可解析为首帧资产、i2v 严格合成产出可解码 MP4。
 * 确认前 stub engine.startRun 阻断真实媒体执行；compose 用本地 ffmpeg 生成可解码素材，不触网。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m31', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M31_KEY = 'probe-m31-offline-secret-key-7a1d'

const SECTIONS = ['attachment', 'fromasset', 'hashguard', 'capability', 'bgm', 'firstframe'] as const

// 1x1 透明 PNG（合法可解码图像字节，供参考图资产）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
// 1x1 蓝色 PNG（内容不同 → 与 PNG_1X1 不被 sha256 去重合并，供多参考核验）
const PNG_1X1_ALT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
// 拼接字节 PNG（第三份不同内容，供「文件缺失」拒绝面）
const PNG_UNIQUE = Buffer.concat([PNG_1X1, PNG_1X1_ALT])

function makePlan(mode: 'dynamic' | 'slideshow', refs: unknown[] = []) {
  return {
    title: '咖啡冲煮三分钟', summary: '用三段讲清风味来源', genre: 'science' as const, duration: 30,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode, style: '轻松科普',
    script: '豆子决定风味。\n水温影响萃取。\n研磨匹配时间。',
    lines: [
      { id: 'l1', text: '豆子决定风味' },
      { id: 'l2', text: '水温影响萃取' },
      { id: 'l3', text: '研磨匹配时间' },
    ],
    shots: [
      { id: 's1', duration: 10, image_prompt: '咖啡豆特写', motion_prompt: '缓慢推近', lines: ['l1'] },
      { id: 's2', duration: 10, image_prompt: '手冲注水', motion_prompt: '水流环绕', lines: ['l2'] },
      { id: 's3', duration: 10, image_prompt: '研磨刻度', motion_prompt: '镜头下移', lines: ['l3'] },
    ],
    refs,
  }
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m31')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
  }
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    const e = await errOf(fn)
    return e && typeof (e as unknown as { code?: unknown }).code === 'string' ? (e as unknown as { code: string }).code : e ? 'other' : 'none'
  }

  const mkProject = async (name: string): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    return (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'easy-video', status: 'active', settings: '{}', tags: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }

  const mkSession = async (projectId: number): Promise<number> => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const t = Date.now()
    return (await db.insert(creationSessions).values({ projectId, requestKey: `m31s${t}`, status: 'draft', planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }

  const seedEndpoints = async (over: { videoActive?: number; videoProvider?: string; videoModel?: string; videoCaps?: unknown; durations?: number[]; aspectRatios?: string[] } = {}): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    for (const s of ['llm', 'audio', 'video', 'image']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, s))
    const t = Date.now()
    const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M31_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: v.isActive ?? 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'probe-voice' }, pricing: '{"char":0.1}' })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
    await insert({
      name: 'video', providerKey: over.videoProvider ?? 'siliconflow_video', serviceType: 'video', isActive: over.videoActive ?? 1,
      model: over.videoModel ?? 'Wan2.2-I2V-A14B',
      extra: over.videoCaps === null ? {} : { creationCapabilities: over.videoCaps ?? { model: over.videoModel ?? 'Wan2.2-I2V-A14B', verified: true, modes: ['i2v', 't2v'], durations: over.durations ?? [10], aspectRatios: over.aspectRatios ?? ['9:16', '16:9', '1:1'], resolution: '720p' } },
      pricing: '{"second":0.1}',
    })
  }

  // 本地生成可解码素材并登记资产（不触网）：voice=静音 mp3 / video=testsrc mp4 / image=testsrc png
  const genMedia = async (projectId: number, kind: 'voice' | 'video' | 'image', id: string, durSec: number, runId: number, params: Record<string, unknown>): Promise<number> => {
    const { ensureProjectDirs, relPathOf, absPathOf, registerAsset } = await import('../src/services/storage')
    const { resolveFfmpeg } = await import('../src/services/ffmpeg')
    const ffmpeg = resolveFfmpeg()!
    ensureProjectDirs(projectId)
    const purpose = kind === 'voice' ? 'voice' : kind === 'video' ? 'shot_video' : 'shot_image'
    const ext = kind === 'voice' ? 'mp3' : kind === 'video' ? 'mp4' : 'png'
    const rel = relPathOf(projectId, purpose, `${id}-${Date.now()}.${ext}`)
    const abs = absPathOf(rel)
    const args = kind === 'voice'
      ? ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(durSec), '-q:a', '4', abs]
      : kind === 'video'
        ? ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=25', '-t', String(durSec), '-pix_fmt', 'yuv420p', '-preset', 'veryfast', abs]
        : ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=1', '-frames:v', '1', abs]
    const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 120000, windowsHide: true })
    if (r.status !== 0) throw new Error(`探针生成素材失败(${kind} ${id}): ${(r.stderr ?? '').slice(-200)}`)
    const asset = await registerAsset(projectId, { name: `${id}.${ext}`, kind: kind === 'voice' ? 'audio' : kind, purpose, relPath: rel, ext, mime: kind === 'voice' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'image/png', duration: kind === 'video' ? durSec : undefined, runId, params })
    return asset.id
  }

  // 直建「待确认」会话（旁路 LLM：直接 preflightPlan 填充 plan/preflight/planHash）
  const makeReadySession = async (mode: 'dynamic' | 'slideshow', refs: unknown[] = []) => {
    const { db } = await import('../src/db')
    const { creationSessions } = await import('../src/db/schema')
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    const projectId = await mkProject(`probe-m31-${mode}-${Date.now()}`)
    const plan = creationPlanSchema.parse(makePlan(mode, refs))
    const pf = await preflightPlan(projectId, plan)
    const t = Date.now()
    const [s] = await db.insert(creationSessions).values({ projectId, requestKey: `ready${t}`, status: pf.ready ? 'ready' : 'draft', plan: JSON.stringify(plan), planRevision: 1, planHash: pf.execution ? hashJson({ plan, execution: pf.execution }) : null, preflight: JSON.stringify(pf), runHistory: '[]', createdAt: t, updatedAt: t }).returning()
    return { projectId, sessionId: s!.id, plan, pf, planHash: pf.execution ? hashJson({ plan, execution: pf.execution }) : null }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= attachment：类型 / 大小 / 归属 / role 匹配 / 去重 / 跨项目拒绝 =================
    attachment: async () => {
      const { addAttachment, resolveAttachmentRefs } = await import('../src/services/creation-chat/attachments')
      await seedEndpoints()
      const pid = await mkProject('m31-att-main')
      const sid = await mkSession(pid)

      const img = await addAttachment(sid, { name: 'style.png', data: PNG_1X1 })
      check(img.kind === 'image' && img.role === 'style' && /^[a-f0-9]{64}$/.test(img.hash) && (img.thumbUrl ?? '').includes('/thumb'), '图片附件默认 role=style、返回内容摘要与缩略图 URL')
      const subj = await addAttachment(sid, { name: 'subject.png', data: PNG_1X1_ALT }, 'subject')
      check(subj.role === 'subject' && subj.assetId > 0, '显式指定 role=subject 通过图片用途校验')

      check(await codeOf(() => addAttachment(sid, { name: 'notes.txt', data: new Uint8Array(Buffer.from('hi')) })) === 'bad_kind', '非图/视频/音频文件被拒绝（不静默收为参考）')
      check(await codeOf(() => addAttachment(sid, { name: 'song.mp3', data: new Uint8Array(Buffer.from('f'.repeat(64))) }, 'first_frame')) === 'bad_role', '音频用作 first_frame → role 与 kind 不匹配被拒')
      check(await codeOf(() => addAttachment(sid, { name: 'x.png', data: new Uint8Array(0) })) === 'empty_file', '空文件被拒绝')
      check(await codeOf(() => addAttachment(sid, { name: 'huge.png', data: new Uint8Array(21 * 1024 * 1024) })) === 'too_large', '图片超过 20MB 上限被拒（不入库不计费）')

      const dup = await addAttachment(sid, { name: 'style-copy.png', data: PNG_1X1 })
      check(dup.assetId === img.assetId, '相同内容附件按 sha256 去重复用同一资产')

      // 同内容改用途重传：应原地更新既有 attachment 消息的 role，不再插新行（防对话流出现多条同图卡片）
      const { db: pdb } = await import('../src/db')
      const { creationMessages: pcm } = await import('../src/db/schema')
      const { eq: peq } = await import('drizzle-orm')
      await addAttachment(sid, { name: 'style.png', data: PNG_1X1 }, 'subject')
      const attRows = await pdb.select().from(pcm).where(peq(pcm.sessionId, sid))
      const dupRows = attRows.filter((r) => {
        try { return (JSON.parse(r.payload ?? '{}') as { assetId?: number }).assetId === img.assetId } catch { return false }
      })
      const dupRole = (() => { try { return (JSON.parse(dupRows[0]?.payload ?? '{}') as { ref?: { role?: string } }).ref?.role } catch { return undefined } })()
      check(dupRows.length === 1 && dupRole === 'subject', '同内容改用途重传 → 单条 attachment 消息原地更新 role，不插新行')

      const refs = await resolveAttachmentRefs(sid, pid, [img.assetId, subj.assetId])
      check(refs.length === 2 && refs.every((r) => r.kind === 'image'), '规划前核验通过：附件资产编译为 refs')

      const otherPid = await mkProject('m31-att-other')
      const otherSid = await mkSession(otherPid)
      check(await codeOf(() => resolveAttachmentRefs(otherSid, otherPid, [img.assetId])) === 'ref_not_found', '跨项目引用附件 → ref_not_found（拒绝他项目资产）')
      check(await codeOf(() => resolveAttachmentRefs(sid, pid, Array.from({ length: 13 }, (_, i) => i + 1))) === 'too_many_refs', '参考数量超过 12 上限被拒')
    },

    // ============ fromasset：[M31+] 从素材选取（同项目直登 / 跨项目复制去重 / 拒绝面） ============
    fromasset: async () => {
      const { addAttachmentFromAsset, resolveAttachmentRefs } = await import('../src/services/creation-chat/attachments')
      const { importFiles, absPathOf } = await import('../src/services/storage')
      const { db } = await import('../src/db')
      const { assets, creationMessages } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      await seedEndpoints()
      const pidA = await mkProject('m31-fa-src')
      const pidB = await mkProject('m31-fa-sess')
      const sidB = await mkSession(pidB)

      const [imgA] = await importFiles(pidA, [{ name: 'style-a.png', data: PNG_1X1 }], { purpose: 'source' })
      const [txtA] = await importFiles(pidA, [{ name: 'notes.txt', data: new Uint8Array(Buffer.from('hello probe note')) }], { purpose: 'source' })

      // 同项目：资产与会话同项目 → 直接登记不复制
      const sidA = await mkSession(pidA)
      const same = await addAttachmentFromAsset(sidA, imgA!.id)
      check(same.assetId === imgA!.id && same.kind === 'image' && same.role === 'style' && /^[a-f0-9]{64}$/.test(same.hash) && (same.thumbUrl ?? '').includes('/thumb'), '同项目素材选取 → 直接登记不复制（返回摘要与缩略图）')

      // 跨项目：自动复制进会话项目，规划前核验可过
      const cross = await addAttachmentFromAsset(sidB, imgA!.id)
      check(cross.assetId !== imgA!.id && cross.hash === same.hash, '跨项目素材选取 → 复制进会话项目（新资产 id、内容摘要一致）')
      const copied = (await db.select().from(assets).where(eq(assets.id, cross.assetId)))[0]!
      check(copied.projectId === pidB && copied.kind === 'image', '复制资产归属会话项目（满足规划前归属核验）')
      const refs = await resolveAttachmentRefs(sidB, pidB, [cross.assetId])
      check(refs.length === 1 && refs[0]!.role === 'style', '跨项目选取的参考通过规划前核验并编译为 refs')

      // 重复选取改用途：sha256 复用同一会话资产 + 单条 attachment 消息原地更新 role
      const again = await addAttachmentFromAsset(sidB, imgA!.id, 'subject')
      check(again.assetId === cross.assetId, '重复选取同内容 → sha256 去重复用同一会话资产（不产生新文件）')
      const faMsgs = (await db.select().from(creationMessages).where(eq(creationMessages.sessionId, sidB))).filter((r) => {
        try { return (JSON.parse(r.payload ?? '{}') as { assetId?: number }).assetId === cross.assetId } catch { return false }
      })
      const faRole = (() => { try { return (JSON.parse(faMsgs[0]?.payload ?? '{}') as { ref?: { role?: string } }).ref?.role } catch { return undefined } })()
      check(faMsgs.length === 1 && faRole === 'subject', '重复选取改用途 → 单条 attachment 消息原地更新 role，不插新行')

      // 拒绝面：非媒体 / role 不匹配 / 软删 / 不存在 / 非法 id / 磁盘文件缺失
      check(await codeOf(() => addAttachmentFromAsset(sidA, txtA!.id)) === 'bad_kind', '非媒体（文本）素材选取 → 拒绝（不静默收为参考）')
      check(await codeOf(() => addAttachmentFromAsset(sidA, imgA!.id, 'bgm')) === 'bad_role', '图片用作 bgm → role 与 kind 不匹配被拒')
      check(await codeOf(() => addAttachmentFromAsset(sidB, 0)) === 'bad_asset', '非法资产编号 → bad_asset')
      check(await codeOf(() => addAttachmentFromAsset(sidB, 999999)) === 'asset_not_found', '不存在的资产 → asset_not_found')
      const [imgC] = await importFiles(pidA, [{ name: 'gone.png', data: PNG_UNIQUE }], { purpose: 'source' })
      await db.update(assets).set({ deletedAt: Date.now() }).where(eq(assets.id, imgC!.id))
      check(await codeOf(() => addAttachmentFromAsset(sidB, imgC!.id)) === 'asset_not_found', '已软删素材选取 → asset_not_found（不引用回收站素材）')
      const [imgD] = await importFiles(pidA, [{ name: 'missing.png', data: new Uint8Array(Buffer.concat([PNG_UNIQUE, PNG_1X1_ALT])) }], { purpose: 'source' })
      const { rmSync } = await import('node:fs')
      rmSync(absPathOf(imgD!.relPath!))
      check(await codeOf(() => addAttachmentFromAsset(sidB, imgD!.id)) === 'no_file', '磁盘文件缺失的素材 → no_file 拒绝（不登记幽灵参考）')
    },

    // ================= hashguard：refs 进 planHash + 篡改/删除/迁移停机 + 无参考零回归 =================
    hashguard: async () => {
      const { db } = await import('../src/db')
      const { assets, pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { hashJson, creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const { assertRecipeSources, recipeOf } = await import('../src/services/creation-chat/recipe')
      const { addAttachment } = await import('../src/services/creation-chat/attachments')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { absPathOf } = await import('../src/services/storage')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      engine.engine.startRun = ((runId: number): 'started' => { void runId; return 'started' }) as typeof engine.engine.startRun
      try {
        await seedEndpoints()
        const a = creationPlanSchema.parse(makePlan('slideshow'))
        const b = creationPlanSchema.parse(makePlan('slideshow', []))
        check(a.refs.length === 0 && hashJson(a) === hashJson(b), '旧无参考方案：refs 缺省空数组，序列化哈希与显式空一致（零回归）')

        const pid = await mkProject('m31-hg')
        const sess = await mkSession(pid)
        const att = await addAttachment(sess, { name: 'subject.png', data: PNG_1X1 }, 'subject')
        const refs = [{ assetId: att.assetId, kind: 'image' as const, role: 'subject' as const, hash: att.hash }]
        const withRef = await makeReadySession('slideshow', refs)
        await db.update(assets).set({ projectId: withRef.projectId }).where(eq(assets.id, att.assetId))
        const noRef = await makeReadySession('slideshow')
        check(withRef.pf.ready && noRef.pf.ready && withRef.planHash !== noRef.planHash, '含参考方案 planHash 与无参考不同（参考进哈希 → 确认即执行）')
        check(JSON.stringify(withRef.pf.execution?.refs) === JSON.stringify(refs), '预检执行快照携带 refs（PreparedRecipe 随之哈希）')

        const { runId } = await confirmCreation(withRef.sessionId, { planRevision: 1, planHash: withRef.planHash!, idempotencyKey: `hg${Date.now()}`, acceptUnpriced: false })
        const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
        const recipe = recipeOf(run)!
        check(recipe.refs.length === 1 && recipe.refs[0]!.assetId === att.assetId, '确认后 run.recipe 冻结参考素材')
        check(await errOf(() => assertRecipeSources(run, recipe)) === null, '未篡改时来源核验通过（含参考）')

        const refAsset = (await db.select().from(assets).where(eq(assets.id, att.assetId)))[0]!
        writeFileSync(absPathOf(refAsset.relPath!), Buffer.concat([PNG_1X1, Buffer.from('tampered-extra-bytes')]))
        const tamper = await errOf(() => assertRecipeSources(run, recipe))
        check(!!tamper && /内容已变化/.test(tamper.message), '参考文件被改写 → 执行前停机（不静默消费新素材）')
        writeFileSync(absPathOf(refAsset.relPath!), PNG_1X1)

        await db.update(assets).set({ deletedAt: Date.now() }).where(eq(assets.id, att.assetId))
        const del = await errOf(() => assertRecipeSources(run, recipe))
        check(!!del && /不存在|已删除/.test(del.message), '参考资产被软删 → 执行前停机')
        await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, att.assetId))

        const foreign = await mkProject('m31-hg-foreign')
        await db.update(assets).set({ projectId: foreign }).where(eq(assets.id, att.assetId))
        const moved = await errOf(() => assertRecipeSources(run, recipe))
        check(!!moved && /不属于本项目/.test(moved.message), '参考资产被移出本项目 → 执行前停机（拒绝跨项目引用）')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ================= capability：不静默降级 / 不假称理解 / 能力 blocker / 成本可见 =================
    capability: async () => {
      const { compileReferenceContext } = await import('../src/services/creation-chat/planning')
      const { preflightPlan } = await import('../src/services/creation-chat/preflight')
      const { creationPlanSchema, refSchema } = await import('../src/services/creation-chat/contract')
      const issue = async (pid: number, mode: 'dynamic' | 'slideshow', refs: unknown[]): Promise<string> => (await preflightPlan(pid, creationPlanSchema.parse(makePlan(mode, refs)))).issues[0]?.code ?? ''

      await seedEndpoints()
      const pid = await mkProject('m31-cap')
      const imgRef = refSchema.parse({ assetId: 901, kind: 'image', role: 'subject', hash: 'a'.repeat(64) })
      const vidRef = refSchema.parse({ assetId: 902, kind: 'video', role: 'content', hash: 'b'.repeat(64) })

      const msgs = await compileReferenceContext(pid, [imgRef], false)
      const text = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('')
      check(msgs.length === 1 && typeof msgs[0]!.content === 'string' && /不会描述|未声明视觉/.test(text), '无视觉实例：图片参考明告「不描述内容、仅作生成参考」（不假称理解）')

      check(await codeOf(() => compileReferenceContext(pid, [vidRef], false)) === 'video_analysis_unavailable', '无视觉实例的参考视频 → video_analysis_unavailable（不跳过不编造）')

      const t2vCaps = { model: 'Wan2.2-T2V-A14B', verified: true, modes: ['t2v'], durations: [10], aspectRatios: ['9:16'], resolution: '720p' }
      await seedEndpoints({ videoCaps: t2vCaps, videoModel: 'Wan2.2-T2V-A14B' })
      const ffRef = refSchema.parse({ assetId: 903, kind: 'image', role: 'first_frame', hash: 'c'.repeat(64) })
      check(await issue(pid, 'dynamic', [ffRef]) === 'first_frame_unsupported', '含首帧参考但能力非 i2v → first_frame_unsupported（不改文生）')
      check(await issue(pid, 'dynamic', [imgRef]) === 'ref_image_unsupported', '含图片参考但动态文生无图像实例 → ref_image_unsupported（不静默忽略）')

      await seedEndpoints()
      const pfCost = await preflightPlan(pid, creationPlanSchema.parse(makePlan('slideshow', [vidRef, imgRef])))
      check(pfCost.ready && pfCost.estimate.refCount === 2 && pfCost.estimate.videoAnalysisCount === 1, '预检 estimate 计入参考数量与视频解析数')
      check(pfCost.estimate.unpriced.some((u) => u.includes('参考视频解析')), '参考视频解析列入未计价项（不按零元，须显式接受）')
    },

    // ================= bgm：严格合成窄口径 opt-in（有 role:'bgm' 才混音、默认无 BGM） =================
    bgm: async () => {
      const { db } = await import('../src/db')
      const { assets, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { createStepContext } = await import('../src/pipeline/context')
      const { subtitle } = await import('../src/pipeline/actions/subtitle')
      const { ffmpegMerge } = await import('../src/pipeline/actions/ffmpeg-merge')
      const { recipeOf, refContentHash } = await import('../src/services/creation-chat/recipe')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { addAttachment } = await import('../src/services/creation-chat/attachments')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      engine.engine.startRun = ((runId: number): 'started' => { void runId; return 'started' }) as typeof engine.engine.startRun

      const tmpl = loadTemplate('easy-video')
      const defCap = tmpl.steps.find((s) => s.action === 'subtitle')!
      const defCompose = tmpl.steps.find((s) => s.action === 'ffmpeg_merge')!

      const composeFinal = async (runId: number, projectId: number, recipe: NonNullable<ReturnType<typeof recipeOf>>): Promise<number> => {
        const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!
        const voices: number[] = []
        for (const line of recipe.plan.lines) voices.push(await genMedia(projectId, 'voice', line.id, 1.2, runId, { lineId: line.id }))
        const shots: number[] = []
        for (const shot of recipe.plan.shots) shots.push(await genMedia(projectId, 'image', shot.id, shot.duration, runId, { shotId: shot.id }))
        const s1 = (await db.insert(pipelineSteps).values({ runId, seq: 900, stepKey: 'captions', actionKey: 'subtitle', title: 'captions', status: 'running', createdAt: Date.now(), updatedAt: Date.now() }).returning())[0]!
        const ctx1 = await createStepContext({ run, step: s1, template: tmpl, def: defCap, input: { lines: [recipe.sources[1].id], voices }, projectSettings: {} })
        const srtId = (await subtitle(ctx1)).assetIds[0]!
        const s2 = (await db.insert(pipelineSteps).values({ runId, seq: 901, stepKey: 'compose', actionKey: 'ffmpeg_merge', title: 'compose', status: 'running', createdAt: Date.now(), updatedAt: Date.now() }).returning())[0]!
        const ctx2 = await createStepContext({ run, step: s2, template: tmpl, def: defCompose, input: { shots: [recipe.sources[2].id], images: shots, voices, subtitle: [srtId] }, projectSettings: {} })
        return (await ffmpegMerge(ctx2)).assetIds[0]!
      }

      try {
        await seedEndpoints()
        // 默认无 BGM：slideshow 无 bgm ref → params.bgm=null
        const plain = await makeReadySession('slideshow')
        const plainRun = await confirmCreation(plain.sessionId, { planRevision: 1, planHash: plain.planHash!, idempotencyKey: `bgmnone${Date.now()}`, acceptUnpriced: false })
        const plainRecipe = recipeOf((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, plainRun.runId)))[0]!)!
        const plainAsset = (await db.select().from(assets).where(eq(assets.id, await composeFinal(plainRun.runId, plain.projectId, plainRecipe))))[0]!
        check(plainAsset.purpose === 'final_video' && JSON.parse(plainAsset.params ?? '{}').bgm === null, '严格合成默认无 BGM：params.bgm=null（不违反 M30「不生成 BGM」）')

        // BGM opt-in：用户上传音轨 → 附件资产落本会话项目 → 方案含 role:'bgm' ref → 混入
        const bgmProject = await mkProject('m31-bgm')
        const bgmSess = await mkSession(bgmProject)
        const bgmAbs = await genMediaAbs(bgmProject, 'voice', 'theme', 3)
        const att = await addAttachment(bgmSess, { name: 'theme.mp3', data: new Uint8Array(readFileSync(bgmAbs)) }, 'bgm')
        const row = (await db.select().from(assets).where(eq(assets.id, att.assetId)))[0]!
        const ref = [{ assetId: att.assetId, kind: 'audio' as const, role: 'bgm' as const, hash: await refContentHash({ relPath: row.relPath! }) }]
        const withBgm = await makeReadySession('slideshow', ref)
        await db.update(assets).set({ projectId: withBgm.projectId }).where(eq(assets.id, att.assetId))
        const bgmRun = await confirmCreation(withBgm.sessionId, { planRevision: 1, planHash: withBgm.planHash!, idempotencyKey: `bgmon${Date.now()}`, acceptUnpriced: false })
        const bgmRecipe = recipeOf((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, bgmRun.runId)))[0]!)!
        const bgmAsset = (await db.select().from(assets).where(eq(assets.id, await composeFinal(bgmRun.runId, withBgm.projectId, bgmRecipe))))[0]!
        const bgmParam = JSON.parse(bgmAsset.params ?? '{}').bgm
        check(!!bgmParam && bgmParam.asset_id === att.assetId && (bgmAsset.tags ?? '').includes('with_audio'), '方案批准 role:bgm → 严格合成混入该用户上传音轨（params.bgm 记录来源）')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },

    // ================= firstframe：首帧参考冻结 → 解析首帧资产 + i2v 严格合成可解码 MP4 =================
    firstframe: async () => {
      const { db } = await import('../src/db')
      const { assets, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { createStepContext } = await import('../src/pipeline/context')
      const { subtitle } = await import('../src/pipeline/actions/subtitle')
      const { ffmpegMerge } = await import('../src/pipeline/actions/ffmpeg-merge')
      const { recipeOf, recipeFirstFrameId, recipeRefImageIds, refContentHash } = await import('../src/services/creation-chat/recipe')
      const { assertStrictOutput } = await import('../src/pipeline/actions/ffmpeg-merge/strict')
      const { probeMediaDuration } = await import('../src/services/ffmpeg')
      const { absPathOf } = await import('../src/services/storage')
      const { confirmCreation } = await import('../src/services/creation-chat/execution')
      const { addAttachment } = await import('../src/services/creation-chat/attachments')
      const engine = await import('../src/pipeline/engine')
      const origStart = engine.engine.startRun.bind(engine.engine)
      engine.engine.startRun = ((runId: number): 'started' => { void runId; return 'started' }) as typeof engine.engine.startRun

      const fake = (refs: Array<{ assetId: number; kind: 'image'; role: string; hash: string; shotId?: string }>) => ({ refs }) as never
      check(recipeFirstFrameId(fake([{ assetId: 5, kind: 'image', role: 'first_frame', hash: 'a'.repeat(64), shotId: 'x' }, { assetId: 9, kind: 'image', role: 'first_frame', hash: 'b'.repeat(64) }]), 'x') === 5, '首帧解析：shot 级 first_frame 优先于全局')
      check(recipeFirstFrameId(fake([{ assetId: 9, kind: 'image', role: 'first_frame', hash: 'b'.repeat(64) }]), 'x') === 9, '无 shot 级首帧时回退全局 first_frame（shotId=null）')
      check(recipeFirstFrameId(fake([{ assetId: 7, kind: 'image', role: 'subject', hash: 'd'.repeat(64) }]), 'x') === null, '非 first_frame 角色不作为首帧（不误当首帧降级）')
      check(recipeRefImageIds(fake([{ assetId: 3, kind: 'image', role: 'subject', hash: 'e'.repeat(64), shotId: 's1' }, { assetId: 4, kind: 'image', role: 'subject', hash: 'f'.repeat(64), shotId: 's2' }]), 's1', ['subject']).join() === '3', '本镜参考图按 shotId 命中（他镜参考不越界注入）')

      try {
        await seedEndpoints()
        // 附件先落临时会话项目，再迁移到 dynamic ready 会话项目（与 hashguard/bgm 同法，旁路重算）
        const scratch = await mkProject('m31-ff-scratch')
        const scratchSess = await mkSession(scratch)
        const att = await addAttachment(scratchSess, { name: 'first.png', data: PNG_1X1 }, 'first_frame')
        const row = (await db.select().from(assets).where(eq(assets.id, att.assetId)))[0]!
        const refs = [{ assetId: att.assetId, kind: 'image' as const, role: 'first_frame' as const, hash: refContentHash({ relPath: row.relPath! }), shotId: 's1' }]
        const session = await makeReadySession('dynamic', refs)
        await db.update(assets).set({ projectId: session.projectId }).where(eq(assets.id, att.assetId))
        check(session.pf.ready && session.pf.execution?.videoMode === 'i2v', 'i2v 方案含首帧参考：预检就绪且 videoMode=i2v（不降级文生）')
        const run = await confirmCreation(session.sessionId, { planRevision: 1, planHash: session.planHash!, idempotencyKey: `ff${Date.now()}`, acceptUnpriced: false })
        const rr = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.runId)))[0]!
        const recipe = recipeOf(rr)!
        check(recipeFirstFrameId(recipe, 's1') === att.assetId && recipeFirstFrameId(recipe, 's2') === null, '首帧参考冻结进方案并按镜解析为 i2v 首帧资产 id')

        const tmpl = loadTemplate('easy-video')
        const defCap = tmpl.steps.find((s) => s.action === 'subtitle')!
        const defCompose = tmpl.steps.find((s) => s.action === 'ffmpeg_merge')!
        const voices: number[] = []
        for (const line of recipe.plan.lines) voices.push(await genMedia(session.projectId, 'voice', line.id, 1.2, run.runId, { lineId: line.id }))
        const clips: number[] = []
        for (const shot of recipe.plan.shots) clips.push(await genMedia(session.projectId, 'video', shot.id, shot.duration, run.runId, { shotId: shot.id }))
        const s1 = (await db.insert(pipelineSteps).values({ runId: run.runId, seq: 900, stepKey: 'captions', actionKey: 'subtitle', title: 'captions', status: 'running', createdAt: Date.now(), updatedAt: Date.now() }).returning())[0]!
        const ctx1 = await createStepContext({ run: rr, step: s1, template: tmpl, def: defCap, input: { lines: [recipe.sources[1].id], voices }, projectSettings: {} })
        const srtId = (await subtitle(ctx1)).assetIds[0]!
        const s2 = (await db.insert(pipelineSteps).values({ runId: run.runId, seq: 901, stepKey: 'compose', actionKey: 'ffmpeg_merge', title: 'compose', status: 'running', createdAt: Date.now(), updatedAt: Date.now() }).returning())[0]!
        const ctx2 = await createStepContext({ run: rr, step: s2, template: tmpl, def: defCompose, input: { shots: [recipe.sources[2].id], motion_clips: clips, voices, subtitle: [srtId] }, projectSettings: {} })
        const finalAsset = (await db.select().from(assets).where(eq(assets.id, (await ffmpegMerge(ctx2)).assetIds[0]!)))[0]!
        let decodable = true
        try { assertStrictOutput(absPathOf(finalAsset.relPath!), recipe.plan.duration) } catch { decodable = false }
        check(decodable && Math.abs((probeMediaDuration(absPathOf(finalAsset.relPath!)) ?? 0) - 30) <= 0.15, '首帧参考进入 i2v 严格合成链后仍产出可解码 MP4（≈30s，含音轨）')
      } finally {
        engine.engine.startRun = origStart as typeof engine.engine.startRun
      }
    },
  }

  // 生成素材文件并返回绝对路径（供 addAttachment 读取字节）
  async function genMediaAbs(projectId: number, kind: 'voice', id: string, durSec: number): Promise<string> {
    const { ensureProjectDirs, relPathOf, absPathOf } = await import('../src/services/storage')
    const { resolveFfmpeg } = await import('../src/services/ffmpeg')
    ensureProjectDirs(projectId)
    const rel = relPathOf(projectId, 'source', `${id}-${Date.now()}.mp3`)
    const abs = absPathOf(rel)
    const r = spawnSync(resolveFfmpeg()!, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(durSec), '-q:a', '4', abs], { encoding: 'utf8', timeout: 120000, windowsHide: true })
    if (r.status !== 0) throw new Error(`探针生成 BGM 失败: ${(r.stderr ?? '').slice(-200)}`)
    return abs
  }

  await runSections({ log, title: 'M31', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
