/**
 * M23 探针（画布规模化与智能编排）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m23.ts [--section=force|serialize|edit|overview|advice|bench]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m22）。零网络、零计费：
 * 直测服务层纯函数与聚合函数，不触发引擎执行、真实生成与 LLM 调用（LLM 通道走 e2e 实弹）。
 *
 * section（默认 all；P0 骨架，P1/P2/P3 逐批填充全矩阵；三批已全量实装）：
 *   force     [P1] 力导向全矩阵：确定性 / round 取整 / 分离度 / 锚定双例 / 单节点 / 空集 / 两点无边 / 幽灵边过滤 / layered·grid 零漂移
 *   serialize [P3] 模板序列化：parse ∘ stringify 往返（全字段/最小模板/转义）/ snake_case / 键序 / key 覆盖
 *   edit      [P3] 编辑矩阵：物化三态 / 加边去重 / 删边 / after null 回落 / 非前置·未知引用·白名单拒绝 / key 避让
 *   overview  [P2] 全景聚合：批次分组 / 独立 run / cost 映射 / 空项目
 *   advice    [P3] 建议解析：buildCanvasSummary 确定性 + parseAdviceOutput 归一降级矩阵
 *   bench     [P1] 基准报告：300/600/1000 节点 buildCanvasDoc 耗时（隔离库种子：60% gen / 30% text / 10% asset + 链式边）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanvasDoc, CanvasDocNode } from '../src/services/creation/spec'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m23-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch {
      /* 占用中（并行探针）→ 跳过 */
    }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(join(process.env.CSTUDIO_WORKSPACE, 'templates'), { recursive: true })

const SECTIONS = ['force', 'serialize', 'edit', 'overview', 'advice', 'bench'] as const

/** serialize/edit 共用夹具（特征全覆盖：inputs 4 kind / defaults / after / when / when_any / gate / batch / output / 非字符串叶子） */
const FIXTURE_YAML = `key: m23-fixture
version: 2
name: M23 夹具
description: 序列化往返夹具
genre: other
scene: produce
next: [other-tpl]
inputs:
  - key: topic
    label: 主题
    kind: text
    required: true
    default: 默认主题
  - key: files
    kind: files
    required: false
    accept: [.md, .txt]
  - key: rounds
    kind: int
    required: false
    default: 3
  - key: flag
    kind: bool
    required: false
    default: false
defaults:
  llm: { temperature: 0.7 }
steps:
  - key: ingest
    action: manual_ingest
    title: 入库
    inputs:
      docs: input.files
  - key: gen
    action: ai_text
    title: 生成
    after: [ingest]
    when: input.topic exists
    when_any: [steps.ingest.count > 0]
    inputs:
      topic: input.topic
      source: steps.ingest.assets
      meta: { k: 1 }
    params:
      prompt_tpl: adapt-text.md
      name_tpl: "gen.md"
    gate:
      mode: required
      message: 请审阅 {input.topic}
      skip_label: 通过
      when: input.flag == false
    batch:
      field: items
      max_concurrent: 3
      retry: 1
    output:
      purpose: export
  - key: render
    action: ffmpeg_merge
    title: 合成
    inputs:
      video: steps.gen.assets
`

/** serialize 节最小模板夹具（可选键缺省路径：无 description/defaults/scene） */
const MIN_YAML = `key: m23-min
version: 1
name: M23 最小
genre: other
inputs: []
steps:
  - key: only
    action: literal
    title: 唯一步骤
    inputs: {}
`

