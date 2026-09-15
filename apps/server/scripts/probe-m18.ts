/**
 * M18 探针（创作画布四批能力全量补齐：快赢 / 安全 / 深度 / 规模）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m18.ts [--section=p1-schema|frame-extract|compose-v3|run-preview|trash-snapshot|llm-node|template-v2|groups|scale-zip]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db + workspace），
 * 不触碰开发库（同 probe-m2a~m17）。globalThis.fetch stub 兜底（零网络、零计费）。画布 HTTP 全链经 app.request 内存执行。
 *
 * section（默认 all）：
 *   p1-schema      [P1] 迁移与兜底：deleted_at / group_id 列 + canvas_groups / canvas_snapshots 表与索引 +
 *                  schema 读写冒烟 + initDb 幂等
 *   frame-extract  [P2] 抽帧：frameTimeOf 全模式矩阵 + buildFrameExtractArgs 快照 + 端点全链（真实 ffmpeg）
 *   compose-v3     [P2] 合成 v3：buildComposeArgs 快照（旧形态输出不变 / 转场 / BGM / 降级）+ 真实合成冒烟
 *   run-preview    [P2] 成本预估：preflight + 定价链 + 各 genKind 单位矩阵 + 响应结构
 *   trash-snapshot [P3] 回收站与快照：软删/在途取消/trash 列表/restore/purge + 保留 id 重放（任务历史认领）
 *   llm-node       [P4] LLM 节点：端口 v3 全组合 + specProblems + 执行链 + 产物文本下游装载
 *   template-v2    [P5] 模板 v2：literal action + ai_text prompt_inline + draft v2 映射 + template-try 全链
 *   groups         [P6] 画布分组：CRUD + 跨组拒绝 + 解组 + 读模型
 *   scale-zip      [P6] 封面派生矩阵 + 流式 zip 对拍（名称/数量/内容等价 + 大文件路径）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
const TMP_PREFIX = 'acs-probe-m18-'
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
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })
// LLM 兜底屏蔽（隔离）：dotenv 不覆盖已存在 key → .env 的 AGENT_LLM_* 不参与；本探针只走 api_configs 种子
process.env.AGENT_LLM_BASE_URL = ''
process.env.AGENT_LLM_API_KEY = ''

const SECTIONS = [
  'p1-schema',
  'frame-extract',
  'compose-v3',
  'run-preview',
  'trash-snapshot',
  'llm-node',
  'template-v2',
  'groups',
  'scale-zip',
] as const

// ---- fetch stub：兜底安全网（本探针零真实外发请求）----
const stubFetch = (async (): Promise<Response> => {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

/** 任务收敛轮询间隔（对齐 probe-m16/m17 执行通道模式） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { apiConfigs, assets, canvasEdges, canvasGroups, canvasNodes, canvasSnapshots, canvases, genTasks, pipelineRuns, projects, settings, usageRecords } = await import('../src/db/schema')
  const { and, eq, inArray } = await import('drizzle-orm')
  const { app } = await import('../src/app')
  const { spawnSync } = await import('node:child_process')
  const { probeMediaDuration, resolveFfmpeg } = await import('../src/services/ffmpeg')
  const { absPathOf, ensureProjectDirs, relPathOf } = await import('../src/services/storage')

  const log = createLogger('probe-m18')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ---- setup：隔离库 + 种子工厂 ----
  await initDb()
  const T0 = 1_700_000_000_000

  const mkProject = async (name: string): Promise<number> => {
    const id = (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
    ensureProjectDirs(id) // 媒体落盘目录（genMedia 输出依赖；真实链由服务端各自 ensure）
    return id
  }

  /** 资产工厂（relPath/duration/软删等可选；对齐 probe-m17 超集） */
  const mkAsset = async (
    projectId: number,
    kind: string,
    name: string,
    opts: { purpose?: string; relPath?: string; duration?: number; deletedAt?: number; width?: number; height?: number } = {},
  ): Promise<number> =>
    (
      await db
        .insert(assets)
        .values({
          projectId,
          kind,
          name,
          purpose: opts.purpose ?? null,
          mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'text/plain',
          relPath: opts.relPath ?? null,
          duration: opts.duration ?? null,
          deletedAt: opts.deletedAt ?? null,
          width: opts.width ?? null,
          height: opts.height ?? null,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id

  /** 真实媒体生成（ffmpeg lavfi；ffmpeg 不可用 → false 走 SKIP 分支；失败打印 stderr 尾部便于诊断） */
  const ffmpegBin = resolveFfmpeg()
  const genMedia = (outAbs: string, args: string[]): boolean => {
    if (!ffmpegBin) return false
    const r = spawnSync(ffmpegBin, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (!r.error && r.status === 0) return true
    log.warn(`genMedia 失败（${outAbs}）：${r.error?.message ?? `exit=${r.status}`} ${String(r.stderr ?? '').trim().split(/\r?\n/).slice(-2).join(' | ')}`)
    return false
  }

  /** 任务收敛轮询（对齐 probe-m17）：全终态或超时（25s）返回 id→status */
  const settleTasks = async (ids: number[]): Promise<Map<number, string>> => {
    const deadline = Date.now() + 25_000
    for (;;) {
      const rows = await db.select({ id: genTasks.id, status: genTasks.status }).from(genTasks).where(inArray(genTasks.id, ids))
      const m = new Map(rows.map((r) => [r.id, r.status]))
      if ([...m.values()].every((s) => s === 'succeeded' || s === 'failed' || s === 'cancelled')) return m
      if (Date.now() > deadline) return m
      await sleep(300)
    }
  }

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

  // ================= sections =================

  /** ⑧ [P1] 迁移与兜底：列/表/索引 + schema 读写冒烟 + initDb 幂等 */
  const sectionP1Schema = async (): Promise<void> => {
    const cvCols = await sqlite.execute("PRAGMA table_info('canvases')")
    const cvNames = new Set((cvCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
    check(cvNames.has('deleted_at'), 'canvases.deleted_at 列存在（ensureColumn）')
    const cnCols = await sqlite.execute("PRAGMA table_info('canvas_nodes')")
    const cnNames = new Set((cnCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
    check(cnNames.has('group_id'), 'canvas_nodes.group_id 列存在（ensureColumn）')

    const tbl = async (name: string): Promise<number> => {
      const r = await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`)
      return r.rows.length
    }
    const idx = async (name: string): Promise<number> => {
      const r = await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name='${name}'`)
      return r.rows.length
    }
    check((await tbl('canvas_groups')) === 1, 'canvas_groups 表存在（ensureTable）')
    check((await tbl('canvas_snapshots')) === 1, 'canvas_snapshots 表存在（ensureTable）')
    check((await idx('idx_canvas_groups_canvas')) === 1, 'canvas_groups 索引存在')
    check((await idx('idx_canvas_snapshots_canvas')) === 1, 'canvas_snapshots 索引存在')

    // ---- schema 读写冒烟（drizzle 导出直用）----
    const [g] = await db.insert(canvasGroups).values({ canvasId: 1, title: '组甲', createdAt: T0 }).returning()
    check(g!.collapsed === 0 && g!.x === 0 && g!.color === null, 'canvas_groups 插入默认值（collapsed=0 / x=0 / color=null）')
    const [gUp] = await db
      .update(canvasGroups)
      .set({ collapsed: 1, title: '组乙', color: 'blue' })
      .where(eq(canvasGroups.id, g!.id))
      .returning()
    check(gUp!.collapsed === 1 && gUp!.title === '组乙' && gUp!.color === 'blue', 'canvas_groups PATCH 持久化（collapsed/title/color）')

    const [s] = await db
      .insert(canvasSnapshots)
      .values({ canvasId: 1, label: '冒烟', doc: JSON.stringify({ nodes: [], edges: [], groups: [] }), createdAt: T0 })
      .returning()
    const sRows = await db.select().from(canvasSnapshots).where(eq(canvasSnapshots.id, s!.id))
    check(sRows.length === 1 && JSON.parse(sRows[0]!.doc).nodes.length === 0, 'canvas_snapshots 插入/读回（doc JSON 往返）')

    // ---- initDb 幂等：二次执行（ensureX 全 no-op + migrate 跳过）----
    await initDb()
    check(true, 'initDb 二次执行无异常（幂等）')

    // 清理冒烟行
    await db.delete(canvasSnapshots).where(eq(canvasSnapshots.id, s!.id))
    await db.delete(canvasGroups).where(eq(canvasGroups.id, g!.id))
  }

  /** ① [P2] 抽帧：frameTimeOf 全模式矩阵 + buildFrameExtractArgs 快照 + 端点全链（真实 ffmpeg） */
  const sectionFrameExtract = async (): Promise<void> => {
    const { buildFrameExtractArgs, frameTimeOf } = await import('../src/services/creation/gen')

    // ---- frameTimeOf 全模式矩阵 ----
    check(frameTimeOf('first', null, 10) === 0.1, 'first：常规 10s → 0.1（避开淡入）')
    check(frameTimeOf('first', null, 0.1) === 0.05, 'first：超短视频 → 中点（min(0.1, dur/2)）')
    check(frameTimeOf('first', null, null) === 0.1, 'first：时长未知 → 0.1')
    check(frameTimeOf('last', null, 10) === 9.9, 'last：常规 10s → 9.9（dur−0.1）')
    check(frameTimeOf('last', null, 0.05) === 0, 'last：极短 → 0（下界收口）')
    check(frameTimeOf('last', null, null) === 0.1, 'last：时长未知 → 0.1')
    check(frameTimeOf('custom', 5.5, 10) === 5.5, 'custom：正常取值')
    check(frameTimeOf('custom', 20, 10) === 9.95, 'custom：上界 clamp 到 dur−0.05')
    check(frameTimeOf('custom', -3, 10) === 0, 'custom：负值 clamp 到 0')
    check(frameTimeOf('custom', 5, null) === 5, 'custom：时长未知仅下界')

    // ---- buildFrameExtractArgs 快照 ----
    check(
      JSON.stringify(buildFrameExtractArgs('in.mp4', 'o.jpg', 0.1)) ===
        JSON.stringify(['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.1', '-i', 'in.mp4', '-frames:v', '1', '-q:v', '2', 'o.jpg']),
      'buildFrameExtractArgs 快照（-ss 前置 / 全尺寸 jpg / -q:v 2）',
    )

    // ---- 端点全链（真实 ffmpeg） ----
    const PID = await mkProject('M18 抽帧')
    const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '抽帧画布' })).body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id

    if (!ffmpegBin) {
      log.info('  SKIP  抽帧端点全链（未找到 ffmpeg：仓库根 pnpm install / 配置 CSTUDIO_FFMPEG_PATH）')
      return
    }
    const vRel = relPathOf(PID, 'creation_video', 'probe-src-2s.mp4')
    const vAbs = absPathOf(vRel)
    const okGen = genMedia(vAbs, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', '-t', '2', vAbs])
    check(okGen, 'ffmpeg 生成测试视频（testsrc 2s）')
    if (!okGen) return
    const VID = await mkAsset(PID, 'video', '源视频', { relPath: vRel, duration: 2, width: 160, height: 120 })
    const IMA = await mkAsset(PID, 'image', '图片素材')
    const VDEL = await mkAsset(PID, 'video', '软删视频', { relPath: vRel, duration: 2 })
    const VNOREL = await mkAsset(PID, 'video', '无文件视频')

    const NAV = await mkNode({ kind: 'asset', assetId: VID, x: 400, y: 300 })
    const NAI = await mkNode({ kind: 'asset', assetId: IMA, x: 400, y: 500 })
    const NAVD = await mkNode({ kind: 'asset', assetId: VDEL, x: 400, y: 700 })
    const NAVN = await mkNode({ kind: 'asset', assetId: VNOREL, x: 400, y: 800 })
    await db.update(assets).set({ deletedAt: T0 }).where(eq(assets.id, VDEL)) // 建节点后软删（复刻回收站时序）

    // asset 源 · first
    const r1 = await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'first' })
    const p1 = JSON.parse(String(r1.body?.asset?.params ?? '{}'))
    check(r1.status === 201 && r1.body?.node?.kind === 'asset' && r1.body?.asset?.kind === 'image', 'asset 源抽帧 → 201（asset 节点 + image 资产）')
    check(r1.body?.asset?.purpose === 'creation_frame' && r1.body?.asset?.mime === 'image/jpeg', 'purpose=creation_frame / mime=image/jpeg')
    check(p1.timeSec === 0.1 && p1.sourceAssetId === VID && p1.mode === 'first', 'params：timeSec=0.1 / sourceAssetId / mode')
    check(r1.body?.node?.x === 460 && r1.body?.node?.y === 440, '缺省位置 = 源节点右下偏移（+60/+140）')
    check(String(r1.body?.node?.title ?? '') === '抽帧 0.1s', '节点 title=抽帧 0.1s')
    const outAbs1 = absPathOf(String(r1.body?.asset?.relPath ?? ''))
    const head1 = existsSync(outAbs1) ? readFileSync(outAbs1).subarray(0, 2) : Buffer.alloc(0)
    check(head1.length === 2 && head1[0] === 0xff && head1[1] === 0xd8, '产物文件存在且为 JPEG（FFD8 魔数）')

    // gen(video) 显示产物（造 succeeded 任务）
    const NG = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: '测试视频' }, x: 700, y: 300 })
    await db.insert(genTasks).values({ projectId: PID, runId: null, stepId: null, canvasNodeId: NG, kind: 'video', params: '{}', status: 'succeeded', resultAssetId: VID, createdAt: T0, updatedAt: T0 })
    const r2 = await jreq('POST', `/api/v1/nodes/${NG}/extract-frame`, { mode: 'last' })
    check(r2.status === 201 && JSON.parse(String(r2.body?.asset?.params ?? '{}')).timeSec === 1.9, 'gen 源（显示产物）· last → 1.9')

    // custom clamp + 显式坐标
    const r3 = await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'custom', time: 99, x: 555, y: 666 })
    check(
      r3.status === 201 && JSON.parse(String(r3.body?.asset?.params ?? '{}')).timeSec === 1.95 && r3.body?.node?.x === 555 && r3.body?.node?.y === 666,
      'custom：time=99 → clamp 1.95 + 显式坐标生效',
    )

    // ---- 错误族 ----
    check((await jreq('POST', `/api/v1/nodes/${NAI}/extract-frame`, {})).status === 400, '非视频素材 → 400')
    check((await jreq('POST', `/api/v1/nodes/${NAVD}/extract-frame`, {})).status === 400, '软删视频 → 400')
    check((await jreq('POST', `/api/v1/nodes/${NAVN}/extract-frame`, {})).status === 400, '无文件视频 → 400')
    check((await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'nope' })).status === 400, 'mode 非法 → 400')
    check((await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'custom', time: 'abc' })).status === 400, 'time 非数值 → 400')
    check((await jreq('POST', '/api/v1/nodes/999999/extract-frame', {})).status === 400, '节点不存在 → 400')
    const NGI = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 700, y: 500 })
    check((await jreq('POST', `/api/v1/nodes/${NGI}/extract-frame`, {})).status === 400, '非视频 gen → 400')
    const NGV2 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'v' }, x: 700, y: 600 })
    const rNone = await jreq('POST', `/api/v1/nodes/${NGV2}/extract-frame`, {})
    check(rNone.status === 400 && String(rNone.body?.error?.message ?? '').includes('暂无可用产物'), 'gen(video) 无产物 → 400「暂无可用产物」')
    const NTX = await mkNode({ kind: 'text', spec: { text: 'x' }, x: 700, y: 700 })
    check((await jreq('POST', `/api/v1/nodes/${NTX}/extract-frame`, {})).status === 400, 'text 节点 → 400')
  }

  /** ② [P2] 合成 v3：buildComposeArgs 快照（旧形态零变化/转场/BGM/降级）+ 真实合成全链 */
  const sectionComposeV3 = async (): Promise<void> => {
    const { buildComposeArgs } = await import('../src/services/creation/gen')
    const SZ = { width: 100, height: 100 }

    // ---- 旧形态零变化（probe-m17 快照基线） ----
    const a1 = buildComposeArgs({ videoPaths: ['a.mp4'], audioPaths: [], outPath: 'o.mp4' })
    check(
      a1.join(' ') === '-y -i a.mp4 -map 0:v -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an -movflags +faststart o.mp4',
      'N=1 无新参数 → 旧形态零变化（回归基线）',
    )

    // ---- 转场启用（n=2） ----
    const x1 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], transition: 'fade', transitionDuration: 0.5 }).join(' ')
    check(
      x1.includes('[0:v]scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=0.5,settb=AVTB[v0]'),
      '转场：段0 tpad 冻帧补足 T + settb=AVTB',
    )
    check(
      x1.includes('[1:v]scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,settb=AVTB[v1]'),
      '转场：段1（末镜）无 tpad',
    )
    check(x1.includes('[v0][v1]xfade=transition=fade:duration=0.5:offset=4[vout]'), 'xfade 链：offset=4（=Σd 首段）')
    check(!x1.includes('concat'), '转场启用：不出现 concat')
    check(x1.includes('-map [vout]'), '转场：maps [vout]')

    // ---- none / durations 不齐 / 缺失 → 宽容降级 concat ----
    const x2 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], transition: 'none' }).join(' ')
    check(x2.includes('concat=n=2:v=1:a=0[vout]') && !x2.includes('xfade'), 'transition=none → concat（durations 齐备也不启用）')
    const x3 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4], transition: 'fade' }).join(' ')
    check(x3.includes('concat=n=2') && !x3.includes('xfade'), 'durations 长度不齐 → 降级 concat')
    const x4 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, transition: 'fade' }).join(' ')
    check(x4.includes('concat=n=2') && !x4.includes('xfade'), 'durations 缺失 → 降级 concat')

    // ---- M17 音频基线（-map [aout] 回归守卫） ----
    const x0 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: ['v.mp3'], outPath: 'o.mp4', fps: 24, size: SZ }).join(' ')
    check(
      x0.includes('[2:a]amix=inputs=1:duration=longest[aout]') && x0.includes('-map [aout]') && x0.includes('-c:a aac'),
      'M17 音频基线：amix[aout] → -map [aout] + -c:a aac（回归守卫）',
    )

    // ---- BGM（无原音轨 → anull） ----
    const x5 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], bgmPath: 'b.mp3' }).join(' ')
    check(x5.includes('-stream_loop -1 -i b.mp3'), 'BGM：-stream_loop -1 输入')
    check(x5.includes('atrim=0:9') && x5.includes('volume=0.5'), 'BGM：atrim=0:totalDur(9) / 默认 volume 0.5')
    check(x5.includes('afade=t=in:st=0:d=1.5') && x5.includes('afade=t=out:st=7.5:d=1.5'), 'BGM：默认首尾 afade 1.5s')
    check(x5.includes('[bgm]anull[aout]') && x5.includes('-map [aout]') && x5.includes('-c:a aac'), 'BGM 无原音轨 → anull[aout] + -map [aout] + -c:a aac')

    // ---- BGM + 原音轨（amix normalize=0；m=1 索引推导） ----
    const x6 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: ['v.mp3'], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], bgmPath: 'b.mp3', bgmVolume: 0.3, bgmFade: false }).join(' ')
    check(x6.includes('[2:a]amix=inputs=1:duration=longest[amix]'), '原音轨 amix 中转 [amix]（n=2 → 输入索引 2）')
    check(x6.includes('[3:a]atrim=0:9') && x6.includes('volume=0.3') && !x6.includes('afade'), 'bgmVolume=0.3 / bgmFade=false → 无 afade')
    check(x6.includes('[amix][bgm]amix=inputs=2:duration=first:normalize=0[aout]') && x6.includes('-map [aout]'), 'BGM 混音：amix duration=first:normalize=0 + -map [aout]')

    // ---- 真实合成全链（转场 + BGM；真实 ffmpeg） ----
    const PID = await mkProject('M18 合成')
    const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '合成画布' })).body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    if (!ffmpegBin) {
      log.info('  SKIP  真实合成全链（未找到 ffmpeg）')
      return
    }
    const v1Rel = relPathOf(PID, 'creation_video', 'seg1.mp4')
    const v2Rel = relPathOf(PID, 'creation_video', 'seg2.mp4')
    const bRel = relPathOf(PID, 'creation_audio', 'bgm.wav')
    const mkArgs = (src: string, out: string): string[] => ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-pix_fmt', 'yuv420p', '-t', '1', out]
    const ok1 = genMedia(absPathOf(v1Rel), mkArgs('testsrc=duration=1:size=160x120:rate=10', absPathOf(v1Rel)))
    const ok2 = genMedia(absPathOf(v2Rel), mkArgs('testsrc=duration=1:size=160x120:rate=10', absPathOf(v2Rel)))
    const ok3 = genMedia(absPathOf(bRel), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-t', '3', absPathOf(bRel)])
    check(ok1 && ok2 && ok3, 'ffmpeg 生成 2 段测试视频 + 1 段 BGM（wav）')
    if (!(ok1 && ok2 && ok3)) return
    const A1 = await mkAsset(PID, 'video', '段1', { relPath: v1Rel, duration: 1, width: 160, height: 120 })
    const A2 = await mkAsset(PID, 'video', '段2', { relPath: v2Rel, duration: 1, width: 160, height: 120 })
    const AB = await mkAsset(PID, 'audio', 'BGM', { relPath: bRel, duration: 3 })
    const N1 = await mkNode({ kind: 'asset', assetId: A1, x: 0, y: 0 })
    const N2 = await mkNode({ kind: 'asset', assetId: A2, x: 0, y: 100 })
    const NC = await mkNode({ kind: 'gen', spec: { genKind: 'compose', fps: 10, resolution: '160x120', transition: 'fade', transitionDuration: 0.5, bgmAssetId: AB, bgmFade: false }, x: 300, y: 0 })
    await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: N1, to: NC, port: 'video' })
    await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: N2, to: NC, port: 'video' })
    const run = await jreq('POST', `/api/v1/nodes/${NC}/run`, {})
    check(run.status === 200 && run.body?.taskIds?.length === 1, 'compose 全链：run → 任务入队')
    const st = await settleTasks([run.body.taskIds[0]])
    check(st.get(run.body.taskIds[0]) === 'succeeded', 'compose 全链：succeeded（真实 ffmpeg + xfade + BGM）')
    const outs = await db.select().from(assets).where(and(eq(assets.projectId, PID), eq(assets.purpose, 'creation_compose')))
    const outA = outs[0]
    check(!!outA && outA.kind === 'video', 'compose 产物：video 资产落库')
    if (outA?.relPath) {
      const oAbs = absPathOf(outA.relPath)
      check(existsSync(oAbs) && statSync(oAbs).size > 1000, 'compose 产物文件存在（>1KB）')
      const dur = probeMediaDuration(oAbs)
      check(dur != null && Math.abs(dur - 2) < 0.35, `成片时长 ≈ 2s（实际 ${dur == null ? 'null' : Math.round(dur * 100) / 100}）`)
    }
    if (outA?.params) {
      const pOut = JSON.parse(outA.params) as Record<string, unknown>
      check(pOut.transition === 'fade' && pOut.bgmAssetId === AB, '产物 params：transition/bgmAssetId 留痕')
    }
  }

  /** ③ [P2] 成本预估：定价链（实例级 → settings → unpriced）+ 各 genKind 单位矩阵 + 响应结构 + preflight 回归 */
  const sectionRunPreview = async (): Promise<void> => {
    const PID = await mkProject('M18 预估')
    const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '预估画布' })).body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id

    // ---- 定价种子：实例级（image/second/char 扁平 pricing）+ 全局兜底（video） ----
    const cfgBase = { serviceType: 'image', priority: 100, isDefault: 1, isActive: 1, createdAt: T0, updatedAt: T0 }
    await db.insert(apiConfigs).values({ ...cfgBase, providerKey: 'probe-vendor', name: 'probe 图像', model: 'pv-1', pricing: JSON.stringify({ image: 0.5, second: 0.1, char: 30 }) })
    await db.insert(apiConfigs).values({ ...cfgBase, serviceType: 'audio', providerKey: 'probe-tts', name: 'probe 配音', model: 'tts-1', pricing: JSON.stringify({ char: 30 }) })
    await db.insert(settings).values({ key: 'pricing', value: JSON.stringify({ video: { 'probe-global:*': { second: 0.2 } } }), updatedAt: T0 })

    // ---- 节点矩阵 ----
    const NI = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '图片', provider: 'probe-vendor', model: 'pv-1' }, x: 0, y: 0 })
    const NV = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: '视频', provider: 'probe-global', duration: 8 }, x: 0, y: 100 })
    const NV2 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: '视频2', provider: 'probe-global' }, x: 0, y: 200 })
    const NA = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: '你好世界', provider: 'probe-tts' }, x: 0, y: 300 })
    const NC = await mkNode({ kind: 'gen', spec: { genKind: 'compose', resolution: '160x120' }, x: 0, y: 400 })
    const AV = await mkAsset(PID, 'video', '预估视频素材', { duration: 2 })
    const NAV = await mkNode({ kind: 'asset', assetId: AV, x: -200, y: 400 })
    await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NAV, to: NC, port: 'video' })
    const NX = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '未计价', provider: 'nobody' }, x: 0, y: 500 })
    const NBLOCKED = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 0, y: 600 })
    const NBUSY = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '忙', provider: 'probe-vendor', model: 'pv-1' }, x: 0, y: 700 })
    await db.insert(genTasks).values({ projectId: PID, runId: null, stepId: null, canvasNodeId: NBUSY, kind: 'image', params: '{}', status: 'processing', createdAt: T0, updatedAt: T0 })

    const ids = [NI, NV, NV2, NA, NC, NX, NBLOCKED, NBUSY]
    const r = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: ids })
    check(r.status === 200 && r.body?.nodes?.length === 8, 'run-preview → 200（8 节点条目）')
    const byId = new Map<number, any>((r.body?.nodes ?? []).map((n: any) => [n.nodeId, n]))

    const i = byId.get(NI)
    check(
      i?.ready === true && i?.units?.[0]?.unit === 'image' && i?.units?.[0]?.quantity === 1 && i?.units?.[0]?.unitPrice === 0.5 && i?.total === 0.5,
      'image：实例级 0.5/张 → 0.5',
    )
    const v = byId.get(NV)
    check(v?.units?.[0]?.unit === 'second' && v?.units?.[0]?.quantity === 8 && v?.units?.[0]?.unitPrice === 0.2 && Math.abs(v?.total - 1.6) < 1e-9, 'video：全局兜底 0.2/秒 × 8s = 1.6')
    const v2 = byId.get(NV2)
    check(v2?.units?.[0]?.quantity === 5 && v2?.total === 1, 'video：duration 缺省 → 5s（1.0）')
    const a = byId.get(NA)
    check(a?.units?.[0]?.unit === 'char' && a?.units?.[0]?.quantity === 4 && a?.units?.[0]?.unitPrice === 0.03 && Math.abs(a?.total - 0.12) < 1e-9, 'audio：char 30/千字 × 4 字 = 0.12')
    const cc = byId.get(NC)
    check(cc?.ready === true && cc?.units?.length === 0 && cc?.total === 0 && cc?.unpriced === false, 'compose：本地零成本（units 空 / total=0）')
    const x = byId.get(NX)
    check(x?.unpriced === true && x?.total === null && x?.units?.[0]?.unitPrice === null, '未命中定价 → unpriced / total=null')
    const bl = byId.get(NBLOCKED)
    check(bl?.ready === false && (bl?.problems?.length ?? 0) > 0 && bl?.units?.length === 0, '未就绪 → ready=false + problems + 无单位行')
    const bu = byId.get(NBUSY)
    check(bu?.busy === true && bu?.ready === false, 'busy=processing → busy=true / ready=false')

    check(Math.abs((r.body?.total?.amount ?? 0) - 3.72) < 1e-6, `total.amount = 0.5+1.6+1.0+0.12+0+0.5 = 3.72（实际 ${r.body?.total?.amount}）`)
    check(r.body?.total?.unpriced === 1 && r.body?.total?.ready === 6 && r.body?.total?.blocked === 1 && r.body?.total?.busy === 1, 'total 聚合：unpriced=1 / ready=6 / blocked=1 / busy=1')

    // ---- 实例级优先于全局（同 kind 双源） ----
    await db
      .update(settings)
      .set({ value: JSON.stringify({ image: { 'probe-vendor:pv-1': { image: 9 }, 'probe-vendor:*': { image: 8 } }, video: { 'probe-global:*': { second: 0.2 } } }) })
      .where(eq(settings.key, 'pricing'))
    const r2 = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [NI] })
    check(r2.body?.nodes?.[0]?.units?.[0]?.unitPrice === 0.5, '实例级定价优先于 settings.pricing（0.5 不被 9 覆盖）')

    // ---- 缺省 nodeIds = 全部 gen 节点 / 非法 nodeIds → 400 ----
    const r3 = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, {})
    check(r3.status === 200 && r3.body?.nodes?.length === 8, '缺省 nodeIds → 全部 gen 节点（8）')
    check((await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: 'x' })).status === 400, 'nodeIds 非数组 → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [] })).status === 400, 'nodeIds 空数组 → 400')
    check((await jreq('POST', '/api/v1/canvases/999999/run-preview', {})).status === 404, '画布不存在 → 404')

    // ---- 他画布节点：失败条目（不炸） ----
    const C2 = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '别的画布' })).body.canvas.id
    const GN2 = (await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })).body.node.id
    const r4 = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [GN2] })
    check(
      r4.status === 200 && r4.body?.nodes?.[0]?.ready === false && String(r4.body?.nodes?.[0]?.problems?.[0] ?? '').includes('不属于该画布'),
      '他画布节点 → 失败条目（不属于该画布）',
    )

    // ---- preflight 重构回归：run 错误路径文案不变 ----
    const rb = await jreq('POST', `/api/v1/nodes/${NBLOCKED}/run`, {})
    check(rb.status === 400 && String(rb.body?.error?.message ?? '').includes('未就绪'), 'run 回归：未就绪 → 400「节点未就绪」（preflight 同源）')
    const rbusy = await jreq('POST', `/api/v1/nodes/${NBUSY}/run`, {})
    check(rbusy.status === 400 && String(rbusy.body?.error?.message ?? '').includes('已有进行中的任务'), 'run 回归：busy → 400（文案保持）')
  }

  /** ④ [P3] 回收站与快照：软删/在途取消/列表排除/trash/restore/purge + 快照（保留 id 重放/自动备份/上限/冲突 409） */
  const sectionTrashSnapshot = async (): Promise<void> => {
    const PID = await mkProject('M18 安全')
    const mkCanvas = async (name: string): Promise<number> =>
      (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name })).body.canvas.id
    const mkNode = async (canvasId: number, body: unknown): Promise<number> =>
      (await jreq('POST', `/api/v1/canvases/${canvasId}/nodes`, body)).body.node.id

    // ---------- C1：快照主体（asset→compose 边 + 任务挂靠） ----------
    const C1 = await mkCanvas('主画布')
    const AV = await mkAsset(PID, 'video', '快照视频', { duration: 1 })
    const NAV = await mkNode(C1, { kind: 'asset', assetId: AV, x: 0, y: 0 })
    const NC = await mkNode(C1, { kind: 'gen', spec: { genKind: 'compose', resolution: '160x120' }, x: 300, y: 0 })
    const e1 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: NAV, to: NC, port: 'video' })
    const EID = e1.body.edge.id
    const TASK = (
      await db
        .insert(genTasks)
        .values({ projectId: PID, runId: null, stepId: null, canvasNodeId: NC, kind: 'compose', params: '{}', status: 'succeeded', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id

    // ---------- C2：回收站全链（软删 / 在途取消 / 列表 / restore / purge） ----------
    const C2 = await mkCanvas('待删画布')
    const N2 = await mkNode(C2, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })
    const mkTask = async (status: string): Promise<number> =>
      (
        await db
          .insert(genTasks)
          .values({ projectId: PID, runId: null, stepId: null, canvasNodeId: N2, kind: 'image', params: '{}', status, createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!.id
    const TP = await mkTask('pending')
    const TQ = await mkTask('processing')

    const del = await jreq('DELETE', `/api/v1/canvases/${C2}`)
    check(del.status === 200 && del.body?.mode === 'trashed' && typeof del.body?.deletedAt === 'number' && del.body?.cancelled === 2, 'DELETE → 软删（mode=trashed / cancelled=2）')
    const tsk = await db.select().from(genTasks).where(inArray(genTasks.id, [TP, TQ]))
    check(tsk.length === 2 && tsk.every((t) => t.status === 'cancelled' && t.errorMsg === 'user cancelled' && t.completedAt != null), '在途任务自动取消（pending/processing → cancelled + errorMsg）')
    const listA = await jreq('GET', `/api/v1/projects/${PID}/canvases`)
    check(!(listA.body?.items ?? []).some((i: any) => i.id === C2), '默认列表排除已删画布')
    const listT = await jreq('GET', `/api/v1/projects/${PID}/canvases?trash=1`)
    const tItem = (listT.body?.items ?? []).find((i: any) => i.id === C2)
    check(!!tItem && typeof tItem.deletedAt === 'number' && tItem.nodeCount === 1, 'trash 列表：含 deletedAt + nodeCount（1）')
    check((await jreq('GET', `/api/v1/canvases/${C2}`)).status === 404, '已删画布 doc → 404')
    check((await jreq('PATCH', `/api/v1/canvases/${C2}`, { name: 'x' })).status === 404, '已删画布 PATCH → 404')
    check((await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'text', spec: { text: 'x' }, x: 0, y: 0 })).status === 404, '已删画布建节点 → 404')
    check((await jreq('GET', `/api/v1/canvases/${C2}/snapshots`)).status === 404, '已删画布快照列表 → 404')
    check((await jreq('DELETE', `/api/v1/canvases/${C2}`)).status === 404, '二次 DELETE（已在回收站）→ 404')

    const rActive = await jreq('POST', `/api/v1/canvases/${C1}/restore`, {})
    check(rActive.status === 400 && rActive.body?.error?.code === 'bad_state', 'restore 活跃画布 → 400 bad_state')
    const rr = await jreq('POST', `/api/v1/canvases/${C2}/restore`, {})
    check(rr.status === 200 && rr.body?.canvas?.deletedAt === null, 'restore → 200（已删→deletedAt=null）')
    check((await jreq('GET', `/api/v1/canvases/${C2}`)).status === 200, '恢复后 doc 可读（200）')
    const listB = await jreq('GET', `/api/v1/projects/${PID}/canvases`)
    check((listB.body?.items ?? []).some((i: any) => i.id === C2), '恢复后回默认列表')
    check((await jreq('POST', '/api/v1/canvases/999999/restore', {})).status === 404, 'restore 不存在 → 404')
    const pActive = await jreq('POST', `/api/v1/canvases/${C1}/purge`, {})
    check(pActive.status === 400 && pActive.body?.error?.code === 'bad_state', 'purge 活跃画布 → 400 bad_state')
    await jreq('DELETE', `/api/v1/canvases/${C2}`)
    const pg = await jreq('POST', `/api/v1/canvases/${C2}/purge`, {})
    check(pg.status === 200, '先软删后 purge → 200')
    check((await db.select().from(canvases).where(eq(canvases.id, C2))).length === 0, 'purge：canvases 行已删')
    check((await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, C2))).length === 0, 'purge 级联：canvas_nodes 零行')
    check((await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, C2))).length === 0, 'purge 级联：canvas_edges 零行')
    check((await db.select().from(genTasks).where(inArray(genTasks.id, [TP, TQ]))).length === 2, 'purge 留痕：gen_tasks 行保留（2）')
    check((await jreq('POST', `/api/v1/canvases/${C2}/purge`, {})).status === 404, '重复 purge → 404')
    check((await jreq('POST', '/api/v1/canvases/999999/purge', {})).status === 404, 'purge 不存在 → 404')

    // ---------- C1 快照：创建 / 列表 / 默认 label / 保留 id 重放 / 自动备份 ----------
    const s1 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots`, { label: '基线' })
    check(s1.status === 201 && s1.body?.snapshot?.label === '基线' && s1.body?.snapshot?.id > 0, '快照创建 → 201（label=基线）')
    const SID = s1.body.snapshot.id
    const ls1 = await jreq('GET', `/api/v1/canvases/${C1}/snapshots`)
    const it1 = (ls1.body?.items ?? [])[0]
    check(ls1.status === 200 && ls1.body?.items?.length === 1 && it1?.nodeCount === 2 && it1?.edgeCount === 1 && it1?.groupCount === 0 && it1?.doc === undefined, '快照列表：统计 node=2/edge=1/group=0（不含 doc）')
    const s2 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots`, {})
    check(s2.status === 201 && s2.body?.snapshot?.label === '快照 2', '默认 label = 「快照 N」')

    await jreq('POST', `/api/v1/canvases/${C1}/nodes/delete`, { ids: [NC] })
    check((await jreq('GET', `/api/v1/canvases/${C1}`)).body?.nodes?.length === 1, '改乱：删除节点后 doc 仅剩 1')
    const r1 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots/${SID}/restore`, {})
    check(r1.status === 200 && r1.body?.ok === true && r1.body?.restored?.nodes === 2 && r1.body?.restored?.edges === 1 && r1.body?.restored?.groups === 0, '恢复 → 200（restored nodes:2/edges:1/groups:0）')
    const docBack = await jreq('GET', `/api/v1/canvases/${C1}`)
    const nodeIds = new Set((docBack.body?.nodes ?? []).map((n: any) => n.id))
    const edgeIds = (docBack.body?.edges ?? []).map((e: any) => e.id)
    check(nodeIds.has(NAV) && nodeIds.has(NC), '保留 id 重放：节点 id 原样回插（含已删的 NC）')
    check(edgeIds.length === 1 && edgeIds[0] === EID, '保留 id 重放：边 id 原样（EID）')
    const claim = await db
      .select({ nid: canvasNodes.id })
      .from(genTasks)
      .innerJoin(canvasNodes, eq(genTasks.canvasNodeId, canvasNodes.id))
      .where(eq(genTasks.id, TASK))
    check(claim.length === 1 && claim[0]!.nid === NC, '任务历史认领：gen_tasks.canvasNodeId 仍指向回插节点（不孤儿）')
    const ls2 = await jreq('GET', `/api/v1/canvases/${C1}/snapshots`)
    const backupItem = (ls2.body?.items ?? []).find((i: any) => i.id === r1.body.backupSnapshotId)
    check(!!backupItem && String(backupItem.label).includes('恢复前备份'), '恢复前自动备份快照已创建（label 含「恢复前备份」）')

    // ---------- 冲突 409：快照行 id 被他画布显式占用（先释放 C1 的 NAV id → C3 直插占用） ----------
    await jreq('POST', `/api/v1/canvases/${C1}/nodes/delete`, { ids: [NAV] })
    const docPre = await jreq('GET', `/api/v1/canvases/${C1}`)
    check(docPre.body?.nodes?.length === 1 && docPre.body?.edges?.length === 0, '冲突预置：删 NAV 后 doc 1 节点 0 边')
    const C3 = await mkCanvas('占用画布')
    await db
      .insert(canvasNodes)
      .values({ id: NAV, canvasId: C3, kind: 'gen', spec: JSON.stringify({ genKind: 'image', prompt: '占位' }), x: 0, y: 0, createdAt: T0, updatedAt: T0 })
    const r409 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots/${SID}/restore`, {})
    check(r409.status === 409 && r409.body?.error?.code === 'conflict', '冲突：快照行 id 被他画布占用 → 409 conflict')
    const doc409 = await jreq('GET', `/api/v1/canvases/${C1}`)
    check(doc409.body?.nodes?.length === 1 && doc409.body?.edges?.length === 0, '409 事务回滚：原文档零变动（1 节点 0 边）')

    // ---------- 快照删除（域限定） ----------
    const delS2 = await jreq('DELETE', `/api/v1/canvases/${C1}/snapshots/${s2.body.snapshot.id}`)
    check(delS2.status === 200, '快照 DELETE → 200')
    check((await jreq('DELETE', `/api/v1/canvases/${C1}/snapshots/${s2.body.snapshot.id}`)).status === 404, '已删快照再删 → 404')

    // ---------- C4：上限 20（手动 400 / auto 驱逐最旧） ----------
    const C4 = await mkCanvas('上限画布')
    const N4 = await mkNode(C4, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })
    const s4 = await jreq('POST', `/api/v1/canvases/${C4}/snapshots`, { label: 'S1' })
    check(s4.status === 201, '上限画布：首个快照 201')
    const fill = await db
      .insert(canvasSnapshots)
      .values(
        Array.from({ length: 19 }, (_, k) => ({ canvasId: C4, label: `S${k + 2}`, doc: JSON.stringify({ nodes: [], edges: [], groups: [] }), createdAt: T0 + k + 2 })),
      )
      .returning({ id: canvasSnapshots.id })
    const oldestFillId = fill[0]!.id
    const s21 = await jreq('POST', `/api/v1/canvases/${C4}/snapshots`, {})
    check(s21.status === 400 && String(s21.body?.error?.message ?? '').includes('上限'), '上限 20：手动创建满额 → 400（提示清理）')
    const delS1 = await jreq('DELETE', `/api/v1/canvases/${C4}/snapshots/${s4.body.snapshot.id}`)
    check(delS1.status === 200, '满额删除一条 → 200')
    const sx = await jreq('POST', `/api/v1/canvases/${C4}/snapshots`, { label: '回位' })
    check(sx.status === 201, '腾位后重建 → 201（回 20）')
    const r5 = await jreq('POST', `/api/v1/canvases/${C4}/snapshots/${sx.body.snapshot.id}/restore`, {})
    check(r5.status === 200 && r5.body?.restored?.nodes === 1, '满额 restore：auto 备份驱逐最旧不阻断（restored.nodes=1）')
    const ls5 = await jreq('GET', `/api/v1/canvases/${C4}/snapshots`)
    check(ls5.body?.items?.length === 20, 'C4：auto 备份后总量仍为 20（驱逐最旧）')
    check(!(ls5.body?.items ?? []).some((i: any) => i.id === oldestFillId), 'C4：最旧快照被驱逐')
    check((ls5.body?.items ?? []).some((i: any) => String(i.label).includes('恢复前备份')), 'C4：恢复前备份快照存在')
    check((await jreq('GET', `/api/v1/canvases/${C4}`)).body?.nodes?.[0]?.id === N4, 'C4 恢复后节点 id 保留（N4）')

    // ---------- 错误族与域限定 ----------
    check((await jreq('DELETE', `/api/v1/canvases/${C4}/snapshots/${SID}`)).status === 404, '快照删除域限定：他画布快照 → 404')
    check((await jreq('GET', '/api/v1/canvases/999999/snapshots')).status === 404, '画布不存在 → 快照列表 404')
    check((await jreq('POST', '/api/v1/canvases/999999/snapshots', {})).status === 404, '画布不存在 → 创建快照 404')
    check((await jreq('POST', `/api/v1/canvases/${C1}/snapshots/999999/restore`, {})).status === 404, '快照不存在 → restore 404')
    check((await jreq('DELETE', `/api/v1/canvases/${C1}/snapshots/999999`)).status === 404, '快照不存在 → DELETE 404')
  }

  /** ⑤ [P4] LLM 节点：端口矩阵 v3 + specProblems/parseNodeSpec + 未配置引导 + stub 执行链（多模态/用量/落库）+ 产物文本下游装载 */
  const sectionLlmNode = async (): Promise<void> => {
    const { validateNewEdge, productKindOf, parseNodeSpec, specProblems, planNodeInputs } = await import('../src/services/creation')
    const { preflightNode } = await import('../src/services/creation/gen')
    const llmSpec = parseNodeSpec({ genKind: 'llm', prompt: '请总结' })
    const throwsWith = (fn: () => unknown, kw: string): boolean => {
      try {
        fn()
        return false
      } catch (e) {
        return (e as Error).message.includes(kw)
      }
    }

    // ---- productKindOf / 端口矩阵 v3（纯函数） ----
    check(productKindOf(llmSpec) === 'text', 'productKindOf(llm) = text（产物文本类型）')
    const toLlm = { id: 9, kind: 'gen', spec: llmSpec }
    const toImage = { id: 10, kind: 'gen', spec: parseNodeSpec({ genKind: 'image', prompt: 'x' }) }
    const textFrom = { id: 1, kind: 'text' }
    const llmFrom = { id: 2, kind: 'gen', spec: llmSpec }
    const entFrom = { id: 3, kind: 'entity' }
    const imgFrom = { id: 4, kind: 'asset', assetKind: 'image' }
    const vidFrom = { id: 5, kind: 'asset', assetKind: 'video' }

    check(validateNewEdge(toLlm, 'text', 1, [], textFrom) === null, 'text 端口：llm 目标 + text 源 → 允许')
    check(validateNewEdge(toLlm, 'text', 2, [], llmFrom) === null, 'text 端口：llm 目标 + llm 产物源 → 允许')
    check(validateNewEdge(toLlm, 'text', 4, [], imgFrom)?.includes('文本素材来源需为文本节点或 LLM 节点') === true, 'text 端口：image 源 → 拒（来源文案）')
    check(validateNewEdge(toImage, 'text', 1, [], textFrom)?.includes('文本素材端口仅 LLM 节点支持') === true, 'text 端口：image 目标 → 拒')
    const four = [1, 2, 3, 4].map((f) => ({ from: f, to: 9, port: 'text' }))
    check(validateNewEdge(toLlm, 'text', 5, four, textFrom)?.includes('文本素材上限 4 段') === true, 'text 端口：第 5 条 → 上限 4 段')

    check(validateNewEdge(toLlm, 'reference', 4, [], imgFrom) === null, 'reference：llm 目标 + image 源 → 允许')
    check(validateNewEdge(toLlm, 'reference', 3, [], entFrom) === null, 'reference：llm 目标 + entity 源 → 允许')
    const fourRef = [1, 2, 3, 4].map((f) => ({ from: f, to: 9, port: 'reference' }))
    check(validateNewEdge(toLlm, 'reference', 5, fourRef, imgFrom)?.includes('LLM生成节点参考图上限 4 张') === true, 'reference：llm 第 5 张 → 上限 4 张')
    check(validateNewEdge(toLlm, 'reference', 5, [], vidFrom)?.includes('参考图来源需为图片素材/生成图/实体节点') === true, 'reference：llm 目标 + video 源 → 拒')

    check(validateNewEdge(toLlm, 'prompt', 1, [], textFrom) === null, 'prompt：llm 目标 + text 源 → 允许')
    check(validateNewEdge(toLlm, 'prompt', 4, [], imgFrom)?.includes('提示词端口仅接受文本节点或 LLM 节点') === true, 'prompt：image 源 → 拒')

    // ---- specProblems / parseNodeSpec ----
    check(specProblems({ genKind: 'llm', prompt: '' }, false).some((p) => p.includes('指令为空')) === true, 'specProblems：llm 空指令 → 问题')
    check(specProblems({ genKind: 'llm', prompt: '写' }, false).length === 0, 'specProblems：llm 有指令 → 无问题')
    check(specProblems({ genKind: 'llm', prompt: '' }, true).length === 0, 'specProblems：prompt 端口提供指令 → 无问题')
    check(parseNodeSpec({ genKind: 'llm', prompt: 'x', temperature: 1.5, maxTokens: 8000 }).temperature === 1.5, 'parseNodeSpec：temperature/maxTokens 透传')
    check(throwsWith(() => parseNodeSpec({ genKind: 'llm', prompt: 'x', temperature: 2.5 }), 'temperature'), 'parseNodeSpec：temperature>2 → 拒')
    check(throwsWith(() => parseNodeSpec({ genKind: 'llm', prompt: 'x', maxTokens: 1.5 }), 'maxTokens'), 'parseNodeSpec：maxTokens 非整数 → 拒')

    // ---- planNodeInputs（纯函数）：text 素材装载（trim/空跳过/上限）+ prompt 端口 ----
    const plan = planNodeInputs(
      llmSpec,
      9,
      [1, 2, 3, 4, 5, 6].map((f) => ({ from: f, to: 9, port: 'text' })).concat([{ from: 7, to: 9, port: 'prompt' }]),
      new Map([
        [1, { assetId: null, mediaKind: null, text: '素材甲' }],
        [2, { assetId: null, mediaKind: null, text: '  素材乙  ' }],
        [3, { assetId: null, mediaKind: null, text: '' }],
        [4, { assetId: null, mediaKind: null, text: '素材丙' }],
        [5, { assetId: null, mediaKind: null, text: '素材丁' }],
        [6, { assetId: null, mediaKind: null, text: '素材戊' }],
        [7, { assetId: null, mediaKind: null, text: '端口指令' }],
      ]),
    )
    check(
      plan.textInputs.length === 4 && plan.textInputs[0] === '素材甲' && plan.textInputs[1] === '素材乙' && plan.textInputs[3] === '素材丁',
      'plan：textInputs 装载（trim；第 5、6 段被上限截断）',
    )
    check(plan.problems.some((p) => p.includes('暂无文本或为空')) === true, 'plan：空文本素材 → 问题')
    check(plan.problems.some((p) => p.includes('文本素材超过上限 4 段')) === true, 'plan：超上限 → 问题')
    check(plan.promptText === '端口指令', 'plan：prompt 端口指令装载')

    // ---- 执行链（HTTP 全链 + fetch stub） ----
    const PID = await mkProject('M18 LLM')
    const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: 'LLM 画布' })).body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id

    // 未配置 LLM（探针顶部已屏蔽 env；无 api_configs）→ preflight 引导 + run 400
    const NL0 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '未配置测试' }, x: 0, y: 0 })
    const pf0 = await preflightNode(NL0)
    check(pf0.problems.some((p) => p.includes('LLM 未配置')) === true, '未配置：preflight problems 含「LLM 未配置」引导')
    const r0 = await jreq('POST', `/api/v1/nodes/${NL0}/run`, {})
    check(r0.status === 400 && String(r0.body?.error?.message ?? '').includes('LLM 未配置'), '未配置：run → 400 引导文案')

    // 配置探针 LLM（实例级 llm 实例）
    await db.insert(apiConfigs).values({
      providerKey: 'probe-llm',
      serviceType: 'llm',
      name: 'probe LLM',
      baseUrl: 'https://probe.invalid/v1',
      apiKeyRef: 'env:PROBE_M18_LLM_KEY',
      model: 'probe-model',
      priority: 0,
      isDefault: 1,
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    process.env.PROBE_M18_LLM_KEY = 'probe-key-m18'
    const pf1 = await preflightNode(NL0)
    check(!pf1.problems.some((p) => p.includes('LLM 未配置')), '已配置：preflight 不再报「LLM 未配置」')

    // fetch stub：chat/completions → 固定文本 + usage；捕获请求体供断言
    const captured: Array<{ url: string; body: any }> = []
    const LLM_REPLY = '【探针】总结：素材要点已提炼。'
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(
        JSON.stringify({ choices: [{ message: { content: LLM_REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    // 素材链：text 节点 → text 端口；参考图 → reference 端口；llm 节点（temperature/maxTokens 透传）
    const NTX = await mkNode({ kind: 'text', spec: { text: '资料：萌宝镖客是一部短剧。' }, x: 0, y: 200 })
    const NL1 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '请总结资料', temperature: 0.3, maxTokens: 900 }, x: 300, y: 0 })
    check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NTX, to: NL1, port: 'text' })).status === 201, '建边：text 端口 → 201')
    const pngRel = relPathOf(PID, 'creation_ref', 'probe-ref.png')
    mkdirSync(dirname(absPathOf(pngRel)), { recursive: true })
    writeFileSync(
      absPathOf(pngRel),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    )
    const AIM = await mkAsset(PID, 'image', '参考图', { relPath: pngRel })
    const NAIM = await mkNode({ kind: 'asset', assetId: AIM, x: 0, y: 400 })
    check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NAIM, to: NL1, port: 'reference' })).status === 201, '建边：reference 端口（llm）→ 201')

    const r1 = await jreq('POST', `/api/v1/nodes/${NL1}/run`, {})
    check(r1.status === 200 && r1.body?.taskIds?.length === 1, 'run → 任务入队')
    const st = await settleTasks([r1.body.taskIds[0]])
    check(st.get(r1.body.taskIds[0]) === 'succeeded', 'llm 执行 → succeeded（stub 端点）')

    // 请求体断言（最后一发）
    const reqBody = captured[captured.length - 1]?.body
    check(captured[captured.length - 1]?.url === 'https://probe.invalid/v1/chat/completions', '请求 URL = baseUrl + /chat/completions')
    check(reqBody?.model === 'probe-model' && reqBody?.temperature === 0.3 && reqBody?.max_tokens === 900, '请求体：model/temperature/maxTokens 透传')
    const userMsg = reqBody?.messages?.[1]
    check(Array.isArray(userMsg?.content) && userMsg.content[0]?.type === 'text' && String(userMsg.content[0].text).includes('--- 素材 1 ---') && String(userMsg.content[0].text).includes('指令：请总结资料'), '多模态：文本素材段 + 指令拼接')
    check(
      Array.isArray(userMsg?.content) && userMsg.content.some((p: any) => p.type === 'image_url' && String(p.image_url?.url).startsWith('data:image/png;base64,')),
      '多模态：参考图 data URI 分片',
    )

    // 落库断言：产物资产 + 文件内容 + params
    const outs = await db.select().from(assets).where(and(eq(assets.projectId, PID), eq(assets.purpose, 'creation_llm')))
    const outT = outs[0]
    check(!!outT && outT.kind === 'text' && outT.mime === 'text/markdown' && outT.ext === 'md', '产物：text 资产（text/markdown；md）')
    check(outT?.name === `LLM 文本 #${NL1}.md`, '产物命名：LLM 文本 #<nodeId>.md')
    if (outT?.relPath) {
      const content = readFileSync(absPathOf(outT.relPath), 'utf8')
      check(content === LLM_REPLY, '产物文件内容 = 模型返回')
    } else {
      check(false, '产物文件存在')
    }
    const pOut = JSON.parse(String(outT?.params ?? '{}')) as Record<string, unknown>
    check(pOut.materials === 1 && pOut.images === 1 && pOut.canvasId === C && pOut.nodeId === NL1, '产物 params：materials=1 / images=1 / canvasId/nodeId')

    // 用量：tokens_in/out 两行
    const urs = await db.select().from(usageRecords).where(eq(usageRecords.projectId, PID))
    check(
      urs.some((u) => u.kind === 'llm' && u.unit === 'tokens_in' && u.quantity === 120) && urs.some((u) => u.kind === 'llm' && u.unit === 'tokens_out' && u.quantity === 48),
      '用量：tokens_in=120 / tokens_out=48',
    )

    // 读模型
    const doc = await jreq('GET', `/api/v1/canvases/${C}`)
    const nd = (doc.body?.nodes ?? []).find((n: any) => n.id === NL1)
    check(nd?.status === 'succeeded' && nd?.displayTask?.asset?.kind === 'text', '读模型：succeeded + displayTask.asset.kind=text')

    // ---- 产物文本下游装载：llm 产物 → 下游 llm（prompt / text 端口） ----
    const NL2 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '基于指令改写' }, x: 600, y: 0 })
    check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NL1, to: NL2, port: 'prompt' })).status === 201, '建边：llm 产物 → prompt 端口 → 201')
    const pf2 = await preflightNode(NL2)
    check(pf2.plan.promptText === LLM_REPLY, '下游装载：llm 产物文本 → plan.promptText（prompt 端口）')
    check(pf2.problems.length === 0, '下游装载：preflight 无问题')
    const NL3 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '合并素材' }, x: 600, y: 200 })
    check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NL1, to: NL3, port: 'text' })).status === 201, '建边：llm 产物 → text 端口 → 201')
    const pf3 = await preflightNode(NL3)
    check(pf3.plan.textInputs.length === 1 && pf3.plan.textInputs[0] === LLM_REPLY, '下游装载：llm 产物文本 → textInputs（text 端口）')

    // 链二段执行：指令 = 上游产物文本
    const r2 = await jreq('POST', `/api/v1/nodes/${NL2}/run`, {})
    const st2 = await settleTasks([r2.body?.taskIds?.[0] ?? -1])
    check(r2.status === 200 && st2.get(r2.body?.taskIds?.[0] ?? -1) === 'succeeded', '下游执行：llm 链二段 succeeded')
    const req2 = captured[captured.length - 1]?.body
    check(String(req2?.messages?.[1]?.content) === LLM_REPLY, '下游执行：无素材时指令直传（content 字符串）')

    // ---- 产物文件缺失降级：装载留空 + problem（不炸） ----
    if (outT?.relPath) {
      rmSync(absPathOf(outT.relPath), { force: true })
      const pf4 = await preflightNode(NL2)
      check(pf4.plan.promptText === null && pf4.problems.some((p) => p.includes('暂无文本或为空')) === true, '产物文件缺失：装载降级 → promptText=null + 问题')
    }

    // ---- 清理（防影响后续 section）：还原 fetch + 删实例 + 清 env ----
    globalThis.fetch = stubFetch
    await db.delete(apiConfigs).where(and(eq(apiConfigs.providerKey, 'probe-llm'), eq(apiConfigs.serviceType, 'llm')))
    delete process.env.PROBE_M18_LLM_KEY
  }

  /** ⑥ [P5] 模板 v2 */
  const sectionTemplateV2 = async (): Promise<void> => {
    const { buildTemplateDraftYaml, tryRunTemplate, parseNodeSpec } = await import('../src/services/creation')
    const { validateTemplateText, saveTemplate, deleteTemplate, KNOWN_ACTIONS, loadTemplate } = await import('../src/pipeline/loader')
    const { literal } = await import('../src/pipeline/actions/literal')
    const { listActionKeys } = await import('../src/pipeline/actions')
    const { readTextAsset } = await import('../src/services/storage')
    void saveTemplate
    type CanvasDocT = import('../src/services/creation').CanvasDoc

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
        { ...emptyNode, kind: 'asset', id: 2, title: '参考图', assetId: 99 },
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
      lossy.some((s) => s.includes('#11') && s.includes('参考/首末帧')),
      'draft v2 lossy：image 参考连线',
    )
    check(
      lossy.some((s) => s.includes('#12') && s.includes('参考/首末帧')),
      'draft v2 lossy：video first_frame 连线',
    )
    const val = validateTemplateText(yaml, 'probe-v2-88')
    check(val.ok, `draft v2 通过 validateTemplateText：${val.errors.join(' | ')}`)

    // ---- ② literal action 直接执行（as 全矩阵 + payload 回退 + 空抛错 + 非法 as 抛错） ----
    const mkCtx = (over: Partial<import('../src/pipeline/context').StepContext>): any => ({
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
      Array.isArray(try1.body?.lossy) && try1.body.lossy.some((s: string) => s.includes('#' + nI) && s.includes('参考')),
      'template-try lossy 非空（参考连线写入）',
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

  /** ⑦ [P6] 画布分组 */
  const sectionGroups = async (): Promise<void> => {
    const PID = await mkProject('M18 分组')
    const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '分组画布' })).body.canvas.id
    const addN = async (cid: number, body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${cid}/nodes`, body)).body.node.id
    const N1 = await addN(C, { kind: 'gen', spec: { genKind: 'image', prompt: 'a' }, x: 100, y: 200 })
    const N2 = await addN(C, { kind: 'gen', spec: { genKind: 'image', prompt: 'b' }, x: 20, y: 40 })
    const N3 = await addN(C, { kind: 'text', spec: { text: 'c' }, x: 500, y: 500 })

    check((await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [] })).status === 400, 'groups：空 nodeIds → 400')
    const bad = await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [999999] })
    check(bad.status === 400 && bad.body?.error?.code === 'node_not_in_canvas', 'groups：节点不属本画布 → 400 node_not_in_canvas')

    const g = await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [N1, N2], title: '第一组', color: 'blue' })
    const GID = g.body?.group?.id
    check(
      g.status === 201 && GID > 0 && g.body.group.x === 20 && g.body.group.y === 40 && g.body.group.collapsed === 0,
      '建组 → 201，锚点=成员包围盒左上（20,40）',
    )
    check(g.body?.group?.title === '第一组' && g.body?.group?.color === 'blue', '建组：title/color 落库')

    const doc1 = (await jreq('GET', `/api/v1/canvases/${C}`)).body
    check(
      Array.isArray(doc1.groups) && doc1.groups.length === 1 && doc1.groups[0].id === GID && doc1.groups[0].collapsed === false,
      'doc.groups：1 组（collapsed 布尔）',
    )
    const byId = new Map<number, any>(doc1.nodes.map((n: any) => [n.id, n]))
    check(
      byId.get(N1)?.groupId === GID && byId.get(N2)?.groupId === GID && byId.get(N3)?.groupId == null,
      'doc 节点：成员 groupId 归属，非成员 null',
    )

    const dup = await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [N1, N3] })
    check(
      dup.status === 400 && dup.body?.error?.code === 'already_grouped' && String(dup.body?.error?.message ?? '').includes(String(N1)),
      '跨组拒绝：成员已属他组 → 400 列出违规',
    )

    const pCol = await jreq('PATCH', `/api/v1/canvases/${C}/groups/${GID}`, { collapsed: true })
    check(pCol.status === 200 && pCol.body?.group?.collapsed === 1, 'PATCH：collapsed=true → 1 落库')
    check((await jreq('PATCH', `/api/v1/canvases/${C}/groups/${GID}`, { title: '   ' })).status === 400, 'PATCH：空 title → 400')
    const pColor = await jreq('PATCH', `/api/v1/canvases/${C}/groups/${GID}`, { color: 'notacolor' })
    check(pColor.status === 200 && pColor.body?.group?.color === null, 'PATCH：非白名单色 → null 回退')
    check((await jreq('PATCH', `/api/v1/canvases/${C}/groups/999999`, { title: 'x' })).status === 404, 'PATCH：不存在组 → 404')

    const del = await jreq('DELETE', `/api/v1/canvases/${C}/groups/${GID}`)
    check(del.status === 200 && del.body?.ok === true, '解组 → 200 {ok}')
    const doc2 = (await jreq('GET', `/api/v1/canvases/${C}`)).body
    check(doc2.groups.length === 0 && doc2.nodes.every((n: any) => n.groupId == null), '解组：组行移除 + 成员归属清空')
    check((await jreq('DELETE', `/api/v1/canvases/${C}/groups/${GID}`)).status === 404, '解组：重复删除 → 404')

    // 空组保留（删成员节点不级联删组）
    const G2 = (await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [N3], title: '将空组' })).body.group.id
    await jreq('DELETE', `/api/v1/nodes/${N3}`)
    const doc3 = (await jreq('GET', `/api/v1/canvases/${C}`)).body
    check(doc3.groups.some((x: any) => x.id === G2), '删成员节点 → 空组保留（不级联删组）')
    const pXY = await jreq('PATCH', `/api/v1/canvases/${C}/groups/${G2}`, { x: 7, y: 9 })
    check(pXY.status === 200 && pXY.body.group.x === 7 && pXY.body.group.y === 9, '空组：锚点 x/y 可 PATCH')
  }

  /** ⑨ [P6] 封面派生 + 流式 zip */
  const sectionScaleZip = async (): Promise<void> => {
    const { unzipSync, strFromU8 } = await import('fflate')
    const { exportCanvas } = await import('../src/services/creation/export')
    const { listCanvases } = await import('../src/services/creation')

    // ===== cover 派生 =====
    const PID = await mkProject('M18 规模')
    const addN = async (cid: number, body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${cid}/nodes`, body)).body.node.id
    const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '规模画布' })).body.canvas.id
    const NG = await addN(C, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })
    const oldA = await mkAsset(PID, 'image', '旧产物', {})
    const newA = await mkAsset(PID, 'image', '新产物', {})
    const mkTask = async (assetId: number, completedAt: number): Promise<void> => {
      await db.insert(genTasks).values({
        projectId: PID, canvasNodeId: NG, kind: 'image', params: '{}', status: 'succeeded',
        resultAssetId: assetId, completedAt, createdAt: T0, updatedAt: completedAt,
      })
    }
    await mkTask(oldA, 1_000)
    await mkTask(newA, 5_000)
    const itemC = (await listCanvases(PID)).find((x) => x.id === C)
    check(itemC?.cover?.id === newA, 'cover：多 succeeded 任务取最近完成产物（max completedAt）')

    const C0 = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '空画布' })).body.canvas.id
    await addN(C0, { kind: 'gen', spec: { genKind: 'image', prompt: 'y' }, x: 0, y: 0 })
    check((await listCanvases(PID)).find((x) => x.id === C0)?.cover === null, 'cover：无成功产物 → null')

    await jreq('DELETE', `/api/v1/canvases/${C}`) // 软删
    check(
      (await listCanvases(PID, { trash: true })).find((x) => x.id === C)?.cover?.id === newA,
      'cover：回收站列表同样派生封面',
    )

    // ===== 流式 zip 对拍 =====
    const PZ = await mkProject('M18 zip')
    const CZ = (await jreq('POST', `/api/v1/projects/${PZ}/canvases`, { name: '打包画布' })).body.canvas.id
    const addZ = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CZ}/nodes`, body)).body.node.id
    const TXT_CONTENT = '文本内容α\nβ'
    await addZ({ kind: 'text', spec: { text: TXT_CONTENT }, x: 0, y: 0, title: '说明' })
    const pngRel = relPathOf(PZ, 'creation_ref', 'pack.png')
    mkdirSync(dirname(absPathOf(pngRel)), { recursive: true })
    writeFileSync(
      absPathOf(pngRel),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    )
    const IMG = await mkAsset(PZ, 'image', '素材图', { relPath: pngRel })
    await addZ({ kind: 'asset', assetId: IMG, x: 100, y: 0, title: '素材图' })
    // 大文件 ~30MB 走 store 流式路径
    const bigRel = relPathOf(PZ, 'creation_ref', 'big.bin')
    writeFileSync(absPathOf(bigRel), Buffer.alloc(30 * 1024 * 1024, 7))
    const BIG = await mkAsset(PZ, 'image', '大图', { relPath: bigRel })
    await addZ({ kind: 'asset', assetId: BIG, x: 200, y: 0, title: '大图' })
    // 软删资产 → skipped 记账（先建正常节点，导出前再软删；建节点时资产尚在→不拒）
    const deadA = await mkAsset(PZ, 'image', '死链', { relPath: pngRel })
    await addZ({ kind: 'asset', assetId: deadA, x: 300, y: 0, title: '死链' })
    await db.update(assets).set({ deletedAt: T0 }).where(eq(assets.id, deadA))

    const ex = await exportCanvas(CZ)
    check(ex !== null && ex.stats.packed === 3 && ex.stats.skipped === 1, '导出：3 打包 + 1 skipped（软删资产）')
    const zipBytes = readFileSync(absPathOf(ex!.asset.relPath as string))
    const unz = unzipSync(new Uint8Array(zipBytes))
    const names = Object.keys(unz)
    check(names.includes('manifest.json'), 'zip：manifest.json 存在')
    const mf = JSON.parse(strFromU8(unz['manifest.json']))
    check(mf.files.length === 3 && mf.skipped.length === 1 && mf.canvas.id === CZ, 'manifest：files 3 / skipped 1 / canvas 一致')
    const textEntry = names.find((n) => n.endsWith('.txt'))
    check(textEntry != null && strFromU8(unz[textEntry]) === TXT_CONTENT, 'zip：文本条目内容逐字节等价')
    const imgEntry = names.find((n) => n.endsWith('.png'))
    check(
      imgEntry != null && Array.from(unz[imgEntry]).join() === Array.from(readFileSync(absPathOf(pngRel))).join(),
      'zip：媒体条目 store 内容等价',
    )
    const bigEntry = names.find((n) => n.endsWith('.bin'))
    check(
      bigEntry != null && unz[bigEntry].length === 30 * 1024 * 1024 && unz[bigEntry][0] === 7 && unz[bigEntry][unz[bigEntry].length - 1] === 7,
      'zip：30MB 流式 store 长度/字节等价',
    )
    check(ex!.asset.kind === 'archive' && ex!.asset.purpose === 'creation_export', '导出资产登记：archive / creation_export')
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'p1-schema': sectionP1Schema,
    'frame-extract': sectionFrameExtract,
    'compose-v3': sectionComposeV3,
    'run-preview': sectionRunPreview,
    'trash-snapshot': sectionTrashSnapshot,
    'llm-node': sectionLlmNode,
    'template-v2': sectionTemplateV2,
    groups: sectionGroups,
    'scale-zip': sectionScaleZip,
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
    console.log(`\n==== M18 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    globalThis.fetch = origFetch // 还原网络栈
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
