/**
 * M6 探针（参考图驱动：asset-ref / 能力声明 / 首帧匹配 / 降级路径 / 契约参数位）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m6.ts [--section=asset-ref|capability|match|degrade|contract]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3/m4）。零网络、零计费。
 *
 * section（默认 all）：
 *   asset-ref  资产图 → data URI：mime 链 / 8MB 守卫 / 缺文件与非图报错 / step 级缓存（删源文件复测）
 *   capability 适配器能力声明矩阵：图片 7 家 / 视频 5 家（声明必须与实现一致）
 *   match      buildFirstFrameIndex（shotId 匹配，非图/损坏行跳过）+ pickPromptText（prompt_field 回退链）
 *   degrade    none 家请求形态：referenceImages / firstFrameUrl 均不注入（降级路径的请求面覆盖）
 *   contract   端点解析与参数位：gemini 参考图透传 + apiKey 解析；pollinations 首/尾帧字段就位
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m6-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['asset-ref', 'capability', 'match', 'degrade', 'contract'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { apiConfigs, assets, projects } = await import('../src/db/schema')

  const log = createLogger('probe-m6')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const errOf = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn()
      return null
    } catch (err) {
      return err
    }
  }

  // ---- setup：隔离库 + 种子（api_configs 三家 / 密钥 env / 项目行） ----
  await initDb()
  process.env.PROBE_M6_KEY = 'probe-m6-key'
  const t0 = Date.now()
  const cfg = (providerKey: string, serviceType: string, isDefault: number, priority: number) => ({
    providerKey,
    serviceType,
    name: `probe-${providerKey}`,
    baseUrl: 'http://127.0.0.1:9', // 仅解析用，不发起请求（零网络）
    apiKeyRef: 'env:PROBE_M6_KEY',
    extra: '{}',
    pricing: '{}',
    priority,
    isDefault,
    isActive: 1,
    createdAt: t0,
    updatedAt: t0,
  })
  await db.insert(apiConfigs).values([
    cfg('gemini_image', 'image', 1, 0),
    cfg('pollinations_image', 'image', 0, 5),
    cfg('pollinations_video', 'video', 1, 0),
  ])
  const pid = (
    await db
      .insert(projects)
      .values({ name: 'M6 探针项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: t0, updatedAt: t0 })
      .returning()
  )[0]!.id

  // ================= sections =================

  const sectionAssetRef = async (): Promise<void> => {
    const { MAX_REF_IMAGE_BYTES, assetToDataUri } = await import('../src/services/asset-ref')
    const { absPathOf, ensureProjectDirs, registerAsset, relPathOf } = await import('../src/services/storage')
    ensureProjectDirs(pid)

    // 小 PNG：PNG 魔数 8 字节（转换不校验内容，仅验证链路）
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex')
    const rel = relPathOf(pid, 'shot_image', 'probe-ref.png')
    writeFileSync(absPathOf(rel), pngBytes)
    const a1 = await registerAsset(pid, {
      kind: 'image',
      purpose: 'shot_image',
      name: 'probe-ref.png',
      relPath: rel,
      mime: 'image/png',
      ext: 'png',
      fileSize: pngBytes.byteLength,
    })

    const uri1 = await assetToDataUri(a1.id)
    check(uri1.startsWith('data:image/png;base64,'), `URI 前缀 data:image/png;base64,（${uri1.slice(0, 30)}…）`)
    check(uri1 === `data:image/png;base64,${pngBytes.toString('base64')}`, 'base64 载荷与源文件一致')

    // mime 链：行 mime 缺失 + ext='png' → 扩展名推断
    const a2 = await registerAsset(pid, {
      kind: 'image',
      purpose: 'shot_image',
      name: 'probe-ref-2.png',
      relPath: rel,
      ext: 'png',
      fileSize: pngBytes.byteLength,
    })
    check((await assetToDataUri(a2.id)).startsWith('data:image/png;base64,'), 'mime 缺失 + ext=png → image/png')

    // mime/ext 均空 → 从 relPath 后缀推断
    const a3 = await registerAsset(pid, { kind: 'image', purpose: 'shot_image', name: 'probe-ref-3.png', relPath: rel, fileSize: pngBytes.byteLength })
    check((await assetToDataUri(a3.id)).startsWith('data:image/png;base64,'), 'mime/ext 均空 → relPath 后缀推断')

    // 8MB 守卫
    const big = Buffer.alloc(MAX_REF_IMAGE_BYTES + 1, 0)
    const bigRel = relPathOf(pid, 'shot_image', 'probe-big.png')
    writeFileSync(absPathOf(bigRel), big)
    const a4 = await registerAsset(pid, { kind: 'image', purpose: 'shot_image', name: 'probe-big.png', relPath: bigRel, mime: 'image/png', ext: 'png' })
    const e4 = await errOf(() => assetToDataUri(a4.id))
    check(e4 instanceof Error && /超上限 8MB/.test(e4.message), `8MB 守卫抛错（${e4 instanceof Error ? e4.message : '未抛'}）`)

    // 缺文件（relPath 指向不存在）
    const missingRel = relPathOf(pid, 'shot_image', 'not-exist.png')
    const a5 = await registerAsset(pid, { kind: 'image', purpose: 'shot_image', name: 'not-exist.png', relPath: missingRel, mime: 'image/png', ext: 'png' })
    const e5 = await errOf(() => assetToDataUri(a5.id))
    check(e5 instanceof Error, `缺文件抛错（${e5 instanceof Error ? (e5 as Error).message.slice(0, 60) : '未抛'}）`)

    // 非图 kind='text'
    const textBytes = new TextEncoder().encode('hello m6')
    const textRel = relPathOf(pid, 'script', 'probe-note.md')
    writeFileSync(absPathOf(textRel), textBytes)
    const a6 = await registerAsset(pid, { kind: 'text', purpose: 'script', name: 'probe-note.md', relPath: textRel, mime: 'text/markdown', ext: 'md' })
    const e6 = await errOf(() => assetToDataUri(a6.id))
    check(e6 instanceof Error && /非图片/.test(e6.message), `非图抛错（${e6 instanceof Error ? e6.message : '未抛'}）`)

    // 缓存：成功转换 → 删源文件 → 带同一 cache 再调 → 成功且同值（证明未重复读盘）
    const cache = new Map<number, string>()
    const c1 = await assetToDataUri(a1.id, cache)
    rmSync(absPathOf(rel))
    const c2 = await assetToDataUri(a1.id, cache)
    check(c1 === c2 && c2 === uri1 && c2.startsWith('data:image/png'), '缓存命中：删源文件后仍返回同值（未重复读盘）')
  }

  const sectionCapability = async (): Promise<void> => {
    const { getImageAdapter } = await import('../src/adapters/provider')
    const { getVideoAdapter } = await import('../src/adapters/video')
    const img = (k: string): string => getImageAdapter(k).referenceImages ?? 'none'
    check(
      ['gemini_image', 'volcengine_image', 'aliyun_bailian_image'].every((k) => img(k) === 'base64'),
      `图片 base64 组：gemini / volcengine / aliyun_bailian（${['gemini_image', 'volcengine_image', 'aliyun_bailian_image'].map((k) => `${k}=${img(k)}`).join(' ')}）`,
    )
    check(
      ['openai_image', 'siliconflow_image', 'pollinations_image'].every((k) => img(k) === 'none'),
      '图片 none 组：openai / siliconflow / pollinations',
    )
    const vid = (k: string): string => getVideoAdapter(k).firstFrame ?? 'none'
    check(
      ['minimax_video', 'siliconflow_video', 'aliyun_bailian_video'].every((k) => vid(k) === 'base64'),
      '视频 base64 组：minimax / siliconflow / aliyun_bailian',
    )
    check(
      ['base64', 'as-reference'].includes(vid('volcengine_video')),
      `volcengine_video 首帧 ∈ {base64, as-reference}（实际 ${vid('volcengine_video')}；实弹对表后可收紧）`,
    )
    check(vid('pollinations_video') === 'none', '视频 none 组：pollinations')
  }

  const sectionMatch = async (): Promise<void> => {
    const { buildFirstFrameIndex, pickPromptText } = await import('../src/pipeline/actions/ai-video')
    const t = Date.now()
    const mk = async (kind: string, params: string | null): Promise<number> =>
      (
        await db
          .insert(assets)
          .values({ projectId: pid, kind, name: `m6-${kind}-${t}-${Math.random().toString(36).slice(2, 6)}.bin`, tags: '[]', params, createdAt: t, updatedAt: t })
          .returning()
      )[0]!.id
    const i1 = await mk('image', JSON.stringify({ shotId: 's01' }))
    const i2 = await mk('image', JSON.stringify({ shotId: 's02' }))
    const v3 = await mk('video', JSON.stringify({ shotId: 's03' }))
    const broken = await mk('image', '{损坏')

    const index = await buildFirstFrameIndex([i1, i2, v3, broken])
    check(index.size === 2, `size=2（实际 ${index.size}）`)
    check(index.get('s01') === i1 && index.get('s02') === i2, '映射正确（s01→image#1 / s02→image#2）')
    check(index.get('s03') === undefined, '非图行跳过（s03 未映射）')
    check((await buildFirstFrameIndex([])).size === 0, '空入参 → 空 Map')

    check(pickPromptText({ image_prompt: 'A' }, ['motion_prompt', 'image_prompt']) === 'A', '回退：无 motion_prompt → image_prompt')
    check(pickPromptText({ motion_prompt: 'M', image_prompt: 'A' }, ['motion_prompt', 'image_prompt']) === 'M', '优先：motion_prompt 非空 → M')
    check(pickPromptText({ motion_prompt: '  ', image_prompt: '' }, ['motion_prompt', 'image_prompt']) === '', '双空 → 空串')
  }

  const sectionDegrade = async (): Promise<void> => {
    const { buildImageRequest, getImageAdapter } = await import('../src/adapters/provider')
    const { buildVideoRequest } = await import('../src/adapters/video')
    check((getImageAdapter('pollinations_image').referenceImages ?? 'none') === 'none', 'none 家声明复核（pollinations_image）')
    const r1 = await buildImageRequest({ prompt: 'p', provider: 'pollinations_image' })
    check(r1.request.referenceImages === undefined, 'none 家 buildImageRequest 不带 referenceImages（降级请求面）')
    const r2 = await buildVideoRequest({ prompt: 'p', provider: 'pollinations_video' })
    check(r2.request.firstFrameUrl === undefined && r2.request.lastFrameUrl === undefined, 'none 家 buildVideoRequest 不带首/尾帧（降级请求面）')
  }

  const sectionContract = async (): Promise<void> => {
    const { buildImageRequest } = await import('../src/adapters/provider')
    const { buildVideoRequest } = await import('../src/adapters/video')
    const uri = 'data:image/png;base64,AAAA'
    const r1 = await buildImageRequest({ prompt: 'p', provider: 'gemini_image', referenceImages: [uri] })
    check(r1.adapter.provider === 'gemini_image', `adapter.provider=gemini_image（实际 ${r1.adapter.provider}）`)
    check(r1.request.referenceImages?.length === 1 && r1.request.referenceImages[0] === uri, 'request.referenceImages 就位（透传）')
    check(r1.request.apiKey === 'probe-m6-key', `apiKey 经 env:PROBE_M6_KEY 解析（${r1.request.apiKey ? '有值' : '空'}）`)
    check(r1.request.baseUrl === 'http://127.0.0.1:9', 'baseUrl 取实例配置')

    const r2 = await buildVideoRequest({ prompt: 'p', provider: 'pollinations_video', firstFrameUrl: uri, lastFrameUrl: uri })
    check(r2.request.firstFrameUrl === uri && r2.request.lastFrameUrl === uri, 'buildVideoRequest 首/尾帧参数位透传（VideoGenRequest 契约）')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    'asset-ref': sectionAssetRef,
    capability: sectionCapability,
    match: sectionMatch,
    degrade: sectionDegrade,
    contract: sectionContract,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of (wanted === 'all' ? SECTIONS : [wanted]) as readonly string[]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M6 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch {
      /* 已关闭或未初始化 */
    }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
