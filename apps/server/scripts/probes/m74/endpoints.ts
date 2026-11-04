/**
 * 端点节（真实应用挂载：全部经 src/app.ts 导出的实例发 /api/v1 请求，不自建路由）。
 *
 * 覆盖：挂载前缀本身成为被测事实；分层登记七个端点的完整闭环与整套错误码词汇表；
 * 空补丁的零副作用语义；派生列真源边界（扁平直写只造成可见窗口，下一次分层写即回正）；
 * 逐镜预览与图像能力端点；一致性评价端点与只读回显；门禁全阶段触发与豁免回转；
 * 风格负向词「写 → 读回 → 注入锚点 → 清空」整链；删除面级联见同目录级联文件。
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { getSeededEntityIds, getSeededRunId, initDatabase, newAppearingSnapshot, newImageAsset, newRunFixture, newTaskFixture } from './bootstrap'
import { api, call, count, flatRefIds, getApp, rowsOf, test } from './helpers'
import { installStubFetch, restoreFetch, replyScore, stubCallCount } from './llm-stub'
import { runDeleteCascades } from './delete-cascades'

/** 分层登记域的响应体形态：{error:{code,message}}（前端直接展示 message 原文） */
function errorShape(data: unknown): { code?: string; message?: string } {
  return (data as { error?: { code?: string; message?: string } })?.error ?? {}
}

async function newProject(name: string): Promise<number> {
  const proj = await call('POST', '/projects', { name })
  assert.equal(proj.status, 201, `项目 ${name} 创建失败：${proj.status} ${proj.body}`)
  return proj.data.project.id as number
}

async function newEntity(projectId: number, name: string, states: string[] = []): Promise<number> {
  const ent = await call('POST', '/entities', { project_id: projectId, name, kind: 'character', appearance: '圆脸短发', states })
  assert.equal(ent.status, 201, `角色 ${name} 创建失败：${ent.status} ${ent.body}`)
  return ent.data.entity.id as number
}

/** 分层清单端点的实体快照（状态下拉与「未固化扁平参考」提示的数据源） */
interface RefsPayload {
  refs: Array<{ id: number; assetId: number; role: string; stateKey: string | null; viewKey: string | null; enabled: boolean; note: string | null }>
  entity: { id: number; name: string; states: string[]; refAssetIds: number[] }
}

async function getRefs(entityId: number): Promise<RefsPayload> {
  const res = await call('GET', `/entities/${entityId}/references`)
  assert.equal(res.status, 200, `读分层清单失败 ${res.status} ${res.body}`)
  return res.data as RefsPayload
}

