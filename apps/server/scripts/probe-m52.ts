/**
 * M52 离线探针：全局素材池（全局实体挂参考图放开）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m52.ts [--section=pool|channels|inject|sync]
 *
 * 隔离策略：isolatedEnv('m52') 一次性临时目录（独立 studio.db + workspace），必须在任何 src 动态 import 前调用。
 * 零网络：AGENT_LLM_* 指向假端点 + globalThis.fetch 常驻 stub（scheduleImageCheck 等后台任务落 stub 不外发）。
 *
 * 断言面（spec docs/milestones.md M52）：
 *  - pool     GET/POST /global/assets（虚拟项目 #0）：入库 project_id=0 / purpose 白名单 / sha256 复用 /
 *             非图·非法 purpose·空表单 400 / 列表与 kind·purpose 过滤 / 项目资产列表不泄露池；
 *  - channels 五通道挂图守卫 assertRefAssetsForScope：POST/PUT entities 全局挂池 201·200、挂项目资产 400、
 *             非法 id 400、项目行挂池 400（挂图通道不放行池→项目）；同名遮蔽：attachRefAssets(null) 仅命中全局行；
 *  - inject   assetToDataUri 收口唯一例外：池资产对任意项目放行、项目私有资产跨项目依旧拒、缓存复用；
 *  - sync     character_sync / entity_sync 全局分支（project:false）：仅消费池资产挂全局行，
 *             同名项目行不遮蔽、项目 ref_images 不越界；幂等重跑 refAttached=0。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m52')

// 假 LLM 端点 + fetch stub 常驻（必须先于任何 src import：env 单量首载固化）
process.env.AGENT_LLM_BASE_URL = 'http://probe-m52.local/v1'
process.env.AGENT_LLM_API_KEY = 'probe-key'
process.env.AGENT_LLM_MODEL = 'probe-model'
globalThis.fetch = (async () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m52')
const checker: Checker = makeChecker(log)
const check = checker.check

const T0 = 1_700_000_000_000

/** 各分节共享的动态导入（模块缓存，重复 import 零成本） */
async function mod() {
  const { db, initDb } = await import('../src/db')
  const schema = await import('../src/db/schema')
  const orm = await import('drizzle-orm')
  const { app } = await import('../src/app')
  const storage = await import('../src/services/storage')
  return { db, initDb, schema, orm, app, storage }
}

/** 直插项目行（绕业务面，探针专用） */
async function mkProject(db: Awaited<ReturnType<typeof mod>>['db'], name: string): Promise<number> {
  const { projects } = await import('../src/db/schema')
  const [p] = await db
    .insert(projects)
    .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()
  return p!.id
}