const canon = (v: unknown): string => JSON.stringify(v)

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { createLogger } = await import('../src/logger')
  const { computeArrange } = await import('../src/services/creation/ops')
  const { addDep, applyTemplateEdits, materializeAfter, removeDep, serializeTemplate, TemplateEditError } = await import(
    '../src/pipeline/template-edit'
  )
  const { avoidTemplateKeyConflict, validateTemplateText } = await import('../src/pipeline/loader')

  const log = createLogger('probe-m23')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ================= [P1] force：力导向布局全矩阵（13 断言） =================
  const sectionForce = async (): Promise<void> => {
    const nodes = [
      { id: 1, x: 0, y: 0, seq: null },
      { id: 2, x: 10, y: 0, seq: null },
      { id: 3, x: 20, y: 0, seq: null },
    ]
    const edges = [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]
    const a = computeArrange(nodes, { edges, mode: 'force' })
    const b = computeArrange(nodes, { edges, mode: 'force' })
    check(a.size === 3, 'force：3 节点全量出坐标')
    check(
      [...a.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
      'force：无 NaN/Infinity',
    )
    check([...a.values()].every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)), 'force：坐标 round 取整')
    check(canon([...a.entries()]) === canon([...b.entries()]), 'force：两次调用确定性等值')
    const minX = Math.min(...[...a.values()].map((p) => p.x))
    const minY = Math.min(...[...a.values()].map((p) => p.y))
    check(minX === 0 && minY === 0, 'force：包围盒左上锚回原锚（0,0）')
    const pts = [...a.values()]
    let minPair = Infinity
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        minPair = Math.min(minPair, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y))
      }
    }
    check(minPair > 100, `force：节点分离（最小对距 ${minPair.toFixed(0)} > 100）`)

    const single = computeArrange([{ id: 9, x: 123, y: 456, seq: null }], { edges: [], mode: 'force' })
    check(single.get(9)!.x === 123 && single.get(9)!.y === 456, 'force：单节点原坐标不动')
    check(computeArrange([], { edges: [], mode: 'force' }).size === 0, 'force：空集合 → 空 Map')

    const two = computeArrange(
      [
        { id: 1, x: 0, y: 0, seq: null },
        { id: 2, x: 5, y: 0, seq: null },
      ],
      { edges: [], mode: 'force' },
    )
    const d2 = Math.hypot(two.get(1)!.x - two.get(2)!.x, two.get(1)!.y - two.get(2)!.y)
    check(d2 > 100, `force：两点无边按 charge/collide 分离（间距 ${d2.toFixed(0)} > 100）`)

    const shifted = computeArrange(
      [
        { id: 1, x: 1000, y: 2000, seq: null },
        { id: 2, x: 1010, y: 2000, seq: null },
        { id: 3, x: 1020, y: 2000, seq: null },
      ],
      { edges, mode: 'force' },
    )
    check(
      Math.min(...[...shifted.values()].map((p) => p.x)) === 1000 &&
        Math.min(...[...shifted.values()].map((p) => p.y)) === 2000,
      'force：带偏移输入锚定回 (1000,2000)',
    )

    const clean12 = computeArrange(nodes, { edges: [{ from: 1, to: 2 }], mode: 'force' })
    const withGhost = computeArrange(nodes, { edges: [{ from: 1, to: 2 }, { from: 2, to: 99 }], mode: 'force' })
    check(
      canon([...withGhost.entries()]) === canon([...clean12.entries()]),
      'force：引用不存在节点的边被过滤（等价于仅合法边）',
    )

    const layered = computeArrange(nodes, { edges, mode: 'layered' })
    check(
      layered.get(1)!.x === 0 && layered.get(2)!.x === 300 && layered.get(3)!.x === 600,
      'layered 快照零漂移（0/300/600）',
    )
    const grid = computeArrange(nodes, { edges, mode: 'grid' })
    check(
      grid.get(1)!.x === 0 && grid.get(2)!.x === 300 && grid.get(3)!.x === 0 && grid.get(3)!.y === 240,
      'grid 快照零漂移（2 列行优先）',
    )
  }

  // ================= [P3] serialize：模板序列化往返（13 断言：全字段/最小模板/转义/键序/key 覆盖） =================
  const sectionSerialize = async (): Promise<void> => {
    const r1 = validateTemplateText(FIXTURE_YAML)
    check(r1.ok && r1.template != null, `夹具 YAML 校验通过（${r1.ok ? 'ok' : r1.errors.join('；')}）`)
    if (!r1.template) return
    const tpl1 = r1.template
    const before = canon(tpl1)
    const text2 = serializeTemplate(tpl1)
    check(canon(tpl1) === before, 'serialize 不改动入参（纯函数）')
    const r2 = validateTemplateText(text2, 'm23-fixture')
    check(r2.ok && r2.template != null, `序列化产物再校验通过（${r2.ok ? 'ok' : r2.errors.join('；')}）`)
    if (!r2.template) return
    check(canon(r2.template) === canon(tpl1), 'parse ∘ stringify 往返等值（全字段）')
    check(
      text2.includes('max_concurrent: 3') && text2.includes('skip_label: 通过') && text2.includes('when_any:'),
      'snake_case 结构键还原（batch/gate/when_any）',
    )
    check(!text2.includes('maxConcurrent'), 'camelCase 不泄漏到 YAML')
    const head = text2.split('\n').slice(0, 3).map((l) => l.split(':')[0]!.trim())
    check(head.join(',') === 'key,version,name', `键序：前 3 键 key/version/name（${head.join(',')}）`)
    check(/after:/.test(text2) && /^\s+- ingest$/m.test(text2), 'after 数组块式输出（- ingest 项）')

    // 转义往返：特殊字符（引号/冒号/井号/反斜杠/换行）经 title 编辑 → serialize → parse 等值
    const tricky = '标"题": #1 \\线\n换行'
    const rTricky = applyTemplateEdits(tpl1, { steps: [{ key: 'gen', title: tricky }] })
    const tText = serializeTemplate(rTricky.template)
    const r3 = validateTemplateText(tText, 'm23-fixture')
    check(
      r3.ok && r3.template != null && r3.template.steps[1]!.title === tricky,
      '转义往返：特殊字符 title（引号/冒号/井号/反斜杠/换行）parse 等值',
    )

    // SerializeOptions.key 覆盖（edit-save 落新 key 复用）
    const renamed = serializeTemplate(tpl1, { key: 'm23-renamed' })
    check(
      renamed.startsWith('key: m23-renamed') && validateTemplateText(renamed, 'm23-renamed').ok,
      'SerializeOptions.key 覆盖生效（validate 通过）',
    )

    // 最小模板：可选键缺省不进入 YAML + 往返等值
    const rMin = validateTemplateText(MIN_YAML)
    check(rMin.ok && rMin.template != null, `最小模板校验通过（${rMin.ok ? 'ok' : rMin.errors.join('；')}）`)
    if (rMin.template) {
      const minText = serializeTemplate(rMin.template)
      check(
        !minText.includes('description') && !minText.includes('defaults') && !minText.includes('scene'),
        '缺省可选键不进入 YAML（description/defaults/scene）',
      )
      const rMin2 = validateTemplateText(minText, 'm23-min')
      check(rMin2.ok && rMin2.template != null && canon(rMin2.template) === canon(rMin.template), '最小模板往返等值')
    }
  }

  // ================= [P3] edit：edits 应用与边操作（物化三态/加边/删边/白名单拒绝/key 避让 27 断言） =================
  const sectionEdit = async (): Promise<void> => {
    const r1 = validateTemplateText(FIXTURE_YAML)
    if (!r1.ok || !r1.template) {
      check(false, `夹具 YAML 校验通过（edit 节前置；${r1.errors.join('；')}）`)
      return
    }
    const tpl = r1.template
    const before = canon(tpl)
    const rejects = (fn: () => unknown): boolean => {
      try {
        fn()
        return false
      } catch (err) {
        return err instanceof TemplateEditError
      }
    }

    const noop = applyTemplateEdits(tpl, { steps: [] })
    check(noop.applied === 0 && canon(noop.template) === before, '空 edits：applied=0 且零改动')

    const res = applyTemplateEdits(tpl, { steps: [{ key: 'gen', title: '新标题', texts: { topic: '新主题' } }] })
    check(
      res.applied === 1 && res.template.steps[1]!.title === '新标题' && res.template.steps[1]!.inputs['topic'] === '新主题',
      'title + texts 覆盖生效',
    )
    check(res.template.steps[1]!.inputs['source'] === 'steps.ingest.assets', '未覆盖的 inputs 字段保持原值')
    check(canon(tpl) === before, 'applyTemplateEdits 不改动入参（纯函数）')

    // 白名单拒绝矩阵（每例均须 TemplateEditError）
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', texts: { meta: 'x' } }] })), 'texts 覆盖非字符串原值 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', texts: { nope: 'x' } }] })), 'texts 未知键 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'nope', title: 'x' }] })), '未知步骤 key → 拒绝')
    check(
      rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'ingest', after: ['gen'] }] })),
      'after 引用非前置（前→后约束）→ 拒绝',
    )
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', after: ['nope'] }] })), 'after 引用不存在 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', after: [1] }] })), 'after 含非字符串 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', title: '  ' }] })), 'title 空白 → 拒绝')
    check(
      rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', title: 'a' }, { key: 'gen', title: 'b' }] })),
      '同一步骤重复编辑 → 拒绝',
    )
    check(rejects(() => applyTemplateEdits(tpl, { steps: [], nope: 1 })), 'edits 未知字段 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, { steps: [{ key: 'gen', foo: 1 }] })), '步骤编辑未知字段 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, { steps: 'x' })), 'edits.steps 非数组 → 拒绝')
    check(rejects(() => applyTemplateEdits(tpl, null)), 'edits 非对象 → 拒绝')

    // 物化三态：显式拷贝 / 首节点 → [] / undefined 非首步 → [前一步]
    check(
      materializeAfter(tpl, 'gen').join(',') === 'ingest' &&
        materializeAfter(tpl, 'ingest').length === 0 &&
        materializeAfter(tpl, 'render').join(',') === 'gen',
      '物化：显式拷贝 / 首节点 → [] / undefined → 前一步（render → gen）',
    )

    // 加边：物化后追加（去重 / 新依赖 / 非前置拒绝）
    check(addDep(tpl, 'gen', 'ingest').join(',') === 'ingest', 'addDep：已存在 → 去重忽略')
    check(addDep(tpl, 'render', 'ingest').join(',') === 'gen,ingest', 'addDep：物化后追加新依赖（gen,ingest）')
    check(rejects(() => addDep(tpl, 'ingest', 'gen')), 'addDep：from 非前置 → 拒绝')

    // 删边：移除后显式空列表 / 无此依赖保持物化列表
    check(removeDep(tpl, 'gen', 'ingest').length === 0, 'removeDep：移除后显式空列表')
    check(removeDep(tpl, 'render', 'ingest').join(',') === 'gen', 'removeDep：无此依赖 → 物化列表不变（显式）')

    // after null：删除显式依赖（回落缺省语义）；显式覆盖后再 null → 物化回「前一步」
    const rNull = applyTemplateEdits(tpl, { steps: [{ key: 'gen', after: null }] })
    check(
      rNull.applied === 1 && rNull.template.steps[1]!.after === undefined,
      'after null：删除显式依赖（字段回落 undefined）',
    )
    const rExplicit = applyTemplateEdits(tpl, { steps: [{ key: 'render', after: ['ingest'] }] })
    check(rExplicit.template.steps[2]!.after!.join(',') === 'ingest', 'after 显式覆盖（render → ingest，跳过 gen）')
    const rBack = applyTemplateEdits(rExplicit.template, { steps: [{ key: 'render', after: null }] })
    check(materializeAfter(rBack.template, 'render').join(',') === 'gen', 'after null 后物化回落「前一步」（gen）')

    // key 避让（edit-save / template-try 共用）：占用 → 后缀 -2；未占用 → 原样
    writeFileSync(join(process.env.CSTUDIO_WORKSPACE!, 'templates', 'm23-avoid.yaml'), FIXTURE_YAML)
    check(avoidTemplateKeyConflict('m23-avoid') === 'm23-avoid-2', 'key 避让：占用 → 后缀 -2')
    check(avoidTemplateKeyConflict('m23-free') === 'm23-free', 'key 避让：未占用 → 原样')
  }

  // ================= [P2] overview：全景聚合（批次分组 / 独立 run / cost 映射 / 空项目 / 404 语义） =================
  const sectionOverview = async (): Promise<void> => {
    const { db, initDb } = await import('../src/db')
    const { batches, pipelineRuns, projects, usageRecords } = await import('../src/db/schema')
    const { buildCanvasOverview } = await import('../src/services/canvas-overview')
    await initDb()
    const T0 = 1_700_000_000_000

    const [proj] = await db
      .insert(projects)
      .values({ name: 'M23 全景项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const pid = proj!.id
    const [b1] = await db
      .insert(batches)
      .values({ projectId: pid, templateKey: 'mengbao-episode', name: '批次A', status: 'running', schedule: '{"max_concurrent":1}', total: 3, finished: 2, succeeded: 1, failed: 1, createdAt: T0, updatedAt: T0 })
      .returning()
    const [b2] = await db
      .insert(batches)
      .values({ projectId: pid, templateKey: 'mengbao-episode', name: '批次B', status: 'completed', schedule: '{"max_concurrent":1}', total: 2, finished: 2, succeeded: 2, failed: 0, createdAt: T0 + 1, updatedAt: T0 + 1 })
      .returning()

    const mkRun = (over: Partial<typeof pipelineRuns.$inferInsert>): typeof pipelineRuns.$inferInsert => ({
      projectId: pid,
      templateKey: 'mengbao-episode',
      status: 'completed',
      input: '{}',
      createdAt: T0,
      updatedAt: T0,
      ...over,
    })
    // 7 runs：批 A 3（completed/failed/running）+ 批 B 2 + 独立 2（completed/cancelled）
    const inserted = await db
      .insert(pipelineRuns)
      .values([
        mkRun({ batchId: b1!.id, batchSeq: 1, templateSnapshot: '{"version":3}', startedAt: T0, completedAt: T0 + 100 }),
        mkRun({ batchId: b1!.id, batchSeq: 2, status: 'failed', error: 'boom' }),
        mkRun({ batchId: b1!.id, batchSeq: 3, status: 'running' }),
        mkRun({ batchId: b2!.id, batchSeq: 1, templateSnapshot: '{"version":2}' }),
        mkRun({ batchId: b2!.id, batchSeq: 2 }),
        mkRun({}),
        mkRun({ status: 'cancelled' }),
      ])
      .returning({ id: pipelineRuns.id })
    const [r1, , , r4, , r6, r7] = inserted

    // usage：r1 = 0.5 + 0.25（二进制精确）；r4 = 1.25；r7 = cost null（未计价）
    await db.insert(usageRecords).values([
      { projectId: pid, runId: r1!.id, kind: 'llm', quantity: 100, unit: 'tokens_in', cost: 0.5, createdAt: T0 },
      { projectId: pid, runId: r1!.id, kind: 'image', quantity: 1, unit: 'image', cost: 0.25, createdAt: T0 },
      { projectId: pid, runId: r4!.id, kind: 'llm', quantity: 200, unit: 'tokens_out', cost: 1.25, createdAt: T0 },
      { projectId: pid, runId: r7!.id, kind: 'llm', quantity: 50, unit: 'tokens_in', cost: null, createdAt: T0 },
    ])

    const ov = await buildCanvasOverview(pid)
    if (!ov) {
      check(false, 'overview：项目聚合返回非 null')
      return
    }
    check(ov.batches.length === 2, `批次分组：2 组（${ov.batches.length}）`)
    check(ov.batches[0]!['name'] === '批次B' && ov.batches[1]!['name'] === '批次A', '批次排序：新批在前（createdAt desc）')
    const bA = ov.batches[1]!
    const bB = ov.batches[0]!
    check(bA.runs.map((r) => r.batchSeq).join(',') === '1,2,3', '批次组内 runs 按 batchSeq 升序')
    check(
      bA['total'] === 3 && bA['finished'] === 2 && bA['succeeded'] === 1 && bA['failed'] === 1 && bA['status'] === 'running',
      '批次头计数与状态回读一致（toBatchView 同构）',
    )
    check(
      ov.standaloneRuns.length === 2 && ov.standaloneRuns.every((r) => r.id === r6!.id || r.id === r7!.id),
      '独立 runs：2 条且不混入批次',
    )
    check(bA.runs[0]!.cost === 0.75 && bB.runs[0]!.cost === 1.25, 'cost 映射：usage 聚合（0.5+0.25=0.75 / 1.25）')
    check(bA.runs[1]!.cost === null, '无 usage → cost null')
    check(bA.runs[0]!.templateVersion === 3 && bB.runs[1]!.templateVersion === null, 'templateVersion：快照解析 / 缺失 → null')
    check(ov.stats.runCount === 7, `stats.runCount = 7（${ov.stats.runCount}）`)
    check(
      ov.stats.byStatus['completed'] === 4 && ov.stats.byStatus['failed'] === 1 && ov.stats.byStatus['running'] === 1 && ov.stats.byStatus['cancelled'] === 1,
      'stats.byStatus 计数（completed 4 / failed 1 / running 1 / cancelled 1）',
    )
    check(ov.stats.totalCost === 2, `stats.totalCost = 2（0.75+1.25，null 不计；实际 ${ov.stats.totalCost}）`)

    // 空项目：无 run → 三空；项目不存在 → null（路由层 404）
    const [proj2] = await db
      .insert(projects)
      .values({ name: 'M23 全景空项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const empty = await buildCanvasOverview(proj2!.id)
    check(
      empty != null && empty.batches.length === 0 && empty.standaloneRuns.length === 0 && empty.stats.runCount === 0 && empty.stats.totalCost === 0 && Object.keys(empty.stats.byStatus).length === 0,
      '空项目：batches / standaloneRuns / stats 全空',
    )
    check((await buildCanvasOverview(999_999)) === null, '项目不存在 → null（路由层 404）')

    // [P2] 编辑模式数据源：buildTemplateCanvas.inputFields（string 可编辑 / 非 string 只读预览）
    writeFileSync(join(process.env.CSTUDIO_WORKSPACE!, 'templates', 'm23-fixture.yaml'), FIXTURE_YAML)
    const { buildTemplateCanvas } = await import('../src/services/canvas')
    const tc = await buildTemplateCanvas('m23-fixture')
    const genNode = tc.nodes.find((n) => n.key === 'gen')!
    check(
      genNode.inputFields.map((f) => f.key).join(',') === 'topic,source,meta',
      'inputFields：顶层字段全量透出且保序（topic,source,meta）',
    )
    check(
      genNode.inputFields.every((f) => (f.editable ? f.key !== 'meta' : f.key === 'meta')) &&
        genNode.inputFields.find((f) => f.key === 'meta')!.value === '{"k":1}',
      'inputFields：string 可编辑 / 非 string 只读 JSON 预览',
    )
  }

  // ================= [P3] advice：摘要确定性 + 解析归一（18 断言） =================
  const sectionAdvice = async (): Promise<void> => {
    const { buildCanvasSummary, parseAdviceOutput } = await import('../src/services/creation/advice')
    const mkNode = (over: Partial<CanvasDocNode> & Pick<CanvasDocNode, 'id' | 'kind'>): CanvasDocNode =>
      ({
        x: 0,
        y: 0,
        title: `节点${over.id}`,
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
        ...over,
      }) as CanvasDocNode
    const doc: CanvasDoc = {
      canvas: { id: 7, projectId: 3, name: '建议夹具', viewport: { x: 0, y: 0, zoom: 1 } },
      // nodes/edges 故意乱序：验证摘要内部确定性排序
      nodes: [
        mkNode({
          id: 12,
          kind: 'gen',
          title: '出图',
          spec: { genKind: 'image', prompt: '一只猫在屋顶', provider: 'openai', model: 'gpt-image-1', size: '1024x1024' },
          status: 'failed',
          readiness: { ready: false, problems: ['缺上游素材'] },
        }),
        mkNode({ id: 5, kind: 'text', title: '提示词', spec: { text: '猫' } }),
        mkNode({ id: 9, kind: 'asset', title: '素材', groupId: 2 }),
        mkNode({ id: 30, kind: 'gen', title: '空提示词', spec: { genKind: 'video', prompt: '   ' }, status: 'idle' }),
      ],
      edges: [
        { id: 3, from: 5, to: 12, port: 'prompt' },
        { id: 1, from: 9, to: 12, port: 'reference' },
      ],
      groups: [{ id: 2, title: '素材组', color: null, collapsed: false, x: 0, y: 0, parentId: null }],
    }
    const s1 = buildCanvasSummary(doc)
    const s2 = buildCanvasSummary(doc)
    check(canon(s1) === canon(s2), 'buildCanvasSummary：两次调用确定性等值')
    check(s1.nodes.map((n) => n.id).join(',') === '5,9,12,30', `摘要节点按 id 升序（${s1.nodes.map((n) => n.id).join(',')}）`)
    check(s1.edges.map((e) => e.from).join(',') === '9,5', '摘要边按 id 升序（9,5）且仅保留 from/to/port')
    const gen12 = s1.nodes.find((n) => n.id === 12)!
    check(
      gen12.gen != null &&
        gen12.gen.genKind === 'image' &&
        gen12.gen.provider === 'openai' &&
        gen12.gen.model === 'gpt-image-1' &&
        gen12.gen.size === '1024x1024' &&
        gen12.gen.duration === undefined &&
        gen12.excerpt === '一只猫在屋顶',
      '摘要 gen 关键参数白名单（genKind/provider/model/size；duration 缺省不入摘要）',
    )
    check(
      gen12.status === 'failed' && gen12.problems?.join(',') === '缺上游素材' && gen12.groupId === null,
      '摘要状态与 problems 透出（failed + 预检问题）',
    )
    const gen30 = s1.nodes.find((n) => n.id === 30)!
    check(gen30.excerpt === undefined && gen30.problems === undefined, '摘要：空白提示词无 excerpt；无问题节点无 problems 字段')
    check(s1.groups[0]!.nodeCount === 1 && s1.groups[0]!.title === '素材组', '摘要组 nodeCount 按 groupId 派生（1）')
    check(
      canon(s1.kindCount) === canon({ text: 1, asset: 1, gen: 2 }) && canon(s1.taskStatus) === canon({ failed: 1, idle: 1 }),
      '摘要 kindCount / taskStatus 计数（gen2/text1/asset1；failed1/idle1）',
    )
    check(
      s1.canvas.nodeCount === 4 && s1.canvas.edgeCount === 2 && s1.canvas.id === 7,
      '摘要 canvas 头（nodeCount/edgeCount/id）',
    )

    // parseAdviceOutput 矩阵
    const valid = new Set([5, 9, 12, 30])
    const okJson = parseAdviceOutput(
      JSON.stringify([{ kind: 'config', targetNodeId: 12, title: '改提示词', detail: '节点 12 提示词过短' }]),
      valid,
    )
    check(
      okJson.mode === 'json' &&
        okJson.advice.length === 1 &&
        okJson.advice[0]!.kind === 'config' &&
        okJson.advice[0]!.targetNodeId === 12 &&
        okJson.advice[0]!.title === '改提示词',
      'parse：正常 JSON 数组 → 全字段保留（mode=json）',
    )
    const fenced = parseAdviceOutput('```json\n[{"kind":"connect","title":"加连线","detail":"9→12 缺参考"}]\n```', valid)
    check(fenced.mode === 'json' && fenced.advice[0]!.kind === 'connect', 'parse：```json 围栏剥离')
    const bare = parseAdviceOutput('这不是 JSON，只是一段建议文本。', valid)
    check(bare.mode === 'raw' && bare.advice.length === 1 && bare.advice[0]!.kind === 'raw', 'parse：裸文本 → 单条 raw 降级')
    const badKind = parseAdviceOutput('[{"kind":"hack","title":"x","detail":"y"}]', valid)
    check(badKind.advice[0]!.kind === 'config', 'parse：kind 白名单外 → 归一 config')
    const badTarget = parseAdviceOutput(
      '[{"kind":"config","targetNodeId":999,"title":"x","detail":"y"},{"kind":"config","targetNodeId":12.5,"title":"y","detail":"z"}]',
      valid,
    )
    check(
      badTarget.advice.length === 2 && badTarget.advice.every((a) => a.targetNodeId === undefined),
      'parse：无效 targetNodeId（不存在 / 非整数）→ 剔除字段保留建议',
    )
    const many = parseAdviceOutput(
      JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ kind: 'cleanup', title: `t${i}`, detail: `d${i}` }))),
      valid,
    )
    check(many.advice.length === 20 && many.advice[19]!.title === 't19', `parse：超量截断 25 → 20（${many.advice.length}）`)
    const filtered = parseAdviceOutput(
      '[{"kind":"config","title":"","detail":"x"},{"kind":"config","title":"t"},42,{"kind":"config","title":"ok","detail":"d"}]',
      valid,
    )
    check(
      filtered.advice.length === 1 && filtered.advice[0]!.title === 'ok',
      'parse：title/detail 缺失或空、非对象项 → 丢弃（保留合法项）',
    )
    const empty = parseAdviceOutput('   ', valid)
    check(empty.advice.length === 0 && empty.mode === 'raw', 'parse：空文本 → 空建议（mode=raw）')
    const objOut = parseAdviceOutput('{"advice":[]}', valid)
    check(objOut.mode === 'raw' && objOut.advice.length === 1, 'parse：非数组 JSON（对象）→ raw 降级（宽容不炸）')
  }

  // ================= [P1] bench：规模化基准（300/600/1000 节点 buildCanvasDoc 耗时） =================
  const sectionBench = async (): Promise<void> => {
    const { db, initDb } = await import('../src/db')
    const { canvasEdges, canvasNodes, canvases, projects } = await import('../src/db/schema')
    const { buildCanvasDoc } = await import('../src/services/creation/doc')
    await initDb()
    const T0 = 1_700_000_000_000
    const [proj] = await db
      .insert(projects)
      .values({ name: 'M23 基准项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const report: string[] = []
    for (const n of [300, 600, 1000]) {
      const [canvas] = await db
        .insert(canvases)
        .values({ projectId: proj!.id, name: `bench-${n}`, viewport: '{"x":0,"y":0,"zoom":1}', createdAt: T0, updatedAt: T0 })
        .returning()
      const cid = canvas!.id
      // 节点 mix：60% gen（走 spec 解析 + 输入规划）/ 30% text / 10% asset
      const nodeValues = Array.from({ length: n }, (_, i) => {
        const mod = i % 10
        const isGen = mod < 6
        const isText = mod >= 6 && mod < 9
        return {
          canvasId: cid,
          kind: isGen ? 'gen' : isText ? 'text' : 'asset',
          title: `${isGen ? 'gen' : isText ? 'text' : 'asset'}-${i}`,
          spec: isGen ? JSON.stringify({ genKind: 'image', provider: 'openai', prompt: `基准提示词 ${i}` }) : isText ? JSON.stringify({ text: `文本 ${i}` }) : null,
          assetId: null as number | null,
          x: (i % 20) * 340,
          y: Math.floor(i / 20) * 260,
          createdAt: T0,
          updatedAt: T0,
        }
      })
      const ids: number[] = []
      for (let i = 0; i < nodeValues.length; i += 100) {
        const rows = await db.insert(canvasNodes).values(nodeValues.slice(i, i + 100)).returning({ id: canvasNodes.id })
        ids.push(...rows.map((r) => r.id))
      }
      // 边：每 5 节点内链式（4/组），port=reference
      const edgeValues: Array<{ canvasId: number; from: number; to: number; port: string; createdAt: number }> = []
      for (let i = 0; i + 1 < ids.length; i += 1) {
        if (i % 5 === 4) continue
        edgeValues.push({ canvasId: cid, from: ids[i]!, to: ids[i + 1]!, port: 'reference', createdAt: T0 })
      }
      for (let i = 0; i < edgeValues.length; i += 100) {
        await db.insert(canvasEdges).values(edgeValues.slice(i, i + 100))
      }
      // 预热一次（冷启动不计）→ 量测一次
      await buildCanvasDoc(cid)
      const t0 = performance.now()
      const doc = await buildCanvasDoc(cid)
      const ms = performance.now() - t0
      check(
        doc != null && doc.nodes.length === n && doc.edges.length === edgeValues.length,
        `bench ${n}：doc 装配完整（nodes=${doc?.nodes.length ?? -1} / edges=${doc?.edges.length ?? -1}）`,
      )
      check(Number.isFinite(ms) && ms < 10_000, `bench ${n}：耗时 ${ms.toFixed(1)}ms < 10000ms`)
      report.push(`${n} 节点/${edgeValues.length} 边：${ms.toFixed(1)}ms`)
    }
    log.info(`  REPORT  基准（二次调用，含 spec 解析/任务查询/输入规划）：${report.join('；')}`)
  }

  const runners: Record<string, () => Promise<void>> = {
    force: sectionForce,
    serialize: sectionSerialize,
    edit: sectionEdit,
    overview: sectionOverview,
    advice: sectionAdvice,
    bench: sectionBench,
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
    console.log(`\n==== M23 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