export async function runEndpoints(checker: Checker): Promise<void> {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  const seeded = await getSeededEntityIds()
  const seededRun = await getSeededRunId()

  // ── 一、挂载前缀是被测事实 ───────────────────────────────────────────────
  await t('带 /api/v1 前缀命中分层端点、裸前缀命不中（门禁缺陷的回归面）', async () => {
    const app = await getApp()
    const mounted = await api(`/entities/${seeded.a}/references`)
    assert.equal(mounted.status, 200, `真实挂载路径应命中，实得 ${mounted.status}`)
    const mountedBody = (await mounted.json()) as RefsPayload
    assert.ok(Array.isArray(mountedBody.refs), '命中响应体是分层清单载荷')

    // 裸前缀用非 GET 方法：POST 不进 SPA 兜底通道，只走应用级 404；探针环境未构建前端产物时
    // GET 兜底同样是 notFound 而非 HTML 单页外壳（见下一测试的裸 GET 断言）。
    const bare = await app.request(`/entities/${seeded.a}/references`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(bare.status, 404, `裸前缀未挂到接口路由，应 404，实得 ${bare.status}`)
    const bareBody = (await bare.json()) as { error?: { code?: string; message?: string } }
    assert.equal(bareBody.error?.code, 'not_found', '裸前缀走应用级 404 兜底（错误体同款形态）')
    assert.ok(String(bareBody.error?.message).includes(`/entities/${seeded.a}/references`), `兜底文案回显请求原路径（未进入挂载路由），实得 ${JSON.stringify(bareBody.error)}`)
    assert.ok(!String(bareBody.error?.message).includes('/api/v1'), `兜底文案不应带挂载前缀（若带说明请求被路由到 /api/v1 内），实得 ${JSON.stringify(bareBody.error)}`)
  })

  await t('裸前缀的 GET 落应用级 404（不会被误当成清单接口）', async () => {
    // 探针环境 WEB_DIST 未构建 → 单页兜底不启用 → 未挂路由的 GET 与应用级 404 兜底同形态；
    // 断言只锁定「裸前缀 GET 不返回清单载荷」这一核心事实，不依赖前端产物是否存在。
    const app = await getApp()
    const bareGet = await app.request(`/entities/${seeded.a}/references`)
    assert.equal(bareGet.status, 404, `裸前缀 GET 应落 404，实得 ${bareGet.status}`)
    const text = await bareGet.text()
    assert.ok(!text.includes('"refs"'), '裸前缀 GET 响应体不含分层清单字段')
    const body = JSON.parse(text) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'not_found', '裸前缀 GET 与应用级 404 兜底同形态')
  })

  await t('真实挂载下的一致性端点可达（同一实例、同一前缀）', async () => {
    const caps = await call('GET', '/image-caps')
    assert.equal(caps.status, 200, `能力端点应可达，实得 ${caps.status}`)
    const gates = await call('GET', `/runs/${seededRun}/quality-gates`)
    assert.equal(gates.status, 200, `门禁查询端点应可达，实得 ${gates.status}`)
    assert.ok(Array.isArray(gates.data?.gates), '门禁查询返回 gates 数组')
  })

  // ── 二、分层端点完整闭环 + 错误码词汇表 ──────────────────────────────────
  const epProject = await newProject('分层端点项目')
  const epEntity = await newEntity(epProject, '端点主角', ['第3场：淋雨', '第4场：夜奔'])
  const epHistory = [await newImageAsset(epProject, '端点历史一'), await newImageAsset(epProject, '端点历史二')]
  const epFresh = await newImageAsset(epProject, '端点新参考')
  const epView = await newImageAsset(epProject, '端点视角图')

  await t('清单端点前置态：无分层行 + 实体快照带 states 与扁平参考', async () => {
    const { call: c } = await import('./helpers')
    await c('PUT', `/entities/${epEntity}`, { ref_asset_ids: epHistory })
    const payload = await getRefs(epEntity)
    assert.equal(payload.refs.length, 0, '前置：分层行为空数组')
    assert.equal(payload.entity.id, epEntity, '快照带实体标识')
    assert.equal(payload.entity.name, '端点主角', '快照带实体名')
    assert.deepEqual(payload.entity.states, ['第3场：淋雨', '第4场：夜奔'], `快照带状态条目供下拉，实得 ${JSON.stringify(payload.entity.states)}`)
    assert.deepEqual(payload.entity.refAssetIds, epHistory, `快照带扁平参考供「未固化」判定，实得 ${JSON.stringify(payload.entity.refAssetIds)}`)
    const unregistered = payload.entity.refAssetIds.filter((id) => !payload.refs.some((r) => r.assetId === id))
    assert.deepEqual(unregistered, epHistory, '未固化扁平参考可由响应体直接算出（前端提示口径）')
  })

  let epStateRow = 0
  await t('新增端点：状态角色登记 201 且历史扁平参考同批固化', async () => {
    const post = await call('POST', `/entities/${epEntity}/references`, { assetId: epFresh, role: 'state', stateKey: '第3场：淋雨', note: '端点登记' })
    assert.equal(post.status, 201, `登记应 201，实得 ${post.status} ${post.body}`)
    assert.equal(post.data?.assetId, epFresh, '响应体是登记行视图')
    assert.equal(post.data?.role, 'state', '响应体保留用户所选角色')
    assert.equal(post.data?.enabled, true, '启用位以布尔回显')
    epStateRow = post.data.id as number
    const payload = await getRefs(epEntity)
    assert.equal(payload.refs.length, 3, `历史两张固化 + 本次一张 = 三行，实得 ${payload.refs.length}`)
    assert.deepEqual(await flatRefIds(epEntity), [...epHistory, epFresh], '派生列随登记同步')
  })

  await t('错误码词汇表：重复登记 409 / 状态键不命中 400 / 角色非法两档', async () => {
    const dup = await call('POST', `/entities/${epEntity}/references`, { assetId: epFresh, role: 'base' })
    assert.equal(dup.status, 409, `重复登记应 409，实得 ${dup.status}`)
    assert.equal(errorShape(dup.data).code, 'conflict', `域错误映射到冲突码，实得 ${JSON.stringify(errorShape(dup.data))}`)
    assert.ok(String(errorShape(dup.data).message).includes('同实体同资产唯一'), '冲突文案直述唯一约束')

    const badKey = await call('POST', `/entities/${epEntity}/references`, { assetId: epView, role: 'state', stateKey: '黑化' })
    assert.equal(badKey.status, 400, '状态键不属实体应 400')
    assert.equal(errorShape(badKey.data).code, 'bad_request', `域错误映射到请求非法码，实得 ${JSON.stringify(errorShape(badKey.data))}`)
    assert.ok(String(errorShape(badKey.data).message).includes('可核对：第3场：淋雨 / 第4场：夜奔'), `文案带候选清单，实得 ${errorShape(badKey.data).message}`)

    const bogusRole = await call('POST', `/entities/${epEntity}/references`, { assetId: epView, role: 'bogus' })
    assert.equal(bogusRole.status, 400, '角色枚举非法应 400')
    assert.equal(errorShape(bogusRole.data).code, 'bad_request', '枚举校验在服务层，映射到请求非法码')

    const typeRole = await call('POST', `/entities/${epEntity}/references`, { assetId: epView, role: 123 })
    assert.equal(typeRole.status, 400, '角色类型错误应 400')
    assert.equal(errorShape(typeRole.data).code, 'bad_role', `类型校验在路由层，实得 ${JSON.stringify(errorShape(typeRole.data))}`)

    const missingRole = await call('POST', `/entities/${epEntity}/references`, { assetId: epView })
    assert.equal(missingRole.status, 400, '缺角色应 400')
    assert.equal(errorShape(missingRole.data).code, 'bad_role', '缺省角色按类型错误同码')

    const badAsset = await call('POST', `/entities/${epEntity}/references`, { role: 'base' })
    assert.equal(badAsset.status, 400, '缺资产标识应 400')
    assert.equal(errorShape(badAsset.data).code, 'bad_asset_id', `资产标识校验独立成码，实得 ${JSON.stringify(errorShape(badAsset.data))}`)
  })

  await t('错误码词汇表：请求体非合法 JSON 与路径标识非法', async () => {
    const brokenJson = await api(`/entities/${epEntity}/references`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"role":' })
    assert.equal(brokenJson.status, 400, `坏 JSON 应 400，实得 ${brokenJson.status}`)
    assert.equal(errorShape(await brokenJson.json()).code, 'bad_json', '请求体解析失败独立成码')

    const badId = await call('GET', '/entities/abc/references')
    assert.equal(badId.status, 400, '非数字标识应 400')
    assert.equal(errorShape(badId.data).code, 'bad_id', '标识解析失败独立成码')

    const zeroId = await call('POST', '/entities/0/references', { assetId: epView, role: 'base' })
    assert.equal(zeroId.status, 400, '零标识被拒')
    assert.equal(errorShape(zeroId.data).code, 'bad_id', '零标识按标识非法处理')
  })

  await t('错误码词汇表：宿主缺失 404 覆盖清单/新增/回填/预览四类入口', async () => {
    const missing = 9_999_999
    const got = [
      await call('GET', `/entities/${missing}/references`),
      await call('POST', `/entities/${missing}/references`, { assetId: epView, role: 'base' }),
      await call('POST', `/entities/${missing}/references/backfill`),
      await call('GET', `/entities/${missing}/selection-preview`),
    ]
    for (const [i, res] of got.entries()) {
      assert.equal(res.status, 404, `第 ${i + 1} 个入口应 404，实得 ${res.status}`)
      assert.equal(errorShape(res.data).code, 'not_found', '缺失码统一')
      assert.ok(String(errorShape(res.data).message).includes('不存在'), `缺失文案沿用统一口径，实得 ${errorShape(res.data).message}`)
    }
  })

  await t('局部更新：停用剔除派生列、恢复回到原值、清单显式呈现停用行', async () => {
    const off = await call('PATCH', `/entity-references/${epStateRow}`, { enabled: false })
    assert.equal(off.status, 200, `停用应 200，实得 ${off.status} ${off.body}`)
    assert.equal(off.data?.enabled, false, '停用回显布尔假')
    assert.deepEqual(await flatRefIds(epEntity), epHistory, `派生列剔除停用行，实得 ${JSON.stringify(await flatRefIds(epEntity))}`)
    const listed = await getRefs(epEntity)
    assert.ok(listed.refs.some((r) => r.id === epStateRow && r.enabled === false), '清单含停用行并显式呈现启用位为假')
    const on = await call('PATCH', `/entity-references/${epStateRow}`, { enabled: true })
    assert.equal(on.status, 200, '恢复应 200')
    assert.deepEqual(await flatRefIds(epEntity), [...epHistory, epFresh], '恢复后派生列回到停用前集合')
  })

  await t('空补丁是零副作用：各列（含更新时刻）分毫未动且不记实体版本', async () => {
    const before = await rowsOf<Record<string, unknown>>('SELECT * FROM entity_references WHERE id = ?', [epStateRow])
    const versionsBefore = await countVersions()
    const noop = await call('PATCH', `/entity-references/${epStateRow}`, {})
    assert.equal(noop.status, 200, `空补丁应 200，实得 ${noop.status} ${noop.body}`)
    const after = await rowsOf<Record<string, unknown>>('SELECT * FROM entity_references WHERE id = ?', [epStateRow])
    assert.deepEqual(after, before, `空补丁后整行逐列相同（含更新时刻），实得变化列：${changedColumns(before[0]!, after[0]!).join(',')}`)
    assert.equal(await countVersions(), versionsBefore, '空补丁不记实体版本')
    assert.deepEqual(await flatRefIds(epEntity), [...epHistory, epFresh], '空补丁后派生列不变')
  })

  await t('局部更新的类型与缺失分支：非布尔启用位 / 非字符串可空列 / 行缺失', async () => {
    const badEnabled = await call('PATCH', `/entity-references/${epStateRow}`, { enabled: 'yes' })
    assert.equal(badEnabled.status, 400, '非布尔启用位应 400')
    assert.equal(errorShape(badEnabled.data).code, 'bad_enabled', `启用位独立成码，实得 ${JSON.stringify(errorShape(badEnabled.data))}`)

    const badRole = await call('PATCH', `/entity-references/${epStateRow}`, { role: 123 })
    assert.equal(badRole.status, 400, '补丁角色类型错应 400')
    assert.equal(errorShape(badRole.data).code, 'bad_role', '补丁角色沿用类型码')

    const badKey = await call('PATCH', `/entity-references/${epStateRow}`, { stateKey: 123 })
    assert.equal(badKey.status, 400, '状态键类型错应 400')
    assert.equal(errorShape(badKey.data).code, 'bad_field_type', `可空文本列统一归字段类型码，实得 ${JSON.stringify(errorShape(badKey.data))}`)

    const badNote = await call('PATCH', `/entity-references/${epStateRow}`, { note: 42 })
    assert.equal(badNote.status, 400, '注记类型错应 400')
    assert.equal(errorShape(badNote.data).code, 'bad_field_type', '注记同字段类型码')

    const missing = await call('PATCH', '/entity-references/999999', { enabled: false })
    assert.equal(missing.status, 404, '行缺失应 404')
    assert.equal(errorShape(missing.data).code, 'not_found', '行缺失码统一')

    const badId = await call('PATCH', '/entity-references/abc', { enabled: false })
    assert.equal(badId.status, 400, '非法标识应 400')
    assert.equal(errorShape(badId.data).code, 'bad_id', '非法标识码统一')
  })

  await t('失败的分层写不落库：两次非法补丁后该行角色与键原样', async () => {
    const payload = await getRefs(epEntity)
    const row = payload.refs.find((r) => r.id === epStateRow)!
    assert.equal(row.role, 'state', `失败写不覆角色，实得 ${row.role}`)
    assert.equal(row.stateKey, '第3场：淋雨', `失败写不清状态键，实得 ${String(row.stateKey)}`)
    assert.deepEqual(await flatRefIds(epEntity), [...epHistory, epFresh], '失败写不改派生列')
  })

  await t('角色改写与显式清空：改角色不清旧键，清空须显式传 null', async () => {
    const moved = await call('PATCH', `/entity-references/${epStateRow}`, { role: 'view', viewKey: '背面' })
    assert.equal(moved.status, 200, `改写应 200，实得 ${moved.status} ${moved.body}`)
    assert.equal(moved.data?.role, 'view', '角色改为视角')
    assert.equal(moved.data?.stateKey, '第3场：淋雨', '仅切换角色不清空旧状态键（保留原值）')
    const cleared = await call('PATCH', `/entity-references/${epStateRow}`, { stateKey: null })
    assert.equal(cleared.status, 200, `视角角色下显式清键被接受，实得 ${cleared.status} ${cleared.body}`)
    assert.equal(cleared.data?.stateKey, null, '显式 null 才把状态键清空')
    const denied = await call('PATCH', `/entity-references/${epStateRow}`, { role: 'state' })
    assert.equal(denied.status, 400, '清空后改回状态而不带状态键 → 请求非法')
    assert.equal(errorShape(denied.data).code, 'bad_request', '状态键缺失按请求非法码')
    const back = await call('PATCH', `/entity-references/${epStateRow}`, { role: 'state', stateKey: '第3场：淋雨' })
    assert.equal(back.status, 200, '带有效键的改写成功')
    assert.equal(back.data?.role, 'state', '角色回到状态')
  })

  await t('删除端点：删除即剔除派生列、再删 404、非法标识 400', async () => {
    const spare = await call('POST', `/entities/${epEntity}/references`, { assetId: epView, role: 'view', viewKey: '侧面' })
    assert.equal(spare.status, 201, `前置登记应 201，实得 ${spare.status} ${spare.body}`)
    const spareId = spare.data.id as number
    const del = await call('DELETE', `/entity-references/${spareId}`)
    assert.equal(del.status, 200, `删除应 200，实得 ${del.status}`)
    assert.equal(del.data?.ok, true, '删除回显成功标记')
    const payload = await getRefs(epEntity)
    assert.ok(!payload.refs.some((r) => r.id === spareId), '删除后行从清单消失')
    const again = await call('DELETE', `/entity-references/${spareId}`)
    assert.equal(again.status, 404, '再删同一行应 404')
    const bad = await call('DELETE', '/entity-references/abc')
    assert.equal(bad.status, 400, '非法标识应 400')
    assert.equal(errorShape(bad.data).code, 'bad_id', '非法标识码统一')
  })

  await t('回填端点：历史扁平参考补齐后二次零新增、空请求体也可调用', async () => {
    const pid = await newProject('回填端点项目')
    const eid = await newEntity(pid, '回填主角')
    const two = [await newImageAsset(pid, '回填历史一'), await newImageAsset(pid, '回填历史二')]
    await call('PUT', `/entities/${eid}`, { ref_asset_ids: two })
    const first = await call('POST', `/entities/${eid}/references/backfill`)
    assert.equal(first.status, 200, `首次回填应 200，实得 ${first.status} ${first.body}`)
    assert.equal(first.data?.added, 2, `补齐两张历史参考，实得 ${first.data?.added}`)
    const second = await call('POST', `/entities/${eid}/references/backfill`, {})
    assert.equal(second.data?.added, 0, `二次回填零新增，实得 ${second.data?.added}`)
    const emptyBody = await api(`/entities/${eid}/references/backfill`, { method: 'POST' })
    assert.equal(emptyBody.status, 200, `空请求体仍成功（前端不送 body）${emptyBody.status}`)
    const payload = await getRefs(eid)
    assert.equal(payload.refs.length, 2, `回填后共两行，实得 ${payload.refs.length}`)
    assert.ok(payload.refs.every((r) => r.role === 'base'), '回填行一律基准角色')
  })

  await t('预览端点：状态命中排前 + 三数组形态 + 纯读零副作用', async () => {
    const base = await newImageAsset(epProject, '预览基准')
    const state = await newImageAsset(epProject, '预览状态')
    await call('POST', `/entities/${epEntity}/references`, { assetId: base, role: 'base' })
    await call('POST', `/entities/${epEntity}/references`, { assetId: state, role: 'state', stateKey: '第4场：夜奔' })
    const versionsBefore = await countVersions()
    const rowsBefore = JSON.stringify((await getRefs(epEntity)).refs.map((r) => [r.id, r.role, r.enabled]))
    const flatBefore = await flatRefIds(epEntity)

    const hit = await call('GET', `/entities/${epEntity}/selection-preview?scene=4&text=第4场 夜奔`)
    assert.equal(hit.status, 200, `预览应 200，实得 ${hit.status} ${hit.body}`)
    assert.ok(Array.isArray(hit.data?.selected) && Array.isArray(hit.data?.fallbacks) && Array.isArray(hit.data?.dropped), '响应体是三数组形态')
    assert.equal(hit.data?.selected?.[0]?.role, 'state', `状态命中排首位，实得 ${JSON.stringify(hit.data?.selected?.[0])}`)
    assert.ok(String(hit.data?.selected?.[0]?.reason).includes('第4场：夜奔'), `入选理由带命中条目原文，实得 ${JSON.stringify(hit.data?.selected?.[0]?.reason)}`)

    const miss = await call('GET', `/entities/${epEntity}/selection-preview?scene=9`)
    assert.equal(miss.status, 200, '无命中上下文也应 200')
    assert.equal(miss.data?.selected?.[0]?.role, 'base', `无状态命中时端点应退到基准层，实得 ${JSON.stringify(miss.data?.selected?.[0])}`)
    assert.deepEqual(miss.data?.fallbacks, [], `基准直取不构成回退说明，实得 ${JSON.stringify(miss.data?.fallbacks)}`)

    const noParams = await call('GET', `/entities/${epEntity}/selection-preview`)
    assert.equal(noParams.status, 200, '参数全缺省（空文本档）应 200')

    assert.equal(await countVersions(), versionsBefore, '预览不写实体版本')
    assert.equal(JSON.stringify((await getRefs(epEntity)).refs.map((r) => [r.id, r.role, r.enabled])), rowsBefore, '预览不改分层表任何行')
    assert.deepEqual(await flatRefIds(epEntity), flatBefore, '预览不改派生列')
  })

  await t('预览查询参数校验：非整数场次与集数各自成码', async () => {
    const badScene = await call('GET', `/entities/${epEntity}/selection-preview?scene=abc`)
    assert.equal(badScene.status, 400, '非整数场次应 400')
    assert.equal(errorShape(badScene.data).code, 'bad_scene', `场次查询参数独立成码，实得 ${JSON.stringify(errorShape(badScene.data))}`)
    const badEpisode = await call('GET', `/entities/${epEntity}/selection-preview?episode=1.5`)
    assert.equal(badEpisode.status, 400, '非整数集数应 400')
    assert.equal(errorShape(badEpisode.data).code, 'bad_episode', '集数查询参数独立成码')
  })

  // ── 三、派生列真源边界：直写只造成可见窗口 ───────────────────────────────
  let directWriteIds: number[] = []
  await t('派生列真源：分层行在位时扁平直写确实覆盖列值（服务端不设闸）', async () => {
    const layersBefore = (await getRefs(epEntity)).refs.length
    const x1 = await newImageAsset(epProject, '直写一')
    const x2 = await newImageAsset(epProject, '直写二')
    directWriteIds = [x1, x2]
    const put = await call('PUT', `/entities/${epEntity}`, { ref_asset_ids: [x1, x2] })
    assert.equal(put.status, 200, `直写应成功（无闸），实得 ${put.status} ${put.body}`)
    assert.deepEqual(await flatRefIds(epEntity), [x1, x2], `扁平列确实被覆盖，实得 ${JSON.stringify(await flatRefIds(epEntity))}`)
    assert.equal((await getRefs(epEntity)).refs.length, layersBefore, '覆盖窗口内分层行原样不动')
  })

  await t('覆盖窗口内：预览与出图侧取用仍只认分层行（扁平列不参与）', async () => {
    const preview = await call('GET', `/entities/${epEntity}/selection-preview?scene=4`)
    const previewIds: number[] = (preview.data?.selected ?? []).map((s: { assetId: number }) => s.assetId)
    const layerAssetIds = new Set((await getRefs(epEntity)).refs.filter((r) => r.enabled).map((r) => r.assetId))
    assert.ok(previewIds.length > 0, '预览仍有取用结果')
    assert.ok(previewIds.every((id) => layerAssetIds.has(id)), `预览全部落在启用分层行内，实得 ${JSON.stringify(previewIds)}`)

    // 出图侧的真实取用面：实体索引 + 分层索引喂给同一份纯选择函数（与出图动作同源）
    const { loadEntityIndex } = await import('../../../src/services/character')
    const { loadRefIndex } = await import('../../../src/services/entity-references')
    const { collectRefAssetIds } = await import('../../../src/services/ref-selection')
    const indexes = { characters: await loadEntityIndex(epProject), scenes: new Map(), props: new Map() }
    const refIndex = await loadRefIndex([epEntity])
    const taken = collectRefAssetIds({ id: 'shot-win-1', characters: ['端点主角'] }, indexes, refIndex)
    assert.ok(taken.length > 0, '出图侧取用仍有结果')
    assert.ok(taken.every((id) => layerAssetIds.has(id)), `出图侧只认分层行，实得 ${JSON.stringify(taken)}`)
    const overwritten = await flatRefIds(epEntity)
    assert.deepEqual(taken.filter((id) => overwritten.includes(id)), [], `被直写覆盖的扁平列一项都没参与取用（列值 ${JSON.stringify(overwritten)} 与取用 ${JSON.stringify(taken)} 不相交）`)
  })

  await t('下一次分层写即回正：派生列回到启用行重算值', async () => {
    const payload = await getRefs(epEntity)
    const row = payload.refs.find((r) => r.enabled)!.id
    const toggle = await call('PATCH', `/entity-references/${row}`, { enabled: false })
    assert.equal(toggle.status, 200, `回正用的分层写应成功，实得 ${toggle.status} ${toggle.body}`)
    const afterOff = await flatRefIds(epEntity)
    assert.ok(afterOff.length > 0, '回正后派生列非空')
    assert.deepEqual(afterOff, await recomputeFromHelper(epEntity), `分层写把列回正为启用行重算值，实得 ${JSON.stringify(afterOff)}`)
    assert.deepEqual(afterOff.filter((id) => directWriteIds.includes(id)), [], `直写进去的两项被分层写冲掉（列值 ${JSON.stringify(afterOff)} 不含 ${JSON.stringify(directWriteIds)}）`)
    const restore = await call('PATCH', `/entity-references/${row}`, { enabled: true })
    assert.equal(restore.status, 200, '恢复启用')
    assert.deepEqual(await flatRefIds(epEntity), await recomputeFromHelper(epEntity), '再次分层写后仍等于全量启用行重算')
  })

  // ── 四、图像能力端点 ─────────────────────────────────────────────────────
  await t('能力端点：探针环境无图像配置 → 保守回显且说明留痕', async () => {
    const caps = await call('GET', '/image-caps')
    assert.equal(caps.status, 200, `能力端点应 200，实得 ${caps.status}`)
    assert.equal(caps.data?.supportsRefs, false, '无配置按不支持参考图回显')
    assert.equal(typeof caps.data?.maxRefs, 'number', '上限以数字回显')
    assert.ok(Array.isArray(caps.data?.notes), '说明为数组')
    const withQuery = await call('GET', '/image-caps?provider=openai&model=gpt-image-1')
    assert.equal(withQuery.status, 200, '带查询参数同样保守返回')
    assert.equal(withQuery.data?.supportsRefs, false, '参数不改变缺配置的结论')
  })

  // ── 五、一致性评价端点 + 只读回显 ────────────────────────────────────────
  installStubFetch()
  try {
    await t('评价端点：真实挂载触发评分链并按实体一行', async () => {
      replyScore(8)
      const res = await call('POST', `/runs/${seededRun}/consistency-eval`)
      assert.equal(res.status, 200, `评价端点应 200，实得 ${res.status} ${res.body}`)
      assert.equal(res.data?.runId, seededRun, '回显运行标识')
      assert.ok(Array.isArray(res.data?.results), '回显逐实体结果数组')
      assert.equal(stubCallCount() > 0, true, '评分链确实触达协议层')
    })

    await t('评价端点：分层角色的基准计数取启用基准行数、未分层角色截到四条', async () => {
      const res = await call('POST', `/runs/${seededRun}/consistency-eval`)
      const evalResults = (res.data?.results ?? []) as Array<{ entityId: number; refCount: number }>
      const byId = new Map(evalResults.map((x): [number, { entityId: number; refCount: number }] => [x.entityId, x]))
      const seededRefs = await getRefs(seeded.a)
      const enabledBase = seededRefs.refs.filter((r) => r.enabled && r.role === 'base').length
      assert.equal(byId.get(seeded.a)?.refCount, enabledBase, `分层角色基准数 = 启用基准行 ${enabledBase}，实得 ${byId.get(seeded.a)?.refCount}`)
      const flatCount = (await flatRefIds(seeded.b)).length
      assert.equal(byId.get(seeded.b)?.refCount, Math.min(flatCount, 4), `未分层角色走扁平回落（截到上限四条），实得 ${byId.get(seeded.b)?.refCount}`)
    })

    await t('评价端点错误面：运行缺失 404、非法标识 400', async () => {
      const nf = await call('POST', '/runs/9999999/consistency-eval')
      assert.equal(nf.status, 404, `缺失运行应 404，实得 ${nf.status}`)
      assert.equal(errorShape(nf.data).code, 'not_found', '缺失码统一')
      const bad = await call('POST', '/runs/abc/consistency-eval')
      assert.equal(bad.status, 400, '非法标识应 400')
      assert.equal(errorShape(bad.data).code, 'bad_id', '非法标识码统一')
    })

    await t('只读回显端点：问题计数粒度为运行×实体，集序恒零', async () => {
      const read = await call('GET', `/runs/${seededRun}/character-consistency`)
      assert.equal(read.status, 200, `只读端点应 200，实得 ${read.status}`)
      const entities = read.data?.entities ?? []
      assert.equal(entities.length, 2, `播种运行两个出镜角色各一行，实得 ${entities.length}`)
      for (const ent of entities) {
        assert.equal(ent.episodeIdx, 0, `回显集序恒零，实得 ${ent.episodeIdx}`)
        assert.equal(typeof ent.name, 'string', '回显带实体名')
        assert.ok(Array.isArray(ent.issues?.severities), '回显带问题分级数组')
      }
      const badGet = await call('GET', '/runs/abc/character-consistency')
      assert.equal(badGet.status, 400, '只读端点同款标识校验')
    })

    // ── 六、门禁全阶段触发 + 豁免回转 ────────────────────────────────────
    const gateProject = await newProject('门禁端点项目')
    const gateEntity = await newEntity(gateProject, '门禁主角')
    const gateBase = await newImageAsset(gateProject, '门禁基准')
    await call('POST', `/entities/${gateEntity}/references`, { assetId: gateBase, role: 'base' })
    const gateRun = await gateRunFixture(gateProject, gateEntity)

    await t('门禁端点：整轮触发返回五段结果且低分把末段翻为失败', async () => {
      replyScore(4)
      const evalRes = await call('POST', `/runs/${gateRun}/consistency-eval`)
      assert.equal(evalRes.status, 200, `评价应 200，实得 ${evalRes.status} ${evalRes.body}`)
      const gates = await call('POST', `/runs/${gateRun}/quality-gates`, { episodeIdx: 0 })
      assert.equal(gates.status, 201, `门禁触发应 201，实得 ${gates.status} ${gates.body}`)
      const list = gates.data?.gates ?? []
      assert.equal(list.length, 5, `五个阶段各一条结果，实得 ${list.length}`)
      const final = list.find((g: { stage: string }) => g.stage === 'final')
      assert.equal(final?.status, 'fail', `低分把末段翻为失败，实得 ${final?.status}`)
      assert.ok(final?.blockingCount >= 1, `阻断计数非零，实得 ${final?.blockingCount}`)
    })

    await t('门禁查询端点：一致性阻断项定位到本角色并带归一分', async () => {
      const single = await call('GET', `/runs/${gateRun}/quality-gates/final`)
      assert.equal(single.status, 200, `单段查询应 200，实得 ${single.status}`)
      assert.equal(single.data?.gate?.status, 'fail', '查询回显同一状态')
      // 末段可能同时有其它检查器的阻断项（如缺成片的 qc.verdict），本断言只归因于一致性检查项自身
      const consistencyBlocking = (single.data?.issues ?? []).filter((i: { severity: string; checker: string }) => i.severity === 'blocking' && i.checker === 'character.consistency')
      assert.equal(consistencyBlocking.length, 1, `一致性检查项贡献一条阻断，实得 ${consistencyBlocking.length}`)
      assert.equal(String(consistencyBlocking[0]?.targetId), String(gateEntity), '阻断项定位到该角色')
      assert.equal(consistencyBlocking[0]?.evidence?.normalized, 0.4, `证据带归一分，实得 ${JSON.stringify(consistencyBlocking[0]?.evidence)}`)
    })

    await t('豁免端点：逐条豁免后末段转为已豁免，取消豁免即回到失败', async () => {
      const single = await call('GET', `/runs/${gateRun}/quality-gates/final`)
      const blocking = (single.data?.issues ?? []).filter((i: { severity: string }) => i.severity === 'blocking')
      let gate: Record<string, unknown> | undefined
      for (const issue of blocking) {
        const exempt = await call('POST', `/quality-gates/issues/${issue.id}/exempt`, { reason: '探针裁定：本镜偏差可接受' })
        assert.equal(exempt.status, 200, `豁免应 200，实得 ${exempt.status} ${exempt.body}`)
        gate = exempt.data?.gate
      }
      assert.equal((gate as { status?: string })?.status, 'exempt', `全部阻断豁免后状态转已豁免，实得 ${JSON.stringify(gate)}`)
      assert.ok(((gate as { exemptCount?: number })?.exemptCount ?? 0) >= 1, '豁免计数随结果回显')

      const readBack = await rowsOf<{ exempted: number; exemptReason: string }>(
        "SELECT exempted, exempt_reason AS exemptReason FROM quality_issues WHERE run_id = ? AND checker = 'character.consistency' AND severity = 'blocking'",
        [gateRun],
      )
      assert.equal(Number(readBack[0]?.exempted), 1, '豁免位落库')
      assert.equal(readBack[0]?.exemptReason, '探针裁定：本镜偏差可接受', '豁免理由落库')

      const unexempt = await call('POST', `/quality-gates/issues/${blocking[0]?.id}/unexempt`)
      assert.equal(unexempt.status, 200, `取消豁免应 200，实得 ${unexempt.status} ${unexempt.body}`)
      assert.equal(unexempt.data?.gate?.status, 'fail', '取消豁免后末段回到失败')

      const badReason = await call('POST', `/quality-gates/issues/${blocking[0]?.id}/exempt`, { reason: '   ' })
      assert.equal(badReason.status, 400, '空理由被拒')
      assert.equal(errorShape(badReason.data).code, 'bad_reason', '理由校验独立成码')
    })
  } finally {
    restoreFetch()
  }

  // ── 七、风格负向词整链 ───────────────────────────────────────────────────
  await t('风格负向词：新建即带负向 → 读回 → 改写 → 空串清空', async () => {
    const created = await call('POST', '/style-presets', { name: '端点画风甲', snippet: 'ink wash painting', negative: '现代建筑' })
    assert.equal(created.status, 201, `新建预设应 201，实得 ${created.status} ${created.body}`)
    const presetId = created.data?.preset?.id as number
    assert.equal(created.data?.preset?.negative, '现代建筑', '新建回显负向词')

    const readBack = await call('GET', `/style-presets/${presetId}`)
    assert.equal(readBack.status, 200, `读回应 200，实得 ${readBack.status}`)
    assert.equal(readBack.data?.preset?.negative, '现代建筑', '读回负向词原值')

    const updated = await call('PUT', `/style-presets/${presetId}`, { negative: '现代建筑；霓虹灯' })
    assert.equal(updated.data?.preset?.negative, '现代建筑；霓虹灯', '改写负向词生效')

    const trimmed = await call('PUT', `/style-presets/${presetId}`, { negative: '   ' })
    assert.equal(trimmed.data?.preset?.negative, null, '纯空白串按清空语义落库为空值')

    const badType = await call('PUT', `/style-presets/${presetId}`, { negative: 42 })
    assert.equal(badType.status, 400, '非字符串负向词被拒')
    assert.equal(errorShape(badType.data).code, 'bad_negative', '负向词校验独立成码')

    const bound = await newProject('风格绑定项目')
    const bind = await call('PATCH', `/projects/${bound}`, { settings: { style_preset_ids: [presetId] } })
    assert.equal(bind.status, 200, `绑定预设应 200，实得 ${bind.status} ${bind.body}`)
    const { resolveProjectStyleSnippets } = await import('../../../src/services/style-preset')
    const resolved = await resolveProjectStyleSnippets(bound)
    assert.equal(resolved[0]?.negative, null, '清空后随词块透传的负向词为空值')

    await call('PUT', `/style-presets/${presetId}`, { negative: '现代建筑' })
    const resolvedAgain = await resolveProjectStyleSnippets(bound)
    assert.equal(resolvedAgain[0]?.negative, '现代建筑', '写回后经出图侧读面透传同一值')
    await call('DELETE', `/style-presets/${presetId}`)
  })

  await t('负向锚点整链：端点写入的负向词经真实索引与注入函数进出图提示词', async () => {
    const { loadEntityIndex } = await import('../../../src/services/character')
    const { injectCharacterAnchors } = await import('../../../src/pipeline/actions/ai-image')
    const pid = await newProject('负向锚点项目')
    const eid = await newEntity(pid, '锚点角色')
    await call('PUT', `/entities/${eid}`, { negative: '多余手指' })

    const index = await loadEntityIndex(pid)
    const injected = injectCharacterAnchors([{ id: 'shot-1', image_prompt: '少年立于檐下', characters: ['锚点角色'] }], index)
    assert.equal(injected.injected, 1, '命中角色即注入一条')
    assert.ok(injected.shots[0]!.image_prompt.includes('必须剔除：多余手指'), `锚点段带负向词原文，实得 ${JSON.stringify(injected.shots[0]!.image_prompt)}`)
    assert.ok(injected.shots[0]!.image_prompt.includes('角色锚定（锚点角色）：圆脸短发'), '同一段落携带外观锚定（负向词紧跟其后）')
    assert.ok((await entityRefPrompt(eid)).includes('必须剔除：多余手指'), '定妆照提示词走同一锚点（真实拼装函数）')

    await call('PUT', `/entities/${eid}`, { negative: '' })
    const indexCleared = await loadEntityIndex(pid)
    const afterClear = injectCharacterAnchors([{ id: 'shot-2', image_prompt: '少年立于檐下', characters: ['锚点角色'] }], indexCleared)
    assert.ok(!afterClear.shots[0]!.image_prompt.includes('必须剔除'), `空串清空后剔除段消失，实得 ${JSON.stringify(afterClear.shots[0]!.image_prompt)}`)
    assert.equal(afterClear.shots[0]!.image_prompt, '少年立于檐下\n角色锚定（锚点角色）：圆脸短发', '清空负向词只去掉剔除段，外观锚点仍随角色注入（原画面提示词逐字保留在前）')

    const refPrompt = await entityRefPrompt(eid)
    assert.ok(!refPrompt.includes('必须剔除'), `定妆照提示词同样不再携带锚点段，实得 ${JSON.stringify(refPrompt)}`)
  })

  // ── 八、宿主状态变更后的分层行判定口径 ──────────────────────────────────
  await t('状态条目变更后分层行保留旧键（服务端不自动清理，界面按失效判定）', async () => {
    const pid = await newProject('状态失效项目')
    const eid = await newEntity(pid, '失效角色', ['日常', '受伤'])
    const asset = await newImageAsset(pid, '失效参考')
    const reg = await call('POST', `/entities/${eid}/references`, { assetId: asset, role: 'state', stateKey: '受伤' })
    assert.equal(reg.status, 201, `前置登记应 201，实得 ${reg.status} ${reg.body}`)
    const before = await getRefs(eid)
    assert.deepEqual(before.entity.states, ['日常', '受伤'], '变更前宿主状态两条')

    const shrink = await call('PUT', `/entities/${eid}`, { states: ['日常'] })
    assert.equal(shrink.status, 200, `状态收窄应 200，实得 ${shrink.status} ${shrink.body}`)
    const after = await getRefs(eid)
    assert.deepEqual(after.entity.states, ['日常'], '变更后宿主快照只剩一条（下拉候选随之收窄）')
    assert.equal(after.refs.length, 1, `分层行不被静默删除，实得 ${after.refs.length} 行`)
    assert.equal(after.refs.find((r) => r.role === 'state')?.stateKey, '受伤', '该行仍保留旧状态键')
    assert.ok(
      after.refs.some((r) => r.role === 'state' && !!r.stateKey && !after.entity.states.includes(r.stateKey)),
      '可用「行状态键不在宿主状态内」判失效（界面同口径）',
    )
    assert.deepEqual(await flatRefIds(eid), await recomputeFromHelper(eid), '失效行未被静默改写：派生列仍等于启用行重算')
  })

  // ── 九、保存语义：不送扁平参考键即不动派生列（前端修复依赖的服务端契约）──
  await t('保存不带扁平参考键时派生列保持分层结果；送旧勾选快照会把停用项带回', async () => {
    const pid = await newProject('保存覆盖项目')
    const eid = await newEntity(pid, '保存角色')
    const a1 = await newImageAsset(pid, '保存参考一')
    const a2 = await newImageAsset(pid, '保存参考二')
    const a3 = await newImageAsset(pid, '保存参考三')
    await call('PUT', `/entities/${eid}`, { ref_asset_ids: [a1, a2] })
    const third = await call('POST', `/entities/${eid}/references`, { assetId: a3, role: 'view', viewKey: '侧面' })
    assert.equal(third.status, 201, `前置登记应 201，实得 ${third.status} ${third.body}`)
    const off = await call('PATCH', `/entity-references/${third.data.id}`, { enabled: false })
    assert.equal(off.status, 200, '停用成功')
    assert.deepEqual(await flatRefIds(eid), [a1, a2], '停用后派生列按启用行重算')

    const rename = await call('PUT', `/entities/${eid}`, { name: '保存角色改名' })
    assert.equal(rename.status, 200, `改名应 200，实得 ${rename.status} ${rename.body}`)
    assert.deepEqual(await flatRefIds(eid), [a1, a2], '未带该键的保存不改派生列')

    const snapshot = await call('PUT', `/entities/${eid}`, { ref_asset_ids: [a1, a2, a3] })
    assert.equal(snapshot.status, 200, '反证请求本身成功')
    assert.deepEqual(await flatRefIds(eid), [a1, a2, a3], '反证成立：送旧勾选快照会把已停用项带回派生列')

    const reWrite = await call('PATCH', `/entity-references/${third.data.id}`, { enabled: true })
    assert.equal(reWrite.status, 200, '恢复启用成功')
    assert.deepEqual(await flatRefIds(eid), [a1, a2, a3], '分层写后派生列回到启用行重算（两者一致）')
  })

  // ── 十、删除面级联（子文件，走真实删除端点）──────────────────────────────
  await runDeleteCascades(checker)
}

/** 实体版本链条数（分层派生同步与档案编辑都会记，用作「零副作用」的度量） */
async function countVersions(): Promise<number> {
  return await count('SELECT COUNT(*) AS n FROM content_versions')
}

/** 两行之间取值不同的列名（空补丁这类「零副作用」断言用它把变化列直接摊开，失败时一眼定位） */
function changedColumns(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const diffs: string[] = []
  for (const key of keys) if (!Object.is(before[key], after[key])) diffs.push(key)
  return diffs
}

/** 用与派生同步同一口径的重算函数取期望值（基准→状态→视角、同层按行号升序、去重） */
async function recomputeFromHelper(entityId: number): Promise<number[]> {
  const { recomputeRefIds } = await import('./helpers')
  return await recomputeRefIds(entityId)
}

/** 定妆照提示词（真实拼装函数 + 真实库读回的实体行）：负向词锚点的第二处消费面 */
async function entityRefPrompt(entityId: number): Promise<string> {
  const { composeEntityRefPrompt } = await import('../../../src/services/entity-refgen')
  const rows = await rowsOf<{ appearance: string | null; negative: string | null }>('SELECT appearance, negative FROM characters WHERE id = ?', [entityId])
  const row = rows[0]!
  return composeEntityRefPrompt({ appearance: row.appearance ?? '', negative: row.negative ?? null }, ['水墨国风'])
}

/** 为门禁端点造一条「出镜 + 出图」的运行（运行与任务行属历史输入夹具，无服务形态） */
async function gateRunFixture(projectId: number, entityId: number): Promise<number> {
  const runId = await newRunFixture(projectId)
  const shot = await newImageAsset(projectId, '门禁出图')
  await newTaskFixture(projectId, runId, entityId, shot, 'shot-gate', 1000)
  await newAppearingSnapshot(projectId, runId, [entityId])
  return runId
}