await runSections({
  log,
  title: 'M52',
  checker,
  sections: ['pool', 'channels', 'inject', 'sync'] as const,
  cleanup,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成（零真实执行、零真实外发）')
  },
  runners: {
    // ============ ① 池基建：/global/assets 列表与上传 ============
    pool: async () => {
      const { db, app, storage } = await mod()
      const { assets } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { existsSync } = await import('node:fs')
      const pid = await mkProject(db, 'm52-pool')

      const post = async (files: Array<[string, string]>, purpose?: string): Promise<{ status: number; body: any }> => {
        const form = new FormData()
        if (purpose !== undefined) form.append('purpose', purpose)
        for (const [name, text] of files) form.append('file', new File([text], name, { type: 'image/png' }))
        const res = await app.request('/api/v1/global/assets', { method: 'POST', body: form })
        let json: any = null
        try {
          json = await res.json()
        } catch {
          /* 非 JSON */
        }
        return { status: res.status, body: json }
      }

      const up = await post([['池图一.png', 'm52-pool-1'], ['池图二.png', 'm52-pool-2']], 'reference_character')
      check(up.status === 201 && up.body?.items?.length === 2, `池批量上传 → 201 两张（实际 ${up.status}）`)
      const ids: number[] = (up.body?.items ?? []).map((a: any) => a.id)
      const row1 = (await db.select().from(assets).where(eq(assets.id, ids[0]!)))[0]!
      check(
        row1.projectId === 0 && row1.purpose === 'reference_character' && row1.kind === 'image',
        `池行 project_id=0 + purpose + kind（实际 ${row1.projectId}/${row1.purpose}/${row1.kind}）`,
      )
      check(!!row1.relPath && existsSync(storage.absPathOf(row1.relPath)), '池文件真实落盘（PROJECTS_DIR/0/…）')
      check(up.body?.items?.[0]?.urls?.file === `/api/v1/assets/${ids[0]}/file`, '池资产视图 toAssetView 结构')

      // sha256 复用：同字节重传 → 同一行
      const dup = await post([['池图一.png', 'm52-pool-1']], 'reference_character')
      check(dup.status === 201 && dup.body?.items?.[0]?.id === ids[0], '同字节复用池原行（sha256 去重）')

      // purpose 缺省 = source；白名单外/非图/空表单 → 400
      const up3 = await post([['池图三.png', 'm52-pool-3']])
      const row3 = (await db.select().from(assets).where(eq(assets.id, up3.body?.items?.[0]?.id)))[0]!
      check(up3.status === 201 && row3.purpose === 'source', `purpose 缺省 source（实际 ${row3.purpose}）`)
      const badPurpose = await post([['x.png', 'm52-bad-purpose']], 'final_video')
      check(badPurpose.status === 400 && badPurpose.body?.error?.code === 'bad_purpose', `白名单外 purpose → 400 bad_purpose（${badPurpose.status}）`)
      const notImg = await post([['note.txt', 'hello']])
      check(notImg.status === 400 && notImg.body?.error?.code === 'not_image', `非图片 → 400 not_image（${notImg.status}）`)
      const empty = await post([])
      check(empty.status === 400 && empty.body?.error?.code === 'no_files', `空表单 → 400 no_files（${empty.status}）`)

      // 列表 + 过滤
      const list = await (await app.request('/api/v1/global/assets')).json()
      check(list?.total === 3 && list.items.every((a: any) => a.projectId === 0), `池列表 3 行且全属池（实际 ${list?.total}）`)
      const byPurpose = await (await app.request('/api/v1/global/assets?purpose=reference_character')).json()
      check(byPurpose?.total === 2 && byPurpose.items.every((a: any) => a.id !== up3.body?.items?.[0]?.id), 'purpose 过滤（reference_character 2 张）')
      const byKind = await (await app.request('/api/v1/global/assets?kind=text')).json()
      check(byKind?.total === 0, 'kind 过滤（池内无 text → 空集）')

      // 项目资产列表不泄露池
      const plist: any = await (await app.request(`/api/v1/projects/${pid}/assets`)).json()
      const pItems: any[] = plist?.items ?? []
      check(!ids.some((id) => pItems.some((a) => a.id === id)), '项目资产列表不含池行（池不进项目列表）')
    },

    // ============ ② 五通道挂图守卫（POST/PUT entities + 同名遮蔽） ============
    channels: async () => {
      const { db, app, storage } = await mod()
      const { characters } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { attachRefAssets } = await import('../src/services/character')
      const pid = await mkProject(db, 'm52-channels')
      const [poolA] = await storage.importFiles(0, [{ name: '挂图甲.png', data: new TextEncoder().encode('m52-ch-a') }], { purpose: 'reference_character' })
      const [poolB] = await storage.importFiles(0, [{ name: '挂图乙.png', data: new TextEncoder().encode('m52-ch-b') }], { purpose: 'reference_character' })
      const [ownP] = await storage.importFiles(pid, [{ name: '项目图.png', data: new TextEncoder().encode('m52-ch-own') }], { purpose: 'reference_character' })

      const jreq = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
        const res = await app.request(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        let json: any = null
        try {
          json = await res.json()
        } catch {
          /* 非 JSON */
        }
        return { status: res.status, body: json }
      }

      // POST 新建全局挂池
      const g1 = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '全局挂池角色', ref_asset_ids: [poolA!.id] })
      check(
        g1.status === 201 && g1.body?.entity?.scope === 'global' && g1.body?.entity?.refAssetIds?.join(',') === String(poolA!.id),
        `POST 全局挂池 → 201 落库（实际 ${g1.status}）`,
      )
      check(g1.body?.entity?.refAssetIds?.length === 1, 'POST 全局挂池：refAssetIds 含池资产')
      // 创建视图不带 refAssets（既有口径）；缩略渲染面经 GET 详情验证
      const gView = await jreq('GET', `/api/v1/entities/${g1.body?.entity?.id}`)
      check(gView.body?.entity?.refAssets?.[0]?.urls?.thumb?.startsWith('/api/v1/assets/'), 'GET 详情含池缩略（全局挂图有渲染入口）')

      // POST 全局挂项目资产 → 400（点名全局素材池）
      const gBad = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '全局越界角色', ref_asset_ids: [ownP!.id] })
      check(
        gBad.status === 400 && gBad.body?.error?.code === 'bad_ref_assets' && String(gBad.body?.error?.message).includes('全局素材池'),
        `POST 全局挂项目资产 → 400 池口径文案（${gBad.status}）`,
      )
      // POST 非法 id → 400
      const gNum = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '全局非法 id', ref_asset_ids: [0] })
      check(gNum.status === 400 && gNum.body?.error?.code === 'bad_ref_assets', 'POST 非法资产 id → 400 bad_ref_assets')

      // PUT 替换语义
      const g2 = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '全局更新靶' })
      const gid: number = g2.body.entity.id
      const put1 = await jreq('PUT', `/api/v1/entities/${gid}`, { ref_asset_ids: [poolA!.id, poolB!.id] })
      check(put1.status === 200 && put1.body?.entity?.refAssetIds?.join(',') === `${poolA!.id},${poolB!.id}`, 'PUT 全局挂两张池图 → 200 替换落库')
      const put2 = await jreq('PUT', `/api/v1/entities/${gid}`, { ref_asset_ids: [ownP!.id] })
      check(put2.status === 400, 'PUT 全局挂项目资产 → 400')
      const detail = await jreq('GET', `/api/v1/entities/${gid}`)
      check(detail.body?.entity?.refAssetIds?.join(',') === `${poolA!.id},${poolB!.id}`, '越界 PUT 被拒后原挂接不动（零副作用）')

      // 项目行挂池 → 400（挂图通道不放行池→项目；池例外仅在注入收口）
      const pE = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '项目挂图角色', project_id: pid })
      const pPut = await jreq('PUT', `/api/v1/entities/${pE.body.entity.id}`, { ref_asset_ids: [poolA!.id] })
      check(pPut.status === 400 && pPut.body?.error?.code === 'bad_ref_assets', '项目行挂池资产 → 400（挂图通道池不进项目）')

      // 同名遮蔽：全局行与项目行同名 → attachRefAssets(null 域) 仅命中全局行
      const gS = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '池影角色' })
      const pS = await jreq('POST', '/api/v1/entities', { kind: 'character', name: '池影角色', project_id: pid })
      const added = await attachRefAssets(null, '池影角色', [poolB!.id], 'character')
      const gRow = (await db.select().from(characters).where(eq(characters.id, gS.body.entity.id)))[0]!
      const pRow = (await db.select().from(characters).where(eq(characters.id, pS.body.entity.id)))[0]!
      check(
        added === 1 && gRow.refAssetIds === JSON.stringify([poolB!.id]) && pRow.refAssetIds === '[]',
        `同名遮蔽防护：null 域按名挂接仅落全局行（added=${added}）`,
      )
    },

    // ============ ③ 注入收口：assetToDataUri 池例外（唯一跨项目通道） ============
    inject: async () => {
      const { db, storage } = await mod()
      const { assetToDataUri } = await import('../src/services/asset-ref')
      const [pidA, pidB] = [await mkProject(db, 'm52-inj-a'), await mkProject(db, 'm52-inj-b')]
      const [pool] = await storage.importFiles(0, [{ name: '注入池图.png', data: new TextEncoder().encode('m52-inj-pool') }], { purpose: 'reference_character' })
      const [ownA] = await storage.importFiles(pidA, [{ name: '注入本图.png', data: new TextEncoder().encode('m52-inj-a') }], { purpose: 'reference_character' })
      const [privB] = await storage.importFiles(pidB, [{ name: '注入他图.png', data: new TextEncoder().encode('m52-inj-b') }], { purpose: 'reference_character' })

      const uriPool = await assetToDataUri(pool!.id, pidA)
      check(uriPool.startsWith('data:image/'), '池资产对项目 A 视角放行（跨项目注入唯一例外）')
      const uriOwn = await assetToDataUri(ownA!.id, pidA)
      check(uriOwn.startsWith('data:image/'), '本项目资产照旧放行（回归锁）')
      const errB = await assetToDataUri(privB!.id, pidA).catch((e: Error) => e)
      check(errB instanceof Error && errB.message.includes('跨项目引用被拒'), '项目私有资产跨项目依旧拒（隔离不放宽）')
      const errMiss = await assetToDataUri(999999, pidA).catch((e: Error) => e)
      check(errMiss instanceof Error && errMiss.message.includes('不存在'), '不存在资产 → 抛错（调用方跳图契约）')
      const cache = new Map<number, string>()
      const u1 = await assetToDataUri(pool!.id, pidA, cache)
      const u2 = await assetToDataUri(pool!.id, pidB, cache)
      check(cache.size === 1 && u1 === u2, 'cache 命中复用（同 id 同 URI，零重复读盘）')
    },

    // ============ ④ 模板动作全局分支：character_sync / entity_sync 仅消费池资产 ============
    sync: async () => {
      const { db, storage } = await mod()
      const { characters } = await import('../src/db/schema')
      const { eq, isNull } = await import('drizzle-orm')
      const { writeTextAsset } = storage
      const { upsertEntity } = await import('../src/services/character')
      const { readFileSync } = await import('node:fs')
      const { characterSync } = await import('../src/pipeline/actions/character-sync')
      const { entitySync } = await import('../src/pipeline/actions/entity-sync')
      const pid = await mkProject(db, 'm52-sync')

      // 手工 StepContext（动作仅消费 run/step/def/log/assetIdsOf/assetsOf/readText）
      const mkCtx = (params: Record<string, unknown>, inputs: Record<string, number[]>) =>
        ({
          run: { id: 0, projectId: pid },
          step: { id: 0 },
          def: { key: 'sync', params },
          log: () => {},
          assetIdsOf: (k: string) => inputs[k] ?? [],
          assetsOf: async (ids: number[]) => {
            const out = []
            for (const i of ids) {
              const rows = await db.select().from((await import('../src/db/schema')).assets)
              const r = rows.find((x) => x.id === i)
              if (r) out.push(r)
            }
            return out
          },
          readText: async (id: number) => {
            const rows = await db.select().from((await import('../src/db/schema')).assets)
            const r = rows.find((x) => x.id === id)
            return r?.relPath ? readFileSync(storage.absPathOf(r.relPath), 'utf8') : ''
          },
        }) as unknown as import('../src/pipeline/context').StepContext

      // 角色链：档案 + 池定妆照 + 同名项目定妆照（全局分支必须跳过后者）
      const charJson = await writeTextAsset(pid, {
        name: 'characters.json',
        content: JSON.stringify({ characters: [{ name: '图图', appearance: '圆脸胖萌男宝，虎头帽' }] }),
        purpose: 'characters_json',
      })
      const [poolRef] = await storage.importFiles(0, [{ name: '图图-池定妆.png', data: new TextEncoder().encode('m52-sync-pool') }], { purpose: 'reference_character' })
      const [projRef] = await storage.importFiles(pid, [{ name: '图图-项目定妆.png', data: new TextEncoder().encode('m52-sync-proj') }], { purpose: 'reference_character' })
      // 预建同名项目行（遮蔽防护：全局挂接不得落到它）
      const shadow = await upsertEntity({ projectId: pid, kind: 'character', name: '图图', appearance: '项目私有同名' })

      const r1 = await characterSync(mkCtx({ project: false }, { characters: [charJson.id], ref_images: [poolRef!.id, projRef!.id] }))
      const logAsset = (await db.select().from((await import('../src/db/schema')).assets).where(eq((await import('../src/db/schema')).assets.id, r1.assetIds![0]!)))[0]!
      const snap = JSON.parse(readFileSync(storage.absPathOf(logAsset.relPath!), 'utf8')) as { scope: string; created: string[]; refAttached: number }
      check(snap.scope === 'global' && snap.created.includes('图图') && snap.refAttached === 1, `character_sync 全局建档 + 仅挂池 1 张（实际 ${snap.refAttached}）`)
      const gRow = (await db.select().from(characters).where(isNull(characters.projectId))).find((x) => x.name === '图图')!
      const pRow = (await db.select().from(characters).where(eq(characters.id, shadow.id)))[0]!
      check(
        gRow.refAssetIds === JSON.stringify([poolRef!.id]),
        `全局角色挂接命中全局行（ref=${gRow.refAssetIds} 期望 ${poolRef!.id}）`,
      )
      check(pRow.refAssetIds === '[]', '同名项目行零污染（项目定妆照不越界、遮蔽不串写）')
      const r2 = await characterSync(mkCtx({ project: false }, { characters: [charJson.id], ref_images: [poolRef!.id, projRef!.id] }))
      const log2 = (await db.select().from((await import('../src/db/schema')).assets).where(eq((await import('../src/db/schema')).assets.id, r2.assetIds![0]!)))[0]!
      const snap2 = JSON.parse(readFileSync(storage.absPathOf(log2.relPath!), 'utf8')) as { updated: string[]; refAttached: number }
      check(snap2.updated.includes('图图') && snap2.refAttached === 0, '二次运行幂等（updated 分支 + 并集零新增）')

      // 场景链：entity_sync 同构
      const setJson = await writeTextAsset(pid, {
        name: 'sets.json',
        content: JSON.stringify({ scenes: [{ name: '村口', appearance: '老槐树土坯房' }], props: [] }),
        purpose: 'set_json',
      })
      const [poolSceneRef] = await storage.importFiles(0, [{ name: '村口-池参考.png', data: new TextEncoder().encode('m52-sync-scene') }], { purpose: 'reference_scene' })
      const [projSceneRef] = await storage.importFiles(pid, [{ name: '村口-项目参考.png', data: new TextEncoder().encode('m52-sync-scene-proj') }], { purpose: 'reference_scene' })
      await entitySync(mkCtx({ project: false }, { sets: [setJson.id], ref_images: [poolSceneRef!.id, projSceneRef!.id] }))
      const gScene = (await db.select().from(characters).where(isNull(characters.projectId))).find((x) => x.name === '村口' && x.kind === 'scene')!
      check(gScene.refAssetIds === JSON.stringify([poolSceneRef!.id]), `entity_sync 全局场景仅挂池（实际 ${gScene.refAssetIds}）`)
    },
  },
})
