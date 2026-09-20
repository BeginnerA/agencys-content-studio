/**
 * M34 探针（模板与运行入参自动化：G6 输入预填 + G8 视频合法档位）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m34.ts [--section=g6-inputs|g8-caps|guards]
 *
 * 隔离策略：isolatedEnv('m34', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费、零计费：resolveRunPrefill 纯 DB 读 + 静态真源表，
 * 绝不触发生成/计价/LLM。端点只读。app.request 内存执行。
 *
 * 分节：
 *   - g6-inputs：优先级 template_default < last_run < brief；媒体(_/files/publications)排除；损坏 run 跳过取次新可解析。
 *   - g8-caps：project.settings.video 命中 minimax/volcengine 时长边界 + 域对齐防 400；未登记/非视频模板 → null；回落默认实例。
 *   - guards：端点 200 / 缺 project_id 400 / 项目 404 / 模板 404。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m34', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M34_KEY = 'probe-m34-offline-secret-key-9c3b'

const SECTIONS = ['g6-inputs', 'g8-caps', 'guards'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m34')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const T_TB = 'mengbao-episode'
  const T_NOVIDEO = 'topic-radar'

  const insertProject = async (tag: string, opts: { brief?: string; settings?: string }): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    const t = Date.now()
    const name = `probe-m34-${tag}`
    await db.insert(projects).values({
      name, genre: 'drama_short', brief: opts.brief ?? null, templateKey: T_TB,
      status: 'active', settings: opts.settings ?? '{}', tags: '[]', createdAt: t, updatedAt: t,
    } as never)
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).limit(1)
    return (row as { id: number }).id
  }

  const setVideoSettings = async (projectId: number, video: Record<string, unknown> | null): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    await db
      .update(projects)
      .set({ settings: JSON.stringify(video ? { video } : {}) })
      .where(eq(projects.id, projectId))
  }

  const insertRun = async (
    projectId: number,
    templateKey: string,
    input: unknown,
    at: number,
  ): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { pipelineRuns } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    const raw = typeof input === 'string' ? input : JSON.stringify(input)
    await db.insert(pipelineRuns).values({
      projectId, templateKey, status: 'completed', input: raw,
      createdAt: at, updatedAt: at,
    } as never)
    // 取本项目最大 id（自增，即本次插入）
    const all = await db
      .select({ id: pipelineRuns.id })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.projectId, projectId))
      .orderBy(pipelineRuns.id)
    return (all[all.length - 1] as { id: number }).id
  }

  const seedDefaultVideoInstance = async (providerKey: string, model: string): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { apiConfigs } = await import('../src/db/schema')
    const { and, eq } = await import('drizzle-orm')
    await initDb()
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'video'))
    const t = Date.now()
    await db.insert(apiConfigs).values({
      name: `m34-${providerKey}`, providerKey, serviceType: 'video',
      apiKeyRef: 'env:PROBE_M34_KEY', baseUrl: 'http://localhost:0/offline', model,
      extra: '{}', pricing: '{}', isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t,
    } as never)
    void and
  }

  const clearRuns = async (): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { pipelineRuns } = await import('../src/db/schema')
    await initDb()
    await db.delete(pipelineRuns)
  }

  const svc = async (projectId: number, templateKey: string) => {
    const { resolveRunPrefill } = await import('../src/services/run-prefill')
    return resolveRunPrefill(projectId, templateKey)
  }

  const jget = async (path: string): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path)
    let json: any = null
    try { json = await res.json() } catch { /* non-json */ }
    return { status: res.status, body: json }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= G6：输入预填优先级 + 排除纪律 =================
    'g6-inputs': async () => {
      await clearRuns()
      const pid = await insertProject('g6', { brief: '测试项目简介XYZ' })

      // 无 run：brief 放置 + 模板默认 + 媒体/未默认 int 不填
      const r0 = await svc(pid, T_TB)
      check(r0.inputs.brief?.source === 'brief' && String(r0.inputs.brief?.value).includes('测试项目简介XYZ'), '无历史 run：brief 文本输入承接项目简介（source=brief）')
      check(r0.inputs.motion?.source === 'template_default' && r0.inputs.motion?.value === false, '模板声明 default 的 bool 输入 → template_default')
      check(r0.inputs.setting_docs === undefined, '媒体类（files）输入从不自动填充')
      check(r0.inputs.episode_number === undefined, 'int 输入无 default/无 run → 不猜值（缺席）')
      check(r0.lastRunId === null, '无历史 run → lastRunId 为 null')

      // 播种两条 run：较新者胜出；媒体 / 内部键排除
      const oldInput = { brief: 'OLD', episode_number: 3, setting_docs: [1, 2], _params: { video: { duration: 9 } } }
      const newInput = { brief: 'NEW', episode_number: 5 }
      await insertRun(pid, T_TB, oldInput, 1_000)
      const newId = await insertRun(pid, T_TB, newInput, 2_000)
      const r1 = await svc(pid, T_TB)
      check(r1.inputs.brief?.value === 'NEW' && r1.inputs.brief?.source === 'last_run', '较新同模板 run 的 brief 精确复用（last_run 覆盖 brief 来源）')
      check(r1.inputs.episode_number?.value === 5 && r1.inputs.episode_number?.source === 'last_run', 'int 输入从历史 run 复用（last_run）')
      check(r1.inputs.setting_docs === undefined, '媒体类输入即便历史 run 有值也不复用（防跨集资产误绑）')
      check((r1.inputs as Record<string, unknown>)['_params'] === undefined, 'run 内部键（_params 等）绝不作为表单输入回填')
      check(r1.lastRunId === newId, 'lastRunId 指向最近一条可解析 run')

      // 最新一条损坏 → 跳过取次新可解析（仍为 newInput，非 oldInput）
      await insertRun(pid, T_TB, '{ not json', 3_000)
      const r2 = await svc(pid, T_TB)
      check(r2.inputs.brief?.value === 'NEW' && r2.lastRunId === newId, '最新 run 输入损坏 → 跳过取次新可解析（不整体失败）')

      // 非白名单 / 已有默认：topic-radar 的 platform 有 default，brief 不越权覆盖
      const pidT = await insertProject('g6t', { brief: '赛道简介ABC' })
      const rt = await svc(pidT, T_NOVIDEO)
      check(rt.inputs.platform?.value === '抖音' && rt.inputs.platform?.source === 'template_default', '已有 template_default 的输入不被 brief 越权覆盖')
      check(rt.inputs.track?.source === 'brief', 'label 命中白名单（方向）的空文本输入承接 brief')
      check(rt.inputs.count?.source === 'template_default' && rt.inputs.count?.value === 12, 'int 默认走 template_default（brief 不作用于非文本）')
    },

    // ================= G8：视频覆盖合法档位（域对齐防 400） =================
    'g8-caps': async () => {
      const pid = await insertProject('g8', { brief: 'g8' })

      // minimax：输出档位 768P/2K ∉ 输入白名单 → selectable 回落全量、default null（防 400）
      await setVideoSettings(pid, { provider: 'minimax_video', model: 'MiniMax-H3' })
      const mm = (await svc(pid, T_TB)).overrides.video
      check(!!mm && mm?.providerKey === 'minimax_video', 'settings.video 指定 minimax → 命中 caps（providerKey）')
      check(!!mm && mm.durations.every((d) => d >= 4 && d <= 15) && mm.defaultDuration === 5, 'minimax 时长档位收敛 4–15、默认 5（用于收窄越界手填）')
      check(!!mm && JSON.stringify(mm.resolutions) === JSON.stringify(['768P', '2K']), 'resolutions 暴露 caps 输出档位（仅展示提示）')
      check(!!mm && JSON.stringify(mm.selectableResolutions) === JSON.stringify(['480p', '720p', '1080p']), '交集空 → selectableResolutions 回落输入白名单全量（防下拉为空）')
      check(!!mm && mm.defaultResolution === null, 'defaultResolution ∉ 可选域 → null（防 validateRunParams 400）')

      // volcengine：480p/720p ∈ 白名单 → selectable 收敛、defaultResolution 720p
      await setVideoSettings(pid, { provider: 'volcengine_video', model: 'Seedance-2.0' })
      const vc = (await svc(pid, T_TB)).overrides.video
      check(!!vc && JSON.stringify(vc.selectableResolutions) === JSON.stringify(['480p', '720p']), 'volcengine selectableResolutions 收敛到合法交集')
      check(!!vc && vc.defaultResolution === '720p', 'volcengine defaultResolution ∈ 可选域 → 给出推荐')

      // 未登记模型 → null（不背书，前端回退手填）
      await setVideoSettings(pid, { provider: 'mystery_video', model: 'x' })
      check((await svc(pid, T_TB)).overrides.video === null, '未登记视频模型 → overrides.video null（fail-closed，不猜档位）')

      // 非视频模板 → null（usesVideo=false）
      check((await svc(pid, T_NOVIDEO)).overrides.video === null, '不含 ai_video/ffmpeg_merge 的模板 → overrides.video null')

      // settings.video 缺省 → 回落默认 video 实例
      await seedDefaultVideoInstance('aliyun_wan_video', 'wan3.0')
      await setVideoSettings(pid, null)
      const fb = (await svc(pid, T_TB)).overrides.video
      check(!!fb && fb.providerKey === 'aliyun_wan_video' && fb.durations.every((d) => d >= 2 && d <= 30), 'settings 无 video → 回落默认 video 实例（万相 2–30）')
      check(!!fb && JSON.stringify(fb.selectableResolutions) === JSON.stringify(['480p', '720p', '1080p']), '万相三档分辨率均在输入白名单内 → selectable 全保留')
    },

    // ================= guards：端点校验 =================
    guards: async () => {
      await clearRuns()
      const pid = await insertProject('guards', { brief: 'g', settings: JSON.stringify({ video: { provider: 'minimax_video', model: 'MiniMax-H3' } }) })
      const ok = await jget(`/api/v1/templates/${T_TB}/prefill?project_id=${pid}`)
      check(ok.status === 200 && !!ok.body?.inputs && ok.body?.overrides && 'video' in ok.body.overrides, 'GET prefill 200 → {inputs, overrides.video}')
      const bad = await jget(`/api/v1/templates/${T_TB}/prefill`)
      check(bad.status === 400, '缺 project_id → 400')
      const bad2 = await jget(`/api/v1/templates/${T_TB}/prefill?project_id=abc`)
      check(bad2.status === 400, '非法 project_id → 400')
      const np = await jget(`/api/v1/templates/${T_TB}/prefill?project_id=999999`)
      check(np.status === 404 && np.body?.error?.code === 'project_not_found', '项目不存在 → 404 project_not_found')
      const nt = await jget(`/api/v1/templates/no-such-template-xyz/prefill?project_id=${pid}`)
      check(nt.status === 404 && nt.body?.error?.code === 'template_not_found', '模板不存在 → 404 template_not_found')
    },
  }

  await runSections({ log, title: 'M34', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
