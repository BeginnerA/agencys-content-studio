/**
 * M8 探针（场景/道具参考资产库 + 风格预设库）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m8.ts [--section=migrate|entity|inject|style|api|template]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3/m6）。零网络、零计费。
 *
 * section（默认 all）：
 *   migrate   characters.kind 列（PRAGMA 默认值）+ style_presets 表 + DB 级旧行默认 character + 重复 initDb 幂等
 *   entity    实体服务：kind 隔离 / 别名命中 / 项目覆盖全局 / attachRefAssets 并集与幂等 / 旧签名回归
 *   inject    ai_image 注入纯函数：injectSetAnchors / collectRefAssetIds（顺序 角色→场景→道具、4+1+1）/ injectStyleAnchor
 *   style     风格预设：绑定命中 / 未绑定 / 停用 / 被删 / settings 畸形 + stylePresetIdOf 单元
 *   api       /entities + /characters 兼容路径 + /style-presets（app.request 内存 HTTP，零网络）
 *   template  mengbao-episode v8 / series-setup v2 契约 + set-json validateTextOutput
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m8-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['migrate', 'entity', 'inject', 'style', 'api', 'template'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')

  const log = createLogger('probe-m8')
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
  const throwsSync = (fn: () => unknown): Error | null => {
    try {
      fn()
      return null
    } catch (err) {
      return err as Error
    }
  }

  // ---- setup：隔离库初始化（各 section 自建独立项目行，避免数据互污） ----
  await initDb()

  /** 建一个探针专用项目行，返回 id */
  const newProject = async (name: string, key: string): Promise<number> => {
    const { db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const t = Date.now()
    const row = (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: key, settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    return row.id
  }

  // ================= sections =================

  const sectionMigrate = async (): Promise<void> => {
    await initDb() // setup 已跑一次 → 本次即幂等验证

    const charCols = await sqlite.execute("PRAGMA table_info('characters')")
    const charMap = new Map(
      (charCols.rows as unknown as Array<{ name: string; dflt_value: string | null; notnull: number }>).map((r) => [r.name, r]),
    )
    const kindCol = charMap.get('kind')
    check(!!kindCol, 'characters.kind 列存在')
    check((kindCol?.dflt_value ?? '').includes('character'), `kind 列默认值 character（实际 ${kindCol?.dflt_value}）`)
    check(charMap.has('ref_asset_ids'), 'characters.ref_asset_ids 列在位（旧结构保留）')

    const tbls = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('characters','style_presets') ORDER BY name",
    )
    const names = (tbls.rows as unknown as Array<{ name: string }>).map((x) => x.name)
    check(names.join(',') === 'characters,style_presets', `characters/style_presets 两表存在（${names.join(',')}）`)

    // DB 级默认：raw SQL 不指定 kind 插入（等价存量旧行迁移后口径）→ kind 读出 'character'
    const t = Date.now()
    await sqlite.execute({
      sql: 'INSERT INTO characters (name, aliases, ref_asset_ids, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: ['迁移旧行', '[]', '[]', '{}', t, t],
    })
    const back = await sqlite.execute("SELECT kind FROM characters WHERE name = '迁移旧行'")
    const kindBack = (back.rows as unknown as Array<{ kind: string }>)[0]?.kind
    check(kindBack === 'character', `旧行 DB 级默认 kind=character（实际 ${kindBack}）`)

    // 幂等：再 initDb 一次 → 表/列仍在、不重复 ALTER
    await initDb()
    const again = await sqlite.execute(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('characters','style_presets')",
    )
    check(Number((again.rows as unknown as Array<{ n: number }>)[0]?.n) === 2, '重复 initDb 幂等（两表仍单份）')
    const colsAgain = await sqlite.execute("PRAGMA table_info('characters')")
    const kindAgain = (colsAgain.rows as unknown as Array<{ name: string }>).some((r) => r.name === 'kind')
    check(kindAgain, '重复 initDb 后 kind 列仍在')
  }

  const sectionEntity = async (): Promise<void> => {
    await initDb()
    const { loadEntityIndex, findEntity, upsertEntity, attachRefAssets, loadCharacterIndex, findCharacter, upsertCharacter } =
      await import('../src/services/character')
    const pid = await newProject('M8 实体探针', 'probe-m8-entity')

    // —— 1. 三 kind 建档 + 跨 kind 同名隔离 ——
    const c1 = await upsertEntity({ projectId: pid, kind: 'character', name: '萌宝', appearance: '圆脸大眼' })
    const s1 = await upsertEntity({ projectId: pid, kind: 'scene', name: '萌宝', appearance: '同名场景（kind 隔离）' })
    await upsertEntity({ projectId: pid, kind: 'scene', name: '老宅', aliases: ['祖宅'], appearance: '青砖灰瓦小院' })
    await upsertEntity({ projectId: pid, kind: 'prop', name: '虎头帽', appearance: '红色虎头造型' })
    check(c1.created && s1.created, '同名跨 kind 各自建行（character#x / scene#y）')
    check(c1.id !== s1.id, `跨 kind 不互相命中（id ${c1.id} ≠ ${s1.id}）`)

    // —— 2. 索引按 kind 隔离 + 别名入索引 ——
    const charIdx = await loadEntityIndex(pid)
    const sceneIdx = await loadEntityIndex(pid, 'scene')
    const propIdx = await loadEntityIndex(pid, 'prop')
    check(charIdx.get('萌宝')?.kind === 'character', 'character 索引含角色「萌宝」')
    check(sceneIdx.get('萌宝')?.appearance === '同名场景（kind 隔离）', 'scene 索引同名行互不干扰')
    check(sceneIdx.get('祖宅')?.name === '老宅', '别名「祖宅」入 scene 索引')
    check(propIdx.get('虎头帽')?.kind === 'prop' && !propIdx.has('老宅'), 'prop 索引独立（无 scene 泄漏）')

    // —— 3. findEntity kind 限定 ——
    check((await findEntity(pid, '老宅', 'scene'))?.name === '老宅', 'findEntity scene 命中')
    check((await findEntity(pid, '老宅', 'character')) === null, 'findEntity character 视角查 scene 名 → null')

    // —— 4. 项目覆盖全局（同名同 kind） ——
    await upsertEntity({ projectId: null, kind: 'scene', name: '客厅', appearance: '全局版客厅' })
    await upsertEntity({ projectId: pid, kind: 'scene', name: '客厅', appearance: '项目版客厅' })
    const sceneIdx2 = await loadEntityIndex(pid, 'scene')
    check(sceneIdx2.get('客厅')?.appearance === '项目版客厅', '同名项目行覆盖全局行')

    // —— 5. attachRefAssets：并集 / 幂等 / 未命中 / kind 限定 ——
    const a1 = await attachRefAssets(pid, '老宅', [9101, 9102], 'scene')
    check(a1 === 2, `attach 新增 2（实际 ${a1}）`)
    const a2 = await attachRefAssets(pid, '老宅', [9102, 9103], 'scene')
    check(a2 === 1, `再挂接并集去重（新增 ${a2}）`)
    const sRow = await findEntity(pid, '老宅', 'scene')
    check(sRow?.refAssetIds === '[9101,9102,9103]', `refAssetIds 并集（${sRow?.refAssetIds}）`)
    check((await attachRefAssets(pid, '查无此景', [1], 'scene')) === 0, '未命中实体 → 0')
    check((await attachRefAssets(pid, '老宅', [9104])) === 0, 'kind 缺省 character → scene 名不命中（0）')

    // —— 6. 旧签名回归（kind 恒 character） ——
    const legacy = await upsertCharacter({ projectId: pid, name: '小灰', appearance: '灰毛垂耳小狼' })
    check(legacy.created, 'upsertCharacter 建档')
    const legacyRow = await findCharacter(pid, '小灰')
    check(legacyRow?.kind === 'character', `旧签名行 kind=character（${legacyRow?.kind}）`)
    const legacyIdx = await loadCharacterIndex(pid)
    check(legacyIdx.has('小灰') && !legacyIdx.has('老宅') && !legacyIdx.has('虎头帽'), 'loadCharacterIndex 等价 character 索引（无 scene/prop 泄漏）')
    const legacy2 = await upsertCharacter({ projectId: pid, name: '小灰', appearance: '灰毛垂耳小狼（v2）' })
    check(!legacy2.created && legacy2.id === legacy.id, '旧签名 upsert 命中更新（保 id）')
  }

  const sectionInject = async (): Promise<void> => {
    await initDb()
    const { loadEntityIndex, upsertEntity, attachRefAssets } = await import('../src/services/character')
    const { injectSetAnchors, collectRefAssetIds, injectStyleAnchor } = await import('../src/pipeline/actions/ai-image')
    const pid = await newProject('M8 注入探针', 'probe-m8-inject')

    // 预置：场景 / 道具（含别名与负向词）+ 角色（含 refAssetIds）
    await upsertEntity({ projectId: pid, kind: 'scene', name: '老宅', aliases: ['祖宅'], appearance: '青砖灰瓦小院', negative: '现代建筑' })
    await upsertEntity({ projectId: pid, kind: 'prop', name: '虎头帽', appearance: '红色虎头造型' })
    await upsertEntity({ projectId: pid, kind: 'prop', name: '铜锁', appearance: '黄铜古锁', negative: '崭新锃亮' })
    await upsertEntity({ projectId: pid, kind: 'character', name: '萌宝', appearance: '圆脸大眼', refAssetIds: [101] })
    await upsertEntity({ projectId: pid, kind: 'character', name: '灰灰', appearance: '灰毛垂耳小狼', refAssetIds: [102] })
    await attachRefAssets(pid, '老宅', [201], 'scene')
    await attachRefAssets(pid, '虎头帽', [301], 'prop')
    await attachRefAssets(pid, '铜锁', [302], 'prop')

    const charIdx = await loadEntityIndex(pid, 'character')
    const sceneIdx = await loadEntityIndex(pid, 'scene')
    const propIdx = await loadEntityIndex(pid, 'prop')

    // —— injectSetAnchors ——
    const shotsIn = [
      { id: 's1', image_prompt: 'P1', location: '老宅', props: ['虎头帽'] },
      { id: 's2', image_prompt: 'P2', location: '祖宅' },
      { id: 's3', image_prompt: 'P3', location: '废弃工厂' },
      { id: 's4', image_prompt: 'P4', props: ['虎头帽', '铜锁', '不存在道具'] },
      { id: 's5', image_prompt: 'P5' },
    ]
    const inj = injectSetAnchors(shotsIn, sceneIdx, propIdx)
    check(inj.shots[0]!.image_prompt.includes('场景锚定（老宅）：青砖灰瓦小院'), 's1 场景锚定（appearance 段）')
    check(inj.shots[0]!.image_prompt.includes('道具锚定（虎头帽）：红色虎头造型'), 's1 道具锚定')
    check(inj.shots[0]!.image_prompt.includes('必须剔除：现代建筑'), 's1 场景负向词')
    check(inj.shots[1]!.image_prompt.includes('场景锚定（老宅）：'), 's2 别名「祖宅」命中同一场景')
    check(inj.shots[2]!.image_prompt === 'P3', 's3 未命中场景 → 原文不变')
    check(
      inj.shots[3]!.image_prompt.includes('道具锚定（铜锁）：黄铜古锁') && inj.shots[3]!.image_prompt.includes('必须剔除：崭新锃亮'),
      's4 多道具命中（铜锁 + 负向词）',
    )
    check(inj.shots[4]!.image_prompt === 'P5', 's5 无 location/props → 原文不变')
    check(inj.sceneInjected === 2, `sceneInjected=${inj.sceneInjected}（=2）`)
    check(inj.propInjected === 2, `propInjected=${inj.propInjected}（=2）`)
    check(JSON.stringify(inj.missing) === '["废弃工厂","不存在道具"]', `missing=[${inj.missing.join(',')}]`)
    check(shotsIn[0]!.image_prompt === 'P1', '入参数组未被修改')

    // —— collectRefAssetIds：顺序 角色→场景→道具 ——
    const ids1 = collectRefAssetIds(
      { id: 'c1', image_prompt: 'p', characters: ['萌宝', '灰灰'], location: '老宅', props: ['虎头帽', '铜锁'] },
      { characters: charIdx, scenes: sceneIdx, props: propIdx },
    )
    check(ids1.join(',') === '101,102,201,301', `保序拼接（角色→场景→道具）：${ids1.join(',')}`)
    const idsDup = collectRefAssetIds(
      { id: 'c2', image_prompt: 'p', characters: ['萌宝', '萌宝'], props: ['虎头帽', '虎头帽'] },
      { characters: charIdx, scenes: sceneIdx, props: propIdx },
    )
    check(idsDup.join(',') === '101,301', `重名去重（${idsDup.join(',')}）`)
    const idsEmpty = collectRefAssetIds({ id: 'c3', image_prompt: 'p' }, { characters: charIdx, scenes: sceneIdx, props: propIdx })
    check(idsEmpty.length === 0, '空镜零值')

    // —— collectRefAssetIds：4+1+1 全量与截断 ——
    for (const [i, name] of ['甲', '乙', '丙', '丁'].entries()) {
      await upsertEntity({ projectId: pid, kind: 'character', name, refAssetIds: [401 + i] })
    }
    const charIdx2 = await loadEntityIndex(pid, 'character')
    const ids6 = collectRefAssetIds(
      { id: 'c4', image_prompt: 'p', characters: ['甲', '乙', '丙', '丁'], location: '老宅', props: ['虎头帽'] },
      { characters: charIdx2, scenes: sceneIdx, props: propIdx },
    )
    check(ids6.join(',') === '401,402,403,404,201,301', `4+1+1 全量（${ids6.join(',')}，共 ${ids6.length}）`)
    await upsertEntity({ projectId: pid, kind: 'character', name: '戊', refAssetIds: [405] })
    const charIdx3 = await loadEntityIndex(pid, 'character')
    const idsTrunc = collectRefAssetIds(
      { id: 'c5', image_prompt: 'p', characters: ['甲', '乙', '丙', '丁', '戊'] },
      { characters: charIdx3, scenes: sceneIdx, props: propIdx },
    )
    check(idsTrunc.join(',') === '401,402,403,404', `5 角色截断至 4（${idsTrunc.join(',')}）`)
    await upsertEntity({ projectId: pid, kind: 'character', name: '多图角', refAssetIds: [501, 502, 503, 504, 505] })
    const charIdx4 = await loadEntityIndex(pid, 'character')
    const idsCap = collectRefAssetIds(
      { id: 'c6', image_prompt: 'p', characters: ['多图角'] },
      { characters: charIdx4, scenes: sceneIdx, props: propIdx },
    )
    check(idsCap.join(',') === '501,502,503,504', `单角色多图截断至 4（${idsCap.join(',')}）`)

    // —— injectStyleAnchor ——
    const shots = [
      { id: 'a', image_prompt: 'A' },
      { id: 'b', image_prompt: 'B ' },
    ]
    check(injectStyleAnchor(shots, null) === shots, 'snippet=null → 原样同一引用（零注入）')
    check(injectStyleAnchor(shots, '  ') === shots, 'snippet 空白 → 同一引用')
    const styled = injectStyleAnchor(shots, 'flat anime style, soft colors')
    check(styled[0]!.image_prompt === 'A\n视觉风格：flat anime style, soft colors', '尾追「视觉风格」段')
    check(styled[1]!.image_prompt === 'B\n视觉风格：flat anime style, soft colors', '尾部空白 trim 后拼接')
    check(shots[0]!.image_prompt === 'A', '入参数组未被修改（风格注入）')
  }

  const sectionStyle = async (): Promise<void> => {
    await initDb()
    const { db } = await import('../src/db')
    const { projects, stylePresets } = await import('../src/db/schema')
    const { resolveProjectStyleSnippet, stylePresetIdOf } = await import('../src/services/style-preset')
    const { eq } = await import('drizzle-orm')
    const pid = await newProject('M8 风格探针', 'probe-m8-style')

    const now = Date.now()
    const preset = (
      await db
        .insert(stylePresets)
        .values({
          name: '国漫质感',
          snippet: 'chinese anime style, cel shading',
          description: '探针预设',
          sortOrder: 0,
          isActive: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0]!
    const setSettings = (s: string): Promise<unknown> => db.update(projects).set({ settings: s }).where(eq(projects.id, pid))

    // —— 1. 未绑定 → null（静默） ——
    check((await resolveProjectStyleSnippet(pid)) === null, '未绑定 → null')

    // —— 2. 绑定命中 ——
    await setSettings(JSON.stringify({ style_preset_id: preset.id }))
    const hit = await resolveProjectStyleSnippet(pid)
    check(hit?.id === preset.id && hit.snippet === 'chinese anime style, cel shading', `绑定命中（#${hit?.id} ${hit?.name}）`)

    // —— 3. 绑定但停用 → null ——
    await db.update(stylePresets).set({ isActive: 0 }).where(eq(stylePresets.id, preset.id))
    check((await resolveProjectStyleSnippet(pid)) === null, '绑定但预设停用 → null（+warn）')
    await db.update(stylePresets).set({ isActive: 1 }).where(eq(stylePresets.id, preset.id))
    check((await resolveProjectStyleSnippet(pid))?.id === preset.id, '恢复启用 → 命中复原')

    // —— 4. 绑定不存在 id → null（+warn） ——
    await setSettings(JSON.stringify({ style_preset_id: 999999 }))
    check((await resolveProjectStyleSnippet(pid)) === null, '绑定不存在 id → null')

    // —— 5. settings 畸形 / 缺键 → null ——
    await setSettings('{损坏')
    check((await resolveProjectStyleSnippet(pid)) === null, 'settings 畸形 JSON → null')
    await setSettings('{"other":1}')
    check((await resolveProjectStyleSnippet(pid)) === null, 'settings 缺 style_preset_id 键 → null')

    // —— 6. 预设被删后绑定残留 → null ——
    await setSettings(JSON.stringify({ style_preset_id: preset.id }))
    await db.delete(stylePresets).where(eq(stylePresets.id, preset.id))
    check((await resolveProjectStyleSnippet(pid)) === null, '预设被删后绑定残留 → null（+warn）')

    // —— 7. 项目不存在 → null ——
    check((await resolveProjectStyleSnippet(999999)) === null, '项目不存在 → null')

    // —— 8. stylePresetIdOf 单元 ——
    check(stylePresetIdOf('{"style_preset_id":5}') === 5, '解析正整数 → 5')
    check(stylePresetIdOf('{"style_preset_id":"7"}') === 7, '字符串数字宽容转换 → 7')
    check(stylePresetIdOf('{"style_preset_id":0}') === null, '0 → null')
    check(stylePresetIdOf('{"style_preset_id":-3}') === null, '负数 → null')
    check(stylePresetIdOf('{"style_preset_id":1.5}') === null, '非整数 → null')
    check(stylePresetIdOf('{}') === null, '缺键 → null')
    check(stylePresetIdOf('oops') === null, '畸形 JSON → null')
  }

  const sectionApi = async (): Promise<void> => {
    await initDb()
    const { app } = await import('../src/app')
    const pid = await newProject('M8 路由探针', 'probe-m8-api')

    /** app.request 内存 HTTP（零网络）：返回状态码 + JSON body */
    const jreq = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const init: RequestInit = { method }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const res = await app.request(path, init)
      let json: any = null
      try {
        json = await res.json()
      } catch {
        /* 非 JSON 响应 */
      }
      return { status: res.status, body: json }
    }

    // —— /entities CRUD + kind 行为 ——
    const cr = await jreq('POST', '/api/v1/entities', { kind: 'scene', project_id: pid, name: '破庙', aliases: ['土地庙'], appearance: '坍塌土墙' })
    check(cr.status === 201 && cr.body?.entity?.kind === 'scene', `POST /entities 201（${cr.status}）`)
    check(cr.body?.entity?.scope === 'project' && cr.body?.created === true, '项目域 + created=true')
    const sid = cr.body?.entity?.id as number

    const cr2 = await jreq('POST', '/api/v1/entities', { kind: 'scene', project_id: pid, name: '土地庙' })
    check(cr2.body?.created === false && cr2.body?.entity?.id === sid, '别名命中 upsert（created=false 同 id）')

    const cr3 = await jreq('POST', '/api/v1/entities', { project_id: pid, name: '默认角色' })
    check(cr3.body?.entity?.kind === 'character', 'kind 缺省 character')

    const bad = await jreq('POST', '/api/v1/entities', { kind: 'monster', name: 'X' })
    check(bad.status === 400 && bad.body?.error?.code === 'bad_kind', `kind 非法 → 400 bad_kind（${bad.body?.error?.code}）`)

    const g = await jreq('POST', '/api/v1/entities', { kind: 'prop', name: '全局香炉' })
    check(g.body?.entity?.scope === 'global', '无 project_id → 全局行')
    const gBad = await jreq('POST', '/api/v1/entities', { kind: 'prop', name: '全局违规', ref_asset_ids: [1] })
    check(gBad.status === 400 && gBad.body?.error?.code === 'bad_ref_assets', '全局域挂非池资产 → 400 bad_ref_assets（[M52] 仅放行全局池）')

    const list = await jreq('GET', `/api/v1/entities?project_id=${pid}&kind=scene`)
    check(list.body?.items?.every((x: any) => x.kind === 'scene'), 'kind=scene 过滤（列表全为场景）')
    check(
      list.body?.items?.some((x: any) => x.id === sid) && list.body?.items?.some((x: any) => x.scope === 'global'),
      '项目视角含项目域 + 全局',
    )

    const legacy = await jreq('GET', `/api/v1/characters?project_id=${pid}`)
    check(legacy.status === 200 && legacy.body?.items?.every((x: any) => x.kind === 'character'), '/characters 兼容路径（kind 缺省 character）')

    const one = await jreq('GET', `/api/v1/entities/${sid}`)
    check(one.body?.entity?.name === '破庙' && 'refAssets' in (one.body?.entity ?? {}), 'GET 单条 key=entity（含 refAssets）')

    const upd = await jreq('PUT', `/api/v1/entities/${sid}`, { appearance: '修缮后土墙', voice: '不应生效' })
    check(upd.body?.entity?.appearance === '修缮后土墙' && upd.body?.entity?.voice === null, 'PUT 更新 + scene.voice 忽略')

    const del = await jreq('DELETE', `/api/v1/entities/${sid}`)
    const gone = await jreq('GET', `/api/v1/entities/${sid}`)
    check(del.status === 200 && gone.status === 404, 'DELETE + 再查 404')

    const cWrite = await jreq('POST', '/api/v1/characters', { project_id: pid, name: '兼容角色' })
    check(cWrite.status === 201 && cWrite.body?.entity?.kind === 'character', '/characters POST 兼容（kind=character）')

    // —— /style-presets CRUD ——
    const sp = await jreq('POST', '/api/v1/style-presets', { name: '水墨写意', snippet: 'chinese ink wash painting', description: '探针', sort_order: 5 })
    check(sp.status === 201 && sp.body?.preset?.name === '水墨写意', `POST /style-presets 201（${sp.status}）`)
    const spid = sp.body?.preset?.id as number
    const dup = await jreq('POST', '/api/v1/style-presets', { name: '水墨写意', snippet: 'x' })
    check(dup.status === 400 && dup.body?.error?.code === 'duplicate_name', '重名 → 400 duplicate_name')
    const noSnip = await jreq('POST', '/api/v1/style-presets', { name: '无词块' })
    check(noSnip.status === 400 && noSnip.body?.error?.code === 'bad_snippet', '缺 snippet → 400 bad_snippet')
    const spList = await jreq('GET', '/api/v1/style-presets?active=1')
    check(spList.body?.items?.some((x: any) => x.id === spid), 'active=1 列表含新建')
    const spOff = await jreq('PUT', `/api/v1/style-presets/${spid}`, { is_active: false })
    check(spOff.body?.preset?.isActive === 0, '停用 isActive=0')
    const spList2 = await jreq('GET', '/api/v1/style-presets?active=1')
    check(!spList2.body?.items?.some((x: any) => x.id === spid), '停用后 active=1 不含')
    const spBad = await jreq('PUT', `/api/v1/style-presets/${spid}`, { is_active: 'x' })
    check(spBad.status === 400 && spBad.body?.error?.code === 'bad_is_active', 'is_active 非法 → 400')
    const spDel = await jreq('DELETE', `/api/v1/style-presets/${spid}`)
    check(spDel.status === 200, 'DELETE 预设')
    const spGone = await jreq('GET', `/api/v1/style-presets/${spid}`)
    check(spGone.status === 404, '删除后再查 404')
  }

  const sectionTemplate = async (): Promise<void> => {
    await initDb()
    const { loadTemplate } = await import('../src/pipeline/loader')
    const { TEMPLATES_DIR } = await import('../src/env')
    const { validateTextOutput } = await import('../src/pipeline/actions/ai-text')

    // 真实模板拷入隔离 templates 目录（loadTemplate 读隔离 workspace；探针不触碰真实工作区）
    const srcDir = join(REPO_ROOT, 'workspace', 'templates')
    mkdirSync(TEMPLATES_DIR, { recursive: true })
    const copyTpl = (key: string): boolean => {
      try {
        cpSync(join(srcDir, `${key}.yaml`), join(TEMPLATES_DIR, `${key}.yaml`))
        return true
      } catch (err) {
        check(false, `真实模板 ${key}.yaml 拷贝失败：${(err as Error).message}`)
        return false
      }
    }
    const tryLoad = (key: string): ReturnType<typeof loadTemplate> | null => {
      try {
        return loadTemplate(key, true)
      } catch (err) {
        log.error(`       loader 错误全文：${(err as Error).message}`)
        return null
      }
    }

    // —— T1 mengbao-episode v15：版本 15 / 21 步 / 角色链 + 场景道具链与注入前置（出图步挂人工审阅闸；v12 集间承接；v13 智能 BGM 映射；v14 视频兜底改真厂商；v15 setting_docs 接受 json 承接商业结构） ——
    if (copyTpl('mengbao-episode')) {
      const t = tryLoad('mengbao-episode')
      check(t !== null, 'mengbao-episode 加载成功')
      if (t) {
        const keys = t.steps.map((s) => s.key)
        const stepOf = (k: string) => t.steps.find((s) => s.key === k)
        check(t.version === 15, `version=15（实际 ${t.version}）`)
        check(t.steps.length === 21, `steps=21（实际 ${t.steps.length}）`)
        check(
          ['gen_refs', 'gen_set_refs', 'gen_images', 'gen_frames'].every((k) => stepOf(k)?.gate?.mode === 'required' && !!stepOf(k)?.gate?.skip_label),
          'mengbao-episode 四个出图步均挂人工审阅闸（required + 可跳过）',
        )
        check(
          ['char_profile', 'ref_prompts', 'gen_refs', 'sync_characters'].every((k) => keys.includes(k)),
          'mengbao-episode 含角色链（char_profile/ref_prompts/gen_refs/sync_characters）',
        )
        check(
          ['set_profile', 'set_ref_prompts', 'gen_set_refs', 'sync_set'].every((k) => keys.includes(k)),
          'mengbao-episode 含场景道具链（set_profile/set_ref_prompts/gen_set_refs/sync_set）',
        )
        check(t.inputs.some((i) => i.key === 'with_set_refs'), 'inputs 含 with_set_refs')
        check(t.inputs.some((i) => i.key === 'prev_script' && !i.required), 'inputs 含 prev_script 选填（v12 集间承接）')
        const bgmIn = t.inputs.find((i) => i.key === 'bgm_mode')
        check(!!bgmIn && bgmIn.default === 'auto' && (bgmIn.options as readonly string[] | undefined)?.join(',') === 'none,auto,music_gen', 'v13 inputs 含 bgm_mode（默认 auto，三值选项）')
        check(t.inputs.some((i) => i.key === 'bgm_prompt' && !i.required), 'v13 inputs 含 bgm_prompt 选填')
        const cvIn = stepOf('compose_video')?.inputs as Record<string, string> | undefined
        check(cvIn?.['bgm_mode'] === 'input.bgm_mode' && cvIn?.['bgm_prompt'] === 'input.bgm_prompt', 'v13 compose_video 桥映射 bgm_mode/bgm_prompt（智能选曲接入）')
        check(stepOf('write_script')?.inputs['prev_script'] === 'input.prev_script', 'v12 write_script.inputs 接 prev_script（上集剧本直注）')
        const gsr = stepOf('gen_set_refs')
        check(typeof gsr?.when === 'string' && gsr.when.includes('with_set_refs'), `gen_set_refs.when 绑 with_set_refs（${String(gsr?.when)}）`)
        check(gsr?.params?.['output_purpose'] === 'reference_scene', 'gen_set_refs.output_purpose=reference_scene')
        const byCat = gsr?.params?.['output_purpose_by_category'] as Record<string, unknown> | undefined
        check(byCat?.['prop'] === 'reference_prop', 'output_purpose_by_category.prop=reference_prop')
        const ss = stepOf('sync_set')
        check(ss?.action === 'entity_sync', `sync_set.action=entity_sync（${String(ss?.action)}）`)
        check(
          (ss?.after ?? []).includes('set_profile') && (ss?.after ?? []).includes('gen_set_refs'),
          'sync_set.after 含 set_profile/gen_set_refs',
        )
        check(
          ss?.inputs?.['sets'] === 'steps.set_profile.asset' && ss?.inputs?.['ref_images'] === 'steps.gen_set_refs.assets',
          'sync_set.inputs 契约（sets/ref_images）',
        )
        const ms = stepOf('make_storyboard')
        check((ms?.after ?? []).includes('set_profile'), 'make_storyboard.after 含 set_profile')
        check(ms?.inputs?.['sets'] === 'steps.set_profile.asset', 'make_storyboard.inputs.sets 就位')
        check((stepOf('gen_images')?.after ?? []).includes('sync_set'), 'gen_images.after 含 sync_set')
        check((stepOf('gen_frames')?.after ?? []).includes('sync_set'), 'gen_frames.after 含 sync_set')
      }
    }

    // —— T2 series-setup v4：版本 4 / 13 步 / 场景道具链（出图步挂人工审阅闸）+ M60 商业结构设计步 ——
    if (copyTpl('series-setup')) {
      const t = tryLoad('series-setup')
      check(t !== null, 'series-setup 加载成功')
      if (t) {
        const keys = t.steps.map((s) => s.key)
        const stepOf = (k: string) => t.steps.find((s) => s.key === k)
        check(t.version === 4, `series-setup version=4（实际 ${t.version}）`)
        check(t.steps.length === 13, `series-setup steps=13（实际 ${t.steps.length}）`)
        // [M60] 商业结构设计：开关输入 + monetize 步接线 + 必审可跳闸
        const wm = t.inputs.find((i) => i.key === 'with_monetization')
        check(!!wm && wm.kind === 'bool' && wm.required === false && wm.default === true, 'inputs 含 with_monetization（bool 选填默认开）')
        const mz = stepOf('monetize')
        check(!!mz && mz.action === 'ai_text' && mz.params?.['output_format'] === 'monetization-json' && mz.params?.['prompt_tpl'] === 'monetize-structure.md', 'monetize 步：ai_text + monetize-json 契约 + monetize-structure.md')
        check(!!mz && mz.inputs?.['series'] === 'steps.write_series.asset' && (mz.after ?? []).includes('write_series'), 'monetize.after/inputs 吃设定包（分集地图为唯一上游）')
        check(typeof mz?.when === 'string' && mz.when.includes('with_monetization'), 'monetize.when 绑 with_monetization（可关零漂移）')
        check(mz?.gate?.mode === 'required' && !!mz.gate.skip_label, 'monetize 挂必审可跳闸（卡点结构需人工确认）')
        check(
          ['gen_refs', 'gen_set_refs'].every((k) => stepOf(k)?.gate?.mode === 'required' && !!stepOf(k)?.gate?.skip_label),
          'series-setup 出图步均挂人工审阅闸（required + 可跳过）',
        )
        check(
          ['set_profile', 'set_ref_prompts', 'gen_set_refs', 'sync_set'].every((k) => keys.includes(k)),
          'series-setup 含场景道具链',
        )
        check(stepOf('set_profile')?.params?.['output_format'] === 'set-json', 'set_profile.output_format=set-json')
        const ss = stepOf('sync_set')
        check(
          (ss?.after ?? []).includes('set_profile') && (ss?.after ?? []).includes('gen_set_refs'),
          'series sync_set.after 链完整',
        )
        check(ss?.inputs?.['sets'] === 'steps.set_profile.asset', 'series sync_set.inputs.sets 就位')
      }
    }

    // —— T3 set-json 输出契约（validateTextOutput） ——
    const good = JSON.stringify({
      scenes: [{ name: '老宅', appearance: '青砖灰瓦' }],
      props: [{ name: '虎头帽', appearance: '红色虎头', aliases: ['小帽'], negative: '现代元素' }],
    })
    check(validateTextOutput(good, 'set-json') === 2, 'set-json 合法 → 2 项')
    const fenced = '```json\n' + JSON.stringify({ props: [{ name: '铜锁', appearance: '黄铜' }] }) + '\n```'
    check(validateTextOutput(fenced, 'set-json') === 1, '围栏 JSON 剥离解析（仅 props → 1）')
    const e1 = throwsSync(() => validateTextOutput('{"scenes":[],"props":[]}', 'set-json'))
    check(e1 !== null && e1.message.includes('双空'), `scenes/props 双空抛错（${e1 ? e1.message.slice(0, 40) : '未抛'}）`)
    const e2 = throwsSync(() => validateTextOutput('{"scenes":[{"name":"老宅"}]}', 'set-json'))
    check(e2 !== null && e2.message.includes('缺 appearance'), '缺 appearance 抛错')
    const e3 = throwsSync(() => validateTextOutput('{"props":[{"name":"x","appearance":"y","aliases":"bad"}]}', 'set-json'))
    check(e3 !== null && e3.message.includes('aliases'), 'aliases 非字符串数组抛错')
    const e4 = throwsSync(() => validateTextOutput('{"props":[{"name":"x","appearance":"y","negative":5}]}', 'set-json'))
    check(e4 !== null && e4.message.includes('negative'), 'negative 非字符串抛错')
    check(validateTextOutput('普通文本', 'script') === 0, '非校验格式 → 0')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    migrate: sectionMigrate,
    entity: sectionEntity,
    inject: sectionInject,
    style: sectionStyle,
    api: sectionApi,
    template: sectionTemplate,
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
    console.log(`\n==== M8 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
